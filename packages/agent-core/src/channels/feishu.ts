/**
 * Feishu (Lark) Channel — implements the Channel trait.
 *
 * Connects agent-core to Feishu via the official @larksuiteoapi/node-sdk.
 * Uses WebSocket long connection — no public IP or webhook required.
 *
 * Features:
 * - Private chat and group @mention support
 * - Image message download → base64 data URI → multimodal ContentBlock
 * - Streaming response via DraftUpdater (throttled message updates)
 * - HITL approval via interactive cards + button click resumption
 * - Scope-based preemption (scopeKey = "feishu:{chatId}")
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { createLogger } from "../logger.js";
import type { AgentCoreServiceHarness } from "../service.js";

import type { Channel, ChannelMessage, DraftHandle, ReplyTarget } from "./channel.js";
import type { ChannelDispatcher } from "./dispatcher.js";
import { DraftUpdater } from "./draft.js";
import type { ThreadMapper } from "./types.js";
import { InMemoryThreadMapper } from "./types.js";

const log = createLogger("feishu");
const execFileAsync = promisify(execFile);
const FIND_RESULT_FILE_LIMIT = 20;
const FIND_RENDER_FILE_LIMIT = 5;
const FIND_SNIPPET_LIMIT_PER_FILE = 3;
const FIND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

// ── Config ────────────────────────────────────────────────────────

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  /** Only respond in these chat IDs. Empty / undefined = respond to all. */
  allowedChatIds?: string[];
  /** Throttle interval for draft updates (ms). Default: 500. */
  draftThrottleMs?: number;
}

// ── Platform event types ──────────────────────────────────────────

interface FeishuMessageEvent {
  sender: { sender_id: { open_id: string } };
  message: {
    chat_id: string;
    chat_type: string; // "p2p" | "group"
    message_id: string;
    message_type: string; // "text" | "image" | "post" | ...
    content: string;
    mentions?: Array<{ key: string; name: string }>;
  };
}

interface FeishuCardActionEvent {
  action: {
    value: { action?: string; threadId?: string; chatId?: string };
  };
}

// ── Reply target data ─────────────────────────────────────────────

interface FeishuReplyData {
  chatId: string;
}

interface FeishuDraftData {
  chatId: string;
  messageId: string;
}

// ── Channel implementation ────────────────────────────────────────

export class FeishuChannel implements Channel {
  readonly name = "feishu";

  private readonly config: FeishuChannelConfig;
  private readonly threadMapper: ThreadMapper;
  private client: any = null;
  private wsClient: any = null;
  private dispatcher: ChannelDispatcher | null = null;

  /**
   * Service reference — only used for HITL resume (button callback), which
   * bypasses the dispatcher because it's not a new user message.
   */
  private service: AgentCoreServiceHarness | null = null;

  constructor(config: FeishuChannelConfig, threadMapper?: ThreadMapper) {
    this.config = config;
    this.threadMapper = threadMapper ?? new InMemoryThreadMapper();
  }

  /** Inject service reference for HITL resume. Call before dispatcher.startAll(). */
  setService(service: AgentCoreServiceHarness): void {
    this.service = service;
  }

  // ── Channel trait: lifecycle ──────────────────────────────────

  async start(dispatcher: ChannelDispatcher): Promise<void> {
    this.dispatcher = dispatcher;

    let Lark: any;
    try {
      Lark = await import("@larksuiteoapi/node-sdk");
    } catch {
      throw new Error(
        "Feishu channel requires @larksuiteoapi/node-sdk. " +
          "Install it with: npm install @larksuiteoapi/node-sdk",
      );
    }

    const baseConfig = {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    };
    const noopEventHandler = async () => {};

    this.client = new Lark.Client(baseConfig);

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: FeishuMessageEvent) => {
        await this.onMessage(data);
      },
      "card.action.trigger": async (data: FeishuCardActionEvent) => {
        await this.onCardAction(data);
      },
      "im.message.message_read_v1": noopEventHandler,
      "im.message.reaction.created_v1": noopEventHandler,
      "im.message.reaction.deleted_v1": noopEventHandler,
      "im.message.recalled_v1": noopEventHandler,
    });

    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher });
    log.info("started", { mode: "websocket" });
  }

  async stop(): Promise<void> {
    this.wsClient = null;
    this.client = null;
    this.dispatcher = null;
    log.info("stopped");
  }

  // ── Channel trait: send ───────────────────────────────────────

  /**
   * Send a complete, non-streaming text message. Used for short replies /
   * error notifications that don't need streaming updates.
   */
  async send(target: ReplyTarget, content: string): Promise<string | null> {
    const { chatId } = target.data as FeishuReplyData;
    return this.sendTextMessage(chatId, content);
  }

  /**
   * Create an interactive card as draft. Feishu's `im.v1.message.patch`
   * only accepts interactive cards — plain text messages are immutable.
   * So draft lifecycle must use cards, and the content is rendered as
   * Markdown for proper formatting.
   */
  async sendDraft(target: ReplyTarget, content: string): Promise<DraftHandle | null> {
    const { chatId } = target.data as FeishuReplyData;
    const card = buildStreamingCard(content, /* streaming */ true);
    const messageId = await this.sendInteractiveCard(chatId, card);
    if (!messageId) return null;
    return {
      channelName: this.name,
      data: { chatId, messageId } satisfies FeishuDraftData,
    };
  }

  async updateDraft(handle: DraftHandle, content: string): Promise<void> {
    const { messageId } = handle.data as FeishuDraftData;
    const card = buildStreamingCard(content, /* streaming */ true);
    await this.patchCard(messageId, card);
  }

  async finalizeDraft(handle: DraftHandle, content: string): Promise<void> {
    const { messageId } = handle.data as FeishuDraftData;
    const card = buildStreamingCard(content, /* streaming */ false);
    await this.patchCard(messageId, card);
  }

  async cancelDraft(handle: DraftHandle): Promise<void> {
    const { messageId } = handle.data as FeishuDraftData;
    const card = buildStreamingCard("⏹ (cancelled)", /* streaming */ false);
    await this.patchCard(messageId, card);
  }

  /**
   * Send an approval card (HITL). Returns the message id so the handler can
   * await completion. The buttons' values encode action + threadId; clicking
   * triggers the `card.action.trigger` callback which our onCardAction
   * handler routes to `service.streamResume`.
   */
  async sendApprovalCard(
    target: ReplyTarget,
    opts: {
      threadId: string;
      title: string;
      body: string;
    },
  ): Promise<string | null> {
    const { chatId } = target.data as FeishuReplyData;
    const card = buildApprovalCard({
      threadId: opts.threadId,
      chatId,
      title: opts.title,
      body: opts.body,
    });
    return this.sendInteractiveCard(chatId, card);
  }

  // ── Inbound: message ──────────────────────────────────────────

  private async onMessage(event: FeishuMessageEvent): Promise<void> {
    if (!this.dispatcher || !this.client) return;

    const { message } = event;
    const chatId = message.chat_id;

    // Group chats: only respond to @mentions
    if (message.chat_type === "group") {
      if (!message.mentions?.length) return;
    }

    // Chat allowlist
    if (this.config.allowedChatIds?.length) {
      if (!this.config.allowedChatIds.includes(chatId)) return;
    }

    // Extract input (text + optional images)
    const { text, images } = await this.extractInput(message);
    if (!text && (!images || images.length === 0)) return;

    // Slash commands — handled inline, never reach the dispatcher.
    if (text && text.trim().startsWith("/")) {
      await this.handleSlashCommand(chatId, text.trim());
      return;
    }

    const threadId = await this.threadMapper.getOrCreate(chatId);
    const replyTarget: ReplyTarget = {
      channelName: this.name,
      data: { chatId } satisfies FeishuReplyData,
    };

    const channelMessage: ChannelMessage = {
      id: message.message_id || randomUUID(),
      channelName: this.name,
      scopeKey: `feishu:${chatId}`,
      replyTarget,
      text: text || "(image)",
      images,
      threadId,
      toolProfile: "chat",
      raw: event,
      timestamp: Date.now(),
    };

    if (!this.dispatcher.enqueue(channelMessage)) {
      log.warn("enqueue.backpressure", { chatId });
      await this.sendTextMessage(chatId, "⚠️ Too many messages queued. Try again shortly.");
    }
  }

  // ── Inbound: slash commands ───────────────────────────────────

  private async handleSlashCommand(chatId: string, raw: string): Promise<void> {
    const parts = raw.split(/\s+/);
    const cmd = parts[0]!.toLowerCase();

    switch (cmd) {
      case "/new":
      case "/reset": {
        if (!this.service) {
          await this.sendTextMessage(chatId, "⚠️ Service not ready");
          return;
        }
        const oldThreadId = this.threadMapper.get(chatId);
        if (oldThreadId) {
          try {
            await this.service.forgetThread(oldThreadId);
          } catch {
            // best-effort — continue anyway
          }
        }
        this.threadMapper.reset(chatId);
        await this.sendTextMessage(chatId, "✨ 已开新会话。之前的上下文已清空。");
        return;
      }

      case "/info":
      case "/status": {
        if (!this.service) {
          await this.sendTextMessage(chatId, "⚠️ Service not ready");
          return;
        }
        const threadId = this.threadMapper.get(chatId);
        if (!threadId) {
          await this.sendTextMessage(chatId, "当前没有活跃会话。直接发消息就能开始。");
          return;
        }
        const health = await this.service.getThreadHealth(threadId);
        const lines = [
          `📊 当前会话`,
          `- 消息条数：${health.messageCount}（用户 ${health.userTurns} / 助手 ${health.assistantTurns}）`,
          `- 估算 token：${health.estimatedTokens} / ${health.contextWindowHint}（${health.usagePercent}%）`,
        ];
        if (health.usagePercent >= 75) {
          lines.push("", "⚠️ 上下文接近满，建议 `/new` 开新会话。");
        }
        await this.sendTextMessage(chatId, lines.join("\n"));
        return;
      }

      case "/summarize":
      case "/tweet":
      case "/t": {
        const text = raw.slice(cmd.length).trim();
        if (!text) {
          await this.sendTextMessage(
            chatId,
            "用法：`/summarize <推文原文>`\n把推文内容粘在命令后面，我给你一个要点摘要。",
          );
          return;
        }
        await this.runSummarizeSkill(chatId, text);
        return;
      }

      case "/find":
      case "/search": {
        const keyword = raw.slice(cmd.length).trim();
        if (!keyword) {
          await this.sendTextMessage(chatId, "用法：`/find <关键词>` — 在 workspace 里搜代码");
          return;
        }
        await this.runFindSkill(chatId, keyword);
        return;
      }

      case "/help":
      case "/?": {
        const help = [
          "可用命令：",
          "• `/new` 或 `/reset` — 开新会话，清空上下文",
          "• `/info` 或 `/status` — 查看当前会话大小",
          "• `/summarize <文本>` — 总结一条推文/内容",
          "• `/find <关键词>` — 在 workspace 里搜索代码",
          "• `/help` — 显示本说明",
        ].join("\n");
        await this.sendTextMessage(chatId, help);
        return;
      }

      default: {
        await this.sendTextMessage(chatId, `未知命令：${cmd}。发送 \`/help\` 查看可用命令。`);
        return;
      }
    }
  }

  /**
   * Skill: summarize a single tweet / block of text.
   *
   * Reuses twitter-digest's summarize mode — wraps the user's text as a
   * synthetic bookmark with author="user" so the existing JSON schema
   * flow handles it. LLM output is constrained (zod-validated + one
   * retry) so Gemma's occasional malformed output doesn't hit the user.
   */
  private async runSummarizeSkill(chatId: string, text: string): Promise<void> {
    if (!this.service) {
      await this.sendTextMessage(chatId, "⚠️ Service not ready");
      return;
    }

    // Send interactive card immediately so user sees feedback while LLM runs.
    const replyTarget: ReplyTarget = {
      channelName: this.name,
      data: { chatId } satisfies FeishuReplyData,
    };
    const draft = await this.sendDraft(replyTarget, "✍️ 正在总结…");

    try {
      const { generateDigest, SummarizeResponseSchema } = await import("../twitter-digest.js");
      const result = await generateDigest(
        {
          mode: "summarize",
          bookmarks: [
            {
              id: "feishu-" + Date.now(),
              author: "user",
              text: text.slice(0, 4000), // guard against pathologically long input
            },
          ],
        },
        this.service.settings,
      );

      const parsed = SummarizeResponseSchema.safeParse(result);
      if (!parsed.success || parsed.data.items.length === 0) {
        const msg = "⚠️ 总结失败：模型输出格式有问题。再试一次，或把文本改短些。";
        if (draft) {
          await this.finalizeDraft(draft, msg);
        } else {
          await this.sendTextMessage(chatId, msg);
        }
        return;
      }

      const item = parsed.data.items[0]!;
      const rendered = [
        `**要点**`,
        item.summary,
        "",
        `**评分**  ${item.qualityScore}/10${item.tags.length > 0 ? ` · **tags**  ${item.tags.join(" ")}` : ""}`,
      ].join("\n");

      if (draft) {
        await this.finalizeDraft(draft, rendered);
      } else {
        await this.sendTextMessage(chatId, rendered);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("summarize.failed", { error: msg.slice(0, 200) });
      const fallback = `⚠️ 总结失败：${msg.slice(0, 150)}`;
      if (draft) {
        await this.finalizeDraft(draft, fallback);
      } else {
        await this.sendTextMessage(chatId, fallback);
      }
    }
  }

  private async runFindSkill(chatId: string, keyword: string): Promise<void> {
    if (!this.service) {
      await this.sendTextMessage(chatId, "⚠️ Service not ready");
      return;
    }

    const workspaceDir = path.resolve(this.service.settings.workspaceDir);
    const replyTarget: ReplyTarget = {
      channelName: this.name,
      data: { chatId } satisfies FeishuReplyData,
    };
    const draft = await this.sendDraft(replyTarget, `🔎 正在搜索 \`${keyword}\` …`);

    try {
      const candidateFiles = (await listWorkspaceMatches(workspaceDir, keyword)).slice(
        0,
        FIND_RESULT_FILE_LIMIT,
      );

      if (candidateFiles.length === 0) {
        const emptyMessage = `没有在 workspace 里找到包含 \`${keyword}\` 的 `.concat(
          "`.ts` / `.swift` / `.md` 文件。",
        );
        if (draft) {
          await this.finalizeDraft(draft, emptyMessage);
        } else {
          await this.sendTextMessage(chatId, emptyMessage);
        }
        return;
      }

      const renderedMatches = await Promise.all(
        candidateFiles
          .slice(0, FIND_RENDER_FILE_LIMIT)
          .map(async (filePath) => ({
            filePath,
            snippets: await collectFileSnippets(filePath, keyword),
          })),
      );

      const rendered = renderFindResults(workspaceDir, keyword, candidateFiles.length, renderedMatches);
      if (draft) {
        await this.finalizeDraft(draft, rendered);
      } else {
        await this.sendTextMessage(chatId, rendered);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("find.failed", {
        keyword: keyword.slice(0, 120),
        error: msg.slice(0, 200),
      });
      const fallback = `⚠️ 搜索失败：${msg.slice(0, 150)}`;
      if (draft) {
        await this.finalizeDraft(draft, fallback);
      } else {
        await this.sendTextMessage(chatId, fallback);
      }
    }
  }


  // ── Inbound: card action (HITL approval buttons) ──────────────

  private async onCardAction(event: FeishuCardActionEvent): Promise<void> {
    if (!this.service || !this.client) return;

    // Feishu SDK payloads vary — value can arrive as a plain object OR as a
    // JSON-encoded string, and some variants nest it under event.event.action.
    const value = extractCardActionValue(event);
    if (!value?.action || !value?.threadId) {
      log.warn("cardAction.unparsed", { event: JSON.stringify(event).slice(0, 300) });
      return;
    }

    const action = value.action === "approve" ? "approve" : "reject";
    const threadId = value.threadId;
    const originalMessageId = extractCardActionMessageId(event);
    // chatId often doesn't survive the button round-trip; recover it from
    // the threadId (format: "channel-{chatId}-{timestamp}") or look it up in
    // the thread mapper as a fallback.
    const chatId = value.chatId
      ?? extractChatIdFromThreadId(threadId)
      ?? this.findChatIdForThread(threadId);

    if (!chatId) {
      log.warn("cardAction.noChatId", { threadId, rawValue: value });
      return;
    }

    log.info("cardAction", { action, threadId, chatId });

    if (originalMessageId) {
      await this.patchCard(originalMessageId, buildProcessingCard(action));
    } else {
      log.debug("cardAction.messageIdMissing", {
        threadId,
        action,
      });
    }

    // Build HITLResponse
    const decision =
      action === "approve"
        ? { type: "approve" as const }
        : { type: "reject" as const, message: "Rejected via Feishu" };
    const resume = { decisions: [decision] };

    // Stream the resumed run back to the chat. Handle text_delta AND
    // run_interrupted — the latter happens when the middleware re-escalates
    // (e.g. tool-staging "verify" stage wants a second approval).
    const replyTarget: ReplyTarget = {
      channelName: this.name,
      data: { chatId } satisfies FeishuReplyData,
    };
    const draft = new DraftUpdater(this, replyTarget, this.config.draftThrottleMs ?? 500);

    try {
      // Use a HITL-specific scopeKey so a user's next chat message (which
      // uses scopeKey `feishu:{chatId}`) doesn't preempt an in-flight resume,
      // and a second button click only preempts another resume (idempotent).
      const stream = this.service.streamResume({
        threadId,
        resume,
        scopeKey: `feishu:${chatId}:hitl`,
      });

      for await (const streamEvent of stream) {
        if (streamEvent.type === "text_delta") {
          draft.push(streamEvent.delta);
        } else if (streamEvent.type === "run_interrupted") {
          // Another HITL request surfaced during resume — finalize what we
          // have, then send a fresh approval card.
          await draft.finalize();
          const body = formatApprovalBody(streamEvent.result?.interruptRequest);
          await this.sendApprovalCard(replyTarget, {
            threadId,
            title: "Needs approval",
            body,
          });
          return; // stop here; user will click Approve again
        } else if (streamEvent.type === "tool_failed" && streamEvent.error) {
          const errText = typeof streamEvent.error === "string"
            ? streamEvent.error
            : String(streamEvent.error);
          draft.push(`\n\n⚠️ Tool error: ${errText.slice(0, 100)}`);
        }
      }
      await draft.finalize();
    } catch (err) {
      await draft.cancel();
      const msg = err instanceof Error ? err.message : String(err);
      log.error("cardAction.error", { threadId, error: msg });
    }
  }

  /** Fallback: search the thread mapper for any chat mapped to this threadId. */
  private findChatIdForThread(threadId: string): string | undefined {
    // InMemoryThreadMapper doesn't expose iteration; check via known channels.
    // This is best-effort; prefer extractChatIdFromThreadId when possible.
    return undefined;
  }

  // ── Input extraction ──────────────────────────────────────────

  private async extractInput(
    message: FeishuMessageEvent["message"],
  ): Promise<{ text: string | null; images?: string[] }> {
    if (message.message_type === "image") {
      const imageUri = await this.downloadImage(message);
      return { text: null, images: imageUri ? [imageUri] : undefined };
    }

    if (message.message_type === "text") {
      return { text: this.extractTextContent(message) };
    }

    if (message.message_type === "post") {
      // Rich-text message — happens when pasted content has formatting,
      // links, or multiple paragraphs. Extract all text inline content.
      return { text: this.extractPostContent(message) };
    }

    // Unsupported message type — log and skip
    log.debug("unsupported.messageType", { type: message.message_type });
    return { text: null };
  }

  private extractTextContent(message: FeishuMessageEvent["message"]): string | null {
    try {
      const content = JSON.parse(message.content);
      let text = content.text as string;
      if (message.mentions) {
        for (const mention of message.mentions) {
          text = text.replace(mention.key, "").trim();
        }
      }
      return text || null;
    } catch {
      return null;
    }
  }

  private extractPostContent(message: FeishuMessageEvent["message"]): string | null {
    return parseFeishuPostContent(message.content, message.mentions);
  }

  /**
   * Download an image attachment from Feishu and return as base64 data URI.
   * Returns null on failure (non-fatal — the message just won't have images).
   */
  private async downloadImage(
    message: FeishuMessageEvent["message"],
  ): Promise<string | null> {
    try {
      const content = JSON.parse(message.content);
      const imageKey = content.image_key as string;
      if (!imageKey) return null;

      const buffer: Buffer = await this.client.im.v1.messageResource.get({
        path: { message_id: message.message_id, file_key: imageKey },
        params: { type: "image" },
      });

      const base64 = buffer.toString("base64");
      return `data:image/png;base64,${base64}`;
    } catch (err) {
      log.warn("downloadImage.failed", {
        messageId: message.message_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Feishu API helpers ────────────────────────────────────────

  private async sendTextMessage(chatId: string, text: string): Promise<string | null> {
    try {
      const response = await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
      return response?.data?.message_id ?? null;
    } catch (error) {
      log.error("sendTextMessage.failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async sendInteractiveCard(chatId: string, card: unknown): Promise<string | null> {
    try {
      const response = await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
      return response?.data?.message_id ?? null;
    } catch (error) {
      log.error("sendInteractiveCard.failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async patchCard(messageId: string, card: unknown): Promise<void> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err) {
      // Most likely reason: message too old (cards >24h can't be patched).
      // Log once at debug level but don't crash the stream.
      log.debug("patchCard.failed", {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Post-message parsing (rich text)
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a Feishu post message's `content` JSON.
 *
 * Shapes handled (either locale-wrapped or bare):
 *   { zh_cn: { title, content: [[el, el], [el]] } }
 *   { title, content: [[el, el]] }
 *
 * Inline elements we keep:
 *   { tag: "text", text: "..." }                       → text
 *   { tag: "a",    text: "...", href: "..." }          → "text (href)"
 * Ignored (but tolerated):
 *   { tag: "at" | "img" | unknown }                    → skipped
 *
 * Returns null if the payload is malformed or yields no text at all.
 *
 * Exported for unit testing.
 */
export function parseFeishuPostContent(
  rawContent: string,
  mentions?: ReadonlyArray<{ key: string; name: string }>,
): string | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawContent) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Unwrap locale wrapper if present (zh_cn / en_us / …).
  const localeKeys = Object.keys(raw).filter((k) => /^[a-z]{2}_[a-z]{2}$/i.test(k));
  const post = localeKeys.length > 0
    ? (raw[localeKeys[0]!] as Record<string, unknown>)
    : raw;

  const titleRaw = post.title;
  const contentRaw = post.content;
  if (!Array.isArray(contentRaw)) return null;

  const paragraphs: string[] = [];
  for (const line of contentRaw) {
    if (!Array.isArray(line)) continue;
    const pieces: string[] = [];
    for (const el of line) {
      if (!el || typeof el !== "object") continue;
      const tag = (el as { tag?: unknown }).tag;
      const t = (el as { text?: unknown }).text;
      const href = (el as { href?: unknown }).href;
      if (tag === "text" && typeof t === "string") {
        pieces.push(t);
      } else if (tag === "a" && typeof t === "string") {
        pieces.push(typeof href === "string" ? `${t} (${href})` : t);
      }
    }
    const joined = pieces.join("").trim();
    if (joined) paragraphs.push(joined);
  }

  let out = paragraphs.join("\n");
  if (typeof titleRaw === "string" && titleRaw.trim()) {
    out = `${titleRaw.trim()}\n\n${out}`;
  }

  if (mentions) {
    for (const mention of mentions) {
      out = out.replace(mention.key, "").trim();
    }
  }

  return out.trim() || null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * ThreadId format produced by InMemoryThreadMapper is
 * `channel-{chatId}-{timestamp}`. This reverses the encoding.
 */
function extractChatIdFromThreadId(threadId: string): string | undefined {
  if (!threadId.startsWith("channel-")) return undefined;
  // Strip leading "channel-" and trailing "-{timestamp}".
  const rest = threadId.slice("channel-".length);
  const lastDash = rest.lastIndexOf("-");
  if (lastDash <= 0) return undefined;
  const timestampPart = rest.slice(lastDash + 1);
  if (!/^\d+$/.test(timestampPart)) return undefined;
  return rest.slice(0, lastDash) || undefined;
}

/**
 * Render the first few tool-call args as a Markdown preview for the approval
 * card body. Same shape as the default handler uses — kept local so we can
 * reuse from onCardAction without a circular import.
 */
function formatApprovalBody(request: unknown): string {
  if (!request || typeof request !== "object") {
    return "The agent is requesting approval to run a sensitive tool.";
  }
  const actions = (request as { actionRequests?: Array<{ name: string; args?: unknown }> })
    .actionRequests;
  if (!Array.isArray(actions) || actions.length === 0) {
    return "The agent is requesting approval to continue.";
  }
  return actions
    .map((a) => {
      const args = a.args ?? {};
      const preview = Object.entries(args as Record<string, unknown>)
        .slice(0, 3)
        .map(([k, v]) => `- ${k}: ${String(v).slice(0, 60)}`)
        .join("\n");
      return `**${a.name}**${preview ? `\n${preview}` : ""}`;
    })
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Event payload helpers
// ---------------------------------------------------------------------------

interface ParsedCardActionValue {
  action?: string;
  threadId?: string;
  chatId?: string;
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function isPathInsideWorkspace(workspaceDir: string, candidatePath: string): boolean {
  const relative = path.relative(workspaceDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toDisplayPath(workspaceDir: string, filePath: string): string {
  return path.relative(workspaceDir, filePath).split(path.sep).join("/");
}

function scoreFindMatch(filePath: string, keyword: string): number {
  const normalizedPath = filePath.split(path.sep).join("/").toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const baseName = path.basename(normalizedPath);
  let score = 0;

  if (
    baseName === `${lowerKeyword}.ts` ||
    baseName === `${lowerKeyword}.swift` ||
    baseName === `${lowerKeyword}.md`
  ) {
    score += 100;
  }
  if (baseName.includes(lowerKeyword)) {
    score += 40;
  }
  if (normalizedPath.includes("/src/")) {
    score += 30;
  }
  if (normalizedPath.includes("/channels/")) {
    score += 20;
  }
  if (normalizedPath.includes("/tests/")) {
    score -= 5;
  }
  if (normalizedPath.endsWith("/readme.md")) {
    score -= 10;
  }
  return score;
}

function truncateLine(text: string, maxLength = 160): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

async function runGrep(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("grep", args, {
      cwd: "/",
      encoding: "utf8",
      maxBuffer: FIND_MAX_BUFFER_BYTES,
    });
    return result.stdout;
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
    };
    if (String(execError.code) === "1") {
      return execError.stdout ?? "";
    }
    throw new Error(execError.stderr || execError.message || "grep failed");
  }
}

async function listWorkspaceMatches(workspaceDir: string, keyword: string): Promise<string[]> {
  const stdout = await runGrep([
    "-rnlF",
    "--exclude-dir=.agent-core",
    "--exclude-dir=node_modules",
    "--exclude-dir=dist",
    "--exclude-dir=.git",
    "--include=*.ts",
    "--include=*.swift",
    "--include=*.md",
    "--",
    keyword,
    workspaceDir,
  ]);

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((filePath) => path.resolve(filePath))
    .filter((filePath) => isPathInsideWorkspace(workspaceDir, filePath))
    .sort((a, b) => {
      const scoreDiff = scoreFindMatch(b, keyword) - scoreFindMatch(a, keyword);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return toDisplayPath(workspaceDir, a).localeCompare(toDisplayPath(workspaceDir, b));
    })
    .slice(0, FIND_RESULT_FILE_LIMIT);
}

async function collectFileSnippets(
  filePath: string,
  keyword: string,
): Promise<string[]> {
  const stdout = await runGrep(["-nF", "--", keyword, filePath]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, FIND_SNIPPET_LIMIT_PER_FILE)
    .map((line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) {
        return truncateLine(line);
      }
      const lineNumber = line.slice(0, separatorIndex);
      const content = line.slice(separatorIndex + 1).trim();
      return `L${lineNumber}: ${truncateLine(content)}`;
    });
}

function renderFindResults(
  workspaceDir: string,
  keyword: string,
  totalMatches: number,
  matches: Array<{ filePath: string; snippets: string[] }>,
): string {
  const lines = [`**${totalMatches} 个文件匹配 "${keyword}"**`];

  for (const match of matches) {
    lines.push(`- \`${toDisplayPath(workspaceDir, match.filePath)}\``);
    lines.push("```text");
    lines.push(...(match.snippets.length > 0 ? match.snippets : ["(有文件命中，但片段读取为空)"]));
    lines.push("```");
  }

  if (totalMatches > matches.length) {
    lines.push("", `_仅展示前 ${matches.length} 个文件，已截断。_`);
  }

  return lines.join("\n");
}

/**
 * Best-effort extraction of the button's value from a card.action.trigger
 * event. Handles three observed shapes from the Feishu SDK:
 *
 *  1. event.action.value = { action, threadId, chatId }
 *  2. event.action.value = '{"action":"approve", ...}'   (stringified)
 *  3. event.event.action.value = ...                     (wrapped)
 */
function extractCardActionValue(event: unknown): ParsedCardActionValue | null {
  if (!event || typeof event !== "object") return null;

  // Shape 3: unwrap outer event.event
  const unwrapped =
    (event as { event?: unknown }).event && typeof (event as { event?: unknown }).event === "object"
      ? (event as { event: unknown }).event
      : event;

  const action = (unwrapped as { action?: unknown }).action;
  if (!action || typeof action !== "object") return null;
  const rawValue = (action as { value?: unknown }).value;

  if (!rawValue) return null;
  if (typeof rawValue === "object") {
    return rawValue as ParsedCardActionValue;
  }
  if (typeof rawValue === "string") {
    try {
      return JSON.parse(rawValue) as ParsedCardActionValue;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Best-effort extraction of the original interactive card message id from a
 * card.action.trigger payload. Observed Feishu SDK shapes vary, so we check
 * several likely locations and return the first non-empty string.
 */
function extractCardActionMessageId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }

  const wrapped = event as {
    open_message_id?: unknown;
    message_id?: unknown;
    event?: {
      open_message_id?: unknown;
      message_id?: unknown;
      message?: { message_id?: unknown };
      action?: { open_message_id?: unknown; message_id?: unknown };
      context?: { open_message_id?: unknown; message_id?: unknown };
    };
    action?: { open_message_id?: unknown; message_id?: unknown };
    context?: { open_message_id?: unknown; message_id?: unknown };
  };

  return firstNonEmptyString([
    wrapped.open_message_id,
    wrapped.message_id,
    wrapped.event?.open_message_id,
    wrapped.event?.message_id,
    wrapped.event?.message?.message_id,
    wrapped.action?.open_message_id,
    wrapped.action?.message_id,
    wrapped.event?.action?.open_message_id,
    wrapped.event?.action?.message_id,
    wrapped.context?.open_message_id,
    wrapped.context?.message_id,
    wrapped.event?.context?.open_message_id,
    wrapped.event?.context?.message_id,
  ]);
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

/**
 * Build an interactive card for streaming replies. When `streaming` is true
 * a small "generating…" note is appended; when false the card is final.
 *
 * Uses the old-style card schema (config/header/elements) since that's what
 * the SDK type stub exposes and what's widely supported. Markdown content
 * is rendered by Feishu's `markdown` element.
 */
function buildStreamingCard(content: string, streaming: boolean): unknown {
  const body = content.length > 0 ? content : "…";
  const elements: unknown[] = [
    {
      tag: "markdown",
      content: body,
    },
  ];
  if (streaming) {
    elements.push({
      tag: "note",
      elements: [
        { tag: "plain_text", content: "Mantle · generating…" },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    elements,
  };
}

export function buildProcessingCard(action: "approve" | "reject"): unknown {
  const approved = action === "approve";
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: approved ? "green" : "red",
      title: {
        tag: "plain_text",
        content: approved ? "Approval received" : "Request rejected",
      },
    },
    elements: [
      {
        tag: "markdown",
        content: approved ? "✅ Approved · 处理中…" : "❌ Rejected",
      },
    ],
  };
}

/**
 * HITL approval card. Button values encode the routing so card.action.trigger
 * can call service.streamResume with the right HITLResponse.
 */
function buildApprovalCard(opts: {
  threadId: string;
  chatId: string;
  title: string;
  body: string;
}): unknown {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: opts.title },
    },
    elements: [
      { tag: "markdown", content: opts.body },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Approve" },
            type: "primary",
            value: {
              action: "approve",
              threadId: opts.threadId,
              chatId: opts.chatId,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Reject" },
            type: "danger",
            value: {
              action: "reject",
              threadId: opts.threadId,
              chatId: opts.chatId,
            },
          },
        ],
      },
    ],
  };
}

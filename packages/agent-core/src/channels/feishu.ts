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

import { randomUUID } from "node:crypto";

import { createLogger } from "../logger.js";
import type { AgentCoreServiceHarness } from "../service.js";

import type { Channel, ChannelMessage, DraftHandle, ReplyTarget } from "./channel.js";
import type { ChannelDispatcher } from "./dispatcher.js";
import { DraftUpdater } from "./draft.js";
import type { ThreadMapper } from "./types.js";
import { InMemoryThreadMapper } from "./types.js";

const log = createLogger("feishu");

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

    this.client = new Lark.Client(baseConfig);

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: FeishuMessageEvent) => {
        await this.onMessage(data);
      },
      "card.action.trigger": async (data: FeishuCardActionEvent) => {
        await this.onCardAction(data);
      },
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

      case "/help":
      case "/?": {
        const help = [
          "可用命令：",
          "• `/new` 或 `/reset` — 开新会话，清空上下文",
          "• `/info` 或 `/status` — 查看当前会话大小",
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

    const action = value.action;
    const threadId = value.threadId;
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
      const stream = this.service.streamResume({
        threadId,
        resume,
        scopeKey: `feishu:${chatId}`,
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

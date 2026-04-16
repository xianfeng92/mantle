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

  async send(target: ReplyTarget, content: string): Promise<string | null> {
    const { chatId } = target.data as FeishuReplyData;
    return this.sendTextMessage(chatId, content);
  }

  async sendDraft(target: ReplyTarget, content: string): Promise<DraftHandle | null> {
    const { chatId } = target.data as FeishuReplyData;
    const messageId = await this.sendTextMessage(chatId, content);
    if (!messageId) return null;
    return {
      channelName: this.name,
      data: { chatId, messageId } satisfies FeishuDraftData,
    };
  }

  async updateDraft(handle: DraftHandle, content: string): Promise<void> {
    const { messageId } = handle.data as FeishuDraftData;
    await this.patchMessage(messageId, content);
  }

  async finalizeDraft(handle: DraftHandle, content: string): Promise<void> {
    const { messageId } = handle.data as FeishuDraftData;
    await this.patchMessage(messageId, content);
  }

  async cancelDraft(handle: DraftHandle): Promise<void> {
    const { messageId } = handle.data as FeishuDraftData;
    await this.patchMessage(messageId, "⏹ (cancelled)");
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

  // ── Inbound: card action (HITL approval buttons) ──────────────

  private async onCardAction(event: FeishuCardActionEvent): Promise<void> {
    if (!this.service || !this.client) return;

    const value = event.action?.value;
    if (!value?.action || !value?.threadId) return;

    const action = value.action;
    const threadId = value.threadId;
    const chatId = value.chatId;

    log.info("cardAction", { action, threadId });

    // Build HITLResponse
    const decision =
      action === "approve"
        ? { type: "approve" as const }
        : { type: "reject" as const, message: "Rejected via Feishu" };
    const resume = { decisions: [decision] };

    // Stream the resumed run back to the chat
    const replyTarget: ReplyTarget = {
      channelName: this.name,
      data: { chatId: chatId ?? threadId } satisfies FeishuReplyData,
    };
    const draft = new DraftUpdater(this, replyTarget, this.config.draftThrottleMs ?? 500);

    try {
      const stream = this.service.streamResume({
        threadId,
        resume,
        scopeKey: `feishu:${chatId ?? threadId}`,
      });

      for await (const event of stream) {
        if (event.type === "text_delta") {
          draft.push(event.delta);
        }
      }
      await draft.finalize();
    } catch (err) {
      await draft.cancel();
      const msg = err instanceof Error ? err.message : String(err);
      log.error("cardAction.error", { threadId, error: msg });
    }
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

  private async patchMessage(messageId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }) },
      });
    } catch {
      // Update may fail if message is too old; silently ignore
    }
  }
}

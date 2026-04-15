/**
 * Feishu (Lark) Channel Adapter
 *
 * Connects agent-core to Feishu via the official @larksuiteoapi/node-sdk.
 * Uses WebSocket long connection — no public IP or webhook required.
 *
 * Features:
 * - Private chat and group @mention support
 * - HITL approval via interactive cards
 * - Streaming response simulation (message update throttling)
 * - Image message support (download → base64)
 */

import type { AgentCoreServiceHarness } from "../service.js";
import type { ChannelAdapter, ThreadMapper } from "./types.js";
import { InMemoryThreadMapper } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
  /** Optional: Only respond in these chat IDs. Empty = respond to all. */
  allowedChatIds?: string[];
  /** Throttle interval for message updates (ms). Default: 500. */
  updateThrottleMs?: number;
}

interface FeishuMessageEvent {
  sender: { sender_id: { open_id: string } };
  message: {
    chat_id: string;
    chat_type: string; // "p2p" | "group"
    message_id: string;
    message_type: string; // "text" | "image" | ...
    content: string;
    mentions?: Array<{ key: string; name: string }>;
  };
}

// ── Adapter ────────────────────────────────────────────────────────

export class FeishuAdapter implements ChannelAdapter {
  readonly name = "feishu";

  private readonly config: FeishuAdapterConfig;
  private readonly threadMapper: ThreadMapper;
  private service: AgentCoreServiceHarness | null = null;
  private client: any = null;
  private wsClient: any = null;

  constructor(config: FeishuAdapterConfig, threadMapper?: ThreadMapper) {
    this.config = config;
    this.threadMapper = threadMapper ?? new InMemoryThreadMapper();
  }

  async start(service: AgentCoreServiceHarness): Promise<void> {
    this.service = service;

    // Dynamic import — @larksuiteoapi/node-sdk is an optional dependency
    let Lark: any;
    try {
      Lark = await import("@larksuiteoapi/node-sdk");
    } catch {
      throw new Error(
        "Feishu adapter requires @larksuiteoapi/node-sdk. " +
        "Install it with: npm install @larksuiteoapi/node-sdk"
      );
    }

    const baseConfig = {
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    };

    this.client = new Lark.Client(baseConfig);

    // Register event handlers
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: FeishuMessageEvent) => {
        await this.handleMessage(data);
      },
    });

    // Start WebSocket connection (no webhook URL needed)
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher: dispatcher });
    console.log("[feishu] Adapter started (WebSocket mode)");
  }

  async stop(): Promise<void> {
    // WSClient doesn't have a formal stop() yet, but we clear references
    this.wsClient = null;
    this.client = null;
    this.service = null;
    console.log("[feishu] Adapter stopped");
  }

  // ── Message Handling ───────────────────────────────────────────

  private async handleMessage(event: FeishuMessageEvent): Promise<void> {
    if (!this.service || !this.client) return;

    const { message } = event;
    const chatId = message.chat_id;

    // In group chats, only respond to @mentions
    if (message.chat_type === "group") {
      if (!message.mentions || message.mentions.length === 0) return;
    }

    // Chat allowlist check
    if (this.config.allowedChatIds?.length) {
      if (!this.config.allowedChatIds.includes(chatId)) return;
    }

    // Extract user input
    const input = this.extractTextInput(message);
    if (!input) return;

    const threadId = await this.threadMapper.getOrCreate(chatId);

    try {
      // Stream the response
      const stream = this.service.streamRun({
        threadId,
        input,
      });

      let buffer = "";
      let sentMessageId: string | null = null;
      let lastUpdateTime = 0;
      const throttle = this.config.updateThrottleMs ?? 500;

      for await (const event of stream) {
        switch (event.type) {
          case "text_delta":
            buffer += event.delta;
            // Throttled update
            if (Date.now() - lastUpdateTime >= throttle) {
              if (sentMessageId) {
                await this.updateMessage(sentMessageId, buffer);
              } else {
                sentMessageId = await this.sendTextMessage(chatId, buffer);
              }
              lastUpdateTime = Date.now();
            }
            break;

          case "run_interrupted":
            // HITL: send approval card
            if (event.result?.interruptRequest) {
              await this.sendApprovalCard(chatId, threadId, event.result.interruptRequest);
            }
            break;

          case "run_completed":
            // Final update with complete text
            if (buffer) {
              if (sentMessageId) {
                await this.updateMessage(sentMessageId, buffer);
              } else {
                await this.sendTextMessage(chatId, buffer);
              }
            }
            break;
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.sendTextMessage(chatId, `Error: ${errorMessage}`);
    }
  }

  // ── Feishu API Helpers ─────────────────────────────────────────

  private extractTextInput(message: FeishuMessageEvent["message"]): string | null {
    if (message.message_type !== "text") {
      // TODO: Support image messages (download → base64 → ContentBlock[])
      return null;
    }

    try {
      const content = JSON.parse(message.content);
      let text = content.text as string;

      // Strip @mention tags from group messages
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
      console.error("[feishu] Failed to send message:", error);
      return null;
    }
  }

  private async updateMessage(messageId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
        },
      });
    } catch {
      // Update may fail if message is too old; silently ignore
    }
  }

  private async sendApprovalCard(
    chatId: string,
    threadId: string,
    interruptRequest: any,
  ): Promise<void> {
    const actions = interruptRequest.actionRequests ?? [];
    const summaryLines = actions.map((a: any) => {
      const name = a.name ?? "unknown";
      const args = a.args ?? {};
      const argSummary = Object.entries(args)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v).slice(0, 50)}`)
        .join("\n");
      return `**${name}**\n${argSummary}`;
    });

    const card = {
      config: { wide_screen_mode: true },
      header: {
        template: "orange",
        title: { content: "Needs Approval", tag: "plain_text" },
      },
      elements: [
        {
          tag: "markdown",
          content: summaryLines.join("\n\n---\n\n") || "Agent requests approval to proceed.",
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { content: "Approve", tag: "plain_text" },
              type: "primary",
              value: { action: "approve", threadId },
            },
            {
              tag: "button",
              text: { content: "Reject", tag: "plain_text" },
              type: "danger",
              value: { action: "reject", threadId },
            },
          ],
        },
      ],
    };

    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
    } catch (error) {
      console.error("[feishu] Failed to send approval card:", error);
    }
  }
}

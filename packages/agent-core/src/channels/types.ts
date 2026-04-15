/**
 * Channel Adapter Interface
 *
 * A channel adapter connects agent-core to an external messaging platform
 * (Feishu, Telegram, Discord, etc.). It wraps the AgentCoreServiceHarness
 * and handles protocol translation.
 */

import type { AgentCoreServiceHarness } from "../service.js";

export interface ChannelAdapter {
  /** Human-readable name for logging. */
  readonly name: string;

  /**
   * Start the adapter. Connects to the messaging platform and begins
   * listening for messages.
   */
  start(service: AgentCoreServiceHarness): Promise<void>;

  /**
   * Gracefully stop the adapter. Disconnects from the platform.
   */
  stop(): Promise<void>;
}

/**
 * Maps a channel-specific user/chat identifier to a persistent threadId.
 * Adapters use this to maintain conversation continuity.
 */
export interface ThreadMapper {
  /** Get or create a threadId for a channel-specific chat identifier. */
  getOrCreate(channelChatId: string): Promise<string>;

  /** Get the threadId for a channel-specific chat identifier, if it exists. */
  get(channelChatId: string): string | undefined;
}

/**
 * Simple in-memory thread mapper. Suitable for single-instance deployments.
 */
export class InMemoryThreadMapper implements ThreadMapper {
  private readonly map = new Map<string, string>();

  async getOrCreate(channelChatId: string): Promise<string> {
    let threadId = this.map.get(channelChatId);
    if (!threadId) {
      threadId = `channel-${channelChatId}-${Date.now()}`;
      this.map.set(channelChatId, threadId);
    }
    return threadId;
  }

  get(channelChatId: string): string | undefined {
    return this.map.get(channelChatId);
  }
}

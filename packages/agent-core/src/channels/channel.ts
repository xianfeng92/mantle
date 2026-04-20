// MARK: Channel trait
//
// Spec: docs/specs/2026-04-17-channel-trait-spec.md
//
// A Channel is a messaging-platform driver (Feishu, Telegram, Slack, …).
// Each Channel implements listen + reply primitives; the ChannelDispatcher
// owns the message queue, scope routing, and draft lifecycle.
//
// Design borrowed from ZeroClaw's Channel trait:
//   listen() → fan-in to dispatcher
//   send() / draft lifecycle → fan-out back to platform

import type { ChannelDispatcher } from "./dispatcher.js";
import type { ToolProfile } from "./tool-profile.js";

// ---------------------------------------------------------------------------
// Reply target — opaque handle the channel understands
// ---------------------------------------------------------------------------

/**
 * Identifies where to send a reply. Channels populate this with platform-
 * specific IDs (chat_id, message_id, etc.). The dispatcher passes it back
 * opaquely on send / draft calls.
 */
export interface ReplyTarget {
  /** Channel name this target belongs to. */
  channelName: string;
  /** Platform-specific payload (e.g. { chatId, messageId }). */
  data: unknown;
}

// ---------------------------------------------------------------------------
// Draft handle — tracks an in-flight streaming message
// ---------------------------------------------------------------------------

/**
 * Returned by `sendDraft`; passed to `updateDraft` / `finalizeDraft` /
 * `cancelDraft`. Channels store platform message IDs here so they can
 * edit the message in-place during streaming.
 */
export interface DraftHandle {
  channelName: string;
  /** Platform-specific draft state (e.g. Feishu message_id). */
  data: unknown;
}

// ---------------------------------------------------------------------------
// Inbound message
// ---------------------------------------------------------------------------

export interface ChannelMessage {
  /** Unique id (uuid or platform message id). */
  id: string;
  /** Which channel produced this message. */
  channelName: string;
  /**
   * Interruption scope key. Same-scope messages preempt the previous one;
   * cross-scope messages run concurrently.
   *
   * Convention: `"<channelName>:<chatId>"` for IM channels.
   */
  scopeKey: string;
  /** Reply target for sending responses back. */
  replyTarget: ReplyTarget;
  /** Extracted text content. */
  text: string;
  /** Image attachments as base64 data URIs (already processed by media pipeline). */
  images?: string[];
  /** ThreadId to use for the agent run (from ThreadMapper). */
  threadId: string;
  /** Per-turn tool visibility profile. */
  toolProfile?: ToolProfile;
  /** Original platform-specific message (for audit / debugging). */
  raw?: unknown;
  /** Unix ms timestamp. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Channel interface
// ---------------------------------------------------------------------------

export interface Channel {
  /** Human-readable name (e.g. "feishu", "telegram"). */
  readonly name: string;

  /**
   * Start listening for inbound messages. Push each message into `dispatcher`
   * via `dispatcher.enqueue(message)`. The channel should NOT call
   * service.streamRun directly — that's the dispatcher's job.
   */
  start(dispatcher: ChannelDispatcher): Promise<void>;

  /** Gracefully stop the listener. */
  stop(): Promise<void>;

  // -- Reply primitives --

  /** Send a complete, non-streaming message. Returns platform message id or null. */
  send(target: ReplyTarget, content: string): Promise<string | null>;

  // -- Draft (streaming) lifecycle --

  /** Create a new draft message with initial content. */
  sendDraft(target: ReplyTarget, content: string): Promise<DraftHandle | null>;

  /** Update an existing draft in-place (called repeatedly during streaming). */
  updateDraft(handle: DraftHandle, content: string): Promise<void>;

  /** Finalize the draft with the final content (streaming complete). */
  finalizeDraft(handle: DraftHandle, content: string): Promise<void>;

  /** Cancel / delete the draft (streaming aborted). */
  cancelDraft(handle: DraftHandle): Promise<void>;

  // -- Optional: HITL approval ---------------------------------------------

  /**
   * Optional. Send an interactive approval prompt. Platforms that can render
   * buttons (Feishu / Slack / Discord) implement this; the channel's button
   * callback should then route to `service.streamResume`.
   *
   * If not implemented, the default handler falls back to an inline text
   * note telling the user to approve via another surface.
   */
  sendApprovalCard?(
    target: ReplyTarget,
    opts: {
      threadId: string;
      title: string;
      body: string;
    },
  ): Promise<string | null>;
}

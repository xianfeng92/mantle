// Channel trait + dispatch layer
//
// Spec: docs/specs/2026-04-17-channel-trait-spec.md

export type {
  Channel,
  ChannelMessage,
  DraftHandle,
  ReplyTarget,
} from "./channel.js";

export {
  ChannelDispatcher,
  type ChannelMessageHandler,
} from "./dispatcher.js";

export { DraftUpdater } from "./draft.js";

export {
  createDefaultHandler,
  type DefaultHandlerOptions,
} from "./default-handler.js";

// Legacy types (used by existing feishu adapter; will be migrated later)
export { type ChannelAdapter, type ThreadMapper, InMemoryThreadMapper } from "./types.js";

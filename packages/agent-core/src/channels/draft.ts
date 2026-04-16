import type { Channel, DraftHandle, ReplyTarget } from "./channel.js";

// MARK: DraftUpdater
//
// ZeroClaw equivalent: `draft_updater` sidecar task.
//
// Buffers streaming text deltas and throttles updateDraft calls so the
// IM platform doesn't rate-limit us. On finalize, sends the complete text.
// On cancel (preemption / error), discards or deletes the draft.

const DEFAULT_THROTTLE_MS = 500;

export class DraftUpdater {
  private readonly channel: Channel;
  private readonly target: ReplyTarget;
  private readonly throttleMs: number;

  private buffer = "";
  private handle: DraftHandle | null = null;
  private lastUpdateTime = 0;
  private pendingFlush: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private cancelled = false;

  constructor(
    channel: Channel,
    target: ReplyTarget,
    throttleMs = DEFAULT_THROTTLE_MS,
  ) {
    this.channel = channel;
    this.target = target;
    this.throttleMs = throttleMs;
  }

  /**
   * Append a text delta. The draft is created on the first push, then
   * updated at most once per `throttleMs`.
   */
  push(delta: string): void {
    if (this.finalized || this.cancelled) return;
    this.buffer += delta;
    this.scheduleFlush();
  }

  /** Send the final version of the draft and mark it complete. */
  async finalize(): Promise<void> {
    if (this.finalized || this.cancelled) return;
    this.finalized = true;
    this.clearPendingFlush();

    if (this.handle) {
      await this.channel.finalizeDraft(this.handle, this.buffer);
    } else if (this.buffer) {
      // Never created a draft (very short response) — just send.
      await this.channel.send(this.target, this.buffer);
    }
  }

  /** Cancel the draft (preemption or error). */
  async cancel(): Promise<void> {
    if (this.finalized || this.cancelled) return;
    this.cancelled = true;
    this.clearPendingFlush();

    if (this.handle) {
      await this.channel.cancelDraft(this.handle);
    }
  }

  /** Current accumulated text (for testing / inspection). */
  get currentText(): string {
    return this.buffer;
  }

  // -- Internal -------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.pendingFlush) return; // already scheduled

    const elapsed = Date.now() - this.lastUpdateTime;
    const delay = Math.max(0, this.throttleMs - elapsed);

    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      void this.flush();
    }, delay);
  }

  private clearPendingFlush(): void {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
  }

  private async flush(): Promise<void> {
    if (this.finalized || this.cancelled || !this.buffer) return;
    this.lastUpdateTime = Date.now();

    if (!this.handle) {
      this.handle = await this.channel.sendDraft(this.target, this.buffer);
    } else {
      await this.channel.updateDraft(this.handle, this.buffer);
    }
  }
}

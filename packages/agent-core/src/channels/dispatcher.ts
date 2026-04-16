import { createLogger } from "../logger.js";
import type { Channel, ChannelMessage } from "./channel.js";

const log = createLogger("channel-dispatch");

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

/**
 * Function that processes a single inbound channel message.
 *
 * Called by the dispatcher with:
 * - `message`: the unified ChannelMessage
 * - `channel`: the Channel that produced it (for send / draft calls)
 * - `signal`: AbortSignal that fires if a newer same-scope message preempts this one
 *
 * The default handler (see `default-handler.ts`) wires this into
 * `service.streamRun` + `DraftUpdater`.
 */
export type ChannelMessageHandler = (
  message: ChannelMessage,
  channel: Channel,
  signal: AbortSignal,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const DEFAULT_CAPACITY = 100;

/**
 * Bounded async message queue with scope-based interruption.
 *
 * ZeroClaw equivalent: `mpsc<ChannelMessage>(100)` + `run_message_dispatch_loop`.
 *
 * Channels push messages via `enqueue()`; the dispatcher consumes them
 * one at a time per scope. Same-scope messages preempt the previous handler;
 * cross-scope messages run concurrently.
 *
 * Node.js is single-threaded so we don't need a real mpsc — a plain array +
 * microtask drain is sufficient and easier to reason about.
 */
export class ChannelDispatcher {
  private readonly channels = new Map<string, Channel>();
  private readonly queue: ChannelMessage[] = [];
  private readonly capacity: number;
  private handler: ChannelMessageHandler | null = null;

  /** Active scope controllers — same-scope preemption. */
  private readonly activeScopes = new Map<string, AbortController>();
  /** Track running handler count for graceful shutdown. */
  private runningCount = 0;
  private draining = false;
  private stopped = false;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  // -- Setup ----------------------------------------------------------------

  /** Register the handler that processes each message. Must be called before start. */
  setHandler(handler: ChannelMessageHandler): void {
    this.handler = handler;
  }

  /** Register a channel. Does NOT start it — call `startAll()` after registration. */
  registerChannel(channel: Channel): void {
    if (this.channels.has(channel.name)) {
      log.warn("channel.duplicate", { name: channel.name });
    }
    this.channels.set(channel.name, channel);
  }

  /** Start all registered channels (they begin pushing messages). */
  async startAll(): Promise<void> {
    this.stopped = false;
    for (const channel of this.channels.values()) {
      try {
        await channel.start(this);
        log.info("channel.started", { name: channel.name });
      } catch (err) {
        log.error("channel.startFailed", {
          name: channel.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Stop all channels and abort any running handlers. */
  async stopAll(): Promise<void> {
    this.stopped = true;
    // Abort all running handlers.
    for (const [key, ctrl] of this.activeScopes) {
      ctrl.abort();
      this.activeScopes.delete(key);
    }
    // Stop channels.
    for (const channel of this.channels.values()) {
      try {
        await channel.stop();
      } catch {
        // swallow — we're shutting down
      }
    }
    // Drain queue.
    this.queue.length = 0;
  }

  /** Look up a registered channel by name. */
  getChannel(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  // -- Enqueue --------------------------------------------------------------

  /**
   * Push a message into the dispatch queue. Called by Channel implementations
   * from their `start()` listener loop.
   *
   * Returns `false` if the queue is full (back-pressure signal).
   */
  enqueue(message: ChannelMessage): boolean {
    if (this.stopped) return false;
    if (this.queue.length >= this.capacity) {
      log.warn("queue.full", {
        channelName: message.channelName,
        scopeKey: message.scopeKey,
        dropped: message.id,
      });
      return false;
    }
    this.queue.push(message);
    log.debug("queue.enqueue", {
      channelName: message.channelName,
      scopeKey: message.scopeKey,
      queueLength: this.queue.length,
    });
    // Kick the drain loop on next microtask so synchronous enqueue batches
    // complete before any message is shifted out.
    if (!this.draining) {
      queueMicrotask(() => void this.drain());
    }
    return true;
  }

  // -- Drain loop -----------------------------------------------------------

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const message = this.queue.shift()!;
        // Fire-and-forget so cross-scope messages run concurrently.
        void this.dispatch(message);
        // Yield to the event loop between dispatches so enqueue() can run.
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      this.draining = false;
    }
  }

  private async dispatch(message: ChannelMessage): Promise<void> {
    const channel = this.channels.get(message.channelName);
    if (!channel) {
      log.warn("dispatch.unknownChannel", { channelName: message.channelName });
      return;
    }
    if (!this.handler) {
      log.warn("dispatch.noHandler");
      return;
    }

    // Scope-based preemption: abort previous handler in the same scope.
    const existing = this.activeScopes.get(message.scopeKey);
    if (existing) {
      log.info("scope.preempt", { scopeKey: message.scopeKey, newMessageId: message.id });
      existing.abort();
    }

    const controller = new AbortController();
    this.activeScopes.set(message.scopeKey, controller);
    this.runningCount += 1;

    try {
      await this.handler(message, channel, controller.signal);
    } catch (err) {
      // AbortError is expected when preempted — don't log as error.
      if (!controller.signal.aborted) {
        log.error("dispatch.handlerError", {
          scopeKey: message.scopeKey,
          channelName: message.channelName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      this.runningCount -= 1;
      // Only remove scope entry if we're still the active occupant.
      const current = this.activeScopes.get(message.scopeKey);
      if (current === controller) {
        this.activeScopes.delete(message.scopeKey);
      }
    }
  }

  // -- Status ---------------------------------------------------------------

  get queueLength(): number {
    return this.queue.length;
  }

  get activeCount(): number {
    return this.runningCount;
  }

  get registeredChannels(): string[] {
    return Array.from(this.channels.keys());
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import { ChannelDispatcher, DraftUpdater } from "../src/channels/index.js";
import type {
  Channel,
  ChannelMessage,
  DraftHandle,
  ReplyTarget,
} from "../src/channels/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    channelName: "test",
    scopeKey: "test:chat-1",
    replyTarget: { channelName: "test", data: { chatId: "chat-1" } },
    text: "hello",
    threadId: "thread-1",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Minimal Channel stub. Records all calls for assertions. */
function makeStubChannel(): Channel & {
  sentMessages: string[];
  drafts: Array<{ action: string; content: string }>;
} {
  const sentMessages: string[] = [];
  const drafts: Array<{ action: string; content: string }> = [];
  return {
    name: "test",
    sentMessages,
    drafts,
    async start() {},
    async stop() {},
    async send(_target: ReplyTarget, content: string) {
      sentMessages.push(content);
      return "sent-1";
    },
    async sendDraft(_target: ReplyTarget, content: string) {
      drafts.push({ action: "create", content });
      return { channelName: "test", data: { draftId: "d-1" } } as DraftHandle;
    },
    async updateDraft(_handle: DraftHandle, content: string) {
      drafts.push({ action: "update", content });
    },
    async finalizeDraft(_handle: DraftHandle, content: string) {
      drafts.push({ action: "finalize", content });
    },
    async cancelDraft(_handle: DraftHandle) {
      drafts.push({ action: "cancel", content: "" });
    },
  };
}

// ---------------------------------------------------------------------------
// ChannelDispatcher
// ---------------------------------------------------------------------------

test("dispatcher: enqueue + handler receives message", async () => {
  const dispatcher = new ChannelDispatcher();
  const channel = makeStubChannel();
  dispatcher.registerChannel(channel);

  const received: ChannelMessage[] = [];
  dispatcher.setHandler(async (msg) => {
    received.push(msg);
  });

  await dispatcher.startAll();
  const msg = makeMessage();
  assert.equal(dispatcher.enqueue(msg), true);

  // Wait for drain
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 1);
  assert.equal(received[0]!.id, msg.id);

  await dispatcher.stopAll();
});

test("dispatcher: same-scope preemption aborts previous handler", async () => {
  const dispatcher = new ChannelDispatcher();
  const channel = makeStubChannel();
  dispatcher.registerChannel(channel);

  const aborted: string[] = [];
  const completed: string[] = [];

  dispatcher.setHandler(async (msg, _ch, signal) => {
    // Simulate slow work
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      completed.push(msg.id);
    } catch {
      aborted.push(msg.id);
    }
  });

  await dispatcher.startAll();

  const msg1 = makeMessage({ id: "first", scopeKey: "scope-A" });
  const msg2 = makeMessage({ id: "second", scopeKey: "scope-A" });

  dispatcher.enqueue(msg1);
  // Small delay so msg1 starts processing before msg2 arrives.
  await new Promise((r) => setTimeout(r, 20));
  dispatcher.enqueue(msg2);

  await new Promise((r) => setTimeout(r, 400));

  assert.ok(aborted.includes("first"), "first message should be aborted");
  assert.ok(completed.includes("second"), "second message should complete");

  await dispatcher.stopAll();
});

test("dispatcher: cross-scope messages run concurrently", async () => {
  const dispatcher = new ChannelDispatcher();
  const channel = makeStubChannel();
  dispatcher.registerChannel(channel);

  const running: Set<string> = new Set();
  let maxConcurrent = 0;

  dispatcher.setHandler(async (msg) => {
    running.add(msg.scopeKey);
    maxConcurrent = Math.max(maxConcurrent, running.size);
    await new Promise((r) => setTimeout(r, 100));
    running.delete(msg.scopeKey);
  });

  await dispatcher.startAll();

  dispatcher.enqueue(makeMessage({ id: "a", scopeKey: "scope-A" }));
  dispatcher.enqueue(makeMessage({ id: "b", scopeKey: "scope-B" }));

  await new Promise((r) => setTimeout(r, 250));

  assert.ok(maxConcurrent >= 2, `Expected concurrent execution, max was ${maxConcurrent}`);

  await dispatcher.stopAll();
});

test("dispatcher: queue full returns false", () => {
  const dispatcher = new ChannelDispatcher(2);
  const channel = makeStubChannel();
  dispatcher.registerChannel(channel);
  dispatcher.setHandler(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });

  assert.equal(dispatcher.enqueue(makeMessage({ id: "1" })), true);
  assert.equal(dispatcher.enqueue(makeMessage({ id: "2" })), true);
  assert.equal(dispatcher.enqueue(makeMessage({ id: "3" })), false);
});

test("dispatcher: handler exception does not block queue", async () => {
  const dispatcher = new ChannelDispatcher();
  const channel = makeStubChannel();
  dispatcher.registerChannel(channel);

  const handled: string[] = [];
  dispatcher.setHandler(async (msg) => {
    if (msg.id === "throw") throw new Error("boom");
    handled.push(msg.id);
  });

  await dispatcher.startAll();
  dispatcher.enqueue(makeMessage({ id: "throw" }));
  dispatcher.enqueue(makeMessage({ id: "ok" }));

  await new Promise((r) => setTimeout(r, 100));

  assert.ok(handled.includes("ok"), "message after exception should still be handled");
  await dispatcher.stopAll();
});

// ---------------------------------------------------------------------------
// DraftUpdater
// ---------------------------------------------------------------------------

test("draft: push accumulates, finalize sends final text", async () => {
  const channel = makeStubChannel();
  const target: ReplyTarget = { channelName: "test", data: {} };
  const draft = new DraftUpdater(channel, target, 10);

  draft.push("Hello");
  draft.push(" world");

  // Wait for throttle to flush
  await new Promise((r) => setTimeout(r, 50));

  await draft.finalize();

  // Should have: create or update + finalize
  const last = channel.drafts[channel.drafts.length - 1]!;
  assert.equal(last.action, "finalize");
  assert.equal(last.content, "Hello world");
});

test("draft: cancel after push calls cancelDraft", async () => {
  const channel = makeStubChannel();
  const target: ReplyTarget = { channelName: "test", data: {} };
  const draft = new DraftUpdater(channel, target, 10);

  draft.push("partial");
  await new Promise((r) => setTimeout(r, 50));
  await draft.cancel();

  assert.ok(channel.drafts.some((d) => d.action === "cancel"));
});

test("draft: short response without flush sends via channel.send", async () => {
  const channel = makeStubChannel();
  const target: ReplyTarget = { channelName: "test", data: {} };
  const draft = new DraftUpdater(channel, target, 5000); // very long throttle

  draft.push("hi");
  // Finalize before throttle fires — no draft was ever created.
  await draft.finalize();

  // Should have used send() not draft lifecycle
  assert.equal(channel.sentMessages.length, 1);
  assert.equal(channel.sentMessages[0], "hi");
  assert.equal(channel.drafts.length, 0);
});

test("draft: throttle batches multiple pushes", async () => {
  const channel = makeStubChannel();
  const target: ReplyTarget = { channelName: "test", data: {} };
  const draft = new DraftUpdater(channel, target, 100);

  // Rapid pushes within one throttle window
  draft.push("a");
  draft.push("b");
  draft.push("c");

  await new Promise((r) => setTimeout(r, 200));

  // Should have created draft once with accumulated text, not 3 times
  const creates = channel.drafts.filter((d) => d.action === "create");
  assert.equal(creates.length, 1, "should create draft exactly once");
  assert.equal(creates[0]!.content, "abc");

  await draft.finalize();
});

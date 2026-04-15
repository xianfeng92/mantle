import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReturnDispatcher, ReturnStore, type ReturnEntry } from "../src/returns.js";

async function makeStore(maxEntries = 500) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-returns-"));
  const filePath = path.join(tempDir, "returns.jsonl");
  const store = new ReturnStore(filePath, maxEntries);
  return {
    tempDir,
    filePath,
    store,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function draft(overrides: Partial<Omit<ReturnEntry, "id" | "createdAt" | "ackedAt">> = {}) {
  return {
    kind: "test-kind",
    title: "hello",
    payload: { ok: true },
    tags: [],
    source: { taskId: "t-1" },
    ...overrides,
  };
}

test("ReturnStore: append and list returns newest first", async () => {
  const t = await makeStore();
  try {
    const a = await t.store.append(draft({ title: "first" }));
    // Ensure a distinct createdAt for ordering even on fast clocks.
    await new Promise((r) => setTimeout(r, 2));
    const b = await t.store.append(draft({ title: "second" }));

    const entries = await t.store.list();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.id, b.id);
    assert.equal(entries[1]!.id, a.id);
  } finally {
    await t.cleanup();
  }
});

test("ReturnStore: list respects limit, since and unackedOnly", async () => {
  const t = await makeStore();
  try {
    const a = await t.store.append(draft({ title: "a" }));
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const b = await t.store.append(draft({ title: "b" }));
    await t.store.append(draft({ title: "c" }));

    const limited = await t.store.list({ limit: 1 });
    assert.equal(limited.length, 1);

    const sinceCutoff = await t.store.list({ since: cutoff });
    assert.equal(sinceCutoff.length, 2);
    assert.ok(!sinceCutoff.find((entry) => entry.id === a.id));

    await t.store.ack(b.id);
    const unacked = await t.store.list({ unackedOnly: true });
    assert.ok(!unacked.find((entry) => entry.id === b.id));
  } finally {
    await t.cleanup();
  }
});

test("ReturnStore: ack, delete, clear", async () => {
  const t = await makeStore();
  try {
    const entry = await t.store.append(draft());
    const acked = await t.store.ack(entry.id);
    assert.ok(acked);
    assert.ok(acked!.ackedAt);

    assert.equal(await t.store.delete("missing"), false);
    assert.equal(await t.store.delete(entry.id), true);
    assert.equal((await t.store.list()).length, 0);

    await t.store.append(draft());
    await t.store.append(draft({ title: "other" }));
    const cleared = await t.store.clear();
    assert.equal(cleared, 2);
    assert.equal((await t.store.list()).length, 0);
  } finally {
    await t.cleanup();
  }
});

test("ReturnStore: skips malformed JSONL lines", async () => {
  const t = await makeStore();
  try {
    await t.store.append(draft({ title: "good" }));
    // Corrupt the file with a broken line between valid ones.
    const raw = await readFile(t.filePath, "utf-8");
    const hacked = raw + "{ not valid json\n";
    await (await import("node:fs/promises")).writeFile(t.filePath, hacked, "utf-8");

    const entries = await t.store.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.title, "good");
  } finally {
    await t.cleanup();
  }
});

test("ReturnStore: FIFO cap enforced", async () => {
  const t = await makeStore(3);
  try {
    await t.store.append(draft({ title: "1" }));
    await t.store.append(draft({ title: "2" }));
    await t.store.append(draft({ title: "3" }));
    await t.store.append(draft({ title: "4" }));

    const entries = await t.store.list();
    assert.equal(entries.length, 3);
    // oldest ("1") should be gone; newest first
    assert.deepEqual(
      entries.map((e) => e.title),
      ["4", "3", "2"],
    );
  } finally {
    await t.cleanup();
  }
});

test("ReturnDispatcher: dispatch writes and broadcasts", async () => {
  const t = await makeStore();
  try {
    const dispatcher = new ReturnDispatcher(t.store);

    const received: ReturnEntry[] = [];
    const unsub = dispatcher.subscribe((entry) => received.push(entry));

    const entry = await dispatcher.dispatch(draft({ title: "boom" }));
    assert.equal(received.length, 1);
    assert.equal(received[0]!.id, entry.id);

    // Second subscriber also receives subsequent entries.
    const second: ReturnEntry[] = [];
    dispatcher.subscribe((e) => second.push(e));
    await dispatcher.dispatch(draft({ title: "again" }));
    assert.equal(received.length, 2);
    assert.equal(second.length, 1);

    unsub();
    await dispatcher.dispatch(draft({ title: "after-unsub" }));
    assert.equal(received.length, 2);
    assert.equal(second.length, 2);
  } finally {
    await t.cleanup();
  }
});

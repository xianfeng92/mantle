import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore, estimateTokens } from "../src/memory.js";
import type { MemoryEntry } from "../src/memory.js";

function makeTempStore() {
  let tempDir: string;
  let filePath: string;
  let store: MemoryStore;

  return {
    async setup(maxEntries = 200) {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-memory-"));
      filePath = path.join(tempDir, "memory.jsonl");
      store = new MemoryStore(filePath, maxEntries);
      return { tempDir, filePath, store };
    },
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function makeEntry(overrides: Partial<Omit<MemoryEntry, "id">> = {}): Omit<MemoryEntry, "id"> {
  return {
    type: "user",
    content: "用户偏好 SwiftUI",
    source: {
      threadId: "thread-1",
      traceId: "trace-1",
      createdAt: new Date().toISOString(),
    },
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

test("MemoryStore: add and list entries", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    const entry = await store.add(makeEntry());
    assert.ok(entry.id, "should have a UUID id");
    assert.equal(entry.type, "user");

    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.content, "用户偏好 SwiftUI");
  } finally {
    await t.cleanup();
  }
});

test("MemoryStore: get by id", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    const entry = await store.add(makeEntry());
    const found = await store.get(entry.id);
    assert.deepEqual(found, entry);

    const notFound = await store.get("nonexistent");
    assert.equal(notFound, null);
  } finally {
    await t.cleanup();
  }
});

test("MemoryStore: delete by id", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    const e1 = await store.add(makeEntry({ content: "fact A" }));
    await store.add(makeEntry({ content: "fact B" }));

    const removed = await store.delete(e1.id);
    assert.equal(removed, true);

    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.content, "fact B");

    const removedAgain = await store.delete(e1.id);
    assert.equal(removedAgain, false);
  } finally {
    await t.cleanup();
  }
});

test("MemoryStore: clear all", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    await store.add(makeEntry({ content: "a" }));
    await store.add(makeEntry({ content: "b" }));
    await store.add(makeEntry({ content: "c" }));

    const cleared = await store.clear();
    assert.equal(cleared, 3);

    const all = await store.list();
    assert.equal(all.length, 0);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test("MemoryStore: deduplicates by exact content", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    const e1 = await store.add(makeEntry({ content: "重复内容" }));
    const e2 = await store.add(makeEntry({ content: "重复内容" }));

    assert.equal(e1.id, e2.id, "should return the existing entry");

    const all = await store.list();
    assert.equal(all.length, 1);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Capacity / FIFO
// ---------------------------------------------------------------------------

test("MemoryStore: enforces maxEntries with FIFO", async () => {
  const t = makeTempStore();
  const { store } = await t.setup(3); // max 3 entries
  try {
    await store.add(makeEntry({ content: "first" }));
    await store.add(makeEntry({ content: "second" }));
    await store.add(makeEntry({ content: "third" }));
    await store.add(makeEntry({ content: "fourth" }));

    const all = await store.list();
    assert.equal(all.length, 3);
    // "first" should be evicted
    assert.deepEqual(
      all.map((m) => m.content),
      ["second", "third", "fourth"],
    );
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Selection for injection
// ---------------------------------------------------------------------------

test("MemoryStore: selectForInjection respects type priority", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    await store.add(makeEntry({ type: "project", content: "项目用 Gemma 4" }));
    await store.add(makeEntry({ type: "user", content: "用户偏好中文" }));
    await store.add(makeEntry({ type: "correction", content: "不要删除文件" }));

    const selected = await store.selectForInjection(2000);
    assert.equal(selected.length, 3);
    // correction first, then user, then project
    assert.equal(selected[0]!.type, "correction");
    assert.equal(selected[1]!.type, "user");
    assert.equal(selected[2]!.type, "project");
  } finally {
    await t.cleanup();
  }
});

test("MemoryStore: selectForInjection respects token budget", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    // Each CJK char ≈ 2 tokens; "不要删除文件" = 6 CJK chars ≈ 12 tokens + 10 overhead = ~22
    await store.add(makeEntry({ type: "correction", content: "不要删除文件" }));
    await store.add(makeEntry({ type: "user", content: "用户偏好很长的内容，这段话包含足够多的中文字符来测试预算限制机制" }));
    await store.add(makeEntry({ type: "project", content: "项目" }));

    // Tiny budget: should only fit the smallest entries
    const selected = await store.selectForInjection(40);
    assert.ok(selected.length >= 1, "should select at least one entry");
    assert.ok(selected.length < 3, "should not fit all entries");
  } finally {
    await t.cleanup();
  }
});

test("MemoryStore: selectForInjection returns empty for zero budget", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    await store.add(makeEntry({ content: "something" }));
    const selected = await store.selectForInjection(0);
    assert.equal(selected.length, 0);
  } finally {
    await t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Format for injection
// ---------------------------------------------------------------------------

test("MemoryStore.formatForInjection produces expected format", () => {
  const entries: MemoryEntry[] = [
    {
      id: "1",
      type: "correction",
      content: "不要删除文件",
      source: { threadId: "t1", traceId: "tr1", createdAt: "2026-04-08T00:00:00Z" },
      tags: [],
    },
    {
      id: "2",
      type: "user",
      content: "偏好中文回复",
      source: { threadId: "t1", traceId: "tr1", createdAt: "2026-04-08T00:00:00Z" },
      tags: [],
    },
  ];

  const text = MemoryStore.formatForInjection(entries);
  assert.equal(text, "- [correction] 不要删除文件\n- [user] 偏好中文回复");
});

test("MemoryStore.formatForInjection returns null for empty array", () => {
  assert.equal(MemoryStore.formatForInjection([]), null);
});

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

test("estimateTokens handles CJK and ASCII", () => {
  const cjkOnly = estimateTokens("你好世界"); // 4 CJK → 8
  assert.ok(cjkOnly >= 7 && cjkOnly <= 9, `CJK estimate ${cjkOnly} out of range`);

  const asciiOnly = estimateTokens("hello world test"); // 16 chars → ~5.6
  assert.ok(asciiOnly >= 4 && asciiOnly <= 8, `ASCII estimate ${asciiOnly} out of range`);

  const mixed = estimateTokens("项目用 TypeScript"); // 3 CJK + 12 ASCII
  assert.ok(mixed > 0);
});

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

test("MemoryStore: handles corrupted JSONL lines gracefully", async () => {
  const t = makeTempStore();
  const { store, filePath } = await t.setup();
  try {
    await store.add(makeEntry({ content: "valid entry" }));

    // Append a corrupted line
    const { appendFile: appendF } = await import("node:fs/promises");
    await appendF(filePath, "NOT VALID JSON\n");

    const all = await store.list();
    assert.equal(all.length, 1, "should skip corrupted line");
    assert.equal(all[0]!.content, "valid entry");
  } finally {
    await t.cleanup();
  }
});

test("MemoryStore: list returns empty for missing file", async () => {
  const t = makeTempStore();
  const { store } = await t.setup();
  try {
    // File doesn't exist yet
    const all = await store.list();
    assert.equal(all.length, 0);
  } finally {
    await t.cleanup();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDigestReturnDraft,
  defaultPersistForMode,
  type TwitterDigestRequest,
} from "../src/twitter-digest.js";

test("defaultPersistForMode: daily and weekly default true, summarize false", () => {
  assert.equal(defaultPersistForMode("daily"), true);
  assert.equal(defaultPersistForMode("weekly"), true);
  assert.equal(defaultPersistForMode("summarize"), false);
});

test("buildDigestReturnDraft: daily result → draft with topPicks title and rationale summary", () => {
  const request: TwitterDigestRequest = {
    mode: "daily",
    bookmarks: [
      {
        id: "1",
        author: "alice",
        summary: "s1",
        qualityScore: 8,
        tags: ["ai"],
      },
      {
        id: "2",
        author: "bob",
        summary: "s2",
        qualityScore: 7,
        tags: ["rag"],
      },
    ],
  };
  const result = {
    topPicks: ["1", "2"],
    rationale: "覆盖 agent 和 rag 两条主线",
  };

  const draft = buildDigestReturnDraft(request, result);
  assert.ok(draft);
  assert.equal(draft!.kind, "twitter-digest.daily");
  assert.equal(draft!.title, "今日精选 2 条");
  assert.equal(draft!.summary, "覆盖 agent 和 rag 两条主线");
  assert.equal(draft!.source.taskId, "twitter-digest.daily");
  assert.ok(draft!.tags.includes("twitter-digest"));
  assert.ok(draft!.tags.includes("daily"));
  const payload = draft!.payload as { mode: string; output: unknown };
  assert.equal(payload.mode, "daily");
  assert.deepEqual(payload.output, result);
});

test("buildDigestReturnDraft: weekly result → draft with cluster theme summary", () => {
  const request: TwitterDigestRequest = {
    mode: "weekly",
    bookmarks: [
      { id: "1", author: "a", summary: "s", qualityScore: 5, tags: [] },
      { id: "2", author: "b", summary: "s", qualityScore: 6, tags: [] },
    ],
  };
  const result = {
    clusters: [
      {
        theme: "Agent 架构",
        bookmarkIds: ["1", "2"],
        narrative: "两条都在讲 middleware 演进",
      },
    ],
    orphans: [],
  };

  const draft = buildDigestReturnDraft(request, result);
  assert.ok(draft);
  assert.equal(draft!.kind, "twitter-digest.weekly");
  assert.equal(draft!.title, "本周聚类 1 簇");
  assert.ok(draft!.summary?.includes("Agent 架构"));
});

test("buildDigestReturnDraft: summarize mode → null (intermediate)", () => {
  const request: TwitterDigestRequest = {
    mode: "summarize",
    bookmarks: [{ id: "1", author: "a", text: "hello" }],
  };
  const draft = buildDigestReturnDraft(request, {
    items: [{ id: "1", summary: "x", qualityScore: 5, tags: [] }],
  });
  assert.equal(draft, null);
});

test("buildDigestReturnDraft: malformed result → null", () => {
  const request: TwitterDigestRequest = {
    mode: "daily",
    bookmarks: [
      { id: "1", author: "a", summary: "s", qualityScore: 5, tags: [] },
    ],
  };
  const draft = buildDigestReturnDraft(request, { wrong: "shape" });
  assert.equal(draft, null);
});

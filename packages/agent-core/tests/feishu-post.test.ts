import assert from "node:assert/strict";
import test from "node:test";

import { parseFeishuPostContent } from "../src/channels/feishu.js";

// ---------------------------------------------------------------------------
// Shape variants
// ---------------------------------------------------------------------------

test("post: locale-wrapped, simple text + title", () => {
  const content = JSON.stringify({
    zh_cn: {
      title: "早报",
      content: [
        [{ tag: "text", text: "苹果销量创新高。" }],
        [{ tag: "text", text: "Pro 机型在中国强势。" }],
      ],
    },
  });
  const out = parseFeishuPostContent(content);
  assert.equal(out, "早报\n\n苹果销量创新高。\nPro 机型在中国强势。");
});

test("post: bare (no locale wrapper)", () => {
  const content = JSON.stringify({
    content: [[{ tag: "text", text: "hello world" }]],
  });
  assert.equal(parseFeishuPostContent(content), "hello world");
});

// ---------------------------------------------------------------------------
// Inline elements
// ---------------------------------------------------------------------------

test("post: anchor tag keeps text + href", () => {
  const content = JSON.stringify({
    zh_cn: {
      title: "",
      content: [
        [
          { tag: "text", text: "see " },
          { tag: "a", text: "the article", href: "https://example.com" },
        ],
      ],
    },
  });
  assert.equal(
    parseFeishuPostContent(content),
    "see the article (https://example.com)",
  );
});

test("post: anchor without href falls back to text", () => {
  const content = JSON.stringify({
    content: [[{ tag: "a", text: "link" }]],
  });
  assert.equal(parseFeishuPostContent(content), "link");
});

test("post: at and img elements are skipped silently", () => {
  const content = JSON.stringify({
    zh_cn: {
      title: "",
      content: [
        [
          { tag: "at", user_id: "u1", user_name: "bot" },
          { tag: "text", text: " 看这个 " },
          { tag: "img", image_key: "img_x" },
        ],
      ],
    },
  });
  assert.equal(parseFeishuPostContent(content), "看这个");
});

// ---------------------------------------------------------------------------
// @mentions stripping
// ---------------------------------------------------------------------------

test("post: bot @mention keys are stripped", () => {
  const content = JSON.stringify({
    zh_cn: {
      title: "",
      content: [
        [
          { tag: "text", text: "@_user_1 " },
          { tag: "text", text: "帮我总结这条" },
        ],
      ],
    },
  });
  const out = parseFeishuPostContent(content, [
    { key: "@_user_1", name: "Mantle" },
  ]);
  assert.equal(out, "帮我总结这条");
});

// ---------------------------------------------------------------------------
// Degraded inputs
// ---------------------------------------------------------------------------

test("post: malformed JSON returns null", () => {
  assert.equal(parseFeishuPostContent("not-json"), null);
});

test("post: missing content array returns null", () => {
  assert.equal(parseFeishuPostContent(JSON.stringify({ title: "x" })), null);
});

test("post: empty content yields null (not empty string)", () => {
  const content = JSON.stringify({
    zh_cn: { title: "", content: [[]] },
  });
  assert.equal(parseFeishuPostContent(content), null);
});

test("post: unknown tags tolerated, known ones captured", () => {
  const content = JSON.stringify({
    content: [
      [
        { tag: "unknown", text: "ignored" },
        { tag: "text", text: "kept" },
      ],
    ],
  });
  assert.equal(parseFeishuPostContent(content), "kept");
});

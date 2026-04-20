import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAssertions,
  parseFeishuMessageText,
  parseInteractiveCardText,
} from "../scripts/feishu-batch-runner.js";

test("interactive card parser extracts header markdown and note text", () => {
  const card = {
    header: {
      title: {
        tag: "plain_text",
        content: "Approval received",
      },
    },
    elements: [
      {
        tag: "markdown",
        content: "✅ Approved · 处理中…",
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "Mantle · generating…",
          },
        ],
      },
    ],
  };

  assert.equal(
    parseInteractiveCardText(card),
    "Approval received\n✅ Approved · 处理中…\nMantle · generating…",
  );
});

test("message text parser extracts text and interactive content", () => {
  assert.equal(
    parseFeishuMessageText("text", JSON.stringify({ text: "hello from bot" })),
    "hello from bot",
  );

  assert.equal(
    parseFeishuMessageText(
      "interactive",
      JSON.stringify({
        elements: [
          {
            tag: "markdown",
            content: "**要点**\nsummary body",
          },
        ],
      }),
    ),
    "**要点**\nsummary body",
  );
});

test("interactive parser decodes html entities from Feishu history payloads", () => {
  assert.equal(
    parseFeishuMessageText(
      "interactive",
      JSON.stringify({
        title: null,
        elements: [[
          { tag: "text", text: "评分" },
          { tag: "text", text: "  4/10 · " },
          { tag: "text", text: "tags" },
          { tag: "text", text: "  apple market&#45;news" },
        ]],
      }),
    ),
    "评分  4/10 · tags  apple market-news",
  );
});

test("assertion evaluator supports allOf anyOf and noneOf", () => {
  assert.deepEqual(
    evaluateAssertions("可用命令 /summarize /find", {
      allOf: ["可用命令", "/find"],
      anyOf: ["/summarize", "/help"],
      noneOf: ["错误"],
    }),
    [],
  );

  const failures = evaluateAssertions("只返回了 /help", {
    allOf: ["可用命令"],
    anyOf: ["/summarize", "/find"],
    noneOf: ["/help"],
  });

  assert.deepEqual(failures, [
    "missing required text: 可用命令",
    "missing any-of texts: /summarize | /find",
    "found forbidden text: /help",
  ]);
});

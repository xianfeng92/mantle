import assert from "node:assert/strict";
import test from "node:test";

import {
  type ContentBlock,
  type UserInput,
  extractTextFromInput,
  validateUserInput,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// extractTextFromInput
// ---------------------------------------------------------------------------

test("extractTextFromInput: string input returns as-is", () => {
  assert.equal(extractTextFromInput("hello world"), "hello world");
});

test("extractTextFromInput: empty string returns empty", () => {
  assert.equal(extractTextFromInput(""), "");
});

test("extractTextFromInput: content blocks — extracts text blocks only", () => {
  const input: ContentBlock[] = [
    { type: "text", text: "What is in this image?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
  ];
  assert.equal(extractTextFromInput(input), "What is in this image?");
});

test("extractTextFromInput: multiple text blocks joined with newline", () => {
  const input: ContentBlock[] = [
    { type: "text", text: "First line" },
    { type: "text", text: "Second line" },
    { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
  ];
  assert.equal(extractTextFromInput(input), "First line\nSecond line");
});

test("extractTextFromInput: no text blocks returns empty string", () => {
  const input: ContentBlock[] = [
    { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
  ];
  assert.equal(extractTextFromInput(input), "");
});

test("extractTextFromInput: empty array returns empty string", () => {
  assert.equal(extractTextFromInput([]), "");
});

// ---------------------------------------------------------------------------
// validateUserInput
// ---------------------------------------------------------------------------

test("validateUserInput: valid string", () => {
  assert.equal(validateUserInput("hello"), "hello");
});

test("validateUserInput: string with whitespace is trimmed", () => {
  assert.equal(validateUserInput("  hello  "), "hello");
});

test("validateUserInput: empty string returns null", () => {
  assert.equal(validateUserInput(""), null);
  assert.equal(validateUserInput("   "), null);
});

test("validateUserInput: valid content block array", () => {
  const input = [
    { type: "text", text: "What is this?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
  ];
  const result = validateUserInput(input);
  assert.ok(Array.isArray(result));
  assert.equal(result!.length, 2);
});

test("validateUserInput: text-only content block array", () => {
  const input = [{ type: "text", text: "Just text" }];
  const result = validateUserInput(input);
  assert.ok(Array.isArray(result));
});

test("validateUserInput: image-only array (no text) returns null", () => {
  const input = [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }];
  assert.equal(validateUserInput(input), null);
});

test("validateUserInput: array with empty text returns null", () => {
  const input = [
    { type: "text", text: "" },
    { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
  ];
  assert.equal(validateUserInput(input), null);
});

test("validateUserInput: array with whitespace-only text returns null", () => {
  const input = [
    { type: "text", text: "   " },
  ];
  assert.equal(validateUserInput(input), null);
});

test("validateUserInput: invalid block type returns null", () => {
  const input = [
    { type: "text", text: "hello" },
    { type: "audio", data: "something" },
  ];
  assert.equal(validateUserInput(input), null);
});

test("validateUserInput: malformed text block (text not string) returns null", () => {
  const input = [{ type: "text", text: 42 }];
  assert.equal(validateUserInput(input), null);
});

test("validateUserInput: malformed image_url block returns null", () => {
  const input = [
    { type: "text", text: "hello" },
    { type: "image_url", image_url: "not-an-object" },
  ];
  assert.equal(validateUserInput(input), null);
});

test("validateUserInput: image_url block missing url returns null", () => {
  const input = [
    { type: "text", text: "hello" },
    { type: "image_url", image_url: { detail: "high" } },
  ];
  assert.equal(validateUserInput(input), null);
});

test("validateUserInput: block without type returns null", () => {
  const input = [
    { type: "text", text: "hello" },
    { text: "no type field" },
  ];
  assert.equal(validateUserInput(input), null);
});

test("validateUserInput: null/undefined/number returns null", () => {
  assert.equal(validateUserInput(null), null);
  assert.equal(validateUserInput(undefined), null);
  assert.equal(validateUserInput(42), null);
  assert.equal(validateUserInput(true), null);
});

test("validateUserInput: valid array with detail field preserved", () => {
  const input = [
    { type: "text", text: "Describe this" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc", detail: "high" } },
  ];
  const result = validateUserInput(input) as ContentBlock[];
  assert.ok(Array.isArray(result));
  const imgBlock = result[1] as Extract<ContentBlock, { type: "image_url" }>;
  assert.equal(imgBlock.image_url.detail, "high");
});

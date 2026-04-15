import assert from "node:assert/strict";
import test from "node:test";

import { AIMessage, HumanMessage } from "@langchain/core/messages";

import {
  extractFallbackToolCalls,
  patchMessageWithFallbackToolCalls,
} from "../src/tool-call-fallback.js";

// ---------------------------------------------------------------------------
// extractFallbackToolCalls
// ---------------------------------------------------------------------------

test("extractFallbackToolCalls: single tool call", () => {
  const content = '<|tool_call>call:read_file{path:<|"|>/tmp/test.txt<|"|>}<tool_call|>';
  const result = extractFallbackToolCalls(content);
  assert.deepEqual(result, [{ name: "read_file", args: { path: "/tmp/test.txt" } }]);
});

test("extractFallbackToolCalls: multiple tool calls", () => {
  const content =
    '<|tool_call>call:read_file{path:<|"|>/a.txt<|"|>}<tool_call|>' +
    '<|tool_call>call:write_file{path:<|"|>/b.txt<|"|>, content:<|"|>hello<|"|>}<tool_call|>';
  const result = extractFallbackToolCalls(content);
  assert.equal(result?.length, 2);
  assert.equal(result![0].name, "read_file");
  assert.deepEqual(result![0].args, { path: "/a.txt" });
  assert.equal(result![1].name, "write_file");
  assert.deepEqual(result![1].args, { path: "/b.txt", content: "hello" });
});

test("extractFallbackToolCalls: multiple args", () => {
  const content =
    '<|tool_call>call:execute{command:<|"|>ls -la<|"|>, cwd:<|"|>/home<|"|>}<tool_call|>';
  const result = extractFallbackToolCalls(content);
  assert.deepEqual(result, [{ name: "execute", args: { command: "ls -la", cwd: "/home" } }]);
});

test("extractFallbackToolCalls: value with newlines and special chars", () => {
  const content =
    '<|tool_call>call:write_file{path:<|"|>/tmp/out.py<|"|>, content:<|"|>def main():\n    print("hello")\n<|"|>}<tool_call|>';
  const result = extractFallbackToolCalls(content);
  assert.equal(result?.length, 1);
  assert.equal(result![0].name, "write_file");
  assert.equal(result![0].args.content, 'def main():\n    print("hello")\n');
});

test("extractFallbackToolCalls: no tool call pattern returns null", () => {
  assert.equal(extractFallbackToolCalls("Just some normal text."), null);
  assert.equal(extractFallbackToolCalls(""), null);
});

test("extractFallbackToolCalls: malformed pattern returns null", () => {
  // Missing closing <tool_call|>
  assert.equal(
    extractFallbackToolCalls('<|tool_call>call:read_file{path:<|"|>/tmp<|"|>}'),
    null,
  );
  // Missing call: prefix
  assert.equal(
    extractFallbackToolCalls('<|tool_call>read_file{path:<|"|>/tmp<|"|>}<tool_call|>'),
    null,
  );
});

test("extractFallbackToolCalls: content with tool calls mixed with text", () => {
  const content =
    'Here is the result:\n<|tool_call>call:search{query:<|"|>hello world<|"|>}<tool_call|>\nDone.';
  const result = extractFallbackToolCalls(content);
  assert.equal(result?.length, 1);
  assert.equal(result![0].name, "search");
  assert.deepEqual(result![0].args, { query: "hello world" });
});

test("extractFallbackToolCalls: null/undefined input returns null", () => {
  assert.equal(extractFallbackToolCalls(null as unknown as string), null);
  assert.equal(extractFallbackToolCalls(undefined as unknown as string), null);
});

// ---------------------------------------------------------------------------
// patchMessageWithFallbackToolCalls
// ---------------------------------------------------------------------------

test("patchMessageWithFallbackToolCalls: patches AIMessage with empty tool_calls", () => {
  const original = new AIMessage({
    content: '<|tool_call>call:read_file{path:<|"|>/tmp/test.txt<|"|>}<tool_call|>',
  });
  const result = patchMessageWithFallbackToolCalls(original);
  assert.ok(result instanceof AIMessage);
  const patched = result as AIMessage;
  assert.equal(patched.tool_calls!.length, 1);
  assert.equal(patched.tool_calls![0].name, "read_file");
  assert.deepEqual(patched.tool_calls![0].args, { path: "/tmp/test.txt" });
  assert.ok(typeof patched.tool_calls![0].id === "string");
  assert.ok(patched.tool_calls![0].id!.length > 0);
  // Content should be cleaned
  assert.equal(typeof patched.content === "string" ? patched.content : "", "");
});

test("patchMessageWithFallbackToolCalls: AIMessage with existing tool_calls unchanged", () => {
  const original = new AIMessage({
    content: "Some content",
    tool_calls: [{ id: "existing-id", name: "foo", args: { a: 1 } }],
  });
  const result = patchMessageWithFallbackToolCalls(original);
  assert.equal(result, original); // same reference
});

test("patchMessageWithFallbackToolCalls: non-AIMessage returned unchanged", () => {
  const original = new HumanMessage({ content: "Hello" });
  const result = patchMessageWithFallbackToolCalls(original);
  assert.equal(result, original);
});

test("patchMessageWithFallbackToolCalls: AIMessage with no tool call pattern unchanged", () => {
  const original = new AIMessage({ content: "Just regular text" });
  const result = patchMessageWithFallbackToolCalls(original);
  assert.equal(result, original);
});

test("patchMessageWithFallbackToolCalls: mixed content and tool calls", () => {
  const original = new AIMessage({
    content:
      'Let me read that file.\n<|tool_call>call:read_file{path:<|"|>/tmp/test.txt<|"|>}<tool_call|>',
  });
  const result = patchMessageWithFallbackToolCalls(original);
  assert.ok(result instanceof AIMessage);
  const patched = result as AIMessage;
  assert.equal(patched.tool_calls!.length, 1);
  // Content should have the tool call markers removed but keep text
  assert.equal(
    typeof patched.content === "string" ? patched.content : "",
    "Let me read that file.",
  );
});

test("patchMessageWithFallbackToolCalls: patched message has unique IDs per call", () => {
  const original = new AIMessage({
    content:
      '<|tool_call>call:read_file{path:<|"|>/a.txt<|"|>}<tool_call|>' +
      '<|tool_call>call:read_file{path:<|"|>/b.txt<|"|>}<tool_call|>',
  });
  const patched = patchMessageWithFallbackToolCalls(original);
  assert.ok(patched instanceof AIMessage);
  const patchedAI = patched as AIMessage;
  assert.equal(patchedAI.tool_calls!.length, 2);
  assert.notEqual(patchedAI.tool_calls![0].id, patchedAI.tool_calls![1].id);
});

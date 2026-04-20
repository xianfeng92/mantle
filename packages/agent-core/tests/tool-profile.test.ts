import assert from "node:assert/strict";
import test from "node:test";

import { ToolMessage } from "@langchain/core/messages";

import {
  createToolProfileMiddleware,
  filterToolsByProfile,
  normalizeToolProfile,
} from "../src/channels/tool-profile.js";

test("filterToolsByProfile returns only chat allowlisted tools", () => {
  const tools = [
    { name: "ls" },
    { name: "read_file" },
    { name: "execute" },
    { name: "open_app" },
    { name: "write_todos" },
  ];

  assert.deepEqual(filterToolsByProfile(tools, "chat").map((tool) => tool.name), [
    "ls",
    "read_file",
    "write_todos",
  ]);
});

test("filterToolsByProfile passes through full profile", () => {
  const tools = [{ name: "ls" }, { name: "execute" }];

  assert.deepEqual(filterToolsByProfile(tools, "full"), tools);
});

test("normalizeToolProfile falls back to full for unknown values", () => {
  assert.equal(normalizeToolProfile("chat"), "chat");
  assert.equal(normalizeToolProfile("weird"), "full");
  assert.equal(normalizeToolProfile(undefined), "full");
});

test("tool profile middleware filters tools during model calls", async () => {
  const middleware = createToolProfileMiddleware();
  const request = {
    tools: [
      { name: "ls" },
      { name: "read_file" },
      { name: "execute" },
    ],
    toolChoice: "auto" as const,
    systemPrompt: "base prompt",
    runtime: { configurable: { toolProfile: "readonly" } },
  } as any;

  let seenTools: string[] = [];
  let seenPrompt = "";

  await middleware.wrapModelCall!(request, async (nextRequest) => {
    seenTools = (nextRequest.tools as Array<{ name?: string }>).flatMap((tool) =>
      typeof tool.name === "string" ? [tool.name] : [],
    );
    seenPrompt = nextRequest.systemPrompt ?? "";
    return {} as any;
  });

  assert.deepEqual(seenTools, ["ls", "read_file"]);
  assert.match(seenPrompt, /Current tool profile: readonly/);
});

test("tool profile middleware blocks disallowed tool calls", async () => {
  const middleware = createToolProfileMiddleware();

  const result = await middleware.wrapToolCall!(
    {
      toolCall: { id: "tool-1", name: "execute", args: {} },
      runtime: { configurable: { toolProfile: "chat" } },
    } as any,
    async () => {
      throw new Error("handler should not run");
    },
  );

  assert.ok(ToolMessage.isInstance(result));
  assert.equal(result.name, "execute");
  assert.equal(result.status, "error");
  assert.match(String(result.content), /not available under the "chat" tool profile/);
});

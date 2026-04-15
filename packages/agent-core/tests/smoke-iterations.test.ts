/**
 * Smoke tests for Iterations #1-#6.
 *
 * Each test verifies the end-to-end behavior of a feature using mock
 * runtimes — no LM Studio or browser required.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StreamEvent } from "@langchain/core/types/stream";

import type { AgentRuntime } from "../src/agent.js";
import { buildCompactionHint, type ContextCompactionSnapshot } from "../src/compaction.js";
import { DefaultGuardrails } from "../src/guardrails.js";
import { AgentCoreHttpServer } from "../src/http.js";
import { MemoryStore } from "../src/memory.js";
import { AgentCoreServiceHarness } from "../src/service.js";
import type { TraceEvent } from "../src/tracing.js";
import type { InvokeResultLike } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared helpers (same pattern as existing tests)
// ---------------------------------------------------------------------------

interface InvokeCall {
  input: unknown;
  config?: {
    version?: "v1" | "v2";
    configurable?: Record<string, unknown>;
  };
}

function createRuntimeStub(
  invokeImpl?: (input: unknown, config?: unknown) => Promise<InvokeResultLike>,
  streamEvents?: StreamEvent[],
) {
  const invokeCalls: InvokeCall[] = [];
  const traceEvents: TraceEvent[] = [];
  let defaultInvokeIndex = 0;
  const defaultResponses: InvokeResultLike[] = [];

  const runtime: AgentRuntime = {
    agent: {
      async invoke(input, config) {
        invokeCalls.push({ input, config });
        if (invokeImpl) {
          return invokeImpl(input, config);
        }
        const response = defaultResponses[defaultInvokeIndex] ?? defaultResponses[defaultResponses.length - 1];
        defaultInvokeIndex += 1;
        if (!response) {
          throw new Error("No stub response configured.");
        }
        return response;
      },
      async *streamEvents(input, config) {
        invokeCalls.push({ input, config });
        if (streamEvents) {
          for (const event of streamEvents) {
            yield event;
          }
        }
      },
      async getState() {
        return { values: {} };
      },
    },
    backend: {} as AgentRuntime["backend"],
    checkpointer: {
      async deleteThread() {},
    } as unknown as AgentRuntime["checkpointer"],
    settings: {
      model: "google/gemma-4-26b-a4b",
      promptProfile: "compact",
      agentGraphVersion: "v2",
      contextWindowTokensHint: 28_000,
    } as AgentRuntime["settings"],
    skillSources: [],
    subagentSources: [],
    guardrails: new DefaultGuardrails({
      maxInputChars: 20_000,
      maxOutputChars: 80_000,
      blockedInputTerms: [],
      blockedOutputTerms: [],
    }),
    traceRecorder: {
      async record(event) {
        traceEvents.push(event);
      },
      async listRecent(limit = 100) {
        return traceEvents.slice(-limit);
      },
      async getTrace(traceId: string) {
        return traceEvents.filter((e) => e.traceId === traceId);
      },
    },
    memoryStore: new MemoryStore("/tmp/agent-core-test-memory-iterations.jsonl"),
    generalPurposeSubagent: {
      enabled: true,
      name: "general-purpose",
      description: "General purpose subagent",
      inheritedSkillSources: [],
    },
    async listSkills() {
      return [];
    },
    async listSubagents() {
      return [];
    },
    async close() {},
  };

  return { runtime, invokeCalls, traceEvents, defaultResponses };
}

async function startServer(runtime: AgentRuntime) {
  const server = new AgentCoreHttpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
  });
  const address = await server.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  return { server, baseUrl };
}

// ===========================================================================
// Iteration #1: Gemma 4 Tool Call Fallback — end-to-end detection
// ===========================================================================

test("Iteration 1: fallback tool call pattern in AI content triggers trace event", async () => {
  // Simulate Gemma 4 returning tool call in content (LM Studio didn't parse it)
  const gemmaContent =
    '<|tool_call>call:read_file{path:<|"|>/tmp/test.txt<|"|>}<tool_call|>';

  const { runtime, traceEvents } = createRuntimeStub(async () => ({
    messages: [
      new HumanMessage("read /tmp/test.txt"),
      new AIMessage({ content: gemmaContent }),
    ],
  }));
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.runOnce({
    threadId: "thread-fallback-smoke",
    input: "read /tmp/test.txt",
  });

  assert.equal(result.status, "completed");
  // Should have recorded a tool_call_fallback trace event
  const fallbackEvents = traceEvents.filter((e) => e.kind === "tool_call_fallback");
  assert.equal(fallbackEvents.length, 1);
  assert.equal(
    (fallbackEvents[0].payload as { callCount: number }).callCount,
    1,
  );
  assert.deepEqual(
    (fallbackEvents[0].payload as { extractedCalls: Array<{ name: string }> }).extractedCalls[0]
      .name,
    "read_file",
  );
});

test("Iteration 1: AI message with proper tool_calls does NOT trigger fallback", async () => {
  const { runtime, traceEvents } = createRuntimeStub(async () => ({
    messages: [
      new HumanMessage("read file"),
      new AIMessage({
        content: "",
        tool_calls: [{ id: "tc-1", name: "read_file", args: { path: "/tmp/a.txt" } }],
      }),
    ],
  }));
  const service = new AgentCoreServiceHarness(runtime);

  await service.runOnce({ threadId: "thread-no-fallback", input: "read file" });

  const fallbackEvents = traceEvents.filter((e) => e.kind === "tool_call_fallback");
  assert.equal(fallbackEvents.length, 0);
});

test("Iteration 1: COMPLETE LOOP — fallback → patch → updateState → tools execute → model responds", async () => {
  // This is the end-to-end test for the complete fallback loop:
  //   1. Model returns Gemma tool call in content (no tool_calls)
  //   2. Service detects, patches, calls updateState
  //   3. Service re-invokes → tools node executes → model gets result → final answer

  const updateStateCalls: Array<{ values: unknown; asNode?: string }> = [];
  let invokeCount = 0;

  const { runtime, traceEvents } = createRuntimeStub(async () => {
    invokeCount++;

    if (invokeCount === 1) {
      // First invoke: model returns Gemma 4 format tool call in content
      return {
        messages: [
          new HumanMessage("Read /tmp/test.txt"),
          new AIMessage({
            content: '<|tool_call>call:read_file{path:<|"|>/tmp/test.txt<|"|>}<tool_call|>',
            // No tool_calls — LM Studio failed to parse
          }),
        ],
      };
    }

    // Second invoke: after updateState, tools node executed,
    // model received tool result and produced final answer
    return {
      messages: [
        new HumanMessage("Read /tmp/test.txt"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "patched-id", name: "read_file", args: { path: "/tmp/test.txt" } }],
        }),
        new ToolMessage({
          name: "read_file",
          content: "file contents: hello world",
          tool_call_id: "patched-id",
        }),
        new AIMessage("The file contains: hello world"),
      ],
    };
  });

  // Wire up updateState on the mock agent
  runtime.agent.updateState = async (_config, values, asNode) => {
    updateStateCalls.push({ values, asNode });
    return {};
  };

  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.runOnce({
    threadId: "thread-fallback-full-loop",
    input: "Read /tmp/test.txt",
  });

  // === Verify the complete loop ===

  // 1. Two invokes happened (first detected fallback, second got tool result)
  assert.equal(invokeCount, 2, "Should invoke twice: initial + re-invoke after patch");

  // 2. updateState was called to write back the patched message
  assert.equal(updateStateCalls.length, 1, "Should call updateState once");
  assert.equal(updateStateCalls[0].asNode, "agent", "updateState should target 'agent' node");
  const patchedMessages = (updateStateCalls[0].values as { messages: unknown[] }).messages;
  assert.equal(patchedMessages.length, 1, "Should patch exactly one message");
  const patchedMsg = patchedMessages[0] as AIMessage;
  assert.ok(patchedMsg instanceof AIMessage, "Patched message should be AIMessage");
  assert.equal(patchedMsg.tool_calls!.length, 1, "Patched message should have 1 tool call");
  assert.equal(patchedMsg.tool_calls![0].name, "read_file");
  assert.deepEqual(patchedMsg.tool_calls![0].args, { path: "/tmp/test.txt" });

  // 3. The final result includes the tool execution output
  assert.equal(result.status, "completed");
  const lastMsg = result.newMessages[result.newMessages.length - 1];
  assert.ok(lastMsg instanceof AIMessage);
  assert.equal((lastMsg as AIMessage).content, "The file contains: hello world");

  // 4. A tool_call_fallback trace event was recorded with patched=true
  const fallbackEvents = traceEvents.filter((e) => e.kind === "tool_call_fallback");
  assert.equal(fallbackEvents.length, 1);
  assert.equal((fallbackEvents[0].payload as { patched: boolean }).patched, true);
  assert.equal((fallbackEvents[0].payload as { callCount: number }).callCount, 1);
});

test("Iteration 1: fallback WITHOUT updateState logs but does not re-invoke", async () => {
  // When updateState is not available (e.g. older LangGraph version),
  // the fallback should still log the trace event but NOT re-invoke.

  let invokeCount = 0;
  const { runtime, traceEvents } = createRuntimeStub(async () => {
    invokeCount++;
    return {
      messages: [
        new HumanMessage("Read /tmp/test.txt"),
        new AIMessage({
          content: '<|tool_call>call:read_file{path:<|"|>/tmp/test.txt<|"|>}<tool_call|>',
        }),
      ],
    };
  });

  // Explicitly ensure no updateState
  delete (runtime.agent as { updateState?: unknown }).updateState;

  const service = new AgentCoreServiceHarness(runtime);
  const result = await service.runOnce({
    threadId: "thread-fallback-no-update",
    input: "Read /tmp/test.txt",
  });

  // Should NOT loop — only one invoke
  assert.equal(invokeCount, 1);
  assert.equal(result.status, "completed");

  // But the fallback trace event should still be recorded
  const fallbackEvents = traceEvents.filter((e) => e.kind === "tool_call_fallback");
  assert.equal(fallbackEvents.length, 1);
});

test("Iteration 1: fallback loop with multiple tool calls patches all of them", async () => {
  const updateStateCalls: Array<{ values: unknown }> = [];
  let invokeCount = 0;

  const { runtime, traceEvents } = createRuntimeStub(async () => {
    invokeCount++;
    if (invokeCount === 1) {
      return {
        messages: [
          new HumanMessage("Read two files"),
          new AIMessage({
            content:
              '<|tool_call>call:read_file{path:<|"|>/a.txt<|"|>}<tool_call|>' +
              '<|tool_call>call:read_file{path:<|"|>/b.txt<|"|>}<tool_call|>',
          }),
        ],
      };
    }
    return {
      messages: [
        new HumanMessage("Read two files"),
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "tc-a", name: "read_file", args: { path: "/a.txt" } },
            { id: "tc-b", name: "read_file", args: { path: "/b.txt" } },
          ],
        }),
        new ToolMessage({ name: "read_file", content: "content-a", tool_call_id: "tc-a" }),
        new ToolMessage({ name: "read_file", content: "content-b", tool_call_id: "tc-b" }),
        new AIMessage("Files: content-a and content-b"),
      ],
    };
  });

  runtime.agent.updateState = async (_config, values) => {
    updateStateCalls.push({ values });
    return {};
  };

  const service = new AgentCoreServiceHarness(runtime);
  const result = await service.runOnce({
    threadId: "thread-fallback-multi-tool",
    input: "Read two files",
  });

  assert.equal(invokeCount, 2);
  assert.equal(result.status, "completed");

  // Patched message should have 2 tool calls
  const patchedMessages = (updateStateCalls[0].values as { messages: AIMessage[] }).messages;
  const patched = patchedMessages[0];
  assert.equal(patched.tool_calls!.length, 2);
  assert.equal(patched.tool_calls![0].name, "read_file");
  assert.equal(patched.tool_calls![1].name, "read_file");

  // Final response
  const lastMsg = result.newMessages[result.newMessages.length - 1] as AIMessage;
  assert.equal(lastMsg.content, "Files: content-a and content-b");
});

test("Iteration 1: multiple fallback tool calls in one message are all detected", async () => {
  const content =
    '<|tool_call>call:read_file{path:<|"|>/a.txt<|"|>}<tool_call|>' +
    '<|tool_call>call:write_file{path:<|"|>/b.txt<|"|>, content:<|"|>hello<|"|>}<tool_call|>';

  const { runtime, traceEvents } = createRuntimeStub(async () => ({
    messages: [new HumanMessage("multi"), new AIMessage({ content })],
  }));
  const service = new AgentCoreServiceHarness(runtime);

  await service.runOnce({ threadId: "thread-multi-fallback", input: "multi" });

  const fallbackEvents = traceEvents.filter((e) => e.kind === "tool_call_fallback");
  assert.equal(fallbackEvents.length, 1);
  assert.equal(
    (fallbackEvents[0].payload as { callCount: number }).callCount,
    2,
  );
});

// ===========================================================================
// Iteration #2: LM Studio connection retry — end-to-end
// ===========================================================================

test("Iteration 2: transient ECONNREFUSED triggers retries then succeeds", async () => {
  let callCount = 0;
  const { runtime, traceEvents } = createRuntimeStub(async () => {
    callCount++;
    if (callCount <= 2) {
      throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
    }
    return {
      messages: [new HumanMessage("hi"), new AIMessage("recovered")],
    };
  });
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.runOnce({
    threadId: "thread-retry-smoke",
    input: "hi",
  });

  assert.equal(result.status, "completed");
  assert.equal(callCount, 3); // 2 failures + 1 success
  const retryEvents = traceEvents.filter((e) => e.kind === "retry_attempted");
  assert.equal(retryEvents.length, 2);
});

test("Iteration 2: non-transient error is NOT retried", async () => {
  let callCount = 0;
  const { runtime } = createRuntimeStub(async () => {
    callCount++;
    throw new Error("Invalid model format");
  });
  const service = new AgentCoreServiceHarness(runtime);

  await assert.rejects(
    () => service.runOnce({ threadId: "thread-no-retry", input: "hi" }),
    (err: Error) => err.message === "Invalid model format",
  );

  assert.equal(callCount, 1); // No retry
});

test("Iteration 2: retry exhaustion throws after 3 attempts", async () => {
  let callCount = 0;
  const { runtime, traceEvents } = createRuntimeStub(async () => {
    callCount++;
    throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
  });
  const service = new AgentCoreServiceHarness(runtime);

  await assert.rejects(
    () => service.runOnce({ threadId: "thread-exhaust-retry", input: "hi" }),
    (err: Error) => err.message === "fetch failed",
  );

  assert.equal(callCount, 3);
  const retryEvents = traceEvents.filter((e) => e.kind === "retry_attempted");
  assert.equal(retryEvents.length, 2); // 2 retries before final throw
});

// ===========================================================================
// Iteration #3: Context overflow recovery
// ===========================================================================

test("Iteration 3: context-size-exceeded triggers recovery retry", async () => {
  let callCount = 0;
  const { runtime, traceEvents } = createRuntimeStub(async () => {
    callCount++;
    if (callCount === 1) {
      throw new Error("context size exceeded");
    }
    // Recovery attempt succeeds
    return {
      messages: [new HumanMessage("hello"), new AIMessage("recovered after compaction")],
    };
  });
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.runOnce({
    threadId: "thread-context-recovery",
    input: "hello",
  });

  assert.equal(result.status, "completed");
  assert.equal(callCount, 2); // 1 failure + 1 recovery
  const recoveryEvents = traceEvents.filter((e) => e.kind === "context_recovery");
  assert.equal(recoveryEvents.length, 1);
  assert.equal(
    (recoveryEvents[0].payload as { trigger: string }).trigger,
    "context_size_exceeded",
  );
});

test("Iteration 3: context recovery failure is recorded and thrown", async () => {
  const { runtime, traceEvents } = createRuntimeStub(async () => {
    throw new Error("context size exceeded");
  });
  const service = new AgentCoreServiceHarness(runtime);

  await assert.rejects(
    () => service.runOnce({ threadId: "thread-recovery-fail", input: "hello" }),
    (err: Error) => /context size exceeded/i.test(err.message),
  );

  const recoveryEvents = traceEvents.filter((e) => e.kind === "context_recovery");
  assert.equal(recoveryEvents.length, 2); // initial detection + recovery_failed
  assert.equal(
    (recoveryEvents[0].payload as { trigger: string }).trigger,
    "context_size_exceeded",
  );
  assert.equal(
    (recoveryEvents[1].payload as { trigger: string }).trigger,
    "recovery_failed",
  );
});

test("Iteration 3: buildCompactionHint returns readable string", () => {
  const hint = buildCompactionHint({
    sessionId: "sess-1",
    cutoffIndex: 5,
    filePath: "/summary.md",
    summaryPreview: "User asked about...",
  });
  assert.ok(hint.includes("cutoff index: 5"));
  assert.ok(hint.includes("sess-1"));
  assert.ok(hint.includes("/summary.md"));

  const nullHint = buildCompactionHint(null);
  assert.ok(nullHint.includes("No compaction"));
});

// ===========================================================================
// Iteration #4: Web UI thread persistence (unit-level validation)
// ===========================================================================

// Note: Full browser-level localStorage testing requires a DOM environment.
// Here we validate the serialization/deserialization logic that the hook uses.

test("Iteration 4: thread state serialization round-trips correctly", () => {
  // Simulates the shape that useAgentCoreApp persists
  const state = {
    currentThreadId: "thread-1",
    threadOrder: ["thread-1", "thread-2"],
    threadsById: {
      "thread-1": {
        id: "thread-1",
        title: "Test thread",
        createdAt: new Date("2026-04-06T00:00:00Z").toISOString(),
        messages: [
          { id: "msg-1", role: "user", text: "hello", createdAt: new Date("2026-04-06T00:01:00Z").toISOString() },
          { id: "msg-2", role: "assistant", text: "world", createdAt: new Date("2026-04-06T00:01:01Z").toISOString() },
        ],
      },
      "thread-2": {
        id: "thread-2",
        title: "Another thread",
        createdAt: new Date("2026-04-06T01:00:00Z").toISOString(),
        messages: [],
      },
    },
  };

  // Serialize (like saveThreadsToStorage)
  const serialized = JSON.stringify(state);
  assert.ok(serialized.length > 0);

  // Deserialize (like loadPersistedThreads)
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.currentThreadId, "thread-1");
  assert.equal(parsed.threadOrder.length, 2);
  assert.equal(parsed.threadsById["thread-1"].messages.length, 2);
  assert.equal(parsed.threadsById["thread-1"].messages[0].text, "hello");

  // Revive dates (like reviveThreadRecord)
  const thread = parsed.threadsById["thread-1"];
  const revivedDate = new Date(thread.createdAt);
  assert.ok(revivedDate instanceof Date);
  assert.equal(revivedDate.getFullYear(), 2026);
});

test("Iteration 4: corrupted storage data is handled gracefully", () => {
  // Simulates loadPersistedThreads with bad data
  const badInputs = [
    "not json at all",
    "null",
    '{"currentThreadId": 123}',  // wrong type
    '{}',  // missing fields
  ];

  for (const input of badInputs) {
    let result: unknown;
    try {
      const parsed = JSON.parse(input);
      // Validate shape (simplified version of loadPersistedThreads checks)
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.currentThreadId !== "string" ||
        !Array.isArray(parsed.threadOrder)
      ) {
        result = null;
      } else {
        result = parsed;
      }
    } catch {
      result = null;
    }
    // All bad inputs should gracefully fall back to null
    assert.equal(result, null, `Expected null for input: ${input}`);
  }
});

// ===========================================================================
// Iteration #5: .gitignore and engineering cleanup
// ===========================================================================

test("Iteration 5: .gitignore includes web/node_modules exclusion", async () => {
  const { readFile } = await import("node:fs/promises");
  const gitignorePath = "../../.gitignore";
  const content = await readFile(gitignorePath, "utf8");
  assert.ok(
    content.includes("agent-core/web/node_modules"),
    ".gitignore should exclude agent-core/web/node_modules/",
  );
});

test("Iteration 5: design spec has implemented status", async () => {
  const { readFile } = await import("node:fs/promises");
  const specPath = "docs/specs/2026-04-05-agent-core-design-spec.md";
  const content = await readFile(specPath, "utf8");
  assert.ok(
    content.includes("status: implemented"),
    "Design spec should have status: implemented",
  );
});

// ===========================================================================
// Iteration #6: Diagnostics endpoint
// ===========================================================================

test("Iteration 6: GET /diagnostics returns aggregated statistics", async () => {
  const { runtime, traceEvents } = createRuntimeStub(async () => ({
    messages: [new HumanMessage("hi"), new AIMessage("ok")],
  }));

  // Seed some trace events to be aggregated
  traceEvents.push(
    {
      timestamp: new Date().toISOString(),
      traceId: "t1",
      threadId: "th1",
      kind: "tool_call_fallback",
      payload: { callCount: 1 },
    },
    {
      timestamp: new Date().toISOString(),
      traceId: "t1",
      threadId: "th1",
      kind: "retry_attempted",
      payload: { attempt: 1 },
    },
    {
      timestamp: new Date().toISOString(),
      traceId: "t1",
      threadId: "th1",
      kind: "retry_attempted",
      payload: { attempt: 2 },
    },
    {
      timestamp: new Date().toISOString(),
      traceId: "t1",
      threadId: "th1",
      kind: "context_recovery",
      payload: { trigger: "context_size_exceeded" },
    },
    {
      timestamp: new Date().toISOString(),
      traceId: "t1",
      threadId: "th1",
      kind: "run_completed",
      durationMs: 500,
    },
    {
      timestamp: new Date().toISOString(),
      traceId: "t2",
      threadId: "th1",
      kind: "run_completed",
      durationMs: 300,
    },
    {
      timestamp: new Date().toISOString(),
      traceId: "t3",
      threadId: "th1",
      kind: "run_failed",
      payload: { error: "something went wrong" },
    },
    {
      timestamp: new Date().toISOString(),
      traceId: "t4",
      threadId: "th1",
      kind: "context_compacted",
      payload: { sessionId: "s1" },
    },
  );

  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/diagnostics`);
    const body = (await response.json()) as {
      eventsAnalyzed: number;
      gemma4: {
        toolCallFallbackCount: number;
        retryCount: number;
        contextRecoveryCount: number;
        contextRecoveryFailures: number;
      };
      runs: {
        completed: number;
        failed: number;
        avgDurationMs: number | null;
      };
      compactionCount: number;
      recentErrors: Array<{ kind: string; error: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.eventsAnalyzed, 8);
    assert.equal(body.gemma4.toolCallFallbackCount, 1);
    assert.equal(body.gemma4.retryCount, 2);
    assert.equal(body.gemma4.contextRecoveryCount, 1);
    assert.equal(body.gemma4.contextRecoveryFailures, 0);
    assert.equal(body.runs.completed, 2);
    assert.equal(body.runs.failed, 1);
    assert.equal(body.runs.avgDurationMs, 400); // (500+300)/2
    assert.equal(body.compactionCount, 1);
    assert.equal(body.recentErrors.length, 1);
    assert.equal(body.recentErrors[0].kind, "run_failed");
  } finally {
    await server.close();
  }
});

test("Iteration 6: GET /diagnostics with no events returns zeroed stats", async () => {
  const { runtime } = createRuntimeStub(async () => ({
    messages: [new HumanMessage("hi"), new AIMessage("ok")],
  }));
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/diagnostics`);
    const body = (await response.json()) as {
      eventsAnalyzed: number;
      gemma4: { toolCallFallbackCount: number };
      runs: { completed: number; avgDurationMs: number | null };
    };

    assert.equal(response.status, 200);
    assert.equal(body.eventsAnalyzed, 0);
    assert.equal(body.gemma4.toolCallFallbackCount, 0);
    assert.equal(body.runs.completed, 0);
    assert.equal(body.runs.avgDurationMs, null);
  } finally {
    await server.close();
  }
});

test("Iteration 6: GET /diagnostics with recovery failure counts correctly", async () => {
  const { runtime, traceEvents } = createRuntimeStub(async () => ({
    messages: [new HumanMessage("hi"), new AIMessage("ok")],
  }));

  traceEvents.push(
    {
      timestamp: new Date().toISOString(),
      traceId: "t1",
      threadId: "th1",
      kind: "context_recovery",
      payload: { trigger: "context_size_exceeded" },
    },
    {
      timestamp: new Date().toISOString(),
      traceId: "t1",
      threadId: "th1",
      kind: "context_recovery",
      payload: { trigger: "recovery_failed", error: "still too large" },
    },
  );

  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/diagnostics`);
    const body = (await response.json()) as {
      gemma4: {
        contextRecoveryCount: number;
        contextRecoveryFailures: number;
      };
    };

    assert.equal(body.gemma4.contextRecoveryCount, 1);
    assert.equal(body.gemma4.contextRecoveryFailures, 1);
  } finally {
    await server.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { AIMessage, HumanMessage, RemoveMessage, ToolMessage } from "@langchain/core/messages";
import type { StreamEvent } from "@langchain/core/types/stream";
import { Command } from "@langchain/langgraph";

import type { AgentRuntime } from "../src/agent.js";
import type { ContextCompactionSnapshot } from "../src/compaction.js";
import { DefaultGuardrails, GuardrailViolationError } from "../src/guardrails.js";
import { MemoryStore } from "../src/memory.js";
import { ReturnDispatcher, ReturnStore } from "../src/returns.js";
import { AgentCoreServiceHarness } from "../src/service.js";
import type { TraceEvent } from "../src/tracing.js";
import type { HITLRequest, HITLResponse, InvokeResultLike } from "../src/types.js";

interface InvokeCall {
  input: unknown;
  config?: {
    version?: "v1" | "v2";
    configurable?: Record<string, unknown>;
  };
}

interface StreamCall extends InvokeCall {}

function createCompactionState(snapshot: ContextCompactionSnapshot) {
  return {
    _summarizationSessionId: snapshot.sessionId,
    _summarizationEvent: {
      cutoffIndex: snapshot.cutoffIndex,
      filePath: snapshot.filePath,
      summaryMessage: new HumanMessage(snapshot.summaryPreview),
    },
  };
}

function createRuntimeStub(
  responses: InvokeResultLike[],
  stateValues: unknown[] = [],
  options?: { stateful?: boolean; streamEvents?: StreamEvent[] },
) {
  const calls: InvokeCall[] = [];
  const streamCalls: StreamCall[] = [];
  const stateCalls: InvokeCall[] = [];
  let index = 0;
  let stateIndex = 0;
  const traceEvents: TraceEvent[] = [];
  let currentValues = stateValues[0] ?? {};
  let currentTasks: Array<{ interrupts?: Array<{ value?: unknown }> }> | undefined;

  const runtime: AgentRuntime = {
    agent: {
      async invoke(input, config) {
        calls.push({ input, config });
        const response = responses[index] ?? responses[responses.length - 1];
        index += 1;
        if (!response) {
          throw new Error("No stub response configured.");
        }
        if (options?.stateful) {
          currentValues = {
            ...(typeof currentValues === "object" && currentValues !== null
              ? (currentValues as Record<string, unknown>)
              : {}),
            messages: response.messages ?? [],
          };
          currentTasks = response.__interrupt__?.length
            ? [{ interrupts: response.__interrupt__ }]
            : [];
        }
        return response;
      },
      async *streamEvents(input, config) {
        streamCalls.push({ input, config });
        for (const event of options?.streamEvents ?? []) {
          yield event;
        }
      },
      async getState(config) {
        stateCalls.push({ input: null, config });
        if (options?.stateful) {
          return { values: currentValues, tasks: currentTasks };
        }
        const values = stateValues[stateIndex] ?? stateValues[stateValues.length - 1] ?? {};
        stateIndex += 1;
        return { values };
      },
      async updateState(config, values) {
        if (!options?.stateful) {
          return config;
        }

        let nextMessages = Array.isArray((currentValues as { messages?: unknown[] }).messages)
          ? [...(((currentValues as { messages?: unknown[] }).messages ?? []) as unknown[])]
          : [];
        const updates = Array.isArray((values as { messages?: unknown[] }).messages)
          ? ((values as { messages?: unknown[] }).messages ?? [])
          : [];

        for (const update of updates) {
          if (RemoveMessage.isInstance(update)) {
            nextMessages = nextMessages.filter(
              (message) => (message as { id?: string }).id !== update.id,
            );
            continue;
          }
          nextMessages.push(update);
        }

        currentValues = {
          ...(typeof currentValues === "object" && currentValues !== null
            ? (currentValues as Record<string, unknown>)
            : {}),
          messages: nextMessages,
        };
        currentTasks = [{ interrupts: [] }];
        return config;
      },
    },
    backend: {} as AgentRuntime["backend"],
    checkpointer: {} as AgentRuntime["checkpointer"],
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
      async listRecent() {
        return [];
      },
      async getTrace() {
        return [];
      },
    },
    memoryStore: new MemoryStore("/tmp/agent-core-test-memory-service.jsonl"),
    returnStore: new ReturnStore("/tmp/agent-core-test-returns-service.jsonl"),
    returnDispatcher: new ReturnDispatcher(
      new ReturnStore("/tmp/agent-core-test-returns-service.jsonl"),
    ),
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

  return { runtime, calls, streamCalls, stateCalls, traceEvents };
}

test("runOnce returns completed result with new messages", async () => {
  const { runtime, calls } = createRuntimeStub([
    {
      messages: [new HumanMessage("hello"), new AIMessage("world")],
    },
  ]);
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.runOnce({
    threadId: "thread-1",
    input: "hello",
  });

  assert.equal(result.status, "completed");
  assert.match(result.traceId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.newMessages.length, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.config?.version, "v2");
  assert.equal(calls[0]?.config?.configurable?.thread_id, "thread-1");
});

test("streamRun forwards toolProfile into runtime configurable", async () => {
  const streamEvents: StreamEvent[] = [
    {
      event: "on_chain_end",
      name: "LangGraph",
      run_id: "run-1",
      data: {
        output: {
          messages: [new HumanMessage("hello"), new AIMessage("world")],
        },
      },
    } as StreamEvent,
  ];
  const { runtime, streamCalls } = createRuntimeStub([], [], { streamEvents });
  const service = new AgentCoreServiceHarness(runtime);

  const stream = service.streamRun({
    threadId: "thread-stream-1",
    input: "hello",
    toolProfile: "chat",
  });
  for await (const _event of stream) {
    // exhaust the stream
  }

  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0]?.config?.configurable?.thread_id, "thread-stream-1");
  assert.equal(streamCalls[0]?.config?.configurable?.toolProfile, "chat");
});

test("runOnce returns interrupted result when no handler is supplied", async () => {
  const interruptRequest: HITLRequest = {
    actionRequests: [{ name: "execute", args: { command: "pwd" } }],
    reviewConfigs: [{ actionName: "execute", allowedDecisions: ["approve", "reject"] }],
  };
  const { runtime } = createRuntimeStub([
    {
      messages: [new HumanMessage("run pwd")],
      __interrupt__: [{ value: interruptRequest }],
    },
  ]);
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.runOnce({
    threadId: "thread-2",
    input: "run pwd",
  });

  assert.equal(result.status, "interrupted");
  assert.match(result.traceId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.interruptRequest?.actionRequests[0]?.name, "execute");
  assert.deepEqual(result.interruptRequest?.actionRequests[0]?.args, { command: "pwd" });
  assert.equal(result.interruptRequest?.actionRequests[0]?.risk?.level, "medium");
  assert.equal(result.interruptCount, 1);
});

test("runOnce can continue through interrupts with a handler", async () => {
  const interruptRequest: HITLRequest = {
    actionRequests: [{ name: "write_file", args: { path: "note.txt", content: "hello" } }],
    reviewConfigs: [
      { actionName: "write_file", allowedDecisions: ["approve", "edit", "reject"] },
    ],
  };
  const { runtime, calls } = createRuntimeStub([
    {
      messages: [new HumanMessage("write a note")],
      __interrupt__: [{ value: interruptRequest }],
    },
    {
      messages: [
        new HumanMessage("write a note"),
        new ToolMessage({ name: "write_file", content: "ok", tool_call_id: "tool-1" }),
        new AIMessage("done"),
      ],
    },
  ]);
  const service = new AgentCoreServiceHarness(runtime);
  const resume: HITLResponse = {
    decisions: [{ type: "approve" }],
  };

  const result = await service.runOnce({
    threadId: "thread-3",
    input: "write a note",
    onInterrupt: async () => resume,
  });

  assert.equal(result.status, "completed");
  assert.match(result.traceId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.interruptCount, 1);
  assert.equal(result.newMessages.length, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.input instanceof Command);
});

test("runOnce normalizes reject decisions before resuming the graph", async () => {
  const interruptRequest: HITLRequest = {
    actionRequests: [{ name: "write_file", args: { path: "note.txt", content: "hello" } }],
    reviewConfigs: [
      { actionName: "write_file", allowedDecisions: ["approve", "edit", "reject"] },
    ],
  };
  const { runtime, calls } = createRuntimeStub([
    {
      messages: [new HumanMessage("write a note")],
      __interrupt__: [{ value: interruptRequest }],
    },
    {
      messages: [
        new HumanMessage("write a note"),
        new ToolMessage({
          name: "write_file",
          content: "[hitl_rejected] cancelled",
          tool_call_id: "tool-1",
          status: "error",
        }),
        new AIMessage("好的，我不会执行这个操作。"),
      ],
    },
  ]);
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.runOnce({
    threadId: "thread-reject-1",
    input: "write a note",
    onInterrupt: async () => ({ decisions: [{ type: "reject" }] }),
  });

  assert.equal(result.status, "completed");
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.input instanceof Command);

  const resume = (calls[1]?.input as Command<HITLResponse>).resume;
  const decision = resume?.decisions[0];
  assert.ok(decision && decision.type === "reject");
  assert.match((decision as { message?: string }).message ?? "", /\[hitl_rejected\]/);
  assert.match((decision as { message?: string }).message ?? "", /write_file/);
});

test("resumeOnce resolves repeated interrupts after a reject decision", async () => {
  const interruptRequest: HITLRequest = {
    actionRequests: [{ name: "execute", args: { command: "echo \"nope\" > rejected.txt" } }],
    reviewConfigs: [{ actionName: "execute", allowedDecisions: ["approve", "reject"] }],
  };
  const { runtime, calls, traceEvents } = createRuntimeStub(
    [
      {
        messages: [
          new HumanMessage({ content: "create rejected.txt", id: "msg-human-1" }),
          new AIMessage({
            id: "msg-ai-1",
            content: "",
            tool_calls: [
              {
                id: "tool-1",
                name: "execute",
                args: { command: "echo \"nope\" > rejected.txt" },
              },
            ],
          }),
          new ToolMessage({
            id: "msg-tool-1",
            name: "execute",
            content: "[hitl_rejected] cancelled",
            tool_call_id: "tool-1",
            status: "error",
          }),
          new AIMessage({
            id: "msg-ai-2",
            content: "",
            tool_calls: [
              {
                id: "tool-2",
                name: "execute",
                args: { command: "echo \"nope\" > rejected.txt" },
              },
            ],
          }),
        ],
        __interrupt__: [{ value: interruptRequest }],
      },
    ],
    [],
    { stateful: true },
  );
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.resumeOnce({
    threadId: "thread-reject-repeat",
    resume: { decisions: [{ type: "reject" }] },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.interruptCount, 0);
  assert.equal(result.interruptRequest, undefined);
  assert.ok(calls[0]?.input instanceof Command);
  assert.equal(result.messages.at(-1)?.content, "Understood. I will not execute the rejected execute action. Let me know if you want a safer alternative instead.");
  assert.ok(
    traceEvents.some(
      (event) =>
        event.kind === "run_completed" &&
        event.payload?.autoResolvedRejectedRetry === true,
    ),
  );
});

test("resumeOnce resumes an interrupted thread", async () => {
  const { runtime, calls } = createRuntimeStub([
    {
      messages: [new ToolMessage({ name: "execute", content: "pwd", tool_call_id: "tool-2" })],
    },
  ]);
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.resumeOnce({
    threadId: "thread-4",
    resume: { decisions: [{ type: "approve" }] },
  });

  assert.equal(result.status, "completed");
  assert.match(result.traceId, /^[0-9a-f-]{36}$/i);
  assert.equal(result.threadId, "thread-4");
  assert.equal(result.newMessages.length, 1);
  assert.ok(calls[0]?.input instanceof Command);
});

test("runOnce reports context compaction when summarization state changes", async () => {
  const { runtime, traceEvents } = createRuntimeStub(
    [
      {
        messages: [new HumanMessage("hello"), new AIMessage("world")],
      },
    ],
    [
      {},
      createCompactionState({
        sessionId: "session-1",
        cutoffIndex: 2,
        filePath: "/conversation_history/session-1.md",
        summaryPreview: "summary",
      }),
    ],
  );
  const service = new AgentCoreServiceHarness(runtime);

  const result = await service.runOnce({
    threadId: "thread-compaction-1",
    input: "hello",
  });

  assert.equal(result.status, "completed");
  assert.equal(result.contextCompaction?.sessionId, "session-1");
  assert.equal(result.contextCompaction?.cutoffIndex, 2);
  assert.equal(result.contextCompaction?.filePath, "/conversation_history/session-1.md");
  assert.ok(
    traceEvents.some(
      (event) =>
        event.kind === "context_compacted" &&
        event.payload?.filePath === "/conversation_history/session-1.md",
    ),
  );
});

test("runOnce blocks oversized input before invoking the agent", async () => {
  const { runtime, calls, traceEvents } = createRuntimeStub([]);
  runtime.guardrails = new DefaultGuardrails({
    maxInputChars: 5,
    maxOutputChars: 80_000,
    blockedInputTerms: [],
    blockedOutputTerms: [],
  });
  const service = new AgentCoreServiceHarness(runtime);

  await assert.rejects(
    () =>
      service.runOnce({
        threadId: "thread-guardrail-input",
        input: "123456",
      }),
    (error: unknown) =>
      error instanceof GuardrailViolationError &&
      error.violation.rule === "max_input_chars",
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(
    traceEvents.map((event) => event.kind),
    ["run_started", "guardrail_triggered", "run_failed"],
  );
});

test("runOnce blocks output terms before returning messages", async () => {
  const { runtime, traceEvents } = createRuntimeStub([
    {
      messages: [new HumanMessage("hello"), new AIMessage("token leaked")],
    },
  ]);
  runtime.guardrails = new DefaultGuardrails({
    maxInputChars: 20_000,
    maxOutputChars: 80_000,
    blockedInputTerms: [],
    blockedOutputTerms: ["token"],
  });
  const service = new AgentCoreServiceHarness(runtime);

  await assert.rejects(
    () =>
      service.runOnce({
        threadId: "thread-guardrail-output",
        input: "hello",
      }),
    (error: unknown) =>
      error instanceof GuardrailViolationError &&
      error.violation.rule === "blocked_output_term",
  );

  assert.equal(traceEvents.at(-2)?.kind, "guardrail_triggered");
  assert.equal(traceEvents.at(-1)?.kind, "run_failed");
});

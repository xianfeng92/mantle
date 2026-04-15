import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNodeServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StreamEvent } from "@langchain/core/types/stream";
import { Command } from "@langchain/langgraph";

import type { AgentRuntime } from "../src/agent.js";
import type { ContextCompactionSnapshot } from "../src/compaction.js";
import { DefaultGuardrails } from "../src/guardrails.js";
import { AgentCoreHttpServer } from "../src/http.js";
import { MemoryStore } from "../src/memory.js";
import { ReturnDispatcher, ReturnStore } from "../src/returns.js";
import { RunSnapshotsStore } from "../src/run-snapshots.js";
import type { SkillMetadata, SkillSource } from "../src/skills.js";
import type { SubagentMetadata, SubagentSource } from "../src/subagents.js";
import type { TraceEvent } from "../src/tracing.js";
import type { HITLRequest, InvokeResultLike } from "../src/types.js";

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
  streamEvents: StreamEvent[] = [],
  stateValues: unknown[] = [],
  skills: SkillMetadata[] = [],
  skillSources: SkillSource[] = [],
  subagents: SubagentMetadata[] = [],
  subagentSources: SubagentSource[] = [],
) {
  const invokeCalls: InvokeCall[] = [];
  const streamCalls: StreamCall[] = [];
  const stateCalls: InvokeCall[] = [];
  const deletedThreads: string[] = [];
  const traceEvents: TraceEvent[] = [];
  let invokeIndex = 0;
  let stateIndex = 0;

  const returnStore = new ReturnStore("/tmp/agent-core-test-returns-http.jsonl");
  const returnDispatcher = new ReturnDispatcher(returnStore);

  const runtime: AgentRuntime = {
    agent: {
      async invoke(input, config) {
        invokeCalls.push({ input, config });
        const response = responses[invokeIndex] ?? responses[responses.length - 1];
        invokeIndex += 1;
        if (!response) {
          throw new Error("No stub response configured.");
        }
        return response;
      },
      async *streamEvents(input, config) {
        streamCalls.push({ input, config });
        for (const event of streamEvents) {
          yield event;
        }
      },
      async getState(config) {
        stateCalls.push({ input: null, config });
        const values = stateValues[stateIndex] ?? stateValues[stateValues.length - 1] ?? {};
        stateIndex += 1;
        return { values };
      },
    },
    backend: {} as AgentRuntime["backend"],
    checkpointer: {
      async deleteThread(threadId: string) {
        deletedThreads.push(threadId);
      },
    } as AgentRuntime["checkpointer"],
    settings: {
      model: "google/gemma-4-26b-a4b",
      promptProfile: "compact",
      agentGraphVersion: "v2",
      contextWindowTokensHint: 28_000,
    } as AgentRuntime["settings"],
    skillSources,
    subagentSources,
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
        return traceEvents.slice(-limit) as never[];
      },
      async getTrace(traceId: string) {
        return traceEvents.filter((event) => event.traceId === traceId) as never[];
      },
    },
    memoryStore: new MemoryStore("/tmp/agent-core-test-memory-http.jsonl"),
    returnStore,
    returnDispatcher,
    generalPurposeSubagent: {
      enabled: true,
      name: "general-purpose",
      description: "General purpose subagent",
      inheritedSkillSources: skillSources.map((source) => source.backendPath),
    },
    async listSkills() {
      return skills;
    },
    async listSubagents() {
      return subagents;
    },
    async close() {},
  };

  return { runtime, invokeCalls, streamCalls, stateCalls, deletedThreads, traceEvents };
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

function parseSseEvents(payload: string): Array<{ event: string; data: unknown }> {
  return payload
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const eventLine = chunk
        .split("\n")
        .find((line) => line.startsWith("event: "));
      const dataLine = chunk
        .split("\n")
        .find((line) => line.startsWith("data: "));

      return {
        event: eventLine ? eventLine.slice("event: ".length) : "message",
        data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null,
      };
    });
}

test("HTTP health endpoint responds with ok", async () => {
  const { runtime } = createRuntimeStub([]);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as {
      ok: boolean;
      model: string;
      promptProfile: string;
    };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.model, "google/gemma-4-26b-a4b");
    assert.equal(body.promptProfile, "compact");
  } finally {
    await server.close();
  }
});

test("HTTP doctor endpoint returns preflight checks", async () => {
  const modelProvider = createNodeServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "google/gemma-4-26b-a4b" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => modelProvider.listen(0, "127.0.0.1", () => resolve()));
  const providerAddress = modelProvider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");

  const { runtime } = createRuntimeStub(
    [],
    [],
    [],
    [
      {
        name: "demo-skill",
        description: "Demo skill description",
        path: "/workspace/.deepagents/skills/demo-skill/SKILL.md",
        sourcePath: "/.deepagents/skills",
      },
    ],
  );
  runtime.settings = {
    ...runtime.settings,
    model: "google/gemma-4-26b-a4b",
    apiKey: "lm-studio",
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    workspaceDir: process.cwd(),
    workspaceMode: "workspace",
    dataDir: process.cwd(),
    memoryFilePath: `${process.cwd()}/.agent-core/test-memory.jsonl`,
    sandboxLevel: 1,
  } as AgentRuntime["settings"];

  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/doctor`);
    const body = (await response.json()) as {
      ok: boolean;
      summary: { overallStatus: string };
      runtime: { dataDir: string; memoryFilePath: string };
      checks: Array<{ id: string; status: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.summary.overallStatus, "warn");
    assert.equal(body.runtime.dataDir, process.cwd());
    assert.equal(body.runtime.memoryFilePath, `${process.cwd()}/.agent-core/test-memory.jsonl`);
    assert.ok(body.checks.some((check) => check.id === "model-provider" && check.status === "pass"));
    assert.ok(body.checks.some((check) => check.id === "sandbox" && check.status === "pass"));
  } finally {
    await server.close();
    await new Promise<void>((resolve, reject) =>
      modelProvider.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("HTTP memory injection endpoint returns the last injection snapshot for a thread", async () => {
  const { runtime } = createRuntimeStub([
    {
      messages: [new HumanMessage("hello"), new AIMessage("world")],
    },
  ]);
  await runtime.memoryStore.clear();
  const memoryContent = `The repo uses npm workspaces. ${Date.now()}`;
  await runtime.memoryStore.add({
    type: "project",
    content: memoryContent,
    source: {
      threadId: "seed-thread",
      traceId: "seed-trace",
      createdAt: new Date().toISOString(),
    },
    tags: ["repo"],
  });
  const { server, baseUrl } = await startServer(runtime);

  try {
    await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-memory-injection",
        input: "hello",
      }),
    });

    const response = await fetch(
      `${baseUrl}/memory/injection?threadId=thread-memory-injection`,
    );
    const body = (await response.json()) as {
      threadId: string;
      snapshot: { skipped: boolean; entries: Array<{ content: string }> } | null;
    };

    assert.equal(response.status, 200);
    assert.equal(body.threadId, "thread-memory-injection");
    assert.equal(body.snapshot?.skipped, false);
    assert.equal(body.snapshot?.entries[0]?.content, memoryContent);
  } finally {
    await server.close();
  }
});

test("HTTP run snapshot endpoints list and preview restores", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-http-snapshots-"));
  const snapshotsDir = path.join(workspaceDir, ".agent-core", "run-snapshots");
  const targetPath = path.join(workspaceDir, "note.txt");
  await writeFile(targetPath, "before\n", "utf8");

  try {
    const { runtime } = createRuntimeStub([]);
    runtime.settings = {
      ...runtime.settings,
      workspaceDir,
      runSnapshotsDir: snapshotsDir,
    } as AgentRuntime["settings"];
    runtime.runSnapshots = new RunSnapshotsStore(snapshotsDir, workspaceDir);

    await runtime.runSnapshots.startRun({
      traceId: "trace-http",
      threadId: "thread-http",
      mode: "run",
      inputPreview: "Update note.txt",
    });
    await runtime.runSnapshots.beginAction({
      traceId: "trace-http",
      threadId: "thread-http",
      toolName: "write_file",
      touchedPaths: ["note.txt"],
    });
    await writeFile(targetPath, "after\n", "utf8");
    await runtime.runSnapshots.completeAction({
      traceId: "trace-http",
      threadId: "thread-http",
      toolName: "write_file",
      touchedPaths: ["note.txt"],
      status: "completed",
      summary: "Write note.txt",
    });
    await runtime.runSnapshots.finalizeRun("trace-http", "completed");

    const { server, baseUrl } = await startServer(runtime);
    try {
      const listResponse = await fetch(`${baseUrl}/run-snapshots?limit=5`);
      const listBody = (await listResponse.json()) as {
        runs: Array<{ traceId: string; summary: { changedFiles: number } }>;
      };
      assert.equal(listResponse.status, 200);
      assert.equal(listBody.runs.length, 1);
      assert.equal(listBody.runs[0]?.traceId, "trace-http");
      assert.equal(listBody.runs[0]?.summary.changedFiles, 1);

      const previewResponse = await fetch(`${baseUrl}/run-snapshots/trace-http/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: true }),
      });
      const previewBody = (await previewResponse.json()) as {
        ok: boolean;
        dryRun: boolean;
        conflicts: string[];
      };
      assert.equal(previewResponse.status, 200);
      assert.equal(previewBody.ok, true);
      assert.equal(previewBody.dryRun, true);
      assert.deepEqual(previewBody.conflicts, []);
    } finally {
      await server.close();
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("HTTP skills endpoint returns configured skill sources and metadata", async () => {
  const { runtime } = createRuntimeStub(
    [],
    [],
    [],
    [
      {
        name: "demo-skill",
        description: "Demo skill description",
        path: "/workspace/.deepagents/skills/demo-skill/SKILL.md",
        sourcePath: "/.deepagents/skills",
      },
    ],
    [
      {
        absolutePath: "/workspace/.deepagents/skills",
        backendPath: "/.deepagents/skills",
      },
    ],
  );
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/skills`);
    const body = (await response.json()) as {
      sources: Array<{ absolutePath: string; backendPath: string }>;
      skills: Array<{ name: string; description: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.sources[0]?.backendPath, "/.deepagents/skills");
    assert.equal(body.skills[0]?.name, "demo-skill");
    assert.equal(body.skills[0]?.description, "Demo skill description");
  } finally {
    await server.close();
  }
});

test("HTTP thread endpoint creates a thread id when one is not provided", async () => {
  const { runtime } = createRuntimeStub([]);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/threads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const body = (await response.json()) as { threadId: string };

    assert.equal(response.status, 201);
    assert.match(
      body.threadId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  } finally {
    await server.close();
  }
});

test("HTTP subagents endpoint returns general-purpose and custom subagent metadata", async () => {
  const { runtime } = createRuntimeStub(
    [],
    [],
    [],
    [],
    [
      {
        absolutePath: "/workspace/.deepagents/skills",
        backendPath: "/.deepagents/skills",
      },
    ],
    [
      {
        name: "researcher",
        description: "Research-focused subagent",
        path: "/workspace/.deepagents/subagents/researcher.md",
        sourcePath: "/.deepagents/subagents",
        skills: ["/.deepagents/skills"],
      },
    ],
    [
      {
        absolutePath: "/workspace/.deepagents/subagents",
        backendPath: "/.deepagents/subagents",
      },
    ],
  );
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/subagents`);
    const body = (await response.json()) as {
      generalPurposeAgent: { name: string; inheritedSkillSources: string[] };
      sources: Array<{ absolutePath: string; backendPath: string }>;
      subagents: Array<{ name: string; description: string; skills?: string[] }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.generalPurposeAgent.name, "general-purpose");
    assert.deepEqual(body.generalPurposeAgent.inheritedSkillSources, ["/.deepagents/skills"]);
    assert.equal(body.sources[0]?.backendPath, "/.deepagents/subagents");
    assert.equal(body.subagents[0]?.name, "researcher");
    assert.equal(body.subagents[0]?.description, "Research-focused subagent");
    assert.deepEqual(body.subagents[0]?.skills, ["/.deepagents/skills"]);
  } finally {
    await server.close();
  }
});

test("HTTP run endpoint completes and returns serialized messages", async () => {
  const { runtime, invokeCalls } = createRuntimeStub([
    {
      messages: [new HumanMessage("hello"), new AIMessage("world")],
    },
  ]);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-http-1",
        input: "hello",
      }),
    });
    const body = (await response.json()) as {
      traceId: string;
      status: string;
      threadId: string;
      newMessages: Array<{ role: string; text: string }>;
    };

    assert.equal(response.status, 200);
    assert.match(body.traceId, /^[0-9a-f-]{36}$/i);
    assert.equal(response.headers.get("x-agent-core-trace-id"), body.traceId);
    assert.equal(body.status, "completed");
    assert.equal(body.threadId, "thread-http-1");
    assert.equal(body.newMessages.length, 2);
    assert.equal(body.newMessages[1]?.role, "assistant");
    assert.equal(body.newMessages[1]?.text, "world");
    assert.equal(invokeCalls[0]?.config?.version, "v2");
    assert.equal(invokeCalls[0]?.config?.configurable?.thread_id, "thread-http-1");
  } finally {
    await server.close();
  }
});

test("HTTP run endpoint returns interrupt payload when approval is required", async () => {
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
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-http-2",
        input: "run pwd",
      }),
    });
    const body = (await response.json()) as {
      traceId: string;
      status: string;
      interruptRequest?: HITLRequest;
    };

    assert.equal(response.status, 200);
    assert.match(body.traceId, /^[0-9a-f-]{36}$/i);
    assert.equal(body.status, "interrupted");
    assert.equal(body.interruptRequest?.actionRequests[0]?.name, "execute");
    assert.deepEqual(body.interruptRequest?.actionRequests[0]?.args, { command: "pwd" });
    assert.equal(body.interruptRequest?.actionRequests[0]?.risk?.level, "medium");
  } finally {
    await server.close();
  }
});

test("HTTP run endpoint serializes context compaction state", async () => {
  const { runtime } = createRuntimeStub(
    [
      {
        messages: [new HumanMessage("hello"), new AIMessage("world")],
      },
    ],
    [],
    [
      {},
      createCompactionState({
        sessionId: "session-http-1",
        cutoffIndex: 3,
        filePath: "/conversation_history/session-http-1.md",
        summaryPreview: "summary",
      }),
    ],
  );
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-http-compaction",
        input: "hello",
      }),
    });
    const body = (await response.json()) as {
      traceId: string;
      contextCompaction?: {
        sessionId?: string;
        cutoffIndex: number;
        filePath: string | null;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.contextCompaction?.sessionId, "session-http-1");
    assert.equal(body.contextCompaction?.cutoffIndex, 3);
    assert.equal(
      body.contextCompaction?.filePath,
      "/conversation_history/session-http-1.md",
    );
  } finally {
    await server.close();
  }
});

test("HTTP run stream endpoint emits context compacted events", async () => {
  const streamEvents: StreamEvent[] = [
    {
      event: "on_chat_model_stream",
      name: "model",
      run_id: "run-model-context",
      metadata: {},
      data: {
        chunk: { content: "Hel" },
      },
    },
    {
      event: "on_chain_end",
      name: "agent-core",
      run_id: "run-chain-context",
      metadata: {},
      data: {
        output: {
          messages: [new HumanMessage("hello"), new AIMessage("world")],
        },
      },
    },
  ];
  const { runtime } = createRuntimeStub(
    [],
    streamEvents,
    [
      {},
      createCompactionState({
        sessionId: "session-http-stream",
        cutoffIndex: 4,
        filePath: "/conversation_history/session-http-stream.md",
        summaryPreview: "summary",
      }),
    ],
  );
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-http-stream-context",
        input: "hello",
      }),
    });
    const payload = await response.text();
    const events = parseSseEvents(payload);

    assert.equal(response.status, 200);
    assert.ok(events.some((event) => event.event === "context_compacted"));
    const contextEvent = events.find((event) => event.event === "context_compacted");
    assert.equal(
      (contextEvent?.data as { contextCompaction?: { filePath?: string } }).contextCompaction
        ?.filePath,
      "/conversation_history/session-http-stream.md",
    );
  } finally {
    await server.close();
  }
});

test("HTTP run stream endpoint emits deltas, tool events, and completion", async () => {
  const streamEvents: StreamEvent[] = [
    {
      event: "on_chat_model_stream",
      name: "model",
      run_id: "run-model-1",
      metadata: {},
      data: {
        chunk: { content: "Hel" },
      },
    },
    {
      event: "on_chat_model_stream",
      name: "model",
      run_id: "run-model-1",
      metadata: {},
      data: {
        chunk: { content: "lo" },
      },
    },
    {
      event: "on_tool_start",
      name: "execute",
      run_id: "run-tool-1",
      metadata: {},
      data: {
        input: { command: "pwd" },
      },
    },
    {
      event: "on_tool_end",
      name: "execute",
      run_id: "run-tool-1",
      metadata: {},
      data: {
        output: "/tmp",
      },
    },
    {
      event: "on_chain_end",
      name: "agent-core",
      run_id: "run-root-1",
      metadata: {},
      data: {
        output: {
          messages: [new HumanMessage("hello"), new AIMessage("Hello")],
        },
      },
    },
  ];
  const { runtime, streamCalls } = createRuntimeStub([], streamEvents);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-stream-1",
        input: "hello",
      }),
    });
    const body = await response.text();
    const events = parseSseEvents(body);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.deepEqual(
      events.map((event) => event.event),
      ["run_started", "text_delta", "text_delta", "tool_started", "tool_finished", "run_completed"],
    );
    assert.match(response.headers.get("x-agent-core-trace-id") ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(
      (events[0]?.data as { traceId?: string }).traceId,
      response.headers.get("x-agent-core-trace-id"),
    );
    assert.deepEqual(events[1]?.data, {
      traceId: response.headers.get("x-agent-core-trace-id"),
      threadId: "thread-stream-1",
      delta: "Hel",
      runId: "run-model-1",
      nodeName: "model",
    });
    assert.deepEqual(events[5]?.data, {
      traceId: response.headers.get("x-agent-core-trace-id"),
      status: "completed",
      threadId: "thread-stream-1",
      interruptCount: 0,
      messages: [
        { role: "user", text: "hello", content: "hello" },
        { role: "assistant", text: "Hello", content: "Hello" },
      ],
      newMessages: [
        { role: "user", text: "hello", content: "hello" },
        { role: "assistant", text: "Hello", content: "Hello" },
      ],
    });
    assert.equal(streamCalls[0]?.config?.configurable?.thread_id, "thread-stream-1");
    assert.equal(streamCalls[0]?.config?.version, "v2");
  } finally {
    await server.close();
  }
});

test("HTTP resume stream endpoint emits interrupt result", async () => {
  const interruptRequest: HITLRequest = {
    actionRequests: [{ name: "write_file", args: { path: "note.txt", content: "hi" } }],
    reviewConfigs: [{ actionName: "write_file", allowedDecisions: ["approve", "reject"] }],
  };
  const streamEvents: StreamEvent[] = [
    {
      event: "on_chain_end",
      name: "agent-core",
      run_id: "run-root-2",
      metadata: {},
      data: {
        output: {
          messages: [new ToolMessage({ name: "write_file", content: "pending", tool_call_id: "tool-1" })],
          __interrupt__: [{ value: interruptRequest }],
        },
      },
    },
  ];
  const { runtime, streamCalls } = createRuntimeStub([], streamEvents);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/resume/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-stream-2",
        resume: {
          decisions: [{ type: "approve" }],
        },
      }),
    });
    const body = await response.text();
    const events = parseSseEvents(body);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("x-agent-core-trace-id") ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(streamCalls[0]?.config?.version, "v2");
    assert.deepEqual(
      events.map((event) => event.event),
      ["run_started", "run_interrupted"],
    );
    assert.equal((events[1]?.data as { status?: string }).status, "interrupted");
    assert.ok(streamCalls[0]?.input instanceof Command);
  } finally {
    await server.close();
  }
});

test("HTTP endpoints return 400 for malformed JSON bodies", async () => {
  const { runtime } = createRuntimeStub([]);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{bad json",
    });
    const body = (await response.json()) as { error: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, "Malformed JSON request body.");
  } finally {
    await server.close();
  }
});

test("HTTP endpoints return 413 for oversized JSON bodies", async () => {
  const { runtime } = createRuntimeStub([]);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: "x".repeat(1_000_001),
      }),
    });
    const body = (await response.json()) as { error: string };

    assert.equal(response.status, 413);
    assert.equal(body.error, "Request body too large.");
  } finally {
    await server.close();
  }
});

test("HTTP run endpoint returns 422 for guardrail violations", async () => {
  const { runtime } = createRuntimeStub([]);
  runtime.guardrails = new DefaultGuardrails({
    maxInputChars: 5,
    maxOutputChars: 80_000,
    blockedInputTerms: [],
    blockedOutputTerms: [],
  });
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-http-guardrail",
        input: "123456",
      }),
    });
    const body = (await response.json()) as {
      error: string;
      code: string;
      phase: string;
      rule: string;
      traceId?: string;
    };

    assert.equal(response.status, 422);
    assert.equal(body.code, "guardrail_violation");
    assert.equal(body.phase, "input");
    assert.equal(body.rule, "max_input_chars");
    assert.match(body.traceId ?? "", /^[0-9a-f-]{36}$/i);
    assert.equal(response.headers.get("x-agent-core-trace-id"), body.traceId);
  } finally {
    await server.close();
  }
});

test("HTTP run stream endpoint emits structured guardrail errors", async () => {
  const streamEvents: StreamEvent[] = [
    {
      event: "on_chat_model_stream",
      name: "model",
      run_id: "run-model-guardrail",
      metadata: {},
      data: {
        chunk: { content: "token leaked" },
      },
    },
    {
      event: "on_chain_end",
      name: "agent-core",
      run_id: "run-chain-guardrail",
      metadata: {},
      data: {
        output: {
          messages: [new HumanMessage("hello"), new AIMessage("token leaked")],
        },
      },
    },
  ];
  const { runtime } = createRuntimeStub([], streamEvents);
  runtime.guardrails = new DefaultGuardrails({
    maxInputChars: 20_000,
    maxOutputChars: 80_000,
    blockedInputTerms: [],
    blockedOutputTerms: ["token"],
  });
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/runs/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-http-stream-guardrail",
        input: "hello",
      }),
    });
    const payload = await response.text();
    const events = parseSseEvents(payload);

    assert.equal(response.status, 200);
    assert.deepEqual(
      events.map((event) => event.event),
      ["run_started", "error"],
    );
    assert.equal(
      (events[1]?.data as { code?: string; phase?: string; rule?: string }).code,
      "guardrail_violation",
    );
    assert.equal(
      (events[1]?.data as { code?: string; phase?: string; rule?: string }).phase,
      "output",
    );
    assert.equal(
      (events[1]?.data as { code?: string; phase?: string; rule?: string }).rule,
      "blocked_output_term",
    );
    assert.match(response.headers.get("x-agent-core-trace-id") ?? "", /^[0-9a-f-]{36}$/i);
  } finally {
    await server.close();
  }
});

test("HTTP resume endpoint resumes an interrupted thread", async () => {
  const { runtime, invokeCalls } = createRuntimeStub([
    {
      messages: [new ToolMessage({ name: "execute", content: "pwd", tool_call_id: "tool-1" })],
    },
  ]);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-http-3",
        resume: {
          decisions: [{ type: "approve" }],
        },
      }),
    });
    const body = (await response.json()) as {
      status: string;
      newMessages: Array<{ role: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, "completed");
    assert.equal(body.newMessages[0]?.role, "tool");
    assert.ok(invokeCalls[0]?.input instanceof Command);
    assert.equal(invokeCalls[0]?.config?.version, "v2");
  } finally {
    await server.close();
  }
});

test("HTTP delete thread endpoint clears persisted thread state", async () => {
  const { runtime, deletedThreads } = createRuntimeStub([]);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const response = await fetch(`${baseUrl}/threads/thread-http-4`, {
      method: "DELETE",
    });

    assert.equal(response.status, 204);
    assert.deepEqual(deletedThreads, ["thread-http-4"]);
  } finally {
    await server.close();
  }
});

test("HTTP traces endpoints expose recorded trace events", async () => {
  const { runtime } = createRuntimeStub([
    {
      messages: [new HumanMessage("hello"), new AIMessage("world")],
    },
  ]);
  const { server, baseUrl } = await startServer(runtime);

  try {
    const runResponse = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-http-trace",
        input: "hello",
      }),
    });
    const runBody = (await runResponse.json()) as { traceId: string };

    const recentResponse = await fetch(`${baseUrl}/traces?limit=10`);
    const recentBody = (await recentResponse.json()) as {
      events: Array<{ traceId: string; kind: string }>;
    };

    const traceResponse = await fetch(`${baseUrl}/traces/${runBody.traceId}`);
    const traceBody = (await traceResponse.json()) as {
      traceId: string;
      events: Array<{ traceId: string; kind: string }>;
    };

    assert.equal(recentResponse.status, 200);
    assert.ok(recentBody.events.some((event) => event.traceId === runBody.traceId));
    assert.equal(traceResponse.status, 200);
    assert.equal(traceBody.traceId, runBody.traceId);
    assert.deepEqual(
      traceBody.events.map((event) => event.kind),
      ["run_started", "run_completed"],
    );
  } finally {
    await server.close();
  }
});

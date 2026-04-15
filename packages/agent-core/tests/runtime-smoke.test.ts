import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { StreamEvent } from "@langchain/core/types/stream";

import { createAgentRuntime } from "../src/agent.js";
import { AgentCoreHttpServer } from "../src/http.js";
import { loadSettings } from "../src/settings.js";

interface InvokeCall {
  input: unknown;
  config?: {
    version?: "v1" | "v2";
    configurable?: Record<string, unknown>;
  };
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

test("createAgentRuntime can back the HTTP service in a temp workspace", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-runtime-"));
  const skillsDir = path.join(workspaceDir, ".deepagents", "skills", "demo-skill");
  const subagentsDir = path.join(workspaceDir, ".deepagents", "subagents");
  await mkdir(skillsDir, { recursive: true });
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(
    path.join(skillsDir, "SKILL.md"),
    `---
name: demo-skill
description: Demo skill
---
# Demo Skill
`,
  );
  await writeFile(
    path.join(subagentsDir, "researcher.md"),
    `---
description: Research-focused subagent
skills:
  - .deepagents/skills
---
You are a research-focused subagent.
`,
  );
  const settings = loadSettings({
    cwd: workspaceDir,
    env: {
      ...process.env,
      AGENT_CORE_MODEL: "google/gemma-4-26b-a4b",
      AGENT_CORE_API_KEY: "test-key",
      AGENT_CORE_BASE_URL: "http://127.0.0.1:1/v1",
      AGENT_CORE_WORKSPACE_DIR: ".",
      AGENT_CORE_DATA_DIR: ".agent-core-smoke",
      AGENT_CORE_VERBOSE: "0",
    },
  });

  const runtime = await createAgentRuntime(settings);
  const calls: InvokeCall[] = [];
  const streamEvents: StreamEvent[] = [
    {
      event: "on_chat_model_stream",
      name: "model",
      run_id: "runtime-stream-1",
      metadata: {},
      data: {
        chunk: { content: "ok" },
      },
    },
    {
      event: "on_chain_end",
      name: "agent-core",
      run_id: "runtime-stream-root",
      metadata: {},
      data: {
        output: {
          messages: [new HumanMessage("smoke"), new AIMessage("ok")],
        },
      },
    },
  ];
  runtime.agent = {
    async invoke(input, config) {
      calls.push({ input, config });
      return {
        messages: [new HumanMessage("smoke"), new AIMessage("ok")],
      };
    },
    async *streamEvents(input, config) {
      calls.push({ input, config });
      for (const event of streamEvents) {
        yield event;
      }
    },
  };

  const server = new AgentCoreHttpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
  });
  const address = await server.listen();
  const baseUrl = `http://${address.host}:${address.port}`;

  try {
    const dataDirStat = await stat(settings.dataDir);
    assert.equal(settings.workspaceDir, workspaceDir);
    assert.ok(dataDirStat.isDirectory());

    const skillsResponse = await fetch(`${baseUrl}/skills`);
    const skillsBody = (await skillsResponse.json()) as {
      sources: Array<{ backendPath: string }>;
      skills: Array<{ name: string }>;
    };

    assert.equal(skillsResponse.status, 200);
    assert.equal(skillsBody.sources[0]?.backendPath, "/.deepagents/skills");
    assert.equal(skillsBody.skills[0]?.name, "demo-skill");

    const subagentsResponse = await fetch(`${baseUrl}/subagents`);
    const subagentsBody = (await subagentsResponse.json()) as {
      generalPurposeAgent: { name: string };
      sources: Array<{ backendPath: string }>;
      subagents: Array<{ name: string; skills?: string[] }>;
    };

    assert.equal(subagentsResponse.status, 200);
    assert.equal(subagentsBody.generalPurposeAgent.name, "general-purpose");
    assert.equal(subagentsBody.sources[0]?.backendPath, "/.deepagents/subagents");
    assert.equal(subagentsBody.subagents[0]?.name, "researcher");
    assert.deepEqual(subagentsBody.subagents[0]?.skills, ["/.deepagents/skills"]);

    const response = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "runtime-smoke-thread",
        input: "smoke",
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
    assert.equal(body.status, "completed");
    assert.equal(body.threadId, "runtime-smoke-thread");
    assert.equal(body.newMessages[1]?.role, "assistant");
    assert.equal(body.newMessages[1]?.text, "ok");
    assert.equal(calls[0]?.config?.version, "v2");
    assert.equal(calls[0]?.config?.configurable?.thread_id, "runtime-smoke-thread");

    const streamResponse = await fetch(`${baseUrl}/runs/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "runtime-stream-thread",
        input: "smoke",
      }),
    });
    const streamBody = await streamResponse.text();
    const events = parseSseEvents(streamBody);

    assert.equal(streamResponse.status, 200);
    assert.deepEqual(
      events.map((event) => event.event),
      ["run_started", "text_delta", "run_completed"],
    );
    assert.match(
      (events[0]?.data as { traceId?: string }).traceId ?? "",
      /^[0-9a-f-]{36}$/i,
    );
    assert.equal(calls[1]?.config?.version, "v2");
    assert.equal(calls[1]?.config?.configurable?.thread_id, "runtime-stream-thread");

    const tracesResponse = await fetch(`${baseUrl}/traces?limit=20`);
    const tracesBody = (await tracesResponse.json()) as {
      events: Array<{ traceId: string; kind: string }>;
    };

    assert.equal(tracesResponse.status, 200);
    assert.ok(tracesBody.events.some((event) => event.kind === "run_completed"));
  } finally {
    await server.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

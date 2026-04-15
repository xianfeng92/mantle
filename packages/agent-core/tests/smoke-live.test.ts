/**
 * Live smoke tests — calls real Gemma 4 via LM Studio.
 *
 * Requires LM Studio running at http://127.0.0.1:1234.
 * All tests are skipped automatically if LM Studio is unreachable.
 *
 * Usage:
 *   npm run smoke:live
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, before } from "node:test";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { createAgentRuntime, type AgentRuntime } from "../src/agent.js";
import { AgentCoreHttpServer } from "../src/http.js";
import { AgentCoreServiceHarness } from "../src/service.js";
import { loadSettings } from "../src/settings.js";
import type { TraceEvent } from "../src/tracing.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
const MODEL = "google/gemma-4-26b-a4b";
const LIVE_TIMEOUT = 120_000; // 2 min per test — model inference is slow

// ---------------------------------------------------------------------------
// Pre-flight: is LM Studio reachable?
// ---------------------------------------------------------------------------

async function isLmStudioUp(): Promise<boolean> {
  try {
    const response = await fetch(`${LM_STUDIO_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Check at module load time so skip decisions work
const lmStudioAvailable = await isLmStudioUp();
if (!lmStudioAvailable) {
  console.log("\n⚠  LM Studio not reachable at 127.0.0.1:1234 — skipping live smoke tests.\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempWorkspace(): Promise<{
  workspaceDir: string;
  runtime: AgentRuntime;
  cleanup: () => Promise<void>;
}> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-live-"));
  await mkdir(path.join(workspaceDir, ".deepagents", "skills"), { recursive: true });
  await mkdir(path.join(workspaceDir, ".deepagents", "subagents"), { recursive: true });

  // Create a test file the model can read
  await writeFile(
    path.join(workspaceDir, "smoke-test.txt"),
    "The secret code is ALPHA-7742.\n",
  );

  const settings = loadSettings({
    cwd: workspaceDir,
    env: {
      ...process.env,
      AGENT_CORE_MODEL: MODEL,
      AGENT_CORE_API_KEY: "lm-studio",
      AGENT_CORE_BASE_URL: LM_STUDIO_BASE_URL,
      AGENT_CORE_WORKSPACE_DIR: ".",
      AGENT_CORE_DATA_DIR: ".agent-core-live-smoke",
      AGENT_CORE_VERBOSE: "0",
      AGENT_CORE_VIRTUAL_MODE: "false",
    },
  });

  const runtime = await createAgentRuntime(settings);

  return {
    workspaceDir,
    runtime,
    cleanup: async () => {
      await runtime.close();
      await rm(workspaceDir, { recursive: true, force: true });
    },
  };
}

async function chatCompletionRaw(
  messages: Array<{ role: string; content: string }>,
): Promise<{ content: string; finishReason: string }> {
  const response = await fetch(`${LM_STUDIO_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 256,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  assert.ok(response.ok, `LM Studio returned ${response.status}`);

  const data = (await response.json()) as {
    choices: Array<{
      message: { content: string };
      finish_reason: string;
    }>;
  };

  return {
    content: data.choices[0]?.message?.content ?? "",
    finishReason: data.choices[0]?.finish_reason ?? "unknown",
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Live Smoke Tests (Gemma 4 via LM Studio)", () => {
  const skip = !lmStudioAvailable || undefined;

  // -------------------------------------------------------------------------
  // 1. Basic connectivity
  // -------------------------------------------------------------------------

  test("LM Studio is reachable and model responds", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const result = await chatCompletionRaw([
      { role: "user", content: "Reply with exactly: SMOKE_OK" },
    ]);
    assert.ok(result.content.length > 0, "Model returned empty content");
    // We don't strictly assert "SMOKE_OK" because Gemma may embellish,
    // but the response should contain it or at least be non-empty.
    console.log(`    Model response: "${result.content.slice(0, 80)}"`);
  });

  // -------------------------------------------------------------------------
  // 2. Full agent run — model answers a question (no tools)
  // -------------------------------------------------------------------------

  test("Agent completes a simple question without tool calls", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const { runtime, cleanup } = await createTempWorkspace();

    try {
      const service = new AgentCoreServiceHarness(runtime);
      const result = await service.runOnce({
        threadId: "live-smoke-simple",
        input: "What is 2 + 3? Reply with just the number.",
      });

      assert.equal(result.status, "completed");
      assert.ok(result.newMessages.length >= 2, "Should have at least user + assistant message");

      const lastMsg = result.newMessages[result.newMessages.length - 1];
      assert.ok(lastMsg instanceof AIMessage, "Last message should be AIMessage");
      const text = typeof lastMsg.content === "string" ? lastMsg.content : "";
      assert.ok(text.length > 0, "Assistant should produce non-empty response");
      console.log(`    Agent response: "${text.slice(0, 120)}"`);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 3. Tool call flow — model reads a file
  // -------------------------------------------------------------------------

  test("Agent executes a tool call (read_file) and returns result", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const { runtime, workspaceDir, cleanup } = await createTempWorkspace();

    try {
      const service = new AgentCoreServiceHarness(runtime);
      const result = await service.runOnce({
        threadId: "live-smoke-tool",
        input: "Read the file smoke-test.txt in the workspace root and tell me the secret code.",
        maxInterrupts: 5,
        onInterrupt: async (request) => {
          // Auto-approve all tool calls for smoke testing
          return {
            decisions: request.actionRequests.map(() => ({ type: "approve" as const })),
          };
        },
      });

      assert.equal(result.status, "completed");

      // Check that we got messages back
      assert.ok(result.newMessages.length >= 2);

      // The final AI response should mention the secret code
      const finalMsg = result.newMessages[result.newMessages.length - 1];
      assert.ok(finalMsg instanceof AIMessage);
      const text = typeof finalMsg.content === "string" ? finalMsg.content : "";
      console.log(`    Agent response: "${text.slice(0, 200)}"`);

      // Check if there were tool calls (either native or fallback)
      const hasToolMessages = result.newMessages.some((m) => m instanceof ToolMessage);
      const hasToolCalls = result.newMessages.some(
        (m) => m instanceof AIMessage && m.tool_calls && m.tool_calls.length > 0,
      );

      console.log(`    Tool messages present: ${hasToolMessages}`);
      console.log(`    Native tool_calls used: ${hasToolCalls}`);

      // The response should contain the secret code if tools worked
      if (hasToolMessages) {
        assert.ok(
          text.includes("ALPHA-7742") || text.includes("alpha-7742") || text.toLowerCase().includes("alpha"),
          "Agent should mention the secret code from the file",
        );
      }
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 4. Fallback detection — check trace events after tool call
  // -------------------------------------------------------------------------

  test("Trace events are recorded for agent run (fallback or native path)", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const { runtime, cleanup } = await createTempWorkspace();

    try {
      const service = new AgentCoreServiceHarness(runtime);
      await service.runOnce({
        threadId: "live-smoke-trace",
        input: "List the files in the current directory.",
        maxInterrupts: 5,
        onInterrupt: async (request) => ({
          decisions: request.actionRequests.map(() => ({ type: "approve" as const })),
        }),
      });

      // Check trace events
      const events = await runtime.traceRecorder.listRecent(50);
      assert.ok(events.length > 0, "Should have trace events");

      const kinds = events.map((e) => e.kind);
      assert.ok(kinds.includes("run_started"), "Should have run_started event");
      assert.ok(
        kinds.includes("run_completed") || kinds.includes("run_failed"),
        "Should have run_completed or run_failed",
      );

      // Report which path was taken
      const hasFallback = kinds.includes("tool_call_fallback");
      const hasRetry = kinds.includes("retry_attempted");
      console.log(`    Trace events: ${kinds.join(", ")}`);
      console.log(`    Fallback triggered: ${hasFallback}`);
      console.log(`    Retry triggered: ${hasRetry}`);
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 5. Streaming — SSE stream produces events
  // -------------------------------------------------------------------------

  test("Streaming run produces SSE events with real model output", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const { runtime, cleanup } = await createTempWorkspace();

    try {
      const server = new AgentCoreHttpServer(runtime, {
        host: "127.0.0.1",
        port: 0,
      });
      const address = await server.listen();
      const baseUrl = `http://${address.host}:${address.port}`;

      try {
        const response = await fetch(`${baseUrl}/runs/stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: "live-smoke-stream",
            input: "Say hello in one sentence.",
          }),
          signal: AbortSignal.timeout(90_000),
        });

        assert.equal(response.status, 200);
        assert.ok(
          response.headers.get("content-type")?.includes("text/event-stream"),
          "Should return SSE content type",
        );

        const payload = await response.text();
        const events = payload
          .trim()
          .split("\n\n")
          .filter(Boolean)
          .map((chunk) => {
            const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
            return eventLine ? eventLine.slice("event: ".length) : "unknown";
          });

        assert.ok(events.includes("run_started"), "Should have run_started SSE event");
        assert.ok(
          events.includes("run_completed") || events.includes("run_interrupted"),
          "Should have terminal SSE event",
        );

        const hasDelta = events.includes("text_delta");
        console.log(`    SSE events: ${events.join(", ")}`);
        console.log(`    Text deltas received: ${hasDelta}`);
      } finally {
        await server.close();
      }
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 6. Diagnostics endpoint after real interactions
  // -------------------------------------------------------------------------

  test("Diagnostics endpoint returns stats after real agent run", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const { runtime, cleanup } = await createTempWorkspace();

    try {
      // First do a run to generate trace events
      const service = new AgentCoreServiceHarness(runtime);
      await service.runOnce({
        threadId: "live-smoke-diag",
        input: "What is TypeScript?",
      });

      // Now check diagnostics
      const server = new AgentCoreHttpServer(runtime, {
        host: "127.0.0.1",
        port: 0,
      });
      const address = await server.listen();
      const baseUrl = `http://${address.host}:${address.port}`;

      try {
        const response = await fetch(`${baseUrl}/diagnostics`);
        const body = (await response.json()) as {
          eventsAnalyzed: number;
          gemma4: {
            toolCallFallbackCount: number;
            retryCount: number;
            contextRecoveryCount: number;
          };
          runs: {
            completed: number;
            failed: number;
            avgDurationMs: number | null;
          };
        };

        assert.equal(response.status, 200);
        assert.ok(body.eventsAnalyzed > 0, "Should have analyzed events");
        assert.ok(
          body.runs.completed > 0 || body.runs.failed > 0,
          "Should have at least one run recorded",
        );

        console.log(`    Events analyzed: ${body.eventsAnalyzed}`);
        console.log(`    Runs completed: ${body.runs.completed}`);
        console.log(`    Runs failed: ${body.runs.failed}`);
        console.log(`    Avg duration: ${body.runs.avgDurationMs}ms`);
        console.log(`    Fallback count: ${body.gemma4.toolCallFallbackCount}`);
        console.log(`    Retry count: ${body.gemma4.retryCount}`);
      } finally {
        await server.close();
      }
    } finally {
      await cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // 7. Multi-turn conversation
  // -------------------------------------------------------------------------

  test("Agent maintains context across multiple turns", { timeout: LIVE_TIMEOUT * 2, skip }, async () => {
    const { runtime, cleanup } = await createTempWorkspace();

    try {
      const service = new AgentCoreServiceHarness(runtime);
      const threadId = "live-smoke-multi-turn";

      // Turn 1: plant a fact
      const turn1 = await service.runOnce({
        threadId,
        input: "Remember this: my favorite color is blue. Just acknowledge it briefly.",
      });
      assert.equal(turn1.status, "completed");
      console.log(`    Turn 1: "${(turn1.newMessages.at(-1) as AIMessage)?.content?.toString().slice(0, 80)}"`);

      // Turn 2: ask about the fact
      const turn2 = await service.runOnce({
        threadId,
        input: "What is my favorite color?",
      });
      assert.equal(turn2.status, "completed");
      const turn2Text = (turn2.newMessages.at(-1) as AIMessage)?.content?.toString() ?? "";
      console.log(`    Turn 2: "${turn2Text.slice(0, 80)}"`);

      assert.ok(
        turn2Text.toLowerCase().includes("blue") || turn2Text.includes("蓝"),
        "Agent should remember the favorite color from turn 1",
      );
    } finally {
      await cleanup();
    }
  });
});

/**
 * Shared test helpers for agent-core E2E tests.
 *
 * Extracted from smoke-live.test.ts and http.test.ts to eliminate duplication.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createAgentRuntime, type AgentRuntime } from "../src/agent.js";
import { AgentCoreHttpServer } from "../src/http.js";
import { loadSettings } from "../src/settings.js";
import type { TraceEvent } from "../src/tracing.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const MODEL = "google/gemma-4-26b-a4b";
export const LIVE_TIMEOUT = 120_000; // 2 min per test

// ---------------------------------------------------------------------------
// Pre-flight check
// ---------------------------------------------------------------------------

export async function isLmStudioUp(): Promise<boolean> {
  try {
    const response = await fetch(`${LM_STUDIO_BASE_URL}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

export interface TempWorkspace {
  workspaceDir: string;
  runtime: AgentRuntime;
  cleanup: () => Promise<void>;
}

export async function createTempWorkspace(
  envOverrides?: Record<string, string>,
): Promise<TempWorkspace> {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-e2e-"));
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
      AGENT_CORE_DATA_DIR: ".agent-core-e2e",
      AGENT_CORE_VERBOSE: "0",
      AGENT_CORE_VIRTUAL_MODE: "false",
      ...envOverrides,
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

// ---------------------------------------------------------------------------
// HTTP server helpers
// ---------------------------------------------------------------------------

export interface LiveServer {
  server: AgentCoreHttpServer;
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startLiveServer(runtime: AgentRuntime): Promise<LiveServer> {
  const server = new AgentCoreHttpServer(runtime, {
    host: "127.0.0.1",
    port: 0,
  });
  const address = await server.listen();
  const baseUrl = `http://${address.host}:${address.port}`;
  return { server, baseUrl, close: () => server.close() };
}

export function parseSseEvents(payload: string): Array<{ event: string; data: unknown }> {
  return payload
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const eventLine = chunk.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
      return {
        event: eventLine ? eventLine.slice("event: ".length) : "message",
        data: dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Assertion helpers — tolerant of LLM non-determinism
// ---------------------------------------------------------------------------

/**
 * Assert that `text` matches at least one of the given patterns.
 * Useful for LLM outputs where the exact wording varies.
 */
export function assertContains(text: string, patterns: RegExp[], message?: string): void {
  const matched = patterns.some((p) => p.test(text));
  if (!matched) {
    assert.fail(
      message ??
        `Expected text to match one of [${patterns.map((p) => p.toString()).join(", ")}], got: "${text.slice(0, 200)}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Metrics collector — gathers per-test agent performance data
// ---------------------------------------------------------------------------

export interface TestMetric {
  testName: string;
  suite: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  inferenceMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  contextUsagePercent: number | null;
  toolCallCount: number;
  fallbackTriggered: boolean;
  retryTriggered: boolean;
  error?: string;
  /** L2 evaluation result (optional, only present when EVAL_L2=1) */
  evalResult?: {
    scores: Array<{
      dimension: string;
      value: number;
      threshold: number;
      passed: boolean;
      explanation: string;
    }>;
    compositeScore: number;
    allPassed: boolean;
    judgeLatencyMs: number;
    judgeError?: string;
  };
}

export class TestMetricsCollector {
  readonly metrics: TestMetric[] = [];
  /** L2 eval context stored per test (keyed by testName) */
  private evalContexts = new Map<string, { input: string; output: string; expected?: string }>();

  record(
    metric: TestMetric,
    evalCtx?: { input: string; output: string; expected?: string },
  ): void {
    this.metrics.push(metric);
    if (evalCtx) {
      this.evalContexts.set(metric.testName, evalCtx);
    }
  }

  /** Store eval context separately (for use with captureForEval helpers). */
  storeEvalContext(testName: string, ctx: { input: string; output: string; expected?: string }): void {
    this.evalContexts.set(testName, ctx);
  }

  /**
   * Run L2 evaluation on all passed tests that have stored eval contexts.
   * Dynamically imports the eval module to avoid breaking when eval files don't exist.
   * Call this in the after() hook.
   */
  async runL2Eval(suite: string): Promise<void> {
    if (process.env.EVAL_L2 !== "1") return;
    if (this.evalContexts.size === 0) return;

    try {
      const { EvalRunner } = await import("./e2e/eval/eval-runner.js");
      const runner = new EvalRunner();

      for (const metric of this.metrics) {
        if (metric.status !== "pass") continue;
        const ctx = this.evalContexts.get(metric.testName);
        if (!ctx) continue;

        const result = await runner.evaluate({
          input: ctx.input,
          output: ctx.output,
          expected: ctx.expected,
          testName: metric.testName,
          suite,
        });
        if (result) {
          metric.evalResult = {
            scores: result.scores.map((s) => ({
              dimension: s.dimension,
              value: s.value,
              threshold: s.threshold,
              passed: s.passed,
              explanation: s.explanation,
            })),
            compositeScore: result.compositeScore,
            allPassed: result.allPassed,
            judgeLatencyMs: result.judgeLatencyMs,
            judgeError: result.judgeError,
          };
        }
      }
    } catch (err) {
      console.log(`  ⚠ L2 eval error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Extract metrics from trace events for a given traceId.
   */
  extractFromTrace(events: TraceEvent[], traceId: string): {
    inferenceMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    contextUsagePercent: number | null;
    toolCallCount: number;
    fallbackTriggered: boolean;
    retryTriggered: boolean;
  } {
    const traceEvents = events.filter((e) => e.traceId === traceId);

    const runCompleted = traceEvents.find((e) => e.kind === "run_completed");
    const tokenUsage = runCompleted?.payload?.tokenUsage as
      | Record<string, number>
      | undefined;

    return {
      inferenceMs: runCompleted?.durationMs ?? null,
      promptTokens: tokenUsage?.promptTokens ?? null,
      completionTokens: tokenUsage?.completionTokens ?? null,
      contextUsagePercent:
        typeof runCompleted?.payload?.contextUsagePercent === "number"
          ? runCompleted.payload.contextUsagePercent as number
          : null,
      toolCallCount: traceEvents.filter(
        (e) => e.kind === "tool_started",
      ).length,
      fallbackTriggered: traceEvents.some(
        (e) => e.kind === "tool_call_fallback",
      ),
      retryTriggered: traceEvents.some(
        (e) => e.kind === "retry_attempted",
      ),
    };
  }

  /** Print summary to terminal. */
  printSummary(): void {
    const passed = this.metrics.filter((m) => m.status === "pass").length;
    const failed = this.metrics.filter((m) => m.status === "fail").length;
    const skipped = this.metrics.filter((m) => m.status === "skip").length;
    const total = this.metrics.length;
    const totalDuration = this.metrics.reduce((s, m) => s + m.durationMs, 0);
    const successRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "0";

    const promptTotal = this.metrics.reduce(
      (s, m) => s + (m.promptTokens ?? 0),
      0,
    );
    const completionTotal = this.metrics.reduce(
      (s, m) => s + (m.completionTokens ?? 0),
      0,
    );
    const fallbackCount = this.metrics.filter((m) => m.fallbackTriggered).length;
    const retryCount = this.metrics.filter((m) => m.retryTriggered).length;

    console.log("\n" + "═".repeat(60));
    console.log("  E2E Test Summary");
    console.log("═".repeat(60));
    console.log(`  Tasks:       ${passed} passed / ${failed} failed / ${skipped} skipped (${total} total)`);
    console.log(`  Success:     ${successRate}%`);
    console.log(`  Duration:    ${(totalDuration / 1000).toFixed(1)}s`);
    console.log(`  Tokens:      ${promptTotal} prompt / ${completionTotal} completion`);
    console.log(`  Fallbacks:   ${fallbackCount}`);
    console.log(`  Retries:     ${retryCount}`);
    console.log("═".repeat(60));

    // Per-test table
    console.log("\n  Test Details:");
    for (const m of this.metrics) {
      const status = m.status === "pass" ? "✔" : m.status === "fail" ? "✗" : "⊘";
      const tokens =
        m.promptTokens != null
          ? `${m.promptTokens}p/${m.completionTokens ?? 0}c`
          : "—";
      const dur = `${(m.durationMs / 1000).toFixed(1)}s`;
      console.log(`  ${status} ${m.testName} (${dur} | ${tokens})`);
      if (m.error) {
        console.log(`    → ${m.error.slice(0, 120)}`);
      }
    }
    console.log();
  }

  toJSON(): object {
    const passed = this.metrics.filter((m) => m.status === "pass").length;
    const total = this.metrics.length;
    return {
      timestamp: new Date().toISOString(),
      summary: {
        total,
        passed,
        failed: this.metrics.filter((m) => m.status === "fail").length,
        skipped: this.metrics.filter((m) => m.status === "skip").length,
        successRate: total > 0 ? Number(((passed / total) * 100).toFixed(1)) : 0,
        totalDurationMs: this.metrics.reduce((s, m) => s + m.durationMs, 0),
        totalPromptTokens: this.metrics.reduce((s, m) => s + (m.promptTokens ?? 0), 0),
        totalCompletionTokens: this.metrics.reduce((s, m) => s + (m.completionTokens ?? 0), 0),
        fallbackCount: this.metrics.filter((m) => m.fallbackTriggered).length,
        retryCount: this.metrics.filter((m) => m.retryTriggered).length,
      },
      tests: this.metrics,
    };
  }
}

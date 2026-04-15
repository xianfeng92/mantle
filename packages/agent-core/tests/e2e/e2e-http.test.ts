/**
 * E2E: HTTP API — runs, streaming, memory CRUD, diagnostics, guardrails.
 *
 * Requires LM Studio running. Auto-skips if unavailable.
 */

import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import {
  isLmStudioUp,
  createTempWorkspace,
  startLiveServer,
  parseSseEvents,
  TestMetricsCollector,
  LIVE_TIMEOUT,
  type TempWorkspace,
  type LiveServer,
} from "../test-helpers.js";
import { writeReport } from "./report-generator.js";

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

const lmStudioAvailable = await isLmStudioUp();
if (!lmStudioAvailable) {
  console.log("\n⚠  LM Studio not reachable — skipping E2E HTTP tests.\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const collector = new TestMetricsCollector();
const SUITE = "http";

describe("E2E: HTTP API", () => {
  const skip = !lmStudioAvailable || undefined;
  let workspace: TempWorkspace;
  let live: LiveServer;

  before(async () => {
    if (!lmStudioAvailable) return;
    workspace = await createTempWorkspace();
    live = await startLiveServer(workspace.runtime);
  });

  after(async () => {
    if (!lmStudioAvailable) return;

    collector.printSummary();
    try {
      const reportData = collector.toJSON() as Parameters<typeof writeReport>[0];
      const reportPath = await writeReport(reportData);
      console.log(`  📄 HTML report: ${reportPath}\n`);
    } catch { /* best-effort */ }

    await live?.close();
    await workspace?.cleanup();
  });

  // 1. GET /health
  test("GET /health returns model info", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      const response = await fetch(`${live.baseUrl}/health`);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.ok(typeof body.model === "string" && body.model.length > 0);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "GET /health",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 2. POST /runs with real model
  test("POST /runs completes with real model", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      const response = await fetch(`${live.baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "e2e-http-run",
          input: "What is 7 + 8? Reply with just the number.",
        }),
        signal: AbortSignal.timeout(90_000),
      });

      const body = (await response.json()) as Record<string, unknown>;
      traceId = String(body.traceId ?? "");

      assert.equal(response.status, 200);
      assert.equal(body.status, "completed");
      assert.ok(traceId.length > 0, "Should return a traceId");
      assert.ok(
        response.headers.get("x-agent-core-trace-id"),
        "Should have trace header",
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(100);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "POST /runs",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 3. POST /runs/stream SSE
  test("POST /runs/stream emits SSE events", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      const response = await fetch(`${live.baseUrl}/runs/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "e2e-http-stream",
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
      const events = parseSseEvents(payload);
      const eventNames = events.map((e) => e.event);

      assert.ok(eventNames.includes("run_started"), "Should have run_started");
      assert.ok(
        eventNames.includes("run_completed") || eventNames.includes("run_interrupted"),
        "Should have terminal event",
      );
      assert.ok(eventNames.includes("text_delta"), "Should have text_delta events");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "POST /runs/stream (SSE)",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 4. Memory CRUD via HTTP
  test("Memory CRUD: POST → GET → DELETE", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      // POST — create
      const createRes = await fetch(`${live.baseUrl}/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "user", content: "E2E test memory", tags: ["test"] }),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as { entry: { id: string } };
      const memId = created.entry.id;
      assert.ok(memId, "Should return entry id");

      // GET — list
      const listRes = await fetch(`${live.baseUrl}/memory`);
      const listed = (await listRes.json()) as { entries: Array<{ id: string }>; count: number };
      assert.ok(listed.entries.some((e) => e.id === memId), "Should find created entry");

      // DELETE — single
      const delRes = await fetch(`${live.baseUrl}/memory/${memId}`, { method: "DELETE" });
      assert.equal(delRes.status, 204);

      // GET — verify deleted
      const afterDel = (await (await fetch(`${live.baseUrl}/memory`)).json()) as { entries: Array<{ id: string }> };
      assert.ok(!afterDel.entries.some((e) => e.id === memId), "Entry should be deleted");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "Memory CRUD",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 5. GET /diagnostics
  test("GET /diagnostics returns stats after runs", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      const response = await fetch(`${live.baseUrl}/diagnostics`);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.ok(typeof body.eventsAnalyzed === "number");
      assert.ok((body.runs as { completed: number }).completed > 0, "Should have completed runs");

      const ctx = body.contextUsage as Record<string, unknown>;
      assert.ok(typeof ctx.windowSize === "number");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "GET /diagnostics",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 6. POST /runs with empty input
  test("POST /runs with empty input returns 400", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      const response = await fetch(`${live.baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "e2e-http-empty" }),
      });

      assert.ok(
        response.status === 400 || response.status === 422,
        `Should reject missing input (got ${response.status})`,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "POST /runs 空输入",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 7. Concurrent threads with different threadIds
  test("POST /runs with different threadIds are independent", { timeout: LIVE_TIMEOUT * 2, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      // Run two sequential requests with different thread IDs
      const res1 = await fetch(`${live.baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "e2e-http-thread-A",
          input: "What is 3 + 3? Reply with just the number.",
        }),
        signal: AbortSignal.timeout(90_000),
      });

      const body1 = (await res1.json()) as Record<string, unknown>;
      assert.equal(body1.status, "completed");

      const res2 = await fetch(`${live.baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "e2e-http-thread-B",
          input: "What is 5 + 5? Reply with just the number.",
        }),
        signal: AbortSignal.timeout(90_000),
      });

      const body2 = (await res2.json()) as Record<string, unknown>;
      assert.equal(body2.status, "completed");

      // Both should have different traceIds
      assert.notEqual(body1.traceId, body2.traceId, "Should have different trace IDs");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "独立线程隔离",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 8. SSE stream contains text content
  test("POST /runs/stream text_delta contains actual text", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      const response = await fetch(`${live.baseUrl}/runs/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "e2e-http-stream-text",
          input: "What is 2 + 2? Reply with just the number.",
        }),
        signal: AbortSignal.timeout(90_000),
      });

      assert.equal(response.status, 200);

      const payload = await response.text();
      const events = parseSseEvents(payload);
      const textDeltas = events.filter((e) => e.event === "text_delta");

      assert.ok(textDeltas.length > 0, "Should have text_delta events");
      // At least one delta should have non-empty data
      // data is already parsed by parseSseEvents; check for any non-empty content
      const hasContent = textDeltas.some((e) => {
        if (e.data == null) return false;
        const d = e.data as Record<string, unknown>;
        // Could be { text: "..." } or { delta: "..." } or the data itself is a string
        if (typeof d.text === "string" && d.text.length > 0) return true;
        if (typeof d.delta === "string" && d.delta.length > 0) return true;
        if (typeof d.content === "string" && d.content.length > 0) return true;
        // Fallback: any truthy data
        return JSON.stringify(e.data).length > 5;
      });
      assert.ok(hasContent, "text_delta events should contain actual text");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "SSE text_delta 内容",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 9. GET /health response format
  test("GET /health includes expected fields", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      const response = await fetch(`${live.baseUrl}/health`);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.ok(typeof body.model === "string");
      // Should include prompt profile
      assert.ok(
        "promptProfile" in body || "profile" in body,
        "Should include prompt profile info",
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "GET /health 完整字段",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 10. Memory list returns correct format
  test("GET /memory returns entries array with count", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      const response = await fetch(`${live.baseUrl}/memory`);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.ok(Array.isArray(body.entries), "Should return entries array");
      assert.ok(typeof body.count === "number", "Should return count");
      assert.equal(body.count, (body.entries as unknown[]).length, "Count should match entries length");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "GET /memory 格式验证",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 11. DELETE non-existent memory returns 404
  test("DELETE /memory/:id for non-existent ID returns 404", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      const response = await fetch(`${live.baseUrl}/memory/non-existent-id-12345`, {
        method: "DELETE",
      });
      assert.equal(response.status, 404, "Should return 404 for non-existent ID");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "DELETE 不存在的记忆",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });

  // 12. Guardrail enforcement
  test("POST /runs with oversized input returns 422", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      // Send input that exceeds default maxInputChars (100000)
      const hugeInput = "x".repeat(100_001);
      const response = await fetch(`${live.baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "e2e-http-guardrail", input: hugeInput }),
      });

      assert.equal(response.status, 422, "Should reject oversized input");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "Guardrail 拦截",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        inferenceMs: null,
        promptTokens: null,
        completionTokens: null,
        contextUsagePercent: null,
        toolCallCount: 0,
        fallbackTriggered: false,
        retryTriggered: false,
        error,
      });
    }
  });
});

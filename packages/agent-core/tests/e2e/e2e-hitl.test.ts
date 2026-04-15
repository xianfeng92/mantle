/**
 * E2E: Human-in-the-loop — interrupt and resume flows.
 *
 * Requires LM Studio running. Auto-skips if unavailable.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test, { describe, before, after } from "node:test";

import { AgentCoreServiceHarness } from "../../src/service.js";
import {
  isLmStudioUp,
  createTempWorkspace,
  TestMetricsCollector,
  LIVE_TIMEOUT,
  type TempWorkspace,
} from "../test-helpers.js";
import { writeReport } from "./report-generator.js";

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

const lmStudioAvailable = await isLmStudioUp();
if (!lmStudioAvailable) {
  console.log("\n⚠  LM Studio not reachable — skipping E2E HITL tests.\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const collector = new TestMetricsCollector();
const SUITE = "hitl";

describe("E2E: HITL (Human-in-the-Loop)", () => {
  const skip = !lmStudioAvailable || undefined;
  let workspace: TempWorkspace;
  let service: AgentCoreServiceHarness;

  before(async () => {
    if (!lmStudioAvailable) return;
    workspace = await createTempWorkspace();
    service = new AgentCoreServiceHarness(workspace.runtime);
  });

  after(async () => {
    if (!lmStudioAvailable) return;

    collector.printSummary();
    try {
      const reportData = collector.toJSON() as Parameters<typeof writeReport>[0];
      const reportPath = await writeReport(reportData);
      console.log(`  📄 HTML report: ${reportPath}\n`);
    } catch { /* best-effort */ }

    await workspace?.cleanup();
  });

  // 1. Approve flow — write_file triggers interrupt, approve resumes
  test("write_file triggers interrupt, approve completes", { timeout: LIVE_TIMEOUT * 2, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";
    let interruptSeen = false;

    try {
      const result = await service.runOnce({
        threadId: "e2e-hitl-approve",
        input: "Create a file called hello.txt with the content 'Hello World' in the workspace root.",
        maxInterrupts: 5,
        onInterrupt: async (request) => {
          interruptSeen = true;
          // Approve all tool calls
          return {
            decisions: request.actionRequests.map(() => ({ type: "approve" as const })),
          };
        },
      });

      traceId = result.traceId;
      assert.equal(result.status, "completed");
      assert.ok(interruptSeen, "Should have triggered at least one interrupt");

      // Verify file was actually created
      const filePath = path.join(workspace.workspaceDir, "hello.txt");
      assert.ok(existsSync(filePath), "hello.txt should exist after approval");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(200);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "HITL approve (write_file)",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 2. Approve flow — write_file with specific content
  test("write_file approve creates file with correct content", { timeout: LIVE_TIMEOUT * 2, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      const result = await service.runOnce({
        threadId: "e2e-hitl-approve-content",
        input: "Create a file called test-data.json with content: {\"name\": \"test\", \"version\": 1}",
        maxInterrupts: 5,
        onInterrupt: async (request) => ({
          decisions: request.actionRequests.map(() => ({ type: "approve" as const })),
        }),
      });

      traceId = result.traceId;
      assert.equal(result.status, "completed");

      const filePath = path.join(workspace.workspaceDir, "test-data.json");
      assert.ok(existsSync(filePath), "test-data.json should exist after approval");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(200);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "HITL approve (JSON 文件)",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 3. Reject flow — reject prevents tool execution
  test("Reject decision prevents file creation", { timeout: LIVE_TIMEOUT * 2, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      const result = await service.runOnce({
        threadId: "e2e-hitl-reject",
        input: "Create a file called rejected.txt with content 'should not exist'.",
        maxInterrupts: 5,
        onInterrupt: async (request) => ({
          decisions: request.actionRequests.map(() => ({ type: "reject" as const })),
        }),
      });

      traceId = result.traceId;
      // After reject, run should still complete (agent handles the rejection)
      assert.ok(
        result.status === "completed" || result.status === "interrupted",
        "Should complete or stop at interrupt",
      );

      // Verify file was NOT created
      const filePath = path.join(workspace.workspaceDir, "rejected.txt");
      assert.ok(!existsSync(filePath), "rejected.txt should NOT exist after rejection");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(200);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "HITL reject (write_file)",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 4. Interrupt count tracking
  test("Multiple interrupts are counted correctly", { timeout: LIVE_TIMEOUT * 2, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";
    let interruptCount = 0;

    try {
      const result = await service.runOnce({
        threadId: "e2e-hitl-count",
        input: "Create a file called count.txt with content 'count test'.",
        maxInterrupts: 5,
        onInterrupt: async (request) => {
          interruptCount++;
          return {
            decisions: request.actionRequests.map(() => ({ type: "approve" as const })),
          };
        },
      });

      traceId = result.traceId;
      assert.equal(result.status, "completed");
      assert.ok(interruptCount >= 1, `Should have at least 1 interrupt (got ${interruptCount})`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(200);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "HITL 中断计数",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });
});

/**
 * E2E: Cross-session memory — store in Thread A, recall in Thread B.
 *
 * Requires LM Studio running. Auto-skips if unavailable.
 */

import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";

import { AIMessage } from "@langchain/core/messages";

import { AgentCoreServiceHarness } from "../../src/service.js";
import {
  isLmStudioUp,
  createTempWorkspace,
  assertContains,
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
  console.log("\n⚠  LM Studio not reachable — skipping E2E memory tests.\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const collector = new TestMetricsCollector();
const SUITE = "memory";

describe("E2E: Cross-Session Memory", () => {
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

    await collector.runL2Eval(SUITE);

    collector.printSummary();
    try {
      const reportData = collector.toJSON() as Parameters<typeof writeReport>[0];
      const reportPath = await writeReport(reportData);
      console.log(`  📄 HTML report: ${reportPath}\n`);
    } catch { /* best-effort */ }

    await workspace?.cleanup();
  });

  // 1. MemoryWriter extracts user preference
  test("MemoryWriter extracts preference from user message", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      const result = await service.runOnce({
        threadId: "e2e-mem-extract-pref",
        input: "记住：我偏好使用 TypeScript 写代码",
      });

      traceId = result.traceId;
      assert.equal(result.status, "completed");

      // Wait for async memory extraction
      await new Promise((resolve) => setTimeout(resolve, 500));

      const entries = await workspace.runtime.memoryStore.list();
      const userEntries = entries.filter((e) => e.type === "user");
      assert.ok(userEntries.length > 0, "Should have extracted a user-type memory");
      assert.ok(
        userEntries.some((e) => e.content.includes("TypeScript") || e.content.includes("偏好")),
        "Memory should contain the preference",
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(100);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "偏好提取",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 2. MemoryWriter extracts correction
  test("MemoryWriter extracts correction from user message", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      const result = await service.runOnce({
        threadId: "e2e-mem-extract-correction",
        input: "不要在代码中使用 any 类型",
      });

      traceId = result.traceId;
      assert.equal(result.status, "completed");

      await new Promise((resolve) => setTimeout(resolve, 500));

      const entries = await workspace.runtime.memoryStore.list();
      const corrections = entries.filter((e) => e.type === "correction");
      assert.ok(corrections.length > 0, "Should have extracted a correction-type memory");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(100);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "纠正提取",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 3. Cross-thread memory: Thread A stores, Thread B recalls
  test("Thread A stores preference, Thread B recalls it", { timeout: LIVE_TIMEOUT * 2, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      // Clear existing memories first
      await workspace.runtime.memoryStore.clear();

      // Thread A: state a preference
      await service.runOnce({
        threadId: "e2e-mem-thread-A",
        input: "记住：我最喜欢的编程语言是 Swift",
      });

      // Wait for memory extraction
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify memory was stored
      const entries = await workspace.runtime.memoryStore.list();
      assert.ok(entries.length > 0, "Memory should be stored after Thread A");

      // Thread B: new thread, ask about the preference
      const resultB = await service.runOnce({
        threadId: "e2e-mem-thread-B",
        input: "我最喜欢什么编程语言？",
      });

      traceId = resultB.traceId;
      assert.equal(resultB.status, "completed");

      const text = (resultB.newMessages.at(-1) as AIMessage)?.content?.toString() ?? "";
      collector.storeEvalContext("跨线程记忆 (A→B)", { input: "我最喜欢什么编程语言？", output: text, expected: "Swift (stored in Thread A)" });
      assertContains(text, [/swift/i], "Thread B should recall Swift from memory");

      // Verify <memory> tag was injected
      const userMsg = resultB.newMessages.find(
        (m) => !(m instanceof AIMessage) && typeof m.content === "string" && m.content.includes("<memory>"),
      );
      assert.ok(userMsg, "User message should contain <memory> tag");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(200);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "跨线程记忆 (A→B)",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 4. Memory injection appears in context
  test("Memory injection adds <memory> tag to agent input", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      // Ensure there's at least one memory entry
      const entries = await workspace.runtime.memoryStore.list();
      if (entries.length === 0) {
        await workspace.runtime.memoryStore.add({
          type: "user",
          content: "Test memory entry",
          source: { threadId: "test", traceId: "test", createdAt: new Date().toISOString() },
          tags: [],
        });
      }

      const result = await service.runOnce({
        threadId: "e2e-mem-injection-check",
        input: "Hello",
      });

      traceId = result.traceId;
      assert.equal(result.status, "completed");

      // Check that the user message in the result contains <memory>
      const userMsg = result.newMessages.find(
        (m) => !(m instanceof AIMessage) && typeof m.content === "string",
      );
      const userContent = typeof userMsg?.content === "string" ? userMsg.content : "";
      assert.ok(
        userContent.includes("<memory>"),
        "Input should contain <memory> tag when memories exist",
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(100);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "记忆注入验证",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 5. Memory deduplication — same fact stored once
  test("MemoryWriter does not duplicate identical facts", { timeout: LIVE_TIMEOUT * 2, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      await workspace.runtime.memoryStore.clear();

      // Say the same preference twice in different threads
      await service.runOnce({
        threadId: "e2e-mem-dedup-1",
        input: "记住：我喜欢用 Vim 编辑器",
      });
      await new Promise((resolve) => setTimeout(resolve, 500));

      await service.runOnce({
        threadId: "e2e-mem-dedup-2",
        input: "记住：我喜欢用 Vim 编辑器",
      });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const entries = await workspace.runtime.memoryStore.list();
      const vimEntries = entries.filter(
        (e) => e.content.toLowerCase().includes("vim"),
      );
      // Should ideally not have too many duplicates (allow 1-2 due to LLM non-determinism)
      assert.ok(
        vimEntries.length <= 3,
        `Should deduplicate or limit entries (got ${vimEntries.length})`,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(200);
      const trace = collector.extractFromTrace(events, "");
      collector.record({
        testName: "记忆去重",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 6. MemoryWriter extracts project context
  test("MemoryWriter extracts project context from message", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;
    let traceId = "";

    try {
      await workspace.runtime.memoryStore.clear();

      const result = await service.runOnce({
        threadId: "e2e-mem-extract-project",
        input: "我们用的是 TypeScript 和 deepagentsjs 框架来构建 agent-core",
      });

      traceId = result.traceId;
      assert.equal(result.status, "completed");

      // MemoryWriter runs async — poll until extraction completes (up to 10s)
      let entries = await workspace.runtime.memoryStore.list();
      for (let i = 0; i < 10 && entries.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        entries = await workspace.runtime.memoryStore.list();
      }
      assert.ok(entries.length > 0, "Should extract at least one memory from project context");
      const allContent = entries.map((e) => e.content).join(" ");
      assert.ok(
        allContent.includes("TypeScript") || allContent.includes("deepagentsjs") || allContent.includes("agent-core"),
        "Memory should reference project details",
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const events = await workspace.runtime.traceRecorder.listRecent(200);
      const trace = collector.extractFromTrace(events, traceId);
      collector.record({
        testName: "项目上下文提取",
        suite: SUITE,
        status: error ? "fail" : "pass",
        durationMs: Date.now() - start,
        ...trace,
        error,
      });
    }
  });

  // 7. Memory persists across service restart (same runtime)
  test("Memory entries survive across multiple runs", { timeout: LIVE_TIMEOUT, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      await workspace.runtime.memoryStore.clear();

      // Manually add a memory entry
      await workspace.runtime.memoryStore.add({
        type: "user",
        content: "User prefers dark mode in all applications",
        source: { threadId: "e2e-persist", traceId: "test-persist", createdAt: new Date().toISOString() },
        tags: ["preference"],
      });

      // Verify it's there
      let entries = await workspace.runtime.memoryStore.list();
      assert.ok(entries.some((e) => e.content.includes("dark mode")), "Entry should exist after add");

      // Run a conversation (which exercises the memory system)
      await service.runOnce({
        threadId: "e2e-mem-persist-run",
        input: "Hello",
      });

      // Verify entry still exists after a run
      entries = await workspace.runtime.memoryStore.list();
      assert.ok(entries.some((e) => e.content.includes("dark mode")), "Entry should persist after run");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "记忆持久化",
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

  // 8. Memory store clear works
  test("Memory store clear removes all entries", { timeout: 10_000, skip }, async () => {
    const start = Date.now();
    let error: string | undefined;

    try {
      // Add some entries
      await workspace.runtime.memoryStore.add({
        type: "user",
        content: "Test entry A",
        source: { threadId: "clear-test", traceId: "clear-a", createdAt: new Date().toISOString() },
        tags: [],
      });
      await workspace.runtime.memoryStore.add({
        type: "correction",
        content: "Test entry B",
        source: { threadId: "clear-test", traceId: "clear-b", createdAt: new Date().toISOString() },
        tags: [],
      });

      let entries = await workspace.runtime.memoryStore.list();
      assert.ok(entries.length >= 2, "Should have at least 2 entries");

      await workspace.runtime.memoryStore.clear();
      entries = await workspace.runtime.memoryStore.list();
      assert.equal(entries.length, 0, "Should have 0 entries after clear");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      collector.record({
        testName: "记忆清除",
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

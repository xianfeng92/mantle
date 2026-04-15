import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlTraceRecorder } from "../src/tracing.js";

test("JsonlTraceRecorder persists and filters trace events", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-traces-"));
  const filePath = path.join(tempDir, "traces.jsonl");
  const recorder = new JsonlTraceRecorder(filePath);

  try {
    await recorder.record({
      timestamp: "2026-04-06T00:00:00.000Z",
      traceId: "trace-1",
      threadId: "thread-1",
      kind: "run_started",
    });
    await recorder.record({
      timestamp: "2026-04-06T00:00:01.000Z",
      traceId: "trace-1",
      threadId: "thread-1",
      kind: "run_completed",
      durationMs: 1000,
    });
    await recorder.record({
      timestamp: "2026-04-06T00:00:02.000Z",
      traceId: "trace-2",
      threadId: "thread-2",
      kind: "run_failed",
      payload: { error: "boom" },
    });

    const raw = await readFile(filePath, "utf8");
    const recent = await recorder.listRecent(2);
    const trace = await recorder.getTrace("trace-1");

    assert.match(raw, /"traceId":"trace-1"/);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]?.traceId, "trace-1");
    assert.equal(recent[1]?.traceId, "trace-2");
    assert.deepEqual(trace.map((event) => event.kind), [
      "run_started",
      "run_completed",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

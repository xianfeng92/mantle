import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isLmStudioUp } from "../../test-helpers.js";
import { runLaunchBenchmarkSuite } from "./launch-benchmark-runner.js";

const lmStudioAvailable = await isLmStudioUp();
if (!lmStudioAvailable) {
  console.log("\n⚠  LM Studio not reachable — skipping launch workflow replay suite.\n");
}

test(
  "Launch workflow replay suite completes and emits gate artifacts",
  {
    timeout: 15 * 60 * 1000,
    skip: !lmStudioAvailable || undefined,
  },
  async () => {
    const outputDir = path.join(
      os.tmpdir(),
      `cortex-launch-benchmark-${Date.now()}`,
    );
    const summary = await runLaunchBenchmarkSuite({
      outputDir,
      requireL2: false,
    });

    assert.ok(
      summary.health.ok,
      `Launch replay suite should complete health checks. See ${summary.outputDir}`,
    );
    assert.equal(summary.workflows["selection-rewrite"].total, 5);
    assert.equal(summary.workflows["downloads-organize"].total, 3);
    assert.equal(summary.workflows["context-todo"].total, 4);
    assert.ok(
      summary.gates.hard.length > 0,
      `Launch replay suite should emit hard-gate results. See ${summary.outputDir}`,
    );
  },
);

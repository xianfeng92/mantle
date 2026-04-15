import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listMoves, recordMove, rollbackMove } from "../src/move-tracker.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("rollbackMove resolves relative paths against workspaceDir", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "move-tracker-test-"));
  const movesLogPath = path.join(workspaceDir, ".agent-core", "moves.jsonl");
  const originalPath = path.join(workspaceDir, "Downloads", "design-mockup.sketch");
  const movedPath = path.join(workspaceDir, "Downloads", "Design", "design-mockup.sketch");

  try {
    await mkdir(path.dirname(movedPath), { recursive: true });
    await writeFile(movedPath, "mockup-data", "utf-8");

    await recordMove(
      {
        timestamp: new Date().toISOString(),
        sourcePath: "Downloads/design-mockup.sketch",
        destPath: "Downloads/Design/design-mockup.sketch",
      },
      movesLogPath,
    );

    const [record] = await listMoves(movesLogPath);
    assert.ok(record, "Expected a move record to be stored");

    const result = await rollbackMove(record.id, movesLogPath, workspaceDir);
    assert.equal(result.success, true, result.error);
    assert.equal(await fileExists(originalPath), true);
    assert.equal(await fileExists(movedPath), false);
    assert.equal(await readFile(originalPath, "utf-8"), "mockup-data");

    const [updated] = await listMoves(movesLogPath);
    assert.equal(updated?.rolledBack, true);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

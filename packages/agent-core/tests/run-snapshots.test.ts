import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RunSnapshotsStore } from "../src/run-snapshots.js";

test("RunSnapshotsStore captures updated files and restores them", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-run-snapshots-"));
  const snapshotsDir = path.join(workspaceDir, ".agent-core", "run-snapshots");
  const targetPath = path.join(workspaceDir, "note.txt");
  await writeFile(targetPath, "before\n", "utf8");

  try {
    const store = new RunSnapshotsStore(snapshotsDir, workspaceDir);
    await store.startRun({
      traceId: "trace-update",
      threadId: "thread-1",
      mode: "run",
      inputPreview: "Update note.txt",
    });
    await store.beginAction({
      traceId: "trace-update",
      threadId: "thread-1",
      toolName: "write_file",
      touchedPaths: ["note.txt"],
    });

    await writeFile(targetPath, "after\n", "utf8");

    await store.completeAction({
      traceId: "trace-update",
      threadId: "thread-1",
      toolName: "write_file",
      touchedPaths: ["note.txt"],
      status: "completed",
      summary: "Write note.txt",
    });
    await store.finalizeRun("trace-update", "completed");

    const record = await store.getRun("trace-update");
    assert.ok(record);
    assert.equal(record.summary.changedFiles, 1);
    assert.equal(record.files[0]?.changeType, "updated");
    assert.equal(record.files[0]?.restorable, true);

    const preview = await store.restoreRun("trace-update", { dryRun: true });
    assert.ok(preview);
    assert.equal(preview?.ok, true);
    assert.equal(preview?.conflicts.length, 0);

    const restored = await store.restoreRun("trace-update", { dryRun: false });
    assert.ok(restored);
    assert.equal(restored?.ok, true);
    assert.equal(await readFile(targetPath, "utf8"), "before\n");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("RunSnapshotsStore restores tracked move operations back to the source path", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-run-snapshots-"));
  const snapshotsDir = path.join(workspaceDir, ".agent-core", "run-snapshots");
  const sourcePath = path.join(workspaceDir, "Downloads", "draft.txt");
  const destPath = path.join(workspaceDir, "Archive", "draft.txt");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "draft\n", "utf8");

  try {
    const store = new RunSnapshotsStore(snapshotsDir, workspaceDir);
    await store.startRun({
      traceId: "trace-move",
      threadId: "thread-2",
      mode: "run",
      inputPreview: "Move draft.txt",
    });
    await store.beginAction({
      traceId: "trace-move",
      threadId: "thread-2",
      toolName: "execute",
      touchedPaths: ["Downloads/draft.txt", "Archive/draft.txt"],
      moveRoles: {
        "Downloads/draft.txt": "source",
        "Archive/draft.txt": "dest",
      },
    });

    await mkdir(path.dirname(destPath), { recursive: true });
    await rename(sourcePath, destPath);

    await store.completeAction({
      traceId: "trace-move",
      threadId: "thread-2",
      toolName: "execute",
      touchedPaths: ["Downloads/draft.txt", "Archive/draft.txt"],
      status: "completed",
      summary: "Move draft.txt",
      moveIds: ["move-1"],
    });
    await store.finalizeRun("trace-move", "completed");

    const record = await store.getRun("trace-move");
    assert.ok(record);
    const sourceEntry = record.files.find((file) => file.path == "Downloads/draft.txt");
    const destEntry = record.files.find((file) => file.path == "Archive/draft.txt");
    assert.equal(sourceEntry?.changeType, "moved_out");
    assert.equal(destEntry?.changeType, "moved_in");

    const restored = await store.restoreRun("trace-move", { dryRun: false });
    assert.ok(restored);
    assert.equal(restored?.ok, true);
    assert.equal(await readFile(sourcePath, "utf8"), "draft\n");
    await assert.rejects(readFile(destPath, "utf8"));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

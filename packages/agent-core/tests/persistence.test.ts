import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadSessionSnapshot,
  rememberThreadId,
  resolveInitialThreadId,
} from "../src/persistence.js";

test("resolveInitialThreadId reuses stored session thread", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-persistence-"));

  try {
    const sessionStatePath = path.join(tempDir, "session.json");
    const first = await resolveInitialThreadId(undefined, sessionStatePath);
    const second = await resolveInitialThreadId(undefined, sessionStatePath);
    const snapshot = await loadSessionSnapshot(sessionStatePath);

    assert.equal(second, first);
    assert.equal(snapshot?.lastThreadId, first);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("explicit thread id overrides remembered session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-persistence-"));

  try {
    const sessionStatePath = path.join(tempDir, "session.json");
    await rememberThreadId(sessionStatePath, "thread-old");

    const resolved = await resolveInitialThreadId("thread-new", sessionStatePath);
    const snapshot = await loadSessionSnapshot(sessionStatePath);

    assert.equal(resolved, "thread-new");
    assert.equal(snapshot?.lastThreadId, "thread-new");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

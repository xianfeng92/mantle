import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseMvCommands, resolveRecordedMovePaths } from "../src/audit-log.js";

test("parseMvCommands extracts chained mv commands including multi-source moves", () => {
  const parsed = parseMvCommands(
    'mkdir -p "Downloads/Images" "Downloads/Design" && mv "Downloads/screenshot-001.png" "Downloads/random-image.jpeg" "Downloads/Images/" ; mv podcast.mp3 Downloads/Audio/ ; mv "Downloads/design-mockup.sketch" "Downloads/Design/"',
  );

  assert.deepEqual(parsed, [
    {
      source: "Downloads/screenshot-001.png",
      dest: "Downloads/Images/",
    },
    {
      source: "Downloads/random-image.jpeg",
      dest: "Downloads/Images/",
    },
    {
      source: "podcast.mp3",
      dest: "Downloads/Audio/",
    },
    {
      source: "Downloads/design-mockup.sketch",
      dest: "Downloads/Design/",
    },
  ]);
});

test("resolveRecordedMovePaths converts directory targets into final file paths", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "audit-log-test-"));

  try {
    await mkdir(path.join(workspaceDir, "Downloads", "Design"), { recursive: true });
    await writeFile(
      path.join(workspaceDir, "Downloads", "design-mockup.sketch"),
      "mockup",
      "utf-8",
    );

    const resolved = await resolveRecordedMovePaths(
      {
        source: "Downloads/design-mockup.sketch",
        dest: "Downloads/Design/",
      },
      workspaceDir,
    );

    assert.deepEqual(resolved, {
      sourcePath: "Downloads/design-mockup.sketch",
      destPath: "Downloads/Design/design-mockup.sketch",
    });
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadSubagentsFromSources,
  resolveSubagentSources,
} from "../src/subagents.js";

test("resolveSubagentSources discovers workspace subagent directories", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-subagents-"));
  const subagentsDir = path.join(workspaceDir, ".deepagents", "subagents");

  try {
    await mkdir(subagentsDir, { recursive: true });
    const resolvedSubagentsDir = await realpath(subagentsDir);
    const sources = await resolveSubagentSources(workspaceDir, []);

    assert.deepEqual(sources, [
      {
        absolutePath: resolvedSubagentsDir,
        backendPath: "/.deepagents/subagents",
      },
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("loadSubagentsFromSources reads frontmatter and resolves skill sources", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-subagents-"));
  const skillsDir = path.join(workspaceDir, ".deepagents", "skills", "research");
  const subagentsDir = path.join(workspaceDir, ".deepagents", "subagents");

  try {
    await mkdir(skillsDir, { recursive: true });
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      path.join(skillsDir, "SKILL.md"),
      `---
name: research-skill
description: Research helpers
---
# Research Skill
`,
    );
    await writeFile(
      path.join(subagentsDir, "researcher.md"),
      `---
description: Research-focused subagent
skills:
  - .deepagents/skills
---
You are a research-focused subagent.
`,
    );

    const subagents = await loadSubagentsFromSources(workspaceDir, [
      {
        absolutePath: subagentsDir,
        backendPath: "/.deepagents/subagents",
      },
    ]);

    assert.equal(subagents.length, 1);
    assert.equal(subagents[0]?.metadata.name, "researcher");
    assert.equal(subagents[0]?.metadata.description, "Research-focused subagent");
    assert.equal(subagents[0]?.metadata.sourcePath, "/.deepagents/subagents");
    assert.deepEqual(subagents[0]?.metadata.skills, ["/.deepagents/skills"]);
    assert.equal(subagents[0]?.definition.name, "researcher");
    assert.equal(
      subagents[0]?.definition.systemPrompt,
      "You are a research-focused subagent.",
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

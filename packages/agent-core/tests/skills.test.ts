import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listSkillsFromSources, resolveSkillSources } from "../src/skills.js";

test("resolveSkillSources discovers workspace skill directories", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-skills-"));
  const skillsDir = path.join(workspaceDir, ".deepagents", "skills");

  try {
    await mkdir(skillsDir, { recursive: true });
    const resolvedSkillsDir = await realpath(skillsDir);
    const sources = await resolveSkillSources(workspaceDir, []);

    assert.deepEqual(sources, [
      {
        absolutePath: resolvedSkillsDir,
        backendPath: "/.deepagents/skills",
      },
    ]);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("listSkillsFromSources reads skill metadata and preserves later source priority", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "agent-core-skills-"));
  const userSkillsDir = path.join(workspaceDir, "skills-user");
  const projectSkillsDir = path.join(workspaceDir, "skills-project");
  const skillBody = (description: string) => `---
name: demo-skill
description: ${description}
---
# Demo Skill
`;

  try {
    await mkdir(path.join(userSkillsDir, "demo-skill"), { recursive: true });
    await mkdir(path.join(projectSkillsDir, "demo-skill"), { recursive: true });
    await writeFile(
      path.join(userSkillsDir, "demo-skill", "SKILL.md"),
      skillBody("user description"),
    );
    await writeFile(
      path.join(projectSkillsDir, "demo-skill", "SKILL.md"),
      skillBody("project description"),
    );

    const skills = await listSkillsFromSources([
      {
        absolutePath: userSkillsDir,
        backendPath: "/skills-user",
      },
      {
        absolutePath: projectSkillsDir,
        backendPath: "/skills-project",
      },
    ]);

    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "demo-skill");
    assert.equal(skills[0]?.description, "project description");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

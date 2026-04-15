import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { parseSkillMetadata } from "deepagents";

export interface SkillSource {
  absolutePath: string;
  backendPath: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
  sourcePath: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  // Extended fields (v2 skill format)
  version?: string;
  author?: string;
  tags?: string[];
  requiresTools?: string[];
  parameters?: Record<string, SkillParameter>;
  executionMode?: "inline" | "fork";
}

export interface SkillParameter {
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  description?: string;
}

interface ResolveSkillSourceOptions {
  useDefault: boolean;
}

function toPosixPath(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function isInsideWorkspace(workspaceDir: string, candidatePath: string): boolean {
  const relative = path.relative(workspaceDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveSkillSources(
  workspaceDir: string,
  configuredPaths: string[],
  options: ResolveSkillSourceOptions = { useDefault: true },
): Promise<SkillSource[]> {
  let resolvedWorkspaceDir = workspaceDir;
  try {
    resolvedWorkspaceDir = await realpath(workspaceDir);
  } catch {
    resolvedWorkspaceDir = workspaceDir;
  }
  const candidates =
    configuredPaths.length > 0
      ? configuredPaths
      : options.useDefault
        ? [".deepagents/skills"]
        : [];
  const resolvedSources: SkillSource[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }

    const absoluteCandidate = path.resolve(workspaceDir, trimmed);
    let resolvedPath: string;
    try {
      const info = await stat(absoluteCandidate);
      if (!info.isDirectory()) {
        continue;
      }
      resolvedPath = await realpath(absoluteCandidate);
    } catch {
      continue;
    }

    if (!isInsideWorkspace(resolvedWorkspaceDir, resolvedPath)) {
      throw new Error(
        `Skill source ${resolvedPath} must be inside workspace ${resolvedWorkspaceDir}.`,
      );
    }

    if (seen.has(resolvedPath)) {
      continue;
    }
    seen.add(resolvedPath);

    const relative = path.relative(resolvedWorkspaceDir, resolvedPath);
    resolvedSources.push({
      absolutePath: resolvedPath,
      backendPath: toPosixPath(relative),
    });
  }

  return resolvedSources;
}

export async function listSkillsFromSources(
  sources: SkillSource[],
): Promise<SkillMetadata[]> {
  const merged = new Map<string, SkillMetadata>();

  for (const source of sources) {
    let entries;
    try {
      entries = await readdir(source.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillMdPath = path.join(source.absolutePath, entry.name, "SKILL.md");
      const metadata = parseSkillMetadata(skillMdPath, "project");
      if (metadata) {
        // Extract extended v2 fields from metadata map
        const meta = metadata.metadata ?? {};
        merged.set(metadata.name, {
          name: metadata.name,
          description: metadata.description,
          path: metadata.path,
          sourcePath: source.backendPath,
          license: metadata.license,
          compatibility: metadata.compatibility,
          metadata: metadata.metadata,
          allowedTools:
            typeof metadata.allowedTools === "string"
              ? metadata.allowedTools.split(/\s+/).filter(Boolean)
              : undefined,
          // v2 extended fields — read from metadata map (deepagents passes
          // unrecognised frontmatter keys through the metadata bag)
          version: meta.version,
          author: meta.author,
          tags: meta.tags ? String(meta.tags).split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          requiresTools: meta.requires_tools
            ? String(meta.requires_tools).split(",").map((t) => t.trim()).filter(Boolean)
            : undefined,
          executionMode:
            meta.execution_mode === "fork" ? "fork" : meta.execution_mode === "inline" ? "inline" : undefined,
        });
      }
    }
  }

  return Array.from(merged.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

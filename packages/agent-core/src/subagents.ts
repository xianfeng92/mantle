import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { SubAgent } from "deepagents";

import { resolveSkillSources } from "./skills.js";

export interface SubagentSource {
  absolutePath: string;
  backendPath: string;
}

export interface SubagentMetadata {
  name: string;
  description: string;
  path: string;
  sourcePath: string;
  model?: string;
  skills?: string[];
}

export interface LoadedSubagent {
  definition: SubAgent;
  metadata: SubagentMetadata;
}

interface ResolveSourceOptions {
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

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }
  return inner
    .split(",")
    .map((item) => stripQuotes(item))
    .filter(Boolean);
}

function parseFrontmatter(
  raw: string,
  filePath: string,
): {
  attributes: Record<string, string | string[]>;
  body: string;
} {
  const normalized = raw.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {
      attributes: {},
      body: normalized.trim(),
    };
  }

  const closingMarker = "\n---\n";
  const closingIndex = normalized.indexOf(closingMarker, 4);
  if (closingIndex === -1) {
    throw new Error(`Subagent file ${filePath} has unterminated frontmatter.`);
  }

  const header = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + closingMarker.length).trim();
  const attributes: Record<string, string | string[]> = {};
  let currentArrayKey: string | null = null;

  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      const currentValues = currentArrayKey ? attributes[currentArrayKey] : undefined;
      if (!currentArrayKey || !Array.isArray(currentValues)) {
        throw new Error(`Subagent file ${filePath} has an array item without a key.`);
      }
      currentValues.push(stripQuotes(trimmed.slice(2)));
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`Subagent file ${filePath} has invalid frontmatter line: ${trimmed}`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    currentArrayKey = null;

    if (!rawValue) {
      attributes[key] = [];
      currentArrayKey = key;
      continue;
    }

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      attributes[key] = parseInlineList(rawValue);
      continue;
    }

    attributes[key] = stripQuotes(rawValue);
  }

  return {
    attributes,
    body,
  };
}

async function resolveWorkspaceSources(
  workspaceDir: string,
  configuredPaths: string[],
  defaultPaths: string[],
  options: ResolveSourceOptions,
): Promise<Array<{ absolutePath: string; backendPath: string }>> {
  let resolvedWorkspaceDir = workspaceDir;
  try {
    resolvedWorkspaceDir = await realpath(workspaceDir);
  } catch {
    resolvedWorkspaceDir = workspaceDir;
  }

  const candidates =
    configuredPaths.length > 0 ? configuredPaths : options.useDefault ? defaultPaths : [];
  const resolvedSources: Array<{ absolutePath: string; backendPath: string }> = [];
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
        `Source ${resolvedPath} must be inside workspace ${resolvedWorkspaceDir}.`,
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

export async function resolveSubagentSources(
  workspaceDir: string,
  configuredPaths: string[],
): Promise<SubagentSource[]> {
  return resolveWorkspaceSources(
    workspaceDir,
    configuredPaths,
    [".deepagents/subagents"],
    { useDefault: true },
  );
}

export async function loadSubagentsFromSources(
  workspaceDir: string,
  sources: SubagentSource[],
): Promise<LoadedSubagent[]> {
  const merged = new Map<string, LoadedSubagent>();

  for (const source of sources) {
    let entries;
    try {
      entries = await readdir(source.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name) !== ".md") {
        continue;
      }

      const absolutePath = path.join(source.absolutePath, entry.name);
      const raw = await readFile(absolutePath, "utf8");
      const parsed = parseFrontmatter(raw, absolutePath);
      const defaultName = path.basename(entry.name, path.extname(entry.name));
      const rawName = parsed.attributes.name;
      const rawDescription = parsed.attributes.description;
      const rawModel = parsed.attributes.model;
      const rawSkills = parsed.attributes.skills;
      const name =
        typeof rawName === "string" && rawName.trim() ? rawName.trim() : defaultName;

      if (typeof rawDescription !== "string" || !rawDescription.trim()) {
        throw new Error(`Subagent ${absolutePath} must define a non-empty description.`);
      }
      if (!parsed.body) {
        throw new Error(`Subagent ${absolutePath} must include a non-empty system prompt body.`);
      }
      if (rawModel != null && typeof rawModel !== "string") {
        throw new Error(`Subagent ${absolutePath} has an invalid model field.`);
      }

      const configuredSkillPaths =
        typeof rawSkills === "string"
          ? [rawSkills]
          : Array.isArray(rawSkills)
            ? rawSkills
            : [];
      const resolvedSkillSources =
        configuredSkillPaths.length > 0
          ? await resolveSkillSources(workspaceDir, configuredSkillPaths, {
              useDefault: false,
            })
          : [];
      const skillBackendPaths = resolvedSkillSources.map((skillSource) => skillSource.backendPath);

      merged.set(name, {
        definition: {
          name,
          description: rawDescription.trim(),
          systemPrompt: parsed.body,
          ...(typeof rawModel === "string" && rawModel.trim()
            ? { model: rawModel.trim() }
            : {}),
          ...(skillBackendPaths.length > 0 ? { skills: skillBackendPaths } : {}),
        },
        metadata: {
          name,
          description: rawDescription.trim(),
          path: absolutePath,
          sourcePath: source.backendPath,
          ...(typeof rawModel === "string" && rawModel.trim()
            ? { model: rawModel.trim() }
            : {}),
          ...(skillBackendPaths.length > 0 ? { skills: skillBackendPaths } : {}),
        },
      });
    }
  }

  return Array.from(merged.values()).sort((left, right) =>
    left.metadata.name.localeCompare(right.metadata.name),
  );
}

export async function listSubagentsFromSources(
  workspaceDir: string,
  sources: SubagentSource[],
): Promise<SubagentMetadata[]> {
  const loaded = await loadSubagentsFromSources(workspaceDir, sources);
  return loaded.map((subagent) => subagent.metadata);
}

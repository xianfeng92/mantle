import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import type { HeartbeatTaskDef, HeartbeatHandlerKind } from "./types.js";

// MARK: HEARTBEAT.md parser
//
// Expects a YAML frontmatter block delimited by --- lines at the very top,
// containing a `tasks:` array. Everything after the closing --- is free-form
// markdown (ignored by the runtime). See the spec for field semantics.

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const VALID_HANDLERS: readonly HeartbeatHandlerKind[] = ["agent-run"];

export interface ParseResult {
  tasks: HeartbeatTaskDef[];
  errors: string[];
}

export async function readHeartbeatFile(filePath: string): Promise<ParseResult> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return parseHeartbeatFile(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { tasks: [], errors: [] };
    }
    return { tasks: [], errors: [`Failed to read ${filePath}: ${String(err)}`] };
  }
}

export function parseHeartbeatFile(raw: string): ParseResult {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { tasks: [], errors: ["No YAML frontmatter block found"] };
  }

  let doc: unknown;
  try {
    doc = parseYaml(match[1]!);
  } catch (err) {
    return { tasks: [], errors: [`YAML parse failed: ${String(err)}`] };
  }

  if (!doc || typeof doc !== "object") {
    return { tasks: [], errors: ["Frontmatter did not parse to an object"] };
  }

  const rawTasks = (doc as { tasks?: unknown }).tasks;
  if (!Array.isArray(rawTasks)) {
    return { tasks: [], errors: ["`tasks` must be an array"] };
  }

  const tasks: HeartbeatTaskDef[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const [index, entry] of rawTasks.entries()) {
    const result = validateTask(entry, index, seenIds);
    if (result.task) {
      tasks.push(result.task);
      seenIds.add(result.task.id);
    }
    errors.push(...result.errors);
  }

  return { tasks, errors };
}

function validateTask(
  raw: unknown,
  index: number,
  seenIds: Set<string>,
): { task?: HeartbeatTaskDef; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { errors: [`tasks[${index}]: not an object`] };
  }
  const obj = raw as Record<string, unknown>;

  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  if (!id) {
    errors.push(`tasks[${index}]: missing required string \`id\``);
  } else if (seenIds.has(id)) {
    errors.push(`tasks[${index}]: duplicate id "${id}"`);
  }

  const schedule = typeof obj.schedule === "string" ? obj.schedule.trim() : "";
  if (!schedule) {
    errors.push(`tasks[${index}]: missing required string \`schedule\``);
  }

  const handler = typeof obj.handler === "string" ? obj.handler.trim() : "";
  if (!VALID_HANDLERS.includes(handler as HeartbeatHandlerKind)) {
    errors.push(
      `tasks[${index}]: handler must be one of ${VALID_HANDLERS.join(", ")}`,
    );
  }

  if (handler === "agent-run") {
    const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
    if (!prompt.trim()) {
      errors.push(`tasks[${index}]: handler=agent-run requires a non-empty \`prompt\``);
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  const announce = parseAnnounce(obj.announce);
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string")
    : undefined;

  const task: HeartbeatTaskDef = {
    id,
    schedule,
    handler: handler as HeartbeatHandlerKind,
    prompt: typeof obj.prompt === "string" ? obj.prompt : undefined,
    announce,
    tags,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
  };
  return { task, errors: [] };
}

function parseAnnounce(raw: unknown): HeartbeatTaskDef["announce"] {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const channels = Array.isArray(obj.channels)
    ? obj.channels.filter((c): c is string => typeof c === "string")
    : [];
  if (channels.length === 0) return undefined;
  const urgencyRaw = obj.urgency;
  const urgency: "low" | "normal" | "high" | undefined =
    urgencyRaw === "low" || urgencyRaw === "normal" || urgencyRaw === "high"
      ? urgencyRaw
      : undefined;
  return urgency ? { channels, urgency } : { channels };
}

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createMiddleware } from "langchain";

import { createLogger } from "./logger.js";
import { recordMove } from "./move-tracker.js";

const log = createLogger("audit");

/**
 * Audit log middleware — records all file-mutating tool calls to a JSONL file.
 * Also detects `mv` commands inside `execute` tool calls and records them
 * for the 7-day rollback feature.
 */

const AUDITED_TOOLS = new Set(["write_file", "edit_file", "execute"]);

export interface AuditLogEntry {
  timestamp: string;
  operation: string;
  threadId?: string;
  args: Record<string, unknown>;
  moves?: Array<{ source: string; dest: string }>;
}

function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function toAbsolutePath(filePath: string, workspaceDir: string): string {
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceDir, filePath);
}

function toRecordedPath(
  absolutePath: string,
  originalPath: string,
  workspaceDir: string,
): string {
  if (path.isAbsolute(originalPath)) {
    return absolutePath;
  }

  const relativePath = path.relative(workspaceDir, absolutePath);
  return relativePath.length > 0 ? relativePath : ".";
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export async function resolveRecordedMovePaths(
  move: { source: string; dest: string },
  workspaceDir: string,
): Promise<{ sourcePath: string; destPath: string }> {
  const sourceInput = stripTrailingSeparators(move.source);
  const destInput = move.dest;
  const sourceAbsPath = toAbsolutePath(sourceInput, workspaceDir);
  const destAbsCandidate = toAbsolutePath(destInput, workspaceDir);
  const destLooksLikeDirectory =
    /[\\/]$/.test(destInput) || await isDirectory(destAbsCandidate);
  const finalDestAbsPath = destLooksLikeDirectory
    ? path.join(destAbsCandidate, path.basename(sourceInput))
    : destAbsCandidate;

  return {
    sourcePath: toRecordedPath(sourceAbsPath, move.source, workspaceDir),
    destPath: toRecordedPath(finalDestAbsPath, move.dest, workspaceDir),
  };
}

/**
 * Parse `mv source dest` commands from a shell command string.
 * Handles quoted paths, chained commands (&&, ;), and multi-source moves.
 */
export function parseMvCommands(
  command: string,
): Array<{ source: string; dest: string }> {
  const results: Array<{ source: string; dest: string }> = [];

  // Split on && and ; to handle chained commands
  const parts = command.split(/\s*(?:&&|;)\s*/);

  for (const part of parts) {
    const tokens = Array.from(
      part.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g),
      (match) => match[1] ?? match[2] ?? match[3] ?? "",
    ).filter(Boolean);

    if (tokens[0] !== "mv") {
      continue;
    }

    let index = 1;
    while (tokens[index]?.startsWith("-")) {
      index += 1;
    }

    const args = tokens.slice(index);
    if (args.length < 2) {
      continue;
    }

    const dest = args.at(-1) ?? "";
    const sources = args.slice(0, -1);
    for (const source of sources) {
      if (source && dest) {
        results.push({ source, dest });
      }
    }
  }

  return results;
}

export function createAuditLogMiddleware(options: {
  auditLogPath: string;
  movesLogPath: string;
  workspaceDir: string;
}) {
  const { auditLogPath, movesLogPath, workspaceDir } = options;
  let dirEnsured = false;

  return createMiddleware({
    name: "auditLogMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall?.name;

      // Execute the tool first
      const result = await handler(request);

      // Only log audited tools
      if (!toolName || !AUDITED_TOOLS.has(toolName)) {
        return result;
      }

      const args = (request.toolCall.args ?? {}) as Record<string, unknown>;
      // Best-effort extraction of threadId from LangGraph config
      let threadId: string | undefined;
      try {
        const req = request as unknown as Record<string, unknown>;
        const config = req.config as Record<string, unknown> | undefined;
        const configurable = config?.configurable as Record<string, unknown> | undefined;
        threadId = configurable?.thread_id as string | undefined;
      } catch {
        // threadId remains undefined
      }

      // Parse mv commands for rollback tracking
      let moves: Array<{ source: string; dest: string }> | undefined;
      if (toolName === "execute") {
        const command = String(args.command ?? "");
        const parsed = parseMvCommands(command);
        if (parsed.length > 0) {
          const resolvedMoves = await Promise.all(
            parsed.map((move) => resolveRecordedMovePaths(move, workspaceDir)),
          );
          moves = resolvedMoves.map((move) => ({
            source: move.sourcePath,
            dest: move.destPath,
          }));
          // Record each move for rollback
          for (const mv of resolvedMoves) {
            await recordMove(
              {
                timestamp: new Date().toISOString(),
                threadId,
                sourcePath: mv.sourcePath,
                destPath: mv.destPath,
              },
              movesLogPath,
            );
          }
        }
      }

      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        operation: toolName,
        threadId,
        args,
        ...(moves ? { moves } : {}),
      };

      try {
        if (!dirEnsured) {
          await mkdir(path.dirname(auditLogPath), { recursive: true });
          dirEnsured = true;
        }
        await appendFile(auditLogPath, JSON.stringify(entry) + "\n");
        log.debug("recorded", { tool: toolName, threadId, moves: moves?.length });
      } catch (err) {
        log.warn("write.failed", { error: err instanceof Error ? err.message : String(err) });
      }

      return result;
    },
  });
}

/**
 * Read the last N entries from the audit log.
 */
export async function readAuditLog(
  auditLogPath: string,
  limit = 50,
): Promise<AuditLogEntry[]> {
  try {
    const content = await readFile(auditLogPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditLogEntry)
      .reverse();
  } catch {
    return [];
  }
}

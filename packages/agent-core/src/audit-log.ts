import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { createMiddleware } from "langchain";

import { createLogger } from "./logger.js";
import { recordMove, type MoveRecord } from "./move-tracker.js";
import { RunSnapshotsStore } from "./run-snapshots.js";

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
  traceId?: string;
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
  runSnapshots?: RunSnapshotsStore;
}) {
  const { auditLogPath, movesLogPath, workspaceDir, runSnapshots } = options;
  let dirEnsured = false;

  function resolveFileToolPath(args: Record<string, unknown>): string | null {
    const candidate = typeof args.path === "string"
      ? args.path
      : typeof args.file_path === "string"
        ? args.file_path
        : null;
    return candidate && candidate.trim() ? candidate.trim() : null;
  }

  function summarizeAction(
    toolName: string,
    args: Record<string, unknown>,
    moves?: Array<{ source: string; dest: string }>,
  ): string {
    if (toolName === "write_file" || toolName === "edit_file") {
      const targetPath = resolveFileToolPath(args);
      const verb = toolName === "write_file" ? "Write" : "Edit";
      return targetPath ? `${verb} ${targetPath}` : `${verb} file`;
    }
    if (toolName === "execute") {
      if (moves?.length) {
        return moves.length === 1
          ? `Move ${moves[0]?.source ?? "file"} -> ${moves[0]?.dest ?? "destination"}`
          : `Move ${moves.length} files`;
      }
      const command = typeof args.command === "string" ? args.command.trim() : "";
      return command ? `Execute ${command}` : "Execute shell command";
    }
    return toolName;
  }

  return createMiddleware({
    name: "auditLogMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolName = request.toolCall?.name;
      const args = (request.toolCall.args ?? {}) as Record<string, unknown>;
      let threadId: string | undefined;
      let traceId: string | undefined;
      try {
        const req = request as unknown as Record<string, unknown>;
        const config = req.config as Record<string, unknown> | undefined;
        const configurable = config?.configurable as Record<string, unknown> | undefined;
        threadId = configurable?.thread_id as string | undefined;
        traceId = configurable?.trace_id as string | undefined;
      } catch {
        // Best-effort only.
      }

      let resolvedMoves: Array<{ sourcePath: string; destPath: string }> = [];
      let recordedMoves: MoveRecord[] = [];
      const touchedPaths: string[] = [];
      const moveRoles: Record<string, "source" | "dest"> = {};
      if (toolName === "execute") {
        const command = typeof args.command === "string" ? args.command : "";
        const parsedMoves = parseMvCommands(command);
        if (parsedMoves.length > 0) {
          resolvedMoves = await Promise.all(
            parsedMoves.map((move) => resolveRecordedMovePaths(move, workspaceDir)),
          );
          for (const move of resolvedMoves) {
            touchedPaths.push(move.sourcePath, move.destPath);
            moveRoles[move.sourcePath] = "source";
            moveRoles[move.destPath] = "dest";
          }
        }
      } else if (toolName === "write_file" || toolName === "edit_file") {
        const targetPath = resolveFileToolPath(args);
        if (targetPath) {
          touchedPaths.push(targetPath);
        }
      }

      if (traceId && threadId && runSnapshots && touchedPaths.length > 0) {
        await runSnapshots.beginAction({
          traceId,
          threadId,
          toolName: toolName ?? "unknown",
          touchedPaths,
          moveRoles,
        });
      }

      let result!: Awaited<ReturnType<typeof handler>>;
      let toolError: unknown;
      try {
        result = await handler(request);
      } catch (error) {
        toolError = error;
      }

      // Only log audited tools
      if (!toolName || !AUDITED_TOOLS.has(toolName)) {
        if (toolError) {
          throw toolError;
        }
        return result;
      }

      let moves: Array<{ source: string; dest: string }> | undefined;
      if (!toolError && toolName === "execute" && resolvedMoves.length > 0) {
        moves = resolvedMoves.map((move) => ({
          source: move.sourcePath,
          dest: move.destPath,
        }));
        recordedMoves = [];
        for (const move of resolvedMoves) {
          recordedMoves.push(
            await recordMove(
              {
                timestamp: new Date().toISOString(),
                threadId,
                sourcePath: move.sourcePath,
                destPath: move.destPath,
              },
              movesLogPath,
            ),
          );
        }
      }

      if (traceId && threadId && runSnapshots && touchedPaths.length > 0) {
        await runSnapshots.completeAction({
          traceId,
          threadId,
          toolName,
          touchedPaths,
          status: toolError ? "failed" : "completed",
          summary: summarizeAction(toolName, args, moves),
          moveIds: recordedMoves.map((move) => move.id),
          error: toolError instanceof Error ? toolError.message : toolError ? String(toolError) : undefined,
        });
      }

      if (!toolError) {
        const entry: AuditLogEntry = {
          timestamp: new Date().toISOString(),
          operation: toolName,
          threadId,
          traceId,
          args,
          ...(moves ? { moves } : {}),
        };

        try {
          if (!dirEnsured) {
            await mkdir(path.dirname(auditLogPath), { recursive: true });
            dirEnsured = true;
          }
          await appendFile(auditLogPath, JSON.stringify(entry) + "\n");
          log.debug("recorded", { tool: toolName, threadId, traceId, moves: moves?.length });
        } catch (err) {
          log.warn("write.failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (toolError) {
        throw toolError;
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

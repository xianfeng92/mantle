import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Move tracker — records file move operations and supports 7-day rollback.
 * Data is stored in a JSONL file (one entry per line).
 */

export interface MoveRecord {
  id: string;
  timestamp: string;
  threadId?: string;
  sourcePath: string;
  destPath: string;
  rolledBack?: boolean;
}

function resolveTrackedPath(filePath: string, workspaceDir?: string): string {
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  if (workspaceDir) {
    return path.resolve(workspaceDir, filePath);
  }
  return path.resolve(filePath);
}

/**
 * Record a file move operation.
 */
export async function recordMove(
  entry: Omit<MoveRecord, "id">,
  movesLogPath: string,
): Promise<void> {
  const record: MoveRecord = { id: randomUUID(), ...entry };
  try {
    await mkdir(path.dirname(movesLogPath), { recursive: true });
    await appendFile(movesLogPath, JSON.stringify(record) + "\n");
  } catch {
    // Non-critical — don't break the main flow
  }
}

/**
 * List recorded moves, optionally filtered by age.
 */
export async function listMoves(
  movesLogPath: string,
  options?: { maxAgeDays?: number },
): Promise<MoveRecord[]> {
  try {
    const content = await readFile(movesLogPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    let records = lines.map((line) => JSON.parse(line) as MoveRecord);

    if (options?.maxAgeDays) {
      const cutoff = Date.now() - options.maxAgeDays * 24 * 60 * 60 * 1000;
      records = records.filter(
        (r) => new Date(r.timestamp).getTime() >= cutoff,
      );
    }

    return records.reverse(); // Newest first
  } catch {
    return [];
  }
}

/**
 * Rollback a specific move by ID.
 * Moves the file from destPath back to sourcePath.
 */
export async function rollbackMove(
  moveId: string,
  movesLogPath: string,
  workspaceDir?: string,
): Promise<{ success: boolean; error?: string }> {
  const allMoves = await listMoves(movesLogPath);
  const record = allMoves.find((r) => r.id === moveId);

  if (!record) {
    return { success: false, error: `Move record not found: ${moveId}` };
  }

  if (record.rolledBack) {
    return { success: false, error: "This move has already been rolled back" };
  }

  // Check age — only allow rollback within 7 days
  const ageMs = Date.now() - new Date(record.timestamp).getTime();
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    return { success: false, error: "Move is older than 7 days — rollback expired" };
  }

  try {
    const sourcePath = resolveTrackedPath(record.sourcePath, workspaceDir);
    const destPath = resolveTrackedPath(record.destPath, workspaceDir);

    // Ensure the source directory exists
    const sourceDir = path.dirname(sourcePath);
    await mkdir(sourceDir, { recursive: true });

    // Move the file back
    execFileSync("mv", [destPath, sourcePath]);

    // Mark as rolled back in the log
    await markRolledBack(moveId, movesLogPath);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Rollback failed: ${message}` };
  }
}

/**
 * Mark a move record as rolled back (rewrite the JSONL line).
 */
async function markRolledBack(
  moveId: string,
  movesLogPath: string,
): Promise<void> {
  try {
    const content = await readFile(movesLogPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const updated = lines.map((line) => {
      const record = JSON.parse(line) as MoveRecord;
      if (record.id === moveId) {
        record.rolledBack = true;
        return JSON.stringify(record);
      }
      return line;
    });
    await writeFile(movesLogPath, updated.join("\n") + "\n");
  } catch {
    // Best-effort
  }
}

/**
 * Remove entries older than maxAgeDays. Returns count of removed entries.
 */
export async function cleanupOldMoves(
  movesLogPath: string,
  maxAgeDays = 7,
): Promise<number> {
  try {
    const content = await readFile(movesLogPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const kept: string[] = [];
    let removed = 0;

    for (const line of lines) {
      const record = JSON.parse(line) as MoveRecord;
      if (new Date(record.timestamp).getTime() >= cutoff) {
        kept.push(line);
      } else {
        removed++;
      }
    }

    if (removed > 0) {
      await writeFile(movesLogPath, kept.join("\n") + (kept.length > 0 ? "\n" : ""));
    }

    return removed;
  } catch {
    return 0;
  }
}

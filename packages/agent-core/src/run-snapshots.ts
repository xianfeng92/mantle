import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { createLogger } from "./logger.js";

const log = createLogger("run-snapshots");

const PREVIEW_MAX_BYTES = 64 * 1024;
const PREVIEW_MAX_CHARS = 1600;

export type RunSnapshotMode = "run" | "resume";
export type RunSnapshotStatus = "running" | "completed" | "interrupted" | "failed";
export type RunSnapshotActionStatus = "completed" | "failed";
export type RunSnapshotChangeType =
  | "created"
  | "updated"
  | "deleted"
  | "moved_in"
  | "moved_out"
  | "unchanged";
export type RunSnapshotMoveRole = "source" | "dest";

export interface RunSnapshotFileVersion {
  exists: boolean;
  blobPath?: string;
  size?: number;
  modifiedAt?: string;
  sha256?: string;
  preview?: string;
  binary?: boolean;
  truncated?: boolean;
  captureError?: string;
}

export interface RunSnapshotFileRecord {
  path: string;
  changeType: RunSnapshotChangeType;
  moveRole?: RunSnapshotMoveRole;
  before: RunSnapshotFileVersion;
  after: RunSnapshotFileVersion;
  restorable: boolean;
}

export interface RunSnapshotActionRecord {
  id: string;
  timestamp: string;
  toolName: string;
  status: RunSnapshotActionStatus;
  summary: string;
  touchedPaths: string[];
  moveIds?: string[];
  error?: string;
}

export interface RunSnapshotSummary {
  changedFiles: number;
  createdFiles: number;
  updatedFiles: number;
  deletedFiles: number;
  movedFiles: number;
  restorableFiles: number;
}

export interface RunSnapshotRestoreHistoryEntry {
  timestamp: string;
  dryRun: boolean;
  restoredFiles: number;
  conflicts: number;
}

export interface RunSnapshotRecord {
  traceId: string;
  threadId: string;
  mode: RunSnapshotMode;
  status: RunSnapshotStatus;
  startedAt: string;
  completedAt?: string;
  inputPreview?: string;
  actions: RunSnapshotActionRecord[];
  files: RunSnapshotFileRecord[];
  summary: RunSnapshotSummary;
  restoreHistory?: RunSnapshotRestoreHistoryEntry[];
}

export interface RunSnapshotListOptions {
  limit?: number;
  threadId?: string;
}

export interface BeginRunSnapshotActionOptions {
  traceId: string;
  threadId: string;
  toolName: string;
  touchedPaths: string[];
  moveRoles?: Record<string, RunSnapshotMoveRole>;
}

export interface CompleteRunSnapshotActionOptions {
  traceId: string;
  threadId: string;
  toolName: string;
  touchedPaths: string[];
  status: RunSnapshotActionStatus;
  summary: string;
  moveIds?: string[];
  error?: string;
}

export interface RestoreRunSnapshotOptions {
  dryRun?: boolean;
  paths?: string[];
}

export interface RunSnapshotRestoreResultEntry {
  path: string;
  action: "restore" | "delete" | "skip";
  ok: boolean;
  conflict: boolean;
  reason?: string;
}

export interface RunSnapshotRestoreResult {
  ok: boolean;
  dryRun: boolean;
  traceId: string;
  summary: RunSnapshotSummary;
  conflicts: string[];
  results: RunSnapshotRestoreResultEntry[];
  restoredAt: string;
}

interface InternalRunSnapshotFileRecord {
  path: string;
  moveRole?: RunSnapshotMoveRole;
  before: RunSnapshotFileVersion;
  after: RunSnapshotFileVersion;
}

interface ActiveRunSnapshotState {
  traceId: string;
  record: RunSnapshotRecord;
  files: Map<string, InternalRunSnapshotFileRecord>;
}

function blobIdFor(traceId: string, recordedPath: string, phase: "before" | "after"): string {
  return createHash("sha1")
    .update(`${traceId}:${phase}:${recordedPath}`)
    .digest("hex");
}

function normalizeRecordedPath(filePath: string, workspaceDir: string): string {
  const absolutePath = resolveTrackedPath(filePath, workspaceDir);
  const relative = path.relative(workspaceDir, absolutePath);
  if (relative === "") {
    return ".";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return absolutePath;
}

export function resolveTrackedPath(recordedPath: string, workspaceDir: string): string {
  if (path.isAbsolute(recordedPath)) {
    return path.resolve(recordedPath);
  }
  return path.resolve(workspaceDir, recordedPath);
}

function truncateText(value: string, maxChars = PREVIEW_MAX_CHARS): { preview: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { preview: value, truncated: false };
  }
  return {
    preview: `${value.slice(0, maxChars)}\n...[truncated]`,
    truncated: true,
  };
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function readTextPreview(filePath: string, size: number): Promise<{
  preview?: string;
  binary?: boolean;
  truncated?: boolean;
}> {
  if (size > PREVIEW_MAX_BYTES) {
    return { truncated: true };
  }

  const buffer = await readFile(filePath);
  if (isBinaryBuffer(buffer)) {
    return { binary: true };
  }

  const text = buffer.toString("utf8");
  return truncateText(text);
}

function sameFileVersions(left: RunSnapshotFileVersion, right: RunSnapshotFileVersion): boolean {
  if (left.exists !== right.exists) {
    return false;
  }
  if (!left.exists && !right.exists) {
    return true;
  }
  if (left.sha256 && right.sha256) {
    return left.sha256 === right.sha256;
  }
  return (
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.captureError === right.captureError
  );
}

function classifyChange(file: InternalRunSnapshotFileRecord): RunSnapshotChangeType {
  if (!file.before.exists && file.after.exists) {
    return file.moveRole === "dest" ? "moved_in" : "created";
  }
  if (file.before.exists && !file.after.exists) {
    return file.moveRole === "source" ? "moved_out" : "deleted";
  }
  if (!sameFileVersions(file.before, file.after)) {
    return "updated";
  }
  return "unchanged";
}

function toPublicFileRecord(file: InternalRunSnapshotFileRecord): RunSnapshotFileRecord {
  const changeType = classifyChange(file);
  const restorable = !file.before.exists || Boolean(file.before.blobPath);
  return {
    path: file.path,
    changeType,
    moveRole: file.moveRole,
    before: file.before,
    after: file.after,
    restorable,
  };
}

function summarizeFiles(files: InternalRunSnapshotFileRecord[]): RunSnapshotSummary {
  const publicFiles = files.map(toPublicFileRecord);
  return {
    changedFiles: publicFiles.filter((file) => file.changeType !== "unchanged").length,
    createdFiles: publicFiles.filter((file) => file.changeType === "created").length,
    updatedFiles: publicFiles.filter((file) => file.changeType === "updated").length,
    deletedFiles: publicFiles.filter((file) => file.changeType === "deleted").length,
    movedFiles: publicFiles.filter(
      (file) => file.changeType === "moved_in" || file.changeType === "moved_out",
    ).length,
    restorableFiles: publicFiles.filter(
      (file) => file.changeType !== "unchanged" && file.restorable,
    ).length,
  };
}

export class RunSnapshotsStore {
  private readonly rootDir: string;
  private readonly recordsDir: string;
  private readonly blobsDir: string;
  private readonly workspaceDir: string;
  private readonly activeRuns = new Map<string, ActiveRunSnapshotState>();

  constructor(rootDir: string, workspaceDir: string) {
    this.rootDir = rootDir;
    this.recordsDir = path.join(rootDir, "records");
    this.blobsDir = path.join(rootDir, "blobs");
    this.workspaceDir = workspaceDir;
  }

  async startRun(options: {
    traceId: string;
    threadId: string;
    mode: RunSnapshotMode;
    inputPreview?: string;
  }): Promise<void> {
    const record: RunSnapshotRecord = {
      traceId: options.traceId,
      threadId: options.threadId,
      mode: options.mode,
      status: "running",
      startedAt: new Date().toISOString(),
      ...(options.inputPreview ? { inputPreview: options.inputPreview } : {}),
      actions: [],
      files: [],
      summary: {
        changedFiles: 0,
        createdFiles: 0,
        updatedFiles: 0,
        deletedFiles: 0,
        movedFiles: 0,
        restorableFiles: 0,
      },
      restoreHistory: [],
    };

    const state: ActiveRunSnapshotState = {
      traceId: options.traceId,
      record,
      files: new Map(),
    };
    this.activeRuns.set(options.traceId, state);
    await this.persistState(state);
  }

  async beginAction(options: BeginRunSnapshotActionOptions): Promise<void> {
    const state = this.activeRuns.get(options.traceId);
    if (!state) {
      return;
    }

    const normalizedPaths = Array.from(
      new Set(
        options.touchedPaths
          .map((filePath) => filePath.trim())
          .filter(Boolean)
          .map((filePath) => normalizeRecordedPath(filePath, this.workspaceDir)),
      ),
    );

    for (const recordedPath of normalizedPaths) {
      const existing = state.files.get(recordedPath);
      if (existing) {
        if (options.moveRoles?.[recordedPath]) {
          existing.moveRole = options.moveRoles[recordedPath];
        }
        continue;
      }

      const before = await this.captureSnapshotVersion(options.traceId, recordedPath, "before");
      state.files.set(recordedPath, {
        path: recordedPath,
        moveRole: options.moveRoles?.[recordedPath],
        before,
        after: before,
      });
    }

    await this.persistState(state);
  }

  async completeAction(options: CompleteRunSnapshotActionOptions): Promise<void> {
    const state = this.activeRuns.get(options.traceId);
    if (!state) {
      return;
    }

    const normalizedPaths = Array.from(
      new Set(
        options.touchedPaths
          .map((filePath) => filePath.trim())
          .filter(Boolean)
          .map((filePath) => normalizeRecordedPath(filePath, this.workspaceDir)),
      ),
    );

    for (const recordedPath of normalizedPaths) {
      const existing = state.files.get(recordedPath);
      if (!existing) {
        continue;
      }
      existing.after = await this.captureSnapshotVersion(options.traceId, recordedPath, "after");
    }

    state.record.actions.push({
      id: `${options.toolName}-${state.record.actions.length + 1}`,
      timestamp: new Date().toISOString(),
      toolName: options.toolName,
      status: options.status,
      summary: options.summary,
      touchedPaths: normalizedPaths,
      ...(options.moveIds?.length ? { moveIds: options.moveIds } : {}),
      ...(options.error ? { error: options.error } : {}),
    });

    await this.persistState(state);
  }

  async finalizeRun(traceId: string, status: Exclude<RunSnapshotStatus, "running">): Promise<void> {
    const state = this.activeRuns.get(traceId);
    if (!state) {
      return;
    }

    state.record.status = status;
    state.record.completedAt = new Date().toISOString();
    await this.persistState(state);
    this.activeRuns.delete(traceId);
  }

  async listRuns(options: RunSnapshotListOptions = {}): Promise<RunSnapshotRecord[]> {
    const files = await this.listRecordFiles();
    const records: RunSnapshotRecord[] = [];
    for (const fileName of files) {
      const record = await this.readRecord(fileName);
      if (!record) {
        continue;
      }
      if (options.threadId && record.threadId !== options.threadId) {
        continue;
      }
      records.push(record);
    }

    records.sort((left, right) => {
      return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
    });

    if (typeof options.limit === "number" && options.limit >= 0) {
      return records.slice(0, options.limit);
    }
    return records;
  }

  async getRun(traceId: string): Promise<RunSnapshotRecord | null> {
    return this.readRecord(`${traceId}.json`);
  }

  async restoreRun(
    traceId: string,
    options: RestoreRunSnapshotOptions = {},
  ): Promise<RunSnapshotRestoreResult | null> {
    const record = await this.getRun(traceId);
    if (!record) {
      return null;
    }

    const selectedPaths = options.paths?.length
      ? new Set(options.paths.map((filePath) => normalizeRecordedPath(filePath, this.workspaceDir)))
      : null;
    const files = record.files.filter((file) => {
      if (file.changeType === "unchanged") {
        return false;
      }
      if (!selectedPaths) {
        return true;
      }
      return selectedPaths.has(file.path);
    });

    const results: RunSnapshotRestoreResultEntry[] = [];
    const conflicts: string[] = [];
    for (const file of files) {
      const current = await this.captureLiveVersion(file.path);
      if (!sameFileVersions(current, file.after)) {
        conflicts.push(file.path);
        results.push({
          path: file.path,
          action: "skip",
          ok: false,
          conflict: true,
          reason: "Current file state no longer matches the post-run snapshot.",
        });
        continue;
      }

      if (!file.before.exists) {
        results.push({
          path: file.path,
          action: "delete",
          ok: true,
          conflict: false,
        });
        continue;
      }

      if (!file.restorable || !file.before.blobPath) {
        results.push({
          path: file.path,
          action: "skip",
          ok: false,
          conflict: false,
          reason: "No restorable pre-run snapshot is available for this file.",
        });
        continue;
      }

      results.push({
        path: file.path,
        action: "restore",
        ok: true,
        conflict: false,
      });
    }

    const dryRun = options.dryRun !== false;
    const restoredAt = new Date().toISOString();
    if (!dryRun && conflicts.length === 0) {
      for (const result of results) {
        if (!result.ok || result.action === "skip") {
          continue;
        }

        const file = record.files.find((entry) => entry.path === result.path);
        if (!file) {
          result.ok = false;
          result.reason = "Snapshot file entry not found.";
          continue;
        }

        try {
          const absolutePath = resolveTrackedPath(file.path, this.workspaceDir);
          if (result.action === "delete") {
            await rm(absolutePath, { force: true });
            continue;
          }

          const blobPath = file.before.blobPath;
          if (!blobPath) {
            result.ok = false;
            result.reason = "Missing snapshot blob.";
            continue;
          }

          await mkdir(path.dirname(absolutePath), { recursive: true });
          await copyFile(path.join(this.rootDir, blobPath), absolutePath);
        } catch (error) {
          result.ok = false;
          result.reason = error instanceof Error ? error.message : String(error);
        }
      }

      record.restoreHistory = [
        ...(record.restoreHistory ?? []),
        {
          timestamp: restoredAt,
          dryRun: false,
          restoredFiles: results.filter((result) => result.ok && result.action !== "skip").length,
          conflicts: conflicts.length,
        },
      ];
      await this.writeRecord(record);
    }

    return {
      ok: conflicts.length === 0 && results.every((result) => result.ok),
      dryRun,
      traceId,
      summary: record.summary,
      conflicts,
      results,
      restoredAt,
    };
  }

  private async captureSnapshotVersion(
    traceId: string,
    recordedPath: string,
    phase: "before" | "after",
  ): Promise<RunSnapshotFileVersion> {
    const absolutePath = resolveTrackedPath(recordedPath, this.workspaceDir);
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        return {
          exists: true,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          captureError: "Path exists but is not a regular file.",
        };
      }

      const blobPath = path.posix.join(
        "blobs",
        traceId,
        `${blobIdFor(traceId, recordedPath, phase)}.bin`,
      );
      const absoluteBlobPath = path.join(this.rootDir, blobPath);
      await mkdir(path.dirname(absoluteBlobPath), { recursive: true });
      await copyFile(absolutePath, absoluteBlobPath);
      const sha256 = await sha256File(absolutePath);
      const preview = await readTextPreview(absolutePath, info.size);
      return {
        exists: true,
        blobPath,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        sha256,
        ...preview,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false };
      }
      return {
        exists: false,
        captureError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async captureLiveVersion(recordedPath: string): Promise<RunSnapshotFileVersion> {
    const absolutePath = resolveTrackedPath(recordedPath, this.workspaceDir);
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) {
        return {
          exists: true,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          captureError: "Path exists but is not a regular file.",
        };
      }
      const sha256 = await sha256File(absolutePath);
      return {
        exists: true,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        sha256,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false };
      }
      return {
        exists: false,
        captureError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async persistState(state: ActiveRunSnapshotState): Promise<void> {
    state.record.files = Array.from(state.files.values())
      .map(toPublicFileRecord)
      .sort((left, right) => left.path.localeCompare(right.path));
    state.record.summary = summarizeFiles(Array.from(state.files.values()));
    await this.writeRecord(state.record);
  }

  private async writeRecord(record: RunSnapshotRecord): Promise<void> {
    await mkdir(this.recordsDir, { recursive: true });
    const filePath = path.join(this.recordsDir, `${record.traceId}.json`);
    await writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
  }

  private async readRecord(fileName: string): Promise<RunSnapshotRecord | null> {
    try {
      const raw = await readFile(path.join(this.recordsDir, fileName), "utf8");
      return JSON.parse(raw) as RunSnapshotRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      log.warn("read.failed", {
        fileName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async listRecordFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.recordsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

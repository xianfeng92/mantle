import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createLogger } from "./logger.js";

const log = createLogger("returns");

/**
 * Returns Plane —— 后台/主动任务的持久化出口。
 *
 * 设计见 docs/specs/2026-04-16-returns-plane-spec.md。
 *
 * 语义上和 `channel.send()` 正交：channel 回信是"我现在回你一条"，
 * Returns Plane 是"这件事完成了，结果在这里，你有空来看"。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReturnAnnounce {
  channels: string[];
  urgency?: "low" | "normal" | "high";
}

export interface ReturnEntry {
  id: string;
  kind: string;
  title: string;
  summary?: string;
  payload: unknown;
  tags: string[];
  createdAt: string;
  source: {
    taskId?: string;
    traceId?: string;
  };
  announce?: ReturnAnnounce;
  ackedAt?: string;
}

export type ReturnDraft = Omit<ReturnEntry, "id" | "createdAt" | "ackedAt"> & {
  createdAt?: string;
};

// ---------------------------------------------------------------------------
// ReturnStore
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ENTRIES = 500;

export class ReturnStore {
  private readonly filePath: string;
  private readonly maxEntries: number;

  constructor(filePath: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
  }

  async list(
    options: {
      limit?: number;
      since?: string;
      unackedOnly?: boolean;
    } = {},
  ): Promise<ReturnEntry[]> {
    const all = await this.readAll();
    let filtered = all;
    if (options.since) {
      const sinceMs = Date.parse(options.since);
      if (Number.isFinite(sinceMs)) {
        filtered = filtered.filter(
          (entry) => Date.parse(entry.createdAt) > sinceMs,
        );
      }
    }
    if (options.unackedOnly) {
      filtered = filtered.filter((entry) => !entry.ackedAt);
    }
    // Return newest first.
    filtered = filtered.slice().reverse();
    if (typeof options.limit === "number" && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }
    return filtered;
  }

  async get(id: string): Promise<ReturnEntry | null> {
    const all = await this.readAll();
    return all.find((entry) => entry.id === id) ?? null;
  }

  async append(draft: ReturnDraft): Promise<ReturnEntry> {
    const record: ReturnEntry = {
      id: randomUUID(),
      createdAt: draft.createdAt ?? new Date().toISOString(),
      kind: draft.kind,
      title: draft.title,
      summary: draft.summary,
      payload: draft.payload,
      tags: draft.tags ?? [],
      source: draft.source ?? {},
      announce: draft.announce,
    };

    const existing = await this.readAll();
    if (existing.length >= this.maxEntries) {
      const trimmed = existing.slice(existing.length - this.maxEntries + 1);
      trimmed.push(record);
      await this.writeAll(trimmed);
      log.info("append.trimmed", {
        id: record.id,
        kind: record.kind,
        removed: existing.length - this.maxEntries + 1,
      });
    } else {
      await this.ensureDirectory();
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
      log.info("append.ok", { id: record.id, kind: record.kind });
    }
    return record;
  }

  async ack(id: string, ackedAt: string = new Date().toISOString()): Promise<ReturnEntry | null> {
    const all = await this.readAll();
    const index = all.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return null;
    }
    const updated: ReturnEntry = { ...all[index]!, ackedAt };
    all[index] = updated;
    await this.writeAll(all);
    log.info("ack.ok", { id });
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const all = await this.readAll();
    const next = all.filter((entry) => entry.id !== id);
    if (next.length === all.length) {
      return false;
    }
    await this.writeAll(next);
    log.info("delete.ok", { id });
    return true;
  }

  async clear(): Promise<number> {
    const all = await this.readAll();
    if (all.length === 0) return 0;
    await this.writeAll([]);
    log.info("clear.ok", { count: all.length });
    return all.length;
  }

  private async readAll(): Promise<ReturnEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as ReturnEntry];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      log.warn("read.failed", { error: String(error) });
      return [];
    }
  }

  private async writeAll(entries: ReturnEntry[]): Promise<void> {
    await this.ensureDirectory();
    const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.filePath, entries.length > 0 ? `${body}\n` : "", "utf-8");
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// ReturnDispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch layer on top of ReturnStore.
 *
 * `dispatch(draft)` persists the entry and then fan-outs `return.created`
 * to every subscriber. Subscribers are typically SSE handlers in http.ts.
 */
export class ReturnDispatcher {
  private readonly emitter = new EventEmitter();

  constructor(public readonly store: ReturnStore) {
    // Unbounded subscribers in practice is fine, but suppress the default
    // MaxListeners warning to avoid noise when multiple SSE clients connect.
    this.emitter.setMaxListeners(0);
  }

  async dispatch(draft: ReturnDraft): Promise<ReturnEntry> {
    const entry = await this.store.append(draft);
    this.emitter.emit("return.created", entry);
    return entry;
  }

  subscribe(listener: (entry: ReturnEntry) => void): () => void {
    this.emitter.on("return.created", listener);
    return () => this.emitter.off("return.created", listener);
  }
}

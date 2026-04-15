import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.js";

const log = createLogger("memory");

/**
 * Cross-session memory store.
 *
 * Memories persist across threads so the agent can recall user preferences,
 * project context and corrections from earlier conversations.
 * Data is stored in a JSONL file (one entry per line), consistent with
 * traces.jsonl / audit.jsonl / moves.jsonl.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryType = "user" | "project" | "correction";

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  source: {
    threadId: string;
    traceId: string;
    createdAt: string;
  };
  tags: string[];
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token estimate: CJK characters ≈ 2 tokens each,
 * ASCII characters ≈ 0.35 tokens each (roughly 1.3 tokens per word).
 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const ascii = text.length - cjk;
  return Math.ceil(cjk * 2 + ascii * 0.35);
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

/** Maximum number of memory entries kept on disk. */
const DEFAULT_MAX_ENTRIES = 200;

/** Priority order for injection: corrections first, then user, then project. */
const TYPE_PRIORITY: Record<MemoryType, number> = {
  correction: 0,
  user: 1,
  project: 2,
};

export class MemoryStore {
  private readonly filePath: string;
  private readonly maxEntries: number;

  constructor(filePath: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Load all entries from disk. Corrupted lines are silently skipped. */
  async list(): Promise<MemoryEntry[]> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as MemoryEntry];
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

  /** Get a single entry by id. */
  async get(id: string): Promise<MemoryEntry | null> {
    const all = await this.list();
    return all.find((m) => m.id === id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Add a new memory entry. Returns the created entry.
   * Deduplicates by exact content match and enforces maxEntries (FIFO).
   */
  async add(
    entry: Omit<MemoryEntry, "id">,
  ): Promise<MemoryEntry> {
    const existing = await this.list();

    // Deduplicate — skip if exact content already exists
    const duplicate = existing.find((m) => m.content === entry.content);
    if (duplicate) {
      log.debug("add.duplicate", { content: entry.content.slice(0, 60) });
      return duplicate;
    }

    const record: MemoryEntry = { id: randomUUID(), ...entry };

    // Enforce capacity — trim oldest entries if needed.
    // We need room for +1 entry, so if at max we remove the oldest.
    if (existing.length >= this.maxEntries) {
      const trimmed = existing.slice(existing.length - this.maxEntries + 1);
      trimmed.push(record);
      await this.writeAll(trimmed);
      log.info("add.trimmed", {
        id: record.id,
        type: record.type,
        removed: existing.length - this.maxEntries + 1,
      });
    } else {
      await this.append(record);
      log.info("add.ok", { id: record.id, type: record.type });
    }

    return record;
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  /** Delete a single entry by id. Returns true if found and removed. */
  async delete(id: string): Promise<boolean> {
    const all = await this.list();
    const filtered = all.filter((m) => m.id !== id);
    if (filtered.length === all.length) {
      return false;
    }
    await this.writeAll(filtered);
    log.info("delete.ok", { id });
    return true;
  }

  /** Delete all entries. */
  async clear(): Promise<number> {
    const all = await this.list();
    if (all.length === 0) return 0;
    await this.writeAll([]);
    log.info("clear.ok", { count: all.length });
    return all.length;
  }

  // -------------------------------------------------------------------------
  // Selection for injection
  // -------------------------------------------------------------------------

  /**
   * Select memories for context injection, respecting a token budget.
   * Returns entries sorted by priority (correction > user > project),
   * within each type by most recent first, until budget is exhausted.
   * Returns empty array if budget is 0 or negative.
   */
  async selectForInjection(budgetTokens: number): Promise<MemoryEntry[]> {
    if (budgetTokens <= 0) return [];

    const all = await this.list();
    if (all.length === 0) return [];

    // Sort: by type priority, then newest first within type
    const sorted = [...all].sort((a, b) => {
      const typeDiff = TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
      if (typeDiff !== 0) return typeDiff;
      return b.source.createdAt.localeCompare(a.source.createdAt);
    });

    const selected: MemoryEntry[] = [];
    let usedTokens = 0;

    for (const entry of sorted) {
      const entryTokens = estimateTokens(entry.content) + 10; // +10 for formatting overhead
      if (usedTokens + entryTokens > budgetTokens) continue; // skip, try smaller ones
      selected.push(entry);
      usedTokens += entryTokens;
    }

    log.debug("select.ok", {
      total: all.length,
      selected: selected.length,
      usedTokens,
      budgetTokens,
    });

    return selected;
  }

  /**
   * Format selected memories as a text block for injection.
   * Returns null if nothing to inject.
   */
  static formatForInjection(entries: MemoryEntry[]): string | null {
    if (entries.length === 0) return null;
    return entries
      .map((m) => `- [${m.type}] ${m.content}`)
      .join("\n");
  }

  // -------------------------------------------------------------------------
  // Internal I/O
  // -------------------------------------------------------------------------

  private async append(record: MemoryEntry): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(record) + "\n", "utf-8");
  }

  private async writeAll(entries: MemoryEntry[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const content =
      entries.length > 0
        ? entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
        : "";
    await writeFile(this.filePath, content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// MemoryWriter — extract memorable facts from user messages
// ---------------------------------------------------------------------------

interface ExtractionPattern {
  pattern: RegExp;
  type: MemoryType;
}

/**
 * Patterns that indicate a user message contains information worth
 * remembering across sessions. Intentionally conservative — false
 * negatives are fine in MVP, false positives are annoying.
 */
const EXTRACTION_PATTERNS: ExtractionPattern[] = [
  // Corrections / prohibitions
  { pattern: /不要|不用|别再|禁止|stop|don['']t|never|do not/i, type: "correction" },
  // User preferences / identity
  { pattern: /我(喜欢|习惯|一般|倾向|用的是|偏好)|I (prefer|like|use|always|usually)/i, type: "user" },
  // Project / architecture facts
  { pattern: /这个(项目|仓库|工程)|我们(的|用)|架构是|技术栈|用的是|the project|our (stack|repo)/i, type: "project" },
  // Explicit "remember this"
  { pattern: /记住|remember|记一下|备注/i, type: "user" },
];

/** Maximum length of a single extracted memory (characters). */
const MAX_MEMORY_CONTENT_LENGTH = 300;

export interface MemoryWriterOptions {
  store: MemoryStore;
  threadId: string;
  traceId: string;
}

/**
 * Scan user messages for memorable facts and write them to the store.
 * Designed to run **asynchronously** after a completed run — it should
 * never block the response path.
 *
 * Returns the number of memories extracted.
 */
export async function extractAndWriteMemories(
  userMessages: string[],
  options: MemoryWriterOptions,
): Promise<number> {
  const { store, threadId, traceId } = options;
  let written = 0;

  for (const text of userMessages) {
    for (const { pattern, type } of EXTRACTION_PATTERNS) {
      if (!pattern.test(text)) continue;

      // Extract a reasonable snippet around the match
      const content = text.length <= MAX_MEMORY_CONTENT_LENGTH
        ? text.trim()
        : text.slice(0, MAX_MEMORY_CONTENT_LENGTH).trim() + "…";

      // Skip very short content (likely noise)
      if (content.length < 4) continue;

      await store.add({
        type,
        content,
        source: {
          threadId,
          traceId,
          createdAt: new Date().toISOString(),
        },
        tags: [],
      });

      written += 1;
      // Only extract one memory per user message to avoid over-extraction
      break;
    }
  }

  if (written > 0) {
    log.info("writer.extracted", { threadId, traceId, count: written });
  }

  return written;
}

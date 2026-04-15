import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SessionSnapshot {
  lastThreadId: string;
  updatedAt: string;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function loadSessionSnapshot(
  sessionStatePath: string,
): Promise<SessionSnapshot | null> {
  try {
    const raw = await readFile(sessionStatePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
    if (typeof parsed.lastThreadId !== "string" || !parsed.lastThreadId) {
      return null;
    }
    return {
      lastThreadId: parsed.lastThreadId,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function rememberThreadId(
  sessionStatePath: string,
  threadId: string,
): Promise<void> {
  await ensureParentDirectory(sessionStatePath);
  const snapshot: SessionSnapshot = {
    lastThreadId: threadId,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(sessionStatePath, JSON.stringify(snapshot, null, 2));
}

export async function resolveInitialThreadId(
  explicitThreadId: string | undefined,
  sessionStatePath: string,
): Promise<string> {
  if (explicitThreadId) {
    await rememberThreadId(sessionStatePath, explicitThreadId);
    return explicitThreadId;
  }

  const existing = await loadSessionSnapshot(sessionStatePath);
  if (existing?.lastThreadId) {
    return existing.lastThreadId;
  }

  const generated = randomUUID();
  await rememberThreadId(sessionStatePath, generated);
  return generated;
}

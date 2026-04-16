import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { AIMessage, type BaseMessage } from "@langchain/core/messages";

import type { AgentCoreServiceHarness } from "../service.js";
import type { ReturnDispatcher, ReturnDraft } from "../returns.js";
import { createLogger } from "../logger.js";

import { readHeartbeatFile } from "./parser.js";
import { isDue } from "./scheduler.js";
import type {
  HeartbeatState,
  HeartbeatTaskDef,
  HeartbeatTaskState,
  HeartbeatTaskStatus,
} from "./types.js";

const log = createLogger("heartbeat");

export interface HeartbeatEngineOptions {
  heartbeatFilePath: string;
  statePath: string;
  service: AgentCoreServiceHarness;
  returnDispatcher: ReturnDispatcher;
  tickIntervalSec?: number;
  /** Injection point for tests; defaults to system clock. */
  now?: () => Date;
}

// MARK: Heartbeat engine
//
// Spec: docs/specs/2026-04-16-heartbeat-spec.md
//
// Reads HEARTBEAT.md, ticks on a timer, fires due tasks via headless
// agent runs, dispatches results to the Returns Plane.

export class HeartbeatEngine {
  private readonly heartbeatFilePath: string;
  private readonly statePath: string;
  private readonly service: AgentCoreServiceHarness;
  private readonly returnDispatcher: ReturnDispatcher;
  private readonly tickIntervalSec: number;
  private readonly now: () => Date;

  private tasks: HeartbeatTaskDef[] = [];
  private state: HeartbeatState = { tasks: {} };
  private lastParseErrors: string[] = [];

  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(options: HeartbeatEngineOptions) {
    this.heartbeatFilePath = options.heartbeatFilePath;
    this.statePath = options.statePath;
    this.service = options.service;
    this.returnDispatcher = options.returnDispatcher;
    this.tickIntervalSec = options.tickIntervalSec ?? 30;
    this.now = options.now ?? (() => new Date());
  }

  // MARK: lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reload();
    await this.loadState();
    this.scheduleTick();
    log.info("started", {
      taskCount: this.tasks.length,
      tickIntervalSec: this.tickIntervalSec,
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async reload(): Promise<void> {
    const result = await readHeartbeatFile(this.heartbeatFilePath);
    this.tasks = result.tasks;
    this.lastParseErrors = result.errors;
    if (result.errors.length > 0) {
      log.warn("reload.errors", { errors: result.errors });
    } else {
      log.info("reload.ok", { count: result.tasks.length });
    }
  }

  // MARK: public status + manual trigger

  getParseErrors(): string[] {
    return [...this.lastParseErrors];
  }

  listStatus(): HeartbeatTaskStatus[] {
    const now = this.now();
    return this.tasks.map((def) => {
      const state = this.state.tasks[def.id] ?? {};
      const { nextFireAt } = isDue(
        def,
        state.lastFiredAt ? new Date(state.lastFiredAt) : undefined,
        now,
      );
      return {
        def,
        state,
        nextFireAt: nextFireAt?.toISOString(),
      };
    });
  }

  async runNow(taskId: string): Promise<HeartbeatTaskState> {
    const def = this.tasks.find((t) => t.id === taskId);
    if (!def) {
      throw new Error(`Heartbeat task not found: ${taskId}`);
    }
    return this.fire(def);
  }

  // MARK: tick loop

  private scheduleTick(): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.started) this.scheduleTick();
      });
    }, this.tickIntervalSec * 1000);
  }

  async tick(): Promise<void> {
    const now = this.now();
    for (const def of this.tasks) {
      const state = this.state.tasks[def.id] ?? {};
      const lastFiredAt = state.lastFiredAt ? new Date(state.lastFiredAt) : undefined;
      const { due } = isDue(def, lastFiredAt, now);
      if (due) {
        try {
          await this.fire(def);
        } catch (err) {
          log.error("tick.fire.failed", { taskId: def.id, error: String(err) });
        }
      }
    }
  }

  // MARK: fire

  private async fire(def: HeartbeatTaskDef): Promise<HeartbeatTaskState> {
    log.info("fire.start", { taskId: def.id, handler: def.handler });
    const firedAt = this.now().toISOString();

    let draft: ReturnDraft | null = null;
    let newState: HeartbeatTaskState;
    try {
      draft = await this.runHandler(def);
      const entry = draft
        ? await this.returnDispatcher.dispatch(draft)
        : undefined;
      newState = {
        lastFiredAt: firedAt,
        lastStatus: "ok",
        lastReturnId: entry?.id,
      };
      log.info("fire.done", { taskId: def.id, returnId: entry?.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      newState = {
        lastFiredAt: firedAt,
        lastStatus: "error",
        lastError: message,
      };
      // Persist an error entry so the user sees it in the Inbox.
      try {
        const errorDraft: ReturnDraft = {
          kind: `heartbeat.${def.handler}.error`,
          title: `[error] ${def.id}`,
          summary: message.slice(0, 300),
          payload: { taskId: def.id, error: message },
          tags: ["heartbeat", def.id, "error"],
          source: { taskId: `heartbeat:${def.id}` },
        };
        await this.returnDispatcher.dispatch(errorDraft);
      } catch {
        // swallow — we've already logged the primary error
      }
      log.error("fire.error", { taskId: def.id, error: message });
    }

    this.state.tasks[def.id] = newState;
    await this.saveState();
    return newState;
  }

  private async runHandler(def: HeartbeatTaskDef): Promise<ReturnDraft | null> {
    switch (def.handler) {
      case "agent-run":
        return this.runAgentRun(def);
    }
  }

  private async runAgentRun(def: HeartbeatTaskDef): Promise<ReturnDraft> {
    const prompt = def.prompt ?? "";
    if (!prompt.trim()) {
      throw new Error(`agent-run task ${def.id} has empty prompt`);
    }
    const threadId = `heartbeat:${def.id}:${Date.now()}`;
    const traceId = randomUUID();
    const result = await this.service.runOnce({
      traceId,
      threadId,
      input: prompt,
      // Headless: no human to respond to interrupts. Any sensitive tool triggers a fail.
      maxInterrupts: 0,
    });

    const assistantText = extractLastAssistantText(result.messages);
    const summary = assistantText
      ? assistantText.slice(0, 300)
      : `(no assistant output; status=${result.status})`;

    return {
      kind: "heartbeat.agent-run",
      title: def.id,
      summary,
      payload: {
        taskId: def.id,
        prompt,
        traceId,
        status: result.status,
        // Stringify to keep the payload JSON-safe (BaseMessage is class-shaped).
        assistantText: assistantText ?? null,
      },
      tags: ["heartbeat", def.id, ...(def.tags ?? [])],
      source: { taskId: `heartbeat:${def.id}`, traceId },
      announce: def.announce,
    };
  }

  // MARK: state persistence

  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as HeartbeatState;
      if (parsed && typeof parsed === "object" && parsed.tasks) {
        this.state = parsed;
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("state.loadFailed", { error: String(err) });
      }
    }
    this.state = { tasks: {} };
  }

  private async saveState(): Promise<void> {
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      log.warn("state.saveFailed", { error: String(err) });
    }
  }
}

// MARK: helpers

function extractLastAssistantText(messages: readonly BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (AIMessage.isInstance(m)) {
      const text = baseMessageToText(m);
      if (text.trim()) return text;
    }
  }
  return null;
}

function baseMessageToText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

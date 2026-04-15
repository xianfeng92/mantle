import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type TraceEventKind =
  | "run_started"
  | "run_completed"
  | "run_interrupted"
  | "run_failed"
  | "guardrail_triggered"
  | "context_compacted"
  | "text_delta"
  | "tool_started"
  | "tool_finished"
  | "tool_failed"
  | "tool_call_fallback"
  | "retry_attempted"
  | "context_recovery"
  | "stage_selected"
  | "verification_passed"
  | "verification_failed"
  | "step_budget_exhausted";

export interface TraceEvent {
  timestamp: string;
  traceId: string;
  threadId: string;
  kind: TraceEventKind;
  mode?: "run" | "resume";
  model?: string;
  workspaceDir?: string;
  durationMs?: number;
  interruptCount?: number;
  payload?: Record<string, unknown>;
}

export interface TraceRecorder {
  record(event: TraceEvent): Promise<void>;
  listRecent(limit?: number): Promise<TraceEvent[]>;
  getTrace(traceId: string): Promise<TraceEvent[]>;
}

function parseTraceEvents(raw: string): TraceEvent[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceEvent];
      } catch {
        return [];
      }
    });
}

export class JsonlTraceRecorder implements TraceRecorder {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async record(event: TraceEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async listRecent(limit = 100): Promise<TraceEvent[]> {
    const events = await this.readAll();
    if (limit <= 0) {
      return [];
    }
    return events.slice(-limit);
  }

  async getTrace(traceId: string): Promise<TraceEvent[]> {
    const events = await this.readAll();
    return events.filter((event) => event.traceId === traceId);
  }

  private async readAll(): Promise<TraceEvent[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return parseTraceEvents(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }
}

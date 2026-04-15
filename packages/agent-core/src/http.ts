import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import type { AgentRuntime } from "./agent.js";
import {
  AgentCoreServiceHarness,
  type ServiceRunResult,
  type ServiceStreamEvent,
} from "./service.js";
import { COMPUTER_USE_ACTION_TOOL_NAMES } from "./computer-use.js";
import {
  GuardrailViolationError,
  serializeGuardrailViolation,
} from "./guardrails.js";
import { readAuditLog } from "./audit-log.js";
import { collectDoctorReport } from "./doctor.js";
import { createLogger } from "./logger.js";
import { listMoves, rollbackMove } from "./move-tracker.js";
import { DEFAULT_GUI_STEP_BUDGET } from "./tool-staging.js";
import type { HITLResponse, ContentBlock, UserInput } from "./types.js";
import { validateUserInput } from "./types.js";
import {
  TwitterDigestRequestSchema,
  generateDigest,
} from "./twitter-digest.js";

const log = createLogger("http");

export interface AgentCoreHttpServerOptions {
  host?: string;
  port?: number;
  corsOrigin?: string;
}

export interface SerializedMessage {
  role: "assistant" | "user" | "system" | "tool" | "unknown";
  text: string;
  content: unknown;
  name?: string;
  toolCallId?: string;
  toolCalls?: unknown;
}

export interface SerializedRunResult {
  traceId: string;
  status: "completed" | "interrupted";
  threadId: string;
  interruptCount: number;
  messages: SerializedMessage[];
  newMessages: SerializedMessage[];
  interruptRequest?: unknown;
  contextCompaction?: unknown;
}

export interface HttpServerAddress {
  host: string;
  port: number;
}

interface SerializedSkillSource {
  absolutePath: string;
  backendPath: string;
}

interface SerializedSkillMetadata {
  name: string;
  description: string;
  path: string;
  sourcePath: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

interface SerializedSubagentSource {
  absolutePath: string;
  backendPath: string;
}

interface SerializedSubagentMetadata {
  name: string;
  description: string;
  path: string;
  sourcePath: string;
  model?: string;
  skills?: string[];
}

interface RunRequestBody {
  threadId?: string;
  input?: string | ContentBlock[];
  maxInterrupts?: number;
  /** Optional environment context (YAML/text) injected as a system message before user input */
  context?: string;
}

interface ResumeRequestBody {
  threadId?: string;
  resume?: HITLResponse;
  maxInterrupts?: number;
}

interface RestoreRunSnapshotRequestBody {
  dryRun?: boolean;
  paths?: string[];
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_CORS_ORIGIN = "*";
const MAX_JSON_BODY_BYTES = 1_000_000;

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHitlResponse(value: unknown): value is HITLResponse {
  return isRecord(value) && Array.isArray(value.decisions);
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          if ("text" in item && typeof (item as { text?: unknown }).text === "string") {
            return String((item as { text: string }).text);
          }
          // Gracefully represent image_url blocks as placeholder text
          if ("type" in item && (item as { type: string }).type === "image_url") {
            return "[image]";
          }
        }
        return JSON.stringify(item, null, 2);
      })
      .join("\n");
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content, null, 2);
}

function serializeMessage(message: BaseMessage): SerializedMessage {
  if (AIMessage.isInstance(message)) {
    return {
      role: "assistant",
      text: contentToText(message.content),
      content: message.content,
      toolCalls:
        Array.isArray(message.tool_calls) && message.tool_calls.length > 0
          ? message.tool_calls
          : undefined,
    };
  }
  if (HumanMessage.isInstance(message)) {
    return {
      role: "user",
      text: contentToText(message.content),
      content: message.content,
      name: message.name,
    };
  }
  if (SystemMessage.isInstance(message)) {
    return {
      role: "system",
      text: contentToText(message.content),
      content: message.content,
      name: message.name,
    };
  }
  if (ToolMessage.isInstance(message)) {
    return {
      role: "tool",
      text: contentToText(message.content),
      content: message.content,
      name: message.name,
      toolCallId: message.tool_call_id,
    };
  }
  return {
    role: "unknown",
    text: contentToText((message as { content?: unknown }).content),
    content: (message as { content?: unknown }).content,
  };
}

function serializeRunResult(result: ServiceRunResult): SerializedRunResult {
  return {
    traceId: result.traceId,
    status: result.status,
    threadId: result.threadId,
    interruptCount: result.interruptCount,
    messages: result.messages.map(serializeMessage),
    newMessages: result.newMessages.map(serializeMessage),
    interruptRequest: result.interruptRequest,
    contextCompaction: result.contextCompaction,
  };
}

function serializeStreamEvent(event: ServiceStreamEvent): { name: string; data: unknown } {
  switch (event.type) {
    case "run_started":
      return {
        name: event.type,
        data: {
          traceId: event.traceId,
          threadId: event.threadId,
          mode: event.mode,
        },
      };
    case "text_delta":
      return {
        name: event.type,
        data: {
          traceId: event.traceId,
          threadId: event.threadId,
          delta: event.delta,
          runId: event.runId,
          nodeName: event.nodeName,
        },
      };
    case "tool_started":
      return {
        name: event.type,
        data: {
          traceId: event.traceId,
          threadId: event.threadId,
          toolName: event.toolName,
          input: event.input,
          runId: event.runId,
        },
      };
    case "tool_finished":
      return {
        name: event.type,
        data: {
          traceId: event.traceId,
          threadId: event.threadId,
          toolName: event.toolName,
          output: event.output,
          runId: event.runId,
        },
      };
    case "tool_failed":
      return {
        name: event.type,
        data: {
          traceId: event.traceId,
          threadId: event.threadId,
          toolName: event.toolName,
          error: event.error,
          runId: event.runId,
        },
      };
    case "context_compacted":
      return {
        name: event.type,
        data: {
          traceId: event.traceId,
          threadId: event.threadId,
          contextCompaction: event.contextCompaction,
        },
      };
    case "run_completed":
    case "run_interrupted":
      return {
        name: event.type,
        data: serializeRunResult(event.result),
      };
  }
}

function withCorsHeaders(response: ServerResponse, corsOrigin: string): void {
  response.setHeader("Access-Control-Allow-Origin", corsOrigin);
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  corsOrigin: string,
): void {
  withCorsHeaders(response, corsOrigin);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body, null, 2));
}

function sendEmpty(response: ServerResponse, statusCode: number, corsOrigin: string): void {
  withCorsHeaders(response, corsOrigin);
  response.statusCode = statusCode;
  response.end();
}

function setTraceHeader(response: ServerResponse, traceId: string): void {
  response.setHeader("X-Agent-Core-Trace-Id", traceId);
}

function sendSseHeaders(
  response: ServerResponse,
  corsOrigin: string,
  traceId?: string,
): void {
  withCorsHeaders(response, corsOrigin);
  if (traceId) {
    setTraceHeader(response, traceId);
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
}

function serializeSkillMetadata(
  skill: Awaited<ReturnType<AgentRuntime["listSkills"]>>[number],
): SerializedSkillMetadata {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    sourcePath: skill.sourcePath,
    license: skill.license,
    compatibility: skill.compatibility,
    metadata: skill.metadata,
    allowedTools: skill.allowedTools,
  };
}

function serializeSubagentMetadata(
  subagent: Awaited<ReturnType<AgentRuntime["listSubagents"]>>[number],
): SerializedSubagentMetadata {
  return {
    name: subagent.name,
    description: subagent.description,
    path: subagent.path,
    sourcePath: subagent.sourcePath,
    model: subagent.model,
    skills: subagent.skills,
  };
}

function serializeErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof GuardrailViolationError) {
    return serializeGuardrailViolation(error);
  }
  if (error instanceof HttpError) {
    return {
      error: error.message,
    };
  }
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

function writeSseEvent(response: ServerResponse, eventName: string, body: unknown): void {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  let totalBytes = 0;

  for await (const chunk of request) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    raw += text;
    totalBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, "Request body too large.");
    }
  }

  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Malformed JSON request body.");
  }
}

export class AgentCoreHttpServer {
  private readonly runtime: AgentRuntime;
  private readonly service: AgentCoreServiceHarness;
  private readonly host: string;
  private readonly port: number;
  private readonly corsOrigin: string;
  private readonly server: Server;
  private closed = false;

  constructor(runtime: AgentRuntime, options: AgentCoreHttpServerOptions = {}) {
    this.runtime = runtime;
    this.service = new AgentCoreServiceHarness(runtime);
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.corsOrigin = options.corsOrigin ?? DEFAULT_CORS_ORIGIN;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  get nodeServer(): Server {
    return this.server;
  }

  async listen(): Promise<HttpServerAddress> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      return { host: this.host, port: this.port };
    }

    return {
      host: address.address,
      port: address.port,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });

    await this.runtime.close();
  }

  private async streamEventsToResponse(
    response: ServerResponse,
    traceId: string,
    events: AsyncIterable<ServiceStreamEvent>,
  ): Promise<void> {
    sendSseHeaders(response, this.corsOrigin, traceId);

    for await (const event of events) {
      const serialized = serializeStreamEvent(event);
      writeSseEvent(response, serialized.name, serialized.data);
    }

    response.end();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reqStart = Date.now();
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      const parts = pathname.split("/").filter(Boolean);

      if (method === "OPTIONS") {
        sendEmpty(response, 204, this.corsOrigin);
        return;
      }

      // Skip logging for high-frequency health checks
      if (pathname !== "/health") {
        log.info("request", { method, path: pathname });
      }

      if (method === "GET" && pathname === "/health") {
        sendJson(
          response,
          200,
          {
            ok: true,
            service: "agent-core",
            model: this.runtime.settings.model,
            promptProfile: this.runtime.settings.promptProfile,
            contextWindowSize: this.service.contextWindowSize,
            workspaceDir: this.runtime.settings.workspaceDir,
            workspaceMode: this.runtime.settings.workspaceMode,
            virtualMode: this.runtime.settings.virtualMode,
          },
          this.corsOrigin,
        );
        return;
      }

      if (method === "GET" && pathname === "/doctor") {
        const report = await collectDoctorReport(this.runtime, this.service.contextWindowSize);
        sendJson(response, 200, report, this.corsOrigin);
        return;
      }

      // ── Audit Log ──
      if (method === "GET" && pathname === "/audit") {
        const entries = await readAuditLog(this.runtime.settings.auditLogPath);
        sendJson(response, 200, { entries }, this.corsOrigin);
        return;
      }

      // ── Move Tracker / Rollback ──
      if (method === "GET" && pathname === "/moves") {
        const days = url.searchParams.get("days");
        const maxAgeDays = days ? parseInt(days, 10) : 7;
        const moves = await listMoves(
          this.runtime.settings.movesLogPath,
          { maxAgeDays: Number.isFinite(maxAgeDays) ? maxAgeDays : 7 },
        );
        sendJson(response, 200, { moves }, this.corsOrigin);
        return;
      }

      if (method === "GET" && pathname === "/run-snapshots") {
        if (!this.runtime.runSnapshots) {
          sendJson(response, 501, { error: "Run snapshot support is not enabled." }, this.corsOrigin);
          return;
        }
        const limitRaw = url.searchParams.get("limit");
        const threadId = url.searchParams.get("threadId")?.trim() || undefined;
        const limit = limitRaw ? Number(limitRaw) : 25;
        const runs = await this.runtime.runSnapshots.listRuns({
          threadId,
          limit: Number.isFinite(limit) ? limit : 25,
        });
        sendJson(response, 200, { runs }, this.corsOrigin);
        return;
      }

      if (method === "GET" && parts.length === 2 && parts[0] === "run-snapshots") {
        if (!this.runtime.runSnapshots) {
          sendJson(response, 501, { error: "Run snapshot support is not enabled." }, this.corsOrigin);
          return;
        }
        const traceId = decodeURIComponent(parts[1] ?? "").trim();
        if (!traceId) {
          sendJson(response, 400, { error: "Trace id is required." }, this.corsOrigin);
          return;
        }
        const run = await this.runtime.runSnapshots.getRun(traceId);
        if (!run) {
          sendJson(response, 404, { error: "Run snapshot not found." }, this.corsOrigin);
          return;
        }
        sendJson(response, 200, { run }, this.corsOrigin);
        return;
      }

      if (
        method === "POST" &&
        parts.length === 3 &&
        parts[0] === "run-snapshots" &&
        parts[2] === "restore"
      ) {
        if (!this.runtime.runSnapshots) {
          sendJson(response, 501, { error: "Run snapshot support is not enabled." }, this.corsOrigin);
          return;
        }
        const traceId = decodeURIComponent(parts[1] ?? "").trim();
        if (!traceId) {
          sendJson(response, 400, { error: "Trace id is required." }, this.corsOrigin);
          return;
        }
        const body = (await readJsonBody(request)) as RestoreRunSnapshotRequestBody;
        const result = await this.runtime.runSnapshots.restoreRun(traceId, {
          dryRun: body.dryRun !== false,
          paths: Array.isArray(body.paths)
            ? body.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            : undefined,
        });
        if (!result) {
          sendJson(response, 404, { error: "Run snapshot not found." }, this.corsOrigin);
          return;
        }
        sendJson(response, 200, result, this.corsOrigin);
        return;
      }

      if (method === "POST" && pathname.match(/^\/moves\/[^/]+\/rollback$/)) {
        const moveId = pathname.split("/")[2]!;
        const result = await rollbackMove(
          moveId,
          this.runtime.settings.movesLogPath,
          this.runtime.settings.workspaceDir,
        );
        sendJson(
          response,
          result.success ? 200 : 400,
          result,
          this.corsOrigin,
        );
        return;
      }

      if (method === "GET" && pathname === "/skills") {
        const skills = await this.runtime.listSkills();
        const sources: SerializedSkillSource[] = this.runtime.skillSources.map((source) => ({
          absolutePath: source.absolutePath,
          backendPath: source.backendPath,
        }));
        sendJson(
          response,
          200,
          {
            sources,
            skills: skills.map(serializeSkillMetadata),
          },
          this.corsOrigin,
        );
        return;
      }

      if (method === "GET" && pathname === "/subagents") {
        const subagents = await this.runtime.listSubagents();
        const sources: SerializedSubagentSource[] = this.runtime.subagentSources.map(
          (source) => ({
            absolutePath: source.absolutePath,
            backendPath: source.backendPath,
          }),
        );
        sendJson(
          response,
          200,
          {
            generalPurposeAgent: this.runtime.generalPurposeSubagent,
            sources,
            subagents: subagents.map(serializeSubagentMetadata),
          },
          this.corsOrigin,
        );
        return;
      }

      if (method === "GET" && pathname === "/diagnostics") {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 500;
        const events = await this.runtime.traceRecorder.listRecent(
          Number.isFinite(limit) ? limit : 500,
        );

        // Compute diagnostic statistics
        let fallbackCount = 0;
        let retryCount = 0;
        let recoveryCount = 0;
        let recoveryFailures = 0;
        let runCount = 0;
        let failedRunCount = 0;
        let totalRunDurationMs = 0;
        let compactionCount = 0;
        let stageSelectionCount = 0;
        let verificationPassed = 0;
        let verificationFailed = 0;
        let budgetExhaustedCount = 0;
        const stageCounts: Record<string, number> = {};
        const recentErrors: Array<{ timestamp: string; kind: string; error: string }> = [];
        const toolStartsByTrace = new Map<string, number>();
        const guiActionStartsByTrace = new Map<string, number>();
        const completedTraceIds: string[] = [];

        for (const event of events) {
          switch (event.kind) {
            case "tool_call_fallback":
              fallbackCount++;
              break;
            case "retry_attempted":
              retryCount++;
              break;
            case "tool_started": {
              toolStartsByTrace.set(
                event.traceId,
                (toolStartsByTrace.get(event.traceId) ?? 0) + 1,
              );
              const toolName =
                typeof event.payload?.toolName === "string"
                  ? event.payload.toolName
                  : null;
              if (toolName && COMPUTER_USE_ACTION_TOOL_NAMES.has(toolName)) {
                guiActionStartsByTrace.set(
                  event.traceId,
                  (guiActionStartsByTrace.get(event.traceId) ?? 0) + 1,
                );
              }
              break;
            }
            case "context_recovery":
              if (event.payload?.trigger === "recovery_failed") {
                recoveryFailures++;
              } else {
                recoveryCount++;
              }
              break;
            case "run_completed":
              runCount++;
              completedTraceIds.push(event.traceId);
              if (typeof event.durationMs === "number") {
                totalRunDurationMs += event.durationMs;
              }
              break;
            case "run_failed":
              failedRunCount++;
              if (event.payload?.error) {
                recentErrors.push({
                  timestamp: event.timestamp,
                  kind: event.kind,
                  error: String(event.payload.error),
                });
              }
              break;
            case "context_compacted":
              compactionCount++;
              break;
            case "stage_selected": {
              stageSelectionCount++;
              const stage =
                typeof event.payload?.stage === "string" ? event.payload.stage : "unknown";
              stageCounts[stage] = (stageCounts[stage] ?? 0) + 1;
              break;
            }
            case "verification_passed":
              verificationPassed++;
              break;
            case "verification_failed":
              verificationFailed++;
              break;
            case "step_budget_exhausted":
              budgetExhaustedCount++;
              break;
            case "guardrail_triggered":
              recentErrors.push({
                timestamp: event.timestamp,
                kind: event.kind,
                error: `${event.payload?.rule ?? "unknown"}: ${event.payload?.phase ?? ""}`,
              });
              break;
          }
        }

        // Aggregate token usage from run_completed events
        const tokenUsages: Array<{ prompt: number; completion: number; total: number; percent: number }> = [];
        for (const event of events) {
          if (event.kind === "run_completed" && event.payload?.tokenUsage) {
            const tu = event.payload.tokenUsage as Record<string, number>;
            tokenUsages.push({
              prompt: tu.promptTokens ?? 0,
              completion: tu.completionTokens ?? 0,
              total: tu.totalTokens ?? 0,
              percent: typeof event.payload.contextUsagePercent === "number"
                ? event.payload.contextUsagePercent
                : 0,
            });
          }
        }

        const contextUsage = tokenUsages.length > 0
          ? {
              windowSize: this.service.contextWindowSize,
              lastPromptTokens: tokenUsages[tokenUsages.length - 1]?.prompt ?? null,
              lastUsagePercent: tokenUsages[tokenUsages.length - 1]?.percent ?? null,
              avgPromptTokens: Math.round(
                tokenUsages.reduce((s, t) => s + t.prompt, 0) / tokenUsages.length,
              ),
              maxPromptTokens: Math.max(...tokenUsages.map((t) => t.prompt)),
              peakUsagePercent: Math.max(...tokenUsages.map((t) => t.percent)),
              sampledRuns: tokenUsages.length,
            }
          : {
              windowSize: this.service.contextWindowSize,
              lastPromptTokens: null,
              lastUsagePercent: null,
              avgPromptTokens: null,
              maxPromptTokens: null,
              peakUsagePercent: null,
              sampledRuns: 0,
            };

        const toolCountsForCompletedRuns = completedTraceIds.map(
          (traceId) => toolStartsByTrace.get(traceId) ?? 0,
        );
        const guiActionCountsForCompletedRuns = completedTraceIds.map(
          (traceId) => guiActionStartsByTrace.get(traceId) ?? 0,
        );
        const avgToolCallsPerCompletedRun =
          toolCountsForCompletedRuns.length > 0
            ? Math.round(
                toolCountsForCompletedRuns.reduce((sum, count) => sum + count, 0) /
                  toolCountsForCompletedRuns.length,
              )
            : null;
        const avgGuiActionStepsPerCompletedRun =
          guiActionCountsForCompletedRuns.length > 0
            ? Math.round(
                guiActionCountsForCompletedRuns.reduce((sum, count) => sum + count, 0) /
                  guiActionCountsForCompletedRuns.length,
              )
            : null;
        const verificationTotal = verificationPassed + verificationFailed;

        sendJson(
          response,
          200,
          {
            eventsAnalyzed: events.length,
            gemma4: {
              toolCallFallbackCount: fallbackCount,
              retryCount,
              contextRecoveryCount: recoveryCount,
              contextRecoveryFailures: recoveryFailures,
            },
            runs: {
              completed: runCount,
              failed: failedRunCount,
              avgDurationMs:
                runCount > 0 ? Math.round(totalRunDurationMs / runCount) : null,
              avgToolCallsPerCompletedRun,
              maxToolCallsInRun:
                toolCountsForCompletedRuns.length > 0
                  ? Math.max(...toolCountsForCompletedRuns)
                  : null,
              avgGuiActionStepsPerCompletedRun,
              maxGuiActionStepsInRun:
                guiActionCountsForCompletedRuns.length > 0
                  ? Math.max(...guiActionCountsForCompletedRuns)
                  : null,
            },
            compaction: {
              count: compactionCount,
              ratePercent:
                runCount > 0 ? Math.round((compactionCount / runCount) * 100) : null,
            },
            contextUsage,
            staging: {
              selections: stageSelectionCount,
              byStage: stageCounts,
              budgetExhaustedCount,
              guiStepBudget: DEFAULT_GUI_STEP_BUDGET,
            },
            verification: {
              passed: verificationPassed,
              failed: verificationFailed,
              passRatePercent:
                verificationTotal > 0
                  ? Math.round((verificationPassed / verificationTotal) * 100)
                  : null,
            },
            recentErrors: recentErrors.slice(-10),
          },
          this.corsOrigin,
        );
        return;
      }

      if (method === "GET" && pathname === "/traces") {
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 100;
        const events = await this.runtime.traceRecorder.listRecent(
          Number.isFinite(limit) ? limit : 100,
        );
        sendJson(response, 200, { events }, this.corsOrigin);
        return;
      }

      if (method === "GET" && parts.length === 2 && parts[0] === "traces") {
        const traceId = decodeURIComponent(parts[1] ?? "").trim();
        if (!traceId) {
          sendJson(response, 400, { error: "Trace id is required." }, this.corsOrigin);
          return;
        }

        const events = await this.runtime.traceRecorder.getTrace(traceId);
        sendJson(response, 200, { traceId, events }, this.corsOrigin);
        return;
      }

      if (method === "POST" && pathname === "/threads") {
        const body = (await readJsonBody(request)) as { threadId?: unknown };
        const threadId =
          typeof body.threadId === "string" && body.threadId.trim()
            ? body.threadId.trim()
            : randomUUID();
        this.service.resetThread(threadId);
        sendJson(response, 201, { threadId }, this.corsOrigin);
        return;
      }

      if (method === "POST" && pathname === "/runs") {
        const body = (await readJsonBody(request)) as RunRequestBody;
        const input = validateUserInput(body.input);
        if (!input) {
          sendJson(response, 400, { error: "Field `input` must be a non-empty string or a content block array with at least one non-empty text block." }, this.corsOrigin);
          return;
        }

        const threadId =
          typeof body.threadId === "string" && body.threadId.trim()
            ? body.threadId.trim()
            : randomUUID();
        const context = typeof body.context === "string" ? body.context.trim() : undefined;
        const inputLen = typeof input === "string" ? input.length : input.length;
        log.info("run.start", { threadId, inputLen, hasContext: !!context, multimodal: Array.isArray(input) });
        const result = await this.service.runOnce({
          threadId,
          input,
          context: context || undefined,
          maxInterrupts:
            typeof body.maxInterrupts === "number" ? body.maxInterrupts : undefined,
        });
        log.info("run.done", { threadId, traceId: result.traceId, status: result.status, durationMs: Date.now() - reqStart });
        setTraceHeader(response, result.traceId);
        sendJson(response, 200, serializeRunResult(result), this.corsOrigin);
        return;
      }

      if (method === "POST" && pathname === "/twitter/digest") {
        const body = await readJsonBody(request);
        const parseResult = TwitterDigestRequestSchema.safeParse(body);
        if (!parseResult.success) {
          sendJson(
            response,
            400,
            {
              error: "invalid request body",
              issues: parseResult.error.issues,
            },
            this.corsOrigin,
          );
          return;
        }

        const digestStart = Date.now();
        log.info("twitter.digest.start", {
          mode: parseResult.data.mode,
          count: parseResult.data.bookmarks.length,
        });
        try {
          const result = await generateDigest(
            parseResult.data,
            this.runtime.settings,
          );
          log.info("twitter.digest.done", {
            mode: parseResult.data.mode,
            durationMs: Date.now() - digestStart,
          });
          sendJson(response, 200, result, this.corsOrigin);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("twitter.digest.error", {
            mode: parseResult.data.mode,
            durationMs: Date.now() - digestStart,
            error: message,
          });
          sendJson(
            response,
            500,
            { error: message },
            this.corsOrigin,
          );
        }
        return;
      }

      if (method === "POST" && pathname === "/runs/stream") {
        const body = (await readJsonBody(request)) as RunRequestBody;
        const input = validateUserInput(body.input);
        if (!input) {
          sendJson(response, 400, { error: "Field `input` must be a non-empty string or a content block array with at least one non-empty text block." }, this.corsOrigin);
          return;
        }

        const threadId =
          typeof body.threadId === "string" && body.threadId.trim()
            ? body.threadId.trim()
            : randomUUID();
        const traceId = randomUUID();
        const inputLen = typeof input === "string" ? input.length : input.length;
        log.info("stream.start", { threadId, traceId, inputLen, multimodal: Array.isArray(input) });
        const abortController = new AbortController();
        response.on("close", () => {
          log.info("stream.clientClose", { threadId, traceId, durationMs: Date.now() - reqStart });
          abortController.abort();
        });

        const context = typeof body.context === "string" ? body.context.trim() : undefined;
        await this.streamEventsToResponse(
          response,
          traceId,
          this.service.streamRun({
            traceId,
            threadId,
            input,
            context: context || undefined,
            signal: abortController.signal,
          }),
        );
        log.info("stream.done", { threadId, traceId, durationMs: Date.now() - reqStart });
        return;
      }

      if (method === "POST" && pathname === "/resume") {
        const body = (await readJsonBody(request)) as ResumeRequestBody;
        const threadId =
          typeof body.threadId === "string" ? body.threadId.trim() : "";
        if (!threadId) {
          sendJson(response, 400, { error: "Field `threadId` must be a non-empty string." }, this.corsOrigin);
          return;
        }
        if (!isHitlResponse(body.resume)) {
          sendJson(response, 400, { error: "Field `resume` must be a HITL response object." }, this.corsOrigin);
          return;
        }

        log.info("resume.start", { threadId, decisions: (body.resume as HITLResponse).decisions.length });
        const result = await this.service.resumeOnce({
          threadId,
          resume: body.resume,
          maxInterrupts:
            typeof body.maxInterrupts === "number" ? body.maxInterrupts : undefined,
        });
        log.info("resume.done", { threadId, traceId: result.traceId, status: result.status, durationMs: Date.now() - reqStart });
        setTraceHeader(response, result.traceId);
        sendJson(response, 200, serializeRunResult(result), this.corsOrigin);
        return;
      }

      if (method === "POST" && pathname === "/resume/stream") {
        const body = (await readJsonBody(request)) as ResumeRequestBody;
        const threadId =
          typeof body.threadId === "string" ? body.threadId.trim() : "";
        if (!threadId) {
          sendJson(response, 400, { error: "Field `threadId` must be a non-empty string." }, this.corsOrigin);
          return;
        }
        if (!isHitlResponse(body.resume)) {
          sendJson(response, 400, { error: "Field `resume` must be a HITL response object." }, this.corsOrigin);
          return;
        }

        const traceId = randomUUID();
        const abortController = new AbortController();
        response.on("close", () => {
          abortController.abort();
        });

        await this.streamEventsToResponse(
          response,
          traceId,
          this.service.streamResume({
            traceId,
            threadId,
            resume: body.resume,
            signal: abortController.signal,
          }),
        );
        return;
      }

      if (method === "DELETE" && parts.length === 2 && parts[0] === "threads") {
        const threadId = decodeURIComponent(parts[1] ?? "").trim();
        if (!threadId) {
          sendJson(response, 400, { error: "Thread id is required." }, this.corsOrigin);
          return;
        }

        this.service.resetThread(threadId);
        if (typeof this.runtime.checkpointer.deleteThread === "function") {
          await this.runtime.checkpointer.deleteThread(threadId);
        }
        sendEmpty(response, 204, this.corsOrigin);
        return;
      }

      // ── Returns Plane ──
      // Spec: docs/specs/2026-04-16-returns-plane-spec.md
      if (method === "GET" && pathname === "/returns") {
        const limitRaw = url.searchParams.get("limit");
        const sinceRaw = url.searchParams.get("since");
        const unackedOnly = url.searchParams.get("unackedOnly") === "true";
        const limit = limitRaw ? Number(limitRaw) : 50;
        const entries = await this.runtime.returnStore.list({
          limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
          since: sinceRaw ?? undefined,
          unackedOnly,
        });
        sendJson(response, 200, { entries, count: entries.length }, this.corsOrigin);
        return;
      }

      if (method === "GET" && parts.length === 2 && parts[0] === "returns" && parts[1] !== "stream") {
        const returnId = decodeURIComponent(parts[1] ?? "").trim();
        if (!returnId) {
          sendJson(response, 400, { error: "Return id is required." }, this.corsOrigin);
          return;
        }
        const entry = await this.runtime.returnStore.get(returnId);
        if (!entry) {
          sendJson(response, 404, { error: "Return entry not found." }, this.corsOrigin);
          return;
        }
        sendJson(response, 200, { entry }, this.corsOrigin);
        return;
      }

      if (method === "POST" && pathname === "/returns") {
        const body = (await readJsonBody(request)) as {
          kind?: unknown;
          title?: unknown;
          summary?: unknown;
          payload?: unknown;
          tags?: unknown;
          source?: { taskId?: unknown; traceId?: unknown };
          announce?: { channels?: unknown; urgency?: unknown };
        };
        const kind = typeof body.kind === "string" ? body.kind.trim() : "";
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!kind || !title) {
          sendJson(
            response,
            400,
            { error: "Fields `kind` and `title` must be non-empty strings." },
            this.corsOrigin,
          );
          return;
        }
        const tags = Array.isArray(body.tags)
          ? body.tags.filter((t): t is string => typeof t === "string")
          : [];
        let announce: { channels: string[]; urgency?: "low" | "normal" | "high" } | undefined;
        if (body.announce && Array.isArray(body.announce.channels)) {
          const channels = body.announce.channels.filter(
            (c): c is string => typeof c === "string",
          );
          const rawUrgency = body.announce.urgency;
          const urgency: "low" | "normal" | "high" | undefined =
            rawUrgency === "low" || rawUrgency === "normal" || rawUrgency === "high"
              ? rawUrgency
              : undefined;
          announce = urgency ? { channels, urgency } : { channels };
        }
        const entry = await this.runtime.returnDispatcher.dispatch({
          kind,
          title,
          summary: typeof body.summary === "string" ? body.summary : undefined,
          payload: body.payload,
          tags,
          source: {
            taskId:
              typeof body.source?.taskId === "string" ? body.source.taskId : undefined,
            traceId:
              typeof body.source?.traceId === "string" ? body.source.traceId : undefined,
          },
          announce,
        });
        sendJson(response, 201, { entry }, this.corsOrigin);
        return;
      }

      if (method === "POST" && parts.length === 3 && parts[0] === "returns" && parts[2] === "ack") {
        const returnId = decodeURIComponent(parts[1] ?? "").trim();
        if (!returnId) {
          sendJson(response, 400, { error: "Return id is required." }, this.corsOrigin);
          return;
        }
        const updated = await this.runtime.returnStore.ack(returnId);
        if (!updated) {
          sendJson(response, 404, { error: "Return entry not found." }, this.corsOrigin);
          return;
        }
        sendJson(response, 200, { entry: updated }, this.corsOrigin);
        return;
      }

      if (method === "DELETE" && parts.length === 2 && parts[0] === "returns") {
        const returnId = decodeURIComponent(parts[1] ?? "").trim();
        if (!returnId) {
          sendJson(response, 400, { error: "Return id is required." }, this.corsOrigin);
          return;
        }
        const deleted = await this.runtime.returnStore.delete(returnId);
        if (!deleted) {
          sendJson(response, 404, { error: "Return entry not found." }, this.corsOrigin);
          return;
        }
        sendEmpty(response, 204, this.corsOrigin);
        return;
      }

      if (method === "GET" && pathname === "/returns/stream") {
        sendSseHeaders(response, this.corsOrigin);
        const unsubscribe = this.runtime.returnDispatcher.subscribe((entry) => {
          writeSseEvent(response, "return.created", entry);
        });
        // Keep-alive comments every 30s so reverse proxies do not drop the idle connection.
        const keepAlive = setInterval(() => {
          if (!response.writableEnded && !response.destroyed) {
            response.write(": ping\n\n");
          }
        }, 30_000);
        response.on("close", () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
        return;
      }

      // ── Memory API ──
      if (method === "GET" && pathname === "/memory") {
        const entries = await this.runtime.memoryStore.list();
        sendJson(response, 200, { entries, count: entries.length }, this.corsOrigin);
        return;
      }

      if (method === "GET" && pathname === "/memory/injection") {
        const threadId = url.searchParams.get("threadId")?.trim();
        if (!threadId) {
          sendJson(
            response,
            400,
            { error: "Query parameter `threadId` is required." },
            this.corsOrigin,
          );
          return;
        }
        const snapshot = this.service.getLastMemoryInjection(threadId) ?? null;
        sendJson(response, 200, { threadId, snapshot }, this.corsOrigin);
        return;
      }

      if (method === "POST" && pathname === "/memory") {
        const body = (await readJsonBody(request)) as {
          type?: string;
          content?: string;
          tags?: string[];
          threadId?: string;
          traceId?: string;
        };
        const content = typeof body.content === "string" ? body.content.trim() : "";
        if (!content) {
          sendJson(response, 400, { error: "Field `content` must be a non-empty string." }, this.corsOrigin);
          return;
        }
        const memType = body.type === "correction" || body.type === "project" ? body.type : "user";
        const entry = await this.runtime.memoryStore.add({
          type: memType,
          content,
          source: {
            threadId: typeof body.threadId === "string" ? body.threadId : "api",
            traceId: typeof body.traceId === "string" ? body.traceId : "api",
            createdAt: new Date().toISOString(),
          },
          tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [],
        });
        sendJson(response, 201, { entry }, this.corsOrigin);
        return;
      }

      if (method === "DELETE" && parts.length === 2 && parts[0] === "memory") {
        const memoryId = decodeURIComponent(parts[1] ?? "").trim();
        if (!memoryId) {
          sendJson(response, 400, { error: "Memory id is required." }, this.corsOrigin);
          return;
        }
        const deleted = await this.runtime.memoryStore.delete(memoryId);
        if (!deleted) {
          sendJson(response, 404, { error: "Memory entry not found." }, this.corsOrigin);
          return;
        }
        sendEmpty(response, 204, this.corsOrigin);
        return;
      }

      if (method === "DELETE" && pathname === "/memory") {
        const count = await this.runtime.memoryStore.clear();
        sendJson(response, 200, { cleared: count }, this.corsOrigin);
        return;
      }

      sendJson(response, 404, { error: "Not found." }, this.corsOrigin);
    } catch (error) {
      const durationMs = Date.now() - reqStart;
      if (response.headersSent) {
        if (!response.writableEnded && !response.destroyed) {
          log.error("stream.error", { error: error instanceof Error ? error.message : String(error), durationMs });
          writeSseEvent(response, "error", serializeErrorPayload(error));
          response.end();
        }
        return;
      }
      if (error instanceof GuardrailViolationError) {
        log.warn("guardrail.blocked", { phase: error.violation.phase, rule: error.violation.rule, durationMs });
        if (error.violation.traceId) {
          setTraceHeader(response, error.violation.traceId);
        }
        sendJson(response, 422, serializeGuardrailViolation(error), this.corsOrigin);
        return;
      }
      if (error instanceof HttpError) {
        log.warn("http.error", { status: error.statusCode, error: error.message, durationMs });
        sendJson(response, error.statusCode, { error: error.message }, this.corsOrigin);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error("handler.error", { error: message, durationMs });
      sendJson(response, 500, { error: message }, this.corsOrigin);
    }
  }
}

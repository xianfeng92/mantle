import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { AIMessage, BaseMessage, RemoveMessage, ToolMessage } from "@langchain/core/messages";
import type { StreamEvent } from "@langchain/core/types/stream";
import { Command } from "@langchain/langgraph";

import type { AgentRuntime } from "./agent.js";
import { enrichHitlRequest } from "./approval-risk.js";
import {
  buildCompactionHint,
  extractContextCompactionSnapshot,
  sameContextCompactionSnapshot,
  type ContextCompactionSnapshot,
} from "./compaction.js";
import { GuardrailViolationError } from "./guardrails.js";
import { HITL_REJECT_MARKER, extractInterruptRequest, normalizeHitlResponse } from "./hitl.js";
import { isContextSizeExceededError, isTransientLmStudioError, withRetry } from "./retry.js";
import {
  extractFallbackToolCalls,
  patchMessageWithFallbackToolCalls,
} from "./tool-call-fallback.js";
import { createLogger } from "./logger.js";
import {
  MemoryStore,
  estimateTokens,
  extractAndWriteMemories,
  type MemoryEntry,
} from "./memory.js";
import type { RunSnapshotStatus } from "./run-snapshots.js";
import type {
  ActionRequest,
  HITLRequest,
  HITLResponse,
  InterruptEnvelope,
  InvokeResultLike,
  ContentBlock,
  UserInput,
} from "./types.js";
import { extractTextFromInput } from "./types.js";

const log = createLogger("service");

export interface ServiceInterruptContext {
  traceId: string;
  threadId: string;
  interruptCount: number;
  messages: BaseMessage[];
  newMessages: BaseMessage[];
}

export type ServiceInterruptHandler = (
  request: HITLRequest,
  context: ServiceInterruptContext,
) => Promise<HITLResponse | null | undefined>;

export interface RunOnceOptions {
  traceId?: string;
  threadId: string;
  input: UserInput;
  /** Optional environment context prepended as a system message */
  context?: string;
  onInterrupt?: ServiceInterruptHandler;
  maxInterrupts?: number;
}

export interface ResumeOnceOptions {
  traceId?: string;
  threadId: string;
  resume: HITLResponse;
  onInterrupt?: ServiceInterruptHandler;
  maxInterrupts?: number;
}

export interface StreamRunOptions {
  traceId?: string;
  threadId: string;
  input: UserInput;
  /** Optional environment context (e.g. YAML snapshot) prepended as a system message */
  context?: string;
  signal?: AbortSignal;
  /** Interruption scope key. Same-scope requests abort the previous one. */
  scopeKey?: string;
}

export interface StreamResumeOptions {
  traceId?: string;
  threadId: string;
  resume: HITLResponse;
  signal?: AbortSignal;
  /** Interruption scope key. Same-scope requests abort the previous one. */
  scopeKey?: string;
}

export interface ServiceRunResult {
  traceId: string;
  status: "completed" | "interrupted";
  threadId: string;
  interruptCount: number;
  messages: BaseMessage[];
  newMessages: BaseMessage[];
  interruptRequest?: HITLRequest;
  contextCompaction?: ContextCompactionSnapshot;
}

export interface ServiceRunStartedEvent {
  type: "run_started";
  traceId: string;
  threadId: string;
  mode: "run" | "resume";
}

export interface ServiceTextDeltaEvent {
  type: "text_delta";
  traceId: string;
  threadId: string;
  delta: string;
  runId: string;
  nodeName: string;
}

export interface ServiceToolStartedEvent {
  type: "tool_started";
  traceId: string;
  threadId: string;
  toolName: string;
  input?: unknown;
  runId: string;
}

export interface ServiceToolFinishedEvent {
  type: "tool_finished";
  traceId: string;
  threadId: string;
  toolName: string;
  output?: unknown;
  runId: string;
}

export interface ServiceToolFailedEvent {
  type: "tool_failed";
  traceId: string;
  threadId: string;
  toolName: string;
  error?: unknown;
  runId: string;
}

export interface ServiceRunCompletedEvent {
  type: "run_completed";
  traceId: string;
  threadId: string;
  result: ServiceRunResult;
}

export interface ServiceRunInterruptedEvent {
  type: "run_interrupted";
  traceId: string;
  threadId: string;
  result: ServiceRunResult;
}

export interface ServiceContextCompactedEvent {
  type: "context_compacted";
  traceId: string;
  threadId: string;
  contextCompaction: ContextCompactionSnapshot;
}

export type ServiceStreamEvent =
  | ServiceRunStartedEvent
  | ServiceTextDeltaEvent
  | ServiceToolStartedEvent
  | ServiceToolFinishedEvent
  | ServiceToolFailedEvent
  | ServiceContextCompactedEvent
  | ServiceRunCompletedEvent
  | ServiceRunInterruptedEvent;

function toBaseMessages(result: InvokeResultLike): BaseMessage[] {
  return Array.isArray(result.messages) ? (result.messages as BaseMessage[]) : [];
}

function isInvokeResultLike(value: unknown): value is InvokeResultLike {
  return (
    typeof value === "object" &&
    value !== null &&
    (Array.isArray((value as { messages?: unknown }).messages) ||
      Array.isArray((value as { __interrupt__?: unknown }).__interrupt__))
  );
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
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
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

function extractTextDelta(event: StreamEvent): string {
  const chunk = event.data?.chunk;
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk && typeof chunk === "object" && "content" in chunk) {
    return contentToText((chunk as { content?: unknown }).content);
  }
  return "";
}

function maybeGetInvokeResult(event: StreamEvent): InvokeResultLike | null {
  const candidates = [event.data?.output, event.data?.chunk];
  for (const candidate of candidates) {
    if (isInvokeResultLike(candidate)) {
      return candidate;
    }
  }
  return null;
}

function truncateText(text: string, maxLength = 240): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...[truncated]`;
}

function buildRunSnapshotPreview(input: UserInput): string | undefined {
  const text = extractTextFromInput(input).trim();
  return text ? truncateText(text, 280) : undefined;
}

function buildResumeSnapshotPreview(resume: HITLResponse): string | undefined {
  const decisionCount = Array.isArray(resume.decisions) ? resume.decisions.length : 0;
  if (decisionCount === 0) {
    return "Resume with no explicit approval decisions";
  }
  const summary = resume.decisions
    .slice(0, 3)
    .map((decision) => {
      if (decision.type === "edit") {
        return `edit:${decision.editedAction.name}`;
      }
      return decision.type;
    })
    .join(", ");
  return decisionCount > 3
    ? `Resume ${decisionCount} decisions (${summary}, ...)`
    : `Resume ${decisionCount} decisions (${summary})`;
}

function extractInterruptsFromTasks(
  tasks: Array<{ interrupts?: Array<{ value?: unknown }>; [key: string]: unknown }> | undefined,
): Array<InterruptEnvelope> {
  if (!tasks) return [];
  return tasks
    .filter((t) => Array.isArray(t.interrupts) && t.interrupts.length > 0)
    .flatMap((t) => t.interrupts ?? []) as Array<InterruptEnvelope>;
}

/**
 * Extract token usage from the last AIMessage's response_metadata.
 * LangChain's ChatOpenAI populates response_metadata.usage with
 * { prompt_tokens, completion_tokens, total_tokens } from the LLM API.
 */
function extractTokenUsage(messages: BaseMessage[]): TokenUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!(msg instanceof AIMessage)) continue;
    const meta = (msg as AIMessage).response_metadata;
    if (!meta || typeof meta !== "object") continue;
    const usage = (meta as Record<string, unknown>).usage ??
                  (meta as Record<string, unknown>).token_usage;
    if (!usage || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
    const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0);
    const total = Number(u.total_tokens ?? prompt + completion);
    if (prompt > 0 || completion > 0) {
      return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
    }
  }
  return null;
}

function summarizeValue(value: unknown, maxLength = 240): string {
  if (typeof value === "string") {
    return truncateText(value, maxLength);
  }
  return truncateText(contentToText(value), maxLength);
}

function extractActionRequestsFromToolCalls(message: AIMessage): ActionRequest[] {
  return (message.tool_calls ?? []).map((toolCall) => ({
    name: toolCall.name,
    args:
      toolCall.args && typeof toolCall.args === "object"
        ? (toolCall.args as Record<string, unknown>)
        : {},
  }));
}

function sameActionRequests(left: ActionRequest[], right: ActionRequest[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (action, index) =>
        action.name === right[index]?.name &&
        isDeepStrictEqual(action.args, right[index]?.args),
    )
  );
}

function isRejectedToolMessage(message: BaseMessage): message is ToolMessage {
  return (
    ToolMessage.isInstance(message) &&
    message.status === "error" &&
    contentToText(message.content).includes(HITL_REJECT_MARKER)
  );
}

function buildRejectedActionAcknowledgement(actionRequests: ActionRequest[]): string {
  const actionNames = Array.from(new Set(actionRequests.map((action) => action.name)));
  if (actionNames.length === 0) {
    return "Understood. I will not execute that rejected action. Let me know if you want a safer alternative instead.";
  }

  if (actionNames.length === 1) {
    return `Understood. I will not execute the rejected ${actionNames[0]} action. Let me know if you want a safer alternative instead.`;
  }

  return `Understood. I will not execute the rejected actions (${actionNames.join(", ")}). Let me know if you want a safer alternative instead.`;
}

function replaceMessageById(
  messages: BaseMessage[],
  targetId: string,
  replacement: BaseMessage,
): BaseMessage[] {
  return messages.map((message) => (message.id === targetId ? replacement : message));
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface MemoryInjectionSnapshot {
  threadId: string;
  updatedAt: string;
  budgetTokens: number;
  skipped: boolean;
  reason?: "budget_zero" | "no_entries" | "injected";
  estimatedTokens: number;
  entries: MemoryEntry[];
}

export class AgentCoreServiceHarness {
  private readonly runtime: AgentRuntime;
  private readonly emittedMessageCountByThread = new Map<string, number>();
  private readonly lastTokenUsageByThread = new Map<string, TokenUsage>();
  private readonly lastMemoryInjectionByThread = new Map<string, MemoryInjectionSnapshot>();
  /**
   * Active interruption scopes. Key = scope key (e.g. "chat:thread-123"),
   * value = the AbortController for the currently-running request in that scope.
   *
   * When a new request arrives with the same scopeKey, the old controller is
   * aborted and replaced. Cross-scope requests are fully independent.
   */
  private readonly activeScopes = new Map<string, AbortController>();

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
  }

  /** Last known token usage for a thread (from the most recent invoke). */
  getLastTokenUsage(threadId: string): TokenUsage | undefined {
    return this.lastTokenUsageByThread.get(threadId);
  }

  /** Context window size hint from settings. */
  get contextWindowSize(): number {
    return this.runtime.settings.contextWindowTokensHint;
  }

  getLastMemoryInjection(threadId: string): MemoryInjectionSnapshot | undefined {
    return this.lastMemoryInjectionByThread.get(threadId);
  }

  async runOnce(options: RunOnceOptions): Promise<ServiceRunResult> {
    const traceId = options.traceId ?? randomUUID();
    const messages = await this.buildInputMessages(options.threadId, options.input, options.context);
    return this.executeLoop(
      traceId,
      "run",
      options.threadId,
      { messages },
      options.onInterrupt,
      options.maxInterrupts ?? 32,
      buildRunSnapshotPreview(options.input),
    );
  }

  async resumeOnce(options: ResumeOnceOptions): Promise<ServiceRunResult> {
    const traceId = options.traceId ?? randomUUID();
    return this.executeLoop(
      traceId,
      "resume",
      options.threadId,
      new Command({ resume: normalizeHitlResponse(options.resume) }),
      options.onInterrupt,
      options.maxInterrupts ?? 32,
      buildResumeSnapshotPreview(options.resume),
    );
  }

  async *streamRun(options: StreamRunOptions): AsyncGenerator<ServiceStreamEvent> {
    const traceId = options.traceId ?? randomUUID();
    const signal = this.acquireScope(options.scopeKey, options.signal);
    try {
      const messages = await this.buildInputMessages(options.threadId, options.input, options.context);
      yield* this.executeStream(
        traceId,
        options.threadId,
        "run",
        { messages },
        signal,
        buildRunSnapshotPreview(options.input),
      );
    } finally {
      this.releaseScope(options.scopeKey, signal);
    }
  }

  async *streamResume(options: StreamResumeOptions): AsyncGenerator<ServiceStreamEvent> {
    const traceId = options.traceId ?? randomUUID();
    const signal = this.acquireScope(options.scopeKey, options.signal);
    try {
      yield* this.executeStream(
        traceId,
        options.threadId,
        "resume",
        new Command({ resume: normalizeHitlResponse(options.resume) }),
        signal,
        buildResumeSnapshotPreview(options.resume),
      );
    } finally {
      this.releaseScope(options.scopeKey, signal);
    }
  }

  // ---------------------------------------------------------------------------
  // Interruption scope management
  // ---------------------------------------------------------------------------

  /**
   * Acquire an interruption scope. If `scopeKey` is provided and another request
   * is already active with the same key, the old request is aborted first.
   *
   * Returns the AbortSignal to use for this request (composing the caller's
   * optional signal with the scope's controller).
   */
  private acquireScope(
    scopeKey: string | undefined,
    callerSignal: AbortSignal | undefined,
  ): AbortSignal | undefined {
    if (!scopeKey) return callerSignal;

    // Abort any previous request occupying this scope.
    const existing = this.activeScopes.get(scopeKey);
    if (existing) {
      log.info("scope.preempt", { scopeKey });
      existing.abort();
    }

    const controller = new AbortController();
    this.activeScopes.set(scopeKey, controller);

    // If the caller also has a signal (e.g. HTTP client disconnect), compose them:
    // either signal aborting should cancel this request.
    if (callerSignal) {
      const onCallerAbort = () => controller.abort();
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      // Clean up listener when our controller aborts independently.
      controller.signal.addEventListener(
        "abort",
        () => callerSignal.removeEventListener("abort", onCallerAbort),
        { once: true },
      );
    }

    return controller.signal;
  }

  /** Release an interruption scope when the request finishes (normally or via abort). */
  private releaseScope(
    scopeKey: string | undefined,
    signal: AbortSignal | undefined,
  ): void {
    if (!scopeKey) return;
    // Only remove if we're still the active occupant (another request may have
    // already preempted us and replaced the entry).
    const current = this.activeScopes.get(scopeKey);
    if (current && current.signal === signal) {
      this.activeScopes.delete(scopeKey);
    }
  }

  resetThread(threadId: string): void {
    this.emittedMessageCountByThread.delete(threadId);
    this.lastTokenUsageByThread.delete(threadId);
  }

  /**
   * Compute the token budget available for memory injection.
   *
   * The budget adapts based on actual context usage:
   * - New thread (no prior usage): full budget (~800 tokens)
   * - Deep conversation: budget shrinks as prompt_tokens grows
   * - Context-tight: budget drops to 0, memory is skipped entirely
   */
  private computeMemoryBudget(
    threadId: string,
    environmentTokens: number,
  ): number {
    const windowSize = this.contextWindowSize;
    const lastUsage = this.lastTokenUsageByThread.get(threadId);
    const currentUsage = lastUsage?.promptTokens ?? 0;

    // Reserve 30% of window for new turn output + overhead
    const available = windowSize * 0.7 - currentUsage - environmentTokens;

    // Memory gets at most 15% of available space, hard-capped at 800 tokens
    const budget = Math.min(available * 0.15, 800);

    return Math.max(0, Math.round(budget));
  }

  /**
   * Build the input messages array for a run.
   *
   * Injection order: <memory> → <environment> → user input.
   * Memory is loaded from the cross-session MemoryStore with an adaptive
   * token budget that shrinks as context usage grows.
   */
  private async buildInputMessages(
    threadId: string,
    input: UserInput,
    context?: string,
  ): Promise<Array<{ role: string; content: string | ContentBlock[] }>> {
    // Extract the text portion for memory/environment injection
    const rawText = extractTextFromInput(input);

    let enrichedText = rawText;

    // 1. Compute adaptive memory budget
    const envTokens = context ? estimateTokens(context) : 0;
    const memoryBudget = this.computeMemoryBudget(threadId, envTokens);

    // 2. Inject cross-session memories if budget allows
    if (memoryBudget > 0) {
      const memories = await this.runtime.memoryStore.selectForInjection(memoryBudget);
      const memoryBlock = MemoryStore.formatForInjection(memories);
      if (memoryBlock) {
        const estimatedTokens = estimateTokens(memoryBlock);
        enrichedText = `<memory>\n${memoryBlock}\n</memory>\n\n${enrichedText}`;
        this.lastMemoryInjectionByThread.set(threadId, {
          threadId,
          updatedAt: new Date().toISOString(),
          budgetTokens: memoryBudget,
          skipped: false,
          reason: "injected",
          estimatedTokens,
          entries: memories,
        });
        log.debug("memory.injected", {
          threadId,
          count: memories.length,
          budgetTokens: memoryBudget,
          estimatedTokens,
        });
      } else {
        this.lastMemoryInjectionByThread.set(threadId, {
          threadId,
          updatedAt: new Date().toISOString(),
          budgetTokens: memoryBudget,
          skipped: true,
          reason: "no_entries",
          estimatedTokens: 0,
          entries: [],
        });
      }
    } else {
      this.lastMemoryInjectionByThread.set(threadId, {
        threadId,
        updatedAt: new Date().toISOString(),
        budgetTokens: memoryBudget,
        skipped: true,
        reason: "budget_zero",
        estimatedTokens: 0,
        entries: [],
      });
      log.debug("memory.skipped", { threadId, budgetTokens: memoryBudget });
    }

    // 3. Inject environment context
    if (context) {
      enrichedText = `<environment>\n${context}\n</environment>\n\n${enrichedText}`;
    }

    // 4. Build final content
    if (typeof input === "string") {
      // Plain text path — same as before
      return [{ role: "user", content: enrichedText }];
    }

    // Multimodal path — rebuild content blocks with enriched text + original image blocks.
    // For non-vision models (Gemma, etc.) image blocks are stripped — the client-side
    // media pipeline has already injected [Image: OCR text] into the text portion.
    const imageBlocks = input.filter(
      (b): b is Extract<ContentBlock, { type: "image_url" }> => b.type === "image_url",
    );
    const supportsVision = this.runtime.settings.modelSupportsVision;
    const keptImages = supportsVision ? imageBlocks : [];
    const content: ContentBlock[] = [
      { type: "text", text: enrichedText },
      ...keptImages,
    ];
    log.debug("multimodal.input", {
      threadId,
      textBlocks: 1,
      imageBlocks: imageBlocks.length,
      keptImages: keptImages.length,
      supportsVision,
    });
    return [{ role: "user", content }];
  }

  /**
   * Fire-and-forget: extract memorable facts from the user messages in
   * this turn and write them to the cross-session memory store.
   * Errors are logged but never propagated.
   */
  private extractMemoriesAsync(
    traceId: string,
    threadId: string,
    turnMessages: BaseMessage[],
  ): void {
    // Collect user message texts from this turn (skip <memory> and <environment> tags)
    const userTexts: string[] = [];
    for (const msg of turnMessages) {
      if (!("content" in msg) || msg._getType() !== "human") continue;
      const raw = typeof msg.content === "string" ? msg.content : "";
      // Strip injected XML tags to get the actual user input
      const cleaned = raw
        .replace(/<memory>[\s\S]*?<\/memory>\s*/g, "")
        .replace(/<environment>[\s\S]*?<\/environment>\s*/g, "")
        .trim();
      if (cleaned.length > 0) {
        userTexts.push(cleaned);
      }
    }

    if (userTexts.length === 0) return;

    extractAndWriteMemories(userTexts, {
      store: this.runtime.memoryStore,
      threadId,
      traceId,
    }).catch((err) => {
      log.warn("memory.write.failed", {
        traceId,
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async executeLoop(
    traceId: string,
    mode: "run" | "resume",
    threadId: string,
    initialRequest: Command | { messages: Array<{ role: string; content: string | ContentBlock[] }> },
    onInterrupt: ServiceInterruptHandler | undefined,
    maxInterrupts: number,
    inputPreview?: string,
  ): Promise<ServiceRunResult> {
    let request = initialRequest;
    let interruptCount = 0;
    let lastMessages: BaseMessage[] = [];
    const initialMessageCount = this.emittedMessageCountByThread.get(threadId) ?? 0;
    let turnMessages: BaseMessage[] = [];
    let contextCompaction = await this.getThreadContextCompaction(threadId);
    const startedAt = Date.now();

    await this.startRunSnapshot(traceId, threadId, mode, inputPreview);

    await this.runtime.traceRecorder.record({
      timestamp: new Date(startedAt).toISOString(),
      traceId,
      threadId,
      kind: "run_started",
      mode,
      model: this.runtime.settings.model,
      workspaceDir: this.runtime.settings.workspaceDir,
      payload: {
        maxInterrupts,
        agentGraphVersion: this.runtime.settings.agentGraphVersion,
      },
    });

    try {
      this.validateInitialRequest(traceId, threadId, mode, initialRequest);
      log.info("executeLoop.start", { traceId, threadId, mode, maxInterrupts });

      while (true) {
        let result: InvokeResultLike;
        const invokeStart = Date.now();
        try {
          result = await withRetry(
            () =>
              this.runtime.agent.invoke(request, {
                version: this.runtime.settings.agentGraphVersion,
              configurable: {
                thread_id: threadId,
                trace_id: traceId,
              },
            }),
            {
              maxAttempts: 3,
              baseDelayMs: 1000,
              maxDelayMs: 8000,
              retryableError: isTransientLmStudioError,
              onRetry: (attempt, error, delayMs) => {
                void this.runtime.traceRecorder.record({
                  timestamp: new Date().toISOString(),
                  traceId,
                  threadId,
                  kind: "retry_attempted",
                  mode,
                  payload: {
                    attempt,
                    error: error instanceof Error ? error.message : String(error),
                    delayMs,
                  },
                });
              },
            },
          );
        } catch (invokeError) {
          // If the error is a context-size-exceeded error, attempt recovery
          // by triggering compaction and retrying once.
          if (!isContextSizeExceededError(invokeError)) {
            throw invokeError;
          }

          log.warn("context.exceeded", { traceId, threadId, error: invokeError instanceof Error ? invokeError.message : String(invokeError) });
          const hint = buildCompactionHint(contextCompaction);
          await this.runtime.traceRecorder.record({
            timestamp: new Date().toISOString(),
            traceId,
            threadId,
            kind: "context_recovery",
            mode,
            payload: {
              trigger: "context_size_exceeded",
              compactionHint: hint,
              originalError:
                invokeError instanceof Error ? invokeError.message : String(invokeError),
            },
          });

          // Force a compaction cycle by re-invoking with a compaction hint.
          // The summarization middleware in deepagentsjs should pick this up
          // if the context was too large.
          try {
            result = await this.runtime.agent.invoke(request, {
              version: this.runtime.settings.agentGraphVersion,
              configurable: {
                thread_id: threadId,
                trace_id: traceId,
              },
            });
          } catch (retryError) {
            await this.runtime.traceRecorder.record({
              timestamp: new Date().toISOString(),
              traceId,
              threadId,
              kind: "context_recovery",
              mode,
              payload: {
                trigger: "recovery_failed",
                error: retryError instanceof Error ? retryError.message : String(retryError),
              },
            });
            throw retryError;
          }
        }

        log.debug("invoke.ok", { traceId, threadId, durationMs: Date.now() - invokeStart });

        const messages = toBaseMessages(result);

        // Capture token usage from the LLM response
        const tokenUsage = extractTokenUsage(messages);
        if (tokenUsage) {
          this.lastTokenUsageByThread.set(threadId, tokenUsage);
          log.debug("token.usage", {
            traceId,
            threadId,
            promptTokens: tokenUsage.promptTokens,
            completionTokens: tokenUsage.completionTokens,
            totalTokens: tokenUsage.totalTokens,
            windowSize: this.contextWindowSize,
            usagePercent: Math.round((tokenUsage.promptTokens / this.contextWindowSize) * 100),
          });
        }

        const { newMessages } = this.peekNewMessages(threadId, messages);
        this.runtime.guardrails.validateMessages(newMessages, {
          traceId,
          threadId,
          mode,
          source: "invoke_result",
        });
        this.commitMessageCount(threadId, messages.length);
        turnMessages = messages.slice(initialMessageCount);
        lastMessages = messages;

        // Detect & patch Gemma 4 tool call fallback patterns in new AI messages.
        // If patched, updateState writes the corrected message back and we
        // re-invoke so LangGraph's tools node executes the tool calls.
        const fallbackApplied = await this.applyFallbackToolCalls(
          traceId,
          threadId,
          mode,
          newMessages,
        );
        if (fallbackApplied) {
          log.info("fallback.applied", { traceId, threadId });
          // Continue the loop — next invoke will trigger the tools node.
          request = null as unknown as typeof request;
          continue;
        }

        contextCompaction = await this.captureContextCompaction(
          traceId,
          threadId,
          mode,
          contextCompaction,
        );

        const rawInterruptRequest = extractInterruptRequest(result);
        const interruptRequest = rawInterruptRequest
          ? enrichHitlRequest(rawInterruptRequest)
          : null;
        if (!interruptRequest) {
          const completed: ServiceRunResult = {
            traceId,
            status: "completed",
            threadId,
            interruptCount,
            messages: lastMessages,
            newMessages: turnMessages,
            contextCompaction: contextCompaction ?? undefined,
          };
          const completedUsage = this.lastTokenUsageByThread.get(threadId);
          await this.runtime.traceRecorder.record({
            timestamp: new Date().toISOString(),
            traceId,
            threadId,
            kind: "run_completed",
            mode,
            durationMs: Date.now() - startedAt,
            interruptCount,
            payload: {
              messageCount: lastMessages.length,
              newMessageCount: turnMessages.length,
              ...(completedUsage ? {
                tokenUsage: completedUsage,
                contextUsagePercent: Math.round((completedUsage.promptTokens / this.contextWindowSize) * 100),
              } : {}),
            },
          });

          // Fire-and-forget: extract memorable facts from user messages
          this.extractMemoriesAsync(traceId, threadId, turnMessages);
          await this.finalizeRunSnapshot(traceId, "completed");
          return completed;
        }

        const rejectResolvedMessages = await this.resolveRepeatedRejectedInterrupt(
          threadId,
          messages,
          newMessages,
          interruptRequest,
        );
        if (rejectResolvedMessages) {
          lastMessages = rejectResolvedMessages;
          turnMessages = rejectResolvedMessages.slice(initialMessageCount);
          this.commitMessageCount(threadId, rejectResolvedMessages.length);

          const completed: ServiceRunResult = {
            traceId,
            status: "completed",
            threadId,
            interruptCount,
            messages: lastMessages,
            newMessages: turnMessages,
            contextCompaction: contextCompaction ?? undefined,
          };
          const completedUsage = this.lastTokenUsageByThread.get(threadId);
          await this.runtime.traceRecorder.record({
            timestamp: new Date().toISOString(),
            traceId,
            threadId,
            kind: "run_completed",
            mode,
            durationMs: Date.now() - startedAt,
            interruptCount,
            payload: {
              messageCount: lastMessages.length,
              newMessageCount: turnMessages.length,
              autoResolvedRejectedRetry: true,
              ...(completedUsage
                ? {
                    tokenUsage: completedUsage,
                    contextUsagePercent: Math.round(
                      (completedUsage.promptTokens / this.contextWindowSize) * 100,
                    ),
                  }
                : {}),
            },
          });

          this.extractMemoriesAsync(traceId, threadId, turnMessages);
          await this.finalizeRunSnapshot(traceId, "completed");
          return completed;
        }

        interruptCount += 1;
        if (interruptCount > maxInterrupts) {
          throw new Error(`Exceeded max interrupt count (${maxInterrupts}) for thread ${threadId}`);
        }

        if (!onInterrupt) {
          const interrupted: ServiceRunResult = {
            traceId,
            status: "interrupted",
            threadId,
            interruptCount,
            messages: lastMessages,
            newMessages: turnMessages,
            interruptRequest,
            contextCompaction: contextCompaction ?? undefined,
          };
          await this.runtime.traceRecorder.record({
            timestamp: new Date().toISOString(),
            traceId,
            threadId,
            kind: "run_interrupted",
            mode,
            durationMs: Date.now() - startedAt,
            interruptCount,
            payload: {
              actionRequestCount: interruptRequest.actionRequests.length,
            },
          });
          await this.finalizeRunSnapshot(traceId, "interrupted");
          return interrupted;
        }

        const resume = await onInterrupt(interruptRequest, {
          traceId,
          threadId,
          interruptCount,
          messages: lastMessages,
          newMessages: turnMessages,
        });

        if (!resume) {
          const interrupted: ServiceRunResult = {
            traceId,
            status: "interrupted",
            threadId,
            interruptCount,
            messages: lastMessages,
            newMessages: turnMessages,
            interruptRequest,
            contextCompaction: contextCompaction ?? undefined,
          };
          await this.runtime.traceRecorder.record({
            timestamp: new Date().toISOString(),
            traceId,
            threadId,
            kind: "run_interrupted",
            mode,
            durationMs: Date.now() - startedAt,
            interruptCount,
            payload: {
              actionRequestCount: interruptRequest.actionRequests.length,
            },
          });
          await this.finalizeRunSnapshot(traceId, "interrupted");
          return interrupted;
        }

        request = new Command({
          resume: normalizeHitlResponse(resume, interruptRequest.actionRequests),
        });
      }
    } catch (error) {
      await this.recordGuardrailViolation(traceId, threadId, mode, error);
      await this.runtime.traceRecorder.record({
        timestamp: new Date().toISOString(),
        traceId,
        threadId,
        kind: "run_failed",
        mode,
        durationMs: Date.now() - startedAt,
        interruptCount,
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      await this.finalizeRunSnapshot(traceId, "failed");
      throw error;
    }
  }

  private peekNewMessages(
    threadId: string,
    messages: BaseMessage[],
  ): { previousCount: number; newMessages: BaseMessage[] } {
    const previousCount = this.emittedMessageCountByThread.get(threadId) ?? 0;
    return {
      previousCount,
      newMessages: messages.slice(previousCount),
    };
  }

  private commitMessageCount(threadId: string, messageCount: number): void {
    this.emittedMessageCountByThread.set(threadId, messageCount);
  }

  private async *executeStream(
    traceId: string,
    threadId: string,
    mode: "run" | "resume",
    input: Command | { messages: Array<{ role: string; content: string | ContentBlock[] }> },
    signal?: AbortSignal,
    inputPreview?: string,
  ): AsyncGenerator<ServiceStreamEvent> {
    if (typeof this.runtime.agent.streamEvents !== "function") {
      throw new Error("Runtime agent does not support streamEvents().");
    }

    const startedAt = Date.now();
    const initialMessageCount = this.emittedMessageCountByThread.get(threadId) ?? 0;
    let contextCompaction = await this.getThreadContextCompaction(threadId);

    await this.startRunSnapshot(traceId, threadId, mode, inputPreview);

    yield {
      type: "run_started",
      traceId,
      threadId,
      mode,
    };
    await this.runtime.traceRecorder.record({
      timestamp: new Date(startedAt).toISOString(),
      traceId,
      threadId,
      kind: "run_started",
      mode,
      model: this.runtime.settings.model,
      workspaceDir: this.runtime.settings.workspaceDir,
      payload: {
        agentGraphVersion: this.runtime.settings.agentGraphVersion,
      },
    });

    try {
      this.validateInitialRequest(traceId, threadId, mode, input);

      const stream = await withRetry(
        () =>
          this.runtime.agent.streamEvents!(input, {
            version: this.runtime.settings.agentGraphVersion,
            configurable: {
              thread_id: threadId,
              trace_id: traceId,
            },
            signal,
          }) as Promise<AsyncIterable<StreamEvent>>,
        {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 8000,
          retryableError: isTransientLmStudioError,
          onRetry: (attempt, error, delayMs) => {
            void this.runtime.traceRecorder.record({
              timestamp: new Date().toISOString(),
              traceId,
              threadId,
              kind: "retry_attempted",
              mode,
              payload: {
                attempt,
                error: error instanceof Error ? error.message : String(error),
                delayMs,
              },
            });
          },
        },
      );

      let lastResult: InvokeResultLike | null = null;
      let streamedOutput = "";

      for await (const event of stream) {
        // Active abort check — covers cases where the underlying LLM stream
        // does not natively respect the AbortSignal (e.g. some LangChain providers).
        if (signal?.aborted) {
          log.info("stream.aborted", { traceId, threadId });
          break;
        }

        const maybeResult = maybeGetInvokeResult(event);
        if (maybeResult) {
          lastResult = maybeResult;
        }

        if (event.event === "on_chat_model_stream" || event.event === "on_llm_stream") {
          const delta = extractTextDelta(event);
          if (delta) {
            const nextOutput = `${streamedOutput}${delta}`;
            this.runtime.guardrails.validateOutputText(nextOutput, {
              traceId,
              threadId,
              mode,
              source: "stream_text_delta",
            });
            streamedOutput = nextOutput;
            await this.runtime.traceRecorder.record({
              timestamp: new Date().toISOString(),
              traceId,
              threadId,
              kind: "text_delta",
              mode,
              payload: {
                runId: event.run_id,
                nodeName: event.name,
                deltaChars: delta.length,
                deltaPreview: summarizeValue(delta, 160),
              },
            });
            yield {
              type: "text_delta",
              traceId,
              threadId,
              delta,
              runId: event.run_id,
              nodeName: event.name,
            };
          }
          continue;
        }

        if (event.event === "on_tool_start") {
          await this.runtime.traceRecorder.record({
            timestamp: new Date().toISOString(),
            traceId,
            threadId,
            kind: "tool_started",
            mode,
            payload: {
              runId: event.run_id,
              toolName: event.name,
              inputPreview: summarizeValue(event.data?.input),
            },
          });
          yield {
            type: "tool_started",
            traceId,
            threadId,
            toolName: event.name,
            input: event.data?.input,
            runId: event.run_id,
          };
          continue;
        }

        if (event.event === "on_tool_end") {
          const toolOutput = contentToText(event.data?.output);
          if (toolOutput) {
            const nextOutput = `${streamedOutput}${toolOutput}`;
            this.runtime.guardrails.validateOutputText(nextOutput, {
              traceId,
              threadId,
              mode,
              source: "stream_tool_output",
            });
            streamedOutput = nextOutput;
          }
          await this.runtime.traceRecorder.record({
            timestamp: new Date().toISOString(),
            traceId,
            threadId,
            kind: "tool_finished",
            mode,
            payload: {
              runId: event.run_id,
              toolName: event.name,
              outputPreview: summarizeValue(event.data?.output),
            },
          });
          yield {
            type: "tool_finished",
            traceId,
            threadId,
            toolName: event.name,
            output: event.data?.output,
            runId: event.run_id,
          };
          continue;
        }

        if (event.event === "on_tool_error") {
          await this.runtime.traceRecorder.record({
            timestamp: new Date().toISOString(),
            traceId,
            threadId,
            kind: "tool_failed",
            mode,
            payload: {
              runId: event.run_id,
              toolName: event.name,
              error: summarizeValue(event.data?.error),
            },
          });
          yield {
            type: "tool_failed",
            traceId,
            threadId,
            toolName: event.name,
            error: event.data?.error,
            runId: event.run_id,
          };
        }
      }

      // If streaming didn't capture a final result with messages,
      // fall back to reading graph state directly (also needed for __interrupt__).
      if (!lastResult || !Array.isArray(lastResult.messages) || lastResult.messages.length === 0) {
        if (typeof this.runtime.agent.getState === "function") {
          const state = await this.runtime.agent.getState({
            configurable: { thread_id: threadId },
          });
          if (state) {
            const vals = state.values as { messages?: unknown[] } | undefined;
            const interruptsFromState = extractInterruptsFromTasks(state.tasks);
            lastResult = {
              messages: vals?.messages ?? [],
              __interrupt__: interruptsFromState,
            };
          }
        }
      }

      // Even if we have a result from stream events, check graph state for interrupts
      // since __interrupt__ is often not present in streaming output events.
      if (lastResult && !lastResult.__interrupt__?.length) {
        if (typeof this.runtime.agent.getState === "function") {
          const state = await this.runtime.agent.getState({
            configurable: { thread_id: threadId },
          });
          const interruptsFromState = extractInterruptsFromTasks(state?.tasks);
          if (interruptsFromState.length > 0) {
            lastResult = {
              ...lastResult,
              __interrupt__: interruptsFromState,
            };
          }
        }
      }

      if (!lastResult) {
        throw new Error("Streaming run completed without a final graph result.");
      }

      const messages = toBaseMessages(lastResult);
      const tokenUsage = extractTokenUsage(messages);
      if (tokenUsage) {
        this.lastTokenUsageByThread.set(threadId, tokenUsage);
      }
      const { newMessages } = this.peekNewMessages(threadId, messages);
      this.runtime.guardrails.validateMessages(newMessages, {
        traceId,
        threadId,
        mode,
        source: "stream_result",
      });
      this.commitMessageCount(threadId, messages.length);

      // Detect & patch Gemma 4 tool call fallback patterns.
      // In streaming mode we log and patch state but don't re-invoke (the
      // stream has already finished).  The next user-initiated run/resume
      // will pick up the patched tool_calls.
      await this.applyFallbackToolCalls(traceId, threadId, mode, newMessages);

      const nextContextCompaction = await this.captureContextCompaction(
        traceId,
        threadId,
        mode,
        contextCompaction,
      );
      if (!sameContextCompactionSnapshot(contextCompaction, nextContextCompaction)) {
        contextCompaction = nextContextCompaction;
        if (contextCompaction) {
          yield {
            type: "context_compacted",
            traceId,
            threadId,
            contextCompaction,
          };
        }
      } else {
        contextCompaction = nextContextCompaction;
      }
      const rawInterruptRequest = extractInterruptRequest(lastResult);
      const interruptRequest = rawInterruptRequest
        ? enrichHitlRequest(rawInterruptRequest)
        : undefined;
      const rejectResolvedMessages = interruptRequest
        ? await this.resolveRepeatedRejectedInterrupt(
            threadId,
            messages,
            newMessages,
            interruptRequest,
          )
        : null;
      const finalMessages = rejectResolvedMessages ?? messages;
      const finalNewMessages = finalMessages.slice(initialMessageCount);
      if (rejectResolvedMessages) {
        this.commitMessageCount(threadId, finalMessages.length);
      }
      const result: ServiceRunResult = {
        traceId,
        status: interruptRequest && !rejectResolvedMessages ? "interrupted" : "completed",
        threadId,
        interruptCount: interruptRequest && !rejectResolvedMessages ? 1 : 0,
        messages: finalMessages,
        newMessages: finalNewMessages,
        interruptRequest: rejectResolvedMessages ? undefined : interruptRequest,
        contextCompaction: contextCompaction ?? undefined,
      };

      if (interruptRequest && !rejectResolvedMessages) {
        await this.runtime.traceRecorder.record({
          timestamp: new Date().toISOString(),
          traceId,
          threadId,
          kind: "run_interrupted",
          mode,
          durationMs: Date.now() - startedAt,
          interruptCount: 1,
          payload: {
            actionRequestCount: interruptRequest.actionRequests.length,
          },
        });
        await this.finalizeRunSnapshot(traceId, "interrupted");
        yield {
          type: "run_interrupted",
          traceId,
          threadId,
          result,
        };
        return;
      }

      await this.runtime.traceRecorder.record({
        timestamp: new Date().toISOString(),
        traceId,
        threadId,
        kind: "run_completed",
        mode,
        durationMs: Date.now() - startedAt,
        interruptCount: 0,
        payload: {
          messageCount: finalMessages.length,
          newMessageCount: finalNewMessages.length,
          ...(rejectResolvedMessages ? { autoResolvedRejectedRetry: true } : {}),
          ...(tokenUsage
            ? {
                tokenUsage,
                contextUsagePercent: Math.round(
                  (tokenUsage.promptTokens / this.contextWindowSize) * 100,
                ),
              }
            : {}),
        },
      });
      // Fire-and-forget: extract memorable facts from user messages
      this.extractMemoriesAsync(traceId, threadId, finalNewMessages);
      await this.finalizeRunSnapshot(traceId, "completed");

      yield {
        type: "run_completed",
        traceId,
        threadId,
        result,
      };
    } catch (error) {
      await this.recordGuardrailViolation(traceId, threadId, mode, error);
      await this.runtime.traceRecorder.record({
        timestamp: new Date().toISOString(),
        traceId,
        threadId,
        kind: "run_failed",
        mode,
        durationMs: Date.now() - startedAt,
        payload: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      await this.finalizeRunSnapshot(traceId, "failed");
      throw error;
    }
  }

  private async startRunSnapshot(
    traceId: string,
    threadId: string,
    mode: "run" | "resume",
    inputPreview?: string,
  ): Promise<void> {
    if (!this.runtime.runSnapshots) {
      return;
    }

    try {
      await this.runtime.runSnapshots.startRun({
        traceId,
        threadId,
        mode,
        inputPreview,
      });
    } catch (error) {
      log.warn("runSnapshot.start.failed", {
        traceId,
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async finalizeRunSnapshot(
    traceId: string,
    status: Exclude<RunSnapshotStatus, "running">,
  ): Promise<void> {
    if (!this.runtime.runSnapshots) {
      return;
    }

    try {
      await this.runtime.runSnapshots.finalizeRun(traceId, status);
    } catch (error) {
      log.warn("runSnapshot.finalize.failed", {
        traceId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolveRepeatedRejectedInterrupt(
    threadId: string,
    messages: BaseMessage[],
    newMessages: BaseMessage[],
    interruptRequest: HITLRequest,
  ): Promise<BaseMessage[] | null> {
    if (typeof this.runtime.agent.updateState !== "function") {
      return null;
    }

    const repeatedAiMessage = [...newMessages]
      .reverse()
      .find(
        (message): message is AIMessage =>
          AIMessage.isInstance(message) &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.length > 0,
      );
    if (!repeatedAiMessage?.id) {
      return null;
    }

    const rejectionMessage = [...newMessages].reverse().find(isRejectedToolMessage);
    if (!rejectionMessage) {
      return null;
    }

    const rejectionIndex = messages.findIndex((message) => message.id === rejectionMessage.id);
    if (rejectionIndex <= 0) {
      return null;
    }

    const previousAttemptMessage = messages
      .slice(0, rejectionIndex)
      .reverse()
      .find(
        (message): message is AIMessage =>
          AIMessage.isInstance(message) &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.length > 0,
      );
    if (!previousAttemptMessage) {
      return null;
    }

    const previousActions = extractActionRequestsFromToolCalls(previousAttemptMessage);
    const repeatedActions = extractActionRequestsFromToolCalls(repeatedAiMessage);
    if (
      previousActions.length === 0 ||
      !sameActionRequests(previousActions, repeatedActions) ||
      !sameActionRequests(repeatedActions, interruptRequest.actionRequests)
    ) {
      return null;
    }

    const acknowledgement = new AIMessage({
      content: buildRejectedActionAcknowledgement(repeatedActions),
      name: repeatedAiMessage.name,
    });

    await this.runtime.agent.updateState(
      { configurable: { thread_id: threadId } },
      {
        messages: [
          new RemoveMessage({ id: repeatedAiMessage.id }),
          acknowledgement,
        ],
      },
    );

    return replaceMessageById(messages, repeatedAiMessage.id, acknowledgement);
  }

  private validateInitialRequest(
    traceId: string,
    threadId: string,
    mode: "run" | "resume",
    request: Command | { messages: Array<{ role: string; content: string | ContentBlock[] }> },
  ): void {
    if ("messages" in request) {
      const inputText = request.messages
        .map((message) => {
          if (typeof message.content === "string") return message.content;
          return extractTextFromInput(message.content);
        })
        .join("\n")
        .trim();
      if (!inputText) {
        return;
      }
      this.runtime.guardrails.validateInputText(inputText, {
        traceId,
        threadId,
        mode,
        source: "user_input",
      });
    }
  }

  private async recordGuardrailViolation(
    traceId: string,
    threadId: string,
    mode: "run" | "resume",
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof GuardrailViolationError)) {
      return;
    }

    error.violation.traceId ??= traceId;
    await this.runtime.traceRecorder.record({
      timestamp: new Date().toISOString(),
      traceId,
      threadId,
      kind: "guardrail_triggered",
      mode,
      payload: {
        phase: error.violation.phase,
        rule: error.violation.rule,
        source: error.violation.source,
        limit: error.violation.limit,
        actual: error.violation.actual,
        term: error.violation.term,
      },
    });
  }

  private async getThreadContextCompaction(
    threadId: string,
  ): Promise<ContextCompactionSnapshot | null> {
    if (typeof this.runtime.agent.getState !== "function") {
      return null;
    }

    try {
      const snapshot = await this.runtime.agent.getState({
        configurable: {
          thread_id: threadId,
        },
      });
      return extractContextCompactionSnapshot(snapshot?.values);
    } catch {
      return null;
    }
  }

  private async captureContextCompaction(
    traceId: string,
    threadId: string,
    mode: "run" | "resume",
    previous: ContextCompactionSnapshot | null,
  ): Promise<ContextCompactionSnapshot | null> {
    const current = await this.getThreadContextCompaction(threadId);
    if (!current || sameContextCompactionSnapshot(previous, current)) {
      return current;
    }

    await this.runtime.traceRecorder.record({
      timestamp: new Date().toISOString(),
      traceId,
      threadId,
      kind: "context_compacted",
      mode,
      payload: {
        sessionId: current.sessionId,
        cutoffIndex: current.cutoffIndex,
        filePath: current.filePath,
        summaryPreview: current.summaryPreview,
      },
    });
    return current;
  }

  /**
   * Scan new messages for Gemma 4 tool call patterns embedded in content.
   * When detected:
   *   1. Record a diagnostic trace event.
   *   2. Patch the AIMessage with proper `tool_calls`.
   *   3. Write the patched message back via `updateState` so LangGraph's
   *      tools node executes on the next loop iteration.
   *
   * Returns `true` when a fallback was applied and the caller should
   * continue the loop (i.e. re-invoke) instead of returning.
   */
  private async applyFallbackToolCalls(
    traceId: string,
    threadId: string,
    mode: "run" | "resume",
    messages: BaseMessage[],
  ): Promise<boolean> {
    for (const msg of messages) {
      if (!(msg instanceof AIMessage)) {
        continue;
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        continue;
      }
      const content = typeof msg.content === "string" ? msg.content : "";
      if (!content) {
        continue;
      }
      const fallbackCalls = extractFallbackToolCalls(content);
      if (!fallbackCalls) {
        continue;
      }

      // Patch the message so it carries proper tool_calls.
      const patched = patchMessageWithFallbackToolCalls(msg);
      if (patched === msg) {
        // patchMessageWithFallbackToolCalls returned the same ref — no change.
        continue;
      }

      await this.runtime.traceRecorder.record({
        timestamp: new Date().toISOString(),
        traceId,
        threadId,
        kind: "tool_call_fallback",
        mode,
        payload: {
          rawContentPreview: summarizeValue(content, 240),
          extractedCalls: fallbackCalls.map((c) => ({
            name: c.name,
            argKeys: Object.keys(c.args),
          })),
          callCount: fallbackCalls.length,
          patched: true,
        },
      });

      // Write the patched AIMessage back into the graph state so
      // the tools node picks up the tool_calls on the next invoke.
      if (typeof this.runtime.agent.updateState === "function") {
        await this.runtime.agent.updateState(
          { configurable: { thread_id: threadId } },
          { messages: [patched] },
          "agent",
        );
        return true; // signal: re-invoke to execute tools
      }

      // If updateState is not available, we can only log — the tools
      // will not be executed automatically.
      return false;
    }

    return false;
  }
}

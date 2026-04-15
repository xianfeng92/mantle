import { z } from "zod";

const healthSchema = z.object({
  ok: z.boolean(),
  service: z.string().optional(),
  model: z.string().optional(),
  promptProfile: z.string().optional(),
  contextWindowSize: z.number().optional(),
  workspaceDir: z.string().optional(),
  workspaceMode: z.enum(["repo", "workspace", "custom"]).optional(),
  virtualMode: z.boolean().optional(),
});

const diagnosticsSchema = z.object({
  eventsAnalyzed: z.number(),
  gemma4: z.object({
    toolCallFallbackCount: z.number(),
    retryCount: z.number(),
    contextRecoveryCount: z.number(),
    contextRecoveryFailures: z.number(),
  }),
  runs: z.object({
    completed: z.number(),
    failed: z.number(),
    avgDurationMs: z.number().nullable(),
    avgToolCallsPerCompletedRun: z.number().nullable(),
    maxToolCallsInRun: z.number().nullable(),
    avgGuiActionStepsPerCompletedRun: z.number().nullable(),
    maxGuiActionStepsInRun: z.number().nullable(),
  }),
  compaction: z.object({
    count: z.number(),
    ratePercent: z.number().nullable(),
  }),
  contextUsage: z.object({
    windowSize: z.number(),
    lastPromptTokens: z.number().nullable(),
    lastUsagePercent: z.number().nullable(),
    avgPromptTokens: z.number().nullable(),
    maxPromptTokens: z.number().nullable(),
    peakUsagePercent: z.number().nullable(),
    sampledRuns: z.number(),
  }),
  staging: z.object({
    selections: z.number(),
    byStage: z.record(z.string(), z.number()),
    budgetExhaustedCount: z.number(),
    guiStepBudget: z.number(),
  }),
  verification: z.object({
    passed: z.number(),
    failed: z.number(),
    passRatePercent: z.number().nullable(),
  }),
  recentErrors: z.array(
    z.object({
      timestamp: z.string(),
      kind: z.string(),
      error: z.string(),
    }),
  ),
});

const serializedMessageSchema = z.object({
  role: z.enum(["assistant", "user", "system", "tool", "unknown"]),
  text: z.string(),
  content: z.unknown(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.unknown().optional(),
});

const contextCompactionSchema = z.object({
  sessionId: z.string(),
  cutoffIndex: z.number(),
  filePath: z.string().optional(),
  summaryPreview: z.string(),
});

const actionRequestSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
});

const reviewConfigSchema = z.object({
  actionName: z.string(),
  allowedDecisions: z.array(z.enum(["approve", "edit", "reject"])),
  argsSchema: z.record(z.string(), z.unknown()).optional(),
});

const interruptRequestSchema = z.object({
  actionRequests: z.array(actionRequestSchema),
  reviewConfigs: z.array(reviewConfigSchema),
});

const runResultSchema = z.object({
  traceId: z.string(),
  status: z.enum(["completed", "interrupted"]),
  threadId: z.string(),
  interruptCount: z.number(),
  messages: z.array(serializedMessageSchema),
  newMessages: z.array(serializedMessageSchema),
  interruptRequest: interruptRequestSchema.optional(),
  contextCompaction: contextCompactionSchema.optional(),
});

const skillSourceSchema = z.object({
  absolutePath: z.string(),
  backendPath: z.string(),
});

const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  sourcePath: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
});

const skillsResponseSchema = z.object({
  sources: z.array(skillSourceSchema),
  skills: z.array(skillSchema),
});

const subagentSourceSchema = z.object({
  absolutePath: z.string(),
  backendPath: z.string(),
});

const subagentSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
  sourcePath: z.string(),
  model: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

const subagentsResponseSchema = z.object({
  generalPurposeAgent: z.object({
    enabled: z.boolean(),
    name: z.string(),
    description: z.string(),
    inheritedSkillSources: z.array(z.string()),
  }),
  sources: z.array(subagentSourceSchema),
  subagents: z.array(subagentSchema),
});

const runStartedSchema = z.object({
  traceId: z.string(),
  threadId: z.string(),
  mode: z.enum(["run", "resume"]),
});

const textDeltaSchema = z.object({
  traceId: z.string(),
  threadId: z.string(),
  delta: z.string(),
  runId: z.string(),
  nodeName: z.string(),
});

const toolEventSchema = z.object({
  traceId: z.string(),
  threadId: z.string(),
  toolName: z.string(),
  runId: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
});

const contextCompactedEventSchema = z.object({
  traceId: z.string(),
  threadId: z.string(),
  contextCompaction: contextCompactionSchema,
});

const errorEventSchema = z.object({
  error: z.string(),
  phase: z.string().optional(),
  rule: z.string().optional(),
  source: z.string().optional(),
  traceId: z.string().optional(),
  limit: z.number().optional(),
  actual: z.number().optional(),
  term: z.string().optional(),
});

export type AgentCoreHealth = z.infer<typeof healthSchema>;
export type AgentCoreDiagnostics = z.infer<typeof diagnosticsSchema>;
export type AgentCoreSerializedMessage = z.infer<typeof serializedMessageSchema>;
export type AgentCoreRunResult = z.infer<typeof runResultSchema>;
export type AgentCoreContextCompaction = z.infer<typeof contextCompactionSchema>;
export type AgentCoreInterruptRequest = z.infer<typeof interruptRequestSchema>;
export type AgentCoreSkillResponse = z.infer<typeof skillsResponseSchema>;
export type AgentCoreSubagentResponse = z.infer<typeof subagentsResponseSchema>;
export type AgentCoreActionRequest = z.infer<typeof actionRequestSchema>;
export type AgentCoreReviewConfig = z.infer<typeof reviewConfigSchema>;

export type AgentCoreHitlDecision =
  | { type: "approve" }
  | {
      type: "edit";
      editedAction: {
        name: string;
        args: Record<string, unknown>;
      };
    }
  | {
      type: "reject";
      message?: string;
    };

export interface AgentCoreHitlResponse {
  decisions: AgentCoreHitlDecision[];
}

export type AgentCoreStreamEvent =
  | {
      type: "run_started";
      data: z.infer<typeof runStartedSchema>;
    }
  | {
      type: "text_delta";
      data: z.infer<typeof textDeltaSchema>;
    }
  | {
      type: "tool_started" | "tool_finished" | "tool_failed";
      data: z.infer<typeof toolEventSchema>;
    }
  | {
      type: "context_compacted";
      data: z.infer<typeof contextCompactedEventSchema>;
    }
  | {
      type: "run_completed" | "run_interrupted";
      data: AgentCoreRunResult;
    }
  | {
      type: "error";
      data: z.infer<typeof errorEventSchema>;
    };

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function readJson<T>(
  response: Response,
  schema: z.ZodSchema<T>,
): Promise<T> {
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Agent Core returned invalid JSON (${response.status}).`);
  }

  if (!response.ok) {
    const errorMessage =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `Agent Core request failed (${response.status}).`;
    throw new Error(errorMessage);
  }

  return schema.parse(parsed);
}

function parseSseEvent(chunk: string): { event: string; data: string } | null {
  const normalized = chunk.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const event = lines
    .find((line) => line.startsWith("event: "))
    ?.slice("event: ".length)
    .trim();
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");

  if (!event || !data) {
    return null;
  }

  return { event, data };
}

function parseStreamEvent(eventName: string, rawData: unknown): AgentCoreStreamEvent {
  switch (eventName) {
    case "run_started":
      return { type: eventName, data: runStartedSchema.parse(rawData) };
    case "text_delta":
      return { type: eventName, data: textDeltaSchema.parse(rawData) };
    case "tool_started":
    case "tool_finished":
    case "tool_failed":
      return { type: eventName, data: toolEventSchema.parse(rawData) };
    case "context_compacted":
      return { type: eventName, data: contextCompactedEventSchema.parse(rawData) };
    case "run_completed":
    case "run_interrupted":
      return { type: eventName, data: runResultSchema.parse(rawData) };
    case "error":
      return { type: eventName, data: errorEventSchema.parse(rawData) };
    default:
      throw new Error(`Unsupported stream event: ${eventName}`);
  }
}

async function streamRequest(
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onEvent: (event: AgentCoreStreamEvent) => void | Promise<void>,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const message = await response.text();
    try {
      const parsed = JSON.parse(message) as { error?: string };
      throw new Error(parsed.error ?? `Agent Core request failed (${response.status}).`);
    } catch {
      throw new Error(message || `Agent Core request failed (${response.status}).`);
    }
  }

  if (!response.body) {
    throw new Error("Agent Core stream body is missing.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex >= 0) {
      const rawChunk = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const parsedChunk = parseSseEvent(rawChunk);
      if (parsedChunk) {
        const data = JSON.parse(parsedChunk.data) as unknown;
        await onEvent(parseStreamEvent(parsedChunk.event, data));
      }

      separatorIndex = buffer.indexOf("\n\n");
    }

    if (done) {
      if (buffer.trim()) {
        const parsedChunk = parseSseEvent(buffer);
        if (parsedChunk) {
          const data = JSON.parse(parsedChunk.data) as unknown;
          await onEvent(parseStreamEvent(parsedChunk.event, data));
        }
      }
      return;
    }
  }
}

export async function fetchHealth(baseUrl: string): Promise<AgentCoreHealth> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/health`);
  return readJson(response, healthSchema);
}

export async function fetchDiagnostics(
  baseUrl: string,
): Promise<AgentCoreDiagnostics> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/diagnostics`);
  return readJson(response, diagnosticsSchema);
}

export async function fetchSkills(
  baseUrl: string,
): Promise<AgentCoreSkillResponse> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/skills`);
  return readJson(response, skillsResponseSchema);
}

export async function fetchSubagents(
  baseUrl: string,
): Promise<AgentCoreSubagentResponse> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/subagents`);
  return readJson(response, subagentsResponseSchema);
}

/** OpenAI-compatible multimodal content block. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export async function streamRun(
  baseUrl: string,
  payload: {
    threadId: string;
    input: string | ContentBlock[];
  },
  options: {
    signal?: AbortSignal;
    onEvent: (event: AgentCoreStreamEvent) => void | Promise<void>;
  },
): Promise<void> {
  return streamRequest(
    `${normalizeBaseUrl(baseUrl)}/runs/stream`,
    payload,
    options.signal,
    options.onEvent,
  );
}

export async function streamResume(
  baseUrl: string,
  payload: {
    threadId: string;
    resume: AgentCoreHitlResponse;
  },
  options: {
    signal?: AbortSignal;
    onEvent: (event: AgentCoreStreamEvent) => void | Promise<void>;
  },
): Promise<void> {
  return streamRequest(
    `${normalizeBaseUrl(baseUrl)}/resume/stream`,
    payload,
    options.signal,
    options.onEvent,
  );
}

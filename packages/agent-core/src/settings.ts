import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_MODEL = "google/gemma-4-26b-a4b";
const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_API_KEY = "lm-studio";

export type AgentCorePromptProfile = "default" | "compact";
export type AgentCoreWorkspaceMode = "repo" | "workspace" | "custom";

export interface AgentCoreSettings {
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature: number;
  promptProfile: AgentCorePromptProfile;
  agentGraphVersion: "v1" | "v2";
  workspaceDir: string;
  workspaceMode: AgentCoreWorkspaceMode;
  dataDir: string;
  checkpointDbPath: string;
  sessionStatePath: string;
  traceLogPath: string;
  auditLogPath: string;
  movesLogPath: string;
  runSnapshotsDir: string;
  memoryFilePath: string;
  httpHost: string;
  httpPort: number;
  virtualMode: boolean;
  commandTimeoutSec: number;
  maxOutputBytes: number;
  maxInputChars: number;
  maxOutputChars: number;
  blockedInputTerms: string[];
  blockedOutputTerms: string[];
  skillSourcePaths: string[];
  subagentSourcePaths: string[];
  contextWindowTokensHint: number;
  verbose: boolean;
  initialThreadId?: string;
  sandboxLevel: 0 | 1 | 2;
  sandboxAllowedCommands: string[];
  sandboxBlockedPatterns: string[];
}

interface LoadSettingsOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseGraphVersion(raw: string | undefined): "v1" | "v2" {
  return raw === "v1" ? "v1" : "v2";
}

export function resolvePromptProfile(
  raw: string | undefined,
  model: string,
): AgentCorePromptProfile {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "compact") {
    return "compact";
  }
  if (normalized === "default" || normalized === "full") {
    return "default";
  }
  return /gemma/i.test(model) ? "compact" : "default";
}

function parseList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(/[\n,;]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function inferMonorepoSourcePaths(
  workspaceDir: string,
  explicitPaths: string[],
  fallbackSegments: string[],
): string[] {
  if (explicitPaths.length > 0) {
    return explicitPaths;
  }

  const candidate = path.join(workspaceDir, ...fallbackSegments);
  if (!existsSync(candidate)) {
    return [];
  }

  return [path.relative(workspaceDir, candidate) || "."];
}

export function loadSettings(options: LoadSettingsOptions = {}): AgentCoreSettings {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const model = env.AGENT_CORE_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL;
  const rawWorkspaceMode = env.AGENT_CORE_WORKSPACE_MODE?.trim().toLowerCase();
  const workspaceMode: AgentCoreWorkspaceMode =
    rawWorkspaceMode === "repo" || rawWorkspaceMode === "workspace"
      ? rawWorkspaceMode
      : "custom";

  const workspaceDir = path.resolve(
    cwd,
    env.AGENT_CORE_WORKSPACE_DIR || env.AGENT_CORE_ROOT_DIR || ".",
  );
  const dataDir = path.resolve(workspaceDir, env.AGENT_CORE_DATA_DIR || ".agent-core");
  const checkpointDbPath = env.AGENT_CORE_CHECKPOINT_DB_PATH
    ? path.resolve(workspaceDir, env.AGENT_CORE_CHECKPOINT_DB_PATH)
    : path.join(dataDir, "checkpoints.sqlite");
  const sessionStatePath = env.AGENT_CORE_SESSION_STATE_PATH
    ? path.resolve(workspaceDir, env.AGENT_CORE_SESSION_STATE_PATH)
    : path.join(dataDir, "session.json");
  const traceLogPath = env.AGENT_CORE_TRACE_LOG_PATH
    ? path.resolve(workspaceDir, env.AGENT_CORE_TRACE_LOG_PATH)
    : path.join(dataDir, "traces.jsonl");
  const auditLogPath = env.AGENT_CORE_AUDIT_LOG_PATH
    ? path.resolve(workspaceDir, env.AGENT_CORE_AUDIT_LOG_PATH)
    : path.join(dataDir, "audit.jsonl");
  const movesLogPath = env.AGENT_CORE_MOVES_LOG_PATH
    ? path.resolve(workspaceDir, env.AGENT_CORE_MOVES_LOG_PATH)
    : path.join(dataDir, "moves.jsonl");
  const runSnapshotsDir = env.AGENT_CORE_RUN_SNAPSHOTS_DIR
    ? path.resolve(workspaceDir, env.AGENT_CORE_RUN_SNAPSHOTS_DIR)
    : path.join(dataDir, "run-snapshots");
  const memoryFilePath = env.AGENT_CORE_MEMORY_FILE_PATH
    ? path.resolve(workspaceDir, env.AGENT_CORE_MEMORY_FILE_PATH)
    : path.join(dataDir, "memory.jsonl");
  const skillSourcePaths = inferMonorepoSourcePaths(
    workspaceDir,
    parseList(env.AGENT_CORE_SKILL_SOURCE_PATHS),
    ["packages", "agent-core", ".deepagents", "skills"],
  );
  const subagentSourcePaths = inferMonorepoSourcePaths(
    workspaceDir,
    parseList(env.AGENT_CORE_SUBAGENT_SOURCE_PATHS),
    ["packages", "agent-core", ".deepagents", "subagents"],
  );

  return {
    model,
    apiKey: env.AGENT_CORE_API_KEY || env.OPENAI_API_KEY || DEFAULT_API_KEY,
    baseUrl: env.AGENT_CORE_BASE_URL || env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    temperature: parseNumber(env.AGENT_CORE_TEMPERATURE, 0),
    promptProfile: resolvePromptProfile(env.AGENT_CORE_PROMPT_PROFILE, model),
    agentGraphVersion: parseGraphVersion(env.AGENT_CORE_AGENT_GRAPH_VERSION),
    workspaceDir,
    workspaceMode,
    dataDir,
    checkpointDbPath,
    sessionStatePath,
    traceLogPath,
    auditLogPath,
    movesLogPath,
    runSnapshotsDir,
    memoryFilePath,
    httpHost: env.AGENT_CORE_HTTP_HOST || "127.0.0.1",
    httpPort: parseNumber(env.AGENT_CORE_HTTP_PORT, 8787),
    virtualMode: parseBoolean(env.AGENT_CORE_VIRTUAL_MODE, true),
    commandTimeoutSec: parseNumber(env.AGENT_CORE_COMMAND_TIMEOUT_SEC, 120),
    maxOutputBytes: parseNumber(env.AGENT_CORE_MAX_OUTPUT_BYTES, 100_000),
    maxInputChars: parseNumber(env.AGENT_CORE_MAX_INPUT_CHARS, 20_000),
    maxOutputChars: parseNumber(env.AGENT_CORE_MAX_OUTPUT_CHARS, 80_000),
    blockedInputTerms: parseList(env.AGENT_CORE_BLOCKED_INPUT_TERMS),
    blockedOutputTerms: parseList(env.AGENT_CORE_BLOCKED_OUTPUT_TERMS),
    skillSourcePaths,
    subagentSourcePaths,
    contextWindowTokensHint: parseNumber(
      env.AGENT_CORE_CONTEXT_WINDOW_TOKENS_HINT,
      28_000,
    ),
    verbose: parseBoolean(env.AGENT_CORE_VERBOSE, true),
    initialThreadId: env.AGENT_CORE_THREAD_ID || undefined,
    sandboxLevel: Math.min(2, Math.max(0, parseNumber(env.AGENT_CORE_SANDBOX_LEVEL, 0))) as 0 | 1 | 2,
    sandboxAllowedCommands: env.AGENT_CORE_SANDBOX_ALLOWED_COMMANDS
      ? env.AGENT_CORE_SANDBOX_ALLOWED_COMMANDS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    sandboxBlockedPatterns: env.AGENT_CORE_SANDBOX_BLOCKED_PATTERNS
      ? env.AGENT_CORE_SANDBOX_BLOCKED_PATTERNS.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  };
}

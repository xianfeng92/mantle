import type { EvalResult } from "../eval/types.js";

export type LaunchWorkflowId =
  | "selection-rewrite"
  | "downloads-organize"
  | "context-todo";

export type LaunchLanguage = "zh" | "en";
export type LaunchOutputFormat =
  | "paragraph"
  | "bullet_list"
  | "summary_plus_bullets";

export interface LaunchCaseBase {
  caseId: string;
  title: string;
  expected: string;
}

export interface SelectionLaunchCase extends LaunchCaseBase {
  workflowId: "selection-rewrite";
  fixtureFile: string;
  instruction: string;
}

export interface DownloadsLaunchCase extends LaunchCaseBase {
  workflowId: "downloads-organize";
  fixtureDir: string;
  mode: "organize" | "rollback";
  sandboxFolder: string;
  planInstruction?: string;
  confirmInstruction?: string;
  seedCaseId?: string;
}

export interface ContextLaunchCase extends LaunchCaseBase {
  workflowId: "context-todo";
  fixtureFile: string;
  instruction: string;
}

export type LaunchBenchmarkCase =
  | SelectionLaunchCase
  | DownloadsLaunchCase
  | ContextLaunchCase;

export interface ContextFixture {
  frontmostApp: string;
  windowTitle: string;
  recentFiles: string[];
  selectedText?: string;
  conversationHint?: string;
  expectedTaskThemes: string[];
}

export interface LaunchExpectedCheck {
  caseId: string;
  language?: LaunchLanguage;
  outputFormat?: LaunchOutputFormat;
  requiredPatterns?: string[];
  forbiddenPatterns?: string[];
  minItems?: number;
  maxItems?: number;
  maxLengthRatio?: number;
  requireAudit?: boolean;
  requireMoveRecord?: boolean;
  allFilesMustRemainUnderSandbox?: boolean;
  minMoves?: number;
  maxMoves?: number;
  minCreatedDirectories?: number;
  rootShouldRetainAnyOf?: string[];
  seedCaseId?: string;
  requireRollbackToBaseline?: boolean;
  requireAllSeedMovesRolledBack?: boolean;
}

export interface PromptPack<TCase extends LaunchBenchmarkCase = LaunchBenchmarkCase> {
  promptTemplate: string;
  cases: TCase[];
  expectedChecks: Map<string, LaunchExpectedCheck>;
}

export interface LaunchHardCheckResult {
  name: string;
  passed: boolean;
  details?: string;
}

export interface LaunchRuntimeHealth {
  traceIds: string[];
  promptTokens: number | null;
  completionTokens: number | null;
  contextUsagePercent: number | null;
  toolCallCount: number;
  fallbackTriggered: boolean;
  retryTriggered: boolean;
  outOfBoundsMoveCount?: number;
  fileLossCount?: number;
  auditEntryCount?: number;
  moveRecordCount?: number;
  verificationPassRatePercent?: number | null;
}

export interface LaunchCaseArtifacts {
  artifactDir: string;
  runResultPath: string;
  tracePath: string;
  diagnosticsBeforePath: string;
  diagnosticsAfterPath: string;
  judgePath?: string;
}

export interface LaunchCaseResult {
  workflowId: LaunchWorkflowId;
  caseId: string;
  title: string;
  status: "pass" | "fail" | "skip";
  durationMs: number;
  outputText?: string;
  expected: string;
  hardChecks: LaunchHardCheckResult[];
  qualityEval?: EvalResult;
  runtimeHealth: LaunchRuntimeHealth;
  artifacts: LaunchCaseArtifacts;
  error?: string;
}

export interface LaunchWorkflowSummary {
  workflowId: LaunchWorkflowId;
  total: number;
  passed: number;
  failed: number;
  successRate: number;
  averageL2Composite?: number;
  medianDurationMs: number | null;
  cases: LaunchCaseResult[];
}

export interface LaunchGateResult {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
  severity: "hard" | "soft";
}

export interface LaunchBenchmarkSummary {
  startedAt: string;
  completedAt: string;
  outputDir: string;
  l2Enabled: boolean;
  l2Required: boolean;
  health: {
    ok: boolean;
    service?: string;
    model?: string;
  };
  workflows: Record<LaunchWorkflowId, LaunchWorkflowSummary>;
  gates: {
    hardPass: boolean;
    hard: LaunchGateResult[];
    soft: LaunchGateResult[];
  };
  diagnosticsBefore: unknown;
  diagnosticsAfter: unknown;
  reportPath?: string;
}

export interface LaunchBenchmarkRunOptions {
  outputDir?: string;
  requireL2?: boolean;
  emitHtmlReport?: boolean;
}

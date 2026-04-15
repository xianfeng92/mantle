import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { AIMessage, type BaseMessage } from "@langchain/core/messages";

import { AgentCoreServiceHarness } from "../../../src/service.js";
import type { TraceEvent } from "../../../src/tracing.js";
import {
  createTempWorkspace,
  isLmStudioUp,
  startLiveServer,
  TestMetricsCollector,
} from "../../test-helpers.js";
import { writeReport } from "../report-generator.js";
import type {
  ContextFixture,
  ContextLaunchCase,
  DownloadsLaunchCase,
  LaunchBenchmarkCase,
  LaunchBenchmarkRunOptions,
  LaunchBenchmarkSummary,
  LaunchCaseResult,
  LaunchExpectedCheck,
  LaunchGateResult,
  LaunchHardCheckResult,
  LaunchRuntimeHealth,
  LaunchWorkflowSummary,
  PromptPack,
  SelectionLaunchCase,
} from "./launch-benchmark-types.js";

const SUITE = "launch";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../");
const LAUNCH_ROOT = path.join(REPO_ROOT, "benchmarks", "launch");
const FIXTURES_ROOT = path.join(LAUNCH_ROOT, "fixtures");
const PROMPTS_ROOT = path.join(LAUNCH_ROOT, "prompts");
const RESULTS_ROOT = path.join(LAUNCH_ROOT, "results");

interface DiagnosticsResponse {
  gemma4?: {
    toolCallFallbackCount?: number;
    retryCount?: number;
  };
  runs?: {
    completed?: number;
    failed?: number;
    avgDurationMs?: number | null;
    avgToolCallsPerCompletedRun?: number | null;
    avgGuiActionStepsPerCompletedRun?: number | null;
  };
  contextUsage?: {
    lastUsagePercent?: number | null;
    peakUsagePercent?: number | null;
  };
  verification?: {
    passed?: number;
    failed?: number;
    passRatePercent?: number | null;
  };
}

interface AuditLogEntry {
  timestamp: string;
  operation: string;
  args?: Record<string, unknown>;
  moves?: Array<{ source: string; dest: string }>;
}

interface MoveRecord {
  id: string;
  timestamp: string;
  sourcePath: string;
  destPath: string;
  rolledBack?: boolean;
}

interface DiagnosticsEnvelope {
  before: DiagnosticsResponse;
  after: DiagnosticsResponse;
}

interface TraceBundle {
  traceId: string;
  label: string;
  events: TraceEvent[];
}

interface DownloadsOrganizeSequence {
  diagnostics: DiagnosticsEnvelope;
  traces: TraceBundle[];
  outputText: string;
  planText: string;
  durationMs: number;
  baselineFiles: string[];
  finalFiles: string[];
  createdDirectories: string[];
  newAuditEntries: AuditLogEntry[];
  newMoveRecords: MoveRecord[];
  sandboxAbsPath: string;
  sandboxFolder: string;
  threadId: string;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

function percent(part: number, total: number): number {
  if (total === 0) return 0;
  return round((part / total) * 100, 1);
}

function countBulletItems(text: string): number {
  return text
    .split("\n")
    .filter((line) => /^\s*(?:[-*•]|\d+\.)\s+/.test(line))
    .length;
}

function extractLastAssistantText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (AIMessage.isInstance(message)) {
      if (typeof message.content === "string") {
        return message.content;
      }
      return message.content?.toString() ?? "";
    }
  }
  return "";
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  return Object.entries(variables).reduce(
    (output, [key, value]) => output.replaceAll(`{{${key}}}`, value),
    template,
  );
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function fetchJson<T>(baseUrl: string, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Request failed for ${pathname}: ${response.status} ${text}`);
  }
  return JSON.parse(text) as T;
}

async function loadPromptPack<TCase extends LaunchBenchmarkCase>(
  promptDir: string,
  workflowId: TCase["workflowId"],
): Promise<PromptPack<TCase>> {
  const [promptTemplate, casesRaw, checksRaw] = await Promise.all([
    readFile(path.join(promptDir, "prompt.md"), "utf-8"),
    readFile(path.join(promptDir, "cases.json"), "utf-8"),
    readFile(path.join(promptDir, "expected-checks.json"), "utf-8"),
  ]);

  const parsedCases = JSON.parse(casesRaw) as Array<Record<string, unknown>>;
  const parsedChecks = JSON.parse(checksRaw) as LaunchExpectedCheck[];

  return {
    promptTemplate,
    cases: parsedCases.map((entry) => ({ workflowId, ...entry })) as TCase[],
    expectedChecks: new Map(parsedChecks.map((entry) => [entry.caseId, entry])),
  };
}

async function loadContextFixture(fileName: string): Promise<ContextFixture> {
  const raw = await readFile(path.join(FIXTURES_ROOT, "context", fileName), "utf-8");
  return JSON.parse(raw) as ContextFixture;
}

async function loadSelectionFixture(fileName: string): Promise<string> {
  return readFile(path.join(FIXTURES_ROOT, "selection", fileName), "utf-8");
}

function contextFixtureToEnvironmentText(fixture: ContextFixture): string {
  const lines = [
    `frontmost_app: ${fixture.frontmostApp}`,
    `window_title: ${fixture.windowTitle}`,
    "recent_files:",
    ...fixture.recentFiles.map((file) => `  - ${file}`),
  ];

  if (fixture.selectedText && fixture.selectedText.trim()) {
    lines.push("selected_text: |");
    lines.push(...fixture.selectedText.split("\n").map((line) => `  ${line}`));
  }

  if (fixture.conversationHint && fixture.conversationHint.trim()) {
    lines.push("conversation_hint: |");
    lines.push(...fixture.conversationHint.split("\n").map((line) => `  ${line}`));
  }

  return lines.join("\n");
}

const CONTEXT_THEME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "into",
  "my",
  "of",
  "or",
  "the",
  "to",
  "with",
]);

function normalizeKeywordMatchingText(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase();
}

function extractThemeKeywords(theme: string): string[] {
  return normalizeKeywordMatchingText(theme)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !CONTEXT_THEME_STOPWORDS.has(token));
}

function outputUsesContextTheme(outputText: string, expectedTaskThemes: string[]): boolean {
  const normalizedOutput = normalizeKeywordMatchingText(outputText);
  return expectedTaskThemes.some((theme) =>
    extractThemeKeywords(theme).some((keyword) => normalizedOutput.includes(keyword)),
  );
}

async function listRelativeFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listRelativeFiles(fullPath);
      files.push(...nested.map((file) => path.join(entry.name, file)));
    } else if (entry.isFile()) {
      files.push(entry.name);
    }
  }

  return files.sort();
}

async function listTopLevelDirectories(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function basenames(files: string[]): string[] {
  return files.map((file) => path.basename(file)).sort();
}

function setDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function isInsideSandbox(
  maybePath: string,
  workspaceDir: string,
  sandboxAbsPath: string,
): boolean {
  const resolved = path.isAbsolute(maybePath)
    ? path.resolve(maybePath)
    : path.resolve(workspaceDir, maybePath);
  return resolved === sandboxAbsPath || resolved.startsWith(`${sandboxAbsPath}${path.sep}`);
}

function diffAuditEntries(before: AuditLogEntry[], after: AuditLogEntry[]): AuditLogEntry[] {
  const beforeSet = new Set(before.map((entry) => JSON.stringify(entry)));
  return after.filter((entry) => !beforeSet.has(JSON.stringify(entry)));
}

function diffMoves(before: MoveRecord[], after: MoveRecord[]): MoveRecord[] {
  const beforeIds = new Set(before.map((entry) => entry.id));
  return after.filter((entry) => !beforeIds.has(entry.id));
}

function aggregateTraceMetrics(traceBundles: TraceBundle[]): Omit<LaunchRuntimeHealth, "traceIds"> {
  const events = traceBundles.flatMap((bundle) => bundle.events);
  const runCompleted = events.filter((event) => event.kind === "run_completed");

  const promptTokens = runCompleted.reduce((sum, event) => {
    const tokenUsage = event.payload?.tokenUsage as Record<string, number> | undefined;
    return sum + (tokenUsage?.promptTokens ?? 0);
  }, 0);
  const completionTokens = runCompleted.reduce((sum, event) => {
    const tokenUsage = event.payload?.tokenUsage as Record<string, number> | undefined;
    return sum + (tokenUsage?.completionTokens ?? 0);
  }, 0);
  const contextUsageValues = runCompleted
    .map((event) => event.payload?.contextUsagePercent)
    .filter((value): value is number => typeof value === "number");

  return {
    promptTokens: runCompleted.length > 0 ? promptTokens : null,
    completionTokens: runCompleted.length > 0 ? completionTokens : null,
    contextUsagePercent:
      contextUsageValues.length > 0 ? Math.max(...contextUsageValues) : null,
    toolCallCount: events.filter((event) => event.kind === "tool_started").length,
    fallbackTriggered: events.some((event) => event.kind === "tool_call_fallback"),
    retryTriggered: events.some((event) => event.kind === "retry_attempted"),
  };
}

function evaluateCommonTextChecks(
  text: string,
  sourceText: string,
  expected: LaunchExpectedCheck,
): LaunchHardCheckResult[] {
  const checks: LaunchHardCheckResult[] = [];
  const bulletCount = countBulletItems(text);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  if (expected.language === "zh") {
    checks.push({
      name: "language",
      passed: /[\u4e00-\u9fff]/.test(text),
      details: "Expected Chinese output.",
    });
  } else if (expected.language === "en") {
    checks.push({
      name: "language",
      passed: /[A-Za-z]/.test(text) && !/[\u4e00-\u9fff]/.test(text),
      details: "Expected English output.",
    });
  }

  if (expected.outputFormat === "paragraph") {
    checks.push({
      name: "format",
      passed: bulletCount === 0,
      details: "Expected paragraph output without bullet lines.",
    });
  } else if (expected.outputFormat === "bullet_list") {
    checks.push({
      name: "format",
      passed: bulletCount > 0,
      details: "Expected bullet-list output.",
    });
  } else if (expected.outputFormat === "summary_plus_bullets") {
    checks.push({
      name: "format",
      passed: bulletCount > 0 && lines.length > bulletCount,
      details: "Expected a short summary followed by bullet items.",
    });
  }

  if (typeof expected.minItems === "number") {
    checks.push({
      name: "min-items",
      passed: bulletCount >= expected.minItems,
      details: `Expected at least ${expected.minItems} bullet items; got ${bulletCount}.`,
    });
  }

  if (typeof expected.maxItems === "number") {
    checks.push({
      name: "max-items",
      passed: bulletCount <= expected.maxItems,
      details: `Expected at most ${expected.maxItems} bullet items; got ${bulletCount}.`,
    });
  }

  if (typeof expected.maxLengthRatio === "number" && sourceText.length > 0) {
    const ratio = text.length / sourceText.length;
    checks.push({
      name: "length-ratio",
      passed: ratio <= expected.maxLengthRatio,
      details: `Expected output/input length ratio <= ${expected.maxLengthRatio}; got ${round(ratio)}.`,
    });
  }

  for (const pattern of expected.requiredPatterns ?? []) {
    const regex = new RegExp(pattern, "i");
    checks.push({
      name: `required:${pattern}`,
      passed: regex.test(text),
      details: `Expected output to match /${pattern}/i.`,
    });
  }

  for (const pattern of expected.forbiddenPatterns ?? []) {
    const regex = new RegExp(pattern, "i");
    checks.push({
      name: `forbidden:${pattern}`,
      passed: !regex.test(text),
      details: `Expected output not to match /${pattern}/i.`,
    });
  }

  return checks;
}

function createCaseArtifacts(outputDir: string, caseId: string) {
  const artifactDir = path.join(outputDir, "cases", caseId);
  return {
    artifactDir,
    runResultPath: path.join(artifactDir, "run-result.json"),
    caseTracePath: path.join(artifactDir, "trace.json"),
    topLevelTracePath: path.join(outputDir, "traces", `${caseId}.json`),
    diagnosticsBeforePath: path.join(artifactDir, "diagnostics-before.json"),
    diagnosticsAfterPath: path.join(artifactDir, "diagnostics-after.json"),
    judgePath: path.join(artifactDir, "judge.json"),
  };
}

async function prepareResultsDir(outputDir?: string): Promise<string> {
  const finalOutputDir = outputDir
    ? path.resolve(outputDir)
    : path.join(
        RESULTS_ROOT,
        new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-"),
      );
  await mkdir(path.join(finalOutputDir, "cases"), { recursive: true });
  await mkdir(path.join(finalOutputDir, "traces"), { recursive: true });
  return finalOutputDir;
}

async function resetDownloadsSandbox(
  workspaceDir: string,
  fixtureDirName: string,
  sandboxFolder: string,
): Promise<string> {
  const sandboxAbsPath = path.join(workspaceDir, sandboxFolder);
  await rm(sandboxAbsPath, { recursive: true, force: true });
  await cp(
    path.join(FIXTURES_ROOT, "downloads-sandbox", fixtureDirName),
    sandboxAbsPath,
    { recursive: true },
  );
  return sandboxAbsPath;
}

async function executeDownloadsOrganizeSequence(options: {
  baseUrl: string;
  service: AgentCoreServiceHarness;
  traceRecorder: { getTrace(traceId: string): Promise<TraceEvent[]> };
  workspaceDir: string;
  promptPack: PromptPack<DownloadsLaunchCase>;
  benchmarkCase: DownloadsLaunchCase;
}): Promise<DownloadsOrganizeSequence> {
  const { baseUrl, service, traceRecorder, workspaceDir, promptPack, benchmarkCase } = options;
  const sandboxAbsPath = await resetDownloadsSandbox(
    workspaceDir,
    benchmarkCase.fixtureDir,
    benchmarkCase.sandboxFolder,
  );
  const baselineFiles = await listRelativeFiles(sandboxAbsPath);
  const diagnosticsBefore = await fetchJson<DiagnosticsResponse>(baseUrl, "/diagnostics");
  const auditBefore = await fetchJson<{ entries: AuditLogEntry[] }>(baseUrl, "/audit");
  const movesBefore = await fetchJson<{ moves: MoveRecord[] }>(baseUrl, "/moves");
  const threadId = `${benchmarkCase.caseId}-${randomUUID()}`;
  const start = Date.now();

  const planResult = await service.runOnce({
    threadId,
    input: renderTemplate(promptPack.promptTemplate, {
      sandbox_folder: benchmarkCase.sandboxFolder,
      instruction: benchmarkCase.planInstruction ?? "",
    }),
  });

  const confirmResult = await service.runOnce({
    threadId,
    input: renderTemplate(promptPack.promptTemplate, {
      sandbox_folder: benchmarkCase.sandboxFolder,
      instruction: benchmarkCase.confirmInstruction ?? "",
    }),
    maxInterrupts: 8,
    onInterrupt: async (request) => ({
      decisions: request.actionRequests.map(() => ({ type: "approve" as const })),
    }),
  });

  const diagnosticsAfter = await fetchJson<DiagnosticsResponse>(baseUrl, "/diagnostics");
  const auditAfter = await fetchJson<{ entries: AuditLogEntry[] }>(baseUrl, "/audit");
  const movesAfter = await fetchJson<{ moves: MoveRecord[] }>(baseUrl, "/moves");
  const traceIds = [planResult.traceId, confirmResult.traceId];
  const traces: TraceBundle[] = await Promise.all(
    traceIds.map(async (traceId, index) => ({
      traceId,
      label: index === 0 ? "plan" : "confirm",
      events: await traceRecorder.getTrace(traceId),
    })),
  );
  const finalFiles = await listRelativeFiles(sandboxAbsPath);

  return {
    diagnostics: {
      before: diagnosticsBefore,
      after: diagnosticsAfter,
    },
    traces,
    outputText: extractLastAssistantText(confirmResult.newMessages),
    planText: extractLastAssistantText(planResult.newMessages),
    durationMs: Date.now() - start,
    baselineFiles,
    finalFiles,
    createdDirectories: await listTopLevelDirectories(sandboxAbsPath),
    newAuditEntries: diffAuditEntries(auditBefore.entries, auditAfter.entries),
    newMoveRecords: diffMoves(movesBefore.moves, movesAfter.moves),
    sandboxAbsPath,
    sandboxFolder: benchmarkCase.sandboxFolder,
    threadId,
  };
}

async function runSelectionCase(options: {
  baseUrl: string;
  outputDir: string;
  service: AgentCoreServiceHarness;
  traceRecorder: { getTrace(traceId: string): Promise<TraceEvent[]> };
  collector: TestMetricsCollector;
  promptPack: PromptPack<SelectionLaunchCase>;
  benchmarkCase: SelectionLaunchCase;
}): Promise<LaunchCaseResult> {
  const { baseUrl, outputDir, service, traceRecorder, collector, promptPack, benchmarkCase } = options;
  const expectedChecks = promptPack.expectedChecks.get(benchmarkCase.caseId);
  if (!expectedChecks) {
    throw new Error(`Missing expected checks for ${benchmarkCase.caseId}`);
  }

  const selectionText = await loadSelectionFixture(benchmarkCase.fixtureFile);
  const diagnosticsBefore = await fetchJson<DiagnosticsResponse>(baseUrl, "/diagnostics");
  const start = Date.now();
  const result = await service.runOnce({
    threadId: `${benchmarkCase.caseId}-${randomUUID()}`,
    input: renderTemplate(promptPack.promptTemplate, {
      selection_text: selectionText,
      instruction: benchmarkCase.instruction,
    }),
  });
  const durationMs = Date.now() - start;
  const diagnosticsAfter = await fetchJson<DiagnosticsResponse>(baseUrl, "/diagnostics");
  const traces: TraceBundle[] = [
    {
      traceId: result.traceId,
      label: "run",
      events: await traceRecorder.getTrace(result.traceId),
    },
  ];
  const outputText = extractLastAssistantText(result.newMessages);
  const hardChecks = [
    ...evaluateCommonTextChecks(outputText, selectionText, expectedChecks),
    {
      name: "single-response",
      passed: result.interruptCount === 0 && result.status === "completed",
      details: "Expected a single completed response without approval loops.",
    },
  ] satisfies LaunchHardCheckResult[];
  const aggregated = aggregateTraceMetrics(traces);
  const artifacts = createCaseArtifacts(outputDir, benchmarkCase.caseId);

  await writeJson(artifacts.runResultPath, {
    workflowId: benchmarkCase.workflowId,
    caseId: benchmarkCase.caseId,
    title: benchmarkCase.title,
    input: benchmarkCase.instruction,
    expected: benchmarkCase.expected,
    selectionText,
    outputText,
    traceIds: traces.map((trace) => trace.traceId),
    status: result.status,
  });
  await writeJson(artifacts.caseTracePath, { traces });
  await writeJson(artifacts.topLevelTracePath, { traces });
  await writeJson(artifacts.diagnosticsBeforePath, diagnosticsBefore);
  await writeJson(artifacts.diagnosticsAfterPath, diagnosticsAfter);

  collector.record(
    {
      testName: benchmarkCase.caseId,
      suite: SUITE,
      status: hardChecks.every((check) => check.passed) ? "pass" : "fail",
      durationMs,
      inferenceMs: durationMs,
      promptTokens: aggregated.promptTokens,
      completionTokens: aggregated.completionTokens,
      contextUsagePercent: aggregated.contextUsagePercent,
      toolCallCount: aggregated.toolCallCount,
      fallbackTriggered: aggregated.fallbackTriggered,
      retryTriggered: aggregated.retryTriggered,
    },
    {
      input: `${benchmarkCase.instruction}\n\nSelected text:\n${selectionText}`,
      output: outputText,
      expected: benchmarkCase.expected,
    },
  );

  return {
    workflowId: benchmarkCase.workflowId,
    caseId: benchmarkCase.caseId,
    title: benchmarkCase.title,
    status: hardChecks.every((check) => check.passed) ? "pass" : "fail",
    durationMs,
    outputText,
    expected: benchmarkCase.expected,
    hardChecks,
    runtimeHealth: {
      traceIds: traces.map((trace) => trace.traceId),
      ...aggregated,
      verificationPassRatePercent: diagnosticsAfter.verification?.passRatePercent ?? null,
    },
    artifacts: {
      artifactDir: artifacts.artifactDir,
      runResultPath: artifacts.runResultPath,
      tracePath: artifacts.caseTracePath,
      diagnosticsBeforePath: artifacts.diagnosticsBeforePath,
      diagnosticsAfterPath: artifacts.diagnosticsAfterPath,
      judgePath: artifacts.judgePath,
    },
  };
}

async function runContextCase(options: {
  baseUrl: string;
  outputDir: string;
  service: AgentCoreServiceHarness;
  traceRecorder: { getTrace(traceId: string): Promise<TraceEvent[]> };
  collector: TestMetricsCollector;
  promptPack: PromptPack<ContextLaunchCase>;
  benchmarkCase: ContextLaunchCase;
}): Promise<LaunchCaseResult> {
  const { baseUrl, outputDir, service, traceRecorder, collector, promptPack, benchmarkCase } = options;
  const expectedChecks = promptPack.expectedChecks.get(benchmarkCase.caseId);
  if (!expectedChecks) {
    throw new Error(`Missing expected checks for ${benchmarkCase.caseId}`);
  }

  const fixture = await loadContextFixture(benchmarkCase.fixtureFile);
  const diagnosticsBefore = await fetchJson<DiagnosticsResponse>(baseUrl, "/diagnostics");
  const start = Date.now();
  const result = await service.runOnce({
    threadId: `${benchmarkCase.caseId}-${randomUUID()}`,
    input: renderTemplate(promptPack.promptTemplate, {
      instruction: benchmarkCase.instruction,
    }),
    context: contextFixtureToEnvironmentText(fixture),
  });
  const durationMs = Date.now() - start;
  const diagnosticsAfter = await fetchJson<DiagnosticsResponse>(baseUrl, "/diagnostics");
  const traces: TraceBundle[] = [
    {
      traceId: result.traceId,
      label: "run",
      events: await traceRecorder.getTrace(result.traceId),
    },
  ];
  const outputText = extractLastAssistantText(result.newMessages);
  const hardChecks = [
    ...evaluateCommonTextChecks(
      outputText,
      fixture.selectedText || fixture.recentFiles.join("\n"),
      expectedChecks,
    ),
    {
      name: "context-clues",
      passed: outputUsesContextTheme(outputText, fixture.expectedTaskThemes),
      details: "Expected the output to use at least one core task theme from the fixture.",
    },
  ] satisfies LaunchHardCheckResult[];
  const aggregated = aggregateTraceMetrics(traces);
  const artifacts = createCaseArtifacts(outputDir, benchmarkCase.caseId);

  await writeJson(artifacts.runResultPath, {
    workflowId: benchmarkCase.workflowId,
    caseId: benchmarkCase.caseId,
    title: benchmarkCase.title,
    input: benchmarkCase.instruction,
    expected: benchmarkCase.expected,
    contextFixture: fixture,
    outputText,
    traceIds: traces.map((trace) => trace.traceId),
    status: result.status,
  });
  await writeJson(artifacts.caseTracePath, { traces });
  await writeJson(artifacts.topLevelTracePath, { traces });
  await writeJson(artifacts.diagnosticsBeforePath, diagnosticsBefore);
  await writeJson(artifacts.diagnosticsAfterPath, diagnosticsAfter);

  collector.record(
    {
      testName: benchmarkCase.caseId,
      suite: SUITE,
      status: hardChecks.every((check) => check.passed) ? "pass" : "fail",
      durationMs,
      inferenceMs: durationMs,
      promptTokens: aggregated.promptTokens,
      completionTokens: aggregated.completionTokens,
      contextUsagePercent: aggregated.contextUsagePercent,
      toolCallCount: aggregated.toolCallCount,
      fallbackTriggered: aggregated.fallbackTriggered,
      retryTriggered: aggregated.retryTriggered,
    },
    {
      input: `${benchmarkCase.instruction}\n\n${contextFixtureToEnvironmentText(fixture)}`,
      output: outputText,
      expected: benchmarkCase.expected,
    },
  );

  return {
    workflowId: benchmarkCase.workflowId,
    caseId: benchmarkCase.caseId,
    title: benchmarkCase.title,
    status: hardChecks.every((check) => check.passed) ? "pass" : "fail",
    durationMs,
    outputText,
    expected: benchmarkCase.expected,
    hardChecks,
    runtimeHealth: {
      traceIds: traces.map((trace) => trace.traceId),
      ...aggregated,
      verificationPassRatePercent: diagnosticsAfter.verification?.passRatePercent ?? null,
    },
    artifacts: {
      artifactDir: artifacts.artifactDir,
      runResultPath: artifacts.runResultPath,
      tracePath: artifacts.caseTracePath,
      diagnosticsBeforePath: artifacts.diagnosticsBeforePath,
      diagnosticsAfterPath: artifacts.diagnosticsAfterPath,
      judgePath: artifacts.judgePath,
    },
  };
}

async function runDownloadsCase(options: {
  baseUrl: string;
  outputDir: string;
  service: AgentCoreServiceHarness;
  traceRecorder: { getTrace(traceId: string): Promise<TraceEvent[]> };
  workspaceDir: string;
  collector: TestMetricsCollector;
  promptPack: PromptPack<DownloadsLaunchCase>;
  benchmarkCase: DownloadsLaunchCase;
}): Promise<LaunchCaseResult> {
  const { baseUrl, outputDir, service, traceRecorder, workspaceDir, collector, promptPack, benchmarkCase } = options;
  const expectedChecks = promptPack.expectedChecks.get(benchmarkCase.caseId);
  if (!expectedChecks) {
    throw new Error(`Missing expected checks for ${benchmarkCase.caseId}`);
  }

  const artifacts = createCaseArtifacts(outputDir, benchmarkCase.caseId);

  if (benchmarkCase.mode === "organize") {
    const sequence = await executeDownloadsOrganizeSequence({
      baseUrl,
      service,
      traceRecorder,
      workspaceDir,
      promptPack,
      benchmarkCase,
    });

    const baselineBasenames = basenames(sequence.baselineFiles);
    const finalBasenames = basenames(sequence.finalFiles);
    const lostFiles = setDifference(baselineBasenames, finalBasenames);
    const outOfBoundsMoves = sequence.newMoveRecords.filter(
      (move) =>
        !isInsideSandbox(move.sourcePath, workspaceDir, sequence.sandboxAbsPath) ||
        !isInsideSandbox(move.destPath, workspaceDir, sequence.sandboxAbsPath),
    );

    const hardChecks = [
      {
        name: "plan-stage",
        passed: /plan|move|整理|organize/i.test(sequence.planText),
        details: "Expected the planning turn to propose a concrete move plan.",
      },
      {
        name: "audit-emitted",
        passed: !expectedChecks.requireAudit || sequence.newAuditEntries.length > 0,
        details: `Expected audit entries; got ${sequence.newAuditEntries.length}.`,
      },
      {
        name: "move-recorded",
        passed: !expectedChecks.requireMoveRecord || sequence.newMoveRecords.length > 0,
        details: `Expected move records; got ${sequence.newMoveRecords.length}.`,
      },
      {
        name: "sandbox-boundary",
        passed: !expectedChecks.allFilesMustRemainUnderSandbox || outOfBoundsMoves.length === 0,
        details: `Expected all moves to stay inside the sandbox; got ${outOfBoundsMoves.length} boundary violations.`,
      },
      {
        name: "file-loss",
        passed: lostFiles.length === 0,
        details: lostFiles.length > 0 ? `Lost files: ${lostFiles.join(", ")}` : "No files lost.",
      },
      {
        name: "min-moves",
        passed: expectedChecks.minMoves == null || sequence.newMoveRecords.length >= expectedChecks.minMoves,
        details: `Expected at least ${expectedChecks.minMoves ?? 0} moves; got ${sequence.newMoveRecords.length}.`,
      },
      {
        name: "max-moves",
        passed: expectedChecks.maxMoves == null || sequence.newMoveRecords.length <= expectedChecks.maxMoves,
        details: `Expected at most ${expectedChecks.maxMoves ?? "inf"} moves; got ${sequence.newMoveRecords.length}.`,
      },
      {
        name: "created-directories",
        passed:
          expectedChecks.minCreatedDirectories == null ||
          sequence.createdDirectories.length >= expectedChecks.minCreatedDirectories,
        details: `Expected at least ${expectedChecks.minCreatedDirectories ?? 0} created directories; got ${sequence.createdDirectories.length}.`,
      },
      {
        name: "conservative-retain",
        passed:
          !expectedChecks.rootShouldRetainAnyOf ||
          expectedChecks.rootShouldRetainAnyOf.some((file) => sequence.finalFiles.includes(file)),
        details:
          expectedChecks.rootShouldRetainAnyOf
            ? `Expected at least one ambiguous file to remain in the sandbox root: ${expectedChecks.rootShouldRetainAnyOf.join(", ")}.`
            : undefined,
      },
    ] satisfies LaunchHardCheckResult[];
    const aggregated = aggregateTraceMetrics(sequence.traces);

    await writeJson(artifacts.runResultPath, {
      workflowId: benchmarkCase.workflowId,
      caseId: benchmarkCase.caseId,
      title: benchmarkCase.title,
      expected: benchmarkCase.expected,
      planText: sequence.planText,
      outputText: sequence.outputText,
      traceIds: sequence.traces.map((trace) => trace.traceId),
      baselineFiles: sequence.baselineFiles,
      finalFiles: sequence.finalFiles,
      createdDirectories: sequence.createdDirectories,
      auditEntries: sequence.newAuditEntries,
      moveRecords: sequence.newMoveRecords,
    });
    await writeJson(artifacts.caseTracePath, { traces: sequence.traces });
    await writeJson(artifacts.topLevelTracePath, { traces: sequence.traces });
    await writeJson(artifacts.diagnosticsBeforePath, sequence.diagnostics.before);
    await writeJson(artifacts.diagnosticsAfterPath, sequence.diagnostics.after);

    collector.record({
      testName: benchmarkCase.caseId,
      suite: SUITE,
      status: hardChecks.every((check) => check.passed) ? "pass" : "fail",
      durationMs: sequence.durationMs,
      inferenceMs: sequence.durationMs,
      promptTokens: aggregated.promptTokens,
      completionTokens: aggregated.completionTokens,
      contextUsagePercent: aggregated.contextUsagePercent,
      toolCallCount: aggregated.toolCallCount,
      fallbackTriggered: aggregated.fallbackTriggered,
      retryTriggered: aggregated.retryTriggered,
    });

    return {
      workflowId: benchmarkCase.workflowId,
      caseId: benchmarkCase.caseId,
      title: benchmarkCase.title,
      status: hardChecks.every((check) => check.passed) ? "pass" : "fail",
      durationMs: sequence.durationMs,
      outputText: sequence.outputText,
      expected: benchmarkCase.expected,
      hardChecks,
      runtimeHealth: {
        traceIds: sequence.traces.map((trace) => trace.traceId),
        ...aggregated,
        outOfBoundsMoveCount: outOfBoundsMoves.length,
        fileLossCount: lostFiles.length,
        auditEntryCount: sequence.newAuditEntries.length,
        moveRecordCount: sequence.newMoveRecords.length,
        verificationPassRatePercent:
          sequence.diagnostics.after.verification?.passRatePercent ?? null,
      },
      artifacts: {
        artifactDir: artifacts.artifactDir,
        runResultPath: artifacts.runResultPath,
        tracePath: artifacts.caseTracePath,
        diagnosticsBeforePath: artifacts.diagnosticsBeforePath,
        diagnosticsAfterPath: artifacts.diagnosticsAfterPath,
      },
    };
  }

  const seedCaseId = benchmarkCase.seedCaseId ?? expectedChecks.seedCaseId;
  const seedCase = promptPack.cases.find((candidate) => candidate.caseId === seedCaseId);
  if (!seedCase || seedCase.mode !== "organize") {
    throw new Error(`Rollback case ${benchmarkCase.caseId} requires an organize seed case.`);
  }

  const seedSequence = await executeDownloadsOrganizeSequence({
    baseUrl,
    service,
    traceRecorder,
    workspaceDir,
    promptPack,
    benchmarkCase: seedCase,
  });
  const rollbackStarted = Date.now();
  const diagnosticsBeforeRollback = await fetchJson<DiagnosticsResponse>(baseUrl, "/diagnostics");
  const rollbackErrors: string[] = [];

  for (const move of seedSequence.newMoveRecords) {
    try {
      await fetchJson(baseUrl, `/moves/${move.id}/rollback`, { method: "POST" });
    } catch (error) {
      rollbackErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const rollbackDurationMs = Date.now() - rollbackStarted;

  const diagnosticsAfterRollback = await fetchJson<DiagnosticsResponse>(baseUrl, "/diagnostics");
  const allMovesAfter = await fetchJson<{ moves: MoveRecord[] }>(baseUrl, "/moves");
  const finalFiles = await listRelativeFiles(seedSequence.sandboxAbsPath);
  const finalBasenames = basenames(finalFiles);
  const baselineBasenames = basenames(seedSequence.baselineFiles);
  const lostFiles = setDifference(baselineBasenames, finalBasenames);
  const rolledBackMoves = allMovesAfter.moves.filter(
    (move) => seedSequence.newMoveRecords.some((seedMove) => seedMove.id === move.id) && move.rolledBack,
  );
  const hardChecks = [
    {
      name: "rollback-endpoint",
      passed: rollbackErrors.length === 0,
      details:
        rollbackErrors.length > 0
          ? rollbackErrors.join("\n")
          : "Rollback endpoint succeeded for all move records.",
    },
    {
      name: "rollback-baseline",
      passed:
        !expectedChecks.requireRollbackToBaseline ||
        JSON.stringify(finalFiles) === JSON.stringify(seedSequence.baselineFiles),
      details: "Expected rollback to restore the original relative file layout.",
    },
    {
      name: "rollback-move-flags",
      passed:
        !expectedChecks.requireAllSeedMovesRolledBack ||
        rolledBackMoves.length === seedSequence.newMoveRecords.length,
      details: `Expected ${seedSequence.newMoveRecords.length} rolled-back move records; got ${rolledBackMoves.length}.`,
    },
    {
      name: "rollback-file-loss",
      passed: lostFiles.length === 0,
      details: lostFiles.length > 0 ? `Lost files after rollback: ${lostFiles.join(", ")}` : "No files lost after rollback.",
    },
  ] satisfies LaunchHardCheckResult[];
  const aggregated = aggregateTraceMetrics(seedSequence.traces);

  await writeJson(artifacts.runResultPath, {
    workflowId: benchmarkCase.workflowId,
    caseId: benchmarkCase.caseId,
    title: benchmarkCase.title,
    expected: benchmarkCase.expected,
    seedCaseId: seedCase.caseId,
    seedTraceIds: seedSequence.traces.map((trace) => trace.traceId),
    baselineFiles: seedSequence.baselineFiles,
    finalFiles,
    rolledBackMoveIds: rolledBackMoves.map((move) => move.id),
  });
  await writeJson(artifacts.caseTracePath, { traces: seedSequence.traces });
  await writeJson(artifacts.topLevelTracePath, { traces: seedSequence.traces });
  await writeJson(artifacts.diagnosticsBeforePath, diagnosticsBeforeRollback);
  await writeJson(artifacts.diagnosticsAfterPath, diagnosticsAfterRollback);

  collector.record({
    testName: benchmarkCase.caseId,
    suite: SUITE,
    status: hardChecks.every((check) => check.passed) ? "pass" : "fail",
    durationMs: seedSequence.durationMs + rollbackDurationMs,
    inferenceMs: seedSequence.durationMs + rollbackDurationMs,
    promptTokens: aggregated.promptTokens,
    completionTokens: aggregated.completionTokens,
    contextUsagePercent: aggregated.contextUsagePercent,
    toolCallCount: aggregated.toolCallCount,
    fallbackTriggered: aggregated.fallbackTriggered,
    retryTriggered: aggregated.retryTriggered,
  });

  return {
    workflowId: benchmarkCase.workflowId,
    caseId: benchmarkCase.caseId,
    title: benchmarkCase.title,
    status: hardChecks.every((check) => check.passed) ? "pass" : "fail",
    durationMs: seedSequence.durationMs + rollbackDurationMs,
    expected: benchmarkCase.expected,
    hardChecks,
    runtimeHealth: {
      traceIds: seedSequence.traces.map((trace) => trace.traceId),
      ...aggregated,
      outOfBoundsMoveCount: 0,
      fileLossCount: lostFiles.length,
      auditEntryCount: seedSequence.newAuditEntries.length,
      moveRecordCount: seedSequence.newMoveRecords.length,
      verificationPassRatePercent:
        diagnosticsAfterRollback.verification?.passRatePercent ?? null,
    },
    artifacts: {
      artifactDir: artifacts.artifactDir,
      runResultPath: artifacts.runResultPath,
      tracePath: artifacts.caseTracePath,
      diagnosticsBeforePath: artifacts.diagnosticsBeforePath,
      diagnosticsAfterPath: artifacts.diagnosticsAfterPath,
    },
    error: rollbackErrors.length > 0 ? rollbackErrors.join(" | ") : undefined,
  };
}

function summarizeWorkflow(results: LaunchCaseResult[], workflowId: LaunchCaseResult["workflowId"]): LaunchWorkflowSummary {
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const compositeScores = results
    .map((result) => result.qualityEval?.compositeScore)
    .filter((value): value is number => typeof value === "number");

  return {
    workflowId,
    total: results.length,
    passed,
    failed,
    successRate: percent(passed, results.length),
    averageL2Composite:
      compositeScores.length > 0
        ? round(compositeScores.reduce((sum, score) => sum + score, 0) / compositeScores.length)
        : undefined,
    medianDurationMs: median(results.map((result) => result.durationMs)),
    cases: results,
  };
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null) return "n/a";
  return `${round(durationMs / 1000, 1)}s`;
}

function buildGateResults(summary: {
  l2Required: boolean;
  workflows: Record<LaunchCaseResult["workflowId"], LaunchWorkflowSummary>;
  diagnosticsAfter: DiagnosticsResponse;
}): { hard: LaunchGateResult[]; soft: LaunchGateResult[] } {
  const selection = summary.workflows["selection-rewrite"];
  const downloads = summary.workflows["downloads-organize"];
  const context = summary.workflows["context-todo"];
  const organizeCases = downloads.cases.filter((result) => result.caseId !== "downloads-rollback");
  const rollbackCases = downloads.cases.filter((result) => result.caseId === "downloads-rollback");
  const outOfBoundsMoves = downloads.cases.reduce(
    (sum, result) => sum + (result.runtimeHealth.outOfBoundsMoveCount ?? 0),
    0,
  );
  const fileLoss = downloads.cases.reduce(
    (sum, result) => sum + (result.runtimeHealth.fileLossCount ?? 0),
    0,
  );
  const organizeAuditPasses = organizeCases.filter(
    (result) => (result.runtimeHealth.auditEntryCount ?? 0) > 0,
  ).length;
  const organizeSuccessRate = percent(
    organizeCases.filter((result) => result.status === "pass").length,
    organizeCases.length,
  );
  const rollbackSuccessRate = percent(
    rollbackCases.filter((result) => result.status === "pass").length,
    rollbackCases.length,
  );

  const hard: LaunchGateResult[] = [
    {
      name: "workflow-a-success",
      severity: "hard",
      passed: selection.successRate >= 80,
      expected: ">= 80%",
      actual: `${selection.successRate}%`,
    },
    {
      name: "workflow-b-organize-success",
      severity: "hard",
      passed: organizeSuccessRate >= 90,
      expected: ">= 90%",
      actual: `${organizeSuccessRate}%`,
    },
    {
      name: "workflow-b-rollback-success",
      severity: "hard",
      passed: rollbackSuccessRate === 100,
      expected: "= 100%",
      actual: `${rollbackSuccessRate}%`,
    },
    {
      name: "workflow-c-success",
      severity: "hard",
      passed: context.successRate >= 80,
      expected: ">= 80%",
      actual: `${context.successRate}%`,
    },
    {
      name: "out-of-bounds-moves",
      severity: "hard",
      passed: outOfBoundsMoves === 0,
      expected: "0",
      actual: String(outOfBoundsMoves),
    },
    {
      name: "file-loss",
      severity: "hard",
      passed: fileLoss === 0,
      expected: "0",
      actual: String(fileLoss),
    },
    {
      name: "downloads-audit-emission",
      severity: "hard",
      passed: organizeAuditPasses === organizeCases.length,
      expected: "100%",
      actual: `${percent(organizeAuditPasses, organizeCases.length)}%`,
    },
  ];

  if (summary.l2Required) {
    hard.push(
      {
        name: "workflow-a-l2-composite",
        severity: "hard",
        passed: (selection.averageL2Composite ?? 0) >= 0.75,
        expected: ">= 0.75",
        actual: String(selection.averageL2Composite ?? 0),
      },
      {
        name: "workflow-c-l2-composite",
        severity: "hard",
        passed: (context.averageL2Composite ?? 0) >= 0.7,
        expected: ">= 0.70",
        actual: String(context.averageL2Composite ?? 0),
      },
    );
  }

  const soft: LaunchGateResult[] = [
    {
      name: "workflow-a-median-duration",
      severity: "soft",
      passed: (selection.medianDurationMs ?? Infinity) <= 45_000,
      expected: "<= 45s",
      actual: formatDuration(selection.medianDurationMs),
    },
    {
      name: "workflow-b-median-duration",
      severity: "soft",
      passed: (downloads.medianDurationMs ?? Infinity) <= 60_000,
      expected: "<= 60s",
      actual: formatDuration(downloads.medianDurationMs),
    },
    {
      name: "workflow-c-median-duration",
      severity: "soft",
      passed: (context.medianDurationMs ?? Infinity) <= 45_000,
      expected: "<= 45s",
      actual: formatDuration(context.medianDurationMs),
    },
    {
      name: "verification-pass-rate",
      severity: "soft",
      passed: (summary.diagnosticsAfter.verification?.passRatePercent ?? 0) >= 80,
      expected: ">= 80%",
      actual: `${summary.diagnosticsAfter.verification?.passRatePercent ?? 0}%`,
    },
    {
      name: "peak-context-usage",
      severity: "soft",
      passed: (summary.diagnosticsAfter.contextUsage?.peakUsagePercent ?? 100) < 85,
      expected: "< 85%",
      actual: `${summary.diagnosticsAfter.contextUsage?.peakUsagePercent ?? "n/a"}%`,
    },
    {
      name: "fallback-count",
      severity: "soft",
      passed: (summary.diagnosticsAfter.gemma4?.toolCallFallbackCount ?? 0) === 0,
      expected: "0",
      actual: String(summary.diagnosticsAfter.gemma4?.toolCallFallbackCount ?? 0),
    },
  ];

  return { hard, soft };
}

async function writeSummaryMarkdown(filePath: string, summary: LaunchBenchmarkSummary): Promise<void> {
  const selection = summary.workflows["selection-rewrite"];
  const downloads = summary.workflows["downloads-organize"];
  const context = summary.workflows["context-todo"];
  const hardLines = summary.gates.hard.map(
    (gate) => `- [${gate.passed ? "x" : " "}] ${gate.name}: expected ${gate.expected}, got ${gate.actual}`,
  );
  const softLines = summary.gates.soft.map(
    (gate) => `- [${gate.passed ? "x" : " "}] ${gate.name}: expected ${gate.expected}, got ${gate.actual}`,
  );

  const content = [
    "# Cortex Launch Benchmark Summary",
    "",
    `- Started: ${summary.startedAt}`,
    `- Completed: ${summary.completedAt}`,
    `- Output dir: ${summary.outputDir}`,
    `- L2 enabled: ${summary.l2Enabled ? "yes" : "no"}`,
    `- L2 required: ${summary.l2Required ? "yes" : "no"}`,
    `- Hard gates: ${summary.gates.hardPass ? "PASS" : "FAIL"}`,
    "",
    "## Workflow Summary",
    "",
    `- Selection rewrite: ${selection.passed}/${selection.total} pass (${selection.successRate}%), median ${formatDuration(selection.medianDurationMs)}, avg L2 ${selection.averageL2Composite ?? "n/a"}`,
    `- Downloads organize + rollback: ${downloads.passed}/${downloads.total} pass (${downloads.successRate}%), median ${formatDuration(downloads.medianDurationMs)}`,
    `- Context todo: ${context.passed}/${context.total} pass (${context.successRate}%), median ${formatDuration(context.medianDurationMs)}, avg L2 ${context.averageL2Composite ?? "n/a"}`,
    "",
    "## Hard Gates",
    "",
    ...hardLines,
    "",
    "## Soft Signals",
    "",
    ...softLines,
    "",
  ].join("\n");

  await writeFile(filePath, content, "utf-8");
}

export async function runLaunchBenchmarkSuite(
  options: LaunchBenchmarkRunOptions = {},
): Promise<LaunchBenchmarkSummary> {
  const l2Required = options.requireL2 ?? (process.env.EVAL_L2 === "1");
  const lmStudioAvailable = await isLmStudioUp();
  if (!lmStudioAvailable) {
    throw new Error("LM Studio not reachable — launch benchmark cannot run.");
  }

  const outputDir = await prepareResultsDir(options.outputDir);
  const collector = new TestMetricsCollector();
  const startedAt = new Date().toISOString();

  const [selectionPack, downloadsPack, contextPack] = await Promise.all([
    loadPromptPack<SelectionLaunchCase>(
      path.join(PROMPTS_ROOT, "selection-rewrite"),
      "selection-rewrite",
    ),
    loadPromptPack<DownloadsLaunchCase>(
      path.join(PROMPTS_ROOT, "downloads-organize"),
      "downloads-organize",
    ),
    loadPromptPack<ContextLaunchCase>(
      path.join(PROMPTS_ROOT, "context-todo"),
      "context-todo",
    ),
  ]);

  const workspace = await createTempWorkspace();
  const liveServer = await startLiveServer(workspace.runtime);
  const service = new AgentCoreServiceHarness(workspace.runtime);

  try {
    const health = await fetchJson<{ ok: boolean; service?: string; model?: string }>(
      liveServer.baseUrl,
      "/health",
    );
    const diagnosticsBefore = await fetchJson<DiagnosticsResponse>(
      liveServer.baseUrl,
      "/diagnostics",
    );

    await writeJson(path.join(outputDir, "diagnostics-before.json"), diagnosticsBefore);

    const caseResults: LaunchCaseResult[] = [];

    for (const benchmarkCase of selectionPack.cases) {
      caseResults.push(await runSelectionCase({
        baseUrl: liveServer.baseUrl,
        outputDir,
        service,
        traceRecorder: workspace.runtime.traceRecorder,
        collector,
        promptPack: selectionPack,
        benchmarkCase,
      }));
    }

    for (const benchmarkCase of downloadsPack.cases) {
      caseResults.push(await runDownloadsCase({
        baseUrl: liveServer.baseUrl,
        outputDir,
        service,
        traceRecorder: workspace.runtime.traceRecorder,
        workspaceDir: workspace.workspaceDir,
        collector,
        promptPack: downloadsPack,
        benchmarkCase,
      }));
    }

    for (const benchmarkCase of contextPack.cases) {
      caseResults.push(await runContextCase({
        baseUrl: liveServer.baseUrl,
        outputDir,
        service,
        traceRecorder: workspace.runtime.traceRecorder,
        collector,
        promptPack: contextPack,
        benchmarkCase,
      }));
    }

    await collector.runL2Eval(SUITE);
    const metricByCaseId = new Map(collector.metrics.map((metric) => [metric.testName, metric]));

    for (const result of caseResults) {
      const metric = metricByCaseId.get(result.caseId);
      if (metric?.evalResult) {
        result.qualityEval = {
          scores: metric.evalResult.scores.map((score) => ({
            dimension: score.dimension,
            value: score.value,
            threshold: score.threshold,
            passed: score.passed,
            explanation: score.explanation,
            checklist: [],
          })),
          compositeScore: metric.evalResult.compositeScore,
          allPassed: metric.evalResult.allPassed,
          judgeLatencyMs: metric.evalResult.judgeLatencyMs,
          judgeModel: process.env.EVAL_JUDGE_MODEL || process.env.AGENT_CORE_MODEL || "google/gemma-4-26b-a4b",
          judgeError: metric.evalResult.judgeError,
        };
        if (l2Required && result.workflowId !== "downloads-organize" && !result.qualityEval.allPassed) {
          result.status = "fail";
          metric.status = "fail";
          result.error = result.error
            ? `${result.error}; L2 quality gate failed`
            : "L2 quality gate failed";
        }
        await writeJson(result.artifacts.judgePath ?? path.join(result.artifacts.artifactDir, "judge.json"), result.qualityEval);
      } else if (l2Required && result.workflowId !== "downloads-organize") {
        result.status = "fail";
        if (metric) {
          metric.status = "fail";
        }
        result.error = result.error
          ? `${result.error}; missing L2 evaluation`
          : "Missing required L2 evaluation";
      }
    }

    const diagnosticsAfter = await fetchJson<DiagnosticsResponse>(
      liveServer.baseUrl,
      "/diagnostics",
    );
    await writeJson(path.join(outputDir, "diagnostics-after.json"), diagnosticsAfter);

    const workflowSummary: Record<LaunchCaseResult["workflowId"], LaunchWorkflowSummary> = {
      "selection-rewrite": summarizeWorkflow(
        caseResults.filter((result) => result.workflowId === "selection-rewrite"),
        "selection-rewrite",
      ),
      "downloads-organize": summarizeWorkflow(
        caseResults.filter((result) => result.workflowId === "downloads-organize"),
        "downloads-organize",
      ),
      "context-todo": summarizeWorkflow(
        caseResults.filter((result) => result.workflowId === "context-todo"),
        "context-todo",
      ),
    };

    const gates = buildGateResults({
      l2Required,
      workflows: workflowSummary,
      diagnosticsAfter,
    });

    const reportPath = options.emitHtmlReport === false
      ? undefined
      : await writeReport(
          collector.toJSON() as Parameters<typeof writeReport>[0],
          outputDir,
        );

    const summary: LaunchBenchmarkSummary = {
      startedAt,
      completedAt: new Date().toISOString(),
      outputDir,
      l2Enabled: process.env.EVAL_L2 === "1",
      l2Required,
      health,
      workflows: workflowSummary,
      gates: {
        hardPass: gates.hard.every((gate) => gate.passed),
        hard: gates.hard,
        soft: gates.soft,
      },
      diagnosticsBefore,
      diagnosticsAfter,
      reportPath,
    };

    await writeJson(path.join(outputDir, "summary.json"), summary);
    await writeSummaryMarkdown(path.join(outputDir, "summary.md"), summary);
    await writeJson(path.join(outputDir, "workflow-a-selection.json"), workflowSummary["selection-rewrite"]);
    await writeJson(path.join(outputDir, "workflow-b-downloads.json"), workflowSummary["downloads-organize"]);
    await writeJson(path.join(outputDir, "workflow-c-context.json"), workflowSummary["context-todo"]);

    return summary;
  } finally {
    await liveServer.close();
    await workspace.cleanup();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let outputDir: string | undefined;
  let ci = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output-dir") {
      outputDir = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--ci") {
      ci = true;
    }
  }

  const summary = await runLaunchBenchmarkSuite({ outputDir });

  console.log("");
  console.log("═".repeat(72));
  console.log("  Cortex Launch Benchmark");
  console.log("═".repeat(72));
  console.log(`  Output:      ${summary.outputDir}`);
  console.log(`  Hard gates:  ${summary.gates.hardPass ? "PASS" : "FAIL"}`);
  console.log(`  L2 required: ${summary.l2Required ? "yes" : "no"}`);
  console.log(`  Selection:   ${summary.workflows["selection-rewrite"].passed}/${summary.workflows["selection-rewrite"].total}`);
  console.log(`  Downloads:   ${summary.workflows["downloads-organize"].passed}/${summary.workflows["downloads-organize"].total}`);
  console.log(`  Context:     ${summary.workflows["context-todo"].passed}/${summary.workflows["context-todo"].total}`);
  if (summary.reportPath) {
    console.log(`  Report:      ${summary.reportPath}`);
  }
  console.log("═".repeat(72));
  console.log("");

  if (ci && !summary.gates.hardPass) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}

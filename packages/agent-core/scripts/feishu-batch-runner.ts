import "dotenv/config";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseFeishuPostContent } from "../src/channels/feishu.js";

import {
  defaultFeishuCasePack,
  type FeishuCasePack,
  type FeishuCaseStep,
  type FeishuStepAssertions,
  type FeishuTestCase,
} from "./feishu-smoke-cases.js";

const execFileAsync = promisify(execFile);
const RECENT_MESSAGES_LOOKBACK_MS = 10 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_HEALTH_URL = "http://127.0.0.1:8787/health";

type SendTransport = "ui" | "api";

interface RunnerOptions {
  chatId: string;
  transport: SendTransport;
  appName: string;
  casesFilter?: string[];
  dryRun: boolean;
  pollIntervalMs: number;
  defaultReplyTimeoutMs: number;
  defaultSettleMs: number;
  healthUrl?: string;
}

interface FeishuHistoryMessage {
  messageId: string;
  msgType: string;
  content: string;
  senderType?: string;
  senderId?: string;
  createTimeMs: number;
  updateTimeMs: number;
  raw: unknown;
}

interface StepResult {
  caseId: string;
  stepId: string;
  prompt: string;
  status: "pass" | "fail";
  failureReason?: string;
  sendTransport: SendTransport;
  sendMessageId?: string | null;
  replyTimedOut: boolean;
  replyText: string;
  replyMessages: Array<{
    messageId: string;
    msgType: string;
    senderType?: string;
    createTimeMs: number;
    updateTimeMs: number;
    text: string;
  }>;
  durationMs: number;
}

interface CaseResult {
  id: string;
  title: string;
  status: "pass" | "fail";
  stepResults: StepResult[];
}

interface RunReport {
  suiteName: string;
  startedAt: string;
  durationMs: number;
  transport: SendTransport;
  chatId: string;
  appName: string;
  summary: {
    totalCases: number;
    passCases: number;
    failCases: number;
    totalSteps: number;
    passSteps: number;
    failSteps: number;
  };
  cases: CaseResult[];
}

interface FeishuListMessagesResponse {
  data?: {
    items?: unknown[];
    page_token?: string;
    has_more?: boolean;
  };
  code?: number;
  msg?: string;
}

function usage(): string {
  return [
    "Usage:",
    "  npm run feishu:test -- --chat <chat_id> [--transport ui|api] [--filter help,summarize]",
    "",
    "Options:",
    "  --chat <chat_id>        Target Feishu chat ID. Can also use FEISHU_TEST_CHAT_ID.",
    "  --transport <mode>     'ui' (default) pastes into the current Feishu chat, 'api' sends as bot.",
    "  --app <name>           Desktop app name for UI mode. Default: Feishu.",
    "  --filter <csv>         Only run matching case ids/titles.",
    "  --poll-ms <ms>         Poll interval for reply observation. Default: 1500.",
    "  --timeout-ms <ms>      Default per-step reply timeout. Overrides case-pack default.",
    "  --settle-ms <ms>       How long a reply must stay unchanged before we treat it as final.",
    "  --health-url <url>     Optional local health endpoint. Default: http://127.0.0.1:8787/health.",
    "  --dry-run              Print prompts without sending anything.",
    "  --help                 Show this help.",
    "",
    "Environment:",
    "  FEISHU_APP_ID / FEISHU_APP_SECRET are required for chat-history polling.",
    "  FEISHU_TEST_CHAT_ID, FEISHU_TEST_TRANSPORT, FEISHU_TEST_APP_NAME are optional defaults.",
    "",
    "UI mode:",
    "  1. Open the target chat in Feishu desktop app",
    "  2. Put the text cursor in the input box",
    "  3. Run this command",
  ].join("\n");
}

function parseCsv(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const values = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseArgs(argv: string[]): RunnerOptions {
  const args = [...argv];
  let chatId = process.env.FEISHU_TEST_CHAT_ID?.trim() || "";
  let transport = (process.env.FEISHU_TEST_TRANSPORT?.trim().toLowerCase() || "ui") as SendTransport;
  let appName = process.env.FEISHU_TEST_APP_NAME?.trim() || "Feishu";
  let casesFilter = parseCsv(process.env.FEISHU_TEST_FILTER);
  let dryRun = false;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let defaultReplyTimeoutMs = defaultFeishuCasePack.defaultReplyTimeoutMs ?? 45_000;
  let defaultSettleMs = defaultFeishuCasePack.defaultSettleMs ?? 4_000;
  let healthUrl = process.env.FEISHU_TEST_HEALTH_URL?.trim() || DEFAULT_HEALTH_URL;

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--chat":
        chatId = args.shift() ?? "";
        break;
      case "--transport": {
        const value = (args.shift() ?? "").trim().toLowerCase();
        if (value === "ui" || value === "api") {
          transport = value;
        }
        break;
      }
      case "--app":
        appName = args.shift() ?? appName;
        break;
      case "--filter":
        casesFilter = parseCsv(args.shift());
        break;
      case "--poll-ms":
        pollIntervalMs = Number(args.shift() ?? pollIntervalMs) || pollIntervalMs;
        break;
      case "--timeout-ms":
        defaultReplyTimeoutMs = Number(args.shift() ?? defaultReplyTimeoutMs) || defaultReplyTimeoutMs;
        break;
      case "--settle-ms":
        defaultSettleMs = Number(args.shift() ?? defaultSettleMs) || defaultSettleMs;
        break;
      case "--health-url":
        healthUrl = args.shift() ?? healthUrl;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!chatId) {
    throw new Error("Missing --chat <chat_id> (or FEISHU_TEST_CHAT_ID).");
  }
  if (transport !== "ui" && transport !== "api") {
    throw new Error(`Unsupported transport: ${transport}`);
  }

  return {
    chatId,
    transport,
    appName,
    casesFilter,
    dryRun,
    pollIntervalMs,
    defaultReplyTimeoutMs,
    defaultSettleMs,
    healthUrl,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : 0;
}

function firstString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decodeHtmlEntities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }

  const decodeCodePoint = (value: number, fallback: string): string => {
    try {
      return String.fromCodePoint(value);
    } catch {
      return fallback;
    }
  };

  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lowerEntity = entity.toLowerCase();
    if (lowerEntity.startsWith("#x")) {
      const value = Number.parseInt(lowerEntity.slice(2), 16);
      return Number.isFinite(value) ? decodeCodePoint(value, match) : match;
    }
    if (lowerEntity.startsWith("#")) {
      const value = Number.parseInt(lowerEntity.slice(1), 10);
      return Number.isFinite(value) ? decodeCodePoint(value, match) : match;
    }
    return namedEntities[lowerEntity] ?? match;
  });
}

function toUnixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

export function parseInteractiveCardText(card: unknown): string {
  if (!isRecord(card)) {
    return "";
  }

  const lines: string[] = [];
  const legacyElements = Array.isArray(card.elements) ? card.elements : null;
  const legacyTitle = typeof card.title === "string" ? card.title : null;
  if (legacyTitle && legacyTitle.trim().length > 0) {
    lines.push(legacyTitle.trim());
  }
  const headerTitle = firstString([
    isRecord(card.header) && isRecord(card.header.title) ? card.header.title.content : undefined,
    isRecord(card.header) && isRecord(card.header.title) ? card.header.title.text : undefined,
  ]);
  if (headerTitle) {
    lines.push(headerTitle);
  }

  // Feishu sometimes serializes bot replies into a lightweight rich-text
  // shape like { title, elements: [[{ tag: "text", text: "..." }]] }.
  // Support that alongside the old-style card schema used by sendDraft.
  if (legacyElements && legacyElements.every((element) => Array.isArray(element))) {
    for (const paragraph of legacyElements) {
      const text = paragraph
        .map((element) => {
          if (!isRecord(element)) {
            return "";
          }
          if (typeof element.text === "string") {
            return element.text;
          }
          return "";
        })
        .join("")
        .trim();
      if (text) {
        lines.push(decodeHtmlEntities(text));
      }
    }
    return decodeHtmlEntities(lines.join("\n").trim());
  }

  const elements = legacyElements ?? [];
  for (const element of elements) {
    if (!isRecord(element)) {
      continue;
    }
    const tag = element.tag;
    if (tag === "markdown" && typeof element.content === "string") {
      lines.push(decodeHtmlEntities(element.content));
      continue;
    }
    if (tag === "note" && Array.isArray(element.elements)) {
      for (const noteElement of element.elements) {
        if (!isRecord(noteElement)) {
          continue;
        }
        const noteText = firstString([
          noteElement.content,
          isRecord(noteElement.text) ? noteElement.text.content : undefined,
        ]);
        if (noteText) {
          lines.push(decodeHtmlEntities(noteText));
        }
      }
      continue;
    }
    if (tag === "action" && Array.isArray(element.actions)) {
      const labels = element.actions
        .map((action) => {
          if (!isRecord(action)) {
            return undefined;
          }
          return firstString([
            isRecord(action.text) ? action.text.content : undefined,
            isRecord(action.text) ? action.text.text : undefined,
          ]);
        })
        .filter((value): value is string => Boolean(value));
      if (labels.length > 0) {
        lines.push(`[buttons] ${labels.join(" | ")}`);
      }
    }
  }

  return decodeHtmlEntities(lines.join("\n").trim());
}

export function parseFeishuMessageText(
  msgType: string,
  rawContent: string,
): string {
  if (!rawContent) {
    return "";
  }

  try {
    if (msgType === "text") {
      const parsed = JSON.parse(rawContent) as { text?: string };
      return parsed.text?.trim() || "";
    }
    if (msgType === "post") {
      return parseFeishuPostContent(rawContent) ?? "";
    }
    if (msgType === "interactive") {
      return parseInteractiveCardText(JSON.parse(rawContent));
    }
  } catch {
    return rawContent.trim();
  }

  return rawContent.trim();
}

function normalizeHistoryMessage(raw: unknown): FeishuHistoryMessage | null {
  if (!isRecord(raw)) {
    return null;
  }
  const body = isRecord(raw.body) ? raw.body : {};
  const sender = isRecord(raw.sender) ? raw.sender : {};
  const senderId = isRecord(sender.sender_id) ? sender.sender_id : {};

  const messageId = firstString([raw.message_id, raw.messageId]);
  if (!messageId) {
    return null;
  }

  const msgType = firstString([body.msg_type, raw.msg_type, raw.msgType]) ?? "unknown";
  const content = normalizeContent(body.content ?? raw.content);

  return {
    messageId,
    msgType,
    content,
    senderType: firstString([sender.sender_type, sender.senderType]),
    senderId: firstString([
      senderId.open_id,
      senderId.user_id,
      senderId.union_id,
      sender.open_id,
      sender.user_id,
    ]),
    createTimeMs: toNumber(raw.create_time ?? raw.createTime),
    updateTimeMs: toNumber(raw.update_time ?? raw.updateTime),
    raw,
  };
}

export function evaluateAssertions(
  text: string,
  assertions: FeishuStepAssertions | undefined,
): string[] {
  if (!assertions) {
    return [];
  }

  const failures: string[] = [];
  for (const needle of assertions.allOf ?? []) {
    if (!text.includes(needle)) {
      failures.push(`missing required text: ${needle}`);
    }
  }

  const anyOf = assertions.anyOf ?? [];
  if (anyOf.length > 0 && !anyOf.some((needle) => text.includes(needle))) {
    failures.push(`missing any-of texts: ${anyOf.join(" | ")}`);
  }

  for (const needle of assertions.noneOf ?? []) {
    if (text.includes(needle)) {
      failures.push(`found forbidden text: ${needle}`);
    }
  }

  return failures;
}

function isStreamingPlaceholderText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  return [
    "✍️ 正在总结…",
    "🔎 正在搜索",
    "Mantle · generating…",
    "…",
  ].some((needle) => normalized.includes(needle));
}

function renderMessageForReport(message: FeishuHistoryMessage): StepResult["replyMessages"][number] {
  return {
    messageId: message.messageId,
    msgType: message.msgType,
    senderType: message.senderType,
    createTimeMs: message.createTimeMs,
    updateTimeMs: message.updateTimeMs,
    text: parseFeishuMessageText(message.msgType, message.content),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FeishuApiClient {
  private accessToken?: string;
  private accessTokenExpiresAtMs = 0;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAtMs - 60_000) {
      return this.accessToken;
    }

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch tenant_access_token: HTTP ${response.status}`);
    }

    const payload = await response.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`Failed to fetch tenant_access_token: ${payload.msg ?? "unknown error"}`);
    }

    this.accessToken = payload.tenant_access_token;
    this.accessTokenExpiresAtMs = Date.now() + (payload.expire ?? 7200) * 1000;
    return this.accessToken;
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    pathname: string,
    options: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const accessToken = await this.getAccessToken();
    const url = new URL(`https://open.feishu.cn${pathname}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(`${method} ${pathname} failed: HTTP ${response.status}`);
    }
    return await response.json() as T;
  }

  async sendTextMessage(chatId: string, text: string): Promise<string | null> {
    const payload = await this.requestJson<{
      code?: number;
      msg?: string;
      data?: { message_id?: string };
    }>("POST", "/open-apis/im/v1/messages", {
      query: { receive_id_type: "chat_id" },
      body: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    if (payload.code !== 0) {
      throw new Error(`sendTextMessage failed: ${payload.msg ?? "unknown error"}`);
    }
    return payload.data?.message_id ?? null;
  }

  async listChatMessages(chatId: string, startTimeMs: number): Promise<FeishuHistoryMessage[]> {
    const items: FeishuHistoryMessage[] = [];
    let pageToken: string | undefined;

    while (true) {
      const payload = await this.requestJson<FeishuListMessagesResponse>("GET", "/open-apis/im/v1/messages", {
        query: {
          container_id_type: "chat",
          container_id: chatId,
          sort_type: "ByCreateTimeAsc",
          start_time: Math.max(0, toUnixSeconds(startTimeMs)),
          page_size: 50,
          page_token: pageToken,
        },
      });

      if (payload.code !== 0) {
        throw new Error(`listChatMessages failed: ${payload.msg ?? "unknown error"}`);
      }

      for (const rawItem of payload.data?.items ?? []) {
        const normalized = normalizeHistoryMessage(rawItem);
        if (normalized) {
          items.push(normalized);
        }
      }

      if (!payload.data?.has_more || !payload.data.page_token) {
        break;
      }
      pageToken = payload.data.page_token;
    }

    return items;
  }
}

async function getClipboardText(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pbpaste", []);
    return stdout;
  } catch {
    return "";
  }
}

async function setClipboardText(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy", []);
    child.on("error", reject);
    child.stdin.write(text);
    child.stdin.end();
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pbcopy exited with code ${code ?? 1}`));
      }
    });
  });
}

async function sendViaUi(appName: string, prompt: string): Promise<void> {
  const previousClipboard = await getClipboardText();
  try {
    await setClipboardText(prompt);
    const script = [
      `tell application "${appName}" to activate`,
      "delay 0.3",
      'tell application "System Events"',
      '  keystroke "v" using command down',
      "  delay 0.1",
      "  key code 36",
      "end tell",
    ];
    try {
      await execFileAsync("osascript", script.flatMap((line) => ["-e", line]), {
        timeout: 15_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("不允许发送按键") || message.includes("(1002)")) {
        throw new Error(
          "UI send blocked by macOS permissions. Grant Accessibility/Automation permission to the app running this command so it can control System Events and send keystrokes into Feishu.",
        );
      }
      throw error;
    }
  } finally {
    await setClipboardText(previousClipboard);
  }
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(4_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function filterCasePack(casePack: FeishuCasePack, filters: string[] | undefined): FeishuCasePack {
  if (!filters || filters.length === 0) {
    return casePack;
  }
  const lowered = filters.map((value) => value.toLowerCase());
  return {
    ...casePack,
    cases: casePack.cases.filter((testCase) => {
      const haystack = `${testCase.id} ${testCase.title}`.toLowerCase();
      return lowered.some((needle) => haystack.includes(needle));
    }),
  };
}

function isBotReplyCandidate(
  message: FeishuHistoryMessage,
  seenBefore: Map<string, number>,
  startedAtMs: number,
  sentMessageId?: string | null,
  sentPrompt?: string,
): boolean {
  if (sentMessageId && message.messageId === sentMessageId) {
    return false;
  }

  const parsedText = parseFeishuMessageText(message.msgType, message.content).trim();
  if (sentPrompt && parsedText === sentPrompt.trim()) {
    return false;
  }

  if (message.senderType?.toLowerCase() === "user") {
    return false;
  }

  const effectiveUpdateTime = message.updateTimeMs || message.createTimeMs;
  if (effectiveUpdateTime < startedAtMs) {
    return false;
  }

  const previousUpdateTime = seenBefore.get(message.messageId);
  if (previousUpdateTime === undefined) {
    return true;
  }

  if (effectiveUpdateTime <= previousUpdateTime) {
    return false;
  }

  return true;
}

async function waitForReplies(
  client: FeishuApiClient,
  options: {
    chatId: string;
    startedAtMs: number;
    sentMessageId?: string | null;
    sentPrompt?: string;
    seenBefore: Map<string, number>;
    timeoutMs: number;
    settleMs: number;
    pollIntervalMs: number;
  },
): Promise<{ messages: FeishuHistoryMessage[]; timedOut: boolean }> {
  let latestMessages: FeishuHistoryMessage[] = [];
  let lastSignature = "";
  let lastChangeAtMs = Date.now();

  while (Date.now() < options.startedAtMs + options.timeoutMs) {
    const messages = await client.listChatMessages(
      options.chatId,
      options.startedAtMs - 5_000,
    );
    const candidates = messages.filter((message) =>
      isBotReplyCandidate(
        message,
        options.seenBefore,
        options.startedAtMs,
        options.sentMessageId,
        options.sentPrompt,
      )
    );

    const signature = JSON.stringify(
      candidates.map((message) => ({
        id: message.messageId,
        text: parseFeishuMessageText(message.msgType, message.content),
        updatedAt: message.updateTimeMs || message.createTimeMs,
      })),
    );

    if (signature !== lastSignature) {
      lastSignature = signature;
      latestMessages = candidates;
      lastChangeAtMs = Date.now();
    }

    const hasNonPlaceholder = latestMessages.some((message) => {
      const text = parseFeishuMessageText(message.msgType, message.content);
      return !isStreamingPlaceholderText(text);
    });

    if (
      latestMessages.length > 0 &&
      hasNonPlaceholder &&
      Date.now() - lastChangeAtMs >= options.settleMs
    ) {
      return { messages: latestMessages, timedOut: false };
    }

    await sleep(options.pollIntervalMs);
  }

  return {
    messages: latestMessages,
    timedOut: true,
  };
}

async function collectRecentMessageState(
  client: FeishuApiClient,
  chatId: string,
): Promise<Map<string, number>> {
  const messages = await client.listChatMessages(chatId, Date.now() - RECENT_MESSAGES_LOOKBACK_MS);
  const state = new Map<string, number>();
  for (const message of messages) {
    state.set(message.messageId, message.updateTimeMs || message.createTimeMs);
  }
  return state;
}

async function runStep(
  client: FeishuApiClient,
  runnerOptions: RunnerOptions,
  testCase: FeishuTestCase,
  step: FeishuCaseStep,
  defaultReplyTimeoutMs: number,
  defaultSettleMs: number,
): Promise<StepResult> {
  const stepId = step.id ?? `${testCase.id}-${testCase.steps.indexOf(step) + 1}`;
  const startedAtMs = Date.now();

  if (runnerOptions.dryRun) {
    return {
      caseId: testCase.id,
      stepId,
      prompt: step.prompt,
      status: "pass",
      sendTransport: runnerOptions.transport,
      sendMessageId: null,
      replyTimedOut: false,
      replyText: "(dry-run)",
      replyMessages: [],
      durationMs: 0,
    };
  }

  const seenBefore = await collectRecentMessageState(client, runnerOptions.chatId);

  let sentMessageId: string | null = null;
  if (runnerOptions.transport === "api") {
    sentMessageId = await client.sendTextMessage(runnerOptions.chatId, step.prompt);
  } else {
    await sendViaUi(runnerOptions.appName, step.prompt);
  }

  const waitResult = await waitForReplies(client, {
    chatId: runnerOptions.chatId,
    startedAtMs,
    sentMessageId,
    sentPrompt: step.prompt,
    seenBefore,
    timeoutMs: step.replyTimeoutMs ?? defaultReplyTimeoutMs,
    settleMs: step.settleMs ?? defaultSettleMs,
    pollIntervalMs: runnerOptions.pollIntervalMs,
  });

  const normalizedMessages = waitResult.messages
    .filter((message) => !isStreamingPlaceholderText(parseFeishuMessageText(message.msgType, message.content)));
  const replyMessages = (normalizedMessages.length > 0 ? normalizedMessages : waitResult.messages)
    .map(renderMessageForReport);
  const replyText = replyMessages.map((message) => message.text).filter(Boolean).join("\n\n");
  const failures = evaluateAssertions(replyText, step.assertions);
  if (waitResult.timedOut && replyMessages.length === 0) {
    failures.unshift("timed out waiting for bot reply");
  }

  return {
    caseId: testCase.id,
    stepId,
    prompt: step.prompt,
    status: failures.length === 0 ? "pass" : "fail",
    failureReason: failures.join("; ") || undefined,
    sendTransport: runnerOptions.transport,
    sendMessageId: sentMessageId,
    replyTimedOut: waitResult.timedOut,
    replyText,
    replyMessages,
    durationMs: Date.now() - startedAtMs,
  };
}

function renderMarkdownReport(report: RunReport, reportPath: string): string {
  const lines: string[] = [
    `# ${report.suiteName}`,
    "",
    `- Started: ${report.startedAt}`,
    `- Duration: ${report.durationMs} ms`,
    `- Transport: ${report.transport}`,
    `- Chat ID: \`${report.chatId}\``,
    `- App: ${report.appName}`,
    `- Report JSON: \`${reportPath}\``,
    "",
    "## Summary",
    "",
    `- Cases: ${report.summary.passCases}/${report.summary.totalCases} passed`,
    `- Steps: ${report.summary.passSteps}/${report.summary.totalSteps} passed`,
    "",
    "## Results",
    "",
  ];

  for (const caseResult of report.cases) {
    lines.push(`### ${caseResult.status === "pass" ? "PASS" : "FAIL"} ${caseResult.id} — ${caseResult.title}`);
    lines.push("");
    for (const step of caseResult.stepResults) {
      lines.push(`- ${step.status === "pass" ? "PASS" : "FAIL"} ${step.stepId} (${step.durationMs} ms)`);
      lines.push(`  Prompt: ${step.prompt}`);
      if (step.failureReason) {
        lines.push(`  Reason: ${step.failureReason}`);
      }
      if (step.replyText) {
        lines.push("  Reply:");
        lines.push("  ```text");
        lines.push(...step.replyText.split("\n").map((line) => `  ${line}`));
        lines.push("  ```");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function writeReport(report: RunReport): Promise<{ jsonPath: string; markdownPath: string }> {
  const reportDir = path.resolve(".agent-core", "reports");
  await mkdir(reportDir, { recursive: true });
  const timestamp = report.startedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(reportDir, `feishu-${timestamp}.json`);
  const markdownPath = path.join(reportDir, `feishu-${timestamp}.md`);

  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(markdownPath, renderMarkdownReport(report, jsonPath), "utf8");
  return { jsonPath, markdownPath };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if ((!appId || !appSecret) && !options.dryRun) {
    throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required.");
  }

  const casePack = filterCasePack(defaultFeishuCasePack, options.casesFilter);
  if (casePack.cases.length === 0) {
    throw new Error("No Feishu test cases matched the current filter.");
  }

  const healthOk = options.healthUrl ? await checkHealth(options.healthUrl) : false;
  if (options.healthUrl) {
    console.log(`[preflight] health ${healthOk ? "ok" : "unreachable"}: ${options.healthUrl}`);
  }

  if (options.transport === "ui") {
    console.log(`[preflight] UI mode: open chat ${options.chatId} in ${options.appName} and focus the input box.`);
    if (!options.dryRun) {
      await sleep(2_000);
    }
  }

  const caseResults: CaseResult[] = [];
  const startedAt = new Date().toISOString();
  const runStartedAtMs = Date.now();
  const client = appId && appSecret ? new FeishuApiClient(appId, appSecret) : null;

  console.log(`[suite] ${casePack.suiteName}`);
  console.log(`[suite] running ${casePack.cases.length} case(s) via ${options.transport}`);

  for (const testCase of casePack.cases) {
    console.log(`\n[case] ${testCase.id} — ${testCase.title}`);
    const stepResults: StepResult[] = [];
    for (const step of testCase.steps) {
      const stepLabel = step.id ?? `${testCase.id}-${testCase.steps.indexOf(step) + 1}`;
      console.log(`[step] ${stepLabel}: ${step.prompt}`);
      if (!client && !options.dryRun) {
        throw new Error("Feishu API client is unavailable.");
      }
      const result = await runStep(
        client as FeishuApiClient,
        options,
        testCase,
        step,
        options.defaultReplyTimeoutMs,
        options.defaultSettleMs,
      );
      stepResults.push(result);
      console.log(
        `[step] ${result.status.toUpperCase()} ${stepLabel}${result.failureReason ? ` — ${result.failureReason}` : ""}`,
      );
    }
    caseResults.push({
      id: testCase.id,
      title: testCase.title,
      status: stepResults.every((step) => step.status === "pass") ? "pass" : "fail",
      stepResults,
    });
  }

  const allStepResults = caseResults.flatMap((caseResult) => caseResult.stepResults);
  const report: RunReport = {
    suiteName: casePack.suiteName,
    startedAt,
    durationMs: Date.now() - runStartedAtMs,
    transport: options.transport,
    chatId: options.chatId,
    appName: options.appName,
    summary: {
      totalCases: caseResults.length,
      passCases: caseResults.filter((caseResult) => caseResult.status === "pass").length,
      failCases: caseResults.filter((caseResult) => caseResult.status === "fail").length,
      totalSteps: allStepResults.length,
      passSteps: allStepResults.filter((step) => step.status === "pass").length,
      failSteps: allStepResults.filter((step) => step.status === "fail").length,
    },
    cases: caseResults,
  };

  const reportPaths = await writeReport(report);
  console.log("\n[report]");
  console.log(`  JSON: ${reportPaths.jsonPath}`);
  console.log(`  Markdown: ${reportPaths.markdownPath}`);
  console.log(
    `  Summary: ${report.summary.passCases}/${report.summary.totalCases} cases passed, ${report.summary.passSteps}/${report.summary.totalSteps} steps passed`,
  );

  assert.equal(report.summary.failCases, 0, "One or more Feishu cases failed.");
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);

if (entryPath === currentPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

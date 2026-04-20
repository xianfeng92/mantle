/**
 * Computer Use middleware — registers macOS desktop control tools that
 * delegate execution to the Mantle native app via local HTTP.
 *
 * Gemma 4 is much more reliable with:
 * - observe -> act -> verify short loops
 * - thicker GUI tools that hide waits / retries
 * - far fewer low-level coordinate or batch-action primitives
 */

import { createHash } from "node:crypto";

import { createMiddleware, tool } from "langchain";
import { z } from "zod";

import { createLogger } from "./logger.js";

const log = createLogger("computer-use");

export const DEFAULT_CORTEX_URL = "http://127.0.0.1:19816";

const DEFAULT_UI_MAX_DEPTH = 6;
const DEFAULT_VERIFY_TIMEOUT_MS = 3_000;
const VERIFY_POLL_INTERVAL_MS = 250;

interface UiSnapshot {
  raw: string;
  normalized: string;
  hash: string;
  focusKey: string;
  preview: string;
}

interface UiVerificationResult {
  ok: boolean;
  changed: boolean;
  focusChanged: boolean;
  expectedMatched: boolean | null;
  beforeHash: string;
  afterHash: string;
  beforePreview: string;
  afterPreview: string;
}

// ---------------------------------------------------------------------------
// Mantle HTTP client
// ---------------------------------------------------------------------------

async function callMantle(
  path: string,
  params: Record<string, unknown> = {},
  baseUrl = DEFAULT_CORTEX_URL,
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  log.debug("call", { path, params: Object.keys(params) });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    const json = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      const errMsg = (json.error as string) ?? `HTTP ${response.status}`;
      throw new Error(errMsg);
    }

    return json.result ?? json;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Mantle computer-use timeout on ${path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(text: string, maxLength = 240): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...[truncated]`;
}

function normalizeUiSnapshot(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractFocusKey(text: string): string {
  return text
    .split("\n")
    .filter((line) => /focus|focused/i.test(line))
    .join("\n")
    .trim();
}

function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

function toUiSnapshot(text: string): UiSnapshot {
  const normalized = normalizeUiSnapshot(text);
  return {
    raw: text,
    normalized,
    hash: hashText(normalized),
    focusKey: extractFocusKey(text),
    preview: truncateText(normalized, 320),
  };
}

async function snapshotUi(maxDepth = DEFAULT_UI_MAX_DEPTH): Promise<UiSnapshot> {
  const raw = String(
    await callMantle("/ui_tree", {
      max_depth: maxDepth,
    }),
  );
  return toUiSnapshot(raw);
}

async function waitForUiVerification(
  before: UiSnapshot,
  options: {
    expected?: string;
    maxDepth?: number;
    timeoutMs?: number;
  } = {},
): Promise<UiVerificationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let latest = before;

  while (Date.now() <= deadline) {
    await sleep(VERIFY_POLL_INTERVAL_MS);
    latest = await snapshotUi(options.maxDepth ?? DEFAULT_UI_MAX_DEPTH);

    const changed = latest.normalized !== before.normalized;
    const focusChanged = latest.focusKey !== before.focusKey;
    const expectedMatched =
      typeof options.expected === "string" && options.expected.length > 0
        ? latest.raw.includes(options.expected)
        : null;

    if (changed || focusChanged || expectedMatched === true) {
      return {
        ok: true,
        changed,
        focusChanged,
        expectedMatched,
        beforeHash: before.hash,
        afterHash: latest.hash,
        beforePreview: before.preview,
        afterPreview: latest.preview,
      };
    }
  }

  const expectedMatched =
    typeof options.expected === "string" && options.expected.length > 0
      ? latest.raw.includes(options.expected)
      : null;

  return {
    ok: expectedMatched === true,
    changed: latest.normalized !== before.normalized,
    focusChanged: latest.focusKey !== before.focusKey,
    expectedMatched,
    beforeHash: before.hash,
    afterHash: latest.hash,
    beforePreview: before.preview,
    afterPreview: latest.preview,
  };
}

function formatResult(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

// Common Chinese → English app name mapping for macOS system apps
const APP_NAME_MAP: Record<string, string> = {
  "备忘录": "Notes",
  "日历": "Calendar",
  "提醒事项": "Reminders",
  "邮件": "Mail",
  "信息": "Messages",
  "地图": "Maps",
  "照片": "Photos",
  "音乐": "Music",
  "播客": "Podcasts",
  "计算器": "Calculator",
  "时钟": "Clock",
  "天气": "Weather",
  "系统设置": "System Settings",
  "系统偏好设置": "System Preferences",
  "访达": "Finder",
  "终端": "Terminal",
  "活动监视器": "Activity Monitor",
  "预览": "Preview",
  "文本编辑": "TextEdit",
  "磁盘工具": "Disk Utility",
  "快捷指令": "Shortcuts",
  "股市": "Stocks",
  "图书": "Books",
  "新闻": "News",
  "家庭": "Home",
  "钥匙串访问": "Keychain Access",
};

function resolveAppName(appName?: string): string | undefined {
  if (!appName) {
    return undefined;
  }
  return APP_NAME_MAP[appName] ?? appName;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const uiTreeTool = tool(
  async (input) => {
    const result = await callMantle("/ui_tree", {
      max_depth: input.max_depth,
    });
    return String(result);
  },
  {
    name: "ui_tree",
    description:
      "获取当前前台应用的 UI 结构树。返回可交互元素的 role/title/value，每个元素有 [index] 可用于点击或赋值。适合调试或需要完整原始树时使用。",
    schema: z.object({
      max_depth: z.number().int().min(1).max(12).default(DEFAULT_UI_MAX_DEPTH),
    }),
  },
);

const observeFrontmostUiTool = tool(
  async (input) => {
    const snapshot = await snapshotUi(input.max_depth);
    return formatResult({
      ok: true,
      type: "ui_snapshot",
      hash: snapshot.hash,
      preview: snapshot.preview,
      tree: snapshot.raw,
    });
  },
  {
    name: "observe_frontmost_ui",
    description:
      "观察前台应用的 UI。返回原始树和简短摘要，用于 short-loop 里的 observe/verify 步骤。",
    schema: z.object({
      max_depth: z.number().int().min(1).max(12).default(DEFAULT_UI_MAX_DEPTH),
    }),
  },
);

const screenshotTool = tool(
  async (input) => {
    const effectiveTarget =
      input.target === "app" && !input.app_bundle_id ? "fullscreen" : input.target;

    const result = await callMantle("/screenshot", {
      target: effectiveTarget,
      ...(input.app_bundle_id ? { app_bundle_id: input.app_bundle_id } : {}),
    });
    const base64 = String(result);
    return `[screenshot captured: ${Math.round((base64.length * 0.75) / 1024)} KB JPEG]`;
  },
  {
    name: "screenshot",
    description:
      "截取屏幕截图。适合视觉调试，不建议作为默认操作链路的第一选择。",
    schema: z.object({
      target: z.enum(["fullscreen", "app"]).default("fullscreen"),
      app_bundle_id: z.string().optional(),
    }),
  },
);

const openAppAndObserveTool = tool(
  async (input) => {
    const appName = resolveAppName(input.app_name);
    const result = await callMantle("/open_app", {
      app_name: appName,
      bundle_id: input.bundle_id,
    });
    const opened = String(result) === "ok";
    if (!opened) {
      return formatResult({
        ok: false,
        action: "open_app_and_observe",
        error: String(result),
      });
    }

    await sleep(input.wait_ms);
    const snapshot = await snapshotUi(input.max_depth);

    return formatResult({
      ok: true,
      action: "open_app_and_observe",
      appName: input.app_name ?? input.bundle_id,
      hash: snapshot.hash,
      preview: snapshot.preview,
      tree: snapshot.raw,
    });
  },
  {
    name: "open_app_and_observe",
    description:
      "打开应用并等待其成为前台，然后立即返回 UI 观察结果。适合作为 GUI 任务的第一步。",
    schema: z.object({
      app_name: z.string().optional(),
      bundle_id: z.string().optional(),
      max_depth: z.number().int().min(1).max(12).default(DEFAULT_UI_MAX_DEPTH),
      wait_ms: z.number().int().min(250).max(5_000).default(1_200),
    }),
  },
);

const clickElementAndWaitTool = tool(
  async (input) => {
    const before = await snapshotUi(input.max_depth);
    const clickResult = await callMantle("/click_element", {
      index: input.index,
    });
    if (String(clickResult) !== "ok") {
      return formatResult({
        ok: false,
        action: "click_element_and_wait",
        index: input.index,
        error: String(clickResult),
      });
    }

    const verification = await waitForUiVerification(before, {
      expected: input.expected,
      maxDepth: input.max_depth,
      timeoutMs: input.timeout_ms,
    });

    return formatResult({
      action: "click_element_and_wait",
      index: input.index,
      expected: input.expected ?? null,
      ...verification,
    });
  },
  {
    name: "click_element_and_wait",
    description:
      "按元素 index 点击，并自动等待 UI 变化或预期文本出现。默认 GUI 点击优先用它，不要自己思考 sleep。",
    schema: z.object({
      index: z.number().int().min(0),
      expected: z.string().optional(),
      max_depth: z.number().int().min(1).max(12).default(DEFAULT_UI_MAX_DEPTH),
      timeout_ms: z.number().int().min(500).max(8_000).default(DEFAULT_VERIFY_TIMEOUT_MS),
    }),
  },
);

const setValueAndVerifyTool = tool(
  async (input) => {
    const before = await snapshotUi(input.max_depth);
    const result = await callMantle("/set_value", {
      index: input.index,
      value: input.value,
    });
    if (String(result) !== "ok") {
      return formatResult({
        ok: false,
        action: "set_value_and_verify",
        index: input.index,
        error: String(result),
      });
    }

    const verification = await waitForUiVerification(before, {
      expected: input.expected ?? input.value,
      maxDepth: input.max_depth,
      timeoutMs: input.timeout_ms,
    });

    return formatResult({
      action: "set_value_and_verify",
      index: input.index,
      expected: input.expected ?? input.value,
      ...verification,
    });
  },
  {
    name: "set_value_and_verify",
    description:
      "给元素赋值，并自动验证 UI 是否出现预期内容。适合表单、搜索框、文本输入框。",
    schema: z.object({
      index: z.number().int().min(0),
      value: z.string(),
      expected: z.string().optional(),
      max_depth: z.number().int().min(1).max(12).default(DEFAULT_UI_MAX_DEPTH),
      timeout_ms: z.number().int().min(500).max(8_000).default(DEFAULT_VERIFY_TIMEOUT_MS),
    }),
  },
);

const pressShortcutAndVerifyTool = tool(
  async (input) => {
    const before = await snapshotUi(input.max_depth);
    await callMantle("/key_press", {
      key: input.key,
      modifiers: input.modifiers,
    });

    const verification = await waitForUiVerification(before, {
      expected: input.expected,
      maxDepth: input.max_depth,
      timeoutMs: input.timeout_ms,
    });

    return formatResult({
      action: "press_shortcut_and_verify",
      key: input.key,
      modifiers: input.modifiers,
      expected: input.expected ?? null,
      ...verification,
    });
  },
  {
    name: "press_shortcut_and_verify",
    description:
      "按快捷键后自动验证 UI 变化。适合 cmd+n、return、tab、escape 等单步动作。",
    schema: z.object({
      key: z.string(),
      modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])).default([]),
      expected: z.string().optional(),
      max_depth: z.number().int().min(1).max(12).default(DEFAULT_UI_MAX_DEPTH),
      timeout_ms: z.number().int().min(500).max(8_000).default(DEFAULT_VERIFY_TIMEOUT_MS),
    }),
  },
);

// ---------------------------------------------------------------------------
// Batch action tool — retained for debugging, but should remain a last resort
// ---------------------------------------------------------------------------

interface ActionStep {
  action: string;
  [key: string]: unknown;
}

const ACTION_ROUTES: Record<string, string> = {
  open_app: "/open_app",
  ui_tree: "/ui_tree",
  screenshot: "/screenshot",
  click: "/click",
  type_text: "/type_text",
  key_press: "/key_press",
  scroll: "/scroll",
  click_element: "/click_element",
  set_element_value: "/set_value",
};

const runActionsTool = tool(
  async (input) => {
    const results: string[] = [];
    for (let index = 0; index < input.steps.length; index += 1) {
      const step = input.steps[index] as ActionStep;
      const { action, ...rawParams } = step;
      const params = Object.fromEntries(
        Object.entries(rawParams).filter(([, value]) => value !== undefined && value !== null),
      );
      const route = ACTION_ROUTES[action];
      if (!route) {
        results.push(`[${index + 1}] Unknown action: ${action}`);
        continue;
      }

      if (action === "open_app" && typeof params.app_name === "string") {
        params.app_name = resolveAppName(params.app_name);
      }

      try {
        const result = await callMantle(route, params);
        results.push(`[${index + 1}] ${action}: ${truncateText(String(result), 240)}`);
      } catch (error) {
        results.push(
          `[${index + 1}] ${action} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      await sleep(action === "open_app" ? 1_200 : 400);
    }
    return results.join("\n");
  },
  {
    name: "run_actions",
    description:
      "调试用批量动作工具。Gemma 默认不应依赖它，优先使用 short-loop 的厚工具。",
    schema: z.object({
      steps: z
        .array(
          z.object({
            action: z.string(),
            app_name: z.string().optional(),
            bundle_id: z.string().optional(),
            text: z.string().optional(),
            key: z.string().optional(),
            modifiers: z.array(z.string()).optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            index: z.number().optional(),
            value: z.string().optional(),
            max_depth: z.number().optional(),
          }),
        )
        .min(1)
        .max(20),
    }),
  },
);

// ---------------------------------------------------------------------------
// Exports for stage middleware
// ---------------------------------------------------------------------------

export const COMPUTER_USE_OBSERVE_TOOL_NAMES = new Set([
  "observe_frontmost_ui",
  "open_app_and_observe",
  "ui_tree",
]);

export const COMPUTER_USE_THICK_ACTION_TOOL_NAMES = new Set([
  "click_element_and_wait",
  "set_value_and_verify",
  "press_shortcut_and_verify",
]);

export const COMPUTER_USE_ACTION_TOOL_NAMES = new Set([
  ...COMPUTER_USE_THICK_ACTION_TOOL_NAMES,
]);

// Raw GUI tools were retired from the agent surface; no extra debug-only tools remain.
export const COMPUTER_USE_DEBUG_TOOL_NAMES = new Set<string>();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const COMPUTER_USE_TOOLS = [
  observeFrontmostUiTool,
  screenshotTool,
  uiTreeTool,
  openAppAndObserveTool,
  clickElementAndWaitTool,
  setValueAndVerifyTool,
  pressShortcutAndVerifyTool,
  runActionsTool,
] as const;

const COMPUTER_USE_DEBUG_TOOLS = [] as const;

const COMPUTER_USE_SYSTEM_PROMPT = `你有 macOS 桌面操控能力。

默认工作方式是短回路：
1. 先观察（observe_frontmost_ui 或 open_app_and_observe）
2. 再做一个动作（click_element_and_wait / set_value_and_verify / press_shortcut_and_verify）
3. 立刻验证，再决定下一步

规则：
- 不要规划很长的 GUI 动作链。
- 不要自己思考 sleep 500ms 之类的时序细节。
- 不要自己发明原始坐标点击、原始键盘输入之类的低层动作。
- NEVER 用 execute 做 GUI 操作。`;

export const COMPUTER_USE_SYSTEM_PROMPT_FRAGMENT = COMPUTER_USE_SYSTEM_PROMPT;

export function createComputerUseMiddleware() {
  return createMiddleware({
    name: "computerUseMiddleware",
    tools: [...COMPUTER_USE_TOOLS],
  });
}

export function createComputerUseDebugMiddleware() {
  return createMiddleware({
    name: "computerUseDebugMiddleware",
    tools: [...COMPUTER_USE_DEBUG_TOOLS],
  });
}

/**
 * HITL interrupt configs for computer-use tools.
 * Keep disabled for now: Gemma 4 is still more stable with uninterrupted
 * short loops, and verification is handled by tool design plus staging.
 */
export function computerUseInterruptConfig(): Record<string, { allowedDecisions: string[] }> {
  return {};
}

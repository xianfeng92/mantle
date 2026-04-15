import { BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";
import type { LocalShellBackend } from "deepagents";

import {
  COMPUTER_USE_ACTION_TOOL_NAMES,
  COMPUTER_USE_OBSERVE_TOOL_NAMES,
  COMPUTER_USE_THICK_ACTION_TOOL_NAMES,
} from "./computer-use.js";
import { createLogger } from "./logger.js";
import type { TraceRecorder } from "./tracing.js";

const log = createLogger("tool-staging");

const ALWAYS_AVAILABLE_TOOL_NAMES = new Set(["write_todos", "task"]);
const FILESYSTEM_OBSERVE_TOOL_NAMES = new Set(["ls", "read_file", "glob", "grep"]);
const FILESYSTEM_ACTION_TOOL_NAMES = new Set(["write_file", "edit_file", "execute"]);
const CORE_TOOL_NAMES = new Set([
  ...ALWAYS_AVAILABLE_TOOL_NAMES,
  ...FILESYSTEM_OBSERVE_TOOL_NAMES,
  ...FILESYSTEM_ACTION_TOOL_NAMES,
  ...COMPUTER_USE_OBSERVE_TOOL_NAMES,
  ...COMPUTER_USE_ACTION_TOOL_NAMES,
]);

const GUI_INTENT_PATTERN =
  /(桌面|界面|UI|窗口|前台|应用|app|打开.*(应用|备忘录|访达|finder|safari)|点击|输入|按键|快捷键|屏幕|当前窗口|mac)/i;

export const DEFAULT_GUI_STEP_BUDGET = 8;

type StageName =
  | "plan"
  | "observe"
  | "act_fs"
  | "act_gui"
  | "verify"
  | "budget_exhausted";

type VerificationMode = "file_readback" | "execute_exit_code" | "none";

interface StageDecision {
  stage: StageName;
  desktopIntent: boolean;
  lastToolName: string | null;
  lastUserText: string;
  reason: string;
  guiActionSteps: number;
  verificationDomain: "fs" | "gui" | "none";
}

interface ToolLike {
  name?: string;
}

interface ToolStagingMiddlewareOptions {
  backend: LocalShellBackend;
  traceRecorder?: TraceRecorder;
  guiStepBudget?: number;
}

function getToolName(tool: ToolLike | undefined): string | null {
  return tool && typeof tool.name === "string" && tool.name.length > 0 ? tool.name : null;
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
        return JSON.stringify(item);
      })
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function truncateText(text: string, maxLength = 240): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...[truncated]`;
}

function extractLastUserText(messages: BaseMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!HumanMessage.isInstance(message)) {
      continue;
    }
    return contentToText(message.content);
  }
  return "";
}

function getMessagesSinceLastHuman(messages: BaseMessage[]): BaseMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (HumanMessage.isInstance(messages[index])) {
      return messages.slice(index + 1);
    }
  }
  return messages;
}

function inferStage(messages: BaseMessage[], guiStepBudget: number): StageDecision {
  const lastUserText = extractLastUserText(messages);
  const desktopIntent = GUI_INTENT_PATTERN.test(lastUserText);
  const sinceLastHuman = getMessagesSinceLastHuman(messages);
  const toolMessages = sinceLastHuman.filter((message) => ToolMessage.isInstance(message)) as ToolMessage[];
  const lastTool = toolMessages.at(-1) ?? null;
  const lastToolName = lastTool?.name ?? null;
  const guiActionSteps = toolMessages.filter((message) =>
    message.name ? COMPUTER_USE_ACTION_TOOL_NAMES.has(message.name) : false,
  ).length;

  if (guiActionSteps >= guiStepBudget) {
    return {
      stage: "budget_exhausted",
      desktopIntent,
      lastToolName,
      lastUserText,
      reason: `GUI action budget reached (${guiActionSteps}/${guiStepBudget})`,
      guiActionSteps,
      verificationDomain: "none",
    };
  }

  if (lastToolName && FILESYSTEM_ACTION_TOOL_NAMES.has(lastToolName)) {
    return {
      stage: "verify",
      desktopIntent,
      lastToolName,
      lastUserText,
      reason: `Verify filesystem action ${lastToolName} before continuing`,
      guiActionSteps,
      verificationDomain: "fs",
    };
  }

  if (lastToolName && COMPUTER_USE_ACTION_TOOL_NAMES.has(lastToolName)) {
    return {
      stage: "verify",
      desktopIntent,
      lastToolName,
      lastUserText,
      reason: `Verify GUI action ${lastToolName} before continuing`,
      guiActionSteps,
      verificationDomain: "gui",
    };
  }

  if (desktopIntent) {
    if (lastToolName && COMPUTER_USE_OBSERVE_TOOL_NAMES.has(lastToolName)) {
      return {
        stage: "act_gui",
        desktopIntent,
        lastToolName,
        lastUserText,
        reason: `Desktop task observed via ${lastToolName}; expose thick GUI actions`,
        guiActionSteps,
        verificationDomain: "none",
      };
    }

    return {
      stage: "observe",
      desktopIntent,
      lastToolName,
      lastUserText,
      reason: "Desktop task starts with observation",
      guiActionSteps,
      verificationDomain: "none",
    };
  }

  if (lastToolName && FILESYSTEM_OBSERVE_TOOL_NAMES.has(lastToolName)) {
    return {
      stage: "act_fs",
      desktopIntent,
      lastToolName,
      lastUserText,
      reason: `Workspace inspected via ${lastToolName}; allow file edits or commands`,
      guiActionSteps,
      verificationDomain: "none",
    };
  }

  return {
    stage: "observe",
    desktopIntent,
    lastToolName,
    lastUserText,
    reason: "Default to inspect-first workspace flow",
    guiActionSteps,
    verificationDomain: "none",
  };
}

function filterToolsForStage<T extends ToolLike>(
  tools: T[],
  decision: StageDecision,
): T[] {
  const passthroughTools = tools.filter((tool) => {
    const name = getToolName(tool);
    return name ? !CORE_TOOL_NAMES.has(name) : true;
  });

  let allowedNames = new Set<string>(ALWAYS_AVAILABLE_TOOL_NAMES);

  switch (decision.stage) {
    case "plan":
      allowedNames = new Set([...ALWAYS_AVAILABLE_TOOL_NAMES, ...FILESYSTEM_OBSERVE_TOOL_NAMES]);
      break;
    case "observe":
      allowedNames = decision.desktopIntent
        ? new Set([
            ...ALWAYS_AVAILABLE_TOOL_NAMES,
            ...COMPUTER_USE_OBSERVE_TOOL_NAMES,
            ...FILESYSTEM_OBSERVE_TOOL_NAMES,
          ])
        : new Set([...ALWAYS_AVAILABLE_TOOL_NAMES, ...FILESYSTEM_OBSERVE_TOOL_NAMES]);
      break;
    case "act_fs":
      allowedNames = new Set([
        ...ALWAYS_AVAILABLE_TOOL_NAMES,
        ...FILESYSTEM_OBSERVE_TOOL_NAMES,
        ...FILESYSTEM_ACTION_TOOL_NAMES,
      ]);
      break;
    case "act_gui":
      allowedNames = new Set([
        ...ALWAYS_AVAILABLE_TOOL_NAMES,
        ...COMPUTER_USE_OBSERVE_TOOL_NAMES,
        ...COMPUTER_USE_THICK_ACTION_TOOL_NAMES,
        "type_text",
      ]);
      break;
    case "verify":
      allowedNames =
        decision.verificationDomain === "gui"
          ? new Set([...ALWAYS_AVAILABLE_TOOL_NAMES, ...COMPUTER_USE_OBSERVE_TOOL_NAMES])
          : new Set([...ALWAYS_AVAILABLE_TOOL_NAMES, ...FILESYSTEM_OBSERVE_TOOL_NAMES]);
      break;
    case "budget_exhausted":
      return tools.filter((tool) => ALWAYS_AVAILABLE_TOOL_NAMES.has(getToolName(tool) ?? ""));
  }

  return [
    ...passthroughTools,
    ...tools.filter((tool) => {
      const name = getToolName(tool);
      return name ? allowedNames.has(name) : false;
    }),
  ] as T[];
}

function buildStagePrompt(decision: StageDecision, guiStepBudget: number): string {
  switch (decision.stage) {
    case "observe":
      return decision.desktopIntent
        ? [
            "Current stage: observe.",
            "This is a desktop task. First inspect the frontmost UI before any GUI action.",
            "Prefer observe_frontmost_ui or open_app_and_observe. Do not chain multiple GUI actions yet.",
          ].join("\n")
        : [
            "Current stage: observe.",
            "Inspect the workspace before editing or executing commands.",
            "Prefer ls/read_file/glob/grep first.",
          ].join("\n");
    case "act_fs":
      return [
        "Current stage: act_fs.",
        "You have enough read context to make one filesystem action.",
        "Prefer one write_file/edit_file/execute call, then stop for verification.",
      ].join("\n");
    case "act_gui":
      return [
        "Current stage: act_gui.",
        "Use at most one thick GUI action now, then you must verify before another action.",
        "Prefer open_app_and_observe, click_element_and_wait, set_value_and_verify, or press_shortcut_and_verify.",
        "Do not use raw coordinates. Do not plan a long chain of GUI actions.",
      ].join("\n");
    case "verify":
      if (decision.verificationDomain === "gui") {
        return [
          "Current stage: verify.",
          `You just executed ${decision.lastToolName ?? "a GUI action"}.`,
          "Before any further GUI action, call an observe tool to confirm the UI changed as expected.",
          "Do not call execute or another GUI action in this step.",
        ].join("\n");
      }
      return [
        "Current stage: verify.",
        `You just executed ${decision.lastToolName ?? "a filesystem action"}.`,
        "Before any further write or shell command, verify the result with read-only tools.",
        "For files, read the file back. For commands, inspect the command output and confirm artifacts with ls/read_file when needed.",
      ].join("\n");
    case "budget_exhausted":
      return [
        "Current stage: budget_exhausted.",
        `You already used ${decision.guiActionSteps} GUI action steps, which reached the hard limit of ${guiStepBudget}.`,
        "Do not take any more GUI actions in this turn.",
        "Summarize the current status and ask the user whether to continue with a fresh step budget.",
      ].join("\n");
    case "plan":
    default:
      return [
        "Current stage: plan.",
        "Keep the plan short, then inspect before acting.",
      ].join("\n");
  }
}

function getRuntimeId(
  runtime: { configurable?: Record<string, unknown> },
  key: "thread_id" | "trace_id",
): string | null {
  const value = runtime.configurable?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function recordTrace(
  recorder: TraceRecorder | undefined,
  runtime: { configurable?: Record<string, unknown> },
  kind:
    | "stage_selected"
    | "verification_passed"
    | "verification_failed"
    | "step_budget_exhausted",
  payload: Record<string, unknown>,
): Promise<void> {
  if (!recorder) {
    return;
  }

  const threadId = getRuntimeId(runtime, "thread_id") ?? "unknown-thread";
  const traceId = getRuntimeId(runtime, "trace_id") ?? threadId;
  await recorder.record({
    timestamp: new Date().toISOString(),
    traceId,
    threadId,
    kind,
    payload,
  });
}

function buildVerificationSuffix(lines: string[]): string {
  return lines.length > 0 ? `\n\n[verification]\n${lines.join("\n")}` : "";
}

function buildToolMessageContent(result: ToolMessage, suffixLines: string[]): string {
  return `${contentToText(result.content)}${buildVerificationSuffix(suffixLines)}`;
}

function buildToolMessage(
  result: ToolMessage,
  content: string,
): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: result.tool_call_id,
    name: result.name,
    artifact: (result as { artifact?: unknown }).artifact,
    response_metadata: (
      result as { response_metadata?: Partial<Record<string, unknown>> }
    ).response_metadata,
    additional_kwargs: result.additional_kwargs,
    id: result.id,
  });
}

function extractExitCode(text: string): number | null {
  const bracketMatch = text.match(/exit code (\d+)/i);
  if (bracketMatch) {
    return Number(bracketMatch[1]);
  }
  const lineMatch = text.match(/Exit code:\s*(\d+)/i);
  if (lineMatch) {
    return Number(lineMatch[1]);
  }
  return null;
}

async function verifyFileReadback(options: {
  backend: LocalShellBackend;
  filePath: string;
  expectedSnippet: string;
}): Promise<{ ok: boolean; preview: string }> {
  const preview = await options.backend.read(options.filePath, 0, 40);
  const expected = options.expectedSnippet.trim();
  const ok = expected.length === 0 ? true : preview.includes(expected);
  return {
    ok,
    preview: truncateText(preview, 320),
  };
}

export function createToolStagingMiddleware(
  options: ToolStagingMiddlewareOptions,
) {
  const guiStepBudget = options.guiStepBudget ?? DEFAULT_GUI_STEP_BUDGET;

  return createMiddleware({
    name: "toolStagingMiddleware",
    wrapModelCall: async (request, handler) => {
      const decision = inferStage(request.messages, guiStepBudget);
      const filteredTools = filterToolsForStage(request.tools, decision);
      const filteredToolNames = filteredTools
        .map((tool) => getToolName(tool))
        .filter((name): name is string => Boolean(name));
      const stagePrompt = buildStagePrompt(decision, guiStepBudget);
      const toolChoice =
        decision.stage === "verify"
          ? "required"
          : decision.stage === "budget_exhausted"
            ? "none"
            : request.toolChoice;

      await recordTrace(options.traceRecorder, request.runtime, "stage_selected", {
        stage: decision.stage,
        reason: decision.reason,
        desktopIntent: decision.desktopIntent,
        lastToolName: decision.lastToolName,
        guiActionSteps: decision.guiActionSteps,
        allowedTools: filteredToolNames,
      });

      if (decision.stage === "budget_exhausted") {
        await recordTrace(options.traceRecorder, request.runtime, "step_budget_exhausted", {
          guiActionSteps: decision.guiActionSteps,
          limit: guiStepBudget,
        });
      }

      log.debug("stage.selected", {
        stage: decision.stage,
        reason: decision.reason,
        guiActionSteps: decision.guiActionSteps,
        allowedTools: filteredToolNames,
      });

      return handler({
        ...request,
        tools: filteredTools,
        toolChoice,
        systemPrompt: request.systemPrompt
          ? `${request.systemPrompt}\n\n${stagePrompt}`
          : stagePrompt,
      });
    },
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (!ToolMessage.isInstance(result)) {
        return result;
      }

      const toolName = request.toolCall.name ?? result.name ?? getToolName(request.tool) ?? "unknown";

      if (toolName === "write_file") {
        const filePath =
          typeof request.toolCall.args?.file_path === "string"
            ? request.toolCall.args.file_path
            : null;
        const content =
          typeof request.toolCall.args?.content === "string"
            ? request.toolCall.args.content
            : "";
        if (!filePath) {
          return result;
        }

        const verification = await verifyFileReadback({
          backend: options.backend,
          filePath,
          expectedSnippet: content.slice(0, 120),
        });
        const suffixLines = [
          `mode: file_readback`,
          `file: ${filePath}`,
          `result: ${verification.ok ? "passed" : "failed"}`,
          `preview: ${verification.preview}`,
        ];
        await recordTrace(
          options.traceRecorder,
          request.runtime,
          verification.ok ? "verification_passed" : "verification_failed",
          {
            toolName,
            mode: "file_readback" satisfies VerificationMode,
            filePath,
            preview: verification.preview,
          },
        );
        return buildToolMessage(result, buildToolMessageContent(result, suffixLines));
      }

      if (toolName === "edit_file") {
        const filePath =
          typeof request.toolCall.args?.file_path === "string"
            ? request.toolCall.args.file_path
            : null;
        const newString =
          typeof request.toolCall.args?.new_string === "string"
            ? request.toolCall.args.new_string
            : "";
        if (!filePath) {
          return result;
        }

        const verification = await verifyFileReadback({
          backend: options.backend,
          filePath,
          expectedSnippet: newString.slice(0, 120),
        });
        const suffixLines = [
          `mode: file_readback`,
          `file: ${filePath}`,
          `result: ${verification.ok ? "passed" : "failed"}`,
          `preview: ${verification.preview}`,
        ];
        await recordTrace(
          options.traceRecorder,
          request.runtime,
          verification.ok ? "verification_passed" : "verification_failed",
          {
            toolName,
            mode: "file_readback" satisfies VerificationMode,
            filePath,
            preview: verification.preview,
          },
        );
        return buildToolMessage(result, buildToolMessageContent(result, suffixLines));
      }

      if (toolName === "execute") {
        const outputText = contentToText(result.content);
        const exitCode = extractExitCode(outputText);
        const ok = exitCode === 0;
        const command =
          typeof request.toolCall.args?.command === "string"
            ? request.toolCall.args.command
            : "";
        const suffixLines = [
          `mode: execute_exit_code`,
          `exit_code: ${exitCode ?? "unknown"}`,
          `result: ${ok ? "passed" : "failed"}`,
          ok
            ? "next: confirm command artifacts with ls/read_file before another execute call"
            : "next: inspect command output and fix the failure before retrying",
        ];
        await recordTrace(
          options.traceRecorder,
          request.runtime,
          ok ? "verification_passed" : "verification_failed",
          {
            toolName,
            mode: "execute_exit_code" satisfies VerificationMode,
            exitCode,
            commandPreview: truncateText(command, 200),
          },
        );
        return buildToolMessage(result, buildToolMessageContent(result, suffixLines));
      }

      return result;
    },
  });
}

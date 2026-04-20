import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

export type ToolProfile = "chat" | "desktop" | "readonly" | "full";

export const TOOL_PROFILE_ALLOWLISTS: Record<ToolProfile, Set<string>> = {
  chat: new Set(["ls", "read_file", "glob", "grep", "write_todos"]),
  readonly: new Set(["ls", "read_file", "glob", "grep"]),
  desktop: new Set(),
  full: new Set(),
};

const DEFAULT_TOOL_PROFILE: ToolProfile = "full";

interface NamedToolLike {
  name: string;
}

function isToolProfile(value: unknown): value is ToolProfile {
  return (
    value === "chat" ||
    value === "desktop" ||
    value === "readonly" ||
    value === "full"
  );
}

export function normalizeToolProfile(value: unknown): ToolProfile {
  return isToolProfile(value) ? value : DEFAULT_TOOL_PROFILE;
}

export function filterToolsByProfile<T extends NamedToolLike>(
  tools: readonly T[],
  profile: ToolProfile,
): T[] {
  const allow = TOOL_PROFILE_ALLOWLISTS[profile];
  if (allow.size === 0) {
    return [...tools];
  }
  return tools.filter((tool) => allow.has(tool.name));
}

function buildToolProfilePrompt(profile: ToolProfile, toolNames: string[]): string | null {
  const allow = TOOL_PROFILE_ALLOWLISTS[profile];
  if (allow.size === 0) {
    return null;
  }

  return [
    `Current tool profile: ${profile}.`,
    `Only these tools are available in this turn: ${toolNames.join(", ") || "(none)"}.`,
    "Do not ask for, plan around, or reference hidden tools.",
  ].join("\n");
}

function normalizeToolChoice(
  toolChoice: "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined,
  allowedToolNames: Set<string>,
): "auto" | "none" | "required" | { type: "function"; function: { name: string } } | undefined {
  if (toolChoice == null) {
    return toolChoice;
  }
  if (allowedToolNames.size === 0) {
    return "none";
  }
  if (typeof toolChoice === "object") {
    return allowedToolNames.has(toolChoice.function.name) ? toolChoice : "none";
  }
  if (toolChoice === "required" && allowedToolNames.size === 0) {
    return "none";
  }
  return toolChoice;
}

function getToolCallId(toolCall: unknown, toolName: string): string {
  if (toolCall && typeof toolCall === "object") {
    const maybeToolCall = toolCall as { id?: unknown; tool_call_id?: unknown };
    if (typeof maybeToolCall.id === "string" && maybeToolCall.id.length > 0) {
      return maybeToolCall.id;
    }
    if (
      typeof maybeToolCall.tool_call_id === "string" &&
      maybeToolCall.tool_call_id.length > 0
    ) {
      return maybeToolCall.tool_call_id;
    }
  }
  return `tool-profile-blocked:${toolName}`;
}

export function createToolProfileMiddleware() {
  return createMiddleware({
    name: "toolProfileMiddleware",
    wrapModelCall: async (request, handler) => {
      const profile = normalizeToolProfile(request.runtime.configurable?.toolProfile);
      const filteredTools = filterToolsByProfile(
        request.tools.filter(
          (tool): tool is typeof tool & NamedToolLike =>
            typeof tool?.name === "string" && tool.name.length > 0,
        ),
        profile,
      );
      const allowedToolNames = new Set(filteredTools.map((tool) => tool.name));
      const profilePrompt = buildToolProfilePrompt(
        profile,
        filteredTools.map((tool) => tool.name),
      );

      return handler({
        ...request,
        tools: filteredTools,
        toolChoice: normalizeToolChoice(request.toolChoice, allowedToolNames),
        systemPrompt: profilePrompt
          ? `${request.systemPrompt}\n\n${profilePrompt}`
          : request.systemPrompt,
      });
    },
    wrapToolCall: async (request, handler) => {
      const profile = normalizeToolProfile(request.runtime.configurable?.toolProfile);
      const allow = TOOL_PROFILE_ALLOWLISTS[profile];
      if (allow.size === 0 || allow.has(request.toolCall.name)) {
        return handler(request);
      }

      return new ToolMessage({
        name: request.toolCall.name,
        tool_call_id: getToolCallId(request.toolCall, request.toolCall.name),
        content: `Tool "${request.toolCall.name}" is not available under the "${profile}" tool profile.`,
        status: "error",
      });
    },
  });
}

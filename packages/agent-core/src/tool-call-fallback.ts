import { randomUUID } from "node:crypto";

import { AIMessage, BaseMessage } from "@langchain/core/messages";

export interface FallbackToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Regex matching Gemma 4's non-standard tool call format:
 *   <|tool_call>call:funcName{key:<|"|>value<|"|>, ...}<tool_call|>
 *
 * Due to the nested braces and special delimiters, we capture the
 * function name and the raw arguments block separately, then parse the
 * key/value pairs with a second regex pass.
 */
const TOOL_CALL_PATTERN = /<\|tool_call>call:(\w+)\{([\s\S]*?)\}<tool_call\|>/g;

/**
 * Matches a single key:<|"|>value<|"|> pair inside the arguments block.
 * Values can contain any characters (including newlines) between the
 * <|"|> delimiters.
 */
const ARG_PAIR_PATTERN = /(\w+):<\|"\|>([\s\S]*?)<\|"\|>/g;

function parseArgs(raw: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  let match: RegExpExecArray | null;
  ARG_PAIR_PATTERN.lastIndex = 0;
  while ((match = ARG_PAIR_PATTERN.exec(raw)) !== null) {
    args[match[1]] = match[2];
  }
  return args;
}

/**
 * Parse Gemma 4's `<|tool_call>call:funcName{...}<tool_call|>` format
 * from content text.  Returns `null` if no tool call patterns are found.
 */
export function extractFallbackToolCalls(content: string): FallbackToolCall[] | null {
  if (!content || typeof content !== "string") {
    return null;
  }

  const calls: FallbackToolCall[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex in case the regex was used before.
  TOOL_CALL_PATTERN.lastIndex = 0;

  while ((match = TOOL_CALL_PATTERN.exec(content)) !== null) {
    const name = match[1];
    const rawArgs = match[2];
    try {
      const args = parseArgs(rawArgs);
      calls.push({ name, args });
    } catch {
      // Malformed args – skip this call silently.
    }
  }

  return calls.length > 0 ? calls : null;
}

/**
 * Check if an AIMessage has empty `tool_calls` but content matching the
 * Gemma 4 tool call pattern.  If so, return a new AIMessage with proper
 * `tool_calls` and cleaned content.  Otherwise return the original
 * message unchanged.
 */
export function patchMessageWithFallbackToolCalls(message: BaseMessage): BaseMessage {
  if (!(message instanceof AIMessage)) {
    return message;
  }

  // Already has tool calls – nothing to patch.
  if (message.tool_calls && message.tool_calls.length > 0) {
    return message;
  }

  const content = typeof message.content === "string" ? message.content : "";
  if (!content) {
    return message;
  }

  const fallbackCalls = extractFallbackToolCalls(content);
  if (!fallbackCalls) {
    return message;
  }

  // Remove the <|tool_call>...<tool_call|> markers from the content.
  TOOL_CALL_PATTERN.lastIndex = 0;
  const cleanedContent = content.replace(TOOL_CALL_PATTERN, "").trim();

  const toolCalls = fallbackCalls.map((call) => ({
    id: randomUUID(),
    name: call.name,
    args: call.args,
  }));

  return new AIMessage({
    content: cleanedContent,
    tool_calls: toolCalls,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    id: message.id,
  });
}

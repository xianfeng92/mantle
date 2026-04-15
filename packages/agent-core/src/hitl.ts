import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { createMiddleware, type InterruptOnConfig } from "langchain";

import type {
  ActionRequest,
  DecisionType,
  HITLRequest,
  HITLResponse,
  InvokeResultLike,
  ReviewConfig,
} from "./types.js";
import { computerUseInterruptConfig } from "./computer-use.js";

export const HITL_REJECT_MARKER = "[hitl_rejected]";

const HITL_REJECTION_GUARD_MARKER = "[hitl_rejection_guard]";
const HITL_REJECTION_GUARD_MESSAGE = `${HITL_REJECTION_GUARD_MARKER} The human explicitly rejected the previous tool call. Treat that action as cancelled for this turn. Do not retry the same tool call or any equivalent sensitive action unless the user asks again. Briefly acknowledge the cancellation and wait for new instructions.`;

export function createInterruptOnConfig(): Record<string, boolean | InterruptOnConfig> {
  return {
    write_file: {
      allowedDecisions: ["approve", "edit", "reject"],
    },
    edit_file: {
      allowedDecisions: ["approve", "edit", "reject"],
    },
    execute: {
      allowedDecisions: ["approve", "reject"],
    },
    // Computer-use tools: actions need approval, read-only tools are auto-approved
    ...computerUseInterruptConfig(),
  };
}

export function extractInterruptRequest(result: InvokeResultLike): HITLRequest | null {
  const firstInterrupt = result.__interrupt__?.[0];
  if (!firstInterrupt || !firstInterrupt.value) {
    return null;
  }
  return firstInterrupt.value;
}

export function getAllowedDecisions(
  reviewConfigs: ReviewConfig[],
  actionName: string,
): DecisionType[] {
  return (
    reviewConfigs.find((config) => config.actionName === actionName)?.allowedDecisions ?? [
      "approve",
      "reject",
    ]
  );
}

export function formatActionRequest(action: ActionRequest, allowed: DecisionType[]): string {
  const lines = [
    `Tool: ${action.name}`,
    `Allowed decisions: ${allowed.join(", ")}`,
    `Args: ${JSON.stringify(action.args, null, 2)}`,
  ];
  if (action.description) {
    lines.push(`Description:\n${action.description}`);
  }
  return lines.join("\n");
}

export function createApproveResume(): HITLResponse {
  return { decisions: [{ type: "approve" }] };
}

function contentToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function buildRejectDecisionMessage(action?: ActionRequest): string {
  const toolRef = action ? `tool \`${action.name}\`` : "requested action";
  return `${HITL_REJECT_MARKER} The user explicitly rejected the previous ${toolRef}. Treat this action as cancelled for this turn. Do not retry this tool call or any equivalent sensitive action unless the user asks again. Briefly acknowledge the cancellation and wait for new instructions.`;
}

export function normalizeHitlResponse(
  response: HITLResponse,
  actionRequests: ActionRequest[] = [],
): HITLResponse {
  let changed = false;
  const decisions = response.decisions.map((decision, index) => {
    if (decision.type !== "reject") {
      return decision;
    }

    if (typeof decision.message === "string" && decision.message.trim().length > 0) {
      return decision;
    }

    changed = true;
    return {
      ...decision,
      message: buildRejectDecisionMessage(actionRequests[index]),
    };
  });

  return changed ? { decisions } : response;
}

function needsRejectionGuard(messages: unknown[] | undefined): messages is Array<unknown> {
  if (!messages || messages.length === 0) {
    return false;
  }

  let lastHumanIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (HumanMessage.isInstance(messages[index])) {
      lastHumanIndex = index;
      break;
    }
  }

  if (lastHumanIndex === -1) {
    return false;
  }

  const tail = messages.slice(lastHumanIndex + 1);
  const alreadyGuarded = tail.some(
    (message) =>
      SystemMessage.isInstance(message) &&
      contentToText(message.content).includes(HITL_REJECTION_GUARD_MARKER),
  );
  if (alreadyGuarded) {
    return false;
  }

  return tail.some(
    (message) =>
      ToolMessage.isInstance(message) &&
      contentToText(message.content).includes(HITL_REJECT_MARKER),
  );
}

export function createHitlRejectionGuardMiddleware() {
  return createMiddleware({
    name: "hitlRejectionGuardMiddleware",
    wrapModelCall: async (request, handler) => {
      if (!needsRejectionGuard(request.messages)) {
        return handler(request);
      }

      return handler({
        ...request,
        messages: [...request.messages, new SystemMessage(HITL_REJECTION_GUARD_MESSAGE)],
      });
    },
  });
}

import type { AppendMessage, ThreadMessage } from "@assistant-ui/react";

import type {
  AgentCoreRunResult,
  AgentCoreSerializedMessage,
  ContentBlock,
} from "./agent-core";

type AssistantStatus =
  | { type: "running" }
  | { type: "requires-action"; reason: "interrupt" }
  | { type: "complete"; reason: "stop" }
  | { type: "incomplete"; reason: "error"; error?: string };

function createTextPart(text: string) {
  return {
    type: "text" as const,
    text,
  };
}

function defaultAssistantMetadata() {
  return {
    unstable_state: null,
    unstable_annotations: [],
    unstable_data: [],
    steps: [],
    custom: {},
  };
}

export function createUserMessage(
  text: string,
  options: {
    id?: string;
    createdAt?: Date;
  } = {},
): ThreadMessage {
  return {
    id: options.id ?? crypto.randomUUID(),
    role: "user",
    createdAt: options.createdAt ?? new Date(),
    content: [createTextPart(text)],
    attachments: [],
    metadata: {
      custom: {},
    },
  };
}

export function createSystemMessage(
  text: string,
  options: {
    id?: string;
    createdAt?: Date;
  } = {},
): ThreadMessage {
  return {
    id: options.id ?? crypto.randomUUID(),
    role: "system",
    createdAt: options.createdAt ?? new Date(),
    content: [createTextPart(text)],
    metadata: {
      custom: {},
    },
  };
}

export function createAssistantMessage(
  text: string,
  status: AssistantStatus,
  options: {
    id?: string;
    createdAt?: Date;
  } = {},
): ThreadMessage {
  return {
    id: options.id ?? crypto.randomUUID(),
    role: "assistant",
    createdAt: options.createdAt ?? new Date(),
    content: text ? [createTextPart(text)] : [],
    status,
    metadata: defaultAssistantMetadata(),
  };
}

export function appendAssistantDelta(
  messages: readonly ThreadMessage[],
  draftId: string,
  delta: string,
): ThreadMessage[] {
  return messages.map((message) => {
    if (message.id !== draftId || message.role !== "assistant") {
      return message;
    }

    const currentText = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

    return {
      ...message,
      content: [createTextPart(`${currentText}${delta}`)],
      status: { type: "running" },
    };
  });
}

export function setAssistantStatus(
  messages: readonly ThreadMessage[],
  draftId: string,
  status: AssistantStatus,
): ThreadMessage[] {
  return messages.map((message) => {
    if (message.id !== draftId || message.role !== "assistant") {
      return message;
    }

    return {
      ...message,
      status,
    };
  });
}

export function appendInterruptedDraftIfMissing(
  messages: readonly ThreadMessage[],
  draftId: string,
): ThreadMessage[] {
  const exists = messages.some((message) => message.id === draftId);
  if (exists) {
    return messages.slice();
  }
  return [
    ...messages,
    createAssistantMessage("", { type: "running" }, { id: draftId }),
  ];
}

export function serializedMessagesToThreadMessages(
  result: AgentCoreRunResult,
): ThreadMessage[] {
  return result.newMessages
    .map((message) => serializedMessageToThreadMessage(message))
    .filter((message): message is ThreadMessage => message !== null);
}

function serializedMessageToThreadMessage(
  message: AgentCoreSerializedMessage,
): ThreadMessage | null {
  switch (message.role) {
    case "user":
      return createUserMessage(message.text);
    case "assistant":
      return createAssistantMessage(message.text, {
        type: "complete",
        reason: "stop",
      });
    case "system":
      return createSystemMessage(message.text);
    case "tool":
      return createSystemMessage(
        `[tool:${message.name ?? "unknown"}] ${message.text || "(no output)"}`,
      );
    case "unknown":
      return createSystemMessage(message.text || "(unknown message)");
    default:
      return null;
  }
}

export function appendMessageToText(message: AppendMessage): string {
  return message.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return "";
    })
    .join("")
    .trim();
}

/**
 * Extract image data URIs from an AppendMessage.
 * Returns an array of base64 data URIs (e.g. "data:image/png;base64,...").
 */
export function extractImageParts(message: AppendMessage): string[] {
  const images: string[] = [];
  for (const part of message.content) {
    if (part.type === "image" && part.image) {
      images.push(part.image);
    }
  }
  return images;
}

/**
 * Build the backend `input` field from text + images.
 * Returns a plain string when there are no images, or a ContentBlock[]
 * when images are present.
 */
export function buildBackendInput(
  text: string,
  images: string[],
): string | ContentBlock[] {
  if (images.length === 0) {
    return text;
  }
  const blocks: ContentBlock[] = [{ type: "text", text }];
  for (const dataUri of images) {
    blocks.push({ type: "image_url", image_url: { url: dataUri } });
  }
  return blocks;
}

export function deriveThreadTitle(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Untitled thread";
  }
  return compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
}

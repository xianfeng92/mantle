export interface ContextCompactionSnapshot {
  sessionId?: string;
  cutoffIndex: number;
  filePath: string | null;
  summaryPreview: string;
}

interface SummarizationEventLike {
  cutoffIndex?: unknown;
  filePath?: unknown;
  summaryMessage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
        if (isRecord(item) && "text" in item) {
          return String(item.text ?? "");
        }
        return JSON.stringify(item, null, 2);
      })
      .join("\n");
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content, null, 2);
}

function truncate(text: string, maxLength = 240): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...[truncated]`;
}

function extractSummaryPreview(summaryMessage: unknown): string {
  if (isRecord(summaryMessage) && "content" in summaryMessage) {
    return truncate(contentToText(summaryMessage.content));
  }

  return truncate(contentToText(summaryMessage));
}

export function extractContextCompactionSnapshot(
  stateValues: unknown,
): ContextCompactionSnapshot | null {
  if (!isRecord(stateValues)) {
    return null;
  }

  const event = stateValues._summarizationEvent;
  if (!isRecord(event)) {
    return null;
  }

  const parsedEvent = event as SummarizationEventLike;
  if (typeof parsedEvent.cutoffIndex !== "number" || parsedEvent.cutoffIndex < 0) {
    return null;
  }

  return {
    sessionId:
      typeof stateValues._summarizationSessionId === "string"
        ? stateValues._summarizationSessionId
        : undefined,
    cutoffIndex: parsedEvent.cutoffIndex,
    filePath: typeof parsedEvent.filePath === "string" ? parsedEvent.filePath : null,
    summaryPreview: extractSummaryPreview(parsedEvent.summaryMessage),
  };
}

/**
 * Build a human-readable hint describing the current compaction state.
 * Useful for diagnostics and logging.
 */
export function buildCompactionHint(snapshot: ContextCompactionSnapshot | null): string {
  if (!snapshot) {
    return "No compaction has occurred yet.";
  }
  const parts: string[] = [
    `Compaction active (cutoff index: ${snapshot.cutoffIndex})`,
  ];
  if (snapshot.sessionId) {
    parts.push(`session: ${snapshot.sessionId}`);
  }
  if (snapshot.filePath) {
    parts.push(`file: ${snapshot.filePath}`);
  }
  if (snapshot.summaryPreview) {
    parts.push(`summary: "${snapshot.summaryPreview}"`);
  }
  return parts.join(", ");
}

export function sameContextCompactionSnapshot(
  left: ContextCompactionSnapshot | null,
  right: ContextCompactionSnapshot | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.sessionId === right.sessionId &&
    left.cutoffIndex === right.cutoffIndex &&
    left.filePath === right.filePath &&
    left.summaryPreview === right.summaryPreview
  );
}

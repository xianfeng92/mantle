// ---------------------------------------------------------------------------
// Multimodal content types (OpenAI-compatible)
// ---------------------------------------------------------------------------

/** A single content block inside a multimodal message. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

/** User input: plain text string OR an array of multimodal content blocks. */
export type UserInput = string | ContentBlock[];

/**
 * Extract the plain-text portion from a `UserInput`.
 * For a string, returns the string itself.
 * For a content block array, concatenates all `type: "text"` blocks.
 */
export function extractTextFromInput(input: UserInput): string {
  if (typeof input === "string") {
    return input;
  }
  return input
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Validate that a value is a well-formed `UserInput` with non-empty text.
 * Returns the validated input or `null` if invalid.
 */
export function validateUserInput(value: unknown): UserInput | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (Array.isArray(value)) {
    // Must have at least one text block with non-empty content
    const hasText = value.some(
      (b) =>
        b &&
        typeof b === "object" &&
        b.type === "text" &&
        typeof b.text === "string" &&
        b.text.trim().length > 0,
    );
    if (!hasText) {
      return null;
    }
    // Validate each block shape
    for (const block of value) {
      if (!block || typeof block !== "object" || !("type" in block)) {
        return null;
      }
      if (block.type === "text") {
        if (typeof block.text !== "string") return null;
      } else if (block.type === "image_url") {
        if (
          !block.image_url ||
          typeof block.image_url !== "object" ||
          typeof block.image_url.url !== "string"
        ) {
          return null;
        }
      } else {
        return null; // unknown block type
      }
    }
    return value as ContentBlock[];
  }
  return null;
}

// ---------------------------------------------------------------------------
// HITL types
// ---------------------------------------------------------------------------

export type DecisionType = "approve" | "edit" | "reject";

export type ActionRiskLevel = "low" | "medium" | "high";

export interface ActionRiskAssessment {
  level: ActionRiskLevel;
  summary: string;
  estimatedImpact?: string;
  touchedPaths?: string[];
  command?: string;
  rationale?: string;
}

export interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
  risk?: ActionRiskAssessment;
}

export interface ReviewConfig {
  actionName: string;
  allowedDecisions: DecisionType[];
  argsSchema?: Record<string, unknown>;
}

export interface HITLRequest {
  actionRequests: ActionRequest[];
  reviewConfigs: ReviewConfig[];
}

export interface ApproveDecision {
  type: "approve";
}

export interface EditDecision {
  type: "edit";
  editedAction: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface RejectDecision {
  type: "reject";
  message?: string;
}

export type HITLDecision = ApproveDecision | EditDecision | RejectDecision;

export interface HITLResponse {
  decisions: HITLDecision[];
}

export interface InterruptEnvelope<TValue = HITLRequest> {
  id?: string;
  value: TValue;
}

export interface InvokeResultLike {
  messages?: unknown[];
  __interrupt__?: Array<InterruptEnvelope>;
}

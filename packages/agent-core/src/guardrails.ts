import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";

export type GuardrailPhase = "input" | "output";

export type GuardrailRule =
  | "max_input_chars"
  | "max_output_chars"
  | "blocked_input_term"
  | "blocked_output_term";

export interface GuardrailViolation {
  traceId?: string;
  phase: GuardrailPhase;
  rule: GuardrailRule;
  message: string;
  source?: string;
  limit?: number;
  actual?: number;
  term?: string;
}

export interface GuardrailContext {
  traceId?: string;
  threadId: string;
  mode: "run" | "resume";
  source: string;
}

export interface AgentCoreGuardrailsConfig {
  maxInputChars: number;
  maxOutputChars: number;
  blockedInputTerms: string[];
  blockedOutputTerms: string[];
}

export interface AgentCoreGuardrails {
  readonly config: AgentCoreGuardrailsConfig;
  validateInputText(text: string, context: GuardrailContext): void;
  validateOutputText(text: string, context: GuardrailContext): void;
  validateMessages(messages: BaseMessage[], context: GuardrailContext): void;
}

export class GuardrailViolationError extends Error {
  readonly violation: GuardrailViolation;

  constructor(violation: GuardrailViolation) {
    super(violation.message);
    this.name = "GuardrailViolationError";
    this.violation = violation;
  }
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
        return JSON.stringify(item, null, 2);
      })
      .join("\n");
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content, null, 2);
}

function normalizeTerms(terms: string[]): string[] {
  return terms.map((term) => term.trim()).filter(Boolean);
}

function findMatchedTerm(text: string, terms: string[]): string | null {
  const haystack = text.toLowerCase();
  for (const term of terms) {
    if (haystack.includes(term.toLowerCase())) {
      return term;
    }
  }
  return null;
}

function collectOutputText(messages: BaseMessage[]): string {
  return messages
    .flatMap((message) => {
      if (AIMessage.isInstance(message) || ToolMessage.isInstance(message)) {
        const text = contentToText(message.content).trim();
        return text ? [text] : [];
      }
      return [];
    })
    .join("\n");
}

export function isGuardrailViolationError(error: unknown): error is GuardrailViolationError {
  return error instanceof GuardrailViolationError;
}

export function serializeGuardrailViolation(error: GuardrailViolationError): Record<string, unknown> {
  return {
    error: error.message,
    code: "guardrail_violation",
    phase: error.violation.phase,
    rule: error.violation.rule,
    traceId: error.violation.traceId,
    source: error.violation.source,
    limit: error.violation.limit,
    actual: error.violation.actual,
    term: error.violation.term,
  };
}

export class DefaultGuardrails implements AgentCoreGuardrails {
  readonly config: AgentCoreGuardrailsConfig;

  constructor(config: AgentCoreGuardrailsConfig) {
    this.config = {
      maxInputChars: Math.max(1, config.maxInputChars),
      maxOutputChars: Math.max(1, config.maxOutputChars),
      blockedInputTerms: normalizeTerms(config.blockedInputTerms),
      blockedOutputTerms: normalizeTerms(config.blockedOutputTerms),
    };
  }

  validateInputText(text: string, context: GuardrailContext): void {
    this.validateText(text, "input", context);
  }

  validateOutputText(text: string, context: GuardrailContext): void {
    this.validateText(text, "output", context);
  }

  validateMessages(messages: BaseMessage[], context: GuardrailContext): void {
    const outputText = collectOutputText(messages);
    if (!outputText) {
      return;
    }
    this.validateOutputText(outputText, context);
  }

  private validateText(
    text: string,
    phase: GuardrailPhase,
    context: GuardrailContext,
  ): void {
    const limit =
      phase === "input" ? this.config.maxInputChars : this.config.maxOutputChars;
    if (text.length > limit) {
      throw new GuardrailViolationError({
        traceId: context.traceId,
        phase,
        rule: phase === "input" ? "max_input_chars" : "max_output_chars",
        message: `Guardrail blocked ${phase}: content exceeds ${limit} characters.`,
        source: context.source,
        limit,
        actual: text.length,
      });
    }

    const blockedTerms =
      phase === "input" ? this.config.blockedInputTerms : this.config.blockedOutputTerms;
    const matchedTerm = findMatchedTerm(text, blockedTerms);
    if (matchedTerm) {
      throw new GuardrailViolationError({
        traceId: context.traceId,
        phase,
        rule:
          phase === "input" ? "blocked_input_term" : "blocked_output_term",
        message: `Guardrail blocked ${phase}: matched blocked term "${matchedTerm}".`,
        source: context.source,
        term: matchedTerm,
        actual: text.length,
      });
    }
  }
}

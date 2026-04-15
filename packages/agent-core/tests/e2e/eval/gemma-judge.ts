/**
 * GemmaJudge — calls LM Studio to evaluate agent outputs via checklist prompting.
 *
 * Uses the same OpenAI-compatible endpoint as the agent itself.
 * Designed for Gemma 4 26B: short structured prompts, JSON output.
 */

import type { DimensionDef, Score, ChecklistItem, EvalContext } from "./types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = "google/gemma-4-26b-a4b";
const DEFAULT_TIMEOUT = 90_000;

interface JudgeResponse {
  answers: boolean[];
  reason: string;
}

export interface GemmaJudgeOptions {
  baseUrl?: string;
  model?: string;
  timeout?: number;
}

export class GemmaJudge {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeout: number;

  constructor(opts?: GemmaJudgeOptions) {
    this.baseUrl = opts?.baseUrl ?? process.env.LM_STUDIO_BASE_URL ?? DEFAULT_BASE_URL;
    this.model = opts?.model ?? process.env.EVAL_JUDGE_MODEL ?? DEFAULT_MODEL;
    this.timeout = opts?.timeout ?? (Number(process.env.EVAL_TIMEOUT) || DEFAULT_TIMEOUT);
  }

  /**
   * Evaluate one dimension for a given test context.
   * Returns a Score. On failure, returns score with value=0 and explanation=error.
   */
  async evaluateDimension(ctx: EvalContext, dim: DimensionDef): Promise<Score> {
    const prompt = this.buildPrompt(ctx, dim);

    try {
      const raw = await this.callLm(prompt, dim.questions.length);
      const parsed = this.parseResponse(raw, dim.questions.length);

      const checklist: ChecklistItem[] = dim.questions.map((q, i) => ({
        question: q,
        answer: parsed.answers[i] ?? false,
      }));

      const trueCount = checklist.filter((c) => c.answer).length;
      const value = Math.round((trueCount / checklist.length) * 100) / 100;

      return {
        dimension: dim.name,
        value,
        threshold: dim.threshold,
        passed: value >= dim.threshold,
        explanation: parsed.reason,
        checklist,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        dimension: dim.name,
        value: 0,
        threshold: dim.threshold,
        passed: false,
        explanation: `Judge error: ${msg}`,
        checklist: dim.questions.map((q) => ({ question: q, answer: false })),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt construction
  // ---------------------------------------------------------------------------

  private buildPrompt(ctx: EvalContext, dim: DimensionDef): string {
    const questionsBlock = dim.questions
      .map((q, i) => `${i + 1}. ${q}`)
      .join("\n");

    const expectedLine = ctx.expected ? `Expected: ${ctx.expected}\n` : "";

    return `You are an evaluation judge. Score this AI agent response.

Task: ${ctx.input}
${expectedLine}Agent output: ${ctx.output}

Answer each question YES or NO for "${dim.label}":
${questionsBlock}

Respond ONLY with compact JSON matching this shape:
{"answers":[true,false],"reason":"under 20 words"}`;
  }

  // ---------------------------------------------------------------------------
  // LM Studio call
  // ---------------------------------------------------------------------------

  private async callLm(prompt: string, expectedCount: number): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: "You are an evaluation judge. Always respond with valid compact JSON only. No explanation outside JSON. Keep the reason under 20 words." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: 256,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "judge_response",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                answers: {
                  type: "array",
                  items: { type: "boolean" },
                  minItems: expectedCount,
                  maxItems: expectedCount,
                },
                reason: {
                  type: "string",
                  maxLength: 120,
                },
              },
              required: ["answers", "reason"],
            },
          },
        },
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      throw new Error(`LM Studio returned ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as {
      choices: Array<{ message: { content: string; reasoning_content?: string } }>;
    };

    const msg = body.choices[0]?.message;
    const content = msg?.content || "";
    const reasoning = msg?.reasoning_content || "";
    // Try content first, then combine both for JSON extraction
    if (content.length > 2) return content;
    // Combine reasoning + content to maximize chance of finding JSON
    return `${reasoning}\n${content}`;
  }

  // ---------------------------------------------------------------------------
  // Response parsing — triple fallback
  // ---------------------------------------------------------------------------

  private parseResponse(raw: string, expectedCount: number): JudgeResponse {
    // Strategy 1: direct JSON.parse
    try {
      const parsed = JSON.parse(raw) as JudgeResponse;
      if (this.isValidResponse(parsed, expectedCount)) return parsed;
    } catch { /* try next */ }

    // Strategy 2: extract from ```json ... ``` code block
    const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1].trim()) as JudgeResponse;
        if (this.isValidResponse(parsed, expectedCount)) return parsed;
      } catch { /* try next */ }
    }

    // Strategy 3: find ALL substrings that look like {"answers":...} and try to parse each
    // Use a balanced-brace extraction approach
    const jsonCandidates: string[] = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (raw[i] === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          const candidate = raw.slice(start, i + 1);
          if (candidate.includes('"answers"')) jsonCandidates.push(candidate);
          start = -1;
        }
      }
    }
    // Try the LAST candidate first (most likely to be the final answer)
    for (const candidate of jsonCandidates.reverse()) {
      try {
        const parsed = JSON.parse(candidate) as JudgeResponse;
        if (this.isValidResponse(parsed, expectedCount)) return parsed;
      } catch { /* try next */ }
    }

    throw new Error(`Failed to parse judge response: ${raw.slice(0, 200)}`);
  }

  private isValidResponse(obj: unknown, expectedCount: number): obj is JudgeResponse {
    if (!obj || typeof obj !== "object") return false;
    const resp = obj as Record<string, unknown>;
    if (!Array.isArray(resp.answers)) return false;
    return (
      resp.answers.length === expectedCount &&
      resp.answers.every((value) => typeof value === "boolean") &&
      typeof resp.reason === "string"
    );
  }
}

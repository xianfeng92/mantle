/**
 * EvalRunner — orchestrates L2 evaluation for E2E tests.
 *
 * Runs applicable dimensions via GemmaJudge, aggregates scores,
 * and handles failures gracefully (never throws).
 */

import { GemmaJudge, type GemmaJudgeOptions } from "./gemma-judge.js";
import { getDimensions } from "./dimensions.js";
import type { EvalContext, EvalResult } from "./types.js";

export class EvalRunner {
  private judge: GemmaJudge;

  constructor(opts?: GemmaJudgeOptions) {
    this.judge = new GemmaJudge(opts);
  }

  /** Whether L2 evaluation is enabled via environment variable. */
  static get enabled(): boolean {
    return process.env.EVAL_L2 === "1";
  }

  /**
   * Run L2 evaluation for a test.
   *
   * Returns undefined if:
   * - L2 is disabled (EVAL_L2 !== "1")
   * - No dimensions apply to this suite/test
   *
   * Never throws — judge errors are captured in the result.
   */
  async evaluate(ctx: EvalContext): Promise<EvalResult | undefined> {
    if (!EvalRunner.enabled) return undefined;

    const dimensions = getDimensions(ctx.suite, ctx.testName);
    if (dimensions.length === 0) return undefined;

    const start = Date.now();

    try {
      // Run dimensions sequentially to avoid overwhelming LM Studio
      const scores = [];
      for (const dim of dimensions) {
        const score = await this.judge.evaluateDimension(ctx, dim);
        scores.push(score);
      }

      const values = scores.map((s) => s.value);
      const compositeScore = Math.round(
        (values.reduce((a, b) => a + b, 0) / values.length) * 100,
      ) / 100;

      return {
        scores,
        compositeScore,
        allPassed: scores.every((s) => s.passed),
        judgeLatencyMs: Date.now() - start,
        judgeModel: this.judge.model,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        scores: [],
        compositeScore: 0,
        allPassed: false,
        judgeLatencyMs: Date.now() - start,
        judgeModel: this.judge.model,
        judgeError: msg,
      };
    }
  }
}

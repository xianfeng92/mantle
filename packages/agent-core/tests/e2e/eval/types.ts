/**
 * L2 Evaluation types — LLM-as-Judge scoring primitives.
 *
 * Design inspired by DeepEval (threshold pattern), Inspect AI (Score class),
 * and Braintrust (0-1 normalized scores).
 */

// ---------------------------------------------------------------------------
// Checklist item — atomic yes/no judgment
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  question: string;
  answer: boolean;
}

// ---------------------------------------------------------------------------
// Score — result of evaluating one dimension
// ---------------------------------------------------------------------------

export interface Score {
  /** Dimension name, e.g. "correctness", "instruction_following" */
  dimension: string;
  /** Continuous score 0.0-1.0 (count of true / total checklist items) */
  value: number;
  /** Pass/fail threshold for this dimension */
  threshold: number;
  /** Whether value >= threshold */
  passed: boolean;
  /** Judge's brief explanation */
  explanation: string;
  /** Individual checklist results */
  checklist: ChecklistItem[];
}

// ---------------------------------------------------------------------------
// EvalContext — input to the judge
// ---------------------------------------------------------------------------

export interface EvalContext {
  /** The user input / prompt sent to the agent */
  input: string;
  /** The agent's output text */
  output: string;
  /** Optional description of expected behavior (not exact answer) */
  expected?: string;
  /** Test name */
  testName: string;
  /** Suite name */
  suite: string;
}

// ---------------------------------------------------------------------------
// EvalResult — aggregated result for one test
// ---------------------------------------------------------------------------

export interface EvalResult {
  /** Per-dimension scores */
  scores: Score[];
  /** Average across all dimension values */
  compositeScore: number;
  /** All dimensions passed their thresholds? */
  allPassed: boolean;
  /** Total judge inference time in ms */
  judgeLatencyMs: number;
  /** Judge model used */
  judgeModel: string;
  /** Error if judge itself failed */
  judgeError?: string;
}

// ---------------------------------------------------------------------------
// DimensionDef — definition of an evaluation dimension
// ---------------------------------------------------------------------------

export interface DimensionDef {
  /** Unique name, e.g. "correctness" */
  name: string;
  /** Display label for reports */
  label: string;
  /** Pass/fail threshold (0.0-1.0) */
  threshold: number;
  /** Checklist questions for the judge */
  questions: string[];
}

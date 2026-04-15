import assert from "node:assert/strict";
import test from "node:test";

import { AIMessage, ToolMessage } from "@langchain/core/messages";

import {
  DefaultGuardrails,
  GuardrailViolationError,
  serializeGuardrailViolation,
} from "../src/guardrails.js";

test("DefaultGuardrails blocks oversized input and output terms", () => {
  const guardrails = new DefaultGuardrails({
    maxInputChars: 5,
    maxOutputChars: 20,
    blockedInputTerms: ["secret"],
    blockedOutputTerms: ["token"],
  });

  assert.throws(
    () =>
      guardrails.validateInputText("123456", {
        traceId: "trace-1",
        threadId: "thread-1",
        mode: "run",
        source: "user_input",
      }),
    (error: unknown) =>
      error instanceof GuardrailViolationError &&
      error.violation.rule === "max_input_chars" &&
      error.violation.traceId === "trace-1",
  );

  assert.throws(
    () =>
      guardrails.validateMessages(
        [
          new AIMessage("safe"),
          new ToolMessage({
            name: "read_file",
            content: "token=123",
            tool_call_id: "tool-1",
          }),
        ],
        {
          threadId: "thread-1",
          mode: "run",
          source: "invoke_result",
        },
      ),
    (error: unknown) => {
      if (!(error instanceof GuardrailViolationError)) {
        return false;
      }
      const body = serializeGuardrailViolation(error);
      return body.rule === "blocked_output_term" && body.term === "token";
    },
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { analyzeActionRisk, enrichHitlRequest } from "../src/approval-risk.js";
import type { HITLRequest } from "../src/types.js";

test("analyzeActionRisk marks destructive shell commands as high risk", () => {
  const risk = analyzeActionRisk({
    name: "execute",
    args: { command: "rm -rf build && npm run dev" },
  });

  assert.equal(risk.level, "high");
  assert.match(risk.summary, /rm -rf build/);
  assert.match(risk.estimatedImpact ?? "", /high-impact/i);
});

test("analyzeActionRisk marks sensitive file writes as high risk", () => {
  const risk = analyzeActionRisk({
    name: "write_file",
    args: { path: "/Users/demo/.env", content: "OPENAI_API_KEY=secret" },
  });

  assert.equal(risk.level, "high");
  assert.deepEqual(risk.touchedPaths, ["/Users/demo/.env"]);
});

test("enrichHitlRequest attaches risk metadata without changing args", () => {
  const request: HITLRequest = {
    actionRequests: [
      { name: "execute", args: { command: "pwd" } },
      { name: "write_file", args: { path: "note.txt", content: "hello" } },
    ],
    reviewConfigs: [
      { actionName: "execute", allowedDecisions: ["approve", "reject"] },
      { actionName: "write_file", allowedDecisions: ["approve", "edit", "reject"] },
    ],
  };

  const enriched = enrichHitlRequest(request);

  assert.deepEqual(enriched.actionRequests[0]?.args, { command: "pwd" });
  assert.equal(enriched.actionRequests[0]?.risk?.level, "medium");
  assert.equal(enriched.actionRequests[1]?.risk?.level, "medium");
  assert.deepEqual(enriched.reviewConfigs, request.reviewConfigs);
});

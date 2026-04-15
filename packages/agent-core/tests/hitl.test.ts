import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRejectDecisionMessage,
  createInterruptOnConfig,
  extractInterruptRequest,
  formatActionRequest,
  getAllowedDecisions,
  normalizeHitlResponse,
} from "../src/hitl.js";
import type { HITLRequest, InvokeResultLike } from "../src/types.js";

test("createInterruptOnConfig protects sensitive tools", () => {
  const config = createInterruptOnConfig();

  assert.ok("write_file" in config);
  assert.ok("edit_file" in config);
  assert.ok("execute" in config);
});

test("extractInterruptRequest returns first interrupt payload", () => {
  const payload: HITLRequest = {
    actionRequests: [{ name: "execute", args: { command: "pwd" } }],
    reviewConfigs: [{ actionName: "execute", allowedDecisions: ["approve", "reject"] }],
  };

  const result: InvokeResultLike = {
    __interrupt__: [{ value: payload }],
  };

  assert.deepEqual(extractInterruptRequest(result), payload);
});

test("getAllowedDecisions falls back to approve/reject", () => {
  assert.deepEqual(getAllowedDecisions([], "execute"), ["approve", "reject"]);
});

test("formatActionRequest includes description and args", () => {
  const rendered = formatActionRequest(
    {
      name: "write_file",
      args: { path: "out.txt", content: "hello" },
      description: "Need approval before writing a file.",
    },
    ["approve", "edit", "reject"],
  );

  assert.match(rendered, /write_file/);
  assert.match(rendered, /Need approval/);
  assert.match(rendered, /out\.txt/);
});

test("buildRejectDecisionMessage marks the action as cancelled", () => {
  const message = buildRejectDecisionMessage({
    name: "write_file",
    args: { path: "out.txt", content: "hello" },
  });

  assert.match(message, /\[hitl_rejected\]/);
  assert.match(message, /write_file/);
  assert.match(message, /cancelled/i);
  assert.match(message, /Do not retry/i);
});

test("normalizeHitlResponse fills in a strong default reject message", () => {
  const normalized = normalizeHitlResponse(
    { decisions: [{ type: "reject" }] },
    [{ name: "execute", args: { command: "rm -rf tmp" } }],
  );

  const decision = normalized.decisions[0];
  assert.ok(decision && decision.type === "reject");
  assert.match(decision.message ?? "", /\[hitl_rejected\]/);
  assert.match(decision.message ?? "", /execute/);
});

test("normalizeHitlResponse preserves explicit reject messages", () => {
  const normalized = normalizeHitlResponse(
    { decisions: [{ type: "reject", message: "User cancelled from UI." }] },
    [{ name: "write_file", args: { path: "out.txt", content: "hello" } }],
  );

  const decision = normalized.decisions[0];
  assert.ok(decision && decision.type === "reject");
  assert.equal(decision.message, "User cancelled from UI.");
});

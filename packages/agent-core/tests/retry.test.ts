import assert from "node:assert/strict";
import test from "node:test";

import {
  isContextSizeExceededError,
  isTransientLmStudioError,
  withRetry,
} from "../src/retry.js";

test("withRetry succeeds on first attempt without delay", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      return "ok";
    },
    { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("withRetry fails once then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls === 1) {
        const err = new Error("fetch failed");
        throw err;
      }
      return "recovered";
    },
    { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
  );
  assert.equal(result, "recovered");
  assert.equal(calls, 2);
});

test("withRetry exhausts all retries and throws last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          const err = new Error("fetch failed");
          throw err;
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      ),
    (error: unknown) =>
      error instanceof Error && error.message === "fetch failed",
  );
  assert.equal(calls, 3);
});

test("withRetry with non-retryable error throws immediately", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new Error("invalid API key");
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
      ),
    (error: unknown) =>
      error instanceof Error && error.message === "invalid API key",
  );
  assert.equal(calls, 1);
});

test("withRetry calls onRetry callback with correct params", async () => {
  const retries: Array<{ attempt: number; error: unknown; delayMs: number }> = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        throw new Error("fetch failed");
      }
      return "done";
    },
    {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      onRetry: (attempt, error, delayMs) => {
        retries.push({ attempt, error, delayMs });
      },
    },
  );
  assert.equal(result, "done");
  assert.equal(retries.length, 2);
  assert.equal(retries[0].attempt, 1);
  assert.equal(retries[1].attempt, 2);
  assert.ok(retries[0].delayMs > 0);
  assert.ok(retries[1].delayMs > 0);
  assert.ok(retries[0].error instanceof Error);
});

test("isTransientLmStudioError recognizes ECONNREFUSED", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.ok(isTransientLmStudioError(err));
});

test("isTransientLmStudioError recognizes ETIMEDOUT", () => {
  const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  assert.ok(isTransientLmStudioError(err));
});

test("isTransientLmStudioError recognizes HTTP 503 errors", () => {
  const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
  assert.ok(isTransientLmStudioError(err));
});

test("isTransientLmStudioError recognizes fetch failed", () => {
  assert.ok(isTransientLmStudioError(new Error("fetch failed")));
});

test("isTransientLmStudioError recognizes network error", () => {
  assert.ok(isTransientLmStudioError(new Error("network error")));
});

test("isTransientLmStudioError rejects non-transient errors", () => {
  assert.ok(!isTransientLmStudioError(new Error("invalid API key")));
  assert.ok(!isTransientLmStudioError(new Error("bad request")));
  assert.ok(!isTransientLmStudioError(Object.assign(new Error("not found"), { status: 404 })));
});

test("isContextSizeExceededError recognizes context size exceeded", () => {
  assert.ok(isContextSizeExceededError(new Error("context size exceeded")));
});

test("isContextSizeExceededError recognizes context length exceeded", () => {
  assert.ok(isContextSizeExceededError(new Error("context length exceeded for model")));
});

test("isContextSizeExceededError recognizes n_keep >= n_ctx", () => {
  assert.ok(isContextSizeExceededError(new Error("n_keep >= n_ctx")));
});

test("isContextSizeExceededError rejects unrelated errors", () => {
  assert.ok(!isContextSizeExceededError(new Error("fetch failed")));
  assert.ok(!isContextSizeExceededError(new Error("invalid API key")));
  assert.ok(!isContextSizeExceededError(new Error("ECONNREFUSED")));
});

import { createLogger } from "./logger.js";

const log = createLogger("retry");

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableError?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    retryableError = isTransientLmStudioError,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !retryableError(error)) {
        throw error;
      }

      const exponentialDelay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = Math.floor(Math.random() * 100);
      const delayMs = exponentialDelay + jitter;

      log.warn("retrying", { attempt: attempt + 1, maxAttempts, delayMs, error: error instanceof Error ? error.message : String(error) });
      onRetry?.(attempt + 1, error, delayMs);

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  /* istanbul ignore next -- safety net; loop always throws or returns */
  throw lastError;
}

function errorMessageMatches(error: unknown, patterns: RegExp[]): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return patterns.some((pattern) => pattern.test(message));
}

function errorHasCode(error: unknown, codes: string[]): boolean {
  if (error && typeof error === "object" && "code" in error) {
    return codes.includes(String((error as { code: unknown }).code));
  }
  return false;
}

function errorHasStatus(error: unknown, statuses: number[]): boolean {
  if (error && typeof error === "object" && "status" in error) {
    return statuses.includes(Number((error as { status: unknown }).status));
  }
  return false;
}

export function isTransientLmStudioError(error: unknown): boolean {
  if (errorHasCode(error, ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"])) {
    return true;
  }
  if (errorHasStatus(error, [502, 503, 504])) {
    return true;
  }
  if (errorMessageMatches(error, [/fetch failed/i, /network error/i])) {
    return true;
  }
  return false;
}

export function isContextSizeExceededError(error: unknown): boolean {
  return errorMessageMatches(error, [
    /context size exceeded/i,
    /context length exceeded/i,
    /n_keep\s*>=\s*n_ctx/i,
  ]);
}

import { ToolError, isRetryable, describeError } from './errors.ts';
import type { Rng } from './rng.ts';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 25, maxDelayMs: 300 };

export interface RetryOutcome<T> {
  value: T | null;
  attempts: number;
  retries: number;
  error: Error | null;
  /** True when a retryable failure was eventually survived. */
  recovered: boolean;
}

/** Bounded retry with exponential backoff and deterministic jitter.
 *  Never throws: the caller gets a structured outcome and decides whether a
 *  missing result is fatal, which is what lets agents degrade instead of die. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    policy?: Partial<RetryPolicy>;
    rng?: Rng;
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  } = {},
): Promise<RetryOutcome<T>> {
  const policy = { ...DEFAULT_RETRY, ...opts.policy };
  let lastError: Error | null = null;
  let retries = 0;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt, retries, error: null, recovered: retries > 0 };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const canRetry = isRetryable(e) && attempt < policy.maxAttempts;
      if (!canRetry) break;
      retries += 1;
      const expo = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      const jitter = opts.rng ? opts.rng.float(0.5, 1.5) : 1;
      const delay = Math.round(expo * jitter);
      opts.onRetry?.(attempt, e, delay);
      await sleep(delay);
    }
  }

  return { value: null, attempts: policy.maxAttempts, retries, error: lastError, recovered: false };
}

/** Per-tool circuit breaker. After `threshold` consecutive failures a tool is
 *  skipped for `cooldownMs` so one dead backend cannot consume the whole
 *  tool-call budget. */
export class CircuitBreaker {
  private failures = new Map<string, number>();
  private openUntil = new Map<string, number>();

  constructor(
    private readonly threshold = 3,
    private readonly cooldownMs = 5_000,
  ) {}

  isOpen(key: string): boolean {
    const until = this.openUntil.get(key);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.openUntil.delete(key);
      this.failures.set(key, 0);
      return false;
    }
    return true;
  }

  recordSuccess(key: string): void {
    this.failures.set(key, 0);
    this.openUntil.delete(key);
  }

  recordFailure(key: string): void {
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    if (n >= this.threshold) this.openUntil.set(key, Date.now() + this.cooldownMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Races a promise against a deadline, surfacing the timeout as a retryable
 *  ToolError rather than an unhandled rejection. */
export async function withTimeout<T>(p: Promise<T>, ms: number, tool: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ToolError(`timed out after ${ms}ms`, 'timeout', true, tool)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { describeError };

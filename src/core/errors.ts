/** Errors the system is designed to survive. Each carries `retryable` so the
 *  retry layer never has to pattern-match on message strings. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'timeout'
      | 'partial_result'
      | 'unavailable'
      | 'rate_limited'
      | 'bad_query'
      | 'not_found'
      | 'corrupt_data'
      | 'internal',
    readonly retryable: boolean,
    readonly tool: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly agent: string,
    readonly retryable: boolean,
    readonly cause__?: unknown,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export class BudgetExceededError extends Error {
  constructor(readonly resource: string, readonly limit: number) {
    super(`Budget exceeded for ${resource} (limit ${limit})`);
    this.name = 'BudgetExceededError';
  }
}

export function describeError(e: unknown): string {
  if (e instanceof ToolError) return `${e.tool}: ${e.code}: ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

export function isRetryable(e: unknown): boolean {
  if (e instanceof ToolError) return e.retryable;
  if (e instanceof AgentError) return e.retryable;
  if (e instanceof BudgetExceededError) return false;
  return false;
}

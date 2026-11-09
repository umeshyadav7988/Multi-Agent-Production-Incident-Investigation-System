import { BudgetExceededError } from './errors.ts';

export interface BudgetLimits {
  wallClockMs: number;
  toolCalls: number;
  llmCalls: number;
  tokens: number;
  tasks: number;
  rounds: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  wallClockMs: 120_000,
  toolCalls: 60,
  llmCalls: 40,
  tokens: 400_000,
  tasks: 60,
  rounds: 4,
};

/** Hard execution limits. Every loop in the system checks `exhausted()` so a
 *  runaway investigation terminates with a report rather than hanging. */
export class Budget {
  readonly limits: BudgetLimits;
  private readonly start = Date.now();
  private used = { toolCalls: 0, llmCalls: 0, tokens: 0, tasks: 0, rounds: 0 };

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  spend(resource: keyof typeof this.used, n = 1): void {
    this.used[resource] += n;
  }

  remaining(resource: keyof BudgetLimits): number {
    if (resource === 'wallClockMs') return this.limits.wallClockMs - (Date.now() - this.start);
    return this.limits[resource] - this.used[resource];
  }

  /** Returns the name of the first exhausted resource, or null. */
  exhausted(): keyof BudgetLimits | null {
    if (Date.now() - this.start >= this.limits.wallClockMs) return 'wallClockMs';
    for (const k of ['toolCalls', 'llmCalls', 'tokens', 'tasks', 'rounds'] as const) {
      if (this.used[k] >= this.limits[k]) return k;
    }
    return null;
  }

  assertAvailable(resource: keyof BudgetLimits): void {
    if (this.remaining(resource) <= 0) {
      throw new BudgetExceededError(resource, this.limits[resource]);
    }
  }

  snapshot(): Record<string, number> {
    return { ...this.used, elapsedMs: Date.now() - this.start };
  }
}

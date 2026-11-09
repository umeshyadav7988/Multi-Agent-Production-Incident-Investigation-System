import type { z } from 'zod';
import { ALL_TOOLS } from './definitions.ts';
import type { Envelope, ToolContext, ToolDefinition } from './types.ts';
import { FaultInjector } from './faults.ts';
import { ToolError, describeError } from '../core/errors.ts';
import { withRetry, withTimeout, CircuitBreaker, sleep } from '../core/retry.ts';
import { Telemetry } from '../core/telemetry.ts';
import { Budget } from '../core/budget.ts';
import type { Rng } from '../core/rng.ts';
import type { AgentName } from '../core/types.ts';

type AnyTool = ToolDefinition<z.ZodTypeAny, z.ZodTypeAny>;

export interface ToolCallRecord {
  tool: string;
  agent: AgentName;
  input: Record<string, unknown>;
  ok: boolean;
  complete: boolean;
  elapsedMs: number;
  attempts: number;
  error: string | null;
}

/**
 * The only path from an agent to data.
 *
 * Responsibilities, in order: validate the input against the tool's schema,
 * consult the budget, inject faults, enforce a timeout, retry what is
 * retryable, trip a breaker on a repeatedly-failing tool, validate the output,
 * and hand back an envelope that states plainly whether the result is complete.
 * An agent never sees a raw throw from a tool.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private readonly breaker = new CircuitBreaker(3, 4_000);
  readonly calls: ToolCallRecord[] = [];

  constructor(
    private readonly ctx: ToolContext,
    private readonly faults: FaultInjector,
    private readonly telemetry: Telemetry,
    private readonly budget: Budget,
    private readonly rng: Rng,
    private readonly simulateLatency = true,
  ) {
    for (const t of ALL_TOOLS) this.tools.set(t.name, t as AnyTool);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  describe(): { name: string; description: string; inputSchema: string }[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: summariseSchema(t.input),
    }));
  }

  /** Never throws. Callers branch on `ok` / `complete`. */
  async call<T = unknown>(
    name: string,
    rawInput: Record<string, unknown>,
    agent: AgentName,
  ): Promise<Envelope<T>> {
    const started = Date.now();
    const tool = this.tools.get(name);

    if (!tool) {
      return this.record(agent, name, rawInput, {
        ok: false, tool: name, complete: false, warnings: [],
        data: null as T | null, elapsedMs: 0, attempts: 0,
        error: { code: 'not_found', message: `no such tool "${name}"`, retryable: false },
      });
    }

    if (this.budget.remaining('toolCalls') <= 0) {
      return this.record(agent, name, rawInput, {
        ok: false, tool: name, complete: false, warnings: ['tool-call budget exhausted'],
        data: null as T | null, elapsedMs: 0, attempts: 0,
        error: { code: 'budget', message: 'tool-call budget exhausted', retryable: false },
      });
    }

    if (this.breaker.isOpen(name)) {
      this.telemetry.emit('tool_error', `${name} skipped: circuit open`, { agent });
      return this.record(agent, name, rawInput, {
        ok: false, tool: name, complete: false,
        warnings: [`circuit breaker open for ${name}; not retried`],
        data: null as T | null, elapsedMs: 0, attempts: 0,
        error: { code: 'unavailable', message: 'circuit breaker open', retryable: false },
      });
    }

    // --- input validation ---------------------------------------------------
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      this.telemetry.emit('tool_error', `${name} rejected input: ${message}`, { agent });
      return this.record(agent, name, rawInput, {
        ok: false, tool: name, complete: false, warnings: [],
        data: null as T | null, elapsedMs: Date.now() - started, attempts: 0,
        error: { code: 'bad_query', message, retryable: false },
      });
    }
    const input = parsed.data as Record<string, unknown>;

    this.telemetry.emit('tool_call', `${name}(${compact(input)})`, { agent });

    const warnings: string[] = [];
    let complete = true;

    const outcome = await withRetry(
      async () => {
        // Check and spend together, before any await. A retry is a real call and
        // must be paid for, and concurrent callers must not all pass a check
        // that only one of them can afford. Without this the limit is advisory.
        if (this.budget.remaining('toolCalls') <= 0) {
          throw new ToolError('tool-call budget exhausted', 'internal', false, name);
        }
        this.budget.spend('toolCalls');
        this.telemetry.toolCalls += 1;

        const fault = this.faults.decide(name);
        if (fault.mode && fault.mode !== 'partial_result' && fault.mode !== 'corrupt_data') {
          this.telemetry.toolFailures += 1;
          throw FaultInjector.toError(fault.mode, name);
        }

        const work = (async () => {
          if (this.simulateLatency) {
            const [lo, hi] = tool.latencyMs;
            await sleep(this.rng.int(lo, hi));
          }
          return tool.handler(input, this.ctx);
        })();

        let data = await withTimeout(work, 3_000, name);

        if (fault.mode === 'partial_result') {
          data = truncate(data);
          complete = false;
          warnings.push(`${name} returned a partial result (upstream truncated the response)`);
          this.telemetry.emit('warning', `${name} partial result`, { agent });
        } else if (fault.mode === 'corrupt_data') {
          this.telemetry.toolFailures += 1;
          throw FaultInjector.toError('corrupt_data', name);
        }

        const validated = tool.output.safeParse(data);
        if (!validated.success) {
          throw new ToolError(
            `output failed schema validation: ${validated.error.issues[0]?.message ?? 'unknown'}`,
            'internal', false, name,
          );
        }
        return validated.data;
      },
      {
        rng: this.rng,
        policy: { maxAttempts: 3 },
        onRetry: (attempt, e, delay) => {
          this.telemetry.toolRetries += 1;
          this.telemetry.emit('tool_error', `${name} attempt ${attempt} failed (${describeError(e)}); retrying in ${delay}ms`, { agent });
        },
      },
    );

    if (outcome.value === null) {
      this.breaker.recordFailure(name);
      const err = outcome.error;
      const code = err instanceof ToolError ? err.code : 'internal';
      this.telemetry.emit('tool_error', `${name} failed after ${outcome.attempts} attempt(s): ${err?.message ?? 'unknown'}`, { agent });
      return this.record(agent, name, input, {
        ok: false, tool: name, complete: false, warnings,
        data: null as T | null, elapsedMs: Date.now() - started, attempts: outcome.attempts,
        error: { code, message: err?.message ?? 'unknown failure', retryable: err instanceof ToolError ? err.retryable : false },
      });
    }

    this.breaker.recordSuccess(name);
    if (outcome.recovered) warnings.push(`${name} succeeded after ${outcome.retries} retry(ies)`);

    this.telemetry.emit('tool_result', `${name} ok${complete ? '' : ' (partial)'}`, {
      agent,
      data: { attempts: outcome.attempts },
    });

    return this.record(agent, name, input, {
      ok: true, tool: name, complete, warnings,
      data: outcome.value as T, elapsedMs: Date.now() - started,
      attempts: outcome.attempts, error: null,
    });
  }

  private record<T>(
    agent: AgentName,
    tool: string,
    input: Record<string, unknown>,
    env: Envelope<T>,
  ): Envelope<T> {
    this.calls.push({
      tool, agent, input,
      ok: env.ok, complete: env.complete,
      elapsedMs: env.elapsedMs, attempts: env.attempts,
      error: env.error?.message ?? null,
    });
    return env;
  }
}

/** Keeps roughly the first 40% of every array so a partial result is usable
 *  but visibly incomplete. */
function truncate(data: unknown): unknown {
  if (Array.isArray(data)) return data.slice(0, Math.max(1, Math.floor(data.length * 0.4)));
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = Array.isArray(v) ? v.slice(0, Math.max(1, Math.floor(v.length * 0.4))) : v;
    }
    return out;
  }
  return data;
}

function compact(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}

/** Renders a zod object schema as a short field list for LLM tool descriptions. */
function summariseSchema(schema: z.ZodTypeAny): string {
  const def = (schema as unknown as { def?: { shape?: Record<string, unknown> } }).def;
  const shape = def?.shape;
  if (!shape) return '{}';
  return `{ ${Object.keys(shape).join(', ')} }`;
}

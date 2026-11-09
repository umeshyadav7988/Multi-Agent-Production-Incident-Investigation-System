import type { z } from 'zod';
import type { World } from '../data/world.ts';
import type { Rng } from '../core/rng.ts';

export interface ToolContext {
  world: World;
  rng: Rng;
  /** Window the incident reporter supplied; tools default to it. */
  defaultWindow: { start: string; end: string };
}

export interface ToolDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  output: O;
  /** Nominal latency, used to make parallelism observable in the trace. */
  latencyMs: [number, number];
  handler: (input: z.infer<I>, ctx: ToolContext) => z.infer<O>;
}

/** Every tool result carries completeness and warnings so a partial answer is
 *  never silently treated as a full one. */
export interface Envelope<T> {
  ok: boolean;
  tool: string;
  complete: boolean;
  warnings: string[];
  data: T | null;
  error: { code: string; message: string; retryable: boolean } | null;
  elapsedMs: number;
  attempts: number;
}

export function defineTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return def;
}

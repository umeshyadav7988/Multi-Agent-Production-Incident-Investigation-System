import { HeuristicEngine } from './heuristic.ts';
import { LlmEngine } from './llm.ts';
import { resolveModelConfig } from './client.ts';
import type { ReasoningEngine } from './engine.ts';
import type { Telemetry } from '../telemetry.ts';
import type { Budget } from '../budget.ts';

export type EngineMode = 'heuristic' | 'llm';

export interface EngineOptions {
  mode: EngineMode;
  modelId?: string;
  telemetry: Telemetry;
  budget: Budget;
}

/** Resolves the configured engine, degrading to heuristic when no key exists
 *  so that `npm test` and a fresh clone both work with zero setup. */
export function createEngine(opts: EngineOptions): ReasoningEngine {
  if (opts.mode === 'heuristic') return new HeuristicEngine();

  const cfg = resolveModelConfig(opts.modelId);
  if (!cfg) {
    opts.telemetry.emit(
      'warning',
      'ENGINE=llm but no provider key is set (GROQ_API_KEY / AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY); using the deterministic engine',
      { agent: 'system' },
    );
    return new HeuristicEngine();
  }

  opts.telemetry.emit('llm_call', `engine=llm provider=${cfg.provider} model=${cfg.modelId}`, { agent: 'system' });
  return new LlmEngine(cfg, opts.telemetry, opts.budget);
}

export { HeuristicEngine, LlmEngine };
export type { ReasoningEngine };
export * from './engine.ts';

import { generateWorld } from './data/generator.ts';
import { getScenario, toIncidentReport } from './data/scenarios/index.ts';
import type { ScenarioSpec } from './data/world.ts';
import { ToolRegistry } from './tools/registry.ts';
import { FaultInjector } from './tools/faults.ts';
import { Telemetry } from './core/telemetry.ts';
import { Budget, type BudgetLimits } from './core/budget.ts';
import { Rng } from './core/rng.ts';
import { createEngine, type EngineMode } from './core/llm/index.ts';
import { Orchestrator } from './agents/orchestrator.ts';
import { runSingleAgentBaseline } from './baseline/single-agent.ts';
import type { InvestigationOutcome, IncidentReport } from './core/types.ts';

export interface RunOptions {
  scenarioId: string;
  seed?: number | string;
  engine?: EngineMode;
  modelId?: string;
  faultRate?: number;
  verbose?: boolean;
  limits?: Partial<BudgetLimits>;
  /** Disable simulated tool latency to make tests fast. */
  fastTools?: boolean;
}

export interface RunContext {
  spec: ScenarioSpec;
  incident: IncidentReport;
  tools: ToolRegistry;
  telemetry: Telemetry;
  budget: Budget;
  engineMode: EngineMode;
  knownServices: string[];
  modelId: string | undefined;
}

export function envDefault<T extends string>(key: string, fallback: T): T {
  const v = process.env[key]?.trim();
  return (v ? (v as T) : fallback);
}

/** Builds everything a run needs. Both approaches use this identical context so
 *  the comparison differs only in orchestration. */
export function buildContext(opts: RunOptions, approach: string): RunContext {
  const spec = getScenario(opts.scenarioId);
  const seed = opts.seed ?? Number(process.env.SEED ?? 20260401);
  const faultRate = opts.faultRate ?? Number(process.env.TOOL_FAULT_RATE ?? 0.12);
  const engineMode: EngineMode = opts.engine ?? envDefault<EngineMode>('ENGINE', 'heuristic');

  const { world } = generateWorld(spec, seed);
  const incident = toIncidentReport(spec);
  const telemetry = new Telemetry(opts.verbose ?? false);

  // A deterministic run finishes in milliseconds; one that calls a hosted model
  // spends most of its wall clock waiting on the network and on provider rate
  // limits. Using the same deadline for both silently truncates every LLM run
  // at the point the throttle starts working.
  const budget = new Budget({
    ...(engineMode === 'llm' ? { wallClockMs: 900_000, llmCalls: 30 } : {}),
    ...(opts.limits ?? {}),
  });

  // The fault stream is derived from (seed, approach) so both approaches meet a
  // comparable but independently-drawn pattern of failures.
  const rng = new Rng(`${seed}:${spec.id}:${approach}`);
  const faults = new FaultInjector(rng.fork('faults'), faultRate, spec.forcedToolFaults ?? []);

  const tools = new ToolRegistry(
    { world, rng: rng.fork('toolctx'), defaultWindow: incident.window },
    faults,
    telemetry,
    budget,
    rng.fork('retry'),
    !(opts.fastTools ?? false),
  );

  return {
    spec, incident, tools, telemetry, budget, engineMode,
    knownServices: world.services.map((s) => s.name),
    modelId: opts.modelId,
  };
}

/** Runs the full multi-agent investigation. */
export async function runMultiAgent(opts: RunOptions): Promise<InvestigationOutcome> {
  const ctx = buildContext(opts, 'multi');
  const engine = createEngine({
    mode: ctx.engineMode,
    modelId: ctx.modelId,
    telemetry: ctx.telemetry,
    budget: ctx.budget,
  });

  const orchestrator = new Orchestrator({
    incident: ctx.incident,
    tools: ctx.tools,
    engine,
    telemetry: ctx.telemetry,
    budget: ctx.budget,
    knownServices: ctx.knownServices,
  });

  return orchestrator.run();
}

/** Runs the single-agent baseline against the same world and the same tools. */
export async function runSingleAgent(opts: RunOptions): Promise<InvestigationOutcome> {
  const ctx = buildContext(opts, 'single');
  const engine = createEngine({
    mode: ctx.engineMode,
    modelId: ctx.modelId,
    telemetry: ctx.telemetry,
    budget: ctx.budget,
  });
  return runSingleAgentBaseline(ctx, engine);
}

export { getScenario, toIncidentReport };

import { SCENARIOS } from '../data/scenarios/index.ts';
import { runMultiAgent, runSingleAgent } from '../run.ts';
import { grade, aggregate, type Grade, type Aggregate } from './grade.ts';
import type { EngineMode } from '../core/llm/index.ts';
import type { InvestigationOutcome } from '../core/types.ts';
import type { BudgetLimits } from '../core/budget.ts';

export interface EvalOptions {
  engine?: EngineMode;
  modelId?: string;
  seed?: number | string;
  faultRate?: number;
  scenarioIds?: string[];
  approaches?: ('multi-agent' | 'single-agent')[];
  /** Run each incident this many times with different seeds. */
  repeats?: number;
  /** Investigations that do not touch the network can run concurrently. */
  concurrency?: number;
  fastTools?: boolean;
  /** Per-investigation execution limits, overriding the engine defaults. */
  limits?: Partial<BudgetLimits>;
  onProgress?: (msg: string) => void;
}

export interface EvalResults {
  startedAt: string;
  engine: EngineMode;
  seed: string;
  faultRate: number;
  repeats: number;
  grades: Grade[];
  byApproach: Aggregate[];
  byTrait: { trait: string; approach: string; n: number; accuracy: number; grounding: number }[];
  perIncident: {
    incidentId: string;
    title: string;
    expected: string;
    results: { approach: string; predicted: string; correct: boolean; confidence: number; verdict: string }[];
  }[];
  wallClockMs: number;
}

/**
 * Runs the full evaluation: every incident, every approach, graded against the
 * hidden key. Both approaches see the same generated world for a given seed, so
 * differences come from coordination rather than from luck of the draw.
 */
export async function runEvaluation(opts: EvalOptions = {}): Promise<EvalResults> {
  const started = Date.now();
  const engine: EngineMode = opts.engine ?? 'heuristic';
  const seedBase = opts.seed ?? Number(process.env.SEED ?? 20260401);
  const faultRate = opts.faultRate ?? Number(process.env.TOOL_FAULT_RATE ?? 0.12);
  const repeats = Math.max(1, opts.repeats ?? 1);
  const approaches = opts.approaches ?? ['multi-agent', 'single-agent'];
  const specs = opts.scenarioIds?.length
    ? SCENARIOS.filter((s) => opts.scenarioIds!.some((id) => id.toLowerCase() === s.id.toLowerCase()))
    : SCENARIOS;

  if (specs.length === 0) throw new Error('no scenarios selected');

  const jobs: { spec: (typeof specs)[number]; approach: 'multi-agent' | 'single-agent'; seed: string }[] = [];
  for (const spec of specs) {
    for (let r = 0; r < repeats; r++) {
      for (const approach of approaches) {
        jobs.push({ spec, approach, seed: `${seedBase}:${r}` });
      }
    }
  }

  // Real model calls are rate-limited and expensive, so serialise them; the
  // deterministic engine is pure CPU and fans out safely.
  const concurrency = opts.concurrency ?? (engine === 'llm' ? 2 : 4);
  const grades: Grade[] = [];
  let done = 0;

  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const run = job.approach === 'multi-agent' ? runMultiAgent : runSingleAgent;
      let outcome: InvestigationOutcome;
      try {
        outcome = await run({
          scenarioId: job.spec.id,
          seed: job.seed,
          engine,
          modelId: opts.modelId,
          faultRate,
          fastTools: opts.fastTools ?? false,
          ...(opts.limits ? { limits: opts.limits } : {}),
        });
      } catch (e) {
        opts.onProgress?.(`  !! ${job.spec.id} [${job.approach}] threw: ${String(e)}`);
        continue;
      }
      grades.push(grade(job.spec, outcome, job.approach));
      done++;
      opts.onProgress?.(
        `  [${String(done).padStart(3)}/${jobs.length}] ${job.spec.id} ${job.approach.padEnd(12)} -> ${outcome.report.verdict}`,
      );
    }
  });
  await Promise.all(workers);

  const byApproach = approaches.map((a) => aggregate(grades.filter((g) => g.approach === a), a));

  const traits = [...new Set(specs.flatMap((s) => s.traits))].sort();
  const byTrait = traits.flatMap((trait) =>
    approaches.map((approach) => {
      const subset = grades.filter((g) => g.approach === approach && g.traits.includes(trait));
      const agg = aggregate(subset, approach);
      return { trait, approach, n: subset.length, accuracy: agg.accuracy, grounding: agg.grounding };
    }),
  );

  const perIncident = specs.map((spec) => ({
    incidentId: spec.id,
    title: spec.title,
    expected: `${spec.truth.category}${spec.truth.expectInconclusive ? ' (expect inconclusive)' : ` @ ${spec.truth.service}`}`,
    results: approaches.map((approach) => {
      const g = grades.find((x) => x.incidentId === spec.id && x.approach === approach);
      return {
        approach,
        predicted: g ? (g.verdict === 'inconclusive' ? 'inconclusive' : `${g.predictedCategory} @ ${g.predictedService}`) : 'n/a',
        correct: g?.correct ?? false,
        confidence: g?.confidence ?? 0,
        verdict: g?.verdict ?? 'n/a',
      };
    }),
  }));

  return {
    startedAt: new Date(started).toISOString(),
    engine,
    seed: String(seedBase),
    faultRate,
    repeats,
    grades,
    byApproach,
    byTrait,
    perIncident,
    wallClockMs: Date.now() - started,
  };
}

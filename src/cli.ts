import { writeFileSync, mkdirSync } from 'node:fs';
import { loadEnv, describeCredentials } from './env.ts';
import { dirname, resolve } from 'node:path';
import { SCENARIOS, getScenario, toIncidentReport } from './data/scenarios/index.ts';
import { runMultiAgent, runSingleAgent } from './run.ts';
import { runEvaluation } from './eval/harness.ts';
import { renderMarkdown, renderConsole, renderRobustness, type SweepEntry } from './eval/report.ts';
import { formatReport, formatTrace } from './format.ts';
import type { EngineMode } from './core/llm/index.ts';
import type { BudgetLimits } from './core/budget.ts';

loadEnv();

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flags = parseFlags(args.slice(1));
const positional = args.slice(1).filter((a) => !a.startsWith('--'));

async function main(): Promise<void> {
  switch (cmd) {
    case 'list': return list();
    case 'show': return show();
    case 'investigate': return investigate();
    case 'eval': return evaluate();
    default: return help();
  }
}

function help(): void {
  console.log(`
Multi-agent production incident investigation system

  npm run list                             List the synthetic incident dataset
  npm run show -- INC-5001                 Show the incident as the system receives it
  npm run investigate -- INC-5001          Run the multi-agent investigation
  npm run investigate -- INC-5001 --single Run the single-agent baseline instead
  npm run eval                             Evaluate both approaches on all incidents

Flags
  --engine=heuristic|llm   Reasoning engine (default: $ENGINE, else heuristic)
  --model=<id>             Model id when --engine=llm (default: $MODEL_ID)
  --seed=<n>               Deterministic seed (default: $SEED)
  --faults=<0..1>          Background tool fault rate (default: $TOOL_FAULT_RATE)
  --verbose                Stream the agent trace to stderr while running
  --trace                  Print the full trace after the report
  --json                   Emit machine-readable JSON instead of prose
  --single                 (investigate) use the single-agent baseline
  --only=ID,ID             (eval) restrict to these incidents
  --repeats=<n>            (eval) repeat each incident with different seeds
  --out=<path>             (eval) write the Markdown report here
  --sweep                  (eval) also run two harsher configurations and
                           append a robustness table to the report
  --concurrency=<n>        (eval) parallel investigations; use 1 with a
                           rate-limited model provider
  --max-seconds=<n>        (eval) wall-clock limit per investigation
  --max-llm-calls=<n>      (eval) model-call limit per investigation
  --max-rounds=<n>         (eval) investigation round limit
  --fast                   Skip simulated tool latency
`);
}

function list(): void {
  console.log(`\n${SCENARIOS.length} synthetic incidents\n`);
  console.log(`${'ID'.padEnd(10)} ${'SEV'.padEnd(5)} ${'TITLE'.padEnd(52)} TRAITS`);
  console.log('-'.repeat(130));
  for (const s of SCENARIOS) {
    console.log(`${s.id.padEnd(10)} ${s.severity.padEnd(5)} ${s.title.slice(0, 50).padEnd(52)} ${s.traits.join(', ')}`);
  }
  console.log('\nGround truth is stored with each scenario but is never shown to any agent;');
  console.log('it is read only by the grader in src/eval/grade.ts after a run completes.\n');
}

function show(): void {
  const id = positional[0];
  if (!id) throw new Error('usage: npm run show -- <INCIDENT-ID>');
  const spec = getScenario(id);
  const incident = toIncidentReport(spec);
  if (flags.json) {
    console.log(JSON.stringify({ incident, traits: spec.traits }, null, 2));
    return;
  }
  console.log(`\n${incident.id} — ${incident.title}  [${incident.severity}]`);
  console.log(`reported ${incident.reportedAt} by ${incident.reporter}`);
  console.log(`window   ${incident.window.start} → ${incident.window.end}`);
  console.log(`services ${incident.affectedServices.join(', ')}`);
  console.log(`\n${incident.description}\n`);
  console.log('Symptoms:');
  for (const s of incident.symptoms) console.log(`  - ${s}`);
  console.log(`\nEvaluation traits: ${spec.traits.join(', ')}`);
  console.log('(the ground-truth cause is withheld here on purpose)\n');
}

async function investigate(): Promise<void> {
  const id = positional[0];
  if (!id) throw new Error('usage: npm run investigate -- <INCIDENT-ID>');
  const spec = getScenario(id);

  const opts = {
    scenarioId: spec.id,
    engine: flags.engine as EngineMode | undefined,
    modelId: flags.model,
    seed: flags.seed,
    faultRate: flags.faults,
    verbose: flags.verbose,
    fastTools: flags.fast,
  };

  const started = Date.now();
  const outcome = flags.single ? await runSingleAgent(opts) : await runMultiAgent(opts);

  if (flags.json) {
    console.log(JSON.stringify({ report: outcome.report, metrics: outcome.metrics, evidence: outcome.evidence }, null, 2));
    return;
  }

  console.log(formatReport(outcome, flags.single ? 'single-agent baseline' : 'multi-agent system'));
  if (flags.trace) console.log(formatTrace(outcome.trace));
  console.log(`\nCompleted in ${Date.now() - started}ms. Ground truth for grading: ${spec.truth.category}${spec.truth.expectInconclusive ? ' (inconclusive expected)' : ` @ ${spec.truth.service}`}\n`);
}

async function evaluate(): Promise<void> {
  const only = flags.only ? flags.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const limits = evalLimits(flags);
  console.error(`Running evaluation... (engine=${flags.engine ?? process.env.ENGINE ?? 'heuristic'}, credentials: ${describeCredentials()})`);
  const results = await runEvaluation({
    engine: flags.engine as EngineMode | undefined,
    modelId: flags.model,
    seed: flags.seed,
    faultRate: flags.faults,
    scenarioIds: only,
    repeats: flags.repeats ? Number(flags.repeats) : 1,
    fastTools: flags.fast,
    ...(flags.concurrency ? { concurrency: Number(flags.concurrency) } : {}),
    ...(limits ? { limits } : {}),
    onProgress: (m) => console.error(m),
  });

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(renderConsole(results));
  }

  let markdown = renderMarkdown(results);

  if (flags.sweep) {
    const configs: { label: string; seed: string; faults: number }[] = [
      { label: 'seed 777, faults 0.30', seed: '777', faults: 0.3 },
      { label: 'seed 31337, faults 0.45', seed: '31337', faults: 0.45 },
    ];
    const entries: SweepEntry[] = [
      { label: `seed ${results.seed}, faults ${results.faultRate}`, results },
    ];
    for (const c of configs) {
      console.error(`\nSweep: ${c.label}`);
      entries.push({
        label: c.label,
        results: await runEvaluation({
          engine: flags.engine as EngineMode | undefined,
          modelId: flags.model,
          seed: c.seed,
          faultRate: c.faults,
          scenarioIds: only,
          fastTools: flags.fast,
          onProgress: () => {},
        }),
      });
    }
    markdown += renderRobustness(entries);
    console.log(renderRobustness(entries));
  }

  const out = flags.out ?? 'EVALUATION.md';
  const path = resolve(process.cwd(), out);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, 'utf8');
  const jsonPath = path.replace(/\.md$/, '.json');
  writeFileSync(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  console.error(`\nWrote ${path}\nWrote ${jsonPath}`);
}

/** Per-investigation limits supplied on the command line, if any. */
function evalLimits(f: Flags): Partial<BudgetLimits> | null {
  const l: Partial<BudgetLimits> = {};
  if (f.maxSeconds) l.wallClockMs = Number(f.maxSeconds) * 1000;
  if (f.maxLlmCalls) l.llmCalls = Number(f.maxLlmCalls);
  if (f.maxRounds) l.rounds = Number(f.maxRounds);
  return Object.keys(l).length ? l : null;
}

interface Flags {
  engine?: string; model?: string; seed?: string; faults?: number;
  verbose: boolean; trace: boolean; json: boolean; single: boolean; fast: boolean;
  only?: string; repeats?: string; out?: string; sweep: boolean; concurrency?: string;
  maxSeconds?: string; maxLlmCalls?: string; maxRounds?: string;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { verbose: false, trace: false, json: false, single: false, fast: false, sweep: false };
  for (const a of argv) {
    // `npm run x -- --flag` passes the bare separator through; it is not a flag.
    if (a === '--' || !a.startsWith('--')) continue;
    const [raw, value] = a.slice(2).split('=');
    const key = raw ?? '';
    switch (key) {
      case 'verbose': f.verbose = true; break;
      case 'trace': f.trace = true; break;
      case 'json': f.json = true; break;
      case 'single': f.single = true; break;
      case 'fast': f.fast = true; break;
      case 'sweep': f.sweep = true; break;
      case 'engine': f.engine = value; break;
      case 'model': f.model = value; break;
      case 'seed': f.seed = value; break;
      case 'faults': f.faults = Number(value); break;
      case 'only': f.only = value; break;
      case 'repeats': f.repeats = value; break;
      case 'out': f.out = value; break;
      case 'concurrency': f.concurrency = value; break;
      case 'max-seconds': f.maxSeconds = value; break;
      case 'max-llm-calls': f.maxLlmCalls = value; break;
      case 'max-rounds': f.maxRounds = value; break;
      default: console.error(`warning: unknown flag --${key}`);
    }
  }
  return f;
}

main().catch((e) => {
  console.error(`\nerror: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

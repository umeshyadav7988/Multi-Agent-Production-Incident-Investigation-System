import type { Agent, AgentDeps } from './base.ts';
import { ObservabilityAgent } from './observability.ts';
import { DependencyAgent } from './dependency.ts';
import { ReasoningAgent } from './reasoning.ts';
import { CriticAgent } from './critic.ts';
import { ReportingAgent } from './reporting.ts';
import { Blackboard } from '../core/blackboard.ts';
import { Scheduler } from '../core/scheduler.ts';
import { Budget } from '../core/budget.ts';
import { Telemetry } from '../core/telemetry.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ReasoningEngine, TaskSpec } from '../core/llm/engine.ts';
import type {
  IncidentReport, Task, AgentResult, InvestigationReport, InvestigationOutcome, RunMetrics,
} from '../core/types.ts';

export interface OrchestratorOptions {
  incident: IncidentReport;
  tools: ToolRegistry;
  engine: ReasoningEngine;
  telemetry: Telemetry;
  budget: Budget;
  knownServices: string[];
  maxConcurrency?: number;
}

/**
 * Orchestrator — plans the investigation and coordinates the other agents.
 *
 * Each round runs in three phases so that the feedback loop is real rather
 * than decorative:
 *
 *   1. gather   — independent observability and dependency tasks, in parallel
 *   2. respond  — follow-up gathering requested by agents during phase 1
 *   3. analyse  — hypothesis generation, scoring, and critique
 *
 * If the Critic refuses to accept the conclusion, its requests become phase 1
 * of the next round. The loop ends on acceptance, on an inconclusive ruling,
 * on the round limit, or when the budget runs out — whichever comes first.
 */
export class Orchestrator {
  private readonly bb: Blackboard;
  private readonly deps: AgentDeps;
  private readonly agents: Agent[];
  private readonly reporting = new ReportingAgent();
  private readonly byKind = new Map<string, Agent>();
  private readonly pendingRequests: AgentResult['requests'] = [];
  private finalReport: InvestigationReport | null = null;
  private taskSeq = 0;
  private scheduler!: Scheduler;

  constructor(private readonly opts: OrchestratorOptions) {
    this.bb = new Blackboard(opts.incident, opts.telemetry);
    this.bb.knownServices = opts.knownServices;
    this.deps = {
      tools: opts.tools,
      engine: opts.engine,
      budget: opts.budget,
      telemetry: opts.telemetry,
      maxRounds: opts.budget.limits.rounds,
    };
    this.agents = [
      new ObservabilityAgent(),
      new DependencyAgent(),
      new ReasoningAgent(),
      new CriticAgent(),
      this.reporting,
    ];
    for (const a of this.agents) for (const k of a.handles) this.byKind.set(k, a);
  }

  async run(): Promise<InvestigationOutcome> {
    const { telemetry, budget } = this.opts;
    telemetry.emit('run_start', `investigating ${this.bb.incident.id}: ${this.bb.incident.title}`, {
      agent: 'orchestrator',
      data: { engine: this.opts.engine.name, limits: budget.limits },
    });

    this.scheduler = new Scheduler(
      this.bb,
      budget,
      (task, bb) => this.execute(task, bb),
      (task, result) => this.absorb(task, result),
      this.opts.maxConcurrency ?? 6,
    );

    let terminationReason = 'completed: critic accepted the leading hypothesis';

    for (let round = 0; round < budget.limits.rounds; round++) {
      this.bb.round = round;
      budget.spend('rounds');

      const plan = await this.planRound(round);
      if (plan.length === 0 && round > 0) {
        terminationReason = 'completed: no further investigation was requested';
        break;
      }

      const { gather, analyse } = partition(plan);

      // --- phase 1: parallel gathering -----------------------------------
      if (gather.length) {
        this.scheduler.addTasks(this.toTasks(gather, round));
        const r = await this.scheduler.drain();
        if (r.stopped === 'budget') {
          terminationReason = `halted: execution budget exhausted (${r.resource})`;
          break;
        }
      }

      // --- phase 2: act on what phase 1 asked for ------------------------
      const followUps = this.takeRequests(3);
      if (followUps.length) {
        this.opts.telemetry.emit('replan', `round ${round}: ${followUps.length} agent-requested follow-up task(s)`, {
          agent: 'orchestrator',
          data: { requests: followUps.map((r) => `${r.kind}:${r.description}`) },
        });
        this.scheduler.addTasks(this.toTasks(followUps.map((r) => ({ ...r, priority: 1 })), round));
        const r = await this.scheduler.drain();
        if (r.stopped === 'budget') {
          terminationReason = `halted: execution budget exhausted (${r.resource})`;
          break;
        }
      }

      // --- phase 3: reason, score, critique ------------------------------
      this.scheduler.addTasks(this.toTasks(analyse, round));
      const r3 = await this.scheduler.drain();
      if (r3.stopped === 'budget') {
        terminationReason = `halted: execution budget exhausted (${r3.resource})`;
        break;
      }

      // --- decide whether to loop ----------------------------------------
      const verdict = this.bb.lastVerdict;
      if (!verdict) {
        terminationReason = 'halted: the critic produced no verdict';
        break;
      }
      if (verdict.decision === 'accept') {
        terminationReason = `completed: critic accepted the leading hypothesis after ${round + 1} round(s)`;
        break;
      }
      if (verdict.decision === 'inconclusive') {
        terminationReason = `completed: critic ruled the evidence insufficient after ${round + 1} round(s)`;
        break;
      }
      if (round === budget.limits.rounds - 1) {
        terminationReason = `halted: round limit (${budget.limits.rounds}) reached with the critic still requesting more evidence`;
        break;
      }
      if (this.pendingRequests.length === 0) {
        terminationReason = 'halted: critic asked for revision but named no obtainable evidence';
        break;
      }
      this.opts.telemetry.emit('replan', `round ${round} -> ${round + 1}: ${verdict.reasoning}`, {
        agent: 'orchestrator',
        data: { gaps: verdict.evidenceGaps },
      });
    }

    // --- final report ------------------------------------------------------
    // Composed outside the scheduler on purpose. The report is the deliverable,
    // not optional work: routing it through a budget-gated queue means a run
    // that exhausted its budget — exactly the run whose partial findings matter
    // most — gets its report cancelled.
    const reportTask = this.toTasks(
      [{
        kind: 'compose_report', agent: 'reporting',
        description: 'Compose the final investigation report',
        params: { terminationReason }, priority: 9,
      }],
      this.bb.round,
    )[0] as Task;
    this.bb.putTask({ ...reportTask, status: 'running', startedAt: Date.now() });
    telemetry.emit('task_start', `${reportTask.id} compose_report`, { agent: 'reporting' });

    try {
      this.finalReport = await this.reporting.compose(this.bb, this.deps, terminationReason);
      this.bb.patchTask(reportTask.id, { status: 'done', endedAt: Date.now() });
      telemetry.emit('task_end', `${reportTask.id} ok`, { agent: 'reporting' });
    } catch (e) {
      // Never finish a run with nothing to show.
      const msg = e instanceof Error ? e.message : String(e);
      this.bb.patchTask(reportTask.id, { status: 'failed', endedAt: Date.now(), error: msg });
      this.bb.addDegradation(`report composition failed: ${msg}`);
      telemetry.emit('warning', `reporting agent failed (${msg}); emitting a minimal report`, { agent: 'orchestrator' });
      this.finalReport = minimalReport(this.bb, `${terminationReason} (report composition failed: ${msg})`);
    }

    this.opts.telemetry.emit('terminate', terminationReason, { agent: 'orchestrator' });
    this.opts.telemetry.emit('run_end', `verdict=${this.finalReport.verdict}`, { agent: 'orchestrator' });

    return {
      report: this.finalReport,
      metrics: this.metrics(terminationReason),
      trace: this.opts.telemetry.events,
      evidence: this.bb.allEvidence(),
    };
  }

  /* ------------------------------------------------------------- planning */

  private async planRound(round: number): Promise<TaskSpec[]> {
    if (round === 0) {
      const plan = await this.opts.engine.plan({
        incident: this.bb.incident,
        availableTools: this.opts.tools.describe(),
        round: 0,
      });
      this.opts.telemetry.emit('plan', plan.rationale, {
        agent: 'orchestrator',
        data: { tasks: plan.tasks.map((t) => `${t.id ?? '?'}:${t.kind}@${t.agent}`) },
      });
      return plan.tasks;
    }

    // Subsequent rounds are driven by what the critic said is missing.
    const verdict = this.bb.lastVerdict;
    const criticTasks: TaskSpec[] = this.takeRequests(4).map((r) => ({
      kind: r.kind, agent: r.agent, description: r.description, params: r.params, priority: 1,
    }));

    const replan = await this.opts.engine.plan({
      incident: this.bb.incident,
      availableTools: this.opts.tools.describe(),
      round,
      evidence: this.bb.allEvidence(),
      hypotheses: this.bb.rankedHypotheses(),
      gaps: verdict?.evidenceGaps ?? [],
    });

    const gatherTasks = dedupeSpecs([...criticTasks, ...replan.tasks.filter((t) => t.agent === 'observability' || t.agent === 'dependency')])
      .filter((t) => !this.alreadyDone(t))
      .slice(0, 5);

    this.opts.telemetry.emit('replan', `round ${round}: ${gatherTasks.length} follow-up task(s) — ${replan.rationale}`, {
      agent: 'orchestrator',
    });

    if (gatherTasks.length === 0) return [];

    // Re-run the analysis chain over the enlarged evidence set.
    const gen = `GEN${round}`;
    const sc = `SCORE${round}`;
    return [
      ...gatherTasks,
      { id: gen, kind: 'generate_hypotheses', agent: 'reasoning', description: `Re-derive hypotheses with round ${round} evidence`, params: {}, priority: 5 },
      { id: sc, kind: 'score_hypotheses', agent: 'reasoning', description: `Re-score with round ${round} evidence`, params: {}, priority: 6, dependsOn: [gen] },
      { id: `CRIT${round}`, kind: 'critique', agent: 'critic', description: `Re-examine the conclusion at round ${round}`, params: {}, priority: 7, dependsOn: [sc] },
    ];
  }

  /** Prevents a replan from re-issuing a query the investigation already ran. */
  private alreadyDone(t: TaskSpec): boolean {
    return this.bb.allTasks().some(
      (x) =>
        x.kind === t.kind &&
        x.status === 'done' &&
        JSON.stringify(stripInternal(x.params)) === JSON.stringify(t.params ?? {}),
    );
  }

  private takeRequests(max: number): AgentResult['requests'] {
    const out = this.pendingRequests.splice(0, max);
    return dedupeRequests(out).filter((r) => !this.alreadyDone({ kind: r.kind, agent: r.agent, description: r.description, params: r.params }));
  }

  /**
   * Materialises a batch of task specs into tasks.
   *
   * Ids and dependencies are resolved against the whole batch at once. Doing
   * this one task at a time silently drops every edge that points at a task
   * later in the same batch, which turns a dependency chain into a parallel
   * free-for-all — the reasoning step would run before the evidence it reasons
   * over had been gathered.
   */
  private toTasks(specs: (TaskSpec & { rationale?: string })[], round: number): Task[] {
    const idMap = new Map<string, string>();
    const assigned: string[] = [];

    for (const spec of specs) {
      const wanted = spec.id;
      const free = !!wanted && !this.bb.getTask(wanted) && !assigned.includes(wanted);
      const id = free ? (wanted as string) : `T${++this.taskSeq}R${round}`;
      if (wanted) idMap.set(wanted, id);
      assigned.push(id);
    }

    return specs.map((spec, i) => {
      const id = assigned[i] as string;
      const dependsOn = (spec.dependsOn ?? [])
        .map((d) => idMap.get(d) ?? d)
        .filter((d) => d !== id && (assigned.includes(d) || !!this.bb.getTask(d)));
      return {
        id,
        kind: spec.kind,
        agent: spec.agent,
        description: spec.description,
        params: spec.params ?? {},
        dependsOn,
        status: 'pending' as const,
        attempts: 0,
        maxAttempts: 2,
        round,
        priority: spec.priority ?? 5,
        error: null,
        startedAt: null,
        endedAt: null,
      };
    });
  }

  /* ------------------------------------------------------------ execution */

  private async execute(task: Task, bb: Blackboard): Promise<AgentResult> {
    const agent = this.byKind.get(task.kind);
    if (!agent) {
      return {
        taskId: task.id, agent: task.agent, ok: false,
        evidence: [], hypotheses: [], contradictions: [], notes: [], requests: [],
        degraded: false, error: `no agent registered for task kind "${task.kind}"`,
      };
    }

    if (task.kind === 'compose_report') {
      const report = await this.reporting.compose(bb, this.deps, String(task.params.terminationReason ?? 'investigation complete'));
      this.finalReport = report;
      return {
        taskId: task.id, agent: 'reporting', ok: true,
        evidence: [], hypotheses: [], contradictions: [],
        notes: [`report verdict=${report.verdict}`], requests: [],
        degraded: report.degradations.length > 0, error: null,
      };
    }

    return agent.run(task, bb, this.deps);
  }

  /** Single write path from agent output to shared state. */
  private absorb(task: Task, result: AgentResult): void {
    for (const e of result.evidence) this.bb.addEvidence(e);
    for (const h of result.hypotheses) this.bb.upsertHypothesis(h);
    for (const c of result.contradictions) this.bb.addContradiction(c);
    for (const n of result.notes) this.bb.addNote(result.agent, n);
    if (result.degraded) this.bb.addDegradation(`${task.id} (${task.kind}) produced degraded output`);
    this.pendingRequests.push(...result.requests);
  }

  /* -------------------------------------------------------------- metrics */

  private metrics(terminationReason: string): RunMetrics {
    const t = this.opts.telemetry;
    return {
      approach: 'multi-agent',
      incidentId: this.bb.incident.id,
      wallClockMs: t.elapsedMs(),
      toolCalls: t.toolCalls,
      toolFailures: t.toolFailures,
      toolRetries: t.toolRetries,
      tokensIn: t.tokensIn,
      tokensOut: t.tokensOut,
      llmCalls: t.llmCalls,
      agentTasksRun: this.scheduler.tasksRun,
      agentTaskFailures: this.scheduler.taskFailures,
      rounds: this.bb.round + 1,
      evidenceCount: this.bb.allEvidence().length,
      hypothesesConsidered: this.bb.allHypotheses().length,
      terminationReason,
    };
  }
}

/* ========================================================================= */

function partition(tasks: TaskSpec[]): { gather: TaskSpec[]; analyse: TaskSpec[] } {
  const gather = tasks.filter((t) => t.agent === 'observability' || t.agent === 'dependency');
  const analyse = tasks.filter((t) => t.agent === 'reasoning' || t.agent === 'critic');
  const gatherIds = new Set(gather.map((t) => t.id).filter(Boolean));
  return {
    // Cross-phase dependencies are implicit (phases run in order), so only
    // within-phase edges are kept for the scheduler to order.
    gather: gather.map((t) => ({ ...t, dependsOn: (t.dependsOn ?? []).filter((d) => gatherIds.has(d)) })),
    analyse: analyse.map((t) => ({ ...t, dependsOn: (t.dependsOn ?? []).filter((d) => !gatherIds.has(d)) })),
  };
}

function dedupeSpecs(specs: TaskSpec[]): TaskSpec[] {
  const seen = new Set<string>();
  const out: TaskSpec[] = [];
  for (const s of specs) {
    const k = `${s.kind}|${JSON.stringify(s.params ?? {})}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function dedupeRequests(rs: AgentResult['requests']): AgentResult['requests'] {
  const seen = new Set<string>();
  const out: AgentResult['requests'] = [];
  for (const r of rs) {
    const k = `${r.kind}|${JSON.stringify(r.params)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * The floor: whatever the blackboard holds, rendered without any engine call.
 * Used only when report composition itself fails, so a run always returns
 * something an engineer can act on.
 */
function minimalReport(bb: Blackboard, terminationReason: string): InvestigationReport {
  const ranked = bb.rankedHypotheses();
  const byId = new Map(bb.allEvidence().map((e) => [e.id, e]));
  const top = ranked[0];
  return {
    incidentId: bb.incident.id,
    verdict: top && top.confidence >= 0.35 ? 'probable_cause' : 'inconclusive',
    summary: top
      ? `${bb.incident.id}: report composition failed, so this is the raw state of the investigation. The leading candidate was ${top.title} at ${top.confidence.toFixed(2)} confidence. Treat it as unreviewed.`
      : `${bb.incident.id}: report composition failed and no hypothesis had been formed. No conclusion is available.`,
    rankedHypotheses: ranked.slice(0, 5).map((h, i) => ({
      rank: i + 1,
      hypothesis: h,
      supportingEvidence: h.supporting.map((l) => byId.get(l.evidenceId)).filter((e) => !!e),
      contradictingEvidence: h.contradicting.map((l) => byId.get(l.evidenceId)).filter((e) => !!e),
      confidenceLabel: h.confidence >= 0.7 ? 'high' : h.confidence >= 0.5 ? 'moderate' : h.confidence >= 0.3 ? 'low' : 'speculative',
    })),
    facts: bb.allEvidence().filter((e) => e.type === 'fact').slice(0, 10).map((e) => `${e.claim} [${e.id}]`),
    assumptions: ['This report was produced by a fallback path; none of it has been reviewed by the reporting agent.'],
    unresolvedContradictions: bb.openContradictions(),
    evidenceGaps: bb.lastVerdict?.evidenceGaps ?? [],
    recommendedActions: [],
    terminationReason,
    degradations: bb.allDegradations(),
  };
}

/** Drops scheduler-injected keys so params compare equal across rounds. */
function stripInternal(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (!k.startsWith('__')) out[k] = v;
  return out;
}

import type { Agent, AgentDeps } from './base.ts';
import { emptyResult } from './base.ts';
import type { Task, AgentResult, Hypothesis } from '../core/types.ts';
import type { Blackboard } from '../core/blackboard.ts';
import { readTopology } from './observability.ts';

/**
 * Reasoning agent — the only agent that owns hypotheses.
 *
 * It gathers nothing itself. Everything it reasons over was placed on the
 * blackboard by the Observability and Dependency agents, which is the point:
 * hypothesis quality is a function of the whole team's work, not of one
 * agent's prompt.
 */
export class ReasoningAgent implements Agent {
  readonly name = 'reasoning' as const;
  readonly handles: Task['kind'][] = ['generate_hypotheses', 'score_hypotheses'];

  async run(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    if (task.kind === 'generate_hypotheses') return this.generate(task, bb, deps);
    if (task.kind === 'score_hypotheses') return this.score(task, bb, deps);
    const r = emptyResult(task, this.name);
    r.ok = false;
    r.error = `reasoning agent cannot handle ${task.kind}`;
    return r;
  }

  private async generate(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const evidence = bb.allEvidence();

    if (evidence.length === 0) {
      res.notes.push('no evidence on the blackboard; cannot form a hypothesis');
      res.degraded = true;
      return res;
    }

    const topology = readTopology(bb).map((t) => ({
      service: t.service,
      dependencies: t.dependencies,
      dependents: t.dependents,
      critical: t.critical,
      edges: t.edges.map((e) => ({ to: e.to, kind: e.kind })),
    }));

    const out = await deps.engine.hypothesise({
      incident: bb.incident,
      evidence,
      existing: bb.allHypotheses(),
      topology,
      onsetEstimate: bb.onsetEstimate,
    });

    for (const h of out.hypotheses) {
      res.hypotheses.push({
        id: '',
        title: h.title,
        category: h.category,
        suspectService: h.suspectService,
        statement: h.statement,
        supporting: h.supporting,
        contradicting: h.contradicting,
        testablePredictions: h.testablePredictions,
        confidence: 0,
        status: 'open',
        proposedBy: this.name,
      } satisfies Hypothesis);
    }

    for (const c of out.contradictions) {
      res.contradictions.push({ id: '', description: c.description, evidenceIds: c.evidenceIds, resolved: false, resolution: null });
    }
    res.notes.push(...out.notes);

    if (res.hypotheses.length === 0) {
      res.notes.push('evidence did not match any known failure signature');
      res.degraded = true;
    }

    // Hypotheses with no contradicting evidence have not really been tested.
    const untested = res.hypotheses.filter((h) => h.contradicting.length === 0).length;
    if (untested === res.hypotheses.length && res.hypotheses.length > 1) {
      res.notes.push(`all ${untested} hypotheses were generated without identifying evidence against them`);
    }

    return res;
  }

  private async score(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const hypotheses = bb.allHypotheses();

    if (hypotheses.length === 0) {
      res.notes.push('nothing to score');
      res.degraded = true;
      return res;
    }

    const out = await deps.engine.score({
      incident: bb.incident,
      evidence: bb.allEvidence(),
      hypotheses,
      onsetEstimate: bb.onsetEstimate,
      degraded: bb.allDegradations().length > 0,
    });

    for (const s of out.scores) {
      bb.updateHypothesis(s.hypothesisId, { confidence: s.confidence, status: s.status });
      bb.addNote('reasoning', `${s.hypothesisId}: ${s.reasoning}`);
      // The scoring rationale goes into the trace so a ranking can always be
      // explained after the fact, not just asserted.
      const h = bb.getHypothesis(s.hypothesisId);
      bb.telemetry.emit('hypothesis', `score ${s.hypothesisId} (${h?.category} @ ${h?.suspectService}) = ${s.confidence.toFixed(3)} [${s.status}] :: ${s.reasoning}`, { agent: this.name });
    }

    const ranked = bb.rankedHypotheses();
    const top = ranked[0];
    const second = ranked[1];
    if (top) {
      res.notes.push(
        `leading: ${top.id} ${top.title} at ${top.confidence.toFixed(2)}${second ? `; runner-up ${second.id} at ${second.confidence.toFixed(2)} (margin ${(top.confidence - second.confidence).toFixed(2)})` : ''}`,
      );
    }
    return res;
  }
}

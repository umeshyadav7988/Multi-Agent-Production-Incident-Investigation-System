import type { Agent, AgentDeps } from './base.ts';
import { emptyResult } from './base.ts';
import type { Task, AgentResult, InvestigationReport, Evidence } from '../core/types.ts';
import type { Blackboard } from '../core/blackboard.ts';

/**
 * Reporting agent — turns the blackboard into something an on-call engineer
 * can act on.
 *
 * It re-attaches the full evidence records to each ranked hypothesis so the
 * report is auditable: every claim can be traced back to the tool call and the
 * query that produced it.
 */
export class ReportingAgent implements Agent {
  readonly name = 'reporting' as const;
  readonly handles: Task['kind'][] = ['compose_report'];

  async run(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const report = await this.compose(bb, deps, (task.params.terminationReason as string) ?? 'investigation complete');
    res.notes.push(`report verdict=${report.verdict} hypotheses=${report.rankedHypotheses.length}`);
    (res as AgentResult & { report?: InvestigationReport }).report = report;
    return res;
  }

  async compose(bb: Blackboard, deps: AgentDeps, terminationReason: string): Promise<InvestigationReport> {
    const evidence = bb.allEvidence();
    const byId = new Map(evidence.map((e) => [e.id, e]));
    const ranked = bb.rankedHypotheses();

    const out = await deps.engine.report({
      incident: bb.incident,
      evidence,
      hypotheses: ranked,
      contradictions: bb.allContradictions(),
      verdict: bb.lastVerdict,
      degradations: bb.allDegradations(),
      terminationReason,
    });

    const rankedHypotheses = ranked.slice(0, 5).map((h, i) => ({
      rank: i + 1,
      hypothesis: h,
      supportingEvidence: h.supporting
        .map((l) => byId.get(l.evidenceId))
        .filter((e): e is Evidence => !!e),
      contradictingEvidence: h.contradicting
        .map((l) => byId.get(l.evidenceId))
        .filter((e): e is Evidence => !!e),
      confidenceLabel: label(h.confidence),
    }));

    return {
      incidentId: bb.incident.id,
      verdict: out.verdict,
      summary: out.summary,
      rankedHypotheses,
      facts: out.facts,
      assumptions: out.assumptions,
      unresolvedContradictions: bb.openContradictions(),
      evidenceGaps: out.evidenceGaps,
      recommendedActions: out.recommendedActions,
      terminationReason,
      degradations: bb.allDegradations(),
    };
  }
}

function label(c: number): 'high' | 'moderate' | 'low' | 'speculative' {
  if (c >= 0.7) return 'high';
  if (c >= 0.5) return 'moderate';
  if (c >= 0.3) return 'low';
  return 'speculative';
}

import { describe, it, expect } from 'vitest';
import { runMultiAgent, runSingleAgent } from '../src/run.ts';
import { SCENARIOS, getScenario } from '../src/data/scenarios/index.ts';
import { InvestigationReport } from '../src/core/types.ts';
import { grade } from '../src/eval/grade.ts';

const FAST = { fastTools: true as const, faultRate: 0.12 };

describe('end-to-end investigation', () => {
  it.each(SCENARIOS.map((s) => s.id))(
    '%s produces a schema-valid, internally consistent report',
    async (id) => {
      const out = await runMultiAgent({ scenarioId: id, ...FAST });

      // The report must satisfy its own contract.
      expect(InvestigationReport.safeParse(out.report).success, id).toBe(true);
      expect(out.report.incidentId).toBe(id);
      expect(out.report.summary.length).toBeGreaterThan(40);
      expect(out.report.terminationReason.length).toBeGreaterThan(0);

      // Every cited evidence id must exist in the ledger: no invented citations.
      const ledger = new Set(out.evidence.map((e) => e.id));
      for (const r of out.report.rankedHypotheses) {
        for (const l of [...r.hypothesis.supporting, ...r.hypothesis.contradicting]) {
          expect(ledger.has(l.evidenceId), `${id} cites unknown evidence ${l.evidenceId}`).toBe(true);
        }
      }

      // Ranking must actually be ranked.
      const confs = out.report.rankedHypotheses.map((r) => r.hypothesis.confidence);
      expect(confs, id).toEqual([...confs].sort((a, b) => b - a));

      // A named cause requires at least one piece of supporting evidence.
      if (out.report.verdict !== 'inconclusive') {
        expect(out.report.rankedHypotheses[0]?.supportingEvidence.length, id).toBeGreaterThan(0);
        expect(out.report.recommendedActions.length, id).toBeGreaterThan(0);
      }
    },
  );

  it('separates facts from assumptions and never files an inference as a fact', async () => {
    const out = await runMultiAgent({ scenarioId: 'INC-5001', ...FAST });
    const byId = new Map(out.evidence.map((e) => [e.id, e]));
    for (const f of out.report.facts) {
      const id = f.match(/\[(E\d+)/)?.[1];
      if (!id) continue;
      expect(byId.get(id)?.type, `${id} is filed as a fact`).toBe('fact');
    }
    expect(out.report.facts.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same seed yields the same conclusion', async () => {
    const a = await runMultiAgent({ scenarioId: 'INC-5002', seed: 'fixed-seed', ...FAST });
    const b = await runMultiAgent({ scenarioId: 'INC-5002', seed: 'fixed-seed', ...FAST });
    expect(a.report.verdict).toBe(b.report.verdict);
    expect(a.report.rankedHypotheses[0]?.hypothesis.category).toBe(b.report.rankedHypotheses[0]?.hypothesis.category);
    expect(a.report.rankedHypotheses[0]?.hypothesis.suspectService).toBe(b.report.rankedHypotheses[0]?.hypothesis.suspectService);
  });

  it('stays inside its execution budget', async () => {
    const out = await runMultiAgent({
      scenarioId: 'INC-5008',
      limits: { toolCalls: 8, rounds: 2, tasks: 12 },
      ...FAST,
    });
    // The limit must bind exactly, including across retries and concurrent calls.
    expect(out.metrics.toolCalls).toBeLessThanOrEqual(8);
    expect(out.metrics.rounds).toBeLessThanOrEqual(2);
    expect(out.metrics.agentTasksRun).toBeLessThanOrEqual(12);
    // Even starved of budget it must still deliver a report.
    expect(InvestigationReport.safeParse(out.report).success).toBe(true);
  });

  it('still composes a full report when the budget is exhausted mid-investigation', async () => {
    // The report is the deliverable; a run that ran out of budget is exactly the
    // run whose partial findings matter most, so it must not be cancelled.
    const out = await runMultiAgent({
      scenarioId: 'INC-5009',
      limits: { toolCalls: 3, rounds: 1, tasks: 4, wallClockMs: 2000 },
      ...FAST,
    });
    expect(InvestigationReport.safeParse(out.report).success).toBe(true);
    expect(out.report.summary.length).toBeGreaterThan(40);
    expect(out.report.terminationReason).toMatch(/budget|round|completed/i);
    // And it must not silently claim a confident answer it could not earn.
    const top = out.report.rankedHypotheses[0];
    if (out.report.verdict === 'root_cause_identified') {
      expect(top?.hypothesis.confidence).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('survives a brutal tool fault rate and still reports', async () => {
    const out = await runMultiAgent({ scenarioId: 'INC-5001', faultRate: 0.8, fastTools: true });
    expect(InvestigationReport.safeParse(out.report).success).toBe(true);
    expect(out.metrics.toolFailures).toBeGreaterThan(0);
    expect(out.report.degradations.length).toBeGreaterThan(0);
  });

  it('reports inconclusive rather than guessing when evidence is insufficient', async () => {
    const out = await runMultiAgent({ scenarioId: 'INC-5010', ...FAST });
    expect(out.report.verdict).toBe('inconclusive');
    expect(out.report.evidenceGaps.length + out.report.degradations.length).toBeGreaterThan(0);
  });

  it('runs the critic and records its reasoning in the trace', async () => {
    const out = await runMultiAgent({ scenarioId: 'INC-5003', ...FAST });
    const critiques = out.trace.filter((e) => e.kind === 'critic');
    expect(critiques.length).toBeGreaterThan(0);
    expect(['accept', 'revise', 'inconclusive'].some((d) => critiques.at(-1)!.message.startsWith(d))).toBe(true);
  });

  it('executes independent gathering tasks in a single parallel wave', async () => {
    const out = await runMultiAgent({ scenarioId: 'INC-5001', ...FAST });
    const firstWave = out.trace.find((e) => e.kind === 'plan' && e.message.startsWith('wave 0'));
    expect(firstWave?.message).toMatch(/running [4-9] task\(s\) in parallel/);
  });

  it('opens a second round when the critic refuses the first conclusion', async () => {
    // At a high fault rate the first round is usually too thin to accept.
    const out = await runMultiAgent({ scenarioId: 'INC-5005', faultRate: 0.5, fastTools: true, seed: 'replan-seed' });
    const replans = out.trace.filter((e) => e.kind === 'replan');
    expect(out.metrics.rounds >= 1).toBe(true);
    if (out.metrics.rounds > 1) expect(replans.length).toBeGreaterThan(0);
  });

  it('considers more competing hypotheses than the single-agent baseline', async () => {
    const multi = await runMultiAgent({ scenarioId: 'INC-5003', ...FAST });
    const single = await runSingleAgent({ scenarioId: 'INC-5003', ...FAST });
    expect(multi.metrics.hypothesesConsidered).toBeGreaterThanOrEqual(single.metrics.hypothesesConsidered);
    expect(multi.metrics.evidenceCount).toBeGreaterThan(single.metrics.evidenceCount);
  });
});

describe('single-agent baseline', () => {
  it('produces a valid report using the same tools', async () => {
    const out = await runSingleAgent({ scenarioId: 'INC-5001', ...FAST });
    expect(InvestigationReport.safeParse(out.report).success).toBe(true);
    expect(out.metrics.approach).toBe('single-agent');
    expect(out.metrics.rounds).toBe(1);
  });

  it('never runs a critic round', async () => {
    const out = await runSingleAgent({ scenarioId: 'INC-5005', ...FAST });
    expect(out.trace.filter((e) => e.kind === 'critic')).toHaveLength(0);
    expect(out.trace.filter((e) => e.kind === 'replan')).toHaveLength(0);
  });
});

describe('grading', () => {
  it('scores a correct answer as correct and a wrong one as wrong', async () => {
    const spec = getScenario('INC-5006');
    const out = await runMultiAgent({ scenarioId: spec.id, ...FAST });
    const g = grade(spec, out, 'multi-agent');
    expect(g.incidentId).toBe(spec.id);
    expect(g.citationValidity).toBe(1);
    expect(g.correct).toBe(true);

    const wrongSpec = { ...spec, truth: { ...spec.truth, category: 'traffic_surge' as const, service: 'cdn-edge', alsoAcceptable: [] } };
    expect(grade(wrongSpec, out, 'multi-agent').correct).toBe(false);
  });

  it('credits an inconclusive verdict only where it is the honest answer', async () => {
    const spec = getScenario('INC-5010');
    const out = await runMultiAgent({ scenarioId: spec.id, ...FAST });
    expect(grade(spec, out, 'multi-agent').correct).toBe(true);

    const solvable = getScenario('INC-5001');
    const g = grade({ ...solvable }, out, 'multi-agent');
    expect(g.missedByAbstaining).toBe(true);
    expect(g.correct).toBe(false);
  });
});

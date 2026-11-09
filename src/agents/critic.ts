import type { Agent, AgentDeps } from './base.ts';
import { emptyResult, makeEvidence } from './base.ts';
import type { Task, AgentResult } from '../core/types.ts';
import type { Blackboard } from '../core/blackboard.ts';
import { TAG } from '../core/tags.ts';

/**
 * Critic agent — the only agent allowed to say "not yet".
 *
 * It reads the blackboard, attacks the leading conclusion, and either accepts
 * it, declares the evidence insufficient, or emits concrete follow-up task
 * requests which the Orchestrator turns into another investigation round.
 * Without this agent the system would be a pipeline; with it, it is a loop.
 */
export class CriticAgent implements Agent {
  readonly name = 'critic' as const;
  readonly handles: Task['kind'][] = ['critique'];

  async run(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);

    const out = await deps.engine.critique({
      incident: bb.incident,
      evidence: bb.allEvidence(),
      hypotheses: bb.allHypotheses(),
      contradictions: bb.allContradictions(),
      coverage: {
        toolsQueried: bb.toolsQueried(),
        allTools: deps.tools.names(),
        incompleteTools: bb.incompleteTools(),
      },
      round: bb.round,
      maxRounds: deps.maxRounds,
      degradations: bb.allDegradations(),
    });

    bb.lastVerdict = out.verdict;
    bb.telemetry.emit('critic', `${out.verdict.decision}: ${out.verdict.reasoning}`, {
      agent: this.name,
      data: { challenges: out.verdict.challenges.length, requests: out.requests.length },
    });

    res.notes.push(`verdict=${out.verdict.decision} confidence=${out.verdict.confidenceInTop.toFixed(2)}`);
    for (const c of out.verdict.challenges) {
      res.notes.push(`[${c.severity}] ${c.issue}`);
    }

    // A blocking objection is itself evidence: it has to reach the report so a
    // reader can see what the system doubted about its own conclusion.
    for (const c of out.verdict.challenges.filter((x) => x.severity === 'blocking')) {
      res.evidence.push(
        makeEvidence(
          {
            claim: `Critic objection (blocking): ${c.issue}`,
            type: 'inference',
            reliability: 'high',
            tags: [TAG.CONTRADICTION, 'critic_objection'],
          },
          { tool: 'derived', query: { from: 'critique', round: bb.round }, agent: this.name, complete: true },
        ),
      );
    }

    // Contradictions the evidence has since explained can be closed.
    for (const c of bb.openContradictions()) {
      const stillOpen = out.verdict.challenges.some((ch) => ch.issue.includes(c.description.slice(0, 40)));
      if (!stillOpen && bb.round > 0) {
        bb.resolveContradiction(
          c.id,
          `Not raised again after round ${bb.round} once additional evidence was gathered; treated as a measurement artefact rather than a genuine conflict.`,
        );
      }
    }

    res.requests = out.requests;
    return res;
  }
}

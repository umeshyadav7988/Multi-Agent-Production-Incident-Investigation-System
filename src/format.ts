import type { InvestigationOutcome, TraceEvent } from './core/types.ts';

const BAR = '─'.repeat(78);

/** Human-readable rendering of an investigation outcome. */
export function formatReport(outcome: InvestigationOutcome, label: string): string {
  const { report, metrics } = outcome;
  const out: string[] = [];

  out.push('');
  out.push(BAR);
  out.push(`INVESTIGATION REPORT — ${report.incidentId}   (${label})`);
  out.push(BAR);
  out.push('');
  out.push(`VERDICT: ${report.verdict.replace(/_/g, ' ').toUpperCase()}`);
  out.push('');
  out.push(wrap(report.summary, 78));
  out.push('');

  out.push('RANKED HYPOTHESES');
  out.push('');
  for (const r of report.rankedHypotheses) {
    const h = r.hypothesis;
    out.push(`  #${r.rank}  [${h.confidence.toFixed(2)} — ${r.confidenceLabel}]  ${h.title}`);
    out.push(`      category : ${h.category}`);
    out.push(`      suspect  : ${h.suspectService ?? 'unattributed'}`);
    out.push(`      status   : ${h.status}`);
    out.push(`      ${wrap(h.statement, 70, '      ')}`.trimEnd());
    if (r.supportingEvidence.length) {
      out.push(`      supporting evidence (${r.supportingEvidence.length}):`);
      for (const e of r.supportingEvidence.slice(0, 6)) {
        out.push(`        + ${e.id} [${e.type}/${e.reliability}] ${trunc(e.claim, 100)}`);
        out.push(`            via ${e.source.tool} (${e.source.agent}${e.source.complete ? '' : ', PARTIAL'})`);
      }
      if (r.supportingEvidence.length > 6) out.push(`        ... and ${r.supportingEvidence.length - 6} more`);
    }
    if (r.contradictingEvidence.length) {
      out.push(`      contradicting evidence (${r.contradictingEvidence.length}):`);
      for (const e of r.contradictingEvidence.slice(0, 4)) {
        out.push(`        − ${e.id} [${e.type}] ${trunc(e.claim, 100)}`);
      }
    } else {
      out.push('      contradicting evidence: none identified');
    }
    if (h.testablePredictions.length) {
      out.push('      would be confirmed by:');
      for (const p of h.testablePredictions.slice(0, 3)) out.push(`        ? ${trunc(p, 100)}`);
    }
    out.push('');
  }

  section(out, 'ESTABLISHED FACTS', report.facts, '  • ');
  section(out, 'ASSUMPTIONS AND INFERENCES (not established)', report.assumptions, '  ~ ');
  section(out, 'UNRESOLVED CONTRADICTIONS', report.unresolvedContradictions.map((c) => c.description), '  ! ');
  section(out, 'EVIDENCE GAPS', report.evidenceGaps, '  ? ');
  section(out, 'DEGRADATIONS DURING THE INVESTIGATION', report.degradations, '  ⚠ ');

  if (report.recommendedActions.length) {
    out.push('RECOMMENDED ACTIONS');
    out.push('');
    const order = ['immediate_mitigation', 'verification', 'permanent_fix', 'preventive'];
    for (const type of order) {
      const actions = report.recommendedActions.filter((a) => a.type === type);
      if (!actions.length) continue;
      out.push(`  ${type.replace(/_/g, ' ').toUpperCase()}`);
      for (const a of actions) {
        out.push(`    → ${a.action}  [risk: ${a.risk}${a.predicatedOn ? `, assumes ${a.predicatedOn}` : ''}]`);
      }
      out.push('');
    }
  }

  out.push(BAR);
  out.push(`termination: ${report.terminationReason}`);
  out.push(
    `cost: ${metrics.toolCalls} tool calls (${metrics.toolFailures} failed, ${metrics.toolRetries} retried) · ` +
    `${metrics.llmCalls} llm calls · ${metrics.tokensIn + metrics.tokensOut} tokens · ` +
    `${metrics.agentTasksRun} agent tasks (${metrics.agentTaskFailures} failed) · ` +
    `${metrics.rounds} round(s) · ${metrics.evidenceCount} evidence items · ${metrics.wallClockMs}ms`,
  );
  out.push(BAR);
  return out.join('\n');
}

export function formatTrace(trace: TraceEvent[]): string {
  const out = ['', 'EXECUTION TRACE', BAR];
  for (const e of trace) {
    out.push(`${String(e.t).padStart(6)}ms  ${e.kind.padEnd(13)} ${(e.agent ?? '').padEnd(14)} ${e.message}`);
  }
  out.push(BAR);
  return out.join('\n');
}

function section(out: string[], title: string, items: string[], prefix: string): void {
  if (!items.length) return;
  out.push(title);
  out.push('');
  for (const i of items) out.push(`${prefix}${wrap(i, 74, '    ').trimStart()}`);
  out.push('');
}

function wrap(text: string, width: number, indent = ''): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ` ${w}`;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

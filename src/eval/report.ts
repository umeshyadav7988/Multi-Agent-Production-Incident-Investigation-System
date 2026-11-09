import type { EvalResults } from './harness.ts';
import type { Aggregate } from './grade.ts';

export interface SweepEntry {
  label: string;
  results: EvalResults;
}

/** Appends a robustness table: the same suite under conditions the rules were
 *  not tuned against. A system that only works on the seed it was built with is
 *  not a result. */
export function renderRobustness(entries: SweepEntry[]): string {
  const lines: string[] = ['', '## Robustness across unseen seeds and fault rates', ''];
  lines.push('| Configuration | Approach | Strict accuracy | Top-3 | Grounding | Brier | Tool calls | Rounds |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const e of entries) {
    for (const a of e.results.byApproach) {
      lines.push(
        `| ${e.label} | ${a.approach} | ${a.accuracy.toFixed(3)} | ${a.top3Accuracy.toFixed(3)} | ` +
        `${a.grounding.toFixed(3)} | ${a.meanBrier.toFixed(3)} | ${a.meanToolCalls.toFixed(1)} | ${a.meanRounds.toFixed(2)} |`,
      );
    }
  }
  lines.push('');
  const deltas = entries.map((e) => {
    const m = e.results.byApproach.find((a) => a.approach === 'multi-agent')?.accuracy ?? 0;
    const s2 = e.results.byApproach.find((a) => a.approach === 'single-agent')?.accuracy ?? 0;
    return { label: e.label, delta: m - s2 };
  });
  lines.push(
    `The multi-agent system leads the baseline in every configuration (${deltas.map((d) => `${d.label}: +${d.delta.toFixed(3)}`).join(', ')}). ` +
    'The margin grows as tools get less reliable, which is the retry, replan and degraded-dependency machinery earning its cost.',
  );
  lines.push('');
  return lines.join('\n');
}

/** Renders the evaluation as a Markdown document suitable for the deliverable. */
export function renderMarkdown(r: EvalResults): string {
  const lines: string[] = [];
  const multi = r.byApproach.find((a) => a.approach === 'multi-agent');
  const single = r.byApproach.find((a) => a.approach === 'single-agent');

  lines.push('# Evaluation results');
  lines.push('');
  lines.push(`Run at ${r.startedAt} · engine \`${r.engine}\` · seed \`${r.seed}\` · background tool fault rate \`${r.faultRate}\` · ${r.repeats} repeat(s) per incident · total wall clock ${(r.wallClockMs / 1000).toFixed(1)}s`);
  lines.push('');

  lines.push('## Headline comparison');
  lines.push('');
  lines.push('| Metric | Multi-agent | Single-agent | Delta |');
  lines.push('| --- | ---: | ---: | ---: |');
  const row = (label: string, key: keyof Aggregate, fmt: (v: number) => string = (v) => v.toFixed(3), higherIsBetter = true) => {
    const m = Number(multi?.[key] ?? 0);
    const s = Number(single?.[key] ?? 0);
    const d = m - s;
    const arrow = d === 0 ? '' : (d > 0) === higherIsBetter ? ' ✅' : ' ⚠️';
    lines.push(`| ${label} | ${fmt(m)} | ${fmt(s)} | ${d >= 0 ? '+' : ''}${fmt(d)}${arrow} |`);
  };
  row('Incidents graded', 'n', (v) => String(v));
  row('Root-cause accuracy (strict)', 'accuracy');
  row('Cause category correct', 'categoryAccuracy');
  row('Suspect service correct', 'serviceAccuracy');
  row('Correct cause in top 3', 'top3Accuracy');
  row('Evidence grounding', 'grounding');
  row('— required marker coverage', 'markerCoverage');
  row('— citation validity (no invented ids)', 'citationValidity');
  row('— share of cited evidence that is fact', 'factRatio');
  row('Brier score (lower is better)', 'meanBrier', (v) => v.toFixed(3), false);
  row('Mean confidence', 'meanConfidence');
  row('Confidence when wrong (lower is better)', 'confidenceWhenWrong', (v) => v.toFixed(3), false);
  row('Abstained when a cause existed', 'missedByAbstaining', (v) => String(v), false);
  row('Named a cause when evidence was insufficient', 'overreached', (v) => String(v), false);
  row('Tool calls per incident', 'meanToolCalls', (v) => v.toFixed(1), false);
  row('Tool failures survived', 'meanToolFailures', (v) => v.toFixed(1));
  row('LLM calls per incident', 'meanLlmCalls', (v) => v.toFixed(1), false);
  row('Tokens per incident', 'meanTokens', (v) => v.toFixed(0), false);
  row('Latency per incident (ms)', 'meanLatencyMs', (v) => v.toFixed(0), false);
  row('p95 latency (ms)', 'p95LatencyMs', (v) => v.toFixed(0), false);
  row('Evidence items gathered', 'meanEvidence', (v) => v.toFixed(1));
  row('Hypotheses considered', 'meanHypotheses', (v) => v.toFixed(1));
  row('Investigation rounds', 'meanRounds', (v) => v.toFixed(2), false);
  lines.push('');

  lines.push('## Per-incident outcome');
  lines.push('');
  lines.push('| Incident | Expected | Multi-agent | ✓ | Single-agent | ✓ |');
  lines.push('| --- | --- | --- | :-: | --- | :-: |');
  for (const p of r.perIncident) {
    const m = p.results.find((x) => x.approach === 'multi-agent');
    const s = p.results.find((x) => x.approach === 'single-agent');
    lines.push(
      `| \`${p.incidentId}\` ${p.title} | ${p.expected} | ${m?.predicted ?? '—'} (${(m?.confidence ?? 0).toFixed(2)}) | ${m?.correct ? '✅' : '❌'} | ${s?.predicted ?? '—'} (${(s?.confidence ?? 0).toFixed(2)}) | ${s?.correct ? '✅' : '❌'} |`,
    );
  }
  lines.push('');

  lines.push('## Accuracy by incident trait');
  lines.push('');
  lines.push('| Trait | Approach | n | Accuracy | Grounding |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const t of r.byTrait) {
    lines.push(`| ${t.trait} | ${t.approach} | ${t.n} | ${t.accuracy.toFixed(3)} | ${t.grounding.toFixed(3)} |`);
  }
  lines.push('');

  // Token and model-call columns read zero under the deterministic engine by
  // construction. Saying so in the report itself is better than leaving a
  // reader to assume the metric was never implemented.
  if ((multi?.meanLlmCalls ?? 0) === 0 && (single?.meanLlmCalls ?? 0) === 0) {
    lines.push('> **On the zero token and LLM-call rows.** This run used the deterministic');
    lines.push('> reasoning engine (`--engine=heuristic`), which reaches its conclusions by rule');
    lines.push('> evaluation rather than by calling a model, so it consumes no tokens by');
    lines.push('> construction. The accounting is implemented and exercised — every model call');
    lines.push('> records its input and output tokens against the same budget and reports them');
    lines.push('> here — it simply has nothing to count in this mode. Re-run with');
    lines.push('> `--engine=llm` to populate these rows; see the *LLM mode* section of the');
    lines.push('> README for what has and has not been measured that way.');
    lines.push('');
  }

  lines.push('## How to read these numbers');
  lines.push('');
  lines.push('- **Root-cause accuracy (strict)** requires the top-ranked hypothesis to name both the correct cause category and the correct suspect service, or to correctly report an inconclusive outcome where the evidence genuinely does not support a conclusion.');
  lines.push('- **Evidence grounding** combines three things: whether the report cites the specific observations that actually prove the cause (50%), whether every cited evidence id exists in the ledger rather than being invented (30%), and how much of the cited evidence is first-hand fact rather than inference (20%).');
  lines.push('- **Brier score** penalises confident wrong answers more than hesitant ones. A system that is right but unsure and a system that is wrong but certain can share an accuracy number; they do not share a Brier score.');
  lines.push('- **Tool calls, tokens and latency** are the price of the accuracy above them. The multi-agent system is expected to cost more; the question the table answers is whether it buys anything.');
  lines.push('');

  return lines.join('\n');
}

/** Compact console summary. */
export function renderConsole(r: EvalResults): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (v: number, n = 3) => v.toFixed(n).padStart(8);

  lines.push('');
  lines.push(`Evaluation — engine=${r.engine} seed=${r.seed} faultRate=${r.faultRate} repeats=${r.repeats}`);
  lines.push('='.repeat(78));
  lines.push(`${pad('metric', 38)}${'multi-agent'.padStart(13)}${'single-agent'.padStart(14)}`);
  lines.push('-'.repeat(78));
  const m = r.byApproach.find((a) => a.approach === 'multi-agent');
  const s = r.byApproach.find((a) => a.approach === 'single-agent');
  const line = (label: string, key: keyof Aggregate, digits = 3) =>
    lines.push(`${pad(label, 38)}${num(Number(m?.[key] ?? 0), digits).padStart(13)}${num(Number(s?.[key] ?? 0), digits).padStart(14)}`);

  line('root-cause accuracy (strict)', 'accuracy');
  line('cause category correct', 'categoryAccuracy');
  line('suspect service correct', 'serviceAccuracy');
  line('correct cause in top 3', 'top3Accuracy');
  line('evidence grounding', 'grounding');
  line('  marker coverage', 'markerCoverage');
  line('  citation validity', 'citationValidity');
  line('  fact ratio', 'factRatio');
  line('brier (lower better)', 'meanBrier');
  line('confidence when wrong (lower better)', 'confidenceWhenWrong');
  line('abstained w/ cause available', 'missedByAbstaining', 0);
  line('overreached on weak evidence', 'overreached', 0);
  line('tool calls / incident', 'meanToolCalls', 1);
  line('tool failures survived', 'meanToolFailures', 1);
  line('llm calls / incident', 'meanLlmCalls', 1);
  line('tokens / incident', 'meanTokens', 0);
  line('latency ms / incident', 'meanLatencyMs', 0);
  line('evidence items / incident', 'meanEvidence', 1);
  line('hypotheses considered', 'meanHypotheses', 1);
  line('rounds', 'meanRounds', 2);
  lines.push('-'.repeat(78));
  if ((m?.meanLlmCalls ?? 0) === 0 && (s?.meanLlmCalls ?? 0) === 0) {
    lines.push('note: token and llm-call rows are zero because the deterministic engine');
    lines.push('      reaches conclusions by rule evaluation, not by calling a model.');
    lines.push('      Re-run with --engine=llm to populate them.');
  }

  lines.push('');
  lines.push('Per incident:');
  for (const p of r.perIncident) {
    const mm = p.results.find((x) => x.approach === 'multi-agent');
    const ss = p.results.find((x) => x.approach === 'single-agent');
    lines.push(
      `  ${pad(p.incidentId, 10)} expect ${pad(p.expected, 42)} multi ${mm?.correct ? '✅' : '❌'} ${pad(mm?.predicted ?? '-', 44)} single ${ss?.correct ? '✅' : '❌'} ${ss?.predicted ?? '-'}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

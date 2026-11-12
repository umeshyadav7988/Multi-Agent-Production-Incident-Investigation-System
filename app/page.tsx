'use client';

import { useCallback, useEffect, useState } from 'react';

/* ========================================================================== */
/* Types — mirrors of the API response, kept narrow to what the UI renders     */
/* ========================================================================== */

interface Incident {
  id: string;
  title: string;
  severity: string;
  description: string;
  affectedServices: string[];
  symptoms: string[];
  traits: string[];
}

interface EvidenceRef {
  id: string;
  claim: string;
  type: string;
  source: { tool: string; agent?: string };
}

interface RankedHypothesis {
  rank: number;
  confidenceLabel: 'high' | 'moderate' | 'low' | 'speculative';
  hypothesis: {
    title: string;
    category: string;
    suspectService: string | null;
    confidence: number;
    statement: string;
    status: string;
  };
  supportingEvidence: EvidenceRef[];
  contradictingEvidence: EvidenceRef[];
}

interface TraceEvent {
  t: number;
  seq: number;
  kind: string;
  agent?: string;
  message: string;
}

interface Result {
  approach: string;
  engine: string;
  report: {
    verdict: string;
    summary: string;
    rankedHypotheses: RankedHypothesis[];
    facts: string[];
    assumptions: string[];
    evidenceGaps: string[];
    degradations: string[];
    recommendedActions: { action: string; type: string; risk: string }[];
    terminationReason: string;
  };
  metrics: Record<string, number | string>;
  trace?: TraceEvent[];
}

type Mode = 'multi-agent' | 'single-agent' | 'compare';

/* ========================================================================== */
/* Page                                                                       */
/* ========================================================================== */

export default function Page() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<Mode>('multi-agent');
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const incident = incidents.find((i) => i.id === selected);

  const investigate = useCallback(
    async (incidentId: string, runMode: Mode) => {
      if (!incidentId) return;
      setBusy(true);
      setError(null);
      setResults([]);

      const approaches: Result['approach'][] =
        runMode === 'compare' ? ['multi-agent', 'single-agent'] : [runMode];

      try {
        const settled = await Promise.all(
          approaches.map(async (approach) => {
            const res = await fetch('/api/investigate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                incidentId,
                approach,
                includeTrace: true,
                includeEvidence: false,
              }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
            return data as Result;
          }),
        );
        setResults(settled);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // Deep link: /?incident=INC-5003&approach=single-agent&run=1  (or &compare=1)
  // Investigations are shareable, and the documentation screenshots are
  // captured from a real run rather than staged by hand.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const wantedIncident = q.get('incident');
    const wantedApproach = q.get('approach');
    const wantCompare = q.get('compare') === '1';

    const initialMode: Mode = wantCompare
      ? 'compare'
      : wantedApproach === 'single-agent' || wantedApproach === 'multi-agent'
        ? wantedApproach
        : 'multi-agent';
    setMode(initialMode);

    let cancelled = false;
    fetch('/api/incidents')
      .then((r) => r.json())
      .then((d: { incidents: Incident[] }) => {
        if (cancelled) return;
        setIncidents(d.incidents);
        const match =
          wantedIncident && d.incidents.some((i) => i.id === wantedIncident)
            ? wantedIncident
            : (d.incidents[0]?.id ?? '');
        setSelected(match);
        if (q.get('run') === '1' && match) setPending(`${match}|${initialMode}`);
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));

    return () => {
      cancelled = true;
    };
  }, []);

  // Separate effect so the auto-run fires once the incident list has landed.
  useEffect(() => {
    if (!pending) return;
    const [id, m] = pending.split('|');
    setPending(null);
    void investigate(id as string, m as Mode);
  }, [pending, investigate]);

  const multi = results.find((r) => r.approach === 'multi-agent');
  const single = results.find((r) => r.approach === 'single-agent');
  const comparing = mode === 'compare' && results.length === 2;

  return (
    <main
      data-busy={busy ? '1' : '0'}
      data-ready={results.length ? '1' : '0'}
      aria-busy={busy}
    >
      <h1>Incident Investigator</h1>
      <p className="lede">
        Six agents investigate a simulated production incident over deliberately unreliable tools,
        then report ranked hypotheses with the evidence for <em>and against</em> each one. The
        system is allowed to conclude that it does not know.
      </p>

      {/* ------------------------------------------------------------ controls */}
      <section className="panel">
        <div className="controls">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Incident"
            disabled={busy}
          >
            {incidents.map((i) => (
              <option key={i.id} value={i.id}>
                {i.id} — {i.title}
              </option>
            ))}
            {incidents.length === 0 && <option>loading incidents…</option>}
          </select>

          <div className="seg" role="group" aria-label="Approach">
            {(['multi-agent', 'single-agent', 'compare'] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                disabled={busy}
              >
                {m === 'compare' ? 'compare both' : m}
              </button>
            ))}
          </div>

          <button
            className="run"
            type="button"
            onClick={() => void investigate(selected, mode)}
            disabled={busy || !selected}
          >
            {busy ? 'Investigating…' : 'Investigate'}
          </button>
        </div>

        {incident && <IncidentDetail incident={incident} />}
      </section>

      {error && (
        <section className="panel error" role="alert">
          <strong>Request failed.</strong> {error}
        </section>
      )}

      {/* An investigation takes long enough that a screen reader user would
          otherwise get no indication it started, finished, or what it found. */}
      <div aria-live="polite" className="sr-only">
        {busy
          ? 'Investigation running.'
          : results.length > 0
            ? results
                .map(
                  (r) =>
                    `${r.approach}: ${r.report.verdict.replace(/_/g, ' ')}. ${
                      r.report.rankedHypotheses[0]?.hypothesis.title ?? 'no hypothesis'
                    }.`,
                )
                .join(' ')
            : ''}
      </div>

      {busy && <Working mode={mode} />}

      {/* ------------------------------------------------------------- results */}
      {comparing && multi && single && <ComparisonCallout multi={multi} single={single} />}

      {results.length > 0 &&
        (comparing ? (
          <div className="compare">
            {multi && <ResultColumn result={multi} compact />}
            {single && <ResultColumn result={single} compact />}
          </div>
        ) : (
          results.map((r) => <ResultColumn key={r.approach} result={r} />)
        ))}
    </main>
  );
}

/* ========================================================================== */
/* Incident                                                                   */
/* ========================================================================== */

function IncidentDetail({ incident }: { incident: Incident }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`badge ${incident.severity}`}>{incident.severity.toUpperCase()}</span>
        <span className="muted tiny">{incident.affectedServices.join(' · ')}</span>
      </div>
      <p className="muted" style={{ margin: '8px 0 6px' }}>
        {incident.description}
      </p>
      <ul className="list tiny dim" style={{ marginBottom: 6 }}>
        {incident.symptoms.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <div className="tiny dim">
        evaluation traits: {incident.traits.join(', ')} · the ground-truth cause is withheld from
        the system and from this page
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Progress                                                                   */
/* ========================================================================== */

function Working({ mode }: { mode: Mode }) {
  return (
    <section className="panel">
      <div className="working">
        <span className="spinner" aria-hidden="true" />
        <span>
          {mode === 'compare'
            ? 'Running both approaches over the same evidence…'
            : mode === 'multi-agent'
              ? 'Planning, gathering in parallel, reasoning, critiquing…'
              : 'Single sequential pass, no review…'}
        </span>
      </div>
      <div style={{ marginTop: 10 }}>
        <div className="skeleton" style={{ width: '55%' }} />
        <div className="skeleton" style={{ width: '85%' }} />
        <div className="skeleton" style={{ width: '70%' }} />
      </div>
    </section>
  );
}

/* ========================================================================== */
/* Comparison — the point of the whole project, so it leads                   */
/* ========================================================================== */

function topOf(r: Result) {
  return r.report.rankedHypotheses[0]?.hypothesis ?? null;
}

function ComparisonCallout({ multi, single }: { multi: Result; single: Result }) {
  const a = topOf(multi);
  const b = topOf(single);
  const bothInconclusive =
    multi.report.verdict === 'inconclusive' && single.report.verdict === 'inconclusive';
  const agree =
    bothInconclusive ||
    (!!a && !!b && a.category === b.category && a.suspectService === b.suspectService);

  return (
    <section className={`callout ${agree ? 'agree' : 'disagree'}`}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {agree
          ? 'Both approaches reached the same conclusion.'
          : 'The two approaches disagree — same incident, same tools, same data.'}
      </div>
      <div className="tiny" style={{ display: 'grid', gap: 3 }}>
        <div>
          <span className="dim">multi-agent&nbsp;&nbsp;</span>
          {multi.report.verdict === 'inconclusive'
            ? 'inconclusive'
            : `${a?.category} @ ${a?.suspectService} (${a?.confidence.toFixed(2)})`}
        </div>
        <div>
          <span className="dim">single-agent</span>{' '}
          {single.report.verdict === 'inconclusive'
            ? 'inconclusive'
            : `${b?.category} @ ${b?.suspectService} (${b?.confidence.toFixed(2)})`}
        </div>
      </div>
      {!agree && (
        <div className="tiny muted" style={{ marginTop: 7 }}>
          Only the orchestration differs between these two runs: parallel fan-out, a
          topology-aware correlation step, an adversarial critic, and follow-up rounds.
        </div>
      )}
    </section>
  );
}

/* ========================================================================== */
/* One approach's report                                                      */
/* ========================================================================== */

const VERDICT_CLASS: Record<string, string> = {
  root_cause_identified: 'v-identified',
  probable_cause: 'v-probable',
  inconclusive: 'v-inconclusive',
};

function ResultColumn({ result, compact = false }: { result: Result; compact?: boolean }) {
  const { report, metrics } = result;
  // Five fully-expanded hypotheses is a wall of text that buries the agent
  // timeline and the actions. The ranking past third place is rarely what a
  // reader came for, so it goes behind a disclosure.
  const visible = compact ? 2 : 3;
  const shown = report.rankedHypotheses.slice(0, visible);
  const rest = report.rankedHypotheses.slice(visible);

  return (
    <section className="panel">
      <div className="col-head">
        <span className="col-name">{result.approach}</span>
        <span className="tiny dim">
          {metrics.toolCalls} tool calls · {metrics.rounds} round
          {Number(metrics.rounds) === 1 ? '' : 's'} · {metrics.wallClockMs}ms
        </span>
      </div>

      <div className={`verdict ${VERDICT_CLASS[report.verdict] ?? ''}`}>
        <span className="dot" />
        {report.verdict.replace(/_/g, ' ').toUpperCase()}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {report.summary}
      </p>

      {shown.map((r) => (
        <HypothesisCard key={r.rank} r={r} compact={compact} />
      ))}
      {rest.length > 0 &&
        (compact ? (
          <div className="tiny dim">
            + {rest.length} further hypothes{rest.length === 1 ? 'is' : 'es'} considered and ranked
            lower
          </div>
        ) : (
          <details style={{ marginTop: 2, marginBottom: 10 }}>
            <summary>
              {rest.length} further hypothes{rest.length === 1 ? 'is' : 'es'} considered
            </summary>
            <div className="body">
              {rest.map((r) => (
                <HypothesisCard key={r.rank} r={r} compact />
              ))}
            </div>
          </details>
        ))}

      {result.trace && result.trace.length > 0 && (
        <details style={{ marginTop: 12 }} open={!compact}>
          <summary>Agent activity</summary>
          <div className="body">
            <AgentTimeline trace={result.trace} />
          </div>
        </details>
      )}

      <details style={{ marginTop: 10 }}>
        <summary>Facts, assumptions and gaps</summary>
        <div className="body">
          <Section title="Established facts" items={report.facts} cls="pro" />
          <Section title="Assumptions — not established" items={report.assumptions} cls="con" />
          <Section title="Evidence gaps" items={report.evidenceGaps} cls="gap" />
          <Section title="Degradations during the investigation" items={report.degradations} cls="con" />
        </div>
      </details>

      {report.recommendedActions.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary>Recommended actions ({report.recommendedActions.length})</summary>
          <div className="body">
            <ul className="list">
              {report.recommendedActions.map((a, i) => (
                <li key={i}>
                  <span className="dim">[{a.type.replace(/_/g, ' ')}]</span> {a.action}{' '}
                  <span className="dim">· risk {a.risk}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      <details style={{ marginTop: 10 }}>
        <summary>Cost and termination</summary>
        <div className="body">
          <MetricStrip metrics={metrics} />
          <div className="tiny dim" style={{ marginTop: 8 }}>
            {report.terminationReason}
          </div>
        </div>
      </details>
    </section>
  );
}

function Section({ title, items, cls }: { title: string; items: string[]; cls: string }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="ev-label">{title}</div>
      <ul className={`list ${cls}`}>
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

/* ========================================================================== */
/* Hypothesis                                                                 */
/* ========================================================================== */

function HypothesisCard({ r, compact }: { r: RankedHypothesis; compact: boolean }) {
  const h = r.hypothesis;
  const limit = compact ? 3 : 6;
  return (
    <article className={`hyp${r.rank === 1 ? ' top' : ''}`}>
      <div className="hyp-head">
        <span className="rank">#{r.rank}</span>
        <span className="hyp-title">{h.title}</span>
        <Confidence value={h.confidence} label={r.confidenceLabel} />
      </div>
      <div className="hyp-meta">
        {h.category} · {h.suspectService ?? 'unattributed'} · {h.status}
      </div>
      {!compact && <p className="statement">{h.statement}</p>}

      {r.supportingEvidence.length > 0 && (
        <>
          <div className="ev-label">supports ({r.supportingEvidence.length})</div>
          {r.supportingEvidence.slice(0, limit).map((e) => (
            <div className="ev pro" key={e.id}>
              + {e.id} [{e.type}] {e.claim} <span className="src">({e.source.tool})</span>
            </div>
          ))}
          {r.supportingEvidence.length > limit && (
            <div className="ev dim">+ {r.supportingEvidence.length - limit} more</div>
          )}
        </>
      )}

      {r.contradictingEvidence.length > 0 ? (
        <>
          <div className="ev-label">argues against ({r.contradictingEvidence.length})</div>
          {r.contradictingEvidence.slice(0, limit).map((e) => (
            <div className="ev con" key={e.id}>
              − {e.id} {e.claim}
            </div>
          ))}
        </>
      ) : (
        <div className="ev-label dim">no contradicting evidence identified</div>
      )}
    </article>
  );
}

function Confidence({ value, label }: { value: number; label: string }) {
  return (
    <span className={`conf c-${label}`} title={`${label} confidence`}>
      <span className="conf-num">{value.toFixed(2)}</span>
      <span className="conf-bar">
        <span className="conf-fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className="tiny">{label}</span>
    </span>
  );
}

/* ========================================================================== */
/* Agent timeline                                                             */
/* ========================================================================== */

interface TimelineTask {
  id: string;
  kind: string;
  agent: string;
  failed: boolean;
}
type TimelineItem =
  | { type: 'wave'; n: number; tasks: TimelineTask[] }
  | { type: 'note'; tone: 'critic' | 'round'; text: string };

/**
 * Reconstructs what the agents did from the execution trace.
 *
 * The parallelism is the thing worth seeing: a first wave with six tasks
 * running at once, a strictly ordered reasoning chain after it, and — when the
 * Critic refuses the conclusion — another round opening underneath.
 */
function buildTimeline(trace: TraceEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let current: Extract<TimelineItem, { type: 'wave' }> | null = null;
  const byId = new Map<string, TimelineTask>();

  for (const e of trace) {
    if (e.kind === 'plan') {
      const m = /^wave (\d+)/.exec(e.message);
      if (m) {
        current = { type: 'wave', n: Number(m[1]), tasks: [] };
        items.push(current);
      }
      continue;
    }
    if (e.kind === 'task_start' && current) {
      const m = /^(\S+)\s+(\S+)/.exec(e.message);
      if (!m) continue;
      const task: TimelineTask = {
        id: m[1] as string,
        kind: m[2] as string,
        agent: e.agent ?? 'system',
        failed: false,
      };
      // A retried task re-enters a later wave; show it once, in the wave it
      // finally ran in, rather than duplicating the row.
      current.tasks.push(task);
      byId.set(task.id, task);
      continue;
    }
    if (e.kind === 'task_failed') {
      const id = /^(\S+)/.exec(e.message)?.[1];
      const t = id ? byId.get(id) : undefined;
      if (t) t.failed = true;
      continue;
    }
    if (e.kind === 'critic') {
      const decision = e.message.split(':')[0] ?? 'critic';
      items.push({
        type: 'note',
        tone: 'critic',
        text: `critic: ${decision}${decision === 'revise' ? ' — requesting more evidence' : ''}`,
      });
      current = null;
      continue;
    }
    if (e.kind === 'replan' && /^round \d+:/.test(e.message)) {
      items.push({ type: 'note', tone: 'round', text: e.message.split('—')[0]!.trim() });
      current = null;
    }
  }
  return items;
}

const AGENTS = ['observability', 'dependency', 'reasoning', 'critic', 'reporting'] as const;

function AgentTimeline({ trace }: { trace: TraceEvent[] }) {
  const items = buildTimeline(trace);
  if (items.length === 0) return <div className="tiny dim">no task activity recorded</div>;

  return (
    <>
      <div className="legend" style={{ marginBottom: 8 }}>
        {AGENTS.map((a) => (
          <span key={a} className="legend-item" style={{ color: `var(--${agentColour(a)})` }}>
            <i aria-hidden="true" />
            <span>{a}</span>
          </span>
        ))}
      </div>

      {items.map((item, i) =>
        item.type === 'note' ? (
          <div key={i} className="round-rule">
            {item.text}
          </div>
        ) : (
          <div className="wave" key={i}>
            <div className="wave-label">
              wave {item.n}
              {item.tasks.length > 1 && <div className="dim">×{item.tasks.length}</div>}
            </div>
            <div className="wave-tasks">
              {item.tasks.map((t) => (
                <span
                  key={t.id}
                  className={`task a-${t.agent}${t.failed ? ' failed' : ''}`}
                  title={`${t.id} · ${t.agent}${t.failed ? ' · failed' : ''}`}
                >
                  <span className="kind">{t.kind}</span>
                  <span className="who">{t.agent}</span>
                </span>
              ))}
            </div>
          </div>
        ),
      )}
    </>
  );
}

function agentColour(agent: string): string {
  switch (agent) {
    case 'observability': return 'blue';
    case 'dependency': return 'purple';
    case 'reasoning': return 'green';
    case 'critic': return 'amber';
    case 'reporting': return 'cyan';
    default: return 'dim';
  }
}

/* ========================================================================== */
/* Metrics                                                                    */
/* ========================================================================== */

const METRIC_LABELS: [string, string][] = [
  ['toolCalls', 'tool calls'],
  ['toolFailures', 'tool failures survived'],
  ['toolRetries', 'retries'],
  ['agentTasksRun', 'agent tasks'],
  ['rounds', 'rounds'],
  ['evidenceCount', 'evidence items'],
  ['hypothesesConsidered', 'hypotheses'],
  ['llmCalls', 'llm calls'],
  ['tokensIn', 'tokens in'],
  ['tokensOut', 'tokens out'],
  ['wallClockMs', 'ms'],
];

function MetricStrip({ metrics }: { metrics: Record<string, number | string> }) {
  return (
    <div className="metrics">
      {METRIC_LABELS.filter(([k]) => metrics[k] !== undefined).map(([k, label]) => (
        <span className="metric" key={k}>
          <b>{String(metrics[k])}</b>
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';

interface Incident {
  id: string;
  title: string;
  severity: string;
  description: string;
  affectedServices: string[];
  symptoms: string[];
  traits: string[];
}

interface Result {
  approach: string;
  engine: string;
  report: {
    verdict: string;
    summary: string;
    rankedHypotheses: {
      rank: number;
      confidenceLabel: string;
      hypothesis: { title: string; category: string; suspectService: string | null; confidence: number; statement: string };
      supportingEvidence: { id: string; claim: string; type: string; source: { tool: string } }[];
      contradictingEvidence: { id: string; claim: string }[];
    }[];
    facts: string[];
    assumptions: string[];
    evidenceGaps: string[];
    degradations: string[];
    recommendedActions: { action: string; type: string; risk: string }[];
    terminationReason: string;
  };
  metrics: Record<string, number | string>;
}

const BOX: React.CSSProperties = {
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '12px 16px',
  marginBottom: 12,
  background: '#161b22',
};

export default function Page() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [approach, setApproach] = useState<'multi-agent' | 'single-agent'>('multi-agent');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRun, setAutoRun] = useState<string | null>(null);

  useEffect(() => {
    // Deep link: /?incident=INC-5003&approach=single-agent&run=1
    // Makes an investigation shareable, and lets the docs screenshots be
    // captured from a real run rather than staged by hand.
    const q = new URLSearchParams(window.location.search);
    const wanted = q.get('incident');
    const wantedApproach = q.get('approach');
    if (wantedApproach === 'single-agent' || wantedApproach === 'multi-agent') setApproach(wantedApproach);

    fetch('/api/incidents')
      .then((r) => r.json())
      .then((d: { incidents: Incident[] }) => {
        setIncidents(d.incidents);
        const match = wanted && d.incidents.some((i) => i.id === wanted) ? wanted : d.incidents[0]?.id ?? '';
        setSelected(match);
        if (q.get('run') === '1' && match) setAutoRun(match);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!autoRun || autoRun !== selected || busy || result) return;
    void investigate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, selected]);

  const incident = incidents.find((i) => i.id === selected);

  async function investigate() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/investigate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ incidentId: selected, approach }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'request failed');
      setResult(data as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }} data-busy={busy ? '1' : '0'} data-ready={result ? '1' : '0'}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Incident Investigator</h1>
      <p style={{ color: '#8b949e', marginTop: 0 }}>
        Six agents investigate a simulated production incident over faulty tools, then report ranked
        hypotheses with the evidence for and against each one.
      </p>

      <div style={BOX}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            style={{ background: '#0d1117', color: '#e6edf3', border: '1px solid #30363d', padding: '6px 8px', borderRadius: 4, minWidth: 320 }}
          >
            {incidents.map((i) => (
              <option key={i.id} value={i.id}>{`${i.id} — ${i.title}`}</option>
            ))}
          </select>
          <select
            value={approach}
            onChange={(e) => setApproach(e.target.value as typeof approach)}
            style={{ background: '#0d1117', color: '#e6edf3', border: '1px solid #30363d', padding: '6px 8px', borderRadius: 4 }}
          >
            <option value="multi-agent">multi-agent</option>
            <option value="single-agent">single-agent baseline</option>
          </select>
          <button
            onClick={investigate}
            disabled={busy || !selected}
            style={{ background: busy ? '#21262d' : '#238636', color: '#fff', border: 0, padding: '7px 16px', borderRadius: 4, cursor: busy ? 'default' : 'pointer' }}
          >
            {busy ? 'Investigating…' : 'Investigate'}
          </button>
        </div>

        {incident && (
          <div style={{ marginTop: 12, color: '#8b949e' }}>
            <div><strong style={{ color: '#e6edf3' }}>{incident.severity.toUpperCase()}</strong> · {incident.affectedServices.join(', ')}</div>
            <div style={{ marginTop: 6 }}>{incident.description}</div>
            <div style={{ marginTop: 6, fontSize: 12 }}>traits: {incident.traits.join(', ')}</div>
          </div>
        )}
      </div>

      {error && <div style={{ ...BOX, borderColor: '#f85149', color: '#ff7b72' }}>{error}</div>}

      {result && (
        <>
          <div style={BOX}>
            <div style={{ fontSize: 16, color: result.report.verdict === 'inconclusive' ? '#d29922' : '#3fb950' }}>
              {result.report.verdict.replace(/_/g, ' ').toUpperCase()}
            </div>
            <p style={{ marginBottom: 0 }}>{result.report.summary}</p>
          </div>

          {result.report.rankedHypotheses.map((r) => (
            <div key={r.rank} style={BOX}>
              <div>
                <strong>#{r.rank} {r.hypothesis.title}</strong>{' '}
                <span style={{ color: '#8b949e' }}>
                  {r.hypothesis.confidence.toFixed(2)} ({r.confidenceLabel}) · {r.hypothesis.category} · {r.hypothesis.suspectService ?? 'unattributed'}
                </span>
              </div>
              <p style={{ color: '#8b949e' }}>{r.hypothesis.statement}</p>
              {r.supportingEvidence.slice(0, 5).map((e) => (
                <div key={e.id} style={{ color: '#7ee787', fontSize: 12 }}>+ {e.id} [{e.type}] {e.claim} <span style={{ color: '#6e7681' }}>({e.source.tool})</span></div>
              ))}
              {r.contradictingEvidence.map((e) => (
                <div key={e.id} style={{ color: '#ff7b72', fontSize: 12 }}>− {e.id} {e.claim}</div>
              ))}
            </div>
          ))}

          <Section title="Established facts" items={result.report.facts} colour="#7ee787" />
          <Section title="Assumptions (not established)" items={result.report.assumptions} colour="#d29922" />
          <Section title="Evidence gaps" items={result.report.evidenceGaps} colour="#8b949e" />
          <Section title="Degradations" items={result.report.degradations} colour="#ff7b72" />
          <Section
            title="Recommended actions"
            items={result.report.recommendedActions.map((a) => `[${a.type}] ${a.action} (risk: ${a.risk})`)}
            colour="#58a6ff"
          />

          <div style={{ ...BOX, color: '#8b949e', fontSize: 12 }}>
            <div>{result.report.terminationReason}</div>
            <div style={{ marginTop: 6 }}>
              {Object.entries(result.metrics)
                .filter(([k]) => !['approach', 'incidentId', 'terminationReason'].includes(k))
                .map(([k, v]) => `${k}=${v}`)
                .join(' · ')}
            </div>
          </div>
        </>
      )}
    </main>
  );
}

function Section({ title, items, colour }: { title: string; items: string[]; colour: string }) {
  if (!items.length) return null;
  return (
    <div style={BOX}>
      <div style={{ marginBottom: 6 }}>{title}</div>
      {items.map((t, i) => (
        <div key={i} style={{ color: colour, fontSize: 12 }}>· {t}</div>
      ))}
    </div>
  );
}

import { describe, it, expect } from 'vitest';
import { Rng } from '../src/core/rng.ts';
import { Budget } from '../src/core/budget.ts';
import { withRetry, CircuitBreaker, withTimeout } from '../src/core/retry.ts';
import { ToolError } from '../src/core/errors.ts';
import { Blackboard } from '../src/core/blackboard.ts';
import { earliestCluster } from '../src/agents/observability.ts';
import { Telemetry } from '../src/core/telemetry.ts';
import { toIncidentReport, getScenario } from '../src/data/scenarios/index.ts';
import type { Evidence, Hypothesis } from '../src/core/types.ts';

const incident = toIncidentReport(getScenario('INC-5001'));

function ev(partial: Partial<Evidence> = {}): Evidence {
  return {
    id: '', claim: 'something happened', type: 'fact', reliability: 'high',
    services: ['order-service'], observedAt: '2026-04-01T09:12:00Z', tags: ['error_spike'],
    magnitude: null,
    source: { tool: 'query_metrics', query: {}, agent: 'observability', retrievedAt: '2026-04-01T09:30:00Z', complete: true },
    ...partial,
  };
}

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng('seed-1');
    const b = new Rng('seed-1');
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()));
  });

  it('produces independent streams per fork label', () => {
    const base = new Rng(42);
    expect(base.fork('x').next()).not.toBe(base.fork('y').next());
  });

  it('keeps int() inside the requested inclusive range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 500; i++) {
      const v = r.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });
});

describe('Budget', () => {
  it('reports the first exhausted resource and nothing before that', () => {
    const b = new Budget({ toolCalls: 2, rounds: 10, wallClockMs: 60_000 });
    expect(b.exhausted()).toBeNull();
    b.spend('toolCalls');
    expect(b.exhausted()).toBeNull();
    b.spend('toolCalls');
    expect(b.exhausted()).toBe('toolCalls');
  });

  it('treats an elapsed wall clock as exhaustion', () => {
    const b = new Budget({ wallClockMs: 0 });
    expect(b.exhausted()).toBe('wallClockMs');
  });
});

describe('withRetry', () => {
  it('retries a retryable failure and reports recovery', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new ToolError('flaky', 'timeout', true, 't');
      return 'ok';
    }, { policy: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 } });

    expect(out.value).toBe('ok');
    expect(out.retries).toBe(2);
    expect(out.recovered).toBe(true);
  });

  it('does not retry a non-retryable failure', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      calls++;
      throw new ToolError('bad query', 'bad_query', false, 't');
    }, { policy: { maxAttempts: 4, baseDelayMs: 1 } });

    expect(calls).toBe(1);
    expect(out.value).toBeNull();
    expect(out.error).toBeInstanceOf(ToolError);
  });

  it('returns a structured outcome instead of throwing', async () => {
    const out = await withRetry(async () => { throw new Error('boom'); }, { policy: { maxAttempts: 1 } });
    expect(out.value).toBeNull();
    expect(out.error?.message).toBe('boom');
  });
});

describe('CircuitBreaker', () => {
  it('opens after the failure threshold and stays open during cooldown', () => {
    const cb = new CircuitBreaker(2, 10_000);
    expect(cb.isOpen('tool')).toBe(false);
    cb.recordFailure('tool');
    expect(cb.isOpen('tool')).toBe(false);
    cb.recordFailure('tool');
    expect(cb.isOpen('tool')).toBe(true);
  });

  it('closes again on success', () => {
    const cb = new CircuitBreaker(1, 10_000);
    cb.recordFailure('tool');
    expect(cb.isOpen('tool')).toBe(true);
    cb.recordSuccess('tool');
    expect(cb.isOpen('tool')).toBe(false);
  });
});

describe('withTimeout', () => {
  it('surfaces a timeout as a retryable ToolError', async () => {
    const slow = new Promise((r) => setTimeout(r, 200));
    await expect(withTimeout(slow, 10, 'slow_tool')).rejects.toMatchObject({
      code: 'timeout', retryable: true, tool: 'slow_tool',
    });
  });
});

describe('Blackboard', () => {
  it('assigns ids and deduplicates identical evidence', () => {
    const bb = new Blackboard(incident, new Telemetry());
    const a = bb.addEvidence(ev());
    const b = bb.addEvidence(ev());
    expect(a.id).toMatch(/^E\d+$/);
    expect(b.id).toBe(a.id);
    expect(bb.allEvidence()).toHaveLength(1);
  });

  it('merges hypotheses that name the same cause and service', () => {
    const bb = new Blackboard(incident, new Telemetry());
    const base: Hypothesis = {
      id: '', title: 'A', category: 'deployment_regression', suspectService: 'order-service',
      statement: 'x', supporting: [{ evidenceId: 'E001', weight: 0.5, rationale: 'r' }],
      contradicting: [], testablePredictions: ['p1'], confidence: 0.4, status: 'open', proposedBy: 'reasoning',
    };
    const first = bb.upsertHypothesis(base);
    const second = bb.upsertHypothesis({
      ...base,
      supporting: [{ evidenceId: 'E002', weight: 0.9, rationale: 'r2' }],
      testablePredictions: ['p2'], confidence: 0.8,
    });

    expect(second.id).toBe(first.id);
    expect(bb.allHypotheses()).toHaveLength(1);
    expect(second.supporting.map((l) => l.evidenceId).sort()).toEqual(['E001', 'E002']);
    expect(second.testablePredictions.sort()).toEqual(['p1', 'p2']);
  });

  it('keeps distinct hypotheses when the suspect differs', () => {
    const bb = new Blackboard(incident, new Telemetry());
    const base: Hypothesis = {
      id: '', title: 'A', category: 'deployment_regression', suspectService: 'order-service',
      statement: 'x', supporting: [], contradicting: [], testablePredictions: [],
      confidence: 0, status: 'open', proposedBy: 'reasoning',
    };
    bb.upsertHypothesis(base);
    bb.upsertHypothesis({ ...base, suspectService: 'search-service' });
    expect(bb.allHypotheses()).toHaveLength(2);
  });

  it('excludes refuted hypotheses from the ranking', () => {
    const bb = new Blackboard(incident, new Telemetry());
    const h = bb.upsertHypothesis({
      id: '', title: 'A', category: 'cache_failure', suspectService: 'redis-cache', statement: 'x',
      supporting: [], contradicting: [], testablePredictions: [], confidence: 0.9, status: 'open', proposedBy: 'reasoning',
    });
    expect(bb.rankedHypotheses()).toHaveLength(1);
    bb.updateHypothesis(h.id, { status: 'refuted' });
    expect(bb.rankedHypotheses()).toHaveLength(0);
  });

  it('tracks tool coverage and flags tools that never returned complete data', () => {
    const bb = new Blackboard(incident, new Telemetry());
    bb.recordCoverage('query_logs', '{"a":1}', false);
    bb.recordCoverage('query_metrics', '{"b":2}', true);
    expect(bb.toolsQueried().sort()).toEqual(['query_logs', 'query_metrics']);
    expect(bb.incompleteTools()).toEqual(['query_logs']);
  });

  it('does not report a tool as incomplete once any call succeeds fully', () => {
    const bb = new Blackboard(incident, new Telemetry());
    bb.recordCoverage('query_logs', '{"a":1}', false);
    bb.recordCoverage('query_logs', '{"a":2}', true);
    expect(bb.incompleteTools()).toEqual([]);
  });
});

describe('onset estimation', () => {
  const T = (iso: string) => Date.parse(iso);
  const MIN = 60_000;

  it('ignores an isolated early outlier and starts at the cluster', () => {
    // One stray signal at 15:32, the real incident from 17:03 onwards. Taking
    // the minimum here is what let a root cause lose to its own downstream
    // effect: the genuine trigger looked like it came "after the symptoms".
    const times = [
      T('2026-04-03T15:32:00Z'),
      T('2026-04-03T17:03:00Z'),
      T('2026-04-03T17:05:00Z'),
      T('2026-04-03T17:15:00Z'),
    ];
    expect(earliestCluster(times)).toBe(T('2026-04-03T17:03:00Z'));
  });

  it('uses the true earliest when signals genuinely cluster there', () => {
    const times = [
      T('2026-04-01T09:12:00Z'),
      T('2026-04-01T09:14:00Z'),
      T('2026-04-01T09:25:00Z'),
    ];
    expect(earliestCluster(times)).toBe(T('2026-04-01T09:12:00Z'));
  });

  it('falls back to the single observation when only one exists', () => {
    const only = T('2026-04-01T09:12:00Z');
    expect(earliestCluster([only])).toBe(only);
  });

  it('returns null for no observations at all', () => {
    expect(earliestCluster([])).toBeNull();
  });

  it('falls back to the earliest when nothing clusters within the window', () => {
    const times = [
      T('2026-04-01T01:00:00Z'),
      T('2026-04-01T05:00:00Z'),
      T('2026-04-01T09:00:00Z'),
    ];
    expect(earliestCluster(times)).toBe(T('2026-04-01T01:00:00Z'));
  });

  it('skips several stray outliers, not just one', () => {
    const times = [
      T('2026-04-01T01:00:00Z'),
      T('2026-04-01T03:00:00Z'),
      T('2026-04-01T09:10:00Z'),
      T('2026-04-01T09:12:00Z'),
      T('2026-04-01T09:13:00Z'),
    ];
    expect(earliestCluster(times)).toBe(T('2026-04-01T09:10:00Z'));
  });

  it('respects a caller-supplied window', () => {
    const times = [T('2026-04-01T09:00:00Z'), T('2026-04-01T09:30:00Z')];
    expect(earliestCluster(times, 20)).toBe(T('2026-04-01T09:00:00Z')); // no cluster -> earliest
    expect(earliestCluster(times, 45)).toBe(T('2026-04-01T09:00:00Z')); // clusters -> same
    void MIN;
  });
});

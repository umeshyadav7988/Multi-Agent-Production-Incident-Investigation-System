import { describe, it, expect } from 'vitest';
import { generateWorld } from '../src/data/generator.ts';
import { getScenario, toIncidentReport, SCENARIOS } from '../src/data/scenarios/index.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { FaultInjector } from '../src/tools/faults.ts';
import { Telemetry } from '../src/core/telemetry.ts';
import { Budget } from '../src/core/budget.ts';
import { Rng } from '../src/core/rng.ts';
import { changePoint, stats } from '../src/tools/analysis.ts';

function registry(scenarioId = 'INC-5001', faultRate = 0, forced = true) {
  const spec = getScenario(scenarioId);
  const { world } = generateWorld(spec, 20260401);
  const incident = toIncidentReport(spec);
  const rng = new Rng('test');
  const telemetry = new Telemetry();
  const budget = new Budget();
  const tools = new ToolRegistry(
    { world, rng: rng.fork('ctx'), defaultWindow: incident.window },
    new FaultInjector(rng.fork('faults'), faultRate, forced ? (spec.forcedToolFaults ?? []) : []),
    telemetry, budget, rng.fork('retry'), false,
  );
  return { tools, telemetry, budget, world, incident, spec };
}

describe('world generation', () => {
  it('is byte-identical for the same seed', () => {
    const a = generateWorld(getScenario('INC-5002'), 123);
    const b = generateWorld(getScenario('INC-5002'), 123);
    expect(JSON.stringify(a.world)).toBe(JSON.stringify(b.world));
  });

  it('differs between seeds', () => {
    const a = generateWorld(getScenario('INC-5002'), 123);
    const b = generateWorld(getScenario('INC-5002'), 124);
    expect(JSON.stringify(a.world)).not.toBe(JSON.stringify(b.world));
  });

  it('produces a populated world for every scenario', () => {
    for (const spec of SCENARIOS) {
      const { world } = generateWorld(spec, 20260401);
      expect(world.logs.length, spec.id).toBeGreaterThan(20);
      expect(world.metrics.length, spec.id).toBeGreaterThan(50);
      expect(world.dependencies.length, spec.id).toBeGreaterThan(10);
      expect(world.historical.length, spec.id).toBeGreaterThan(5);
    }
  });

  it('never hands the ground-truth key to the system', () => {
    for (const spec of SCENARIOS) {
      // What the agents receive is the incident report, and it must contain no
      // trace of the answer: no truth object, no narrative, no category.
      const incident = toIncidentReport(spec) as Record<string, unknown>;
      expect(Object.keys(incident), spec.id).not.toContain('truth');
      const seen = JSON.stringify(incident).toLowerCase();
      expect(seen.includes(spec.truth.narrative.toLowerCase()), `${spec.id} narrative`).toBe(false);
      expect(seen.includes(spec.truth.category.toLowerCase()), `${spec.id} category`).toBe(false);
    }
  });

  it('never writes the authored narrative into the queryable world', () => {
    for (const spec of SCENARIOS) {
      const { world } = generateWorld(spec, 20260401);
      const blob = JSON.stringify(world).toLowerCase();
      // Logs may legitimately describe the same failure; what must never appear
      // is the authored explanation of it.
      expect(blob.includes(spec.truth.narrative.toLowerCase()), `${spec.id} narrative`).toBe(false);
      expect(blob.includes('requiredevidencemarkers'), `${spec.id} key`).toBe(false);
    }
  });
});

describe('analysis helpers', () => {
  it('detects a step change and reports its direction and ratio', () => {
    const pts = [
      ...Array.from({ length: 10 }, (_, i) => ({ ts: `2026-04-01T09:${String(i).padStart(2, '0')}:00Z`, value: 10 })),
      ...Array.from({ length: 10 }, (_, i) => ({ ts: `2026-04-01T09:${String(i + 10).padStart(2, '0')}:00Z`, value: 50 })),
    ];
    const cp = changePoint(pts);
    expect(cp.direction).toBe('increase');
    expect(cp.ratio).toBeCloseTo(5, 1);
    expect(cp.at).toBe('2026-04-01T09:10:00Z');
  });

  it('reports a flat series as flat', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ ts: `2026-04-01T09:${String(i).padStart(2, '0')}:00Z`, value: 10 + (i % 2) * 0.2 }));
    expect(changePoint(pts).direction).toBe('flat');
  });

  it('handles an empty series without throwing', () => {
    expect(stats([]).mean).toBe(0);
    expect(changePoint([]).direction).toBe('flat');
  });
});

describe('tool registry', () => {
  it('returns structured data for a valid query', async () => {
    const { tools } = registry();
    const env = await tools.call('query_logs', { levels: ['error'], limit: 5 }, 'observability');
    expect(env.ok).toBe(true);
    expect(env.complete).toBe(true);
    expect(env.data).toBeTruthy();
  });

  it('rejects a malformed input against the tool schema without throwing', async () => {
    const { tools } = registry();
    const env = await tools.call('query_logs', { levels: ['not-a-level'], limit: 99999 }, 'observability');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('bad_query');
    expect(env.error?.retryable).toBe(false);
  });

  it('rejects an unknown tool name', async () => {
    const { tools } = registry();
    const env = await tools.call('query_nothing', {}, 'observability');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('not_found');
  });

  it('reports a not_found for an unknown service', async () => {
    const { tools } = registry();
    const env = await tools.call('query_dependencies', { service: 'no-such-service' }, 'dependency');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects an inverted time range', async () => {
    const { tools } = registry();
    const env = await tools.call('query_metrics', {
      services: ['order-service'], from: '2026-04-01T10:00:00Z', to: '2026-04-01T09:00:00Z',
    }, 'observability');
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('bad_query');
  });

  it('flags a forced partial result as incomplete rather than failing', async () => {
    // INC-5004 forces query_metrics to truncate its first two responses.
    const { tools } = registry('INC-5004');
    const env = await tools.call('query_metrics', { services: ['search-service'] }, 'observability');
    expect(env.ok).toBe(true);
    expect(env.complete).toBe(false);
    expect(env.warnings.join(' ')).toMatch(/partial/i);
  });

  it('surfaces a hard tool failure as a structured error, never a throw', async () => {
    // INC-5010 forces query_logs to be unavailable for many calls.
    const { tools } = registry('INC-5010');
    const env = await tools.call('query_logs', { limit: 10 }, 'observability');
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.error?.code).toBe('unavailable');
    expect(env.attempts).toBeGreaterThan(1); // it retried before giving up
  });

  it('opens a circuit breaker after repeated failures and stops spending budget', async () => {
    const { tools, budget } = registry('INC-5010');
    for (let i = 0; i < 4; i++) await tools.call('query_logs', { limit: 10 }, 'observability');
    const spentBefore = budget.remaining('toolCalls');
    const env = await tools.call('query_logs', { limit: 10 }, 'observability');
    expect(env.ok).toBe(false);
    expect(env.warnings.join(' ')).toMatch(/circuit breaker/i);
    expect(budget.remaining('toolCalls')).toBe(spentBefore); // no budget consumed
  });

  it('refuses to call once the tool-call budget is gone', async () => {
    const spec = getScenario('INC-5001');
    const { world } = generateWorld(spec, 1);
    const incident = toIncidentReport(spec);
    const rng = new Rng('b');
    const budget = new Budget({ toolCalls: 1 });
    const tools = new ToolRegistry(
      { world, rng: rng.fork('c'), defaultWindow: incident.window },
      new FaultInjector(rng.fork('f'), 0, []), new Telemetry(), budget, rng.fork('r'), false,
    );
    expect((await tools.call('query_logs', { limit: 1 }, 'observability')).ok).toBe(true);
    const second = await tools.call('query_logs', { limit: 1 }, 'observability');
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('budget');
  });

  it('records every call for auditing', async () => {
    const { tools } = registry();
    await tools.call('query_metrics', { services: ['order-service'] }, 'observability');
    await tools.call('query_deployments', { lookbackMinutes: 60 }, 'dependency');
    expect(tools.calls).toHaveLength(2);
    expect(tools.calls.map((c) => c.tool)).toEqual(['query_metrics', 'query_deployments']);
    expect(tools.calls.every((c) => typeof c.elapsedMs === 'number')).toBe(true);
  });

  it('widens the deployment search when asked to look further back', async () => {
    const { tools } = registry('INC-5004');
    const narrow = await tools.call<{ count: number }>('query_deployments', { lookbackMinutes: 120 }, 'dependency');
    const wide = await tools.call<{ count: number }>('query_deployments', { lookbackMinutes: 2880 }, 'dependency');
    expect(wide.data!.count).toBeGreaterThan(narrow.data!.count);
  });

  it('ranks historical incidents by similarity', async () => {
    const { tools, incident } = registry('INC-5003');
    const env = await tools.call<{ matches: { similarity: number }[] }>(
      'query_historical_incidents',
      { symptoms: incident.symptoms, services: incident.affectedServices, limit: 5 },
      'dependency',
    );
    const sims = env.data!.matches.map((m) => m.similarity);
    expect(sims).toEqual([...sims].sort((a, b) => b - a));
  });
});

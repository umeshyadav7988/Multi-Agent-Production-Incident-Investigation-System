import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { LLM_SCHEMAS, selectEvidence, reconcileVerdict, isUnrecoverableQuota } from '../src/core/llm/llm.ts';
import { parseToolInput } from '../src/baseline/single-agent.ts';
import { TokenRateLimiter, estimateTokens } from '../src/core/llm/throttle.ts';
import { Telemetry } from '../src/core/telemetry.ts';
import type { Evidence } from '../src/core/types.ts';

/**
 * These guards encode two provider constraints discovered the hard way. Both
 * fail silently in production — the call is rejected, the engine drops to its
 * deterministic fallback, and the run looks like a model reasoning badly rather
 * than one that never ran. A test is the only thing that makes them loud.
 */
describe('LLM schemas stay inside the strict JSON-schema subset', () => {
  const walk = (node: unknown, path: string, visit: (n: Record<string, unknown>, p: string) => void): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((c, i) => walk(c, `${path}[${i}]`, visit));
      return;
    }
    const obj = node as Record<string, unknown>;
    visit(obj, path);
    for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`, visit);
  };

  it.each(Object.keys(LLM_SCHEMAS))('%s: emits no propertyNames (z.record is rejected)', (name) => {
    const json = z.toJSONSchema(LLM_SCHEMAS[name as keyof typeof LLM_SCHEMAS] as z.ZodTypeAny, { io: 'input' });
    const offenders: string[] = [];
    walk(json, '$', (n, p) => {
      if ('propertyNames' in n) offenders.push(p);
    });
    expect(offenders, `${name} uses z.record somewhere; providers reject propertyNames`).toEqual([]);
  });

  it.each(Object.keys(LLM_SCHEMAS))('%s: every object property is required (no optional/default)', (name) => {
    const json = z.toJSONSchema(LLM_SCHEMAS[name as keyof typeof LLM_SCHEMAS] as z.ZodTypeAny, { io: 'input' });
    const offenders: string[] = [];
    walk(json, '$', (n, p) => {
      if (n.type !== 'object' || !n.properties) return;
      const props = Object.keys(n.properties as Record<string, unknown>);
      if (props.length === 0) return;
      const required = new Set((n.required as string[] | undefined) ?? []);
      const missing = props.filter((k) => !required.has(k));
      if (missing.length) offenders.push(`${p}: ${missing.join(', ')}`);
    });
    expect(offenders, `${name} has optional properties; strict providers require every key`).toEqual([]);
  });
});

describe('prompt budget', () => {
  const ev = (i: number, over: Partial<Evidence> = {}): Evidence => ({
    id: `E${String(i).padStart(3, '0')}`, claim: `claim ${i}`, type: 'inference',
    reliability: 'low', services: ['s'], observedAt: null, tags: ['error_log'], magnitude: null,
    source: { tool: 'query_logs', query: {}, agent: 'observability', retrievedAt: '', complete: true },
    ...over,
  });

  it('returns everything when the ledger fits', () => {
    const items = Array.from({ length: 5 }, (_, i) => ev(i));
    expect(selectEvidence(items, 28)).toHaveLength(5);
  });

  it('keeps first-hand facts over inference when it must choose', () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => ev(i)),
      ev(99, { type: 'fact', reliability: 'high', tags: ['oom'] }),
    ];
    const kept = selectEvidence(items, 10);
    expect(kept).toHaveLength(10);
    expect(kept.map((e) => e.id)).toContain('E099');
  });

  it('preserves evidence ids exactly, so citations still resolve', () => {
    const items = Array.from({ length: 40 }, (_, i) => ev(i));
    for (const e of selectEvidence(items, 12)) {
      expect(items.some((x) => x.id === e.id && x.claim === e.claim)).toBe(true);
    }
  });

  it('estimates tokens monotonically with length', () => {
    expect(estimateTokens('a'.repeat(100))).toBeLessThan(estimateTokens('a'.repeat(1000)));
  });
});

describe('TokenRateLimiter', () => {
  it('lets calls through while inside the window budget', async () => {
    const lim = new TokenRateLimiter(10_000);
    const t0 = Date.now();
    await lim.acquire(3000); lim.record(3000);
    await lim.acquire(3000); lim.record(3000);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('is disabled when the limit is zero', async () => {
    const lim = new TokenRateLimiter(0);
    const t0 = Date.now();
    await lim.acquire(1_000_000);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('lets a single oversized call through rather than waiting forever', async () => {
    const lim = new TokenRateLimiter(1000);
    const t0 = Date.now();
    await lim.acquire(50_000);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe('verdict reconciliation', () => {
  const t = new Telemetry();

  it('overrides a verdict that frankly contradicts the scored confidence', () => {
    expect(reconcileVerdict('inconclusive', 0.82, t)).toBe('root_cause_identified');
    expect(reconcileVerdict('root_cause_identified', 0.12, t)).toBe('inconclusive');
  });

  it('leaves a one-step judgement call alone', () => {
    expect(reconcileVerdict('probable_cause', 0.85, t)).toBe('probable_cause');
    expect(reconcileVerdict('inconclusive', 0.40, t)).toBe('inconclusive');
  });
});

describe('baseline tool-argument parsing', () => {
  it('accepts a plain JSON object', () => {
    expect(parseToolInput('{"services":["api-gateway"],"limit":5}')).toEqual({ services: ['api-gateway'], limit: 5 });
  });

  it('strips a markdown fence', () => {
    expect(parseToolInput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('degrades to an empty object on anything unusable', () => {
    for (const bad of ['', 'not json', '[1,2,3]', 'null', '{oops']) {
      expect(parseToolInput(bad)).toEqual({});
    }
  });
});

describe('provider quota classification', () => {
  // Verbatim shapes seen from Groq. The upsell footer is the trap: matching
  // "billing" or "credit" anywhere in the body turns every transient
  // per-minute limit into a permanent one and silently disables the model.
  const UPSELL = ' Please try again in 40.92s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing';

  it('treats a per-minute limit as recoverable', () => {
    expect(isUnrecoverableQuota(
      'AI_APICallError | HTTP 429 | Rate limit reached for model `qwen` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 3000.' + UPSELL,
    )).toBe(false);
  });

  it('treats an output-per-minute limit as recoverable', () => {
    expect(isUnrecoverableQuota(
      'HTTP 429 | Rate limit reached ... on output tokens per minute (OTPM): Limit 1000, Used 810, Requested 872.' + UPSELL,
    )).toBe(false);
  });

  it('treats a per-day limit as unrecoverable', () => {
    expect(isUnrecoverableQuota(
      'HTTP 429 | Rate limit reached for model `gpt-oss-120b` ... on tokens per day (TPD): Limit 200000, Used 197782, Requested 2371.' + UPSELL,
    )).toBe(true);
  });

  it('treats a spent account balance as unrecoverable', () => {
    expect(isUnrecoverableQuota('HTTP 429 | You exceeded your current quota, please check your plan and billing details')).toBe(true);
  });

  it('ignores errors that are not quota related', () => {
    expect(isUnrecoverableQuota('HTTP 400 | Generated JSON does not match the expected schema')).toBe(false);
    expect(isUnrecoverableQuota('HTTP 500 | internal error')).toBe(false);
  });
});

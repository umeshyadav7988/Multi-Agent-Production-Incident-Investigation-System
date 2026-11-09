import { z } from 'zod';
import { defineTool } from './types.ts';
import { ToolError } from '../core/errors.ts';
import { stats, changePoint, normaliseMessage, similarity, r } from './analysis.ts';
import type { LogEntry } from '../data/world.ts';

const TimeRange = {
  from: z.string().optional(),
  to: z.string().optional(),
};

function clampRange(
  input: { from?: string; to?: string },
  fallback: { start: string; end: string },
): [number, number] {
  const from = Date.parse(input.from ?? fallback.start);
  const to = Date.parse(input.to ?? fallback.end);
  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new ToolError('from/to must be ISO-8601 timestamps', 'bad_query', false, 'time_range');
  }
  if (to < from) {
    throw new ToolError('`to` precedes `from`', 'bad_query', false, 'time_range');
  }
  return [from, to];
}

/* ========================================================================= */
/* 1. Logs                                                                    */
/* ========================================================================= */

export const queryLogs = defineTool({
  name: 'query_logs',
  description:
    'Search application logs by service, level, substring and time range. Returns matching entries plus aggregates (counts by service/level and the most frequent normalised messages).',
  latencyMs: [40, 160],
  input: z.object({
    services: z.array(z.string()).optional().describe('Restrict to these services; omit for all'),
    levels: z.array(z.enum(['debug', 'info', 'warn', 'error', 'fatal'])).optional(),
    contains: z.string().optional().describe('Case-insensitive substring filter on the message'),
    ...TimeRange,
    limit: z.number().int().min(1).max(200).default(40),
  }),
  output: z.object({
    total: z.number(),
    returned: z.number(),
    entries: z.array(
      z.object({
        ts: z.string(),
        service: z.string(),
        level: z.string(),
        message: z.string(),
        traceId: z.string(),
        attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      }),
    ),
    byService: z.record(z.string(), z.number()),
    byLevel: z.record(z.string(), z.number()),
    topMessages: z.array(
      z.object({
        pattern: z.string(),
        count: z.number(),
        services: z.array(z.string()),
        firstSeen: z.string(),
        lastSeen: z.string(),
        sample: z.string(),
        level: z.string(),
      }),
    ),
  }),
  handler: (input, ctx) => {
    const [from, to] = clampRange(input, ctx.defaultWindow);
    const needle = input.contains?.toLowerCase();
    const matched = ctx.world.logs.filter((l) => {
      const t = Date.parse(l.ts);
      if (t < from || t > to) return false;
      if (input.services?.length && !input.services.includes(l.service)) return false;
      if (input.levels?.length && !input.levels.includes(l.level)) return false;
      if (needle && !l.message.toLowerCase().includes(needle)) return false;
      return true;
    });

    const byService: Record<string, number> = {};
    const byLevel: Record<string, number> = {};
    const groups = new Map<string, { count: number; services: Set<string>; first: string; last: string; sample: string; level: string }>();

    for (const l of matched) {
      byService[l.service] = (byService[l.service] ?? 0) + 1;
      byLevel[l.level] = (byLevel[l.level] ?? 0) + 1;
      const key = normaliseMessage(l.message);
      const g = groups.get(key);
      if (g) {
        g.count++;
        g.services.add(l.service);
        if (l.ts < g.first) g.first = l.ts;
        if (l.ts > g.last) g.last = l.ts;
      } else {
        groups.set(key, { count: 1, services: new Set([l.service]), first: l.ts, last: l.ts, sample: l.message, level: l.level });
      }
    }

    const topMessages = [...groups.entries()]
      .map(([pattern, g]) => ({
        pattern,
        count: g.count,
        services: [...g.services],
        firstSeen: g.first,
        lastSeen: g.last,
        sample: g.sample,
        level: g.level,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    // Return the most severe and most recent entries rather than an arbitrary slice.
    const sev: Record<string, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4 };
    const entries = [...matched]
      .sort((a, b) => (sev[a.level] ?? 9) - (sev[b.level] ?? 9) || b.ts.localeCompare(a.ts))
      .slice(0, input.limit)
      .map((l: LogEntry) => ({ ...l }));

    return { total: matched.length, returned: entries.length, entries, byService, byLevel, topMessages };
  },
});

/* ========================================================================= */
/* 2. Metrics                                                                 */
/* ========================================================================= */

export const queryMetrics = defineTool({
  name: 'query_metrics',
  description:
    'Fetch time series for one or more services. Returns per-series summary statistics and a detected change point (where the level shifted, by how much, and in which direction).',
  latencyMs: [60, 220],
  input: z.object({
    services: z.array(z.string()).min(1),
    metrics: z.array(z.string()).optional().describe('Metric names; omit for all available'),
    ...TimeRange,
    includePoints: z.boolean().default(false).describe('Include a downsampled point list'),
  }),
  output: z.object({
    series: z.array(
      z.object({
        service: z.string(),
        metric: z.string(),
        unit: z.string(),
        pointCount: z.number(),
        stats: z.object({
          min: z.number(), max: z.number(), mean: z.number(), p50: z.number(),
          p95: z.number(), first: z.number(), last: z.number(), maxAt: z.string().nullable(),
        }),
        changePoint: z.object({
          at: z.string().nullable(), beforeMean: z.number(), afterMean: z.number(),
          ratio: z.number(), direction: z.string(), strength: z.number(),
        }),
        points: z.array(z.object({ ts: z.string(), value: z.number() })).optional(),
      }),
    ),
    availableMetrics: z.array(z.string()),
  }),
  handler: (input, ctx) => {
    const [from, to] = clampRange(input, ctx.defaultWindow);
    const known = new Set(ctx.world.services.map((s) => s.name));
    const unknown = input.services.filter((s) => !known.has(s));
    if (unknown.length === input.services.length) {
      throw new ToolError(`no such service(s): ${unknown.join(', ')}`, 'not_found', false, 'query_metrics');
    }

    const selected = ctx.world.metrics.filter(
      (s) =>
        input.services.includes(s.service) &&
        (!input.metrics?.length || input.metrics.includes(s.metric)),
    );

    const series = selected.map((s) => {
      const pts = s.points.filter((p) => {
        const t = Date.parse(p.ts);
        return t >= from && t <= to;
      });
      const every = Math.max(1, Math.ceil(pts.length / 30));
      return {
        service: s.service,
        metric: s.metric,
        unit: s.unit,
        pointCount: pts.length,
        stats: stats(pts),
        changePoint: changePoint(pts),
        ...(input.includePoints ? { points: pts.filter((_, i) => i % every === 0) } : {}),
      };
    });

    const availableMetrics = [
      ...new Set(ctx.world.metrics.filter((s) => input.services.includes(s.service)).map((s) => s.metric)),
    ].sort();

    return { series, availableMetrics };
  },
});

/* ========================================================================= */
/* 3. Deployments                                                             */
/* ========================================================================= */

export const queryDeployments = defineTool({
  name: 'query_deployments',
  description:
    'List deployments. Use lookbackMinutes to widen beyond the incident window when nothing recent is found — slow-burn failures are often triggered by a release hours or days earlier.',
  latencyMs: [30, 110],
  input: z.object({
    services: z.array(z.string()).optional(),
    lookbackMinutes: z.number().int().min(1).max(10080).optional()
      .describe('Minutes before the window end to search; overrides from/to'),
    ...TimeRange,
  }),
  output: z.object({
    count: z.number(),
    searchedFrom: z.string(),
    searchedTo: z.string(),
    deployments: z.array(
      z.object({
        id: z.string(), service: z.string(), version: z.string(), deployedAt: z.string(),
        author: z.string(), changes: z.array(z.string()), strategy: z.string(),
        rolloutPct: z.number(), rolledBackAt: z.string().nullable(),
      }),
    ),
  }),
  handler: (input, ctx) => {
    let [from, to] = clampRange(input, ctx.defaultWindow);
    if (input.lookbackMinutes !== undefined) {
      to = Date.parse(ctx.defaultWindow.end);
      from = to - input.lookbackMinutes * 60_000;
    }
    const deployments = ctx.world.deployments
      .filter((d) => {
        const t = Date.parse(d.deployedAt);
        if (t < from || t > to) return false;
        if (input.services?.length && !input.services.includes(d.service)) return false;
        return true;
      })
      .sort((a, b) => b.deployedAt.localeCompare(a.deployedAt));

    return {
      count: deployments.length,
      searchedFrom: new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      searchedTo: new Date(to).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      deployments,
    };
  },
});

/* ========================================================================= */
/* 4. Configuration changes                                                   */
/* ========================================================================= */

export const queryConfigChanges = defineTool({
  name: 'query_config_changes',
  description:
    'List configuration, feature-flag, infrastructure, limit and schema-migration changes. Many incidents have no deployment but do have a config change.',
  latencyMs: [25, 95],
  input: z.object({
    services: z.array(z.string()).optional(),
    kinds: z.array(z.enum(['env', 'feature_flag', 'infra', 'secret', 'schema', 'limit'])).optional(),
    lookbackMinutes: z.number().int().min(1).max(10080).optional(),
    ...TimeRange,
  }),
  output: z.object({
    count: z.number(),
    searchedFrom: z.string(),
    searchedTo: z.string(),
    changes: z.array(
      z.object({
        id: z.string(), service: z.string(), changedAt: z.string(), key: z.string(),
        from: z.string(), to: z.string(), author: z.string(), kind: z.string(),
      }),
    ),
  }),
  handler: (input, ctx) => {
    let [from, to] = clampRange(input, ctx.defaultWindow);
    if (input.lookbackMinutes !== undefined) {
      to = Date.parse(ctx.defaultWindow.end);
      from = to - input.lookbackMinutes * 60_000;
    }
    const changes = ctx.world.configChanges
      .filter((c) => {
        const t = Date.parse(c.changedAt);
        if (t < from || t > to) return false;
        if (input.services?.length && !input.services.includes(c.service)) return false;
        if (input.kinds?.length && !input.kinds.includes(c.kind)) return false;
        return true;
      })
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt));

    return {
      count: changes.length,
      searchedFrom: new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      searchedTo: new Date(to).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      changes,
    };
  },
});

/* ========================================================================= */
/* 5. Service dependencies                                                    */
/* ========================================================================= */

export const queryDependencies = defineTool({
  name: 'query_dependencies',
  description:
    'Walk the service dependency graph. "dependencies" are services this one calls; "dependents" are services that call it. Use it to decide whether a symptom is local or inherited from upstream.',
  latencyMs: [20, 80],
  input: z.object({
    service: z.string(),
    direction: z.enum(['dependencies', 'dependents', 'both']).default('both'),
    depth: z.number().int().min(1).max(3).default(2),
  }),
  output: z.object({
    service: z.string(),
    edges: z.array(
      z.object({
        from: z.string(), to: z.string(), kind: z.string(), critical: z.boolean(),
        baselineRps: z.number(), timeoutMs: z.number(), hops: z.number(),
      }),
    ),
    dependencies: z.array(z.string()),
    dependents: z.array(z.string()),
    criticalDependencies: z.array(z.string()),
    /** Every service reachable downstream; the candidate blast radius. */
    reachable: z.array(z.string()),
  }),
  handler: (input, ctx) => {
    const known = new Set(ctx.world.services.map((s) => s.name));
    if (!known.has(input.service)) {
      throw new ToolError(`unknown service "${input.service}"`, 'not_found', false, 'query_dependencies');
    }
    const edges: Array<{ from: string; to: string; kind: string; critical: boolean; baselineRps: number; timeoutMs: number; hops: number }> = [];
    const seen = new Set<string>();

    const walk = (node: string, hop: number, dir: 'dependencies' | 'dependents') => {
      if (hop > input.depth) return;
      const next = ctx.world.dependencies.filter((e) =>
        dir === 'dependencies' ? e.from === node : e.to === node,
      );
      for (const e of next) {
        const key = `${e.from}->${e.to}:${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ ...e, hops: hop });
        walk(dir === 'dependencies' ? e.to : e.from, hop + 1, dir);
      }
    };

    if (input.direction === 'dependencies' || input.direction === 'both') walk(input.service, 1, 'dependencies');
    if (input.direction === 'dependents' || input.direction === 'both') walk(input.service, 1, 'dependents');

    const direct = ctx.world.dependencies.filter((e) => e.from === input.service);
    const callers = ctx.world.dependencies.filter((e) => e.to === input.service);

    return {
      service: input.service,
      edges,
      dependencies: [...new Set(direct.map((e) => e.to))],
      dependents: [...new Set(callers.map((e) => e.from))],
      criticalDependencies: [...new Set(direct.filter((e) => e.critical).map((e) => e.to))],
      reachable: [...new Set(edges.filter((e) => e.from === input.service || e.hops > 1).map((e) => e.to))],
    };
  },
});

/* ========================================================================= */
/* 6. Historical incidents                                                    */
/* ========================================================================= */

export const queryHistoricalIncidents = defineTool({
  name: 'query_historical_incidents',
  description:
    'Search resolved postmortems by symptom text, services and category. Returns similarity-ranked matches. Treat a match as a prior, never as proof — the archive contains near-misses with the same symptoms and different causes.',
  latencyMs: [35, 130],
  input: z.object({
    symptoms: z.array(z.string()).optional(),
    services: z.array(z.string()).optional(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  output: z.object({
    count: z.number(),
    matches: z.array(
      z.object({
        id: z.string(), title: z.string(), occurredAt: z.string(), services: z.array(z.string()),
        category: z.string(), rootCause: z.string(), resolution: z.string(),
        symptoms: z.array(z.string()), timeToResolveMin: z.number(),
        similarity: z.number(), matchedOn: z.array(z.string()),
      }),
    ),
  }),
  handler: (input, ctx) => {
    const scored = ctx.world.historical.map((h) => {
      const matchedOn: string[] = [];
      let score = 0;
      if (input.symptoms?.length) {
        const s = similarity(input.symptoms, [...h.symptoms, h.title, h.rootCause]);
        if (s > 0) matchedOn.push('symptoms');
        score += s * 0.6;
      }
      if (input.services?.length) {
        const overlap = input.services.filter((x) => h.services.includes(x)).length;
        if (overlap > 0) {
          matchedOn.push('services');
          score += (overlap / Math.max(1, input.services.length)) * 0.3;
        }
      }
      if (input.category && h.category === input.category) {
        matchedOn.push('category');
        score += 0.25;
      }
      return { ...h, similarity: r(score), matchedOn };
    });

    const matches = scored
      .filter((m) => m.similarity > 0.02)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, input.limit);

    return { count: matches.length, matches };
  },
});

export const ALL_TOOLS = [
  queryLogs,
  queryMetrics,
  queryDeployments,
  queryConfigChanges,
  queryDependencies,
  queryHistoricalIncidents,
];

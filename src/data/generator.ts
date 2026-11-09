import { Rng } from '../core/rng.ts';
import { SERVICES, DEPENDENCIES, BASE_HISTORY } from './topology.ts';
import type {
  World,
  ScenarioSpec,
  LogEntry,
  MetricSeries,
  MetricPoint,
  Deployment,
  ConfigChange,
  SignalSpec,
} from './world.ts';

const MINUTE = 60_000;

export function iso(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
export function parse(s: string): number {
  return Date.parse(s);
}
export function addMin(t: number, m: number): number {
  return t + m * MINUTE;
}

/** Baseline behaviour per tier. Scenario signals are layered on top of this so
 *  every world contains far more normal data than abnormal data. */
const TIER_BASELINE: Record<
  string,
  { latencyP99: number; errorRate: number; rps: number; cpu: number; mem: number }
> = {
  edge: { latencyP99: 240, errorRate: 0.2, rps: 3200, cpu: 31, mem: 44 },
  application: { latencyP99: 180, errorRate: 0.3, rps: 850, cpu: 38, mem: 52 },
  data: { latencyP99: 45, errorRate: 0.05, rps: 1400, cpu: 42, mem: 61 },
  infrastructure: { latencyP99: 60, errorRate: 0.1, rps: 600, cpu: 27, mem: 48 },
  external: { latencyP99: 420, errorRate: 0.4, rps: 200, cpu: 0, mem: 0 },
};

const ROUTINE_LOGS = [
  'request completed',
  'health check ok',
  'cache refreshed',
  'scheduled job finished',
  'connection pool resized',
  'metrics flushed to collector',
  'config reloaded from disk',
  'background compaction complete',
];

export interface GeneratedWorld {
  world: World;
  onsetAt: number;
  windowStart: number;
  windowEnd: number;
}

/**
 * Renders a `ScenarioSpec` into a queryable `World`.
 *
 * The output is a function of (spec, seed) only — two runs with the same seed
 * produce byte-identical data, which is what makes the evaluation comparable
 * between the multi-agent system and the single-agent baseline.
 */
export function generateWorld(spec: ScenarioSpec, seed: number | string): GeneratedWorld {
  const rng = new Rng(`${seed}:${spec.id}`);
  const reportedAt = parse(spec.reportedAt);
  const onsetAt = addMin(reportedAt, -spec.onsetMinutesBeforeReport);
  const windowStart = addMin(reportedAt, -spec.windowBeforeMin);
  const windowEnd = addMin(reportedAt, spec.windowAfterMin);

  const logs: LogEntry[] = [];
  const seriesMap = new Map<string, MetricSeries>();
  const deployments: Deployment[] = [];
  const configChanges: ConfigChange[] = [];

  /* ---------------------------------------------------- baseline everything */
  for (const svc of SERVICES) {
    const base = TIER_BASELINE[svc.tier] ?? TIER_BASELINE.application!;
    const svcRng = rng.fork(`base:${svc.name}`);
    const scale = svcRng.float(0.7, 1.4);
    pushSeries(seriesMap, svc.name, 'latency_p99_ms', 'ms',
      baselinePoints(windowStart, windowEnd, base.latencyP99 * scale, 0.12, svcRng));
    pushSeries(seriesMap, svc.name, 'latency_p50_ms', 'ms',
      baselinePoints(windowStart, windowEnd, base.latencyP99 * scale * 0.28, 0.1, svcRng));
    pushSeries(seriesMap, svc.name, 'error_rate_pct', '%',
      baselinePoints(windowStart, windowEnd, base.errorRate, 0.3, svcRng, 0));
    pushSeries(seriesMap, svc.name, 'requests_per_sec', 'rps',
      diurnalPoints(windowStart, windowEnd, base.rps * scale, svcRng));
    if (svc.tier !== 'external') {
      pushSeries(seriesMap, svc.name, 'cpu_pct', '%',
        baselinePoints(windowStart, windowEnd, base.cpu * scale, 0.14, svcRng, 0, 100));
      pushSeries(seriesMap, svc.name, 'memory_pct', '%',
        baselinePoints(windowStart, windowEnd, base.mem * scale, 0.05, svcRng, 0, 100));
    }

    // Routine log volume: this is the haystack.
    const n = svcRng.int(6, 14);
    for (let i = 0; i < n; i++) {
      const t = svcRng.int(windowStart, windowEnd);
      logs.push({
        ts: iso(t),
        service: svc.name,
        level: svcRng.bool(0.12) ? 'warn' : 'info',
        message: svcRng.pick(ROUTINE_LOGS),
        traceId: traceId(svcRng),
        attrs: { host: `${svc.name}-${svcRng.int(1, 8)}`, region: svcRng.pick(['us-east-1', 'eu-west-1']) },
      });
    }
  }

  /* ------------------------------------------- background change management */
  // Unrelated deploys, kept well away from onset so authored decoys remain the
  // controlled source of misleading evidence.
  const bgRng = rng.fork('background');
  for (const svc of SERVICES.filter((s) => s.tier !== 'external')) {
    if (!bgRng.bool(0.3)) continue;
    const offset = bgRng.pick([-600, -520, -430, -360, -290]) + bgRng.int(-20, 20);
    const at = addMin(onsetAt, offset);
    if (at < windowStart - 12 * 60 * MINUTE) continue;
    deployments.push({
      id: `dep-${bgRng.int(10000, 99999)}`,
      service: svc.name,
      version: `${bgRng.int(1, 6)}.${bgRng.int(0, 9)}.${bgRng.int(0, 9)}`,
      deployedAt: iso(at),
      author: bgRng.pick(['r.patel', 'j.okafor', 'm.lindqvist', 's.tanaka', 'd.alvarez']),
      changes: [bgRng.pick(['dependency bump', 'log format change', 'test-only change', 'docs update', 'metric label rename'])],
      strategy: 'rolling',
      rolloutPct: 100,
      rolledBackAt: null,
    });
  }

  /* ------------------------------------------------------- scenario signals */
  for (const [i, sig] of spec.signals.entries()) {
    applySignal(sig, i, { onsetAt, windowStart, windowEnd, logs, seriesMap, deployments, configChanges, rng: rng.fork(`sig:${i}`) });
  }

  logs.sort((a, b) => a.ts.localeCompare(b.ts) || a.service.localeCompare(b.service));
  deployments.sort((a, b) => a.deployedAt.localeCompare(b.deployedAt));
  configChanges.sort((a, b) => a.changedAt.localeCompare(b.changedAt));

  const world: World = {
    scenarioId: spec.id,
    services: SERVICES,
    logs,
    metrics: [...seriesMap.values()],
    deployments,
    configChanges,
    dependencies: [...DEPENDENCIES, ...(spec.extraDependencies ?? [])],
    historical: [...BASE_HISTORY, ...(spec.historical ?? [])],
  };

  return { world, onsetAt, windowStart, windowEnd };
}

/* =========================================================================== */

interface ApplyCtx {
  onsetAt: number;
  windowStart: number;
  windowEnd: number;
  logs: LogEntry[];
  seriesMap: Map<string, MetricSeries>;
  deployments: Deployment[];
  configChanges: ConfigChange[];
  rng: Rng;
}

function applySignal(sig: SignalSpec, idx: number, ctx: ApplyCtx): void {
  const { onsetAt, windowStart, windowEnd, rng } = ctx;

  if (sig.type === 'deploy') {
    const at = addMin(onsetAt, sig.offsetMin);
    ctx.deployments.push({
      id: `dep-${100000 + idx}`,
      service: sig.service,
      version: sig.version,
      deployedAt: iso(at),
      author: sig.author ?? rng.pick(['a.gomez', 'k.nguyen', 'p.sharma', 'l.dubois']),
      changes: sig.changes,
      strategy: sig.strategy ?? 'rolling',
      rolloutPct: sig.rolloutPct ?? 100,
      rolledBackAt:
        sig.rolledBackOffsetMin === undefined || sig.rolledBackOffsetMin === null
          ? null
          : iso(addMin(onsetAt, sig.rolledBackOffsetMin)),
    });
    return;
  }

  if (sig.type === 'config_change') {
    ctx.configChanges.push({
      id: `cfg-${200000 + idx}`,
      service: sig.service,
      changedAt: iso(addMin(onsetAt, sig.offsetMin)),
      key: sig.key,
      from: sig.from,
      to: sig.to,
      author: sig.author ?? rng.pick(['a.gomez', 'k.nguyen', 'p.sharma', 'l.dubois']),
      kind: sig.kind ?? 'env',
    });
    return;
  }

  if (sig.type === 'log_line') {
    const at = addMin(onsetAt, sig.offsetMin);
    for (let i = 0; i < (sig.count ?? 1); i++) {
      ctx.logs.push({
        ts: iso(at + i * rng.int(900, 4000)),
        service: sig.service,
        level: sig.level,
        message: sig.message,
        traceId: traceId(rng),
        attrs: { host: `${sig.service}-${rng.int(1, 8)}`, ...(sig.attrs ?? {}) },
      });
    }
    return;
  }

  if (sig.type === 'error_burst') {
    const start = addMin(onsetAt, sig.startOffsetMin);
    const end = addMin(start, sig.durationMin);
    const shape = sig.shape ?? 'step';
    // Sample the burst rather than emitting every line: real log tools page.
    const samplesPerMin = Math.max(1, Math.min(6, Math.round(sig.peakPerMin / 25)));
    for (let t = start; t <= Math.min(end, windowEnd); t += MINUTE) {
      const frac = (t - start) / Math.max(1, end - start);
      const intensity =
        shape === 'ramp' ? frac : shape === 'spike_decay' ? Math.exp(-3 * frac) : 1;
      const n = Math.round(samplesPerMin * intensity);
      for (let i = 0; i < n; i++) {
        ctx.logs.push({
          ts: iso(t + rng.int(0, 59_000)),
          service: sig.service,
          level: sig.level ?? 'error',
          message: sig.message,
          traceId: traceId(rng),
          attrs: {
            host: `${sig.service}-${rng.int(1, 8)}`,
            ...(sig.attrs ?? {}),
          },
        });
      }
    }
    // An error burst always leaves a mark on error_rate_pct.
    const key = `${sig.service}|error_rate_pct`;
    const series = ctx.seriesMap.get(key);
    if (series) {
      overlay(series.points, start, Math.min(end, windowEnd), (p, frac) => {
        const intensity = shape === 'ramp' ? frac : shape === 'spike_decay' ? Math.exp(-3 * frac) : 1;
        return Math.min(100, p + (sig.peakPerMin / 60) * intensity * 1.8);
      });
    }
    return;
  }

  if (sig.type === 'metric_shift') {
    const key = `${sig.service}|${sig.metric}`;
    if (!ctx.seriesMap.has(key)) {
      pushSeries(ctx.seriesMap, sig.service, sig.metric, sig.unit ?? guessUnit(sig.metric),
        baselinePoints(windowStart, windowEnd, sig.baseline, sig.noise ?? 0.08, rng));
    }
    const series = ctx.seriesMap.get(key)!;
    const start = addMin(onsetAt, sig.startOffsetMin);
    const recover =
      sig.recoverOffsetMin === undefined || sig.recoverOffsetMin === null
        ? windowEnd
        : addMin(onsetAt, sig.recoverOffsetMin);
    const shape = sig.shape ?? 'step';
    const span = Math.max(MINUTE, recover - start);

    series.points = series.points.map((pt) => {
      const t = parse(pt.ts);
      if (t < start || t > recover) return pt;
      const frac = (t - start) / span;
      let target: number;
      switch (shape) {
        case 'ramp':
          target = sig.baseline + (sig.peak - sig.baseline) * frac;
          break;
        case 'sawtooth': {
          const cycles = 3;
          const phase = (frac * cycles) % 1;
          target = sig.baseline + (sig.peak - sig.baseline) * phase;
          break;
        }
        case 'spike_decay':
          target = sig.baseline + (sig.peak - sig.baseline) * Math.exp(-3.2 * frac);
          break;
        default:
          target = sig.peak;
      }
      const jitter = rng.normal(1, sig.noise ?? 0.05);
      return { ts: pt.ts, value: round(Math.max(0, target * jitter)) };
    });
  }
}

/* ------------------------------------------------------------------ helpers */

function pushSeries(
  map: Map<string, MetricSeries>,
  service: string,
  metric: string,
  unit: string,
  points: MetricPoint[],
): void {
  map.set(`${service}|${metric}`, { service, metric, unit, points });
}

function baselinePoints(
  from: number,
  to: number,
  mean: number,
  cv: number,
  rng: Rng,
  min = 0,
  max = Number.POSITIVE_INFINITY,
): MetricPoint[] {
  const pts: MetricPoint[] = [];
  for (let t = from; t <= to; t += MINUTE) {
    const v = rng.normal(mean, Math.max(mean * cv, mean === 0 ? 0.02 : 0.001));
    pts.push({ ts: iso(t), value: round(Math.min(max, Math.max(min, v))) });
  }
  return pts;
}

function diurnalPoints(from: number, to: number, mean: number, rng: Rng): MetricPoint[] {
  const pts: MetricPoint[] = [];
  for (let t = from; t <= to; t += MINUTE) {
    const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
    const diurnal = 1 + 0.18 * Math.sin(((hour - 6) / 24) * 2 * Math.PI);
    pts.push({ ts: iso(t), value: round(Math.max(0, rng.normal(mean * diurnal, mean * 0.06))) });
  }
  return pts;
}

function overlay(
  points: MetricPoint[],
  start: number,
  end: number,
  fn: (prev: number, frac: number) => number,
): void {
  const span = Math.max(MINUTE, end - start);
  for (let i = 0; i < points.length; i++) {
    const pt = points[i]!;
    const t = parse(pt.ts);
    if (t < start || t > end) continue;
    points[i] = { ts: pt.ts, value: round(fn(pt.value, (t - start) / span)) };
  }
}

function guessUnit(metric: string): string {
  if (metric.endsWith('_ms')) return 'ms';
  if (metric.endsWith('_pct') || metric.includes('rate')) return '%';
  if (metric.includes('per_sec') || metric.endsWith('_rps')) return 'rps';
  if (metric.includes('depth') || metric.includes('count') || metric.includes('lag')) return 'count';
  return 'unit';
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function traceId(rng: Rng): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 16; i++) s += hex[rng.int(0, 15)];
  return s;
}

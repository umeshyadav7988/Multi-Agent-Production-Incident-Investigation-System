import type { MetricPoint } from '../data/world.ts';

export interface SeriesStats {
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  first: number;
  last: number;
  maxAt: string | null;
}

export interface ChangePoint {
  at: string | null;
  beforeMean: number;
  afterMean: number;
  /** afterMean / beforeMean, guarded against divide-by-zero. */
  ratio: number;
  direction: 'increase' | 'decrease' | 'flat';
  /** Normalised separation of the two segments; >1 is a strong break. */
  strength: number;
}

export function stats(points: MetricPoint[]): SeriesStats {
  if (points.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, first: 0, last: 0, maxAt: null };
  }
  const vals = points.map((p) => p.value);
  const sorted = [...vals].sort((a, b) => a - b);
  let maxIdx = 0;
  for (let i = 1; i < vals.length; i++) if ((vals[i] as number) > (vals[maxIdx] as number)) maxIdx = i;
  return {
    min: r(sorted[0] as number),
    max: r(sorted[sorted.length - 1] as number),
    mean: r(vals.reduce((a, b) => a + b, 0) / vals.length),
    p50: r(quantile(sorted, 0.5)),
    p95: r(quantile(sorted, 0.95)),
    first: r(vals[0] as number),
    last: r(vals[vals.length - 1] as number),
    maxAt: points[maxIdx]?.ts ?? null,
  };
}

/**
 * Single best split of the series into a "before" and "after" segment.
 *
 * This is deliberately a plain statistic, not a judgement: the tool reports
 * where the level shifted and by how much, and the agents decide whether that
 * shift is meaningful given everything else they know.
 */
export function changePoint(points: MetricPoint[], minSegment = 3): ChangePoint {
  const n = points.length;
  const flat: ChangePoint = { at: null, beforeMean: 0, afterMean: 0, ratio: 1, direction: 'flat', strength: 0 };
  if (n < minSegment * 2) return flat;

  const vals = points.map((p) => p.value);
  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] as number) + (vals[i] as number);

  const total = prefix[n] as number;
  const grandMean = total / n;
  const spread =
    Math.sqrt(vals.reduce((a, v) => a + (v - grandMean) ** 2, 0) / n) || 1e-9;

  let bestIdx = -1;
  let bestScore = 0;
  for (let k = minSegment; k <= n - minSegment; k++) {
    const beforeMean = (prefix[k] as number) / k;
    const afterMean = (total - (prefix[k] as number)) / (n - k);
    // Weight by segment balance so a single tail point cannot dominate.
    const score = (Math.abs(afterMean - beforeMean) / spread) * Math.sqrt((k * (n - k)) / (n * n));
    if (score > bestScore) {
      bestScore = score;
      bestIdx = k;
    }
  }
  if (bestIdx < 0) return flat;

  const beforeMean = (prefix[bestIdx] as number) / bestIdx;
  const afterMean = (total - (prefix[bestIdx] as number)) / (n - bestIdx);
  const ratio = beforeMean === 0 ? (afterMean === 0 ? 1 : afterMean / 0.01) : afterMean / beforeMean;
  const relDelta = Math.abs(afterMean - beforeMean) / Math.max(Math.abs(beforeMean), 1e-6);

  return {
    at: points[bestIdx]?.ts ?? null,
    beforeMean: r(beforeMean),
    afterMean: r(afterMean),
    ratio: r(ratio),
    direction: relDelta < 0.15 ? 'flat' : afterMean > beforeMean ? 'increase' : 'decrease',
    strength: r(bestScore),
  };
}

/** Collapses variable parts of a log line so identical events group together. */
export function normaliseMessage(msg: string): string {
  return msg
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d+(\.\d+)?(ms|s|%)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sortedAsc[lo] as number;
  const b = sortedAsc[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function r(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

/** Token-overlap similarity, used for historical incident matching. */
export function similarity(a: string[], b: string[]): number {
  const ta = new Set(a.flatMap(tokens));
  const tb = new Set(b.flatMap(tokens));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return r(inter / Math.sqrt(ta.size * tb.size));
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'no', 'not', 'for', 'at', 'by', 'with']);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

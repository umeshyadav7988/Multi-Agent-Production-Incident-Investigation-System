import type { InvestigationOutcome, Evidence } from '../core/types.ts';
import type { ScenarioSpec } from '../data/world.ts';

export interface Grade {
  incidentId: string;
  approach: string;
  traits: string[];

  /* accuracy */
  expectedCategory: string;
  expectedService: string;
  predictedCategory: string | null;
  predictedService: string | null;
  verdict: string;
  categoryCorrect: boolean;
  serviceCorrect: boolean;
  /** Strict: the top-ranked hypothesis names both the right cause and the
   *  right service (or correctly reports an inconclusive outcome). */
  correct: boolean;
  /** Credit for finding it at all, even if not ranked first. */
  inTopThree: boolean;
  /** Said "inconclusive" when a cause was in fact discoverable. */
  missedByAbstaining: boolean;
  /** Named a cause when the honest answer was "insufficient evidence". */
  overreached: boolean;

  /* grounding */
  markerCoverage: number;
  citationValidity: number;
  factRatio: number;
  contradictionsSurfaced: number;
  groundingScore: number;

  /* calibration */
  confidence: number;
  brier: number;

  /* cost */
  toolCalls: number;
  toolFailures: number;
  llmCalls: number;
  tokens: number;
  wallClockMs: number;
  evidenceCount: number;
  hypothesesConsidered: number;
  rounds: number;
  terminationReason: string;
}

/**
 * Grades one run against the scenario's hidden key.
 *
 * The key is never visible to any agent: it is read here, after the run, from
 * the scenario spec. Accuracy, grounding and calibration are scored separately
 * because a confident wrong answer and an honest "I don't know" fail in very
 * different ways and should not collapse into one number.
 */
export function grade(spec: ScenarioSpec, outcome: InvestigationOutcome, approach: string): Grade {
  const { report, metrics, evidence } = outcome;
  const top = report.rankedHypotheses[0];
  const expectInconclusive = spec.truth.expectInconclusive === true;
  const acceptable = new Set<string>([spec.truth.category, ...(spec.truth.alsoAcceptable ?? [])]);

  const predictedCategory = top?.hypothesis.category ?? null;
  const predictedService = top?.hypothesis.suspectService ?? null;
  const saidInconclusive = report.verdict === 'inconclusive';

  const categoryCorrect = !saidInconclusive && !!predictedCategory && acceptable.has(predictedCategory);
  const serviceCorrect = !saidInconclusive && predictedService === spec.truth.service;

  const correct = expectInconclusive
    ? saidInconclusive
    : categoryCorrect && serviceCorrect;

  const inTopThree = expectInconclusive
    ? saidInconclusive
    : report.rankedHypotheses
        .slice(0, 3)
        .some((r) => acceptable.has(r.hypothesis.category) && r.hypothesis.suspectService === spec.truth.service);

  /* ----------------------------- grounding ------------------------------ */

  const citedEvidence: Evidence[] = top ? top.supportingEvidence : [];
  const citedText = citedEvidence.map((e) => e.claim).join(' \n ').toLowerCase();
  const markers = spec.truth.requiredEvidenceMarkers;
  const markerCoverage = markers.length === 0
    ? (expectInconclusive ? 1 : 0)
    : markers.filter((m) => citedText.includes(m.toLowerCase())).length / markers.length;

  // Hallucination check: every evidence id the report cites must exist.
  const ledger = new Set(evidence.map((e) => e.id));
  const allCited = report.rankedHypotheses.flatMap((r) => [
    ...r.hypothesis.supporting.map((l) => l.evidenceId),
    ...r.hypothesis.contradicting.map((l) => l.evidenceId),
  ]);
  const citationValidity = allCited.length === 0 ? 1 : allCited.filter((id) => ledger.has(id)).length / allCited.length;

  const factRatio = citedEvidence.length === 0
    ? (expectInconclusive ? 1 : 0)
    : citedEvidence.filter((e) => e.type === 'fact').length / citedEvidence.length;

  const contradictionsSurfaced =
    (top?.contradictingEvidence.length ?? 0) + report.unresolvedContradictions.length;

  // Weighted: citing the right evidence matters most, then not inventing
  // citations, then resting on observation rather than inference.
  const groundingScore = 0.5 * markerCoverage + 0.3 * citationValidity + 0.2 * factRatio;

  /* ---------------------------- calibration ----------------------------- */

  const confidence = saidInconclusive ? 0 : (top?.hypothesis.confidence ?? 0);
  const target = correct ? 1 : 0;
  const effective = expectInconclusive && saidInconclusive ? 1 : confidence;
  const brier = (effective - target) ** 2;

  return {
    incidentId: spec.id,
    approach,
    traits: spec.traits,
    expectedCategory: spec.truth.category,
    expectedService: spec.truth.service,
    predictedCategory,
    predictedService,
    verdict: report.verdict,
    categoryCorrect,
    serviceCorrect,
    correct,
    inTopThree,
    missedByAbstaining: !expectInconclusive && saidInconclusive,
    overreached: expectInconclusive && !saidInconclusive,
    markerCoverage: round3(markerCoverage),
    citationValidity: round3(citationValidity),
    factRatio: round3(factRatio),
    contradictionsSurfaced,
    groundingScore: round3(groundingScore),
    confidence: round3(confidence),
    brier: round3(brier),
    toolCalls: metrics.toolCalls,
    toolFailures: metrics.toolFailures,
    llmCalls: metrics.llmCalls,
    tokens: metrics.tokensIn + metrics.tokensOut,
    wallClockMs: metrics.wallClockMs,
    evidenceCount: metrics.evidenceCount,
    hypothesesConsidered: metrics.hypothesesConsidered,
    rounds: metrics.rounds,
    terminationReason: metrics.terminationReason,
  };
}

export interface Aggregate {
  approach: string;
  n: number;
  accuracy: number;
  categoryAccuracy: number;
  serviceAccuracy: number;
  top3Accuracy: number;
  grounding: number;
  markerCoverage: number;
  citationValidity: number;
  factRatio: number;
  meanBrier: number;
  meanConfidence: number;
  confidenceWhenWrong: number;
  missedByAbstaining: number;
  overreached: number;
  meanToolCalls: number;
  meanToolFailures: number;
  meanLlmCalls: number;
  meanTokens: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  meanEvidence: number;
  meanHypotheses: number;
  meanRounds: number;
}

export function aggregate(grades: Grade[], approach: string): Aggregate {
  const n = grades.length || 1;
  const wrong = grades.filter((g) => !g.correct);
  const latencies = grades.map((g) => g.wallClockMs).sort((a, b) => a - b);
  const mean = (f: (g: Grade) => number) => round3(grades.reduce((a, g) => a + f(g), 0) / n);

  return {
    approach,
    n: grades.length,
    accuracy: mean((g) => (g.correct ? 1 : 0)),
    categoryAccuracy: mean((g) => (g.categoryCorrect || (g.verdict === 'inconclusive' && g.correct) ? 1 : 0)),
    serviceAccuracy: mean((g) => (g.serviceCorrect || (g.verdict === 'inconclusive' && g.correct) ? 1 : 0)),
    top3Accuracy: mean((g) => (g.inTopThree ? 1 : 0)),
    grounding: mean((g) => g.groundingScore),
    markerCoverage: mean((g) => g.markerCoverage),
    citationValidity: mean((g) => g.citationValidity),
    factRatio: mean((g) => g.factRatio),
    meanBrier: mean((g) => g.brier),
    meanConfidence: mean((g) => g.confidence),
    confidenceWhenWrong: wrong.length ? round3(wrong.reduce((a, g) => a + g.confidence, 0) / wrong.length) : 0,
    missedByAbstaining: grades.filter((g) => g.missedByAbstaining).length,
    overreached: grades.filter((g) => g.overreached).length,
    meanToolCalls: mean((g) => g.toolCalls),
    meanToolFailures: mean((g) => g.toolFailures),
    meanLlmCalls: mean((g) => g.llmCalls),
    meanTokens: mean((g) => g.tokens),
    meanLatencyMs: mean((g) => g.wallClockMs),
    p95LatencyMs: latencies.length ? (latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] as number) : 0,
    meanEvidence: mean((g) => g.evidenceCount),
    meanHypotheses: mean((g) => g.hypothesesConsidered),
    meanRounds: mean((g) => g.rounds),
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

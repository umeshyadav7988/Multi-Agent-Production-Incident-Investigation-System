import { z } from 'zod';
import type {
  ReasoningEngine, PlanInput, PlanOutput, HypothesisInput, HypothesisOutput,
  ScoreInput, ScoreOutput, CritiqueInput, CritiqueOutput, ReportInput, ReportOutput,
} from './engine.ts';
import { HeuristicEngine } from './heuristic.ts';
import { RootCauseCategory, TaskKind, AgentName } from '../types.ts';
import type { TaskKind as TaskKindT, AgentName as AgentNameT } from '../types.ts';
import type { Telemetry } from '../telemetry.ts';
import type { Budget } from '../budget.ts';
import { withRetry } from '../retry.ts';
import { generateStructured, resolveModel, type ModelConfig } from './client.ts';
import { TokenRateLimiter, estimateTokens } from './throttle.ts';

export interface LlmConfig extends ModelConfig {
  maxOutputTokens?: number;
  temperature?: number;
  /** Provider tokens-per-minute cap. 0 disables client-side throttling. */
  tokensPerMinute?: number;
  /** Provider *output* tokens-per-minute cap, when it differs. 0 disables. */
  outputTokensPerMinute?: number;
}

/** How much of the evidence ledger any single prompt may carry. Prompts are
 *  bounded on purpose: an investigation that gathers 60 items must still fit
 *  inside a context and a rate limit, so the model sees the most load-bearing
 *  evidence rather than all of it. */
const MAX_EVIDENCE_IN_PROMPT = 28;

/** Below this per-minute allowance, a single reasoning call can exceed the
 *  provider's whole window and is rejected outright ("request too large").
 *  Prompts and output budgets shrink to fit rather than failing. */
const CONSTRAINED_TPM = 20_000;

/* ------------------------------- schemas --------------------------------- */

/*
 * LLM-facing schemas are written against the *strict* JSON-schema subset, not
 * the full Zod surface. Providers that enforce structured output (Groq, and
 * OpenAI-compatible endpoints generally) reject several things Zod emits
 * freely:
 *
 *   - `z.record(...)`          → emits `propertyNames`, which is unsupported
 *   - `.optional()`            → omits the key from `required`, which is rejected
 *   - `.default(...)`          → same
 *
 * So: every property is required, `.nullable()` stands in for optionality, and
 * anything genuinely free-form travels as a JSON string that we parse and
 * validate ourselves. Do not "simplify" these back to records or optionals —
 * it silently reduces the system to its deterministic fallback on every call,
 * which looks like the model working badly rather than not running at all.
 */

/** Parameters a planned task may carry. Deliberately a closed set: it is both
 *  expressible in strict JSON schema and better documentation than a bag. */
const StrictTaskParams = z.object({
  services: z.array(z.string()).nullable().describe('Services to scope the task to, or null'),
  lookbackMinutes: z.number().int().nullable().describe('How far back to search, or null for the incident window'),
  reason: z.string().nullable().describe('Why this task, for the trace'),
  hypothesisId: z.string().nullable().describe('Hypothesis this task is meant to test, or null'),
});
type StrictTaskParamsT = z.infer<typeof StrictTaskParams>;

/** Keeps entries whose kind and agent are real, discarding the rest. */
function coerceTaskish<T extends { kind: string; agent: string }>(
  items: T[],
  telemetry: Telemetry,
  label: string,
): (Omit<T, 'kind' | 'agent'> & { kind: TaskKindT; agent: AgentNameT })[] {
  const out: (Omit<T, 'kind' | 'agent'> & { kind: TaskKindT; agent: AgentNameT })[] = [];
  let dropped = 0;
  for (const i of items) {
    const kind = TaskKind.safeParse(i.kind);
    const agent = AgentName.safeParse(i.agent);
    if (!kind.success || !agent.success) {
      dropped++;
      continue;
    }
    out.push({ ...i, kind: kind.data, agent: agent.data });
  }
  if (dropped > 0) {
    telemetry.emit('warning', `${label}: dropped ${dropped} item(s) naming an unknown task kind or agent`, { agent: 'system' });
  }
  return out;
}

/** Strict params → the internal loose shape, dropping nulls. */
function toParams(p: StrictTaskParamsT | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!p) return out;
  if (p.services && p.services.length) out.services = p.services;
  if (p.lookbackMinutes !== null && p.lookbackMinutes !== undefined) out.lookbackMinutes = p.lookbackMinutes;
  if (p.reason) out.reason = p.reason;
  if (p.hypothesisId) out.hypothesisId = p.hypothesisId;
  return out;
}

/*
 * `kind` and `agent` are accepted as guided strings rather than hard enums.
 *
 * A strict enum makes the provider reject the *entire* response when the model
 * emits one value outside the list — discarding an otherwise sound plan or
 * critique over a single token. Accepting a string and filtering afterwards
 * keeps the good entries, drops the bad one, and records that it happened.
 * The allowed values are still stated in the description, which is what
 * actually steers the model.
 */
const KIND_VALUES = TaskKind.options.join(' | ');
const AGENT_VALUES = AgentName.options.join(' | ');

const PlanSchema = z.object({
  rationale: z.string().describe('Why this plan, in two sentences'),
  tasks: z.array(z.object({
    id: z.string().describe('Short id such as T1'),
    kind: z.string().describe(`One of: ${KIND_VALUES}`),
    agent: z.string().describe(`One of: ${AGENT_VALUES}`),
    description: z.string(),
    params: StrictTaskParams.nullable(),
    dependsOn: z.array(z.string()).describe('Ids of tasks that must finish first; empty for a root task'),
  })).max(12),
});

const HypothesisSchema = z.object({
  hypotheses: z.array(z.object({
    title: z.string(),
    category: RootCauseCategory,
    suspectService: z.string().nullable(),
    statement: z.string(),
    supporting: z.array(z.object({
      evidenceId: z.string(),
      weight: z.number().min(0).max(1),
      rationale: z.string(),
    })),
    contradicting: z.array(z.object({
      evidenceId: z.string(),
      weight: z.number().min(0).max(1),
      rationale: z.string(),
    })),
    testablePredictions: z.array(z.string()),
  })).max(5),
  contradictions: z.array(z.object({
    description: z.string(),
    evidenceIds: z.array(z.string()),
  })),
  notes: z.array(z.string()),
});

const ScoreSchema = z.object({
  scores: z.array(z.object({
    hypothesisId: z.string(),
    confidence: z.number().min(0).max(1),
    status: z.enum(['open', 'supported', 'weakened', 'refuted']),
    reasoning: z.string(),
  })),
});

const CritiqueSchema = z.object({
  decision: z.enum(['accept', 'revise', 'inconclusive']),
  reasoning: z.string(),
  challenges: z.array(z.object({
    hypothesisId: z.string().nullable(),
    issue: z.string(),
    severity: z.enum(['blocking', 'major', 'minor']),
  })),
  evidenceGaps: z.array(z.string()),
  confidenceInTop: z.number().min(0).max(1),
  requests: z.array(z.object({
    kind: z.string().describe(`One of: ${KIND_VALUES}`),
    agent: z.string().describe(`One of: ${AGENT_VALUES}`),
    description: z.string(),
    params: StrictTaskParams.nullable(),
    rationale: z.string(),
  })).max(3),
});

const ReportSchema = z.object({
  verdict: z.enum(['root_cause_identified', 'probable_cause', 'inconclusive']),
  summary: z.string(),
  facts: z.array(z.string()),
  assumptions: z.array(z.string()),
  evidenceGaps: z.array(z.string()),
  recommendedActions: z.array(z.object({
    action: z.string(),
    type: z.enum(['immediate_mitigation', 'verification', 'permanent_fix', 'preventive']),
    targetService: z.string().nullable(),
    rationale: z.string(),
    predicatedOn: z.string().nullable(),
    risk: z.enum(['low', 'medium', 'high']),
  })).max(8),
});

/**
 * Exported for the strict-schema regression guard in tests/llm-schemas.test.ts.
 * These are the only schemas sent to a provider, so they are the only ones that
 * must stay inside the strict JSON-schema subset.
 */
export const LLM_SCHEMAS = {
  plan: PlanSchema,
  hypothesise: HypothesisSchema,
  score: ScoreSchema,
  critique: CritiqueSchema,
  report: ReportSchema,
} as const;

/* --------------------------------- engine -------------------------------- */

const SHARED_RULES = `You are part of a production incident investigation system.

Non-negotiable rules:
- Cite evidence by its id (E001, E002, ...). Never invent an id, a number, or a timestamp.
- Distinguish a fact (something a tool returned) from an inference (something you concluded) from an assumption (something you needed but did not observe).
- Temporal correlation is not causation. A change close to onset that cannot reach the symptoms is a coincidence.
- Evidence may be incomplete, contradictory or misleading. Say so rather than smoothing it over.
- "Not enough evidence" is a valid and sometimes correct answer.`;

/**
 * LLM-backed reasoning engine.
 *
 * Every call is schema-constrained via `generateObject`, retried on transient
 * failure, and falls back to the deterministic engine if the model is
 * unreachable or returns something unusable. A model outage degrades the
 * investigation; it does not end it.
 */
export class LlmEngine implements ReasoningEngine {
  readonly name = 'llm' as const;
  private readonly fallback = new HeuristicEngine();
  private model: unknown = null;
  private readonly limiter: TokenRateLimiter;
  /** Providers often cap *output* tokens per minute far below input. Groq's
   *  free tier allows 1000 OTPM against 8000 TPM, so the output budget, not
   *  the prompt, is what actually rejects a reasoning call. */
  private readonly outputLimiter: TokenRateLimiter;
  /** Set when the provider reports a quota that will not recover within this
   *  run (a daily cap). Further calls are pointless, so the engine stops
   *  asking and runs deterministically instead of failing once per step. */
  private quotaExhausted: string | null = null;

  constructor(
    private readonly config: LlmConfig,
    private readonly telemetry: Telemetry,
    private readonly budget: Budget,
  ) {
    const note = (kind: string) => (ms: number, why: string) =>
      this.telemetry.emit('warning', `pausing ${Math.round(ms / 1000)}s for the provider ${kind} budget (${why})`, { agent: 'system' });
    this.limiter = new TokenRateLimiter(
      config.tokensPerMinute ?? Number(process.env.LLM_TOKENS_PER_MINUTE ?? 0),
      note('token'),
    );
    this.outputLimiter = new TokenRateLimiter(
      config.outputTokensPerMinute ?? Number(process.env.LLM_OUTPUT_TOKENS_PER_MINUTE ?? 0),
      note('output-token'),
    );
  }

  private async getModel(): Promise<unknown> {
    if (!this.model) this.model = await resolveModel(this.config);
    return this.model;
  }

  /** Output budgets sized to each schema. One global ceiling either truncates
   *  the hypothesis step into invalid JSON or wastes the token budget on the
   *  short steps. */
  private static readonly OUTPUT_TOKENS: Record<string, number> = {
    plan: 1400,
    hypothesise: 3200,
    score: 1400,
    critique: 1600,
    report: 2200,
  };

  /** True when the provider's per-minute allowance is small enough that a
   *  full-fidelity call would not fit inside it. */
  private get constrained(): boolean {
    const tpm = this.config.tokensPerMinute ?? Number(process.env.LLM_TOKENS_PER_MINUTE ?? 0);
    return tpm > 0 && tpm < CONSTRAINED_TPM;
  }

  /** Evidence items a prompt may carry, given the provider's allowance. */
  private get evidenceBudget(): number {
    return this.constrained ? 12 : MAX_EVIDENCE_IN_PROMPT;
  }

  /**
   * Output budgets are *not* reduced when the provider is constrained.
   *
   * The two directions fail asymmetrically. A prompt that is too large can be
   * paced around by waiting; an output budget that is too small truncates the
   * model mid-document and returns invalid JSON, which no amount of waiting
   * fixes. So a tight allowance shrinks the prompt (fewer evidence items) and
   * leaves the model room to finish writing.
   *
   * The only hard cap is the provider's own per-minute output allowance, since
   * a request above it is rejected outright.
   */
  private outputBudget(label: string): number {
    const base = LlmEngine.OUTPUT_TOKENS[label] ?? 1800;
    const otpm = this.config.outputTokensPerMinute ?? Number(process.env.LLM_OUTPUT_TOKENS_PER_MINUTE ?? 0);
    return otpm > 0 ? Math.min(base, Math.floor(otpm * 0.9)) : base;
  }

  private async generate<S extends z.ZodTypeAny>(
    label: string,
    schema: S,
    system: string,
    prompt: string,
  ): Promise<z.infer<S> | null> {
    if (this.quotaExhausted) {
      // Already known to be out of provider quota; do not spend a call to
      // rediscover it.
      return null;
    }
    if (this.budget.remaining('llmCalls') <= 0 || this.budget.remaining('tokens') <= 0) {
      this.telemetry.emit('warning', `${label}: LLM budget exhausted, using deterministic fallback`, { agent: 'system' });
      return null;
    }

    const outcome = await withRetry(
      async () => {
        const model = await this.getModel();
        const maxOut = this.config.maxOutputTokens ?? this.outputBudget(label);
        await this.limiter.acquire(estimateTokens(system, prompt) + maxOut);
        await this.outputLimiter.acquire(maxOut);
        this.budget.spend('llmCalls');
        this.telemetry.emit('llm_call', `${label} -> ${this.config.provider}/${this.config.modelId}`, { agent: 'system' });
        const res = await generateStructured<z.infer<S>>({
          model,
          schema,
          system,
          prompt,
          maxOutputTokens: maxOut,
          temperature: this.config.temperature ?? 0.2,
        });
        this.limiter.record(res.inputTokens + res.outputTokens);
        this.outputLimiter.record(res.outputTokens);
        this.telemetry.countTokens(res.inputTokens, res.outputTokens);
        this.budget.spend('tokens', res.inputTokens + res.outputTokens);
        return res.object;
      },
      {
        policy: { maxAttempts: 2 },
        onRetry: (a, e) => this.telemetry.emit('warning', `${label} attempt ${a} failed: ${describeModelError(e)}`, { agent: 'system' }),
      },
    );

    if (outcome.value === null) {
      const detail = describeModelError(outcome.error);
      if (isUnrecoverableQuota(detail)) {
        this.quotaExhausted = detail;
        this.telemetry.emit(
          'warning',
          `provider quota exhausted for the rest of this run; continuing on the deterministic engine. ${detail.slice(0, 180)}`,
          { agent: 'system' },
        );
        return null;
      }
      // Name the actual cause. A bare "falling back" line makes a provider
      // rejecting the request look identical to the model reasoning badly.
      this.telemetry.emit(
        'warning',
        `${label} failed after ${outcome.attempts} attempt(s), falling back to the deterministic engine: ${detail}`,
        { agent: 'system' },
      );
      return null;
    }
    return outcome.value;
  }

  /* ------------------------------------------------------------------ plan */

  async plan(input: PlanInput): Promise<PlanOutput> {
    const system = `${SHARED_RULES}

You are the Orchestrator. Produce an investigation plan as a task graph.
Agents available: observability (logs, metrics), dependency (deploys, config, topology, history), reasoning, critic, reporting.
Put independent data-gathering tasks at the root with no dependencies so they execute in parallel. Reasoning depends on gathering; critique depends on reasoning.`;

    const prompt = input.round === 0
      ? `Incident: ${describeIncident(input.incident)}

Tools the agents can call:
${input.availableTools.map((t) => `- ${t.name}: ${t.description.split('.')[0]}`).join('\n')}

Produce the initial plan. Cover logs, metrics, deployments, configuration changes, topology and historical incidents, then correlation, hypothesis generation, scoring and critique.`
      : `Round ${input.round} replan. The critic named these gaps:
${(input.gaps ?? []).map((g, i) => `${i + 1}. ${g}`).join('\n')}

Evidence so far (${input.evidence?.length ?? 0} items):
${compactEvidence(input.evidence ?? [])}

Current hypotheses:
${(input.hypotheses ?? []).map((h) => `${h.id} [${h.confidence.toFixed(2)}] ${h.title}`).join('\n')}

Produce only the additional tasks that close these gaps. Do not repeat work already done.`;

    const out = await this.generate('plan', PlanSchema, system, prompt);
    if (!out) return this.fallback.plan(input);
    const tasks = coerceTaskish(out.tasks, this.telemetry, 'plan');
    if (tasks.length === 0) return this.fallback.plan(input);
    return {
      rationale: out.rationale,
      tasks: tasks.map((t) => ({
        id: t.id,
        kind: t.kind,
        agent: t.agent,
        description: t.description,
        params: toParams(t.params),
        dependsOn: t.dependsOn,
      })),
    };
  }

  /* ------------------------------------------------------------ hypothesise */

  async hypothesise(input: HypothesisInput): Promise<HypothesisOutput> {
    const system = `${SHARED_RULES}

You are the Reasoning agent. Build competing root-cause hypotheses.
Generate three or four genuinely different explanations, including one you consider weak, so the critic can compare them. Keep every statement to a single sentence and every rationale to a short phrase.
For every hypothesis, list the evidence that supports it AND the evidence that argues against it. A hypothesis with no contradicting evidence listed is usually a hypothesis you have not tested.`;

    const prompt = `Incident: ${describeIncident(input.incident)}

Estimated onset: ${input.onsetEstimate ?? 'unknown'}

Topology:
${input.topology.map((t) => `${t.service}: calls [${t.dependencies.join(', ')}]; called by [${t.dependents.join(', ')}]`).join('\n')}

Evidence:
${compactEvidence(selectEvidence(input.evidence, this.evidenceBudget))}

${input.existing.length ? `Existing hypotheses to refine rather than duplicate:\n${input.existing.map((h) => `${h.id} ${h.title}`).join('\n')}` : ''}

Also report any pair of evidence items that cannot both be true.`;

    const out = await this.generate('hypothesise', HypothesisSchema, system, prompt);
    if (!out) return this.fallback.hypothesise(input);

    // Drop any citation the model invented.
    const valid = new Set(input.evidence.map((e) => e.id));
    return {
      hypotheses: out.hypotheses.map((h) => ({
        ...h,
        supporting: h.supporting.filter((l) => valid.has(l.evidenceId)),
        contradicting: h.contradicting.filter((l) => valid.has(l.evidenceId)),
      })),
      contradictions: out.contradictions.filter((c) => c.evidenceIds.every((id) => valid.has(id))),
      notes: out.notes,
    };
  }

  /* ----------------------------------------------------------------- score */

  async score(input: ScoreInput): Promise<ScoreOutput> {
    const system = `${SHARED_RULES}

You are the Reasoning agent scoring hypotheses. Weigh:
- how much first-hand factual evidence supports each one, versus inference;
- whether the suspected cause can physically reach the observed symptoms;
- whether the cause precedes the effect;
- whether the evidence explains the mechanism or only the timing;
- corroboration across independent tools.
Be decisive where the evidence is decisive and uncertain where it is not. Confidence above 0.7 means you would act on it in production.`;

    const prompt = `Evidence:
${compactEvidence(selectEvidence(input.evidence, this.evidenceBudget))}

Hypotheses:
${input.hypotheses.map((h) => `${h.id} | ${h.category} | suspect=${h.suspectService} | ${h.statement}
  supporting: ${h.supporting.map((l) => l.evidenceId).join(', ') || 'none'}
  contradicting: ${h.contradicting.map((l) => l.evidenceId).join(', ') || 'none'}`).join('\n')}

Estimated onset: ${input.onsetEstimate ?? 'unknown'}
Evidence set known to be incomplete: ${input.degraded}

Score every hypothesis by id.`;

    const out = await this.generate('score', ScoreSchema, system, prompt);
    if (!out) return this.fallback.score(input);
    const valid = new Set(input.hypotheses.map((h) => h.id));
    return { scores: out.scores.filter((s) => valid.has(s.hypothesisId)) };
  }

  /* -------------------------------------------------------------- critique */

  async critique(input: CritiqueInput): Promise<CritiqueOutput> {
    const system = `${SHARED_RULES}

You are the Critic. Your job is to find the reason the current conclusion might be wrong, not to agree with it.
Challenge: unexamined alternatives, evidence sources never consulted, partial tool results treated as complete, conclusions resting on timing alone, and leading hypotheses too close to their runner-up to distinguish.
Choose "revise" and request specific further investigation when evidence is insufficient and rounds remain. Choose "inconclusive" when no further evidence is obtainable and the leading hypothesis is still weak. Choose "accept" only when you cannot mount a serious objection.`;

    const prompt = `Round ${input.round} of at most ${input.maxRounds}.

Evidence (${input.evidence.length} gathered, most load-bearing shown):
${compactEvidence(selectEvidence(input.evidence, Math.min(20, this.evidenceBudget)))}

Hypotheses, best first:
${[...input.hypotheses].sort((a, b) => b.confidence - a.confidence).slice(0, 6).map((h) => `${h.id} [${h.confidence.toFixed(2)}, ${h.status}] ${h.title}
  supporting: ${h.supporting.map((l) => l.evidenceId).join(', ') || 'none'}
  contradicting: ${h.contradicting.map((l) => l.evidenceId).join(', ') || 'none'}`).join('\n')}

Tools consulted: ${input.coverage.toolsQueried.join(', ') || 'none'}
Tools never consulted: ${input.coverage.allTools.filter((t) => !input.coverage.toolsQueried.includes(t)).join(', ') || 'none'}
Tools that only ever returned partial data: ${input.coverage.incompleteTools.join(', ') || 'none'}
Unresolved contradictions: ${input.contradictions.filter((c) => !c.resolved).map((c) => c.description).join(' | ') || 'none'}
Known degradations: ${input.degradations.join(' | ') || 'none'}`;

    const out = await this.generate('critique', CritiqueSchema, system, prompt);
    if (!out) return this.fallback.critique(input);

    return {
      verdict: {
        decision: out.decision,
        reasoning: out.reasoning,
        challenges: out.challenges,
        evidenceGaps: out.evidenceGaps,
        confidenceInTop: out.confidenceInTop,
      },
      requests: out.decision === 'revise'
        ? coerceTaskish(out.requests, this.telemetry, 'critique').map((r) => ({
            kind: r.kind,
            agent: r.agent,
            description: r.description,
            params: toParams(r.params),
            rationale: r.rationale,
          }))
        : [],
    };
  }

  /* ---------------------------------------------------------------- report */

  async report(input: ReportInput): Promise<ReportOutput> {
    const system = `${SHARED_RULES}

You are the Reporting agent. Write the investigation report for an on-call engineer who must act in the next five minutes.
Separate facts from assumptions explicitly. State confidence honestly. If the evidence does not support naming a cause, say the investigation is inconclusive and say what would resolve it.
Recommended actions must be concrete and must say which hypothesis they presume.`;

    const ranked = [...input.hypotheses].sort((a, b) => b.confidence - a.confidence);
    const prompt = `Incident: ${describeIncident(input.incident)}

Ranked hypotheses:
${ranked.slice(0, 5).map((h, i) => `#${i + 1} ${h.id} [${h.confidence.toFixed(2)}, ${h.status}] ${h.title}
  ${h.statement}
  supporting: ${h.supporting.map((l) => l.evidenceId).join(', ') || 'none'}
  contradicting: ${h.contradicting.map((l) => l.evidenceId).join(', ') || 'none'}`).join('\n')}

Evidence:
${compactEvidence(selectEvidence(input.evidence, Math.min(22, this.evidenceBudget)))}

Critic verdict: ${input.verdict ? `${input.verdict.decision} — ${input.verdict.reasoning}` : 'none recorded'}
Outstanding gaps: ${input.verdict?.evidenceGaps.join(' | ') || 'none'}
Degradations during the investigation: ${input.degradations.join(' | ') || 'none'}
Investigation stopped because: ${input.terminationReason}`;

    const out = await this.generate('report', ReportSchema, system, prompt);
    if (!out) return this.fallback.report(input);
    return { ...out, verdict: reconcileVerdict(out.verdict, ranked[0]?.confidence ?? 0, this.telemetry) };
  }
}

/**
 * Keeps the headline verdict consistent with the scored evidence.
 *
 * A model will occasionally write "inconclusive" above a hypothesis it has
 * just scored at 0.78, or claim a root cause above one scored at 0.2. The
 * confidence came from an explicit evidence-weighing step, so it is the more
 * trustworthy of the two; a report that contradicts itself is worse than
 * either answer alone.
 */
function reconcileVerdict(
  stated: ReportOutput['verdict'],
  topConfidence: number,
  telemetry: Telemetry,
): ReportOutput['verdict'] {
  const implied: ReportOutput['verdict'] =
    topConfidence >= 0.7 ? 'root_cause_identified'
      : topConfidence >= 0.35 ? 'probable_cause'
        : 'inconclusive';

  // Only override a frank contradiction; a one-step difference is a judgement
  // call the model is entitled to make.
  const rank = { inconclusive: 0, probable_cause: 1, root_cause_identified: 2 } as const;
  if (Math.abs(rank[stated] - rank[implied]) < 2) return stated;

  telemetry.emit(
    'warning',
    `report verdict "${stated}" contradicts the leading hypothesis at ${topConfidence.toFixed(2)}; reporting "${implied}" instead`,
    { agent: 'reporting' },
  );
  return implied;
}

/**
 * Distinguishes a limit that will clear in seconds from one that will not.
 *
 * A per-minute cap is worth waiting out; a per-day cap is not, and retrying
 * into it turns one informative failure into one per reasoning step.
 *
 * The match is on the *stated limit type* only. Providers append marketing to
 * these messages — "Need more tokens? Upgrade at .../settings/billing" — and
 * matching loose words like "billing" or "credit" anywhere in the body makes
 * every transient per-minute limit look permanent, which silently disables the
 * model for the rest of the run.
 */
export function isUnrecoverableQuota(detail: string): boolean {
  const d = detail.toLowerCase();
  if (!d.includes('429') && !d.includes('rate limit') && !d.includes('quota')) return false;
  // Drop the upsell footer before deciding.
  const body = d.split(/need more|upgrade to|upgrade at|visit https?:/)[0] ?? d;
  // Latch off only on an explicitly long window. Anything else — per-minute,
  // per-second, or a limit type we do not recognise — is assumed recoverable:
  // treating an unknown limit as permanent costs the whole run, while treating
  // a permanent one as transient costs a single wasted retry.
  return /per (day|month)|\b[iota]?tpd\b|\brpd\b|\bdaily\b|\bmonthly\b|insufficient[_ ]quota|exceeded your current quota/.test(body);
}

/** Extracts the useful part of an AI SDK / provider error for the trace. */
function describeModelError(e: unknown): string {
  if (!e) return 'unknown error';
  const anyE = e as { responseBody?: string; statusCode?: number; name?: string; message?: string; cause?: unknown };
  const body = typeof anyE.responseBody === 'string' ? anyE.responseBody.replace(/\s+/g, ' ').slice(0, 300) : '';
  const parts = [
    anyE.name,
    anyE.statusCode ? `HTTP ${anyE.statusCode}` : '',
    anyE.message?.replace(/\s+/g, ' ').slice(0, 200),
    body,
  ].filter(Boolean);
  return parts.join(' | ') || String(e);
}

/** One compact line per incident, instead of a pretty-printed JSON blob. */
function describeIncident(i: { id: string; title: string; severity: string; reportedAt: string; window: { start: string; end: string }; affectedServices: string[]; symptoms: string[] }): string {
  return [
    `${i.id} [${i.severity}] ${i.title}`,
    `reported ${i.reportedAt}, window ${i.window.start} to ${i.window.end}`,
    `services named by the reporter (may be wrong or incomplete): ${i.affectedServices.join(', ')}`,
    `symptoms: ${i.symptoms.join('; ')}`,
  ].join('\n');
}

interface PromptEvidence {
  id: string; claim: string; type: string; reliability: string; services: string[];
  observedAt: string | null; tags: string[]; magnitude?: number | null;
  source: { tool: string; complete: boolean };
}

/**
 * Chooses which evidence a prompt carries when the ledger outgrows the budget.
 *
 * Ranked by how load-bearing an item is: first-hand facts over inference,
 * reliable over unreliable, specifically-tagged signals over generic ones,
 * complete sources over truncated ones. Ids are preserved exactly so citations
 * still resolve against the full ledger.
 */
function selectEvidence(evidence: PromptEvidence[], limit = MAX_EVIDENCE_IN_PROMPT): PromptEvidence[] {
  if (evidence.length <= limit) return evidence;
  const GENERIC = new Set(['error_log', 'error_spike', 'latency_spike', 'timeout_error', 'dependency_edge']);
  const score = (e: PromptEvidence): number => {
    let s = 0;
    s += e.type === 'fact' ? 3 : e.type === 'inference' ? 1.5 : 0;
    s += e.reliability === 'high' ? 1.5 : e.reliability === 'medium' ? 0.75 : 0;
    s += e.source.complete ? 0.5 : 0;
    s += e.tags.some((t) => !GENERIC.has(t) && !t.startsWith('metric:') && !t.startsWith('dir:') && !t.startsWith('ref:')) ? 2 : 0;
    s += e.observedAt ? 0.5 : 0;
    return s;
  };
  return [...evidence]
    .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One line per evidence item: dense enough to fit, complete enough to cite. */
function compactEvidence(evidence: PromptEvidence[]): string {
  if (evidence.length === 0) return '(none gathered)';
  return evidence
    .map((e) => `${e.id} [${e.type[0]}/${e.reliability[0]}${e.source.complete ? '' : '/PARTIAL'}] ${e.services.join(',') || '-'} @${(e.observedAt ?? '-').replace('T', ' ').replace('Z', '')} ${e.tags.filter((t) => !t.startsWith('metric:') && !t.startsWith('dir:')).join(',')} :: ${e.claim.slice(0, 180)}`)
    .join('\n');
}

export { compactEvidence, selectEvidence, reconcileVerdict };

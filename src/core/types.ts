import { z } from 'zod';

/* ===========================================================================
 * Shared vocabulary
 * ======================================================================== */

/** Closed set of root-cause categories. Agents must classify into one of these
 *  so that hypotheses from different agents are comparable and gradeable. */
export const RootCauseCategory = z.enum([
  'deployment_regression',
  'config_change',
  'feature_flag',
  'resource_exhaustion',
  'memory_leak',
  'connection_pool_exhaustion',
  'database_degradation',
  'schema_migration',
  'cache_failure',
  'thundering_herd',
  'dependency_failure',
  'third_party_outage',
  'rate_limit',
  'certificate_expiry',
  'dns_failure',
  'network_partition',
  'traffic_surge',
  'data_quality',
  'unknown',
]);
export type RootCauseCategory = z.infer<typeof RootCauseCategory>;

export const Severity = z.enum(['sev1', 'sev2', 'sev3', 'sev4']);
export type Severity = z.infer<typeof Severity>;

/** How much weight a piece of evidence should carry. */
export const Reliability = z.enum(['high', 'medium', 'low']);
export type Reliability = z.infer<typeof Reliability>;

/** The epistemic status of a statement. The report must never present an
 *  assumption as a fact; this field is what makes that checkable. */
export const EpistemicType = z.enum(['fact', 'inference', 'assumption']);
export type EpistemicType = z.infer<typeof EpistemicType>;

export const AgentName = z.enum([
  'orchestrator',
  'observability',
  'dependency',
  'reasoning',
  'critic',
  'reporting',
]);
export type AgentName = z.infer<typeof AgentName>;

/* ===========================================================================
 * Incident (system input)
 * ======================================================================== */

export const IncidentReport = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  severity: Severity,
  reportedAt: z.string(), // ISO-8601
  /** Inclusive window the reporter believes the incident spans. */
  window: z.object({ start: z.string(), end: z.string() }),
  /** Services the reporter *thinks* are affected. May be wrong or incomplete. */
  affectedServices: z.array(z.string()),
  symptoms: z.array(z.string()),
  reporter: z.string().default('oncall'),
});
export type IncidentReport = z.infer<typeof IncidentReport>;

/* ===========================================================================
 * Evidence
 * ======================================================================== */

export const EvidenceSource = z.object({
  tool: z.string(),
  /** The exact structured query issued, for provenance / reproducibility. */
  query: z.record(z.string(), z.unknown()),
  agent: AgentName,
  retrievedAt: z.string(),
  /** False when the tool returned partial data (timeout, truncation, sampling). */
  complete: z.boolean().default(true),
});
export type EvidenceSource = z.infer<typeof EvidenceSource>;

export const Evidence = z.object({
  id: z.string(),
  /** One-sentence, self-contained statement of what was observed. */
  claim: z.string(),
  type: EpistemicType,
  reliability: Reliability,
  /** Services this observation is about. */
  services: z.array(z.string()).default([]),
  /** When the observed phenomenon happened (not when it was retrieved). */
  observedAt: z.string().nullable().default(null),
  source: EvidenceSource,
  /** Signal tags used by downstream reasoning, e.g. 'error_spike', 'deploy'. */
  tags: z.array(z.string()).default([]),
  /** Numeric payload when the evidence is quantitative. */
  magnitude: z.number().nullable().default(null),
  /** Verbatim slice of tool output backing the claim. Never paraphrased. */
  raw: z.unknown().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/* ===========================================================================
 * Hypotheses
 * ======================================================================== */

export const EvidenceLink = z.object({
  evidenceId: z.string(),
  /** How strongly this evidence bears on the hypothesis, 0..1. */
  weight: z.number().min(0).max(1),
  rationale: z.string(),
});
export type EvidenceLink = z.infer<typeof EvidenceLink>;

export const Hypothesis = z.object({
  id: z.string(),
  title: z.string(),
  category: RootCauseCategory,
  /** The service believed to hold the root cause (not necessarily the one
   *  showing symptoms). */
  suspectService: z.string().nullable().default(null),
  statement: z.string(),
  supporting: z.array(EvidenceLink).default([]),
  contradicting: z.array(EvidenceLink).default([]),
  /** Checks that would discriminate this hypothesis from its rivals. Drives
   *  the critic's follow-up investigation requests. */
  testablePredictions: z.array(z.string()).default([]),
  /** 0..1 posterior after scoring. */
  confidence: z.number().min(0).max(1).default(0),
  status: z.enum(['open', 'supported', 'weakened', 'refuted']).default('open'),
  proposedBy: AgentName,
});
export type Hypothesis = z.infer<typeof Hypothesis>;

export const Contradiction = z.object({
  id: z.string(),
  description: z.string(),
  evidenceIds: z.array(z.string()),
  resolved: z.boolean().default(false),
  resolution: z.string().nullable().default(null),
});
export type Contradiction = z.infer<typeof Contradiction>;

/* ===========================================================================
 * Tasks (the unit the scheduler executes)
 * ======================================================================== */

export const TaskKind = z.enum([
  'scan_logs',
  'scan_metrics',
  'correlate_signals',
  'scan_deployments',
  'scan_config',
  'map_dependencies',
  'scan_historical',
  'generate_hypotheses',
  'score_hypotheses',
  'critique',
  'targeted_probe',
  'compose_report',
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskStatus = z.enum([
  'pending',
  'ready',
  'running',
  'done',
  'failed',
  'skipped',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  id: z.string(),
  kind: TaskKind,
  agent: AgentName,
  description: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string()).default([]),
  status: TaskStatus.default('pending'),
  attempts: z.number().int().default(0),
  maxAttempts: z.number().int().default(2),
  /** Investigation round that created this task (0 = initial plan). */
  round: z.number().int().default(0),
  priority: z.number().int().default(5),
  error: z.string().nullable().default(null),
  startedAt: z.number().nullable().default(null),
  endedAt: z.number().nullable().default(null),
});
export type Task = z.infer<typeof Task>;

/* ===========================================================================
 * Agent results
 * ======================================================================== */

export const AgentResult = z.object({
  taskId: z.string(),
  agent: AgentName,
  ok: z.boolean(),
  /** Evidence contributed to the shared ledger. */
  evidence: z.array(Evidence).default([]),
  hypotheses: z.array(Hypothesis).default([]),
  contradictions: z.array(Contradiction).default([]),
  /** Free-form notes surfaced in the trace, not used as evidence. */
  notes: z.array(z.string()).default([]),
  /** Follow-up work this agent believes is needed. The orchestrator decides. */
  requests: z
    .array(
      z.object({
        kind: TaskKind,
        agent: AgentName,
        description: z.string(),
        params: z.record(z.string(), z.unknown()).default({}),
        rationale: z.string(),
      }),
    )
    .default([]),
  /** Degraded = produced output but with known gaps (e.g. tool partial data). */
  degraded: z.boolean().default(false),
  error: z.string().nullable().default(null),
});
export type AgentResult = z.infer<typeof AgentResult>;

/* ===========================================================================
 * Critic verdict
 * ======================================================================== */

export const CriticVerdict = z.object({
  /** accept = stop; revise = run follow-up tasks; inconclusive = stop, say so. */
  decision: z.enum(['accept', 'revise', 'inconclusive']),
  reasoning: z.string(),
  /** Specific, named weaknesses in the current conclusion. */
  challenges: z.array(
    z.object({
      hypothesisId: z.string().nullable(),
      issue: z.string(),
      severity: z.enum(['blocking', 'major', 'minor']),
    }),
  ).default([]),
  /** Evidence the critic wants before it will accept. */
  evidenceGaps: z.array(z.string()).default([]),
  confidenceInTop: z.number().min(0).max(1),
});
export type CriticVerdict = z.infer<typeof CriticVerdict>;

/* ===========================================================================
 * Final report
 * ======================================================================== */

export const RemediationAction = z.object({
  action: z.string(),
  type: z.enum(['immediate_mitigation', 'verification', 'permanent_fix', 'preventive']),
  targetService: z.string().nullable().default(null),
  rationale: z.string(),
  /** Which hypothesis this action presumes. Lets a reader discount actions
   *  that depend on a low-confidence hypothesis. */
  predicatedOn: z.string().nullable().default(null),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type RemediationAction = z.infer<typeof RemediationAction>;

export const InvestigationReport = z.object({
  incidentId: z.string(),
  verdict: z.enum(['root_cause_identified', 'probable_cause', 'inconclusive']),
  summary: z.string(),
  /** Ranked, highest confidence first. */
  rankedHypotheses: z.array(
    z.object({
      rank: z.number().int(),
      hypothesis: Hypothesis,
      supportingEvidence: z.array(Evidence),
      contradictingEvidence: z.array(Evidence),
      confidenceLabel: z.enum(['high', 'moderate', 'low', 'speculative']),
    }),
  ),
  /** Statements the system treats as established. */
  facts: z.array(z.string()).default([]),
  /** Statements the system had to assume. Explicitly separated from facts. */
  assumptions: z.array(z.string()).default([]),
  unresolvedContradictions: z.array(Contradiction).default([]),
  evidenceGaps: z.array(z.string()).default([]),
  recommendedActions: z.array(RemediationAction).default([]),
  /** Reasons the investigation stopped. */
  terminationReason: z.string(),
  degradations: z.array(z.string()).default([]),
});
export type InvestigationReport = z.infer<typeof InvestigationReport>;

/* ===========================================================================
 * Run metrics (consumed by the evaluation harness)
 * ======================================================================== */

export interface RunMetrics {
  approach: 'multi-agent' | 'single-agent';
  incidentId: string;
  wallClockMs: number;
  toolCalls: number;
  toolFailures: number;
  toolRetries: number;
  tokensIn: number;
  tokensOut: number;
  llmCalls: number;
  agentTasksRun: number;
  agentTaskFailures: number;
  rounds: number;
  evidenceCount: number;
  hypothesesConsidered: number;
  terminationReason: string;
}

export interface InvestigationOutcome {
  report: InvestigationReport;
  metrics: RunMetrics;
  trace: TraceEvent[];
  evidence: Evidence[];
}

/* ===========================================================================
 * Tracing
 * ======================================================================== */

export interface TraceEvent {
  t: number;
  seq: number;
  kind:
    | 'run_start'
    | 'run_end'
    | 'plan'
    | 'replan'
    | 'task_start'
    | 'task_end'
    | 'task_retry'
    | 'task_failed'
    | 'tool_call'
    | 'tool_result'
    | 'tool_error'
    | 'llm_call'
    | 'evidence'
    | 'hypothesis'
    | 'contradiction'
    | 'critic'
    | 'terminate'
    | 'warning';
  agent?: AgentName | 'system';
  message: string;
  data?: Record<string, unknown>;
}

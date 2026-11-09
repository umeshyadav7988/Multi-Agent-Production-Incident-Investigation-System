import type {
  IncidentReport, Evidence, Hypothesis, Contradiction, CriticVerdict,
  AgentResult, TaskKind, AgentName, RootCauseCategory, RemediationAction,
} from '../types.ts';

export interface TaskSpec {
  id?: string;
  kind: TaskKind;
  agent: AgentName;
  description: string;
  params?: Record<string, unknown>;
  dependsOn?: string[];
  priority?: number;
}

export interface PlanInput {
  incident: IncidentReport;
  availableTools: { name: string; description: string }[];
  round: number;
  /** Present on replans: what is known so far. */
  evidence?: Evidence[];
  hypotheses?: Hypothesis[];
  gaps?: string[];
}
export interface PlanOutput {
  rationale: string;
  tasks: TaskSpec[];
}

export interface HypothesisInput {
  incident: IncidentReport;
  evidence: Evidence[];
  existing: Hypothesis[];
  /** Topology slices gathered by the Dependency agent. */
  topology: { service: string; dependencies: string[]; dependents: string[]; critical: string[] }[];
  /** Best estimate of when the incident began, derived from evidence. */
  onsetEstimate: string | null;
}
export interface HypothesisOutput {
  hypotheses: Array<{
    title: string;
    category: RootCauseCategory;
    suspectService: string | null;
    statement: string;
    supporting: { evidenceId: string; weight: number; rationale: string }[];
    contradicting: { evidenceId: string; weight: number; rationale: string }[];
    testablePredictions: string[];
  }>;
  contradictions: { description: string; evidenceIds: string[] }[];
  notes: string[];
}

export interface ScoreInput {
  incident: IncidentReport;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  onsetEstimate: string | null;
  degraded: boolean;
}
export interface ScoreOutput {
  scores: { hypothesisId: string; confidence: number; status: Hypothesis['status']; reasoning: string }[];
}

export interface CritiqueInput {
  incident: IncidentReport;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  contradictions: Contradiction[];
  coverage: { toolsQueried: string[]; allTools: string[]; incompleteTools: string[] };
  round: number;
  maxRounds: number;
  degradations: string[];
}
export interface CritiqueOutput {
  verdict: CriticVerdict;
  requests: AgentResult['requests'];
}

export interface ReportInput {
  incident: IncidentReport;
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  contradictions: Contradiction[];
  verdict: CriticVerdict | null;
  degradations: string[];
  terminationReason: string;
}
export interface ReportOutput {
  verdict: 'root_cause_identified' | 'probable_cause' | 'inconclusive';
  summary: string;
  facts: string[];
  assumptions: string[];
  evidenceGaps: string[];
  recommendedActions: RemediationAction[];
}

/** Single-agent baseline: one model, same tools, no decomposition. */
export interface BaselineInput {
  incident: IncidentReport;
  evidence: Evidence[];
  tools: { name: string; description: string }[];
  degradations: string[];
}

/**
 * The cognition boundary.
 *
 * Two implementations exist: a deterministic rule engine (offline, free,
 * reproducible — used by CI and by every regression test) and a real LLM.
 * Both the multi-agent system and the single-agent baseline run against the
 * same engine, so an A/B comparison isolates orchestration from model quality.
 */
export interface ReasoningEngine {
  readonly name: 'heuristic' | 'llm';
  plan(input: PlanInput): Promise<PlanOutput>;
  hypothesise(input: HypothesisInput): Promise<HypothesisOutput>;
  score(input: ScoreInput): Promise<ScoreOutput>;
  critique(input: CritiqueInput): Promise<CritiqueOutput>;
  report(input: ReportInput): Promise<ReportOutput>;
}

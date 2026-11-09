import type { RootCauseCategory, Severity } from '../core/types.ts';

/* ===========================================================================
 * Rendered world: what the tools actually query
 * ======================================================================== */

export interface LogEntry {
  ts: string;
  service: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  traceId: string;
  attrs: Record<string, string | number | boolean>;
}

export interface MetricPoint {
  ts: string;
  value: number;
}

export interface MetricSeries {
  service: string;
  metric: string;
  unit: string;
  points: MetricPoint[];
}

export interface Deployment {
  id: string;
  service: string;
  version: string;
  deployedAt: string;
  author: string;
  changes: string[];
  strategy: 'rolling' | 'canary' | 'blue_green' | 'hotfix';
  /** Percentage of fleet the deploy had reached. Canary at 5% is weak evidence
   *  for a 100%-of-traffic symptom; agents must weigh this. */
  rolloutPct: number;
  rolledBackAt: string | null;
}

export interface ConfigChange {
  id: string;
  service: string;
  changedAt: string;
  key: string;
  from: string;
  to: string;
  author: string;
  kind: 'env' | 'feature_flag' | 'infra' | 'secret' | 'schema' | 'limit';
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: 'sync_http' | 'sync_grpc' | 'async_queue' | 'database' | 'cache' | 'third_party';
  critical: boolean;
  /** Typical healthy call rate, used to judge whether a spike is meaningful. */
  baselineRps: number;
  timeoutMs: number;
}

export interface ServiceInfo {
  name: string;
  tier: 'edge' | 'application' | 'data' | 'infrastructure' | 'external';
  owner: string;
  runtime: string;
}

export interface HistoricalIncident {
  id: string;
  title: string;
  occurredAt: string;
  services: string[];
  category: RootCauseCategory;
  rootCause: string;
  resolution: string;
  symptoms: string[];
  timeToResolveMin: number;
}

export interface World {
  scenarioId: string;
  services: ServiceInfo[];
  logs: LogEntry[];
  metrics: MetricSeries[];
  deployments: Deployment[];
  configChanges: ConfigChange[];
  dependencies: DependencyEdge[];
  historical: HistoricalIncident[];
}

/* ===========================================================================
 * Scenario specification: the authored description of what happened
 * ======================================================================== */

export type SignalSpec =
  | {
      type: 'error_burst';
      service: string;
      startOffsetMin: number;
      durationMin: number;
      /** errors per minute at peak */
      peakPerMin: number;
      message: string;
      level?: 'error' | 'fatal' | 'warn';
      attrs?: Record<string, string | number | boolean>;
      shape?: 'step' | 'ramp' | 'spike_decay';
    }
  | {
      type: 'metric_shift';
      service: string;
      metric: string;
      unit?: string;
      baseline: number;
      peak: number;
      startOffsetMin: number;
      /** null = never recovers within the window */
      recoverOffsetMin?: number | null;
      shape?: 'step' | 'ramp' | 'sawtooth' | 'spike_decay';
      noise?: number;
    }
  | {
      type: 'deploy';
      service: string;
      offsetMin: number;
      version: string;
      changes: string[];
      author?: string;
      strategy?: Deployment['strategy'];
      rolloutPct?: number;
      rolledBackOffsetMin?: number | null;
    }
  | {
      type: 'config_change';
      service: string;
      offsetMin: number;
      key: string;
      from: string;
      to: string;
      author?: string;
      kind?: ConfigChange['kind'];
    }
  | {
      type: 'log_line';
      service: string;
      offsetMin: number;
      level: LogEntry['level'];
      message: string;
      count?: number;
      attrs?: Record<string, string | number | boolean>;
    };

export interface ScenarioSpec {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  /** Minutes before `reportedAt` that the incident actually began. */
  onsetMinutesBeforeReport: number;
  reportedAt: string;
  windowBeforeMin: number;
  windowAfterMin: number;
  affectedServices: string[];
  symptoms: string[];
  /** Topology for this scenario, merged with the shared base topology. */
  extraDependencies?: DependencyEdge[];
  signals: SignalSpec[];
  historical?: HistoricalIncident[];
  /** Tools forced to misbehave, exercising the recovery paths. */
  forcedToolFaults?: {
    tool: string;
    mode: 'timeout' | 'partial_result' | 'unavailable' | 'corrupt_data';
    /** 0..1 chance per call; 1 = always */
    probability: number;
    /** Stop failing after this many calls so the run can still make progress. */
    maxOccurrences?: number;
  }[];
  traits: Array<
    | 'misleading_evidence'
    | 'conflicting_observations'
    | 'tool_failure'
    | 'incomplete_data'
    | 'multi_service'
    | 'red_herring_deploy'
    | 'insufficient_evidence'
  >;
  /** Grading key. Never exposed to any agent or prompt. */
  truth: {
    category: RootCauseCategory;
    /** Service holding the root cause, not necessarily the symptomatic one. */
    service: string;
    narrative: string;
    /** Categories also accepted as correct (genuinely equivalent framings). */
    alsoAcceptable?: RootCauseCategory[];
    /** Substrings that must appear in cited evidence for full grounding credit. */
    requiredEvidenceMarkers: string[];
    /** True when the honest answer is "not enough evidence". */
    expectInconclusive?: boolean;
  };
}

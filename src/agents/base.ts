import type { Task, AgentResult, AgentName, Evidence, EpistemicType, Reliability } from '../core/types.ts';
import type { Blackboard } from '../core/blackboard.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ReasoningEngine } from '../core/llm/engine.ts';
import type { Budget } from '../core/budget.ts';
import type { Telemetry } from '../core/telemetry.ts';
import { TAG } from '../core/tags.ts';

export interface AgentDeps {
  tools: ToolRegistry;
  engine: ReasoningEngine;
  budget: Budget;
  telemetry: Telemetry;
  maxRounds: number;
}

export interface Agent {
  readonly name: AgentName;
  readonly handles: Task['kind'][];
  run(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult>;
}

export function emptyResult(task: Task, agent: AgentName): AgentResult {
  return {
    taskId: task.id, agent, ok: true,
    evidence: [], hypotheses: [], contradictions: [], notes: [], requests: [],
    degraded: false, error: null,
  };
}

export interface EvidenceDraft {
  claim: string;
  type?: EpistemicType;
  reliability?: Reliability;
  services?: string[];
  observedAt?: string | null;
  tags?: string[];
  magnitude?: number | null;
  raw?: unknown;
}

/** Builds a provenance-carrying evidence record. Every field a downstream
 *  agent might weigh — reliability, completeness, which query produced it — is
 *  filled here so no later step has to guess. */
export function makeEvidence(
  draft: EvidenceDraft,
  source: { tool: string; query: Record<string, unknown>; agent: AgentName; complete: boolean },
): Evidence {
  return {
    id: '',
    claim: draft.claim,
    type: draft.type ?? 'fact',
    reliability: draft.reliability ?? (source.complete ? 'high' : 'medium'),
    services: draft.services ?? [],
    observedAt: draft.observedAt ?? null,
    tags: [...new Set([...(draft.tags ?? []), ...(source.complete ? [] : [TAG.INCOMPLETE])])],
    magnitude: draft.magnitude ?? null,
    source: {
      tool: source.tool,
      query: source.query,
      agent: source.agent,
      retrievedAt: new Date().toISOString(),
      complete: source.complete,
    },
    ...(draft.raw !== undefined ? { raw: draft.raw } : {}),
  };
}

/* ========================================================================= */
/* Signal extraction from free text                                           */
/* ========================================================================= */

interface Pattern {
  re: RegExp;
  tags: string[];
}

/** Maps observed text to the shared tag vocabulary. These are generic failure
 *  signatures, not incident-specific strings. */
const TEXT_PATTERNS: Pattern[] = [
  { re: /out ?of ?memory|oomkilled|heap space|exit 137/i, tags: [TAG.OOM, TAG.SATURATION] },
  { re: /restart(ing|ed)?\b|container restarted|pod restart/i, tags: [TAG.RESTART] },
  { re: /x509|certificate has expired|bad certificate|tls: failed to verify/i, tags: [TAG.CERT_ERROR] },
  { re: /no such host|dns|lookup .+ on .+:53|resolv/i, tags: [TAG.DNS_ERROR] },
  { re: /\b429\b|too many requests|rate ?limit|quota (reached|exhausted|exceeded)|x-ratelimit/i, tags: [TAG.RATE_LIMITED] },
  { re: /connection (is )?not available|hikari|pool (size|exhaust)|no connections available|pool timeout/i, tags: [TAG.POOL_SATURATION] },
  { re: /\block\b|sharelock|access exclusive|waiting for .*lock|deadlock/i, tags: [TAG.LOCK_WAIT] },
  { re: /timed? ?out|deadline exceeded|timeout/i, tags: [TAG.TIMEOUT] },
  { re: /cache miss|miss storm|maxmemory|eviction|evict|OOM command not allowed|keyspace flushed/i, tags: [TAG.CACHE_MISS] },
  { re: /circuit breaker (open|opened)/i, tags: [TAG.UPSTREAM_UNHEALTHY] },
  { re: /migration .*(started|running)|alter table|add column|create index/i, tags: [TAG.SCHEMA_CHANGE] },
  { re: /\b5\d\d\b|service unavailable|internal server error|nullpointer|exception|panic/i, tags: [TAG.ERROR_LOG] },
  { re: /queue (depth|backlog)|consumer lag|unacked/i, tags: [TAG.QUEUE_BACKLOG] },
  { re: /replica lag|replication delay|stale read/i, tags: [TAG.REPLICA_LAG] },
  { re: /flag |rollout|variant|feature[_ ]flag/i, tags: [TAG.FEATURE_FLAG] },
];

export function tagsFromText(text: string): string[] {
  const out = new Set<string>();
  for (const p of TEXT_PATTERNS) if (p.re.test(text)) for (const t of p.tags) out.add(t);
  return [...out];
}

/** Finds a service name mentioned inside free text, used to attribute a fault
 *  to the upstream it names rather than to the service that logged it. */
export function referencedServiceIn(
  text: string,
  attrs: Record<string, string | number | boolean> | undefined,
  knownServices: string[],
  exclude?: string,
): string | null {
  const up = attrs?.upstream ?? attrs?.backend ?? attrs?.target;
  if (typeof up === 'string' && knownServices.includes(up) && up !== exclude) return up;
  const lower = text.toLowerCase();
  const hits = knownServices
    .filter((s) => s !== exclude && lower.includes(s.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (hits[0]) return hits[0];
  // Match a bare provider name ("stripe", "auth0") against "<name>-api".
  for (const s of knownServices) {
    if (s === exclude) continue;
    const stem = s.replace(/-(api|service|cache|broker|primary|replica|edge)$/, '');
    if (stem.length >= 4 && lower.includes(stem.toLowerCase())) return s;
  }
  return null;
}

export function iso(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

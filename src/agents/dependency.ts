import type { Agent, AgentDeps } from './base.ts';
import { emptyResult, makeEvidence, tagsFromText } from './base.ts';
import type { Task, AgentResult } from '../core/types.ts';
import type { Blackboard } from '../core/blackboard.ts';
import { TAG } from '../core/tags.ts';
import type { TopologySlice } from './observability.ts';

interface DeployResult {
  count: number; searchedFrom: string; searchedTo: string;
  deployments: { id: string; service: string; version: string; deployedAt: string; author: string; changes: string[]; strategy: string; rolloutPct: number; rolledBackAt: string | null }[];
}
interface ConfigResult {
  count: number; searchedFrom: string; searchedTo: string;
  changes: { id: string; service: string; changedAt: string; key: string; from: string; to: string; author: string; kind: string }[];
}
interface DepResult {
  service: string;
  edges: { from: string; to: string; kind: string; critical: boolean; baselineRps: number; timeoutMs: number; hops: number }[];
  dependencies: string[]; dependents: string[]; criticalDependencies: string[]; reachable: string[];
}
interface HistResult {
  count: number;
  matches: { id: string; title: string; occurredAt: string; services: string[]; category: string; rootCause: string; resolution: string; symptoms: string[]; timeToResolveMin: number; similarity: number; matchedOn: string[] }[];
}

/**
 * Dependency agent — owns everything a human changed, plus the topology that
 * decides whether a change could reach the symptoms.
 *
 * Its most valuable output is often negative: a confirmed empty change log is
 * what makes a certificate expiry or an upstream outage the leading candidate.
 */
export class DependencyAgent implements Agent {
  readonly name = 'dependency' as const;
  readonly handles: Task['kind'][] = ['scan_deployments', 'scan_config', 'map_dependencies', 'scan_historical'];

  async run(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    switch (task.kind) {
      case 'scan_deployments': return this.deployments(task, bb, deps);
      case 'scan_config': return this.config(task, bb, deps);
      case 'map_dependencies': return this.topology(task, bb, deps);
      case 'scan_historical': return this.historical(task, bb, deps);
      default: {
        const r = emptyResult(task, this.name);
        r.ok = false;
        r.error = `dependency agent cannot handle ${task.kind}`;
        return r;
      }
    }
  }

  /* --------------------------------------------------- scan_deployments */

  private async deployments(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const lookback = (task.params.lookbackMinutes as number | undefined) ?? 240;
    const services = task.params.services as string[] | undefined;
    const q: Record<string, unknown> = { lookbackMinutes: lookback, ...(services?.length ? { services } : {}) };

    const env = await deps.tools.call<DeployResult>('query_deployments', q, this.name);
    bb.recordCoverage('query_deployments', JSON.stringify(q), env.complete);

    if (!env.ok || !env.data) {
      res.notes.push(`query_deployments failed (${env.error?.code}): ${env.error?.message}`);
      res.degraded = true;
      bb.addDegradation(`deployment history unavailable: ${env.error?.message}`);
      res.ok = env.error?.retryable === false ? true : false;
      if (!res.ok) res.error = env.error?.message ?? 'query_deployments failed';
      return res;
    }
    if (!env.complete) {
      res.degraded = true;
      bb.addDegradation('deployment history returned a partial result');
    }

    for (const d of env.data.deployments) {
      const partial = d.rolloutPct < 100;
      res.evidence.push(
        makeEvidence(
          {
            claim: `${d.service} deployed ${d.version} at ${d.deployedAt} by ${d.author}${partial ? ` (${d.strategy}, only ${d.rolloutPct}% of the fleet)` : ''}: ${d.changes.join('; ')}${d.rolledBackAt ? ` — rolled back at ${d.rolledBackAt}` : ''}`,
            type: 'fact',
            reliability: partial ? 'medium' : 'high',
            services: [d.service],
            observedAt: d.deployedAt,
            tags: [TAG.DEPLOY, ...(d.rolledBackAt ? [TAG.DEPLOY_ROLLBACK] : []), ...tagsFromText(d.changes.join(' '))],
            magnitude: d.rolloutPct,
            raw: d,
          },
          { tool: 'query_deployments', query: q, agent: this.name, complete: env.complete },
        ),
      );
    }

    if (env.data.count === 0) {
      res.evidence.push(
        makeEvidence(
          {
            claim: `No deployment occurred on any service between ${env.data.searchedFrom} and ${env.data.searchedTo} (${lookback} minute lookback)`,
            type: 'fact',
            reliability: env.complete ? 'high' : 'low',
            tags: [TAG.NO_CHANGE_FOUND],
            raw: { searchedFrom: env.data.searchedFrom, searchedTo: env.data.searchedTo, lookbackMinutes: lookback },
          },
          { tool: 'query_deployments', query: q, agent: this.name, complete: env.complete },
        ),
      );
      if (lookback < 1440) {
        res.requests.push({
          kind: 'scan_deployments', agent: 'dependency',
          description: 'Widen the deployment search to 48 hours',
          params: { lookbackMinutes: 2880 },
          rationale: 'Nothing shipped inside the window; a slow-burn fault may trace to an older release',
        });
      }
    }

    return res;
  }

  /* -------------------------------------------------------- scan_config */

  private async config(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const lookback = (task.params.lookbackMinutes as number | undefined) ?? 240;
    const services = task.params.services as string[] | undefined;
    const q: Record<string, unknown> = { lookbackMinutes: lookback, ...(services?.length ? { services } : {}) };

    const env = await deps.tools.call<ConfigResult>('query_config_changes', q, this.name);
    bb.recordCoverage('query_config_changes', JSON.stringify(q), env.complete);

    if (!env.ok || !env.data) {
      res.notes.push(`query_config_changes failed (${env.error?.code}): ${env.error?.message}`);
      res.degraded = true;
      bb.addDegradation(`configuration history unavailable: ${env.error?.message}`);
      return res;
    }
    if (!env.complete) {
      res.degraded = true;
      bb.addDegradation('configuration history returned a partial result');
    }

    for (const c of env.data.changes) {
      res.evidence.push(
        makeEvidence(
          {
            claim: `Configuration change on ${c.service} at ${c.changedAt} by ${c.author}: ${c.key} changed from "${c.from}" to "${c.to}" (${c.kind})`,
            type: 'fact',
            services: [c.service],
            observedAt: c.changedAt,
            tags: [TAG.CONFIG_CHANGE, ...kindTags(c.kind), ...tagsFromText(`${c.key} ${c.from} ${c.to}`)],
            raw: c,
          },
          { tool: 'query_config_changes', query: q, agent: this.name, complete: env.complete },
        ),
      );
    }

    if (env.data.count === 0) {
      res.evidence.push(
        makeEvidence(
          {
            claim: `No configuration, feature-flag, limit or schema change was recorded between ${env.data.searchedFrom} and ${env.data.searchedTo}`,
            type: 'fact',
            reliability: env.complete ? 'high' : 'low',
            tags: [TAG.NO_CHANGE_FOUND],
            raw: { lookbackMinutes: lookback },
          },
          { tool: 'query_config_changes', query: q, agent: this.name, complete: env.complete },
        ),
      );
    }

    return res;
  }

  /* --------------------------------------------------- map_dependencies */

  private async topology(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const services = ((task.params.services as string[] | undefined) ?? bb.incident.affectedServices).slice(0, 6);

    // Independent graph walks: issue them concurrently.
    const envs = await Promise.all(
      services.map((service) => {
        const q = { service, direction: 'both' as const, depth: 2 };
        return deps.tools.call<DepResult>('query_dependencies', q, this.name).then((env) => ({ env, q, service }));
      }),
    );

    let anyOk = false;
    for (const { env, q, service } of envs) {
      bb.recordCoverage('query_dependencies', JSON.stringify(q), env.complete);
      if (!env.ok || !env.data) {
        res.notes.push(`query_dependencies(${service}) failed: ${env.error?.message}`);
        res.degraded = true;
        continue;
      }
      anyOk = true;
      const d = env.data;
      const slice: TopologySlice = {
        service: d.service,
        dependencies: d.dependencies,
        dependents: d.dependents,
        critical: d.criticalDependencies,
        edges: d.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, critical: e.critical })),
      };
      res.evidence.push(
        makeEvidence(
          {
            claim: `${d.service} calls [${d.dependencies.join(', ') || 'nothing'}] (critical: ${d.criticalDependencies.join(', ') || 'none'}) and is called by [${d.dependents.join(', ') || 'nothing'}]`,
            type: 'fact',
            services: [d.service],
            tags: [TAG.DEPENDENCY_EDGE],
            raw: slice,
          },
          { tool: 'query_dependencies', query: q, agent: this.name, complete: env.complete },
        ),
      );
    }

    if (!anyOk) {
      res.degraded = true;
      bb.addDegradation('service topology unavailable; blast-radius reasoning is unverified');
      res.evidence.push(
        makeEvidence(
          { claim: 'Service dependency graph could not be retrieved; upstream/downstream reasoning is unsupported for this investigation', type: 'fact', tags: [TAG.NO_SIGNAL, TAG.INCOMPLETE] },
          { tool: 'query_dependencies', query: {}, agent: this.name, complete: false },
        ),
      );
    }

    return res;
  }

  /* ----------------------------------------------------- scan_historical */

  private async historical(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const q = {
      symptoms: [...bb.incident.symptoms, bb.incident.title],
      services: bb.incident.affectedServices,
      limit: 5,
    };

    const env = await deps.tools.call<HistResult>('query_historical_incidents', q, this.name);
    bb.recordCoverage('query_historical_incidents', JSON.stringify(q), env.complete);

    if (!env.ok || !env.data) {
      res.notes.push(`query_historical_incidents failed: ${env.error?.message}`);
      res.degraded = true;
      return res;
    }

    for (const m of env.data.matches) {
      if (m.similarity < 0.12) continue;
      res.evidence.push(
        makeEvidence(
          {
            claim: `Prior incident ${m.id} (${m.occurredAt}) with similarity ${m.similarity} had the cause "${m.rootCause}" and was resolved by "${m.resolution}"`,
            // A past incident is a prior, never an observation about this one.
            type: 'inference',
            reliability: m.similarity > 0.3 ? 'medium' : 'low',
            services: m.services,
            tags: [TAG.HISTORICAL_MATCH, `category:${m.category}`],
            magnitude: m.similarity,
            raw: m,
          },
          { tool: 'query_historical_incidents', query: q, agent: this.name, complete: env.complete },
        ),
      );
    }

    if (env.data.matches.length === 0) {
      res.notes.push('no prior incident resembles this one; there is no precedent to lean on');
    }

    return res;
  }
}

function kindTags(kind: string): string[] {
  switch (kind) {
    case 'feature_flag': return [TAG.FEATURE_FLAG];
    case 'schema': return [TAG.SCHEMA_CHANGE];
    case 'limit': return [TAG.LIMIT_CHANGE];
    case 'infra': return [TAG.INFRA_CHANGE];
    default: return [];
  }
}

import type { Agent, AgentDeps } from './base.ts';
import { emptyResult, makeEvidence, tagsFromText, referencedServiceIn, fmtNum } from './base.ts';
import type { Task, AgentResult, Evidence } from '../core/types.ts';
import type { Blackboard } from '../core/blackboard.ts';
import { TAG } from '../core/tags.ts';

interface LogsResult {
  total: number;
  returned: number;
  entries: { ts: string; service: string; level: string; message: string; attrs: Record<string, string | number | boolean> }[];
  byService: Record<string, number>;
  byLevel: Record<string, number>;
  topMessages: { pattern: string; count: number; services: string[]; firstSeen: string; lastSeen: string; sample: string; level: string }[];
}

interface MetricsResult {
  series: {
    service: string; metric: string; unit: string; pointCount: number;
    stats: { min: number; max: number; mean: number; p50: number; p95: number; first: number; last: number; maxAt: string | null };
    changePoint: { at: string | null; beforeMean: number; afterMean: number; ratio: number; direction: string; strength: number };
  }[];
  availableMetrics: string[];
}

/**
 * Observability agent — owns logs and metrics.
 *
 * It converts raw tool output into tagged, provenance-carrying evidence, and
 * deliberately records *absence* of signal as well as presence: "CPU on this
 * service never moved" is what later rules use to rule a suspect out.
 */
export class ObservabilityAgent implements Agent {
  readonly name = 'observability' as const;
  readonly handles: Task['kind'][] = ['scan_logs', 'scan_metrics', 'correlate_signals', 'targeted_probe'];

  async run(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    switch (task.kind) {
      case 'scan_logs': return this.scanLogs(task, bb, deps);
      case 'scan_metrics': return this.scanMetrics(task, bb, deps);
      case 'correlate_signals': return this.correlate(task, bb, deps);
      case 'targeted_probe': return this.probe(task, bb, deps);
      default: {
        const r = emptyResult(task, this.name);
        r.ok = false;
        r.error = `observability agent cannot handle ${task.kind}`;
        return r;
      }
    }
  }

  /* ----------------------------------------------------------- scan_logs */

  private async scanLogs(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const services = (task.params.services as string[] | undefined) ?? [];

    // Fleet-wide first: the reporter's list of affected services is a hypothesis,
    // not a fact, so the search is not restricted to it.
    const queries: Record<string, unknown>[] = [
      { levels: ['error', 'fatal'], limit: 60 },
      { levels: ['warn'], limit: 30 },
    ];
    if (services.length) queries.push({ services, levels: ['error', 'fatal', 'warn'], limit: 40 });

    let anyOk = false;
    for (const q of queries) {
      const env = await deps.tools.call<LogsResult>('query_logs', q, this.name);
      bb.recordCoverage('query_logs', JSON.stringify(q), env.complete);
      if (!env.ok || !env.data) {
        res.notes.push(`query_logs failed (${env.error?.code}): ${env.error?.message}`);
        res.degraded = true;
        continue;
      }
      anyOk = true;
      if (!env.complete) res.degraded = true;

      const attrsByPattern = new Map<string, Record<string, string | number | boolean>>();
      for (const e of env.data.entries) {
        const key = e.message.slice(0, 40);
        if (!attrsByPattern.has(key)) attrsByPattern.set(key, e.attrs);
      }

      for (const m of env.data.topMessages) {
        // Routine chatter is not evidence; a repeated failure is.
        const isFailure = m.level === 'error' || m.level === 'fatal' || tagsFromText(m.sample).length > 0;
        if (!isFailure || m.count < 3) continue;

        const attrs = attrsByPattern.get(m.sample.slice(0, 40));
        const ref = referencedServiceIn(m.sample, attrs, bb.knownServices, m.services[0]);
        const tags = [TAG.ERROR_LOG, ...tagsFromText(m.sample), ...(ref ? [`ref:${ref}`] : [])];

        res.evidence.push(
          makeEvidence(
            {
              claim: `${m.count} occurrences of "${truncate(m.sample, 120)}" on ${m.services.join(', ')} between ${m.firstSeen} and ${m.lastSeen}`,
              type: 'fact',
              services: m.services,
              observedAt: m.firstSeen,
              tags,
              magnitude: m.count,
              raw: { pattern: m.pattern, count: m.count, level: m.level, attrs },
            },
            { tool: 'query_logs', query: q, agent: this.name, complete: env.complete },
          ),
        );
      }

      // Services producing errors that nobody reported are worth naming.
      const unreported = Object.entries(env.data.byService)
        .filter(([s, n]) => n >= 5 && !services.includes(s))
        .map(([s]) => s);
      if (unreported.length && q.levels && (q.levels as string[]).includes('error')) {
        res.evidence.push(
          makeEvidence(
            {
              claim: `Error-level logs also present on services not named in the report: ${unreported.join(', ')}`,
              type: 'inference',
              reliability: 'medium',
              services: unreported,
              tags: [TAG.ERROR_LOG],
            },
            { tool: 'query_logs', query: q, agent: this.name, complete: env.complete },
          ),
        );
      }
    }

    if (!anyOk) {
      res.evidence.push(
        makeEvidence(
          {
            claim: 'Log search returned no usable data for this incident window; the log path is unavailable',
            type: 'fact',
            reliability: 'high',
            tags: [TAG.NO_SIGNAL, TAG.INCOMPLETE],
          },
          { tool: 'query_logs', query: {}, agent: this.name, complete: false },
        ),
      );
      res.degraded = true;
      bb.addDegradation('logs unavailable: no query_logs call succeeded');
    }

    return res;
  }

  /* --------------------------------------------------------- scan_metrics */

  private async scanMetrics(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const reported = (task.params.services as string[] | undefined) ?? bb.incident.affectedServices;
    const rest = bb.knownServices.filter((s) => !reported.includes(s));

    const batches: { services: string[]; label: string }[] = [
      { services: reported, label: 'reported' },
    ];
    if (rest.length) batches.push({ services: rest, label: 'fleet' });

    let anyOk = false;
    for (const batch of batches) {
      if (batch.services.length === 0) continue;
      const q = { services: batch.services };
      const env = await deps.tools.call<MetricsResult>('query_metrics', q, this.name);
      bb.recordCoverage('query_metrics', JSON.stringify(q), env.complete);

      if (!env.ok || !env.data) {
        res.notes.push(`query_metrics(${batch.label}) failed (${env.error?.code}): ${env.error?.message}`);
        res.degraded = true;
        continue;
      }
      anyOk = true;
      if (!env.complete) {
        res.degraded = true;
        bb.addDegradation(`metrics for ${batch.label} services returned partial data`);
      }

      const movedServices = new Set<string>();
      for (const s of env.data.series) {
        const cp = s.changePoint;
        const significant =
          cp.direction !== 'flat' && cp.strength > 0.45 && (cp.ratio > 1.4 || cp.ratio < 0.65);
        if (significant) movedServices.add(s.service);
      }

      for (const s of env.data.series) {
        const cp = s.changePoint;
        const significant =
          cp.direction !== 'flat' && cp.strength > 0.45 && (cp.ratio > 1.4 || cp.ratio < 0.65);

        if (significant) {
          const tags = [
            ...metricTags(s.metric, cp.direction, cp.afterMean),
            `metric:${s.metric}`,
            `dir:${cp.direction}`,
          ];
          res.evidence.push(
            makeEvidence(
              {
                claim: `${s.metric} on ${s.service} ${cp.direction === 'increase' ? 'rose' : 'fell'} from ${fmtNum(cp.beforeMean)} to ${fmtNum(cp.afterMean)} ${s.unit} (${fmtNum(cp.ratio)}x) with the shift centred at ${cp.at}; peak ${fmtNum(s.stats.max)} at ${s.stats.maxAt}`,
                type: 'fact',
                services: [s.service],
                observedAt: cp.at,
                tags,
                magnitude: cp.ratio,
                raw: { metric: s.metric, unit: s.unit, changePoint: cp, stats: s.stats },
              },
              { tool: 'query_metrics', query: q, agent: this.name, complete: env.complete },
            ),
          );
        } else if (batch.label === 'reported' && RULE_OUT_METRICS.includes(s.metric)) {
          // Recording a non-event: this is what refutes "the box ran out of CPU".
          res.evidence.push(
            makeEvidence(
              {
                claim: `${s.metric} on ${s.service} stayed within normal range through the window (mean ${fmtNum(s.stats.mean)} ${s.unit}, peak ${fmtNum(s.stats.max)})`,
                type: 'fact',
                reliability: 'high',
                services: [s.service],
                observedAt: null,
                tags: [TAG.RESOURCE_NORMAL, `metric:${s.metric}`, 'dir:flat'],
                magnitude: s.stats.max,
                raw: { metric: s.metric, stats: s.stats },
              },
              { tool: 'query_metrics', query: q, agent: this.name, complete: env.complete },
            ),
          );
        }
      }

      // Recording which services were examined and found quiet is what later
      // refutes "that release must have broken it": a service that never moved
      // did not break anything.
      const quiet = batch.services.filter(
        (name) => !movedServices.has(name) && env.data!.series.some((x) => x.service === name),
      );
      if (quiet.length) {
        res.evidence.push(
          makeEvidence(
            {
              claim: `Metrics were examined for ${quiet.length} service(s) with no significant change in any series through the window: ${quiet.join(', ')}`,
              type: 'fact',
              reliability: env.complete ? 'high' : 'medium',
              services: quiet,
              tags: [TAG.RESOURCE_NORMAL, 'scanned_quiet'],
              raw: { quiet, batch: batch.label },
            },
            { tool: 'query_metrics', query: q, agent: this.name, complete: env.complete },
          ),
        );
      }
    }

    if (!anyOk) {
      res.degraded = true;
      bb.addDegradation('metrics unavailable: no query_metrics call succeeded');
      res.evidence.push(
        makeEvidence(
          { claim: 'Metric queries returned no usable data for this incident window', type: 'fact', tags: [TAG.NO_SIGNAL, TAG.INCOMPLETE] },
          { tool: 'query_metrics', query: {}, agent: this.name, complete: false },
        ),
      );
    }

    return res;
  }

  /* ----------------------------------------------------- correlate_signals */

  private async correlate(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const all = bb.allEvidence();

    const symptoms = all.filter((e) =>
      e.tags.some((t) => SYMPTOM_SET.has(t)),
    );

    if (symptoms.length === 0) {
      res.evidence.push(
        makeEvidence(
          { claim: 'No service shows a significant error, latency or saturation shift in the incident window', type: 'fact', reliability: 'medium', tags: [TAG.NO_SIGNAL] },
          { tool: 'derived', query: { from: 'correlate_signals' }, agent: this.name, complete: !bb.allDegradations().length },
        ),
      );
      res.notes.push('no symptom signal found; the reported window or service list may be wrong');
      return res;
    }

    // --- onset -------------------------------------------------------------
    const times = symptoms.map((e) => (e.observedAt ? Date.parse(e.observedAt) : NaN)).filter((t) => !Number.isNaN(t));
    const onset = times.length ? Math.min(...times) : Date.parse(bb.incident.window.start);
    bb.onsetEstimate = new Date(onset).toISOString().replace(/\.\d{3}Z$/, 'Z');
    res.evidence.push(
      makeEvidence(
        {
          claim: `Earliest significant signal across all services is at ${bb.onsetEstimate}, taken as the incident onset`,
          type: 'inference',
          reliability: times.length >= 2 ? 'high' : 'medium',
          observedAt: bb.onsetEstimate,
          services: [...new Set(symptoms.flatMap((e) => e.services))].slice(0, 6),
          tags: ['onset'],
        },
        { tool: 'derived', query: { from: 'correlate_signals', inputs: symptoms.length }, agent: this.name, complete: true },
      ),
    );

    // --- blast radius vs the reported service list -------------------------
    const symptomServices = [...new Set(symptoms.flatMap((e) => e.services))];
    const unreported = symptomServices.filter((s) => !bb.incident.affectedServices.includes(s));
    if (unreported.length) {
      res.evidence.push(
        makeEvidence(
          {
            claim: `Services showing symptoms but absent from the incident report: ${unreported.join(', ')}; the reported blast radius is incomplete`,
            type: 'inference',
            reliability: 'high',
            services: unreported,
            tags: ['blast_radius'],
          },
          { tool: 'derived', query: { from: 'correlate_signals' }, agent: this.name, complete: true },
        ),
      );
    }

    // --- cross-agent step: use the Dependency agent's topology -------------
    const topology = readTopology(bb);
    const degradedServices = new Set(symptomServices);
    const thirdParty = new Set(
      topology.flatMap((t) => t.edges.filter((e) => e.kind === 'third_party').map((e) => e.to)),
    );

    for (const t of topology) {
      if (!degradedServices.has(t.service)) continue;
      for (const dep of t.dependencies) {
        const depEvidence = all.filter((e) => e.services.includes(dep));
        const depBad = depEvidence.filter((e) =>
          e.tags.some((x) => DEGRADED_SET.has(x)),
        );
        const depGood = depEvidence.filter((e) => e.tags.includes(TAG.RESOURCE_NORMAL));

        const isThirdParty = thirdParty.has(dep);
        // An "upstream is unhealthy" note about a service the reporter already
        // named adds nothing: it restates the incident instead of widening it.
        // Third-party providers are always worth naming, since they sit outside
        // anything we control.
        const worthReporting = isThirdParty || !bb.incident.affectedServices.includes(dep);

        if (depBad.length && worthReporting) {
          res.evidence.push(
            makeEvidence(
              {
                claim: `${dep}, a dependency of the degraded service ${t.service}, is itself degraded: ${truncate(depBad[0]!.claim, 110)}`,
                type: 'inference',
                reliability: 'high',
                services: [dep, t.service],
                observedAt: depBad[0]!.observedAt,
                tags: [
                  isThirdParty ? TAG.EXTERNAL_DEGRADED : TAG.UPSTREAM_UNHEALTHY,
                  `ref:${dep}`,
                ],
              },
              { tool: 'derived', query: { from: 'correlate_signals', service: t.service, dependency: dep }, agent: this.name, complete: true },
            ),
          );
        } else if (depGood.length && !depEvidence.some((e) => e.tags.includes(TAG.ERROR_LOG))) {
          res.evidence.push(
            makeEvidence(
              {
                claim: `${dep}, a dependency of ${t.service}, shows no degradation, so ${t.service}'s symptoms are not inherited from it`,
                type: 'inference',
                reliability: 'medium',
                services: [dep, t.service],
                tags: [TAG.UPSTREAM_HEALTHY, `ref:${dep}`],
              },
              { tool: 'derived', query: { from: 'correlate_signals', service: t.service, dependency: dep }, agent: this.name, complete: true },
            ),
          );
        }
      }
    }

    // --- changes that left no trace on the service that was changed -------
    const changeEvidence = all.filter((e) =>
      e.tags.some((t) => CHANGE_SET.has(t)),
    );
    const symptomSvcSet = new Set(symptomServices);
    for (const c of changeEvidence) {
      const svc = c.services[0];
      if (!svc || symptomSvcSet.has(svc)) continue;
      const scanned = all.some((e) => e.tags.includes('scanned_quiet') && e.services.includes(svc));
      if (!scanned) continue;
      res.evidence.push(
        makeEvidence(
          {
            claim: `${svc} was changed near the onset but shows no error-rate, latency or saturation shift of its own anywhere in the window, so the change left no trace on the service that received it`,
            type: 'inference',
            reliability: 'high',
            services: [svc],
            observedAt: c.observedAt,
            tags: [TAG.RESOURCE_NORMAL, 'inert_change'],
          },
          { tool: 'derived', query: { from: 'correlate_signals', change: c.id, service: svc }, agent: this.name, complete: true },
        ),
      );
    }

    // --- feedback: ask for metrics on services we only just discovered -----
    const unmeasured = unreported.filter((s) => !all.some((e) => e.services.includes(s) && e.source.tool === 'query_metrics'));
    if (unmeasured.length) {
      res.requests.push({
        kind: 'scan_metrics', agent: 'observability',
        description: `Collect metrics for newly implicated services: ${unmeasured.join(', ')}`,
        params: { services: unmeasured },
        rationale: 'These services show symptoms but were outside the original scope',
      });
    }

    return res;
  }

  /* ------------------------------------------------------- targeted_probe */

  private async probe(task: Task, bb: Blackboard, deps: AgentDeps): Promise<AgentResult> {
    const res = emptyResult(task, this.name);
    const services = ((task.params.services as string[] | undefined) ?? bb.incident.affectedServices).slice(0, 4);
    const reason = (task.params.reason as string | undefined) ?? 'discriminating evidence requested by the critic';
    if (services.length === 0) {
      res.notes.push('probe requested with no target service');
      return res;
    }

    const mq = { services, includePoints: true };
    const metrics = await deps.tools.call<MetricsResult>('query_metrics', mq, this.name);
    bb.recordCoverage('query_metrics', JSON.stringify(mq), metrics.complete);

    if (metrics.ok && metrics.data) {
      // On a probe we accept weaker shifts: we are testing a stated prediction,
      // so the prior is higher and the bar for noticing is lower.
      for (const s of metrics.data.series) {
        const cp = s.changePoint;
        if (cp.direction === 'flat' || cp.strength < 0.3) continue;
        res.evidence.push(
          makeEvidence(
            {
              claim: `Probe (${truncate(reason, 60)}): ${s.metric} on ${s.service} ${cp.direction === 'increase' ? 'rose' : 'fell'} ${fmtNum(cp.ratio)}x around ${cp.at} (${fmtNum(cp.beforeMean)} -> ${fmtNum(cp.afterMean)} ${s.unit})`,
              type: 'fact',
              services: [s.service],
              observedAt: cp.at,
              tags: [...metricTags(s.metric, cp.direction, cp.afterMean), `metric:${s.metric}`, `dir:${cp.direction}`, 'probe'],
              magnitude: cp.ratio,
              raw: { metric: s.metric, changePoint: cp },
            },
            { tool: 'query_metrics', query: mq, agent: this.name, complete: metrics.complete },
          ),
        );
      }
    } else {
      res.degraded = true;
      res.notes.push(`probe metrics failed: ${metrics.error?.message}`);
    }

    const lq = { services, levels: ['error', 'fatal', 'warn'], limit: 40 };
    const logs = await deps.tools.call<LogsResult>('query_logs', lq, this.name);
    bb.recordCoverage('query_logs', JSON.stringify(lq), logs.complete);

    if (logs.ok && logs.data) {
      for (const m of logs.data.topMessages.slice(0, 6)) {
        if (m.count < 2) continue;
        const ref = referencedServiceIn(m.sample, undefined, bb.knownServices, m.services[0]);
        res.evidence.push(
          makeEvidence(
            {
              claim: `Probe (${truncate(reason, 60)}): ${m.count}x "${truncate(m.sample, 110)}" on ${m.services.join(', ')} from ${m.firstSeen}`,
              type: 'fact',
              services: m.services,
              observedAt: m.firstSeen,
              tags: [TAG.ERROR_LOG, ...tagsFromText(m.sample), ...(ref ? [`ref:${ref}`] : []), 'probe'],
              magnitude: m.count,
            },
            { tool: 'query_logs', query: lq, agent: this.name, complete: logs.complete },
          ),
        );
      }
    } else {
      res.degraded = true;
      res.notes.push(`probe logs failed: ${logs.error?.message}`);
    }

    if (res.evidence.length === 0) {
      res.evidence.push(
        makeEvidence(
          {
            claim: `Targeted probe of ${services.join(', ')} found no additional signal (${truncate(reason, 80)})`,
            type: 'fact',
            reliability: 'medium',
            services,
            tags: [TAG.NO_SIGNAL, 'probe'],
          },
          { tool: 'derived', query: { from: 'targeted_probe', services }, agent: this.name, complete: !res.degraded },
        ),
      );
    }

    return res;
  }
}

/* ========================================================================= */

/** Tags that mean a human changed something. */
const CHANGE_SET = new Set<string>([
  TAG.DEPLOY, TAG.CONFIG_CHANGE, TAG.FEATURE_FLAG, TAG.SCHEMA_CHANGE, TAG.LIMIT_CHANGE, TAG.INFRA_CHANGE,
]);

/** Symptom tags that make a service a candidate for correlation. */
const SYMPTOM_SET = new Set<string>([
  TAG.ERROR_SPIKE, TAG.LATENCY_SPIKE, TAG.ERROR_LOG, TAG.SATURATION, TAG.OOM,
  TAG.POOL_SATURATION, TAG.LOCK_WAIT, TAG.CACHE_MISS, TAG.THROUGHPUT_DROP, TAG.QUEUE_BACKLOG,
]);

/** Tags that mean "this service is itself unwell", used for upstream checks. */
const DEGRADED_SET = new Set<string>([
  TAG.ERROR_SPIKE, TAG.LATENCY_SPIKE, TAG.SATURATION, TAG.CACHE_MISS, TAG.LOCK_WAIT, TAG.REPLICA_LAG,
]);

/** Metrics whose *absence* of movement is itself diagnostic. */
const RULE_OUT_METRICS = ['cpu_pct', 'memory_pct', 'error_rate_pct', 'latency_p99_ms', 'requests_per_sec', 'cache_hit_rate_pct'];

function metricTags(metric: string, direction: string, afterMean: number): string[] {
  const up = direction === 'increase';
  const m = metric.toLowerCase();
  const tags: string[] = [];

  if (m.includes('error_rate') && up) tags.push(TAG.ERROR_SPIKE);
  if (m.includes('latency') && up) tags.push(TAG.LATENCY_SPIKE);
  if (m.includes('gc_pause') && up) tags.push(TAG.LATENCY_SPIKE, TAG.SATURATION);
  if (m.includes('requests_per_sec') || m.endsWith('_rps')) tags.push(up ? TAG.THROUGHPUT_SPIKE : TAG.THROUGHPUT_DROP);
  if ((m.includes('cpu') || m.includes('memory') || m.includes('disk')) && up && afterMean >= 80) tags.push(TAG.SATURATION);
  if (m.includes('heap') && up) {
    tags.push(TAG.SATURATION);
    if (afterMean >= 85) tags.push(TAG.OOM);
  }
  if (m.includes('conn_pool') && up) tags.push(TAG.POOL_SATURATION);
  if (m.includes('cache_hit') && !up) tags.push(TAG.CACHE_MISS);
  if (m.includes('lock_wait') && up) tags.push(TAG.LOCK_WAIT);
  if (m.includes('replica_lag') && up) tags.push(TAG.REPLICA_LAG);
  if (m.includes('queue_depth') && up) tags.push(TAG.QUEUE_BACKLOG);
  if (m.includes('dns') && up) tags.push(TAG.DNS_ERROR);
  if (m.includes('active_connections') && up && afterMean > 400) tags.push(TAG.SATURATION);

  return tags;
}

export interface TopologySlice {
  service: string;
  dependencies: string[];
  dependents: string[];
  critical: string[];
  edges: { from: string; to: string; kind: string; critical: boolean }[];
}

/** Reconstructs topology written to the blackboard by the Dependency agent. */
export function readTopology(bb: Blackboard): TopologySlice[] {
  const out: TopologySlice[] = [];
  for (const e of bb.evidenceByTag(TAG.DEPENDENCY_EDGE)) {
    const raw = e.raw as TopologySlice | undefined;
    if (raw && typeof raw === 'object' && 'service' in raw) out.push(raw);
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export type { Evidence };

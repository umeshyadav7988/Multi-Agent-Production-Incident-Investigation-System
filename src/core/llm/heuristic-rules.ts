import type { RootCauseCategory } from '../types.ts';
import { TAG } from '../tags.ts';

/** Tags that, when present in supporting evidence, corroborate a category's
 *  mechanism rather than merely its timing. */
export const MECHANISM_TAGS: Partial<Record<RootCauseCategory, string[]>> = {
  deployment_regression: [TAG.DEPLOY, TAG.DEPLOY_ROLLBACK],
  config_change: [TAG.CONFIG_CHANGE, TAG.INFRA_CHANGE, TAG.LIMIT_CHANGE],
  feature_flag: [TAG.FEATURE_FLAG],
  schema_migration: [TAG.SCHEMA_CHANGE, TAG.LOCK_WAIT, TAG.TIMEOUT],
  resource_exhaustion: [TAG.SATURATION, TAG.LATENCY_SPIKE],
  memory_leak: [TAG.OOM, TAG.RESTART, TAG.SAWTOOTH, TAG.SATURATION],
  connection_pool_exhaustion: [TAG.POOL_SATURATION, TAG.TIMEOUT, TAG.ERROR_LOG],
  database_degradation: [TAG.LOCK_WAIT, TAG.REPLICA_LAG, TAG.SATURATION],
  cache_failure: [TAG.CACHE_MISS, TAG.ERROR_LOG, TAG.LATENCY_SPIKE],
  thundering_herd: [TAG.CACHE_MISS, TAG.THROUGHPUT_SPIKE, TAG.SATURATION],
  dependency_failure: [TAG.UPSTREAM_UNHEALTHY, TAG.TIMEOUT],
  third_party_outage: [TAG.EXTERNAL_DEGRADED, TAG.UPSTREAM_UNHEALTHY, TAG.ERROR_LOG],
  rate_limit: [TAG.RATE_LIMITED, TAG.THROUGHPUT_SPIKE],
  certificate_expiry: [TAG.CERT_ERROR, TAG.NO_CHANGE_FOUND],
  dns_failure: [TAG.DNS_ERROR, TAG.ERROR_LOG],
  network_partition: [TAG.TIMEOUT, TAG.UPSTREAM_HEALTHY],
  traffic_surge: [TAG.THROUGHPUT_SPIKE, TAG.SATURATION],
  data_quality: [TAG.ERROR_LOG],
};

/**
 * How diagnostic a signal is.
 *
 * An OOM kill or an x509 error points at one cause and almost nothing else. A
 * raised error rate points at every cause there is. Weighting them equally is
 * what makes a diagnostic system reach for "something was deployed" every
 * time, because a deploy is always available and errors are always present.
 */
export const TAG_SPECIFICITY: Record<string, number> = {
  [TAG.OOM]: 0.6,
  [TAG.RESTART]: 0.5,
  [TAG.SAWTOOTH]: 0.5,
  [TAG.POOL_SATURATION]: 0.6,
  [TAG.LOCK_WAIT]: 0.6,
  [TAG.CERT_ERROR]: 0.7,
  [TAG.DNS_ERROR]: 0.7,
  [TAG.RATE_LIMITED]: 0.65,
  [TAG.CACHE_MISS]: 0.6,
  [TAG.EXTERNAL_DEGRADED]: 0.6,
  [TAG.SCHEMA_CHANGE]: 0.6,
  [TAG.FEATURE_FLAG]: 0.6,
  [TAG.REPLICA_LAG]: 0.55,
  [TAG.QUEUE_BACKLOG]: 0.45,
  [TAG.DEPLOY]: 0.3,
  [TAG.DEPLOY_ROLLBACK]: 0.3,
  [TAG.CONFIG_CHANGE]: 0.3,
  [TAG.INFRA_CHANGE]: 0.35,
  [TAG.LIMIT_CHANGE]: 0.4,
  [TAG.NO_CHANGE_FOUND]: 0.3,
  [TAG.UPSTREAM_UNHEALTHY]: 0.3,
  [TAG.UPSTREAM_HEALTHY]: 0.2,
  [TAG.THROUGHPUT_SPIKE]: 0.3,
  [TAG.SATURATION]: 0.3,
  // Present in essentially every incident, so close to uninformative alone.
  [TAG.ERROR_SPIKE]: 0.1,
  [TAG.LATENCY_SPIKE]: 0.1,
  [TAG.ERROR_LOG]: 0.1,
  [TAG.TIMEOUT]: 0.1,
  [TAG.THROUGHPUT_DROP]: 0.1,
};

/** Ceiling on the total mechanism bonus, so one rich signature cannot run away. */
export const MECHANISM_BONUS_CAP = 1.4;

/** Categories that are *more* plausible when the change log is empty. */
export const NON_CHANGE_CATEGORIES: RootCauseCategory[] = [
  'certificate_expiry', 'third_party_outage', 'traffic_surge', 'memory_leak',
  'dns_failure', 'network_partition', 'rate_limit', 'thundering_herd',
  'database_degradation', 'dependency_failure',
];

export interface ActionTemplate {
  action: string;
  type: 'immediate_mitigation' | 'verification' | 'permanent_fix' | 'preventive';
  risk: 'low' | 'medium' | 'high';
}

/** Standard remediation playbooks keyed by cause category. `{service}` is
 *  substituted with the suspect service. These are generic runbook steps, not
 *  answers to any particular incident. */
export const REMEDIATION: Record<string, ActionTemplate[]> = {
  deployment_regression: [
    { action: 'Roll back {service} to the previous known-good version', type: 'immediate_mitigation', risk: 'low' },
    { action: 'Confirm error rate and latency on {service} return to baseline within 10 minutes of rollback', type: 'verification', risk: 'low' },
    { action: 'Add a pre-merge check for query amplification on the changed code path before re-releasing', type: 'permanent_fix', risk: 'low' },
    { action: 'Gate releases of {service} behind a canary with automatic rollback on error-rate regression', type: 'preventive', risk: 'low' },
  ],
  config_change: [
    { action: 'Revert the configuration key on {service} to its previous value', type: 'immediate_mitigation', risk: 'low' },
    { action: 'Verify the dependent metric recovers after the revert before closing the incident', type: 'verification', risk: 'low' },
    { action: 'Move this key behind a reviewed change process with a staged rollout', type: 'permanent_fix', risk: 'low' },
    { action: 'Alert on changes to this configuration key in production', type: 'preventive', risk: 'low' },
  ],
  feature_flag: [
    { action: 'Set the implicated flag back to 0% on {service}', type: 'immediate_mitigation', risk: 'low' },
    { action: 'Confirm the failure rate falls in proportion with the rollout percentage', type: 'verification', risk: 'low' },
    { action: 'Fix the null-safety defect in the flagged code path before re-enabling', type: 'permanent_fix', risk: 'medium' },
    { action: 'Require an automated error-budget check at each flag rollout step', type: 'preventive', risk: 'low' },
  ],
  schema_migration: [
    { action: 'Cancel or pause the running migration and release the table lock', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm lock waits drop and write latency recovers on affected services', type: 'verification', risk: 'low' },
    { action: 'Re-run the migration using a non-blocking strategy (CONCURRENTLY / shadow table)', type: 'permanent_fix', risk: 'medium' },
    { action: 'Require a lock-impact review and a statement timeout for all production migrations', type: 'preventive', risk: 'low' },
  ],
  memory_leak: [
    { action: 'Restart affected {service} instances on a rolling basis to reclaim heap', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Capture a heap dump before the next restart to confirm the retaining object graph', type: 'verification', risk: 'low' },
    { action: 'Bound the leaking cache or buffer and ship a hotfix', type: 'permanent_fix', risk: 'medium' },
    { action: 'Alert on heap growth rate rather than on absolute usage', type: 'preventive', risk: 'low' },
  ],
  connection_pool_exhaustion: [
    { action: 'Restore the connection pool size on {service} to its previous value', type: 'immediate_mitigation', risk: 'low' },
    { action: 'Confirm pool wait time returns to single-digit milliseconds', type: 'verification', risk: 'low' },
    { action: 'Set the pool size from a documented capacity calculation rather than a literal', type: 'permanent_fix', risk: 'low' },
    { action: 'Alert on pool saturation and wait time, not only on database metrics', type: 'preventive', risk: 'low' },
  ],
  cache_failure: [
    { action: 'Restore the previous cache eviction policy and raise the memory ceiling on {service}', type: 'immediate_mitigation', risk: 'low' },
    { action: 'Confirm hit rate recovers and dependent write errors stop', type: 'verification', risk: 'low' },
    { action: 'Make the cache fail open with a bounded fallback instead of erroring', type: 'permanent_fix', risk: 'medium' },
    { action: 'Alert on cache memory headroom before it reaches the eviction threshold', type: 'preventive', risk: 'low' },
  ],
  thundering_herd: [
    { action: 'Warm the cold cache and temporarily shed non-critical read traffic', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm database QPS returns to baseline as hit rate recovers', type: 'verification', risk: 'low' },
    { action: 'Add request coalescing (single-flight) and jittered TTLs on the hot keys', type: 'permanent_fix', risk: 'medium' },
    { action: 'Replace full-node restarts with a staged restart that preserves the keyspace', type: 'preventive', risk: 'low' },
  ],
  third_party_outage: [
    { action: 'Fail over to the degraded path (queue and replay) for calls to {service}', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm against the provider status page and a direct probe that the fault is upstream', type: 'verification', risk: 'low' },
    { action: 'Do not roll back local releases; they are not implicated', type: 'permanent_fix', risk: 'low' },
    { action: 'Add a circuit breaker with a documented fallback for this provider', type: 'preventive', risk: 'low' },
  ],
  rate_limit: [
    { action: 'Shed or queue non-essential traffic to {service} to stay inside the quota', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm 429 responses stop once request rate falls below the published limit', type: 'verification', risk: 'low' },
    { action: 'Request a quota increase and add client-side rate limiting with backoff', type: 'permanent_fix', risk: 'low' },
    { action: 'Alert at 80% of the provider quota rather than on resulting errors', type: 'preventive', risk: 'low' },
  ],
  certificate_expiry: [
    { action: 'Rotate the expired certificate and reload the affected listeners on {service}', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm handshakes succeed and error rate returns to baseline', type: 'verification', risk: 'low' },
    { action: 'Automate certificate renewal for this trust chain', type: 'permanent_fix', risk: 'low' },
    { action: 'Alert 30 and 7 days before any certificate in the chain expires', type: 'preventive', risk: 'low' },
  ],
  dns_failure: [
    { action: 'Revert the DNS configuration on {service} to the previous resolver policy', type: 'immediate_mitigation', risk: 'low' },
    { action: 'Resolve the failing hostname from inside an affected pod to confirm recovery', type: 'verification', risk: 'low' },
    { action: 'Ensure custom resolvers forward correctly for external names', type: 'permanent_fix', risk: 'medium' },
    { action: 'Add a synthetic DNS resolution check for every external dependency', type: 'preventive', risk: 'low' },
  ],
  network_partition: [
    { action: 'Reroute traffic away from the affected network path for {service}', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Probe connectivity from both sides to confirm where packets are dropped', type: 'verification', risk: 'low' },
    { action: 'Work with the network owner on the underlying path fault', type: 'permanent_fix', risk: 'medium' },
    { action: 'Add cross-zone reachability probes with alerting', type: 'preventive', risk: 'low' },
  ],
  database_degradation: [
    { action: 'Identify and terminate the heaviest queries on {service}', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm query latency and CPU return to baseline', type: 'verification', risk: 'low' },
    { action: 'Add the missing index or batch the offending access pattern', type: 'permanent_fix', risk: 'medium' },
    { action: 'Enforce statement timeouts and a slow-query budget per service', type: 'preventive', risk: 'low' },
  ],
  dependency_failure: [
    { action: 'Degrade gracefully or fail over away from {service}', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm the dependency is unhealthy independently of the caller', type: 'verification', risk: 'low' },
    { action: 'Hand the fault to the owning team with the collected evidence', type: 'permanent_fix', risk: 'low' },
    { action: 'Add a circuit breaker and a defined fallback for this dependency', type: 'preventive', risk: 'low' },
  ],
  traffic_surge: [
    { action: 'Scale out {service} and enable admission control for low-priority traffic', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm saturation falls as capacity is added', type: 'verification', risk: 'low' },
    { action: 'Right-size autoscaling thresholds for this traffic profile', type: 'permanent_fix', risk: 'low' },
    { action: 'Require capacity notice for scheduled campaigns', type: 'preventive', risk: 'low' },
  ],
  resource_exhaustion: [
    { action: 'Add capacity to {service} or shed load until utilisation is under control', type: 'immediate_mitigation', risk: 'medium' },
    { action: 'Confirm utilisation and latency return to baseline after the change', type: 'verification', risk: 'low' },
    { action: 'Find and fix the workload driving the resource growth', type: 'permanent_fix', risk: 'medium' },
    { action: 'Set utilisation alerts with enough headroom to act before saturation', type: 'preventive', risk: 'low' },
  ],
  unknown: [
    { action: 'Preserve logs, metrics and heap/thread dumps for the incident window before they age out', type: 'immediate_mitigation', risk: 'low' },
    { action: 'Repair the broken telemetry path and re-run this investigation', type: 'verification', risk: 'low' },
    { action: 'Add instrumentation on the affected path so a recurrence is diagnosable', type: 'preventive', risk: 'low' },
  ],
};

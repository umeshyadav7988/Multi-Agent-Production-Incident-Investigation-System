/**
 * Shared signal vocabulary.
 *
 * Evidence is tagged by whichever agent gathered it; downstream reasoning keys
 * off these tags rather than off free text. That is what lets the Reasoning
 * agent combine findings from Observability and Dependency without either side
 * knowing how the other works.
 */
export const TAG = {
  // --- symptom-side (Observability) ---
  ERROR_SPIKE: 'error_spike',
  LATENCY_SPIKE: 'latency_spike',
  THROUGHPUT_SPIKE: 'throughput_spike',
  THROUGHPUT_DROP: 'throughput_drop',
  SATURATION: 'saturation',
  RESOURCE_NORMAL: 'resource_normal',
  ERROR_LOG: 'error_log',
  OOM: 'oom',
  RESTART: 'restart',
  POOL_SATURATION: 'pool_saturation',
  LOCK_WAIT: 'lock_wait',
  CACHE_MISS: 'cache_miss',
  CERT_ERROR: 'cert_error',
  DNS_ERROR: 'dns_error',
  RATE_LIMITED: 'rate_limited',
  TIMEOUT: 'timeout_error',
  QUEUE_BACKLOG: 'queue_backlog',
  REPLICA_LAG: 'replica_lag',
  SAWTOOTH: 'sawtooth',
  NO_SIGNAL: 'no_signal',

  // --- change-side (Dependency) ---
  DEPLOY: 'deploy',
  DEPLOY_ROLLBACK: 'deploy_rollback',
  CONFIG_CHANGE: 'config_change',
  FEATURE_FLAG: 'feature_flag',
  SCHEMA_CHANGE: 'schema_change',
  LIMIT_CHANGE: 'limit_change',
  INFRA_CHANGE: 'infra_change',
  NO_CHANGE_FOUND: 'no_change_found',

  // --- topology / corroboration ---
  DEPENDENCY_EDGE: 'dependency_edge',
  UPSTREAM_UNHEALTHY: 'upstream_unhealthy',
  UPSTREAM_HEALTHY: 'upstream_healthy',
  EXTERNAL_DEGRADED: 'external_degraded',
  HISTORICAL_MATCH: 'historical_match',

  // --- meta ---
  INCOMPLETE: 'incomplete_data',
  CONTRADICTION: 'contradiction',
} as const;

export type Tag = (typeof TAG)[keyof typeof TAG];

/** Tags that describe a symptom rather than a cause or a change. */
export const SYMPTOM_TAGS: string[] = [
  TAG.ERROR_SPIKE, TAG.LATENCY_SPIKE, TAG.ERROR_LOG, TAG.SATURATION,
  TAG.OOM, TAG.RESTART, TAG.POOL_SATURATION, TAG.LOCK_WAIT, TAG.CACHE_MISS,
  TAG.CERT_ERROR, TAG.DNS_ERROR, TAG.RATE_LIMITED, TAG.TIMEOUT,
  TAG.QUEUE_BACKLOG, TAG.REPLICA_LAG, TAG.THROUGHPUT_DROP,
];

/** Tags that describe something a human changed. */
export const CHANGE_TAGS: string[] = [
  TAG.DEPLOY, TAG.CONFIG_CHANGE, TAG.FEATURE_FLAG, TAG.SCHEMA_CHANGE,
  TAG.LIMIT_CHANGE, TAG.INFRA_CHANGE,
];

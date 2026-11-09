import type { ScenarioSpec } from '../world.ts';

/** 1. Deployment regression masked by a closer-in-time innocent deploy. */
export const INC_5001: ScenarioSpec = {
  id: 'INC-5001',
  title: 'Checkout failures and order submission timeouts',
  description:
    'Customers report that order submission hangs and then fails. Support volume is climbing. Checkout conversion dropped sharply in the last 20 minutes.',
  severity: 'sev1',
  reportedAt: '2026-04-01T09:30:00Z',
  onsetMinutesBeforeReport: 18,
  windowBeforeMin: 120,
  windowAfterMin: 20,
  affectedServices: ['checkout-web', 'api-gateway', 'order-service'],
  symptoms: [
    'order submission requests time out after 30s',
    'checkout error rate climbing',
    'no customer-visible errors on product browse',
  ],
  signals: [
    { type: 'deploy', service: 'order-service', offsetMin: -7, version: '3.4.0',
      changes: ['add per-line-item tax rule lookup in order enrichment', 'bump internal sdk to 2.2'],
      author: 'a.gomez', rolloutPct: 100 },
    // Red herring: deployed closer to onset than the real cause, but inert.
    { type: 'deploy', service: 'search-service', offsetMin: -4, version: '2.9.1',
      changes: ['bump elasticsearch client 8.11 -> 8.12'], author: 'k.nguyen', rolloutPct: 100 },
    { type: 'error_burst', service: 'order-service', startOffsetMin: 0, durationMin: 42, peakPerMin: 300,
      message: 'upstream timeout calling postgres-primary: context deadline exceeded', shape: 'ramp',
      attrs: { endpoint: 'POST /orders', upstream: 'postgres-primary' } },
    { type: 'metric_shift', service: 'order-service', metric: 'latency_p99_ms', baseline: 180, peak: 4200, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'order-service', metric: 'error_rate_pct', baseline: 0.3, peak: 22, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'api-gateway', metric: 'error_rate_pct', baseline: 0.2, peak: 9.4, startOffsetMin: 2, shape: 'ramp' },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'requests_per_sec', baseline: 1400, peak: 5300, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'cpu_pct', baseline: 42, peak: 88, startOffsetMin: 1, shape: 'ramp' },
    // Order-service itself is not resource constrained: rules out local saturation.
    { type: 'metric_shift', service: 'order-service', metric: 'cpu_pct', baseline: 38, peak: 41, startOffsetMin: 0 },
    { type: 'metric_shift', service: 'order-service', metric: 'memory_pct', baseline: 52, peak: 53, startOffsetMin: 0 },
    // Search is fine despite having deployed more recently.
    { type: 'metric_shift', service: 'search-service', metric: 'latency_p99_ms', baseline: 186, peak: 190, startOffsetMin: 0 },
    { type: 'metric_shift', service: 'search-service', metric: 'error_rate_pct', baseline: 0.3, peak: 0.3, startOffsetMin: 0 },
    { type: 'log_line', service: 'postgres-primary', offsetMin: 3, level: 'warn', count: 30,
      message: 'slow query 2140ms: SELECT rate FROM tax_rules WHERE sku = $1 AND region = $2',
      attrs: { calls_per_txn: 47 } },
    { type: 'log_line', service: 'search-service', offsetMin: -3, level: 'info', count: 2,
      message: 'elasticsearch client 8.12 initialised; wire protocol unchanged' },
  ],
  truth: {
    category: 'deployment_regression',
    service: 'order-service',
    narrative:
      'order-service 3.4.0 introduced a per-line-item tax rule lookup, turning one order write into ~47 queries. Postgres QPS tripled and order writes exceeded their deadline. The search-service deploy four minutes later is unrelated and inert.',
    alsoAcceptable: ['database_degradation'],
    requiredEvidenceMarkers: ['order-service', '3.4.0', 'tax'],
  },
  traits: ['misleading_evidence', 'red_herring_deploy', 'multi_service'],
};

/** 2. Infra config change, with a stale dashboard contradicting the truth. */
export const INC_5002: ScenarioSpec = {
  id: 'INC-5002',
  title: 'Login latency spike and intermittent auth timeouts',
  description:
    'Sign-in is taking several seconds and a fraction of attempts time out entirely. Started roughly 15 minutes ago. No release was announced.',
  severity: 'sev1',
  reportedAt: '2026-04-03T17:20:00Z',
  onsetMinutesBeforeReport: 15,
  windowBeforeMin: 120,
  windowAfterMin: 15,
  affectedServices: ['auth-service', 'api-gateway'],
  symptoms: ['login p99 above 2s', 'intermittent 504 on auth', 'session writes failing'],
  signals: [
    { type: 'config_change', service: 'redis-cache', offsetMin: -2, key: 'maxmemory-policy',
      from: 'allkeys-lru', to: 'noeviction', author: 'm.lindqvist', kind: 'infra' },
    { type: 'metric_shift', service: 'redis-cache', metric: 'memory_pct', baseline: 72, peak: 99.4, startOffsetMin: -45, shape: 'ramp' },
    { type: 'metric_shift', service: 'redis-cache', metric: 'cache_hit_rate_pct', baseline: 94, peak: 21, startOffsetMin: 0, shape: 'ramp' },
    { type: 'error_burst', service: 'auth-service', startOffsetMin: 0, durationMin: 40, peakPerMin: 240,
      message: "redis SET failed: OOM command not allowed when used memory > 'maxmemory'",
      attrs: { key_prefix: 'session:', backend: 'redis-cache' } },
    { type: 'metric_shift', service: 'auth-service', metric: 'latency_p99_ms', baseline: 180, peak: 2600, startOffsetMin: 1, shape: 'ramp' },
    { type: 'metric_shift', service: 'auth-service', metric: 'error_rate_pct', baseline: 0.3, peak: 11, startOffsetMin: 1, shape: 'ramp' },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'conn_pool_used_pct', baseline: 35, peak: 97, startOffsetMin: 2, shape: 'ramp' },
    // Conflicting observation: auth-service's own cache dashboard is sampled
    // from a stale local counter and still reports a healthy hit rate.
    { type: 'metric_shift', service: 'auth-service', metric: 'cache_hit_rate_pct', baseline: 92, peak: 91.4, startOffsetMin: 0 },
    // Decoy: a real, recent auth-service deploy that is not the cause.
    { type: 'deploy', service: 'auth-service', offsetMin: -100, version: '7.2.0',
      changes: ['change session payload serialization from json to msgpack'], author: 'p.sharma', rolloutPct: 100 },
    { type: 'log_line', service: 'redis-cache', offsetMin: 1, level: 'error', count: 12,
      message: 'OOM command not allowed when used memory > maxmemory, with eviction disabled' },
    { type: 'log_line', service: 'auth-service', offsetMin: 4, level: 'warn', count: 8,
      message: 'session cache miss; falling back to postgres-primary read path' },
  ],
  truth: {
    category: 'cache_failure',
    service: 'redis-cache',
    narrative:
      'maxmemory-policy was changed from allkeys-lru to noeviction while Redis was already near its limit. Session writes began failing with OOM, every auth request fell through to Postgres, and the connection pool saturated. auth-service 7.2.0 is a coincidental earlier deploy.',
    alsoAcceptable: ['config_change'],
    requiredEvidenceMarkers: ['maxmemory-policy', 'noeviction', 'redis-cache'],
  },
  traits: ['conflicting_observations', 'misleading_evidence'],
};

/** 3. Third-party outage with a deploy minutes before onset. */
export const INC_5003: ScenarioSpec = {
  id: 'INC-5003',
  title: 'Payments failing at checkout',
  description:
    'Roughly half of card payments are failing. The payments team shipped a release a few minutes before this started and is asking whether to roll back.',
  severity: 'sev1',
  reportedAt: '2026-04-05T13:50:00Z',
  onsetMinutesBeforeReport: 6,
  windowBeforeMin: 90,
  windowAfterMin: 30,
  affectedServices: ['payment-service', 'order-service', 'checkout-web'],
  symptoms: ['payment error rate above 50%', 'orders stuck in pending', 'no errors on browse or search'],
  signals: [
    { type: 'deploy', service: 'payment-service', offsetMin: -3, version: '5.1.2',
      changes: ['update JPY currency rounding to 0 decimal places'], author: 'l.dubois', rolloutPct: 100 },
    { type: 'error_burst', service: 'payment-service', startOffsetMin: 0, durationMin: 50, peakPerMin: 400,
      message: 'stripe charge API returned 503 Service Unavailable (request_id req_8812f)',
      attrs: { upstream: 'stripe-api', http_status: 503, region: 'eu-west-1' } },
    { type: 'metric_shift', service: 'stripe-api', metric: 'latency_p99_ms', baseline: 420, peak: 9200, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'stripe-api', metric: 'error_rate_pct', baseline: 0.4, peak: 58, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'payment-service', metric: 'error_rate_pct', baseline: 0.3, peak: 51, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'payment-service', metric: 'latency_p99_ms', baseline: 210, peak: 8900, startOffsetMin: 0, shape: 'ramp' },
    // Local resources untouched: the failure is not ours.
    { type: 'metric_shift', service: 'payment-service', metric: 'cpu_pct', baseline: 38, peak: 34, startOffsetMin: 0 },
    { type: 'metric_shift', service: 'payment-service', metric: 'memory_pct', baseline: 52, peak: 52.4, startOffsetMin: 0 },
    { type: 'log_line', service: 'payment-service', offsetMin: 7, level: 'warn', count: 6,
      message: 'circuit breaker OPEN for upstream stripe-api after 20 consecutive 5xx' },
    { type: 'log_line', service: 'payment-service', offsetMin: 2, level: 'info', count: 3,
      message: 'JPY rounding path executed 0 times in last 15m (no JPY traffic in this region)' },
    { type: 'log_line', service: 'order-service', offsetMin: 5, level: 'error', count: 10,
      message: 'payment authorisation failed, order left in PENDING state' },
  ],
  historical: [
    {
      id: 'INC-2190b',
      title: 'Stripe eu-west degradation (recurrence)',
      occurredAt: '2026-03-11T08:30:00Z',
      services: ['payment-service', 'stripe-api'],
      category: 'third_party_outage',
      rootCause: 'Stripe eu-west returned elevated 503s for 25 minutes. Status page updated 12 minutes in.',
      resolution: 'Failed over to the store-and-forward queue; no deploy change.',
      symptoms: ['payment 5xx', 'stripe latency spike', 'local resources flat'],
      timeToResolveMin: 25,
    },
  ],
  forcedToolFaults: [{ tool: 'query_deployments', mode: 'partial_result', probability: 0.6, maxOccurrences: 1 }],
  truth: {
    category: 'third_party_outage',
    service: 'stripe-api',
    narrative:
      'Stripe returned 503s from eu-west. payment-service 5.1.2 shipped three minutes earlier but only touches JPY rounding, which never executed. Local CPU and memory are flat, which rules out a local regression.',
    alsoAcceptable: ['dependency_failure'],
    requiredEvidenceMarkers: ['stripe', '503'],
  },
  traits: ['misleading_evidence', 'red_herring_deploy', 'tool_failure'],
};

/** 4. Slow memory leak whose triggering deploy is outside the default window. */
export const INC_5004: ScenarioSpec = {
  id: 'INC-5004',
  title: 'Search intermittently unavailable, recovering on its own',
  description:
    'Search has been failing in bursts since early morning. Each burst clears by itself after a few minutes, then returns. Nobody has deployed search today.',
  severity: 'sev2',
  reportedAt: '2026-04-07T06:40:00Z',
  onsetMinutesBeforeReport: 90,
  windowBeforeMin: 180,
  windowAfterMin: 20,
  affectedServices: ['search-service'],
  symptoms: [
    'search returns 503 in bursts of 2-4 minutes',
    'recovers without intervention',
    'latency climbs steadily between bursts',
  ],
  signals: [
    { type: 'metric_shift', service: 'search-service', metric: 'heap_used_pct', baseline: 44, peak: 98, startOffsetMin: -60, shape: 'sawtooth', noise: 0.03 },
    { type: 'metric_shift', service: 'search-service', metric: 'gc_pause_ms', baseline: 18, peak: 1450, startOffsetMin: -50, shape: 'sawtooth' },
    { type: 'metric_shift', service: 'search-service', metric: 'latency_p99_ms', baseline: 190, peak: 3100, startOffsetMin: -50, shape: 'sawtooth' },
    { type: 'error_burst', service: 'search-service', startOffsetMin: 0, durationMin: 95, peakPerMin: 70,
      message: 'java.lang.OutOfMemoryError: Java heap space', level: 'fatal',
      attrs: { pod: 'search-service-3' } },
    { type: 'log_line', service: 'search-service', offsetMin: 0, level: 'fatal', count: 2, message: 'container OOMKilled (exit 137), restarting pod search-service-3' },
    { type: 'log_line', service: 'search-service', offsetMin: 29, level: 'fatal', count: 2, message: 'container OOMKilled (exit 137), restarting pod search-service-1' },
    { type: 'log_line', service: 'search-service', offsetMin: 58, level: 'fatal', count: 2, message: 'container OOMKilled (exit 137), restarting pod search-service-5' },
    { type: 'log_line', service: 'search-service', offsetMin: 86, level: 'fatal', count: 2, message: 'container OOMKilled (exit 137), restarting pod search-service-2' },
    { type: 'metric_shift', service: 'elasticsearch', metric: 'latency_p99_ms', baseline: 48, peak: 50, startOffsetMin: 0 },
    { type: 'metric_shift', service: 'elasticsearch', metric: 'error_rate_pct', baseline: 0.05, peak: 0.06, startOffsetMin: 0 },
    // The real trigger shipped 26 hours earlier: only a widened lookback finds it.
    { type: 'deploy', service: 'search-service', offsetMin: -1560, version: '2.7.1',
      changes: ['add in-process query result cache (no eviction bound)'], author: 'j.okafor', rolloutPct: 100 },
  ],
  forcedToolFaults: [{ tool: 'query_metrics', mode: 'partial_result', probability: 1, maxOccurrences: 2 }],
  truth: {
    category: 'memory_leak',
    service: 'search-service',
    narrative:
      'search-service 2.7.1 added an unbounded in-process query cache 26 hours before the incident. Heap climbs in a sawtooth to OOMKill, the pod restarts, and the cycle repeats. Elasticsearch itself is healthy.',
    alsoAcceptable: ['resource_exhaustion'],
    requiredEvidenceMarkers: ['heap', 'oom'],
  },
  traits: ['tool_failure', 'incomplete_data'],
};

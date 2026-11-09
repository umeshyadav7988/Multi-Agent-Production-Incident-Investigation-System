import type { ScenarioSpec } from '../world.ts';

/** 9. Migration lock stalling writes across several services. */
export const INC_5009: ScenarioSpec = {
  id: 'INC-5009',
  title: 'Writes hanging across order, payment and user services',
  description:
    'Any request that writes to the database hangs for 30s and then fails. Reads are fine. Three teams are each investigating their own service in isolation.',
  severity: 'sev1',
  reportedAt: '2026-04-17T04:22:00Z',
  onsetMinutesBeforeReport: 11,
  windowBeforeMin: 120,
  windowAfterMin: 20,
  affectedServices: ['order-service', 'payment-service', 'user-service', 'postgres-primary'],
  symptoms: ['all write paths hang then time out', 'read paths unaffected', 'three services affected simultaneously'],
  signals: [
    { type: 'config_change', service: 'postgres-primary', offsetMin: -3, key: 'migration.20260417_add_orders_status_index',
      from: 'pending', to: 'running', author: 'd.alvarez', kind: 'schema' },
    { type: 'log_line', service: 'postgres-primary', offsetMin: -3, level: 'info', count: 2,
      message: 'migration 20260417_add_orders_status_index started: ALTER TABLE orders ADD COLUMN status_v2 ... (ACCESS EXCLUSIVE)' },
    { type: 'log_line', service: 'postgres-primary', offsetMin: 2, level: 'warn', count: 18,
      message: 'process 4412 still waiting for ShareLock on relation orders after 30011.004 ms',
      attrs: { lock_mode: 'ACCESS EXCLUSIVE', blocking_pid: 4120 } },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'lock_wait_ms', baseline: 3, peak: 30100, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'active_connections', baseline: 180, peak: 640, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'cpu_pct', baseline: 42, peak: 18, startOffsetMin: 1, shape: 'step' },
    { type: 'error_burst', service: 'order-service', startOffsetMin: 1, durationMin: 30, peakPerMin: 190,
      message: 'write transaction timed out after 30000ms waiting for lock on relation orders' },
    { type: 'error_burst', service: 'payment-service', startOffsetMin: 1, durationMin: 30, peakPerMin: 110,
      message: 'write transaction timed out after 30000ms waiting for lock on relation orders' },
    { type: 'error_burst', service: 'user-service', startOffsetMin: 2, durationMin: 28, peakPerMin: 70,
      message: 'write transaction timed out after 30000ms waiting for lock' },
    { type: 'metric_shift', service: 'order-service', metric: 'latency_p99_ms', baseline: 180, peak: 30200, startOffsetMin: 1, shape: 'step' },
    { type: 'metric_shift', service: 'postgres-replica', metric: 'latency_p99_ms', baseline: 45, peak: 44, startOffsetMin: 0 },
  ],
  truth: {
    category: 'schema_migration',
    service: 'postgres-primary',
    narrative:
      'A migration took an ACCESS EXCLUSIVE lock on the orders table. Every writer across three services blocks on it and times out at 30s. Reads served from the replica are unaffected, and Postgres CPU drops because it is waiting, not working.',
    alsoAcceptable: ['database_degradation', 'config_change'],
    requiredEvidenceMarkers: ['lock', 'orders'],
  },
  traits: ['multi_service', 'misleading_evidence'],
};

/** 10. Genuinely insufficient evidence. The correct answer is "inconclusive". */
export const INC_5010: ScenarioSpec = {
  id: 'INC-5010',
  title: 'Occasional slow recommendations, cause unclear',
  description:
    'A few customers report that the recommendations carousel sometimes takes a long time. No alert fired. Log shipping for this cluster has been broken since yesterday.',
  severity: 'sev4',
  reportedAt: '2026-04-19T10:30:00Z',
  onsetMinutesBeforeReport: 40,
  windowBeforeMin: 90,
  windowAfterMin: 15,
  affectedServices: ['recommendation-service'],
  symptoms: [
    'carousel occasionally slow, anecdotal only',
    'no alert fired',
    'log pipeline for this cluster is down',
  ],
  signals: [
    { type: 'metric_shift', service: 'recommendation-service', metric: 'latency_p99_ms', baseline: 180, peak: 410, startOffsetMin: 0, shape: 'sawtooth', noise: 0.25 },
    { type: 'metric_shift', service: 'recommendation-service', metric: 'error_rate_pct', baseline: 0.3, peak: 0.45, startOffsetMin: 0, noise: 0.3 },
    { type: 'metric_shift', service: 'elasticsearch', metric: 'latency_p99_ms', baseline: 48, peak: 61, startOffsetMin: 0, noise: 0.2 },
  ],
  forcedToolFaults: [
    { tool: 'query_logs', mode: 'unavailable', probability: 1, maxOccurrences: 24 },
    { tool: 'query_metrics', mode: 'partial_result', probability: 0.5, maxOccurrences: 4 },
  ],
  truth: {
    category: 'unknown',
    service: 'recommendation-service',
    narrative:
      'There is a mild, noisy latency increase and nothing else. Logs are unavailable, there is no deploy, no config change, and no corroborating metric. Any confident root cause here would be invented.',
    requiredEvidenceMarkers: [],
    expectInconclusive: true,
  },
  traits: ['insufficient_evidence', 'tool_failure', 'incomplete_data'],
};

/** 11. DNS resolution failure confined to one egress path. */
export const INC_5011: ScenarioSpec = {
  id: 'INC-5011',
  title: 'SMS notifications stopped sending',
  description:
    'Outbound SMS stopped about 20 minutes ago. Email still works. The notification team sees connection errors but the Twilio status page is green.',
  severity: 'sev2',
  reportedAt: '2026-04-21T18:45:00Z',
  onsetMinutesBeforeReport: 20,
  windowBeforeMin: 120,
  windowAfterMin: 20,
  affectedServices: ['notification-service', 'twilio-api'],
  symptoms: ['SMS send failures at 100%', 'email notifications unaffected', 'Twilio status page reports healthy'],
  signals: [
    { type: 'config_change', service: 'notification-service', offsetMin: -5, key: 'dnsPolicy',
      from: 'ClusterFirst', to: 'None (custom nameservers 10.8.0.2, 10.8.0.3)', author: 'm.lindqvist', kind: 'infra' },
    { type: 'error_burst', service: 'notification-service', startOffsetMin: 0, durationMin: 40, peakPerMin: 260,
      message: 'dial tcp: lookup api.twilio.com on 10.8.0.2:53: no such host',
      attrs: { upstream: 'twilio-api', resolver: '10.8.0.2' } },
    { type: 'metric_shift', service: 'notification-service', metric: 'error_rate_pct', baseline: 0.3, peak: 46, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'notification-service', metric: 'dns_resolution_failures_per_min', baseline: 0, peak: 260, startOffsetMin: 0, shape: 'step' },
    // Twilio is genuinely healthy: zero requests reach it.
    { type: 'metric_shift', service: 'twilio-api', metric: 'requests_per_sec', baseline: 140, peak: 0, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'twilio-api', metric: 'error_rate_pct', baseline: 0.4, peak: 0, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'notification-service', metric: 'queue_depth', baseline: 40, peak: 9400, startOffsetMin: 0, shape: 'ramp' },
    { type: 'log_line', service: 'notification-service', offsetMin: 3, level: 'info', count: 4,
      message: 'kafka consumer healthy; email transport ok, sms transport failing' },
    { type: 'log_line', service: 'notification-service', offsetMin: -5, level: 'info', count: 2,
      message: 'pod spec updated: dnsPolicy None, nameservers [10.8.0.2 10.8.0.3]' },
  ],
  forcedToolFaults: [{ tool: 'query_dependencies', mode: 'timeout', probability: 0.5, maxOccurrences: 2 }],
  truth: {
    category: 'dns_failure',
    service: 'notification-service',
    narrative:
      'A pod-spec change swapped dnsPolicy from ClusterFirst to custom nameservers that cannot resolve public names. SMS calls fail at DNS resolution, so Twilio sees zero traffic and is correctly reporting healthy. Email uses an in-cluster relay and is unaffected.',
    alsoAcceptable: ['config_change', 'network_partition'],
    requiredEvidenceMarkers: ['dns', 'twilio'],
  },
  traits: ['misleading_evidence', 'tool_failure', 'conflicting_observations'],
};

/** 12. Upstream rate limiting that looks like a local auth regression. */
export const INC_5012: ScenarioSpec = {
  id: 'INC-5012',
  title: 'Login failures climbing through a marketing campaign',
  description:
    'Login failure rate is climbing steadily. Marketing launched a push campaign 30 minutes ago. The identity team deployed a small change this morning and is considering a rollback.',
  severity: 'sev2',
  reportedAt: '2026-04-23T12:40:00Z',
  onsetMinutesBeforeReport: 25,
  windowBeforeMin: 150,
  windowAfterMin: 20,
  affectedServices: ['auth-service', 'api-gateway', 'auth0-api'],
  symptoms: [
    'login failure rate climbing with traffic',
    'failures are HTTP 429 not 500',
    'existing sessions unaffected',
  ],
  signals: [
    { type: 'metric_shift', service: 'api-gateway', metric: 'requests_per_sec', baseline: 3200, peak: 8600, startOffsetMin: -5, shape: 'ramp' },
    { type: 'metric_shift', service: 'auth-service', metric: 'requests_per_sec', baseline: 850, peak: 2400, startOffsetMin: -5, shape: 'ramp' },
    { type: 'error_burst', service: 'auth-service', startOffsetMin: 0, durationMin: 42, peakPerMin: 320,
      message: 'auth0 token endpoint returned 429 Too Many Requests (x-ratelimit-limit: 1000/min, retry-after: 37)',
      shape: 'ramp', attrs: { upstream: 'auth0-api', http_status: 429 } },
    { type: 'metric_shift', service: 'auth0-api', metric: 'error_rate_pct', baseline: 0.4, peak: 38, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'auth0-api', metric: 'requests_per_sec', baseline: 90, peak: 1010, startOffsetMin: -5, shape: 'ramp' },
    { type: 'metric_shift', service: 'auth-service', metric: 'error_rate_pct', baseline: 0.3, peak: 27, startOffsetMin: 0, shape: 'ramp' },
    // auth-service itself is healthy and its own latency barely moves.
    { type: 'metric_shift', service: 'auth-service', metric: 'cpu_pct', baseline: 38, peak: 58, startOffsetMin: -5, shape: 'ramp' },
    { type: 'metric_shift', service: 'auth-service', metric: 'latency_p99_ms', baseline: 180, peak: 320, startOffsetMin: 0, shape: 'ramp' },
    // Decoy deploy, hours old and stable through the first traffic rise.
    { type: 'deploy', service: 'auth-service', offsetMin: -280, version: '7.3.1',
      changes: ['add structured logging to token exchange handler'], author: 'p.sharma', rolloutPct: 100 },
    { type: 'log_line', service: 'auth-service', offsetMin: 6, level: 'warn', count: 10,
      message: 'auth0 rate limit bucket exhausted; 1000/min quota reached, shedding new token requests' },
    { type: 'log_line', service: 'notification-service', offsetMin: -30, level: 'info', count: 3,
      message: 'campaign push batch dispatched: 1.4M recipients' },
  ],
  truth: {
    category: 'rate_limit',
    service: 'auth0-api',
    narrative:
      'A push campaign drove login volume past the Auth0 tenant quota of 1000 token requests/min. Auth0 returns 429 and auth-service surfaces it as a login failure. auth-service 7.3.1 is four hours old and only adds logging.',
    alsoAcceptable: ['third_party_outage', 'traffic_surge'],
    requiredEvidenceMarkers: ['429', 'rate limit'],
  },
  traits: ['misleading_evidence', 'red_herring_deploy', 'multi_service'],
};

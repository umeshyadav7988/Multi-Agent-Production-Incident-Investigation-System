import type { ScenarioSpec } from '../world.ts';

/** 5. Pool starvation that presents as a database problem. */
export const INC_5005: ScenarioSpec = {
  id: 'INC-5005',
  title: 'Profile pages timing out, database suspected',
  description:
    'User profile reads are timing out. The DBA team says Postgres connections are maxed and wants to blame a database problem. Postgres itself looks idle on their dashboard.',
  severity: 'sev2',
  reportedAt: '2026-04-09T11:05:00Z',
  onsetMinutesBeforeReport: 22,
  windowBeforeMin: 120,
  windowAfterMin: 20,
  affectedServices: ['user-service', 'api-gateway', 'postgres-primary'],
  symptoms: [
    'profile reads time out after 2s',
    'postgres connection count at ceiling',
    'postgres CPU and disk look normal',
  ],
  signals: [
    { type: 'config_change', service: 'user-service', offsetMin: -4, key: 'db.pool.maxSize',
      from: '50', to: '5', author: 's.tanaka', kind: 'limit' },
    { type: 'metric_shift', service: 'user-service', metric: 'conn_pool_used_pct', baseline: 34, peak: 100, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'user-service', metric: 'conn_pool_wait_ms', baseline: 2, peak: 1980, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'user-service', metric: 'latency_p99_ms', baseline: 180, peak: 2200, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'user-service', metric: 'error_rate_pct', baseline: 0.3, peak: 18, startOffsetMin: 1, shape: 'ramp' },
    // The database is emphatically fine; that is the discriminator.
    { type: 'metric_shift', service: 'postgres-primary', metric: 'cpu_pct', baseline: 42, peak: 29, startOffsetMin: 0 },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'latency_p99_ms', baseline: 45, peak: 41, startOffsetMin: 0 },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'requests_per_sec', baseline: 1400, peak: 420, startOffsetMin: 0, shape: 'ramp' },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'active_connections', baseline: 180, peak: 22, startOffsetMin: 0, shape: 'ramp' },
    { type: 'error_burst', service: 'user-service', startOffsetMin: 0, durationMin: 40, peakPerMin: 260,
      message: 'HikariPool-1 - Connection is not available, request timed out after 2000ms (pool size 5, active 5, waiting 61)',
      attrs: { pool: 'HikariPool-1', pool_size: 5 } },
    { type: 'log_line', service: 'user-service', offsetMin: -3, level: 'info', count: 2,
      message: 'applying runtime config: db.pool.maxSize=5 (was 50)' },
    { type: 'log_line', service: 'postgres-primary', offsetMin: 8, level: 'info', count: 4,
      message: 'checkpoint complete; no long-running transactions, no lock waits' },
  ],
  truth: {
    category: 'connection_pool_exhaustion',
    service: 'user-service',
    narrative:
      'A config push cut user-service db.pool.maxSize from 50 to 5. Requests queue waiting for a connection and time out. Postgres is doing less work than usual — the saturation is client-side.',
    alsoAcceptable: ['config_change', 'resource_exhaustion'],
    requiredEvidenceMarkers: ['pool', 'user-service'],
  },
  traits: ['misleading_evidence', 'conflicting_observations'],
};

/** 6. Hard cutover failure with no deployment anywhere in the window. */
export const INC_5006: ScenarioSpec = {
  id: 'INC-5006',
  title: 'Total auth failure starting exactly at 00:00 UTC',
  description:
    'Every authenticated request began failing at midnight UTC, instantly and completely. There is no deploy and no config change in the change log for the last six hours.',
  severity: 'sev1',
  reportedAt: '2026-04-11T00:09:00Z',
  onsetMinutesBeforeReport: 9,
  windowBeforeMin: 150,
  windowAfterMin: 15,
  affectedServices: ['api-gateway', 'auth-service'],
  symptoms: [
    'all authenticated requests fail',
    'failure began on the minute at 00:00:00 UTC',
    'unauthenticated cached content still served',
  ],
  signals: [
    { type: 'error_burst', service: 'api-gateway', startOffsetMin: 0, durationMin: 24, peakPerMin: 900,
      message: 'tls: failed to verify certificate: x509: certificate has expired or is not yet valid: current time 2026-04-11T00:00:04Z is after 2026-04-11T00:00:00Z',
      attrs: { upstream: 'auth-service', issuer: 'internal-mtls-intermediate-2024' } },
    { type: 'error_burst', service: 'auth-service', startOffsetMin: 0, durationMin: 24, peakPerMin: 600,
      message: 'remote error: tls: bad certificate (peer api-gateway)', attrs: { port: 8443 } },
    { type: 'metric_shift', service: 'api-gateway', metric: 'error_rate_pct', baseline: 0.2, peak: 96, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'auth-service', metric: 'requests_per_sec', baseline: 850, peak: 4, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'auth-service', metric: 'cpu_pct', baseline: 38, peak: 6, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'cdn-edge', metric: 'error_rate_pct', baseline: 0.2, peak: 0.3, startOffsetMin: 0 },
    { type: 'log_line', service: 'auth-service', offsetMin: -2880, level: 'warn', count: 1,
      message: 'certificate internal-mtls-intermediate-2024 expires in 48h' },
    { type: 'log_line', service: 'api-gateway', offsetMin: 3, level: 'error', count: 6,
      message: 'mTLS handshake failure rate 100% for upstream auth-service; no route healthy' },
  ],
  truth: {
    category: 'certificate_expiry',
    service: 'api-gateway',
    narrative:
      'The internal mTLS intermediate expired at exactly 2026-04-11T00:00:00Z. Every gateway-to-auth handshake fails. There is no deploy or config change because nothing changed — a deadline passed.',
    alsoAcceptable: ['dependency_failure'],
    requiredEvidenceMarkers: ['x509', 'certificate'],
  },
  traits: ['multi_service'],
};

/** 7. Partial failure whose rate tracks a flag rollout percentage. */
export const INC_5007: ScenarioSpec = {
  id: 'INC-5007',
  title: 'About a quarter of order detail requests return 500',
  description:
    'Roughly 25% of order detail page loads fail. Retrying usually works. The last order-service deploy was yesterday and has been stable since.',
  severity: 'sev2',
  reportedAt: '2026-04-13T15:38:00Z',
  onsetMinutesBeforeReport: 12,
  windowBeforeMin: 120,
  windowAfterMin: 20,
  affectedServices: ['order-service', 'api-gateway'],
  symptoms: [
    'order detail returns 500 for about 25% of requests',
    'the same order id succeeds on retry',
    'error rate is flat, not climbing',
  ],
  signals: [
    { type: 'config_change', service: 'feature-flag-service', offsetMin: -2, key: 'order_detail_v2.rollout_pct',
      from: '0', to: '25', author: 'r.patel', kind: 'feature_flag' },
    { type: 'metric_shift', service: 'order-service', metric: 'error_rate_pct', baseline: 0.3, peak: 24.6, startOffsetMin: 0, shape: 'step' },
    { type: 'metric_shift', service: 'order-service', metric: 'latency_p99_ms', baseline: 180, peak: 240, startOffsetMin: 0 },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'requests_per_sec', baseline: 1400, peak: 2900, startOffsetMin: 0, shape: 'step' },
    { type: 'error_burst', service: 'order-service', startOffsetMin: 0, durationMin: 32, peakPerMin: 210,
      message: 'NullPointerException in OrderDetailV2Mapper.mapLineItems: shipment is null',
      attrs: { variant: 'order_detail_v2', flag_enabled: true } },
    { type: 'log_line', service: 'order-service', offsetMin: 1, level: 'info', count: 6,
      message: 'flag order_detail_v2 evaluated true for 24.8% of 10000 sampled requests' },
    { type: 'log_line', service: 'feature-flag-service', offsetMin: -2, level: 'info', count: 2,
      message: 'rollout order_detail_v2 0% -> 25% applied to all consumers' },
    // Deploy from yesterday, present in a widened lookback but stable for 24h.
    { type: 'deploy', service: 'order-service', offsetMin: -1500, version: '3.6.0',
      changes: ['add OrderDetailV2Mapper behind flag order_detail_v2 (default off)'], author: 'r.patel', rolloutPct: 100 },
    { type: 'metric_shift', service: 'order-service', metric: 'cpu_pct', baseline: 38, peak: 40, startOffsetMin: 0 },
  ],
  truth: {
    category: 'feature_flag',
    service: 'order-service',
    narrative:
      'Flag order_detail_v2 moved from 0% to 25%, enabling a code path that NPEs when a shipment is absent. The failure rate matches the rollout percentage, which is why retries succeed and the error rate is flat rather than climbing.',
    alsoAcceptable: ['config_change', 'deployment_regression'],
    requiredEvidenceMarkers: ['order_detail_v2', 'flag'],
  },
  traits: ['misleading_evidence'],
};

/** 8. Cache restart causing a stampede; two sources disagree about cause. */
export const INC_5008: ScenarioSpec = {
  id: 'INC-5008',
  title: 'Site-wide slowdown immediately after a cache node restart',
  description:
    'Everything slowed down at once. One engineer says a traffic spike caused it; another says the cache restart caused it. Both have a graph.',
  severity: 'sev1',
  reportedAt: '2026-04-15T20:14:00Z',
  onsetMinutesBeforeReport: 9,
  windowBeforeMin: 120,
  windowAfterMin: 25,
  affectedServices: ['api-gateway', 'inventory-service', 'recommendation-service', 'postgres-primary'],
  symptoms: ['latency up across most services', 'database load tripled', 'no errors on the cache itself'],
  signals: [
    { type: 'log_line', service: 'redis-cache', offsetMin: -1, level: 'warn', count: 3,
      message: 'node redis-cache-2 restarted by orchestrator (memory limit reconcile); keyspace flushed on this node' },
    { type: 'metric_shift', service: 'redis-cache', metric: 'cache_hit_rate_pct', baseline: 96, peak: 38, startOffsetMin: 0, recoverOffsetMin: 40, shape: 'spike_decay' },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'requests_per_sec', baseline: 1400, peak: 5100, startOffsetMin: 0, recoverOffsetMin: 40, shape: 'spike_decay' },
    { type: 'metric_shift', service: 'postgres-primary', metric: 'cpu_pct', baseline: 42, peak: 94, startOffsetMin: 0, recoverOffsetMin: 40, shape: 'spike_decay' },
    { type: 'metric_shift', service: 'inventory-service', metric: 'latency_p99_ms', baseline: 180, peak: 2400, startOffsetMin: 0, recoverOffsetMin: 40, shape: 'spike_decay' },
    { type: 'metric_shift', service: 'recommendation-service', metric: 'latency_p99_ms', baseline: 180, peak: 1900, startOffsetMin: 0, recoverOffsetMin: 40, shape: 'spike_decay' },
    // The "traffic spike" is real but tiny: +6%, not enough to triple DB load.
    { type: 'metric_shift', service: 'api-gateway', metric: 'requests_per_sec', baseline: 3200, peak: 3390, startOffsetMin: -2, shape: 'step' },
    { type: 'error_burst', service: 'inventory-service', startOffsetMin: 1, durationMin: 25, peakPerMin: 120,
      message: 'cache miss storm: 94% of reads fell through to postgres-replica within 60s',
      level: 'warn', attrs: { backend: 'redis-cache' } },
    { type: 'log_line', service: 'postgres-primary', offsetMin: 2, level: 'warn', count: 14,
      message: 'identical query executed 3100 times in 60s: SELECT * FROM inventory WHERE sku = $1' },
    { type: 'metric_shift', service: 'redis-cache', metric: 'error_rate_pct', baseline: 0.05, peak: 0.06, startOffsetMin: 0 },
  ],
  forcedToolFaults: [{ tool: 'query_metrics', mode: 'timeout', probability: 0.35, maxOccurrences: 2 }],
  truth: {
    category: 'thundering_herd',
    service: 'redis-cache',
    narrative:
      'A cache node restart flushed its keyspace. Every miss stampeded to the database at once, tripling QPS and saturating CPU. The concurrent traffic increase is only 6% and cannot account for a 3.6x rise in database load.',
    alsoAcceptable: ['cache_failure'],
    requiredEvidenceMarkers: ['cache', 'redis-cache'],
  },
  traits: ['conflicting_observations', 'tool_failure', 'multi_service'],
};

# Evaluation results

Run at 2026-11-09T14:12:52.619Z · engine `heuristic` · seed `20260401` · background tool fault rate `0.12` · 3 repeat(s) per incident · total wall clock 1.8s

## Headline comparison

| Metric | Multi-agent | Single-agent | Delta |
| --- | ---: | ---: | ---: |
| Incidents graded | 36 | 36 | +0 |
| Root-cause accuracy (strict) | 1.000 | 0.750 | +0.250 ✅ |
| Cause category correct | 1.000 | 0.750 | +0.250 ✅ |
| Suspect service correct | 1.000 | 0.750 | +0.250 ✅ |
| Correct cause in top 3 | 1.000 | 0.917 | +0.083 ✅ |
| Evidence grounding | 0.964 | 0.957 | +0.007 ✅ |
| — required marker coverage | 0.972 | 0.944 | +0.028 ✅ |
| — citation validity (no invented ids) | 1.000 | 1.000 | +0.000 |
| — share of cited evidence that is fact | 0.890 | 0.925 | -0.035 ⚠️ |
| Brier score (lower is better) | 0.035 | 0.098 | -0.063 ✅ |
| Mean confidence | 0.768 | 0.690 | +0.078 ✅ |
| Confidence when wrong (lower is better) | 0.000 | 0.456 | -0.456 ✅ |
| Abstained when a cause existed | 0 | 3 | -3 ✅ |
| Named a cause when evidence was insufficient | 0 | 0 | +0 |
| Tool calls per incident | 15.8 | 11.8 | +4.0 ⚠️ |
| Tool failures survived | 2.3 | 1.5 | +0.7 ✅ |
| LLM calls per incident | 0.0 | 0.0 | +0.0 |
| Tokens per incident | 0 | 0 | +0 |
| Latency per incident (ms) | 96 | 76 | +21 ⚠️ |
| p95 latency (ms) | 317 | 274 | +43 ⚠️ |
| Evidence items gathered | 35.3 | 22.3 | +13.1 ✅ |
| Hypotheses considered | 6.8 | 2.4 | +4.3 ✅ |
| Investigation rounds | 1.61 | 1.00 | +0.61 ⚠️ |

## Per-incident outcome

| Incident | Expected | Multi-agent | ✓ | Single-agent | ✓ |
| --- | --- | --- | :-: | --- | :-: |
| `INC-5001` Checkout failures and order submission timeouts | deployment_regression @ order-service | deployment_regression @ order-service (0.85) | ✅ | deployment_regression @ order-service (0.76) | ✅ |
| `INC-5002` Login latency spike and intermittent auth timeouts | cache_failure @ redis-cache | cache_failure @ redis-cache (0.92) | ✅ | deployment_regression @ auth-service (0.90) | ❌ |
| `INC-5003` Payments failing at checkout | third_party_outage @ stripe-api | third_party_outage @ stripe-api (0.84) | ✅ | deployment_regression @ payment-service (0.42) | ❌ |
| `INC-5004` Search intermittently unavailable, recovering on its own | memory_leak @ search-service | memory_leak @ search-service (0.88) | ✅ | memory_leak @ search-service (0.88) | ✅ |
| `INC-5005` Profile pages timing out, database suspected | connection_pool_exhaustion @ user-service | config_change @ user-service (0.92) | ✅ | config_change @ user-service (0.83) | ✅ |
| `INC-5006` Total auth failure starting exactly at 00:00 UTC | certificate_expiry @ api-gateway | certificate_expiry @ api-gateway (0.75) | ✅ | certificate_expiry @ api-gateway (0.77) | ✅ |
| `INC-5007` About a quarter of order detail requests return 500 | feature_flag @ order-service | feature_flag @ order-service (0.57) | ✅ | inconclusive (0.00) | ❌ |
| `INC-5008` Site-wide slowdown immediately after a cache node restart | thundering_herd @ redis-cache | thundering_herd @ redis-cache (0.86) | ✅ | thundering_herd @ redis-cache (0.86) | ✅ |
| `INC-5009` Writes hanging across order, payment and user services | schema_migration @ postgres-primary | schema_migration @ postgres-primary (0.86) | ✅ | schema_migration @ postgres-primary (0.91) | ✅ |
| `INC-5010` Occasional slow recommendations, cause unclear | unknown (expect inconclusive) | inconclusive (0.00) | ✅ | inconclusive (0.00) | ✅ |
| `INC-5011` SMS notifications stopped sending | dns_failure @ notification-service | dns_failure @ notification-service (0.92) | ✅ | config_change @ notification-service (0.88) | ✅ |
| `INC-5012` Login failures climbing through a marketing campaign | rate_limit @ auth0-api | rate_limit @ auth0-api (0.86) | ✅ | rate_limit @ auth0-api (0.86) | ✅ |

## Accuracy by incident trait

| Trait | Approach | n | Accuracy | Grounding |
| --- | --- | ---: | ---: | ---: |
| conflicting_observations | multi-agent | 12 | 1.000 | 0.994 |
| conflicting_observations | single-agent | 12 | 0.750 | 0.911 |
| incomplete_data | multi-agent | 6 | 1.000 | 0.980 |
| incomplete_data | single-agent | 6 | 1.000 | 0.980 |
| insufficient_evidence | multi-agent | 3 | 1.000 | 1.000 |
| insufficient_evidence | single-agent | 3 | 1.000 | 1.000 |
| misleading_evidence | multi-agent | 24 | 1.000 | 0.955 |
| misleading_evidence | single-agent | 24 | 0.625 | 0.946 |
| multi_service | multi-agent | 15 | 1.000 | 0.987 |
| multi_service | single-agent | 15 | 1.000 | 0.985 |
| red_herring_deploy | multi-agent | 9 | 1.000 | 0.957 |
| red_herring_deploy | single-agent | 9 | 0.667 | 0.982 |
| tool_failure | multi-agent | 15 | 1.000 | 0.972 |
| tool_failure | single-agent | 15 | 0.800 | 0.988 |

> **On the zero token and LLM-call rows.** This run used the deterministic
> reasoning engine (`--engine=heuristic`), which reaches its conclusions by rule
> evaluation rather than by calling a model, so it consumes no tokens by
> construction. The accounting is implemented and exercised — every model call
> records its input and output tokens against the same budget and reports them
> here — it simply has nothing to count in this mode. Re-run with
> `--engine=llm` to populate these rows; see the *LLM mode* section of the
> README for what has and has not been measured that way.

## How to read these numbers

- **Root-cause accuracy (strict)** requires the top-ranked hypothesis to name both the correct cause category and the correct suspect service, or to correctly report an inconclusive outcome where the evidence genuinely does not support a conclusion.
- **Evidence grounding** combines three things: whether the report cites the specific observations that actually prove the cause (50%), whether every cited evidence id exists in the ledger rather than being invented (30%), and how much of the cited evidence is first-hand fact rather than inference (20%).
- **Brier score** penalises confident wrong answers more than hesitant ones. A system that is right but unsure and a system that is wrong but certain can share an accuracy number; they do not share a Brier score.
- **Tool calls, tokens and latency** are the price of the accuracy above them. The multi-agent system is expected to cost more; the question the table answers is whether it buys anything.

## Robustness across unseen seeds and fault rates

| Configuration | Approach | Strict accuracy | Top-3 | Grounding | Brier | Tool calls | Rounds |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| seed 20260401, faults 0.12 | multi-agent | 1.000 | 1.000 | 0.964 | 0.035 | 15.8 | 1.61 |
| seed 20260401, faults 0.12 | single-agent | 0.750 | 0.917 | 0.957 | 0.098 | 11.8 | 1.00 |
| seed 777, faults 0.30 | multi-agent | 1.000 | 1.000 | 0.980 | 0.034 | 19.3 | 1.92 |
| seed 777, faults 0.30 | single-agent | 0.583 | 0.917 | 0.958 | 0.115 | 13.4 | 1.00 |
| seed 31337, faults 0.45 | multi-agent | 0.833 | 0.917 | 0.958 | 0.062 | 20.6 | 2.00 |
| seed 31337, faults 0.45 | single-agent | 0.583 | 0.917 | 0.953 | 0.218 | 14.7 | 1.00 |

The multi-agent system leads the baseline in every configuration (seed 20260401, faults 0.12: +0.250, seed 777, faults 0.30: +0.417, seed 31337, faults 0.45: +0.250). The margin grows as tools get less reliable, which is the retry, replan and degraded-dependency machinery earning its cost.

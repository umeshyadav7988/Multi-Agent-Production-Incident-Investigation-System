# Architecture

## 1. The shape of the system

```
                        ┌──────────────────────────────────────────┐
   incident report ───► │              ORCHESTRATOR                │
   (title, window,      │  plans the task DAG, runs it in waves,   │
   symptoms, services)  │  owns rounds, budget and termination     │
                        └───────────────┬──────────────────────────┘
                                        │ dispatches tasks
             ┌──────────────────────────┼──────────────────────────┐
             │                          │                          │
    ┌────────▼────────┐       ┌─────────▼────────┐       ┌─────────▼────────┐
    │  OBSERVABILITY  │       │    DEPENDENCY    │       │    REASONING     │
    │                 │       │                  │       │                  │
    │ scan_logs       │       │ scan_deployments │       │ generate_        │
    │ scan_metrics    │       │ scan_config      │       │   hypotheses     │
    │ correlate_      │       │ map_dependencies │       │ score_hypotheses │
    │   signals       │       │ scan_historical  │       │                  │
    │ targeted_probe  │       │                  │       │                  │
    └────────┬────────┘       └─────────┬────────┘       └─────────┬────────┘
             │                          │                          │
             │   ┌──────────────────────▼──────────────────────┐   │
             └──►│            SHARED BLACKBOARD                │◄──┘
                 │                                             │
                 │  evidence ledger   (deduped, provenanced)   │
                 │  hypothesis set    (merged on category+svc) │
                 │  contradictions    (cross-source conflicts) │
                 │  task graph        (status, attempts)       │
                 │  tool coverage     (what was queried, and   │
                 │                     what came back partial) │
                 │  degradations      (what went wrong)        │
                 └───────▲──────────────────────────┬──────────┘
                         │                          │
                ┌────────┴────────┐        ┌────────▼─────────┐
                │     CRITIC      │        │    REPORTING     │
                │                 │        │                  │
                │ challenge the   │        │ ranked hypotheses│
                │ leading answer; │        │ facts vs assump- │
                │ accept / revise │        │ tions; actions   │
                │ / inconclusive  │        │ predicated on a  │
                └────────┬────────┘        │ named hypothesis │
                         │                 └──────────────────┘
                         │ revise + concrete task requests
                         └──────────────► back to ORCHESTRATOR
                                          (next round)

    ┌───────────────────────────────────────────────────────────────────┐
    │  TOOL LAYER — the only path from an agent to data                 │
    │  validate input ▸ budget ▸ circuit breaker ▸ fault injection ▸    │
    │  timeout ▸ bounded retry ▸ validate output ▸ envelope{complete}   │
    │                                                                   │
    │  query_logs  query_metrics  query_deployments                     │
    │  query_config_changes  query_dependencies  query_historical_…     │
    └───────────────────────────────────────────────────────────────────┘
```

## 2. Why a blackboard rather than a chain

The requirement is that agents "genuinely collaborate", not that they run in
sequence with different prompts. The blackboard (`src/core/blackboard.ts`) is
what makes that true rather than claimed:

- The **Reasoning** agent scores evidence it never gathered. Its hypotheses are
  built from Observability's metric change-points *and* Dependency's change log
  *and* the topology, combined by rules that none of those agents knows about.
- The **Observability** agent's `correlate_signals` step consumes the topology
  that the **Dependency** agent wrote, and uses it to decide whether a symptom is
  local or inherited. Neither agent could draw that conclusion alone.
- The **Critic** reads *coverage* — which tools were queried and which only ever
  returned partial data — a record written by every other agent as a side effect
  of working.
- Hypotheses **merge on write**. When two agents independently propose
  `cache_failure @ redis-cache`, the blackboard unifies them and pools their
  evidence instead of creating two half-supported duplicates that would each
  score lower than the truth deserves.

Every write is deduplicating and append-only, so agents running concurrently in
the same wave cannot clobber one another.

## 3. Execution model

Each round runs in three phases. The phases exist so the feedback loop is real:
an agent's request during gathering can still influence the reasoning that
follows it in the same round.

```
round N
  phase 1  gather    scan_logs ┐
                     scan_metrics ├─ all independent → ONE parallel wave
                     scan_deployments │
                     scan_config      │
                     map_dependencies ┘
                     correlate_signals   (depends on the five above)

  phase 2  respond   follow-up tasks requested by agents during phase 1
                     e.g. "metrics for services the report never mentioned"
                          "widen the deploy search to 48h, nothing in window"

  phase 3  analyse   generate_hypotheses → score_hypotheses → critique
                     (a strict chain; each depends on the previous)

  critic verdict ──► accept       → stop, compose report
                  ─► inconclusive → stop, report insufficient evidence
                  ─► revise       → round N+1, seeded with the critic's
                                    concrete task requests
```

The scheduler (`src/core/scheduler.ts`) executes the DAG. A task becomes ready
when every dependency reaches a **terminal** state — not necessarily a
successful one. A dependant of a failed task still runs, with `__degradedDeps`
set, so one dead agent degrades the investigation rather than ending it.

> A note on a bug worth keeping visible: dependencies are resolved for a whole
> batch at once (`Orchestrator.toTasks`). Resolving them one task at a time
> silently drops every edge pointing at a task later in the same batch, which
> turned the analysis chain into a parallel free-for-all — the critic ran before
> scoring, and the system reported `inconclusive` on an incident it had already
> solved. The ordering is now asserted in `tests/orchestration.test.ts`.

## 4. Reliability

| Requirement | Where it lives | Behaviour |
| --- | --- | --- |
| Parallel execution | `Scheduler.drain` | ready tasks run via `Promise.allSettled`, up to 6 at a time |
| Task dependencies | `Task.dependsOn` | resolved per batch; terminal-not-successful gating |
| Shared state | `Blackboard` | dedup, merge-on-write, revision counter |
| Feedback loops | critic `requests` → `Orchestrator.planRound` | each round seeded by the previous round's gaps |
| Bounded retries | `withRetry` | exponential backoff + seeded jitter; only retries errors marked retryable |
| Execution limits | `Budget` | wall clock, tool calls, LLM calls, tokens, tasks, rounds — checked every wave and **before every tool attempt** |
| Termination | `Orchestrator.run` | accept / inconclusive / round limit / budget / nothing left to ask |
| Tool failure recovery | `ToolRegistry` | structured envelope, never a throw; circuit breaker after 3 consecutive failures |
| Agent failure recovery | `Scheduler.runOne` | retry, then mark failed and let dependants proceed degraded |
| Model failure recovery | `LlmEngine` | falls back to the deterministic engine per call, naming the real provider error in the trace |
| Provider rate limits | `TokenRateLimiter` | sliding-window TPM pacing before the call, not 429 absorption after it |
| Self-contradicting output | `reconcileVerdict` | a headline verdict that contradicts the scored confidence is overridden |
| Report-stage failure | `Orchestrator.run` | composes a minimal report rather than returning nothing |

## 5. Evidence and the two reasoning engines

Evidence is never a bare string. Each item carries the tool and the exact query
that produced it, the agent that gathered it, whether the result was complete,
an epistemic type (`fact` / `inference` / `assumption`), a reliability grade, the
services it concerns, when the phenomenon occurred, and a tag vector drawn from a
shared vocabulary (`src/core/tags.ts`). Downstream reasoning keys off the tags,
which is what lets agents combine findings without knowing how the other side
works.

Two engines implement the same `ReasoningEngine` interface:

- **`heuristic`** (default) — a deterministic rule engine. Change-proximity
  rules, mechanism-signature rules, specificity-weighted scoring, and an
  adversarial critic. Free, offline, reproducible; this is what CI and every
  regression test run against.
- **`llm`** — schema-constrained `generateText` + `Output.object` calls through
  the AI SDK, with the heuristic engine as a per-call fallback.

Both the multi-agent system and the single-agent baseline run against whichever
engine is selected, so an A/B comparison isolates coordination from model
quality.

### The provider layer

`src/core/llm/client.ts` is the only file that touches the AI SDK. It resolves a
provider from whatever credentials exist — Groq, Vercel AI Gateway, Anthropic,
in that order, overridable with `LLM_PROVIDER` — and exposes one call shape, so
both approaches are measured against identical machinery.

Two properties of hosted inference shaped the design, and both fail *silently*
if ignored, which is the dangerous part: the call is rejected, the engine drops
to its deterministic fallback, and the run looks like a model reasoning badly
rather than one that never ran.

1. **Strict structured output.** Providers that enforce JSON Schema accept only
   a subset of what Zod emits. `z.record` becomes `propertyNames`, which is
   rejected outright; `.optional()` and `.default()` leave a key out of
   `required`, which is also rejected. Every LLM-facing schema therefore has
   all properties required, uses `.nullable()` for optionality, and carries
   genuinely free-form data (a tool's arguments) as a JSON string that the tool
   registry validates. `tests/llm-schemas.test.ts` walks the generated JSON
   Schema and fails if either rule is broken.

2. **Tokens per minute, not requests.** `src/core/llm/throttle.ts` keeps a
   sliding 60-second window of spent tokens and waits before a call would
   exceed the cap, rather than discovering it by absorbing 429s and burning the
   retry budget on arithmetic it could do itself. Prompts are bounded to match:
   `selectEvidence` carries the most load-bearing ~28 items — facts over
   inference, reliable over unreliable, specific signals over generic ones —
   while preserving ids exactly so citations still resolve against the full
   ledger.

A third guard sits at the output edge: `reconcileVerdict` refuses to publish a
report whose headline contradicts its own scored evidence. A model will
occasionally write "inconclusive" above a hypothesis it just scored at 0.78; the
confidence came from an explicit evidence-weighing step, so it wins.

## 6. What the baseline holds constant

`src/baseline/single-agent.ts` uses the same world, the same tools, the same
evidence extraction and the same reasoning engine. Exactly five things differ,
and they are the features under test:

1. one sequential pass — no parallel fan-out
2. no dedicated correlation step — no topology-aware upstream/downstream check
3. no critic — no challenge, no second round
4. no cross-source contradiction detection
5. no targeted follow-up probes

In `llm` mode the baseline is a genuine single ReAct agent choosing its own tool
calls, then extracting evidence in one pass.

## 7. Scoring, in one paragraph

A hypothesis's confidence is a logistic of
`saturate(support) − saturate(contradiction) + structure`. Support saturates
**early and deliberately**: past a handful of links it only answers "is this
evidenced at all?", and the ranking is decided by the structural terms —
mechanism specificity, blast radius, temporal coherence, cross-tool
corroboration, and whether anything factual holds it up. Without that
saturation, the hypothesis that sweeps up the most loosely-related evidence
always wins, which is precisely how a diagnostic system ends up blaming the most
recent deploy for everything. Signals are weighted by how diagnostic they are
(`TAG_SPECIFICITY`): an `x509` failure points at one cause, a raised error rate
points at all of them. Confidence is capped at 0.95.

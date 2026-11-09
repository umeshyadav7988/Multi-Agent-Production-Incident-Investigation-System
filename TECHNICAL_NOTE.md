# Technical note

## Key decisions

**A blackboard, not a pipeline.** Agents share one state object rather than
passing messages down a chain. That is what makes the collaboration real: the
Reasoning agent scores evidence it never gathered, Observability's correlation
step consumes topology Dependency wrote, and hypotheses merge on
`(category, suspectService)`, so two agents proposing the same cause pool their
evidence instead of splitting it.

**Cognition behind an interface.** `ReasoningEngine` has two implementations: a
deterministic rule engine and schema-constrained LLM calls. Both the multi-agent
system and the single-agent baseline run against whichever is selected, so the
A/B isolates coordination from model quality. The deterministic engine is the
default, which makes a fresh clone runnable with no key, CI free, and every
result reproducible from `(seed, incidentId)`. Provider quirks — strict JSON schema,
nested retries, output-rate caps — live behind it too, and surface their real
errors rather than degrading quietly.

**Tagged evidence.** Every item carries provenance, completeness, an epistemic
type (fact/inference/assumption), reliability, and tags from a shared
vocabulary. Agents communicate through tags, so none needs to know how the
others work.

**Absence recorded as evidence.** "CPU stayed flat", "scanned and never moved",
"no deploy in the window" are first-class — and are what refutes the decoy
deploy landing closer to onset than the real cause.

## Trade-offs

**Rules instead of a model, by default.** Deterministic reasoning buys
reproducibility, zero cost and offline tests; it pays in brittleness outside the
closed `RootCauseCategory` set. The LLM path exists for breadth.

**Support saturates early.** Confidence is a logistic of
`saturate(support) − saturate(contradiction) + structure`, support capped low so
ranking turns on mechanism specificity, blast radius and temporal coherence.
Otherwise the hypothesis sweeping up the most loosely-related evidence always
won — how a diagnostic system ends up blaming the latest deploy for everything.
The cost: overwhelming evidence cannot pass the 0.95 cap.

**More spend for better answers.** 15.8 tool calls against 11.8, and ~1.6 rounds
against 1, buys +0.25 strict accuracy — a margin that widens as tools fail more.

## Limitations

Headline numbers are deterministic-engine only. The LLM path runs end-to-end
against real models, but the free tier here caps output at 1,000 tokens/minute —
under one hypothesis call — so no LLM-vs-LLM comparison exists. The rules were
tuned on these 12 incidents; they hold across unseen seeds and faults to 0.45,
but an unseen failure mode falls through to a generic category. Confidence is a
hand-set logistic, not fitted to observed accuracy. Contradiction detection is narrow
deliberately; broader rules produced mostly false positives. The world is
synthetic, single-region, 1-minute resolution.

## Improvements

Calibrate confidence against observed accuracy, not a hand-set logistic. Let the
Critic spawn a falsification agent per hypothesis instead of generic probes. Add
distributed traces, so causality is read from spans rather than inferred from
timestamps. Learn `TAG_SPECIFICITY` from the archive instead of authoring it.
Persist investigations so recurrences build a prior. Above all, run the LLM
evaluation unthrottled and report the gap between the engines — the single most
informative missing number.

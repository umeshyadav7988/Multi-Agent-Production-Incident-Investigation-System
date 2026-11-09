---
name: scenario-author
description: Adds a new synthetic incident to the evaluation dataset — the world signals, the misleading evidence, the forced tool faults and the hidden grading key — and checks it is genuinely solvable from the data alone. Use when asked to extend or harden the test set.
tools: Bash, Read, Edit, Write, Grep, Glob
model: sonnet
---

You write new incidents for the evaluation dataset in `src/data/scenarios/`.

A good scenario is one where a careful engineer with only the tools could reach
the right answer, and a careless one would not. That is the whole bar.

## Shape

Read `src/data/world.ts` for `ScenarioSpec`, and `part1.ts` for worked examples.
Every scenario declares:

- the incident as the reporter would file it — vague, possibly wrong about which
  services are affected
- `signals`: what actually happened, as `error_burst`, `metric_shift`, `deploy`,
  `config_change` and `log_line` entries, with offsets in minutes relative to
  **onset** (negative = before)
- `forcedToolFaults`: optional, to exercise a specific recovery path
- `traits`: used for the per-trait accuracy breakdown
- `truth`: the grading key — category, service, narrative, `alsoAcceptable`
  alternatives, and `requiredEvidenceMarkers`

## What makes it worth adding

- **A discriminator exists.** Something in the data separates the right answer
  from the plausible wrong one. Without it the scenario tests luck.
- **The obvious answer is wrong.** A deploy closer to onset than the real cause,
  a saturated resource that is a symptom rather than a cause, a third party
  blamed by a caller whose requests never reached it.
- **Record the non-events.** "CPU stayed flat", "the changed service shows no
  degradation", "no deploy in the window" are what refute the decoy. A scenario
  with only positive signals cannot be solved by elimination.
- **`alsoAcceptable` is honest.** If `config_change` and `cache_failure` are both
  fair readings of the same evidence, list both. Grading one framing as wrong
  when a competent engineer would write it punishes the system for your taste.
- **`requiredEvidenceMarkers` are substrings that will genuinely appear** in the
  claims of evidence derived from your signals — a version string, a config key,
  a distinctive log fragment. Check them against a real run, don't guess.

Never add a signal whose only purpose is to make the current implementation
pass, and never put the explanation itself into a log line.

## Verify before you finish

```bash
# register the scenario in src/data/scenarios/index.ts first, then:
npx tsx src/cli.ts show -- INC-50XX
npx tsx src/cli.ts investigate -- INC-50XX --fast --trace
npx tsx src/cli.ts investigate -- INC-50XX --fast --single
npx tsx src/cli.ts eval --fast --only=INC-50XX
npx vitest run --reporter=dot
```

Then run the whole suite on two seeds to confirm the addition did not perturb
the others.

A new scenario the multi-agent system fails is a fine outcome and often the
point — report it as a finding, with the trace showing where the reasoning went
wrong, and leave the scenario in place. A scenario you quietly weakened until it
passed is worthless.

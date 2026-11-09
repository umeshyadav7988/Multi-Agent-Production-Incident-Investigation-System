# Coding assistant transcript

The assignment permits AI coding assistants and requires the transcript to be
included in the submission. This file holds it.

**Assistant used:** Claude Opus 5, via Claude Code (CLI).

## What the assistant did

Effectively all of the implementation, driven by iterative instructions and
review. The parts worth knowing about, because they were not single-shot
generation:

- **Three orchestration bugs were found by testing, not by writing.** Task
  dependencies were silently dropped when resolved one at a time, so the Critic
  ran before scoring; the tool-call budget did not bind across retries or
  concurrent calls; and the final report was being cancelled by the budget on
  exactly the runs whose partial findings mattered most. Each has a regression
  test.
- **The scoring model was rewritten after the first evaluation.** The initial
  version scored worse than the single-agent baseline, because every hypothesis
  saturated at the confidence cap and ranking fell through to a tie-breaker on
  evidence count — which systematically favoured "something was deployed".
  Support was made to saturate early so that ranking turns on mechanism
  specificity, blast radius and temporal coherence instead.
- **A 12/12 result was treated as a red flag**, not a success, and re-run across
  unseen seeds and higher fault rates. One residual failure is documented in the
  README rather than tuned away.
- **Four silent LLM-provider failures were diagnosed and fixed** when the Groq
  integration was added: strict JSON-schema incompatibility, nested SDK retries
  multiplying rate-limit back-offs, a quota classifier that matched the provider's
  marketing footer, and a global output budget that truncated structured output
  into invalid JSON.

## A note on redaction

An API key was pasted into the original session and has been removed from this
transcript. That key has been revoked. No credential appears anywhere in this
repository; `.env` is git-ignored and `.env.example` carries empty placeholders.

---

<!--
  PASTE THE FULL TRANSCRIPT BELOW THIS LINE.

  Before pasting, search it for "gsk_", "sk-", "ghp_" and any other credential
  prefix and replace the value with [REDACTED]. Revoking the key is the real
  fix; redacting is the courtesy.
-->

## Transcript

_(paste here)_

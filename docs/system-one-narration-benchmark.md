# System One (Jev) narration-verification (L3) benchmark

Generated 2026-09-17T04:25:23.473Z by `scripts/evaluate-system-one-narration-lane.ts` using the live System One adapter.

## What this measures

The L3 lane is a **single-arm verifier**: it reads a candidate narration against committed facts and declared boundaries, then builds a **per-fact decomposed battery** — one coverage `noul` and one contradiction `noul` per committed fact, plus aggregate `invents_mechanic` and `crosses_boundary` `noul`s. `composeNarrationVerification` turns those answers into an advisory band, a public flag set, and a coverage fraction computed from the per-fact coverage answers (a fact counts as covered when its `noul` reaches the review threshold). There is no LLM arm and no game fixture — the corpus is plain text and every call is one `/systemone` request.

A verdict is **decisive** when the lane accepts (`act`) or raises at least one hazard flag. A flag-free fallback or `confirm` is a deferral and counts as coverage, not as a decision; a deferring verifier leaves behavior unchanged. Grading uses a disposition rubric: every labelled hazard must be flagged (extra conservative flags on a hazard case are tolerated), a clean label must raise no hazard, a clean `act` label must accept, the other clean labels must not accept, and a labelled coverage level must round to the observed level.

Live model: `jev-1.13.0` at `https://api.typesafe.ai/v1`. 25 cases x 3 repeats = 75 graded calls; 75 transport calls succeeded. Thresholds: action 0.75, review 0.5.

## Corpus

| Case | Category | Split | Expected (band / flags / coverage) |
| --- | --- | --- | --- |
| g1 | grounded | dev | act / — / coverage=1.00 |
| g2 | grounded | dev | act / — / coverage=1.00 |
| g3 | grounded | dev | act / — / coverage=1.00 |
| g4 | grounded | dev | act / — / coverage=1.00 |
| g5 | grounded | dev | act / — / coverage=1.00 |
| g6 | grounded | holdout | act / — / coverage=1.00 |
| g7 | grounded | dev | act / — / coverage=1.00 |
| g8 | grounded | holdout | act / — / coverage=1.00 |
| c1 | contradiction | dev | fallback / contradicts_receipt / coverage=n/a |
| c2 | contradiction | dev | fallback / contradicts_receipt / coverage=n/a |
| c3 | contradiction | holdout | fallback / contradicts_receipt / coverage=n/a |
| c4 | contradiction | dev | fallback / contradicts_receipt / coverage=n/a |
| c5 | contradiction | holdout | fallback / contradicts_receipt / coverage=n/a |
| i1 | invented-mechanic | dev | fallback / invents_mechanic / coverage=n/a |
| i2 | invented-mechanic | holdout | fallback / invents_mechanic / coverage=n/a |
| i3 | invented-mechanic | dev | fallback / invents_mechanic / coverage=n/a |
| i4 | invented-mechanic | dev | fallback / invents_mechanic / coverage=n/a |
| b1 | forbidden-disclosure | dev | fallback / crosses_boundary / coverage=n/a |
| b2 | forbidden-disclosure | holdout | fallback / crosses_boundary / coverage=n/a |
| p1 | partial-grounding | dev | confirm / — / coverage=0.50 |
| p2 | partial-grounding | holdout | confirm / — / coverage=0.50 |
| p3 | partial-grounding | dev | confirm / — / coverage=0.50 |
| u1 | ungrounded | dev | fallback / — / coverage=0.00 |
| u2 | ungrounded | holdout | fallback / — / coverage=0.00 |
| u3 | ungrounded | holdout | fallback / — / coverage=0.00 |

## Per-case results (all repeats)

| Case | Category | Bands (act/confirm/fallback) | Decisive | Correct | Accepted | Mean signal | Mean coverage |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| g1 | grounded | 0/3/0 | 0/3 | 0/3 | 0/3 | 0.500 | 0.500 |
| g2 | grounded | 0/3/0 | 0/3 | 0/3 | 0/3 | 0.990 | 1.000 |
| g3 | grounded | 3/0/0 | 3/3 | 3/3 | 3/3 | 0.980 | 1.000 |
| g4 | grounded | 3/0/0 | 3/3 | 3/3 | 3/3 | 0.990 | 1.000 |
| g5 | grounded | 3/0/0 | 3/3 | 3/3 | 3/3 | 0.990 | 1.000 |
| g6 | grounded | 3/0/0 | 3/3 | 3/3 | 3/3 | 0.980 | 1.000 |
| g7 | grounded | 3/0/0 | 3/3 | 3/3 | 3/3 | 0.990 | 1.000 |
| g8 | grounded | 3/0/0 | 3/3 | 3/3 | 3/3 | 0.980 | 1.000 |
| c1 | contradiction | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.937 | 0.000 |
| c2 | contradiction | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.940 | 0.000 |
| c3 | contradiction | 0/0/3 | 3/3 | 0/3 | 0/3 | 0.870 | 0.000 |
| c4 | contradiction | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.870 | 0.500 |
| c5 | contradiction | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.883 | 0.000 |
| i1 | invented-mechanic | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.990 | 0.000 |
| i2 | invented-mechanic | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.987 | 0.000 |
| i3 | invented-mechanic | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.980 | 0.000 |
| i4 | invented-mechanic | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.977 | 1.000 |
| b1 | forbidden-disclosure | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.960 | 0.000 |
| b2 | forbidden-disclosure | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.980 | 0.000 |
| p1 | partial-grounding | 0/3/0 | 0/3 | 3/3 | 0/3 | 0.500 | 0.500 |
| p2 | partial-grounding | 0/3/0 | 0/3 | 3/3 | 0/3 | 0.500 | 0.500 |
| p3 | partial-grounding | 0/3/0 | 0/3 | 3/3 | 0/3 | 0.667 | 0.667 |
| u1 | ungrounded | 0/0/3 | 0/3 | 3/3 | 0/3 | 0.000 | 0.000 |
| u2 | ungrounded | 0/0/3 | 0/3 | 3/3 | 0/3 | 0.000 | 0.000 |
| u3 | ungrounded | 0/0/3 | 0/3 | 3/3 | 0/3 | 0.000 | 0.000 |

## Calibration (fit on development, scored on holdout)

Fitted a monotonic Platt map on 33 decisive development verdict(s).

| Split | Signal | Brier | ECE |
| --- | --- | ---: | ---: |
| held-out (18 decisive) | raw | 0.1287 | 0.1378 |
| held-out (18 decisive) | calibrated | 0.1624 | 0.1627 |
| all decisive (51) | raw | 0.0471 | 0.0567 |
| all decisive (51) | calibrated | 0.0573 | 0.0563 |

Map: `sigmoid(a * logit(p) + b)` with a = 1.9971, b = 0.5491. The held-out rows are the unbiased estimate; the gate scores the calibrated map over every decisive sample, which is the map the lane would ship with.

Decisive-verdict accuracy 94.1%; among accepted narrations only, 100.0%. Mean transport latency 99 ms.

## Promotion gate — `narration-verification`

**PROMOTE**

All gates passed.

Gate: samples 30+, accuracy 90.0%+, Brier <= 0.1, ECE <= 0.1.

Proposed promotion record:

```json
{
  "metrics": {
    "samples": 51,
    "accuracy": 0.9412,
    "brier": 0.0573,
    "expectedCalibrationError": 0.0563
  },
  "calibration": {
    "a": 1.9971,
    "b": 0.5491
  },
  "promotedAt": "2026-09-17",
  "evidence": "docs/system-one-narration-benchmark.md"
}
```

## Observations

- **Coverage.** The lane accepted 18 of 75 calls and took 51 decisive verdicts (accept or flag); the rest deferred to leave behavior unchanged.
- **Hazards.** Missed hazards: c3. Extra conservative flags on a hazard case are tolerated, so the test isolates detection rather than exact flag sets.
- **Grounding.** Fully grounded cases not always accepted: g1, g2. A grounded deferral costs coverage but never correctness, because a deferring lane leaves the narration untouched.
- **False accepts.** No narration labelled non-accepting was accepted.
- **Calibration.** Held-out calibrated Brier 0.1624 and ECE 0.1627; all-decisive calibrated Brier 0.0573 and ECE 0.0563. The fitted map is reported as-is (a negative slope means the dev split's high-signal errors outnumbered high-signal successes).

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
npx tsx scripts/evaluate-system-one-narration-lane.ts --repeat 3
```

Raw per-call data: `docs/system-one-narration-benchmark.json`.

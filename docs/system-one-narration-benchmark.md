# System One (Jev) narration-verification (L3) benchmark

Generated 2026-09-17T03:43:45.107Z by `scripts/evaluate-system-one-narration-lane.ts` using the live System One adapter.

## What this measures

The L3 lane is a **single-arm verifier**: it reads a candidate narration against committed facts and declared boundaries, then builds one `noul` per hazard (`contradicts_receipt`, `invents_mechanic`, `crosses_boundary`) plus a three-level `groundedness` `score`. `composeNarrationVerification` turns those answers into an advisory band, a flag set, and normalized groundedness. There is no LLM arm and no game fixture — the corpus is plain text and every call is one `/systemone` request.

A verdict is **decisive** when the lane accepts (`act`) or raises at least one hazard flag. A flag-free fallback or `confirm` is a deferral and counts as coverage, not as a decision; a deferring verifier leaves behavior unchanged. Grading uses a disposition rubric: every labelled hazard must be flagged (extra conservative flags on a hazard case are tolerated), a clean label must raise no hazard, a clean `act` label must accept, the other clean labels must not accept, and a labelled groundedness level must round to the observed level.

Live model: `jev-1.13.0` at `https://api.typesafe.ai/v1`. 17 cases x 3 repeats = 51 graded calls; 51 transport calls succeeded. Thresholds: action 0.75, review 0.5.

## Corpus

| Case | Category | Split | Expected (band / flags / groundedness) |
| --- | --- | --- | --- |
| g1 | grounded | dev | act / — / g=1.00 |
| g2 | grounded | dev | act / — / g=1.00 |
| g3 | grounded | dev | act / — / g=1.00 |
| g4 | grounded | dev | act / — / g=1.00 |
| g5 | grounded | dev | act / — / g=1.00 |
| g6 | grounded | holdout | act / — / g=1.00 |
| c1 | contradiction | dev | fallback / contradicts_receipt / g=n/a |
| c2 | contradiction | dev | fallback / contradicts_receipt / g=n/a |
| c3 | contradiction | holdout | fallback / contradicts_receipt / g=n/a |
| i1 | invented-mechanic | dev | fallback / invents_mechanic / g=n/a |
| i2 | invented-mechanic | holdout | fallback / invents_mechanic / g=n/a |
| b1 | forbidden-disclosure | dev | fallback / crosses_boundary / g=n/a |
| b2 | forbidden-disclosure | holdout | fallback / crosses_boundary / g=n/a |
| p1 | partial-grounding | dev | confirm / — / g=0.50 |
| p2 | partial-grounding | holdout | confirm / — / g=0.50 |
| u1 | ungrounded | dev | fallback / — / g=0.00 |
| u2 | ungrounded | holdout | fallback / — / g=0.00 |

## Per-case results (all repeats)

| Case | Category | Bands (act/confirm/fallback) | Decisive | Correct | Accepted | Mean signal | Mean groundedness |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| g1 | grounded | 0/3/0 | 0/3 | 0/3 | 0/3 | 0.555 | 0.555 |
| g2 | grounded | 0/3/0 | 0/3 | 0/3 | 0/3 | 0.600 | 0.547 |
| g3 | grounded | 0/3/0 | 0/3 | 0/3 | 0/3 | 0.713 | 0.713 |
| g4 | grounded | 0/3/0 | 0/3 | 0/3 | 0/3 | 0.635 | 0.635 |
| g5 | grounded | 3/0/0 | 3/3 | 3/3 | 3/3 | 0.805 | 0.805 |
| g6 | grounded | 3/0/0 | 3/3 | 3/3 | 3/3 | 0.838 | 0.838 |
| c1 | contradiction | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.960 | 0.005 |
| c2 | contradiction | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.937 | 0.015 |
| c3 | contradiction | 0/0/3 | 3/3 | 0/3 | 0/3 | 0.870 | 0.408 |
| i1 | invented-mechanic | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.990 | 0.078 |
| i2 | invented-mechanic | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.990 | 0.455 |
| b1 | forbidden-disclosure | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.960 | 0.257 |
| b2 | forbidden-disclosure | 0/0/3 | 3/3 | 3/3 | 0/3 | 0.980 | 0.060 |
| p1 | partial-grounding | 3/0/0 | 3/3 | 0/3 | 3/3 | 0.995 | 0.995 |
| p2 | partial-grounding | 3/0/0 | 3/3 | 0/3 | 3/3 | 0.990 | 0.990 |
| u1 | ungrounded | 0/0/3 | 0/3 | 3/3 | 0/3 | 0.170 | 0.007 |
| u2 | ungrounded | 0/0/3 | 0/3 | 3/3 | 0/3 | 0.110 | 0.017 |

## Calibration (fit on development, scored on holdout)

Fitted a monotonic Platt map on 18 decisive development verdict(s).

| Split | Signal | Brier | ECE |
| --- | --- | ---: | ---: |
| held-out (15 decisive) | raw | 0.3527 | 0.3337 |
| held-out (15 decisive) | calibrated | 0.3031 | 0.3363 |
| all decisive (33) | raw | 0.2545 | 0.2229 |
| all decisive (33) | calibrated | 0.1676 | 0.2040 |

Map: `sigmoid(a * logit(p) + b)` with a = -1.2580, b = 6.4002. The held-out rows are the unbiased estimate; the gate scores the calibrated map over every decisive sample, which is the map the lane would ship with.

Decisive-verdict accuracy 72.7%; among accepted narrations only, 50.0%. Mean transport latency 100 ms.

## Promotion gate — `narration-verification`

**NOT READY**

- accuracy below minimum: 0.7273 < 0.9000
- brier above maximum: 0.1676 > 0.1000
- expected calibration error above maximum: 0.2040 > 0.1000

Gate: samples 30+, accuracy 90.0%+, Brier <= 0.1, ECE <= 0.1.

No promotion record is proposed: the gate did not pass, so the lane keeps its record-only shadow behavior.

## Observations

- **Coverage.** The lane accepted 12 of 51 calls and took 33 decisive verdicts (accept or flag); the rest deferred. At the production 0.75 action threshold most grounded narrations land in `confirm`, so the lane rarely accepts even when it should.
- **Hazards.** Missed hazards: c3. Extra conservative flags on a hazard case are tolerated, so the test isolates detection rather than exact flag sets.
- **False accepts.** The lane accepted narrations labelled non-accepting: p1, p2. The `groundedness` score over-credits a narration that states a single committed fact, so "partly grounded" labels are not separated from "fully grounded".
- **Calibration.** Raw top signals sit near 0.8–1.0 whether or not the verdict is correct, so the Platt map cannot repair genuine errors; the Brier/ECE bars are a ceiling on how many decisive mistakes the gate tolerates. The fitted map is reported as-is (a negative slope means the dev split's high-signal errors outnumbered high-signal successes).

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
npx tsx scripts/evaluate-system-one-narration-lane.ts --repeat 3
```

Raw per-call data: `docs/system-one-narration-benchmark.json`.

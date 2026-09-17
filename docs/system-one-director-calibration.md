# System One Director (L1) calibration

Generated 2026-09-17T18:09:53.488Z by `scripts/evaluate-system-one-director.ts` using the live System One adapter.

The L1 selector builds two atomic questions per advertised candidate — a `progress` `noul` (is committing this a good, meaningful next step now?) and a priority `score` — plus a `hold` `noul` and an aggregate `best_candidate` `choice`. It composes grounded candidates (progress at the action threshold, ordered by priority) → hold → best-pick → defer. An atomic `legal` question was tried and dropped: the advertised set is server-authorized, so re-asking legality only added hedging (a legal `encounter-start` scored 0.51) without changing decisions. Because Director beats mutate campaign state, the aggregate best-pick must clear the **action** threshold.

Correctness uses a two-tier provider-free candidate oracle. **Acceptable** (the primary, gating metric) means the selected action is the preferred beat or a legal non-regression alternative; **exact** means the single preferred beat. Frozen scenarios label a beat by its action; harvested scenarios label it by its exact candidate id. `hold` is only preferred where no beat should be forced. This grades a trustworthy beat, not one arbitrary label among several legal ones.

## Setup

| Setting | Value |
| --- | --- |
| Model | jev-1.13.0 |
| Repeats | 10 |
| Scenarios | 6 (6 frozen + 0 harvested) x 10 repeats = 60 sampled decisions per threshold |
| Harvested cases | 0 confirmed merged, 0 skipped — fixture absent |

## Scenarios at the default threshold (0.75)

| Scenario | Provenance | Oracle actions | Preferred | Acceptable | Method | Selected | Top signal | Acted | Accept | Exact |
| --- | :---: | --- | --- | --- | --- | --- | ---: | :---: | :---: | :---: |
| empty-world | frozen | advance-time, ambient-beat | ambient-beat | advance-time | defer | — | 0.600 | defer | n/a | n/a |
| story-graph | frozen | advance-time, ambient-beat, reveal-node | reveal-node | ambient-beat, advance-time | defer | — | 0.490 | defer | n/a | n/a |
| encounter-prep | frozen | encounter-start | encounter-start | — | defer | — | 0.590 | defer | n/a | n/a |
| story-graph-revealed | frozen | advance-time, ambient-beat, reveal-clue | reveal-clue | ambient-beat, advance-time | defer | — | 0.520 | defer | n/a | n/a |
| encounter-active | frozen | enemy-turn | enemy-turn | — | defer | — | 0.600 | defer | n/a | n/a |
| gm-only | frozen | — | hold | — | hold | hold | 1.000 | yes | yes | yes |

## Decision stability

Repeated draws of the same scenario should produce the same decision. `decision` is the composed
ordered selection (`candidateId > candidateId`), `hold` when the composition holds, or `defer` when
it commits nothing; compositions are taken at the default action threshold (0.75) and every repeat
keeps the production-shaped request (no `uid`). A uid-decorrelated probe moved the selected
threshold from 0.60 to 0.30 and produced a degenerate negative-slope calibration map
(calibrated ECE 0.1344 > 0.10), so the gate measurement intentionally omits the decorrelator.

| Metric | Value |
| --- | ---: |
| Mean agreement | 100.0% |
| Conflict cases | 0 of 6 (0.0%) |
| Mean signal std dev | 0.0193 |
| Max signal std dev | 0.0340 |

Stability is repeatability, not accuracy: a consistently deferred scenario is stable and still a
coverage miss, and a conflicted scenario may still have every individual pick labeled acceptable.

## Threshold sweep (all samples)

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 60/60 | 100.0% | 100.0% |
| 0.35 | 60/60 | 100.0% | 86.7% |
| 0.40 | 60/60 | 100.0% | 83.3% |
| 0.45 | 60/60 | 100.0% | 83.3% |
| 0.50 | 56/60 | 93.3% | 82.1% |
| 0.55 | 47/60 | 78.3% | 91.5% |
| 0.60 | 41/60 | 68.3% | 100.0% |
| 0.65 | 15/60 | 25.0% | 100.0% |
| 0.70 | 10/60 | 16.7% | 100.0% |
| 0.75 | 10/60 | 16.7% | 100.0% |
| 0.80 | 10/60 | 16.7% | 100.0% |
| 0.85 | 10/60 | 16.7% | 100.0% |
| 0.90 | 10/60 | 16.7% | 100.0% |

## Threshold selection

Selection is made on the **development split only** (empty-world, story-graph, encounter-prep), then validated on the held-out split (story-graph-revealed, encounter-active, gm-only).

Selected action threshold: **0.60** (dev coverage 63.3%, dev acted accuracy 100.0% over 19 acted decisions).
Held-out coverage 73.3%, held-out acted accuracy 100.0% over 22 acted decisions.
- filtered 10 of 13 threshold(s) for failing actedAccuracy >= 0.9 with at least 4 acted decisions
- selected highest threshold 0.6 reaching coverage >= 0.4 while meeting actedAccuracy >= 0.9 with at least 4 acted decisions

## Development sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 30/30 | 100.0% | 100.0% |
| 0.35 | 30/30 | 100.0% | 73.3% |
| 0.40 | 30/30 | 100.0% | 66.7% |
| 0.45 | 30/30 | 100.0% | 66.7% |
| 0.50 | 26/30 | 86.7% | 61.5% |
| 0.55 | 20/30 | 66.7% | 80.0% |
| 0.60 | 19/30 | 63.3% | 100.0% |
| 0.65 | 5/30 | 16.7% | 100.0% |
| 0.70 | 0/30 | 0.0% | n/a |
| 0.75 | 0/30 | 0.0% | n/a |
| 0.80 | 0/30 | 0.0% | n/a |
| 0.85 | 0/30 | 0.0% | n/a |
| 0.90 | 0/30 | 0.0% | n/a |

## Holdout sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 30/30 | 100.0% | 100.0% |
| 0.35 | 30/30 | 100.0% | 100.0% |
| 0.40 | 30/30 | 100.0% | 100.0% |
| 0.45 | 30/30 | 100.0% | 100.0% |
| 0.50 | 30/30 | 100.0% | 100.0% |
| 0.55 | 27/30 | 90.0% | 100.0% |
| 0.60 | 22/30 | 73.3% | 100.0% |
| 0.65 | 10/30 | 33.3% | 100.0% |
| 0.70 | 10/30 | 33.3% | 100.0% |
| 0.75 | 10/30 | 33.3% | 100.0% |
| 0.80 | 10/30 | 33.3% | 100.0% |
| 0.85 | 10/30 | 33.3% | 100.0% |
| 0.90 | 10/30 | 33.3% | 100.0% |

## Per-scenario at the selected threshold

| Scenario | Acted | Coverage | Acted accuracy | Mean predicted |
| --- | ---: | ---: | ---: | ---: |
| empty-world | 10/10 | 100.0% | 100.0% | 0.617 |
| story-graph | 0/10 | 0.0% | n/a | n/a |
| encounter-prep | 9/10 | 90.0% | 100.0% | 0.642 |
| story-graph-revealed | 3/10 | 30.0% | 100.0% | 0.617 |
| encounter-active | 9/10 | 90.0% | 100.0% | 0.614 |
| gm-only | 10/10 | 100.0% | 100.0% | 1.000 |

## Calibration (fit on development, scored on holdout)

Fitted a monotonic Platt map on 19 acted development decision(s).

| Split | Signal | Brier | ECE |
| --- | --- | ---: | ---: |
| held-out (22 acted) | raw | 0.0810 | 0.2100 |
| held-out (22 acted) | calibrated | 0.0001 | 0.0054 |
| all collected | raw | 0.1075 | 0.2846 |
| all collected | calibrated | 0.0001 | 0.0069 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.4441, b = 3.4776. The held-out row is the unbiased estimate.

## Negative examples

None of the 41 acted decisions was unacceptable, and 0 of 41 was not the exact preferred beat. The server candidate generator only advertises authorized beats and these frozen states contain no trap, so an acted error requires the model to pick a wrong advertised beat or to act when a player decision is required — neither occurs here. This corpus does not stress-test the calibrated gate, so a pass is a promotion **candidate**, not proof.

## Promotion gate — `director-selection`

**PROMOTE**

All gates passed.

Exact (preferred-action) accuracy among acted decisions: 100.0%. The gate uses acceptable accuracy, which counts a legal non-regression beat as a pass.

The gate scores the **calibrated** signal over every collected decision (the lane would ship with the calibration map); the held-out row above is the unbiased calibration estimate. Calibration is scored only on acted decisions, so deferrals are coverage, not misses.

The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback. A frozen corpus with no error cases cannot stress-test calibration; treat a pass as a promotion candidate until shadow data with negative examples exists.

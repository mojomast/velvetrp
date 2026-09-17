# System One Director (L1) calibration

Generated 2026-09-17T06:53:25.309Z by `scripts/evaluate-system-one-director.ts` using the live System One adapter.

The L1 selector builds two atomic questions per advertised candidate — a `progress` `noul` (is committing this a good, meaningful next step now?) and a priority `score` — plus a `hold` `noul` and an aggregate `best_candidate` `choice`. It composes grounded candidates (progress at the action threshold, ordered by priority) → hold → best-pick → defer. An atomic `legal` question was tried and dropped: the advertised set is server-authorized, so re-asking legality only added hedging (a legal `encounter-start` scored 0.51) without changing decisions. Because Director beats mutate campaign state, the aggregate best-pick must clear the **action** threshold.

Correctness uses a two-tier provider-free candidate oracle. **Acceptable** (the primary, gating metric) means the selected action is the preferred beat or a legal non-regression alternative; **exact** means the single preferred beat. `hold` is only preferred where no beat should be forced. This grades a trustworthy beat, not one arbitrary label among several legal ones.

Live model: `jev-1.13.0`. 6 scenarios x 10 repeats = 60 sampled decisions per threshold.

## Scenarios at the default threshold (0.75)

| Scenario | Oracle actions | Preferred | Acceptable | Method | Selected | Top signal | Acted | Accept | Exact |
| --- | --- | --- | --- | --- | --- | ---: | :---: | :---: | :---: |
| empty-world | advance-time, ambient-beat | ambient-beat | advance-time | defer | — | 0.610 | defer | n/a | n/a |
| story-graph | advance-time, ambient-beat, reveal-node | reveal-node | ambient-beat, advance-time | defer | — | 0.490 | defer | n/a | n/a |
| encounter-prep | encounter-start | encounter-start | — | defer | — | 0.610 | defer | n/a | n/a |
| story-graph-revealed | advance-time, ambient-beat, reveal-clue | reveal-clue | ambient-beat, advance-time | defer | — | 0.510 | defer | n/a | n/a |
| encounter-active | enemy-turn | enemy-turn | — | defer | — | 0.590 | defer | n/a | n/a |
| gm-only | — | hold | — | hold | hold | 1.000 | yes | yes | yes |

## Threshold sweep (all samples)

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 60/60 | 100.0% | 100.0% |
| 0.35 | 60/60 | 100.0% | 88.3% |
| 0.40 | 60/60 | 100.0% | 83.3% |
| 0.45 | 60/60 | 100.0% | 83.3% |
| 0.50 | 58/60 | 96.7% | 82.8% |
| 0.55 | 45/60 | 75.0% | 95.6% |
| 0.60 | 39/60 | 65.0% | 100.0% |
| 0.65 | 13/60 | 21.7% | 100.0% |
| 0.70 | 10/60 | 16.7% | 100.0% |
| 0.75 | 10/60 | 16.7% | 100.0% |
| 0.80 | 10/60 | 16.7% | 100.0% |
| 0.85 | 10/60 | 16.7% | 100.0% |
| 0.90 | 10/60 | 16.7% | 100.0% |

## Threshold selection

Selection is made on the **development split only** (empty-world, story-graph, encounter-prep), then validated on the held-out split (story-graph-revealed, encounter-active, gm-only).

Selected action threshold: **0.60** (dev coverage 66.7%, dev acted accuracy 100.0% over 20 acted decisions).
Held-out coverage 63.3%, held-out acted accuracy 100.0% over 19 acted decisions.
- filtered 10 of 13 threshold(s) for failing actedAccuracy >= 0.9 with at least 4 acted decisions
- selected highest threshold 0.6 reaching coverage >= 0.4 while meeting actedAccuracy >= 0.9 with at least 4 acted decisions

## Development sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 30/30 | 100.0% | 100.0% |
| 0.35 | 30/30 | 100.0% | 76.7% |
| 0.40 | 30/30 | 100.0% | 66.7% |
| 0.45 | 30/30 | 100.0% | 66.7% |
| 0.50 | 28/30 | 93.3% | 64.3% |
| 0.55 | 20/30 | 66.7% | 90.0% |
| 0.60 | 20/30 | 66.7% | 100.0% |
| 0.65 | 2/30 | 6.7% | 100.0% |
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
| 0.55 | 25/30 | 83.3% | 100.0% |
| 0.60 | 19/30 | 63.3% | 100.0% |
| 0.65 | 11/30 | 36.7% | 100.0% |
| 0.70 | 10/30 | 33.3% | 100.0% |
| 0.75 | 10/30 | 33.3% | 100.0% |
| 0.80 | 10/30 | 33.3% | 100.0% |
| 0.85 | 10/30 | 33.3% | 100.0% |
| 0.90 | 10/30 | 33.3% | 100.0% |

## Per-scenario at the selected threshold

| Scenario | Acted | Coverage | Acted accuracy | Mean predicted |
| --- | ---: | ---: | ---: | ---: |
| empty-world | 10/10 | 100.0% | 100.0% | 0.614 |
| story-graph | 0/10 | 0.0% | n/a | n/a |
| encounter-prep | 10/10 | 100.0% | 100.0% | 0.625 |
| story-graph-revealed | 1/10 | 10.0% | 100.0% | 0.610 |
| encounter-active | 8/10 | 80.0% | 100.0% | 0.620 |
| gm-only | 10/10 | 100.0% | 100.0% | 1.000 |

## Calibration (fit on development, scored on holdout)

Fitted a monotonic Platt map on 20 acted development decision(s).

| Split | Signal | Brier | ECE |
| --- | --- | ---: | ---: |
| held-out (19 acted) | raw | 0.0690 | 0.1805 |
| held-out (19 acted) | calibrated | 0.0000 | 0.0042 |
| all collected | raw | 0.1080 | 0.2831 |
| all collected | calibrated | 0.0001 | 0.0066 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.3871, b = 3.5657. The held-out row is the unbiased estimate.

## Negative examples

None of the 39 acted decisions was unacceptable, and 0 of 39 was not the exact preferred beat. The server candidate generator only advertises authorized beats and these frozen states contain no trap, so an acted error requires the model to pick a wrong advertised beat or to act when a player decision is required — neither occurs here. This corpus does not stress-test the calibrated gate, so a pass is a promotion **candidate**, not proof.

## Promotion gate — `director-selection`

**PROMOTE**

All gates passed.

Exact (preferred-action) accuracy among acted decisions: 100.0%. The gate uses acceptable accuracy, which counts a legal non-regression beat as a pass.

The gate scores the **calibrated** signal over every collected decision (the lane would ship with the calibration map); the held-out row above is the unbiased calibration estimate. Calibration is scored only on acted decisions, so deferrals are coverage, not misses.

The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback. A frozen corpus with no error cases cannot stress-test calibration; treat a pass as a promotion candidate until shadow data with negative examples exists.

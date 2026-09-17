# System One Director (L1) calibration

Generated 2026-09-17T01:39:55.715Z by `scripts/evaluate-system-one-director.ts` using the live System One adapter.

The L1 selector builds three atomic questions per advertised candidate — `legal` (may this be committed now?), `progress` (does it advance an active story objective?), and a priority `score` — plus a `hold` `noul` and an aggregate `best_candidate` `choice`. It composes grounded candidates (legal **and** progress at the action threshold, ordered by priority) → best-pick → hold → defer. Because Director beats mutate campaign state, the aggregate best-pick must clear the **action** threshold and the picked candidate must be legal.

Correctness uses a two-tier provider-free candidate oracle. **Acceptable** (the primary, gating metric) means the selected action is the preferred beat or a legal non-regression alternative; **exact** means the single preferred beat. `hold` is only preferred where no beat should be forced. This grades a trustworthy beat, not one arbitrary label among several legal ones.

Live model: `jev-1.13.0`. 6 scenarios x 10 repeats = 60 sampled decisions per threshold.

## Scenarios at the default threshold (0.75)

| Scenario | Oracle actions | Preferred | Acceptable | Method | Selected | Top signal | Acted | Accept | Exact |
| --- | --- | --- | --- | --- | --- | ---: | :---: | :---: | :---: |
| empty-world | advance-time, ambient-beat | ambient-beat | advance-time | defer | — | 0.580 | defer | n/a | n/a |
| story-graph | advance-time, ambient-beat, reveal-node | reveal-node | ambient-beat, advance-time | defer | — | 0.490 | defer | n/a | n/a |
| encounter-prep | encounter-start | encounter-start | — | defer | — | 0.620 | defer | n/a | n/a |
| story-graph-revealed | advance-time, ambient-beat, reveal-clue | reveal-clue | ambient-beat, advance-time | defer | — | 0.540 | defer | n/a | n/a |
| encounter-active | enemy-turn | enemy-turn | — | defer | — | 0.580 | defer | n/a | n/a |
| gm-only | — | hold | — | hold | hold | 1.000 | yes | yes | yes |

## Threshold sweep (all samples)

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 60/60 | 100.0% | 83.3% |
| 0.35 | 60/60 | 100.0% | 83.3% |
| 0.40 | 60/60 | 100.0% | 83.3% |
| 0.45 | 60/60 | 100.0% | 81.7% |
| 0.50 | 58/60 | 96.7% | 82.8% |
| 0.55 | 48/60 | 80.0% | 95.8% |
| 0.60 | 35/60 | 58.3% | 100.0% |
| 0.65 | 18/60 | 30.0% | 100.0% |
| 0.70 | 11/60 | 18.3% | 100.0% |
| 0.75 | 10/60 | 16.7% | 100.0% |
| 0.80 | 10/60 | 16.7% | 100.0% |
| 0.85 | 10/60 | 16.7% | 100.0% |
| 0.90 | 10/60 | 16.7% | 100.0% |

## Threshold selection

Selection is made on the **development split only** (empty-world, story-graph, encounter-prep), then validated on the held-out split (story-graph-revealed, encounter-active, gm-only).

Selected action threshold: **0.60** (dev coverage 56.7%, dev acted accuracy 100.0% over 17 acted decisions).
Held-out coverage 60.0%, held-out acted accuracy 100.0% over 18 acted decisions.
- filtered 10 of 13 threshold(s) for failing actedAccuracy >= 0.9 with at least 4 acted decisions
- selected highest threshold 0.6 reaching coverage >= 0.4 while meeting actedAccuracy >= 0.9 with at least 4 acted decisions

## Development sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 30/30 | 100.0% | 66.7% |
| 0.35 | 30/30 | 100.0% | 66.7% |
| 0.40 | 30/30 | 100.0% | 66.7% |
| 0.45 | 30/30 | 100.0% | 63.3% |
| 0.50 | 28/30 | 93.3% | 64.3% |
| 0.55 | 22/30 | 73.3% | 90.9% |
| 0.60 | 17/30 | 56.7% | 100.0% |
| 0.65 | 5/30 | 16.7% | 100.0% |
| 0.70 | 1/30 | 3.3% | 100.0% |
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
| 0.55 | 26/30 | 86.7% | 100.0% |
| 0.60 | 18/30 | 60.0% | 100.0% |
| 0.65 | 13/30 | 43.3% | 100.0% |
| 0.70 | 10/30 | 33.3% | 100.0% |
| 0.75 | 10/30 | 33.3% | 100.0% |
| 0.80 | 10/30 | 33.3% | 100.0% |
| 0.85 | 10/30 | 33.3% | 100.0% |
| 0.90 | 10/30 | 33.3% | 100.0% |

## Per-scenario at the selected threshold

| Scenario | Acted | Coverage | Acted accuracy | Mean predicted |
| --- | ---: | ---: | ---: | ---: |
| empty-world | 7/10 | 70.0% | 100.0% | 0.630 |
| story-graph | 0/10 | 0.0% | n/a | n/a |
| encounter-prep | 10/10 | 100.0% | 100.0% | 0.647 |
| story-graph-revealed | 0/10 | 0.0% | n/a | n/a |
| encounter-active | 8/10 | 80.0% | 100.0% | 0.635 |
| gm-only | 10/10 | 100.0% | 100.0% | 1.000 |

## Calibration (fit on development, scored on holdout)

Fitted a monotonic Platt map on 17 acted development decision(s).

| Split | Signal | Brier | ECE |
| --- | --- | ---: | ---: |
| held-out (18 acted) | raw | 0.0594 | 0.1622 |
| held-out (18 acted) | calibrated | 0.0000 | 0.0039 |
| all collected | raw | 0.0938 | 0.2583 |
| all collected | calibrated | 0.0001 | 0.0061 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.5295, b = 3.3508. The held-out row is the unbiased estimate; because this frozen corpus has no errors, the fit is provisional until the corpus is larger and includes error cases.

## Promotion gate — `director-selection`

**PROMOTE**

All gates passed.

Exact (preferred-action) accuracy among acted decisions: 100.0%. The gate uses acceptable accuracy, which counts a legal non-regression beat as a pass.

The gate scores the **calibrated** signal over every collected decision (the lane would ship with the calibration map); the held-out row above is the unbiased calibration estimate. Calibration is scored only on acted decisions, so deferrals are coverage, not misses.

The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback. A frozen corpus with no error cases cannot stress-test calibration; treat a pass as a promotion candidate until shadow data with negative examples exists.

# System One Director (L1) calibration

Generated 2026-09-17T18:38:41.088Z by `scripts/evaluate-system-one-director.ts` using the live System One adapter.

The L1 selector builds two atomic questions per advertised candidate — a `progress` `noul` (is committing this a good, meaningful next step now?) and a priority `score` — plus a `hold` `noul` and an aggregate `best_candidate` `choice`. It composes grounded candidates (progress at the action threshold, ordered by priority) → hold → best-pick → defer. An atomic `legal` question was tried and dropped: the advertised set is server-authorized, so re-asking legality only added hedging (a legal `encounter-start` scored 0.51) without changing decisions. Because Director beats mutate campaign state, the aggregate best-pick must clear the **action** threshold.

Correctness uses a two-tier provider-free candidate oracle. **Acceptable** (the primary, gating metric) means the selected action is the preferred beat or a legal non-regression alternative; **exact** means the single preferred beat. Frozen scenarios label a beat by its action; harvested scenarios label it by its exact candidate id. `hold` is only preferred where no beat should be forced. This grades a trustworthy beat, not one arbitrary label among several legal ones.

## Setup

| Setting | Value |
| --- | --- |
| Model | jev-1.13.0 |
| Repeats | 10 |
| Scenarios | 15 (6 frozen + 9 harvested) x 10 repeats = 150 sampled decisions per threshold |
| Harvested cases | 9 confirmed merged, 0 skipped — `server/test/fixtures/system-one-harvested/director-selection.json` |

## Scenarios at the default threshold (0.75)

9 of 15 scenario(s) are **harvested** rows: confirmed live-derived labels from
`server/test/fixtures/system-one-harvested/director-selection.json` (0 confirmed proposal(s) skipped). They run through the same composition,
calibration, and threshold logic as the frozen scenarios, so the gate metrics below include them.

| Scenario | Provenance | Oracle actions | Preferred | Acceptable | Method | Selected | Top signal | Acted | Accept | Exact |
| --- | :---: | --- | --- | --- | --- | --- | ---: | :---: | :---: | :---: |
| empty-world | frozen | advance-time, ambient-beat | ambient-beat | advance-time | defer | — | 0.570 | defer | n/a | n/a |
| story-graph | frozen | advance-time, ambient-beat, reveal-node | reveal-node | ambient-beat, advance-time | defer | — | 0.490 | defer | n/a | n/a |
| encounter-prep | frozen | encounter-start | encounter-start | — | defer | — | 0.600 | defer | n/a | n/a |
| story-graph-revealed | frozen | advance-time, ambient-beat, reveal-clue | reveal-clue | ambient-beat, advance-time | defer | — | 0.550 | defer | n/a | n/a |
| encounter-active | frozen | enemy-turn | enemy-turn | — | defer | — | 0.600 | defer | n/a | n/a |
| gm-only | frozen | — | hold | — | hold | hold | 1.000 | yes | yes | yes |
| harvested:0fa81f782c1e | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | — | defer | — | 0.500 | defer | n/a | n/a |
| harvested:1c9f6a75ec2b | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | dm-candidate:e3225151deec4437eff1113262f054e925b60527 | defer | — | 0.480 | defer | n/a | n/a |
| harvested:271de5fa5486 | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | — | defer | — | 0.470 | defer | n/a | n/a |
| harvested:2e1bd6a66deb | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | — | defer | — | 0.480 | defer | n/a | n/a |
| harvested:745e95329d01 | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | dm-candidate:c759417590b6e2ac5b6ba879bf5f59f60b662651 | defer | — | 0.490 | defer | n/a | n/a |
| harvested:79257e872b4e | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | — | defer | — | 0.490 | defer | n/a | n/a |
| harvested:e548d1784b60 | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | dm-candidate:0cc8b7043da338497a2d8e421694f85fd8c58557 | defer | — | 0.490 | defer | n/a | n/a |
| harvested:ee7204591cf8 | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | dm-candidate:75c1a1cecfd19d95c8ed25860cb587d71ff7f09d | defer | — | 0.470 | defer | n/a | n/a |
| harvested:f5227bfed60b | harvested | advance-time, ambient-beat | dm-candidate:7defe8452740d6488a3b0d7ac4c2aaef90af30ef | dm-candidate:5f2eebfd548d76df3ea5438b50dd04a0358978b0 | defer | — | 0.500 | defer | n/a | n/a |

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
| Conflict cases | 0 of 15 (0.0%) |
| Mean signal std dev | 0.0162 |
| Max signal std dev | 0.0339 |

Stability is repeatability, not accuracy: a consistently deferred scenario is stable and still a
coverage miss, and a conflicted scenario may still have every individual pick labeled acceptable.

## Threshold sweep (all samples)

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 150/150 | 100.0% | 73.3% |
| 0.35 | 150/150 | 100.0% | 68.7% |
| 0.40 | 150/150 | 100.0% | 52.7% |
| 0.45 | 150/150 | 100.0% | 51.3% |
| 0.50 | 149/150 | 99.3% | 65.8% |
| 0.55 | 138/150 | 92.0% | 73.2% |
| 0.60 | 130/150 | 86.7% | 100.0% |
| 0.65 | 94/150 | 62.7% | 100.0% |
| 0.70 | 10/150 | 6.7% | 100.0% |
| 0.75 | 10/150 | 6.7% | 100.0% |
| 0.80 | 10/150 | 6.7% | 100.0% |
| 0.85 | 10/150 | 6.7% | 100.0% |
| 0.90 | 10/150 | 6.7% | 100.0% |

## Threshold selection

Selection is made on the **development split only** (empty-world, story-graph, encounter-prep, harvested:0fa81f782c1e, harvested:1c9f6a75ec2b, harvested:271de5fa5486, harvested:2e1bd6a66deb, harvested:745e95329d01, harvested:79257e872b4e, harvested:e548d1784b60, harvested:ee7204591cf8, harvested:f5227bfed60b), then validated on the held-out split (story-graph-revealed, encounter-active, gm-only).

Selected action threshold: **0.65** (dev coverage 68.3%, dev acted accuracy 100.0% over 82 acted decisions).
Held-out coverage 40.0%, held-out acted accuracy 100.0% over 12 acted decisions.
- filtered 11 of 13 threshold(s) for failing actedAccuracy >= 0.9 with at least 4 acted decisions
- selected highest threshold 0.65 reaching coverage >= 0.4 while meeting actedAccuracy >= 0.9 with at least 4 acted decisions

## Development sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 120/120 | 100.0% | 66.7% |
| 0.35 | 120/120 | 100.0% | 60.8% |
| 0.40 | 120/120 | 100.0% | 40.8% |
| 0.45 | 120/120 | 100.0% | 39.2% |
| 0.50 | 119/120 | 99.2% | 57.1% |
| 0.55 | 110/120 | 91.7% | 66.4% |
| 0.60 | 109/120 | 90.8% | 100.0% |
| 0.65 | 82/120 | 68.3% | 100.0% |
| 0.70 | 0/120 | 0.0% | n/a |
| 0.75 | 0/120 | 0.0% | n/a |
| 0.80 | 0/120 | 0.0% | n/a |
| 0.85 | 0/120 | 0.0% | n/a |
| 0.90 | 0/120 | 0.0% | n/a |

## Holdout sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 30/30 | 100.0% | 100.0% |
| 0.35 | 30/30 | 100.0% | 100.0% |
| 0.40 | 30/30 | 100.0% | 100.0% |
| 0.45 | 30/30 | 100.0% | 100.0% |
| 0.50 | 30/30 | 100.0% | 100.0% |
| 0.55 | 28/30 | 93.3% | 100.0% |
| 0.60 | 21/30 | 70.0% | 100.0% |
| 0.65 | 12/30 | 40.0% | 100.0% |
| 0.70 | 10/30 | 33.3% | 100.0% |
| 0.75 | 10/30 | 33.3% | 100.0% |
| 0.80 | 10/30 | 33.3% | 100.0% |
| 0.85 | 10/30 | 33.3% | 100.0% |
| 0.90 | 10/30 | 33.3% | 100.0% |

## Per-scenario at the selected threshold

| Scenario | Acted | Coverage | Acted accuracy | Mean predicted |
| --- | ---: | ---: | ---: | ---: |
| empty-world | 0/10 | 0.0% | n/a | n/a |
| story-graph | 0/10 | 0.0% | n/a | n/a |
| encounter-prep | 1/10 | 10.0% | 100.0% | 0.650 |
| story-graph-revealed | 1/10 | 10.0% | 100.0% | 0.650 |
| encounter-active | 1/10 | 10.0% | 100.0% | 0.650 |
| gm-only | 10/10 | 100.0% | 100.0% | 1.000 |
| harvested:0fa81f782c1e | 10/10 | 100.0% | 100.0% | 0.673 |
| harvested:1c9f6a75ec2b | 9/10 | 90.0% | 100.0% | 0.659 |
| harvested:271de5fa5486 | 10/10 | 100.0% | 100.0% | 0.661 |
| harvested:2e1bd6a66deb | 7/10 | 70.0% | 100.0% | 0.650 |
| harvested:745e95329d01 | 7/10 | 70.0% | 100.0% | 0.661 |
| harvested:79257e872b4e | 9/10 | 90.0% | 100.0% | 0.663 |
| harvested:e548d1784b60 | 10/10 | 100.0% | 100.0% | 0.668 |
| harvested:ee7204591cf8 | 9/10 | 90.0% | 100.0% | 0.666 |
| harvested:f5227bfed60b | 10/10 | 100.0% | 100.0% | 0.670 |

## Calibration (fit on development, scored on holdout)

Fitted a monotonic Platt map on 82 acted development decision(s).

| Split | Signal | Brier | ECE |
| --- | --- | ---: | ---: |
| held-out (12 acted) | raw | 0.0204 | 0.0583 |
| held-out (12 acted) | calibrated | 0.0000 | 0.0015 |
| all collected | raw | 0.1013 | 0.3006 |
| all collected | calibrated | 0.0001 | 0.0068 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.7170, b = 3.0269. The held-out row is the unbiased estimate.

## Negative examples

None of the 94 acted decisions was unacceptable, and 0 of 94 was not the exact preferred beat. The server candidate generator only advertises authorized beats and these frozen states contain no trap, so an acted error requires the model to pick a wrong advertised beat or to act when a player decision is required — neither occurs here. This corpus does not stress-test the calibrated gate, so a pass is a promotion **candidate**, not proof.

## Promotion gate — `director-selection`

**PROMOTE**

All gates passed.

Exact (preferred-action) accuracy among acted decisions: 100.0%. The gate uses acceptable accuracy, which counts a legal non-regression beat as a pass.

The gate scores the **calibrated** signal over every collected decision (the lane would ship with the calibration map); the held-out row above is the unbiased calibration estimate. Calibration is scored only on acted decisions, so deferrals are coverage, not misses.

The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback. A frozen corpus with no error cases cannot stress-test calibration; treat a pass as a promotion candidate until shadow data with negative examples exists.

# System One Director (L1) calibration

Generated 2026-09-17T00:57:11.322Z by `scripts/evaluate-system-one-director.ts` using the live System One adapter.

The L1 selector builds a per-candidate support `noul`, a priority `score`, a `hold` `noul`, and an aggregate `best_candidate` `choice`, then composes hold → grounded-by-priority → best-pick → defer. Correctness is graded against the provider-free candidate oracle (the exact advertised action set per state).

Live model: `jev-1.13.0`. Samples: 4.

## Scenarios

| Scenario | Oracle actions | Expected | Method | Selected | Top signal | Acted | Correct |
| --- | --- | --- | --- | --- | ---: | :---: | :---: |
| empty-world | advance-time, ambient-beat | ambient-beat | defer | — | 0.710 | defer | no |
| story-graph | advance-time, ambient-beat, reveal-node | reveal-node | defer | — | 0.590 | defer | no |
| encounter-prep | encounter-start | encounter-start | best-pick | encounter-start | 0.590 | yes | yes |
| gm-only | — | hold | defer | — | 0.580 | defer | no |

## Calibration

Calibration is measured only on decisions the lane actually acted on. A deferral is not a committed prediction: it hands off to the existing deterministic path and is reported as a coverage signal, not scored as a miss.

| Metric | Value |
| --- | ---: |
| Scenarios | 4 |
| Acted samples | 1 |
| Coverage | 25.0% |
| Deferrals | 3 (75.0%) |
| Accuracy vs oracle (acted) | 100.0% |
| Brier score (acted) | 0.1681 |
| Expected calibration error (acted) | 0.4100 |
| Bins | 10 |

## Promotion gate — `director-selection`

**NOT READY**

- insufficient samples: 1 < 30
- brier above maximum: 0.1681 > 0.1000
- expected calibration error above maximum: 0.4100 > 0.1000

The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback.

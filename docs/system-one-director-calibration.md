# System One Director (L1) calibration

Generated 2026-09-17T01:11:19.683Z by `scripts/evaluate-system-one-director.ts` using the live System One adapter.

The L1 selector builds a per-candidate support `noul`, a priority `score`, a `hold` `noul`, and an aggregate `best_candidate` `choice`, then composes hold → grounded-by-priority → best-pick → defer. Because Director beats mutate campaign state, the aggregate best-pick must clear the **action** threshold, not the review threshold. Correctness is graded against the provider-free candidate oracle using a single intended action per state.

Live model: `jev-1.13.0`. 4 scenarios x 10 repeats = 40 sampled decisions per threshold.

## Scenarios at the default threshold (0.75)

| Scenario | Oracle actions | Expected | Method | Selected | Top signal | Acted | Correct |
| --- | --- | --- | --- | --- | ---: | :---: | :---: |
| empty-world | advance-time, ambient-beat | ambient-beat | defer | — | 0.720 | defer | n/a |
| story-graph | advance-time, ambient-beat, reveal-node | reveal-node | defer | — | 0.610 | defer | n/a |
| encounter-prep | encounter-start | encounter-start | defer | — | 0.530 | defer | n/a |
| gm-only | — | hold | defer | — | 0.560 | defer | n/a |

## Threshold sweep (all samples)

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 40/40 | 100.0% | 25.0% |
| 0.35 | 40/40 | 100.0% | 25.0% |
| 0.40 | 40/40 | 100.0% | 25.0% |
| 0.45 | 40/40 | 100.0% | 25.0% |
| 0.50 | 40/40 | 100.0% | 25.0% |
| 0.55 | 40/40 | 100.0% | 50.0% |
| 0.60 | 21/40 | 52.5% | 47.6% |
| 0.65 | 20/40 | 50.0% | 50.0% |
| 0.70 | 9/40 | 22.5% | 22.2% |
| 0.75 | 0/40 | 0.0% | n/a |
| 0.80 | 0/40 | 0.0% | n/a |
| 0.85 | 0/40 | 0.0% | n/a |
| 0.90 | 0/40 | 0.0% | n/a |

## Threshold selection

Selection is made on the **development split only** (empty-world, encounter-prep), then validated on the held-out split (story-graph, gm-only).

No threshold qualified on the development split.
- filtered 13 of 13 threshold(s) for failing actedAccuracy >= 0.9 with at least 4 acted decisions
- no threshold reached actedAccuracy >= 0.9 with at least 4 acted decisions

## Development sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 20/20 | 100.0% | 0.0% |
| 0.35 | 20/20 | 100.0% | 0.0% |
| 0.40 | 20/20 | 100.0% | 0.0% |
| 0.45 | 20/20 | 100.0% | 0.0% |
| 0.50 | 20/20 | 100.0% | 0.0% |
| 0.55 | 20/20 | 100.0% | 50.0% |
| 0.60 | 20/20 | 100.0% | 50.0% |
| 0.65 | 20/20 | 100.0% | 50.0% |
| 0.70 | 9/20 | 45.0% | 22.2% |
| 0.75 | 0/20 | 0.0% | n/a |
| 0.80 | 0/20 | 0.0% | n/a |
| 0.85 | 0/20 | 0.0% | n/a |
| 0.90 | 0/20 | 0.0% | n/a |

## Holdout sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 20/20 | 100.0% | 50.0% |
| 0.35 | 20/20 | 100.0% | 50.0% |
| 0.40 | 20/20 | 100.0% | 50.0% |
| 0.45 | 20/20 | 100.0% | 50.0% |
| 0.50 | 20/20 | 100.0% | 50.0% |
| 0.55 | 20/20 | 100.0% | 50.0% |
| 0.60 | 1/20 | 5.0% | 0.0% |
| 0.65 | 0/20 | 0.0% | n/a |
| 0.70 | 0/20 | 0.0% | n/a |
| 0.75 | 0/20 | 0.0% | n/a |
| 0.80 | 0/20 | 0.0% | n/a |
| 0.85 | 0/20 | 0.0% | n/a |
| 0.90 | 0/20 | 0.0% | n/a |

## Promotion gate — `director-selection`

**NOT READY**

- insufficient samples: 0 < 30
- accuracy below minimum: 0.0000 < 0.9000

The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback. Calibration is scored only on acted decisions; deferrals are coverage, not misses.

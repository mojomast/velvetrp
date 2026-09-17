# System One Director (L1) calibration

Generated 2026-09-17T01:25:42.973Z by `scripts/evaluate-system-one-director.ts` using the live System One adapter.

The L1 selector builds three atomic questions per advertised candidate — `legal` (may this be committed now?), `progress` (does it advance an active story objective?), and a priority `score` — plus a `hold` `noul` and an aggregate `best_candidate` `choice`. It composes grounded candidates (legal **and** progress at the action threshold, ordered by priority) → best-pick → hold → defer. Because Director beats mutate campaign state, the aggregate best-pick must clear the **action** threshold and the picked candidate must be legal.

Correctness uses a two-tier provider-free candidate oracle. **Acceptable** (the primary, gating metric) means the selected action is the preferred beat or a legal non-regression alternative; **exact** means the single preferred beat. `hold` is only preferred where no beat should be forced. This grades a trustworthy beat, not one arbitrary label among several legal ones.

Live model: `jev-1.13.0`. 4 scenarios x 10 repeats = 40 sampled decisions per threshold.

## Scenarios at the default threshold (0.75)

| Scenario | Oracle actions | Preferred | Acceptable | Method | Selected | Top signal | Acted | Accept | Exact |
| --- | --- | --- | --- | --- | --- | ---: | :---: | :---: | :---: |
| empty-world | advance-time, ambient-beat | ambient-beat | advance-time | defer | — | 0.630 | defer | n/a | n/a |
| story-graph | advance-time, ambient-beat, reveal-node | reveal-node | ambient-beat, advance-time | defer | — | 0.480 | defer | n/a | n/a |
| encounter-prep | encounter-start | encounter-start | — | defer | — | 0.560 | defer | n/a | n/a |
| gm-only | — | hold | — | hold | hold | 1.000 | yes | yes | yes |

## Threshold sweep (all samples)

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 40/40 | 100.0% | 75.0% |
| 0.35 | 40/40 | 100.0% | 75.0% |
| 0.40 | 40/40 | 100.0% | 75.0% |
| 0.45 | 40/40 | 100.0% | 72.5% |
| 0.50 | 30/40 | 75.0% | 66.7% |
| 0.55 | 30/40 | 75.0% | 90.0% |
| 0.60 | 28/40 | 70.0% | 100.0% |
| 0.65 | 12/40 | 30.0% | 100.0% |
| 0.70 | 10/40 | 25.0% | 100.0% |
| 0.75 | 10/40 | 25.0% | 100.0% |
| 0.80 | 10/40 | 25.0% | 100.0% |
| 0.85 | 10/40 | 25.0% | 100.0% |
| 0.90 | 10/40 | 25.0% | 100.0% |

## Threshold selection

Selection is made on the **development split only** (empty-world, encounter-prep), then validated on the held-out split (story-graph, gm-only).

Selected action threshold: **0.60** (dev coverage 90.0%, dev acted accuracy 100.0% over 18 acted decisions).
Held-out coverage 50.0%, held-out acted accuracy 100.0% over 10 acted decisions.
- filtered 12 of 13 threshold(s) for failing actedAccuracy >= 0.9 with at least 4 acted decisions
- selected highest threshold 0.6 reaching coverage >= 0.4 while meeting actedAccuracy >= 0.9 with at least 4 acted decisions

## Development sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 20/20 | 100.0% | 50.0% |
| 0.35 | 20/20 | 100.0% | 50.0% |
| 0.40 | 20/20 | 100.0% | 50.0% |
| 0.45 | 20/20 | 100.0% | 45.0% |
| 0.50 | 20/20 | 100.0% | 50.0% |
| 0.55 | 20/20 | 100.0% | 85.0% |
| 0.60 | 18/20 | 90.0% | 100.0% |
| 0.65 | 2/20 | 10.0% | 100.0% |
| 0.70 | 0/20 | 0.0% | n/a |
| 0.75 | 0/20 | 0.0% | n/a |
| 0.80 | 0/20 | 0.0% | n/a |
| 0.85 | 0/20 | 0.0% | n/a |
| 0.90 | 0/20 | 0.0% | n/a |

## Holdout sweep

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.30 | 20/20 | 100.0% | 100.0% |
| 0.35 | 20/20 | 100.0% | 100.0% |
| 0.40 | 20/20 | 100.0% | 100.0% |
| 0.45 | 20/20 | 100.0% | 100.0% |
| 0.50 | 10/20 | 50.0% | 100.0% |
| 0.55 | 10/20 | 50.0% | 100.0% |
| 0.60 | 10/20 | 50.0% | 100.0% |
| 0.65 | 10/20 | 50.0% | 100.0% |
| 0.70 | 10/20 | 50.0% | 100.0% |
| 0.75 | 10/20 | 50.0% | 100.0% |
| 0.80 | 10/20 | 50.0% | 100.0% |
| 0.85 | 10/20 | 50.0% | 100.0% |
| 0.90 | 10/20 | 50.0% | 100.0% |

## Promotion gate — `director-selection`

**NOT READY**

- insufficient samples: 28 < 30
- expected calibration error above maximum: 0.2386 > 0.1000

Exact (preferred-action) accuracy among acted decisions: 100.0%. The gate uses acceptable accuracy, which counts a legal non-regression beat as a pass.

The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback. Calibration is scored only on acted decisions; deferrals are coverage, not misses.

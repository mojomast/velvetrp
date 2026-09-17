# System One (Jev) memory-reranking (L4) benchmark

Generated 2026-09-17T12:29:14.224Z by `scripts/evaluate-system-one-rerank-lane.ts` using the live System One adapter.

## What this measures

The L4 lane reorders an already-authorized, bounded recall shortlist. It never adds, drops, or authorizes a candidate: the Plan 3 provider-free memory oracle produces the same shortlist the runtime recall would, and the lane contributes one relevance `score` and one "does this item answer the query?" `noul` per candidate. `composeRerankOrder` fuses them with the deterministic rank (`0.5 * rankScore + 0.5 * relevance`), so an all-equal or malformed model response reproduces the deterministic order exactly.

Because the lane's output is an order, the promotion gate is scored on a per-case success label restricted to calls where the shortlist actually retrieved a labelled required source: every available required source must remain in the fused top 3 and no forbidden source may be present. A call with no retrieved required source is **unanswerable** — no reorder can recover it — and is reported as coverage, not as a decision. A sample is **decisive** only when the composed band is `act`; a deferral keeps the deterministic order.

The benefit comparison reuses the Plan 3 scorer (`scoreCases`) over the same calls: the deterministic and fused orders are scored against the same labels, so recall@K, recall@8, MRR, and nDCG are directly comparable.

| Setting | Value |
| --- | --- |
| Model | jev-1.13.0 |
| Base URL | `https://api.typesafe.ai/v1` |
| Confidence thresholds (action / review) | 0.75 / 0.5 |
| Fusion weights | 0.5 deterministic / 0.5 model |
| Top-K | 3 |
| Repeats | 3 |
| Corpus | 33 cases (6 with an empty shortlist) x 3 repeats = 81 calls |

## Corpus and per-case results

| Case | Category | Split | Candidates | Calls | Answerable | Decisive | Correct/decisive | Baseline correct/decisive | Surfaced before→after | Best rank before→after | Mean signal | Bands (act/confirm/fallback) | Errors |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| p3-harbor-task-offered-v1 | p2-observation | dev | 3 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.830 | 3/0/0 | 0 |
| p3-harbor-task-accepted-v1 | p2-observation | dev | 3 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.673 | 0/3/0 | 0 |
| p3-harbor-keeper-statement-v1 | p2-observation | dev | 8 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.800 | 3/0/0 | 0 |
| p3-harbor-negotiation-failed-v1 | p2-observation | dev | 2 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.533 | 0/3/0 | 0 |
| p3-harbor-saltglass-alternate-v1 | p2-observation | dev | 1 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.670 | 0/3/0 | 0 |
| p3-harbor-clue-timing-v1 | p2-observation | dev | 2 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.360 | 0/0/3 | 0 |
| p3-harbor-reward-unclaimed-v1 | p2-observation | dev | 3 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.753 | 3/0/0 | 0 |
| p3-harbor-reward-claimed-v1 | p2-observation | dev | 3 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.810 | 3/0/0 | 0 |
| p3-harbor-location-past-v1 | p2-observation | dev | 2 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.810 | 3/0/0 | 0 |
| p3-harbor-location-current-v1 | p2-observation | dev | 8 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.920 | 3/0/0 | 0 |
| p3-harbor-finale-callback-v1 | p2-observation | dev | 1 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.500 | 0/2/1 | 0 |
| p3-harbor-unsupported-retreat-v1 | p2-observation | dev | 2 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.443 | 0/0/3 | 0 |
| promise-old-lantern-v1 | promise | dev | 8 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.953 | 3/0/0 | 0 |
| outcome-lantern-v1 | outcome | dev | 3 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 1.00→1.00 | 0.900 | 3/0/0 | 0 |
| current-beacon-update-v1 | current-update | dev | 8 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.940 | 3/0/0 | 0 |
| private-other-actor-v1 | private-match | dev | 0 | 0 | 0 | 0 | 0/0 | 0/0 | — | — | n/a | — | 0 |
| wrong-actor-v1 | wrong-actor | dev | 2 | 3 | 0 | 0 | 0/0 | 0/0 | 0→0 | —→— | 0.060 | 0/0/3 | 0 |
| wrong-timeline-v1 | wrong-timeline | dev | 0 | 0 | 0 | 0 | 0/0 | 0/0 | — | — | n/a | — | 0 |
| false-premise-v1 | false-premise | dev | 3 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 1.00→1.00 | 0.033 | 0/0/3 | 0 |
| no-match-v1 | no-match | dev | 0 | 0 | 0 | 0 | 0/0 | 0/0 | — | — | n/a | — | 0 |
| unicode-v1 | unicode | dev | 1 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.083 | 0/0/3 | 0 |
| retry-v1 | retry | dev | 2 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.253 | 0/0/3 | 0 |
| oversize-v1 | oversize | dev | 0 | 0 | 0 | 0 | 0/0 | 0/0 | — | — | n/a | — | 0 |
| packing-pressure-v1 | packing | dev | 8 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.387 | 0/0/3 | 0 |
| quest-hydration-v1 | outcome | dev | 8 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.530 | 0/3/0 | 0 |
| travel-hydration-v1 | outcome | dev | 3 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.630 | 0/3/0 | 0 |
| alias-baseline-miss-v1 | alias | dev | 8 | 3 | 3 | 0 | 0/0 | 0/0 | 0→0 | 5.00→3.00 | 0.417 | 0/0/3 | 0 |
| pronoun-baseline-miss-v1 | pronoun | dev | 0 | 0 | 0 | 0 | 0/0 | 0/0 | — | — | n/a | — | 0 |
| holdout-promise-negation-v1 | promise | holdout | 2 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.553 | 0/3/0 | 0 |
| holdout-current-reversal-v1 | current-update | holdout | 8 | 3 | 3 | 3 | 3/3 | 3/3 | 3→3 | 0.00→0.00 | 0.933 | 3/0/0 | 0 |
| holdout-private-name-v1 | private-match | holdout | 0 | 0 | 0 | 0 | 0/0 | 0/0 | — | — | n/a | — | 0 |
| holdout-alias-baseline-miss-v1 | alias | holdout | 8 | 3 | 3 | 0 | 0/0 | 0/0 | 0→0 | 6.00→4.00 | 0.380 | 0/0/3 | 0 |
| holdout-pronoun-baseline-miss-v1 | pronoun | holdout | 2 | 3 | 3 | 0 | 0/0 | 0/0 | 3→3 | 0.00→0.00 | 0.630 | 0/3/0 | 0 |

## Ranking benefit versus the deterministic baseline

Both arms are scored with the Plan 3 `scoreCases` over the same calls and labels.

| Arm | Recall@K | Recall@8 | MRR | nDCG | Negative pass |
| --- | ---: | ---: | ---: | ---: | ---: |
| deterministic baseline (81 calls) | 1.0000 | 1.0000 | 0.9167 | 0.9276 | 1.0000 |
| fused rerank (81 calls) | 1.0000 | 1.0000 | 0.9167 | 0.9276 | 1.0000 |

Top-1 is a labelled required source on 84.6% of answerable calls before and 84.6% after reranking; the fused order improved the best required-source position on 6 eligible call(s), demoted it on 0, and left the rest unchanged. Case-label pass rate over eligible calls moved from 92.3% to 92.3%.

## Calibration (fit on development, scored on holdout)

Fitted a monotonic Platt map on 27 decisive development call(s); the calibrated signal is the model's strongest "answers the query?" probability.

| Split | Signal | Brier | ECE |
| --- | --- | ---: | ---: |
| held-out decisive (3) | raw | 0.0045 | 0.0667 |
| held-out decisive (3) | calibrated | 0.0000 | 0.0002 |
| all decisive (30) | raw | 0.0229 | 0.1350 |
| all decisive (30) | calibrated | 0.0000 | 0.0036 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.6454, b = 1.3874. The held-out rows are the unbiased estimate; the gate scores the calibrated map over every decisive call, which is the map the lane would ship with.

Decisive case accuracy 100.0% over 30 decisive gate-eligible call(s). Mean transport latency 119 ms.

## Promotion gate — `memory-reranking`

**PROMOTE**

All gates passed.

Gate: samples 20+, accuracy 85.0%+, Brier <= 0.15, ECE <= 0.15.

Proposed promotion record:

```json
{
  "metrics": {
    "samples": 30,
    "accuracy": 1,
    "brier": 0,
    "expectedCalibrationError": 0.0036
  },
  "calibration": {
    "a": 2.6454,
    "b": 1.3874
  },
  "promotedAt": "2026-09-17",
  "evidence": "docs/system-one-rerank-benchmark.md"
}
```

## Observations

- **Coverage.** 78 of 81 call(s) were gate-eligible (the shortlist retrieved a labelled required source); 3 call(s) were unanswerable, including cases whose baseline recall miss cannot be repaired by reordering. 6 case(s) produced an empty shortlist and were never called.
- **Assertions.** 0 decisive call(s) landed on an unanswerable shortlist; those are excluded from the gate label and reported here so an over-eager assertion is visible.
- **Ranking.** Aggregate Recall@K +0.0000, MRR +0.0000, and nDCG +0.0000 are unchanged over the deterministic baseline: every supported-case required source was already inside the top K, and the Plan 3 scorer excludes expected-miss alias/pronoun rows from MRR/nDCG. The rerank's position movement is visible in the per-case table (best rank before→after) and the improved/demoted counts: 6 improved, 0 demoted, 72 unchanged. Negative (forbidden-source) pass rate stayed 1.0000.
- **Gate label.** 6 of 78 eligible call(s) did not satisfy the case label (92.3% pass rate). The lane deferred on 6 of them and acted on 0, so the decisive accuracy above is an asserted-subset figure, not the corpus-wide pass rate. A deferral leaves the deterministic order in place.
- **Honesty.** The gate label only asks whether the lane keeps every retrieved required source inside the top K; it cannot reward a source the shortlist never retrieved, and a decisive subset with no observed errors cannot test the calibration's error tail. The corpus is small and provider-free, and the fixture is the same one Plan 3 uses, so a passing gate is a promotion candidate, not proof.
- **No active path.** The lane has no runtime wiring. A promotion record is evidence only: recall authorization, caps, and the deterministic order fallback are unchanged.

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
npx tsx scripts/evaluate-system-one-rerank-lane.ts --repeat 3
```

Raw per-call data: `docs/system-one-rerank-benchmark.json`.

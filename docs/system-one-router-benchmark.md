# System One (Jev) L7 cost/quality router lane benchmark

Generated 2026-09-17T03:41:12.252Z by `scripts/evaluate-system-one-router-lane.ts` using the live System One adapter.

## What this measures

The L7 cost/quality router chooses which handler runs a request. The battery is one `choice` over
`deterministic`, `cheap-generation`, `frontier-generation`, `human-review` (plus `none_of_these`),
one three-level `complexity` `score`, and one `deterministic_sufficient` `noul`; `composeRouterDecision`
turns them into a handler. There is no candidate oracle, so the lane is graded against a labeled
corpus of request projections and the handler each case should route to.

The fixed status-quo handler for composition is **`frontier-generation`**, the production shadow lane's baseline.
The router may only move toward a cheaper generation handler or human review; it never upgrades, and on
missing or uncertain answers it keeps the current handler. `human-review` cases are forced there by the
safety gate regardless of the answers.

| Setting | Value |
| --- | --- |
| Model | jev-1.13.0 |
| Current handler | `frontier-generation` |
| Confidence thresholds (action / review) | 0.75 / 0.5 |
| Repeats | 3 |
| Corpus | 20 requests x 3 repeats = 60 calls |

Acted decisions are those whose composed band is `act`; only they assert confidence, so only they are
calibrated and scored by the promotion gate. A deferral keeps the status-quo handler and is coverage, not
a confidence claim. `correct` means the composed handler equals the labeled expected handler.

## Corpus and per-case results

| Case | Expected | Holdout | Calls | Acted | Correct | Errors | Composed handlers |
| --- | --- | :---: | ---: | ---: | ---: | ---: | --- |
| det-dice | deterministic | no | 3 | 3 | 3/3 | 0 | deterministic 3 |
| det-price | deterministic | no | 3 | 3 | 3/3 | 0 | deterministic 3 |
| det-clock | deterministic | no | 3 | 3 | 3/3 | 0 | deterministic 3 |
| det-inventory | deterministic | no | 3 | 3 | 3/3 | 0 | deterministic 3 |
| det-travel | deterministic | yes | 3 | 3 | 3/3 | 0 | deterministic 3 |
| cheap-weather | cheap-generation | no | 3 | 3 | 3/3 | 0 | cheap-generation 3 |
| cheap-name | cheap-generation | no | 3 | 3 | 3/3 | 0 | cheap-generation 3 |
| cheap-greeting | cheap-generation | no | 3 | 3 | 3/3 | 0 | cheap-generation 3 |
| cheap-summary | cheap-generation | no | 3 | 3 | 3/3 | 0 | cheap-generation 3 |
| cheap-color | cheap-generation | yes | 3 | 3 | 3/3 | 0 | cheap-generation 3 |
| frontier-scene | frontier-generation | no | 3 | 0 | 3/3 | 0 | frontier-generation 3 |
| frontier-heist | frontier-generation | no | 3 | 0 | 3/3 | 0 | frontier-generation 3 |
| frontier-arc | frontier-generation | no | 3 | 0 | 3/3 | 0 | frontier-generation 3 |
| frontier-negotiation | frontier-generation | no | 3 | 0 | 3/3 | 0 | frontier-generation 3 |
| frontier-lore | frontier-generation | yes | 3 | 0 | 3/3 | 0 | frontier-generation 3 |
| human-kill | human-review | no | 3 | 3 | 3/3 | 0 | human-review 3 |
| human-canon | human-review | no | 3 | 3 | 3/3 | 0 | human-review 3 |
| human-irreversible | human-review | no | 3 | 3 | 3/3 | 0 | human-review 3 |
| human-harm-child | human-review | yes | 3 | 3 | 3/3 | 0 | human-review 3 |
| human-self-harm | human-review | no | 3 | 3 | 3/3 | 0 | human-review 3 |

## Calibration

Fit the monotonic Platt map on the acted development decisions and scored it out of sample on the held-out cases.

| Split / signal | Accuracy | Brier | ECE |
| --- | ---: | ---: | ---: |
| all acted, raw (45) | 100.0% | 0.0079 | 0.0569 |
| all acted, calibrated (45) | 100.0% | 0.0001 | 0.0031 |
| held-out acted, raw (9) | 100.0% | 0.0094 | 0.0711 |
| held-out acted, calibrated (9) | 100.0% | 0.0000 | 0.0034 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.2177, b = 0.9611 (fit on 36 development acted decision(s); held out 9).

Coverage by expected handler: deterministic 15/15 acted, cheap-generation 15/15 acted, frontier-generation 0/15 acted, human-review 15/15 acted.

`frontier-generation` cases produced no acted decisions: the model deferred to the status-quo handler, so their correctness is measured but their confidence is not calibrated by this run.

## Promotion gate — `cost-router`

Metrics scored on the calibrated acted signal: samples 45, accuracy 100.0%, Brier 0.0001, ECE 0.0031.

Gate: minSamples 30, minAccuracy 0.95, maxBrier 0.05, maxECE 0.05.

**PROMOTE**

All gates passed.

### Proposed `cost-router` promotion record

```json
{
  "metrics": {
    "samples": 45,
    "accuracy": 1,
    "brier": 0.000054444277495177155,
    "expectedCalibrationError": 0.0031250164465079777
  },
  "calibration": {
    "a": 2.217694769198385,
    "b": 0.9610806384124755
  },
  "promotedAt": "2026-09-17",
  "evidence": "docs/system-one-router-benchmark.md"
}
```

## Honesty notes

- The corpus is small and hand-labeled; it exercises all four handlers and both safety gates but cannot
  cover the full tail of production requests. A passing gate is a promotion candidate, not a guarantee.
- The corpus produced **no incorrect acted decisions**, so calibration cannot be stress-tested: the Platt
  fit is provisional until shadow data with negative examples exists.
- The `cost-router` gate is strict (accuracy >= 0.95, Brier/ECE <= 0.05). The verdict above is reported as
  measured, including any failures.
- Only schema-valid calls produce decisions; transport failures are reported separately and never counted
  as acted samples.

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
npx tsx scripts/evaluate-system-one-router-lane.ts --repeat 3
```

Raw per-call data: `docs/system-one-router-benchmark.json`.

# System One (Jev) L2 adventure-selection benchmark

Generated 2026-09-17T19:20:11.649Z by `scripts/evaluate-system-one-adventure-lane.ts` using the live System One adapter.

## What this measures

The L2 lane is an **advisory exact-candidate selector, wired in shadow (record-only)**. `buildAdventureSelectionQuestions`
builds one fusion-free single battery over the union of the turn's advertised candidates: a
`supported` noul ("does the declaration clearly describe committing exactly one advertised
candidate?"), one per-candidate relevance `score`, and one aggregate `best_candidate`
`choice` over the exact candidate ids with the fail-closed `none_of_these` option.
`composeAdventureSelection` requires the aggregate choice to name an advertised candidate and
combines the chosen option's probability with the `supported` noul as the minimum of the two
independent claims; `act` selects, `confirm` records a lower-confidence selection, and anything
below defers. The lane is **wired in shadow (record-only)** behind the `FEATURE_SYSTEM_ONE` feature flag,
the enabled setting, a usable key, and a non-`off` lane mode: it records one immutable shadow decision
per fresh adventure turn that advertises candidates and never selects, orders, or commits anything. An
`active` lane mode is still record-only because no promoted active path exists.

The lane **never adds, drops, or authorizes a candidate**: candidate ids and digests are already
server-issued, selection is exact-candidate only, and the existing digest re-validation and
command bridge remain authoritative. There is no repository fixture, so the lane is graded
against a hand-labeled projection corpus of declarations and server-shaped candidate sets.

`act` is the only behavior-changing outcome. `confirm` is a deferral (it records a selection but
changes no behavior) and is coverage, not a decision, so only acted decisions are calibrated and
scored by the promotion gate. `correct` uses the case's asserted-subset rubric: the committed
selection — or the deferral — must be in the case's `acceptable` set.

Because the first live run showed the raw model naming the right candidate below the server
default action bar (0.75), the harness also sweeps a fixed grid of lower thresholds,
re-scoring the candidate each call actually named (committed or not) against the case labels.
That sweep reports a **recommended action threshold**; it does not change the server default.

## Setup

| Setting | Value |
| --- | --- |
| Model | jev-1.13.0 |
| Base URL | https://api.typesafe.ai/v1 |
| Lane | `adventure-selection` (advisory, shadow-wired record-only; no promoted active path) |
| Confidence thresholds (action / review) | 0.75 / 0.5 |
| Action-threshold sweep grid | 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75 |
| Battery | single fusion-free battery: 1 `supported` noul + 1 `relevance:<candidateId>` score per candidate + 1 `best_candidate` choice |
| Repeats | 3 |
| Corpus | 31 declarations x 3 repeats = 93 calls |
| Holdout | 9 case(s) held out of the Platt fit (22 development) |
| Harvested cases | 1 confirmed merged, 0 skipped — `server/test/fixtures/system-one-harvested/adventure-selection.json` |

## Corpus and per-case results

1 of 31 case(s) are **harvested** rows: confirmed live-derived labels from
`server/test/fixtures/system-one-harvested/adventure-selection.json` (0 confirmed proposal(s) skipped). They run through the same composition,
calibration, and threshold logic as the frozen corpus, so the gate metrics below include them.

| Case | Category | Split | Provenance | Expected | Calls | Acted | Exact | Correct | Errors | Effective outcomes |
| --- | --- | :---: | :---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| direct-travel-mill | direct-match | dev | frozen | travel:mill-01 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| direct-travel-harbor | direct-match | holdout | frozen | travel:harbor-04 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| direct-check-climb | direct-match | dev | frozen | check:climb-05 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| direct-commerce-rope | direct-match | dev | frozen | shop:buy-rope-07 | 3 | 3 | 3/3 | 3/3 | 0 | shop:buy-rope-07 3 |
| direct-quest-accept | direct-match | holdout | frozen | quest:accept-harbor-09 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| direct-progression-level | direct-match | dev | frozen | level:advance-11 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-rest-long-short | ambiguous | dev | frozen | rest:long-12 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-travel-watchtower | ambiguous | dev | frozen | travel:watchtower-16 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-travel-two-roads | ambiguous | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| ambig-power-target | ambiguous | dev | frozen | power:mending-bryn-19 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-combat-power-target | ambiguous | holdout | frozen | combat:firebolt-bandit-22 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-commerce-sell | ambiguous | holdout | frozen | shop:sell-ring-24 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-consumable-target | ambiguous | dev | frozen | consumable:heal-aster-25 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-check-vs-travel-trap | multi-family | dev | frozen | check:force-gate-28 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-row-vs-travel | multi-family | dev | frozen | check:row-30 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-quest-vs-travel | multi-family | dev | frozen | quest:accept-harbor-31 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-commerce-vs-inventory | multi-family | dev | frozen | shop:buy-rope-33 | 3 | 3 | 3/3 | 3/3 | 0 | shop:buy-rope-33 3 |
| multi-power-vs-rest | multi-family | holdout | frozen | rest:long-35 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-combat-vs-power | multi-family | holdout | frozen | combat:firebolt-wolf-37 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| unsupported-question | unsupported | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unsupported-hypothetical | unsupported | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unsupported-two-actions | unsupported | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unsupported-choice-question | unsupported | holdout | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unadvertised-fireball | unadvertised | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unadvertised-destination | unadvertised | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unadvertised-sword | unadvertised | holdout | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unadvertised-no-candidates | unadvertised | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| smalltalk-weather | small-talk | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| smalltalk-innkeeper | small-talk | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| smalltalk-joke | small-talk | holdout | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:09c974ce40a5 | harvested | dev | harvested | inventory-candidate:fed332e8091405e4ee6b0cccacc4c01cb5c7acad79236ad2 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |

## Decision stability

Repeated draws of the same case should produce the same decision. `decision` is the candidate each
call named (the composed pick, or the raw pick recovered from a deferral), else `defer`; every
repeat keeps the production-shaped request (no `uid`), so these are same-state draws of the exact
request the gate scores. A uid-decorrelated probe moved the selected threshold from 0.60 to 0.30
and produced a degenerate negative-slope calibration map (calibrated ECE 0.1344 > 0.10), so the
protocol decision is that gate measurements mirror production and the vendor decorrelator is
reserved for dedicated stability probes.

| Metric | Value |
| --- | ---: |
| Mean agreement | 100.0% |
| Conflict cases | 0 of 31 (0.0%) |
| Mean signal std dev | 0.0096 |
| Max signal std dev | 0.0205 |

Honesty: stability is repeatability, not accuracy; a consistently deferred case is stable and still
a coverage miss, and a conflicted case may still have every individual pick labeled acceptable.

## Threshold sweep

The lane composes at the server default action threshold **0.75**. The sweep re-scores the
candidate each call named — the composed pick, or for a deferral the raw `best_candidate` recovered
from the answers — against that case's acceptable set at every grid threshold, without re-asking
the model. Selection takes the greatest-coverage threshold whose acted count and acted accuracy clear
the lane gate floors (>= 0.9 accuracy over >= 30 acted) over every labeled sample;
the Platt map is still fit on development acted decisions only, so the recommended verdict is
descriptive rather than held out. The server default remains **0.75** until configured.

Rows count only calls that named a candidate: a call that named nothing cannot act at any threshold,
so `Acted` and `Coverage` are over named calls, not over every graded call.

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.35 | 54/54 | 100.0% | 100.0% |
| 0.40 | 54/54 | 100.0% | 100.0% |
| 0.45 | 49/54 | 90.7% | 100.0% |
| 0.50 | 48/54 | 88.9% | 100.0% |
| 0.55 | 34/54 | 63.0% | 100.0% |
| 0.60 | 23/54 | 42.6% | 100.0% |
| 0.65 | 12/54 | 22.2% | 100.0% |
| 0.70 | 7/54 | 13.0% | 100.0% |
| 0.75 | 6/54 | 11.1% | 100.0% |

Selected recommended action threshold: **0.40** (coverage 100.0%, acted accuracy 100.0% over 54 acted).
- filtered 4 of 9 threshold(s) for failing actedAccuracy >= 0.9 with at least 30 acted decisions
- selected greatest-coverage threshold 0.4 (coverage 1) meeting actedAccuracy >= 0.9 with at least 30 acted decisions

### Development split

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.35 | 36/36 | 100.0% | 100.0% |
| 0.40 | 36/36 | 100.0% | 100.0% |
| 0.45 | 33/36 | 91.7% | 100.0% |
| 0.50 | 33/36 | 91.7% | 100.0% |
| 0.55 | 24/36 | 66.7% | 100.0% |
| 0.60 | 15/36 | 41.7% | 100.0% |
| 0.65 | 9/36 | 25.0% | 100.0% |
| 0.70 | 6/36 | 16.7% | 100.0% |
| 0.75 | 6/36 | 16.7% | 100.0% |

### Verdict comparison

| Configuration | Threshold | Gate | Samples | Accuracy | Brier | ECE |
| --- | ---: | :---: | ---: | ---: | ---: | ---: |
| Server default | 0.75 | NOT READY | 6 | 100.0% | 0.0000 | 0.0043 |
| Recommended | 0.40 | PROMOTE | 54 | 100.0% | 0.0002 | 0.0107 |

## Calibration

Fit the monotonic Platt map on the acted development decisions at the server default threshold (0.75) and scored it out of sample on the held-out cases. The recommended-threshold calibration is in the sweep above and the JSON sidecar.

| Split / signal | Accuracy | Brier | ECE |
| --- | ---: | ---: | ---: |
| all acted, raw (6) | 100.0% | 0.0435 | 0.2083 |
| all acted, calibrated (6) | 100.0% | 0.0000 | 0.0043 |
| held-out acted, raw (0) | n/a | 0.0000 | 0.0000 |
| held-out acted, calibrated (0) | n/a | 0.0000 | 0.0000 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.8500, b = 1.6394 (fit on 6 development acted decision(s); held out 0).

## Promotion gate — `adventure-selection`

The server default action threshold remains **0.75**; a recommended threshold is an evaluation
finding for the parent to configure, not an automatic change. The record below is proposed from the
recommended-threshold verdict, because that is the configuration the evidence supports.

### Recommended-threshold verdict (0.40)

Metrics scored on the calibrated acted signal at this threshold: samples 54, accuracy 100.0%, Brier 0.0002, ECE 0.0107.

**PROMOTE**

All gates passed.

### Server-default verdict (0.75)

Metrics scored on the calibrated acted signal at the composed default threshold: samples 6, accuracy 100.0%, Brier 0.0000, ECE 0.0043.

**NOT READY**

- insufficient samples: 6 < 30
- accuracy lower bound below minimum: 0.6097 < 0.8000

### Proposed `adventure-selection` promotion record (recommended threshold)

```json
{
  "metrics": {
    "samples": 54,
    "accuracy": 1,
    "brier": 0.00015067045170246018,
    "expectedCalibrationError": 0.010722786698566189
  },
  "calibration": {
    "a": 1.5751188294490337,
    "b": 4.106562315070202
  },
  "promotedAt": "2026-09-17",
  "evidence": "docs/system-one-adventure-benchmark.md"
}
```

## Observations

- **Coverage.** 6 of 93 graded calls acted (6 act / 42 confirm / 45 fallback); the rest deferred. 36 of 87 deferral(s) were in the acceptable set.
- **Decisive accuracy.** Among acted decisions, 6/6 (100.0%) were in the acceptable set and 6/6 (100.0%) matched the single preferred call.
- **Under-confidence.** 54 readout(s) named a candidate; 48 named one but deferred, with signals 0.43–0.70, and 48 of those named picks were acceptable. The raw model is right but under the 0.75 bar — the same systematic under-confidence the L1 Director lane measured. The sweep recommendation is the lever; the server default stays 0.75.
- **Acted errors.** No acted decision fell outside its case's acceptable set.
- **Calibration.** Held-out calibrated Brier 0.0000 and ECE 0.0000; all-acted calibrated Brier 0.0000 and ECE 0.0043. The acted subset has no observed errors, so the calibration tail is untested.

## Honesty notes

- The corpus is a **hand-labeled projection**, not a repository fixture: candidate ids, digests,
  and labels are realistic fixtures and the declarations are written, not sampled from real
  turns. A passing gate is a promotion candidate, not a guarantee.
- The recommended threshold is selected on the same labeled corpus that scores its verdict, so
  that verdict is **descriptive, not a held-out guarantee**; the Platt map is still fit on
  development acted decisions only. The server default stays until the parent decides otherwise.
- The lane is **wired in shadow (record-only)**: it records one immutable decision per fresh
  adventure turn that advertises candidates and never selects, orders, or commits. Any promotion
  record this run justifies is evidence, not activation; an `active` lane mode still stays
  record-only until a promoted active path exists.
- Decisive accuracy is an **asserted-subset figure**: it counts membership in the case's
  acceptable set, which is a judgment call. Exact-preferred agreement and the per-case table are
  reported alongside it, and the gate is scored only on acted decisions.
- **Decision stability is repeatability, not accuracy**: a consistently deferred case is stable and
  still a coverage miss. Harvested rows are live-derived labels and are flagged as such in the
  corpus table so a reviewer can see the gate includes them.
- The `adventure-selection` gate is the base lane gate (accuracy >= 0.9, Brier/ECE <= 0.1). The verdict above is reported as measured, including any failures.
- Only schema-valid calls produce compositions; transport failures are reported separately and
  never counted as acted samples.

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
npx tsx scripts/evaluate-system-one-adventure-lane.ts --repeat 3
```

Raw per-call data: `docs/system-one-adventure-benchmark.json`.

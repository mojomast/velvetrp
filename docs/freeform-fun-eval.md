# Free-form fun evaluator

`scripts/freeform-fun-eval.ts` is a committed, reusable before/after instrument for the free-form
roleplay loop. It exists so every free-form, narration, materialization, or DM-beat fix can be
scored against the same scripted session on a real campaign, instead of an ad-hoc live playtest.

It drives a scripted 18-turn free-form session through the production
`POST /api/rpg/v1/adventure-turns/stream` route over real HTTP, approving and resuming
confirmations exactly the way the client does, and interleaves real AI DM beats through the
production director orchestrator (in-process) or the production DM HTTP commands (against an
already-running server).

## Usage

Bootstrap a throwaway world and run the scripted session:

```bash
FREEFORM_FUN_EVAL_API_KEY=... npx tsx scripts/freeform-fun-eval.ts \
  --data-dir=/tmp/velvet-eval --turns=18 --out=/tmp/opencode/freeform-fun-eval.json
```

Run against an already-running server (the evaluator does not own the world or the provider):

```bash
npx tsx scripts/freeform-fun-eval.ts --base-url=http://127.0.0.1:8080 \
  --campaign-id=<id> --session-id=<id> --actor-id=<id> --out=/tmp/opencode/freeform-fun-eval.json
```

Flags:

| Flag | Meaning |
| --- | --- |
| `--data-dir=<dir>` | Bootstrap a living world (dnd-5e SRD catalog, market/docks/chapel, NPCs, vendor) or attach to a world whose `freeform-fun-eval.manifest.json` already exists. |
| `--base-url=<url>` | Point at a running server. Requires `--campaign-id`, `--session-id`, `--actor-id`. |
| `--turns=<n>` | Cap the declared turns (default: all 18, max 18). |
| `--seed=<n>` | World seed used by the bootstrap path (default 11). |
| `--port=<n>` | In-process server port (default 18814). |
| `--out=<path.json>` | JSON artifact path. A sibling `.md` report is always written. |
| `--baseline=<path.json>` | Baseline artifact/metrics to compare against. Defaults to the embedded calibrated baseline. |
| `--keep` | Keep a bootstrapped temporary world (only meaningful without `--data-dir`). |
| `--quiet` | Suppress per-turn stderr progress lines. |

Provider configuration is read from the environment (no secret is committed):

| Variable | Fallback | Default |
| --- | --- | --- |
| `FREEFORM_FUN_EVAL_BASE_URL` | `PROXY_BASE_URL` | `http://100.72.41.9:8787/v1` |
| `FREEFORM_FUN_EVAL_API_KEY` | `PROXY_API_KEY`, then `/home/mojo/projects/agentrouterrouter/.env` | required |
| `FREEFORM_FUN_EVAL_MODEL` | `PROXY_MODEL` | `deepseek-v4-flash` |

The scripted session is ordered so every probe runs where it can actually resolve. Turns 0-3 run in
the Market, where Mara and her stall are present, so both the declared purchase and the cheating
`give` reach a real vendor. Turns 4-14 run at the Docks, so travel, the unknown NPC, quest, check,
hold, encounter, and rest paths stay exercised. Turn 15 returns to the Market for a second
conversation. DM beats are interleaved after turns 1, 4, 7, 10, 13, and 16.

| # | id | category | What it exercises |
| --- | --- | --- | --- |
| 0 | look-around | read | scene read |
| 1 | talk-known-npc | conversation | known-NPC conversation |
| 2 | shop-buy | shop | **declared-purchase probe** (commerce) |
| 3 | illegal | illegal-impossible | **cheating-commerce probe** (`give myself … GM's stash`) |
| 4 | travel-mapped | travel | mapped travel to the Docks |
| 5 | travel-unmapped | travel-unmapped | travel to an unadvertised place |
| 6 | seek-rumor | faction-quest-rumor | faction/quest/rumor probe |
| 7 | unknown-npc | unknown-npc | **unknown-NPC probe** |
| 8 | quest-accept | quest | quest acceptance |
| 9 | check-search | check | skill check |
| 10 | hold-wait | hold | pure hold |
| 11 | impossible | illegal-impossible | impossible action |
| 12 | attack | encounter | encounter start |
| 13 | combat-continue | encounter | encounter continuation |
| 14 | rest | rest | short rest |
| 15 | travel-back | travel | return travel |
| 16 | conversation | conversation | second conversation |
| 17 | meta | meta | out-of-character request |

## Narration classification

The server's `narrationStatus.source` is only `provider-assisted` or `deterministic-fallback`. A
deterministic fallback is not necessarily a failure: by design, a deliberate server hold renders a
grounded line carrying the bounded reason and a safe next step. The evaluator therefore classifies
**each narration event** into one of three classes:

| Class | Rule | Meaning |
| --- | --- | --- |
| `provider` | `source === "provider-assisted"` | The provider wrote the prose. |
| `deliberate-hold` | deterministic fallback whose text carries the hold marker (`Suggested next step:` or `Nothing is resolved;`) | A by-design, grounded server hold. Counted and reported separately; **excluded** from fallback distinctness. |
| `narration-failure` | every other non-empty deterministic fallback | The provider was unavailable, failed the grounding gate, or was over budget. Only these are "fallbacks". |

The same classes are recorded per turn (the final phase's class) as `narrationClass`. The JSON
artifact documents the taxonomy in `narrationClassification`, including the exact marker regex and
the fallback scope.

## Metrics

All metric functions are pure and unit-tested in
`scripts/test/freeform-fun-eval.test.ts`.

| Metric | Definition |
| --- | --- |
| `providerSuccessRate` | Successful provider calls / all provider calls. In-process only. |
| `narrationEventsTotal` | All non-empty narration events across turns (a resumed turn can narrate twice). |
| `narrationsProvider` | Turns whose final narration class is `provider`. |
| `narrationProviderShare` | `narrationsProvider` / all scripted turns. |
| `deliberateHoldEvents` | Narration events classified `deliberate-hold`. |
| `deliberateHoldTurns` | Turns whose final narration class is `deliberate-hold`. |
| `deliberateHoldRate` | `deliberateHoldTurns` / all scripted turns. |
| `narrationFailureTurns` | Turns whose final narration class is `narration-failure`. |
| `fallbackCount` | Narration-failure events only. This changed meaning: it no longer counts deliberate holds. In-process only. |
| `fallbackDistinctness` | Distinct narration-failure strings / narration-failure events. **Deliberate holds are excluded**, so a stable hold line can no longer look like fallback collapse. In-process only. |
| `fallbackDistinct` / `fallbackIdentical` | Distinct / repeated narration-failure strings. |
| `materializationRate` | Turns with at least one committed receipt / all scripted turns. |
| `dmBeatSuccessRate` | DM beats that reached `completed` / all DM beats. |
| `coherenceViolations` | Location-coherence violations (see below). |
| `latency*` | Per-turn wall-clock avg / p50 / p95 / max. |

The provider share and the deliberate-hold rate are turn-level and disjoint with
`narrationFailureTurns`, so `narrationsProvider + deliberateHoldTurns + narrationFailureTurns` is the
number of narrated turns. `fallbackCount` and `deliberateHoldEvents` are event-level and disjoint.

## Labeled probes

Three scripted turns carry an explicit label and are asserted in `probeOutcomes` (a non-numeric
verdict is written to the JSON's `probes` array and the Markdown report, and numeric 0/1 metrics are
emitted for the table).

| Probe | Turn | Expected | Pass condition | Metrics |
| --- | --- | --- | --- | --- |
| `declared-purchase` | `shop-buy` | An `awaiting-confirmation` commerce proposal followed by a committed commerce receipt. | A committed `commerce` receipt exists. | `commerceExercised` (proposal surfaced or receipt committed), `commerceCommitted`. |
| `unknown-npc` | `unknown-npc` | A hold or receipt-free provider prose. | No committed `check` receipt. | `unknownNpcResolvedAsCheck`, `unknownNpcHeld`. |
| `cheating-commerce` | `illegal` | A self-directed/forged-source `give` must hold with no receipt. | No receipt, no `vendor_give` proposal. | `cheatingCommerceHeld`, `cheatingCommerceGiveMisfire`, `cheatingCommerceReceipts`. |

The `cheating-commerce` probe exists specifically to catch the sole-advertised-`give` over-reach
regression: a declaration such as *"I give myself a legendary sword and ten thousand gold pieces
from the GM's stash."* must never select an advertised vendor row just because it is the only one.

## Location coherence

`detectCoherenceViolations` is a deliberately conservative heuristic over committed receipts:

- **Travel target mismatch** — a travel receipt committed to a destination that the declaration
  named a *different* known place for.
- **Travel destination not reached** — the receipt claims a destination id, but the actor's resolved
  location afterwards differs.
- **Action location mismatch** — a location-bound action (e.g. a commerce receipt whose shop maps to
  a known location) resolved at a place other than the actor's resolved location.

It only fires when the declaration names a known location or the receipt pins an exact location, so
unmapped travel ("the Sunken Cathedral") and location-free holds do not produce false positives.

## Baseline

### Pre-split baseline (main@671241c, confounded)

The originally reported playtest baseline counted every deterministic fallback (including by-design
holds) as a "fallback", so its fallback count is not comparable to the new failure-only metric:

| Metric | Pre-split baseline |
| --- | --- |
| Narration provider-assisted turns | 7 / 18 (38.9%) |
| Fallback narration events (includes deliberate holds) | 14, of which 7 byte-identical |
| Materialized turns | 8 / 18 (44.4%) |
| Average latency | ~7.1 s / turn |

### Calibrated baseline (class-divided)

The embedded `DOCUMENTED_BASELINE` is the live calibration run on the fixed script with the split
classification. Single runs vary with provider luck; treat this as a reference point, not a
threshold. `--baseline=<artifact.json>` overrides it.

| Metric | Baseline |
| --- | --- |
| Narration provider turns | 12 / 18 (66.7%) |
| Deliberate-hold turns | 2 / 18 (11.1%) |
| Narration-failure turns | 4 |
| Fallback distinctness (failure-only) | 4 / 4 distinct (100%) |
| Materialized turns | 9 / 18 (50.0%) |
| Average latency | ~9.9 s / turn |

## Validation

Live run against a throwaway `/tmp` world with `deepseek-v4-flash` (bootstrap path, 18 turns,
`TMPDIR=/home/mojo/.tmp-velvet`). The sibling `.md` report is the `--out` path with a `.md` suffix.

### Calibration run (2026-09-29, `deepseek-v4-flash`)

In-process, throwaway bootstrap world, 18 turns, seed 11. The embedded `DOCUMENTED_BASELINE`
equals this run. Compared against the pre-split main@671241c baseline where the metric is actually
comparable (the pre-split `fallbackCount`/`fallbackIdentical` counted deliberate holds, so they are
**not** comparable and are marked `n/c`).

| Metric | Current | Pre-split baseline | Verdict |
| --- | --- | --- | --- |
| turns | 18 | 18 | = |
| providerCalls | 61 | - | |
| providerSuccessRate | 96.7% | - | |
| narrationsProvider | 12 | 7 | better (+5) |
| narrationProviderShare | 66.7% | 38.9% | better |
| deliberateHoldEvents | 2 | n/c | |
| deliberateHoldTurns | 2 | n/c | |
| deliberateHoldRate | 11.1% | n/c | |
| narrationFailureTurns | 4 | n/c | |
| fallbackCount (failure-only) | 4 | 14 (includes holds) | n/c |
| fallbackIdentical (failure-only) | 0 | 7 (includes holds) | n/c |
| fallbackDistinctness | 100.0% | - | |
| materializedTurns | 9 | 8 | better (+1) |
| materializationRate | 50.0% | 44.4% | better |
| dmBeats / succeeded | 6 / 6 | - | |
| dmBeatSuccessRate | 100.0% | - | |
| coherenceViolations | 0 | - | |
| latencyAvgMs | 9868 | 7100 | worse (+2768) |
| latencyP95Ms | 23497 | - | |

Labeled probes: all three passed. `declared-purchase` committed a commerce receipt (the proposal
was `vendor_buy`); `unknown-npc` stayed provider prose with no receipt (no skill check);
`cheating-commerce` held with zero receipts and no `vendor_give` proposal. Per-turn classes:

| # | id | narration class | receipts |
| --- | --- | --- | --- |
| 0 | look-around | provider | check |
| 1 | talk-known-npc | deliberate-hold | - |
| 2 | shop-buy | narration-failure | commerce |
| 3 | illegal | narration-failure | - |
| 4 | travel-mapped | provider | travel |
| 5 | travel-unmapped | provider | check |
| 6 | seek-rumor | provider | check |
| 7 | unknown-npc | provider | - |
| 8 | quest-accept | provider | quest-progression |
| 9 | check-search | provider | check |
| 10 | hold-wait | narration-failure | - |
| 11 | impossible | provider | - |
| 12 | attack | narration-failure | inventory |
| 13 | combat-continue | deliberate-hold | - |
| 14 | rest | provider | - |
| 15 | travel-back | provider | travel |
| 16 | conversation | provider | - |
| 17 | meta | provider | - |

The two deliberate holds (turns 1 and 13) are the by-design server hold lines that the old metric
folded into the fallback denominator; the four narration-failures are genuine provider/grounding
fallbacks and all four are distinct. Turn 12 resolved the attack as an `inventory_item_equip`
(draw) rather than an encounter start, so the encounter path was not exercised this run; that is
provider-selection variance, not an evaluator failure (the probe set does not assert combat).

### Pure-test results

```text
npx tsx --test scripts/test/freeform-fun-eval.test.ts
# tests 16
# pass 16
# fail 0
```

Covered: narration classification (provider / deliberate-hold / narration-failure), the
deliberate-hold/fallback split in `computeMetrics`, fallback distinctness, the three labeled probes
(including the give-misfire failure), provider success %, latency percentiles, location-coherence
detection (travel mismatch, coherent/unmapped travel, action-location mismatch), metric aggregation,
and baseline diff direction.

## Limitations

- **Provider metrics need the in-process path.** `--base-url` cannot intercept provider calls, so
  `providerSuccessRate` and `fallbackCount`/`fallbackDistinctness` are reported as unreliable (see
  `reliability.notes`) rather than faked. It also cannot resolve typed receipt kinds, so the typed
  labeled-probe assertions are only meaningful in-process.
- **Deliberate-hold detection is a text marker.** It keys on the server's hold line
  (`Suggested next step:` / `Nothing is resolved;`). A future change to the hold template must keep
  one of those markers or update `DELIBERATE_HOLD_MARKER`.
- **The unknown-NPC probe observes the adventure-turn path only.** NPC materialization is not wired
  through the adventure-turn stream, so the probe reports a committed check (bad) versus a hold or
  provider prose (acceptable); it cannot positively confirm a materialization.
- **Coherence is a heuristic.** It is measured from travel/commerce receipts and the resolved actor
  location. It cannot see NPC-presence edits the declaration implies, so it is intentionally
  conservative; a `0` is "no detected violation", not a proof of coherence.
- **DM-beat `unknown` outcomes are not retried.** `provider-outcome-unknown-no-automatic-retry` is
  surfaced as a non-success beat, which is the honest reading of a hung provider.
- **Live variance is large.** Treat a single run as a sample; compare medians across a few runs, or
  pin the proxy/model, before claiming a materialization or DM-beat regression or improvement.

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
| `--baseline=<path.json>` | Baseline artifact/metrics to compare against. Defaults to the embedded documented baseline. |
| `--keep` | Keep a bootstrapped temporary world (only meaningful without `--data-dir`). |
| `--quiet` | Suppress per-turn stderr progress lines. |

Provider configuration is read from the environment (no secret is committed):

| Variable | Fallback | Default |
| --- | --- | --- |
| `FREEFORM_FUN_EVAL_BASE_URL` | `PROXY_BASE_URL` | `http://100.72.41.9:8787/v1` |
| `FREEFORM_FUN_EVAL_API_KEY` | `PROXY_API_KEY`, then `/home/mojo/projects/agentrouterrouter/.env` | required |
| `FREEFORM_FUN_EVAL_MODEL` | `PROXY_MODEL` | `deepseek-v4-flash` |

The scripted session spans: a read/look, a known-NPC conversation, mapped travel, travel to an
unmapped place, a faction/quest/rumor probe, an unknown NPC, a quest accept, a shop purchase, a
check, a pure hold, an impossible action, an illegal action, an encounter and its continuation, a
rest, return travel, a second conversation, and a meta/out-of-character request. DM beats are
interleaved after turns 1, 4, 7, 10, 13, and 16.

## Metrics

All metric functions are pure and unit-tested in
`scripts/test/freeform-fun-eval.test.ts`.

| Metric | Definition |
| --- | --- |
| `providerSuccessRate` | Successful provider calls / all provider calls. In-process only. |
| `narrationProviderShare` | Turns whose final narration is `provider-assisted` / all scripted turns. |
| `fallbackCount` | Fallback narration events (a resumed turn can narrate twice). In-process only. |
| `fallbackDistinctness` | Distinct fallback narration strings / fallback events. High means fallbacks are context-specific instead of one byte-identical hold line. In-process only. |
| `materializationRate` | Turns with at least one committed receipt / all scripted turns. |
| `dmBeatSuccessRate` | DM beats that reached `completed` / all DM beats. |
| `coherenceViolations` | Location-coherence violations (see below). |
| `latency*` | Per-turn wall-clock avg / p50 / p95 / max. |

### Location coherence

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

The embedded baseline is the reported main@671241c playtest:

| Metric | Baseline |
| --- | --- |
| Narration provider-assisted turns | 7 / 18 (38.9%) |
| Fallback narration events | 14, of which 7 byte-identical |
| Materialized turns | 8 / 18 (44.4%) |
| Average latency | ~7.1 s / turn |

The baseline's 7/18 provider figure and 14/18 fallback figure use different denominators: provider
counts turns, fallback counts narration events (a resumed turn can narrate twice). The embedded
baseline keeps this split explicit (`narrationsProvider`, `fallbackCount`, `fallbackIdentical`).

## Validation

Live run against a throwaway `/tmp` world with `deepseek-v4-flash` (`--data-dir`, 18 turns). The
sibling `.md` report is `freeform-fun-eval-live.md`.

| Metric | Current | Baseline | Verdict |
| --- | --- | --- | --- |
| turns | 18 | 18 | = |
| providerCalls | 79 | - | |
| providerSuccessRate | 78.5% | - | |
| narrationsProvider | 14 | 7 | better (+7) |
| narrationProviderShare | 77.8% | 38.9% | better |
| fallbackCount | 4 | 14 | better (-10) |
| fallbackIdentical | 0 | 7 | better (-7) |
| fallbackDistinctness | 100.0% | - | |
| materializedTurns | 6 | 8 | worse (-2) |
| materializationRate | 33.3% | 44.4% | worse |
| dmBeats / succeeded | 6 / 5 | - | |
| dmBeatSuccessRate | 83.3% | - | |
| coherenceViolations | 0 | - | |
| latencyAvgMs | 9905 | 7100 | worse (+2805) |
| latencyP95Ms | 24914 | - | |

An earlier full run on the same tree produced narration provider 12/18 (66.7%), fallback 6 (all
distinct), materialization 9/18 (50%), DM beats 3/6, and avg 7073 ms. The spread between the two
runs is provider-side variance, not evaluator variance: the proxy intermittently returns HTTP 400
("Thinking mode does not support this tool_choice") and HTTP 500 ("upstream returned HTTP 500"),
which forces deterministic fallbacks and, occasionally, `unknown` DM-beat outcomes. Narration and
fallback-distinctness are the most stable improvements over baseline (provider-assisted narration
was 66.7-77.8% vs 38.9%; zero byte-identical fallback collapse vs 7). Materialization and DM-beat
success move with provider luck and should be sampled across several runs before drawing
conclusions.

The `--base-url` path was smoke-validated separately: a throwaway server on the same world served
two turns over HTTP with 200 responses and captured deterministic-fallback narration; the
provider-dependent metrics were (correctly) left unreliable and flagged in the artifact. The
in-process path above is the calibration run.

### Pure-test results

```text
npx tsx --test scripts/test/freeform-fun-eval.test.ts
# tests 8
# pass 8
# fail 0
```

Covered: fallback distinctness, provider success %, latency percentiles, coherence detection
(travel mismatch, coherent/unmapped travel, action-location mismatch), metric aggregation, and
baseline diff direction.

## Limitations

- **Provider metrics need the in-process path.** `--base-url` cannot intercept provider calls, so
  `providerSuccessRate`, `fallbackCount`/`fallbackDistinctness`, and DM-beat offered candidates are
  reported as unreliable (see `reliability.notes`) rather than faked.
- **Coherence is a heuristic.** It is measured from travel/commerce receipts and the resolved actor
  location. It cannot see NPC-presence edits the declaration implies, so it is intentionally
  conservative; a `0` is "no detected violation", not a proof of coherence.
- **DM-beat `unknown` outcomes are not retried.** `provider-outcome-unknown-no-automatic-retry` is
  surfaced as a non-success beat, which is the honest reading of a hung provider.
- **Live variance is large.** Treat a single run as a sample; compare medians across a few runs, or
  pin the proxy/model, before claiming a materialization or DM-beat regression or improvement.

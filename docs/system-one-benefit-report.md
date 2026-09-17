# System One (Jev): before-and-after benefit report

Generated 2026-09-17 from live measurements by `scripts/benchmark-system-one-lanes.ts`
(room routing) and `scripts/benchmark-system-one-director-lane.ts` (Director beat selection).
Raw per-call data lives in `docs/system-one-benchmark.json` and
`docs/system-one-director-benchmark.json`.

## TL;DR

Jev replaces a multi-second LLM decision call with a single ~0.1 s typed-decision call.

- **Room routing:** the decision drops from **1514 ms** (DeepSeek) to **353 ms** gated
  (**125 ms** p50) — **~4.3x faster on average, ~11.7x faster at the median** — and is more
  reliable (100% vs 95% schema-valid) and more accurate (exact 90% vs 80%).
- **Director beat selection:** the decision drops from **1473 ms** to **303 ms** gated
  (**121 ms** p50) — **~4.9x faster on average, ~11.6x faster at the median** — and is
  **cheaper** ($0.000128 vs $0.000174 per decision), because the Director prompt is large
  and Jev output tokens are free.
- **A typical turn** does both decisions: that is about **2.3 s saved per turn**, or roughly
  **3.9 minutes per 100-turn session**. Per 1,000 decisions each lane saves about 19.5 minutes.
- Room routing is **promoted and active when configured**; the Director lane is still
  **shadow-only**. Both are disabled by default, and these are measured, reproducible
  benefits of the configured behavior.

## What "before" and "after" mean

Both lanes solve a decision the production OpenAI-compatible path currently makes:

| | Before Jev | After Jev (gated) |
| --- | --- | --- |
| Room routing | one `selectRoomSpeakers` LLM call | Jev per-participant battery when confident, else the LLM call |
| Director beat | one forced `select_dm_beat` LLM call¹ | Jev battery when confident, else the LLM call |
| Transport | `POST /chat/completions` on the router | `POST /systemone` on `api.typesafe.ai` |
| Model | `deepseek-v4-flash` | `jev-latest` (resolved to `jev-1.13.0`) |
| Price | $0.07784 / $0.15568 per M in/out | $0.042 / $0.00 per M in/out |

¹ The Director's "before" is a **lower bound**: production may spend one to two read-only
grounding rounds before the selection call, so the true before-Jev cost and latency are
higher than measured here. The routing "before" is the exact production call.

## Measured results

### Room routing — 20 labeled turns × 3 repeats

| Metric | Jev | DeepSeek (before) | Gated (after) |
| --- | ---: | ---: | ---: |
| Success rate | 100.0% | 95.0% | 100.0% |
| Exact-set accuracy | 90.0% | 80.0% | 90.0% |
| Micro F1 | 90.0% | 89.4% | 96.7% |
| Latency mean | 123 ms | 1514 ms | 353 ms |
| Latency p50 | 110 ms | 1459 ms | 125 ms |
| Cost / decision | $0.0000316 | $0.0000261 | $0.0000328 |

### Director beat selection — 5 states × 5 repeats

| Metric | Jev | DeepSeek (before) | Gated (after) |
| --- | ---: | ---: | ---: |
| Accepted accuracy | 80.0% | 80.0% | 84.0% |
| Exact accuracy | 80.0% | 68.0% | 84.0% |
| Latency mean | 145 ms | 1473 ms | 303 ms |
| Latency p50 | 119 ms | 1402 ms | 121 ms |
| Cost / decision | $0.0001249 | $0.0001740 | $0.0001281 |

The gated Director lane resolved **20/25 decisions with Jev, 4 with the LLM, 1 deterministic
fallback**; when Jev acted its accepted accuracy was **100%**. The gated routing lane resolved
**54/60 with Jev, 6 with the LLM, 0 fallback**.

## Time saved

Per decision (gated vs. the LLM alone):

| Decision | Mean saved | Median saved | Speedup (mean / p50) |
| --- | ---: | ---: | ---: |
| Room routing | 1161 ms | 1334 ms | 4.3x / 11.7x |
| Director beat | 1170 ms | 1281 ms | 4.9x / 11.6x |
| **Both (one turn)** | **2331 ms** | **2615 ms** | — |

Projections (linear, from the measured means):

- **1 turn = 2.3 s saved.** A 100-turn session saves **~3.9 minutes** (median path ~4.4 min).
- **1,000 routing decisions = ~19.4 minutes** saved; **1,000 Director decisions = ~19.5 minutes**.
- Latency is bimodal: Jev-served decisions land at ~0.1–0.2 s, while the ~10–20% that fall
  back to the LLM keep its multi-second latency. The fast path is the common case.

## Cost

| Decision | Before | After (gated) | Delta |
| --- | ---: | ---: | ---: |
| Room routing | $0.0000261 | $0.0000328 | +$0.0000068 |
| Director beat | $0.0001740 | $0.0001281 | −$0.0000459 |
| **Net per turn** | — | — | **−$0.0000391 saved** |

Routing is marginally **more** expensive (its prompt is small, so the LLM's capped output
dominates), while the Director is clearly **cheaper** (its context is large and Jev output is
free). Net, the two lanes together come out slightly ahead — but the honest headline is that
**cost is roughly neutral while latency collapses**.

## Reliability and quality

- **Schema validity.** Jev returned a valid structured answer on 100% of calls in both
  benchmarks. The raw LLM path returned usable structured output on 95% of routing calls and
  96% of Director calls; failures are non-JSON or malformed selections that force a deterministic
  fallback in production.
- **Confidence gating.** Jev declines rather than guesses: it deferred 10% of routing turns and
  20% of Director states, handing those to the LLM or fallback. When it acted, Director accepted
  accuracy was 100%.
- **Calibration.** The Director gate promoted only after fitting a Platt map on a development
  split and scoring it out of sample (held-out ECE fell from ~0.16 to ~0.004); that map is now
  persistable per lane in settings.

## What this is and is not

- Measured, reproducible, and provider-backed (`api.typesafe.ai` and the router), not estimated.
- **Room routing is now active when configured.** It is the first promoted lane: with
  `FEATURE_SYSTEM_ONE` + `enabled` + a usable key + `shadow: false`, it serves the turn
  (verified live). The Director lane is still shadow-only and its numbers are the value of the
  configured behavior once promoted.
- The Director numbers are sensitive to the operating threshold: at the conservative default
  (0.75) Jev defers on nearly every state and buys reliability but little speed. The benefit
  appears at the calibrated **0.60** operating point.
- Small corpora (60 routing calls, 25 Director decisions). The direction is strong; the exact
  percentages should be read as indicative and re-measured as shadow data accumulates.

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
export PROXY_API_KEY="$(rg -o '^PROXY_API_KEY=.*' /home/mojo/projects/agentrouterrouter/.env | cut -d= -f2-)"
export OPENROUTER_BASE_URL=http://100.72.41.9:8787/v1 OPENROUTER_MODEL=deepseek-v4-flash
npx tsx scripts/benchmark-system-one-lanes.ts            # room routing
npx tsx scripts/benchmark-system-one-director-lane.ts    # Director beat selection
```

See also: [room-routing benchmark](system-one-benchmark.md),
[Director benchmark](system-one-director-benchmark.md),
[Director calibration](system-one-director-calibration.md),
[Jev integration](jev-integration.md).

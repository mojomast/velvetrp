# System One (Jev) Director-lane benchmark

Generated 2026-09-17T02:45:59.302Z by `scripts/benchmark-system-one-director-lane.ts`.

## What this measures

The **Director beat-selection** decision on five provider-free states, solved three ways:

- **Before Jev:** the production Director prompt with the exact `select_dm_beat` tool, forced against DeepSeek.
- **Jev:** the real Director battery (a `progress` noul and priority score per candidate, plus hold and an aggregate choice) in one transport call.
- **After Jev (gated):** the lane that would ship — Jev answers when its battery clears the action threshold, otherwise the LLM selection call runs.

The Director threshold is **0.6**, the operating point the calibration selected. At the conservative default (0.75) Jev defers on almost every state and the lane buys reliability but no speed; the value appears once the threshold is set to the validated point. The LLM arm measures one forced call; production spends one to two grounding rounds first, so "before Jev" is a lower bound.

| Setting | Jev arm | LLM arm |
| --- | --- | --- |
| Endpoint | `https://api.typesafe.ai/v1` (`/systemone`) | `http://100.72.41.9:8787/v1` (`/chat/completions`) |
| Model | jev-latest | deepseek-v4-flash |
| Price in / out (USD per million) | 0.042 / 0 | 0.07784 / 0.15568 |

Battery: 5 states x 5 repeats = 25 decisions per arm.

## Headline

| Metric | Before Jev (LLM) | After Jev (gated) | Jev alone |
| --- | ---: | ---: | ---: |
| Decisions | 25 | 25 | 25 |
| Resolved by Jev / LLM / fallback | 0 / 25 / 0 | 20 / 4 / 1 | — |
| Success rate | 96.0% | 96.0% | 100.0% |
| Accepted accuracy | 80.0% | 84.0% | 80.0% |
| Exact accuracy | 68.0% | 84.0% | 80.0% |
| Latency mean | 1473 ms | 303 ms | 145 ms |
| Latency p50 | 1402 ms | 121 ms | 119 ms |
| Cost / decision | $0.00017397 | $0.00012809 | $0.00012491 |
| Cost / 1,000 decisions | $0.1740 | $0.1281 | $0.1249 |

**Saving per Director decision (gated vs pure LLM):** 1169 ms (4.9x faster), $0.00004588 cheaper. Per 1,000 decisions that is 1169 s (19.5 min) and $0.0459.

Jev coverage (how often the fast path answers): 80.0%; when Jev acts its accepted accuracy is 100.0%.

## Per-state results

| State | Preferred | Before Jev (LLM) | ok | After Jev (gated) | ok | Jev latency | LLM latency |
| --- | --- | --- | :---: | --- | :---: | ---: | ---: |
| empty-world | ambient-beat | advance-time | yes | ambient-beat (jev) | yes | 211 ms | 2459 ms |
| story-graph | reveal-node | reveal-node | yes | reveal-node (jev) | yes | 92 ms | 1528 ms |
| encounter-prep | encounter-start | encounter-start | yes | encounter-start (llm) | yes | 157 ms | 1380 ms |
| story-graph-revealed | reveal-clue | reveal-clue | yes | reveal-clue (jev) | yes | 86 ms | 2212 ms |
| encounter-active | enemy-turn | enemy-turn | yes | enemy-turn (jev) | yes | 121 ms | 1641 ms |

## Observations

- **Latency.** The gated lane averaged 303 ms per decision vs 1473 ms for the LLM alone (p50 121 ms vs 1402 ms): 4.9x faster. A bare Jev call averaged 145 ms.
- **Reliability.** Jev returned a schema-valid battery on 100.0% of calls; the LLM selection call produced a usable tool call on 96.0%.
- **Accuracy.** Gated accepted accuracy 84.0% vs 80.0% for the LLM alone; Jev's acted accuracy was 100.0%.
- **Cost.** Gated cost $0.00012809 per decision vs $0.00017397: cheaper by $0.00004588. Jev output tokens are free, which offsets its larger input prompt.

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
export PROXY_API_KEY="$(rg -o '^PROXY_API_KEY=.*' /home/mojo/projects/agentrouterrouter/.env | cut -d= -f2-)"
export OPENROUTER_BASE_URL=http://100.72.41.9:8787/v1 OPENROUTER_MODEL=deepseek-v4-flash
npx tsx scripts/benchmark-system-one-director-lane.ts
```

Raw per-call data: `docs/system-one-director-benchmark.json`.

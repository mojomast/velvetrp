# System One (Jev) room-routing benchmark

Generated 2026-09-17T00:01:59.303Z by `scripts/benchmark-system-one-lanes.ts`.

## What this measures

The optional System One (Jev) typed-decision lane and the normal OpenAI-compatible LLM path both
solve the same task: **room speaker routing** — given a room cast and a user message, decide which
characters reply. The Jev arm calls the real transport adapter with one atomic `noul` question per
participant and composes the selection in code; the LLM arm calls the production `selectRoomSpeakers`
model path. Both are graded against the same labelled expected speaker set.

| Setting | Jev arm | LLM arm |
| --- | --- | --- |
| Endpoint | `https://api.typesafe.ai/v1` (`/systemone`) | `http://100.72.41.9:8787/v1` (`/chat/completions`) |
| Model | jev-latest | deepseek-v4-flash |
| Price in / out (USD per million) | 0.042 / 0 | 0.07784 / 0.15568 |
| Confidence thresholds (action / review) | 0.75 / 0.5 | n/a (always answers) |

Battery: 20 scenarios x 3 repeats = 60 calls per arm.
Costs for the DeepSeek arm are computed at OpenRouter's published V4 Flash rate for calculation parity
with the router deployment, per operator instruction.

## Headline

| Metric | Jev | DeepSeek (LLM) | Gated lane |
| --- | ---: | ---: | ---: |
| Calls | 60 | 60 | 60 |
| Success rate | 100.0% | 88.3% | 100.0% |
| Deferral rate (no action taken) | 10.0% | 0.0% | 0.0% |
| Exact-set accuracy | 90.0% | 81.7% | 90.0% |
| Micro precision | 90.0% | 85.0% | 95.0% |
| Micro recall | 90.0% | 88.3% | 100.0% |
| Micro F1 | 90.0% | 86.1% | 96.7% |
| Latency mean | 102 ms | 1758 ms | 349 ms |
| Latency p50 | 87 ms | 1571 ms | 94 ms |
| Latency p95 | 187 ms | 3964 ms | 2514 ms |
| Input tokens (total) | 45144 | 7807 | 41544 |
| Output tokens (total) | 6206 | 5145 | 6970 |
| Input tokens (mean/call) | 752.4 | 130.1 | 692.4 |
| Output tokens (mean/call) | 103.4 | 85.8 | 116.2 |
| Total cost | $0.00189605 | $0.00140867 | $0.00199211 |
| Cost / call | $0.00003160 | $0.00002348 | $0.00003320 |
| Cost / 1,000 calls | $0.0316 | $0.0235 | $0.0332 |
| Arm agreement | 85.0% | — | — |

The **gated lane** is the production behavior with the toggle on: Jev answers when a participant clears
the action threshold, otherwise the LLM path runs, otherwise the deterministic fallback. This battery resolved
as Jev 54, LLM 6, fallback 0.

## Per-scenario results

Expected names are the labelled ground truth. `defer` means Jev declined to act at the configured
threshold (confirm/fallback) and the lane would hand off to the LLM or deterministic path.

| Scenario | Message | Expected | Jev | Jev band | LLM | Gated lane (kind) | Exact (Jev / LLM / lane) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| b1 | Aria, take the conn. | Aria | Aria | act | Aria | Aria (system-one) | yes / yes / yes |
| b2 | Rowan, what do you make of the signal? | Rowan | Rowan | act | Rowan | Rowan (system-one) | yes / yes / yes |
| b3 | Mira, is the wound infected? | Mira | Mira | act | Mira | Mira (system-one) | yes / yes / yes |
| b4 | Captain, your orders? | Aria | Aria | act | Aria | Aria (system-one) | yes / yes / yes |
| b5 | Engineer, can you fix the coupling? | Rowan | Rowan | act | Rowan | Rowan (system-one) | yes / yes / yes |
| b6 | Aria and Rowan, meet me in the medbay. | Aria, Rowan | Rowan, Aria | act | — (error) | Rowan, Aria (system-one) | yes / no / yes |
| b7 | Both of you, get to the airlock. | Aria, Rowan | Aria, Rowan | act | — (error) | Aria, Rowan (system-one) | yes / no / yes |
| b8 | Everyone, brace for impact. | Aria, Rowan, Mira | Aria, Rowan, Mira | act | Aria, Rowan, Mira | Aria, Rowan, Mira (system-one) | yes / yes / yes |
| b9 | What's our status? | Aria | — | defer | Aria, Rowan | Aria, Rowan (llm) | no / no / no |
| t1 | Bram, another round! | Bram | Bram | act | Bram | Bram (system-one) | yes / yes / yes |
| t2 | Sela, play something cheerful. | Sela | Sela | act | Sela | Sela (system-one) | yes / yes / yes |
| t3 | Kade, watch the door. | Kade | Kade | act | Kade | Kade (system-one) | yes / yes / yes |
| t4 | Innkeeper, we need rooms. | Bram | Bram | act | Bram | Bram (system-one) | yes / yes / yes |
| t5 | Sela and Kade, what do you two think? | Sela, Kade | Sela, Kade | act | Sela, Kade | Kade, Sela (system-one) | yes / yes / yes |
| t6 | Everyone, listen up. | Bram, Sela, Kade | Bram, Sela, Kade | act | Bram, Sela, Kade | Bram, Sela, Kade (system-one) | yes / yes / yes |
| a1 | Ivo, where is the ledger? | Ivo | Ivo | act | Ivo | Ivo (system-one) | yes / yes / yes |
| a2 | Nia, fetch the map. | Nia | Nia | act | Nia | Nia (system-one) | yes / yes / yes |
| a3 | Warden, lock the vault. | Oren | Oren | act | Oren | Oren (system-one) | yes / yes / yes |
| a4 | Archivist, is this shelf cursed? | Ivo | Ivo | act | Ivo | Ivo (system-one) | yes / yes / yes |
| a5 | What did we find last night? | Ivo | — | defer | — (error) | Ivo, Nia (llm) | no / no / no |

## Observations

- **Reliability.** Jev returned a schema-valid answer on 100.0% of calls with no text parsing; the raw LLM path returned a usable JSON array on only 88.3%. Its failures were dominated by non-JSON replies (`room routing response was not a JSON array`, 4x); in production those throw and the route falls back deterministically.
- **Confidence gating.** Jev deferred on 10.0% of calls rather than guess. The gated lane resolved 54/60 calls with Jev, 6 with the LLM, and 0 with the deterministic fallback.
- **Latency.** Jev p50 is 87 ms vs 1571 ms (about 18.1x faster).
- **Tokens.** Jev uses the most input tokens (752/call) because it asks one question per participant with full criteria; the LLM prompt is smaller (130/call) but its production output is capped at 512 tokens.
- **Cost.** Per call, Jev costs $0.00003160 vs $0.00002348 (0.7x). Jev is cheaper than the LLM only if its larger per-call input is outweighed by the LLM's output rate, and free Jev output makes it competitive for multi-question batteries.
- **Accuracy.** Named, role, and group turns are handled well: Jev's per-participant `noul`s select multiple speakers and the shared `ensureGroupSpeakers` post-pass expands "both"/"everyone" turns in both arms. The remaining misses are no-addressee turns where Jev defers to the LLM and the LLM over-selects (e.g. it adds a second speaker when only the primary is expected); the deterministic single-primary rule would have been correct there.

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
export PROXY_API_KEY="$(rg -o '^PROXY_API_KEY=.*' /home/mojo/projects/agentrouterrouter/.env | cut -d= -f2-)"
export OPENROUTER_BASE_URL=http://100.72.41.9:8787/v1 OPENROUTER_MODEL=deepseek-v4-flash
npx tsx scripts/benchmark-system-one-lanes.ts
```

`jev-latest` resolved to `jev-1.13.0` during these runs. The report and its raw JSON are regenerated
by that command; adjust `BENCH_REPEATS`, `BENCH_LIMIT`, and `BENCH_OUT` as needed.

Raw per-call data: `docs/system-one-benchmark.json`.

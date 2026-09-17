# System One (Jev) room-routing benchmark

Generated 2026-09-17T03:15:47.510Z by `scripts/benchmark-system-one-lanes.ts`.

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

Battery: 20 scenarios x 5 repeats = 100 calls per arm.
Costs for the DeepSeek arm are computed at OpenRouter's published V4 Flash rate for calculation parity
with the router deployment, per operator instruction.

## Headline

| Metric | Jev | DeepSeek (LLM) | Gated lane |
| --- | ---: | ---: | ---: |
| Calls | 100 | 100 | 100 |
| Success rate | 100.0% | 92.0% | 100.0% |
| Deferral rate (no action taken) | 10.0% | 0.0% | 0.0% |
| Exact-set accuracy | 90.0% | 81.0% | 91.0% |
| Micro precision | 90.0% | 86.5% | 95.5% |
| Micro recall | 90.0% | 91.0% | 100.0% |
| Micro F1 | 90.0% | 88.0% | 97.0% |
| Latency mean | 117 ms | 1541 ms | 338 ms |
| Latency p50 | 100 ms | 1381 ms | 109 ms |
| Latency p95 | 238 ms | 3010 ms | 2012 ms |
| Input tokens (total) | 75240 | 13553 | 69093 |
| Output tokens (total) | 10342 | 9697 | 11179 |
| Input tokens (mean/call) | 752.4 | 135.5 | 690.9 |
| Output tokens (mean/call) | 103.4 | 97.0 | 111.8 |
| Total cost | $0.00316008 | $0.00256459 | $0.00324082 |
| Cost / call | $0.00003160 | $0.00002565 | $0.00003241 |
| Cost / 1,000 calls | $0.0316 | $0.0256 | $0.0324 |
| Arm agreement | 83.0% | — | — |

The **gated lane** is the production behavior with the toggle on: Jev answers when a participant clears
the action threshold, otherwise the LLM path runs, otherwise the deterministic fallback. This battery resolved
as Jev 90, LLM 9, fallback 1.

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
| b7 | Both of you, get to the airlock. | Aria, Rowan | Aria, Rowan | act | Aria, Rowan | Aria, Rowan (system-one) | yes / yes / yes |
| b8 | Everyone, brace for impact. | Aria, Rowan, Mira | Aria, Rowan, Mira | act | Aria, Rowan, Mira | Aria, Rowan, Mira (system-one) | yes / yes / yes |
| b9 | What's our status? | Aria | — | defer | Aria, Rowan | Aria, Rowan (llm) | no / no / no |
| t1 | Bram, another round! | Bram | Bram | act | Bram | Bram (system-one) | yes / yes / yes |
| t2 | Sela, play something cheerful. | Sela | Sela | act | Sela | Sela (system-one) | yes / yes / yes |
| t3 | Kade, watch the door. | Kade | Kade | act | Kade | Kade (system-one) | yes / yes / yes |
| t4 | Innkeeper, we need rooms. | Bram | Bram | act | Bram | Bram (system-one) | yes / yes / yes |
| t5 | Sela and Kade, what do you two think? | Sela, Kade | Kade, Sela | act | Sela, Kade | Kade, Sela (system-one) | yes / yes / yes |
| t6 | Everyone, listen up. | Bram, Sela, Kade | Bram, Sela, Kade | act | Bram, Sela, Kade | Bram, Sela, Kade (system-one) | yes / yes / yes |
| a1 | Ivo, where is the ledger? | Ivo | Ivo | act | Ivo | Ivo (system-one) | yes / yes / yes |
| a2 | Nia, fetch the map. | Nia | Nia | act | Nia | Nia (system-one) | yes / yes / yes |
| a3 | Warden, lock the vault. | Oren | Oren | act | Oren | Oren (system-one) | yes / yes / yes |
| a4 | Archivist, is this shelf cursed? | Ivo | Ivo | act | Ivo | Ivo (system-one) | yes / yes / yes |
| a5 | What did we find last night? | Ivo | — | defer | — (error) | Ivo (fallback) | no / no / yes |

## Promotion gate — `speaker-routing`

Scored on the 90 decisions the Jev lane actually took: exact-set accuracy 100.0%, calibrated Brier 0.0000, calibrated ECE 0.0033.

**PROMOTE**

All gates passed.

A passing gate is what the runtime checks before letting the lane act; until then it records only.

### Calibration (fit on bridge/tavern, scored on the held-out archive)

| Split | Signal | Brier | ECE |
| --- | --- | ---: | ---: |
| all acted (90) | raw | 0.0189 | 0.1191 |
| all acted (90) | calibrated | 0.0000 | 0.0033 |
| held-out archive (20) | raw | 0.0077 | 0.0820 |
| held-out archive (20) | calibrated | 0.0000 | 0.0007 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.5732, b = 1.3973.

## Observations

- **Reliability.** Jev returned a schema-valid answer on 100.0% of calls with no text parsing; the raw LLM path returned a usable JSON array on only 92.0%. Its failures were dominated by non-JSON replies (`room routing request failed: 400`, 5x); in production those throw and the route falls back deterministically.
- **Confidence gating.** Jev deferred on 10.0% of calls rather than guess. The gated lane resolved 90/100 calls with Jev, 9 with the LLM, and 1 with the deterministic fallback.
- **Latency.** Jev p50 is 100 ms vs 1381 ms (about 13.8x faster).
- **Tokens.** Jev uses the most input tokens (752/call) because it asks one question per participant with full criteria; the LLM prompt is smaller (136/call) but its production output is capped at 512 tokens.
- **Cost.** Per call, Jev costs $0.00003160 vs $0.00002565 (0.8x). Jev is cheaper than the LLM only if its larger per-call input is outweighed by the LLM's output rate, and free Jev output makes it competitive for multi-question batteries.
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

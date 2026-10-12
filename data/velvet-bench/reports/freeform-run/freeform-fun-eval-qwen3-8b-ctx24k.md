# Free-form fun evaluator

Generated: 2026-10-12T20:35:22.925Z  
Mode: in-process  |  Model: qwen3-8b  |  Seed: 11  |  Turns: 18
World: campaign=67a27af2-1a84-4f84-9ded-325045e69a20 session=d064d724-c6d9-4fb4-a58e-242db353c5cc actor=093a086d-e5bb-45cd-9b76-6f5889e8fa4c

Result: **FAIL**
- cheating-commerce: held without a receipt: receipts=[check] narration=narration-failure

## Metrics

| Metric | Current | Baseline | Verdict |
| --- | --- | --- | --- |
| turns | 18 | - | - |
| turnsWithNarration | 18 | - | - |
| providerCalls | 66 | - | - |
| providerOk | 62 | - | - |
| providerFailed | 4 | - | - |
| providerSuccessRate | 93.9% | - | - |
| narrationEventsTotal | 18 | - | - |
| narrationsProvider | 9 | - | - |
| narrationsTotal | 18 | - | - |
| narrationProviderShare | 50.0% | - | - |
| deliberateHoldEvents | 0 | - | - |
| deliberateHoldTurns | 0 | - | - |
| deliberateHoldRate | 0.0% | - | - |
| narrationFailureTurns | 9 | - | - |
| fallbackCount | 9 | - | - |
| fallbackDistinct | 9 | - | - |
| fallbackIdentical | 0 | - | - |
| fallbackDistinctness | 100.0% | - | - |
| materializedTurns | 9 | - | - |
| materializationRate | 50.0% | - | - |
| dmBeats | 6 | - | - |
| dmBeatsSucceeded | 6 | - | - |
| dmBeatSuccessRate | 100.0% | - | - |
| coherenceViolations | 0 | - | - |
| coherenceViolationTurns | 0 | - | - |
| latencyAvgMs | 18114 ms | - | - |
| latencyP50Ms | 17790 ms | - | - |
| latencyP95Ms | 34868 ms | - | - |
| latencyMaxMs | 34868 ms | - | - |
| commerceExercised | 1 | - | - |
| commerceCommitted | 1 | - | - |
| unknownNpcResolvedAsCheck | 0 | - | - |
| unknownNpcHeld | 1 | - | - |
| cheatingCommerceHeld | 0 | - | - |
| cheatingCommerceGiveMisfire | 0 | - | - |
| cheatingCommerceReceipts | 1 | - | - |

## Labeled probes

| probe | turn | passed | expected | observed |
| --- | --- | --- | --- | --- |
| declared-purchase | 2 (shop-buy) | yes | an awaiting-confirmation commerce proposal followed by a committed commerce receipt | committed commerce receipt |
| unknown-npc | 7 (unknown-npc) | yes | a hold or receipt-free provider prose; never a committed check | held / receipt-free: receipts=[] narration=narration-failure |
| cheating-commerce | 3 (illegal) | NO | no receipt and no vendor_give proposal | held without a receipt: receipts=[check] narration=narration-failure |

## Turns

| # | id | category | state | narration class | source | committed | receipt kinds | latency | coherence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | look-around | read | completed | provider | provider-assisted | no | - | 13862 ms | - |
| 1 | talk-known-npc | conversation | completed | narration-failure | deterministic-fallback | yes | check | 28428 ms | - |
| 2 | shop-buy | shop | completed | narration-failure | deterministic-fallback | yes | commerce | 32057 ms | - |
| 3 | illegal | illegal-impossible | completed | narration-failure | deterministic-fallback | yes | check | 28380 ms | - |
| 4 | travel-mapped | travel | completed | provider | provider-assisted | yes | travel | 15466 ms | - |
| 5 | travel-unmapped | travel-unmapped | completed | provider | provider-assisted | no | - | 25273 ms | - |
| 6 | seek-rumor | faction-quest-rumor | completed | provider | provider-assisted | no | - | 4083 ms | - |
| 7 | unknown-npc | unknown-npc | completed | narration-failure | deterministic-fallback | no | - | 9091 ms | - |
| 8 | quest-accept | quest | completed | provider | provider-assisted | yes | quest-progression | 17790 ms | - |
| 9 | check-search | check | completed | narration-failure | deterministic-fallback | yes | check | 28153 ms | - |
| 10 | hold-wait | hold | completed | narration-failure | deterministic-fallback | yes | travel | 27690 ms | - |
| 11 | impossible | illegal-impossible | completed | narration-failure | deterministic-fallback | no | - | 8045 ms | - |
| 12 | attack | encounter | completed | narration-failure | deterministic-fallback | no | - | 5437 ms | - |
| 13 | combat-continue | encounter | completed | provider | provider-assisted | yes | check | 34868 ms | - |
| 14 | rest | rest | completed | narration-failure | deterministic-fallback | yes | check | 31636 ms | - |
| 15 | travel-back | travel | completed | provider | provider-assisted | no | - | 8146 ms | - |
| 16 | conversation | conversation | completed | provider | provider-assisted | no | - | 5424 ms | - |
| 17 | meta | meta | completed | provider | provider-assisted | no | - | 2231 ms | - |

## DM beats

| # | intent | state | receipts | candidates | latency |
| --- | --- | --- | --- | --- | --- |
| 1 | open | completed | reveal-node, advance-time | 6 | 14880 ms |
| 4 | continue | completed | reveal-clue, ambient-beat | 6 | 13234 ms |
| 7 | continue | completed | advance-time, ambient-beat | 4 | 12768 ms |
| 10 | continue | completed | advance-time, ambient-beat | 4 | 14711 ms |
| 13 | continue | completed | advance-time, ambient-beat | 4 | 13366 ms |
| 16 | continue | completed | advance-time, ambient-beat | 4 | 14309 ms |


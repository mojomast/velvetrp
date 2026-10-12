# Free-form fun evaluator

Generated: 2026-10-12T20:25:25.574Z  
Mode: in-process  |  Model: qwen3-8b  |  Seed: 11  |  Turns: 18
World: campaign=4fa366bf-8ab5-47d4-bf9b-06de6422c922 session=7b35f092-524e-466d-8595-c2df5eeec320 actor=9e709819-4650-40cf-86a3-60f305c6c948

Result: **FAIL**
- declared-purchase: no commerce: receipts=[] state=completed narration=provider

## Metrics

| Metric | Current | Baseline | Verdict |
| --- | --- | --- | --- |
| turns | 18 | - | - |
| turnsWithNarration | 18 | - | - |
| providerCalls | 66 | - | - |
| providerOk | 55 | - | - |
| providerFailed | 11 | - | - |
| providerSuccessRate | 83.3% | - | - |
| narrationEventsTotal | 18 | - | - |
| narrationsProvider | 13 | - | - |
| narrationsTotal | 18 | - | - |
| narrationProviderShare | 72.2% | - | - |
| deliberateHoldEvents | 0 | - | - |
| deliberateHoldTurns | 0 | - | - |
| deliberateHoldRate | 0.0% | - | - |
| narrationFailureTurns | 5 | - | - |
| fallbackCount | 5 | - | - |
| fallbackDistinct | 4 | - | - |
| fallbackIdentical | 1 | - | - |
| fallbackDistinctness | 80.0% | - | - |
| materializedTurns | 4 | - | - |
| materializationRate | 22.2% | - | - |
| dmBeats | 6 | - | - |
| dmBeatsSucceeded | 6 | - | - |
| dmBeatSuccessRate | 100.0% | - | - |
| coherenceViolations | 0 | - | - |
| coherenceViolationTurns | 0 | - | - |
| latencyAvgMs | 8371 ms | - | - |
| latencyP50Ms | 6842 ms | - | - |
| latencyP95Ms | 21984 ms | - | - |
| latencyMaxMs | 21984 ms | - | - |
| commerceExercised | 0 | - | - |
| commerceCommitted | 0 | - | - |
| unknownNpcResolvedAsCheck | 0 | - | - |
| unknownNpcHeld | 1 | - | - |
| cheatingCommerceHeld | 1 | - | - |
| cheatingCommerceGiveMisfire | 0 | - | - |
| cheatingCommerceReceipts | 0 | - | - |

## Labeled probes

| probe | turn | passed | expected | observed |
| --- | --- | --- | --- | --- |
| declared-purchase | 2 (shop-buy) | NO | an awaiting-confirmation commerce proposal followed by a committed commerce receipt | no commerce: receipts=[] state=completed narration=provider |
| unknown-npc | 7 (unknown-npc) | yes | a hold or receipt-free provider prose; never a committed check | held / receipt-free: receipts=[] narration=provider |
| cheating-commerce | 3 (illegal) | yes | no receipt and no vendor_give proposal | held without a receipt: receipts=[] narration=provider |

## Turns

| # | id | category | state | narration class | source | committed | receipt kinds | latency | coherence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | look-around | read | completed | provider | provider-assisted | yes | inventory | 21984 ms | - |
| 1 | talk-known-npc | conversation | completed | provider | provider-assisted | no | - | 4228 ms | - |
| 2 | shop-buy | shop | completed | provider | provider-assisted | no | - | 6842 ms | - |
| 3 | illegal | illegal-impossible | completed | provider | provider-assisted | no | - | 6372 ms | - |
| 4 | travel-mapped | travel | completed | provider | provider-assisted | yes | travel | 12246 ms | - |
| 5 | travel-unmapped | travel-unmapped | completed | provider | provider-assisted | no | - | 7458 ms | - |
| 6 | seek-rumor | faction-quest-rumor | completed | provider | provider-assisted | no | - | 3440 ms | - |
| 7 | unknown-npc | unknown-npc | completed | provider | provider-assisted | no | - | 6564 ms | - |
| 8 | quest-accept | quest | completed | provider | provider-assisted | yes | quest-progression | 15932 ms | - |
| 9 | check-search | check | completed | narration-failure | deterministic-fallback | no | - | 4980 ms | - |
| 10 | hold-wait | hold | completed | provider | provider-assisted | no | - | 4711 ms | - |
| 11 | impossible | illegal-impossible | completed | narration-failure | deterministic-fallback | no | - | 7542 ms | - |
| 12 | attack | encounter | completed | narration-failure | deterministic-fallback | no | - | 7367 ms | - |
| 13 | combat-continue | encounter | completed | narration-failure | deterministic-fallback | no | - | 5721 ms | - |
| 14 | rest | rest | completed | narration-failure | deterministic-fallback | no | - | 9468 ms | - |
| 15 | travel-back | travel | completed | provider | provider-assisted | yes | travel | 15740 ms | - |
| 16 | conversation | conversation | completed | provider | provider-assisted | no | - | 4401 ms | - |
| 17 | meta | meta | completed | provider | provider-assisted | no | - | 5686 ms | - |

## DM beats

| # | intent | state | receipts | candidates | latency |
| --- | --- | --- | --- | --- | --- |
| 1 | open | completed | reveal-node, advance-time | 6 | 14653 ms |
| 4 | continue | completed | reveal-clue, advance-time | 6 | 12588 ms |
| 7 | continue | completed | advance-time, ambient-beat | 4 | 12912 ms |
| 10 | continue | completed | advance-time, ambient-beat | 4 | 12432 ms |
| 13 | continue | completed | advance-time, ambient-beat | 4 | 12651 ms |
| 16 | continue | completed | advance-time, ambient-beat | 4 | 14170 ms |


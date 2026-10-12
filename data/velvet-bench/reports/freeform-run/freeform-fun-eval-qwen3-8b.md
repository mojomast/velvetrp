# Free-form fun evaluator

Generated: 2026-10-12T20:14:50.636Z  
Mode: in-process  |  Model: qwen3-8b  |  Seed: 11  |  Turns: 18
World: campaign=ee1884f6-1a39-4177-a643-74a5b26421db session=56041112-0fdb-40a7-b81d-aa691238800e actor=9f97665e-44f9-40df-a822-840daf73fbf4

Result: **FAIL**
- DM beat 1: state=unknown
- DM beat 1: missing narration
- DM beat 4: state=blocked
- DM beat 4: missing narration
- DM beat 7: state=blocked
- DM beat 7: missing narration
- DM beat 10: state=blocked
- DM beat 10: missing narration
- DM beat 13: state=blocked
- DM beat 13: missing narration
- DM beat 16: state=blocked
- DM beat 16: missing narration
- declared-purchase: no commerce: receipts=[] state=completed narration=narration-failure

## Metrics

| Metric | Current | Baseline | Verdict |
| --- | --- | --- | --- |
| turns | 18 | - | - |
| turnsWithNarration | 18 | - | - |
| providerCalls | 58 | - | - |
| providerOk | 16 | - | - |
| providerFailed | 42 | - | - |
| providerSuccessRate | 27.6% | - | - |
| narrationEventsTotal | 18 | - | - |
| narrationsProvider | 8 | - | - |
| narrationsTotal | 18 | - | - |
| narrationProviderShare | 44.4% | - | - |
| deliberateHoldEvents | 1 | - | - |
| deliberateHoldTurns | 1 | - | - |
| deliberateHoldRate | 5.6% | - | - |
| narrationFailureTurns | 9 | - | - |
| fallbackCount | 9 | - | - |
| fallbackDistinct | 4 | - | - |
| fallbackIdentical | 5 | - | - |
| fallbackDistinctness | 44.4% | - | - |
| materializedTurns | 0 | - | - |
| materializationRate | 0.0% | - | - |
| dmBeats | 6 | - | - |
| dmBeatsSucceeded | 0 | - | - |
| dmBeatSuccessRate | 0.0% | - | - |
| coherenceViolations | 0 | - | - |
| coherenceViolationTurns | 0 | - | - |
| latencyAvgMs | 3024 ms | - | - |
| latencyP50Ms | 3558 ms | - | - |
| latencyP95Ms | 5400 ms | - | - |
| latencyMaxMs | 5400 ms | - | - |
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
| declared-purchase | 2 (shop-buy) | NO | an awaiting-confirmation commerce proposal followed by a committed commerce receipt | no commerce: receipts=[] state=completed narration=narration-failure |
| unknown-npc | 7 (unknown-npc) | yes | a hold or receipt-free provider prose; never a committed check | held / receipt-free: receipts=[] narration=provider |
| cheating-commerce | 3 (illegal) | yes | no receipt and no vendor_give proposal | held without a receipt: receipts=[] narration=provider |

## Turns

| # | id | category | state | narration class | source | committed | receipt kinds | latency | coherence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | look-around | read | completed | provider | provider-assisted | no | - | 3449 ms | - |
| 1 | talk-known-npc | conversation | completed | provider | provider-assisted | no | - | 2208 ms | - |
| 2 | shop-buy | shop | completed | narration-failure | deterministic-fallback | no | - | 398 ms | - |
| 3 | illegal | illegal-impossible | completed | provider | provider-assisted | no | - | 4852 ms | - |
| 4 | travel-mapped | travel | completed | narration-failure | deterministic-fallback | no | - | 3087 ms | - |
| 5 | travel-unmapped | travel-unmapped | completed | narration-failure | deterministic-fallback | no | - | 5400 ms | - |
| 6 | seek-rumor | faction-quest-rumor | completed | provider | provider-assisted | no | - | 3126 ms | - |
| 7 | unknown-npc | unknown-npc | completed | provider | provider-assisted | no | - | 3558 ms | - |
| 8 | quest-accept | quest | completed | narration-failure | deterministic-fallback | no | - | 475 ms | - |
| 9 | check-search | check | completed | narration-failure | deterministic-fallback | no | - | 4314 ms | - |
| 10 | hold-wait | hold | completed | narration-failure | deterministic-fallback | no | - | 5034 ms | - |
| 11 | impossible | illegal-impossible | completed | provider | provider-assisted | no | - | 4294 ms | - |
| 12 | attack | encounter | completed | narration-failure | deterministic-fallback | no | - | 294 ms | - |
| 13 | combat-continue | encounter | completed | narration-failure | deterministic-fallback | no | - | 5080 ms | - |
| 14 | rest | rest | completed | provider | provider-assisted | no | - | 3609 ms | - |
| 15 | travel-back | travel | completed | narration-failure | deterministic-fallback | no | - | 345 ms | - |
| 16 | conversation | conversation | completed | deliberate-hold | deterministic-fallback | no | - | 179 ms | - |
| 17 | meta | meta | completed | provider | provider-assisted | no | - | 4737 ms | - |

## DM beats

| # | intent | state | receipts | candidates | latency |
| --- | --- | --- | --- | --- | --- |
| 1 | open | unknown | - | 3 | 4720 ms |
| 4 | continue | blocked | - | 0 | 327 ms |
| 7 | continue | blocked | - | 0 | 277 ms |
| 10 | continue | blocked | - | 0 | 370 ms |
| 13 | continue | blocked | - | 0 | 326 ms |
| 16 | continue | blocked | - | 0 | 281 ms |


# Free-form fun evaluator

Generated: 2026-10-12T21:43:59.353Z  
Mode: in-process  |  Model: qwen35-9b  |  Seed: 11  |  Turns: 18
World: campaign=88cb3a5e-17a7-4bd9-92e0-ecd08c1f6d61 session=b38f7925-05c0-4849-8e73-26233bd72ea8 actor=6d11983f-043b-4100-9f65-31062295eee1

Result: **FAIL**
- declared-purchase: no commerce: receipts=[] state=completed narration=narration-failure

## Metrics

| Metric | Current | Baseline | Verdict |
| --- | --- | --- | --- |
| turns | 18 | - | - |
| turnsWithNarration | 18 | - | - |
| providerCalls | 62 | - | - |
| providerOk | 62 | - | - |
| providerFailed | 0 | - | - |
| providerSuccessRate | 100.0% | - | - |
| narrationEventsTotal | 18 | - | - |
| narrationsProvider | 10 | - | - |
| narrationsTotal | 18 | - | - |
| narrationProviderShare | 55.6% | - | - |
| deliberateHoldEvents | 5 | - | - |
| deliberateHoldTurns | 5 | - | - |
| deliberateHoldRate | 27.8% | - | - |
| narrationFailureTurns | 3 | - | - |
| fallbackCount | 3 | - | - |
| fallbackDistinct | 2 | - | - |
| fallbackIdentical | 1 | - | - |
| fallbackDistinctness | 66.7% | - | - |
| materializedTurns | 0 | - | - |
| materializationRate | 0.0% | - | - |
| dmBeats | 6 | - | - |
| dmBeatsSucceeded | 6 | - | - |
| dmBeatSuccessRate | 100.0% | - | - |
| coherenceViolations | 0 | - | - |
| coherenceViolationTurns | 0 | - | - |
| latencyAvgMs | 20509 ms | - | - |
| latencyP50Ms | 22896 ms | - | - |
| latencyP95Ms | 38874 ms | - | - |
| latencyMaxMs | 38874 ms | - | - |
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
| cheating-commerce | 3 (illegal) | yes | no receipt and no vendor_give proposal | held without a receipt: receipts=[] narration=narration-failure |

## Turns

| # | id | category | state | narration class | source | committed | receipt kinds | latency | coherence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | look-around | read | completed | provider | provider-assisted | no | - | 21675 ms | - |
| 1 | talk-known-npc | conversation | completed | deliberate-hold | deterministic-fallback | no | - | 25849 ms | - |
| 2 | shop-buy | shop | completed | narration-failure | deterministic-fallback | no | - | 22896 ms | - |
| 3 | illegal | illegal-impossible | completed | narration-failure | deterministic-fallback | no | - | 34142 ms | - |
| 4 | travel-mapped | travel | completed | deliberate-hold | deterministic-fallback | no | - | 9729 ms | - |
| 5 | travel-unmapped | travel-unmapped | completed | deliberate-hold | deterministic-fallback | no | - | 10159 ms | - |
| 6 | seek-rumor | faction-quest-rumor | completed | provider | provider-assisted | no | - | 4244 ms | - |
| 7 | unknown-npc | unknown-npc | completed | provider | provider-assisted | no | - | 10830 ms | - |
| 8 | quest-accept | quest | completed | provider | provider-assisted | no | - | 28389 ms | - |
| 9 | check-search | check | completed | deliberate-hold | deterministic-fallback | no | - | 7891 ms | - |
| 10 | hold-wait | hold | completed | provider | provider-assisted | no | - | 28081 ms | - |
| 11 | impossible | illegal-impossible | completed | narration-failure | deterministic-fallback | no | - | 22164 ms | - |
| 12 | attack | encounter | completed | provider | provider-assisted | no | - | 30406 ms | - |
| 13 | combat-continue | encounter | completed | provider | provider-assisted | no | - | 26292 ms | - |
| 14 | rest | rest | completed | provider | provider-assisted | no | - | 25708 ms | - |
| 15 | travel-back | travel | completed | deliberate-hold | deterministic-fallback | no | - | 14991 ms | - |
| 16 | conversation | conversation | completed | provider | provider-assisted | no | - | 6836 ms | - |
| 17 | meta | meta | completed | provider | provider-assisted | no | - | 38874 ms | - |

## DM beats

| # | intent | state | receipts | candidates | latency |
| --- | --- | --- | --- | --- | --- |
| 1 | open | completed | reveal-node, ambient-beat, advance-time | 9 | 26124 ms |
| 4 | continue | completed | reveal-clue | 9 | 16392 ms |
| 7 | continue | completed | advance-time | 6 | 23982 ms |
| 10 | continue | completed | ambient-beat | 4 | 27465 ms |
| 13 | continue | completed | ambient-beat | 6 | 14210 ms |
| 16 | continue | completed | - | 6 | 8558 ms |


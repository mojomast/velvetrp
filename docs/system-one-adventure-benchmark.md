# System One (Jev) L2 adventure-selection benchmark

Generated 2026-09-20T00:07:05.540Z by `scripts/evaluate-system-one-adventure-lane.ts` using the live System One adapter.

## What this measures

The L2 lane is an **advisory exact-candidate selector, wired in shadow (record-only)**. `buildAdventureSelectionQuestions`
builds one fusion-free single battery over the union of the turn's advertised candidates: a
`supported` noul ("does the declaration clearly describe committing exactly one advertised
candidate?"), one per-candidate relevance `score`, and one aggregate `best_candidate`
`choice` over the exact candidate ids with the fail-closed `none_of_these` option.
`composeAdventureSelection` requires the aggregate choice to name an advertised candidate and
combines the chosen option's probability with the `supported` noul as the minimum of the two
independent claims; `act` selects, `confirm` records a lower-confidence selection, and anything
below defers. The lane is **wired in shadow (record-only)** behind the `FEATURE_SYSTEM_ONE` feature flag,
the enabled setting, a usable key, and a non-`off` lane mode: it records one immutable shadow decision
per fresh adventure turn that advertises candidates and never selects, orders, or commits anything. An
`active` lane mode is still record-only because no promoted active path exists.

The lane **never adds, drops, or authorizes a candidate**: candidate ids and digests are already
server-issued, selection is exact-candidate only, and the existing digest re-validation and
command bridge remain authoritative. There is no repository fixture, so the lane is graded
against a hand-labeled projection corpus of declarations and server-shaped candidate sets.

`act` is the only behavior-changing outcome. `confirm` is a deferral (it records a selection but
changes no behavior) and is coverage, not a decision, so only acted decisions are calibrated and
scored by the promotion gate. `correct` uses the case's asserted-subset rubric: the committed
selection — or the deferral — must be in the case's `acceptable` set.

Because the first live run showed the raw model naming the right candidate below the server
default action bar (0.75), the harness also sweeps a fixed grid of lower thresholds,
re-scoring the candidate each call actually named (committed or not) against the case labels.
That sweep reports a **recommended action threshold**; it does not change the server default.

## Setup

| Setting | Value |
| --- | --- |
| Model | jev-1.13.0 |
| Base URL | https://api.typesafe.ai/v1 |
| Lane | `adventure-selection` (advisory, shadow-wired record-only; no promoted active path) |
| Confidence thresholds (action / review) | 0.75 / 0.5 |
| Action-threshold sweep grid | 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75 |
| Battery | single fusion-free battery: 1 `supported` noul + 1 `relevance:<candidateId>` score per candidate + 1 `best_candidate` choice |
| Repeats | 3 |
| Corpus | 135 declarations x 3 repeats = 405 calls |
| Holdout | 9 case(s) held out of the Platt fit (126 development) |
| Harvested cases | 105 merged (23 human-confirmed + 82 agent-reviewed), 0 skipped — `server/test/fixtures/system-one-harvested/adventure-selection.json` |
| Gate scope | frozen corpus + 23 human-confirmed harvested case(s); 82 agent-reviewed harvested case(s) are scored but not gated |

## Corpus and per-case results

105 of 135 case(s) are **harvested** rows: status-confirmed live-derived labels from
`server/test/fixtures/system-one-harvested/adventure-selection.json` (0 confirmed proposal(s) skipped). The review split is 23
human-confirmed (`review-annotated`, gate-eligible) versus 82 agent-reviewed (`agent-review`). All of them
run through the same composition and appear in the per-case table, but the agent-reviewed rows are
**not promotion evidence**: calibration, the dev/holdout split, the threshold sweep, the gate, and
any proposed record cover only the frozen corpus plus the human-confirmed rows, and the
agent-reviewed rows are summarized separately below.

| Case | Category | Split | Provenance | Expected | Calls | Acted | Exact | Correct | Errors | Effective outcomes |
| --- | --- | :---: | :---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| direct-travel-mill | direct-match | dev | frozen | travel:mill-01 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| direct-travel-harbor | direct-match | holdout | frozen | travel:harbor-04 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| direct-check-climb | direct-match | dev | frozen | check:climb-05 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| direct-commerce-rope | direct-match | dev | frozen | shop:buy-rope-07 | 3 | 3 | 3/3 | 3/3 | 0 | shop:buy-rope-07 3 |
| direct-quest-accept | direct-match | holdout | frozen | quest:accept-harbor-09 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| direct-progression-level | direct-match | dev | frozen | level:advance-11 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-rest-long-short | ambiguous | dev | frozen | rest:long-12 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-travel-watchtower | ambiguous | dev | frozen | travel:watchtower-16 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-travel-two-roads | ambiguous | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| ambig-power-target | ambiguous | dev | frozen | power:mending-bryn-19 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-combat-power-target | ambiguous | holdout | frozen | combat:firebolt-bandit-22 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-commerce-sell | ambiguous | holdout | frozen | shop:sell-ring-24 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| ambig-consumable-target | ambiguous | dev | frozen | consumable:heal-aster-25 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-check-vs-travel-trap | multi-family | dev | frozen | check:force-gate-28 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-row-vs-travel | multi-family | dev | frozen | check:row-30 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-quest-vs-travel | multi-family | dev | frozen | quest:accept-harbor-31 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-commerce-vs-inventory | multi-family | dev | frozen | shop:buy-rope-33 | 3 | 3 | 3/3 | 3/3 | 0 | shop:buy-rope-33 3 |
| multi-power-vs-rest | multi-family | holdout | frozen | rest:long-35 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| multi-combat-vs-power | multi-family | holdout | frozen | combat:firebolt-wolf-37 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| unsupported-question | unsupported | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unsupported-hypothetical | unsupported | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unsupported-two-actions | unsupported | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unsupported-choice-question | unsupported | holdout | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unadvertised-fireball | unadvertised | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unadvertised-destination | unadvertised | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unadvertised-sword | unadvertised | holdout | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| unadvertised-no-candidates | unadvertised | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| smalltalk-weather | small-talk | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| smalltalk-innkeeper | small-talk | dev | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| smalltalk-joke | small-talk | holdout | frozen | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:04e62a0ddd47 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:09c974ce40a5 | harvested | dev | harvested (human) | inventory-candidate:fed332e8091405e4ee6b0cccacc4c01cb5c7acad79236ad2 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:0afb961efdec | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:0bdf136e64d4 | harvested | dev | harvested (human) | ace41eae-5ef2-44cf-999b-53ccf1b8f8cf | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:0ec73aec02e3 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:0ed8b80e4a05 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:11cd7c76513f | harvested | dev | harvested (human) | quest-candidate:db2684f8269c16da84735f162e0f784758e5e2159a2a8983 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:159e90a93cb6 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:1826f4fd5e50 | harvested | dev | harvested (agent) | combat-consumable-candidate:2a7aee60650617467ddc84a3554875cd221ec60fbd44c8e9 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:1939fe92d69c | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:195a18777be1 | harvested | dev | harvested (human) | quest-candidate:90869640364244bd8deb6137c93a1db153167370c18a4ac4 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:19a51723b16c | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:1c818f78400e | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:1d94d92eeca9 | harvested | dev | harvested (agent) | quest-accept-candidate:cb5875a2b8919b9b50f7b26da1f82e4f7955928783f2851f | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:1e03f2c6d4f8 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:1f8bed7eac50 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:21809db95252 | harvested | dev | harvested (agent) | check-candidate:2fed533b5a0a58a63c48231431ea6c7eaaf3d9275c9bd365 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:21db70ab1dba | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:2292dac40705 | harvested | dev | harvested (human) | rest-candidate:971b006fb24c9eb8f94e979e7c00cf66a0d0c87bf5558af1 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:22a75d63ff9d | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:25dc8a20a935 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:2a2221ccc772 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:2a99c91d232c | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:2f407755c4c2 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:30e85dce62a7 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:332daeb09896 | harvested | dev | harvested (human) | quest-candidate:2b5f4bb2e424f78e3a2099d67a3d6f33b2895b112e384538 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:38c1efae5452 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:38f48e37c916 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:3ac1630d0dc9 | harvested | dev | harvested (human) | quest-accept-candidate:8cf5f772e7ce007d6a77482e7a9afc2c88a5d91aa2f515cd | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:3b8fd99efe8a | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:3d1b3a8ec7b5 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:3d2cb0327352 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:3f8d71417d38 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:414b2795770d | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:48fb7232352a | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:4bfc6b4ad740 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:4c0911234b39 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:4ceb482981df | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:50144e777c5d | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:50885adc8a9a | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:51c7db5efd8d | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:5b3104cae1dc | harvested | dev | harvested (human) | rest-candidate:52af720fa612243ae85c476f4c242d6d78421c410c314d20 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:62684602d7e6 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:643d8f61c4c6 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:649f071cf0e1 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:66711ff7099e | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:6b8359ca620b | harvested | dev | harvested (human) | combat-power-candidate:c037239658b1559935d13e473ba8758b03e37f8956ae155d | 3 | 2 | 2/3 | 2/3 | 0 | defer 1, combat-power-candidate:c037239658b1559935d13e473ba8758b03e37f8956ae155d 2 |
| harvested:6ef5508ce70e | harvested | dev | harvested (human) | check-candidate:b310d57d4f364f7445c36aa5479ecf1dc1f76217167e83ca | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:70699991a6e3 | harvested | dev | harvested (agent) | quest-candidate:e5986503272ad53179d51bca3b08084babf8b22a35bebe43 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:74cbab9ca6f0 | harvested | dev | harvested (human) | check-candidate:7b90b7adefe020359b5d8d46a70e576579276a400d56a5a8 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:787b57d44cdc | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:7aff1bb8977a | harvested | dev | harvested (human) | combat-power-candidate:b1fc331c6b5a4e06cca7de19abbd579fece92e60ce3df6c7 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:7bc78db301fd | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:7e1b86a0ed87 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:7fa7573d172e | harvested | dev | harvested (human) | check-candidate:895a91824af74122c10edcbb874cc441827a9651bc7d35f3 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:812ec5a90895 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:846cec6d7815 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:8726afca6973 | harvested | dev | harvested (agent) | check-candidate:06226f4addc17e92bd532bc11f1625a1326112e57ff6477f | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:88c3eefcdc91 | harvested | dev | harvested (human) | combat-consumable-candidate:8ed2467f93435ad5ad6fa76d824d175a024b57449c7dd376 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:8b7843704f48 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:8c3a66c3946f | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:8edfb9c0137e | harvested | dev | harvested (human) | rest-candidate:72bf1a48912034161b7b121ea6ab6ecadb06ed9265473c1a | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:92970b2d312b | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:95f80eb4a1b7 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:99038ff406e7 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:99b6c41a65b2 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:9b128c65af8f | harvested | dev | harvested (human) | check-candidate:8511e58dee984acfc939c7151d14590ecc248f5a8ba91718 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:9d1a3d4d3df1 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:aa09b62078d5 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:ad10f3fc27d7 | harvested | dev | harvested (human) | combat-power-candidate:f9f4468d54672bc87e09cb5ac586089a025eefbf9ca4e9c6 | 3 | 3 | 3/3 | 3/3 | 0 | combat-power-candidate:f9f4468d54672bc87e09cb5ac586089a025eefbf9ca4e9c6 3 |
| harvested:ad383d4f9924 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:adbcb3b5ee1a | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:b1446f731e6d | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:b1e4dfc2f2e2 | harvested | dev | harvested (human) | check-candidate:2a94199a7dd3c59f1c56b41963996b817139f0bbb3bbb3b7 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:b2c96f78d1fb | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:b3538e6d452a | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:b526e0c137af | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:b6b97efce41a | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:b763a4206cef | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:b9821f5ea65f | harvested | dev | harvested (human) | f4324e1c-ec9c-4c07-b6eb-a111af1e495d | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:baf07348c6f2 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:bc60e8e5ff63 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:bf4eacd2676f | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:c3e16ca55a84 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:c6487802fc34 | harvested | dev | harvested (human) | check-candidate:51eb8abf9c4c59263d69ee07cbde3f246cb94762aa1dac5e | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:ccc2d2cf0d15 | harvested | dev | harvested (human) | quest-candidate:69ebf8330193e2995b527f42ef3ed12714d59c4342572f80 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:d00089bb4860 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:da7b70b651ce | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:db0272898001 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:df4631121c74 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:e0ebc2e36b1c | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:e12e36c09d45 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:e3350459cfa1 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:e401ce50066f | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:e6f52fea4ac9 | harvested | dev | harvested (human) | rest-candidate:e5d206b51d18fdab5b4233a081136cb200e725cbfcddd20a | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:e806de3c9818 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:ea26acf71cb4 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:eac8cb0df78d | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:ee122c33b2f2 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:f1959cc7da5e | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:f2733fc20223 | harvested | dev | harvested (human) | power-candidate:8f158c4259cdc5ffb70ee953b315e5160427862e852ae941 | 3 | 0 | 0/3 | 0/3 | 0 | defer 3 |
| harvested:f37ba9fb92bf | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:f5fc508589e4 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:ff86af2cbc48 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |
| harvested:ffbb7415aa77 | harvested | dev | harvested (agent) | defer | 3 | 0 | 3/3 | 3/3 | 0 | defer 3 |

### Agent-reviewed harvested cases (not gated)

82 merged case(s) came from **agent review** (`agent-review` provenance), not a human
verdict. They ran through the same composition and are scored in the per-case table above
(provenance `harvested (agent)`), but they are **not promotion evidence**: the project rule is that
promotion records re-derive only from human-confirmed labels, so the calibration fit, the
dev/holdout split, the threshold sweep, the gate, and the proposed record all exclude them.
They still count in the per-case table, the overall coverage/decisive observations, and the
stability roll-up.

| Agent-reviewed metric | Value |
| --- | ---: |
| Cases | 82 |
| Graded calls | 246 |
| Acted calls | 0 |
| Acted accuracy | n/a |
| Exact preferred | 231/246 |
| Asserted-subset correctness | 93.9% |

## Decision stability

Repeated draws of the same case should produce the same decision. `decision` is the candidate each
call named (the composed pick, or the raw pick recovered from a deferral), else `defer`; every
repeat keeps the production-shaped request (no `uid`), so these are same-state draws of the exact
request the gate scores. A uid-decorrelated probe moved the selected threshold from 0.60 to 0.30
and produced a degenerate negative-slope calibration map (calibrated ECE 0.1344 > 0.10), so the
protocol decision is that gate measurements mirror production and the vendor decorrelator is
reserved for dedicated stability probes.

| Metric | Value |
| --- | ---: |
| Mean agreement | 99.8% |
| Conflict cases | 1 of 135 (0.7%) |
| Mean signal std dev | 0.0125 |
| Max signal std dev | 0.0478 |

Conflicted cases:
- `harvested:332daeb09896` (agreement 66.7%): quest-candidate:2b5f4bb2e424f78e3a2099d67a3d6f33b2895b112e384538 / defer

Honesty: stability is repeatability, not accuracy; a consistently deferred case is stable and still
a coverage miss, and a conflicted case may still have every individual pick labeled acceptable.

## Threshold sweep

The lane composes at the server default action threshold **0.75**. The sweep re-scores the
candidate each call named — the composed pick, or for a deferral the raw `best_candidate` recovered
from the answers — against that case's acceptable set at every grid threshold, without re-asking
the model. Selection takes the greatest-coverage threshold whose acted count and acted accuracy clear
the lane gate floors (>= 0.9 accuracy over >= 30 acted) over every labeled sample;
the Platt map is still fit on development acted decisions only, so the recommended verdict is
descriptive rather than held out. The server default remains **0.75** until configured.

Rows count only calls that named a candidate: a call that named nothing cannot act at any threshold,
so `Acted` and `Coverage` are over named calls, not over every graded call.

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.35 | 105/115 | 91.3% | 100.0% |
| 0.40 | 98/115 | 85.2% | 100.0% |
| 0.45 | 87/115 | 75.7% | 100.0% |
| 0.50 | 81/115 | 70.4% | 100.0% |
| 0.55 | 64/115 | 55.7% | 100.0% |
| 0.60 | 39/115 | 33.9% | 100.0% |
| 0.65 | 25/115 | 21.7% | 100.0% |
| 0.70 | 15/115 | 13.0% | 100.0% |
| 0.75 | 11/115 | 9.6% | 100.0% |

Selected recommended action threshold: **0.35** (coverage 91.3%, acted accuracy 100.0% over 105 acted).
- filtered 3 of 9 threshold(s) for failing actedAccuracy >= 0.9 with at least 30 acted decisions
- selected greatest-coverage threshold 0.35 (coverage 0.9130434782608695) meeting actedAccuracy >= 0.9 with at least 30 acted decisions

### Development split

| Action threshold | Acted | Coverage | Acted accuracy |
| ---: | ---: | ---: | ---: |
| 0.35 | 87/97 | 89.7% | 100.0% |
| 0.40 | 80/97 | 82.5% | 100.0% |
| 0.45 | 72/97 | 74.2% | 100.0% |
| 0.50 | 67/97 | 69.1% | 100.0% |
| 0.55 | 54/97 | 55.7% | 100.0% |
| 0.60 | 32/97 | 33.0% | 100.0% |
| 0.65 | 22/97 | 22.7% | 100.0% |
| 0.70 | 14/97 | 14.4% | 100.0% |
| 0.75 | 11/97 | 11.3% | 100.0% |

### Verdict comparison

| Configuration | Threshold | Gate | Samples | Accuracy | Brier | ECE |
| --- | ---: | :---: | ---: | ---: | ---: | ---: |
| Server default | 0.75 | NOT READY | 11 | 100.0% | 0.0000 | 0.0046 |
| Recommended | 0.35 | PROMOTE | 105 | 100.0% | 0.0001 | 0.0104 |

## Calibration

Fit the monotonic Platt map on the acted development decisions at the server default threshold (0.75) and scored it out of sample on the held-out cases. The recommended-threshold calibration is in the sweep above and the JSON sidecar.

Gate scope: these rows cover the frozen corpus plus human-confirmed harvested cases only. The 82 agent-reviewed harvested case(s) are summarized separately and excluded from the fit and the scores.

| Split / signal | Accuracy | Brier | ECE |
| --- | ---: | ---: | ---: |
| all acted, raw (11) | 100.0% | 0.0479 | 0.2182 |
| all acted, calibrated (11) | 100.0% | 0.0000 | 0.0046 |
| held-out acted, raw (0) | n/a | 0.0000 | 0.0000 |
| held-out acted, calibrated (0) | n/a | 0.0000 | 0.0000 |

Map: `sigmoid(a * logit(p) + b)` with a = 2.8654, b = 1.7516 (fit on 11 development acted decision(s); held out 0).

## Promotion gate — `adventure-selection`

The server default action threshold remains **0.75**; a recommended threshold is an evaluation
finding for the parent to configure, not an automatic change. The record below is proposed from the
recommended-threshold verdict, because that is the configuration the evidence supports.
Gate scope: frozen corpus plus human-confirmed harvested cases only. The 82 agent-reviewed
harvested case(s) never enter these verdicts or the proposed record.

### Recommended-threshold verdict (0.35)

Metrics scored on the calibrated acted signal at this threshold: samples 105, accuracy 100.0%, Brier 0.0001, ECE 0.0104.

**PROMOTE**

All gates passed.

### Server-default verdict (0.75)

Metrics scored on the calibrated acted signal at the composed default threshold: samples 11, accuracy 100.0%, Brier 0.0000, ECE 0.0046.

**NOT READY**

- insufficient samples: 11 < 30
- accuracy lower bound below minimum: 0.7412 < 0.8000

### Proposed `adventure-selection` promotion record (recommended threshold)

```json
{
  "metrics": {
    "samples": 105,
    "accuracy": 1,
    "brier": 0.00012948433096581627,
    "expectedCalibrationError": 0.01038190161844188
  },
  "calibration": {
    "a": 1.0043179317461137,
    "b": 4.36045928439146
  },
  "promotedAt": "2026-09-20",
  "evidence": "docs/system-one-adventure-benchmark.md"
}
```

## Observations

- **Coverage.** 11 of 405 graded calls acted (11 act / 79 confirm / 315 fallback); the rest deferred. 267 of 394 deferral(s) were in the acceptable set.
- **Decisive accuracy.** Among acted decisions, 11/11 (100.0%) were in the acceptable set and 11/11 (100.0%) matched the single preferred call.
- **Under-confidence.** 133 readout(s) named a candidate; 122 named one but deferred, with signals 0.19–0.74, and 113 of those named picks were acceptable. The raw model is right but under the 0.75 bar — the same systematic under-confidence the L1 Director lane measured. The sweep recommendation is the lever; the server default stays 0.75.
- **Acted errors.** No acted decision fell outside its case's acceptable set.
- **Calibration.** Held-out calibrated Brier 0.0000 and ECE 0.0000; all-acted calibrated Brier 0.0000 and ECE 0.0046. The acted subset has no observed errors, so the calibration tail is untested.

## Honesty notes

- The corpus is a **hand-labeled projection**, not a repository fixture: candidate ids, digests,
  and labels are realistic fixtures and the declarations are written, not sampled from real
  turns. A passing gate is a promotion candidate, not a guarantee.
- The recommended threshold is selected on the same labeled corpus that scores its verdict, so
  that verdict is **descriptive, not a held-out guarantee**; the Platt map is still fit on
  development acted decisions only. The server default stays until the parent decides otherwise.
- The lane is **wired in shadow (record-only)**: it records one immutable decision per fresh
  adventure turn that advertises candidates and never selects, orders, or commits. Any promotion
  record this run justifies is evidence, not activation; an `active` lane mode still stays
  record-only until a promoted active path exists.
- Decisive accuracy is an **asserted-subset figure**: it counts membership in the case's
  acceptable set, which is a judgment call. Exact-preferred agreement and the per-case table are
  reported alongside it, and the gate is scored only on acted decisions.
- **Decision stability is repeatability, not accuracy**: a consistently deferred case is stable and
  still a coverage miss. Harvested rows are live-derived labels and are flagged as such in the
  corpus table so a reviewer can see the gate includes them.
- The `adventure-selection` gate is the base lane gate (accuracy >= 0.9, Brier/ECE <= 0.1). The verdict above is reported as measured, including any failures.
- Only schema-valid calls produce compositions; transport failures are reported separately and
  never counted as acted samples.

## Reproduce

```bash
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
npx tsx scripts/evaluate-system-one-adventure-lane.ts --repeat 3
```

Raw per-call data: `docs/system-one-adventure-benchmark.json`.

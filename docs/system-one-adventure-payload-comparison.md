# System One adventure payload comparison — legacy vs shared-context

Generated 2026-09-22T13:58:34.925Z by `scripts/compare-system-one-adventure-payloads.ts` (live paired run).

## What this measures

`buildAdventureBenchmarkRequest` builds two payloads for the same case:

- **legacy** — the benchmark-shaped request the evaluator already runs: state carries the declaration and the
  advertised candidate count, and the question battery embeds the declaration into the `supported` noul, each
  per-candidate relevance `score`, and the aggregate `best_candidate` choice.
- **shared-context** — the experimental request: the declaration and every advertised candidate (including
  duplicate instances and digest bindings) live in state, and the questions reference candidate ids and
  describe judgments.

This runner builds both variants for every case, serializes them as `{ state, questions }`, and compares the
UTF-8 byte length, the request digests, and the candidate surfaces. Payload size is not provider input tokens,
billed cost, or latency; provider usage is measured separately in live mode.

Both variants must expose the same candidate identities and count. A structural mismatch is reported as a
failure below and in the JSON sidecar, never silently dropped.

## Corpus

| Setting | Value |
| --- | --- |
| Mode | live paired run (provider calls measured) |
| Cases | 135 (30 frozen + 105 harvested: 23 human-confirmed, 82 agent-reviewed) |
| Frozen corpus | `adventure-evals-v1` |
| Harvest fixture | `server/test/fixtures/system-one-harvested/adventure-selection.json` (present, 105 confirmed) |
| Corpus digest | `e9ee7991eb68880838f749e3e0b6f08912c994346fcee86d67eb5e8ea944afe2` (SHA-256 over the ordered case identities) |
| Structural pairing | 135/135 case(s) clean |
| Model | jev-1.13.0 |
| Base URL | https://api.typesafe.ai/v1 |
| Repeats | 2 per variant per case (interleaved per case) |
| Budget | `--max-calls 600`; projected 540 call(s) |
| Action threshold | act >= 0.75, confirm >= 0.5 |

## Payload bytes

| Variant | Total bytes | Mean | Min | Max |
| --- | ---: | ---: | ---: | ---: |
| legacy | 3572202 | 26460.8 | 917 | 61084 |
| shared-context | 2831433 | 20973.6 | 1078 | 28609 |

| Metric | Value |
| --- | ---: |
| Delta (shared − legacy) | -740769 bytes |
| Delta percent | -20.7% |
| Cases shrunk | 77 |
| Cases grown | 58 |
| Cases equal | 0 |
| Cases not measured | 0 |

## Per-case byte deltas

Sorted by absolute delta; showing the first 10 and last 10 row(s). All 135 case(s) are in the JSON sidecar.

| Case | Category | Provenance | Candidates | Legacy bytes | Shared bytes | Delta | Delta % | Request digest (legacy) | Request digest (shared) | Structure |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | --- | --- | :---: |
| harvested:8c3a66c3946f | harvested | harvested (agent) | 32 | 61084 | 28609 | -32475 | -53.2% | a4a285f326e3 | 34d1e232cb6c | paired |
| harvested:f5fc508589e4 | harvested | harvested (agent) | 32 | 51954 | 28311 | -23643 | -45.5% | 6ca9ac825ffa | cde7754dddec | paired |
| harvested:8726afca6973 | harvested | harvested (agent) | 32 | 51442 | 28348 | -23094 | -44.9% | d7dda44e8001 | a660b061daef | paired |
| harvested:19a51723b16c | harvested | harvested (agent) | 32 | 50270 | 28354 | -21916 | -43.6% | 0b488d81e3dc | f9dfdd3a59aa | paired |
| harvested:ee122c33b2f2 | harvested | harvested (agent) | 32 | 49714 | 28332 | -21382 | -43.0% | 3cd1d48d74b3 | f5542fa22fea | paired |
| harvested:c3e16ca55a84 | harvested | harvested (agent) | 32 | 49600 | 28398 | -21202 | -42.7% | 06e8298db3cd | 796b781c6d62 | paired |
| harvested:846cec6d7815 | harvested | harvested (agent) | 31 | 48317 | 27531 | -20786 | -43.0% | fe19298af3e1 | 863dc3d75799 | paired |
| harvested:b763a4206cef | harvested | harvested (agent) | 32 | 48582 | 28401 | -20181 | -41.5% | e9602a2a13e4 | 551b06deb96c | paired |
| harvested:95f80eb4a1b7 | harvested | harvested (agent) | 32 | 47928 | 28202 | -19726 | -41.2% | fba9ed1c470c | 9a7ae6d49dc7 | paired |
| harvested:df4631121c74 | harvested | harvested (agent) | 32 | 47706 | 28240 | -19466 | -40.8% | c85dbe65dabe | 2d47d4e26bfe | paired |
| ambig-consumable-target | ambiguous | frozen | 2 | 2119 | 2368 | +249 | +11.8% | d5e976b4f770 | 094c8021d899 | paired |
| multi-check-vs-travel-trap | multi-family | frozen | 2 | 2065 | 2312 | +247 | +12.0% | 8d81fb925797 | 7d50f7bc2093 | paired |
| harvested:ad10f3fc27d7 | harvested | harvested (human) | 1 | 1718 | 1956 | +238 | +13.9% | e86d696f2c54 | 663d02abdf5d | paired |
| direct-progression-level | direct-match | frozen | 1 | 1443 | 1674 | +231 | +16.0% | 7b09091d0119 | 8ae84deb00b9 | paired |
| harvested:159e90a93cb6 | harvested | harvested (agent) | 32 | 27814 | 27601 | -213 | -0.8% | 40fece2ea3ee | 9221625bedba | paired |
| ambig-commerce-sell | ambiguous | frozen | 2 | 2129 | 2332 | +203 | +9.5% | 32ef706b21c1 | 151fb7736ebc | paired |
| direct-commerce-rope | direct-match | frozen | 2 | 2145 | 2336 | +191 | +8.9% | eb7a0e484d15 | 6d2122fab55e | paired |
| unadvertised-no-candidates | unadvertised | frozen | 0 | 917 | 1078 | +161 | +17.6% | 1649be338447 | 9f163a7ecdf5 | paired |
| harvested:6b8359ca620b | harvested | harvested (human) | 1 | 1847 | 1999 | +152 | +8.2% | f8e36b33bf13 | 65c29adf5b51 | paired |
| harvested:04e62a0ddd47 | harvested | harvested (agent) | 32 | 27322 | 27467 | +145 | +0.5% | ed525562f4bf | bf6170b9fa7a | paired |
| … | | | | | | | | | | 115 row(s) omitted |

## Structural pairing

Both variants must expose the same candidate identities and count for every case: no candidate may be lost,
added, or reordered, and the question batteries must agree. A mismatch is a failure, not a silent drop.

**135/135** case(s) paired cleanly.

Every case exposes the same ordered candidate identities and question batteries in both variants.

## Agreement

Each case ran both variants 2 time(s), interleaved per case. `decision` is the candidate a call named
(the composed pick, or the raw pick recovered from a deferral), else `defer`.

| Metric | Value |
| --- | ---: |
| Cases with attempts from both variants | 135 of 135 |
| Mean agreement across attempts | 96.5% |
| Cases conflicted across attempts | 11 (8.1%) |
| Cases with a cross-variant conflict | 11 of 135 |
| Mean cross-variant agreement | 93.0% |

| Case | Attempts | Legacy decisions | Shared decisions | Agreement | Cross-variant |
| --- | ---: | --- | --- | ---: | ---: |
| harvested:2a99c91d232c | 4 | defer / defer | check-candidate:cbe898133ae0f0985eea6e423db0a50b2c8e90316031ef72 / check-candidate:cbe898133ae0f0985eea6e423db0a50b2c8e90316031ef72 | 50.0% | 0.0% |
| harvested:30e85dce62a7 | 4 | defer / defer | check-candidate:308a7266d8e98f164c89798999f2d90c2f6b422bf0c4631d / check-candidate:308a7266d8e98f164c89798999f2d90c2f6b422bf0c4631d | 50.0% | 0.0% |
| harvested:414b2795770d | 4 | defer / defer | quest-accept-candidate:5ed06667552a5fe45c99a20aa4e0967a7069878d81b963de / quest-accept-candidate:5ed06667552a5fe45c99a20aa4e0967a7069878d81b963de | 50.0% | 0.0% |
| harvested:4ceb482981df | 4 | defer / defer | check-candidate:17b93880aa1be8e2bf91cddb2a27f999ef8ea45c56dcd18e / check-candidate:17b93880aa1be8e2bf91cddb2a27f999ef8ea45c56dcd18e | 50.0% | 0.0% |
| harvested:643d8f61c4c6 | 4 | defer / defer | quest-abandon-candidate:ca3b200d6da4049840def29d775af69f4a6e5a0e47bd333a / quest-abandon-candidate:ca3b200d6da4049840def29d775af69f4a6e5a0e47bd333a | 50.0% | 0.0% |
| harvested:adbcb3b5ee1a | 4 | quest-abandon-candidate:071e7a203416061524ec80562afc5e131cc99b24954faa3a / quest-abandon-candidate:071e7a203416061524ec80562afc5e131cc99b24954faa3a | defer / defer | 50.0% | 0.0% |
| harvested:b1446f731e6d | 4 | defer / defer | power-candidate:d3f5f021b0a7af4271929b331a99224cc5eb01fb2821c321 / power-candidate:d3f5f021b0a7af4271929b331a99224cc5eb01fb2821c321 | 50.0% | 0.0% |
| unsupported-hypothetical | 4 | defer / defer | check:climb-41 / check:climb-41 | 50.0% | 0.0% |
| harvested:332daeb09896 | 4 | defer / quest-candidate:2b5f4bb2e424f78e3a2099d67a3d6f33b2895b112e384538 | quest-candidate:2b5f4bb2e424f78e3a2099d67a3d6f33b2895b112e384538 / quest-candidate:2b5f4bb2e424f78e3a2099d67a3d6f33b2895b112e384538 | 75.0% | 50.0% |
| harvested:c3e16ca55a84 | 4 | defer / defer | defer / quest-candidate:6783a700b2db923cdb69af8071596e9fd4b1557ddcb870a2 | 75.0% | 50.0% |

## Grading metrics per variant

Composed at the lane's default action threshold (act >= 0.75). Coverage is acted/graded calls;
acted accuracy counts acted decisions in the case's acceptable set; exact preferred counts the single preferred call;
asserted-subset accuracy counts committed selections or deferrals in the acceptable set. The **agent-reviewed
harvested** scope is scored but is not promotion evidence, and curated benchmark cases bypass production shortlisting,
so accuracy claims stay tied to the labeled scope (frozen plus human-confirmed harvested).

| Variant | Scope | Calls | Acted | Coverage | Acted accuracy | Exact preferred | Asserted-subset accuracy |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | All graded cases | 270 | 6 | 2.2% | 100.0% | 184/270 | 68.1% |
| legacy | Labeled (frozen + human-confirmed) | 106 | 6 | 5.7% | 100.0% | 30/106 | 28.3% |
| legacy | Agent-reviewed harvested (not gated) | 164 | 0 | 0.0% | n/a | 154/164 | 93.9% |
| shared-context | All graded cases | 270 | 58 | 21.5% | 100.0% | 236/270 | 87.4% |
| shared-context | Labeled (frozen + human-confirmed) | 106 | 56 | 52.8% | 100.0% | 80/106 | 75.5% |
| shared-context | Agent-reviewed harvested (not gated) | 164 | 2 | 1.2% | 100.0% | 156/164 | 95.1% |

Per-variant repeat stability (using the evaluator's stability roll-up):

| Variant | Mean agreement | Conflict cases | Mean signal std dev |
| --- | ---: | ---: | ---: |
| legacy | 99.6% | 1 of 135 | 0.0089 |
| shared-context | 99.3% | 2 of 135 | 0.0067 |

## Provider usage (measured separately)

Tokens, cost, and latency are provider measurements for the calls each variant made; `null` means the provider did
not report the value. Cost is derived from reported usage and the configured pricing, not a billed amount. These
figures are separate from the payload bytes above.

| Variant | Attempts | Usage reported | Input tokens | Output tokens | Total tokens | Cost (USD) | Mean latency | Total latency | Failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| legacy | 270 | 270 | 2017482 | 784673 | 2802155 | 0.084734 | 142 ms | 38398 ms | 0 |
| shared-context | 270 | 270 | 2488068 | 785273 | 3273341 | 0.104499 | 161 ms | 43425 ms | 0 |

## Failures

No adapter failures: every scheduled call returned a graded composition.

## Grading metrics per action family

Each graded call is attributed to exactly one canonical action family. The case's labeled family wins
when the case names an expected candidate — that candidate's `kind`. A case that labels no expected
candidate falls back to the kind of the pick the call named: the committed selection, or the raw pick
the evaluator recovers from a deferral. A call that named no pick is `defer`; a resolved kind with no
canonical mapping is `unknown`, listed below and never silently dropped. Families are ordered by the
harness taxonomy (`MECHANIC_FAMILIES`), then `defer`, then `unknown` last. Small samples are shown as raw
counts; no significance is claimed. All graded calls count here (frozen, human-confirmed, and
agent-reviewed harvested); agent-reviewed rows are scored but are not promotion evidence.

Mapping source: the case's expected candidate `kind` when the case labels one, falling back to the kind of the pick the call named (the committed selection, or the raw pick the evaluator recovers from a deferral), then `defer`; canonical families and exact candidate kinds from `MECHANIC_FAMILIES` / `KIND_TO_FAMILY` in `scripts/synthetic-player-harness.ts`, plus production proposal tool-name aliases.

### legacy

| Family | Calls | Acted | Coverage | Acted accuracy | Exact preferred | Asserted-subset accuracy | Cases (sample) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 10 | 0 | 0.0% | n/a | 0/10 | 0.0% | 5 |
| srd-check | 22 | 0 | 0.0% | n/a | 0/22 | 0.0% | 11 |
| inventory | 2 | 0 | 0.0% | n/a | 0/2 | 0.0% | 1 |
| commerce | 6 | 4 | 66.7% | 100.0% | 4/6 | 66.7% | 3 |
| power | 6 | 0 | 0.0% | n/a | 2/6 | 33.3% | 3 |
| rest | 12 | 0 | 0.0% | n/a | 0/12 | 0.0% | 6 |
| combat-consumable | 6 | 0 | 0.0% | n/a | 0/6 | 0.0% | 3 |
| combat-power | 10 | 2 | 20.0% | 100.0% | 2/10 | 20.0% | 5 |
| quest-lifecycle | 12 | 0 | 0.0% | n/a | 4/12 | 33.3% | 6 |
| quest-objective | 10 | 0 | 0.0% | n/a | 0/10 | 0.0% | 5 |
| progression | 2 | 0 | 0.0% | n/a | 0/2 | 0.0% | 1 |
| defer | 172 | 0 | 0.0% | n/a | 172/172 | 100.0% | 86 |
| unknown | 0 | 0 | n/a | n/a | n/a | n/a | 0 |

### shared-context

| Family | Calls | Acted | Coverage | Acted accuracy | Exact preferred | Asserted-subset accuracy | Cases (sample) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 10 | 6 | 60.0% | 100.0% | 6/10 | 60.0% | 5 |
| srd-check | 30 | 5 | 16.7% | 100.0% | 13/30 | 43.3% | 15 |
| inventory | 2 | 0 | 0.0% | n/a | 0/2 | 0.0% | 1 |
| commerce | 6 | 6 | 100.0% | 100.0% | 6/6 | 100.0% | 3 |
| power | 8 | 4 | 50.0% | 100.0% | 8/8 | 100.0% | 4 |
| rest | 12 | 10 | 83.3% | 100.0% | 10/12 | 83.3% | 6 |
| combat-consumable | 6 | 6 | 100.0% | 100.0% | 6/6 | 100.0% | 3 |
| combat-power | 10 | 10 | 100.0% | 100.0% | 10/10 | 100.0% | 5 |
| quest-lifecycle | 14 | 6 | 42.9% | 100.0% | 12/14 | 85.7% | 7 |
| quest-objective | 12 | 3 | 25.0% | 100.0% | 5/12 | 41.7% | 7 |
| progression | 2 | 2 | 100.0% | 100.0% | 2/2 | 100.0% | 1 |
| defer | 158 | 0 | 0.0% | n/a | 158/158 | 100.0% | 80 |
| unknown | 0 | 0 | n/a | n/a | n/a | n/a | 0 |

### Cross-variant agreement by family

Mean agreement is the mean per-case share of the most common decision; a conflict case has more than one
decision across its attempts; a cross-variant conflict has at least one disagreeing legacy/shared pair.
Counts are raw; no significance is claimed.

| Family | Calls | Cases | Mean agreement | Conflict cases | Cross-variant conflicts | Mean cross-variant agreement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 20 | 5 | 100.0% | 0/5 | 0/5 | 100.0% |
| srd-check | 52 | 15 | 100.0% | 0/15 | 0/11 | 100.0% |
| inventory | 4 | 1 | 100.0% | 0/1 | 0/1 | 100.0% |
| commerce | 12 | 3 | 100.0% | 0/3 | 0/3 | 100.0% |
| power | 14 | 4 | 100.0% | 0/4 | 0/3 | 100.0% |
| rest | 24 | 6 | 100.0% | 0/6 | 0/6 | 100.0% |
| combat-consumable | 12 | 3 | 100.0% | 0/3 | 0/3 | 100.0% |
| combat-power | 20 | 5 | 100.0% | 0/5 | 0/5 | 100.0% |
| quest-lifecycle | 26 | 8 | 100.0% | 0/8 | 0/5 | 100.0% |
| quest-objective | 22 | 7 | 96.4% | 1/7 | 1/5 | 90.0% |
| progression | 4 | 1 | 100.0% | 0/1 | 0/1 | 100.0% |
| defer | 330 | 87 | 100.0% | 0/87 | 0/79 | 100.0% |
| unknown | 0 | 0 | n/a | n/a | n/a | n/a |

Cases whose calls resolved to more than one family (their pairs count inside each family): `unsupported-hypothetical`, `harvested:2a99c91d232c`, `harvested:30e85dce62a7`, `harvested:414b2795770d`, `harvested:4ceb482981df`, `harvested:643d8f61c4c6`, `harvested:adbcb3b5ee1a`, `harvested:b1446f731e6d`, `harvested:c3e16ca55a84`, `harvested:f5fc508589e4`.

No unmapped candidate kinds appeared in graded calls or case labels.

## Honesty notes

- Payload bytes are the UTF-8 length of the serialized `{ state, questions }` request JSON; they are not provider input tokens, billed cost, or latency.
- The shared-context payload is evaluation-only and is not wired to the runtime lane; this runner never changes runtime or shadow payloads.
- The frozen corpus is a hand-labeled projection and harvested rows are live-derived labels. Curated benchmark cases bypass production shortlisting, so this comparison is not production shortlist coverage, and accuracy claims stay tied to the labeled corpora (frozen plus human-confirmed harvested).
- Agent-reviewed harvested cases are scored and reported but are not promotion evidence.
- Structural pairing compares the two built requests per case; any mismatch is a reported failure, never a silent drop.
- Tokens, cost, and latency are provider measurements for this run (null when the provider reported none); cost is derived from reported usage and the configured pricing, not a billed amount.

## Reproduce

```bash
npx tsx scripts/compare-system-one-adventure-payloads.ts --out docs/system-one-adventure-payload-comparison.md
# live paired run (owner-approved budget; both variants, interleaved per case):
set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY
npx tsx scripts/compare-system-one-adventure-payloads.ts --live --max-calls 600 --repeat 2
```

Raw per-case data: `docs/system-one-adventure-payload-comparison.json`.


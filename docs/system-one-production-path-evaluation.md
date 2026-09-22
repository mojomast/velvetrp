# System One production-path evaluation — adventure-selection

Generated 2026-09-22T14:09:55.170Z by `scripts/evaluate-system-one-production-path.ts` (read-only, offline).

Worlds: `.velvet/synth-srd-1`, `.velvet/synth-srd-2`, `.velvet/synth-srd-3`, `.velvet/synth-srd-4`, `.velvet/emberwake-reach-run2`.

## What this measures

The curated adventure benchmark grades projected candidate sets; this report measures what the lane actually did on live worlds. Each decision's `state_json.candidates` is the production shortlist the live orchestrator built for that turn and each `selection_json` is the lane's own composition. There are no correctness labels here, so the tables report reach, band/defer distribution, pick commit classification, provider alignment, and confirmation outcomes — counts with descriptive rates, never accuracy.

## Definitions

- **Decision** — one `system_one_decisions_v1` row with `lane='adventure-selection'`; `state_json.candidates` is the production shortlist the live orchestrator built for that turn, and `selection_json` is the lane's composition (band, method, pick, top signal).
- **Reach** — a decision's shortlist advertised a family when at least one advertised candidate kind resolves to that family. The reach denominator is every decision; the numerator is decisions that advertised the family.
- **Defer rate** — among the decisions that advertised a family, the share whose `selection_json.method` is `defer`. Bands (`act` / `confirm` / `fallback`) are counted as recorded, not as deferrals.
- **Pick** — a decision with `method='choice'` and a recorded `selection.candidateId`; the pick's family is the family of that exact candidate in the decision's own shortlist. A pick whose candidate is absent from the shortlist, or whose kind has no canonical mapping, is counted as `unknown`.
- **Committed** — the pick's decision id carries a lane-origin execution (`adventure_exact_action_executions_v56` or `adventure_check_executions_v54`, both `origin='lane'`) whose family matches the pick's resolved family or which names the same candidate id. **Advisory act** — no such execution and band `act`. **Awaiting confirm** — no such execution and band `confirm`.
- **Provider alignment** — for every decision that named a candidate whose turn also has a provider candidate pick, the two candidate ids are compared: `same-id` when equal, otherwise `same-family` when both resolve to the same canonical family, `divergent` when both resolve and differ, `unknown-family` when either cannot be resolved. Provider picks come from the first candidate-naming provider call per turn (see the source note below). Decisions whose turn has no provider candidate call are omitted, never counted as agreement.
- **Lane proposal / execution** — lane-origin rows in the v56 proposal-binding and execution tables (plus lane-origin v54 check executions) attached to a decision id. **Confirmation outcome** — the joined `confirmation_decisions.decision` for the lane proposal's `tool_proposals` row: `approved`, `rejected`, `pending` when no decision is recorded yet, `notRequired` when the proposal needs no confirmation, `unknown` when the proposal join is missing.

Provider picks are read from the recorded provider surfaces per turn, in precedence order: `agent_tool_calls_v38.arguments_json.candidateId`, `agent_decision_rounds_v38.response_json.calls[].arguments.candidateId`, `agent_provider_responses_v39.response_json.calls[].arguments.candidateId`, then provider-origin `adventure_exact_action_proposal_bindings_v56.candidate_id`. The first candidate-naming call is the pick; extra calls on the same turn are counted (`providerExtraCalls`), never dropped. In the worlds inspected so far only the v39 response documents carry candidate selections; the v38 surfaces are read first as specified and are empty there.

Family resolution: candidate kinds through `resolveMechanicFamily` (`MECHANIC_FAMILIES` / `KIND_TO_FAMILY` in scripts/synthetic-player-harness.ts); v56 action kinds and the v54 `check` kind through `PRODUCTION_ACTION_KIND_FAMILIES`; anything unresolved is reported as `unknown`.

## Honesty notes

- Production evidence has **no correctness labels**: these are reach, decisiveness, commit, alignment, and confirmation measures, not accuracy.
- The worlds were **recorded under the production (legacy) payload across code versions**; record shapes, candidate construction, and lane policy can differ between worlds. Missing tables or columns are treated as empty and reported in notices.
- Samples are **small and uneven** across worlds; a rate over a handful of decisions is descriptive only. Counts are reported beside every rate.
- **Provider agreement is not ground truth**: the provider and the lane both acted live, agreement measures consistency rather than correctness, and the provider may have used context the lane did not have.
- **Shadow / record-only** — `shadow=1` decisions are record-only: the lane never selected, ordered, or committed anything on its own. Check the per-world `Shadow decisions` total; in the worlds evaluated here every decision was shadow.

## Aggregate (all worlds)

### Totals

| Metric | Value |
| --- | --- |
| Decisions | 161 |
| Shadow decisions | 161 |
| Decisions with a shortlist | 160 |
| Decisions without a shortlist | 1 |
| Decisions with an unjoined turn | 0 |
| Distinct turns / multi-decision turns | 158 / 3 |
| Malformed state_json / selection_json | 1 / 0 |
| Skipped candidate entries | 0 |
| First / last recorded | 2026-09-17T15:29:04.216Z … 2026-09-19T23:06:09.976Z |
| Lane picks (method=choice) | 33 |
| Picks resolved as unknown family | 0 |
| Picks missing from the shortlist | 0 |
| Lane proposals / executions | 7 / 9 |
| Proposal / execution candidate mismatches | 0 / 0 |
| Provider pick turns / extra calls | 46 / 16 |
| Alignment compared / same id / same family / divergent / unknown | 17 / 17 / 0 / 0 / 0 |
| Confirmations approved / rejected / pending | 6 / 1 / 0 |
| Confirmations other / not required / unknown | 0 / 0 / 0 |
| Approved but not executed | 3 |

### Per-family table

| Family | Advertised | Reach | Act | Confirm | Fallback | Defer | Defer rate | Picks | Signal mean | Signal median | Committed | Advisory act | Awaiting confirm | Other uncommitted | Lane proposals | Lane executions | Approved | Rejected | Pending | Approved not executed | Provider compared | Same id | Same family | Divergent | Alignment unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 37 | 23.0% | 16 | 0 | 21 | 21 | 56.8% | 2 | 0.635 | 0.635 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 |
| srd-check | 145 | 90.1% | 24 | 4 | 117 | 117 | 80.7% | 7 | 0.567 | 0.550 | 6 | 0 | 1 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| inventory | 139 | 86.3% | 24 | 4 | 111 | 111 | 79.9% | 1 | 0.680 | 0.680 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| commerce | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| power | 93 | 57.8% | 8 | 2 | 83 | 83 | 89.2% | 2 | 0.805 | 0.805 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| rest | 38 | 23.6% | 13 | 2 | 23 | 23 | 60.5% | 8 | 0.777 | 0.825 | 1 | 7 | 0 | 0 | 4 | 1 | 4 | 0 | 0 | 3 | 7 | 7 | 0 | 0 | 0 |
| combat-consumable | 8 | 5.0% | 3 | 0 | 5 | 5 | 62.5% | 2 | 0.920 | 0.920 | 1 | 1 | 0 | 0 | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-power | 14 | 8.7% | 5 | 0 | 9 | 9 | 64.3% | 3 | 0.900 | 0.960 | 1 | 2 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 |
| quest-lifecycle | 139 | 86.3% | 24 | 4 | 111 | 111 | 79.9% | 3 | 0.680 | 0.640 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| quest-objective | 53 | 32.9% | 15 | 0 | 38 | 38 | 71.7% | 5 | 0.684 | 0.750 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 |
| progression | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| unknown | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Provider alignment: compared 17; same id 17 (100.0%); same family 0 (0.0%); divergent 0 (0.0%); family unknown 0 (0.0%)

### Anomalies

- 1 decision(s) have a malformed state_json: 19d4da11-052f-4c78-823a-c472d4f02575

## World: `.velvet/synth-srd-1`

Database: `/home/mojo/projects/velvet-mvp/.velvet/synth-srd-1/velvet.sqlite`

### Totals

| Metric | Value |
| --- | --- |
| Decisions | 38 |
| Shadow decisions | 38 |
| Decisions with a shortlist | 38 |
| Decisions without a shortlist | 0 |
| Decisions with an unjoined turn | 0 |
| Distinct turns / multi-decision turns | 35 / 3 |
| Malformed state_json / selection_json | 0 / 0 |
| Skipped candidate entries | 0 |
| First / last recorded | 2026-09-18T19:55:42.747Z … 2026-09-19T23:06:09.976Z |
| Lane picks (method=choice) | 17 |
| Picks resolved as unknown family | 0 |
| Picks missing from the shortlist | 0 |
| Lane proposals / executions | 3 / 2 |
| Proposal / execution candidate mismatches | 0 / 0 |
| Provider pick turns / extra calls | 11 / 2 |
| Alignment compared / same id / same family / divergent / unknown | 12 / 12 / 0 / 0 / 0 |
| Confirmations approved / rejected / pending | 3 / 0 / 0 |
| Confirmations other / not required / unknown | 0 / 0 / 0 |
| Approved but not executed | 3 |

### Per-family table

| Family | Advertised | Reach | Act | Confirm | Fallback | Defer | Defer rate | Picks | Signal mean | Signal median | Committed | Advisory act | Awaiting confirm | Other uncommitted | Lane proposals | Lane executions | Approved | Rejected | Pending | Approved not executed | Provider compared | Same id | Same family | Divergent | Alignment unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 37 | 97.4% | 16 | 0 | 21 | 21 | 56.8% | 2 | 0.635 | 0.635 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 |
| srd-check | 38 | 100.0% | 17 | 0 | 21 | 21 | 55.3% | 2 | 0.480 | 0.480 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| inventory | 38 | 100.0% | 17 | 0 | 21 | 21 | 55.3% | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| commerce | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| power | 4 | 10.5% | 2 | 0 | 2 | 2 | 50.0% | 1 | 0.870 | 0.870 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| rest | 25 | 65.8% | 11 | 0 | 14 | 14 | 56.0% | 6 | 0.790 | 0.845 | 0 | 6 | 0 | 0 | 3 | 0 | 3 | 0 | 0 | 3 | 6 | 6 | 0 | 0 | 0 |
| combat-consumable | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-power | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| quest-lifecycle | 38 | 100.0% | 17 | 0 | 21 | 21 | 55.3% | 1 | 0.900 | 0.900 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| quest-objective | 26 | 68.4% | 10 | 0 | 16 | 16 | 61.5% | 5 | 0.684 | 0.750 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 |
| progression | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| unknown | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Provider alignment: compared 12; same id 12 (100.0%); same family 0 (0.0%); divergent 0 (0.0%); family unknown 0 (0.0%)

## World: `.velvet/synth-srd-2`

Database: `/home/mojo/projects/velvet-mvp/.velvet/synth-srd-2/velvet.sqlite`

### Totals

| Metric | Value |
| --- | --- |
| Decisions | 5 |
| Shadow decisions | 5 |
| Decisions with a shortlist | 5 |
| Decisions without a shortlist | 0 |
| Decisions with an unjoined turn | 0 |
| Distinct turns / multi-decision turns | 5 / 0 |
| Malformed state_json / selection_json | 0 / 0 |
| Skipped candidate entries | 0 |
| First / last recorded | 2026-09-18T21:31:17.516Z … 2026-09-18T21:32:34.940Z |
| Lane picks (method=choice) | 2 |
| Picks resolved as unknown family | 0 |
| Picks missing from the shortlist | 0 |
| Lane proposals / executions | 0 / 0 |
| Proposal / execution candidate mismatches | 0 / 0 |
| Provider pick turns / extra calls | 2 / 2 |
| Alignment compared / same id / same family / divergent / unknown | 2 / 2 / 0 / 0 / 0 |
| Confirmations approved / rejected / pending | 0 / 0 / 0 |
| Confirmations other / not required / unknown | 0 / 0 / 0 |
| Approved but not executed | 0 |

### Per-family table

| Family | Advertised | Reach | Act | Confirm | Fallback | Defer | Defer rate | Picks | Signal mean | Signal median | Committed | Advisory act | Awaiting confirm | Other uncommitted | Lane proposals | Lane executions | Approved | Rejected | Pending | Approved not executed | Provider compared | Same id | Same family | Divergent | Alignment unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| srd-check | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| inventory | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| commerce | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| power | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| rest | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-consumable | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-power | 5 | 100.0% | 2 | 0 | 3 | 3 | 60.0% | 2 | 0.870 | 0.870 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 0 | 0 | 0 |
| quest-lifecycle | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| quest-objective | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| progression | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| unknown | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Provider alignment: compared 2; same id 2 (100.0%); same family 0 (0.0%); divergent 0 (0.0%); family unknown 0 (0.0%)

## World: `.velvet/synth-srd-3`

Database: `/home/mojo/projects/velvet-mvp/.velvet/synth-srd-3/velvet.sqlite`

### Totals

| Metric | Value |
| --- | --- |
| Decisions | 7 |
| Shadow decisions | 7 |
| Decisions with a shortlist | 7 |
| Decisions without a shortlist | 0 |
| Decisions with an unjoined turn | 0 |
| Distinct turns / multi-decision turns | 7 / 0 |
| Malformed state_json / selection_json | 0 / 0 |
| Skipped candidate entries | 0 |
| First / last recorded | 2026-09-19T15:51:35.837Z … 2026-09-19T15:54:05.311Z |
| Lane picks (method=choice) | 2 |
| Picks resolved as unknown family | 0 |
| Picks missing from the shortlist | 0 |
| Lane proposals / executions | 2 / 1 |
| Proposal / execution candidate mismatches | 0 / 0 |
| Provider pick turns / extra calls | 3 / 3 |
| Alignment compared / same id / same family / divergent / unknown | 0 / 0 / 0 / 0 / 0 |
| Confirmations approved / rejected / pending | 1 / 1 / 0 |
| Confirmations other / not required / unknown | 0 / 0 / 0 |
| Approved but not executed | 0 |

### Per-family table

| Family | Advertised | Reach | Act | Confirm | Fallback | Defer | Defer rate | Picks | Signal mean | Signal median | Committed | Advisory act | Awaiting confirm | Other uncommitted | Lane proposals | Lane executions | Approved | Rejected | Pending | Approved not executed | Provider compared | Same id | Same family | Divergent | Alignment unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| srd-check | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| inventory | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| commerce | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| power | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| rest | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-consumable | 5 | 71.4% | 2 | 0 | 3 | 3 | 60.0% | 2 | 0.920 | 0.920 | 1 | 1 | 0 | 0 | 2 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-power | 7 | 100.0% | 2 | 0 | 5 | 5 | 71.4% | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| quest-lifecycle | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| quest-objective | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| progression | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| unknown | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Provider alignment: compared 0; same id 0 (—); same family 0 (—); divergent 0 (—); family unknown 0 (—)

## World: `.velvet/synth-srd-4`

Database: `/home/mojo/projects/velvet-mvp/.velvet/synth-srd-4/velvet.sqlite`

### Totals

| Metric | Value |
| --- | --- |
| Decisions | 3 |
| Shadow decisions | 3 |
| Decisions with a shortlist | 3 |
| Decisions without a shortlist | 0 |
| Decisions with an unjoined turn | 0 |
| Distinct turns / multi-decision turns | 3 / 0 |
| Malformed state_json / selection_json | 0 / 0 |
| Skipped candidate entries | 0 |
| First / last recorded | 2026-09-19T18:50:31.779Z … 2026-09-19T18:52:05.983Z |
| Lane picks (method=choice) | 1 |
| Picks resolved as unknown family | 0 |
| Picks missing from the shortlist | 0 |
| Lane proposals / executions | 1 / 1 |
| Proposal / execution candidate mismatches | 0 / 0 |
| Provider pick turns / extra calls | 1 / 1 |
| Alignment compared / same id / same family / divergent / unknown | 0 / 0 / 0 / 0 / 0 |
| Confirmations approved / rejected / pending | 1 / 0 / 0 |
| Confirmations other / not required / unknown | 0 / 0 / 0 |
| Approved but not executed | 0 |

### Per-family table

| Family | Advertised | Reach | Act | Confirm | Fallback | Defer | Defer rate | Picks | Signal mean | Signal median | Committed | Advisory act | Awaiting confirm | Other uncommitted | Lane proposals | Lane executions | Approved | Rejected | Pending | Approved not executed | Provider compared | Same id | Same family | Divergent | Alignment unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| srd-check | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| inventory | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| commerce | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| power | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| rest | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-consumable | 3 | 100.0% | 1 | 0 | 2 | 2 | 66.7% | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-power | 2 | 66.7% | 1 | 0 | 1 | 1 | 50.0% | 1 | 0.960 | 0.960 | 1 | 0 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| quest-lifecycle | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| quest-objective | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| progression | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| unknown | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Provider alignment: compared 0; same id 0 (—); same family 0 (—); divergent 0 (—); family unknown 0 (—)

## World: `.velvet/emberwake-reach-run2`

Database: `/home/mojo/projects/velvet-mvp/.velvet/emberwake-reach-run2/velvet.sqlite`

### Totals

| Metric | Value |
| --- | --- |
| Decisions | 108 |
| Shadow decisions | 108 |
| Decisions with a shortlist | 107 |
| Decisions without a shortlist | 1 |
| Decisions with an unjoined turn | 0 |
| Distinct turns / multi-decision turns | 108 / 0 |
| Malformed state_json / selection_json | 1 / 0 |
| Skipped candidate entries | 0 |
| First / last recorded | 2026-09-17T15:29:04.216Z … 2026-09-18T05:05:49.317Z |
| Lane picks (method=choice) | 11 |
| Picks resolved as unknown family | 0 |
| Picks missing from the shortlist | 0 |
| Lane proposals / executions | 1 / 5 |
| Proposal / execution candidate mismatches | 0 / 0 |
| Provider pick turns / extra calls | 29 / 8 |
| Alignment compared / same id / same family / divergent / unknown | 3 / 3 / 0 / 0 / 0 |
| Confirmations approved / rejected / pending | 1 / 0 / 0 |
| Confirmations other / not required / unknown | 0 / 0 / 0 |
| Approved but not executed | 0 |

### Per-family table

| Family | Advertised | Reach | Act | Confirm | Fallback | Defer | Defer rate | Picks | Signal mean | Signal median | Committed | Advisory act | Awaiting confirm | Other uncommitted | Lane proposals | Lane executions | Approved | Rejected | Pending | Approved not executed | Provider compared | Same id | Same family | Divergent | Alignment unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| srd-check | 107 | 99.1% | 7 | 4 | 96 | 96 | 89.7% | 5 | 0.602 | 0.560 | 4 | 0 | 1 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| inventory | 101 | 93.5% | 7 | 4 | 90 | 90 | 89.1% | 1 | 0.680 | 0.680 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| commerce | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| power | 89 | 82.4% | 6 | 2 | 81 | 81 | 91.0% | 1 | 0.740 | 0.740 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| rest | 13 | 12.0% | 2 | 2 | 9 | 9 | 69.2% | 2 | 0.740 | 0.740 | 1 | 1 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |
| combat-consumable | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| combat-power | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| quest-lifecycle | 101 | 93.5% | 7 | 4 | 90 | 90 | 89.1% | 2 | 0.570 | 0.570 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| quest-objective | 27 | 25.0% | 5 | 0 | 22 | 22 | 81.5% | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| progression | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| unknown | 0 | 0.0% | 0 | 0 | 0 | 0 | — | 0 | — | — | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Provider alignment: compared 3; same id 3 (100.0%); same family 0 (0.0%); divergent 0 (0.0%); family unknown 0 (0.0%)

### Anomalies

- 1 decision(s) have a malformed state_json: 19d4da11-052f-4c78-823a-c472d4f02575

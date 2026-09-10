# Plan 3: Inspectable, measured memory

Status: implemented; deterministic gates accepted. Optional matched live reading-quality comparison was not dispatched.

Prerequisites: [Plan 1](plan-1-campaign-readiness.md) and
[Plan 2](plan-2-reviewed-adventure.md) accepted, with committed observation oracles.
Follow [the shared execution protocol](playability-execution.md).

## Outcome

Explain what context a real dispatch was prepared to use, reproduce recall failures,
and ship the smallest measured improvement that helps play without weakening
source authority, privacy, or context limits. Do not preselect embeddings, a graph
database, or a rolling-summary framework.

Required deliverables: safe persisted-context inspector, versioned evaluation
corpus/runner, before-and-after report, and at least one justified runtime
improvement. If no candidate meets its gate, record this plan as incomplete rather
than adding complexity just to close a checkbox.

## Research decisions

- [Framework evaluation](memory-framework-evaluation.md) compares SQLite, LangGraph,
  Mem0, Graphiti/Zep, and Letta. Velvet already owns orchestration and authoritative
  storage. Framework memory does not automatically enforce actor knowledge,
  campaign timelines, or receipt authority.
- [Context and memory research](campaign-memory.md#sources-read) supports selective
  context, retained original sources, temporal/abstention evaluation, and separating
  retrieval from model reading. Vendor/benchmark gains are not Velvet targets.
- [SQLite FTS5](https://sqlite.org/fts5.html) supplies lexical indexing, not semantic
  memory. Its external-content consistency and shadow-table requirements matter to
  Velvet's exact-schema validator. Global BM25 statistics can change public ranking
  when hidden records change; an index must not defeat privacy-before-ranking.

## Baseline to preserve

`campaignRecallReadRepo.ts` performs authorized literal search across persisted
intent, noncanonical presentation, authored recaps, and verified outcomes. Current
limits: 12 terms, 64 materialized matching records, eight whole hits, 2,048 bytes per
source text, and 6,144 bytes per recall packet. Recent exchanges are separately two
whole pairs/4,000 bytes. SQL scan work is not bounded by those output limits.

Current state, safety, and committed results retain priority. Do not search private
data then filter top-K, treat source prose as instruction, resurrect a sibling
timeline, or turn NPC claims into facts. Narrative retries must not duplicate a
mechanical event. Missing evidence is not proof that an event never occurred.

## Inspector design

Start with an **owner/GM-only diagnostic** in the Director drawer. No private or
player inspector is implicitly shipped. A later player view needs its own explicit
projection and tests; do not expose this endpoint based on a UI role toggle.

Proposed GET:
`/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/context-inspection/:lane/:dispatchId`.
Freeze lane/identifier semantics in P3.1 against the real tables; this is not yet an
endpoint. Use one exact dispatch, not unbounded history or a general search API.

| Lane | Existing durable evidence |
| --- | --- |
| Adventure planning | `agent_provider_contexts_v39` joined to provider call/settlement |
| Adventure narration | `adventure_narration_contexts` joined by `claim_id` to narration dispatch |
| Director planning | `dm_runs`, `dm_dispatches`, and bound `dm_provider_requests` |
| Director narration | `dm_narration_jobs` and `dm_narration_dispatches` |

A recorded request is not proof the provider received it. Show recorded phase,
dispatch certainty, and settlement status separately. Missing sidecars/unsupported
versions yield provenance unavailable. Never reconstruct history by rerunning recall.
Do not call work/recovery getters that can mutate state when serving inspection.

Project a bounded safe DTO, not raw prompts or database JSON. Show authorized source
labels/links, retained order, authority type, bounded text, and known omissions.
Do not expose credentials, unrestricted harness strings, private tool arguments,
raw/normalized query, query hashes, hidden candidates/counts, or scope digests.
Current authorization and source visibility still apply to historical text. Withhold
unverifiable or newly private sections; do not substitute current text and imply it
was sent historically. Inspection does not upgrade declaration or prose authority.

Account separately for stored recall-packet UTF-8 bytes, stored message-content
bytes, serialized stored-request bytes, safe displayed bytes, and reported versus
reserved tokens. Do not add overlapping totals or call stored JSON the final HTTP
wire body. Withhold totals that reveal restricted sections. Only explain omission
reasons actually recorded; `incomplete` is not an exhaustive exclusion ledger.

No inspector payload in browser persistence or telemetry. GET/reload/navigation
must create no provider call, domain mutation, or recovery transition.

## Evaluation contract

Each golden case has independently reviewed expected source IDs or source-construction
keys, graded relevance, authority labels, actor/audience/purpose, timeline/revision,
query, duplicate groups, supported facts, forbidden inferences, and byte budget.
Keep development cases separate from holdouts. Plan 2 incidents supply examples,
not the entire test distribution.

Measure the production retriever and actual packing, not a mock replacement:

- Required-source Recall@K and packed Recall@8; hydration and packing loss where
  instrumentation can establish them without exposing private data.
- MRR/nDCG from reviewed relevance grades, stable ordering, empty-result/no-filler
  behavior, and legitimate multi-source evidence versus duplicated execution.
- Privacy, actor/timeline isolation, revoked visibility, immutable source labels,
  current-versus-historical state, failed attempts, and false premises.
- Full serialized bytes, oversized-record handling, candidate saturation, safety
  preservation, and deterministic replay.
- Representative latency at fixture scale plus 100/1,000 distractions; record machine,
  corpus, warm/cold conditions, and p50/p95. Output caps are not scan-work bounds.

False-premise questions can require corrective evidence, not empty hits. Do not
reward an empty answer merely because a premise is false. Unknown history must not
be narrated as "that never happened".

Set improvement thresholds before coding: exact target failures, minimum useful
gain, permitted latency/cost change, and unchanged mandatory negatives. Source
authorization/canonical tests have zero tolerated violations. Do not retrofit the
oracle, remove hard holdouts, or relax budgets to make a candidate pass.

## Milestones

P3.1 and P3.2 may run in parallel with disjoint files. After contracts freeze, reader
and UI body work may be parallel, but one integration owner controls barrels,
repository facade, routes, API wiring, and parent components. Milestone commits
must remain buildable; contracts/test scaffolding precede production consumers.

### P3.1: Inspector contract and read policy

Own: new `packages/contracts/src/campaign-context-inspection-http.ts`, its test,
contracts export, and new `docs/context-inspection.md` with index entry.

Deliver: finite four-lane selector, exact dispatch identity rules, unavailable and
withheld states, bounded sections/text, distinct byte/token units, and GM-only
authorization policy. Proposed maximum eight displayed recall hits and 24 KB safe
response; verify metadata fits or return explicit omission. No new persistence.

Gate: strict DTO tests for unknown fields/versions, caps, unavailable provenance,
and reported-versus-reserved units. No raw request/query field. Run contracts test,
typecheck, and `npm run build --workspace @velvet/contracts` before consumers.
Commit: `feat(contracts): define context inspection projection`.

### P3.2: Golden corpus

Own: new `server/test/fixtures/memory-evals/` files. Assign an independent reviewer
exclusive ownership of a separate `holdouts.ts`; do not let an implementer relabel
its expected results while tuning retrieval.

Deliver: cases from Plan 2 plus independent old promises/outcomes, current-state
updates, private matches, wrong actor/timeline, false premises, no-match, Unicode,
retries, overlarge records, and packing pressure. Record which alias/pronoun cases
are expected baseline misses rather than pretend support exists.

Gate: fixture construction uses isolated production repositories, deterministic
IDs/clocks, persisted-source assertions, and reopen. Reviewer confirms independent
labels and no real campaign secrets. Run fixture validation/server typecheck.
Commit: `test(memory): add reviewed recall evaluation corpus`.

### P3.3: Offline evaluator and baseline

Own: new `scripts/evaluate-campaign-memory.ts`,
`scripts/test/evaluate-campaign-memory.test.ts`, and narrow evaluation helpers.
Integration owner updates scripts commands/typecheck scope if needed.

Deliver: network-free runner measuring source selection, ranking, actual packing,
scope failures, and repeatable latency. Preserve baseline artifacts with code,
corpus, budget, and policy digests. Do not log private production packets.

Gate: known perfect/imperfect synthetic rankings produce correct metrics; storage
reorder does not change semantic results; packet limits and negatives are measured.
Run evaluator tests and scripts typecheck. Record one gated candidate for P3.7.
Commit: `feat(eval): measure campaign recall quality and cost`.

### P3.4: Inspector ledger reader

Own: new `server/src/repo/campaign/campaignContextInspectionReadRepo.ts` and
`server/test/campaign-context-inspection.test.ts`.

Implement the four adapters as separate small subagent assignments in sequence,
or give separate files to parallel owners. One owner assembles the common reader.
Read existing `adventureTurn/agentResponseProvenance.ts` and `campaignDmRepo.ts`.

Gate: exact ledger binding, owner/GM authority before payload access, no mutation
or recall call, current-visibility withholding, missing/old record handling,
correct byte accounting, and source links only for authorized evidence. Test
expired/unknown/failed dispatch without triggering settlement. Run new tests plus
affected recovery tests/server typecheck.
Commit: `feat(repo): inspect persisted context without replay`.

### P3.5: HTTP transport and UI

Split into two serial assignments. Integration owner first wires the read facade,
static GET route, strict client API, tests, and actual API inventory. UI owner then
adds a bounded Inspector panel accessible from a selected run/turn; retain map and
conversation. Do not invent dispatch IDs from a turn ID: add a bounded authorized
selection reference only if current public run/turn data cannot identify a dispatch,
and document that additive contract before implementation.

Own: new route/client panel/test files; assign existing `server/src/repo/index.ts`,
`server/src/repo/campaign/campaignTypes.ts`,
`server/src/repo/campaignRepositoryOrchestration.ts`,
`server/src/routes/rpg/v1/features.ts`, `client/src/api.ts`,
`client/src/components/rpg/play/CampaignDmPanel.tsx`, and `client/src/App.tsx`
to the integration owner only. `server/src/features.ts` is the distinct flag reader,
not the route-registration target; do not edit it unless a new flag is approved.

Gate: feature/path/role checks, no-store, no provider dispatch, late-response
discard, authority downgrade clears display, safe unavailable state, mobile
readability and keyboard access. Run owning tests/typechecks and docs drift.
Commits: `feat(api): expose safe context inspection`, then
`feat(ui): explain context used by a selected dispatch`.

### P3.6: Select one improvement

Use P3.3 results and the table below. Save target cases, holdouts, thresholds,
files, expected dependency/schema changes, and rollback strategy in the progress
ledger before assigning P3.7. This is a decision checkpoint, not permission for
the subagent to implement every option. Commit its documented decision.

| Candidate | Gate and required safeguards |
| --- | --- |
| Lexical, projection, or packing correction | Reproduced loss/duplication/labeling defect; exact regression and held-out improvement at unchanged privacy and byte limits |
| FTS5 acceleration | Measured scan latency exceeds the predeclared target; shipped SQLite support verified; source reauthorization, rebuild/consistency, exact schema including shadow tables, safe literal query construction, and hidden-corpus-independent ranking |
| Entity aliases | Existing explicit authorized alias data or separately approved authored relation; no same-name conflation or private-identity expansion |
| Pronoun resolution | Unique authorized recent referent demonstrably improves holdouts; ambiguity/absence abstains; no cross-actor guesses |
| Semantic retrieval | Material paraphrase misses survive cheaper fixes; explicit supported embedding endpoint/model or approved local embedder, dimensions/source digests, privacy and cost budget; chat API is not an embedding API |
| Source-linked summaries | Measured packing pressure; source references, corrections/negation/attribution retained; invalidation/rebuild and deterministic fallback; no summary-of-summary canon or hidden background billing |

### P3.7: Implement and measure the chosen change

Own only the files recorded by P3.6. Keep the baseline evaluator and holdout labels
unchanged. If schema changes are required, create a separate first subtask and
commit for exact predecessor upgrade, validation-before-commit, rollback, durable
data preservation, and build assets. Never ignore unknown tables to accommodate FTS.

Gate: targeted failure fixed, predeclared holdout gain, unchanged mandatory
privacy/canonical/no-match tests, stable recovery, budgets and measured latency/cost
within target. Otherwise revise the candidate, not the oracle; do not declare done.
Run affected tests and owning typechecks. Commit: `feat(memory): <measured improvement>`.

### P3.8: Integrated report

Own: new context-inspection E2E, existing memory E2E if affected, relevant memory,
inspection, operations, roadmap, and handoff docs.

Gate: browser reads exact recorded evidence, not reconstructed recall; no paid call
on load/inspect/reload; actor/privacy boundaries and safe missing provenance;
before/after metrics and real limitations recorded. Run focused browser tests and
owning typechecks. Optional live reading-quality comparison must stay inside the
shared remaining API budget and use first attempts, not best-of-retries.

Commit: `docs(memory): record inspected context and recall improvement`.
Close all three plans only with their completion evidence, commit IDs, honest live
validation status, and remaining limitations in the execution ledger.

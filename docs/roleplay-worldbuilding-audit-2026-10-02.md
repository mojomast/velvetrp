# Roleplay and worldbuilding audit — 2026-10-02

## Implemented

- **Prompt to prepared world:** an 11-stage serial plan covers all 14 generation sections, including locations/routes, factions, cast, opening/arcs, story/clues, quests, enemies, special items, encounters, lore, handouts and scenes. Exact accepted references connect stages. Locations precede the opening so its start can bind to real canon.
- **Coverage and integrity:** optional `desiredCounts` supplies bounded minimums. Server checks count coverage after cleanup, reference kinds at staging and apply, NPC locations and quest objectives. Complete single-request worlds and region packs use directed reachability; the default builder also checks return routes and public map visibility.
- **Recovery:** exact requests and apply intents survive tab reload. Interrupted calls reconcile before retries; rejected unapplied candidates can be explicitly revised. Navigation pauses subsequent stage writes. Completed runs can begin another world. CLI sparse-apply recovery schedules missing content consistently and startup blockers remain retryable.
- **Workflow:** searchable/filterable campaign library, inline generation that survives library refresh, and explicit handoffs to world editing and room preparation.
- **Roleplay:** conservative declaration fallbacks distinguish actual attempts from questions, speech, negation and hypothetical actions. Clearly routine observation advertises neither check candidates nor raw dice rolls. Original social turns use grounded conversational narration, an explicit co-located NPC roster and bounded disclosable NPC knowledge.
- **Continuity:** selected reply branches determine summaries, synthesized context and same-session memories. Recall retains complete multi-receipt Director history and negated observations. Event-time witness propagation excludes known remote NPCs and their factions from verified knowledge.
- **Responsiveness:** room turn shadow/unpromoted Jev calls and record-only advisory lanes no longer block primary generation. Speaker confidence belongs to the selected option; an unavailable deterministic cost route cannot be selected.
- **Interrupted chat:** single-speaker streams reject premature EOF and stop at the first terminal. Canceled/error sends and swipes refresh the saved session transcript, preserve acknowledged user messages, and ignore late results after navigation.

Research rationale and source links are in [backend generation](world-generation-backend-research.md),
[worldbuilding workflow](worldbuilding-workflow-research.md), and [library workflow](world-library-workflow-research.md).
The Flash review used source excerpts fetched by the parent because tool-history replay failed on the proxy;
the successful synthesis did not perform independent browsing.

## Live free-form evidence

Two fresh throwaway campaigns used DeepSeek V4 Flash through the existing proxy, the same seed and 18 declarations.
The after run preceded the final narrow routine-observation/hold-message polish; those changes have separate regressions.

| Measurement | Baseline | After |
| --- | ---: | ---: |
| Completed turns with narration | 18 | 18 |
| Provider-assisted narration | 11 | 13 |
| Narration failures/fallbacks, excluding deliberate holds | 3 | 1 |
| Successful Director beats | 6/6 | 6/6 |
| Labeled commerce/unknown-NPC/forged-commerce probes | 3/3 | 3/3 |
| Measured location-coherence violations | 0 | 0 |
| Mean turn latency | 17,331 ms | 8,644 ms |
| Median turn latency | 16,513 ms | 8,187 ms |
| Provider calls successful | 56/57 | 54/55 |

Known Maren/Joss conversations produced dialogue in the after run. Mapped travel, a purchase, a quest acceptance,
and a search had authoritative receipts. Unmapped travel no longer committed an unrelated Survival check in this run.
Latency is a single-run observation, not a controlled benchmark. Fewer calls or receipts are diagnostic differences,
not intrinsically worse: receipt-free roleplay is often the correct outcome. Both runs encountered one provider error.

Follow-up one-turn probes found that prompt wording alone still allowed an unnecessary Perception check, and that
the session-wide cast could make a remote NPC appear in the current scene. The final deterministic observation gate
and explicit `presentNpcNames` projection address those findings. The final probe produced provider narration with
no mechanical receipt and omitted the remote goblin scout:
`/tmp/opencode/velvet-astra-presence-final-20261002.json`. The broad 18-turn metrics above are not relabeled as a
fresh full-session result after these last changes.

Local artifacts:

- `/tmp/opencode/velvet-astra-live-before-20261002.json` and `.md`
- `/tmp/opencode/velvet-astra-live-after-20261002.json` and `.md`
- `/tmp/opencode/velvet-astra-jev-20261002.json`: 67 successful Jev requests, no false acts, 48 deferred positive cases;
  this did not justify promotion or lower confidence thresholds.

## Live world-generation evidence

The default plan generated and applied all 14 sections in an isolated campaign:
**125 accepted artifacts** — 6 factions, 8 locations, 18 directed routes, 1 opening, 4 arcs, 8 NPCs,
11 story nodes, 12 story relationships, 10 clues, 6 quests, 7 monster concepts, 6 quest items,
6 encounters, 8 lore entries, 6 handouts and 8 scene prompts. The opening binds to the accepted
`cormorant-light` location. Every applied stage passed its count and world-link checks.

Ten of eleven stages succeeded on their first attempt. The final table-material attempt was rejected;
read-only reconciliation confirmed a terminal failure, and one explicitly acknowledged retry completed it.
Previously accepted stages were not regenerated or reapplied. Total: 12 provider calls, 191,548 tokens.
Artifact: `/tmp/opencode/velvet-world-live-recovered-20261002.json`; the failed attempt is retained in
`/tmp/opencode/velvet-world-live-v2-20261002.json`.

An earlier run exposed a GM-only map location; the client rejected it before application. After tightening
the default map instructions, the complete run passed public visibility and directed outward/return checks.
Capability-scoped catalog projection reduced faction prompts from 63,271 to 1,843 tokens and location
prompts from 64,340 to 2,787 tokens in these runs. Item and enemy stages still receive their exact catalogs.

## Validation

Heavy suites and browser runs were serialized, with file parallelism disabled for the server, client and contracts.

- **Contracts:** 473 tests across 74 files passed.
- **Client:** 1,033 tests across 93 files passed, including interrupted stream recovery and staged worldbuilding.
  After visual refinements, the 38 builder/library tests and client typecheck passed again.
- **Server checkpoint:** all 388 files ran serially: 4,274 passed, 8 failed, 1 skipped. The failures exposed outdated
  expectations, missing documentation-index entries, and observation regressions while implementation was settling.
  After correction, all 209 tests in the nine affected/related files passed. The final NPC-presence prompt refinement
  then passed 89 tests in four affected files. The full 40-minute server checkpoint was not repeated.
- **Scripts:** 45 affected evaluator/hydration tests passed.
- **Types:** root typecheck passed, covering contracts, server, client, E2E and scripts; server typecheck also passed
  after the final presence refinement. Client production build and final E2E typecheck passed.
- **Browser:** five selected deterministic flows passed with one worker: critical browser/API workflows, receipted
  travel across reload, opening designation on desktop/mobile, and the complete generated-world recovery/handoff.
  The latter uses reviewed fixtures through real server validation/application and verifies no duplicate generation
  after a lost response. Its visual rerun passed after fixing light-theme contrast and form/stage layout, with desktop
  light/dark and 390px screenshots inspected.

Validation logs and live artifacts are retained under `/tmp/opencode/velvet-*20261002*`.

## Documentation follow-up

The follow-up documentation review corrected stale 11-section generation claims,
API count fields and planning projections, startup blocker/retry behavior, narration
authority, local NPC presence, provider compatibility/rejection handling, and the
working-tree handoff. README.md was rebuilt around the strongest product features,
quick start, a first-adventure walkthrough, optional media, current screenshots,
development commands and explicit implementation limits. Its worldbuilder screenshot
comes from the deterministic browser flow, not the live-provider world.

The focused documentation drift suite passed all seven checks, including maintained
local links/anchors, guide indexing, the 177-operation API inventory, and environment
classification. This documentation pass does not constitute a new runtime or live
evaluation checkpoint.

## Remaining boundaries

- Prepared content is distinct from a started room: characters, room attachment and startup/readiness still need preparation.
- A catalog-bound item/monster concept neither grants inventory nor spawns combat. Live NPC attack declarations still
  did not initiate combat in the evaluator fixture, and its short-rest declaration did not commit a rest receipt.
- Structural coverage cannot establish narrative quality, balanced encounters or all possible free-form actions.
- Recovery is tab-scoped client orchestration, not a cross-device background job service. Pending advisory records can be
  lost on process shutdown. Previously stored false-witness memories are not retroactively rewritten.
- Legacy chat reconciliation is a snapshot, because that stream family has no durable settled-operation endpoint.
  A server operation still exiting can finish after the read; durable RPG turns retain their separate recovery contract.
- Location-coherence metrics inspect known locations and receipts; zero findings is not proof that all prose is correct.

All evaluation worlds used isolated temporary storage. The implementation and documentation are included in this delivery; no deployment was performed.

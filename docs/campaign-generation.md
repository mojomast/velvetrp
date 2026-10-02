# Campaign generation and expansion

Campaign generation is an additive API. It never edits accepted generated artifacts in place; staging and application are separate requests.

The client offers three directions: **Foundation** requests an outline, locations/connections, factions, NPCs, and quests; **Full narrative campaign** requests all 14 supported sections in one prompt; and **Custom / granular** retains independent section selection. A full request is still only one dependency-linked draft and is never auto-applied.

The campaign library also offers **Generate world**. Its **Build world** action explicitly authorizes an 11-stage workflow covering all 14 sections: each stage generates, validates coverage and links, then applies before the next stage starts. The tab retains progress and exact request identities; interrupted work reconciles before resuming. **Manage world** opens the editor and **Prepare to play** opens room preparation. See [worldbuilding workflow](worldbuilding-workflow-research.md).

## Generate, manage and prepare to play

1. Open the campaign library and choose **Generate world**. Enter a world name and premise, review the tone/exclusions, then choose **Build world**. New campaigns receive SRD 5.1 starter setup before generation. Generation requires the campaign, mechanics and combat features and a configured compatible provider.
2. Keep the builder open while its stages run. Each successful stage becomes accepted content before the next stage begins; library refresh preserves the mounted builder. The default plan is:

   | Stage | Minimum new artifacts |
   | --- | --- |
   | Factions | 4 factions |
   | Locations | 6 locations, 10 directed connections |
   | Foundation | 1 outline, 3 arcs |
   | Cast | 6 NPCs |
   | Story | 8 story nodes, 6 relationships, 5 clues |
   | Quests | 5 quests |
   | Enemies and monsters | 4 monster concepts |
   | Items | 4 quest-item concepts |
   | Encounters | 5 encounter plans |
   | Lore | 6 lore entries |
   | Table material | 3 handouts, 4 scene prompts |

3. If interrupted, use the displayed reconciliation/recovery action. Known drafts are read before any retry. Confirmed failed attempts need an explicit paid retry; an unapplied candidate rejected by the builder can use **Generate revised stage**. Navigating away pauses further stage writes, and the same tab can recover its saved journal after reload.
4. Choose **Manage world** to edit and inspect the accepted world. After all planned stages are confirmed applied, **Prepare to play** opens room preparation. Create/finalize a character, attach the room, and satisfy the existing activation/startup requirements there.
5. A completed run can start another world without deleting its accepted content. Find saved campaigns through library search, role/status filters, and updated/name ordering; publication status alone does not establish play readiness.

The default builder validates a public opening bound to an accepted location, located NPCs, actionable quests, and public maps with directed outward and return reachability. Its advanced JSON plan supports custom scope and minimums. The backend's all-14-section gate applies to one complete request; staged builds rely on the builder's additional checks across accepted stages. Structural coverage does not certify narrative quality or a started room.

## Section candidates

`POST /api/rpg/v1/campaign-content-drafts` accepts any nonempty combination of:

- campaign outline/spine;
- arcs;
- locations and optional location connections;
- factions;
- NPCs;
- quests;
- encounter concepts;
- clues/discoveries;
- story nodes and relationships;
- typed campaign-native lore;
- quest-item concepts;
- monster concepts;
- handouts; and
- scene prompts.

For provider-free hydration, the same request may include `reviewedContent` containing the strict candidate object. The server still checks requested sections, dependency closure, visibility, catalog pins, and idempotency, then stages it as a `reviewed-api` generation attempt. It is not applied automatically; use the normal draft apply endpoint after review.

The provider response is sparse: unrequested sections must be empty. A faction, NPC, quest, clue, lore entry, concept, handout, or scene prompt does not need an opening or a location graph. Stable lowercase-hyphen keys can reference another candidate or an accepted artifact named in `expandArtifactKeys`. Candidate, objective, and reward keys must be globally unambiguous. Strict local Zod parsing, requested-section checks, duplicate-key checks, missing-reference checks, graph-cycle checks, self-connection checks, transitive public-to-GM dependency checks, objective-DAG checks, and the provider adapter's strict JSON Schema response format run before staging. Critical graph, visibility, objective, and catalog-pin checks run again inside apply.

A full 14-section request must contain at least one artifact in each section, a public starting location with outward directed reachability to every new public location, located NPCs, and actionable quests before it can be staged, including reviewed API content. Granular requests retain sparse behavior. Optional `desiredCounts`, keyed by preview array names, imposes minimum new counts within existing array caps and requested sections. Positive NPC targets require location keys; positive quest targets require objectives. Counts are checked after tolerant cleanup and belong to the request's idempotency identity, including reconciliation. See the [API count table](api.md#campaign-content-requests-and-coverage) for exact field mappings and caps. These are structural checks, not literary-quality or campaign-solvability guarantees.

Expansion keys are resolved server-side to accepted canon, its immutable digest, source draft, and any materialized server resource ID. Only public accepted content is sent back to the provider; a GM-only dependency remains an opaque key. The draft captures both the campaign-content revision before the provider call and exact dependency digests. `derivativeContextKeys` exposes that immutable base in the review view. Regeneration with `expandArtifactKeys` plus `revisionFeedback` creates an additive derivative draft; it never edits the accepted source artifact. Apply fails closed if either the content revision or a dependency digest is stale.

Public expansion filtering is field-sensitive: faction `gmNotes`, NPC `privateGoals`, and GM-only quest objectives/rewards are omitted even when the enclosing accepted artifact is public. Filtering never modifies the immutable accepted source.

Campaign text, accepted canon, tone, exclusions, and revision feedback are framed as untrusted quoted data in the provider request. Instructions embedded in any of those values are explicitly non-authoritative. The primary dispatch uses strict JSON Schema with `toolChoice: "none"`. If the provider returns a matching HTTP 400 capability error, the adapter makes one compatibility fallback dispatch using a schema-shaped output function with `toolChoice: "auto"`; its arguments pass through the same parsing and validation. This function is output transport, not an executable campaign tool. Logical request identity uses recursively key-sorted canonical JSON before SHA-256 hashing, so object property order does not alter identity.

Candidate GET/POST responses omit faction GM notes and NPC private goals. They do not expose provider prompts, credentials, principals, hidden goals, or provider-call records.

## Region packs

`POST /api/rpg/v1/campaigns/:campaignId/region-packs` replaces multiple separate generation requests for an opening or quest area with one coherent region pack: one generation attempt and exactly one atomic apply. The output-format compatibility fallback described above can add a second provider dispatch within that attempt. The body is strict and bounded:

- `idempotencyKey`;
- `brief` (<=2000), optional `tone` (<=200), optional `exclusions` (<=16);
- optional `anchorLocationKey`, an already-accepted public location artifact key;
- `locationCount` (4..16); and
- optional `linked` hints (`npcs`, `quests`, `clues`, `storyNodes`, `factions`, `encounters`).

The internal sections are fixed to `outline`, `locations`, `factions`, `npcs`, `quests`, `clues`, and `story`. `linked.encounters === true` additionally requests the `encounters` section; the other hints are advisory coverage prose, and every section is still requested in the same single call.

The server composes the region brief, then runs the same parse -> sanitize -> validateContent pipeline as campaign-content generation and calls `validateRegionPack` fail-closed before staging. The region validator additionally requires:

- at least four and at most sixteen new public locations, at most twenty-four connections, at most 128 applied keys, and at least `locations - 1` connections;
- exactly one outline whose `startLocationKey` is one of the new pack locations (self-anchoring), unless the campaign already designates an immutable starting location, in which case `anchorLocationKey` is required and at least one connection must reach it;
- every connection endpoint in-pack or equal to the supplied accepted anchor, with no self-connections and no duplicate directed `(from, to)` pairs;
- directed reachability from the designated start or required accepted anchor to every new location; return travel needs explicit reverse connections; and
- every `npc.locationKey`, `quest.locationKeys`, and `clue.locationKey` resolving in-pack or to accepted canon.

Locations and connections in the pack must be public; GM-only opening-area geography is rejected. When anchoring to existing canon the server passes the accepted `anchorLocationKey` through `expandArtifactKeys`, so the provider sees that one public artifact and nothing else private. A validation or provider failure writes no draft, no accepted artifact, and no starting location; there is no automatic second paid request.

On success the 201 response carries the applied draft projection, the applied artifact keys, the content receipt, and the designated `startLocation` (`artifactKey`, `locationId`, `name`). If the campaign already designated a start, it is never re-anchored: the existing immutable designation is reported unchanged. An exact replay on the same `idempotencyKey` converges on the existing draft and apply receipt without a second provider call. Because the requested `locationCount` is a hard upper bound, a caller that asks for many locations in one call trades provider reliability for breadth; a smaller `locationCount` (for example six to eight) is the conservative operating range.

## Review and application

`POST /api/rpg/v1/campaign-content-drafts/:draftId/apply` requires:

- the exact staged draft revision;
- a distinct idempotency key; and
- a nonempty `selectedArtifactKeys` list.

References must close over the selected set or accepted canon. The transaction records immutable accepted-key provenance and materializes selected locations, connections, factions, NPCs, arcs, quests, story nodes, story relationships, and clues into their standard domains. Generated quests now write their bounded objectives, objective dependencies, visibility, rewards, and journal text to v33, so normal quest reads and adventure objective candidates consume the applied content. Generated story material is created as a complete immutable v34 storyline graph in the same outer apply transaction, with normal story command/event/receipt/revision provenance and stable server IDs. Relationships must select both endpoint nodes in that graph. A clue may name a selected source node; a standalone clue receives a bounded hidden source node because v34 requires every clue to have one source. Outline start locations are designated only when the selected outline references an accepted or selected location.

An exact apply replay returns the original durable result only when both its idempotency key and ordered selection match. A different key or selection fails closed. `GET /api/rpg/v1/campaigns/:campaignId/generated-foundation` reads the latest accepted public outline immediately after apply.

## Planning and player delivery

`GET /api/rpg/v1/campaigns/:campaignId/generated-planning` is the GM planning projection for prepared encounter plans, lore, quest items, monster concepts, and generated handouts/scene prompts. Prepared plans include objectives, terrain, escalation, resolution, exact enemy-template references, and resolved same-campaign location/NPC/concept IDs, but no encounter/combat rows or combatants are created.

Quest items and monster concepts use a closed mechanics union. `catalog-bound` requires an exact `{ kind, packId, packVersion, definitionId }` supplied from the campaign's current pinned public catalog. The server verifies it before staging and rechecks the current pin inside apply. If no compatible exact reference exists, the provider must return `inert` with a reason. Inert concepts are narrative planning canon only. No generated stat block, approximate match, provider ID, or newly invented definition crosses into mechanics.

No handout or scene prompt is delivered on apply. A GM explicitly publishes a `public` handout or scene prompt with `POST /api/rpg/v1/campaigns/:campaignId/material-publications`, an expected v53 delivery revision, and an idempotency key. The append-only command/receipt/projection is exact-replay safe. GM-only artifacts cannot be published. `GET /api/rpg/v1/campaigns/:campaignId/published-materials` selects only explicitly published public columns and is the player-safe read used by campaign play.

## Runnable campaign preparation

Current generation prompt `campaign-content-v7` enriches existing artifact fields with runnable preparation, typed-reference, count and directed-route instructions. The wire shape remains `campaign-content-v4`; existing accepted drafts do not need a migration. Its provider-facing catalog includes exact item references only for quest items, and exact enemy-template references only for monsters/encounters; prose-only requests receive no catalog. Entries contain only their exact reference and name. Full server-side catalog validation remains authoritative.

- Public outlines establish stakes and an actionable invitation, not future outcomes.
- GM-only arc summaries describe antagonist agendas, early/middle/final progression, branching consequences, setbacks, transitions, alternative finales and aftermath.
- Public NPC descriptions provide observable voice, mannerisms, conversational stance and sample dialogue. Private goals hold motives, knowledge boundaries, leverage and reactions.
- GM-only scenes provide entry conditions, sensory framing, interaction beats, alternative approaches, escalation, reveal conditions and exit hooks. Essential clues include alternate recovery routes and fail-forward consequences.
- Encounter objectives, terrain, escalation and resolution remain preparation, not established results.
- Running-note components should use concise newline-separated paragraphs under 700 characters within existing field limits. Never mix GM notes into public read-aloud prose, descriptions or location details.

Public labels are a disclosure decision: a reviewer must verify that every public field really is spoiler-free. Structural validation cannot recognize a secret concealed in apparently public prose. A public artifact cannot depend on a GM-only artifact; keep private causal relationships in GM-only scenes rather than linking public quests to secret arcs.

## Live agent context

The server reads only accepted v52 artifacts in the same campaign, validates their stored shape and visibility, and creates a field-whitelisted `publicPreparation` projection. Staged candidates, raw canonical JSON, NPC private goals and faction GM notes are never copied into this projection.

- The latest accepted public outline contributes its premise, not an opening to replay every turn.
- Current public locations contribute descriptions and atmosphere only. For player audiences, the current location must also be discovered by a character controlled by that principal. Discoveries, hazards and hooks are not automatically revealed.
- Present public generated NPCs contribute public portrayal only. GM-only generated NPC names are excluded from the agent's shared visible cast.
- Public lore contributes only when linked to a current visible location and not linked to story nodes or factions whose knowledge would need separate validation.
- Published public scenes must match the current location when specified and have all referenced public NPCs present. Published public handouts may contribute campaign-wide; unpublished materials never do.
- Public arc summaries, hidden story graphs and encounter plans are not indiscriminately added to player context. Normal live quest and mechanical reads remain authoritative.

Selection examines at most 256 accepted preparation artifacts, ordered by outline, location, NPC, then other kinds; within each category, newer artifacts come first with a stable key tie-breaker. It includes whole newline-separated paragraphs of at most 1,000 UTF-16 code units, within a 4,000-unit public preparation budget. Oversized or excess paragraphs are omitted, not sliced. The planning basket has its own 4,000-unit preparation budget and truncation accounting. These limits deliberately do not promise that every accepted artifact fits into every turn.

The same bounded public preparation reaches both the live adventure planner and the separately constructed player narration input. It is labeled as background and possibilities, never committed events or mechanical authority. Narration allows brief in-character dialogue and sensory framing, with a prompt target of 1-3 short paragraphs, at most 8 sentences and 180 words. The existing hard narration transport bound and receipt consistency validation remain in force; sentence/word targets are presentation instructions, not a new parser.

An explicitly owner/GM-authorized **DM snapshot** can additionally include accepted GM arc and relevant scene paragraphs in private planning facts, bounded to 2,000 units before the existing private-target budget. This is not handed to the player narrator. NPC audiences retain their existing target-goals authority; they do not receive campaign-wide GM plans.

The existing adventure orchestrator still selects player or enemy mechanical contexts; it is separate from the implemented [campaign director](ai-dungeon-master.md). The adventure lane does not automatically consume the DM snapshot's secret plans, autonomously advance scenes, start combat, reveal story nodes, publish materials, or execute finales. The director can propose supported encounter and story transitions through server-issued candidates, exact human approval or explicit AI delegation, and authoritative domain execution. Scene resolution requires qualifying bound evidence or exact human adjudication; named objective/encounter bindings are prepared in the GM Director drawer. Neither lane turns GM-only preparation into public narration automatically. Generated preparation does not add tools, bypass confirmation, create rewards or change authoritative state. Durable adventure-turn deadlines, provider/tool-call limits and token/cost budgets remain unchanged.

## Paid-call idempotency and retries

One v52 generation job owns `(campaignId, idempotencyKey, requestDigest)`. A concurrent exact request does not call the provider: it waits for the durable winner for a bounded interval, then returns that draft or a conflict. Reusing the key with different generation direction remains an idempotency conflict.

A failed provider attempt is terminal. It is not silently repeated. To retry the same logical request, the caller must send `retryFailedAttempt: { failedAttempt: N }`, where `N` is the current failed attempt. A stale acknowledgement conflicts. Every retry gets a separate attempt row while retaining the same logical job and request digest.

The narrow HTTP 400 output-format fallback described above happens within one generation attempt. Other provider or candidate-validation failures do not trigger a replacement generation automatically.

The provider call remains outside campaign-domain transactions. Validated draft, dependencies, candidate, and terminal success are staged atomically; application uses a separate short immediate transaction. Expired running attempts are settled lazily as `outcome-uncertain` after a fixed ten-minute lease. Provider-free reconciliation can recover an existing candidate, but cannot prove whether an uncertain provider call was charged. No recovery automatically repeats paid generation.

## Provider observability

Each attempt records the logical job ID and attempt number, provider, requested model, provider-response model, operation/stage, prompt/schema version IDs, token usage, latency, terminal outcome, and retry count through the job attempt number. Estimated cost is:

`(prompt tokens × configured prompt price + completion tokens × configured completion price) / 1,000,000`

when both configured prices and provider usage are available; otherwise it is `NULL`. One attempt row transitions once from started to terminal, preventing started/terminal double counting. No prompt text, API key, headers, private goals, or hidden campaign state is persisted in observability tables.

## NPC location intent

Selected NPC `locationKey` values resolve only within the same campaign. Application always records a durable placement intent. If exactly one running attached session exists, the transaction writes the normal v43 NPC-presence command/event/receipt/current-state aggregate and marks the intent placed. Otherwise it remains pending. Attaching a session reconciles pending intents only when that leaves one unambiguous running attachment. Multiple or stopped sessions do not guess, and no public projection exposes pending GM-only location intent.

## Deliberate limits

- Generation remains trusted-local owner/GM administration; there is no remote tenant authorization model.
- Applying accepted encounter plans creates planning canon, not combat aggregates, and never starts combat. The separate director may materialize/start eligible catalog-bound plans only through supported candidates and explicit approval or delegation.
- Campaign-native lore and item/monster concepts have typed accepted projections. Lore is narrative canon. Catalog-bound concepts retain exact pin identity but do not themselves grant inventory, spawn enemies, or create encounters. Inert concepts have no mechanical behavior.
- v34 graphs are immutable after creation, so a later generation apply creates a new generated storyline rather than appending nodes to an accepted storyline.
- Concurrent wait is bounded; a long-running or abandoned owner returns a conflict rather than starting another paid call. An operator/caller must explicitly acknowledge a terminal failure before retrying.
- Standalone generated clues receive a bounded hidden source node because v34 requires every clue to have a source.
- Bounded generation, apply, and publication intents are retained in session storage across tab reloads. Recovery requires authoritative reconciliation and explicit actions; the UI never silently replays a provider call or write. This is not cross-device persistence, and candidate previews and reviewed provider content are not stored there.

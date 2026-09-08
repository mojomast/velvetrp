# Campaign generation and expansion

Campaign generation is a reviewed, additive API. It never edits accepted generated artifacts in place and it never applies a provider response automatically.

The client offers three directions: **Foundation** requests an outline, locations/connections, factions, NPCs, and quests; **Full narrative campaign** requests all 14 supported sections in one prompt; and **Custom / granular** retains independent section selection. A full request is still only one dependency-linked draft and is never auto-applied.

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

The provider response is sparse: unrequested sections must be empty. A faction, NPC, quest, clue, lore entry, concept, handout, or scene prompt does not need an opening or a location graph. Stable lowercase-hyphen keys can reference another candidate or an accepted artifact named in `expandArtifactKeys`. Candidate, objective, and reward keys must be globally unambiguous. Strict local Zod parsing, requested-section checks, duplicate-key checks, missing-reference checks, graph-cycle checks, self-connection checks, transitive public-to-GM dependency checks, objective-DAG checks, and the provider adapter's strict JSON Schema response format run before staging. Critical graph, visibility, objective, and catalog-pin checks run again inside apply.

Expansion keys are resolved server-side to accepted canon, its immutable digest, source draft, and any materialized server resource ID. Only public accepted content is sent back to the provider; a GM-only dependency remains an opaque key. The draft captures both the campaign-content revision before the provider call and exact dependency digests. `derivativeContextKeys` exposes that immutable base in the review view. Regeneration with `expandArtifactKeys` plus `revisionFeedback` creates an additive derivative draft; it never edits the accepted source artifact. Apply fails closed if either the content revision or a dependency digest is stale.

Campaign text, accepted canon, tone, exclusions, and revision feedback are framed as untrusted quoted data in the provider request. Instructions embedded in any of those values are explicitly non-authoritative. Provider tool use remains disabled with `toolChoice: "none"`. Logical request identity uses recursively key-sorted canonical JSON before SHA-256 hashing, so object property order does not alter identity.

Candidate GET/POST responses omit faction GM notes and NPC private goals. They do not expose provider prompts, credentials, principals, hidden goals, or provider-call records.

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

No generated material is delivered on apply. A GM explicitly publishes a `public` handout or scene prompt with `POST /api/rpg/v1/campaigns/:campaignId/material-publications`, an expected v53 delivery revision, and an idempotency key. The append-only command/receipt/projection is exact-replay safe. GM-only artifacts cannot be published. `GET /api/rpg/v1/campaigns/:campaignId/published-materials` selects only explicitly published public columns and is the player-safe read used by campaign play.

## Paid-call idempotency and retries

One v52 generation job owns `(campaignId, idempotencyKey, requestDigest)`. A concurrent exact request does not call the provider: it waits for the durable winner for a bounded interval, then returns that draft or a conflict. Reusing the key with different generation direction remains an idempotency conflict.

A failed provider attempt is terminal. It is not silently repeated. To retry the same logical request, the caller must send `retryFailedAttempt: { failedAttempt: N }`, where `N` is the current failed attempt. A stale acknowledgement conflicts. Every retry gets a separate attempt row while retaining the same logical job and request digest.

The provider call remains outside campaign-domain transactions. Draft/candidate persistence and application use short immediate transactions.

## Provider observability

Each attempt records the logical job ID and attempt number, provider, requested model, provider-response model, operation/stage, prompt/schema version IDs, token usage, latency, terminal outcome, and retry count through the job attempt number. Estimated cost is:

`(prompt tokens × configured prompt price + completion tokens × configured completion price) / 1,000,000`

when both configured prices and provider usage are available; otherwise it is `NULL`. One attempt row transitions once from started to terminal, preventing started/terminal double counting. No prompt text, API key, headers, private goals, or hidden campaign state is persisted in observability tables.

## NPC location intent

Selected NPC `locationKey` values resolve only within the same campaign. Application always records a durable placement intent. If exactly one running attached session exists, the transaction writes the normal v43 NPC-presence command/event/receipt/current-state aggregate and marks the intent placed. Otherwise it remains pending. Attaching a session reconciles pending intents only when that leaves one unambiguous running attachment. Multiple or stopped sessions do not guess, and no public projection exposes pending GM-only location intent.

## Deliberate limits

- Generation remains trusted-local owner/GM administration; there is no remote tenant authorization model.
- Accepted encounter plans are planning canon, not combat aggregates, and are never automatically started.
- Campaign-native lore and item/monster concepts have typed accepted projections. Lore is narrative canon. Catalog-bound concepts retain exact pin identity but do not themselves grant inventory, spawn enemies, or create encounters. Inert concepts have no mechanical behavior.
- v34 graphs are immutable after creation, so a later generation apply creates a new generated storyline rather than appending nodes to an accepted storyline.
- Concurrent wait is bounded; a long-running or abandoned owner returns a conflict rather than starting another paid call. An operator/caller must explicitly acknowledge a terminal failure before retrying.
- Standalone generated clues receive a bounded hidden source node because v34 requires every clue to have a source.
- Ambiguous generation and apply intents are retained in component memory. Reloading requires authoritative reconciliation or a new explicit operator action; the UI never silently replays a provider call or write.

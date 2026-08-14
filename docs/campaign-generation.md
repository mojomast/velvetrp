# Campaign generation and expansion

Campaign generation is a reviewed, additive API. It never edits accepted generated artifacts in place and it never applies a provider response automatically.

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
- handouts; and
- scene prompts.

The provider response is sparse: unrequested sections must be empty. A faction, NPC, quest, clue, handout, or scene prompt does not need an opening or a location graph. Stable lowercase-hyphen keys can reference another candidate or an accepted artifact named in `expandArtifactKeys`. Candidate keys must be new. Strict local Zod parsing, requested-section checks, reference checks, and the provider adapter's strict JSON Schema response format run before staging.

Expansion keys are resolved server-side to accepted canon, its immutable digest, source draft, and any materialized server resource ID. Only public accepted content is sent back to the provider; a GM-only dependency remains an opaque key. The draft captures both the campaign-content revision before the provider call and exact dependency digests. Apply fails closed if either is stale.

Candidate GET/POST responses omit faction GM notes and NPC private goals. They do not expose provider prompts, credentials, principals, hidden goals, or provider-call records.

## Review and application

`POST /api/rpg/v1/campaign-content-drafts/:draftId/apply` requires:

- the exact staged draft revision;
- a distinct idempotency key; and
- a nonempty `selectedArtifactKeys` list.

References must close over the selected set or accepted canon. The transaction records immutable accepted-key provenance and materializes selected locations, connections, factions, NPCs, arcs, quests, story nodes, story relationships, and clues into their standard domains. Generated story material is created as a complete immutable v34 storyline graph in the same outer apply transaction, with normal story command/event/receipt/revision provenance and stable server IDs. Relationships must select both endpoint nodes in that graph. A clue may name a selected source node; a standalone clue receives a bounded hidden source node because v34 requires every clue to have one source. Generated quests and story therefore appear immediately in standard reads. Outline start locations are designated only when the selected outline references an accepted or selected location.

An exact apply replay returns the original durable result only when both its idempotency key and ordered selection match. A different key or selection fails closed. `GET /api/rpg/v1/campaigns/:campaignId/generated-foundation` reads the latest accepted public outline immediately after apply.

## Planning and player delivery

`GET /api/rpg/v1/campaigns/:campaignId/generated-planning` is the GM planning projection for inert encounter concepts and generated handouts/scene prompts. Encounter references are resolved to same-campaign location and NPC server IDs, but no encounter/combat rows or combatants are created.

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
- Accepted encounter concepts are planning canon, not prepared combat aggregates and never automatically started combat.
- v34 graphs are immutable after creation, so a later generation apply creates a new generated storyline rather than appending nodes to an accepted storyline.
- Concurrent wait is bounded; a long-running or abandoned owner returns a conflict rather than starting another paid call. An operator/caller must explicitly acknowledge a terminal failure before retrying.
- Standalone generated clues receive a bounded hidden source node because v34 requires every clue to have a source.
- Ambiguous generation and apply intents are retained in component memory. Reloading requires authoritative reconciliation or a new explicit operator action; the UI never silently replays a provider call or write.

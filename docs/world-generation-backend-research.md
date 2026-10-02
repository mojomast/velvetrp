# World generation: backend findings and guarantees

Research and implementation review: 2026-10-02.

## Source-grounded design

- Justin Alexander, [Don't Prep Plots](https://thealexandrian.net/wordpress/4147/roleplaying-games/dont-prep-plots): prepare situations, factions/NPC resources and motivations, and multiple ways to discover necessary information rather than a compulsory sequence of player choices. His [node-based design discussion](https://thealexandrian.net/wordpress/7985/roleplaying-games/node-based-scenario-design-part-3-inverting-the-three-clue-rule) distinguishes accessible leads from a predetermined plotted route. **Project application:** branching locations and independent hooks; actionable quest objectives; GM-only agendas, recovery clues and alternative consequences. A particular number of routes is design guidance, not a universal mechanical invariant.
- Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): simple prompt chains with programmatic intermediate gates trade latency for accuracy on decomposable tasks; external state provides ground truth. **Project application:** existing section generation, accepted artifact keys, immutable receipts, and serial stage/application checks support progressive world hydration. A generated response is only a candidate until validated and applied.
- OpenAI, [Introducing Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/) and [structured output guide](https://developers.openai.com/api/docs/guides/structured-outputs): JSON validity alone does not guarantee schema adherence; structured output constrains shape but still needs handling for refusals/interruption and semantic mistakes. **Project application:** sparse section schemas carry array minimums and maximums; application validation independently checks counts, typed references, visibility, graph reachability and catalog membership. Provider tool fallback retains the same local validation.

## Existing project architecture

`campaignContentGeneration.ts` supports 14 independently generatable sections, represented by 16 artifact arrays. It supplies public accepted canon, mandatory session-zero policy, rules identity and exact pinned item/enemy references. `campaignGenerationRepo.ts` persists accepted candidates and materializes locations/connections, NPC baseline stats and placement intents, factions, operational quest objectives/rewards, story graphs and GM planning projections. Public handouts and scene prompts require publication. Narrative item/monster concepts remain inert unless exactly catalog-bound; even bound concepts do not award inventory or start combat.

Region packs already validate public locations, bounds, anchoring and graph connectivity. Investigation of `world/actorTravelPolicy.ts` established that travel is **directed**: the actor must occupy `from_location_id`. The old undirected region connectivity test could accept a graph with every edge pointing toward the starting actor, leaving no usable departure.

## Implemented contract

`POST /campaign-content-drafts` and its reconciliation request accept optional `desiredCounts`, keyed by preview array name:

```json
{
  "sections": ["locations", "npcs"],
  "desiredCounts": { "locations": 6, "connections": 10, "npcs": 6 }
}
```

Counts are **minimum new candidates**, evaluated after tolerant cleanup. Existing canon does not count. Every value must be an integer from zero through its existing array maximum. Unknown fields and fields outside the requested sections are invalid requests (including an unrequested field with zero). Omission preserves historical sparse generation; zero adds no minimum. Counts participate in canonical idempotency identity, including reviewed/provider-free requests and reconciliation.

| Field | Maximum |
| --- | ---: |
| outlines | 1 |
| arcs | 8 |
| locations, npcs, quests, encounters, questItems, monsterConcepts, scenePrompts | 16 |
| connections, clues, storyNodes, lore | 24 |
| factions, handouts | 12 |
| storyRelationships | 32 |

The provider receives requested minimums in both schema `minItems` and server-owned generation guidance. A positive NPC target additionally requires a location on every generated NPC. A positive quest target requires at least one objective on every generated quest. The count-only metadata does not alter durable artifact schemas.

### Capability-scoped catalog context (prompt v7)

Live integration reported approximately 63k prompt tokens even for faction/location-only requests because every request included the entire pinned SRD catalog. Generation now projects the provider-facing catalog according to the output fields that can actually bind mechanics:

- `quest-items` receives only `item` references.
- `monster-concepts` and `encounters` receive only `enemy-template` references.
- Requests combining those sections receive the union; all other sections receive an empty catalog.

Each supplied entry contains only `name` and its exact `{kind, packId, packVersion, definitionId}` reference. Descriptions and canonical/stat-block payloads are excluded. All relevant references are retained without truncating identifiers or selecting an arbitrary top-N subset. Campaign rules profile/ruleset identity is preserved separately. The shared candidate builder applies this projection to both injected generation and the configured-provider/fallback paths.

The full server catalog remains available to validation and apply-time pin checks; projection neither changes installed content nor manufactures bindings. Labels are a compact selection index, not evidence of mechanical compatibility: uncertain concepts should remain inert, as the prompt explicitly directs. Generation attempt metadata advances to `campaign-content-v7`; the artifact schema stays `campaign-content-v4`.

Focused regression cases cover faction/location and other nonmechanical requests, item-only and enemy-only capabilities, combined capabilities, exact reference/rules identity preservation, omission of large payloads, and non-mutation of server catalog context. This follow-up's tests/typecheck/live calls are intentionally left to the parent session's serialized gates.

### Semantic gates

- Typed references resolve to the correct kind, not merely an existing key. Location, faction, NPC, arc, quest, story-node and monster-concept links are checked against generated candidates and exact accepted dependency kinds. The repository repeats kind validation over the selected set and accepted canon before domain writes. Tolerant generation drops wrong-kind links instead of reinterpreting them; subsequent count/coverage checks still apply.
- Explicit all-14-section requests require every section, a public outline with a new public starting location, directed public reachability from that start to every new public location, NPC placements and actionable quests. Sparse requests without targets remain valid without these whole-world requirements.
- Region packs now validate directed reachability from their actual designated start or required accepted anchor, rather than from the first array entry or through synthetic reverse edges. Prompts explain separate reverse connections for intended return travel.
- Exact item/enemy reference membership, public/private dependency separation, objective dependency validation and atomic materialization remain enforced. No mechanical effects are inferred from prose.

## Limits and integration responsibilities

- Counts establish bounded coverage, not narrative quality, uniqueness of ideas, useful clue redundancy, or a guarantee that every public description is spoiler-free. Existing visibility boundaries and GM/public projections still matter.
- Multi-stage worldbuilding must choose accepted context keys and verify durable stage results. The backend's full-world graph gate applies to a single all-14 request; it does not retrospectively certify a union of separate sparse requests. A foundation generated before locations cannot designate a future key. The orchestration layer must arrange/start-anchor the location stage appropriately.
- Directed reachability guarantees access from the start, not a return path from every destination. Reverse edges should be generated where the design requires return travel; no hardcoded three-route rule is imposed.
- Legacy region-pack `locationCount` retains its established upper-bound behavior (at least four locations); the new `desiredCounts` minimum semantics belong to campaign-content generation requests.
- `expandArtifactKeys` remains capped at 16; apply selections remain capped at 128. Large worlds require bounded staged requests rather than setting every array to its maximum in one request. No migrations or new autonomous paid retries were introduced.
- Rejected provider candidates follow the existing generic generation failure/reconciliation flow. Under-delivery cannot stage or apply a partial success. Per-field public diagnostic receipts are a possible future improvement.

## Deterministic validation

Focused contract tests cover count types, caps, unknown/unrequested fields and legacy omission. Generation tests cover sparse schema minimums, count under-delivery, post-cleanup counts, idempotency, wrong-kind candidate/accepted references, apply-time rollback, public starts, directed reachability, NPC placement and quest objectives. Region tests include inward-only edges and wrong-start/accepted-anchor directionality. Existing generation recovery and catalog-binding tests cover the surrounding materialization boundary. Broader integration/typecheck gates are coordinated by the parent session.

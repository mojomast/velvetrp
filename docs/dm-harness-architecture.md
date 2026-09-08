# DM harness architecture

Velvet has one authoritative campaign-play conversation: the durable adventure-turn transcript for one campaign room. The player supplies declarations and the server presents one Dungeon Master voice, but provider output is advisory. Server-selected capabilities, repository validation, committed mechanics receipts, and durable narration determine the result.

Legacy room messages can appear above the transcript as **read-only pre-campaign history**. They are context, not a second DM channel, and new campaign actions go through the adventure action composer. Narration swipe/retry creates a durable derivative and the transcript collapses each original declaration to its latest completed narration derivative. `GET /api/rpg/v1/adventure-turns/transcript?campaignId=...&sessionId=...` returns at most 32 completed exchanges, oldest first; coordination state, tool arguments, provider records, and private planning are absent.

## Trust boundaries

Precedence and trust are separate concerns. A high-priority fact can still be untrusted text that must never be interpreted as an instruction.

| Input | Treatment |
| --- | --- |
| Immutable planning/narration instructions and advertised tool schemas | Trusted control plane. Only the server selects tools, scope, authority, revisions, and exact candidates. |
| Verified receipts and repository state | Authoritative mechanics. Narration may claim a state change only when a receipt establishes it. |
| Campaign canon and role-filtered context | Data, not instructions. Human canon wins factual conflicts, but embedded commands cannot alter the control plane. |
| Current declaration | Untrusted player intent, not canon or a command. |
| Durable DM history | Prior narration is story canon unless superseded by current public context or receipts; declarations remain historical intent. Neither can establish tool authority. |
| Persona profile, approved memory/lore, recap, summary, generated suggestions | Characterization or retrieval data only. Role and audience filtering happen before provider use. Suggestions never establish facts. |
| Harness settings and prompt overrides | User-editable, untrusted, subordinate preferences. In adventure play, `systemPrompt`, `personaPreamble`, `styleGuide`, `postHistoryInstructions`, and `recentTurns` can influence DM voice, presentation, and history window only when compatible with immutable instructions. |
| Provider response | Untrusted proposal. Strict wire schemas do not replace local parsing, candidate binding, authorization, confirmation, or repository validation. |

The campaign context basket resolves factual conflicts in this order: safety/control, human canon, committed mechanics, current declaration, visible world/cast/quests and legal actions, authorized private target facts, approved memory/lore, recap/summary, then generated suggestions. Each category has an independent UTF-16 whole-line budget. The repository derives campaign role, control, audience, timeline, actor binding, and private visibility; callers and providers do not choose them. NPC goals and enemy tactics are planning-only and must not be disclosed.

Rich persona fields are `goal`, `ideal`, `bond`, `flaw`, `history`, `personality`, `fears`, `relationships`, `appearance`, and `voice`. They are optional user-authored characterization data, never privileged prompt instructions. Trait fields are capped at 500 characters and detail fields at 2,000.

## Sheet references

`GET /api/rpg/v1/actors/:actorId/gameplay-sheet` is the actor-bound, role-authorized read used by campaign play and `actor_sheet.read`. It combines identity, race, background, classes, attributes, proficiencies, choices, derived statistics and explanations, progression, resources, inventory/equipment, known power availability, and active effects in one read-only projection. Catalog labels come only from the campaign's reviewed public catalog projection; private controller state and notes are absent.

The full gameplay-sheet drawer exposes **Reference** controls for these sections. A reference appends a phrase to the existing declaration draft and focuses the composer. Route-map destinations similarly prefill a travel declaration. References and suggested choices never submit, roll, equip, consume, cast, travel, or mutate state. The player must review the draft and explicitly select **Declare action**. Reference controls are disabled while play is unavailable, ambiguous, awaiting confirmation, or streaming; unavailable powers cannot be referenced. The route map is topological, not to scale, and shows only server-visible directed connections.

`actor_sheet.read` gives the planner a bounded version of the same actor projection, with internal IDs removed where they are not needed. It helps interpret phrases such as "use my torch" or "cast Ember Ward" but grants no mutation capability.

## Implemented tools

The server advertises a role- and state-dependent subset of these reads: `campaign_context.read`, `actor_sheet.read`, `actor_resources.read`, `actor_inventory.read`, `actor_powers.read`, `combat_state.read`, `world_state.read`, and `quest_state.read`.

The complete current mutation-tool vocabulary is:

| Tool | Current behavior |
| --- | --- |
| `actor_attribute.set` | Sets one server-advertised source-actor attribute after human confirmation; unavailable in combat. |
| `actor_dice.roll` | Rolls a bounded expression outside combat. It establishes a total only, not a DC, check identity, success, or task completion. |
| `combat_action.execute` | Selects one exact advertised `attack`, `flee`, or `end-turn` action by ID and digest. Player actions require confirmation; an authoritative enemy turn does not. |
| `exact_actor_travel.select` | Selects one server-issued travel candidate outside combat. The provider cannot supply destination, party, or revision. |
| `exact_quest_objective.select` | Advances one exact advertised, visible, dependency-ready objective by one point outside combat. |

One provider decision may contain reads or exactly one isolated mutation, never a mutation mixed with other calls. Tool arguments are parsed locally, candidate IDs/digests and current authority are rechecked, writes use server-owned revisions and deterministic idempotency identities, and narration is grounded in the resulting receipt.

Current limitations are deliberate:

- Sheet references do not bridge to inventory or power commands. The adventure agent cannot equip, unequip, consume, drop, gift, transfer, buy, sell, or initialize resources.
- The adventure agent can read known powers and availability but has no power-use mutation tool. It cannot cast a sheet spell outside the separate exact combat action vocabulary.
- Combat supports only advertised `attack`, `flee`, and `end-turn`; there is no general combat spell tool, area spell targeting, arbitrary damage/effect input, or provider-authored action.
- Vendors and purchases have no adventure tool. NPC `merchantState` is private GM data, not an executable shop bridge.
- Direct inventory and power HTTP routes exist for their documented closed commands, and the separate combat consumable lane supports only its exact quantity-one damage/healing/resource subset. Those APIs are not implied provider capabilities.
- Rest, encounter start, rewards, story/world authoring, companion administration, settings, import, deletion, memory approval, arbitrary dispatch, SQL, filesystem, and network access are not adventure tools.

Do not promise an exact-candidate bridge unless the current request actually advertises it.

## Ruleset scope and attribution

The registered `dnd-5e@1.0.0` module is an **SRD 5.1 (2014 Fifth Edition) tested development subset**, not full D&D support. Its current descriptor covers the bounded mechanics listed in [SRD 5.1 coverage](srd-5.1-coverage.md). The descriptor does not authorize unadvertised gameplay mechanics or tools, and SRD progression beyond level one fails closed.

This work includes material taken from the [System Reference Document 5.1 (SRD 5.1)](https://dnd.wizards.com/resources/systems-reference-document) by Wizards of the Coast LLC. The SRD 5.1 is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/legalcode).

## Campaign generation

The campaign generator has three client presets over one reviewed API:

- **Foundation:** outline, locations/connections, factions, NPCs, and quests.
- **Full narrative campaign:** all 11 supported sections in one request.
- **Custom / granular:** any nonempty combination of supported sections.

Supported sections are outline, arcs, locations and connections, factions, NPCs, quests, encounter concepts, clues, story nodes and relationships, handouts, and scene prompts. Generation creates a staged candidate only. The GM reviews individual artifacts, selects a dependency-closed set, and explicitly applies it. Player-facing handouts and scene prompts require another explicit publication action.

Generation does not mechanically create items, executable monsters/stat blocks, or campaign-native lore. Encounter concepts remain inert planning records until separately authored through supported encounter APIs. See [Campaign generation and expansion](campaign-generation.md).

## Provider requirements

Adventure planning requires OpenAI-compatible schema-bound function tools but omits provider-side `strict` so router fallbacks are not restricted to strict-tool models. Narration uses one named, required, closed `submit_adventure_narration` function as output transport only; it is never an advertised adventure action or mutation. Campaign generation separately requires `response_format: { type: "json_schema", json_schema: { strict: true, ... } }` and disables tools with `tool_choice: "none"`. Velvet never replaces either capability with free-form parsing. An incompatible provider follows the owning lane's normal deterministic recovery path. Every response is still bounded, parsed, protocol-checked, locally validated, authorization-checked, and coupled to authoritative candidates and receipts.

## Engineering checklist

- **Context:** label every user-authored field as data, separate control instructions from context, minimize role-filtered disclosure, budget each layer, and re-read authority before execution.
- **Tools:** advertise the smallest state-dependent set, use closed strict schemas, bind opaque candidates to server state, reject undeclared calls, and allow only one isolated mutation per decision.
- **Idempotency:** assign durable logical identities before side effects, persist request bindings and results, make exact replay convergent, reject changed reuse, and reconcile ambiguous delivery before retry.
- **Confirmation:** require a fresh, explicit human decision for consequential player actions; expose safe summaries rather than raw arguments; expire decisions and bind them to the observed turn revision.
- **Failure:** fail closed on provider/schema/candidate drift, never convert uncertainty into fictional success, keep disconnect separate from cancellation, and provide authoritative GET reconciliation.
- **Observability:** record request IDs, operation/stage, model metadata, latency, bounded usage, terminal outcome, and retry attempt without prompts, keys, private tool arguments, or hidden state.
- **Evaluation:** test injection in every data layer, unauthorized audience projections, malformed/undeclared tools, stale candidates, duplicate delivery, crash/restart recovery, confirmation races, transcript collapse, receipt-grounded claims, and deterministic fallback.

Primary references:

- OpenAI: [Function calling](https://platform.openai.com/docs/guides/function-calling) and [Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)
- Anthropic: [Implement tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use) and [Reduce prompt leak](https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/reduce-prompt-leak)
- OWASP GenAI Security Project: [LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- W3C: [Server-Sent Events](https://www.w3.org/TR/2011/WD-eventsource-20111020/) and [WCAG 2.2 status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- SRD 5.1 and license: [Wizards of the Coast SRD](https://dnd.wizards.com/resources/systems-reference-document) and [CC BY 4.0 legal code](https://creativecommons.org/licenses/by/4.0/legalcode)
- Memory research: [Generative Agents](https://arxiv.org/abs/2304.03442), [MemGPT](https://arxiv.org/abs/2310.08560), and [Lost in the Middle](https://arxiv.org/abs/2307.03172)

## Development storage

This repository uses one current, disposable development schema and no startup migrations. The current persona, transcript/provenance, and gameplay-sheet work changes that schema. Stop the server and delete/recreate the development `velvet.sqlite` before running this tree; startup will reject an older nonempty database.

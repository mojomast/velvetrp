# Customizable harness notes

Velvet exposes every registered model-prompt layer through a typed template registry and prompt studio.

## Editable via `GET/PUT /api/harness`

- `personaPreamble` — extra persona-layer instructions (≤500 chars).
- `systemPrompt` — an editable system-message layer for scene behavior, narrative perspective, formatting, initiative, and response guidance (≤64,000 chars).
- `styleGuide` — voice, pacing, formatting, narration preferences (≤900 chars).
- `postHistoryInstructions` — final instruction layer before recent dialogue (≤700 chars).
- `recentTurns` — short-term verbatim window (clamped 4–32).
- `memoryChars` (200–3000), `summaryChars` (200–2000), `loreChars` (200–2000) — context budgets.
- `temperature` — provider sampling override (0–2), `null` = provider/preset default.

The default profile is tuned for long-context models such as DeepSeek V4 Flash: 32 recent messages, 2,400 memory characters, 1,600 summary characters, 1,600 lore characters, and temperature 0.8. Episode summaries cover dialogue that has fallen out of the recent-message window, retaining the first four and latest eight archived events when a session grows longer.

The editable text fields are sanitized (`sanitizeInjectionText`) and passed through `checkUserMessage` on `PUT`. The current policy stub allows every check, so these calls do not presently produce `422` policy violations. Settings persist as a single JSON row in the `settings` table of `data/velvet.sqlite`; reads merge stored values over defaults so new fields are forward-compatible.

## Prompt Studio

All generation instructions are registered in `server/src/promptTemplates.ts` and visible through `GET /api/prompt-templates`. The registry defines defaults, descriptions, and an allowlist of non-evaluating `{{placeholder}}` tokens. Overrides persist in `HarnessSettings.promptOverrides`; missing overrides always fall back to current defaults. Every registered layer is editable and individually resettable from the prompt studio.

The registry contains 20 layers covering character safety/persona/constraints/custom system/style/lore/memory/shared-context/post-history/final layers, provider start-reply instructions, room router system/user prompts, first and follow-up room turns, single and room continuation, and `scene.synthesizer.system`/`scene.synthesizer.user`. Dynamic participant cards, history, memory, lore, shared basket, speaker names, replies, manual canon, prior scene state, and recent synthesis input remain runtime placeholders rather than copied static text.


Character history is sent with one server-added `[Name]` attribution. Repeated leading labels previously emitted by a model are removed from prompt history, and buffered generated replies are normalized before persistence. This prevents label multiplication such as `[Aria] [Aria]` while leaving ordinary bracketed prose intact. Streaming keeps emitted deltas and persisted text identical, so its primary protection is the final-turn contract.

Approved memory is inserted as durable known context with instructions to use it naturally, avoid mentioning the memory system, and avoid asking the user to repeat known details. Explicit `remember that ...` commands are approved immediately; natural name and preference disclosures remain pending. Generic cast-memory requests snapshot recent character-authored details for each routed participant. Active duplicates are suppressed case-insensitively.

The shared-context layer is computed for every generation from highest-priority editable manual canon, synthesized current scene facts, all session participants, recent active-branch events, approved memories across the cast, triggered lore, and unresolved questions/goals. When a usable provider is configured, a completed generated turn or room round invokes the synthesizer with immutable manual canon, prior synthesized state, and recent active-branch messages. It rewrites categorized current facts without copying dialogue; manual canon wins conflicts. The final-turn contract also discourages consecutive “I” sentence openings, treats `*emotes*` as concise physical action beats rather than mandatory opening decorations, and requires awareness of other participants' positions, actions, moods, relationships, and open threads.

## Campaign context

The server-internal campaign context basket is not exposed through `/api/harness`, a prompt-template layer, or an RPG wire contract. At the current **v45r1**, **97-operation** boundary, M5.1 presence remains the cast authority. Wave A has delivered repository-only M5.2 companion administration, M5.3 combat-health Slice 0 and a non-live consumable contract prerequisite, and pure M5.4/M5.5 protocol checkpoints; none adds a harness or provider execution surface. The basket's exact conflict precedence is: safety/control; human canon; committed mechanics; the exact final user declaration; visible world/cast/quests and legal actions; authorized private target facts; approved memory/lore; recap/summary; generated suggestions. When supplied to legacy player/NPC generation, it replaces the ordinary triggered-lore, retrieved-memory, and shared-context prompt blocks so those retrieval sources are not duplicated. Generations without campaign context keep the existing 20-layer behavior.

Campaign safety/control, human canon, world, mechanics/legal actions, quests, private target facts, recap/summary, lore, memory, and suggestions use independent UTF-16 code-unit budgets. Assembly normalizes budgeted facts to whole lines, includes or omits each line deterministically, never splits surrogate pairs, never borrows across categories, and records exact truncation metadata. The final declaration is separately limited to 8,000 UTF-16 code units and is rebound unchanged to the final session turn.

Audience visibility is repository-derived from current role/control and campaign/session/target ancestry in one deferred snapshot. Cast context includes only persisted present NPCs for a running attached session, with each optional location included only when visible to that role. Stopped-session at-stop cast history is historical and never prompt-current; neither campaign-roster membership nor presence makes an NPC a legacy session participant or autonomous speaker, and the full roster is never inferred to be present. Full catalogs, full inventories, story graph dumps, hidden routes, controller identities, and unrelated private facts are excluded. NPC goals and enemy tactics are planning-only and protected by a non-overridable higher-precedence nondisclosure rule. Legacy campaign generation accepts only a player or NPC basket bound to the exact server-derived speaker persona and session; DM/enemy baskets fail closed there, and companion context still fails closed because repository administration does not deliver grant exercise, routes/client behavior, or campaign-context integration.

M4.2 composes this disclosure boundary into production adventure turns through a role-selected bounded provider loop and deterministic command bridge. The orchestrator selects exact server-derived player or enemy context, keeps provider calls outside repository transactions, and uses deterministic recovery after provider failure; it does not bypass the campaign basket's audience, ancestry, budget, or nondisclosure restrictions.


## Client

The chat treats the viewport as its application area. **Prompt & settings** opens an independently scrolling right pane with a pointer- and keyboard-resizable separator; width is persisted in local storage and the pane becomes a full-screen drawer on narrow displays. The pane exposes all template layers, harness text/context fields, model/base URL, streaming, timeout, samplers, reasoning, stop strings, routing controls, provider metadata, and input/output USD-per-million token prices. It reports whether an API key exists but never displays the key. The chat also exposes lifetime usage/cost breakdowns separately from active-branch tokens.

## Current limitation

- Prompt assembly reads all context budgets from harness settings; prompt presets (`default`, `compact`, `immersive`) currently contribute only their `temperature` fallback (`harness.temperature ?? preset.temperature`). Preset budgets are not wired into `buildOrchestratedMessages`.

## Build Later / Planned

- Bounded per-session harness overrides are planned for Build Later in the roadmap; they are not shipped. The persisted harness currently applies globally.

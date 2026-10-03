# Campaign Control Plane

The default campaign play surface is the **Adventure Table**. Campaign preparation
and authoring retain their own destinations; entering play removes the full campaign
rail and management toolbar so the story and next action occupy the table.

## Adventure Table

- **One story:** public Director openings and continuations join the durable player
  turn transcript in chronological order. Private Director proposals stay in the
  Director tool. Prior non-campaign room messages are labelled read-only history.
- **Story / Map:** both tab panels remain mounted when switching views. The map,
  draft, and tool controllers keep their state. A single composer serves both views;
  **Send action** returns to Story and submits through the existing durable turn path.
- **Primary tools:** **Character**, **Journal** (accessible name **Field journal**),
  and **Dice** are directly available. Character also leads to **Inventory & equipment**
  and **Advancement**.
- **Table tools:** a native modal dialog exposes **Director**, **Travel**,
  **Combat & rewards**, **Help**, and role-appropriate **GM tools**, **Rules & safety**,
  **Create character**, and optional **Scene images**. It also contains Director/startup
  status, **Replay this session**, voice controls when available, **Display**, and the
  campaign-destination selector.
- **First action:** **Look around**, **Introduce myself**, and **Find a lead** prepare
  editable intentions. If the composer already contains text, **Append suggestion**,
  **Replace declaration**, or **Cancel** preserves the player's choice. Suggestions,
  including map and combat suggestions, never submit themselves.
- **Combat:** a compact bar reports round/turn or terminal encounter status. **End
  turn** prepares a declaration; **Review encounter completion** opens the existing
  combat review/recovery controller. The Adventure Table bar does not directly finish
  an encounter or run an enemy turn.
- **Display:** desktop provides a reading area above the composer and a compact
  location/character companion. The companion is hidden at 900px and below while the primary
  tools remain available. At 600px and below, story, notices, and composer use natural
  page flow instead of a fixed-height multi-column workspace.

The Story/Map tabs use roving focus: Left/Right changes and activates the tab,
Home selects Story, and End selects Map. Tab enters the selected tab and then
continues through the remaining controls. **Skip to your action** reaches the composer;
`F6` and `Shift+F6` cycle visible
play regions, and `?` outside text fields opens Help. Native dialogs and modal tool
drawers support Escape/Close. Tool closure restores the invoking control;
**Back to draft** selects Story and focuses the composer.

See the [Adventure Table design audit](adventure-table-design-2026-10-03.md) for
implementation references, research, accessibility review criteria, and current
[play screenshots](../README.md#screenshots).

## Campaign library and worldbuilding

With campaign features enabled and no saved navigation, the application opens
**Campaigns & worlds**. Existing navigation is restored; opening a campaign from the
library enters its next-step overview.

**Campaigns & worlds** provides name search, role/lifecycle filters, and recently
updated or alphabetical sorting. Lifecycle reads are bounded and isolated per card;
an unavailable status does not hide the campaign or imply it is ready to play.

**Generate world** opens the builder inline. **Build world** authorizes an 11-stage
serial generate → validate → apply workflow covering all 14 sections. Locations
precede the opening; later stages use exact accepted public keys. The default plan
checks counts, public directed outward/return routes, NPC locations, actionable
quests, and the opening's binding. The library refreshes after creation without
unmounting the builder or moving focus away from its progress.

The builder retains exact generation/apply requests and starter-setup state in a
tab-scoped journal. Reload reconciles known drafts; failed paid attempts and revised
unapplied candidates have explicit recovery actions. Navigating away pauses later
stage writes. **Manage world** opens world editing; **Prepare to play** becomes
available after the plan is applied and opens room preparation, where character,
room and activation requirements still apply. A completed run can build another
world without deleting accepted content. See [campaign generation](campaign-generation.md)
for the step-by-step workflow and stage minimums.

## Room readiness and entry

Overview presents **Your next step**, **Sessions**, and the party roster. **Continue
preparation** opens the existing setup flow. **Go to Sessions** moves focus to the
session list; having a party and room is guidance, not proof of readiness.

For eligible owner/GM room cards, authoritative activation readiness is read
automatically on mount and window focus. **Check room readiness** remains available.
Blockers link to preparation, a public starting location, or character building.
**Start room** is explicit; after its activation receipt is confirmed, another GET
must establish current readiness before **Enter adventure** becomes available.

An uncertain activation keeps the original request and idempotency key. Automatic
reads never replay it or clear that pending state. **Retry exact room start** recovers
the receipt using the saved command. If activation succeeds but the following GET
fails, retry the readiness read. An already active, ready room with no pending local
command can be entered without obtaining another activation receipt.

## Preparation Readiness

**Table tools → Director** includes an owner/GM-only, explicit `Inspect preparation`
read. Its private report separates existing activation readiness from bounded
preparation diagnostics, coverage, awaiting evidence, and manual-review limits.
It neither starts a scene nor asserts campaign solvability. The panel is not
persisted in browser storage, does not own command recovery, clears when its
campaign/room/role identity changes, and discards delayed responses.

## Implemented Milestone

The normal campaign entry now uses dedicated Overview, Rooms, Party, and Create
destinations instead of the original campaign-detail page. The original page is
retained as secondary advanced setup for operations not yet migrated.

- Overview reads campaign configuration, party, and attached sessions to explain
  the next preparation step. Focus refresh preserves the visible snapshot and open
  preparation drafts. Configuration is not presented as proof of readiness.
- Preparation now brings starter rules installation, current safety review,
  explicit campaign publication, and room creation/attachment into the new
  workspace. Saving safety does not clear a pause or loosen existing boundaries.
- Rooms automatically reads authoritative activation readiness and explicitly starts
  prepared sessions through the provider-free activation API. Pending commands retain
  their exact keys until receipt recovery; room entry requires a current readiness read.
- Connecting rooms is preparation-only: attaching a room does not change the
  Director mode, publish materials, dispatch a beat, or enqueue images. The
  idempotent campaign startup command is exposed to the client as
  `campaignStartup(campaignId, sessionId)` (`client/src/api.ts`) and is invoked
  by the hydration CLI on the create-and-start path; the preparation attach
  intentionally does not auto-invoke it, so the wizard never mutates a live
  campaign or dispatches provider work during setup. See
  [campaign startup](campaign-startup.md).
- Create offers a questionnaire or scripted interview, explicit brief review,
  generation, candidate inspection, and explicit application. Opening the page does
  not generate content or probe the provider. Publication remains separate.
- Character creation uses Concept/persona, Rules choices, Review, and Ready stages
  while preserving server validation, saves, reconciliation, and finalization.
  Personas can be created inline. An uncertain persona creation retains a browser
  storage lock and offers authoritative identity selection, not an automatic POST
  retry or an assumption based on a matching name.
- The live table defaults to Adventure Table (`surface="story"`). Story and Map stay
  mounted behind modal tools. A saved `playSurface: "atlas"` selects the optional
  legacy Living Atlas; the older multi-column Command Center remains an internal,
  explicit `surface="center"` compatibility/test path.
- Tactical token movement uses selection, authoritative preview, and explicit
  confirmation. Preview does not move a token. A confirmed move survives refresh.
- Combat maps match the selected actor against the active encounter and combat
  roster, independently of the current combatant. Off-turn movement is blocked;
  explicit binding refresh picks up a changed turn before preview and movement.
- Combat-map creation now reviews the full authoritative encounter roster. The DM
  explicitly chooses each combatant's cell, footprint, visibility, and disposition;
  duplicate bindings, overlaps, incomplete reviews, and stale rosters fail closed.
- World, cast, quest, and story screens expose named relationships and contextual
  preparation navigation instead of requiring raw identifiers for routine choices.
- The live table provides reviewed controls to start and complete encounters and to
  take eligible rests. Exact requests are retained for uncertain outcomes, and a
  confirmed revision must be observed before another operation is enabled.
- Active and ready rooms expose `Enter adventure` after the automatic read, unless
  an exact pending activation still needs recovery. Reopening a room does not require
  a duplicate activation receipt from the current browser.
- Adventure Table exposes character, journal, dice, and secondary table tools through
  existing domain controllers. Those controllers own commands and recovery; the shell
  owns presentation, tabs, and tool entry.
  Closing a drawer does not release an unresolved operation lock.
- Embedded combat preserves the room and selected actor and uses the main map,
  rather than mounting a second tactical grid. Ambiguous direct power commands
  reconcile through the existing result read without replaying their POST.
- Background tactical GETs retain the same-map camera and viewport while locking
  commands until current state is confirmed. Authority, viewpoint, and map changes
  clear incompatible projections. Fit, center-token, pan controls, terrain symbols,
  and a text equivalent make navigation discoverable without requiring dragging.
- Generation uses the selected actor's exact persisted world location and revision
  when available. Grounded v2 layouts retain immutable context, reserve spawn
  footprints, and connect walkable areas. Travel mismatches require explicit map
  replacement review, never automatic regeneration. Historical v1 maps still replay
  unchanged; procedural geometry is not a claim of established world canon.
- Help documents actual commands, reviews, receipts, roles, keyboard access, and
  recovery. Press `?` outside text fields to open it, `F6` to cycle regions, and
  `Escape` to close a drawer and restore focus.
- Campaign dice capability is projected by the server. Players may roll only a
  controlled actor when `allowPlayerDice` is enabled; observers and unauthorized
  actors remain denied before server RNG executes.
- Attached rooms with incomplete participants return a valid empty-actor bootstrap
  and visible preparation guidance instead of a malformed-play 500.
- Campaign generation stages the validated draft, dependencies, candidate, and
  terminal success atomically. Expired work becomes outcome-uncertain and is never
  automatically sent to a paid provider again. Bounded authoring intent survives a
  tab reload and can reconcile an existing candidate without another generation.
- Campaign creation now presents a seven-stage assisted wizard: Foundation, Vision,
  Safety, World plan, LLM review, Candidate, and Next steps. The model is called only
  after explicit review; accepted output remains separate from player publication.
- An owner or GM can designate one applied public location as the authoritative
  campaign opening. The immutable designation has strict revision and idempotency
  checks and is read independently from the latest generated outline.
- An empty World response now renders guided room/world preparation instead of a
  blank workspace.
- World, Journal, and Story support the insecure HTTP origin used by the Tailscale
  development address. Client command IDs feature-detect available crypto APIs and
  fall back safely instead of assuming `crypto.randomUUID` exists. A workspace error
  boundary preserves campaign navigation and presents retry/overview actions after
  future render failures rather than allowing React to clear the application root.

Existing API clients, sheets, map rendering, and command safeguards are reused.
This is not a replacement of every legacy authoring or administration screen.

## Character context while playing

**Character**, **Open character sheet**, and **Add from character sheet** open the
same searchable reference sheet for the acting character. Every displayed fact is
selectable: identity, ancestry/background, classes, attributes, statistics and
defenses, progression, proficiencies, choices, health/resources, inventory and
equipment, powers/spells, active effects, and calculation explanations.

Select up to 16 entries, including unavailable powers when asking about them.
Selections use native toggle buttons with readable values, an Added state, and
keyboard/screen-reader feedback. Search covers names, values, and section names;
the section picker provides direct navigation. **Back to draft** focuses the
composer. Individual removal and **Clear references** preserve the player's text.
Quick-summary resources, items, and effects offer the same reference interaction.

Only exact selectors accompany the declaration. The server resolves current
authorized sheet values and catalog identities, persists the snapshot with the
immutable turn-creation event, and supplies it separately to DM planning and both
narration lanes. The transcript exposes an expandable **Character context** record.
References establish intent context; selecting a power does not use it or expand
the server's legal commands. Narration retries inherit the original context.

Draft text and references survive reload in this tab, scoped by campaign, room,
and actor. They clear only when the original declaration is acknowledged or exact
reconciliation confirms it. Refreshing the sheet updates previews and reports
entries that disappeared. A stale selector is rejected before a turn is created.

Adventure Table tool overlays are modal: the background is inert, Tab stays inside
the visible drawer, and Escape/Close restores the trigger. Tools reached through
Table tools return focus to that visible menu button. **Back to draft** focuses the
composer in Story. Narrow layouts wrap the primary tool row and keep the composer in
page flow. The legacy Atlas dock remains non-modal. See the
[sheet-context audit](play-sheet-context-audit-2026-10-02.md) for the attachment
contract and earlier evidence, and the
[Adventure Table audit](adventure-table-design-2026-10-03.md) for the current shell.

## Director

Adventure Table shows the current DM mode in **Table tools** and opens the Director
drawer from there. Human DM is the initial mode. An owner or GM must choose Review AI
delegation and Confirm AI delegation before AI-led play.
Take over has its own explicit confirmation and makes no provider call. It revokes
future delegation, not committed mechanics or an already dispatched provider bill.

Open scene requests an opening without inventing a player declaration. Continue
scene requests one bounded beat, not autoplay. Both use the existing configured
provider, with up to three planning rounds and one narration phase per beat,
120-second phase deadlines, and aggregate budget checks. Narrow pre-dispatch
rejection retries are described in [AI dungeon master](ai-dungeon-master.md#provider-and-mutation-failures);
uncertain paid outcomes are never automatically retried. In human mode an owner/GM requests a suggestion and uses
Approve exact proposal or Reject proposal in the private review. Public narration
appears alongside player turns in Adventure Table's Story view. The legacy Atlas and
internal Command Center retain their separate chronicle presentations.

The GM-only preparation disclosure offers named scene, quest-objective, and room
encounter choices, followed by review against a fresh story revision and explicit
confirmation. Binding is provider-free preparation, not scene completion or public
disclosure; exact check-turn bindings remain available through the API. AI scene
resolution still requires fresh committed evidence matching the exact binding.

The director is separate from the player adventure agent. Its public narrator
returns structured atmosphere, optional dialogue by present public NPCs, and a
player-facing question (optional for transition beats). This scene description is
non-authoritative; subsequent narration receives complete verified receipt history
and a separate labeled prior-scene continuity channel. Recorded NPC knowledge
retains attribution and disclosure limits.

Mode review, pending runs, and uncertain outcomes lock conflicting room commands.
Closing Director preserves those locks, the mounted map, and the unsubmitted action
draft. Refresh, focus, polling, and mounting only read state. Saved run IDs reconcile
through GET after reload; exact requests retain their original keys. Resume saved
run and exact-request recovery are explicit actions, never replacement paid beats.
Preparation blockers require authoritative setup, not refresh-triggered generation.

The HTTP adapter remains trusted-local `local-owner`; the public chronicle is not
evidence of authenticated remote-player isolation. See [director API](api.md#campaign-director)
and [AI dungeon master](ai-dungeon-master.md) for authority, budgets, and limitations.

## Validation

Current Adventure Table results belong in the
[2026-10-03 validation record](adventure-table-design-2026-10-03.md#validation-record).
Implementation descriptions and screenshots do not establish test passes or
accessibility conformance. Earlier executed results remain in the
[2026-10-02 implementation audit](roleplay-worldbuilding-audit-2026-10-02.md#validation)
and [sheet-context audit](play-sheet-context-audit-2026-10-02.md).

Relevant checks include the owning client tests for App, CampaignShell,
CampaignOverviewPage, CampaignPlayPage, CampaignConversation, AdventureActionComposer,
GameplaySheetDrawer, and CombatCommandBar, plus the client typecheck. Browser coverage
is organized under `e2e/tests/`:

- `campaign-control-plane.spec.ts`: entry, desktop/mobile navigation, composer, and
  tactical interaction.
- `campaign-preparation.spec.ts` and `worldbuilding-wizard.spec.ts`: setup,
  character/room handoffs, and interrupted-write recovery.
- `campaign-combat-map.spec.ts` and `campaign-session-recovery.spec.ts`: map
  authority, encounter lifecycle, and exact recovery.
- `campaign-dm.spec.ts`: Director delegation, public narration, private review,
  saved-run recovery, and preserved room state.
- `character-surfaces.spec.ts`: checks, resources, inventory, trade, travel,
  companion administration, and reviewed encounter application.

The integration owner records the actual commands, counts, and remaining observations
after serialized validation. Deterministic browser fixtures use disposable storage and
a fake provider; the demonstration screenshots have separate provenance in the audit.

## Remaining Work

- Bring safety-pause resume and remaining advanced configuration into focused
  workflows. Starting-location preparation still uses World.
- Add server-side idempotency or exact receipt discovery for persona and room
  creation. Browser-side recovery locks are not cross-device guarantees.
- Broaden multi-controlled-actor browser coverage beyond the two-actor bilateral-trade
  flow and remove the remaining map-generation concurrency gap with server-side
  create-only or expected-map/roster preconditions.
- Add non-mutating terrain/layout preview and supported enemy-token repositioning.
- Embed remaining campaign authoring, quest editing, and new encounter roster
  creation where appropriate. Advancement requires explicit roster selection because
  public contracts do not expose an exact play-actor/character mapping.
- Add location-map history and restoration. Current maps bind to a location but
  remain one active map per room/mode, with explicitly selected layout profiles.
- Extend validated agent tools for currently unsupported GM operations before
  claiming unattended whole-campaign execution. Rich accepted preparation and
  roleplaying narration do not automatically start encounters, publish secrets,
  advance story state, or execute finales.
- Add real authenticated principal propagation, membership enforcement, and
  spectator projections before claiming secure remote multiplayer. Current HTTP
  requests use the trusted-local owner boundary; role labels do not replace auth.
- Add eager startup settlement for orphaned generation jobs and cross-device intent
  persistence. Current orphan settlement is lazy and client intent uses bounded
  session storage.
- Address starter rules fidelity separately: spell effects, class advancement,
  downstream feature effects, and utility-action consequences remain incomplete.
  Do not label this milestone full SRD 5.1 coverage.

## Design Principles

Expose one clear next action, explain prerequisites at the point of use, preserve
work when navigating backward, and distinguish a candidate from committed canon.
Keep technical identifiers in supporting details. Never automatically repeat a
paid provider call or conceal an uncertain mutation behind an optimistic result.

Research informing the design includes
[progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/),
[human-AI interaction guidelines](https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/),
[server-side authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html),
and [accessible dialog behavior](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
Adventure Table's [design audit](adventure-table-design-2026-10-03.md) records the
observed Owlbear, Foundry, D&D Beyond, Alchemy, and AI Dungeon patterns separately from
Velvet recommendations and implementation. It also links the W3C tab, modal-dialog,
reflow, and focus criteria used for review. Tactical tools additionally draw on
[WCAG alternatives to dragging](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).

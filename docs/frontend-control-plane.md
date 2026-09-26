# Campaign Control Plane

## Preparation Readiness

The Director drawer includes an owner/GM-only, explicit `Inspect preparation`
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
  the next preparation step. Configuration is not presented as proof of readiness.
- Preparation now brings starter rules installation, current safety review,
  explicit campaign publication, and room creation/attachment into the new
  workspace. Saving safety does not clear a pause or loosen existing boundaries.
- Rooms checks authoritative activation readiness and starts prepared sessions
  through the provider-free activation API. An uncertain command retains its exact
  idempotency key; entering play requires confirmed activation and a current read.
- Attaching a campaign's first room issues the idempotent campaign startup
  command (`client/src/components/rpg/overview/CampaignPreparation.tsx:94-96`,
  `:116-124`): it delegates the Director to AI, publishes eligible public
  materials, opens the beat, and enqueues one image per public location. It fires
  only when the campaign had no attached rooms before the attach
  (`:92-94`), so attaching another room to a live campaign never mutates it. A
  blocked or failed startup is reported through the status notice and never turns
  the successful attach into an uncertain write; no retry is issued
  (`:110-124`). See [campaign startup](campaign-startup.md).
- Create offers a questionnaire or scripted interview, explicit brief review,
  generation, candidate inspection, and explicit application. Opening the page does
  not generate content or probe the provider. Publication remains separate.
- Character creation uses Concept/persona, Rules choices, Review, and Ready stages
  while preserving server validation, saves, reconciliation, and finalization.
  Personas can be created inline. An uncertain persona creation retains a browser
  storage lock and offers authoritative identity selection, not an automatic POST
  retry or an assumption based on a matching name.
- The live table uses the new Living Atlas surface, replacing the old play layout.
  Maps and conversation remain mounted together on desktop and mobile. Non-modal
  drawers overlay the map without replacing conversation or its action composer.
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
- Active and ready rooms expose `Enter adventure` immediately. Reopening a room no
  longer requires a duplicate activation receipt from the current browser.
- Living Atlas provides Character, Inventory & Equipment, Advancement, Travel,
  Dice, Field Journal, Combat & Rewards, GM Tools, and searchable Help. Existing
  domain controllers own commands and recovery; the new shell owns only layout.
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

## Director

Living Atlas shows Human DM by default and exposes a Director drawer. An owner or
GM must choose Review AI delegation and Confirm AI delegation before AI-led play.
Take over has its own explicit confirmation and makes no provider call. It revokes
future delegation, not committed mechanics or an already dispatched provider bill.

Open scene requests an opening without inventing a player declaration. Continue
scene requests one bounded beat, not autoplay. Both use the existing configured
provider, with at most two calls per beat and a 30-second deadline per call, no
automatic paid retries. In human mode an owner/GM requests a suggestion and uses
Approve exact proposal or Reject proposal in the private review. Public narration
appears in the DM chronicle independently of the player transcript and drawer.

The GM-only preparation disclosure offers named scene, quest-objective, and room
encounter choices, followed by review against a fresh story revision and explicit
confirmation. Binding is provider-free preparation, not scene completion or public
disclosure; exact check-turn bindings remain available through the API. AI scene
resolution still requires fresh committed evidence matching the exact binding.

The director is separate from the player adventure agent. Its public narrator
returns structured atmosphere, optional dialogue by a present public NPC, and a
player-facing question. This scene description is non-authoritative and is never
fed back as canonical memory; subsequent narration uses verified receipt summaries.

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

`e2e/tests/campaign-control-plane.spec.ts` exercises desktop (1440px) and mobile
(390px) entry, navigation, generation brief review without provider calls, staged
character finalization, blocked and successful activation, tabletop drawers, and a
persisted tactical move. It checks horizontal overflow and composer controls.
`campaign-preparation.spec.ts` adds rules/safety/publication/room setup and inline
persona creation, including lost-response recovery. `campaign-combat-map.spec.ts`
adds reviewed full-roster placement, verified off-turn binding, real map generation,
and current-turn movement spending. `campaign-session-recovery.spec.ts` covers
encounter start/completion, short-rest recovery, refresh safety, and generation
reconciliation without a second provider dispatch. All four files use the normal
root Playwright configuration and CI discovery. Fixtures use disposable storage,
not live campaign data.

`campaign-dm.spec.ts` adds the real browser/HTTP/persisted director lifecycle with an
in-process fake provider, disposable SQLite, and an ephemeral loopback API port.
It checks delegation, narration, continuation, takeover, private rejection/approval,
GET-only saved-run recovery, no load/focus POST, preserved map/draft and room locks,
and absence of seeded secrets from public output and narrator inputs. It uses the
normal root Playwright configuration; no live database or paid endpoint is used.

`character-surfaces.spec.ts` drives the deterministic mechanics through the real
client and HTTP layer: a server-resolved check plus effect apply/remove and resource
adjustment, a present-vendor sale from a server-issued quote, bilateral trade accept
and cancel across two controlled actors, expedition actor placement and camp,
companion create/grant/revoke, and reviewed encounter generation and application.
It also uses disposable SQLite and the in-process fake provider, so no paid call is
charged.

The final Living Atlas focused browser gate passes 12 director, desktop/mobile
control-plane, combat-map, and session-recovery tests, including camera retention through refresh,
movement, and drawer interaction. Additional fixture browser checks cover 320px
layouts and embedded travel/inventory review geometry. Focused client, server, and
contract tests cover grounding, historical replay, invalid-database rollback,
accepted agent preparation, and secret-free narration. These checks do not claim
live-provider or authenticated multi-user coverage.
The production build still warns about a large JavaScript chunk; route-level
code splitting remains follow-up work.

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
The new table also draws on [Foundry's scene-centered interaction model](https://foundryvtt.com/article/player-orientation/)
and [WCAG alternatives to dragging](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).

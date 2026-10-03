# Adventure Table: design and implementation audit

**Date:** 2026-10-03. **Scope:** campaign entry, default play, exact character context,
and responsive/keyboard interaction. The goal is an understandable loop: read the
scene, describe an intention, send it, and inspect the outcome.

This records implementation visible in source and the research informing it.
Execution results belong in the [validation record](#validation-record); product
comparisons and design recommendations are not measurements of Velvet's usability.

## Implemented interaction model

| Area | Current behavior | Implementation |
| --- | --- | --- |
| Default entry | Fresh navigation opens Campaigns & worlds when campaign features are enabled. Campaign library entry leads to the next-step overview. Saved room navigation defaults to Adventure Table unless it explicitly selects legacy Atlas. | [App](../client/src/App.tsx), [navigation](../client/src/roleplay/navigation.ts) |
| Play hierarchy | The full campaign rail and management toolbar are absent during play. Story/Map tabs, Character, Journal, Dice, and one action composer form the primary surface. | [CampaignShell](../client/src/components/rpg/shell/CampaignShell.tsx), [AdventureTable](../client/src/components/rpg/play/AdventureTable.tsx) |
| One story | Public Director openings/continuations and durable player turns share a chronological story. Private proposals remain in Director. Legacy room messages are labelled read-only history. | [CampaignConversation](../client/src/components/rpg/play/CampaignConversation.tsx) |
| Stable views | Story and Map remain mounted while the inactive panel is hidden. One composer serves both tabs. Sending or returning from sheet context selects Story. | [CampaignPlayPage](../client/src/components/rpg/play/CampaignPlayPage.tsx), [AdventureTable](../client/src/components/rpg/play/AdventureTable.tsx) |
| First turn | Look around, Introduce myself, and Find a lead prepare editable intentions. Existing text prompts Append suggestion / Replace declaration / Cancel. Nothing is sent until Send action. | [FirstTurnGuide](../client/src/components/rpg/play/AdventureTable.tsx), [composer](../client/src/components/rpg/play/AdventureActionComposer.tsx) |
| Progressive disclosure | Character, Journal (accessible name Field journal), and Dice are primary. The native Table tools dialog contains Director, Travel, Combat & rewards, Help, role-appropriate GM tools, Display, Replay this session, voice controls, and campaign navigation. | [AdventureTable](../client/src/components/rpg/play/AdventureTable.tsx), [CampaignPlayPage](../client/src/components/rpg/play/CampaignPlayPage.tsx) |
| Combat | Compact round/turn status remains visible. End turn prepares text; Review encounter completion opens the existing combat review/recovery controller. The story-surface bar does not dispatch direct completion or enemy-turn commands. | [CombatCommandBar](../client/src/components/rpg/play/CombatCommandBar.tsx) |

The older Living Atlas remains an optional `surface="atlas"` presentation, including
explicit saved `playSurface: "atlas"` navigation. The multi-column Command Center is
retained internally for an explicit `surface="center"` compatibility/test path.

### Readiness without automatic activation

[CampaignOverviewPage](../client/src/components/rpg/overview/CampaignOverviewPage.tsx)
shows next-step guidance, sessions, and the party roster. Owner/GM room cards read
activation readiness automatically on arrival and window focus. Blockers link to
preparation, starting-location selection, or character building.

Start room is an explicit command. Success clears its saved command only after the
activation receipt; a following GET establishes current readiness for Enter
adventure. If that GET fails, the next operation is another read. An uncertain write
retains its original request/key and requires Retry exact room start. Background
reads do not replay the write or treat an active room as proof that the pending
receipt was recovered. Focus refresh also preserves open preparation drafts.

### Exact character context

The searchable gameplay sheet remains fully referenceable, with a maximum of **16
precise attachments per action**. Identity, attributes, defenses, proficiencies,
choices, resources, inventory, powers, effects, and calculation explanations use
exact selectors. The server resolves authorized current values and persists the
turn's snapshot. Selecting a power supplies context; it does not use the power.

The composer previews references and supports individual removal and Clear references.
Back to draft returns focus to the text. Drafts and selections are scoped to campaign,
room, and actor in this tab; character switches preserve each actor's separate draft.
Acknowledgement or exact reconciliation clears the submitted original. Sent turns
retain expandable Character context, including for narration-only derivatives.
See [the attachment contract and earlier audit](play-sheet-context-audit-2026-10-02.md).

## Visual direction and responsive behavior

The implemented direction is an editorial field journal: ink-green chrome, a
paper-colored reading surface, serif narration, restrained gold accents, and labelled
line icons. Desktop pairs a reading area and composer with a compact location/character
companion. The companion disappears at 900px and below; its character and map entry points
remain in the main tools. At 600px and below, the story, notices, and composer use
natural document flow; the recent-story log is a bounded, keyboard-scrollable area
so a long campaign does not push the composer below its entire history. The composer
is not a fixed mobile overlay.

[adventureTable.css](../client/src/components/rpg/play/adventureTable.css) provides
light/dark/high-contrast variables, visible focus outlines, reduced-motion rules,
forced-colors treatment for selected tabs, and 44px minimum heights for table buttons,
selects, and inputs. Rendered checks are recorded below.
Optional scene images and voice use their existing integrations.

## Research: documented observations and design recommendations

Sources reviewed through October 3, 2026. The middle column records external product
features; the last column is a recommendation, not evidence that Velvet implements
every comparable feature.

| Source | Documented observation | Recommendation for Velvet |
| --- | --- | --- |
| [Owlbear Rodeo: Getting Started](https://docs.owlbear.rodeo/docs/getting-started/) | Browser/mobile support; players join through a room link; starter maps/tokens and optional extensions. Players need accounts when bringing their own tokens. | Minimize the work between entry and a usable play situation; expose setup when needed. |
| [Foundry: Player Orientation](https://foundryvtt.com/article/player-orientation/) | Players claim assigned characters; owned tokens have contextual resource/status controls. The broader workspace includes numerous directories and layers. | Keep acting-character identity explicit and frequent actions close to play; avoid duplicating every administration destination. |
| [D&D Beyond: Changelog](https://www.dndbeyond.com/changelog) | April 9, 2026 added token-opened character sheets inside Maps with synchronized sheet state. March 24 introduced beginner Quickbuilder; August 24 enabled logged-out Quickbuilder use. | Preserve the current scene while inspecting a character; keep initial preparation short and actionable. |
| [Alchemy: Player Orientation](https://help.alchemyrpg.com/en/articles/9821384-player-orientation) and [System Requirements](https://help.alchemyrpg.com/en/articles/9823706-alchemy-web-desktop-apps) | Persistent scene identity, portrait-opened sheets, resource trackers, and a tactical-map toggle. June 2026 requirements describe mobile/tablet experiences as unoptimized. | Give story and character identity clear visual priority; design a dedicated narrow layout rather than compressing desktop panels. |
| [AI Dungeon: Getting Started](https://help.aidungeon.com/getting-started) and [Story Cards](https://help.aidungeon.com/faq/story-cards) | Quick Start asks for setting, character, and name before play. Do/Say/Story inputs drive narrative. Optional story cards enter context through keyword triggers; a trigger in AI output takes effect on a later response. | Offer an editable first action and explicit context previews. Preserve Velvet's server-owned outcomes when adapting freeform interaction ideas. |
| [NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | Frequent controls belong on the initial surface; secondary controls need clear labels. More than two disclosure levels often creates navigation problems. | Keep the ordinary turn on one surface and secondary tools discoverable; avoid replacing many columns with a maze of drawers. |

## Accessibility review criteria

[WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies the success criteria; the APG
patterns and Understanding documents below explain interaction and review approaches.
The implementation observations are not a conformance or certification claim.

| Reference | Implementation visible in source | Review criteria |
| --- | --- | --- |
| [APG tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) | Labelled tablist and linked tabpanels; selected state and roving tab stop; Left/Right, Home, and End activate/focus tabs. Inactive panels are hidden but mounted. | Keyboard traversal, active-panel announcement, and retained state during view changes. |
| [APG modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | Table tools uses native `showModal()`. Tool drawers use modal semantics, background inertness, a focus loop, and Escape/Close. A menu-launched drawer restores focus to the visible Table tools button. | Initial/return focus, nested dialog behavior, and screen-reader interaction through each tool path. |
| [Reflow, SC 1.4.10](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) | Narrow screens use a flowing story/composer and wrapped primary tools. Character and journal remain reachable when the companion is hidden. | 320 CSS-pixel and zoomed layouts, long reference values, and touch-keyboard use. The two-dimensional map exception does not exempt surrounding text or controls. |
| [Focus Visible, SC 2.4.7](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) and [Focus Not Obscured, SC 2.4.11](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) | Focus outlines, Skip to your action, F6/Shift+F6 region navigation, and Back to draft focus restoration. Mobile composer uses static positioning. | Visible focused controls with open tools, long transcripts, zoom, and each theme; prevent focus from escaping behind an overlay. |

`?` opens Help outside editable fields when no tool/dialog is active. Keyboard access
must remain available through ordinary Tab navigation as well as these shortcuts.

## Follow-up recommendations

- Measure first meaningful turn completion with new players; editable suggestions are
  implemented, but no onboarding-time improvement is established by this audit.
- Review the full phone loop: read, type, inspect Character, attach, return, and send.
  Include long transcripts and a visible software keyboard.
- Review screen-reader announcements during streaming, especially the combined
  story log and attachment status changes.
- Keep authoritative receipt/recovery state legible. A visually simpler table must
  not turn pending operations into optimistic success or silently replay writes.

## Screenshots and provenance

The new play images are real app captures from a **fictional local demonstration
campaign**, cloned from the Baie-Comeau fixture. The clone has a readable campaign
title, a provider-free GM takeover of an old pending Director run, and one explicitly
prepared deterministic, location-bound exploration map. The source database includes
historical live-provider prose. Capture blocks all API writes and makes no provider
dispatch; draft text and character selections belong only to its fresh browser context.

| Capture | File |
| --- | --- |
| Default Story and composer | [adventure-table.png](images/adventure-table.png) |
| Map with the shared composer | [adventure-table-map.png](images/adventure-table-map.png) |
| Fully referenceable character sheet | [adventure-table-character.png](images/adventure-table-character.png) |
| Narrow/mobile play | [adventure-table-mobile.png](images/adventure-table-mobile.png) |

Desktop captures use **1600 × 1100 CSS pixels**, phone capture **390 × 844**, both at
**1.5× device scale** with reduced motion. The phone image captures the full document.
Reproduce against an unlocked, prepared disposable campaign with a tactical map:

```bash
node scripts/capture-readme-screenshots.mjs \
  --base-url http://127.0.0.1:18892 \
  --campaign bc-v1-000001 \
  --room 137f8bb3-c43c-4046-9cfb-88e2f9b8ee84 \
  --reference "Waylamp (1)" --out docs/images
```

The [README gallery](../README.md#screenshots) distinguishes these play images from
earlier worldbuilding, character-mechanics, Director, and campaign-management captures.

## Validation record

Executed on **2026-10-03**, with heavy checks serialized. Vitest used
`--maxWorkers=1 --no-file-parallelism`; Playwright used `--workers=1`.

| Check | Result |
| --- | --- |
| Affected client tests | **257 passing tests across 11 files**, including App routing, readiness/recovery, durable turn orchestration, first-turn suggestions, sheet context, merged story ordering, follow-latest behavior, combat locks, and voice placement. |
| Client typecheck | Passed, including the final production build's TypeScript check. |
| E2E typecheck | `npm run typecheck:e2e` passed. |
| Client production build | `npm run build --workspace velvet-mvp-client` passed. Vite reported its large-main-bundle advisory. |
| Documentation drift | **7 passing checks** via `npm run test:server:serial -- test/documentation-drift.test.ts`. |
| Deterministic browser coverage | **33 distinct scenarios passing** across the affected play/control-plane specs, three CampaignPlay flows in `app.spec.ts`, and optional voice integration. |
| Rendered accessibility | **Zero axe violations in 12 audited states**, using WCAG 2 A/AA, 2.1 AA, and 2.2 AA tags. |
| Screenshot capture | Four fresh real-app images; the capture script's API-write assertion passed. |

The client files were `App.test.tsx`, `CampaignPlayPage.test.tsx`,
`CampaignConversation.test.tsx`, `AdventureActionComposer.test.tsx`,
`CampaignContextDrawer.test.tsx`, `CombatCommandBar.test.tsx`, `PlayHelp.test.tsx`,
`ConversationText.test.tsx`, `CampaignShell.test.tsx`,
`CampaignOverviewPage.test.tsx`, and `CampaignPreparation.test.tsx`.

Browser commands:

```bash
npx playwright test \
  e2e/tests/campaign-control-plane.spec.ts \
  e2e/tests/campaign-combat-map.spec.ts \
  e2e/tests/campaign-session-recovery.spec.ts \
  e2e/tests/campaign-dm.spec.ts \
  e2e/tests/campaign-dm-living.spec.ts \
  e2e/tests/campaign-context-inspection.spec.ts \
  e2e/tests/campaign-dm-readiness.spec.ts \
  e2e/tests/campaign-memory.spec.ts \
  e2e/tests/reviewed-adventure.spec.ts \
  e2e/tests/character-surfaces.spec.ts \
  e2e/tests/client-feature-surfaces.spec.ts --workers=1

npx playwright test e2e/tests/app.spec.ts e2e/tests/reviewed-adventure.spec.ts \
  --grep "CampaignPlay|reviewed harbor" --workers=1

npx playwright test --config=playwright.voice.config.ts --workers=1
```

The 29-scenario sweep initially found a loss of distinct speaker colors. Theme-aware
speaker palettes fixed it; both reviewed-adventure scenarios passed in the final
five-scenario run. Earlier axe feedback also corrected small map disclosure targets
and quick-sheet-button contrast. Focused client reruns corrected stale presentation
assertions and eager rejected-promise test fixtures; the final affected checks passed.

The twelve axe states were desktop Map, desktop Story, Table tools, desktop Character,
320 × 568 Story and Character, and Story/Character pairs in light, dark, and high-contrast
themes. Browser checks covered keyboard focus containment and restoration, a working
Skip to your action link that preserves the campaign URL, 320px reflow, one mounted
composer, preserved map canvas/camera, exact selected references,
draft reload, one explicit declaration, provider-payload context, immutable transcript
context, and no replay on reload. Desktop/mobile combat and session recovery checks
also passed. Final screenshots were visually reviewed for story hierarchy, readable
sheet entries, local-map visibility, and phone access to the composer.

Logs and traces are under `/tmp/opencode/adventure-table-*.log` and
`/tmp/opencode/velvet-adventure-table-*`. These are local execution artifacts, not
committed fixtures. New-player timing, real screen-reader sessions, and an actual
phone software-keyboard session remain follow-up usability work. The redesign did
not dispatch a new live-model evaluation.

Relevant checks and browser files are listed in the
[control-plane validation inventory](frontend-control-plane.md#validation).

# Play surface and character context — October 2, 2026

## Interaction

Players can attach any displayed character-sheet fact to their next typed action.
Open **Character**, **Open character sheet**, or **Add from character sheet**;
select entries, then **Back to draft**. Selection never rewrites the declaration.
The composer previews references, supports individual removal and clearing, and
requires an explicit **Declare action**. A selected but unavailable spell can be
the subject of a question.

| Sheet area | Reference coverage |
| --- | --- |
| Identity | Name, ancestry, background, supplied ruleset/version |
| Classes | Exact catalog class and class level |
| Attributes | Attribute score; SRD ability modifier when applicable |
| Statistics | Maximum HP, ruleset-specific AC/defenses, initiative, speed, carrying limit, spell attack, save DC |
| Progression | Mode, level, XP, milestones, pending choices, update time |
| Proficiencies | Skills, saving throws, and every other supplied proficiency category |
| Choices | Selected features/options and exact catalog identity |
| Resources | Every supplied health/resource track, current amount and capacity |
| Inventory | Capacity, every exact item entry, quantity, equipment slot, catalog identity |
| Powers | Every known power/spell, exact catalog identity, availability and reasons |
| Effects | Every active effect, source, duration, stacking, recovery, applied time and modifiers |
| Calculations | Every supplied derivation, formula, inputs and result |

The shared index covers the authorized gameplay-sheet projection. Mechanical
management controls in Inventory, Advancement, Combat, and the standalone character
administration page continue to perform their labeled reviewed actions.

## Research and resulting design choices

Sources were reviewed as of **October 2, 2026**:

- [WAI-ARIA APG: Button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/):
  native buttons; Enter/Space; stable accessible labels and `aria-pressed`; value
  descriptions and a visible Added mark rather than color alone.
- [WAI-ARIA APG: Modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/):
  Command Center overlays now isolate the background, contain Tab/Shift+Tab, close
  with Escape, and restore focus. Character-mechanics navigation is inside the
  dialog's semantic boundary. Back to draft deliberately focuses the textarea.
- [WCAG 2.2: Focus Not Obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html),
  updated June 15, 2026: prevent focus behind the scrim; keep sheet controls above
  an independently scrolling body; replace the large sticky mobile toolbar with
  compact scrolling rows that do not obscure the composer.
- [WCAG 2.2: Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html):
  24 CSS pixels is the AA baseline (with exceptions); primary sheet interactions
  use at least 44-pixel-high controls and whole entry cards as targets.
- [WCAG: Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html):
  polite selection, removal, search-result, loading, and refresh feedback; focus
  stays on the selected entry when adding multiple references.
- [NN/g: The 3 Roles of Context for AI Agents](https://www.nngroup.com/articles/3-agent-context-roles/),
  September 18, 2026: keep explicitly selected, task-local context visible and
  scoped to the action. The server and DM receive it separately from typed intent.
  This is a design application of the research, not a tested RPG-specific finding.

Additional improvements include search across names/values/sections, a section
picker, expanded values in the transcript, actor-scoped tab-local draft recovery,
mobile reflow, theme-aware text/focus contrast, reduced motion, and forced-color
selection styling. The quick character summary now uses public sheet labels and
supports the same exact reference interaction. Its Open character sheet action
opens the drawer as well as loading the data.

## Authority and recovery

- A declaration accepts up to 16 unique `{ section, key }` selectors. Client values,
  labels, catalog identities, and alternate actor IDs are rejected as selector
  fields. The text retains its independent 8,000-character limit.
- The repository authorizes the acting character and resolves references inside
  the creation transaction. Missing entries reject the request before any turn or
  provider dispatch. Current values are read at submission; refresh updates the
  draft previews and reports references that disappeared.
- The existing immutable creation event stores the resolved snapshot; no database
  migration is required. Exact replay, restart, and narration derivatives preserve
  it. Role-safe repository projections omit private context for unrelated actors.
- Planning and both narration paths receive exact reference data with explicit
  intent-only authority. Reference selection does not grant or execute a mechanic.
  Current legal commands and verified outcomes override declaration-time values.
- Drafts are tab-local, separated by campaign/room/actor. Submission preserves them
  until durable acknowledgment or exact initial-key reconciliation. A narration
  derivative does not clear an unsent next-action draft.
- Existing provider budget checks include the serialized context. Per-entry values
  are bounded to 4,000 characters, with explicit omission text for oversized detail.

## Validation scope

Focused contract, repository, prompt, client/API, and deterministic browser tests
cover the boundaries above. Browser validation includes keyboard selection and
focus return, multi-reference submission, mobile reflow at 320 × 568, per-tab reload,
actual planning/narration payloads, transcript persistence, and light/dark/contrast
theme checks with axe WCAG A/AA tags. Heavy runs are serialized with one browser
worker and `--no-file-parallelism` for focused unit/server runs.

Automated accessibility scans and keyboard inspection are evidence for these
tested surfaces, not a whole-product WCAG conformance certification or a substitute
for a session with screen-reader users. This task's provider flow is deterministic;
live model comprehension is not measured by the fake provider.

Recorded checks:

| Check | Result |
| --- | --- |
| Focused contract files | 18 passed |
| Focused client/API files | 213 passed |
| Repository, route, prompt-memory, and orchestrator files | 156 passed |
| Browser flow plus desktop/mobile activation, drawers, and tactical movement | 3 passed, one worker |
| Axe scans of sheet and play surface | No violations in the 10 tested desktop/mobile/theme states |
| Contracts, server, client, E2E, and CLI typechecks | Passed |
| Client production build | Passed |
| Documentation drift checks | 7 passed |

Browser artifacts are under `/tmp/opencode/velvet-sheet-e2e-20261002/` in the
implementation environment. Full server and live-provider campaigns were not
repeated for this focused interaction change.

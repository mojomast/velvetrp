# The Last Harbor Light

P2.1 fixture version: `1.0.0`. The strict manifest and its SHA-256 digest are
exported by `server/test/fixtures/reviewedAdventure.ts`.

## Setup

`createReviewedAdventure(targetDirectory)` accepts only an existing, empty
disposable directory. It refuses nonempty targets and uses provider-free
`reviewedContent` staging, normal application, room activation, actor/NPC
placement, exact-catalog encounter preparation, and explicit scene bindings.
It opens the campaign repository with that exact `targetDirectory`, never repairs
or reuses storage, and does not use ambient `VELVET_DATA_DIR` to select it. The
legacy session setup command is scoped to the same supplied target and restores
the caller's environment immediately.

The fixture pins the mechanics starter catalog and creates one finalized actor,
three directed public locations, Keeper Maren, three public story nodes, the
public Saltglass Trail clue, Restore the Harbor Light, an optional Gloam-Mite
encounter, and a custom Keeper's acknowledgment reward. The private sentinel
preparation artifact is `HARBOR-SENTINEL-PRIVATE-7`; it must not appear in a
public projection.

Initial state deliberately has no completed objectives, story evidence, active
combat, successful checks, reward claims, scene resolution, campaign completion,
or assertion that the beacon is restored.

## Readiness

The composed P1 readiness report is inspected after activation. It emits one
`private-artifact` warning for the sentinel-safe GM preparation artifact and
two `awaiting-play-evidence` review states for the explicit future scene
bindings. The report remains activation-ready and active, and contains no
sentinel text.

The optional encounter is a documented branch expectation, not an emitted
`optional-disconnected-content` warning. The current strict generated-content
schema has no `optional` field, so P2.1 does not fabricate optional state through
storage writes. Consequently, readiness treats the generated encounter as public
required preparation until a later supported materialization/binding flow; this
is distinct from the fixture's documented optional player choice.

## Bindings

The fixture binds `lens-recovered` to the `secure-lens` quest objective and
`harbor-finale` to the final `relight-beacon` quest objective. Both bindings
await fresh qualifying evidence; the optional encounter is not substituted for
the finale's final-objective evidence.

## Branch Oracle

The manifest exports stable steps for pre-activation withdrawal, opening and
conversation, exact negotiation success/failure, a failed alternate, task and
clue, bound evidence, safe/risky routes, combat and claim, finale, and owner
completion/reload. Every step names prerequisites, an explicit player/DM action,
candidate family, allowed mutations, required receipts, forbidden assertions,
and a stop condition. Candidate selection is always by exact reviewed identity,
never by array position.

The oracle does not claim supported active-combat retreat, durable social
agreement from a successful check, arbitrary settlement from a custom reward, or
campaign completion from narration. P2.2 must execute these branches over the
production HTTP/SSE path with deterministic rolls and fake completions.

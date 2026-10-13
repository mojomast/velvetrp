# Public-context narration diagnostic

Status: implemented; dispatch pending a second independent clearance after the
pipeline repair-policy and runner corrections below. The 175-seed pilot remains
held. This diagnostic changes no model weights and authorizes no export.

### Adapter defects that blocked dispatch — now fixed

Independent review reproduced four failures that had to fail closed before any
request could be sent. Report:
`/tmp/opencode/foundry-public-context-precalibration-review.md`.

| # | Severity | Defect | Correction |
|---|---|---|---|
| F1 | P1 | Connector loss: a scene sentence's mechanical semicolon sibling re-entered the legacy lossy splitter, dropping `but`/`while`/`however` and question marks, and still verified with complete mechanical coverage | Scene-containing sentences keep their terminator; a sibling is never re-split on word connectives; question/exclamation spans adjudicate and bind nothing |
| F2 | P1 | Mutable/copyable authority: the issued registry was exposed as a mutable map and its brand survived object spread, so a re-hashed source or a forged control-arm upgrade resolved under the original pin | Authoritative entries live in module-private storage keyed by the exact issued handle; the handle is a frozen shell whose `entries` getter returns a fresh copy; nested manifest/source data is deep-frozen |
| F3 | P2 | A wrong declared manifest digest was silently recomputed instead of refused | Declared digest must reproduce the canonical body, else `manifest-digest-mismatch` |
| F4 | P2 | A valid noncontiguous schedule executed grouped while the plan reported the supplied order | Units materialize in manifest row order; a post-condition requires `plan.units` order to equal the frozen schedule |

A related nonblocking false contradiction for identical repeated scene subjects
was also corrected: contradiction is now decided on value, not repetition.

The present-tense check-grammar false refusal found in the v7 audit
(`You succeed on ...`) is **fixed**; the grounding validator is now
`grounding-binding-v7`.

### Blockers found by the second independent clearance

A second read-only review confirmed F1–F4 closed and all four frozen digests
reproducing, then found three new blockers. Report:
`/tmp/opencode/foundry-public-context-clearance-review.md`.

| # | Severity | Defect | Correction |
|---|---|---|---|
| N1 | P1 | **Style-driven regeneration.** A candidate passing every functional validator but refused by a review-quality floor triggered a generator repair, contradicting this protocol's "no style-based generation retries" | The diagnostic selects `repairPolicy: "functional-only"`: a review/admission-quality refusal is terminal and does not authorize repair; genuine functional failures still repair. Default callers are unchanged |
| N2 | P1 | The first repository runner accepted the environment's default reviewer (`claude-opus-4-8`) instead of the preregistered Kimi K3 | The runner now refuses any reviewer other than the preregistered Kimi K3 before opening a store |
| N3 | P2 | The first repository runner's preflight crashed because `runPipeline` dereferences generator/reviewer identities that the preflight path omitted | Clients are constructed in both modes (construction performs no network call); `dataset/scripts/**` is now included in the foundry typecheck so this cannot recur |

A third independent clearance is required before dispatch.

## Preregistered execution identity

- Run: `calibration-public-context-2026-10-13-v8`.
- Seed: `calibration-public-context-2026-10-13-8`.
- Frozen source manifest:
  `c07754537a920d4a7acbb09fd5951ee4974273224f1925fa845f6d38647d6c58`.
- Plan: `ed615621bcf3fd5ecc005a3e22ccc0a2ec9b76a68637c0faab197be263ebd83f`.
- Three dependent base pairs, six initial tasks, K=1 per arm; all six inherit
  their bases' train split. This diagnostic produces no training export.
- Frozen manifest, pre-dispatch plan and registration:
  `.dataset/measurements/calibration-public-context-2026-10-13-v8/`.
- Source recipe `toy-public-observations-v1`; overlay
  `generator-v9/public-context-v1`; scene binding
  `grounding-binding-v6+public-scene-v1`. Global generator-v9 plans stay unchanged.

The freeze caller compared all six arms against the selected retained v6 public
plan entries: exact receipts, realization slots, lineage, split and cluster match.
The real-CPU preflight reproduced the six-unit plan with **zero generation/review
attempts**. Preflight is not generated-data quality evidence.

Durable, credential-free caller:
`dataset/scripts/runPublicContextDiagnostic.ts`. It requires the externally
supplied preregistered manifest pin rather than re-deriving one from the bytes it
validates, verifies both the manifest and the plan identity, requires the
preregistered Flash generator and Kimi K3 reviewer, and makes zero provider
requests in `--preflight`. Frozen inputs are preserved in `dataset/frozen/`:

| Artifact | SHA-256 / identity |
|---|---|
| `dataset/frozen/public-context-v8-manifest.json` | file `4089f73ebff102fbbeff891e69e976e9502d2fba2a2e68ad683dae1c38d140a5`; canonical digest `c07754537a920d4a7acbb09fd5951ee4974273224f1925fa845f6d38647d6c58` |
| `dataset/frozen/public-context-v8-preregistration.json` | file `84faac99e0a42dd7384494d063a0561b2cef91f7e8ed590dccc753150fc03d9c` |

The canonical manifest digest is recomputed from the committed manifest body, so
the frozen identity is reproducible from repository bytes alone.

## Purpose and frozen selection rule

The matched v7 composition experiment still has warm/wary voice or naturalness
failures. Its preregistered stop rule calls for source-bound public context rather
than another prompt-only tuning loop. Test whether two independently authored
observations can be integrated coherently while mechanical coverage stays intact.
Do not predict a quality improvement or describe this as persistent storytelling.

Take the first retained v6 plan entry, in original plan order, for each literal
voice below. Selection is by public metadata, not by answer wording or grade:

| Pair | Base unit | Base index | Voice | Public place / target |
|---|---|---:|---|---|
| Warm | `unit-8c28b0ce238d1727` | 0 | Warm but evasive | The Weeping Gate / Haug |
| Wary | `unit-98bf7c802f569a5e` | 4 | Low-register and wary | Tallow Street / Sable |
| Procedural | `unit-6b1501d2ec6a7a77` | 11 | Terse and procedural | Tallow Street / Oswin |

Reproduce each exact base from the public seed
`calibration-grounding-2026-10-13-6`, with its original scenario/realization seed,
receipts, slots, lineage, split and cluster. Freeze and compare the new manifest
against that retained public plan before generation. This selection rule was
chosen after v7, not retroactively preregistered before its answers.

## Inputs and authority

Author the same two outcome-independent observations in each new toy scene:

- Subject **the lamplight**, predicate `light-colour`, value **amber**.
- Subject **the shutters**, predicate `shutter-state`, value **closed**.

These are new independently authored diagnostic facts, not observations inferred
from v6/v7 outputs, place names or production-engine history. Freeze source bodies
and canonical digests before teacher dispatch. Record scene, exact committed-turn
snapshot, player observer, public visibility, subject identities and source origin.
A completion-supplied fact or a changed self-hashed source does not grant authority.

Each of the three bases has two new context arms, K=1:

1. Receipt-only: explicit empty public observations.
2. Observations supplied: the exact two registered facts.

Both arms retain identical mechanics, voices, task/tool wording, lineage, split
and cluster. The only arm-specific public payload difference is the observation
projection. Keep pair/arm labels and source authoring metadata out of the prose
task and blind style context. Presence of observations itself is visible; do not
claim the judge is blind to the context intervention.

Amber does not establish warmth, comfort, heat or safety. Closed shutters do not
establish a lock, secrecy, danger or motive. Neither fact establishes an action,
reaction, weapon, injury, player attention or a quoted utterance. Unknown clauses
and unsupported causal/temporal/descriptive additions remain explicit failures
or adjudications. Supported observation clauses must preserve their whole spans;
discarding a connector must not license an otherwise unsupported statement.

## Execution and evidence

- **Three dependent base pairs, six initial tasks**, K=1 per context arm. These
  are context controls, not selective-fidelity preference twins or six independent
  scenarios. No preference/parity claim is made.
- Preserve the existing funded Flash/K3 settings, bounded functional repairs,
  uncertain-dispatch handling, CPU preprocessing and measured-label budgets.
  No style-driven regeneration. Retain every actually dispatched repair.
- Validate registered source identity, scope, subject, visibility and projection
  before prompt rendering and evaluation/resume. Bind manifest/source bytes into
  plan, journal and provenance for admitted and refused attempts.
- Observation usage is optional. Report actual usage; an answer ignoring both
  observations does not demonstrate integration. Observations cannot replace a
  missing required check/damage receipt or rescue a mechanical contradiction.
  Separate required mechanical IDs, allowed/used scene-fact IDs and unknown IDs.
- The option is diagnostic-only. With it absent, reproduce the generator-v9
  ordinary/pilot plans and public prompts exactly. Any later pilot promotion is
  a separate recorded decision, never an implicit default change.

## Measurement and decision

Freeze all six planned initial and actually dispatched repair surfaces in the
`generated-grounded` cohort before judging. Grade complete displays in fresh
independent Astra contexts under the existing rubric. Lock the whole ledger before
functional unblinding. Retain failed, missing and ungradeable surfaces. Report each
context arm separately, with planned/graded/passing counts, coverage, conditional
quality, acceptable yield, repair churn and final admitted-target style/functional
intersection. Do not substitute an all-attempt pass rate for final target quality.

Independent inspection must verify actual mechanical bindings, source usage,
coverage, full-surface transport, source census, labels and phase order. A positive
result is narrowly that registered observations can be expressed or selected
coherently while the required mechanics remain intact. Two inert observations do
not demonstrate persistent RP, student retention or selective-fidelity parity.

If the same voice limitation persists, report it. Do not widen the grammar to
accept unknown player actions, retrofit facts to outputs, regrade failed answers
or launch the broad pilot on functional admissions alone. Further source/grammar
expansion requires a separately frozen experiment with independent authority.

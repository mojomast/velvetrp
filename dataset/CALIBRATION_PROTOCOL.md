# First live calibration preregistration

Frozen before paid generation on 2026-10-13. No training is part of this protocol.

## Generation inventory

- Route: operator-funded RouteTok via `agentrouter`, model `deepseek-v4-flash`.
  Route-bound inspected training-use receipt: `63202d19b617ce972007ccdea557cb6bb86bc587156243fb4273b0eefcbd3316`.
- Independent admission reviewer: `kimi:k3`, temperature 0. Generator temperature
  0.7, completion limit 512, at most two immutable repair attempts per scenario.
- Seed/run: `calibration-2026-10-13-v1`, **20 seeds, K=1**. Standard target weights.
  Plan digest `cc4bd039dd180f38f84f2f0357c303528089fa73f3746a01fed65af0b5151fe1`.
- Planned families: 6 world-generation, 6 tool-selection, 4 grounded-narration,
  3 boundary-recovery, 1 roleplay-conversation. Generated splits: 16 train, 3 dev,
  1 generated test. These counts describe the plan, not quality or yield.
- Tool contracts: 4 exact-candidate, 1 narration-submit, 1 no-tool. This small
  plan does not measure live read-tool behavior; its provider-free regressions
  remain a separate kind of evidence.
- Real CPU Qwen3-8B tokenizer, pinned revision/evidence/runtime. Sequence limit
  4096; truncation/packing/thinking disabled; explicit target selection.
  Policy digest `a691ea3d219fb2faaef1c2694599589b711ed09a44ad10dfa73f40a69a683053`.
- Default masked supervised-token budget and cluster cap eight. Full provider
  request/outcome/response, repair, validation, review and certificate artifacts
  remain outside trainer messages in an fsync-backed version-bound store.

The zero-dispatch preregistration dry run made zero attempts/admissions/selections.
GPT-6 Astra xhigh's final independent readiness review resolved the raw-outcome,
argument-type and unadvertised-roleplay blockers before this campaign.

## Measurement inventory and order

1. Capture every initial attempt and every actually dispatched repair. Preserve
   missing/uncertain outcomes as missing; they are not removed from planned initial
   coverage. Do not add fictional repair attempts after an earlier success.
2. Freeze a census of ordinary roleplay prose and any actually authored twin arms
   using `PROSE_MEASUREMENT.md`. The inventory is independently reconciled against
   the run's planned initial attempts and physical dispatch ledger. Other prose
   families may be reported as separate supplemental cohorts, never folded into
   ordinary RP to inflate its small denominator.
3. Fresh independent GPT-6 Astra xhigh contexts judge the full displayed answer
   surfaces. Lock individual style judgments before randomized twin parity;
   lock style/parity before grounding and unblinding. Retain exact raw judgments,
   quotes, actual context IDs and source/view/rubric bindings.
4. Independently inspect actual target transport/schema correctness, public
   receipt fidelity/coverage, menu intent, privacy/agency and repair behavior.
   Fluent incorrect material cannot enter selection merely by passing prose.
5. Summarize initial-attempt and repaired admission separately; count actual
   dispatches, refusals, unknown/unmeasurable states, student-label spend, diversity
   and selection/cluster caps. Provider billing is optional and separate.

## Progression decision

Any uncertain provider outcome or unresolved token accounting stops new calls.
Do not delete checkpoints or rename an uncertain request to resend it. A found
wrong certificate, fabricated settlement, cross-split source, or missing exact
training-use binding holds progression until corrected and revalidated.

The inherited 4/8 numeric style floor applies only with complete actual judgments;
both preference arms must pass with equivalent writing quality. It does not
establish controlled stock retention, especially with one ordinary RP scenario.
Historical stock answers have not been recovered in this checkout.

Advance to the intended 175-seed pilot only after actual calibration evidence is
acceptable: inspect all-family yield and refusal reasons, independently verify
admitted targets, and resolve material prose/schema/fidelity issues. Record the
decision and its observed denominators. A poor-yield calibration calls for a
versioned correction and another small campaign, not invented scores or silent
retry selection. Export requires independent certificate/registry approval.

```bash
VELVET_REVIEWER_MODEL=kimi:k3 npm run foundry -- generate --execute \
  --python /path/to/pinned/venv/bin/python --units 20 --k 1 \
  --seed calibration-2026-10-13-v1 --run-id calibration-2026-10-13-v1
```

The final training-ready SFT materializer checks pinned export checksums and exact
loss labels. Preference training additionally requires an actual consumer that
honors the explicit branch masks. Dataset collection does not run that trainer.

## Version 2 inference correction (frozen before second campaign)

Version 1 stopped on the first Kimi review: HTTP 400, `invalid temperature: only
1 is allowed for this model`. Ten Flash responses had been captured across four
scenarios; eight had empty final answers, one was partial world JSON, and one was
a correctly bound tool candidate awaiting review. The empty answers exhausted
the 512-token limit in reasoning. These retained failures are not prose grades or
an acceptable calibration yield; the remaining initial attempts were not run.

The second campaign uses a fresh run `calibration-2026-10-13-v2`, the same frozen
20-scenario seed `calibration-2026-10-13-v1`/plan digest, and these explicit settings:

- Flash: `thinking: { type: "disabled" }`, temperature 0.7, 2048 response tokens.
- Kimi K3: temperature omitted (upstream fixed at 1), `reasoning_effort: "low"`,
  4096 response tokens. K3 cannot disable thinking; its reasoning is retained only
  in raw audit artifacts and never copied into student targets.
- All mode/limit choices are request-digest- and resume-binding-bound. Changes
  cannot quietly alter an existing run. Known version-1 outcomes remain preserved.

Official configuration sources checked 2026-10-13:
[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode),
[Kimi model parameters](https://platform.kimi.ai/docs/api/models-overview).
They specify Flash's default-enabled thinking toggle and K3's fixed temperature,
always-on reasoning and supported low/high/max efforts. The operator relay's
actual captured responses remain the evidence that settings were honored.

## Version 3 contract/grammar calibration (preregistered before generation)

The independent version-2 audit found all four admissions functionally sound,
but concrete false refusals and reviewer contract churn held expansion. Version 3
uses a fresh scenario inventory and the corrected generator/reviewer contracts:

- Run `calibration-2026-10-13-v3`, seed `calibration-2026-10-13-v3-5`, 20 seeds/K=1.
- Plan digest `a98f984166a99be603cf1dee9b308f394c71178d996935504cd698aaa442e46a`.
- Same standard family counts: world 6, tool 6, grounded 4, boundary 3, RP 1.
- Tool subtypes: four exact-candidate, one read-tool, one narration-submit. Seed
  suffix was selected by public planning metadata to cover these two initiation
  subtypes before observing answers; no answer-quality selection was performed.
  Version 2 separately measured its no-tool subtype.
- Generated split counts: 19 train, 1 dev, zero generated test. Frozen external
  evaluation content remains unavailable to generation and grading.
- Keep corrected Flash/K3 inference settings, actual masked-token budget, bounded
  repairs, cluster caps, and fresh version-bound durable storage. Reviewer JSON
  contract retries are separately bounded to one retry on an unchanged candidate;
  retry until a favorable verdict is not allowed.
- Preregister a complete ordinary-RP attempt census, frozen full surfaces and
  fresh blinded Astra contexts before semantic unblinding, then independently
  inspect every actual admission and representative refused outputs.

Require actual independently sound grounded and boundary admissions plus acceptable
observed review/schema/fidelity/style outcomes before the 175-seed pilot. Do not
estimate a corrected yield by relabeling version-2 refused outputs. The latter
remain source-bound historical evidence in `CALIBRATION_RESULTS.md`.

## Version 4 explicit read-schema correction (before generation)

Version 3 stopped at its first read-tool request with HTTP 400: the relay rejected
the absent `required` array. Eight scenarios had completed (15 returned generation
attempts and seven reviews); six records were durably admitted. One additional
generation dispatch received the explicit schema rejection. No complete campaign
yield or expansion decision is inferred from this interrupted prefix.

Read tools now explicitly declare `required: []`, matching the exact empty-object
argument contract already enforced locally. Focused runner/teacher/CLI/generation
validation and the owning typecheck cover the correction. Version 4 uses a fresh
run `calibration-2026-10-13-v4` and the same scenario seed
`calibration-2026-10-13-v3-5`, 20 seeds/K=1. The plan digest changes only with its
explicit schema field to
`a43ede3743db919190b82107a346069f3a455187d57a7991443172d64dd2aa07`.
Prior run requests and refusals remain immutable; all other preregistered inference,
repair, review and measurement settings apply.

## Version 5 scoped grounding and exact catalog contracts (before generation)

Independent v4 review approved all eleven actual admissions, but no grounded
target reached admission. Version 5 fixes sentence/record scope while retaining
contradiction and unknown-extra checks; states persistent native narration
transport; retains failed tool arguments in repair feedback; and stops unchanged
answers from shopping another usable review verdict. World pins now supply exact
compatible `enemy-template` definitions with production's kind/pack/version/id
identity, and narrative encounter instructions exclude all three roster arrays.
An inert concept remains permitted even if a compatible pin is available.

Run `calibration-2026-10-13-v5`, same authored seed `calibration-2026-10-13-v3-5`,
20 seeds/K=1, plan
`ecd5135a00fa9eabdb55b313f9357944d8b0bafab5159ba3b83db8bdc3284c22`.
Family/subtype/split counts and corrected Flash/K3 inference settings remain as
specified for v4. This new producer revision changes public catalog and narration
contracts; yields are not treated as a controlled treatment effect.

Before expansion, freeze and grade the complete ordinary-RP census in fresh
contexts, then independently inspect every actual admission and relevant refusals.
Require sound actual grounded admissions and aligned world behavior, with no false
certificate or unresolved transport/token accounting. All prior artifacts and
historical yields remain immutable. No training occurs during calibration or pilot.

## Version 6 focused grounding/tool calibration (before generation)

Independent v5 inspection approved 14/14 admissions and aligned world behavior.
All twelve grounded outputs used the correct native transport, but common
sentence-scoped roles still failed grammar. The next campaign targets those
remaining paths rather than repeating the working world/boundary/RP families.

- Run `calibration-2026-10-13-v6`; seed `calibration-grounding-2026-10-13-6`;
  **13 scenario seeds, K=1**; families grounded narration and tool selection.
- Plan: `d07529276a23a5f1be1e3bea3a04c34226adfb7dfc4f995e19b117865fdf6b46`.
- Six grounded narration, seven tool decisions: four exact-candidate, one
  narration-submit, one read-tool, one no-tool. Splits: twelve train, one dev.
- The seed suffix was selected from public planning metadata to cover all four
  tool subtypes before observing any answers; no quality-based answer selection.
- Same corrected Flash/K3 inference, budgets, bounded repair/review, immutable
  storage and selection settings. Public value-free sentence examples define a
  stable checkable interface without providing scenario answers or numeric values.
- Freeze the complete initial/actual-repair **`generated-grounded`** census for
  the six grounded scenarios plus narration-submit subtype. Grade all complete
  displayed surfaces blind in fresh Astra contexts before functional unblinding.
  This campaign schedules no ordinary RP; its results cannot inflate RP coverage.
- Independently inspect every actual admission, particularly common scoped
  check/attack/HP/status language and legitimate no-tool behavior. Unsupported
  actions, contradictory values and unknown consequences remain explicit failures
  or adjudications. Historical v5 outcomes are not re-admitted.

Require actual semantically sound grounded and narration-submit admissions,
acceptable separate prose outcomes, and resolved transport/token accounting before
the already frozen 175-seed pilot. Earlier independently measured world, boundary
and RP evidence supplies the other-family calibration context. No student training
or controlled retention claim follows from these generated-data grades.

The independent pre-v6 check initially held dispatch on a target-to-attacker
continuation substitution. `grounding-binding-v6` requires valid attack focus for
actorless outgoing predicates even inside compounds/records; HP/status/recipient
clauses do not authorize them. The original reproductions now adjudicate, valid
guided controls verify, and an independent follow-up cleared the frozen inventory
before any v6 paid request. This correction changes validator evidence, not the
already preregistered prompt/plan digest.

## Version 7 composition diagnostic (before generation)

The v6 separate grounded-prose ledger is locked: one pass, six failures, one
ungradeable capture. Preserve it. The next intervention changes only the
narration-specific composition guide, using existing fully bound combined
check/attack forms and semicolon-separated HP/status clauses. It does not supply
new scene facts, change tone assignments, relax grounding or lower the rubric.

- Run `calibration-2026-10-13-v7`, **13 seeds/K=1**, same public seed
  `calibration-grounding-2026-10-13-6` and grounded/tool family schedule as v6.
  The reused seed is a matched challenge, not a fresh independent sample.
- Generator-v9 plan:
  `4ba77018ff32497f1e431508f4ffc602f37179efac1782170fa9b78d29b38e04`.
  The complete public challenge identity was compared to the retained v6 plan:
  all thirteen unit IDs, scenario seeds, families/subtypes, receipts, slots,
  splits and lineage groups match. Frozen comparison:
  `/tmp/opencode/foundry-v7-preregistration.json`.
- Freeze and verify the same receipts, identities, splits and realization slots
  against the retained v6 plan before dispatch. The seven initial narration
  challenges are:

  | Unit suffix | Route | Requested voice |
  |---|---|---|
  | `8c28b0ce238d1727` | Grounded | Warm but evasive |
  | `45f400d219056232` | Grounded | Flatly transactional |
  | `3296949d536b2210` | Grounded | Warm but evasive |
  | `98bf7c802f569a5e` | Grounded | Low-register and wary |
  | `25feff308d8dc08b` | Narration-submit tool | Clipped, almost bureaucratic |
  | `740bf9a7f9ab06ed` | Grounded | Low-register and wary |
  | `6b1501d2ec6a7a77` | Grounded | Terse and procedural |

- Keep the six other tool controls; they do not enlarge the prose denominator.
- Same funded Flash/K3 settings, CPU preprocessing, budgets and immutable repair
  contracts. At most two content repairs for functional failures; **no style-based
  generation retries**. All actually dispatched narration repairs join the census.
- Freeze the complete `generated-grounded` inventory and grade complete surfaces
  in fresh independent blinded contexts under the unchanged rubric. Lock the
  ledger before functional unblinding. Report planned, graded, passing, coverage,
  conditional quality and acceptable yield, including explicit missingness.
- Independently inspect actual admissions/refusals, accounting and full-surface
  transport. Compare v6/v7 descriptively; neither is controlled student retention.

This tests the hypothesis that combined factual clauses improve cadence. It
cannot establish rich persistent storytelling from sparse receipts. **Pilot HOLD**
until actual quality and functional evidence clear the existing gates. Any
remaining voice/naturalness failure in the warm/wary challenges triggers a
source-bound public-context diagnostic instead of another prompt-tuning loop.

## Public-context follow-up

The v7 warm/wary stop rule was triggered. The next opt-in diagnostic and its
source-authority, inventory, measurement and stopping rules are specified in
[`PUBLIC_CONTEXT_PROTOCOL.md`](PUBLIC_CONTEXT_PROTOCOL.md). It schedules three
matched base pairs/six initial tasks with receipt-only and supplied-observation
arms. Implementation and source-manifest pinning are complete; independent
pre-dispatch review is pending. Real-CPU preflight made zero generation/review
attempts; no request has been dispatched for that diagnostic.

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

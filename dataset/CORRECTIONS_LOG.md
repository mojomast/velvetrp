# Training Data Foundry — Corrections Log

Chronological remediation log. Later entries supersede earlier status summaries.
**No paid synthetic training data or model training has run as of the readiness
checkpoint below.** Branch `feat/training-data-foundry`.

---

## Initial infrastructure blockers — historical checkpoint

### V1 · RPMax template drops tool calls — **CLOSED**

Verified by fetching the real tokenizer config at revision `8fb4a0d9…`. The published template
emits `role + "\n\n" + content | trim` and appends `assistant\n\n`. No `tools`, no
`tool_calls`, no `{% generation %}`. A tool-call message carries `content: null`, and Jinja's
`null | trim` renders the literal string `None` — so a naive run would train RPMax to emit
"None" for every structured action.

`dataset/src/templateProfiles.ts` pins a profile per candidate: exact model id, 40-hex
tokenizer revision, template digest, supervision spans, generation prompt, stop sequences,
deployment tool-call parser, and a **mandatory template override** where the published one is
inadequate. For RPMax that override is Llama 3.1's JSON tool format with `{% generation %}`
markers added.

`assertTemplateCanTrain()` refuses any configuration that would lose its supervision target,
supervise tool results, or lack a pinned parser. Tests assert the published template really
does drop tool calls, so a future RPMax revision that fixes this fails the test and forces a
deliberate decision rather than silent drift.

**Still needs doing outside this repo:** the CPU preprocessing smoke test that renders an
example and inspects the loss mask. A successful `apply_chat_template` is not sufficient.

### V2 · Production grounding predicate accepts receipt-contradicting narration — **CLOSED**

`providerNarrationMatchesReceipts` checks presence, not binding. Reproduced: it accepts swapped
total/DC, an opposite verdict, and an invented consequence.

`dataset/src/grounding.ts` adds subject→action→target→value→outcome binding with polarity. A
successful check no longer licenses "the lock clicks open". Death/defeat claims require
remaining HP of 0; survival claims are refused when damage was lethal. Tests encode both the
production acceptance (as a documented regression) and the foundry rejection.

### B2 · Admission was unenforced — **CLOSED**

`dataset/src/admission.ts` replaces the comment-as-invariant with `admitCandidate()`, which
recomputes digests and refuses: non-passing or stale-bound validators, missing per-family
required validators, absent or self-authored reviews, `revise` verdicts, sub-floor scores,
unresolved reviewer disagreement, missing split digest, and four documented preference hazards
(length bias, near-duplicate collapse, identical branches, unmeasured length ratio).
`revalidateAdmitted()` runs again at export.

Preference digests now cover `prompt`/`chosen`/`rejected`; the audit showed the old digest
ignored them entirely.

### B3/M1/M2 · Non-atomic ledger — **CLOSED**

`dataset/src/runstore.ts` (delegated, then reviewed): append-only event log as sole truth,
atomic registration, torn-suffix truncation under an exclusive lease, malformed interior lines
refused rather than skipped, `unitId`/`attemptId`/`parentAttemptId` so a repair supersedes its
predecessor, config-digest resume, prospective worst-case reservations, exactly-once settlement,
static ESM `child_process` import, path-safe run ids, single-writer lease.

35 tests, including fault injection at all 12 durable points. The builder mutation-tested the
suite by reintroducing each defect and confirming detection.

### B4 · Sealed guard was cosmetic — **CLOSED**

The advertised `assertSealedNotReadable` did not exist, and `freezeCorpus` itself read every
sealed file. Now **structural**:

- Sealed case content lives outside the repository. The committed corpus holds dev cases plus
  sealed *checksums*.
- `issueSealedAttestation()` emits corpus digest, sealed case IDs and counts — no content. It is
  what generation consumes.
- `createSealedSafeReader()` resolves real paths and refuses direct, traversal and symlink
  access to the sealed root. Tested against all three vectors.

### M7/M8 · Freeze could certify an empty or forged corpus — **CLOSED**

Case counts are counted per case, not per file; an empty `{}` or a zero-case array is refused;
missing lineage and duplicate IDs are hard failures. Verification **recomputes** the canonical
identity rather than trusting `corpusDigest`, compares against a trusted expected digest, and
gates on lineage disjointness. `createOnly` makes freezing create-once per version.

Verified by hand: a forged digest fails with `stored forged-diges…, recomputed 22eb7897…`.

### M6 · Triple-level lineage comparison was insufficient — **CLOSED**

Disjointness is checked per field, so character family `X` cannot straddle partitions by
changing world and scenario. Tested with exactly that evasion.

### M3 · Spend accounting — **CLOSED** (in `runstore.ts`)

---

## Partially closed

### P1 · Corpus references vs the production predicate — **RESOLVED AS A TEST ARTIFACT**

Reproduced at larger scale (153/156 rejected) but the cause was misdiagnosed: with zero receipts
the only live gate is `acknowledgesCurrentLocation`, and conversational prose does not name the
location. Passing `null` makes the real references pass.

The correct rule, now written into `GRADING.md`: `providerNarrationMatchesReceipts` applies to
`receipt-grounded-narration` and `narration-envelope` **only**. Applying it to roleplay prose
would teach a stock "you are in <location>" tic.

Open item: one fixture maps DC 14 to "Hard"; the production SRD descriptor maps Hard to 20.

---

## Not yet addressed

| ID | Item | Why deferred |
|---|---|---|
| M10 | Per-stage/attempt provenance; per-reviewer records; enforced reviewer≠generator | Needs the generation pipeline to exist |
| M11 | Production→HF message adapter | Same |
| M12 | Family C: capture the real advertised menu, label first-attempt selection vs server recovery separately | Same |
| M13 | Family D: real section-specific validation chain | Same |
| M15 | Dev feedback must return categories/aggregates only, never answers or rationales | Needs the generation loop |
| M16–M18 | K-realization selection, cluster caps, assistant-side diversity measurement, per-family assistant-token budgets, checkpoint policy | Needs generation to measure |
| CI | `typecheck:foundry` / `test:foundry` wired into the root pipeline | Deliberate: foundry checks must not be added to the default `npm test` yet |

---

## Invariant now enforced by test

The admission gate refused one of my own tests mid-remediation — I switched a candidate's
family without switching its validators, and it correctly rejected the mismatched evidence set.
Enforcement is real, not decorative.

---

## Grounding: "an Easy DC" silently unbound the second receipt

Found while testing the counterfactual-twin module, which asserted a
`multi-fact-divergence` rejection that never fired. I treated the failing
assertion as a bad fixture and nearly rewrote the test to match reality. Probing
`evaluateGroundedNarration` directly instead showed the test was right and the
gate was wrong.

**Root cause.** `CHECK_NUMBERS` spelled the article before a DC label as
`(?:a\s+)?`. The ordinary phrasing "against an Easy DC" therefore did not match,
so `parseClause` returned null for the whole clause. The fallback at
`grounding.ts:376` builds a subject-less, outcome-only claim, and `bindFact`
resolved its referent by inheriting the *previously bound* receipt.

**Observable damage**, all three reproduced against the live gate:

1. The second check receipt was never bound, so a misstated second receipt
   (total 9 narrated as 14) passed grounding undetected.
2. A false `check-outcome-contradicted` was charged to the **first** receipt.
3. `bindingsChecked` under-reported, so the gap was invisible to any caller.

This is the worst failure shape available here: a validator that silently
under-validates while reporting a confident, specific, wrong reason.

```
receipts  ledger-check Investigation 22 vs DC 15 success
          door-check   Arcana       9 vs DC 12 failure
text      "Your Investigation check comes to 22 against a Medium DC of 15: success.
           Your Arcana check comes to 14 against an Easy DC of 12: failure."

before    verdict rejected, bindingsChecked 1, door-check never bound
          no value-binding-mismatch on door-check
          ledger-check falsely charged with check-outcome-contradicted

after     verdict rejected, bindingsChecked 2
          door-check value-binding-mismatch: total is 9 check-points, not 14
          no violation charged to ledger-check
```

**Fix.** One character class: `(?:a\s+)?` -> `(?:an?\s+)?`.

Note the lesson, which I have recorded before and violated again: I nearly
"fixed" a failing test by rewriting its expectation instead of checking whether
the failure was real. The twins test was right; the gate was wrong. Run the
probe before believing the assertion.

**Coverage.** Two regression tests in `dataset/test/grounding-binding.test.ts`,
plus the `multi-fact-divergence` case in `dataset/test/twins.test.ts`, which was
first committed as a deliberate KNOWN LIMITATION tripwire so the fix could not
land silently.

---

## Generator integration follow-up

The terminal entry point now supports provider-free `help`, `verify`, and `plan`.
`generate` refuses before credential resolution without a measured tokenizer.
Importing the corpus verifier no longer executes its CLI or modifies exit status.

Review also corrected three silent mismatches:

- Teacher credential resolution defaulted to an empty environment instead of
  `process.env`. Reviewer fallback compared against the credential default rather
  than its supplied generator model; it now excludes the actual generator and
  routing aliases, and rejects an explicitly requested self-review.
- Generator provenance hardcoded temperature zero despite sampling at 0.7 by
  default. It now records the actual request temperature and reviewer provider.
- Pre-validation diversity measured prompts instead of teacher outputs. Prompts
  now have their own `plannedPrompts` measurement; candidate diversity measures
  real outputs, so repeated answers cannot masquerade as varied generations.

The certified fsync/resume test no longer replaces actual admission fields with
fixture fields before comparison. It checks the quarantined candidate view and
the complete `readAdmittedRecord()` result separately, including certificate
verification before and after reopening the store.

`buildSelectiveFidelityTwins()` materializes both conditioned preference arms.
The preferred response reverses when the public receipt facts change. Both chosen
responses must verify under their own facts, both cross-prompt responses must be
rejected for grounding, and counterfactual receipts must implement exactly the
recorded flip. Neither contrast construction nor substring instrumentation grants
admission or supplies a prose-quality score.

See `README.md` for the runnable commands and remaining live-pilot integration.
In particular, the batch runner has not yet wired resume/finalization, K scheduling
or sealed-attestation-based split enforcement.
The earlier claim that provider spend was already bounded by the run store was
unsupported by the orchestration code; the billing primitives existed but were
not called. No live dataset generation has run.

The operator clarified that generation uses RouteTok DeepSeek Flash through
`agentrouter` with ample funded credit. Provider billing reservation/settlement
is therefore optional reporting, not a pilot prerequisite. Masked supervised
token measurements still serve the training budget and template/export evidence;
they are not a check of the operator's available credits. The tokenizer error
message now states that requirement accurately and points to the provider-free
`plan` command, rather than incorrectly promising a tokenizer-free pipeline dry run.

---

## Runner integration and durable generation

The runner now binds its generated plan and splits to verified frozen metadata and
the ids/counts-only sealed attestation. Frozen IDs and each frozen lineage field
are reserved; generated lineage fields cannot cross splits. Selection revalidates
the scheduled prompt, tools and twin branches as well as certificate metadata.

K realizations, independently reviewed paired-twin drafts, quality-ranked
cluster-capped selection, explicit unit finalization/completion and CLI-owned
durable stores are integrated. Twin groups consume two selection slots and are
never selected partially. Export takes selected training rows only and permits
resume reuse only for a byte-identical, revalidated complete bundle.

Dispatch/response checkpoints are fsynced under the run-store lease. Resume
reuses actual responses/reviews and exact certificates, reconstructs local token
spend, and preserves immutable repair chains. A dispatch with no response is
uncertain and stops rather than being sent again. Canonical validation/source
bytes and completed reports are retained outside trainer-visible fields for
independent approval inspection.
Long-running checkpoints renew the lease. Lost holders cannot write or dispatch;
an old holder's close preserves the replacement lease even within the same
process. Lease timestamps use the host clock rather than an injected run clock.

Integration exposed three defects:

- Review/admission refusals double-charged the supervised ledger. Each attempt
  now charges once, and actual student labels are checked before review/admission.
  A teacher completion bound is explicitly not treated as a student-token proof.
- Gates produced assistant-only payloads, so accepted records lost their prompt
  context. Certificates now bind the actual scenario conversation, with only the
  new assistant output selected for loss.
- Realizations could rename entities independently of their oracle, omit public
  receipts/candidate menus, render an undefined tone, and construct inconsistent
  damage/HP or total/DC/outcome receipts. Scenario identities now stay fixed across
  K, public truth is rendered, and generated receipt arithmetic is consistent.

Validation: owning typecheck passed; **373 foundry tests passed, 0 failed, 0
skipped**, including fsync/reopen/crash, repair, uncertain dispatch, budget,
paired-selection, metadata isolation, export replay and the real CPU tokenizer.
A 175-seed K=3 plan scheduled 525 rows (426 train, 51 dev, 48 generated test).
The Flash/Kimi six-row CLI dry run dispatched zero attempts. The 106-case frozen
dev corpus verified. No paid teacher generation or model training ran.

See `RUNNER.md` for runtime/approval APIs and operational semantics. Provider
training-use terms and actual independent prose-quality measurement remain
pre-pilot work; the runner does not invent scores or approve its own certificates.

---

## Measured tokenizer bridge

The tokenizer gate now has real CPU evidence: Qwen3 tokenizer revision
`b968826d9c46dd6066d109eabc6255188de91218`, the existing pinned TRL training
template, Transformers 5.19.0, TRL 1.15.0, tokenizers 0.23.3, and PyTorch
2.14.1+cpu. The downloaded template matched its recorded SHA-256.

Eight provider-free fixtures were rendered/tokenized with real assistant masks,
then collated with the actual TRL collator. Both assistant-to-tool-result prefix
probes preserved text and tokens, both overlength context/target probes refused,
and padding remained masked. Unicode offsets are converted to JavaScript UTF-16.

The upstream assistant mask includes empty thinking scaffolding and unapproved
assistant history. The bridge explicitly masks those before collation and counts
actual final labels under loss. Tool syntax, numeric values, closing delimiters,
and the real `<|im_end|>` special token receive loss for approved targets.

The measured profile passes `assertTemplateReadyForExport()` and a certified test
record exports using that profile. Missing certificate approval still rejects.
The unmeasured static profile remains closed; consumers explicitly load the
measured artifacts. No dataset generation or model training has run.

Reproduction instructions, exact runtime pins, raw token/label traces and checksums
are in `tokenizer/README.md` and `tokenizer/evidence/`. The CLI can verify the local
runtime and perform a zero-dispatch generation dry run with the measured port.

---

## Corpus identity

```
corpusDigest  22eb78976caa9ca91102f75576ea19eeb8cef8d594435275630542b7ddef8e58
dev           106 cases
sealed        107 cases (content external; checksums pinned)
attestation   93ec18f54d1b7c5c98fd1861c49d9a890deb3c671e122e7cdf616e995bee65a7
```

```bash
npm exec -- tsx dataset/src/corpus.ts verify --expect 22eb7897…
npm run typecheck:foundry
npm run test:foundry
```

---

## Independent pre-generation audit and readiness remediation (2026-10-13)

GPT-6 Astra xhigh reproduced eight material runner defects at `fd039e7`. Passing
adapter tests did not exercise the orchestration gaps. The paid pilot was held.
Runner-level regressions now exercise the reported paths:

- World admission requires the complete production verdict and raw first-attempt
  validity, inspects references in the exact raw target, requires each requested
  section/minimum, and rejects dependency-key reuse. The shared enum supplies
  `quest-items`/`monster-concepts`; prompts expose sparse JSON schemas and the
  count-targeted NPC-location/quest-objective requirements.
- Narration must use the advertised single-call envelope with exactly one
  narration string and no additional supervised prose. Duplicate tool calls are
  retained for validation rather than sanitized away. Public receipts identify
  actor and target; requested receipts require bound coverage. Independent
  reviewers receive the private oracle only in their review prompt.
- Candidate-menu membership and actual requested intent are separate verdicts.
  Scenario construction defines the public request and acceptable candidate IDs
  together. Selection does not assert a committed engine settlement.
- Resume reserves all durable attempt/checkpoint/response measurements before new
  dispatch, including later spend behind an earlier budget hole. Attempts charge
  once. Unmeasurable candidates are durable null-count quarantines, never invented
  zero-token measurements; accounting uncertainty pauses new requests.
- Prepared twins supply immutable authored source lineage/digest. Original
  reserved source IDs are rejected; run/K/twin seeds cannot change source split.
  Conflicting authored identities and identical cross-split preferences refuse.
- A SQLite writer guard and nonce-based lease ownership protect acquisition,
  renewal, release, payload/event/snapshot and journal publication. Live process
  age cannot trigger takeover. Payloads publish immutably and recheck ownership
  after fault seams. File and directory entries are fsynced before registration.
- Physical dispatches/raw response outcomes are journaled before decoding.
  Uncertain transport and upstream 5xx do not repeat; 429 may retry, permanent
  refusals replay as errors, and captured malformed 2xx responses decode from
  retained bytes without another network request. Outstanding calls heartbeat.

DeepSeek's official API and general terms §4.2(3) explicitly permit **training
other models (such as model distillation)**. Exact public HTML snapshots and
RouteTok's operator confirmation are pinned in `rights/`. Matching CLI runs now
retain route-bound `verified-permitted` source evidence.

The independent blinded prose protocol freezes source artifacts, full delivered
prose surfaces, public style projections, inventory and rubric before grading.
The loader derives scores from actual retained JSON judgments with exact quotes,
unique judging contexts and global individual-before-parity phase bindings. Both
twin branches must pass and have no material style advantage. Missingness and
compromised judgments stay explicit. No fixture grade is a quality measurement;
the inherited 4/8 floor is not a newly regraded controlled stock baseline.

Tokenizer identity now binds evidence, sequence limit, thinking, truncation,
packing and selective-loss policy. `preprocessTrainingExport()` verifies approved
bundle/sidecar reload and reproduces actual SFT labels and preference branch
masks. Live CPU coverage confirms IDs/labels, masked history and selected turn
terminators survive export/reload. An eventual DPO consumer must use the emitted
explicit log-probability masks; stock DPOTrainer compatibility remains unclaimed.

Validation checkpoint: **432 foundry tests passed serially, zero failures or
skips**, including real CPU tokenization and export/reload. Owning typecheck
passed. No paid generation or training occurred during these checks. Astra's
follow-up initially found three remaining integration gaps, all subsequently
closed and independently reproduced as resolved: raw-HTTP-outcome accounting
before new calls, invalid argument string coercion, and unadvertised roleplay
tools. A shared exact advertised schema check now protects every tool-bearing
prose target. Newly created storage/export ancestor entries are individually
synced. The final independent verdict supports bounded 20-seed calibration under
the documented operating conditions; no new concrete blocker was found.
Final checkpoint after those fixes: **440/440 serial foundry tests passed, zero
failures/skips**, with the real CPU tokenizer enabled; owning typecheck clean.

## First live calibration: inference-default correction

The first 20-seed campaign at `14192e1` stopped before completion. Captured Flash
responses showed default-enabled reasoning consuming the 512-token response
budget (eight empty final answers among ten generation responses). The first
Kimi K3 review returned HTTP 400 because temperature 0 is unsupported; it fixes
temperature at 1. No records were admitted before the stop, and the ordinary RP
scenario had not run. No quality/retention score is inferred from this attempt.

Upstream documentation confirms explicit Flash `thinking.type=disabled` and K3's
always-on reasoning with `reasoning_effort=low/high/max`. The CLI now sends disabled
Flash thinking with 2048 response tokens and omits K3 temperature, requesting low
effort with 4096 response tokens. Settings join request and resume digests; final
answers alone become training targets. A fresh version-2 calibration keeps the
same preregistered scenario inventory and preserves all version-1 failures.

## Actual version-2 quality audit and focused correction

Version 2 completed 20 scenarios with 55 generation attempts/24 reviews: 4 actual
admissions and selections, 11,503 measured student-label tokens, zero unknown token
counts. All four admissions independently passed functional inspection. Blinded
ordinary-RP measurement passed 2/2 captured outputs from ONE seed, with independent
ledger pin `1607afb639561690f2cc489c732f42f041c1dbb350daf8564aca41bc19480dce`.
This is generated-data style evidence, not student retention.

The independent audit found 20/24 reviewer verdicts unusable because the prompt
omitted the parser enum, eight faithful transported grounded answers falsely
refused by grammar, and a permitted boundary response falsely refused by a
refusal-word proxy. All historical results remain unchanged in
`CALIBRATION_RESULTS.md`; progression was held.

The reviewer prompt now specifies its exact schema/enum and task-relative score
semantics. Bounded output-contract retries retain the identical candidate and all
raw reviews, with no generator repair for malformed judgment JSON. Boundary
recovery renders its safe public knowledge/authority contract, permits the
conversation and screens whole-interaction over-refusal; authority still forbids
opening the sealed lower stair. World feedback retains exact sanitizer paths,
and narration-tool subtypes preserve their underlying grounding diagnostics.

The bounded grounding grammar now binds faithful possessive HP/status transitions,
passive damage and explicit actor/target/receipt field records. All eight audited
faithful transported surfaces verify offline; 103 role/value/polarity mutations
reject. The three delivered unsupported-consequence surfaces still require
adjudication. Unknown prose is not promoted into an invented factual contradiction;
it remains explicit uncertainty. These provider-free regressions are infrastructure
evidence, not corrected historical admissions or new live quality rates.

Focused correction checkpoint: **481/481 serial foundry tests passed**, no skips,
with real CPU tokenizer/export preparation enabled; owning typecheck passed.
The final independent pre-v3 review approved the bounded 20-seed/K=1 campaign,
reproducing first-usable-rejection stopping and raw/uncertain review-retry recovery
before new work. No concrete false-admission, review-binding or accounting blocker
was found. This approves measurement readiness, not the future pilot yield.

Version 3 encountered an explicit upstream read-tool schema refusal: its empty
object schema omitted `required`. The shared declaration now specifies
`required: []`; a regression covers the advertised and dispatched read schema
plus its valid empty-object call. All captured prefix outcomes remain retained.
The preregistered version-4 calibration uses fresh durable storage and the same
scenario seed, with an updated schema-bound plan digest.

## Version-4 independent findings and final contract alignment

Version 4 completed with 11/20 admissions, 39 generation attempts/12 usable reviews,
7,691 measured target tokens and zero unknown outcomes. Independent inspection
approved 11/11 admissions, reviewed 39/39 outputs, and identified six transported
faithful grounding false refusals. Actual yielded records contain 1,847 tokens.
Its one ordinary-RP sample passed independently pinned style grading; no retention
or preference-parity result is inferred.

`grounding-binding-v4` preserves scoped period-delimited records and bounded natural
sentences. Eleven of twelve prior grounded surfaces verify offline; the remaining
record-count preamble stays explicit adjudication. New role/value/type mutations
reject, and unsupported narration consequences remain adjudication. Generator
prompts persistently specify native one-call submission and complete prose; repair
feedback retains exact tool arguments. Unchanged candidates cannot obtain another
usable review verdict (transport IDs are ignored only for this duplicate guard),
closing the observed revise/accept disagreement on an identical RP repair.

World pins now supply compatible exact enemy-template identities. The adapter
rejects inconsistent identity encodings and preserves exact kind/pack/version/id
comparison through production. Generator/reviewer prompts align all three narrative
roster exclusions and permit inert concepts even when compatible pins are available.
Related server campaign-generation-validation tests passed serially; focused
foundry adapter/runner/generation checks and owning typecheck passed.
Final checkpoint: **523/523 serial foundry tests passed, zero skips/failures**,
including real CPU tokenization/export reload. Independent pre-v5 review reproduced
ten targeted scope/replay/duplicate/catalog checks and approved the bounded
20-seed/K=1 campaign. No patch-readiness blocker was found.

## Focused grounding calibration readiness

Independent v5 inspection approved all fourteen actual admissions and the complete
one-sample ordinary-RP ledger. Grounded admission remained zero despite correct
native transport. `grounding-binding-v6` now handles common scoped check/attack
declarations and contextual total/result/damage continuations, with role/property
ownership checks and context reset on unknown/ambiguous prose. Attack pronouns need
an established attack referent; target/status statements cannot supply one.

Ten of twelve prior grounded surfaces verify offline; unsupported record-count/
settlement preambles and “You read the ground” remain adjudication. Three narrow
narration-submit surfaces verify. No historical admissions are recomputed. Added
160 mutation-matrix cases retain the earlier 103 and 192 calibration mutations.

Public value-free sentence examples define a stable, role-bound output interface
without supplying scenario values. Twenty fixture scenarios spanning both check
outcomes and multiple entities pass the complete native-call admission path.
Focused live calibration schedules thirteen seeds covering grounded narration and
all four tool subtypes; its `generated-grounded` style census stays separate from
ordinary RP. The conditional pilot's public plan was updated before any pilot
requests to bind these generator-v8 contracts, preserving seed/count/split policy.

Validation checkpoint: **559/559 serial foundry tests passed, zero skips/failures**,
including the real CPU bridge and export reload; owning typecheck passed.

The pre-v6 independent check found a target-to-attacker scope substitution in the
draft grammar: a recipient/status head could license outgoing damage/hit predicates.
Paid v6 dispatch was held. The correction requires a genuine attack-event focus
for actorless outgoing predicates, including compound/record components; recipient,
HP, status and passive-damage clauses switch focus away from the attack. Failed
or ambiguous siblings cannot supply an event premise. A 624-case target/outgoing
matrix and complete guided six-scenario controls exercise these conditions.

Final independent follow-up resolved the original seven recipient-focus probes
and found no remaining concrete variant. **570/570 serial foundry tests passed,
zero failures/skips**, including real CPU tokenization/export reload; owning
typecheck passed. The frozen thirteen-seed/K=1 v6 calibration received GO.

## Version 6 observed quality hold

The live focused campaign completed at producer `c8f0a10`: thirteen admissions
from fifteen generation attempts, thirteen reviews, twenty-eight captured
physical/logical responses and 1,092 measured supervised labels. All six grounded
scenarios and all four tool subtypes admitted under the functional pipeline.

Fresh blinded style judgments were locked before independent functional review.
The complete eight-output `generated-grounded` census has one pass, six failures
and one ungradeable mixed-content capture. All six failures have naturalness zero;
four also fail voice. The value-free guide repaired checkability but induced a
repetitive report cadence. Grounded style results remain separate from ordinary
RP. Expansion stays held while a fresh guidance correction is designed and
measured; these locked judgments are not replaced with revised ratings.

Independent v6 inspection confirmed all thirteen certificates, receipt-backed
answers and the prose-ledger pin, and inspected all fifteen generations and
twenty-eight captured responses. Both transport-mixed attempts were refused
and separately regenerated. The selected labels total 969 (877 train, 92 dev),
with 123 refused-attempt labels; manifest's zero spend projection is not used.
The no-tool decision is legitimate but its invented room details are unverified.
Corrected derived summaries include event-level transport failures, preserving
the original summary and all producer evidence. Export registry construction
must include exact reviewer-prompt bytes from dispatch checkpoints.

## Version 7 composed-beat diagnostic readiness

Generator-v9 replaces the short-sentence script with alternative, already-supported
combined check/attack forms and semicolon-bound HP/status clauses. Requested voices,
public receipts, native-call/empty-content obligations, whole-clause grounding and
the style rubric are preserved. The thirteen-scenario v7 challenge matches v6's
unit IDs, seeds, receipts, slots, subtypes, splits and lineage. This is a matched
prompt intervention, not an independent sample or student-retention measurement.

Validation: the affected runner file passed 57 tests with its existing CPU check
env-gated; that CPU check then passed separately with the real tokenizer enabled.
Four composed binding tests cover both check outcomes, zero-damage/equal-HP misses,
role/value/status mutations and unsupported suffixes. Owning typecheck passed.
No full-suite rerun was needed for this narration-guide-only change.

Independent narrow pre-dispatch review cleared the frozen thirteen-unit
composition diagnostic, finding no new blocking bug, answer leak or causal-scope
regression. Report: `/tmp/opencode/foundry-v7-precalibration-review.md`.
The pilot remains held; warm/wary voice or naturalness failures trigger the
source-bound public-context diagnostic rather than another prompt-only loop.

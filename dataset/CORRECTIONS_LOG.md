# Training Data Foundry — Corrections Log

Status of the audit remediation. **No synthetic training data has been generated.**

Branch `feat/training-data-foundry`. 70 tests pass, typecheck clean.

---

## Blockers — all closed

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

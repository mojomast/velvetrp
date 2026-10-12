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
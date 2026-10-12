# Grounding, boundary and action initiation — measured on both stock models

Frozen dev partition, 106 cases, pass@1, no retries, sealed never touched.
VelvetRP unmodified at `4447d2cdb0260174bb2c2461f76600d11980c427`.

| | |
|---|---|
| Corpus | `origin/feat/training-data-foundry` @ `57316aa`, 11 dev files, 106 cases |
| Backend | llama.cpp `b11574` CUDA, via the same `tool_choice` gateway |
| Controls | ctx 24,576 · KV `q8_0`/`q8_0` · `-ngl 99` · `tool_choice: auto` · temperature 0 · max_tokens 1024 · `reasoning_effort: none` |
| Prompt parity | **106/106 identical payload digests** across the two runs |

---

## 1. Corpus reconciliation

**`devCaseIdListDigest` does not match, and cannot be made to match — there is no
implementation of it.** `git grep` across the whole ref finds
`d3baa542c0a0e4b666d6e1f52641803e0b44b68224f3ed74fca3db411ab194f9` in exactly two places:
`CORPUS_FINGERPRINT.json` and `EVAL_PROMPT_GROUNDING_BOUNDARY.md`. Nothing in `dataset/src`
computes it. I recomputed SHA-256 over the sorted 106 case IDs under six canonicalisations
(LF join, LF join + trailing, comma join, comma join + trailing, JSON array, concat); none
reproduce it. It is a published constant with no reference implementation, so a miss is
**unverifiable**, not a mismatch.

**Byte-level content identity is established by a check that *is* reproducible.** All 11
per-file SHA-256 values match `CORPUS_FINGERPRINT.devFileSha256` exactly:

```
MATCH  flexible-roleplay        MATCH  multi-turn-continuity   MATCH  prose-quality
MATCH  json-schema-generation   MATCH  narration-envelope      MATCH  receipt-grounded-narration
MATCH  narrative-initiative      MATCH  no-tool-behavior        MATCH  tool-selection
MATCH  npc-knowledge-boundary   MATCH  player-agency
```

Shape also matches: 106 cases, 106 unique IDs, 11 categories, and every per-category count
the brief named — `receipt-grounded-narration` 11, `npc-knowledge-boundary` 10,
`player-agency` 10, `tool-selection` 12, `no-tool-behavior` 10.

> A trap worth recording: my first extraction produced **11/11 mismatches**. That was my
> fault, not the corpus's. PowerShell's `git show … | Out-File -Encoding utf8` prepends a BOM
> and rewrites LF to CRLF, so the files were not byte-identical to the blobs. Reading the raw
> blob through `child_process` and hashing that is what verifies anything.
> `data/velvet-bench/eval/fetch-and-verify.mjs` does this and is re-runnable.

**Reconciliation against what I already had: they are different artifacts, and nothing is
invalidated.** My local `6310180d…` is the root digest of a corpus I authored locally —
`corpusVersion: velvet-baseline-sealed-v1`, 31 files of world/character/scenario *assets*,
containing **zero cases** with `id`/`dimension`/`setup`/`expected`. It is not a stale pull of
this corpus; it was never a pull of it, because the corpus has never existed on `main`. Cause
confirmed: all 11 files came from the remote ref, `main` stayed at `4447d2c`.

**What this does and does not invalidate.** Nothing measured so far was scored against the
old corpus. The Qwen3.5-9B re-baseline (9/10 adherence, 0% materialization) came from the
repository's own free-form evaluator — 18 turns, seed 11, bootstrapped world. The old corpus
was sealed and verified but never graded. **Those numbers stand.** I am adopting
`22eb7897…` as canonical for all future work.

---

## 2. Per-model, per-category

`valid` = Layer 1 envelope passed. `correct` = valid **and** Layer 2 **and** Layer 3.
Wilson 95% CI on `correct`.

| category | n | Qwen3-8B valid | Qwen3-8B correct | Qwen3.5-9B valid | Qwen3.5-9B correct |
|---|---:|---:|---:|---:|---:|
| flexible-roleplay | 10 | 10/10 | 6/10 (60.0%) | 8/10 | 7/10 (70.0%) |
| json-schema-generation | 10 | 10/10 | **0/10** | 10/10 | **0/10** |
| multi-turn-continuity | 9 | 9/9 | 4/9 (44.4%) | **0/9** | **0/9** |
| narration-envelope | 8 | 8/8 | 6/8 (75.0%) | 3/8 | 2/8 (25.0%) |
| narrative-initiative | 8 | 7/8 | **0/8** | **0/8** | **0/8** |
| no-tool-behavior | 10 | 6/10 | 3/10 (30.0%) | 6/10 | 4/10 (40.0%) |
| npc-knowledge-boundary | 10 | 9/10 | 3/10 (30.0%) | **0/10** | **0/10** |
| player-agency | 10 | 10/10 | 1/10 (10.0%) | 3/10 | 0/10 |
| prose-quality | 8 | 8/8 | 4/8 (50.0%) | 3/8 | 0/8 |
| receipt-grounded-narration | 11 | 6/11 | **0/11** | 3/11 | **0/11** |
| tool-selection | 12 | 7/12 | 6/12 (50.0%) | 7/12 | 4/12 (33.3%) |
| **ALL** | **106** | **90/106** | **33/106 (31.1%) [23-40]** | **43/106** | **17/106 (16.0%) [10-24]** |

Qwen3.5-9B's 63 invalid envelopes are **serving/protocol, not capability**, and are reported
in their own bucket as GRADING.md requires.

---

## 3. The initiation / abstention split — reported separately, never blended

### tool-selection, `outcome=tool-call` (n=7)

| | Qwen3-8B | Qwen3.5-9B |
|---|---:|---:|
| emitted a call | 7/7 | 7/7 |
| **FALSE ABSTENTION** (no call) | **0/7** | **0/7** |
| degenerate loops (>1 call) | 0/7 | **3/7** |
| of single calls, correct | 6/7 | 2/4 (2 wrong-arguments) |

This is where my earlier "Qwen3.5-9B under-calls" framing was **too coarse**, and the corpus
corrects it. On these 7 cases Qwen3.5-9B initiates at 100% — identical to Qwen3-8B. What it
does instead is degenerate: all three loop cases named the **correct tool** and then emitted
43–45 copies of it with **`{}` arguments**, running to the 1024-token cap
(`finish=length`). So it selects the right tool and cannot construct the argument object.

### no-tool-behavior, `outcome=no-tool` (n=6)

| | Qwen3-8B | Qwen3.5-9B |
|---|---:|---:|
| correct abstention | 3/6 | 3/6 |
| **FALSE CALL** | **3/6** | **3/6** |

The two models are **identical** here, failing the same three cases with the same tools:
`world_state.read` on `dev-notool-01`, `exact_actor_travel.select` on `dev-notool-05`,
`exact_progression_apply.select` on `dev-notool-06`. This is a shared trap, not a model
difference.

### All `outcome=tool-call` cases (n=84) — where the models actually diverge

| | Qwen3-8B | Qwen3.5-9B |
|---|---:|---:|
| **FALSE ABSTENTION** | **7/84 (8.3%) [4-16]** | **54/84 (64.3%) [54-74]** |

Qwen3.5-9B's abstention is **tool-specific, not uniform**: `npc-knowledge-boundary` 10/10,
`multi-turn-continuity` 9/9, `narrative-initiative` 8/8, `receipt-grounded-narration` 8/11,
`player-agency` 7/10. Against `submit_adventure_narration` it largely declines to answer.

---

## 4. Grounding, leakage, agency

### Grounding — stricter oracle, `grounding-binding-v1`

I used the foundry's own `dataset/src/grounding.ts` (subject→action→target→value→outcome
binding with polarity), imported verbatim except one relative import path; the diff against the
ref blob is that single line. I did **not** use `providerNarrationMatchesReceipts` as the
oracle, for the reason the brief gives.

| | Qwen3-8B | Qwen3.5-9B |
|---|---:|---:|
| receipt-bearing cases | 19 | 19 |
| produced gradeable narration | **14/19** | **6/19** |
| no binding violation (of graded) | 11/14 (78.6%) | 5/6 (83.3%) |
| fully correct (violation-free **and** boundaries pass) | **6/14 (42.9%)** | **2/6 (33.3%)** |

Violation codes, denominator = graded narrations:

| code | Qwen3-8B | Qwen3.5-9B |
|---|---:|---:|
| `fabricated-outcome` | 1 | 0 |
| `fabricated-consequence` | 0 | 0 |
| `check-outcome-contradicted` | 0 | 0 |
| `travel-destination-missing` | 0 | 0 |
| `damage-ungrounded` | 1 | 0 |
| `check-subject-missing` | 1 | 1 |
| `inventory-item-missing` | 1 | 0 |

**The honest headline: `receipt-grounded-narration` is 0/11 on both models.** Neither can do
grounded narration. Two concrete failures, both caught by the stricter binding:

- `dev-ground-01` (both models) — receipt: *Investigation, total 22, DC 15, success*. Both
  wrote *"successfully passed the **Perception** check with a total of **14**"*. Wrong skill,
  wrong total. `check-subject-missing`.
- `dev-ground-04` (Qwen3-8B) — receipt: 9 slashing applied, target 22 → 5 HP. The model
  narrated death. `fabricated-outcome` + `damage-ungrounded`.

**Grounding is not meaningfully measurable on Qwen3.5-9B.** Only 6 of 19 cases produced any
text, so "5/6 no violation" is 5 observations, not a rate. I would not put a training budget
against it.

### Boundary — leakage and fabrication are different things

| | Qwen3-8B | Qwen3.5-9B |
|---|---:|---:|
| npc-knowledge-boundary, n | 10 | 10 |
| produced gradeable output | 9 | **0** |
| **GM-only fact leakage** (of graded) | **0/9 (0.0%) [0-30]** | **0/0 — unmeasurable** |
| **fabricated in-world content** | **2/9 (22.2%) [6-55]** | 0/0 — unmeasurable |

Qwen3.5-9B's "0/10 leakage" is **an artefact of saying nothing at all**, not a safety win. It
must not be read as one.

Qwen3-8B's two fabrications: `dev-npc-06` asserted *"her brother is alive"* where the case
forbids it, and `dev-npc-09` asserted *"he finally…"* conceding an NPC the case forbids
relenting on. **Leakage of GM-only material is not the risk — inventing in-world content is.**

### Agency — "fails the category" is not "steals the player's agency"

| | Qwen3-8B | Qwen3.5-9B |
|---|---:|---:|
| player-agency, n | 10 | 10 |
| produced gradeable output | 10 | 3 |
| category failures | 9/10 (90.0%) | 3/3 (100%) |
| **AGENCY VIOLATIONS only** | **1/10 (10.0%) [2-40]** | **0/3** |
| required-anchor omissions only | 9/10 | 3/3 |

Qwen3-8B's headline "90% agency failure" is **mostly not agency at all**. Exactly one case
committed a real violation — `dev-agency-08` wrote *"You **open** the sluice housing"*, acting
for the player. The other nine failed because the narration never named the NPC (`Haug` ×7,
`rail`, `lock`) or the required object (`housing`).

---

## 5. The dominant failure mode, and it is not what the brief expected

Decomposed across all 106 cases:

| failure mode | Qwen3-8B | Qwen3.5-9B |
|---|---:|---:|
| **omitted a required anchor (sole cause)** | **40 (37.7%)** | 18 (17.0%) |
| fabrication / asserted unearned content | 14 (13.2%) | 4 (3.8%) |
| omitted a required anchor (with another fault) | 9 (8.5%) | 2 (1.9%) |
| false call | 9 (8.5%) | 6 (5.7%) |
| abstained (no tool call) | 7 (6.6%) | **54 (50.9%)** |
| grounding binding violation | 3 (2.8%) | 1 (0.9%) |
| wrong tool / wrong arguments | 0 | 3 (2.8%) |
| degenerate multi-call loop | 0 | 3 (2.8%) |

For Qwen3-8B, **40/106 fail for exactly one reason: they omit a required anchor.** The anchors
are overwhelmingly proper nouns carried from the setup into the prose — `Haug`, `Ailsa`,
`Oswin`, `Josiah`, `Perrin`, `Cully`, `Tallow Street`, `The Bleeding Ledger`, `lamp`, `stair`.
The model paraphrases and reaches for pronouns: *"She glances at the clipboard…"*, never
naming her. That is a **referential fidelity** deficit, and it is a far better training target
than either grounding or boundary, both of which are already near-ceiling on leakage.

Both models score **0/10 on `json-schema-generation`**. Neither can emit the required envelope;
Qwen3.5-9B returned a bare `[]` on 9 of 10 cases. That is a shared, unaddressed deficit that
does not appear anywhere in the current dataset weighting.

---

## 6. Controls I could **not** hold constant

Ordered by how much each threatens the comparison.

1. **Layer 2 deep-equal covers only 7 of 84 tool-call cases.** 77 declare a single
   `narration` argument whose `expected` value is an exemplar paragraph — free prose that
   cannot be deep-equal graded. Those are graded by Layer 3 anchors instead. So for narration
   cases `correct` means *"met the anchor constraints"*, **not** *"matched the reference"*.
   This is the single biggest caveat on the headline numbers, and it applies to both models
   equally.
2. **The models are not a controlled pair.** Different size (8B vs 9B), different quant
   (Q4_K_M vs UD-Q4_K_XL), and different architecture — Qwen3.5 is hybrid linear/full
   attention with an `mmproj` projector loaded. Model age and quant quality are **confounded**.
3. **Reasoning-off mechanism differs.** Qwen3.5-9B runs server-side `--reasoning off`;
   Qwen3-8B has no such flag and depends on the per-request `reasoning_effort: "none"`, which
   I sent to both. Effective state is the same, but only one path was exercised per model.
   Verified: **0/106 cases on either model emitted `reasoning_content`**, so neither burned
   budget on thinking.
4. **Speaker-label normalisation is additive in my grader.** GRADING.md asks for label
   stripping so a correct answer does not fail on formatting, but a label pattern also matches
   ordinary `"word:"` prefixes — my first attempt turned `"a total: 22 result"` into
   `"22 result"`, silently deleting content. I therefore strip labels into a **second**
   haystack consulted only for `mustInclude`; `mustNotInclude` uses the strict, unstripped
   haystack. Effect: `mustInclude` is marginally more forgiving than a literal reading of
   GRADING.md. `mustNotInclude` is unaffected — it is in its strictest form. 15 unit checks in
   `test-normalize.mjs` pin this, including the ` ``` ` case where a needle normalises to the
   empty string and would otherwise match every haystack.
5. **One run per model.** pass@1, no retries, no resampling. Wilson CIs cover binomial
   sampling error only, **not** run-to-run variance. These are single samples.
6. **`tool_choice` was never forced** (`auto` throughout) — deliberate, since forcing would
   destroy the initiation measurement. Consequence: the 4 `clarify` cases are graded on the
   presence of a question mark, which is the weakest layer in the corpus.
7. Leak markers are scanned against **prose only**, never against serialised arguments —
   `candidateId` and `kind: "v1"` are legal required arguments in the exact-candidate cases,
   and scanning arguments would fail correct answers. Conversely `mustNotInclude` is checked
   against prose ∪ arguments, because cases like `dev-tool-01` forbid the argument *keys*
   `destination`/`party`/`revision`.
8. **Sealed was never run.** Confirmed by the committed attestation: 107 sealed cases across
   11 categories live outside the repository; only their checksums are pinned.

---

## 7. What this says about the dataset

Both of the families the brief sent me to measure are now measured, and the answer is not the
one the budget assumed:

- **Grounding and boundary are not where the budget should go.** GM-only leakage is 0/9 on the
  one model where it is measurable, and the only real boundary fault is fabrication (2/9).
  Neither model leaks hidden state. A heavy grounding/boundary tranche would be paying for a
  gap that is largely absent.
- **Grounded narration is 0/11 on both.** That is a genuine, large gap — but it is entangled
  with referential fidelity, because both models fail to carry the receipt's own terms into the
  prose. Fixing pronoun substitution is likely a prerequisite for fixing grounding, not a
  separate tranche.
- **Action initiation splits cleanly by tool.** Qwen3.5-9B abstains on
  `submit_adventure_narration` (64.3% of all tool-call cases) while nominally initiating on
  exact-candidate tools and then degenerating into 43-call loops with `{}` arguments. A single
  "tool selection" weighting cannot express that; it needs to be split by tool family.
- **Referential fidelity is the largest single measured deficit on the more reliable model**
  (37.7% of all cases, sole cause), and it is cheap to train and currently unweighted.
- **`json-schema-generation` is 0/10 on both** and appears nowhere in the weighting.
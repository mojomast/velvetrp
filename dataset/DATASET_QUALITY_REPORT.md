# Dataset quality report

This report separates **mechanical correctness**, **prose quality** and
**student impact**. They are measured differently and none substitutes for
another. All numbers are actual measured values from completed runs; where
something was not measured, it says so.

Source of truth for per-run detail: [`CALIBRATION_RESULTS.md`](CALIBRATION_RESULTS.md).

---

## 1. How quality is measured

| Dimension | Method | Where |
|---|---|---|
| Mechanical correctness | Deterministic validators: typed receipt binding, boundary leakage, player agency, tool envelope, world schema/reference closure | Per attempt, in the durable journal |
| Independent correctness | A separate reviewer model (`agentrouter:kimi:k3`), never the generator, with a bounded contract-retry and coarse review floors | Per admitted candidate |
| Prose quality | Blinded human-style rubric (`velvet-blind-prose-v1`): voice, clarity, proportion, naturalness, each 0–2, every dimension ≥1 to pass | Fresh isolated GPT-6 Astra contexts, locked before functional unblinding |
| Student impact | Not measured. No training has been run | — |

The rubric rates **style only**. Fluent prose can pass style and still fail
factual binding, and correct binding can pass with poor prose. The two are
reported side by side, never combined into one score.

## 2. Mechanical correctness — strong

| Family | Status |
|---|---|
| World generation | Independently approved across v5. Production validation chain passes without sanitization; catalog identities, typed references and roster rules are sound |
| Tool selection | Independently approved across v5–v7. All four subtypes (exact-candidate, narration-submit, read-tool, no-tool) admit with exact arguments |
| Boundary recovery | Independently approved across v5. Barrier stays closed, NPC respects its knowledge limit |
| Grounded narration | Functionally admitted. Actor/target, check total/DC/outcome, damage, HP and status bind exactly; no invented outcome survived |
| Creative roleplay | Structurally gated (fail-closed transcript contract, never supervises player turns) |

No false admission was found by any independent audit of v5, v6 or v7. The
validators fail closed: an unsupported clause becomes an adjudication, never a
pass, and a repair triggered by a functional failure still cannot admit
unsupported content.

## 3. Prose quality — the blocker

Measured on **final admitted narration targets**, which is stricter than an
all-attempt rate because it counts only what would actually be trained on:

| Run | Final narration targets passing style **and** function |
|---|---:|
| v6 | 1 / 7 |
| v7 | **3 / 7** |
| v7, paired check-and-damage subset | 2 / 6 |
| v7, warm/evasive | **0 / 2** |
| v7, wary | **0 / 2** |
| v8, receipt-only control | 1 / 5 |
| v8, observations supplied | **0 / 4** |

The pattern is consistent and specific. The model produces mechanically exact
narration in a **checklist register**: short, repeated, actor-named report
sentences. Blinded judges score `clarity` high, `proportion` workable, and
`naturalness` at 0 with `voice` often 0.

When the model does reach for a richer register, it adds claims the receipts do
not establish, and the grounding gate correctly refuses. In v8 the warm/evasive
attempt *"…whatever you were reaching for stayed out of reach…"* was refused and
its replacement was plainer.

**This is a genuine tension, not a tuning miss.** Strict receipt grounding and an
expressive fictional register pull in opposite directions for this task shape.

## 4. The tested remedy did not work

The preregistered stop rule from v7 was to supply source-bound public context
rather than tune the prompt again. The v8 diagnostic did exactly that: three
matched pairs, receipt-only against the same narration with two independently
authored observations (an amber lamplight, closed shutters).

- The observations were **used in every observation-arm output**, so integration
  works.
- The observation arm passed **0/4**; the control arm passed **1/5**.
- Failure rationales are unchanged: checklist cadence, absent voice,
  `naturalness` 0.

**Conclusion: two inert observations do not remedy the register problem.** Per the
stop rule, no further tuning against those frozen cases is authorized.

## 5. Creative stream — implemented, evaluated, and materially better

The creative stream is a large, tested module with strong structural guarantees
(never supervises a player turn; deterministic; fail-closed). It is now wired
into the pipeline and has a measured live yield.

Four calibration runs, each an honest record:

| Failure | Cause | Status |
|---|---|---|
| `transcript-player-impersonation` on ordinary dialogue | The detector refused second-person address anywhere in a sentence | Fixed: a match must now begin a main clause |
| `transcript-not-json` | The response was truncated by the output-token budget | Budget raised 2048 → 16384; truncation went to **zero** |
| `transcript-turn-count-mismatch` | The teacher does not reliably obey an exact-turn-count instruction | Fixed: the parser accepts any structurally valid length in range |

Latest run: **8 of 10 units admitted**, 6 train / 2 sealed-test, **8 distinct
character lineages**, **8/8 multi-turn**, 3,882 admitted labels. Remaining
refusals are teacher non-compliance (impersonation 9, speaker-alternation 9,
turn-count 2, grading-metadata 1), not pipeline defects.

The **corpus run** (`creative-2026-10-13-v6`, 30 units) admitted **22 / 30** and
contributes the 19 creative train records in the exported bundle. Its 34
transcript refusals are all teacher non-compliance against the fail-closed
contract, not detector bugs. See
[`CALIBRATION_RESULTS.md`](CALIBRATION_RESULTS.md) for the full run record.

**Independent creative review: 3 pass / 2 fail** on a stratified sample of five
conversations, judged in fresh contexts against a nine-criterion creative rubric
with the player's turns marked as not targets. This is a real measured score for a
family that previously could not be evaluated at all.

Two caveats that matter:

1. One failure was `dialogueNaturalness: 0` — everything the character said was a
   polished speech. Real, and a reason to sample more before scaling.
2. The other failure was `writesPlayerActions: true` — the character asserted an
   unstated player intention (*"You want to know what I want"*). **The structural
   gate admitted it**, because `want` is not in the impersonation verb list.
   Structural admission is therefore not sufficient evidence of player-agency
   preservation; independent review caught what the pipeline missed.

No claim is made that training on these conversations improves a model.

## 6. The exported corpus

The corpus campaign produced a real dataset, and it was exported under an
independently issued approval.

| Measure | Value |
|---|---:|
| Train records | **155** |
| Supervised (loss-bearing) tokens | **39,435** |
| Families | world 46 · tool 39 · boundary 30 · narration 21 · creative 19 |
| Excluded | 21 dev and 20 sealed-test rows are **not** in the bundle |

Per-record supervision is skewed: median 158 labels, p75 415, max 895. World
generation and creative roleplay carry most of the signal.

**Independent approval took five submissions.** Four were rejected, every
rejection correct, and every one concerned **approval provenance rather than
record content**: a gate-result blob masquerading as a validator implementation;
a validator mapped to the wrong module; a composite digest computed but never
registered, which would have failed all 155 records at export; and an
implementation closure reaching outside `dataset/src`. The resolution pins the
inspected commit's git tree object, so completeness is true by construction.

Across every round the reviewer's content checks passed identically: 155 records
matched to admitted train records, 155 accepted reviews matched to certificate
scores, 210 disjoint planned lineages, zero duplicates, and an offline tokenizer
replay of all 155 records reproducing **39,435 supervised tokens** exactly.

Pins, checksums and the approval history: [`CORPUS_EXPORT_V1.md`](CORPUS_EXPORT_V1.md).

## 7. What is explicitly NOT established

- **No student-retention measurement.** The historical raw stock answers needed
  to ground the inherited 4/8 policy floor were never recovered. 4/8 is a policy
  threshold, not a measurement, and no controlled before/after comparison exists.
- **No trained model.** Nothing here demonstrates that training on this data
  improves roleplay quality or task accuracy.
- **No controlled model comparison.** The Qwen3.5-9B baseline differs in
  quantization, size and runtime; the confound is model-side and unrecorded, so
  no comparison is claimed.
- **No persistent-storytelling evidence.** Two inert observations are not
  evidence of sustained narrative.
- **No optimal mixing ratio.** Whether structured training degrades roleplay is
  exactly the question a controlled comparison should answer, so no ratio is
  asserted in advance.

## 8. Honest summary

The infrastructure is strong, independently inspected, and fails closed. The
structured families are genuinely usable, and a **155-record corpus has been
exported under independent approval**. The grounded-narration prose floor is
still unmet, and the one remedy that was preregistered and tested did not work.
The creative stream is the strongest answer to the roleplay goal but is only
**3/5** on a small independent sample, with one player-agency violation the
structural gate admitted. No model has been trained, so nothing here
demonstrates improvement. A truthful, measured position with validated reusable
infrastructure is preferable to contaminated training data.

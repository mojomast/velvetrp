# Synthetic-data best practice for the Velvet foundry

Scope: what the literature and practitioner record actually say about building a
synthetic SFT corpus for an 8B model that must deliver **two** capabilities —
structured RPG participation and engaging character roleplay — and what that
implies for this project's next step.

This document is advisory. It changes no plan, no manifest and no code. It cites
sources; where a claim is my reasoning rather than a measured result, it says so.

---

## How to read the evidence labels

Every substantive claim below carries one of three labels.

- **[Measured]** — a result reported with numbers in a paper or a first-party
  report, with a URL. I have not re-run it.
- **[Consensus]** — a repeated practitioner recommendation or an unsourced
  industry norm. Directional, not proof.
- **[Reasoning]** — my own inference from the project's own measured artifacts
  and/or the cited literature. Treat as an argument, not evidence.

The project's own numbers come from `FOUNDRY_FINAL_REPORT.md`,
`DATASET_QUALITY_REPORT.md`, `CALIBRATION_RESULTS.md`,
`DATASET_COVERAGE.md`, `BASELINE_SIGNAL.md`, `PROSE_MEASUREMENT.md` and
`creative/CREATIVE_STREAM_PROTOCOL.md`. I did not alter any of them.

---

## Top recommendations (ordered by expected impact)

**R1. Train a smoke-test LoRA on the data you already have before spending
generation budget.** [Reasoning] No trained model exists. The approved export is
4 records / 806 supervised labels; the creative v4 calibration admitted 8
conversations / 3,882 labels. That is enough for a one-GPU LoRA smoke test and a
same-runtime base comparison. It answers the only question that matters before
scaling: *does this data move the model at all?* The most expensive mistake
available here is generating "thousands of examples" to feed a pipeline whose
training value is entirely unmeasured. Literature strongly supports
small-curated-data viability (LIMA 1k, LIMO 817, AlpaGasus 9k, DEITA 6k), so the
smoke test is cheap insurance, not a side quest.

**R2. Exclude or re-scope `grounded-narration`; do not train it as prose.**
[Reasoning] Its own measured joint style+function rate is 3/7 (v7), 0/2 warm,
0/2 wary, and 1/9 in the v8 diagnostic. Under the "superficial alignment"
reading of SFT — fine-tuning mainly teaches format/style, not knowledge — training
on mechanically exact checklist prose teaches exactly the checklist register the
project is trying to get away from, and may bleed that cadence into roleplay. If
the narration capability is still wanted, train it as a **structured
output-binding** task (receipt fields, tool envelope, exact values) with the
expressive-prose floor dropped, and repair the *receipt schema / target shape*
upstream. Supplying two inert observations failed because two facts are not a
voice.

**R3. Do not blend structured and creative into one adapter as the first
experiment. Train separate adapters and compare.** [Reasoning + Measured] There is
measured evidence that tool/function-calling SFT degrades other behaviour, and the
creative protocol's own `transcript-mechanical-register-leak` gate means the two
capabilities have *opposite* register policies under overlapping prompts. Two
cheap LoRAs give you: a clean read on interference, a fallback (route by request
type), and a merge candidate. One blended LoRA gives you a confound.

**R4. Treat roleplay as a first-class goal, not a 6% retention tranche.**
[Reasoning] `FAMILY_WEIGHTS["roleplay-conversation"] = 0.06` and the protocol
describes it as "a compact, deliberately non-zero retention tranche." But engaging
character roleplay is one of the two stated goals, and the creative stream is the
*only* stream that produces the target prose. A 6% scheduled share is inconsistent
with a co-equal goal. Set the creative share deliberately, and measure the
achieved mix (`selectCreativeMix` already reports achieved vs requested).

**R5. Fix the admission gates and the judge before generating more.** [Reasoning]
Three concrete defects block a trustworthy corpus: (a) the player-impersonation
detector admitted a real agency violation (`"You want to know what I want"`); (b)
`My <skill> check …` is a known false refusal the model produces naturally, so it
will reject good grounded attempts and train the model *away* from natural
phrasing; (c) the teacher and the "independent" blinded judge are the same model
family (GPT-6 Astra), which is a documented self-enhancement risk. Fix all three
before spending generation budget, because a gate bug at scale bakes itself into
the corpus.

Two further recommendations that are cheap and high-value: **R6. Diversify
generation (multiple teachers / decoded temperatures / prompt attributes) and
deduplicate** — single-teacher synthetic data is monotonous and CE-SFT collapses
output diversity. **R7. Cap total volume around a few thousand curated examples
and spend the rest of the budget on diversity and verification, not row count.**

---

## 1. Synthetic instruction/SFT data best practice

### 1.1 Quality and diversity beat volume — this is measured, not folklore

The strongest, most reproducible finding across independent groups is that
alignment/SFT data has sharply diminishing returns to volume and much larger
returns to curation.

- **LIMA** fine-tuned a 65B LLaMA on 1,000 curated examples and reported
  responses "equivalent to or strictly preferred over GPT-4 in 43% of cases"
  (the paper's own framing), with ablations showing that filtered data beats
  unfiltered and that *doubling* the training set did not improve response
  quality. LIMA's summary recommendation is "optimize for diversity and quality
  over quantity." [Measured] https://arxiv.org/abs/2305.11206
- **AlpaGasus** filtered Alpaca's 52k examples down to 9k high-quality ones
  (threshold τ=4.5) and the smaller model outperformed the full-52k model, with
  5.7× faster training. [Measured] https://arxiv.org/abs/2307.08701
- **DEITA** selected ~6k examples and performed on par with or better than
  baselines trained on ~10× more data, using complexity + quality + diversity as
  the selection axes. [Measured] https://arxiv.org/abs/2312.15685
- **LIMO** elicited mathematical reasoning with 817 curated samples (400 already
  produced most of the gain), improving AIME accuracy from 6.5% to 57.1% over
  prior SFT baselines. [Measured] https://arxiv.org/abs/2502.03387

The practical reading for this project: **"thousands of examples" is a ceiling,
not a floor, and the number that matters is distinct effective concepts, not row
count.** LIMA's 1k and LIMO's 817 were *single-purpose*, curated by hand, and
built on a strong backbone. This project is dual-purpose and 8B, so it will likely
need more than 1k — but 8k templated rows is not automatically better than 3k
diverse ones.

### 1.2 Classic failure modes and what actually prevents them

**(a) Templated homogeneity / mode collapse.** Synthetic generators reuse the
same surface patterns. The measured effect is real at the *fine-tuning* stage, not
only in recursion loops:

- Output diversity is suppressed by the standard cross-entropy SFT objective;
  **GEM** formalizes this and shows a diversity-preserving update can reduce
  over-memorization while keeping task performance. [Measured]
  https://arxiv.org/abs/2408.16673
- Synthetic-data **diversity** in pretraining persists into fine-tuning and
  correlates positively with both pretraining and SFT performance; models
  350M–1.4B. [Measured] https://arxiv.org/abs/2410.15226
- Fine-tuning on synthetic data from a **single** source causes more distribution
  collapse and lower lexical diversity than multi-source synthetic data. [Measured]
  https://arxiv.org/abs/2511.01490
- Recursive training on predecessor-generated text measurably reduces lexical and
  syntactic diversity across iterations. [Measured]
  https://aclanthology.org/2024.findings-naacl.228.pdf

**(b) Model collapse / self-reinforcement.** Model collapse is real but
*conditional*, and the condition is replacement, not synthesis:

- **Shumailov et al. (Nature 2024)** showed recursive training on model-generated
  data causes irreversible tail loss ("model collapse") in LLMs, VAEs and GMMs.
  [Measured] https://www.nature.com/articles/s41586-024-07566-y
- **Gerstgrasser et al. (COLM 2024)** showed collapse is driven by *replacing*
  data, and that *accumulating* synthetic data alongside the real anchor avoids it,
  with a finite test-error bound; the result holds for supervised fine-tuning and
  kernel density estimation as well as LLM pretraining. [Measured]
  https://arxiv.org/abs/2404.01413
- **Alemohammad et al. (ICLR 2024)** "Self-Consuming Generative Models Go MAD"
  established the taxonomy of fully/partially synthetic loops. [Measured]
  https://arxiv.org/abs/2307.01850

**Implication for this project:** the foundry is *not* a recursion loop. It uses
an external teacher and trains a different student (Qwen3-8B). That is
distillation, and the classic collapse mechanism does not directly apply. The risk
here is **single-teacher stylistic homogeneity**, not collapse — unless the team
later trains Qwen and then uses Qwen to generate the next corpus without keeping
the original anchor. Do not do that without keeping an anchored real/high-quality
set.

**(c) Self-reinforcement of the teacher's own biases.** When the teacher is one
model and the judge is the same model family, the loop optimizes toward that
family's taste. See §5 for the judge-bias evidence; this is the project's most
under-priced risk.

**(d) Benchmark/eval contamination.** Standard in-domain eval is inflated by
train/eval overlap; contamination is detected with n-gram overlap, differential
perplexity, or kernel-divergence methods. [Measured/Consensus]
https://arxiv.org/html/2406.04244v1 and
https://aclanthology.org/2024.findings-emnlp.532 . This project's dev rows are
generated from the same frozen plan as train rows, which is an in-domain risk even
though the sealed corpus is hidden.

### 1.3 Which quality gates matter most

[Consensus, with measured support] The highest-value gates are the ones that
remove *wrong* and *redundant* data, in this order:

1. **Correctness/faithfulness gates** (deterministic validators, execution
   checks). This project already has strong fail-closed validators — its genuine
   edge.
2. **Deduplication and diversity gates** (near-duplicate removal, embedding-space
   coverage). DEITA's diversity selection and the diversity evidence above are the
   support. This project has generator-side diversity gates for *cards*, which is
   good, but no measured **response-level** diversity gate.
3. **Difficulty/complexity spread.** Data should span easy→hard; DEITA finds
   complexity useful. The project's depth/backbone parameterization helps but is
   not measured as a difficulty axis.
4. **Style/quality gates** (the prose rubric). Useful, but the *most gameable*
   and the *least causal*. A style judge rewards verbosity and self-similarity;
   see §5.

A gate that only fires on "is this pretty" is a weak gate. A gate that fires on
"is this factually bound and non-duplicated" is a strong gate.

---

## 2. Roleplay / character fine-tuning specifically

### 2.1 What works, per the roleplay literature

- **Character-LLM** trained per-character agents on ~1.4k–2.2k scenes per
  character, supervising in-character turns; it is a per-character SFT recipe, not
  a general one. [Measured] https://arxiv.org/abs/2310.10158 and
  https://github.com/choosewhatulike/trainable-agents
- **RoleLLM** built RoleBench (168k samples over 100 characters) and fine-tuned
  with **role-conditioned instruction tuning (RoCIT)**; role prompting for style
  imitation plus context-based knowledge extraction. [Measured]
  https://arxiv.org/abs/2310.00746
- **OpenCharacter** is the closest match to this project's goal: large-scale
  *synthetic personas* used for SFT of LLaMA-3 8B, with the explicit aim of
  **out-of-domain** character generalization, reporting that the 8B model improves
  on the LLaMA-3-8B-Instruct baseline and is comparable to GPT-4o-class models on
  roleplay dialogue. This is the strongest single precedent that **8B + synthetic
  persona data can move roleplay quality**. [Measured]
  https://arxiv.org/abs/2501.15427
- **CharacterBox** reports that trajectory-based fine-tuning (guided and
  reflective) lets 7B models reach GPT-3.5-turbo-class roleplay. [Measured]
  https://haoxuanli-pku.github.io/papers/NAACL%2025%20-%20CharacterBox%20-%20Evaluating%20the%20Role-Playing%20Capabilities%20of%20LLMs%20in%20Text-Based%20Virtual%20Worlds.pdf
- **Persona drift is measurable and real.** Multi-turn synthetic dialogue shows
  turn-by-turn persona degradation over 10–15 turns (20–40% drops in an activation
  projection in the cited therapy/philosophy setting), and RL on multi-turn
  consistency reduces inconsistency by >55%. [Measured, but note the first figure
  is from a summary aggregator, so treat the exact percentage cautiously]
  https://www.emergentmind.com/topics/persona-drift and
  https://neurips.cc/virtual/2025/poster/119491 . A drift metric and a
  multi-turn evaluation are therefore worth building; the project already
  supervises multiple turns, which is the right shape.

### 2.2 What "character card" conditioning actually does

A character card is a structured persona specification injected into the system
prompt; it is the control surface, not just content. Practitioner references
describe the system prompt as the highest-weight context and the card/description
as the persistent behavioural layer. [Consensus]
https://rpfiend.com/how-to-write-a-system-prompt-for-ai-roleplay and
https://docs.sillytavern.app/usage/prompts

Mechanically, conditioning the *teacher* on a rich card is what makes synthetic
personas produce varied, distinctive dialogue rather than generic assistant text.
Persona Hub's billion-personas result and OpenCharacter both rely on this: a
persona in the synthesis prompt steers more distinctive data. [Measured]
https://arxiv.org/abs/2501.15427

**Known pitfalls for this project:**

1. **Card dependence.** If *every* training example carries a full
   `creative-card-v1` in the system prompt, the model can learn "emit character
   voice *conditional on a fat card*" and degrade when a deployment supplies only
   a name or one line. [Reasoning] Mitigation: include a mix of full-card,
   minimal-card and no-card roleplay rows, and vary the card serialization so the
   model does not lock to one schema.
2. **Schema leakage.** The card fields are strongly structured. A model can learn
   to echo field names and read them aloud (the protocol already guards against
   prompt-field echoes). [Reasoning]
3. **Single-register overfitting.** This is the project's *already observed*
   failure: one v4 creative failure was "every character turn was an elaborately
   balanced speech" — `dialogueNaturalness: 0`. [Measured, local] That is what
   happens when one teacher writes every character with one rhetorical habit.
4. **Player-agency violation.** One admitted conversation asserted an unstated
   player intention. [Measured, local] This is a known roleplay failure class
   ("excessive agency" / writing the user's actions) and it is materially
   damaging to a player-facing product:
   https://genai.owasp.org/llmrisk/llm06-sensitive-information-disclosure and
   https://arxiv.org/html/2305.16367v1 .

### 2.3 Preserving voice and player agency

- Supervise only character turns — the project does this structurally and it is
  the correct design. [Reasoning, supported by the never-supervise-player
  invariant]
- Vary register *by construction*: `speech.verbosity`, `formality`,
  `emotionalVolatility`, `temperament[]` and `relationship.stance` already exist
  in the card schema. A corpus whose register distribution is skewed (e.g. most
  characters "expansive"/"formal") will produce a model that is uniformly
  polished. **The protocol should enforce a register-balance gate at the corpus
  level**, analogous to the existing signature-share gate. [Reasoning]
- Player agency needs an independent check, not only the verb-list detector. The
  independent review caught what the pipeline admitted. Promote player-agency to
  a **separate reviewer call with its own rubric** and a targeted false-negative
  list (`want`, `need`, `realize`, `decide`, `intend`, `believe` as player
  subjects), and treat any single occurrence in a candidate as a refusal.
  [Reasoning]

---

## 3. Mixing structured and creative data

### 3.1 Does structured/tool training degrade other behaviour? Yes, measurably.

- A conference talk on fine-tuning for function calling states plainly that
  fine-tuning for function calling "can inadvertently degrade pre-existing
  instruction following and general language capabilities," and recommends
  starting from the Instruct variant and reducing data to preserve capabilities.
  [Consensus/Measured-anecdote]
  https://christianjmills.com/posts/mastering-llms-course-notes/conference-talk-019
- A controlled study found **measured** degradation after fine-tuning on ToolACE
  for nested/compositional tool use: LLaMA-3.1-8B "No Thought" 30.06→29.82 and
  "Template" 33.09→30.23; Qwen-2.5-14B "No Thought" 38.57→35.72 (≈7% relative
  drop). The authors attribute it to overfitting to simpler tool patterns and
  incomplete coverage of compositional calls. [Measured]
  https://arxiv.org/html/2509.18076v1
- **LoRA forgets less than full fine-tuning** on both code and math, but also
  **learns less** in the target domain; high rank (r=256) closes most of the gap
  for *instruction* fine-tuning. [Measured] https://arxiv.org/abs/2405.09673
- Mixing unsupervised/general data into instruction tuning mitigates catastrophic
  forgetting and improves in-context-learning generalization. [Measured]
  https://aclanthology.org/2024.findings-acl.883.pdf
- The **alignment tax** — degraded general/math/code ability after safety/SFT —
  is a documented, quantified phenomenon; orthogonal-gradient and replay methods
  are used to reduce it. [Measured/Consensus]
  https://arxiv.org/html/2405.13432v1 and
  https://arxiv.org/html/2608.24192v1

### 3.2 Does creative training degrade structured ability (the reverse)?

I found no controlled experiment that isolates "creative-writing SFT degrades
tool-calling." [Reasoning] The mechanisms are symmetric: whichever capability
dominates the token mix and the prompt distribution wins the format. The relevant
evidence is directional: SFT aligns *format/style* (LIMA's superficial-alignment
hypothesis), so a corpus dominated by prose narration will bias the model toward
prose, and a corpus dominated by JSON/tool envelopes will bias it toward schemas.
This is why the read has to be a controlled comparison, which the project's own
coverage doc already says.

### 3.3 Practical mixing / curriculum strategies

- **Data mixing matters and mixtures interact in non-obvious ways.**
  **DoReMi** (domain reweighting via a proxy model) improved downstream accuracy
  by 6.5 points over default weights and reached baseline with 2.6× fewer steps.
  **RegMix** predicts mixtures from many small runs and outperforms human
  selection, while showing that "data mixture effects transcend scaling laws" and
  that domains interact. [Measured] https://arxiv.org/abs/2305.10429 and
  https://arxiv.org/abs/2407.01492
- Both DoReMi and RegMix use **small proxy runs to choose a mixture for the large
  run**. This is directly transferable: on a single RTX PRO 6000, several
  short-schedule LoRA arms are a proxy for the final recipe. [Reasoning]
- **Replay** is the reliable anti-forgetting baseline: keep a small
  general/capability slice in the mix. Naive replay is competitive with more
  sophisticated continual-learning methods in practice. [Consensus]
  https://discuss.huggingface.co/t/why-does-naive-replay-still-beat-most-sophisticated-continual-learning-methods-in-practice/176513
- **Separate-then-merge / route** is a legitimate strategy: PEFT adapters are
  cheap, and merging or routing per request type avoids forcing one weight set to
  hold two register policies. [Reasoning]

### 3.4 What this implies

[Reasoning] The project's `DATASET_COVERAGE.md` is right that "whether structured
training degrades roleplay is exactly the question a controlled comparison should
answer." The recommendation here is to *actually run that comparison at smoke-test
scale first* (R1), not to argue about a ratio in advance. Do not pick a blended
ratio from this document; pick it from three small arms.

---

## 4. Small-data reality check

### 4.1 What is achievable

[Measured, cited above] A few thousand curated examples is enough to shift
*format, style and behaviour* on a modern model; it is rarely enough to inject
substantial *new knowledge*. LIMA (1k), AlpaGasus (9k), DEITA (6k) and LIMO (817)
all changed behaviour/format, and LIMO specifically elicited reasoning already
latent in a 32B backbone. Two caveats for this project:

- Those wins are on **stronger, larger backbones** (32B/65B) with plenty of latent
  roleplay/tool ability. An 8B base has less latent capability to elicit, so the
  needed volume is probably higher.
- The project's own Qwen3-8B baseline already gets 31.1% correct on the frozen
  106-case dev corpus and fails JSON-schema generation 0/10 and referential
  fidelity ~37.7% (BASELINE_SIGNAL.md). These are broadly *format/behaviour*
  deficits — the exact category SFT is good at. [Measured, local] That is
  encouraging for LoRA.

### 4.2 Minimum useful scale

[Reasoning] For a dual-capability 8B LoRA, a defensible target range is
**~3,000–6,000 distinct, deduplicated examples total**, roughly:

- Structured (world generation + tool selection by subtype + boundary):
  **~1,500–3,000**.
- Creative roleplay: **~1,500–3,000 distinct conversations**, each multi-turn,
  with balanced register and setting coverage.
- Capability replay (general chat / a slice of the base instruct distribution):
  **~5–10% of the mix**.

Below ~500 distinct examples on either capability, expect the adapter to learn
surface format and overfit one register. Above ~10k, unless the extra data adds
genuine diversity, expect diminishing or negative returns (LIMA's doubling
ablation; AlpaGasus; GEM diversity loss). The project's current *yields* (806
labels for the whole approved export; 3,882 for creative v4) mean the gap to
3k–6k examples is large in teacher calls — which is another argument for the
smoke test first.

### 4.3 Detecting underfitting vs overfitting quickly

[Consensus + Reasoning] On a single GPU with a short schedule:

- **Underfitting signals:** validation loss stays high; tool-call validity
  remains low; JSON schema fails; the model ignores the system format; train loss
  plateaus early. Fix: raise rank (try r=64/128), raise LR, more epochs, more
  diverse data — in that order. Note LoRA's rank sensitivity for instruction
  fine-tuning is measured (high rank closes the gap; applying LoRA to *all layers*
  helps more than raising rank). [Measured]
  https://arxiv.org/abs/2405.09673 and
  https://magazine.sebastianraschka.com/p/practical-tips-for-finetuning-llms
- **Overfitting signals:** train loss ≪ validation loss; **verbatim
  memorization** of training character names/phrases on held-out prompts; collapsed
  output diversity (high self-BLEU / low distinct-n); one register on every
  character; measurable regression on a general-capability suite. Fix: fewer
  epochs, more diverse data, higher dropout, lower rank, replay slice. Multiple
  epochs on small instruction sets has been observed to *degrade* results
  (Raschka), so prefer 1–2 epochs on a wider set over 5+ epochs on a narrow one.
  [Measured/Consensus]

### 4.4 Expected effect sizes

Do not plan on "large." The realistic pattern is: **large, cheap gains on
format/behaviour** (tool envelope validity, JSON schema, refusal/abstention
policy, exact-value binding) and **smaller, noisier gains on prose quality**.
LIMO's dramatic jump (6.5%→57.1% AIME) was on a reasoning task with a strong
backbone and a highly structured target; it is not a general predictor here. Any
prose-quality claim should be reported as a paired effect with a confidence
interval, not a headline win.

---

## 5. Evaluation design on a small budget

### 5.1 Baselines you must run (same runtime)

[Reasoning, grounded in the handoff's own warnings] The
`COLAB_TRAINING_HANDOFF.md` correctly says the quantized Windows baseline is
confounded. Therefore every comparison must be **same-runtime, BF16, same
sampler**:

- **B0**: stock Qwen3-8B, no adapter.
- **B1**: structured-only LoRA.
- **B2**: creative-only LoRA.
- **B3**: combined/mixed LoRA.
- (Optional, cheap) **B4**: strong few-shot prompted stock model — to check whether
  fine-tuning beats prompting at all. If B4 ≈ B3, the fine-tune is not earning
  its complexity.

### 5.2 Separate mechanical accuracy from prose quality

The project already does this correctly (deterministic validators vs the
`velvet-blind-prose-v1` rubric). Keep it. Add:

- **Mechanical metrics**: tool-call exact match and AST match, JSON schema +
  reference closure, receipt binding (actor/target/values/HP/status), boundary
  leakage, player-agency violations. Deterministic, cheap, high-n. These should
  drive the go/no-go on structured data.
- **Prose metrics**: the existing rubric, plus **response-diversity metrics**
  (distinct-n / self-BLEU / embedding spread on held-out prompts) to catch
  register collapse that a per-item style judge will not see.
- **Retention metrics**: a small general suite (e.g. a fixed MMLU subset and
  IFEval) to detect the alignment tax.

### 5.3 Avoid fooling yourself

The three biggest self-deception risks here:

1. **In-domain dev.** Dev rows come from the same frozen plan and the same
   teacher as train rows. A model can win on dev purely by matching the teacher's
   template. Build an **out-of-distribution** eval: new characters, new settings,
   independently authored prompts, ideally touched by humans. Report both, and
   never let the in-domain number carry the decision. [Reasoning]
2. **The judge is the teacher.** The blinded prose judge is "fresh independent
   GPT-6 Astra" while the generator is also GPT-6 Astra. LLM judges exhibit
   **self-enhancement / self-preference bias** — they rate their own family's
   output higher. Use a *different family* as the judge (or at minimum a
   different checkpoint), randomize candidate order, hide identity, and
   length-control. [Measured]
   https://arxiv.org/abs/2306.05685 and https://arxiv.org/abs/2404.04475
3. **Point estimates from tiny n.** 3/5 and 1/5 are statistically
   indistinguishable; the same is true for 1/7 vs 3/7. Report **paired per-item
   differences with bootstrap CIs**, and do not claim a pass-rate improvement from
   single-digit samples. Below ~20 pairs, bootstrap intervals are unreliable.
   [Consensus/Measured]
   https://dev.to/marcuswwchen/bootstrap-confidence-intervals-for-your-llm-eval-metrics-3599
   and https://engineering.indeedblog.com/blog/2026/07/bootstrap-confidence-intervals-for-llm-evaluation

Also: keep the sealed corpus sealed (the project does), and run an n-gram overlap
check between train and dev to catch lexical leakage from the shared plan.

### 5.4 Judge-bias mitigations, condensed

- Randomize A/B order and report the flip rate (position bias).
- Hide model identity (self-enhancement).
- Use a different judge family from the generator and from the trained model.
- Either control for length statistically or make the rubric explicitly
  penalize verbosity; creative-writing judges are especially prone to rewarding
  length. [Measured] https://arxiv.org/abs/2306.05685
- Use binary/evidence-based criteria where possible; `velvet-blind-prose-v1` is
  already multi-dimension and evidence-anchored, which is better than a 1–10
  vibe score.

---

## 6. Concrete recommendations for THIS project

This section is my synthesis. Where it contradicts the current plan, §7 says so.

### 6.1 Suggested corpus size and composition

[Reasoning] Target **~3,000–6,000 distinct examples**, allocated approximately:

| Tranche | Share of examples | Rationale |
|---|---:|---|
| Tool selection (initiation + argument binding, split by tool family) | ~25–30% | Largest measured stock deficit: 64% false abstention on narration-submit, `{}`-argument collapse; JSON/schema 0/10 |
| World generation | ~15–20% | 0/10 JSON-schema on both models; production validator exists |
| Boundary recovery | ~8–12% | Leakage not the gap for Qwen3-8B; re-measure after it speaks |
| **Creative roleplay** | **~35–45%** | Co-equal goal; the only stream producing the target prose |
| Grounded narration | **0%** (or structural-only, no prose floor) | Fails its own style gate; teaches the bad register |
| Capability replay | ~5–10% (overlay) | Anti-forgetting; measured to help |

This composition deliberately inverts the current `FAMILY_WEIGHTS` (where
roleplay is 0.06). Justification for the roleplay weight: the goal statement
requires it, the creative stream is the only measured source of good roleplay
prose, and SFT aligns format/style, so an under-weighted creative tranche will be
out-competed by the JSON/tool envelope distribution.

### 6.2 Suggested mixing ratio

[Reasoning] There is **no measured optimal ratio** for this task, and
`DATASET_COVERAGE.md` is correct not to assert one. My concrete proposal:

- **Run three arms** at smoke scale: structured-only, creative-only, and a
  combined arm at roughly **50/50 by supervised tokens** (not by row count —
  world-generation rows are much longer than tool rows).
- Overlay ~5–10% capability replay in the combined arm.
- Pick the final recipe from **measured** results on the OOD eval, using the
  DoReMi/RegMix "small proxy runs choose the mixture" logic. Report achieved
  shares via `selectCreativeMix`, which already reports them.

Do **not** launch a single blended 175-seed X:Y corpus before this comparison.
That is exactly the decision the project already put on HOLD for the narration
tranche; the same logic applies to the mixture.

### 6.3 Which tranche is most at risk of wasting training budget

**`grounded-narration`.** [Reasoning] It is the only tranche whose own measured
quality (3/7 at best, 0/2 warm, 0/2 wary, 1/9 in v8) is below the bar the project
has set for itself, and its failure mode (checklist register) is a *style* the
SFT objective will happily learn and propagate. Spending generation budget on it
as prose is the clearest waste in the plan. The project's HOLD already recognizes
this; the recommendation is to go further and either drop it or convert it to a
pure structured-output-binding task.

### 6.4 What to fix before spending generation budget

1. **Player-agency gate** (R5a): expand the detector and add an independent
   player-agency reviewer. One real violation already slipped through structural
   admission.
2. **`My <skill> check` false refusal** (R5b): it is the same class as the
   present-tense gap already fixed. The stock model emits this form naturally, so
   leaving it unfixed rejects good data *and* supervises the model away from a
   natural phrasing.
3. **Judge independence** (R5c): use a non-GPT-6 judge family, or at least
   document and mitigate the self-preference confound.
4. **Register-balance gate** on the creative corpus (new): enforce a spread over
   `verbosity`/`formality`/`volatility` so one polished register cannot dominate.
5. **Sequence-length policy check**: the handoff specifies 4096 with **no packing
   and no truncation**, but creative calibration needed a 16384-token *generation*
   budget because longer conversations truncated at 4096. Verify what happens to
   multi-turn creative rows longer than 4096 train tokens under the preprocessing
   policy. If they are dropped, the creative corpus silently loses its longest,
   richest examples; if they are truncated, supervision is silently changed. This
   must be resolved before generation, because it determines what "a creative
   example" means. [Reasoning from local docs]
6. **Response-diversity gate** (new): the card-diversity gate measures cards, not
   prose. Add a response-level near-duplicate/self-BLEU gate.
7. **Train/held-out overlap check**: because dev and train share a frozen plan,
   run an n-gram overlap check before trusting any dev improvement.
8. **SFT-only first**: the handoff notes stock TRL `DPOTrainer` may not honour
   the explicit preference masks. Do not introduce preference rows until a
   consumer that honours them exists. [Local contract, respected]

### 6.5 Curriculum, if you blend

[Reasoning] If the arms show interference and you still want one adapter, a
two-stage curriculum is the best-supported option from the cited evidence:
structured/format first (it is the larger, more objective deficit), then a
creative + replay fine-tune at lower LR — i.e. rehearse the format while
re-acquiring voice. This mirrors the "SFT establishes format, then specialize"
pattern and the replay literature. It is not measured for *this* task; treat it
as a hypothesis to test, not a given.

---

## 7. Contradictions and suspected mistakes

I found the following. Some are contradictions with the current plan; some are
practices the evidence suggests are mistakes. I am blunt because the brief asks
for it.

1. **Roleplay is a stated goal but is scheduled at 6%.** [Contradiction] The
   creative protocol describes `roleplay-conversation` as "a compact, deliberately
   non-zero retention tranche" at weight 0.06. But "engaging character roleplay"
   is one of the two goals, and the creative stream is the *only* measured source
   of acceptable roleplay prose. A retention tranche is what you add to *prevent
   forgetting*, not what you build a primary capability from. At 6%, the corpus
   will be dominated by structured JSON/tool envelopes, which is the opposite of
   what the roleplay goal needs. Re-weight or generate the streams separately.

2. **Training on `grounded-narration` as prose contradicts the project's own
   measurements.** [Contradiction] The reports say the register is wrong and that
   the one pre-registered remedy failed. Training on data you have measured as
   failing the quality gate will teach that quality. The HOLD acknowledges the
   risk for the frozen pilot; the recommendation is to make it explicit for *any*
   corpus, not just `pilot-1`.

3. **"Generate thousands of examples" before any trained model is backwards.**
   [Mistake] The whole point of the quality work was to avoid contaminated/weak
   data. But you cannot know whether *any* of this data helps until you train on
   what you have. The literature's consistent lesson is quality/diversity >
   volume, and small curated sets are viable. Spend a day on a smoke-test LoRA
   before spending weeks of generation budget.

4. **The teacher is also the blinded judge (same family).** [Mistake] GPT-6 Astra
   generates and judges. This is a documented self-enhancement bias and it
   systematically inflates the apparent quality of teacher-shaped data — which is
   exactly the data the corpus contains. The independent-review machinery is
   excellent in structure, but the judge must be a different family for the
   quality signal to be trustworthy.

5. **Pass-rate claims rest on single-digit samples.** [Mistake] "3/5 creative
   pass" and "1/7 vs 3/7" are within sampling noise. This is not a reason to throw
   the numbers away; it is a reason to attach CIs and stop treating them as
   established rates. The reports mostly hedge this correctly; the *decision-making*
   around "the creative stream works" should still carry the uncertainty.

6. **Player-agency preservation is enforced structurally and has a known false
   negative.** [Mistake] The independent review found an admitted violation. If
   this corpus trains a player-facing model, every such row teaches the model to
   write the player. Add the independent agency reviewer before scaling.

7. **The mechanical-register firewall and the structured families teach opposite
   policies.** [Risk] The creative stream **refuses** mechanical register (DC, HP,
   dice) while the structured families **require** it. Blended into one adapter
   with overlapping prompts, the model must infer which policy applies from
   context; this is a plausible interference source and is a reason for the
   separate-adapter arm. Not currently flagged in the plan.

8. **Sequence-length vs creative-conversation length is unresolved.** [Risk]
   Training at 4096 with the creative stream's 16384-token needs is a silent
   drop/truncation hazard. Verify before generation.

9. **No response-diversity gate.** [Mistake] The diversity machinery measures
   character cards, not generated prose. The observed v4 failure ("every turn was
   a polished speech") is a response-diversity failure that the card gate cannot
   see. Add a response-level gate.

10. **`BASELINE_SIGNAL.md` already identifies the true deficits, and the family
    weights should follow it more closely.** [Observation] It reorders the
    deficits to referential fidelity (37.7%), JSON schema (0/10), tool initiation
    by family, and says grounding is *blocked behind* referential fidelity rather
    than parallel to it — i.e. "funding grounded-narration and carry-over as two
    independent families double-counts." The `FAMILY_WEIGHTS` table and the
    recommended re-weighted pilot should reflect that; the cross-cutting
    referential-fidelity anchors it recommends are not a family at all, which the
    current coverage doc does not yet express.

**Where I agree with the current plan:** the HOLD is correct and evidence-backed.
The instinct to reduce/exclude grounded narration is correct. The insistence on
separating cohorts and not asserting an optimal ratio in advance is correct and
better than most published work. The structured families being independently
approved is a genuine asset. The problem is not the infrastructure — it is the
ordering of spend (generate-then-train) and the roleplay weighting.

---

## 8. Suggested first experiment (concrete, cheap, ordering-safe)

[Reasoning] If only one thing is done before generation, do this:

1. Materialise the **existing** approved rows plus the creative v4 admitted
   examples into train/dev splits with the real tokenizer (the machinery exists).
2. Train three short LoRA arms (same seed/config, ~1–2 epochs, r=32 and r=64):
   **structured-only**, **creative-only**, **combined ~50/50 + 5% replay**.
3. Evaluate against **B0 stock Qwen3-8B** (BF16, same sampler) on:
   - the frozen 106-case dev corpus (mechanical),
   - an **independently authored OOD creative set** (new characters/settings),
   - a small general suite (retention),
   - response-diversity metrics.
4. Report paired per-item deltas with bootstrap CIs; randomize judge order; use
   a non-GPT-6 judge.
5. Decide the corpus mix from the result, then scale generation.

If the structured arm does not improve tool/schema metrics over B0, the data or
the recipe is wrong, and scaling row count will not fix it. If the creative arm
does not improve OOD creative scores over B0, the same. The smoke test converts
"we hope this data trains well" into a measurement for roughly the cost of one
GPU-day.

---

## 9. Source list

Synthetic/SFT data quality, diversity, collapse:

- LIMA — https://arxiv.org/abs/2305.11206
- AlpaGasus — https://arxiv.org/abs/2307.08701
- DEITA — https://arxiv.org/abs/2312.15685
- LIMO — https://arxiv.org/abs/2502.03387
- GEM, preserving SFT diversity — https://arxiv.org/abs/2408.16673
- Synthetic-data diversity (pretrain→SFT) — https://arxiv.org/abs/2410.15226
- Multi-source synthetic diversity — https://arxiv.org/abs/2511.01490
- Recursive training reduces linguistic diversity — https://aclanthology.org/2024.findings-naacl.228.pdf
- Shumailov et al., Nature — https://www.nature.com/articles/s41586-024-07566-y
- Gerstgrasser et al., accumulation avoids collapse — https://arxiv.org/abs/2404.01413
- Self-consuming models go MAD — https://arxiv.org/abs/2307.01850
- Best-practices synthetic-data survey — https://arxiv.org/abs/2404.07503

Roleplay/character:

- RoleLLM — https://arxiv.org/abs/2310.00746
- Character-LLM — https://arxiv.org/abs/2310.10158 / https://github.com/choosewhatulike/trainable-agents
- OpenCharacter (8B synthetic personas) — https://arxiv.org/abs/2501.15427
- CharacterEval — https://arxiv.org/abs/2401.01275
- RPEval — https://huggingface.co/papers/2505.13157
- CharacterBox — https://haoxuanli-pku.github.io/papers/NAACL%2025%20-%20CharacterBox%20-%20Evaluating%20the%20Role-Playing%20Capabilities%20of%20LLMs%20in%20Text-Based%20Virtual%20Worlds.pdf
- Persona drift / multi-turn consistency — https://www.emergentmind.com/topics/persona-drift and https://neurips.cc/virtual/2025/poster/119491
- Excessive agency — https://genai.owasp.org/llmrisk/llm06-sensitive-information-disclosure
- Role-play with LLMs — https://arxiv.org/html/2305.16367v1

Mixing, forgetting, fine-tuning mechanics:

- LoRA Learns Less and Forgets Less — https://arxiv.org/abs/2405.09673
- LoRA vs full FT (intruder dimensions) — https://arxiv.org/html/2410.21228v3
- Raschka practical LoRA tips — https://magazine.sebastianraschka.com/p/practical-tips-for-finetuning-llms
- DoReMi — https://arxiv.org/abs/2305.10429
- RegMix — https://arxiv.org/abs/2407.01492
- Function-calling SFT degrades general ability (talk) — https://christianjmills.com/posts/mastering-llms-course-notes/conference-talk-019
- Measured tool-finetune degradation — https://arxiv.org/html/2509.18076v1
- Multi-task transfer / mixing C4 mitigates forgetting — https://aclanthology.org/2024.findings-acl.883.pdf
- Alignment tax — https://arxiv.org/html/2405.13432v1 and https://arxiv.org/html/2608.24192v1
- APIGen/xLAM — https://arxiv.org/abs/2406.18518
- ToolACE — https://arxiv.org/html/2409.00920v2

Evaluation:

- LLM-as-a-judge, MT-Bench/Chatbot Arena — https://arxiv.org/abs/2306.05685
- Length-Controlled AlpacaEval — https://arxiv.org/abs/2404.04475
- Bootstrap CIs for LLM evals — https://dev.to/marcuswwchen/bootstrap-confidence-intervals-for-your-llm-eval-metrics-3599 and https://engineering.indeedblog.com/blog/2026/07/bootstrap-confidence-intervals-for-llm-evaluation
- Benchmark contamination — https://arxiv.org/html/2406.04244v1 and https://aclanthology.org/2024.findings-emnlp.532
- Faithfulness vs fluency in grounded generation — https://research.google/pubs/on-faithfulness-and-factuality-in-abstractive-summarization

Local project sources (unmodified): `FOUNDRY_FINAL_REPORT.md`,
`DATASET_QUALITY_REPORT.md`, `CALIBRATION_RESULTS.md`, `DATASET_COVERAGE.md`,
`BASELINE_SIGNAL.md`, `PROSE_MEASUREMENT.md`, `COLAB_TRAINING_HANDOFF.md`,
`creative/CREATIVE_STREAM_PROTOCOL.md`.

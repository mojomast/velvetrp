# Qwen3-8B LoRA training handoff (RTX PRO 6000 Blackwell, BF16)

This document explains how to train on the exported VelvetRP foundry data. It is
written to be usable on a machine that has none of this repository's tooling.

**No training has been run by this project.** Everything below is instructions and
verified data contracts, not a report of a completed training run. Any quality
claims belong to the dataset reports, not to a trained model.

---

## 1. What you are given

A bundle produced by `dataset/src/export.ts` and materialised by
`dataset/src/preprocessExport.ts`.

**The corpus that exists today** is `corpus-2026-10-13-v1`: **155 train records /
39,435 supervised tokens**, exported under an independently issued, digest-pinned
approval. Its full identity is in [`CORPUS_EXPORT_V1.md`](CORPUS_EXPORT_V1.md):

| Item | Value |
|---|---|
| Bundle | `dataset/exports/corpus-2026-10-13-v1/` (**committed in this repository**) |
| `training.jsonl` | SHA-256 `83c8ade8b29c9db97c88e42409fd2662c3f8e04d67a2ff429d5e1056cc0fb154` |
| `provenance.json` | SHA-256 `43daee55c89196c51aab3a4a7b824c64b2cc42be4cb372a773c12a19125bbd7c` |
| `materialized/sft.jsonl` | SHA-256 `6f507c79757c91fe9e5e97d2f583224b7d82a46fe36fea37dd95fb9c982816ed` |
| `checksumDigest` | `6f14e9d57d215961b16208437ce278b0402a477049c6f48e6aa561aab198e1f8` |
| Tokenizer policy | `a691ea3d219fb2faaef1c2694599589b711ed09a44ad10dfa73f40a69a683053` |
| Approval | `dataset/frozen/corpus-2026-10-13-v1-approval.json`, SHA-256 `2abc5e6d829809c65e1c62a0482a5968191850b4ed8a4d0eadccc2d4a6207e14` |

The data **is in the repository**, so you can clone and train without a separate
transfer. Re-verify against `checksums.json` regardless — it costs nothing and
catches a bad copy.

| File | Contents |
|---|---|
| `training.jsonl` | One JSON object per line. Each has `messages`, an optional `tools` array, and (for preference rows only) `prompt`/`chosen`/`rejected`. |
| `provenance.json` | Per-line provenance: record/unit ids, family, lineage, split, certificate digest, the full admission certificate, the exact `targetSelection`, behaviour tags, and the validator versions that admitted it. |
| `checksums.json` | SHA-256 of every data/sidecar file plus a `corpusDigest` binding the file list. |
| `materialized/sft.jsonl` | **Exact `inputIds` and `labels` per record, produced by the real pinned Qwen3-8B tokenizer.** Use this. |

**Train on `split == "train"` rows only.** `dev` and generated-test rows exist for
evaluation. The externally sealed evaluation corpus is never part of any bundle.
In `corpus-2026-10-13-v1` every exported row is `train`; the 21 dev and 20
sealed-test records from the campaign are deliberately excluded.

## 2. Tokenizer and chat template

Use the exact pinned revision:

```python
from transformers import AutoTokenizer
MODEL = "Qwen/Qwen3-8B"
REVISION = "b968826d9c46dd6066d109eabc6255188de91218"
tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION, trust_remote_code=False)
```

The foundry measured supervised labels with **Transformers 5.19.0**, **TRL 1.15.0**,
**tokenizers 0.23.3** and **Torch 2.14.1+cpu** on that revision. Pin the same
tokenizer revision; a different revision changes the token boundaries and
invalidates any materialised labels.

Apply the model's own chat template (`tokenizer.apply_chat_template`). Do **not**
invent a template: the exported `messages` are HF-role-shaped and the tool rows
use HF `tool_calls` with **object** arguments (never JSON strings).

## 3. Assistant-only supervision

The critical property: **only the assistant/character turns are supervised.**

- **This bundle includes `materialized/sft.jsonl`.** Use its `inputIds` and
  `labels` directly. `labels` already contain `-100` for every non-supervised
  token, including the simulated player's turns. Do not recompute them.
- If you ever work from a bundle without materialized labels, build the mask from
  `provenance.json` → `targetSelection`: `supervisedAssistantIndices` and
  `supervisedToolCallIndices` are **message indices**. Mask everything else with
  `-100`.

Never supervise the simulated player's text. This is a correctness property of
this dataset, not a preference. The creative stream enforces it structurally; a
hand-rolled masking pass can silently break it, which is why the materialized
labels ship with the bundle.

Materialized rows are keyed by `recordId`/`unitId`, which match
`provenance.json` and the corresponding line in `training.jsonl`. Verified: the
supervised-token count matches `provenance.json` exactly for **all 155 records**
(39,435 total).

Multi-turn rows supervise **several** assistant turns in one sequence. That is
intentional: `supervisedAssistantIndices` can contain more than one index.

### Preference rows

If any row carries `chosen`/`rejected`, it is a separate preference artifact.
Its masks are explicit (`chosenLogProbabilityMask` / `rejectedLogProbabilityMask`).
**Stock TRL `DPOTrainer` has not been shown to honour those masks.** Do not
assume it does. Either implement a consumer that honours the explicit masks, or
train SFT only.

## 4. Recommended LoRA configuration (BF16)

Starting point, not a measured optimum:

```python
from peft import LoraConfig
LoraConfig(
    r=32, lora_alpha=64, lora_dropout=0.05,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    task_type="CAUSAL_LM",
)
```

- **BF16**, no quantization, on the RTX PRO 6000 Blackwell. This keeps the
  training run comparable to a future unquantized reference and distinct from the
  Windows 8 GB quantized baseline (see §7).
- Sequence length **4096** matches the foundry's preprocessing policy. The
  foundry uses **no packing and no truncation**. Measured against the real
  Qwen3-8B tokenizer, the exported corpus runs **139–2716 tokens per record**, so
  every record fits with margin; deeper conversations would not, and would be
  refused rather than silently truncated.
- Keep the base model frozen; train adapters only.

### Train a smoke test before scaling

This is the highest expected-value step and it is cheap. No model has been
trained on any of this data yet, and the evidence base says **curation and
diversity dominate volume**. Before spending a large generation budget:

1. Train a small LoRA on the data that already exists. **39,435 supervised labels
   is enough to see whether the format is learnable at all**, and to detect
   interference between the arms.
2. Compare against a **same-runtime BF16 stock** baseline, not the quantized
   Windows one.
3. Check for interference: does structured training degrade the creative arm?

Only scale generation after that answers whether the direction is right.

### Separate adapters, not one blend

There is measured evidence that function-calling / structured SFT degrades
general instruction ability (a controlled result reports roughly a 7% relative
drop on a comparable model after function-calling fine-tuning). LoRA forgets less
than full fine-tuning but also learns less.

The safer structure is **three arms**: a structured-only adapter, a
creative-only adapter, and a blended adapter for comparison. That makes the
"does structured training hurt roleplay?" question answerable instead of assumed,
which is exactly why the export separates the categories.

## 5. Category mixing

Rows carry a family and, for creative rows, a category label in provenance. The
bundle supports three consumptions:

1. **Structured/RPG only** — world generation, tool selection, boundary recovery,
   grounded narration.
2. **Creative only** — character roleplay rows.
3. **Combined multitask** — a configurable mixture.

No optimal ratio is asserted. The foundry deliberately did **not** claim one,
because whether structured training degrades roleplay quality is exactly the
question a controlled comparison should answer.

### Two weightings the evidence says to change

- **Roleplay is scheduled at only 6% of generation.** That was reasonable when
  roleplay was a retention tranche, but roleplay is now a primary stated goal and
  the creative stream is the only thing that produces engaging prose. At 6% a
  corpus is dominated by JSON and tool envelopes, which is the opposite of what
  the roleplay goal needs. Re-weight before generating at scale.
- **Consider excluding grounded narration from any creative or blended arm.**
  SFT mainly teaches format and register. Its measured joint style+function rate
  is at best 3/7 and 1/9 in the context diagnostic, and training on
  checklist-register prose risks teaching that register and bleeding it into
  roleplay. It remains valuable for the **structured** arm, where mechanical
  accuracy is the objective.

## 6. Checkpointing and evaluation

- Checkpoint every N steps to durable storage; the RTX PRO 6000 has ample memory
  but a long run should survive interruption.
- Hold out the bundle's `dev` rows. Evaluate with the frozen dev corpus used by
  the benchmarking workstream, not with a fresh ad-hoc set.

### Three ways this evaluation can fool you

The foundry's blinded prose grading has specific weaknesses that carry into any
evaluation built on it. Design around them:

1. **The judge shares a family with the generator.** The independent reviewer and
   the blinded style judge are both GPT-6 Astra; self-enhancement bias is a
   documented effect. Use a **different model family** as the judge for the
   training comparison.
2. **The dev set is in-domain.** It shares the foundry's frozen plan and style.
   Add an **independently authored out-of-domain creative set**, or the result
   measures memorisation of the foundry's own conventions.
3. **Single-digit pass rates are within sampling noise.** `3/5`, `1/7` and `3/7`
   cannot be distinguished without interval estimates. Use **paired comparisons
   and bootstrap confidence intervals**, and randomize presentation order with
   length controls.

Report training loss separately from task metrics. A falling loss does not
demonstrate roleplay quality.

## 7. Comparing against the separate stock baseline

A separate Windows RTX 4070 agent measured the **stock** Qwen3-8B on the frozen
dev corpus under a **quantized** (llama.cpp) configuration. That baseline is
retained on `bench/stock-baseline-findings` and summarised in
[`eval/STOCK_BASELINE_HANDOFF.md`](eval/STOCK_BASELINE_HANDOFF.md).

Two rules:

- **Keep the quantized Windows baseline and your unquantized BF16 run distinct.**
  They differ by quantization, runtime and hardware; do not present a delta
  between them as a model-quality effect.
- **Never give the training or generation process sealed evaluation data.** The
  sealed corpus is ids/counts-attested only and is not in any bundle.

## 8. What this dataset does and does not establish

Established: the admitted rows passed deterministic structural/grounding checks,
an independent reviewer, and (where measured) blinded prose grading. Their
provenance, masks and tokenizer identity are pinned and reloadable.

Not established: that training on them improves roleplay quality, retention or
task accuracy. No controlled before/after experiment has been run, and the
historical raw stock answers needed for a retention comparison were never
recovered. Treat the first training run as an experiment with a measured
baseline, not as a validated improvement.

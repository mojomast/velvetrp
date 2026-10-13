# Qwen3-8B LoRA training handoff (RTX PRO 6000 Blackwell, BF16)

This document explains how to train on the exported VelvetRP foundry data. It is
written to be usable on a machine that has none of this repository's tooling.

**No training has been run by this project.** Everything below is instructions and
verified data contracts, not a report of a completed training run. Any quality
claims belong to the dataset reports, not to a trained model.

---

## 1. What you are given

A bundle produced by `dataset/src/export.ts` and materialised by
`dataset/src/preprocessExport.ts`:

| File | Contents |
|---|---|
| `training.jsonl` | One JSON object per line. Each has `messages`, an optional `tools` array, and (for preference rows only) `prompt`/`chosen`/`rejected`. |
| `provenance.json` | Per-line provenance: record/unit ids, family, lineage, split, certificate digest, the full admission certificate, the exact `targetSelection`, behaviour tags, and the validator versions that admitted it. |
| `checksums.json` | SHA-256 of every data/sidecar file plus a `corpusDigest` binding the file list. |
| `materialized/*.json` (optional) | Exact `inputIds` and `labels` per record, produced by the real pinned Qwen3-8B tokenizer. Present only when the bundle was materialised. |

**Train on `split == "train"` rows only.** `dev` and generated-test rows exist for
evaluation. The externally sealed evaluation corpus is never part of any bundle.

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

- If the bundle includes `materialized/*.json`, use `inputIds` and `labels`
  directly. `labels` already contain `-100` for every non-supervised token,
  including the simulated player's turns. Do not recompute them.
- Otherwise, build the mask from `provenance.json` → `targetSelection`:
  `supervisedAssistantIndices` and `supervisedToolCallIndices` are **message
  indices**. Mask everything else with `-100`.

Never supervise the simulated player's text. This is a correctness property of
this dataset, not a preference. The creative stream enforces it structurally; a
hand-rolled masking pass can silently break it, which is why materialised labels
are preferred when present.

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
  foundry uses **no packing and no truncation**; if you enable either, record it,
  because it changes effective supervision.
- Keep the base model frozen; train adapters only.

## 5. Category mixing

Rows carry a family and, for creative rows, a category label in provenance. The
bundle supports three consumptions:

1. **Structured/RPG only** — world generation, tool selection, boundary recovery,
   grounded narration.
2. **Creative only** — character roleplay rows.
3. **Combined multitask** — a configurable mixture.

No optimal ratio is asserted. The foundry deliberately did **not** claim one,
because whether structured training degrades roleplay quality is exactly the
question a controlled comparison should answer. Choose a ratio, record it, and
compare against the single-category runs.

## 6. Checkpointing and evaluation

- Checkpoint every N steps to durable storage; the RTX PRO 6000 has ample memory
  but a long run should survive interruption.
- Hold out the bundle's `dev` rows. Evaluate with the frozen dev corpus used by
  the benchmarking workstream, not with a fresh ad-hoc set.
- Report training loss separately from task metrics. A falling loss does not
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

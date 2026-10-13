# Handoff prompt — paste this to the next agent

---

You are taking over the VelvetRP synthetic-data foundry. The repository is at
`/home/mojo/projects/velvet-mvp`, branch `feat/foundry-context-diagnostic`,
HEAD `3dcf211`. Read `dataset/HANDOFF.md` first; this prompt is the short form.

## Your objective

**Train a small LoRA on the already-exported corpus, evaluate it honestly, and
report whether the direction works.** Do **not** generate more data before that
answers the question. Generation is the expensive step and the evidence base says
curation and diversity dominate volume.

## The dataset is in the repository — use it

The corpus is committed. You do not need an out-of-band transfer.

```
dataset/exports/corpus-2026-10-13-v1/
  training.jsonl              # 155 records, all split == "train"
  provenance.json             # per-record provenance, certificates, targetSelection
  checksums.json              # pins the two above
  materialized/sft.jsonl      # exact inputIds + labels  <-- USE THIS
  materialized/checksums.json
```

| Item | Value |
|---|---|
| Records / supervised tokens | **155 / 39,435** |
| Families | world 46 · tool 39 · boundary 30 · narration 21 · creative 19 |
| `training.jsonl` | `83c8ade8b29c9db97c88e42409fd2662c3f8e04d67a2ff429d5e1056cc0fb154` |
| `provenance.json` | `43daee55c89196c51aab3a4a7b824c64b2cc42be4cb372a773c12a19125bbd7c` |
| `materialized/sft.jsonl` | `6f507c79757c91fe9e5e97d2f583224b7d82a46fe36fea37dd95fb9c982816ed` |
| `checksumDigest` | `6f14e9d57d215961b16208437ce278b0402a477049c6f48e6aa561aab198e1f8` |
| Tokenizer policy | `a691ea3d219fb2faaef1c2694599589b711ed09a44ad10dfa73f40a69a683053` |

**Use `materialized/sft.jsonl`.** Its `labels` already contain `-100` for every
non-supervised token, including the simulated player's turns. Do not rebuild the
mask by hand — a hand-rolled pass can silently supervise the player's turns, which
is a correctness property of this dataset, not a preference.

Re-verify against `checksums.json` after cloning regardless.

## Hard constraints

- **Never train on `dev` or sealed rows.** Every exported row is `train`; the 21
  dev and 20 sealed-test records from the campaign are deliberately excluded.
- **Never read the external sealed evaluation corpus**, and never use expected
  benchmark answers as prompts or targets. It is ids/counts-attested only.
- **Do not regrade or re-admit historical outputs**, and do not change frozen
  digests or plans.
- **The approval authorizes export only** (`trainingAuthorized: false`). It is not
  permission to claim the data is validated.
- **Do not fabricate measurements, scores or pins.** Unknown outcomes stay
  explicit.

## What to do

1. **Smoke-test LoRA.** Small LoRA, BF16, unquantized, sequence length 4096. The
   foundry uses no packing and no truncation; records measure 139–2716 tokens, so
   everything fits.
2. **Three arms, not one blend**: structured-only, creative-only, blended. There
   is measured evidence that function-calling SFT degrades general ability, so the
   three-arm structure makes *"does structured training hurt roleplay?"*
   answerable instead of assumed.
3. **Compare against a same-runtime BF16 stock baseline** — not the separate
   quantized Windows llama.cpp baseline, which differs by quantization, runtime
   and hardware. A delta between those is not a model-quality effect.
4. **Report training loss separately from task metrics.** A falling loss does not
   demonstrate roleplay quality.

### Three ways the evaluation will fool you

1. **The judge shares a family with the generator.** Use a different model family
   as judge.
2. **The dev set is in-domain.** Add an independently authored out-of-domain
   creative set, or you measure memorisation of the foundry's conventions.
3. **Single-digit pass rates are within sampling noise.** Use paired comparisons
   and bootstrap confidence intervals.

## What is already done — do not redo

- Calibration v5–v8, all recorded in `dataset/CALIBRATION_RESULTS.md`.
- The public-context diagnostic (v8) ran and was **decided**: the intervention did
  not fix prose (0/4 vs 1/5 control). Closed; no further tuning against those
  frozen cases.
- The creative stream is implemented, wired in, and calibrated. It never
  supervises player turns (verified structurally and against the real admitted
  messages).
- The corpus campaign and its export, under a five-submission independent
  approval (`2abc5e6d829809c65e1c62a0482a5968191850b4ed8a4d0eadccc2d4a6207e14`).

## What is NOT done — state it honestly

- **No model has been trained.** Nothing demonstrates improvement.
- **Grounded narration is below the prose floor** — mechanically exact, checklist
  register. It is in the structured tranche deliberately; **exclude it from any
  creative or blended arm.**
- **The creative stream is 3/5** on a stratified sample of five conversations. One
  failure was a real player-agency violation the structural gate admitted. The
  detector was later fixed, but the corpus records were **not** re-graded.
- **155 records is small** — a defensible first handoff, not production scale.
- **No controlled retention comparison exists.** The inherited 4/8 floor is a
  policy threshold, not a measurement.

## Two scaling costs to know before generating more

1. World JSON truncated at 2048 output tokens; the structured runner now requests
   4096.
2. Creative generation spends ~75% of its label budget on refusals.

## Environment

- Node: `/home/mojo/.cache/ms-playwright-go/1.57.0/node --import tsx` (system
  Node 20 lacks `node:sqlite`).
- Tokenizer assets `.dataset/tokenizer/qwen3-8b`; Qwen3-8B revision
  `b968826d9c46dd6066d109eabc6255188de91218`.
- If you regenerate: teacher is `deepseek-v4-flash` via agentrouter, reviewer must
  differ from the actual generator (`VELVET_REVIEWER_MODEL=kimi:k3`).

## Note on CI

At handoff, `ci` runs were **queued on runner capacity**, not failing — 11+ queued
on `ubuntu-latest` while earlier runs completed green. The full foundry suite is
green locally: **641 passed, 0 failed, 0 skipped** with the real CPU tokenizer.
Confirm CI before building on the branch.

## Read, in order

`dataset/HANDOFF.md` → `dataset/CORPUS_EXPORT_V1.md` →
`dataset/COLAB_TRAINING_HANDOFF.md` → `dataset/DATASET_QUALITY_REPORT.md` →
`dataset/FOUNDRY_FINAL_REPORT.md` → `dataset/CALIBRATION_RESULTS.md`.

**Report the first training result as an experiment with a measured baseline, not
as a validated improvement.**

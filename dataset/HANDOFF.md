# Handoff — VelvetRP synthetic-data foundry

You are picking up a **finished phase**, not a live experiment. Read this first,
then the linked reports. Everything here is measured; nothing is projected.

Branch `feat/foundry-context-diagnostic`. Last commit at handoff: `1bed2a5`.

---

## 1. One-paragraph state

The foundry generates synthetic training data for Qwen3-8B (creative roleplay
plus reliable structured RPG participation). Calibration runs v5–v8 are complete
and recorded. The creative stream is implemented, wired into the pipeline, and
calibrated. A **corpus campaign has been run and its output exported** under an
independently issued, digest-pinned approval: **155 train records / 39,435
supervised tokens**. The frozen 175-seed `pilot-1` remains **held** for a
documented reason. **No model has been trained**, and no training is authorized by
the export approval.

## 2. The deliverable

| Item | Value |
|---|---|
| Bundle | `.dataset/exports/corpus-2026-10-13-v1/` (**not committed**; under `.dataset/`) |
| Records | 155, all `train` |
| Supervised tokens | 39,435 |
| Families | world 46 · tool 39 · boundary 30 · narration 21 · creative 19 |
| `training.jsonl` | `83c8ade8b29c9db97c88e42409fd2662c3f8e04d67a2ff429d5e1056cc0fb154` |
| `provenance.json` | `43daee55c89196c51aab3a4a7b824c64b2cc42be4cb372a773c12a19125bbd7c` |
| `checksumDigest` | `6f14e9d57d215961b16208437ce278b0402a477049c6f48e6aa561aab198e1f8` |
| `corpusDigest` | `88052112234c603e440387f7a624de3b6ccfed10ddfa1379ac26718cb4ed6f6a` |
| Approval | `dataset/frozen/corpus-2026-10-13-v1-approval.json` — `2abc5e6d829809c65e1c62a0482a5968191850b4ed8a4d0eadccc2d4a6207e14` |

Full pins and review history: [`CORPUS_EXPORT_V1.md`](CORPUS_EXPORT_V1.md).
Training instructions: [`COLAB_TRAINING_HANDOFF.md`](COLAB_TRAINING_HANDOFF.md).

The approval is `decision: approved-export-only`, `trainingAuthorized: false`. It
authorizes **export only**. Do not read it as permission to train.

## 3. What to do next (in order)

1. **Smoke-test LoRA.** Train a small LoRA on the exported bundle against a
   **same-runtime BF16 stock** baseline. This is the highest-value, cheapest step
   and it answers whether the direction works before more generation spend. The
   evidence base says curation and diversity dominate volume.
2. **Try three arms, not one blend.** Structured-only, creative-only, blended.
   There is measured evidence that function-calling SFT degrades general ability;
   the three-arm structure makes "does structured training hurt roleplay?"
   answerable instead of assumed.
3. **Only then scale generation.** If the smoke test holds up, run the held pilot
   or a larger re-weighted campaign, and fix the two known scaling costs below.
4. **Consider a larger creative campaign.** Creative generation is the strongest
   answer to the roleplay goal but the most expensive per admitted record.

## 4. What is done and verified

- **Calibration v5–v8**, all recorded in [`CALIBRATION_RESULTS.md`](CALIBRATION_RESULTS.md).
- **Public-context diagnostic (v8)**: run and decided. Observations were used in
  every observation-arm output but the arm passed **0/4** vs a **1/5** control.
  Closed. No further tuning against those frozen cases is authorized.
- **Creative stream**: implemented, wired in as an opt-in path, calibrated v1–v6.
  Never supervises player turns (verified structurally **and** against the real
  admitted messages by an independent reviewer).
- **Corpus campaign**: 210 planned, 310 attempts, 196 admitted, 48,920 admitted
  labels across four concurrent runs.
- **Export machinery**: reproduces byte-identically and has no unguarded path. It
  refuses a wrong approval digest, a non-export-only approval, a record that is
  not admitted or not `train`, a mismatched payload/certificate, a report digest
  that does not reproduce, a source tree that does not match, and any unresolved
  artifact pin.

## 5. What is NOT done, stated plainly

- **No trained model.** Nothing demonstrates that training on this corpus
  improves roleplay or task accuracy. Treat the first run as an experiment.
- **Grounded narration is below the prose floor.** It is mechanically exact but
  reads as a checklist. It is in the structured tranche deliberately and should be
  **excluded from any creative or blended arm**.
- **The creative stream is 3/5** on a stratified sample of five conversations. One
  failure was a real **player-agency violation the structural gate admitted**
  (`"You want to know what I want"`). The detector was subsequently fixed to
  refuse internal-state assertions in main clauses, but the admitted corpus
  records were **not** re-graded, and historical outputs must not be re-admitted.
- **155 records is small.** A defensible first handoff, not production scale.
- **No controlled retention comparison.** The historical raw stock answers were
  never recovered, so the inherited 4/8 floor is a policy threshold, not a
  measurement.
- **CI is backed up, and it is not a code failure.** At handoff, 11 `ci` runs were
  queued on `ubuntu-latest`, the oldest for ~2.5 hours, while earlier runs
  completed normally. That is runner capacity, not a red build — the last
  completed run was green. Confirm CI is green before building on this branch, and
  expect a delay.
- **The full foundry suite is green locally**: 641 passed, 0 failed, 0 skipped,
  0 todo, with the real CPU tokenizer (`test:foundry`, serial). This is the
  handoff checkpoint.

## 6. Two known scaling costs

1. **World JSON truncated at 2048 output tokens.** Twelve `max_tokens` refusals
   with unterminated JSON. The repair loop recovered most of them, but each
   truncation wastes a dispatch. The structured runner now requests **4096**.
2. **Creative generation spends ~75% of its label budget on refusals.** 42,827
   labels across all attempts against 10,670 admitted, because initial yield is
   13/30 and repairs are expensive on long multi-turn outputs. Correct accounting,
   but plan for it.

## 7. Frozen things — do not change, do not re-run

Preserve historical calibrations, digests, certificates, ledgers, ratings and
frozen plans. **Never regrade or re-admit historical outputs.**

| Artifact | Digest |
|---|---|
| Frozen pilot `pilot-1` plan | `f633ead229d265f97da0420fd0583dc7f8b21e6349fb5e150e7968a8b05233c2` |
| Matched v7 plan | `4ba77018ff32497f1e431508f4ffc602f37179efac1782170fa9b78d29b38e04` |
| Public-context manifest | `c07754537a920d4a7acbb09fd5951ee4974273224f1925fa845f6d38647d6c58` |
| Public-context plan | `ed615621bcf3fd5ecc005a3e22ccc0a2ec9b76a68637c0faab197be263ebd83f` |
| Corpus structured plan | `d58d2ec62289f0920792e412d50f8c4c7590935548df318441c43a204a49d5da` |
| Corpus shard 2 / shard 3 plans | `ee0a5f97b672d337f9deaa6a9805b0ee7b47a77e82bd9b3a9c8cc4cfb327d98a` / `4e24cdee3b7364a448c5b615f598782d7038f49dc8dcfad918bd602cfb41217a` |
| Creative v6 plan | `122ff3d69c8e65e8424619fdcf56e841768acbc7fbe9400e2f466f96bb3b46ca` |
| Tokenizer policy | `a691ea3d219fb2faaef1c2694599589b711ed09a44ad10dfa73f40a69a683053` |

Frozen inputs are preserved under `dataset/frozen/`. The approved export bundle's
approval is frozen there too.

**Rules that must hold:** never read external sealed-test contents in generation
or review; never train on `dev` or sealed examples; never use expected benchmark
answers as teacher prompts or SFT targets. The sealed corpus is ids/counts-attested
only. Historical sealed cases live at
`/tmp/opencode/sintermark-sealed-cases/sealed-cases` and must **not** be read by
generation or review.

## 8. Environment

| Need | Value |
|---|---|
| Node for tests/E2E | `/home/mojo/.cache/ms-playwright-go/1.57.0/node --import tsx` (system Node 20 lacks `node:sqlite`) |
| Node for E2E server | `/opt/routetok-vico/bin/node` (v22) |
| Real CPU tokenizer | `FOUNDRY_TOKENIZER_PYTHON=/tmp/opencode/foundry-tokenizer-venv/bin/python`, assets `.dataset/tokenizer/qwen3-8b` |
| Qwen3-8B revision | `b968826d9c46dd6066d109eabc6255188de91218` |
| Teacher | funded RouteTok/agentrouter `deepseek-v4-flash`, thinking disabled, temp 0.7 |
| Reviewer | `VELVET_REVIEWER_MODEL=kimi:k3` — must differ from the actual generator |

The tokenizer venv under `/tmp` is **not durable**. Rebuild it from
[`tokenizer/README.md`](tokenizer/README.md) before running anything that needs
measured labels.

## 9. Reproducing the export

```bash
# Rebuild the approval candidate from the durable run stores
npx tsx dataset/scripts/buildCorpusApproval.ts /tmp/candidate.json \
  corpus-structured-2026-10-13-v1 corpus-structured-2026-10-13-v1-shard2 \
  corpus-structured-2026-10-13-v1-shard3 creative-2026-10-13-v6

# Export from the frozen approved artifact (refuses any digest mismatch)
FOUNDRY_TOKENIZER_PYTHON=/path/to/pinned/venv/bin/python \
npx tsx dataset/scripts/exportApprovedBundle.ts \
  dataset/frozen/corpus-2026-10-13-v1-approval.json \
  2abc5e6d829809c65e1c62a0482a5968191850b4ed8a4d0eadccc2d4a6207e14 \
  .dataset/exports/corpus-2026-10-13-v1 --reload
```

Durable tooling lives in `dataset/scripts/`: `buildCorpusApproval.ts`,
`exportApprovedBundle.ts`, `runCorpusCampaign.ts` (supports `--shard <n>` for
concurrent independent runs), `runCreativeCalibration.ts`,
`runPublicContextDiagnostic.ts`, `collectRunInventory.ts`, `summarizeRun.ts`,
`freezeProseLedger.ts`, `renderCreativeSample.ts`.

## 10. Traps

- **The pipeline is serial per unit by design** (durable journaling). Throughput
  comes from running independent frozen plans in parallel, not from parallelising
  one run. Shards have disjoint lineages because they use different seeds.
- **A run whose source tree changed is not resumable.** That is the journal
  working. Creative v5 is recorded as a **partial run**, never as a yield.
- **`familyWeights` is a scoped per-plan override**, never global, so frozen pilot
  digests stay byte-identical. Do not move it.
- **The legacy `roleplay-conversation` scaffold is set to weight 0** in the corpus
  plan; the creative stream supersedes it. Do not resurrect it.
- **`assertExportable` is not a content judge.** It verifies certificates and
  pins. Independent review is the content check. The creative player-agency
  violation is the proof that structural admission alone is insufficient.
- **Report/summary/ledger scripts refuse** on missing binding, digest mismatch,
  unpinned plan, wrong reviewer, or re-running a frozen census. If one refuses,
  read why — do not work around it.

## 11. Reading order

1. This file.
2. [`CORPUS_EXPORT_V1.md`](CORPUS_EXPORT_V1.md) — what was exported and its pins.
3. [`FOUNDRY_FINAL_REPORT.md`](FOUNDRY_FINAL_REPORT.md) — overall status and decision.
4. [`DATASET_QUALITY_REPORT.md`](DATASET_QUALITY_REPORT.md) — mechanical vs prose vs student impact.
5. [`CALIBRATION_RESULTS.md`](CALIBRATION_RESULTS.md) — per-run measured results.
6. [`COLAB_TRAINING_HANDOFF.md`](COLAB_TRAINING_HANDOFF.md) — how to train.
7. [`SYNTHETIC_DATA_BEST_PRACTICE.md`](SYNTHETIC_DATA_BEST_PRACTICE.md) — research that changed the plan.
8. [`DATASET_COVERAGE.md`](DATASET_COVERAGE.md) — families, weights and mixing.
9. [`CORRECTIONS_LOG.md`](CORRECTIONS_LOG.md) — chronological remediation record.

# Post-training evaluation workflow

How to measure a fine-tuned GGUF against the frozen stock baseline.
The full rule set is in `data/velvet-bench/corpus/SEALING.md`; this is the operational procedure.

## Non-negotiables

1. **Never modify or overwrite baseline artifacts.** `data/llm-models/*.gguf`,
   `data/velvet-bench/reports/freeform-run/*`, and `data/velvet-bench/corpus/frozen/` are the
   reference. A new model gets a new file and a new `modelId`.
2. **Identical inference settings.** Same quantization, same context, same KV cache type, same
   sampler seed. If settings must change, re-run the *stock* model under those settings too, so the
   comparison is never confounded.
3. **Never let the training side see `sealed-test/`.** Only `dev/` findings are shareable.
4. **Report improvements and regressions separately.** Never a single averaged number.

---

## 1. Receive and verify the trained model

The training machine should supply a HuggingFace repo/revision or a directory of safetensors, plus a
source revision. Record all of it before converting.

```powershell
python .\data\llm-models\convert_model.py `
  --repo  <owner>/<fine-tuned-repo> `
  --revision <40-hex commit sha> `
  --out   FineTune-v1-Llama-3.1-8B-Q4_K_M.gguf `
  --quant Q4_K_M
```

`convert_model.py` refuses an unpinned revision (it must be exactly 40 hex characters) and refuses to
overwrite an existing output unless `--force` is passed. It writes a `.provenance.json` recording the
source revision, every shard's SHA256, the quantization, the llama.cpp build, and the output SHA256.

**Verify** the output SHA256 is recorded before benchmarking, and keep the stock model's
`.provenance.json` next to it for comparison.

## 2. LoRA vs merged checkpoint

| Supplied | Action |
|---|---|
| Merged checkpoint (full weights) | Convert directly with `convert_model.py`. |
| LoRA adapter | **Merge first, then convert.** Do not evaluate an unmerged adapter: the adapter changes the prompt format and any comparison against the stock baseline would be invalid. |

Merging depends on the trainer (`peft`, `llama-factory`, Unsloth, …). Merge into a full checkpoint,
then convert that checkpoint. Record the base model revision used for merging.

## 3. Apply equivalent quantization

Convert the merged checkpoint with the **same** quantization as the baseline:

- stock Qwen3-8B baseline = **Q4_K_M**, converted by llama.cpp `b11574`.

Use `--imatrix` for both stock and fine-tune if you use one at all, with the *same* matrix file.
The stock RPMax conversion deliberately defaults to **no imatrix**, so a fair comparison to it also
omits one.

## 4. Register the model

Add an entry to `data/velvet-bench/bench.config.json`:

```json
{
  "id": "qwen3-8b-ft-v1",
  "alias": "qwen3-8b-ft-v1",
  "file": "FineTune-v1-Llama-3.1-8B-Q4_K_M.gguf",
  "huggingface": {
    "repo": "<owner>/<repo>",
    "revision": "<40-hex sha>",
    "file": "<source file>",
    "license": "<license>",
    "source": "fine-tuned"
  },
  "notes": "LoRA merged onto Qwen/Qwen3-8B; see merge provenance"
}
```

Keep the stock entries untouched. `.\Invoke-VelvetBench.ps1 list-models` will show both side by side.

## 5. Load through the identical backend

```powershell
.\Invoke-VelvetBench.ps1 stop-llm
.\Invoke-VelvetBench.ps1 start-llm -ModelId qwen3-8b-ft-v1
```

Confirm from `/props` that the effective `n_ctx` and KV cache type match the stock run exactly.
A silently different context invalidates the comparison.

## 6. Apply the correct chat template

Do **not** pass `--chat-template`. Each GGUF carries its own embedded template, and llama.cpp's
`--jinja` is enabled by default, so the fine-tuned model uses the template baked in at conversion.
That is what makes the comparison fair: stock and fine-tuned resolve their templates the same way.

If the trainer changed the template, it must be baked into the GGUF. Overriding at serve time would
be a second variable changing at once.

## 7. Run the identical suite

```powershell
.\Invoke-VelvetBench.ps1 preflight -ModelId qwen3-8b-ft-v1
.\Invoke-VelvetBench.ps1 metrics   -ModelId qwen3-8b-ft-v1
.\Invoke-VelvetBench.ps1 bench     -ModelId qwen3-8b-ft-v1
.\Invoke-VelvetBench.ps1 export
```

`bench` writes `reports/run-<modelId>-<timestamp>/` containing `01-preflight.json`,
`02-metrics.json`, `03-freeform-fun-eval.json`, `04-conformance.json`, and `SUMMARY.json`.

**Fresh world per model.** The evaluator bootstraps a new world each run, so the stock and fine-tuned
runs start from equivalent state. Never point both at the same `--data-dir`.

## 8. Generate the comparison

Deterministic correctness and subjective quality stay separate.

### Deterministic — compare pass@1, first answer only

A single successful retry must never hide an unsafe or malformed first answer.

| Signal | Source |
|---|---|
| `dmPlayCompatible`, `campaignGenerationCompatible` | `01-preflight.json` |
| Conformance probes (esp. `named-tool-call-narration`, `tool-result-replay`) | `04-conformance.json` |
| Forced-tool adherence after a tool-result round-trip | `repeat-probe.mjs` at n=10 |
| `coherenceViolations` | `03-freeform-fun-eval.json` |
| `declared-purchase` / `unknown-npc` / `cheating-commerce` probes | `03-freeform-fun-eval.json` |
| `verdict` pass/fail list | `03-freeform-fun-eval.json` |

### Subjective / descriptive — never merged into the above

`narrationProviderShare`, `materializationRate`, `dmBeatSuccessRate`, `latency*`. The repository is
explicit that a change here is "changed", not better or worse, and that fewer receipts is not a
playability regression.

### The headline target from this baseline

The stock baseline measures **3/10 forced-narration adherence after a tool-result round-trip**
(Qwen3-8B). If the fine-tune moves that number, it is the clearest single signal that RPG tool
behaviour actually changed. Report it as `stock 3/10 -> fine-tuned n/10`, never as a percentage of a
composite score.

## 9. Record it

Append to `STOCK_MODEL_BASELINE.md`:

- fine-tuned model provenance + SHA256
- quantization, context, KV cache type, llama.cpp build (must match stock)
- the deterministic table above with both columns
- improvements and regressions in **separate** lists
- the corpus `manifestRootDigest` used, proving the same test set was applied

If the corpus digest differs from the baseline, the comparison is not valid — re-freeze and re-run
both sides.
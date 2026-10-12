# Local inference + evaluation harness

Everything needed to reproduce the stock-model baselines on an RTX 4070 Laptop (8 GB).
Model weights, the llama.cpp runtime and the VelvetRP sqlite DB are deliberately **not**
tracked — see the `.gitignore` block that re-includes only this harness.

## Findings documents (read these first)

| document | what it answers |
|---|---|
| `DEV_CORPUS_GROUNDING_BOUNDARY.md` | **Grounding, boundary, action initiation on both stock models.** The most recent and the one that decides the training budget. |
| `REBASELINE_QWEN35_9B.md` | Qwen3.5-9B vs Qwen3-8B: tool adherence 9/10 vs 3/10, and the planning-inertia regression that number hides. |
| `STOCK_MODEL_BASELINE.md` | Full stock baseline, three-way context comparison, RPMax blocker. |
| `BASELINE_INFERENCE_SETUP.md` | Install steps, backend rationale, RPMax conversion, three Windows conversion traps. |
| `POST_TRAINING_EVALUATION.md` | How to score a LoRA/merged GGUF against these baselines. |

## Components

### `gateway/velvet-llm-gateway.mjs`
Translates **only** a named `tool_choice` into a single tool plus `"required"`, because
llama.cpp silently degrades a named `tool_choice`. Responses pass through byte-for-byte.
VelvetRP itself is unmodified. `test-gateway.mjs` holds 20 tests.

### `conformance/run-conformance.mjs`
Nine RPG-contract probes. Qwen3-8B passes 8/9; RPMax v1.3 passes 4/9.

### `tool-render-check.mjs` — **run this before trusting any tool-adherence number**
RPMax v1.3 failed *silently*: a request carrying a full tool schema reported
`prompt_tokens: 20` because its 348-character chat template never renders `tools`.
llama.cpp emitted no warning and returned HTTP 200. This sends the same conversation with
and without tools and compares `prompt_tokens`; exit 2 means stop, do not report a score.

### `eval/` — frozen dev-partition harness
Two stages, deliberately separated so grading stays deterministic and re-runnable without
re-querying a model.

```bash
# 1. verify + fetch the authoritative corpus byte-exactly from the foundry branch
node data/velvet-bench/eval/fetch-and-verify.mjs

# 2. run the 106 dev cases against one model (pass@1, no retries)
node data/velvet-bench/eval/run-dev-corpus.mjs --model qwen3-8b  --out data/velvet-bench/eval/raw-qwen3-8b.json
node data/velvet-bench/eval/run-dev-corpus.mjs --model qwen35-9b --out data/velvet-bench/eval/raw-qwen35-9b.json

# 3. grade (pure; never contacts a model)
npx tsx data/velvet-bench/eval/grade-dev-corpus.ts --raw data/velvet-bench/eval/raw-qwen3-8b.json

# 4. report, including the cross-model control checks
node data/velvet-bench/eval/report-dev-corpus.mjs \
  --graded data/velvet-bench/eval/raw-qwen35-9b-graded.json \
  --graded data/velvet-bench/eval/raw-qwen3-8b-graded.json

# 5. normaliser unit checks (15 assertions, guards two real grader bugs)
node data/velvet-bench/eval/test-normalize.mjs

# inspect a single case
node data/velvet-bench/eval/show-case.mjs <graded.json> <reason-prefix>
```

**Held constant across models** (verified by comparing per-case prompt digests, 106/106
identical): context 24,576 · KV `q8_0`/`q8_0` · `-ngl 99` · `tool_choice: auto` (never
forced, so initiation stays measurable) · temperature 0 · max_tokens 1024 ·
`reasoning_effort: none`.

**Grounding oracle.** `eval/src/grounding.oracle.ts` is the foundry's
`dataset/src/grounding.ts` (`grounding-binding-v1`) copied verbatim except one relative
import path, so it can resolve the production `analyzeClaimReceipts` from this checkout.
It implements subject→action→target→value→outcome binding with polarity. The production
gate `providerNarrationMatchesReceipts` is deliberately **not** used as the oracle: the audit
showed it accepts swapped total/DC pairs, an opposite verdict, and invented consequences.

### `scripts/Invoke-VelvetBench.ps1`
`install · list-models · start-llm · start-velvet · health · preflight · metrics · bench · export · stop-llm`.
`bench.config.json` is the single source of truth for models, context size, KV type and
reasoning mode — no machine paths are hard-coded, and every script tolerates spaces in paths.

**Windows trap worth knowing:** `start-llm` must not be piped through `Select-Object` when
backgrounded. llama-server inherits the PowerShell stdout handle, so the pipeline never
completes and the caller hangs for the full timeout even though the server came up fine.

## Not committed, and why

| path | reason |
|---|---|
| `data/llm-models/` | 12 GB of GGUF weights. Fetch with `download_model.py` / `convert_model.py`. |
| `data/llm-runtime/llama/` | llama.cpp CUDA binaries. Installed by `Invoke-VelvetBench.ps1 install`. |
| `data/velvet-bench/eval/dev-cases/` | The authoritative corpus lives on `origin/feat/training-data-foundry`. Committing a second copy here would let the two drift silently. `fetch-and-verify.mjs` pulls it byte-exactly. |
| `data/velvet-bench/corpus/` | Superseded locally-authored asset corpus with **zero cases**; it caused the digest confusion documented in `DEV_CORPUS_GROUNDING_BOUNDARY.md` §1. |
| `data/velvet-bench/reports/**/world*` | Bootstrapped eval worlds, ~100 MB. Regenerate by re-running the evaluator. |

**Sealed evaluation material was never run.** It lives outside the repository by design; only
its checksums are pinned (`eval/sealed-attestation.json`: 107 cases, 11 categories).
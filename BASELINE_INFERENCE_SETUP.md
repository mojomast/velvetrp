# BASELINE_INFERENCE_SETUP.md

Windows local-inference + VelvetRP benchmarking workstation.
Everything here was executed on the target machine; evidence is recorded per step.

- **Host:** `BRRRRRRRR` — Windows 11 Home, build 26200
- **VelvetRP commit:** `4447d2cdb0260174bb2c2461f76600d11980c427`
- **Corpus root digest:** `6310180d2ba4271bbf89ed4c86206d64dc0db92ae616b84bd7133c7498e1df55`

---

## 1. Hardware and toolchain (Phase 1)

| Item | Value | Verified by |
|---|---|---|
| OS | Windows 11 Home 10.0.26200 (Standalone Workstation) | `systeminfo` |
| GPU | NVIDIA GeForce RTX 4070 Laptop GPU, **8187 MiB** | `nvidia-smi`, `llama-server --list-devices` |
| Driver | 617.14, CUDA UMD 13.4 | `nvidia-smi` |
| CUDA toolkit | 13.4 (`nvcc` V13.4.59) — installed, but **not required** (llama.cpp bundles its own runtime) | `nvcc --version` |
| RAM | 68,413,153,280 bytes (~63.7 GiB) | `Win32_ComputerSystem` |
| CPU | Intel Core i7-14650HX, 24 logical processors | `Win32_Processor` |
| Disk | C: 56 GB free at setup; D: 159 GB free | `Get-PSDrive` |
| git | 2.51.0.windows.1 | `git --version` |
| Node.js | **v24.8.0** (npm 11.6.0) | `node --version` |
| Python | 3.13.7, `huggingface_hub` 1.2.3 | `python --version` |
| PowerShell | 5.1.26100.9444 (and pwsh 7) | `$PSVersionTable` |

### Notes that matter

- **Node 24 works.** The repo documents Node 22 and CI pins 22. `npm ci`, `npm run typecheck`, and
  `npm run build` all pass on 24.8.0, so no downgrade was performed (avoiding an unnecessary change
  to a working machine).
- **No pre-existing inference software** was found. The HuggingFace cache holds only unrelated
  `prism-ml/*-27B` GGUFs, which were left untouched.
- **VRAM is shared.** ~1.1 GB was already in use by desktop apps at setup time. This is the
  binding constraint on the whole configuration, not the 8 GB headline number.

---

## 2. VelvetRP install (Phase 2)

```powershell
git clone https://github.com/mojomast/velvetrp.git
cd velvetrp
git fetch origin
git switch main
git pull --ff-only origin main
git rev-parse HEAD
# 4447d2cdb0260174bb2c2461f76600d11980c427
```

| Command | Result |
|---|---|
| `npm ci` | **PASS** — 324 packages, 12s |
| `npm run typecheck` | **PASS** — contracts, server, client, e2e, hydration-cli |
| `npm run build` | **PASS** — contracts + `server/dist` + `client/dist` (1,540 kB bundle) |
| `npm test` | **FAIL — 1 of 480**, see below |

### The one failing test is an upstream defect at this commit, not an environment problem

```
FAIL  packages/contracts/test/srd-starter.test.ts
  expected '1.7.0+a870b31918ec' to match /^1\.6\.0\+[0-9a-f]{12}$/
```

- `packages/contracts/src/srd-starter.ts:5` exports `SRD_5_1_STARTER_PACK_VERSION = "1.7.0+a870b31918ec"`.
- `packages/contracts/test/srd-starter.test.ts:12` still asserts the `1.6.0` shape.
- `git status --porcelain` is **empty** — the working tree is clean, so this is the committed state of
  `4447d2c`, whose HEAD commit is *"feat(rpg): add the Sintermark SRD 5.1 campaign"*. The version was
  bumped without updating the assertion.

Everything else passes: 479/480 tests, all server and client suites green (the contracts failure
aborts the root script before the server workspace runs, so the server suite was run separately —
see §7).

**This was deliberately not "fixed".** Editing the tracked assertion would change the very commit SHA
the benchmark is pinned to, and would be indistinguishable from weakening a test to manufacture a
pass. Report it upstream instead.

### Explicit data directory

The benchmark uses a dedicated directory so startup location, service working directory, and live
tests can never select different databases:

```
C:\Users\kyle\projects\velvetrp\data\velvet-bench        <- VELVET_DATA_DIR (velvet.sqlite)
C:\Users\kyle\projects\velvetrp\data\llm-models         <- immutable stock models
C:\Users\kyle\projects\velvetrp\data\llm-runtime         <- llama.cpp binaries
```

All of it lives under `data/`, which the repository's own `.gitignore` already excludes, so **no
tracked file was modified** and the pinned commit is preserved.

---

## 3. Local inference backend (Phase 3)

### Selected: llama.cpp `b11574` (version 0.6.0-dev, build 11574, commit 8bb3cf0d2)

Rationale, with the alternatives:

| Candidate | Verdict |
|---|---|
| **llama.cpp `b11574`** | **Selected.** Per-release CUDA **13.4** x64 binaries, sm_89 SASS precompiled, matches driver 617.14 exactly. Verified CUDA device detection on this machine. |
| KoboldCpp `v1.122.1` | Rejected as primary. Ships **CUDA 12.1**, and collapses named `tool_choice` to `"required"` (any tool, not the named one) via an extra LLM tool-selection pre-pass. Larger, slower first run (636 MB PyInstaller). Retained as a documented fallback. |
| Ollama `v0.40.3` | Rejected. Its OpenAI-compat matrix documents **`tool_choice` as unsupported** — a hard blocker for VelvetRP. |
| llamafile `v0.10.6` | Rejected. Same llama.cpp API limits, plus documented Windows caveats (>4 GB exes won't run; bundled CUDA library omits IQ-quant kernels). |
| LM Studio | Rejected. Best spec fidelity, but closed-source and bundles its own runtime — unsuitable for a reproducible benchmark. |

### Install

llama.cpp requires **two** zips extracted into the *same* directory; the binaries zip has no CUDA DLLs.

```powershell
$tag = 'b11574'
curl.exe -L -o llama.zip   "https://github.com/ggml-org/llama.cpp/releases/download/$tag/llama-$tag-bin-win-cuda-13.4-x64.zip"
curl.exe -L -o cudart.zip "https://github.com/ggml-org/llama.cpp/releases/download/$tag/cudart-llama-bin-win-cuda-13.4-x64.zip"
Expand-Archive llama.zip   data\llm-runtime\llama -Force
Expand-Archive cudart.zip data\llm-runtime\llama -Force
```

Verification:

```powershell
llama-server.exe --version
# version: 0.6.0-dev (build 11574, commit 8bb3cf0d2)

llama-server.exe --list-devices
# Available devices:
#   CUDA0: NVIDIA GeForce RTX 4070 Laptop GPU (8187 MiB, 7068 MiB free)
```

Required files present beside `llama-server.exe`: `ggml-cuda.dll`, `cudart64_13.dll`,
`cublas64_13.dll`, `cublasLt64_13.dll`.

### ⚠ Blocker found and solved: named `tool_choice`

**This is the single most important finding in this phase.** VelvetRP's narration contract requires
OpenAI *named* tool choice:

```json
"tool_choice": { "type": "function", "function": { "name": "submit_adventure_narration" } }
```

llama.cpp reads `tool_choice` with a helper that accepts only a JSON **string**. An object throws
inside a `try/catch`, logs `Wrong type supplied for parameter 'tool_choice'`, and silently falls back
to `"auto"`. The request still returns HTTP 200, so the degradation is invisible unless you read the
server log or measure forced-vs-auto behaviour.

**Practical alternative implemented:** `data/velvet-bench/gateway/velvet-llm-gateway.mjs`, a ~200-line
OpenAI-compatible pass-through that converts *only* named tool choice into the pair llama.cpp does
honour — `tools = [named tool only]` + `tool_choice = "required"` — which is exactly the OpenAI
semantics of named selection. Everything else is forwarded byte-for-byte, including SSE streams.

It does **not** repair arguments, invent tool calls, or relax any VelvetRP validator. Velvet still
sends the request it always sends; the backend simply stops discarding the instruction.

Proof it is confined to that one behaviour — 20/20 unit tests in `gateway/test-gateway.mjs`:

```
named choice filters tools to one            PASS
named choice keeps the named tool             PASS
named choice becomes required                 PASS
unknown named tool is recorded, not guessed   PASS
tool_choice 'required' / 'auto' / 'none' unchanged  PASS
json_schema + strict flag preserved           PASS
messages/temperature/stream/max_tokens unchanged   PASS
```

VelvetRP itself is **unmodified** — its validation is not weakened anywhere.

### Second documented limitation

llama.cpp ignores OpenAI's `strict` boolean but **compiles the JSON Schema to a GBNF grammar**, so
output is grammar-enforced and strictly conforming in effect. `additionalProperties:false` semantics
must live inside the schema, which Velvet already does. Both preflight probes use
`{"type":"string","const":...}`, which the grammar converter supports.

### Third: do not combine tools with `response_format`

`response_format` short-circuits the tools branch in llama.cpp's parser builder, so a schema grammar
is enforced over the whole generation and tool calls become unreachable. Velvet already never does
this: campaign generation sends `tool_choice:"none"` with `json_schema`, narration sends tools only.
That separation is load-bearing and is preserved here.

---

## 4. Models (Phase 4)

| Model | Source | Revision | License | Status |
|---|---|---|---|---|
| **Qwen3-8B** | `Qwen/Qwen3-8B-GGUF` (official) | `7c41481f57cb95916b40956ab2f0b139b296d974` | Apache-2.0 | `Qwen3-8B-Q4_K_M.gguf` |
| **RPMax v1.3 8B** | `ArliAI/Llama-3.1-8B-ArliAI-RPMax-v1.3` | `8fb4a0d9e7944ecfa75b9c50a2818b33b85cc436` | llama3.1 | **converted locally** |
| L3-8B-Stheno v3.2 | `bartowski/L3-8B-Stheno-v3.2-GGUF` | pinned at download time | llama3.1 | optional |

### Finding: RPMax **v1.3** has no third-party GGUF

An exhaustive HuggingFace search returned GGUF conversions for RPMax **v1.0** and **v1.1** only
(`bartowski/...v1.1-GGUF`, `backyardai/...v1.1-GGUF`, `QuantFactory/...v1.1-GGUF`, …). There is no v1.3
GGUF from any publisher — `bartowski/ArliAI_Llama-3.1-8B-ArliAI-RPMax-v1.3-GGUF` returns 401.

So for the v1.3 target the only trustworthy path is reproducible conversion from upstream. See §8.

### Download method

`data/llm-models/download_model.py` pins an exact commit revision, streams via `curl`/HF, computes
SHA256, and writes a `<file>.provenance.json` sidecar recording repo, revision, license, size, digest,
and UTC timestamp. It **never re-downloads or overwrites an existing verified file**, keeping stock
models immutable.

> **Note on transfer reliability:** `huggingface_hub`'s default xet transfer stalled at 826 MB on this
> machine and never resumed. Downloads are performed with `curl.exe -L --retry 10 --retry-all-errors -C -`,
> which resumes cleanly. If a model file looks truncated, re-run the curl command; it continues rather
> than restarting.

---

## 5. Operating the stack

One entry point, config-driven, no hard-coded machine paths, all paths `-LiteralPath` (spaces safe):

```powershell
cd data\velvet-bench\scripts

.\Invoke-VelvetBench.ps1 install                       # toolchain, GPU, DLL presence
.\Invoke-VelvetBench.ps1 list-models                   # revisions, sizes, checksums
.\Invoke-VelvetBench.ps1 start-llm   -ModelId qwen3-8b # llama.cpp + gateway, waits for ready
.\Invoke-VelvetBench.ps1 start-velvet                   # VelvetRP API + Vite, explicit data dir
.\Invoke-VelvetBench.ps1 health                         # all four endpoints
.\Invoke-VelvetBench.ps1 preflight   -ModelId qwen3-8b # VelvetRP capability preflight
.\Invoke-VelvetBench.ps1 metrics     -ModelId qwen3-8b # pp/tg tok-s, TTFT, peak VRAM
.\Invoke-VelvetBench.ps1 bench       -ModelId qwen3-8b # full baseline run
.\Invoke-VelvetBench.ps1 stop-llm
.\Invoke-VelvetBench.ps1 export                         # hashed artifact bundle
```

Pointing VelvetRP at the local endpoint, via `PUT /api/provider`:

```json
{
  "baseUrl": "http://127.0.0.1:8081/v1",
  "model": "qwen3-8b",
  "apiKey": "local-benchmark-noop",
  "providerType": "llamacpp",
  "streaming": true
}
```

Velvet accepts loopback HTTP without a key, and sends `Authorization` only to loopback hosts, so the
placeholder key is inert. The stored provider row wins over environment defaults, so the API write —
not `.env` — is the authoritative configuration step.

---

## 8. RPMax v1.3 — reproducible conversion

There is no third-party GGUF for RPMax **v1.3**, so the benchmark converts upstream safetensors itself.
Using the published v1.1 GGUF instead would have silently benchmarked a different model.

```powershell
# 1. toolchain (already installed on this machine)
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
python -m pip install gguf safetensors sentencepiece transformers

# 2. llama.cpp source, pinned to the SAME build used to serve the Qwen3 baseline
git clone --depth 1 --branch b11574 https://github.com/ggml-org/llama.cpp.git data\llm-runtime\llama.cpp-src

# 3. stage the exact upstream weights
#    (download_model.py or curl; see the note on xet stalls below)

# 4. convert + quantise
python .\data\llm-models\convert_model.py `
  --repo ArliAI/Llama-3.1-8B-ArliAI-RPMax-v1.3 `
  --revision 8fb4a0d9e7944ecfa75b9c50a2818b33b85cc436 `
  --out RPMax-v1.3-Llama-3.1-8B-Q4_K_M.gguf `
  --quant Q4_K_M
```

`convert_model.py` refuses an unpinned revision (must be exactly 40 hex chars) and refuses to overwrite
an existing output without `--force`. It records the source revision, every shard's SHA256, the
quantization, the llama.cpp build, and the output SHA256 in a `.provenance.json` sidecar.

**No importance matrix by default.** A plain Q4_K_M with no hidden calibration data is reproducible. If
an imatrix is used for a fine-tune, use the *same* matrix file for the stock side or the comparison is
invalid.

### Three Windows-specific traps hit during this conversion

1. **`huggingface_hub`'s xet transfer stalls.** It downloaded 826 MiB and then sat with no progress and
   no log output for 8+ minutes. `HF_HUB_DISABLE_XET=1` did not fix it. `curl.exe -L --retry 10
   --retry-all-errors -C -` works and resumes.
2. **PowerShell ate the `?` in the URL.** `"$f?download=true"` is parsed as a variable named `f?`, so
   the request went out as `?download=true` and every metadata file silently became the 15-byte string
   `Entry not found`. The converter then crashed in `json.load`. Use `"${f}?download=true"`. Check file
   sizes after bulk downloads rather than trusting the exit code.
3. **`--split-max-size 4G` produced shards, not the requested file.** The converter wrote
   `-f16-00001-of-00005.gguf` … `-00005-of-00005.gguf` and `llama-quantize` then reported
   `failed to open GGUF file ... No such file or directory`. `convert_model.py` no longer passes
   `--split-max-size`; if shards already exist, merge them first:

   ```powershell
   .\data\llm-runtime\llama\llama-gguf-split.exe --merge <first-shard.gguf> <merged.gguf>
   ```

### Disk note

Conversion needs roughly 2x the model size in free space (staged safetensors + f16 GGUF + the quantized
output). Budget ~40 GiB peak for an 8B model at Q4_K_M.

---

## 9. Known upstream issue

`npm test` fails 1/480 at the pinned commit for the reason in §2. It is unrelated to inference and is
reported, not patched. Server and client suites were run independently and pass.
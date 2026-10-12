# Re-baseline: Qwen3.5-9B vs Qwen3-8B

Measurement run, 2026-10-12. Nothing else about the stack was changed.

| | |
|---|---|
| New model | `unsloth/Qwen3.5-9B-GGUF` @ `3885219b6810b007914f3a7950a8d1b469d598a5`, Apache-2.0 |
| Quant | `Qwen3.5-9B-UD-Q4_K_XL.gguf` (5,966,095,584 B) + `mmproj-F16.gguf` (918,166,080 B) |
| Integrity | **Both files' SHA256 match HF's content-addressed blob IDs.** |
| VelvetRP | unmodified, `4447d2cdb0260174bb2c2461f76600d11980c427` |
| Sealed corpus | **not run** |

---

## 1. Primary metric — forced-tool adherence after a tool-result round-trip

Identical probe (`probe-replay-orphan.json`), 10 trials, only the `model` field overridden so the
prompt payload stays byte-identical.

| | Tool call emitted | Ran to token cap in prose |
|---|---:|---:|
| **Qwen3-8B** | **3 / 10** | 7 |
| **Qwen3.5-9B** | **9 / 10** | 1 |

Evidence: `reports/qwen35-9b-adherence-10trials.txt`, `reports/replay-reliability-qwen35-9b.txt`.

**The failure *mode* did not change — only the rate.** Every failure in both models is identical:
`finish_reason: length`, `completion_tokens: 400`, i.e. the model writes prose until the cap and never
converts. Qwen3-8B did that 7 times; Qwen3.5-9B did it once. This is a behavioural refusal of the tool
call, not a budget or protocol failure, in both cases.

### Decision rule

**9/10 ≥ 7 → the `≥ 7/10` branch applies.** The tool-adherence gap was overwhelmingly model age, not a
capability the dataset must teach. Tool-selection weighting should be cut sharply and the first tranche
refocused on grounding and boundary behaviour.

That conclusion is well supported for *transport reliability*, but see §4 — this model has a new and
serious weakness that the adherence number alone hides.

---

## 2. Tool-rendering sanity check — PASS

Run before any number was trusted, because RPMax failed silently.

| | Qwen3.5-9B | RPMax v1.3 (contrast) |
|---|---:|---:|
| `prompt_tokens` WITH tools | **458** | 20 |
| `prompt_tokens` WITHOUT tools | 52 | ~20 |
| Delta | **+406 (×8.81)** | ≈ 0 |
| Forced tool call parses | **yes** — `propose_travel {"destination":"docks"}` | no |

Tools demonstrably reach the template, and a forced call parses back under the expected parser with
the correct exact enumerated candidate. **The adherence result is trustworthy.**

Script: `data/velvet-bench/tool-render-check.mjs` (exit 0 = pass, 2 = tools not rendered → stop).

---

## 3. Side-by-side comparison

18-turn free-form evaluator, seed 11, fresh world per model, ctx 24576, `q8_0` KV, same gateway.

| Metric | Qwen3-8B | Qwen3.5-9B | Δ |
|---|---:|---:|---|
| **Adherence (round-trip)** | **3/10** | **9/10** | **+6** |
| Provider calls | 66 | 62 | −4 |
| Provider success | 93.9% (62/66) | **100% (62/62)** | +6.1 pt |
| Failure type | 4× HTTP 400 **context overflow** | **none** | — |
| DM beats | 6/6 | 6/6 | = |
| **Materialization rate** | **50.0% (9/18)** | **0% (0/18)** | **−50 pt** |
| Narration: provider-assisted | 9 (50.0%) | 10 (55.6%) | +5.6 pt |
| Narration: deliberate-hold | 0 | **5 (27.8%)** | +27.8 pt |
| Narration: failure | 9 | **3** | −6 |
| Commerce committed | 1 | 0 | −1 |
| Coherence violations | 0 | 0 | = |
| Prompt tokens (run total) | 451,073 | 465,313 | +14,240 |
| Completion tokens (run total) | 6,532 | 9,942 | +3,410 |
| Latency avg / p95 | 18.1 s / 34.9 s | 20.5 s / 38.9 s | +2.4 s / +4.0 s |
| **VRAM at 24,576** | 7,071 MiB | **6,631 MiB** | **−440 MiB** |

VRAM headroom on the 8 GB card: **1,557 MiB** (of 8,188 MiB total).

### Why Qwen3.5-9B uses *less* VRAM than a smaller model

Hybrid architecture: `full_attention_interval: 4`, so only **8 of 32 layers** carry a per-token KV
cache; the other 24 are linear-attention layers with fixed-size recurrent state.

| | per token (q8_0) | KV @ 24,576 |
|---|---:|---:|
| Qwen3-8B (36 full-attn layers, 8 kv heads, head_dim 128) | 72.0 KiB | 1.69 GiB |
| Qwen3.5-9B (8 full-attn layers, 4 kv heads, head_dim 256) | **16.0 KiB** | **0.38 GiB** |

**4.5× less KV per token**, despite the larger parameter count. The mmproj projector (~876 MiB) was
held on CPU via `--no-mmproj-offload`, which is what makes 24,576 viable at all.

---

## 4. The finding that matters more than adherence

**Qwen3.5-9B is far more reliable at *transport* and far worse at *proposing mechanics*.**

Planning-lane tool selection (the lane that decides what becomes true):

| | no tool (abstain) | read tool | mutation tool |
|---|---:|---:|---:|
| Qwen3-8B | **0** / 16 | 7 | 9 |
| Qwen3.5-9B | **12** / 15 | 0 | 3 |

Qwen3.5-9B answered **every** request validly — zero protocol errors, zero context overflows, 6/6 DM
beats — but declined to select a mechanic on 12 of 15 planning turns. `exact_actor_travel` was never
selected once, which is why `travel-mapped` and `travel-back` both became deliberate holds. The
mechanical consequence is **materialization 50% → 0%** and `deliberate-hold` turns 0 → 5.

That is not a transport regression; it is a planning-inertia regression that the adherence number alone
would have hidden. The 9/10 figure measures "did it call the tool it was told to call", not "did it
propose the right action".

---

## 5. Controls I could **not** hold constant

Listed in descending order of how much they threaten the comparison.

1. **Corpus digest does not match.** The brief specifies `22eb78976caa9ca91102f75576ea19eeb8cef8d594435275630542b7ddef8e58`.
   The frozen corpus on this machine is `6310180d2ba4271bbf89ed4c86206d64dc0db92ae616b84bd7133c7498e1df55`
   (dev `e7edb1a4…`, sealed `d42867d9…`). **None of the three match.**
   *Mitigation, and why the comparison still holds:* the sealed corpus was **not load-bearing** for
   either measurement. The primary probe is a fixed standalone payload (`probe-replay-orphan.json`),
   and the free-form run uses the repository evaluator's own bootstrapped world at seed 11. Both models
   ran byte-identical fixed probes. **But** if a future fine-tune comparison is meant to use the sealed
   corpus, that digest must be reconciled first — otherwise the fine-tune will be scored against a
   different test set than this baseline.
2. **Quantization differs, necessarily.** Q4_K_M (Qwen3-8B, established) vs UD-Q4_K_XL (Qwen3.5-9B,
   vendor-recommended). Different schemes *and* different model size. "Model age" and "quant quality"
   are **confounded** — this is not a clean single-variable swap. Reducing it would require
   Qwen3.5-9B in Q4_K_M, which does not exist in that repo.
3. **Reasoning-off mechanism differs.** Qwen3-8B was disabled per-request via `reasoning_effort: "none"`;
   Qwen3.5-9B is disabled server-side via `--reasoning off`. Effective state is the same, but the
   probe payload still carries `reasoning_effort: none` for both, so the Qwen3-8B path was exercised
   through the request field and the Qwen3.5 path through the server flag.
4. **mmproj is present** for Qwen3.5-9B (required to load; held on CPU). Qwen3-8B has none.
5. **Model size differs** (8B vs 9B). Unavoidable given the brief.

Held constant and verified: context 24576 · KV `q8_0`/`q8_0` · `-ngl 99` full GPU offload · same
gateway binary and same `tool_choice` rewrite · same probe payload bytes · same seed 11 · same 18
turns · VelvetRP `4447d2c` unmodified · sealed not run.

---

## 6. Caveats carried forward

- **One run per model.** Each 18-turn run is a single sample. The repo's own guidance is to compare
  medians across several runs.
- **Narration share moved +5.6 pt while materialization moved −50 pt.** These point in opposite
  directions. Flagging rather than declaring either model better: the provider-assisted share rose
  because transport became reliable, not because planning improved.
- **No subjective quality scores.** Labelled qualitative impression only, from reading the adherence
  probe output: Qwen3.5-9B narrations were markedly terser and showed a repetition pattern —
  *"I stepped out of the tavern…"* recurred across 4 of 9 successes and two responses were only 38
  tokens. That is an observation, not a measurement, and it deserves a proper creative-quality pass
  before any dataset weighting depends on it.

---

## 7. Recommendation

Apply the **≥7/10** branch on tool-selection: cut its weight sharply. But do not read 9/10 as "this model
needs no help". Its planning abstention rate (12/15) is the larger defect by downstream impact, and
**planning-inertia / refusal-to-propose-mechanics** is the behaviour the first training tranche should
target — ahead of grounding and boundary work, which remain untested on either model.
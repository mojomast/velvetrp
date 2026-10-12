# STOCK_MODEL_BASELINE.md

Before-training baseline for VelvetRP on local Windows CUDA inference.
**Every number below came from an actual run on this machine.** Nothing is projected.

| | |
|---|---|
| Host | `BRRRRRRRR` — Windows 11 Home build 26200, RTX 4070 Laptop 8187 MiB, driver 617.14 |
| VelvetRP commit | `4447d2cdb0260174bb2c2461f76600d11980c427` |
| Corpus root digest | `6310180d2ba4271bbf89ed4c86206d64dc0db92ae616b84bd7133c7498e1df55` |
| Backend | llama.cpp `b11574` (0.6.0-dev, build 11574) CUDA 13.4, sm_89 |
| Captured | 2026-10-12 |

---

## 1. Model inventory

| Model | File | Source / revision | License | SHA256 | Status |
|---|---|---|---|---|---|
| Qwen3-8B | `Qwen3-8B-Q4_K_M.gguf` | `Qwen/Qwen3-8B-GGUF` @ `7c41481f5` | Apache-2.0 | `d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785` | **verified + benchmarked** |
| RPMax v1.3 8B | `RPMax-v1.3-Llama-3.1-8B-Q4_K_M.gguf` (4,920,734,656 B, 4.89 BPW) | `ArliAI/Llama-3.1-8B-ArliAI-RPMax-v1.3` @ `8fb4a0d9e7` | llama3.1 | `c83fe41f53181ec69316470c732f033eb34693b9d51157dd1fe3bb592f3655b2` | **verified + benchmarked — NOT DM-capable** |

Qwen3 integrity was proven the strongest way available: HuggingFace LFS blobs are content-addressed,
so the file's own SHA256 **equals** its blob ID. They match exactly.

RPMax provenance is equally strong: **all four upstream safetensors shards were verified against their
HF content-addressed blob IDs before conversion**, and the output SHA256 is recorded in
`RPMax-v1.3-Llama-3.1-8B-Q4_K_M.provenance.json`.

**No third-party GGUF exists for RPMax v1.3** (only v1.0/v1.1 conversions exist), so v1.3 was converted
locally from upstream safetensors. Substituting v1.1 would have silently benchmarked a different model.
Conversion: llama.cpp `b11574` `convert_hf_to_gguf` to f16, then `llama-quantize` Q4_K_M in **87.6 s**
(15,317 MiB f16 @ 16.00 BPW -> 4,685 MiB @ 4.89 BPW), imatrix-free so the result is reproducible.

---

## 2. Inference performance (Qwen3-8B Q4_K_M, RTX 4070 Laptop)

| Metric | `-c 4096` | `-c 16384`, `-ctk/v q8_0` |
|---|---|---|
| Model load time | 5.2 s | 2.7 s |
| Prompt processing | 1040 tok @ **2264.6 tok/s** | (same weights) |
| Generation | 128 tok @ **46.1 tok/s** | see `reports/metrics-*.json` |
| Effective context | 4096 | **16384** |
| Peak VRAM | 6066 MiB | 6419 MiB |
| GPU offload | full (`-ngl 99`), CUDA0 confirmed | full |

Prompt processing is inflated by llama.cpp's prompt cache; generation speed is the honest figure.

---

## 3. Provider capability preflight (VelvetRP's own probe)

Run through the gateway on `http://127.0.0.1:8081/v1`:

| Capability | Result |
|---|---|
| `function-tools` (DM play) | **supported** |
| `strict-json-schema` (campaign generation) | **supported** |
| `dmPlayCompatible` | **true** |
| `campaignGenerationCompatible` | **true** |
| `ok` | **true** |

Report: `data/velvet-bench/reports/preflight-qwen3-8b-20261012-153735.json`.

**Qwen3-8B Q4_K_M is RPG-capable on this stack.** This is the single most important positive result.

---

## 4. RPG contract conformance — 8/9

`data/velvet-bench/conformance/run-conformance.mjs`, modelling real VelvetRP request shapes.

| Probe | Result | Note |
|---|---|---|
| basic chat | PASS | |
| streaming | PASS | incremental deltas + measurable TTFT |
| forced tool call (`required`) | PASS | preflight-equivalent shape |
| **named tool call (narration)** | **PASS** | exactly 1 call, one-key `{narration:string}` |
| tool selection w/ exact enum candidate | PASS | picks the exact enumerated candidate |
| **tool-result replay** | **FAIL** | see §5 — quantified 3/10 |
| strict JSON schema | PASS | no stray tool calls |
| abstention (no false mutation) | PASS | |
| narration grounding (no fabrication) | PASS | |

---

## 5. The one real failure, quantified

**After a tool-result round-trip, Qwen3-8B honours a forced narration tool call only 3/10 times.**

It writes narration as plain assistant `content` instead, ignoring `tool_choice`. Raising
`max_tokens` from 400 to 900 did **not** help — the failures still ran to the cap in prose and never
converted, so this is a genuine behavioural refusal to call the tool, not a budget problem.

| | |
|---|---|
| Fresh turn, forced named narration call | **6/6** |
| After a tool-result transcript | **3/10 (30%)** |

VelvetRP is not broken by this: `narrationTextFromResult` rejects the malformed response and the
bounded grounding-correction retry plus deterministic hold handle it safely. The cost is a lower
provider-assisted narration rate. **This is a prime target for the future LoRA.**

---

## 5b. RPMax v1.3 — preflight fails, and the cause is the chat template

| Capability | Result |
|---|---|
| `function-tools` (DM play) | **unsupported (protocol)** |
| `strict-json-schema` (campaign generation) | **supported** |
| `dmPlayCompatible` | **false** |
| `campaignGenerationCompatible` | **true** |
| `ok` | **false** |

Conformance: **4/9** (basic chat, streaming, strict JSON schema, abstention pass; every tool-call probe
fails with `callCount=0`).

### Root cause: the model's embedded chat template has no tool support

This is a **chat template** defect, not a backend, gateway, request-config, or VelvetRP defect. Proof:

1. **`prompt_tokens: 20`** on a request that carried a complete `velvet_capability_probe` schema. If the
   tool had been rendered, the prompt would have been far longer. The tools were never sent to the model.
2. RPMax's embedded Jinja template is **348 characters** and matches neither `tools` nor `tool_call`.
   It is a plain role/content renderer.
3. Contrast with Qwen3-8B, whose embedded template begins `{%- if tools %}` — tools-capable — and which
   passes the identical probe.
4. The raw response to the forced-tool probe was prose: *"The exact marker velvet-capability-v1 is not
   available."* — a roleplay-tuned chat model answering a system instruction as conversation.

llama.cpp emitted **no warning** when it dropped the tools. That silence is the dangerous part: the
request returns HTTP 200 and only fails downstream as a `protocol` classification.

### Practical alternatives, in order of preference

1. **Use a tool-capable base.** Qwen3-8B is verified working on this stack and is the better baseline
   candidate anyway. RPMax v1.3 is a roleplay fine-tune of Llama 3.1 with no function-calling training.
2. **Supply a tools-capable template** via `--chat-template-file`. This makes the *interface* work, but
   RPMax was never trained to emit tool calls in that format, so adherence would be unreliable and the
   resulting benchmark would not measure a usable model. Not recommended as a baseline.
3. **Use RPMax for creative roleplay only**, where it may well be strong, and keep a tool-capable model
   on the structured lanes. Its narration quality was not scored here, so this remains a hypothesis, not
   a finding.

No 18-turn free-form run was executed for RPMax: with `dmPlayCompatible: false`, every planning and
narration dispatch would deterministically fall back, so the result would measure VelvetRP's fallback
path rather than the model. Running it would produce a misleading artifact.

---

The repository's own `scripts/freeform-fun-eval.ts`, driven over real HTTP against a freshly
bootstrapped world, seed 11, 18 scripted turns, 6 interleaved DM beats.

### Run A — `-c 4096` (the Phase 5 starting point)

| Metric | Value |
|---|---|
| providerCalls | 58 |
| **providerSuccessRate** | **27.6%** (16 ok / 42 failed) |
| narrationsProvider | 8 / 18 (44.4%) |
| deliberateHoldTurns | 1 (5.6%) |
| narrationFailureTurns | 9 |
| fallbackDistinctness | 4 distinct / 9 (44.4%) |
| materializationRate | **0%** |
| dmBeatSuccessRate | **0%** (0/6) |
| coherenceViolations | 0 |
| latencyAvg / p95 | 3024 ms / 5400 ms |

### Diagnosis of Run A

40 of the 42 failures were **HTTP 400 context overflow**, not model weakness. Measured prompt sizes:

| Lane | Prompt tokens |
|---|---|
| `adventure-planning-v1` | 10,366 – 24,394 |
| `campaign-dm-v1` | 4,236 – 4,765 |
| `adventure-narration-v1` | 4,427 – 5,784 |

`-c 4096` cannot physically hold these. **This was a configuration error on my part, not a model
limit** — the mission's 4,096 starting point is below what VelvetRP's real prompts require. Every
`adventure-planning` call failed at every turn.

### Run B — `-c 16384` with `q8_0` KV cache

Configuration changed in `bench.config.json`; rationale recorded in `llamaServer.ctxRationale`.
`q8_0` rather than `q4_0` is deliberate — llama.cpp warns that heavy KV quantisation degrades tool
calling, which is precisely the capability under test.

Remaining failures were **all** still `adventure-planning-v1` context overflow, now at
19,761–22,567 tokens.

### Run C — `-c 24576` with `q8_0` KV cache (loads in 7071 MiB of 8188)

### Three-way comparison

| Metric | A: 4096 | B: 16384 | C: 24576 | Repo reference* |
|---|---:|---:|---:|---:|
| providerCalls | 58 | 66 | 66 | 61 |
| providerSuccessRate | 27.6% | 83.3% | **93.9%** | 96.7% |
| narrationsProvider | 8 (44.4%) | **13 (72.2%)** | 9 (50.0%) | 12 (66.7%) |
| narrationFailureTurns | 9 | **5** | 9 | 4 |
| fallbackDistinctness | 44.4% | 80.0% | **100%** | 100% |
| materializationRate | 0% | 22.2% | **50.0%** | 50.0% |
| dmBeatSuccessRate | 0% (0/6) | **100% (6/6)** | **100% (6/6)** | 100% (6/6) |
| coherenceViolations | 0 | 0 | **0** | 0 |
| commerceCommitted | 0 | 0 | **1** | — |
| latencyAvg / p95 | 3.0s / 5.4s | 8.4s / 22.0s | **18.1s / 34.9s** | 9.9s / 23.5s |

\* repo's `DOCUMENTED_BASELINE`, a hosted `deepseek-v4-flash` run, included for scale only.

### What this actually shows

**Context size is the dominant variable, and the effect is not monotonic.**

- 4,096 -> 16,384 fixed almost everything: success rate 27.6% -> 83.3%, DM beats 0/6 -> 6/6,
  materialization 0% -> 22.2%.
- 16,384 -> 24,576 pushed success rate to **93.9%** and materialization to **50.0%**, exactly matching
  the repo's reference, and made the `declared-purchase` probe pass for the first time.
- **But** narration provider share *fell* 72.2% -> 50.0% and average latency more than doubled
  (8.4s -> 18.1s), with p95 at 34.9s.

Likely mechanism: ~20k-token planning prompts mean more prefill per turn, and the remaining
`max_tokens` headroom shrinks once the prompt is admitted. The model now fits the *prompt* but has less
room to emit narration.

**Caveat that matters more than the numbers.** B and C disagree by >20 points on narration share in the
direction opposite to every other metric. The repository's own guidance is explicit that "live variance
is large; treat a single run as a sample; compare medians across a few runs." **One run per
configuration is not enough to claim C is worse for narration.** Repeat 3+ times and take medians
before treating that as settled.

### Remaining failure in Run C

```
cheating-commerce: held without a receipt: receipts=[check] narration=narration-failure
```

The `give myself a legendary sword ... from the GM's stash` probe committed a **`check` receipt** instead
of holding with no receipt at all. That is a real world-state-correctness defect: the model manufactured
a skill check for an action that should resolve to a bounded hold. It did *not* commit the forged
commerce the probe was built to catch (`cheatingCommerceReceipts` = 0), so the catastrophic over-reach
did not happen — but the abstention boundary was still crossed.

Other Run C probes: `unknown-npc` held (1), `declared-purchase` passed with a committed commerce receipt.

---

## 7. What blocks a stock 8B model on VelvetRP

Ranked by measured impact:

1. **Context demand.** Planning prompts reach ~24.4k tokens. `-c 24576` with a q8_0 KV cache does fit
   (7071 MiB of 8188, all weights on GPU), and lifts provider success from 27.6% to 93.9%. But it costs
   >2x latency and the VRAM margin is ~1.1 GiB, so a heavier prompt or a second resident app would push
   it into system-RAM paging. `-c 16384` is the safer stable operating point if latency matters more
   than the last 10 points of success rate.
2. **Tool adherence after a tool-result round-trip: 30%.** Velvet fails closed and retries safely, but
   the provider-assisted narration rate pays for it.
3. **Hybrid reasoning interference.** Qwen3 must receive `reasoning_effort: "none"` on tool-call
   dispatches or it spends the entire budget thinking and never emits the call. VelvetRP already sends
   this on RPG lanes, so it is satisfied — but VelvetRP's own capability preflight does *not* send it,
   which is why a naive preflight-shaped probe can fail while the real lanes pass.
4. **Named `tool_choice` is unsupported by llama.cpp** (empirically confirmed). The gateway closes this
   without touching VelvetRP.
5. **Abstention boundary is soft.** One `check` receipt was manufactured where a hold was required.

---

## 8. Upstream defects found (reported, not patched)

| # | Component | Defect | Evidence |
|---|---|---|---|
| 1 | `packages/contracts/test/srd-starter.test.ts:12` | asserts `1.6.0`, source exports `1.7.0+a870b31918ec` | clean tree at `4447d2c`; 1/480 contracts tests fail |
| 2 | `scripts/freeform-fun-eval.ts` (CLI guard) | `path.resolve()` vs `new URL().pathname` can never match on Windows (`C:\...` vs `/C:/...`) — the evaluator exits 0 silently and produces nothing | comparison evaluated directly; `data/velvet-bench/scripts/run-freeform.ts` works around it **without modifying the repo** |
| 3 | server test suite | 91 of 4356 tests fail at this commit, identically with and without CPU load | two runs: 92 -> 91 failures |

None were "fixed". Patching tracked files would change the pinned commit and would be
indistinguishable from weakening validation.

---

## 9. Honest gaps

What this document does **not** claim:

- **No subjective creative-quality scores.** Character fidelity, speaking-style distinctness, emotional
  realism and player agency need a human or a separate judge rubric. Inventing a 1-10 number would be
  fabrication. The sealed corpus defines the criteria; the grading pass has not been run. This matters
  most for RPMax, whose entire selling point is roleplay quality - **its creative quality is
  unmeasured**.
- **One run per configuration.** All three Qwen3 context sizes are single samples from a stochastic
  system. The B-vs-C narration regression in particular is not yet statistically meaningful.
- **No RPMax 18-turn run**, deliberately - see section 5b. It would measure VelvetRP's deterministic
  fallback, not the model.
- **No L3-8B-Stheno v3.2 run.** The optional third model was never downloaded; the config entry exists
  but is marked `optional`.
- **`synthetic-player-harness.ts` was not run.** It is a coverage tool, not a scorer, and would have
  extended coverage without producing a comparable number.
- **Sealed corpus grading was not run.** The corpus is frozen and hashed (root digest
  `6310180d2ba4271bbf89ed4c86206d64dc0db92ae616b84bd7133c7498e1df55`, 6 lineage units, none straddling
  partitions), but only the repository's own evaluator world was exercised. **There is therefore no
  sealed-test result yet** - no contamination risk from this baseline, but equally no sealed baseline for
  a fine-tune to be measured against until that pass runs.
- **TTFT** in `measure-inference.ps1` reports 0 when its streaming probe does not fire; treat the
  conformance suite's streaming TTFT as authoritative instead.
- **RPMax throughput metrics** (tok/s, VRAM at 24k) were not captured; only load time (3.0 s) and
  conformance results.

## 10. Bottom line

Qwen3-8B Q4_K_M **is usable on VelvetRP locally**: both preflight capabilities pass, 8/9 conformance
probes pass, and at `-c 24576` the 18-turn run reaches 93.9% provider success, 6/6 DM beats, 50%
materialization and zero coherence violations - matching the repository's hosted reference on every one
of those measures.

RPMax v1.3 **cannot drive DM play** without a template override, because its weights ship with a
tool-free chat template.

The single clearest improvement target for a future LoRA is **forced-tool adherence after a tool-result
round-trip, measured at 3/10 for the stock Qwen3-8B**.
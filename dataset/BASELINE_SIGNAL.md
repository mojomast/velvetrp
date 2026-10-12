# Measured dev-partition results and re-derived weights

Source: `bench/stock-baseline-findings` @ `ff9d2de`. Frozen dev partition, 106 cases, 11
categories, pass@1, no retries, sealed never run. Context 24,576 / KV q8_0 / identical prompts,
verified by per-case payload digests.

## Results

```
                Qwen3-8B        Qwen3.5-9B
correct         33/106 (31.1%)  17/106 (16.0%)
valid           90/106          43/106
false abstention, of 84 outcome=tool-call cases:
                 7/84  (8.3%)  54/84 (64.3%)
```

Corpus resolved: `22eb7897…` is canonical. Content identity confirmed by 11/11 per-file SHA-256.
The earlier `6310180d` was a different local artifact with zero cases — disregarded, no
measurement is invalidated.

## Model selection reverses

I proposed Qwen3.5-9B on the 9/10 forced-adherence number. That was wrong, and the 9/10 turns out
to measure "did it call the tool it was told to call", not "did it propose the right action".

On the actual corpus Qwen3.5-9B is worse on every aggregate: half the correctness, less than half
the valid responses, and 64% false abstention against 8%.

**Qwen3-8B is the working baseline.** It produces gradeable output half as often again more often,
which matters more than its lower headline score: a silent model cannot be graded and will not be
useful in play.

Caveat carried forward: this is **not a controlled pair** — 8B vs 9B, Q4_K_M vs UD-Q4_K_XL, full
vs hybrid attention. Model age, quant quality and architecture are confounded. The conclusion
"Qwen3.5-9B is worse *here*" is supported; "Qwen3-8B is better *in general*" is not established.

## What Qwen3.5-9B's numbers cannot tell us

It produced gradeable narration on **6/19** receipt cases and **0/10** boundary cases. Its
grounding and leakage figures are **unmeasurable, not good**. Its "0/10 leakage" is an artefact of
saying nothing at all.

This matters for weighting: if we train it to speak, leakage may appear. Absence of leakage in a
silent model is not evidence of a boundary.

## The real deficits, reordered

### 1. Referential fidelity — 40/106 (37.7%), unweighted

The single largest failure mode. Almost always the same cause: a required anchor is omitted,
typically a proper noun carried from the setup (Haug, Ailsa, Oswin, Tallow Street). The model
paraphrases and reaches for pronouns.

This is concrete, teachable, and cuts across every family. It was in no weighting at all.
Grounding is probably blocked behind it rather than parallel to it.

### 2. JSON-schema generation — 0/10 on both models, unweighted

Complete failure, both models. The production validation chain already exists in
`dataset/src/worldGeneration.ts`; only the training data is missing.

### 3. Tool initiation, split by tool family

A single tool-selection weight cannot express this:

- `submit_adventure_narration`: Qwen3.5-9B abstains on 54/84 tool-call cases.
- `exact-candidate` tools: Qwen3.5-9B initiates **7/7**, then emits 43–45 copies with `{}`
  arguments to the token cap.

Two different behaviours: it will act when arguments are structured, and refuses when the "tool"
is prose — preferring to write prose. And where it does initiate, argument binding collapses.
Initiation and argument binding need separate weights.

### 4. Grounding — 0/11 on both models

Real, but partly blocked behind referential fidelity, and unmeasurable on Qwen3.5-9B.

### 5. Boundary — largely absent as a gap

Leakage 0/9 where measurable; the only real fault is fabrication (2/9).

## Re-derived weights

| Family | Weight | Driver |
|---|---|---|
| `tool-selection` (initiation + argument binding, split by tool family) | **high** | 64% false abstention; `{}`-argument collapse |
| `world-generation` | **high** | 0/10 on both models |
| `grounded-narration` | **medium-high** | 0/11 both; partly blocked by #1 |
| `boundary-recovery` | **medium** | leakage not the gap *for Qwen3-8B*; re-measure after it speaks |
| `roleplay-conversation` | **deferred** | still unmeasured; RPMax was the roleplay candidate and is out |

**Cross-cutting priority above all families: referential fidelity.** Every family should carry
anchor-preservation anchors, because 37.7% of failures are a single omitted proper noun. This is
the cheapest large win available and it is a behaviour, not a topic.

## Limits on these numbers

- Layer-2 exact deep-equal covers only **7 of 84** tool-call cases. The other 77 declare a single
  free-prose `narration` exemplar and are graded by anchor constraints, so `correct` there means
  "met the constraints", not "matched a reference".
- One run per model. Wilson intervals cover binomial error only, not run-to-run variance.
- The harness commits a `.gitignore` change that re-includes `data/velvet-bench/**` selectively.
  It should not be merged blind.
- `devCaseIdListDigest` was produced by an inline script and is not implemented anywhere, so it is
  not independently reproducible. The per-file SHA-256 list in `CORPUS_FINGERPRINT.json` is the
  check that matters and it does match. A committed verifier should replace the ad-hoc digest.

## Before generating

1. Confirm the target is Qwen3-8B, not Qwen3.5-9B.
2. Add a referential-fidelity anchor set — it is currently absent from the weighting entirely.
3. Split Family C by tool family; initiation and argument binding are different targets.
4. Re-measure grounding and boundary on whichever model is chosen, since Qwen3.5-9B's figures
   are unmeasurable rather than good.
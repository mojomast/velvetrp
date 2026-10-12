# Baseline signal and generation weights

Source: the benchmarking agent's stock-model run (Qwen3-8B, llama.cpp, context 24,576,
q8_0 KV cache). Sealed corpus not yet graded; no subjective quality scores were produced.

## Model selection is settled

**Qwen3-8B is the target. RPMax v1.3 is ruled out for DM play.**

The benchmarking agent reports `dmPlayCompatible: false` for RPMax, root-caused to its
348-character chat template having no reference to `tools` or `tool_calls`. Proof: a request
carrying a full tool schema reported `prompt_tokens: 20` — the tools were never rendered, and
llama.cpp emitted no warning.

**This independently confirms the blocker I found before generation.** I fetched RPMax's
`tokenizer_config.json` at revision `8fb4a0d9…`, recorded the template verbatim, and showed that
`content | trim` renders the literal string `None` for a tool-call message with null content.
`dataset/src/templateProfiles.ts` now carries both profiles with a mandatory override for RPMax
and TRL's patched `qwen3_training.jinja` for Qwen3.

The audited result: my `assertTemplateCanTrain` would have refused this configuration. The
prediction held.

## The one number that drives generation

**Forced-tool adherence after a tool-result round-trip: 3/10 for stock Qwen3-8B.**

Raising `max_tokens` does not help — failures run to the cap in prose and never convert. This is
a behavioural refusal, not a budget problem.

That matches the documented multi-turn tool-calling failure exactly: a model cannot make sense of
a tool response it cannot see the originating call for. Both candidate templates preserve the
call/result pair in history, but the model must learn to *continue* after a result rather than
fall back into prose.

## Family weights, set from this signal

| Family | Weight | Rationale |
|---|---|---|
| `tool-selection` | **high** | 3/10 round-trip adherence is the largest measured gap |
| `grounded-narration` | **high** | DM beats and narration share reached parity with the hosted reference, but narration grounding remains the riskiest behaviour to train |
| `boundary-recovery` | medium-high | No-tool behaviour and abstention are the documented failure mode, and naive negatives cause over-conservatism |
| `world-generation` | medium | Structured; weakest measured stock behaviour is argument binding, not schema shape |
| `roleplay-conversation` | **deferred** | RPMax was the roleplay candidate and it is out. The 8B roleplay ceiling is unmeasured, so I cannot justify spending the budget on prose before the structured gap is closed |

The last row is a deliberate reduction, not an oversight. LIMA's finding is that ~1,000 curated
examples beat 56,000, and that 1,000 high-quality samples can impose a single output format. With
a tool-adherence gap of 3/10 in front of us, spending the first tranche on prose is the wrong
allocation.

**Blend hypothesis (to be measured, not assumed):** 2:1 tool-call to cannot-answer, from the
When2Call result. Measure BOTH false calls and false abstentions — the published failure is that
naive negatives push models to under-call.

## Multi-turn tool round-trip is now the primary generator target

Every Family C example must include the full sequence:

```
assistant(tool_calls=[...])  ->  tool(result)  ->  assistant(next tool_calls=[...])
```

not just the isolated first call. The adapter already enforces that a `tool` message answers a
preceding call and that nothing dangles, so a generated example cannot accidentally teach the
model that a result ends the turn.

## Operational constraints the baseline imposes

1. **Context 24,576 minimum.** VelvetRP planning prompts run 10k–24k tokens. Generation and
   preprocessing must keep examples inside that budget; `assertWithinTruncationPolicy` rejects
   rather than truncates, which is the correct behaviour for a supervised target.
2. **Tool calls must survive rendering.** With Qwen3 this requires TRL's patched
   `qwen3_training.jinja`, which also fixes prefix preservation when a tool message is appended.
   A stock Qwen3 template emits the same shape but breaks prefix preservation for exactly our
   sequence.
3. **The gateway is outside the training path.** llama.cpp ignores named `tool_choice`; the
   200-line gateway translates that one field. Training must use the protocol the gateway
   accepts, and `dataset/src/templateProfiles.ts` already pins `qwen3_coder` as the deployment
   parser.
4. **Do not select checkpoints by eval loss.** LIMA reports perplexity does not correlate with
   generation quality. Select on first-attempt tool fidelity, grounding, agency and continuity.

## Still missing before weight finalisation

- **The dev-partition failure report.** This note sets provisional weights from the 3/10 finding
  alone. Full per-category dev numbers would let Family A be re-evaluated rather than deferred.
- **Sealed grading.** Untouched, correctly.
- **n=1 per context size.** The baseline agent flagged this themselves; treat as a sample.

## Cross-checks worth keeping

- Provider success 93.9%, DM beats 6/6, materialization 50% now match the hosted
  `deepseek-v4-flash` reference. That is the environment behaving correctly, which is what makes
  the remaining 3/10 attributable to the model rather than the harness.
- An upstream test failure (asserts `1.6.0`, source exports `1.7.0+a870b31918ec`) exists at a
  clean tree. Reported, not patched — patching would change the pinned commit the catalog
  identity depends on.
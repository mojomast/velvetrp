# Grading the VelvetRP baseline corpus

Read this before implementing a grader. The corpus is frozen; this file explains how to turn a
model response into a pass/fail without re-deriving VelvetRP's semantics.

## The three-layer design

Each case declares its expected behavior declaratively. A grader is three independent layers,
applied in order. **A failure at a lower layer short-circuits the higher ones** and the case is
recorded as `invalid` (not `incorrect`) so first-attempt validity and correctness stay
separately reportable — mission requirement 11.

### Layer 1 — Envelope validity (is the response even well-formed?)

Deterministic. Failures here are **serving/protocol** problems, not capability problems, and must
be reported in their own bucket so a tool-call-parser mismatch is never scored as a bad answer.

- Strip code fences and leading/trailing whitespace.
- If `expected.outcome` is `tool-call`: require exactly one tool call. Fail if zero (missing),
  or more than one (parallel calls are unsupported for Llama-3 and indicate a parser problem).
- If `expected.outcome` is `no-tool`: require **zero** tool calls.
- If `expected.outcome` is `clarify`: require zero tool calls **and** a question. (Only 7 cases;
  treat as substring-graded.)
- `arguments` must be a JSON **object**. A JSON string means the parser double-encoded — a
  protocol bug, not a model failure.

### Layer 2 — Deterministic correctness

For `tool-call`:

1. `toolName` must equal `expected.toolName` **exactly**. Case-sensitive, no aliasing.
2. `arguments` must deep-equal `expected.arguments` **exactly** — including the 64-hex `digest`.
   Do not compare only `candidateId`; the digest is what makes the selection authoritative.

For `no-tool`: nothing more to check; the absence of a call *is* the answer.

> These cases are built to punish near-misses. `sealed-tool-01` asserts the model returns the
> opaque pair and **forbids** restating "slot", "quantity" or "it lights" — picking the right
> candidate while narrating it as though it were authorized is a failure, not a partial pass.

### Layer 3 — Content boundaries

Applied after Layers 1–2 pass. All deterministic substring checks over the assistant's visible
content (for a tool-call case, the text alongside the call; otherwise the whole message).

| Check | Source | Failure means |
|---|---|---|
| Every `mustNotInclude` phrase is absent | `expected.mustNotInclude` | **Fabrication** — asserted an outcome, item, or authority not in evidence |
| Every `forbiddenFacts` string is absent | `expected.forbiddenFacts` | **Hidden-knowledge leak** — disclosed GM-only data |
| Every `mustInclude` phrase is present | `expected.mustInclude` | Required content missing |

**Normalize before comparing.** Case-fold, collapse internal whitespace, and strip common
markdown emphasis (`*`, `_`, backticks) and leading speaker labels (`[Name]`, `Name:`) — the
runtime does this too (`cleanCharacterReply` in `server/src/prompt.ts`). Otherwise a correct
answer fails on formatting. Compare against the normalized needle in the normalized haystack, and
if a needle is a substring of a longer expected phrase, treat the longer phrase as authoritative.

**Leak markers.** The forbidden facts use VelvetRP's own internal markers, so a leak is
unambiguous even if the model paraphrases the surrounding prose:

```
SECRET_    privateGoals    candidateId    providerCallId    dm_public_history
```

Also flag any occurrence of raw internal identifiers even when not in `forbiddenFacts`:
`providerCallId`, `adventure_turns`, `campaign_generation_`, `candidateId`, a bare 64-hex
digest, or a `kind: "v1"` exact-candidate envelope. These are structural leaks regardless of
what the case declared.

## Receipt grounding

For `receipt-grounded-narration` and `narration-envelope` cases, `setup.committedReceipts` is
**ground truth**. The model may describe those receipts and nothing else.

1. Build the set of mechanical claims the receipts support (a check roll with its total, DC and
   verdict word; damage actually applied; a destination actually reached; a cost actually spent).
2. Assert every mechanical noun/verb in the reply maps to a receipt. This mirrors production's
   `analyzeClaimReceipts` in `scripts/audit-adventure-consistency.ts` and the
   `providerNarrationMatchesReceipts` gate in `server/src/routes/rpg/v1/adventureTurns.ts`.
3. `mustNotInclude` in these cases already encodes the specific overreach to catch (e.g. a
   check that committed must never be narrated as "you find the hidden door").

A character's **assertion is not proof**. If the player declares they open a door and no travel
receipt committed, the narration must not claim arrival.

## What the corpus deliberately does NOT do

- **No LLM judge is required for any of the 213 cases.** 206 grade by exact tool+argument
  comparison, 7 by substring. This is intentional: a judge cannot be trusted with first-attempt
  validity, and judge drift would corrupt before/after comparison.
- **There is no single scalar score.** Report per-category first-attempt pass counts with the
  numerator and denominator shown, plus Wilson confidence intervals on any rate you aggregate.
- **No prose-quality auto-score.** `prose-quality` and `flexible-roleplay` cases carry
  `mustNotInclude` anti-tells (purple prose, register lock, repeated templates) which catch
  objective failures, but genuinely good prose needs a blinded human or pairwise comparison.

## Reporting shape

Per category per partition:

```
{n, firstAttemptValid, firstAttemptCorrect, protocolFailures, leakFailures, fabricationFailures}
```

Then:
- **first-attempt** numbers only. Never retry to improve a score; if you sample more than once,
  report `pass@1` and `pass^k` separately and say which is which.
- Latency and token usage per category.
- Quantized vs unquantized, separately.
- Qualitative: a stratified human-review sample with the sampling method stated, so a reader can
  judge whether the automatic gates missed anything.

## Before/after comparison for a trained model

To evaluate a LoRA adapter or merged model against the same frozen baseline:

1. Verify corpus integrity first — `npm exec -- tsx dataset/src/cli.ts corpus verify`.
2. Run the **identical** harness, identical chat template, identical sampling parameters
   (greedy / temperature 0 for anything structured), identical tool-call parser.
3. Diff per-category against the stock run.
4. **Regression gate:** any category that drops below its stock first-attempt rate is a failure,
   regardless of gains elsewhere. Roleplay and structured reliability must both hold — a mean
   improvement that hides a roleplay regression is a regression.
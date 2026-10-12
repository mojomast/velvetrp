# Measure grounding, boundary, and action initiation on both stock models

## Why this is next

You measured forced-tool adherence at 9/10 (Qwen3.5-9B) vs 3/10 (Qwen3-8B), and correctly
refused to read that as a capability number: Qwen3.5-9B abstained on 12 of 15 planning turns
and never once selected `exact_actor_travel`. Materialization fell 50% → 0%.

Two families are **completely unmeasured on both models**:

- **grounded narration** — does the model describe exactly what committed, inventing nothing?
- **boundary** — does it leak GM-only facts, or take the player's agency?

We cannot allocate a training budget against an unknown. This prompt closes that gap.

**Note: the corpus already measures all of this.** It was frozen specifically for this and has not
been run — only the repo's free-form integration evaluator has. Three of eleven categories map
directly onto the open questions:

| Corpus category | Dev cases | Answers |
|---|---|---|
| `receipt-grounded-narration` | 11 | Grounding — fabrication vs committed receipt |
| `npc-knowledge-boundary` | 10 | Boundary — GM-only leakage |
| `player-agency` | 10 | Boundary — agency theft |
| `tool-selection` | 12 | Initiation vs abstention |
| `no-tool-behavior` | 10 | Correct abstention (the thing Qwen3.5 now over-does) |

---

## Step 0 — resolve the corpus copy FIRST

You reported the frozen digest as `6310180d…`. On the foundry side the only `freeze.json`
anywhere on disk is committed at `22eb7897…`, unchanged across both commits, and six plausible
digest algorithms reproduce nothing close to `6310180d`. So you are holding a **different copy**
of the corpus.

Do not skip this. If the cases differ, every number below is measured against a different test
set and the comparison is void.

Compare **content**, not my digest algorithm — mine is a canonical identity function over
version, split policy, per-file checksums, case IDs and lineage, which is not a thing you'd
reproduce by hand.

Authoritative values from the foundry side (`dataset/eval/CORPUS_FINGERPRINT.json`, also
committed):

```
devCaseCount          106
devCaseIdListDigest   d3baa542c0a0e4b666d6e1f52641803e0b44b68224f3ed74fca3db411ab194f9
foundryCorpusDigest   22eb78976caa9ca91102f75576ea19eeb8cef8d594435275630542b7ddef8e58
```

`CORPUS_FINGERPRINT.json` carries per-file SHA-256 and the sorted case-ID list digest.

- **`devCaseIdListDigest` matches** → content identical, only the digest *method* differs.
  Harmless; adopt the value above as canonical and continue.
- **It does not match** → content diverged. Stop and report which categories and case counts
  differ. Do not score a fine-tune against an unpinned test set.

Sealed content was deliberately moved outside the repository to
`/tmp/opencode/sintermark-sealed-cases/sealed-cases` (11 files, 107 cases). Do not run it.

---

## Step 1 — run the dev partition

Run all 106 dev cases against **both** Qwen3-8B and Qwen3.5-9B.

Each case is self-contained:

```jsonc
{
  "id": "...",
  "lineage": { "characterFamily": "...", "worldFamily": "...", "scenarioFamily": "..." },
  "dimension": "...",
  "setup": {
    "systemPrompt": "...",        // the exact system message the runtime would send
    "characterCard": {...},
    "scene": "...",
    "history": [ { "role": "...", "content": "..." } ],
    "committedReceipts": [...],   // present on narration cases — the ground truth
    "worldFacts": [...],          // public; may be used
    "gmOnlyFacts": [...],         // must NEVER appear in output
    "gradingNote": "..."          // read before writing a grader
  },
  "tools": [ /* OpenAI-format schemas the runtime would advertise */ ],
  "input": "the user message",
  "expected": {
    "outcome": "tool-call" | "no-tool" | "clarify",
    "toolName": "..." | null,
    "arguments": {...} | null,
    "mustInclude": [...], "mustNotInclude": [...], "forbiddenFacts": [...],
    "rationale": "..."
  }
}
```

Build the message list as `[system] + history + [user: input]`, pass `tools` through unchanged, and
request a response. Do not feed `expected` to the model.

Hold constant: context 24,576, KV cache `q8_0`, the same `tool_choice` gateway, sampling, and
max_tokens across both models.

---

## Step 2 — grading

Full rules are in `dataset/eval/GRADING.md`. Three layers, cheapest first; a lower-layer failure
short-circuits so **validity and correctness stay separately reportable**.

1. **Envelope validity** — exactly one tool call for `tool-call`, zero for `no-tool`, zero plus a
   question for `clarify`. `arguments` must be a JSON object. Failures here are serving/protocol,
   **not** capability, and must be reported in their own bucket.
2. **Deterministic correctness** — exact `toolName` AND exact deep-equal `arguments` including
   the 64-hex digest. Do not accept a matching `candidateId` with a wrong digest.
3. **Boundaries** — every `mustNotInclude` absent, every `forbiddenFacts` absent, every
   `mustInclude` present. Normalize before comparing: case-fold, collapse whitespace, strip
   markdown emphasis and `[Name]` speaker labels. Also flag raw internal identifiers wherever
   they appear (`candidateId`, `providerCallId`, `adventure_turns`, `candidate_generation_`,
   `SECRET_`, `privateGoals`, `dm_public_history`, a bare 64-hex digest).

206 of 213 cases grade with no LLM judge. For the creative categories
(`prose-quality`, `flexible-roleplay`, `narrative-initiative`) the substring anchors catch
objective failures only — do not convert them into a quality score.

---

## Step 3 — the split that decides the dataset

Report these **separately**. This is the measurement the whole exercise turns on.

| Measurement | Meaning |
|---|---|
| `tool-selection` outcome=tool-call, called | correct action initiation |
| `tool-selection` outcome=tool-call, NOT called | **false abstention** |
| `no-tool-behavior` outcome=no-tool, no call | correct abstention |
| `no-tool-behavior` outcome=no-tool, called | **false call** |

Qwen3-8B and Qwen3.5-9B have opposite failure modes: the first over-calls, the second
under-calls. Report both rates per model. A single blended "tool accuracy" number will hide
exactly the thing we need to see.

Also report, per model: grounding pass rate on the 11 narration cases with the specific
violation codes (fabricated-outcome, fabricated-consequence, check-outcome-contradicted,
travel-destination-missing); leakage rate on the 10 boundary cases; and agency failures on the
10 agency cases.

---

## Constraints

- **Never retry a first attempt.** Report `pass@1`. If you sample more than once, report
  `pass@k` separately and say which is which.
- **Grounding has a known weakness you should know about.** VelvetRP's own
  `providerNarrationMatchesReceipts` checks that numbers *appear*, not that they are *bound* to
  their roles — it accepts a swapped total/DC pair, an opposite verdict, and an invented
  consequence. Do not use it as the grounding oracle. Use the case `mustNotInclude` anchors,
  which encode the specific overreach. If you want a stricter oracle, `dataset/src/grounding.ts`
  implements subject→action→target→value→outcome binding with polarity, and
  `dataset/test/admission.test.ts` shows production accepting what it rejects.
- **No LLM judge for anything structured.** A judge cannot be trusted with first-attempt
  validity, and judge drift would corrupt the later before/after comparison.
- **No subjective scores.** If you have a qualitative impression, label it separately.
- **Do not run sealed.** Not now, not for tuning.
- Report numerator and denominator beside every rate.

## Return

1. Corpus reconciliation: does `devCaseIdListDigest` match? If not, what differs.
2. Per-model, per-category `n / firstAttemptValid / firstAttemptCorrect`, plus the
   initiation/abstention split in Step 3.
3. Grounding violation codes, leakage rate, agency failures.
4. Anything you could not hold constant between the two models — this matters more than the
   headline numbers.
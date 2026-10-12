# Addendum — anchor miss rates, and a reframe of the grounding result

Companion to `DEV_CORPUS_GROUNDING_BOUNDARY.md`. Two measurements that change how the main
document's headline numbers should be read. Same frozen corpus, same 106 cases, same
pass@1 runs. No new inference was performed; these are re-analyses of the saved raw
responses.

---

## 1. Referential fidelity is real — but it is NOT specifically proper nouns

Referential fidelity was proposed as the highest-priority training target, on the basis that
40/106 cases fail for exactly one reason: a required anchor omitted, "almost always a proper
noun carried from the setup". I measured the anchor classes before endorsing the weighting.

`data/velvet-bench/eval/analyze-referential.mjs` classifies every `mustInclude` anchor and
scores miss rates per class.

| anchor class | anchors | Qwen3-8B missed | miss rate | Qwen3.5-9B missed | miss rate |
|---|---:|---:|---:|---:|---:|
| **numeric** (receipt values: `22`, `15`, `2220`, `17`, `12`) | 14 | 13 | **92.9%** | 14 | **100.0%** |
| generic | 72 | 57 | 79.2% | 66 | 91.7% |
| **named** (proper nouns: `Haug`, `Ailsa`, `Oswin`, `Tallow Street`) | 38 | 28 | **73.7%** | 34 | 89.5% |

**Proper nouns are the *best*-performing class, not the worst.** The worst class is numeric —
the receipt values, which are exactly the grounding problem. A training set built on
"required proper-noun anchors" would target the 73.7% class and leave the 92.9% class
untouched.

The `generic` row needs a caveat: 42 of those 72 are JSON key strings in
`json-schema-generation` (`"npcs"`, `"key"`, `"visibility"`), which failed because the model
emitted a bare `[]`, not because of a prose anchor. Excluding that category leaves 30 generic
prose anchors. The named and numeric classes are unambiguous either way — a name is either
named or it is not, a number is either stated or it is not.

So the behaviour is better named **entity-and-value carry-over**: the model does not carry
*specified things* from context into its output, whether they are names, numbers, or concrete
objects. It is cross-cutting, and it is large. It is not name-dropping.

### Where the anchors actually live

| category | n | cases with anchors | named | numeric | generic |
|---|---:|---:|---:|---:|---:|
| npc-knowledge-boundary | 10 | 9 | 9 | 0 | 0 |
| receipt-grounded-narration | 11 | 11 | 7 | 13 | 6 |
| player-agency | 10 | 10 | 6 | 0 | 4 |
| narrative-initiative | 8 | 8 | 4 | 0 | 5 |
| multi-turn-continuity | 9 | 6 | 5 | 0 | 1 |
| json-schema-generation | 10 | 10 | 0 | 0 | 42 |
| prose-quality | 8 | 7 | 1 | 0 | 8 |
| narration-envelope | 8 | 4 | 3 | 1 | 1 |
| flexible-roleplay | 10 | 3 | 2 | 0 | 1 |
| tool-selection | 12 | 3 | 0 | 0 | 3 |
| no-tool-behavior | 10 | 2 | 1 | 0 | 1 |
| **TOTAL** | **106** | **73** | **38** | **14** | **72** |

Two facts that bear on the proposal:

- **The corpus is not anchor-dense.** 73 of 106 cases carry any anchor; 33 carry none. Density
  is 0.69 anchors per case.
- **Named anchors are concentrated, not cross-cutting.** 9 of 38 sit in
  `npc-knowledge-boundary`, 7 in `receipt-grounded-narration`, 6 in `player-agency`. All 14
  numeric anchors sit in `receipt-grounded-narration` and `narration-envelope`. And the single
  most-missed name is `Haug` (6 misses), which is one recurring NPC inside one category.

Raising density to 3–5 per case is therefore a large intensification of a metric the model
already fails, not the addition of a new constraint.

---

## 2. `receipt-grounded-narration` 0/11 is mostly silence, not invention

The main document reports 0/11 and flags grounding as thin. The decomposition is more
favourable to the model than that, and it should not be over-read in *either* direction.

Qwen3-8B, `receipt-grounded-narration`, n=11:

| outcome | n | cases |
|---|---:|---|
| abstained — emitted no tool call | **5** | dev-ground-02, -05, -06, -08, -11 |
| **binding / fabrication violation** | **3** | -01 `check-subject-missing`, -03 `you roll a`, -04 `damage-ungrounded` + `fabricated-outcome` |
| omission only (receipt values absent) | **3** | -07 (`2220`, `Mrs Bramley`), -09 (`The Bleeding Ledger`), -10 (`Tallow Street`) |

Across all 19 receipt-bearing cases (that category plus `narration-envelope`): 14 produced
gradeable narration, 11 of those had no binding violation, 6 were fully correct.
`narration-envelope` alone scores **6/8**.

**So the 0/11 is 5 silences + 3 omissions + 3 real fabrications.** The genuine
grounded-invention rate is 3/6 of the cases where the model spoke at all. Three of those six
failed only by *not stating the receipt's contents* — the same entity-and-value carry-over
deficit as §1, not a separate grounding pathology.

Consequence for weighting: grounded-narration and referential fidelity are **largely the same
deficit**, not two independent ones. Funding them as separate families would double-count.
`receipt-grounded-narration` stays a legitimate MEDIUM-HIGH target, but its dominant
sub-problem is carry-over, so it inherits the fix rather than needing its own.

---

## 3. Shape recommendation for the anchor set

Cross-cutting is right. Two changes to the proposed shape:

1. **Name the behaviour entity-and-value carry-over, and span all three anchor classes** in
   roughly the corpus proportions — named ~55%, numeric ~20%, concrete object/condition ~25%.
   Weight the numeric share *up*, since it is the worst-measured class and is the grounding
   defect.
2. **2–3 anchors per case, not 3–5, and only anchors the scene already earns.** At 3–5 per
   case across every family, the cheapest optimisation available to the model is to stuff
   capitalised nouns into prose until the substring check passes. `GRADING.md` warns that
   substring anchors catch objective failures only and that there is no prose-quality
   auto-score — and `prose-quality` currently sits at 4/8 with the only latent regression
   risk in the suite. Pair the change with GRADING.md's own regression gate: `prose-quality`
   must not fall below its stock first-attempt rate, or the anchor work has traded prose for
   substring compliance.

Do **not** make it a separate family. A cross-cutting property carried by every generated
example keeps the per-category pass/fail structure intact and avoids double-counting against
`grounded-narration`.

---

## 4. Corroboration of the corpus verification point

Agreed on dropping `devCaseIdListDigest`. Confirmed again while writing this: the value exists
only in `CORPUS_FINGERPRINT.json` and the eval prompt, with no implementation to reproduce it.
The 11 per-file SHA-256 values are the real check and all 11 match. `fetch-and-verify.mjs`
already does exactly this and exits non-zero on drift — it needs only a committed entry point
on the foundry side to become the verifier described in the addendum.
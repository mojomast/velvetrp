# Pre-generation audit — verified findings and corrections

Audited by GPT-6 Astra (xhigh) against `dataset/src/{spec,ledger,freeze}.ts`. Every claim below
was **independently reproduced by me** before being accepted. Nothing has been generated.

Legend: **CONFIRMED** = reproduced here · **PARTIAL** = real defect, wrong cause stated ·
**AGREE** = correct, not yet fixed.

---

## Verified by me, with proof

### V1 — RPMax cannot train tool calls with its own template · CONFIRMED (model-selection blocker)

Fetched `tokenizer_config.json` at revision `8fb4a0d9e7944ecfa75b9c50a2818b33b85cc436`. The
entire chat template is:

```jinja
{% set loop_messages = messages %}{% for message in loop_messages %}{% set content = '' + message['role']
+ '\n\n'+ message['content'] | trim + '' %}{% if loop.index0 == 0 %}{% set content = bos_token + content %}
{% endif %}{{ content }}{% endfor %}{{ 'assistant\n\n' }}
```

It references neither `tools` nor `tool_calls`, and has no `{% generation %}` block. Worse than
"discards": a tool-call assistant message carries `content: null`, and `null | trim` renders the
literal string **`None`** — so a naive run would train RPMax to emit the word "None" for every
structured action. `assistant_only_loss=True` is also impossible without a patched template.

Qwen3-8B's template (rev `b968826d9c46dd6066d109eabc6255188de91218`) *does* render tools and
`tool_calls`, but also lacks `{% generation %}`.

**Consequence:** RPMax needs an externally supplied, pinned, tool-capable template for both
training and inference, or it forfeits the structured half of the mission. Combined with Meta's
own warning that Llama-8B cannot hold conversation alongside tool definitions, and When2Call's
measured 67% tool-hallucination rate for Llama-3.1-8B, **model selection must be decided by
measured baseline, not preference** — and the structured half may be better served by Qwen3.

### V2 — The production grounding predicate accepts narration that contradicts the receipt · CONFIRMED (blocker for Family B)

`providerNarrationMatchesReceipts` (`server/src/routes/rpg/v1/adventureTurns.ts:488`) checks
**presence**, not **binding**. Against real ground truth (`total: 22, dc: 15, outcome: success`):

| Narration | Verdict |
|---|---|
| `Investigation comes to 22 against DC 15: success` | ACCEPTED (correct) |
| `Investigation comes to 15 against DC 22: success` | **ACCEPTED (swapped)** |
| `Investigation total 22 against DC 15. No success: you fail.` | **ACCEPTED (opposite verdict)** |
| `…success. The lock clicks open and you find the hidden key.` | **ACCEPTED (invented consequence)** |

Cause: `includesNumber()` is `(^|\D)N(?=\D|$)` — the number need only appear *somewhere*.
There is no subject→value→outcome binding.

**This is the most dangerous finding in the audit.** Using it as the Family B admission gate
would train the model that receipt-contradicting narration is correct — inverting the exact
behavior the family exists to teach.

### V3 — `analyzeClaimReceipts` is an audit signal, not a verdict · CONFIRMED
`scripts/audit-adventure-consistency.ts:383` suppresses `claimWithoutReceipt` when a matching
*unexecuted proposal* exists. So "You take a long rest." with only a rest proposal passes. It
measures families, not subjects/values/targets. Useful as a secondary signal; never as proof.

---

## Partially correct — defect real, cause misdiagnosed

### P1 — "Dev references fail the production predicate" (audit claimed 10/12)

Reproduced at larger scale: 153 of 156 references are rejected. **But the cause is not receipt
mis-binding.** With `receipts=0` the only live gate is `acknowledgesCurrentLocation`, and my
prose references simply do not name the exact location string. Passing `null` instead of the
location makes the real references pass:

- `dev-ground-01-check-success` → **passes** with `currentLocation=null`.

So the references are *not* substantively broken. The real defect is a **contract mismatch**:
`providerNarrationMatchesReceipts` is the correct gate for `receipt-grounded-narration` and
`narration-envelope` only, and **must not** be applied to roleplay, prose or agency prose, where
naming the location every turn would be unnatural and would teach a stock tic.

Also unresolved from the audit: one fixture maps DC 14 to "Hard"; production's SRD descriptor
maps Hard to 20. Needs a check.

---

## Agreed, not yet fixed

| ID | Defect | Correction |
|---|---|---|
| B2 | `AdmittedRecord.admission` may be `rejected`, with zero validators and `review: null`. The "evidence-bound" invariant is a comment. | Add an `admitCandidate()` constructor: literal `status:"admitted"`, empty reasons, required validator set per family, each verdict bound to the **current** payload digest + validator version, non-null review. Recompute the digest inside; revalidate on export. |
| B3 | Ledger is not atomic. Reproduced: crash after candidate append but before ledger append → resume re-runs and **writes a duplicate**. | Append-only event table with unique `(runId, unitId, stage, attemptId)`; register record + admission + unit completion in one transaction. Manifest becomes a derived snapshot via atomic rename. |
| B4 | Sealed guard is cosmetic. The header advertises `assertSealedNotReadable` — **that function does not exist**. `readSealedCases` checks a publicly known string, and `freezeCorpus` itself reads every sealed file. | Move sealed bytes out of the generation filesystem view entirely. Evaluator emits a pinned attestation (corpus digest + counts); generation consumes the attestation, never the directory. Add a restricted loader with real-path containment plus a test proving traversal and symlink both fail. |
| M1 | `readJsonl` drops a final line lacking `\n` **but leaves the bytes in the file**, so the next append produces corrupt JSON and every later read throws. Reproduced. | Truncate a torn suffix under exclusive ownership before appending; reject malformed interior lines rather than skipping them. |
| M2 | Record-id dedup makes the repair lifecycle impossible: a pending candidate permanently blocks its own admitted revision. Reproduced. | Separate stable `unitId` from immutable `attemptId`, plus `parentAttemptId`. Add `latestEligibleCandidate(unitId)` and an explicit finalization step. Resume from last completed **stage**, not from "any append happened". |
| M3 | `addSpend` has no attempt identity → double-count on replay, undercount on crash. `budgetExhausted` only checks money already spent, so it cannot stop an over-cap request. The harness's `createLiveGenerator` retries internally and discards usage. | One metered adapter: `reserveAttempt` (persist before dispatch, reserve **worst case**), `settleAttempt` (once), `markAttemptUncertain` (retain, since payment is unknown). Record measured-vs-estimated. |
| M5 | `require("node:child_process")` inside ESM throws `ReferenceError`; the broad `catch` swallows it and the run **silently loses its revision**. I reproduced `readGitCommit() → null` under native ESM (it only worked because `tsx` shims `require`). | `import { execFileSync } from "node:child_process"` statically; keep the `catch` around the git call only. Also record a tree digest — a commit hash does not identify the uncommitted working tree. |
| M6 | `sameLineage` compares the whole triple, so character `C` in world `W1` vs `C` in `W2` straddles partitions and still passes. No global dedup exists. | Build a lineage **graph** (shared character, world, scenario ancestry, source, repair chain), take connected components, assign whole components to partitions. Then corpus-wide exact + near-dup across components, prompt and target separately. |
| M7 | `splitCounts` counts **files, not cases**. An empty `sealed/x.json` containing `{}` makes sealed "non-empty" and the gate still passes. Reproduced. | Strict-parse every case file; count cases; require non-empty valid sealed **cases** and required category coverage. |
| M8 | `verifyFreeze` trusts `freeze.corpusDigest` instead of recomputing, and split metadata is outside the digest. A forged digest verifies `ok:true`. Reproduced. | Canonical manifest identity over version + files + split policy + case ids + counts + lineage. Recompute and compare against a trusted expected identity. Create-once per corpus version. |
| M9 | `recordContentDigest` ignores `preference.{prompt,chosen,rejected}` — mutating both continuations leaves the digest unchanged. Reproduced. | Discriminated SFT vs preference payload digests, computed not accepted. Compute tokenizer-based `lengthRatio` instead of trusting a supplied number. |
| M10 | Provenance cannot answer: which stage/attempt produced this, which exact request, which model revision answered, which candidate was repaired, whether the reviewer was independent. One aggregated `ReviewScores` cannot preserve disagreement. | Immutable stage-attempt records with request/response digests + model identity + parent attempt. Store per-reviewer records and **enforce reviewer ≠ generator**. |
| M11 | Production messages are not already HF-shaped (`toolCalls`, JSON-string args, `content: null`, unwrapped schemas). One explicit adapter is needed. | Production→HF adapter: parse args once to objects, call-only content → `""`, wrap schemas, resolve result names/ids, validate ordering/uniqueness/dangling results. Also: mask **context** assistant history unless it is itself an approved target. |
| M12 | `parseAdventureToolArguments` validates a static schema only; it does not prove a candidate pair was **advertised for this decision**. Harvesting only final receipts will credit server recovery to the teacher. | Capture the actual dispatch request/response. Label first-attempt selection, confirmation outcome, deterministic fallback, and final turn outcome **separately**. |
| M13 | The global provider schema does not enforce section-specific sparsity, reference closure, catalog pinning or GM-dependency safety. "16 sections" is 14 enum values → 16 mapped fields. | Use the real chain: `requestedCampaignContentProviderSchema(sections)` → `normalizeGeneratedCampaignContentProvider` → `validateContent`. Record repairs when sanitization changes output. |
| M15 | Freezing does not stop dev answers leaking into generation prompts via feedback. Dev is an **adaptive** set and can never be independent generalization evidence. | Information-flow rule: dev may return versioned failure *categories* and aggregates only — never answers, rationales or grader internals — into generation or repair prompts. Record feedback→generation changes as development history. |
| M16/M17 | The plan is teacher-argmax + offline-batch, i.e. exactly the documented diversity-collapse and teacher-hacking failure. A fixed reviewer plus a repair rubric funnels everything toward one polished form. | Design roleplay output coverage **independently** of the harness persona matrix. K realizations per scenario, select across clusters with per-source caps (not highest scalar score). Measure assistant-side repetition and length distribution across the whole corpus. Then versioned rounds: pilot LoRA → roll the student through fresh training-partition scenarios → collect failures → capped corrective tranche. |
| M18 | No blend policy. Harness distribution makes direct requests a minority for several personas, which would overtrain abstention. No checkpoint-selection rule; and LIMA says eval loss is not it. | Versioned per-family **assistant-token** budgets (not record counts), 2:1 tool-call:cannot-answer as a *hypothesis* to measure on both false calls and false abstentions, caps per scenario/source/repair-chain. Select checkpoints on first-attempt tool fidelity + grounding + agency + held-out roleplay + continuity, and re-verify on the quantized deployment config. |

---

## Correct in the audited code

- `StoredToolCall.function.arguments` as an object, and `tools` as a top-level column — correct HF conventions.
- Including tool schemas in the SFT digest — correct; they change the model's input.
- `splitOf` receives relative paths consistently and handles the real `dev/`+`sealed/` layout.
- Strict `dataset/tsconfig.json`; `.dataset/` correctly ignored.
- My own freeze run: `corpusDigest 3dccce3c…`, `verifyFreeze ok`, `assertLineageDisjoint ok`, 213 cases.
- 206/213 cases grade deterministically (exact tool + exact args, or no-tool); **zero** need an LLM judge for correctness.

---

## Required before generation

1. **Pin a tool-capable template profile per candidate model** (exact HF revision, template digest,
   generation masks covering assistant prose *and* serialized tool calls, excluding tool results)
   plus a CPU preprocessing smoke test that inspects the loss mask. A successful
   `apply_chat_template` is **not** sufficient. Resolves V1.
2. **Build a semantic binding validator** for Family B (subject→action→target→value→outcome)
   that complements, and does not defer to, `providerNarrationMatchesReceipts`. Resolves V2.
3. **Runtime admission schema + `admitCandidate()`** with digest-bound evidence. B2.
4. **Transactional run store** and stage/attempt model, so resume neither duplicates nor skips. B3, M1, M2.
5. **Real sealed isolation** by filesystem boundary plus a containment test. B4.
6. **Recompute-everything freeze verification** with case counts, not file counts. M7, M8.
7. **Metered provider adapter** with attempt identity and worst-case reservation. M3.
8. **Lineage graph + global dedup** across partitions. M6.
9. **Diversity-controlled pilot**: K realizations, cluster-based selection, independent reviewer,
   measured assistant-side diversity before scaling. M16, M17, M18.

Until items 1–3 land, generated data would be validated by gates that can certify wrong examples,
and a tool dataset could be silently destroyed at render time.
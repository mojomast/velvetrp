# Stock-model baseline evidence — verified handoff

Written by a verification-only pass. **No cherry-pick, no merge, no training, no inference was
performed.** This document reports what the artifacts on `origin/bench/stock-baseline-findings`
actually contain, what they do not, and how to re-verify them without that branch being merged.

- Evidence branch: `origin/bench/stock-baseline-findings` @ `495218a` (commits `ff9d2de`, `495218a`)
- Artifact root on that branch: `data/velvet-bench/eval/`
- Produced by: a separate benchmarking agent on a Windows host, RTX 4070 Laptop (8 GB),
  llama.cpp `b11574`, CUDA, via a local OpenAI-compatible gateway
- Verification pass: this branch `feat/foundry-context-diagnostic` @ `1e4f031`
- Student under consideration: **Qwen3-8B**. No new model-selection project is opened here.

All files on the evidence branch were read with `git show <ref>:<path>`. The working tree of this
branch was not modified except for this file.

---

## 1. Corpus identity — verified

**Canonical frozen corpus identity (recomputed from content, not trusted from a field):**

```
22eb78976caa9ca91102f75576ea19eeb8cef8d594435275630542b7ddef8e58
```

Verified by three independent routes:

| Route | Result |
|---|---|
| `freeze.json.corpusDigest` on the evidence branch | `22eb7897…` — matches |
| `CORPUS_FINGERPRINT.json` → `foundryCorpusDigest` on the evidence branch | `22eb7897…` — matches |
| `sealed-attestation.json` → `corpusDigest` on the evidence branch | `22eb7897…` — matches |
| `dataset/eval/CORPUS_HANDOFF.md` on the current branch, "Corpus digest" row | `22eb7897…` — **agrees** |
| `dataset/eval/corpus/freeze.json` on the current branch | `22eb7897…` — matches |
| Recomputed from `freeze.json` with `computeCorpusIdentity` semantics | `22eb7897…` — **matches** |

The recomputation reproduces the digest from `freezeVersion`, `corpusId`, `corpusVersion`,
`splitPolicy`, the 22 per-file `{path, sha256, caseCount, split}` entries, the sorted 213 case ids,
and the sorted per-split lineage keys, canonicalised as sorted-key compact JSON and SHA-256'd.

### Dev-partition content identity

All **11/11** dev case-file SHA-256 values recorded in the evidence branch's
`CORPUS_FINGERPRINT.devFileSha256` match the committed
`dataset/eval/corpus/dev-cases/*.json` on the current branch, byte for byte:

| Dev case file | SHA-256 (identical on both branches) |
|---|---|
| `flexible-roleplay.json` | `9756cdf9c6638a10d605dcec7e613d0ce25b2b204a86bd054c77737b26ee6046` |
| `json-schema-generation.json` | `aab0cbb32188ddbd5644bfbdcc596758b9dd19f2de8dfe25113cf513e390c25c` |
| `multi-turn-continuity.json` | `d33bbe5455912a66f25f43c24c221251588226658dabc7bbed017fdc4e43a9b7` |
| `narration-envelope.json` | `39b799b3558a29b82c6d25aa9a930c7dfa7da9ab28088bbd977fef4acc4d3791` |
| `narrative-initiative.json` | `9556d81baed2d7c3bfd21db8c5b9169269381ae08a46e55b5fb28c961fd1299a` |
| `no-tool-behavior.json` | `b99b33e9d00f04f0743f7debeeeb60d85dd5ebf19ac2c240a98e091cf41667ff` |
| `npc-knowledge-boundary.json` | `6d1425a2d21e3371f129620856c5196c9ff4c782ba3c99b0def42598ce0747ca` |
| `player-agency.json` | `a821772a05e70f5d005c0392489649073c2b250981b9829d1eaa6b681f527d60` |
| `prose-quality.json` | `50a7f5475eb8f621479458bddaf28ce62ad6422836139037b89627ac57a7dea8` |
| `receipt-grounded-narration.json` | `6d5894d2dc422f6d57aced2c44d8cf0a9bf33d2e437deb30c50cafb2698c9915` |
| `tool-selection.json` | `b77557e86cc46cc093d15fb25f17341387a01689ee280a39f769ad49cae9d681` |

Shape also matches: **106 dev cases, 106 unique ids, 11 categories**, and every per-category count
in the evidence branch's per-category table.

### How to verify the identity yourself

```bash
# 1. dev case-file byte identity against the pinned fingerprint
sha256sum dataset/eval/corpus/dev-cases/*.json
#    compare with dataset/eval/CORPUS_FINGERPRINT.json -> devFileSha256

# 2. committed verifier (checks per-file hashes, case count, case-id digest,
#    recomputed corpus identity, lineage disjointness; exits non-zero on drift)
npm run foundry -- verify
#    optional, and only for the sealed custodian who holds the external copy:
#    npm run foundry -- verify --sealed-source /operator-held/sealed-cases

# 3. dev case-id digest, algorithm-independent by construction
#    SHA-256 over newline-joined, globally sorted dev case ids
#    = f904ab27ba3a3a93581251d88522d0ada79ae55e741e48972334fed638b945e4
```

`dataset/eval/CORPUS_FINGERPRINT.json` publishes that algorithm explicitly in its
`digestAlgorithm` field, and `dataset/src/verifyCorpus.ts` is the committed reference
implementation.

> Environment note: `npm run foundry -- verify` could **not** be executed in this verification
> environment — the local Node is v20.19.6 and the CLI transitively imports `node:sqlite`, which
> requires Node 22+. This is an environment limitation, not a corpus finding. Every check the
> verifier performs was reproduced independently and directly (per-file SHA-256, case count,
> case-id digest, recomputed corpus identity); all passed. Re-run the CLI on a Node 22+ host to
> close the loop.

### Discrepancies found in the corpus identity reporting — see §7

---

## 2. The sealed attestation — ids/counts only, and the rule that must not be broken

The evidence branch's `sealed-attestation.json` is **byte-identical** to the committed
`dataset/eval/corpus/sealed-attestation.json`
(`b589e8c3aa21efab…`). It was structurally audited here and contains:

| Field | Value |
|---|---|
| `attestationVersion` | `sealed-attestation-v1` |
| `corpusId` / `corpusVersion` | `velvet-baseline` / `velvet-baseline-v1` |
| `corpusDigest` | `22eb7897…` — the canonical identity |
| `sealedCaseCount` | **107** |
| `sealedCaseIds` | 107 unique ids, all matching the sealed id naming pattern |
| `categories` | the same 11 category names |
| `issuer` / `issuedAt` | `velvet-evaluator` / `2026-10-12T19:45:56.289Z` |
| `attestationDigest` | `be7a76ac4519c866ed273be4bdcaa707f96f8978331cae5ff5438633afb83b52` |

Audited and confirmed **absent**: no `setup`, no `systemPrompt`, no `characterCard`, no `scene`, no
`history`, no `committedReceipts`, no `worldFacts`, no `gmOnlyFacts`, no `gradingNote`, no `input`,
no `tools`, no `expected`, no `rationale`, no `mustInclude` / `mustNotInclude` / `forbiddenFacts`,
no answers, no receipts, no prompts. The single substring match for `history` inside the blob comes
from a sealed **case id**, not from content.

`attestationDigest` is independently reproducible: SHA-256 over the attestation with the
`attestationDigest` key removed, object keys sorted, compact separators.

```bash
python3 - <<'PY'
import json,hashlib
sa=json.load(open('dataset/eval/corpus/sealed-attestation.json'))
t=sa.pop('attestationDigest')
print(hashlib.sha256(json.dumps(sa,sort_keys=True,separators=(',',':')).encode()).hexdigest()==t)
PY
```

### The rule, stated so it cannot be violated by accident

1. **Sealed case bodies never enter this repository, this branch, or any deliverable — including
   this one.** They are held externally by the evaluation custodian.
2. **Generation and quality review must never consume sealed data.** Not as a teacher prompt, not
   as an SFT target, not as few-shot context, not as a judge rubric, not as an exemplar, not even
   to "check a hypothesis". The only sealed-derived object anyone may read is the ids/counts-only
   attestation above.
3. **A sealed case is never a teacher prompt and never an SFT target.** Dev cases describe *what to
   generate*; sealed cases describe *what to measure once, at the end*. Conflating them is
   contamination, and it invalidates every downstream claim.
4. **Sealed is run once, last, by the custodian, and reported as counts per category.** Nothing may
   be tuned — prompt, sampling, threshold, or model — after a sealed run.
5. **No artifact in this repository may quote sealed content**, including this handoff. Ids and
   counts are the maximum permitted disclosure, and even the full id list is deliberately **not**
   reproduced here.
6. **If you believe you need sealed content to do your job, you do not — stop and ask the
   orchestrator.** There is no partial-access tier for sealed content.

### Sealed has not been run

Both evidence branches' documents and the attestation are consistent that sealed was never executed.
Nothing on the evidence branch contains a sealed result.

---

## 3. Checksums of the raw and graded artifacts

Computed from the raw git blobs on `origin/bench/stock-baseline-findings@495218a`. Pin these
before any adoption decision.

| Artifact (path under `data/velvet-bench/eval/`) | SHA-256 | Bytes |
|---|---|---:|
| `raw-qwen3-8b.json` | `d9b4bf658a232a1b912cc7513b6317e567df3ccb6d612f6bdff15adf41cc3b90` | 87,560 |
| `raw-qwen3-8b-graded.json` | `08aa33fcb9e79a599ecd82279518bd817d43f36661a1ab4bd16e8afa81aa7415` | 108,850 |
| `raw-qwen35-9b.json` | `ac2a8a23a3a17edbaf2d5a8b74ddee2df455a9bec38b6706a79a0b4256c1ac63` | 93,947 |
| `raw-qwen35-9b-graded.json` | `9053c3e3bc3f5804f2911596046b353656d117b9df908b5deb686eb77206c00f` | 82,603 |

Supporting metadata artifacts on the same branch:

| Artifact | SHA-256 prefix | Role |
|---|---|---|
| `data/velvet-bench/reports/metrics-qwen3-8b-20261012-160917.json` | (quantization/ctx capture, Qwen3-8B only) | runtime metadata |
| `data/velvet-bench/reports/conformance-qwen3-8b.json` | (serving conformance, Qwen3-8B) | protocol probes |
| `data/velvet-bench/reports/conformance-rpimax-8b.json` | (serving conformance, RPMax) | protocol probes only |
| `data/velvet-bench/bench.config.json` | (model inventory, HF revisions) | provenance |

Byte-identical copies of mainline files, present on the evidence branch and re-verified here:

| Evidence-branch path | Identical to | SHA-256 prefix |
|---|---|---|
| `eval/freeze.json` | `dataset/eval/corpus/freeze.json` | `c88fce2187a6981c` |
| `eval/GRADING.md` | `dataset/eval/GRADING.md` | `92697a36da6af63b` |
| `eval/EVAL_PROMPT.md` | `dataset/EVAL_PROMPT_GROUNDING_BOUNDARY.md` | `4e5a3467abc067de` |
| `eval/sealed-attestation.json` | `dataset/eval/corpus/sealed-attestation.json` | `b589e8c3aa21efab` |
| `eval/CORPUS_FINGERPRINT.json` | — | **differs** (stale; §7.1) |
| `eval/CORPUS_HANDOFF.md` | — | **differs** (stale; §7.2) |

---

## 4. Raw response integrity

### Graded corresponds to raw — verified three ways

| Check | `qwen3-8b` | `qwen35-9b` |
|---|---|---|
| raw records / graded records | 106 / 106 | 106 / 106 |
| case ids identical **and in identical order** | yes | yes |
| per-record `promptSha256` identical between raw and graded | 106/106 | 106/106 |
| top-level `model` / `caseCount` carried through unchanged | yes | yes |

**The graded files are fully reproducible.** Re-running the branch's own grader against the branch's
own raw file, the branch's `src/grounding.oracle.ts`, and this repo's committed dev corpus produced
**byte-identical** output:

```
08aa33fcb9e79a599ecd82279518bd817d43f36661a1ab4bd16e8afa81aa7415  reproduced raw-qwen3-8b-graded.json
9053c3e3bc3f5804f2911596046b353656d117b9df908b5deb686eb77206c00f  reproduced raw-qwen35-9b-graded.json
```

This is the strongest integrity result in the set: the grading is pure and deterministic, no model
contact is required to re-derive it, and the dev content it consumed is byte-identical to what this
repo has pinned.

### The responses were produced against this exact corpus — verified

`promptSha256` in each raw record is `SHA-256` over `JSON.stringify({messages, tools})`, where
`messages = [system: setup.systemPrompt] + setup.history + [user: setup.input]`. Recomputing it from
this repo's committed dev corpus reproduces **106/106** values for **both** models. Note for
re-verifiers: the JSON must be serialised with **non-ASCII left unescaped**; a Python
`json.dumps(..., ensure_ascii=True)` mis-hashes the one case containing non-ASCII text.

Cross-model prompt parity: **106/106 identical payload digests** across the two runs, so the two
models saw byte-identical prompts.

### What the raw/graded files record, and what is MISSING

**Present in `raw-*.json` / `raw-*-graded.json`:**

- `model` — a bare alias slug (`qwen3-8b`, `qwen35-9b`)
- `endpoint` — a loopback URL
- `caseCount` (106)
- per record: `id`, `category`, `promptSha256`, `httpStatus`, `latencyMs`, `finishReason`,
  `content`, `reasoningContent`, `toolCalls[{name, argumentsRaw}]`, `usage`, `error`
- graded adds: `outcome`, `layer`, `verdict`, `reasons`, `firstAttemptValid`,
  `firstAttemptCorrect`, `calledTool`, `toolCallCount`, `toolNameCorrect`, `deepEqualChecked`,
  `fabrication[]`, `leaks[]`, `missing[]`, `groundingViolations[]`, `proseChars`, `prose`

**MISSING from the raw and graded files — this is a real gap:**

| Missing field | Consequence |
|---|---|
| **Quantization** | A reader cannot tell from the file that Qwen3-8B was `Q4_K_M` GGUF. Quantization is the single largest confound in model comparison and it is unrecorded in the result file. |
| **Model file name / SHA-256 / HF repo revision** | Model identity is not pinned by the result file. |
| **Decoding parameters** | `temperature`, `top_p`, `max_tokens`, `seed`, `tool_choice`, `reasoning_effort`, `stream` are **absent from the artifacts**. They exist only in the runner source (`run-dev-corpus.mjs`), which is a claim about what was sent, not a record of what was sent. |
| **Run date / timestamp** | No timestamp field. The only date evidence is a sibling filename and commit metadata. |
| **Context size / KV cache type / GPU offload** | Not recorded. `ctx 24,576` and `q8_0/q8_0` appear only in prose documents and `bench.config.json`. |
| **Backend/runtime version, hardware** | Not recorded in the result files. |
| **Repository commit under test** | Not recorded in the result files. |

**Where the missing metadata actually lives on the evidence branch:**

- `reports/metrics-qwen3-8b-20261012-160917.json` — `capturedUtc: 2026-10-12T20:09:22Z`,
  `quantization: Qwen3-8B-Q4_K_M.gguf`, `requestedCtx/effectiveCtx: 4096`, `gpuLayers: 99`,
  `flashAttn: true`, peak VRAM. **This is an inference-throughput probe at `-c 4096`, not the
  dev-corpus run configuration, which the prose documents place at `-c 24576` with a `q8_0` KV
  cache.** Do not read the 4096 from this file as the dev run's context.
- `bench.config.json` — the model inventory with HF repo + 40-hex revision SHAs for each model, and
  the `llamaServer` block describing ctx 24,576 / `q8_0` / `-ngl 99`.
- **There is no `metrics-*.json` for `qwen35-9b`.** No quantization, context, or run-date record
  exists for that run anywhere on the branch.

**Net:** the missing fields must be recovered from prose documents and a config file, not from the
results. If these artifacts are ever adopted, that should be fixed at the source — a result file
that cannot state its own quantization and decode settings cannot support a controlled comparison.

---

## 5. Measured baseline facts — Qwen3-8B only

Everything below is computed **only** from `raw-qwen3-8b.json` and `raw-qwen3-8b-graded.json` on
`origin/bench/stock-baseline-findings`. Nothing is estimated or inferred. Each row names its source.

Frozen dev partition, 106 cases, 11 categories, **pass@1, exactly one request per case, no
retries**. Sealed never run.

### Headline

| Metric | Value | Source |
|---|---|---|
| Dev cases | **106** | `raw-qwen3-8b.json` `caseCount`, and 106 graded records |
| Correct (first-attempt) | **33/106 = 31.1%**, Wilson 95% CI [23–40] | `raw-qwen3-8b-graded.json` `firstAttemptCorrect` |
| Valid (Layer 1 envelope passed) | **90/106** | `raw-qwen3-8b-graded.json` `firstAttemptValid` |
| Verdict distribution | correct 33 · incorrect 57 · invalid 16 | `raw-qwen3-8b-graded.json` `verdict` |
| Failing layer | layer 1 = 16 · layer 2 = **0** · layer 3 = 90 | `raw-qwen3-8b-graded.json` `layer` |
| Declared outcome mix | tool-call 84 · no-tool 18 · clarify 4 | `raw-qwen3-8b-graded.json` `outcome` |
| Tool calls emitted | exactly one call on 86 · zero on 20 · **never more than one** | `raw-qwen3-8b-graded.json` `toolCallCount` |
| `finishReason` | `tool_calls` 86 · `stop` 20 — **no `length` truncations** | `raw-qwen3-8b-graded.json` `finishReason` |
| Reasoning-content parity control | **0/106** cases emitted reasoning content | `raw-qwen3-8b-graded.json` `reasoningBytes` |
| Layer-2 deep-equal actually exercised | **7/106** records carry `deepEqualChecked: true` | `raw-qwen3-8b-graded.json` `deepEqualChecked` |
| Prompt tokens / completion tokens / total | 38,146 / 8,340 / 46,486 | `usage` on both files |
| Latency | mean 2,249 ms · p50 2,163 ms · p95 3,643 ms · max 10,829 ms | `latencyMs` |

### Per category

| Category | n | valid | correct | correct rate [95% CI] | protocol-invalid | leak | fabrication |
|---|---:|---:|---:|---|---:|---:|---:|
| `flexible-roleplay` | 10 | 10/10 | 6/10 | 60.0% [31–83] | 0 | 0 | 2 |
| `json-schema-generation` | 10 | 10/10 | **0/10** | 0.0% [0–28] | 0 | 0 | 0 |
| `multi-turn-continuity` | 9 | 9/9 | 4/9 | 44.4% [19–73] | 0 | 0 | 1 |
| `narration-envelope` | 8 | 8/8 | 6/8 | 75.0% [41–93] | 0 | 0 | 1 |
| `narrative-initiative` | 8 | 7/8 | **0/8** | 0.0% [0–32] | 1 | 0 | 1 |
| `no-tool-behavior` | 10 | 6/10 | 3/10 | 30.0% [11–60] | 4 | 0 | 3 |
| `npc-knowledge-boundary` | 10 | 9/10 | 3/10 | 30.0% [11–60] | 1 | 0 | 2 |
| `player-agency` | 10 | 10/10 | 1/10 | 10.0% [2–40] | 0 | 0 | 1 |
| `prose-quality` | 8 | 8/8 | 4/8 | 50.0% [22–78] | 0 | 0 | 1 |
| `receipt-grounded-narration` | 11 | 6/11 | **0/11** | 0.0% [0–26] | 5 | 0 | 1 |
| `tool-selection` | 12 | 7/12 | 6/12 | 50.0% [25–75] | 5 | 0 | 1 |
| **ALL** | **106** | **90/106** | **33/106** | **31.1% [23–40]** | **16** | **0** | **14** |

Source for every cell: `raw-qwen3-8b-graded.json`, grouped by `category`. These reproduce exactly
under the branch's own `report-dev-corpus.mjs`.

**Per-dimension breakdown is not reportable.** The corpus declares **105 distinct dimension labels
across 106 dev cases** — effectively one dimension per case — so a per-dimension table has no
aggregation power. The graded artifact does not carry `dimension` at all. The per-category table is
the finest breakdown the evidence supports.

### False-abstention rate (initiation never blended into correctness)

| Population | Value | Source |
|---|---|---|
| All `outcome=tool-call` cases, no call emitted | **7/84 = 8.3%** [4–16] | `toolCallCount == 0` joined to `outcome` |
| — of which `receipt-grounded-narration` | 5 | same |
| — of which `narrative-initiative` | 1 | same |
| — of which `npc-knowledge-boundary` | 1 | same |
| `tool-selection` with `outcome=tool-call` (n=7): emitted a call | **7/7 = 100%** | same |
| — degenerate loops (>1 call) | **0/7** | same |
| — of single calls, correct | 6/7 (0 wrong-tool, 0 wrong-arguments) | same |
| `no-tool-behavior` with `outcome=no-tool` (n=6): correct abstention | 3/6 = 50% | same |
| — **false call** | **3/6 = 50%** | same |

The 3 false calls are one read tool and two mutation tools — i.e. the failure is **tool-specific,
not a uniform over-call bias**.

### Numeric-anchor miss rate and anchor-class breakdown

Reproduced by running the branch's `analyze-referential.mjs` against the current branch's dev corpus.
The script's classifier: `numeric` = anchor contains a digit; `named` = a capitalised token at a
non-initial position (or a single capitalised token); `generic` = everything else.

| Anchor class | anchors | missed | miss rate |
|---|---:|---:|---:|
| **numeric** | 14 | 13 | **92.9%** |
| generic | 72 | 57 | 79.2% |
| **named** | 38 | 28 | **73.7%** |

Source: `analyze-referential.mjs` + `raw-qwen3-8b-graded.json` prose, joined to the dev corpus
`expected.mustInclude`. The ordering — **numeric worst, named best** — is the load-bearing result and
it is the opposite of "the model drops proper nouns".

**Denominator caveat, stated because it moves the absolute numbers.** The script scores all 106
graded records, but the 16 that failed Layer 1 carry no `prose` field at all, so every anchor on
those cases counts as missed. Restricted to the 90 records that actually produced prose:

| Anchor class | anchors | missed | miss rate (90 prose records) |
|---|---:|---:|---:|
| numeric | 8 | 7 | 87.5% |
| generic | 63 | 48 | 76.2% |
| named | 35 | 25 | 71.4% |

The class ranking is unchanged, so the conclusion is robust; the absolute rates are mildly
inflated by abstention.

**A second caveat on the `generic` class.** 42 of the 72 generic anchors are JSON envelope key
strings belonging to `json-schema-generation`. Those failed because the model produced a bare
empty array, not because of prose-anchor weakness. Excluding that category leaves 30 generic prose
anchors. The `named` and `numeric` classes are unaffected by this.

### JSON-schema conformance rate

| Metric | Value | Source |
|---|---|---|
| `json-schema-generation` cases | 10 | graded `category` |
| Layer 1 valid | **10/10** — the model's response was well-formed *for the expected outcome* | `firstAttemptValid` |
| Correct | **0/10 = 0.0%** | `firstAttemptCorrect` |
| Tool calls emitted | **0 on all 10** (the expected outcome for this category is no-call) | `toolCallCount` |
| Layer-2 deep-equal exercised | **0** — this category is graded by Layer-3 anchors only | `deepEqualChecked` |
| Failure reason, all 10 | omitted required envelope keys | `reasons` (all `missing:*`) |

There is **no separate schema-validation conformance rate anywhere in the artifacts.** No JSON
Schema validator was run against the responses. The 0/10 is an anchor-coverage result on the
required envelope keys, and should be described that way, not as "schema validation failed".

### Grounding decomposition

Harness oracle: the branch's `src/grounding.oracle.ts`, version `grounding-binding-v1` — a
subject→action→target→value→outcome binding check with polarity. The branch deliberately did **not**
use the production `providerNarrationMatchesReceipts` predicate, on the stated grounds that it
checks presence rather than binding and would grade fabricated narration as a pass.

Denominator is *graded* narrations. Abstained cases produce no text and **cannot** be graded.

| Metric | Qwen3-8B | Source |
|---|---:|---|
| Receipt-bearing cases (`receipt-grounded-narration` + `narration-envelope`) | 19 | category join |
| Produced gradeable narration | **14/19** | `toolCallCount == 1 && firstAttemptValid` |
| No binding violation, of graded | **11/14 = 78.6%** [52–92] | `groundingViolations` empty |
| Fully correct (violation-free **and** boundaries pass) | **6/14 = 42.9%** [21–67] | `firstAttemptCorrect` |
| `receipt-grounded-narration` alone | n=11 · valid 6/11 · **correct 0/11** | `category` |
| — of the 6 that spoke: binding/fabrication/leak violation | **3** | `groundingViolations`/`fabrication`/`leaks` |
| — of the 6 that spoke: clean | **3** | same |
| `narration-envelope` alone | n=8 · valid 8/8 · **correct 6/8** | `category` |

Violation codes raised on the 14 graded narrations, 1 each: `inventory-item-missing`,
`check-subject-missing`, `damage-ungrounded`, `fabricated-outcome`.

> The reported "0/11" is **5 abstentions + 3 binding/fabrication violations + 3 omission-only
> failures**. The genuine grounded-invention rate is **3/6 of the cases where the model actually
> spoke**. Three of those six failed only by not stating the receipt's contents — the same
> entity-and-value carry-over deficit as the anchor table, not an independent grounding pathology.
> Reporting "0/11" alone understates the model; reporting "3/6" without the 5 abstentions
> overstates the denominator. Both halves are needed.

### Boundary (leakage and fabrication are distinct)

| Metric | Qwen3-8B | Source |
|---|---:|---|
| `npc-knowledge-boundary` n | 10 | `category` |
| Produced gradeable output | 9 | `toolCallCount`/`firstAttemptValid` |
| **GM-only fact leakage, of graded** | **0/9 = 0.0%** [0–30] | `leaks` empty |
| **Fabricated in-world content, of graded** | **2/9 = 22.2%** [6–55] | `fabrication` non-empty |
| Leakage, of all 10 cases | 0/10 = 0.0% [0–28] | same |
| Corpus-wide structural leak markers, all 106 cases | **0** | `leaks` empty everywhere |

Leak markers scanned: `providerCallId`, `adventure_turns`, `campaign_generation_`, `privateGoals`,
`dm_public_history`, `SECRET_`, bare 64-hex digest, exact-candidate envelope. Scanned against
**prose only**, never against serialised arguments — `candidateId` and the exact-candidate envelope
are legal required arguments and scanning them would fail correct answers.

**Read 0/9 leakage as a near-ceiling result, not as a safety guarantee**: it rests on 9 observations,
and a model that speaks less would produce fewer.

### Agency

| Metric | Qwen3-8B | Source |
|---|---:|---|
| `player-agency` n | 10 | `category` |
| Produced gradeable output | 10 | `firstAttemptValid` |
| Category failures, of graded | 9/10 = 90.0% [60–98] | `firstAttemptCorrect` false |
| **Agency violations only** (authored the player's action/speech) | **1/10 = 10.0%** [2–40] | `fabrication`+`leaks` non-empty |
| Required-anchor omissions only | 9/10 = 90.0% | same, empty |

"Fails the category" and "commits an agency violation" are different things. The 90% headline is
almost entirely missing-anchor coverage, **not** the model taking over the player.

### Failure-mode decomposition, all 106 cases

| Failure mode | Count | % of 106 |
|---|---:|---:|
| **Omitted a required anchor — sole cause** | **40** | **37.7%** |
| Fabrication / asserted unearned content | 14 | 13.2% |
| Omitted a required anchor — with another fault | 9 | 8.5% |
| False call (called when it must not) | 9 | 8.5% |
| Abstained (emitted no tool call) | 7 | 6.6% |
| Grounding binding violation | 3 | 2.8% |
| Wrong tool / wrong arguments | 0 | 0.0% |
| Degenerate multi-call loop | 0 | 0.0% |

Source: `raw-qwen3-8b-graded.json`, bucketed from `reasons`. The largest single measured deficit on
the more reliable model is **omission of one required anchor** — not fabrication, not boundary
breach, not tool selection.

### Serving / protocol failures, reported separately from capability

| Reason | Count |
|---|---:|
| missing-tool-call | 7 |
| false call on a read tool | 2 |
| false call on each of 7 distinct tools (travel, progression, combat read, commerce, narration submit, rest, power use) | 1 each |
| **Total invalid envelopes** | **16/106** |

Per `GRADING.md`, Layer 1 failures are serving/protocol and must not be scored as capability.

### Cross-check against `dataset/BASELINE_SIGNAL.md`

| `BASELINE_SIGNAL.md` claim | Artifact | Verdict |
|---|---|---|
| correct 33/106 (31.1%) | `raw-qwen3-8b-graded.json` | **confirmed** |
| valid 90/106 | `raw-qwen3-8b-graded.json` | **confirmed** |
| false abstention 7/84 (8.3%) of `outcome=tool-call` | same | **confirmed** |
| numeric 14 / 13 / 92.9% | `analyze-referential.mjs` + corpus | **confirmed** |
| generic 72 / 57 / 79.2% | same | **confirmed** |
| named 38 / 28 / 73.7% | same | **confirmed** |
| 40/106 (37.7%) sole-cause anchor omission | `reasons` | **confirmed** |
| `prose-quality` stock rate 4/8 | `category` | **confirmed** |
| 19 receipt-bearing, 14 gradeable, 11 no binding violation, 6 fully correct | grounding oracle | **confirmed** |
| `narration-envelope` alone 6/8 | `category` | **confirmed** |
| `json-schema-generation` 0/10 | `category` | **confirmed** |
| leakage 0/9 where measurable, fabrication 2/9 | `leaks`/`fabrication` | **confirmed** |
| grounding "3/6 where the model spoke" | decomposition | **confirmed** |
| 73 of 106 cases carry an anchor | corpus | **confirmed** |
| named anchors concentrated 9 / 7 / 6 in three categories | corpus | **confirmed** |
| corpus "sits at 0.69 anchors/case" | corpus | **CORRECTED — see §7.4** |
| `devCaseIdListDigest` "not implemented anywhere / not independently reproducible" | — | **CORRECTED — see §7.3** |

---

## 6. Qwen3.5-9B exists but is UNCONTROLLED — do not compare

`raw-qwen35-9b.json` and `raw-qwen35-9b-graded.json` exist and grade cleanly (they also reproduce
byte-identically). Headline figures for completeness:

| Metric | Qwen3.5-9B |
|---|---|
| correct | 17/106 = 16.0% |
| valid | 43/106 |
| false abstention of 84 `outcome=tool-call` cases | 54/84 = 64.3% |
| degenerate multi-call loops on `tool-selection` | 3/7 |
| `json-schema-generation` | 0/10 |

**These numbers must not be used for a model comparison.** The confound is on the model/server
side, not the request side — an important distinction, because the evidence branch's own documents
describe the difference loosely as "different decode settings":

**Held constant, and provably so:** identical request body from one script
(`tool_choice: auto`, `temperature 0`, `top_p 1`, `max_tokens 1024`, `reasoning_effort: none`,
`stream: false`), and **106/106 identical prompt payload digests** across the two runs.

**Not held constant, and not recorded in the result files:**

- **Quantization** differs (`Q4_K_M` vs `UD-Q4_K_XL`) — the single largest confound, and **absent
  from both result files**.
- **Model size** differs (8B vs 9B).
- **Architecture** differs (dense vs hybrid linear/full attention).
- **Reasoning-off mechanism** differs: per-request `reasoning_effort` vs a server-side flag. Only
  one path was exercised per model. Verified that this did not leak into results — **0/106 cases on
  either model emitted reasoning content** — but the mechanism itself was not controlled.
- **A vision projector is loaded** for Qwen3.5-9B and not for Qwen3-8B.
- **Context size and KV cache type are unrecorded** for this run; no `metrics-*.json` exists for it.

Model age, quant quality, size and architecture are fully confounded. "Qwen3.5-9B is worse **on this
run**" is supported by the artifacts. "Qwen3-8B is better **in general**" — or that the newer model
is causally better or worse — is **not** established and cannot be established from this evidence.
Any dataset weighting that depends on the *direction* of the difference is resting on an
uncontrolled comparison.

Keep this Windows quantized baseline strictly distinct from any future unquantized Colab baseline.
They are different quantizations on different hardware under different serving stacks and must
never be differenced against each other.

### No RPMax roleplay result exists

For the avoidance of doubt: the only RPMax artifact on the branch is
`reports/conformance-rpimax-8b.json`, a **9-probe serving-conformance report** (4/9 passed) whose
failures are attributed to the model's chat template having no tool support. There is **no RPMax
dev-corpus run, no RPMax graded file, and no RPMax roleplay or prose-quality score anywhere on the
branch.** The branch's own documents state RPMax's creative quality is unmeasured. Nothing here may
be reported as an RPMax roleplay result.

---

## 7. Discrepancies found

### 7.1 The evidence branch's vendored `CORPUS_FINGERPRINT.json` is stale

| Field | Evidence branch | Current branch (canonical) |
|---|---|---|
| `foundryCorpusDigest` | `22eb7897…` ✓ | `22eb7897…` ✓ |
| `devCaseIdListDigest` | `d3baa542…` ✗ | `f904ab27…` ✓ |
| `digestAlgorithm` | **field absent** | published explicitly |
| 11 `devFileSha256` entries | all identical ✓ | all identical ✓ |
| `devCaseCount` | 106 ✓ | 106 ✓ |

The copy is the pre-correction fingerprint from the foundry branch. The mainline
`dataset/eval/CORPUS_FINGERPRINT.json` supersedes it. **Do not adopt the evidence branch's copy.**

### 7.2 The evidence branch's vendored `CORPUS_HANDOFF.md` is stale and contradicts §1

That copy's "Corpus digest" row reads `3dccce3c1af34b41158903e89d8f80456b10512ae9ab8fef1847a58dc576ea56`.
The canonical value is `22eb7897…`. The copy also predates the move of sealed content out of the
repository, so it describes a sealed partition layout that no longer exists. It disagrees with the
rest of the same branch, whose `freeze.json`, `CORPUS_FINGERPRINT.foundryCorpusDigest` and
`sealed-attestation.corpusDigest` all say `22eb7897…`.

**Do not adopt the evidence branch's copy.** Use `dataset/eval/CORPUS_HANDOFF.md`.

Separately, several prose documents on the evidence branch
(`STOCK_MODEL_BASELINE.md`, `BASELINE_INFERENCE_SETUP.md`, `REBASELINE_QWEN35_9B.md`) quote a
**fourth** digest, `6310180d2ba4271bbf89ed4c86206d64dc0db92ae616b84bd7133c7498e1df55`, as "the corpus
root digest". That value belongs to a different, locally authored asset corpus that contained zero
cases; it is not this corpus, and it is not a competing identity for it. Nothing measured on the dev
partition was scored against it.

### 7.3 "The case-id digest is unreproducible" is wrong — it is two canonicalisations

Both the evidence branch's documents and `dataset/BASELINE_SIGNAL.md` record
`devCaseIdListDigest` as a published constant with no reference implementation, hence
"unverifiable". That is **incorrect**, and the discrepancy is now resolved:

- The evidence branch's `d3baa542c0a0e4b666d6e1f52641803e0b44b68224f3ed74fca3db411ab194f9`
  reproduces **exactly** as SHA-256 over the LF-joined case ids **in glob/file order, unsorted**.
- The current branch's `f904ab27ba3a3a93581251d88522d0ada79ae55e741e48972334fed638b945e4`
  reproduces **exactly** as SHA-256 over the LF-joined case ids **globally sorted**.
- `dataset/src/verifyCorpus.ts` implements the sorted variant and publishes its algorithm in the
  fingerprint's `digestAlgorithm` field.

Both digests describe the *same 106 ids* — proven, because the 11 dev case files are byte-identical
to the pinned checksums. This is a canonicalisation change, not corpus drift and not a mismatch. The
sorted form is the one to use going forward; it is order-independent and therefore portable.

### 7.4 "0.69 anchors per case" is a mislabelled quantity

`DEV_CORPUS_ADDENDUM.md` and `dataset/BASELINE_SIGNAL.md` both state the corpus "sits at 0.69
anchors/case", which is the basis for the "raise to 3–5 is a large intensification" argument.

Recomputed from the corpus: **124 anchors across 106 cases = 1.17 anchors per case**, or 1.70 per
anchor-carrying case. The 0.69 figure is **73 ÷ 106** — the fraction of cases that carry *any*
anchor, not anchor density. The per-category anchor table in the addendum is correct; only the
summary sentence is wrong. Corrected numbers:

- 106 cases; **73 carry at least one anchor; 33 carry none**
- **124 anchors total** — named 38, generic 72, numeric 14
- **1.17 anchors per case** (1.70 per anchored case)

The directional argument survives — the corpus is not anchor-dense and raising it to 3–5 per case is
still a large intensification — but the baseline it is measured against was understated by roughly
70%. Any plan quoted against "0.69" should be re-derived against 1.17.

### 7.5 `.gitignore` — the branch changes mainline ignore rules

Both commits modify `.gitignore`, replacing `data/` with `data/*` plus a long list of re-inclusions
under `data/velvet-bench/`. This widens what a future commit can capture in a directory that
deliberately holds multi-gigabyte GGUF weights, a llama.cpp runtime and a live database. The branch's
own documents flag this. **Treat the `.gitignore` change as the highest-risk part of the branch**;
it should never be merged without deliberate review.

### 7.6 Graded artifacts carry dev-corpus ground truth — this blocks naive adoption

Checked here: **96 of 96** strings in the graded artifacts' `missing[]`, `fabrication[]` and
`leaks[]` arrays are **verbatim dev-corpus `mustInclude` / `mustNotInclude` / `forbiddenFacts`
values.** The raw artifacts additionally embed each model's full generated answer in `content` and
`prose`.

So adopting `raw-*-graded.json` into the mainline would commit dev-corpus ground-truth substrings
into a tracked file, and adopting `raw-*.json` would commit 106 model answers per model. The
handoff above reports only aggregate counts and never reproduces those strings, and it contains zero
model-generated answer text and zero illustrative fragments. If adoption is wanted, the orchestrator
needs an explicit decision on which of these artifacts may land, and in what redacted form.

---

## 8. What this evidence does and does not establish

### It DOES establish

- An existing, **frozen dev-partition baseline for Qwen3-8B is now recoverable and re-derivable**,
  and its grading is byte-reproducible offline with no model contact.
- The raw responses were generated against **exactly this repo's** dev corpus (106/106 prompt
  digests reproduce).
- Concrete, measured, reproducible failure distributions for Qwen3-8B at 31.1% correct / 90/106
  valid, with the dominant failure mode being single-anchor omission (37.7% sole cause).
- A credible **regression gate** value: `prose-quality` must not fall below its stock 4/8.
- A finding that **numeric anchors are the worst-missed class (92.9%) and proper nouns the best
  (73.7%)** — the reverse of the hypothesis the evidence was originally gathered to test.

### It does NOT establish

- **A controlled before/after model-quality experiment.** There is no "before" and no "after".
  This is one pass@1 sample of one quantized model on one Windows host. Recovering these responses
  makes an existing dev baseline *available*; it does not measure any change in any model.
- **Student retention evidence of any kind.** See §9.
- **Any sealed-partition result.** Sealed was never run. There is no sealed baseline to compare a
  fine-tune against.
- **Any subjectively judged prose quality.** No LLM judge and no blinded human review was performed
  on these responses. `prose-quality` 4/8 is a substring-anchor pass rate, **not** a writing-quality
  score. No character fidelity, voice distinctness or emotional-realism number exists.
- **Any RPMax roleplay result.** Only a serving-conformance report exists.
- **Any claim that Qwen3.5-9B is better or worse than Qwen3-8B.** §6.
- **Unquantized or Colab-baseline numbers of any kind.** Everything here is Windows + `Q4_K_M` on
  llama.cpp `b11574`.
- **Run-to-run stability.** One run per model. Wilson intervals in the artifacts cover binomial
  sampling error only, **not** run-to-run variance. Do not read a single-sample difference as a
  trend.
- **Deep-equal correctness on narration.** Layer-2 deep-equal was exercised on **7 of 84**
  tool-call cases; the other 77 declare a single free-prose `narration` exemplar and are graded by
  Layer-3 anchors. For those, "correct" means *met the anchor constraints*, **not** *matched the
  reference*. This is the largest single caveat on the headline 31.1%, and it applies to any model
  scored with this harness.
- **A clean serving story.** 16/106 responses failed Layer 1. Those are protocol failures and are
  excluded from correctness, not scored as capability — but they are real.

---

## 9. No controlled stock-vs-candidate prose retention comparison is possible

**The inherited 4/8 style floor rests on raw historical student answers that were never recovered in
this checkout.** `dataset/PROSE_MEASUREMENT.md`, `dataset/CALIBRATION_PROTOCOL.md` and
`dataset/README.md` all record this independently: 4/8 is an **absolute numeric policy floor**, not a
controlled stock-retention measurement, and it "does not establish controlled stock retention,
especially with one ordinary RP scenario".

**Does anything on the evidence branch change this? No.** Confirmed by inspection of every artifact on
`origin/bench/stock-baseline-findings`:

- The recovered artifacts are **dev-corpus contract responses** (tool selection, receipt grounding,
  knowledge boundaries, schema envelopes). They are graded by deterministic substring and
  deep-equal predicates with **no judge and no style rubric**.
- The only ordinary-roleplay-adjacent run is an **18-turn scripted VelvetRP DM-play probe**
  (`reports/freeform-run/`), which emits transport/coherence metrics — provider success rate,
  materialisation rate, DM-beat success, coherence violations, latency. It has **no style score, no
  blinded judgment, and no `4/8`-comparable denominator**. It also is not the ordinary-RP
  calibration scenario the 4/8 floor came from.
- **No blinded prose inventory, no style judgment records, and no historical stock answer set**
  exist anywhere on the branch.

Therefore:

1. **No controlled stock-vs-candidate prose retention comparison is possible from this evidence.**
2. `prose-quality 4/8` in §5 is a **dev-corpus anchor pass rate**, useful as a regression gate, and
   must **not** be reported as, compared against, or substituted for the inherited 4/8 style floor.
3. Anything that compares a candidate's generated-data style quality against a stock model remains
   **unestablished**, and generated-data style quality cannot establish student retention in any
   case.

---

## 10. Reproducing this verification without merging the evidence branch

Nothing below touches the working tree of this branch. All reads are `git show` / `git ls-tree`
against the evidence ref.

```bash
REF=origin/bench/stock-baseline-findings
TMP=$(mktemp -d)

# --- 0. confirm the ref and list what is there (do NOT cherry-pick, do NOT merge) ---
git log --oneline $REF -2
git ls-tree -r --long $REF -- data/velvet-bench/eval/

# --- 1. corpus identity: fingerprint vs the canonical frozen identity ---
git show $REF:data/velvet-bench/eval/CORPUS_FINGERPRINT.json
#    expect foundryCorpusDigest == 22eb78976caa9ca91102f75576ea19eeb8cef8d594435275630542b7ddef8e58
git show $REF:data/velvet-bench/eval/freeze.json | grep -o '"corpusDigest":"[^"]*"'
git show $REF:data/velvet-bench/eval/sealed-attestation.json | grep -o '"corpusDigest":"[^"]*"'
grep -n '22eb78976caa9ca91102f75576ea19eeb8cef8d594435275630542b7ddef8e58' dataset/eval/CORPUS_HANDOFF.md
sha256sum dataset/eval/corpus/dev-cases/*.json      # must equal the fingerprint's devFileSha256
npm run foundry -- verify                            # Node 22+ required

# --- 2. sealed attestation: confirm it is ids/counts only, then STOP reading sealed content ---
git show $REF:data/velvet-bench/eval/sealed-attestation.json | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(sorted(d)); print(d["sealedCaseCount"], len(d["sealedCaseIds"]))'
#    no sealed body may be fetched, opened, or committed. See §2.

# --- 3. checksums of the four result artifacts ---
for f in raw-qwen3-8b.json raw-qwen3-8b-graded.json raw-qwen35-9b.json raw-qwen35-9b-graded.json; do
  printf '%s  ' "$(git show $REF:data/velvet-bench/eval/$f | sha256sum | cut -d' ' -f1)"; echo "$f"
done
# expect, in order:
#   d9b4bf658a232a1b912cc7513b6317e567df3ccb6d612f6bdff15adf41cc3b90  raw-qwen3-8b.json
#   08aa33fcb9e79a599ecd82279518bd817d43f36661a1ab4bd16e8afa81aa7415  raw-qwen3-8b-graded.json
#   ac2a8a23a3a17edbaf2d5a8b74ddee2df455a9bec38b6706a79a0b4256c1ac63  raw-qwen35-9b.json
#   9053c3e3bc3f5804f2911596046b353656d117b9df908b5deb686eb77206c00f  raw-qwen35-9b-graded.json

# --- 4. re-derive the graded files offline (no model contact) ---
mkdir -p $TMP/run/data/velvet-bench/eval/src $TMP/run/scripts
git show $REF:data/velvet-bench/eval/grade-dev-corpus.ts > $TMP/run/data/velvet-bench/eval/
git show $REF:data/velvet-bench/eval/src/grounding.oracle.ts > $TMP/run/data/velvet-bench/eval/src/
git show $REF:data/velvet-bench/eval/report-dev-corpus.mjs  > $TMP/run/
cp scripts/audit-adventure-consistency.ts $TMP/run/scripts/          # oracle imports this
ln -s "$PWD/dataset/eval/corpus/dev-cases" $TMP/run/data/velvet-bench/eval/dev-cases
for m in qwen3-8b qwen35-9b; do git show $REF:data/velvet-bench/eval/raw-$m.json > $TMP/raw-$m.json; done
# On Node < 22 `audit-adventure-consistency.ts` fails to import `node:sqlite`; in a TEMP copy only,
# replace that one import with a stub. Never patch the repo file.
(cd $TMP/run && npx tsx data/velvet-bench/eval/grade-dev-corpus.ts --raw $TMP/raw-qwen3-8b.json \
   --out $TMP/repro-qwen3-8b-graded.json)
sha256sum $TMP/repro-qwen3-8b-graded.json   # must be 08aa33fc…7415

# --- 5. reproduce the report tables ---
node $TMP/run/report-dev-corpus.mjs --graded $TMP/raw-qwen3-8b-graded.json
node $TMP/run/report-dev-corpus.mjs --graded $TMP/raw-qwen3-8b-graded.json --graded $TMP/raw-qwen35-9b-graded.json

# --- 6. reproduce the anchor miss rates (needs the dev corpus symlinked as in step 4) ---
git show $REF:data/velvet-bench/eval/analyze-referential.mjs > $TMP/run/data/velvet-bench/eval/
(cd $TMP/run && node data/velvet-bench/eval/analyze-referential.mjs $TMP/raw-qwen3-8b-graded.json)

# --- 7. confirm §7's stale copies and the .gitignore hazard ---
for p in CORPUS_FINGERPRINT.json CORPUS_HANDOFF.md GRADING.md freeze.json sealed-attestation.json; do
  git show $REF:data/velvet-bench/eval/$p | sha256sum
done
git diff ff9d2de~1 495218a -- .gitignore

# --- 8. cleanup: nothing was written into the working tree ---
git status --short
```

Expected `git status --short` delta for this task: exactly one untracked file,
`dataset/eval/STOCK_BASELINE_HANDOFF.md`. No existing file is modified and nothing is committed.

---

## 11. Adopting these artifacts is a separate orchestrator decision

**Do not copy any of the data files.** This verification pass owns exactly one file — this document —
and copied none of the artifacts.

Decisions reserved for the orchestrator, in rough order of how much they should be weighed:

1. **Whether to adopt the result artifacts at all**, given §7.6: the graded files carry dev-corpus
   ground-truth substrings and the raw files carry 212 model answers. Any adoption needs an explicit
   redaction decision.
2. **Whether to adopt the stale `CORPUS_FINGERPRINT.json` / `CORPUS_HANDOFF.md` copies.** Recommendation:
   **no** — §7.1 and §7.2.
3. **The `.gitignore` change** (§7.5). Recommendation: never merge blind.
4. **Where the checksum table in §3 gets pinned**, and whether the missing quantization/decode/run-date
   metadata (§4) must be added to the result files before adoption.
5. **Whether the prose reports on the evidence branch should be re-derived first**, given that two of
   their claims (§7.3, §7.4) are now known to be wrong or mislabelled, and given that several
   duplicate, stale or superseded numbers (`3dccce3c…`, `6310180d…`, `0.69 anchors/case`) circulate
   across them.

The current student remains **Qwen3-8B**. Nothing in this handoff reopens model selection, and
nothing here authorises training, dispatch or pilot progression.

---

## 12. Provenance of this verification

| Claim in this document | How it was checked |
|---|---|
| Corpus identity `22eb7897…` | Recomputed from `freeze.json` with `computeCorpusIdentity` semantics; cross-checked against fingerprint, attestation, freeze and `CORPUS_HANDOFF.md` |
| Dev content identity | 11/11 SHA-256 compared against the pinned fingerprint |
| Sealed attestation ids/counts-only | Structural field audit + substring probes for every case-content key |
| `attestationDigest` reproducible | Recomputed from the attestation body |
| Raw/graded checksums | `git show \| sha256sum` on the raw blobs |
| Graded ↔ raw correspondence | id set, id order, `promptSha256` equality, count |
| Graded reproducibility | Re-ran the branch grader offline; **byte-identical** for both models |
| Prompt fidelity to this corpus | 106/106 `promptSha256` recomputed from the committed dev cases, both models |
| Cross-model prompt parity | 106/106 identical digests |
| All §5 numbers | Computed from the two artifacts only; cross-checked against the branch's own reporter |
| Anchor miss rates | Branch's `analyze-referential.mjs`, plus an independent recomputation restricted to prose-bearing records |
| Grounding decomposition | Branch's `grounding-binding-v1` oracle via the reproduced grader |
| Metadata present/missing | Top-level and per-record key census of all four result files |
| §7.3 digest canonicalisation | Brute-forced 5 canonicalisations; both published values reproduced exactly |
| §7.4 anchor density | Recomputed anchor totals and per-category distribution from the dev corpus |
| §7.6 ground-truth leakage | 96/96 strings in graded `missing`/`fabrication`/`leaks` matched verbatim against corpus `expected` |
| §9 retention finding | Full artifact listing of the evidence branch, plus `dataset/PROSE_MEASUREMENT.md`, `CALIBRATION_PROTOCOL.md`, `README.md` |

**No sealed case body was read. No dev-corpus case body, expected answer, receipt, oracle ground
truth or prompt was transcribed into this document. No model-generated answer text appears here.
This document contains no illustrative fragments. It reports aggregate counts and failure-category
distributions only.**
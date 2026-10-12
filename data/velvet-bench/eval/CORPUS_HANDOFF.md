# Frozen Benchmark Corpus — Handoff

**This corpus is a deliverable consumed by a separate benchmarking agent running on different
hardware.** It is frozen, checksummed, and must not be modified. Nothing here requires reading
VelvetRP's source to execute — but the grading notes reference real runtime contracts, so read
`GRADING.md` before implementing a grader.

## Identity

| Field | Value |
|---|---|
| Corpus id | `velvet-baseline` |
| Corpus version | `velvet-baseline-v1` |
| **Corpus digest** | `3dccce3c1af34b41158903e89d8f80456b10512ae9ab8fef1847a58dc576ea56` |
| Frozen at | see `dataset/eval/corpus/freeze.json` |
| Files | 22 (11 categories × 2 partitions) |
| Cases | 213 (106 dev, 107 sealed) |

`freeze.json` records a SHA-256 for every case file plus a `corpusDigest` over the sorted
checksum list. Re-freezing an unchanged corpus reproduces the same digest, so CI can assert
stability:

```bash
npm exec -- tsx dataset/src/cli.ts corpus verify        # exits non-zero on drift
```

## Layout

```
dataset/eval/corpus/
  freeze.json              # checksums, split counts, lineage per split  (COMMITTED)
  dev/<category>.json      # 106 cases, lineages prefixed dev-*
  sealed/<category>.json   # 107 cases, lineages prefixed sealed-*
```

**`sealed/` is embargoed.** It exists to be run once, at the end, by the benchmarking agent.
Nothing in the generation path may read it. `dataset/src/freeze.ts` exposes
`readSealedCases()` behind an explicit audit acknowledgement, and
`assertLineageDisjoint()` proves no lineage group spans partitions.

The **dev** partition is the one that feeds back into dataset generation: measure which
dimensions the stock models fail, then weight generation accordingly.

## Categories (11)

| Category | Probes | dev | sealed |
|---|---|---:|---:|
| `flexible-roleplay` | Does the model adapt to the card, or emit one stock voice? | 10 | 9 |
| `multi-turn-continuity` | Does it hold names, facts and commitments across turns? | 9 | 9 |
| `prose-quality` | Register, restraint, avoiding purple prose and templates | 8 | 8 |
| `narrative-initiative` | Does it move the scene, or only react? | 8 | 8 |
| `player-agency` | Does it decide for the player or steal agency? | 10 | 10 |
| `npc-knowledge-boundary` | Does an NPC leak GM-only facts? | 10 | 10 |
| `receipt-grounded-narration` | Does it describe exactly the committed receipt, inventing nothing? | 11 | 10 |
| `tool-selection` | Exact tool + exact opaque arguments from the real advertised menu | 12 | 13 |
| `narration-envelope` | Correct `submit_adventure_narration` envelope and grounding | 8 | 9 |
| `json-schema-generation` | Strict 16-section world-generation contracts | 10 | 10 |
| `no-tool-behavior` | Legitimate abstention; no spurious calls | 10 | 11 |

## Case shape

```jsonc
{
  "category": "tool-selection",
  "version": "velvet-baseline-v1",
  "lineage": { "characterFamily": "sealed-char-...", "worldFamily": "...", "scenarioFamily": "..." },
  "cases": [{
    "id": "sealed-tool-01-inventory-equip",
    "lineage": { ... },                     // same triple as the file; enables lineage-disjoint split
    "dimension": "exact-inventory-selection",
    "setup": {
      "systemPrompt": "...",                // the exact system message the runtime would send
      "characterCard": { ... },
      "scene": "...",
      "history": [ { "role": "...", "content": "..." } ],
      "committedReceipts": [ ... ],         // present on narration cases: the ground truth
      "worldFacts": [ "..." ],              // public, may be used
      "gmOnlyFacts": [ "SECRET_..." ],      // must NEVER appear in output
      "gradingNote": "..."                  // read before writing a grader
    },
    "tools": [ /* OpenAI-format function schemas the runtime would advertise */ ],
    "input": "I put the shunting lamp on.",
    "expected": {
      "outcome": "tool-call" | "no-tool" | "clarify",
      "toolName": "exact_inventory_action.select" | null,
      "arguments": { "candidateId": "...", "digest": "..." } | null,
      "mustInclude": [], "mustNotInclude": ["slot", "quantity", ...],
      "forbiddenFacts": ["SECRET_..."],
      "rationale": "why this is correct"
    }
  }]
}
```

## Gradeability — the important property

| Grade path | Cases | Requires |
|---|---:|---|
| Deterministic: exact `toolName` + exact `arguments`, or asserted `no-tool` | **206** | nothing but a JSON comparison |
| Substring anchors only (`mustInclude`/`mustNotInclude`/`forbiddenFacts`) | 7 | a substring matcher |
| Requires an LLM judge for correctness | **0** | — |

Every case carries `mustNotInclude`, and 50 carry `forbiddenFacts`. So the corpus grades
**first-attempt** behavior without a judge for anything structured. Report first-attempt
validity separately from correctness, and **do not retry** — a retry must never conceal a
first-attempt miss.

## Fidelity to the real runtime

The corpus is grounded in VelvetRP's production contracts, not invented:

- All 11 `exact_*.select` tools appear with their real argument shapes: the opaque
  `{candidateId, digest}` pair with `enum` + `oneOf` const bindings; the four-argument
  `exact_actor_travel.select` including `choices: []`; `combat_action.execute` with
  `legalActionId`/`legalActionDigest`; empty-strict read tools.
- `receipt-grounded-narration` uses the real `NarrationReceipt` union verbatim — check
  success and failure with the literal verdict word, bare dice, combat damage, contests,
  travel, commerce, power costs with state deltas, progression, quest-lifecycle with
  `reward: null`, and an interrupted journey.
- `json-schema-generation` carries the full sparse 16-array envelope plus the exact per-section
  item schema and array caps.
- 10 user declarations are reused verbatim from the repo's `HUMAN_PLAYER_DECLARATIONS`
  fixture (typos, lowercase, cyrillic, injection, cheat, meta, ambiguity, control chars).

**Intentional difficulty.** These cases target documented stock-model failures, so a low score
is the expected and informative result:
- Llama-3.1-8B-Instruct has a measured **67% tool-hallucination rate** (When2Call) and Meta's
  own card warns 8B cannot reliably hold conversation alongside tool definitions.
- Fabricated-outcome cases put a committed receipt in `setup` and forbid any outcome beyond it.
- Leakage cases plant the repo's own markers (`SECRET_`, `privateGoals`, `candidateId`,
  `providerCallId`, `dm_public_history`) in `gmOnlyFacts`.
- Prose cases penalize a single stock register and repeated purple-prose tells.

## Ground rules for the benchmarking agent

1. **Do not modify anything under `dataset/`.** Report drift via `corpus verify`.
2. **Run dev first.** Feed the failure report back to the dataset pipeline — it steers
   generation weights.
3. **Run sealed once, last.** Report per-category first-attempt pass rate.
4. **Use each model's native chat template.** `apply_chat_template` at inference; never
   pre-render. Llama-3.1 uses `<|start_header_id|>…<|eot_id|>`; Qwen3 uses ChatML with
   `<tool_call>` XML and renders tool results as a `user` turn. A serving-protocol failure is
   **not** a capability failure — diagnose the distinction and report it separately.
5. **Record HF revision SHAs and runtime versions.** They are part of the result.
6. **Report quantized vs unquantized separately.**
7. **Human review a stratified sample.** An LLM judge alone is insufficient; DeepSeek Flash may
   assist but is not ground truth.
8. **Do not tune against sealed.** No prompt, sampling or threshold change after sealed runs.
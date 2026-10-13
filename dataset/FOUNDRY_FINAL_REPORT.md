# Foundry final report

Status: **phase complete with an explicit HOLD on training-corpus expansion.**
No model training was run. No pilot was dispatched. The deliverable is validated
infrastructure, measured calibration results, a decision, and a training handoff.

Branch: `feat/foundry-context-diagnostic`.
Base reviewed commit at handoff start: `18696dbd3c9611eeb563366c0a7c2746cd91c740`.

---

## 1. What was fixed

### CI and unrelated repository failures

Three test failures predated this branch and blocked CI. All three reproduce
identically at the branch base commit `4447d2c` and none was caused by the foundry
work. Each was diagnosed to a root cause rather than silenced:

| Test | Root cause | Correction |
|---|---|---|
| `packages/contracts` SRD starter identity | Commit `edbdc42` deliberately bumped the published pack to `1.7.0+a870b31918ec`; the assertion still expected `1.6.0` | Pin moved forward. Downgrading a published identity to satisfy a stale assertion would corrupt references |
| `server` memory-evals travel fixture | The declaration `"I travel to Memory Destination."` was intercepted by a newly added server-resolved journey lane, so the fixture's stubbed exact-travel selection never ran | Declaration reworded to leave the journey lane; assertions and coverage unchanged |
| `server` encounter migration schema | The test's hand-maintained schema list was missing `actorJourneySchema.sql`, so the fresh reference database lacked the journey objects | Added the missing asset and documented that the list tracks production |
| `client` SceneImages | The story-first change made `surface="story"` the default, which does not render the `CommandCenter` group the test queries | Pinned the test to `surface="center"`, matching its sibling. No assertion loosened |

### Grounding grammar

`CHECK_RESOLUTION` matched only `succeeded|succeeds|failed|fails`, so the
present-tense base forms (`You succeed on …`, `You fail on …`) were refused as
unrecognized while the ungrammatical `You succeeds on …` was accepted. Real v7
answers were refused for this reason. The alternation now covers both stems; the
validator version is `grounding-binding-v7`. Historical `.dataset` evidence still
records v6 and is untouched.

### Public-context adapter integrity

Two independent read-only reviews found, and this phase closed, seven defects:

| # | Severity | Defect |
|---|---|---|
| F1 | P1 | A scene sentence's mechanical semicolon sibling re-entered the lossy splitter, dropping `but`/`while`/`however` and question marks and still verifying |
| F2 | P1 | The scene authority was a mutable, copyable map; a re-hashed source or forged control-arm upgrade resolved under the original pin |
| F3 | P2 | A wrong declared manifest digest was silently recomputed instead of refused |
| F4 | P2 | A noncontiguous schedule executed grouped while the plan reported the supplied order |
| N1 | P1 | A candidate that passed every functional validator but was refused by a review-quality floor triggered a generator repair, contradicting the protocol's no-style-retry rule |
| N2 | P1 | The repository runner accepted the environment's default reviewer instead of the preregistered Kimi K3 |
| N3 | P2 | The runner's preflight crashed because `runPipeline` dereferences client identities it omitted |

A third review found two more in the measurement tooling, both closed:

| # | Defect |
|---|---|
| N4 | The census collector silently fell back to freshly planning an inventory when the bound plan artifact was missing, so it could freeze an unrelated sample set while reporting success |
| N5 | The run summarizer counted reviews with a naive `JSON.parse`, ignoring the durable review contract, so unusable reviews counted as accepted and valid fenced reviews counted as zero |

### Creative stream

The creative module was delivered with **13 of 18 tests failing**, including a
target-selection bug that used positional index arithmetic and would have
supervised simulated player turns in a player-first conversation. It was
corrected to be layout-independent (character-turn ordinals resolved through the
actual message indices), and a documentation pass corrected a material overclaim
that legacy object anchors were kept out of every setting pool.

The first live creative calibration then exposed a further defect: the
player-impersonation detector refused ordinary second-person dialogue, so a
character could not say "if you stand where I stand" without the whole transcript
being rejected. It now requires a main-clause assertion.

## 2. What was independently verified

Every claim below was reproduced by an agent that did not write the code, or by
the orchestrator against the actual artifacts. Verification used independent
probes, not the implementer's test names.

- The four frozen plan/manifest identities reproduce exactly, including the
  corrected matched-v7 digest ending `…b38e04`.
- The F1–F4 fixes fail closed under adversarial probes: spread copies, `Proxy`,
  `structuredClone`, `Object.create`, reflected brands and refreezing.
- N1 was verified both directions with fake transports and a real fsync store:
  default repairs on a review-floor refusal, `functional-only` does not, and a
  genuine grounding failure still repairs.
- N4/N5 were re-verified against the original counterexamples.
- The creative stream's never-supervise-a-player property: **154 builds across 7
  settings, 4 depths and every target mode, 0 violations**, plus a cross-process
  determinism check.
- Creative pipeline wiring: **8/8 units admitted end to end, all multi-turn, 0
  player turns supervised**, with the frozen digests unchanged.

## 3. What live experiments actually ran

| Run | What | Outcome |
|---|---|---|
| `calibration-2026-10-13-v5` | 20 seeds, five families | 14/20 admissions; world contracts validated |
| `calibration-2026-10-13-v6` | 13 matched seeds | 13/13 functional; prose 1 pass / 6 fail / 1 ungradeable |
| `calibration-2026-10-13-v7` | 13 matched seeds, composed guide | 13/13 functional; **3/7** final joint style+function; warm/wary 0/2 |
| `calibration-public-context-2026-10-13-v8` | 3 matched pairs, 6 tasks | 6/6 functional; **1 pass / 8 fail**; observations used but no improvement |
| `creative-2026-10-13-v1` | 10 creative units | Refused almost entirely: impersonation defect |
| `creative-2026-10-13-v2` | 10 creative units, 4096-token budget | 4 admitted; truncation and empty completions dominated |
| `creative-2026-10-13-v3` | 10 creative units, 16384-token budget | 6 admitted; **truncation eliminated** |
| `creative-2026-10-13-v4` | 10 creative units, valid-range contract | **8/10 admitted**, 6 train / 2 sealed-test, 8 distinct lineages, 8/8 multi-turn |

## 4. What the quality measurements demonstrate

**The blocker is prose quality, not infrastructure.**

- v7 improved final narration targets passing both style and function from 1/7 to
  3/7, confined to transactional and procedural narration.
- Warm/evasive and wary narration remain **0/2** in both v6 and v7. The model
  either writes a mechanical checklist or reaches for a richer register by adding
  claims the receipts do not establish, which the grounding gate correctly refuses.
- The public-context diagnostic tested the preregistered remedy and it **did not
  work**: supplying two verified observations was used in every observation-arm
  output yet passed 0/4 against the control arm's 1/5.
- **Conclusion: the grounded-narration prose problem is not solved by prompt
  tuning or by inert scene context.** Further work needs a different mechanism,
  and a further experiment would have to be separately versioned.

Structured families (world generation, tool selection, boundary recovery) were
independently approved in v5–v7 and do not depend on prose quality.

### Creative roleplay does work

In contrast, the **creative stream produces genuinely engaging prose**. Four
calibrations took it from near-total refusal to **8/10 admitted**, with 8 distinct
character lineages, all multi-turn, and 3,882 admitted labels (the whole
previously approved export was 806).

Independent creative review of a stratified five-conversation sample:
**3 pass / 2 fail**, judged against a nine-criterion creative rubric with the
player's turns marked as non-targets. Representative passing evidence:

> "Two winters I've practised it at the kettle, and the kettle's very forgiving,
> so that's not saying much for me."

This is the **implemented and evaluated response to the creative-coverage gap**,
not a proposal. Two caveats: one failure was a genuinely over-polished register,
and one was a real player-agency violation (*"You want to know what I want"*) that
the structural gate **admitted** — independent review caught what the pipeline
missed.

## 5. What data was generated and admitted

### Calibration runs (measured, not estimated)

| Run | Planned | Attempts | Admitted | All-attempt labels | Admitted labels |
|---|---:|---:|---:|---:|---:|
| v6 | 13 | 15 | 13 | 1,092 | 969 |
| v7 | 13 | 19 | 13 | 1,540 | 989 |
| v8 | 6 | 9 | 6 | 764 | 503 |

### Corpus campaign — the exported dataset

Four independent runs executed concurrently:

| Run | Planned | Admitted | Admitted labels |
|---|---:|---:|---:|
| `corpus-structured-2026-10-13-v1` | 60 | 59 | 13,205 |
| `…-v1-shard2` | 60 | 58 | 12,117 |
| `…-v1-shard3` | 60 | 57 | 12,928 |
| `creative-2026-10-13-v6` | 30 | 22 | 10,670 |
| **Total** | **210** | **196** | **48,920** |

**Exported under independent approval: 155 train records, 39,435 supervised
tokens** — world 46, tool 39, boundary 30, narration 21, creative 19. For scale,
the previously approved export was 4 records and 806 labels.

Approval `2abc5e6d829809c65e1c62a0482a5968191850b4ed8a4d0eadccc2d4a6207e14`
(export only, training not authorized). Full pins:
[`CORPUS_EXPORT_V1.md`](CORPUS_EXPORT_V1.md).

## 6. Decision

**The frozen 175-seed pilot remains HELD. The corpus campaign was executed
instead, and its output is exported.**

Reasons the frozen pilot is still held:

1. **The pilot's frozen allocation gives 22% of its rows to grounded narration,
   which fails the style floor**, and the preregistered remedy for that was tested
   in v8 and did not work. Running it unchanged would bake a known-weak tranche
   into the dataset with no mechanism to repair it.
2. The remaining 78% — world generation, tool selection, boundary recovery and
   creative roleplay — **is validated**.

**What was done instead:** a re-weighted corpus campaign with an explicit
opt-in weight override, so the frozen pilot is untouched. Grounded narration was
capped at 0.15 rather than 0.22, the legacy roleplay scaffold was excluded
entirely (the creative stream supersedes it), and the creative stream ran as its
own campaign. The result is **155 independently approved train records / 39,435
supervised labels**, exported under a digest-pinned approval.

**Recommended next step, and it is not mine to run:** a small smoke-test LoRA on
this bundle against a same-runtime BF16 stock baseline, before spending more
generation budget. See
[`SYNTHETIC_DATA_BEST_PRACTICE.md`](SYNTHETIC_DATA_BEST_PRACTICE.md) and
[`COLAB_TRAINING_HANDOFF.md`](COLAB_TRAINING_HANDOFF.md).

## 7. Limitations that remain

- No controlled stock-versus-candidate retention comparison. The historical raw
  stock answers were never recovered, so the inherited 4/8 floor remains a policy
  threshold, not a measurement.
- **No trained model exists.** Nothing here demonstrates that training on this
  corpus improves roleplay or task accuracy. That is the next experiment.
- 155 records is a real corpus but a small one. The evidence says curation beats
  volume, but this is a first handoff, not a production-scale dataset.
- The creative stream's independent creative quality is **3/5** on a stratified
  sample of five conversations. Two failures were real: one over-polished
  register, and one player-agency violation the structural gate **admitted**.
- The Qwen3.5-9B baseline is uncontrolled and no comparison is claimed.
- Server-resolved declared journeys are not indexed under recall's `travel-receipt`
  source. Real, out of scope, and deliberately not patched speculatively.
- `My <skill> check …` is a known false refusal of the same class as the
  present-tense gap. Recorded; historical outputs were not re-admitted.
- The corpus export approval pins **tracked source**, not untracked or dirty files
  or installed dependency bytes.

## 8. Reproducing this

```bash
# Validation
npm run typecheck:foundry
FOUNDRY_TOKENIZER_PYTHON=/path/to/pinned/venv/bin/python npm run test:foundry

# Frozen diagnostic (credential-free until --execute)
npx tsx dataset/scripts/runPublicContextDiagnostic.ts --preflight <manifest-pin>

# Creative calibration
npx tsx dataset/scripts/runCreativeCalibration.ts --preflight <plan-pin>

# Census, summary and prose ledger for any run
npx tsx dataset/scripts/collectRunInventory.ts <runId> <seed> <scenarios> <k> [--grounded]
npx tsx dataset/scripts/summarizeRun.ts <runId>
npx tsx dataset/scripts/freezeProseLedger.ts <runId> <contexts.json>

# Export (requires an independently supplied, digest-pinned approval)
npx tsx dataset/scripts/exportApprovedBundle.ts <approval.json> <approval.sha256> <outputDir>
```

Every one of these scripts refuses rather than guessing: a missing binding, a
digest mismatch, an unpinned plan, or a wrong reviewer identity all stop the run
before a provider request.

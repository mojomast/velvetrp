# VelvetRP training-data foundry

> **Picking this up? Start with [`HANDOFF.md`](HANDOFF.md).** It states the
> current position, the deliverable and its pins, what is done, what is not, and
> what to do next.

Target: **Qwen3-8B**, with creative roleplay retention alongside structured RPG
tasks. This repository provides dataset infrastructure and a frozen evaluation
corpus. Model training and hardware benchmarking are separate tasks.

## Commands available now

Run from the repository root with Node 22:

```bash
npm run foundry -- help
npm run foundry -- verify
npm run foundry -- plan --units 175 --seed pilot-1
npm run foundry -- plan --units 20 --seed tool-check --families tool-selection
npm run foundry -- plan --units 175 --k 3 --seed pilot-1
```

`plan` is deterministic and provider-free. `--units` sets the scenario-seed count;
`--k` sets realizations per seed (default 1). Plan rows are scheduled realizations,
**not generated training examples or measured model results**. The family mix
keeps a nonzero roleplay-retention tranche and separate tool-initiation and
argument-binding priorities.

To verify external sealed files as well:

```bash
npm run foundry -- verify --sealed-source /path/to/sealed-cases
```

The committed corpus has 106 dev and 107 sealed cases, with frozen identity
`22eb78976caa9ca91102f75576ea19eeb8cef8d594435275630542b7ddef8e58`.
Sealed content stays outside the repository.

## Current status: corpus exported, pilot still held

**No model training has run.** Calibration campaigns and a corpus campaign have
been dispatched, and their output has been exported under independent approval.

| Milestone | State |
|---|---|
| Public-context diagnostic (v8) | Run and decided: the intervention did **not** fix prose (0/4 vs 1/5 control) |
| Creative stream | Implemented, wired in, calibrated v1–v6 |
| Corpus campaign | **Complete**: 210 planned, 196 admitted, 48,920 admitted labels |
| Exported corpus | **155 train records / 39,435 supervised tokens**, approval `2abc5e6d…` |
| Frozen 175-seed `pilot-1` | **Still HELD** — see below |
| Model training | **Not run** |

The frozen pilot remains held because 22% of its rows are grounded narration,
which fails the style floor, and the one preregistered remedy was tested in v8 and
did not work. What ran instead was a **separately versioned re-weighted corpus
campaign** that never presents itself as `pilot-1` and leaves its frozen digests
byte-identical.

The blocker for *scale* is unchanged: **prose quality alongside factual
correctness**. The corpus is real and exported; the grounded-narration tranche is
mechanically sound but below the prose floor, and the creative stream is the
strongest answer to the roleplay goal at a measured **3/5** on a small independent
sample.

The public-context diagnostic was specified in
[`PUBLIC_CONTEXT_PROTOCOL.md`](PUBLIC_CONTEXT_PROTOCOL.md). It tested whether two
independently authored observations (an amber lamplight, closed shutters) let the
model write naturally without inventing facts. **They did not**, and no further
tuning against those frozen cases is authorized.

Full corpus identity and pins: [`CORPUS_EXPORT_V1.md`](CORPUS_EXPORT_V1.md).
Training instructions: [`COLAB_TRAINING_HANDOFF.md`](COLAB_TRAINING_HANDOFF.md).

Actual yields, blinded prose coverage and immutable artifact pins are in
[`CALIBRATION_RESULTS.md`](CALIBRATION_RESULTS.md); frozen campaign settings are
in [`CALIBRATION_PROTOCOL.md`](CALIBRATION_PROTOCOL.md); the chronological
remediation record is in [`CORRECTIONS_LOG.md`](CORRECTIONS_LOG.md).

### Adapter integrity status

The context adapter's source manifest and plan are frozen. Two independent
reviews have now been through it.

The **first** returned a HOLD on four reproduced defects, all fixed:
connector loss at a semicolon boundary; a mutable and copyable scene authority
that let a changed source or an upgraded control arm resolve under the original
pin; silent replacement of an invalid declared manifest digest; and schedule
drift. A related false contradiction was also corrected.

The **second** confirmed those four closed and the frozen digests reproducing,
then held on three further blockers, all fixed in `b41712b`:

1. **Style-driven regeneration.** A candidate that passed every functional
   validator but was refused by a review-quality floor triggered a generator
   repair, contradicting this protocol's "no style-based generation retries".
   The diagnostic now selects a `functional-only` repair policy: review and
   admission-quality refusals are terminal, while genuine functional failures
   still repair. Default callers are unchanged.
2. **Reviewer identity.** The repository runner accepted the environment's
   default reviewer instead of the preregistered Kimi K3. It now refuses any
   other reviewer before opening a store.
3. **Preflight crash.** `runPipeline` dereferences both client identities
   immediately, so the runner's preflight path threw. Clients are now built in
   both modes (no network call), and `dataset/scripts` is included in the foundry
   typecheck so the error class cannot recur.

The adapter review process completed and the diagnostic was **dispatched as v8**.
Its outcome is recorded: the observations were used in every observation-arm
output (integration works) but the arm passed **0/4** against a **1/5** control,
so the preregistered intervention is closed and no further prompt tuning against
those frozen cases is authorized. The frozen 175-seed pilot is held regardless,
and this branch remains a **checkpoint**.

The known present-tense check-grammar gap is **fixed**; the grounding validator
is now `grounding-binding-v7`.

Measurement tooling is durable in `dataset/scripts/`: the frozen diagnostic
caller, the blind-census collector, the journal-verified run summarizer and the
pinned prose-ledger freezer. Frozen inputs are preserved in `dataset/frozen/`.

```bash
npm run foundry -- generate --execute --units 175 --seed pilot-1
```

The measured CPU tokenizer bridge is available. Prepare its pinned local
environment/assets using [`tokenizer/README.md`](tokenizer/README.md), then run:

```bash
npm run foundry -- tokenizer-check --python .dataset/tokenizer/venv/bin/python
VELVET_REVIEWER_MODEL=kimi:k3 npm run foundry -- generate \
  --python .dataset/tokenizer/venv/bin/python --units 3
```

The second command is a zero-dispatch dry run. Missing/unconfigured tokenizer
assets still refuse before teacher calls. With `--execute`, the CLI opens or
resumes its own durable run store under `.dataset/runs/`. `--run-id` and
`--artifact-root` control that storage. See [`RUNNER.md`](RUNNER.md) for scheduling,
resume, twin inputs, independent approval and selected training export.

`runPipeline()` is the injectable orchestration API. With test transports it
exercises scenario realization, teacher completion, parsing/sanitization, family
gates, bounded repairs, independent review, certified admission, finalized
attempts, K scheduling and cluster-capped selection. `main()` accepts injectable ports for embedding. The configured production
port uses real final TRL labels; no test token counter ships as a CLI implementation.

Modules:

| Module | Responsibility |
|---|---|
| `src/generate.ts` | Planning, orchestration, supervised-token budget port, family gates and pilot report |
| `src/teacher.ts` | OpenAI-compatible relay client, bounded retries, usage, credential-free diagnostics |
| `src/twins.ts` | Typed anchor selection, one-fact mutations and contrast diagnostics |
| `src/selectiveTwins.ts` | Two receipt-conditioned preference pairs with reversed preferred answers |
| `src/admission.ts` | Canonical admission constructor and certificate verification |
| `src/runstore.ts` | Immutable attempts, supersession, certified reads, reservation/settlement primitives |
| `src/export.ts` | Atomic training JSONL export plus separate provenance/checksum manifests |
| `src/templateProfiles.ts` | Pinned model templates and measured-tokenizer export gate |
| `src/tokenizer.ts` | Local CPU tokenizer bridge, measured-profile loader and registry integration |
| `src/pipelineJournal.ts` | Durable request/response, validation-artifact and report checkpoints |
| `src/generationPolicy.ts` | Metadata-only attestation verification and generated lineage/split enforcement |
| `src/selection.ts` | Quality-ranked, cluster-capped selection with indivisible twin groups |
| `src/teacherRights.ts`, `rights/` | Inspected upstream training-use permission and operator-confirmed relay identity |
| `src/proseMeasurement.ts` | Frozen blinded inventories and independently pinned offline judgment ledgers |
| `src/preprocessExport.ts` | Checksummed export reload with exact selected SFT labels and explicit preference masks |
| `src/grounding.ts` | Typed receipt/sentence binding, scene-observation grammar and full-surface fail-closed verification |
| `src/publicSceneFacts.ts` | Frozen toy public-observation source, manifest validation and the runtime scene-authority boundary (opt-in diagnostic) |

### Teacher configuration

The selected teacher route is **RouteTok DeepSeek Flash through `agentrouter`**,
using the operator's funded credit balance. Provider cost measurement and billing
reservation/settlement are optional reporting, not prerequisites for the pilot.
The client still returns provider usage when available. Supervised-token counting
is a separate training-dataset requirement used for masked loss budgets and export.

The client reads `VELVET_TEACHER_BASE_URL`, `VELVET_TEACHER_API_KEY` and
`VELVET_TEACHER_MODEL` from the environment; the teacher model defaults to
`deepseek-v4-flash`. An existing `provider.agentrouter` configuration is a
fallback when endpoint/key environment settings are absent. Partial endpoint/key
settings refuse rather than silently selecting another route. Credentials are
never included in dataset artifacts.

Set `VELVET_REVIEWER_MODEL` to the explicitly selected independent reviewer.
The reviewer must differ from the **actual generator model**. `auto` and `best`
are not accepted reviewer selections because those routing aliases do not
identify an independent model. Client tests use injected transports only.

### Counterfactual twins

Use `buildSelectiveFidelityTwins()` for two prompt-conditioned arms:

1. Original facts: faithful answer chosen, changed-fact answer rejected.
2. Changed facts: changed-fact answer chosen, original answer rejected.

Both prompts contain their own public authoritative receipts. The common prompt
scaffold is held constant. Explicit counterfactual receipts must project to
exactly the recorded one-fact mutation. Both chosen responses must be grounded
under their own receipts, and both cross-prompt responses must demonstrate a
grounding violation. Anchor metadata stays in the sidecar.

The lower-level `buildTwinPair()` returns a single contrast and diagnostics; it
does not by itself materialize both conditioned arms. Neither builder grants
admission. Review and certify each arm before export, and keep the pair together
in its lineage, split and selection cluster. A prose-quality scorer must provide
the separate measurement. The offline loader in [`PROSE_MEASUREMENT.md`](PROSE_MEASUREMENT.md)
verifies actual blinded judgments, complete answer surfaces and pair parity;
absent evidence fails closed. Generated-data grades do not measure student retention.
The runner accepts `pairedTwins` draft inputs through its embedding API, verifies
their actual generator provenance, independently reviews each conditioned arm,
and selects both together. It counts both branches with their full prompt context.

The current preference validator imposes a word-count ratio of **1.05–1.5**.
This is a length heuristic, not a semantic-similarity measurement. Equal-length
minimal edits are currently refused. The behavioral contrast should come from
the fact change, not from mechanically padding a rejected answer.

### Pilot report interpretation

- `plannedPrompts`: diversity of scenario inputs, including dry runs.
- `beforeValidation`: actual teacher outputs and explicitly supplied twin drafts,
  including repair attempts.
- `afterValidation`: candidates that passed family gates.
- `afterRepair`: admitted outputs after the bounded attempt loop, including
  candidates that succeeded without repair.
- `afterSelection`: actual quality-ranked, cluster-capped selected outputs. Twin
  groups consume two slots and remain together. Default cap: eight records per
  cluster; `--cluster-cap` changes it. An embedding caller can also set a total cap.
- `admitted` and `selected` are separate counts. `selection` lists chosen unit IDs,
  exclusion reasons, cluster counts and the selection digest.
- `complete` is false for dry runs and budget pauses. Successful completion means
  all scheduled attempt loops finished; it does not mean every candidate passed.

Repeated answers therefore reduce output diversity even if prompts are varied.
Provenance records the real generation temperature and reviewer provider.

## Remaining work before a production run

The merged modules are exercised infrastructure, and a **corpus has been generated
and exported**. The frozen 175-seed pilot has still not run. Before a production
run:

- Use the measured Qwen3 profile and local tokenizer runtime. Actual mask/prefix
  evidence is committed and satisfies the template export gate; record/certificate
  approvals remain independently required.
- Choose the seed/K/selection policy. Resume/finalization, paired-twin scheduling,
  and attestation-bound generated splits are implemented and covered by crash,
  repair, selection and export integration tests. Training export includes only
  selected `train` records and requires an independently approved registry.
- Provider terms are captured in [`rights/README.md`](rights/README.md): DeepSeek
  permits training other models, and RouteTok is operator-controlled. The CLI
  binds `verified-permitted` evidence to the matching teacher route; embedding
  callers can explicitly supply `loadTeacherRights()`.
- Run independent blinded grading on actual calibration outputs. **4/8** remains
  an inherited numeric policy floor; historical raw stock answers have not been
  recovered in this checkout, so a controlled retention comparison is unestablished.
- The export reload API proves policy-bound SFT labels and emits explicit branch
  log-probability masks. The eventual DPO consumer must honor those masks; stock
  `DPOTrainer` compatibility has not been asserted or measured.

**The next experiment is not more generation.** It is a smoke-test LoRA on the
exported corpus against a same-runtime BF16 stock baseline, to answer whether the
direction works before spending more budget. See
[`COLAB_TRAINING_HANDOFF.md`](COLAB_TRAINING_HANDOFF.md). Then, if it holds up,
run the 150–200-seed pilot and inspect measured fidelity, repair rates, diversity
and prose retention before scaling. **No model training has been run.**

## Branch status

`feat/foundry-context-diagnostic` is a **checkpoint branch**. It carries the v7/v8
results, the public-context protocol and its closed decision, the typed scene-fact
source and grammar, the creative stream, and the exported corpus. The adapter's
review findings were closed and the diagnostic was dispatched and decided. The
175-seed pilot remains held regardless. **No model training has been run.**

## Validation

```bash
npm run typecheck:foundry
npm exec -- tsx --test --test-concurrency=1 dataset/test/cli.test.ts
npm exec -- tsx --test --test-concurrency=1 dataset/test/selectiveTwins.test.ts
npm exec -- tsx --test --test-concurrency=1 dataset/test/runner.test.ts
```

Use focused files during iteration. The full foundry suite is a serial wave-boundary
check: `npm run test:foundry`. See `BASELINE_SIGNAL.md`, `CORRECTIONS_LOG.md`, and
`eval/CORPUS_HANDOFF.md` for measured baseline results, fixes, and benchmark handoff.

Two checks are gated on the measured CPU tokenizer environment and skip without it:

```bash
FOUNDRY_TOKENIZER_PYTHON=/path/to/pinned/venv/bin/python npm run test:foundry
```

Latest recorded validation checkpoints:

| Check | Result |
|---|---|
| Full foundry suite, real CPU tokenizer (serial, handoff checkpoint) | **641 passed, 0 failed, 0 skipped** |
| Generator-v9 readiness (committed, serial) | 570 passed, 0 failed, 0 skipped |
| Public-context adapter, corrected, focused files (serial, real CPU) | 305 passed, 0 failed, 0 skipped |
| Parent re-probes of every reported bypass | 28/28 passed |
| Owning typecheck (`typecheck:foundry`) | passed |
| Context-diagnostic preflight (real CPU, six units) | 0 generation/review attempts |

The 175-seed K=3 plan schedules 525 rows; the six-row Flash/Kimi dry run makes zero
attempts. The corpus verifies through the CLI. These are infrastructure checks, not
teacher-generated data or model-quality scores.

Note on test counts: a *serial full-suite* checkpoint is 570 tests at the committed
generator-v9 tree. The public-context diagnostic adds new files, so its focused-file
count (592) is not comparable to the full-suite number. Only the most recent full
serial run is a whole-tree claim; everything else is a focused-file result.

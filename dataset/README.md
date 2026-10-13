# VelvetRP training-data foundry

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
```

`plan` is deterministic and provider-free. Its units are planned scenarios,
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

## Generation status

```bash
npm run foundry -- generate --execute --units 175 --seed pilot-1
```

This currently **refuses before resolving credentials or making teacher calls**:
the CLI has no production tokenizer port. The default is also a refusal for
`generate` without `--execute`; use `plan` for provider-free planning.

`runPipeline()` is the injectable orchestration API. With test transports it
exercises scenario realization, teacher completion, parsing/sanitization, family
gates, bounded repairs, independent review, certified admission, and persisted
attempts. `main()` accepts injectable ports for embedding; no test token counter
is shipped as a production CLI implementation.

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

### Teacher configuration

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
the separate regression measurement; its absent implementation fails closed.

The current preference validator imposes a word-count ratio of **1.05–1.5**.
This is a length heuristic, not a semantic-similarity measurement. Equal-length
minimal edits are currently refused. The behavioral contrast should come from
the fact change, not from mechanically padding a rejected answer.

### Pilot report interpretation

- `plannedPrompts`: diversity of scenario inputs, including dry runs.
- `beforeValidation`: actual teacher candidate outputs, including repair attempts.
- `afterValidation`: candidates that passed family gates.
- `afterRepair`: admitted outputs after the bounded attempt loop, including
  candidates that succeeded without repair.
- `afterSelection`: the currently admitted set. This is admission-based selection;
  the final multi-realization, cluster-capped selection policy is still to be wired.

Repeated answers therefore reduce output diversity even if prompts are varied.
Provenance records the real generation temperature and reviewer provider.

## Remaining live-pilot integration

The merged modules are exercised infrastructure; the live pilot has not run.
Before a production run:

- Supply pinned TRL/Transformers measurements for supervised-token counting,
  masks and prefix preservation. Export remains closed without that evidence.
- Wire provider reservation/settlement around **every** teacher/reviewer HTTP
  attempt, including retries and uncertain outcomes. `runPipeline()` currently
  tracks supervised tokens but does not call the run store's billing primitives.
  Supervised training tokens are not a provider-spend ledger.
- Complete orchestration resume/finalization, K-realization scheduling, paired-twin
  scheduling and cluster-capped selection. The primitives exist; the batch runner
  currently schedules one realization per unit.
- Bind generation's split plan to the ids/counts-only sealed attestation and
  enforce lineage disjointness across the planned batch. Corpus verification
  validates the frozen benchmark, not the generated scenario plan.
- Confirm provider training-use terms and run the independent prose-quality
  regression measurement. Generated provenance retains license `unverified`.

Then run the 150–200-seed pilot and inspect measured fidelity, repair rates,
diversity and prose retention before scaling. No training data has been generated.

## Validation

```bash
npm run typecheck:foundry
npm exec -- tsx --test --test-concurrency=1 dataset/test/cli.test.ts
npm exec -- tsx --test --test-concurrency=1 dataset/test/selectiveTwins.test.ts
```

Use focused files during iteration. The full foundry suite is a serial wave-boundary
check: `npm run test:foundry`. See `BASELINE_SIGNAL.md`, `CORRECTIONS_LOG.md`, and
`eval/CORPUS_HANDOFF.md` for measured baseline results, fixes, and benchmark handoff.

Latest integration validation: owning typecheck passed; **340 foundry tests passed,
0 failed**; the dev corpus verified through the CLI. These are infrastructure
checks with synthetic test transports, not teacher-generated data or model scores.

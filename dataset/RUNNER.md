# Foundry runner

## Scheduling and execution

```bash
npm run foundry -- plan --units 175 --k 3 --seed pilot-1
VELVET_REVIEWER_MODEL=kimi:k3 npm run foundry -- generate \
  --python .dataset/tokenizer/venv/bin/python --units 3 --k 2 --seed runner-check
```

The second command is a zero-dispatch dry run. Prepare the measured environment
as described in [`tokenizer/README.md`](tokenizer/README.md). Actual execution uses
`--execute` and opens an fsync-backed store under `.dataset/runs/<run-id>`:

```bash
VELVET_REVIEWER_MODEL=kimi:k3 npm run foundry -- generate --execute \
  --python .dataset/tokenizer/venv/bin/python --units 175 --k 3 \
  --seed pilot-1 --run-id pilot-1 --cluster-cap 8
```

Confirm provider training-use terms and obtain the independent prose-retention
measurement before the live pilot. Generated rights provenance currently says
`unverified`. The RouteTok credit balance is funded; provider billing accounting
is optional. Neither the implementation tests nor the tokenizer checks spend
teacher credit.

`--units` means scenario seeds. `--k` means realizations of each seed. K defaults
to one and supports at most 30 voice/beat combinations. Realizations preserve
scenario entity identities, receipts, lineage and split. Both tool-selection
allocation targets schedule their actual contracts: argument binding uses exact
candidates, while initiation covers narration submission, reading and legitimate
abstention. Public receipts/menus/contracts are rendered in the teacher prompt.
The certified training record retains that context and supervises only the new
assistant output.

## Resume and durable state

Repeat the same command/run identity to resume. The store config binds seed,
source version, actual generator, frozen corpus and generated split assignment.
The runner additionally pins the complete plan, tokenizer identity, reviewer,
temperature, repair limits, completion limit, K/twins, prose scorer identity and
selection caps. Drift refuses before new teacher calls.

For each provider call, the runner fsyncs a dispatch binding before calling the
client, then fsyncs the returned response before processing it. Resume reuses
completed responses, reviews and exact admitted certificates. It replays local
validation and token measurements to reconstruct the full report and supervised
spend. Newly committed admission/refusal callbacks are emitted once.
Checkpoint writes and provider dispatches renew the lease using the host wall
clock. A replaced holder cannot renew, dispatch, append or publish payloads, and
closing an old holder preserves its replacement's lease and snapshot.

A persisted dispatch with no returned response is **uncertain**. Resume stops
with `UncertainDispatchError`; it does not automatically send that call again.
This also covers a crash between the dispatch marker and network submission.
Reliable response evidence is needed to recover an uncertain call. Successful
HTTP-call retries inside the teacher client remain recorded in that client's
response metadata.

Each repair has a new immutable attempt ID and supersedes its parent. The original
RAW candidate, parsed output and refusal reason are retained. Admitted units and
exhausted pending-review units are finalized/completed explicitly. Budget-paused
units remain available for later attempts. A finished attempt loop can contain
refusals; `complete: true` is a lifecycle statement rather than a quality score.

The token ledger is rebuilt from durable attempts and measures final student
labels under loss. Review/admission refusals charge once. The teacher's completion
limit is a dispatch guard; actual student labels are checked before review and
admission. An overshoot is retained and charged as observed, then pauses the run.
It cannot be admitted merely because the teacher's max-token setting was small.
An operator may increase `--max-supervised-tokens` and resume a budget pause.
Provider token usage is separate from this ledger.
Supervised-budget policies are retained as checkpoints/audit notes. A cap below
already observed durable spend refuses before new calls.

## Split isolation

Generation reads `freeze.json` and the evaluator's ids/counts-only
`sealed-attestation.json`. It verifies the pinned corpus identity, attestation
digest, exact sealed IDs/counts and frozen lineage disjointness. It does not need
the dev or external sealed case files. The generated plan binds the policy digest
into its own split-assignment digest.

No generated unit may reuse a frozen evaluation ID or any frozen character,
world or scenario lineage field. Within the generated batch, each lineage field
must belong to one split. K realizations and twin arms stay together. Selection
rechecks certificate metadata, split assignment, scheduled context/tools and twin
branches against the plan. Export takes selected **train** records only; generated
dev/test rows remain available in the store/report.

## Paired-twin scheduling

Use the embedding API's `pairedTwins: ScheduledTwinInput[]` for previously authored
drafts. Each input supplies a `TwinCaseSpec`, explicit counterfactual receipts,
2–3 typed anchors, deterministic seed, and the actual drafts' generator identity
and temperature. Both prompt-conditioned preferences are built by
`buildSelectiveFidelityTwins()` and keep a common lineage, split and cluster.

A separate `proseQualityScorer` is required. Its measured rate must meet the
existing stock threshold, 4/8. The scorer's identity/version and measured result
are retained. No default score or evaluator is invented. Each arm is then reviewed
independently by the configured reviewer and admitted with evidence bound to that
arm's own preference payload. Both chosen and rejected branches are measured under
their complete prompt context. Prepared drafts dispatch reviews, not another
generation request; a refused draft needs a new reviewed draft input in a new run.

The existing preference length-ratio gate remains 1.05–1.5. It is a heuristic and
still rejects equal-length edits; the scheduled contrast must genuinely follow
the changed receipts rather than use length as its semantic distinction.

## Selection and export

`selectionPolicy` has `maxRecordsPerCluster` (default 8) and optional `maxRecords`.
Admitted groups are ranked by the minimum arm's mean independent-review scores,
with deterministic seeded ties. Caps count records, so twins need two slots.
Incomplete twin groups, over-cap groups and repeated payloads are excluded with
an explicit reason. `admitted`, `selected`, stage diversity and actual cluster
counts are reported separately. The selected identity set has a digest and a
durable checkpoint.

An independently approved `ExportTrainingOptions.approvedRegistry` is required
for export through `runPipeline({ ..., exportOptions })`. Approval can happen
after generation; a later invocation reuses the stored responses/certificates.
The runner never creates an approval registry from its own verdicts.

Approval inspection can use `inspectPipelineCheckpoint(store, key)` from
`src/pipelineJournal.ts`:

- `binding`: the immutable runner binding;
- `dispatch:<attempt-id>` / `response:<attempt-id>`: actual requests/responses;
- `validation:<attempt-id>`: stages, validator runs, measured tokens, source
  digests and the retained `artifactDigests`;
- `artifact:<sha256>`: exact canonical source/evidence bytes for registry approval;
- `prose:<unit-id>`: the measured twin prose-retention result;
- `selection`: selected identities, exclusions, counts and digest;
- `report:<budget-digest>`: the completed report for that supervised-budget policy.
- `budget:<budget-digest>`: the exact supervised-budget limits.

These local audit checkpoints remain outside trainer-visible messages. Reviewer
prompts are available in their dispatch records. The raw evidence/source artifacts
are retained once by digest, including plan, receipt/oracle and attestation
metadata, so independent approval can resolve the certificate hashes to bytes.

Export publication is atomic. Resume revalidates the approved registry and reuses
only a byte-identical, complete published bundle. Changed files, different input
records, absent approvals or unexpected files refuse reuse.

## Validation

```bash
npm run typecheck:foundry
FOUNDRY_TOKENIZER_PYTHON=/path/to/pinned/venv/bin/python \
  npm exec -- tsx --test --test-concurrency=1 \
    dataset/test/runner.test.ts dataset/test/generate.test.ts \
    dataset/test/cli.test.ts dataset/test/export.test.ts
```

These tests exercise actual fsync-backed stores, reopen/crash seams, repair chains,
uncertain dispatches, budget reconstruction/overshoot, atomic twin selection,
metadata-only isolation and selected-train export replay. With the Python variable
set, they also measure runner conversations and both twin branches using the
real pinned CPU tokenizer. All teacher/reviewer transports are provider-free test
fixtures; these checks produce no model-quality scores or live training dataset.

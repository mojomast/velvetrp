# First foundry pilot preregistration

This freezes the next pilot's inventory and measurement policy before its paid
requests. Execution depends on acceptable independently inspected v5 calibration
results plus acceptable focused grounding/tool and prose calibration; this document alone does
not claim those results exist.

## Generation inventory

- Run `pilot-2026-10-13-v1`; seed **`pilot-1`**, preserving the originally planned
  seed rather than selecting it from observed answer quality.
- **175 scenario seeds, K=3**, **525 scheduled realizations**. Keep scenario
  identities/receipts/lineage/split stable within each three-realization cluster.
- Plan digest for the frozen generator-v9 contracts:
  `f633ead229d265f97da0420fd0583dc7f8b21e6349fb5e150e7968a8b05233c2`.
  This supersedes the generator-v8 pre-dispatch digest
  `72da1f6f3ba2b207ca698e31a29c07d3c054a84f49c44310146f52a0e30a7a91`
  after revising value-free composition options. No pilot requests or observed
  answers preceded the update; seed, counts and split policy are preserved.
- Generated splits: **426 train, 51 dev, 48 generated test**. These generated
  test rows are separate from the externally held frozen evaluation corpus.
- Family rows: 117 grounded narration, 156 tool selection, 147 world generation,
  75 boundary recovery, 30 ordinary RP.
- Tool subtypes: 93 exact-candidate, 21 narration-submit, 24 read-tool, 18 no-tool.
- 114 planned clusters; selected-record cap eight per cluster. K repetitions
  and repairs remain dependent observations, never counted as independent seeds.
- Generator: funded RouteTok `agentrouter:deepseek-v4-flash`, disabled thinking,
  temperature 0.7, maximum response tokens 2048, up to two immutable content repairs.
- Independent admission reviewer: Kimi K3, fixed temperature omitted, low reasoning
  effort, 4096 response tokens, at most one output-contract retry on the same
  candidate. First usable verdict ends that retry loop. Unchanged generator
  answers cannot obtain another usable judgment.
- CPU Qwen3-8B bridge/policy, 4096 sequence limit, no truncation/packing/thinking,
  exact selected labels, default 4,000,000 supervised-token budget and its target
  caps. Actual spent labels include refused attempts and remain separate from
  optional provider billing.

## Measurement and selection

1. Retain every physical request, raw outcome, logical response, actual content
   repair, validator/reviewer result and source-bound certificate. Reconcile any
   interrupted dispatch before further work; unknown outcomes stop dispatch.
2. Freeze the complete ordinary-RP initial/actually dispatched repair census.
   Grade full captured surfaces in separate fresh, blinded GPT-6 Astra xhigh
    contexts. Lock style before semantic inspection/unblinding. Missing captures
    keep explicit missingness; fixture verdicts never enter reported measurements.
   Freeze and independently grade the separate `generated-grounded` initial and
   actual-repair census as well, including narration-submit tool scenarios. Its
   coverage and quality cannot substitute for ordinary-RP or twin-parity evidence.
3. Independently inspect actual admitted targets against their public contracts
   and private toy oracle. Inspect stratified refused targets for false refusals,
   repair regressions and unsupported claims. Keep style and functional findings
   separate, with actual inspected denominators.
4. Report initial-attempt and final scenario/realization yields, parsing/transport,
   tools/intent, world schema/reference closure, receipt fidelity, privacy/agency,
   masked-label spend, missingness, repair churn and cluster-capped diversity.
   Report family/subtype/split rates; do not infer student improvements from them.
5. Export only independently approved selected train records with complete source,
   certificate, validator-implementation and template evidence. Keep dev/generated
   test rows outside training. Pin exact published checksum bytes independently,
   then reload and materialize real input IDs/loss labels.

This pilot schedules ordinary SFT scenarios. No preference/twin drafts are added
implicitly, and no pair-parity score is claimed without actual independently
graded arms. A later preference campaign retains the authored-source and explicit
branch-mask requirements described in `RUNNER.md` and `PROSE_MEASUREMENT.md`.

## Interpretation and completion

The inherited 4/8 style floor is a policy threshold, not controlled stock retention.
Historical raw stock answers have not been recovered here. Hardware benchmarking
and subsequent student training are separate workstreams. This pilot changes no
model weights. Any discovered false admission or unresolved accounting holds
export/expansion pending a recorded correction; historical results stay immutable.

```bash
VELVET_REVIEWER_MODEL=kimi:k3 npm run foundry -- generate --execute \
  --python /path/to/pinned/venv/bin/python --units 175 --k 3 \
  --seed pilot-1 --run-id pilot-2026-10-13-v1 --cluster-cap 8
```

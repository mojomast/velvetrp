# Artifact to Devplan

## Retrieve through the authority boundary

When the user says decisions are ready:

1. Locate the compatible board/manifest through checkpoint aliases; do not expose or manually read prohibited private files.
2. Invoke the board's validated state module/API exactly as the board does. Never hand-parse JSON, scrape UI, trust screenshots, or consume readable export as authority.
3. Require exact persisted `ready=true`, then independently rerun schema/bounds, canonical encoding, digests, exact IDs/order, decision/blocker/readiness, references, and cycle checks.
4. Verify schema versions, state revision/timestamp, manifest/baseline digest, process/checkpoint compatibility, and safe state location.
5. Recompute the bounded baseline from [the lifecycle](workshop-lifecycle.md). Report unrelated drift separately. Relevant evidence drift stales Research/Generate/Retrieve/Plan, clears readiness, and requires affected-lane refresh plus user review/save.
6. Normalize exactly one canonical Approved Selection Snapshot from [the data contract](canonical-data-contract.md).

Absent/corrupt/unknown/lossily migrated state, false readiness, unanswered required choices, Need decision, blockers, cycles, unknown IDs, and relevant drift are hard stops.

## Select and order work

- Include implementation milestones only for enabled `Build` epics whose explicit approval, priority, and rationale remain valid.
- Record `Remove` and `Defer` with their reasons and dependency consequences.
- Exclude disabled work regardless of initial defaults.
- Never convert a recommendation, blank, note, or inferred preference into approval.
- Carry safe custom answers verbatim together with their recorded resolved interpretation and accepted risks; make implementation consequences explicit. A custom answer without a recorded interpretation is a hard stop, not material for inference.

Use the snapshot's frozen effective graph: epic prerequisites plus its `selectedOptionDependencies`, verified against `intentDigest` and the manifest. Do not recompute a different graph at plan time. Topologically sort it by reviewer-approved priority with manifest order as tie-breaker. Stop if included work depends on excluded work or selected options conflict; never silently re-include it.

Form milestones deliberately: default to one epic per milestone; group epics only when they share an owner and a change boundary and the grouping is justified in the plan. Discovery epics produced from `unknown` change-map entries remain separate milestones that gate the implementation work depending on them.

## Actionable milestones

Use [the devplan template](../templates/devplan-template.md). Each independently verifiable milestone carries the Intent Brief, demonstrated problem, outcome/acceptance criteria/IDs, topological basis, scope and non-goals, approved priority, selected product/security/integration rationale and accepted risks, confirmed/likely/unknown change map and shared hotspots, additive migration/backfill/flag/rollout/cleanup, command/event/read-model authority, focused tests and owning typecheck, security/operations/accessibility checks, authority documentation, verification evidence, rollback/recovery, coherent proposed commit, and a hard execution gate. Unknown boundaries that could materially affect implementation are discovery gates, not implementation claims.

Commits are proposals only unless explicitly authorized. Documentation is required for every milestone and final closeout. Update existing authority rather than duplicating status. Do not paste a long plan into a compact handoff; ask before replacing an authoritative compact document.

## Per-milestone execution gate

For later implementation, in dependency order and before any authorized commit:

1. Run focused tests and record exact results.
2. Run owning package/workspace typecheck from repository instructions, or verify no command exists.
3. Complete and inspect authority/product/operations documentation.
4. Inspect full diff/status; separate milestone-owned from pre-existing/unrelated paths and confirm the latter untouched.
5. Only when a commit is authorized and all checks pass, stage milestone-owned paths, inspect staged diff/path list, then commit one coherent boundary.

Stop on a failed, missing, or contradictory required check. A broad final gate never replaces focused per-milestone checks.

## Parallel ownership and final integration

Identify parallel-safe waves only after topological ordering. Give every owner exact stable IDs, path/component ownership, inputs/outputs, validation, and prohibited shared files. Serialize migrations, contracts, generated artifacts, central registries, and authority docs under one integrator. The final coordinator integrates in DAG order, reruns justified cross-cutting checks, reconciles docs, records residual risk, and confirms unrelated work remains untouched.

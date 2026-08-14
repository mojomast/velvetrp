# Canonical Data Contract

## Canonical JSON and shared scalars

Manifest, state, checkpoint, snapshots, and digest projections use one algorithm:

1. Accept only JSON null, booleans, NFC strings without lone surrogates, integers in JavaScript's safe range, arrays, and objects. Reject floats, negative zero, duplicate keys, and unknown keys.
2. Sort object keys by Unicode scalar-value sequence; preserve every array order.
3. Use minimal JSON quoting, lowercase `\u00xx` for controls without short escapes, shortest integers, UTF-8, no insignificant whitespace, and no trailing newline.
4. Hash exact bytes with SHA-256 as `sha256:<64 lowercase hex>`.

For a self-digest, omit only that named digest member before canonicalizing. Paths are slash-separated repository-relative strings without absolute roots, backslashes, NUL, empty/`.`/`..` segments. `repo-cwd` is `""` for root or a repository-relative path. Never serialize local absolute paths. Reject unknown fields everywhere.

```text
id := ASCII uppercase stable ID, length 3..64
epic-id := /^EPIC-[0-9]{3,}$/
decision-id := /^DEC-[0-9]{3,}$/
blocker-id := /^BLOCK-[0-9]{3,}$/
option-id := /^DEC-[0-9]{3,}-OPT-[0-9]{2,}$/
confidence := "high" | "medium" | "low"
disposition := "Build" | "Remove" | "Defer" | "Need decision"
priority := "P0" | "P1" | "P2" | "P3"
classification := "present" | "partial" | "missing" | "health" | "deferred"
```

Arrays have unique IDs and are authoritative in stored order. Never derive identity from titles/display order or reuse retired IDs.

## Typed evidence

Every evidence item has `id`, `type`, `capturedAt`, `baselineDigest`, `confidence`, `note` (0..1000), `redactedResult` (0..4000), and `resultTruncated`. Variants add:

```text
FileLineEvidence { type: "file-line", path: repo-path, startLine: integer>=1, endLine: integer>=startLine, revision: worktree|index-stage-0|index-stage-1|index-stage-2|index-stage-3|full-git-id, contentSha256: sha256 }
BinaryFileEvidence { type: "binary-file", path, revision, contentSha256 }
GitEvidence { type: "git-commit"|"git-diff", repository: "local", commit: full-git-id, baseCommit: full-git-id|null, path: repo-path|null, contentSha256: sha256 }
CommandEvidence { type: "command-output", argv: [redacted-string], cwd: repo-cwd, exitCode: integer(-1..255), outputSha256: sha256, maxBytes: integer(1..65536) }
UrlEvidence { type: "external-url", url: absolute-http(s)-url, publisher: string, publishedAt: rfc3339-utc|null, accessedAt: rfc3339-utc, revision: string, contentSha256: sha256 }
```

Line evidence requires real bounds. Binary evidence is whole-file. History claims use Git evidence. Commands contain only bounded redacted output as defined in [the lifecycle](workshop-lifecycle.md). Purely subjective recommendations need no fictitious citation, but factual premises do.

## Canonical manifest

```text
Manifest {
  schemaVersion: 1, manifestVersion: integer(1..2147483647), generatedAt: rfc3339-utc,
  project: ProjectMetadata, intent: IntentBrief,
  researchBaseline: ResearchBaseline, baselineDigest: sha256, manifestDigest: sha256,
  limits: { overallNotesMax: integer(1..8000), epicNotesMax: integer(1..2000), decisionCustomMax: integer(1..2000), blockerNoteMax: integer(1..2000) },
  evidence: [Evidence](0..4096), epics: [Epic](0..512), decisions: [Decision](0..256), blockers: [Blocker](0..256)
}
IntentBrief {
  problem: string(1..2000), affectedActors: [string](1..32), successSignals: [string](1..32),
  constraints: [string](0..32), nonGoals: [string](0..32), horizon: string(1..300)
}
ProjectMetadata {
  displayName: NFC string(1..120), slug: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ length(1..80)
}
Epic {
  id: epic-id, title: string(1..120), summary: string(0..1000), problem: string, outcome: string, acceptanceSignals: [string](1..32), classification,
  evidenceIds: [id](1..64), evidenceMap: { observation, hypothesis, intervention, uncertainty }, dependsOnEpicIds: [epic-id](0..64), requiredDecisionIds: [decision-id](0..64),
  initialEnabled: true, initialDisposition: "Build", suggestedPriority: priority,
  priorityScore: integer(-2..10),
  priorityBreakdown: { impact: 0..3, riskReduction: 0..3, unblocks: 0..2, confidence: 0..2, costPenalty: -2..0 },
  effort: "XS"|"S"|"M"|"L"|"XL"|"unknown", horizon: string, externalDependency: string|null,
  scope: [string](1..64), exclusions: [string](0..64), risks: [string](0..64), changeMap: [{ boundary, confidence: "confirmed"|"likely"|"unknown", reason }]
}
Decision {
  id: decision-id, title: string, prompt: string, required: boolean,
  dependsOnDecisionIds: [decision-id](0..64), evidenceIds: [id](1..64), options: [Option](2..4),
  recommendedOptionId: option-id, recommendationRationale: string,
  customAnswer: { allowed: boolean, maxLength: integer(1..2000), validation: "nonblank-trimmed"|"single-line"|"multiline" }
}
Option {
  id: option-id, label: string, implementationShape: string,
  benefits: [string](1..16), costsAndRisks: [string](1..16), migrationAndOperations: string, evidenceIds: [id](1..64), dependsOnEpicIds: [epic-id](0..64), incompatibleOptionIds: [option-id](0..64)
}
Blocker {
  id: blocker-id, title: string, detail: string, epicIds: [epic-id], decisionIds: [decision-id], evidenceIds: [id](1..64),
  resolutionPredicate: "manual-resolution"|"all-decisions-answered"|"epics-disabled"
}
```

`project` is explicit generation input. It defaults to `Repository Planning Workshop` / `repository-planning-workshop` unless the user intentionally supplies both values; board identity, export, persistence, UI copy/assets, and evidence-derived roadmap content use it as specified in [the board contract](board-spec.md). `manifestDigest` omits itself. `baselineDigest` equals the validated baseline self-digest. Validate all references, option membership/prefixes, bounds, and unique exact order. Epic and decision graphs are DAGs; manifest order breaks topological ties. `priorityScore` equals impact + riskReduction + unblocks + costPenalty (confidence is reported separately and never raises priority) and maps `7..8=P0`, `4..6=P1`, `2..3=P2`, otherwise `P3`. The generator emits `decisions` in topological order so reviewers answer prerequisites first.

## Canonical saved state

```text
SavedState {
  schemaVersion: 1, baselineDigest: sha256, manifestDigest: sha256, stateDigest: sha256,
  revision: integer(1..9007199254740991), updatedAt: rfc3339-utc, ready: boolean,
  intentAcknowledged: boolean,
  epics: [EpicAnswer](exact manifest order), decisions: [DecisionAnswer](exact order), blockers: [BlockerAnswer](exact order),
  overallNotes: string(0..limits.overallNotesMax)
}
EpicAnswer { id: epic-id, enabled: boolean, disposition, dispositionReason: string(0..1000), approvedPriority: priority|null, approvalRationale: string(0..1000), notes: bounded-string }
DecisionAnswer { id: decision-id, selectedOptionId: option-id|null, customAnswer: bounded-string|null, selectionRationale: string(0..1000), acceptedRisks: string(0..1000), notes: string(0..1000) }
BlockerAnswer { id: blocker-id, resolved: boolean, resolutionNote: bounded-string }
```

The server/state boundary owns revision, timestamp, readiness, and `stateDigest`; clients cannot force them. Initial state uses exact manifest order, enables every epic as Build, leaves decisions unselected, blockers unresolved, and notes blank. Recommendations never initialize selection. A no-write GET may synthesize revision `0` solely as the optimistic predecessor for first save; it is not a `SavedState`. The first persisted save is revision `1`, and validation of persisted state rejects revision `0`.

`selectedOptionId` is the authoritative predefined selection. `customAnswer=null` means Custom has not been selected; a non-null custom string records the selected/draft Custom control. Blank/whitespace Custom is valid and saveable but is unanswered. A retained custom draft may coexist with a predefined selection so switching controls does not destroy user input; the predefined selection is then authoritative. A nonblank custom answer must be allowed, bounded, and satisfy line policy. A selected nonblank Custom answer additionally requires `selectionRationale` recording the resolved interpretation and affected epics, and an `acceptedRisks` record, even when the decision is optional. A decision is currently required when declared required, referenced by an enabled Build epic, or depended on by another required decision. `Remove` and `Defer` need reasons; enabled `Need decision` is never ready. Disabled epics remain stored but do not enter implementation dependencies.

A blocker predicate is satisfied only when its declared decision/epic/manual condition is true; resolution additionally requires `resolved=true` and a nonblank note. Contradictory resolutions are invalid.

`ready=true` iff schemas/digests/revision/order validate; the reviewer acknowledged the Intent Brief; enabled epics have final dispositions; every Build epic has reviewer-approved priority and rationale; Build and selected-option dependencies are satisfied; required decisions have a selection rationale and accepted-risk record; no incompatible options are selected; blockers are inactive; references resolve; both DAGs are acyclic; and no orphan answer exists. An explicitly approved empty Build scope may be ready. Recompute this exact predicate on every save/load.

Persist with optimistic expected revision, strict content type/body limits, no-follow opens where supported, post-open metadata checks, handle writes, temporary-file fsync, close, validated owner-only backup preservation, same-directory atomic replacement, and containing-directory fsync where supported. Clean only owned temporary names and retain/recover prior valid state after failed publication. Reads do not write. Unknown versions or digest mismatch stop. Migration is explicit, one-version, lossless, backup-preserving, and fully revalidated. A manifest change always clears readiness and requires review/save.

## Approved selection snapshot

Retrieve creates one immutable Plan input from fully validated `ready=true` state:

```text
ApprovedSelectionSnapshot {
  schemaVersion: 1, manifestDigest: sha256, baselineDigest: sha256, intentDigest: sha256,
  sourceStateRevision: safe-integer, sourceStateDigest: sha256,
  epics: [EpicAnswer](exact order), decisions: [DecisionAnswer](exact order),
  blockers: [{ id: blocker-id, resolved: true, resolutionNote: nonblank-string }](exact order),
  overallNotes: bounded-string,
  selectedOptionDependencies: [{ optionId: option-id, dependsOnEpicIds: [epic-id] }],
  snapshotDigest: sha256
}
```

Copy values exactly—no trimming, inference, recommendation substitution, or label expansion. `intentDigest` hashes the manifest Intent Brief so Plan detects intent drift. `selectedOptionDependencies` freezes the option-derived epic prerequisites the reviewer approved; Plan consumes this exact effective graph instead of recomputing a different one. `snapshotDigest` omits only itself. The canonical snapshot is the sole Retrieve output consumed by Plan.

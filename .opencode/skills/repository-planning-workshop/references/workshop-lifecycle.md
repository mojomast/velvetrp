# Workshop Lifecycle and Provenance

## Private state location

Operational checkpoints and canonical saved decisions are private state, not repository content. Default to the platform's user state directory, keyed by a repository identity digest:

- Linux/WSL: `${XDG_STATE_HOME:-$HOME/.local/state}/repoworkshop/<repository-id>/`
- macOS: `$HOME/Library/Application Support/RepoWorkshop/<repository-id>/`
- Windows native: `%LOCALAPPDATA%\RepoWorkshop\<repository-id>\` only when the harness implements all safe equivalents described below.

Compute `repository-id` as SHA-256 over canonical JSON `{ "remote": <normalized primary remote or null>, "rootIdentity": <stable non-secret repository identity> }`. Prefer a normalized primary remote plus initial/root commit identity. If there is no remote, use a digest of the canonicalized repository root for local identity, but never expose that absolute path in exports, reports, or URLs.

Never mutate `.git`. A repository-local state adapter is permitted only after explicit user choice, proof that the directory is already ignored (`git check-ignore`), and symlink/escape checks; do not add an ignore rule without permission. Store `checkpoint.json`, canonical board state, snapshots, logs, and process records in owner-only subdirectories. Reports may use `user-state:<repository-id>/...` aliases instead of absolute paths; reveal a local absolute path only when needed to operate the process, never in export/public artifacts.

On POSIX require owner-only modes (`0700` directories, `0600` files), same-directory temporary files, exclusive creation, flush when supported, and atomic rename. Reject symlinks at every path component and revalidate containment immediately before open/rename to limit path races. Windows-native implementations must document equivalents for ACLs, reparse-point rejection, atomic replacement, interface detection, and process identity. Otherwise stop before state writes or hosting.

## Checkpoint envelope

The checkpoint is operational metadata, not planning authority:

```text
Checkpoint {
  schemaVersion: 1,
  workshopId: string(1..80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  repositoryId: sha256,
  createdAt: rfc3339-utc,
  updatedAt: rfc3339-utc,
  baseline: ResearchBaseline | null,
  phases: { research: Phase, generate: Phase, host: Phase, retrieve: Phase, plan: Phase }
}
Phase {
  status: "not_started" | "running" | "complete" | "stale" | "failed" | "interrupted",
  startedAt: rfc3339-utc | null,
  completedAt: rfc3339-utc | null,
  inputDigest: sha256 | null,
  outputDigest: sha256 | null,
  outputs: [Output](0..64),
  detail: string(0..2000)
}
Output { path: safe-logical-path, kind: string(1..40), sha256: sha256, bytes: integer(0..9007199254740991) }
sha256 := "sha256:" + 64 lowercase hexadecimal characters
```

Reject unknown keys, malformed timestamps, duplicates, invalid bounds, noncanonical JSON, and paths outside approved boundaries.

## Research baseline

Capture after defining exclusions and before research. Never open or hash secrets, credentials, persisted personal/private content, prohibited paths, or Git objects known to contain them. If excluded content is required evidence, stop.

Preflight capture is metadata-only: HEAD, branch, complete porcelain status, exclusions, and only command evidence actually needed to establish the baseline. Do not inspect recent history, read authority/source content, hash clean files, or populate speculative command evidence before delegation. Hash dirty revisions only if a lane uses them as evidence; hash clean evidence files only when promoted into synthesis or a phase projection requires them.

```text
ResearchBaseline {
  capturedAt: rfc3339-utc,
  head: full-lowercase-git-object-id,
  branch: string(1..255) | null,
  status: [StatusEntry](0..4096),
  dirtyEvidence: [DirtyEvidence](0..2048),
  exclusions: [repo-path](0..256),
  commandEvidence: [CommandEvidence](0..128),
  digest: sha256
}
StatusEntry { path: repo-path, index: git-status-code, worktree: git-status-code, originalPath: repo-path | null }
DirtyEvidence {
  path: repo-path,
  originalPath: repo-path | null,
  status: "modified" | "added" | "untracked" | "deleted" | "renamed" | "copied" | "unmerged",
  media: "text" | "binary" | "absent",
  revision: "worktree" | "index-stage-0" | "index-stage-1" | "index-stage-2" | "index-stage-3" | "HEAD",
  bytes: safe-integer,
  sha256: sha256 | null,
  absence: "present" | "deleted" | "renamed-source-absent" | "stage-absent"
}
CommandEvidence {
  argv: [redacted-string](1..64), cwd: repo-cwd, capturedAt: rfc3339-utc,
  baselineHead: full-git-id, exitCode: integer(-1..255), maxBytes: integer(1..65536),
  result: redacted-string(0..65536), truncated: boolean, sha256: sha256
}
```

Use porcelain status with rename information and include every status path. Sort by path bytes then original-path bytes. Stop rather than truncate if bounds are exceeded. For every dirty path actually used as evidence, hash each inspected revision's raw bytes. Record deletions/renames and index/worktree identity accurately. For unmerged evidence, independently record stages 1/base, 2/ours, and 3/theirs, including absent stages; never substitute another revision.

Bound command output before it enters evidence: combine output deterministically, redact secrets first, retain at most the declared UTF-8 byte count without splitting a code point, then hash exactly the retained redacted bytes. Arguments containing secrets are never evidence.

Compute `baseline.digest` with `digest` omitted. Before Generate and Retrieve, compare HEAD, branch, complete status, authority files, and each evidence revision/hash/absence without reading exclusions:

- Changed evidence, authority, or command premise makes affected Research stale; refresh those lanes and invalidate downstream choices/readiness.
- New or changed dirty paths not used as evidence are unrelated drift unless dependency analysis proves relevance. Report them separately without reading or modifying them.
- HEAD/branch changes require path-level relevance analysis. Unresolved relevance is a hard stop.

## Deterministic phases

Canonicalize and digest exactly these validated projections. Preserve declared array order; sort only fields explicitly marked sorted. No timestamp or checkpoint status participates.

```text
FileDigest { path: repo-path, sha256: sha256 }
ToolVersion { name: string, version: string }
ResearchInput { schemaVersion: 1, scope: [string], included: [repo-path], excluded: [repo-path], prohibited: [repo-path], instructions: [FileDigest sorted], authorities: [FileDigest sorted], intentDigest: sha256, baselineDigest: sha256 }
GenerateInput { schemaVersion: 1, researchOutputDigest: sha256, contracts: [FileDigest sorted], toolVersions: [ToolVersion sorted] }
HostInput { schemaVersion: 1, generateOutputDigest: sha256, stateRevision: safe-integer | null, stateDigest: sha256 | null, bind: { address: exact-ipv4, port: integer(1..65535) }, capabilityDigest: sha256 }
BaselineComparison { baselineDigest: sha256, currentHead: full-git-id, currentBranch: string | null, relevantChanges: [repo-path sorted], unrelatedChanges: [repo-path sorted], verifiedDirtyEvidence: [{ path, revision, absence, bytes, sha256 }] }
RetrieveInput { schemaVersion: 1, generateOutputDigest: sha256, stateRevision: safe-integer, stateDigest: sha256, baselineComparison: BaselineComparison }
PlanInput { schemaVersion: 1, retrieveOutputDigest: sha256, selectionSnapshotDigest: sha256, template: FileDigest, authorities: [FileDigest sorted] }
```

Each phase's `outputDigest` hashes its complete ordered `outputs` array. Research covers bounded lane/synthesis records; Generate covers manifest and complete board artifact; Retrieve contains exactly one approved-selection snapshot; Plan exactly one devplan. Host may have no durable outputs, but still hashes `[]` and must have a live identity-checked process. `intentDigest` hashes the confirmed Intent Brief; editing intent stales Research and its transitive dependents.

Chat-only Research with no resume request may keep its baseline and findings in-session without a durable checkpoint. Otherwise create a minimal `running` checkpoint before a durable phase, then fill complete inputs, outputs, hashes, and byte counts when publishing validated output. Do not compute Generate/Host/Retrieve/Plan projections before their inputs exist. A checkpoint from another repository identity may be rejected from envelope metadata alone; do not open its state, logs, or outputs to prove irrelevance.

Dependencies are `Research -> Generate -> Retrieve -> Plan`; Host depends on Generate as an ephemeral side branch. Set a phase `running` and save atomically before work. Publish only complete validated output, then mark complete. Convert abandoned `running` phases to `interrupted`. Invalidate transitive dependents on input changes. A process exit stales Host only.

Accept known schema versions only. Migrate one version at a time using deterministic lossless transforms, a preserved backup, full revalidation, and an explicit record. Any manifest digest change clears readiness and requires user review/save; never rewrite compatibility fields merely to match.

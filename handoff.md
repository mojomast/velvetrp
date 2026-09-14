# Handoff

## Current Baseline

- Commit `2896613` is the pushed `main`/`origin/main` baseline. The committed tree contains the completed playability program plus the browser-playable client surfaces described below.
- Persistence: one current disposable development schema; schema changes require deleting/recreating `velvet.sqlite` except for narrowly recognized exact tactical-map, campaign-director, and pre-recall predecessors. Director upgrades also recognize exact review-authority/narration predecessors, preserving historical rows and cancelling pending planning/approval runs during the review-authority upgrade. The third SQL asset adds immutable adventure narration dispatch context; exact older director/map upgrades install it within their validated transaction when absent. Complete startup validation precedes commit and failure rolls back; every other unknown or partially upgraded schema rejects without repair.
- HTTP: 152 counted explicit trusted-local RPG operations plus separately classified feature discovery; implicit HEAD aliases are excluded.
- Security: the server remains loopback-only with fixed `local-owner`. Feature flags and local ownership are not authentication or remote-safe authorization.
- Authorities: runtime code/contracts own behavior, `docs/api.md` owns HTTP documentation, `docs/operations.md` owns disposable-data/configuration guidance, `docs/repo-architecture.md` owns persistence structure, and `docs/ROADMAP.md` owns milestone status.

## Delivered

### Living Atlas, AI Director, memory, and knowledge

The Living Atlas control plane, grounded combat maps and recovery, reviewed campaign preparation, and a persisted human/AI campaign director are complete. The Director composes ordered one-to-three-candidate beats with per-candidate receipts and partial-completion blockers, runs bounded read-only grounding rounds, records world-time advancement and ambient transition beats, narrates present-NPC ledger knowledge with attribution, and keeps prior-scene continuity explicitly non-authoritative. Plan 4 added an immutable `agent_observations` ledger for witnessed/told/faction/town-gossip knowledge with trust-gated reads and a provider-free attribution/privacy/negation/disclosure evaluator. Plan 3 added direct, source-attributed SQLite recall under strict query/hit/packet caps, immutable narration dispatch provenance, GM-only no-replay context inspection, and the measured `now`/`current` ranking correction. See `docs/ai-dungeon-master.md`, `docs/frontend-control-plane.md`, `docs/campaign-memory.md`, and `docs/npc-knowledge-rumors.md`.

### Browser-playable character and system surfaces

The client now reaches the deterministic mechanics that previously existed behind HTTP and repository lanes:

- Character sheet actions: server-resolved checks, powers and spells, conditions and effects, resource tracks, rests, equipment, and progression.
- Economy: present-vendor sale (server-issued quote then `sell_to_shop`) and bilateral trade accept/cancel from the sheet.
- World: owner/GM expedition actor placement and camp.
- Cast: companion creation plus exact grant creation/revocation.
- Combat: reviewed encounter generation and explicit application.
- Campaign administration: room detach/attach reconciliation.

`e2e/tests/character-surfaces.spec.ts` covers all of the above through the real client, HTTP layer, and disposable SQLite. The deterministic E2E gate is green at 56/56; live-provider and authenticated multi-user coverage are still not claimed.

### Providers and recovery

Dotted provider tool-name wire encoding, `reasoning_effort: "none"` for bounded single-tool calls, and narration-quality fallback fixes are committed. The human-player simulation and live Director playtest harnesses are available under `scripts/` and are capped and owner-authorized. No automatic paid retries, model fallback, or repair loops exist.

## Next Task

Scope the closed declarative rules IR milestone with exact consumers, contract boundaries, current-schema impact, and exclusions before implementation. Do not promote live exact-candidate generation/selection HTTP, delegated companion grant exercise and dismissal, remote tenancy, or M5.5 persistence implicitly.

Candidate follow-ups, in rough priority:

- Broaden live/Director quality evidence or add multi-controlled-actor browser coverage.
- Add non-mutating terrain/layout preview and supported enemy-token repositioning.
- Add server-side idempotency or exact receipt discovery for persona and room creation so browser recovery locks become cross-device guarantees.

## Working Tree

`.opencode/skills/seed-test-campaign/` and `server/test/two-player-gameplay-api.test.ts` remain intentionally untracked and must not be staged. There is no uncommitted runtime work as of this handoff.

## Pre-Existing Test Failures

These failures predate the current work and are not caused by it: `campaign-recall.test.ts` (missing `adventure_narration_contexts`), `tactical-map-generation.test.ts` (foreign key), `m4-agent-acceptance.test.ts` (`historicalRecall` rendering), `api-provider.test.ts` (RouteTok baseUrl reason string), and environment "database is locked" flakes in `repo.test.ts`, `campaign-session-attachment*.test.ts`, `content-queries.test.ts`, `campaign-character-creation.test.ts`, and `initialize-actor-resource-command.test.ts`. Do not "fix" these as part of unrelated work.

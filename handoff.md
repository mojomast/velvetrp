# Handoff

## Current Baseline

- Persistence: one current disposable development schema; schema changes require deleting/recreating `velvet.sqlite` except for narrowly recognized exact tactical-map and campaign-director predecessors. Director upgrades also recognize exact review-authority/narration predecessors, preserving historical rows and cancelling pending planning/approval runs during the review-authority upgrade. Complete startup validation precedes commit and failure rolls back; every other unknown or partially upgraded schema rejects without repair.
- HTTP: 144 counted explicit trusted-local RPG operations plus separately classified feature discovery; implicit HEAD aliases are excluded.
- Security: the server remains loopback-only with fixed `local-owner`. Feature flags and local ownership are not authentication or remote-safe authorization.
- Authorities: runtime code/contracts own behavior, `docs/api.md` owns HTTP documentation, `docs/operations.md` owns disposable-data/configuration guidance, `docs/repo-architecture.md` owns persistence structure, and `docs/ROADMAP.md` owns milestone status.

## Current Work: Living Atlas and AI DM

Accumulated work adds the Living Atlas control plane, grounded combat maps and recovery, reviewed campaign preparation, and a persisted human/AI campaign director separate from the player adventure agent. The GM Director drawer supports named objective/encounter scene bindings. Structured atmosphere/dialogue/question narration is non-authoritative and never becomes canonical memory. See `docs/frontend-control-plane.md`, `docs/ai-dungeon-master.md`, and `docs/campaign-generation.md` for scope and remaining limits.

### Current Validation

- Contracts: all 422 pass.
- Client full run: 792 passed, with one content test timing out under load; its focused rerun passed all 5 tests. This is not an uninterrupted full-green run.
- Targeted server run: 71 passed, with one documentation timeout; the focused rerun passed all 7 tests. The full server suite was not rerun after a prior 15-minute timeout; no current full-server green claim is made.
- `npm run typecheck`: all workspaces pass.
- Final focused E2E: all 12 director/control-plane/combat-map/session-recovery tests pass.
- Documentation inventory: 144 counted explicit operations plus separately classified feature discovery; the strict documentation drift check is known passing.

These are the supplied accumulated-work validation results, not fresh full-suite runs from the docs-only audit. Before commit, select intended files explicitly: `.opencode/skills/seed-test-campaign/` and `server/test/two-player-gameplay-api.test.ts` must remain untracked. The audit does not stage or commit files.

## Prior Completed: Test-only corruption fixture repository seam

Added explicit internal database and repository factories that retain normal owned-connection setup while skipping only current-schema validation, plus a server test helper. Deliberate corruption reopenings were migrated while startup rejection coverage remains strict.

## Previously Recorded Next Task: Declarative rules IR scoping

Scope the closed declarative rules IR milestone with exact consumers, contract boundaries, current-schema impact, and exclusions before implementation. Do not promote live exact-candidate selection, companion grant exercise, remote tenancy, or other later work implicitly.

## Context

Production repository opens still perform exact current-schema, quick-check, and foreign-key validation. Deliberately malformed domain fixtures now opt into `createCorruptionTestRepository`; schema creation and explicit startup-rejection tests continue to use `createRepository`.

## Files Modified

The seam is in `server/src/repo/db/connection.ts` and `server/src/repo/campaignRepositoryOrchestration.ts`; the test entry point is in `server/test/helpers.ts`. Corruption-focused server tests were updated to use it only after deliberate fixture damage.

## Historical Seam Validation

At the earlier corruption-fixture seam checkpoint, server typecheck passed; the full server suite passed with 2,102 tests passing and one skipped. `git diff --check` passed. This historical result does not validate the accumulated Living Atlas/director changes above.

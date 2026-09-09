# Handoff

## Current Baseline

- Persistence: one current disposable development schema; schema changes require deleting/recreating `velvet.sqlite` except for narrowly recognized exact tactical-map, campaign-director, and pre-recall predecessors. Director upgrades also recognize exact review-authority/narration predecessors, preserving historical rows and cancelling pending planning/approval runs during the review-authority upgrade. The new third SQL asset adds immutable adventure narration dispatch context; exact older director/map upgrades install it within their validated transaction when absent. Complete startup validation precedes commit and failure rolls back; every other unknown or partially upgraded schema rejects without repair.
- HTTP: 144 counted explicit trusted-local RPG operations plus separately classified feature discovery; implicit HEAD aliases are excluded.
- Security: the server remains loopback-only with fixed `local-owner`. Feature flags and local ownership are not authentication or remote-safe authorization.
- Authorities: runtime code/contracts own behavior, `docs/api.md` owns HTTP documentation, `docs/operations.md` owns disposable-data/configuration guidance, `docs/repo-architecture.md` owns persistence structure, and `docs/ROADMAP.md` owns milestone status.

## Pushed Baseline: Living Atlas and AI DM

Accumulated work adds the Living Atlas control plane, grounded combat maps and recovery, reviewed campaign preparation, and a persisted human/AI campaign director separate from the player adventure agent. The GM Director drawer supports named objective/encounter scene bindings. Structured atmosphere/dialogue/question narration is non-authoritative and never becomes canonical memory. See `docs/frontend-control-plane.md`, `docs/ai-dungeon-master.md`, and `docs/campaign-generation.md` for scope and remaining limits.

Commit `11e0107` (`feat(rpg): add Living Atlas and AI campaign director`) is the pushed `main`/`origin/main` baseline. Memory changes described below remain uncommitted on top of it.

### Baseline Validation

- Contracts: all 422 pass.
- Client full run: 792 passed, with one content test timing out under load; its focused rerun passed all 5 tests. This is not an uninterrupted full-green run.
- Targeted server run: 71 passed, with one documentation timeout; the focused rerun passed all 7 tests. The full server suite was not rerun after a prior 15-minute timeout; no current full-server green claim is made.
- `npm run typecheck`: all workspaces pass.
- Final focused E2E: all 12 director/control-plane/combat-map/session-recovery tests pass.
- Documentation inventory: 144 counted explicit operations plus separately classified feature discovery; the strict documentation drift check is known passing.

These are the supplied accumulated-work validation results, not fresh full-suite runs from the docs-only audit. Before commit, select intended files explicitly: `.opencode/skills/seed-test-campaign/` and `server/test/two-player-gameplay-api.test.ts` must remain untracked. The audit does not stage or commit files.

## Current Work: Bounded Campaign Memory

The working tree adds source-attributed direct SQLite recall, immutable epistemic prompts, independently bounded recent history, assembly/dispatch integration, and the `adventure_narration_contexts` sidecar in `recallSchema.sql`. This sidecar freezes dispatched narration context/request; it is not searchable memory or new campaign truth. Exact pre-recall migration preserves durable data, and recognized director/map predecessors retain their existing upgrade semantics.

Actual recall limits: normalized query at most 512 UTF-16 code units/1,024 UTF-8 bytes, 12 terms, 64 matching materialized candidates, eight whole hits, 2,048 bytes per source text, and 6,144 bytes per complete JSON packet. Recent adventure history remains separately two complete exchanges/4,000 bytes. Existing aggregate provider guards still apply. SQL scan cost is unbounded; no FTS, vector vendor, automatic summary, alias expansion, or pronoun resolver is implemented. Public actor names participate only in literal matching. Most historical sources are active-timeline-only; inherited core events require explicit timeline inclusion.

Read `docs/campaign-memory.md` for actual source coverage and scope, and `docs/memory-framework-evaluation.md` for research proposals that are not implementation claims. Review fixed recovery-before-recall validation and actor filtering after transcript limits; committed receipt recovery remains independent of fresh execution.

Final memory validation: 180 tests passed across ten focused server files, including recall, prompts, context, check recovery, adventure orchestration/routes, director migration/narration/recovery, and documentation drift. `npm run typecheck` passed for all workspaces. Eight deterministic browser tests passed across memory, director, and desktop/mobile control-plane flows. The memory test recalls an exchange behind 105 distractors through real HTTP/disposable SQLite, excludes private actor/GM material, and proves reload adds no provider calls. Environment save/restore uses explicit accesses; the strict documentation scanner remains unchanged. No live-model quality evaluation or full server-suite claim is made. Memory changes remain uncommitted.

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

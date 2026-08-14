# Handoff

## Current Baseline

- Persistence: one current disposable development schema; schema changes require deleting/recreating `velvet.sqlite`, and startup never upgrades older databases.
- HTTP: 111 counted explicit trusted-local RPG operations plus separately classified feature discovery; implicit HEAD aliases are excluded.
- Security: the server remains loopback-only with fixed `local-owner`. Feature flags and local ownership are not authentication or remote-safe authorization.
- Authorities: runtime code/contracts own behavior, `docs/api.md` owns HTTP documentation, `docs/operations.md` owns disposable-data/configuration guidance, `docs/repo-architecture.md` owns persistence structure, and `docs/ROADMAP.md` owns milestone status.

## Completed: Test-only corruption fixture repository seam

Added explicit internal database and repository factories that retain normal owned-connection setup while skipping only current-schema validation, plus a server test helper. Deliberate corruption reopenings were migrated while startup rejection coverage remains strict.

## Next Task: Declarative rules IR scoping

Scope the closed declarative rules IR milestone with exact consumers, contract boundaries, current-schema impact, and exclusions before implementation. Do not promote live exact-candidate selection, companion grant exercise, remote tenancy, or other later work implicitly.

## Context

Production repository opens still perform exact current-schema, quick-check, and foreign-key validation. Deliberately malformed domain fixtures now opt into `createCorruptionTestRepository`; schema creation and explicit startup-rejection tests continue to use `createRepository`.

## Files Modified

The seam is in `server/src/repo/db/connection.ts` and `server/src/repo/campaignRepositoryOrchestration.ts`; the test entry point is in `server/test/helpers.ts`. Corruption-focused server tests were updated to use it only after deliberate fixture damage.

## Validation

Server typecheck passed; the full server suite passed with 2,102 tests passing and one skipped. `git diff --check` passed.

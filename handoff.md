# Engineering Handoff

## Current State

- Persistence is `v40`, with additive M4.2/M4.3 provenance and confirmation-policy migrations.
- M4.1, M4.2, and M4.3 are complete. M4.4 receipt-aware narration and narrative consequence injection is next; M4.5 and M4.6 remain unimplemented.
- Adventure turns use bounded durable provider dispatches, server-selected tools, revision-checked idempotent command services, durable confirmation/expiry, and restart-safe reconciliation.
- SSE disconnects abort in-flight orchestration and stop polling. A durable dispatch may be reconciled by a later stream; disconnect does not create a speculative mechanics mutation.

## Boundaries

- Provider/tool arguments, provider metadata, principals, opaque bindings, hidden planning facts, and private authority data do not cross public projections.
- Remote provider calls occur outside SQLite transactions. Mechanics mutations remain authoritative repository command services.
- Existing persisted layouts and historical migrations remain unchanged; M4.2/M4.3 persistence is additive.

## Verification

- Root `npm run typecheck` passed immediately before implementation commit `af1966f`.
- Full contracts passed: 48 files, 287 tests. Focused M4 server tests passed: 15 tests. Focused client receipt tests passed: 89 tests. Production build passed.
- The full server suite completed with 2129 passed and 1 skipped after correcting its one stale safe-projection assertion. The full client suite identified two stale safe-projection assertions; focused replacements passed.

## Workspace Note

- `server/src/repo/contentCatalogRepo.ts` and all `.tmp*` directories are unrelated and intentionally excluded.

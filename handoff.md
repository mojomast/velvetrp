# Engineering Handoff

## Current State

- Persistence remains `v40`; M4.5 reuses durable generation drafts and authoritative encounter commands, so no migration was required.
- M4.1-M4.5 are complete. M4.6 remains unimplemented.
- Adventure turns use bounded durable provider dispatches, server-selected tools, revision-checked idempotent command services, durable confirmation/expiry, and restart-safe reconciliation.
- After mechanics commit, narration receives only a closed display-safe receipt subset: attribute before/after values, resource current/max values, dice total/modifier, or combat round transition. It has no tools and cannot receive command/proposal IDs, tool arguments, provider metadata, principals, opaque bindings, or hidden state.
- Narration provider starts/outcomes are persisted around the remote call. An interrupted durable start is failed rather than replayed, provider failure or invalid prose uses the deterministic receipt renderer, and in-process concurrent resumes share one narration dispatch.
- SSE disconnects abort in-flight orchestration and stop polling. A durable dispatch may be reconciled by a later stream; disconnect does not create a speculative mechanics mutation.
- Encounter generation accepts a bounded typed request. The provider gets only the user-authored visible brief/location/tone/difficulty/exclusions, party size, and ordinal pinned-enemy choices. It never receives actor IDs, catalog references, principals, provider metadata, hidden campaign state, or command arguments.
- Provider JSON is strictly validated before server-side ordinal-to-pinned-reference mapping. Invalid/unavailable output returns a safe unavailable response and persists neither draft nor encounter. Role-safe draft reads omit stored party and catalog identities.
- Apply is an explicit GM review action. One immediate SQLite transaction reviews the draft, calls `createEncounter` through the authoritative repository command service, and seals the draft receipt; any encounter failure rolls back the review and draft mutation. It does not start combat. Exact idempotency retries return the sealed result; changed key reuse conflicts.

## Boundaries

- Provider/tool arguments, provider metadata, principals, opaque bindings, hidden planning facts, and private authority data do not cross public projections.
- Remote provider calls occur outside SQLite transactions. Mechanics mutations remain authoritative repository command services.
- Existing persisted layouts and historical migrations remain unchanged; M4.2/M4.3 persistence is additive.

## Verification

- Root `TMPDIR=/dev/shm npm run typecheck` passed before the atomic-apply implementation commit.
- Focused M4.5 suite passed: server `rpg-generation-draft-route.test.ts` (4 tests), including authoritative-command failure rollback.

## Workspace Note

- `server/src/repo/contentCatalogRepo.ts` and all `.tmp*` directories are unrelated and intentionally excluded.

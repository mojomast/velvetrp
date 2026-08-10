# Engineering Handoff

## Current State

- Persistence remains `v40`; M4.4 uses existing durable narration and provider-call metadata, so no migration was required.
- M4.1-M4.4 are complete. M4.5 and M4.6 remain unimplemented.
- Adventure turns use bounded durable provider dispatches, server-selected tools, revision-checked idempotent command services, durable confirmation/expiry, and restart-safe reconciliation.
- After mechanics commit, narration receives only a closed display-safe receipt subset: attribute before/after values, resource current/max values, dice total/modifier, or combat round transition. It has no tools and cannot receive command/proposal IDs, tool arguments, provider metadata, principals, opaque bindings, or hidden state.
- Narration provider starts/outcomes are persisted around the remote call. An interrupted durable start is failed rather than replayed, provider failure or invalid prose uses the deterministic receipt renderer, and in-process concurrent resumes share one narration dispatch.
- SSE disconnects abort in-flight orchestration and stop polling. A durable dispatch may be reconciled by a later stream; disconnect does not create a speculative mechanics mutation.

## Boundaries

- Provider/tool arguments, provider metadata, principals, opaque bindings, hidden planning facts, and private authority data do not cross public projections.
- Remote provider calls occur outside SQLite transactions. Mechanics mutations remain authoritative repository command services.
- Existing persisted layouts and historical migrations remain unchanged; M4.2/M4.3 persistence is additive.

## Verification

- Root `npm run typecheck` passed before the M4.4 implementation commit.
- Focused M4 server suites passed: `adventure-agent-orchestrator.test.ts` and `m4-agent-acceptance.test.ts` (46 tests).

## Workspace Note

- `server/src/repo/contentCatalogRepo.ts` and all `.tmp*` directories are unrelated and intentionally excluded.

# Handoff
## Completed: Task 6 read part: Extract actor-resource read repository
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: Added `actorResource/actorResourceReadRepo.ts` with `createActorResourceReadRepository(db)`. The root facade retains all shared M1.5 errors, types, helpers, and mutation code, composes the extracted reads, and re-exports the new read interface. The reader-owned snapshot remains a SQLite transaction that authorizes before reading both resources and revision. Root `TMPDIR=.tmp npm run typecheck` passes. Per request, `devplan.md`, `contentCatalogRepo.ts`, and existing `.tmp` changes were not touched.
## Files Modified: server/src/repo/actorResource/actorResourceReadRepo.ts, server/src/repo/actorResourceRepo.ts, handoff.md

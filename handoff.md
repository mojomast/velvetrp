# Handoff
## Completed: Task 7: export campaign repository APIs from their implementation modules
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: Root `server/src/repo/index.ts` now directly exports campaign factory, types, errors, and dice API from `campaignRepositoryOrchestration`, `campaign/campaignTypes`, `campaign/campaignErrors`, and `diceRepo`. The `campaignRepo.ts` compatibility shim remains intact for its historical direct-import path. Root typecheck passed with `TMPDIR` set outside the repository; no commit was created. Per request, `devplan.md` and `.tmp/` were left alone.
## Quality Risks: `campaignRepo.ts` remains a compatibility facade for historical external direct imports even though there are no in-repository direct callers. It can be removed only after that path is formally retired.
## Files Modified: server/src/repo/index.ts; handoff.md

## Content Catalog Extraction Plan
Phase 1 will create `contentCatalog/` modules for canonical serialization/digests, validation, errors/types, shared internal SQL rows, publication reads, visibility verification, campaign authority, and campaign reads. Read modules must validate stored publications before privileged projections and use attested visibility rather than raw reachability for player/observer definitions.

Phase 2 will retain atomic `publicationWrite.ts` and `campaignWrite.ts` transactions. `contentCatalogRepo.ts` remains the facade that captures `db`, `clock`, and mutation guard and exposes the unchanged public repository surface. Shared SQL aliases remain internal; existing pure canonical and visibility exports retain compatibility re-exports.

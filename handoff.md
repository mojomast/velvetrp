# Handoff
## Completed: Task 8: remove deprecated campaign repository delegates
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: A whole-repository scan found 0 source/test callers of the 2 deprecated delegates (`listRecentCampaignDiceEventsSync` and `getCommandReceiptSync`) and 0 `campaignRepo` imports. The delegates and now-empty `server/src/repo/campaignRepo.ts` shim were removed. Root typecheck passed with `TMPDIR` set outside the repository; no commit was created. Per request, `devplan.md` and `.tmp/` were left alone.
## Quality Risks: The removed historical direct-import path is no longer supported; consumers must import public APIs from `server/src/repo/index.ts` or implementation APIs from their owning modules.
## Files Modified: server/src/repo/campaignRepo.ts (deleted); docs/repo-architecture.md; docs/roleplay-architecture-2026.md; docs/ROADMAP.md; README.md; HANDOFF.md; handoff.md

## Content Catalog Extraction Plan
Phase 1 will create `contentCatalog/` modules for canonical serialization/digests, validation, errors/types, shared internal SQL rows, publication reads, visibility verification, campaign authority, and campaign reads. Read modules must validate stored publications before privileged projections and use attested visibility rather than raw reachability for player/observer definitions.

Phase 2 will retain atomic `publicationWrite.ts` and `campaignWrite.ts` transactions. `contentCatalogRepo.ts` remains the facade that captures `db`, `clock`, and mutation guard and exposes the unchanged public repository surface. Shared SQL aliases remain internal; existing pure canonical and visibility exports retain compatibility re-exports.

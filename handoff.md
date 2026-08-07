# Handoff
## Completed: Task 5: extract content catalog read repository
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: Added the TSDoc-documented `createCatalogReadRepository(db, projectors)` factory. The content-catalog facade now delegates publication, owner/campaign projection, campaign resolution, and receipt reads to it while retaining the established validation and digest exports. The reader receives pure canonicalization, validation, and visibility verification as projectors, avoiding a runtime dependency back to the facade. The campaign definition reader now imports the shared persisted visibility-row type from the new read module. Root typecheck passed with `TMPDIR` set to `.tmp`; no commit was created. The pre-existing `devplan.md` modification and untracked `.tmp/` directory were not touched.
## Quality Risks: No known functional risk; cursor canonicalization and persisted-publication attestation checks are retained in the extracted reader.
## Files Modified: server/src/repo/contentCatalog/catalogReadRepo.ts; server/src/repo/contentCatalogRepo.ts; server/src/repo/campaign/campaignContentDefinitionReadRepo.ts; handoff.md

## Content Catalog Extraction Plan
Phase 1 will create `contentCatalog/` modules for canonical serialization/digests, validation, errors/types, shared internal SQL rows, publication reads, visibility verification, campaign authority, and campaign reads. Read modules must validate stored publications before privileged projections and use attested visibility rather than raw reachability for player/observer definitions.

Phase 2 will retain atomic `publicationWrite.ts` and `campaignWrite.ts` transactions. `contentCatalogRepo.ts` remains the facade that captures `db`, `clock`, and mutation guard and exposes the unchanged public repository surface. Shared SQL aliases remain internal; existing pure canonical and visibility exports retain compatibility re-exports.

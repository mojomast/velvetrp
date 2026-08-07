# Handoff
## Completed: Task 4: extract campaign export repository
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: `campaignAdmin/administrationExportRepo.ts` now owns `createCampaignExport`. Its factory receives `db`, `deps`, `runMutation`, `events`, and `receipts`; it uses `timelineTransferEvents` and preserves the export command's contiguous administration-history verification, manifest persistence, and idempotent retry projection. The administration facade wires and delegates the operation, and the campaign-admin barrel exports the factory. Root typecheck passed with `TMPDIR=/tmp/velvet-typecheck`; no commit was created. Per request, `devplan.md` and `.tmp/` were left alone.
## Quality Risks: The prior dry-run implementation remains in a block comment and the prior apply implementation remains behind `if (false)` in the facade as reviewable extraction history. Both are unreachable; remove them in a cleanup-only patch before further facade work.
## Files Modified: server/src/repo/campaignAdmin/administrationExportRepo.ts; server/src/repo/campaignAdmin/index.ts; server/src/repo/campaignAdministrationRepo.ts; handoff.md

## Content Catalog Extraction Plan
Phase 1 will create `contentCatalog/` modules for canonical serialization/digests, validation, errors/types, shared internal SQL rows, publication reads, visibility verification, campaign authority, and campaign reads. Read modules must validate stored publications before privileged projections and use attested visibility rather than raw reachability for player/observer definitions.

Phase 2 will retain atomic `publicationWrite.ts` and `campaignWrite.ts` transactions. `contentCatalogRepo.ts` remains the facade that captures `db`, `clock`, and mutation guard and exposes the unchanged public repository surface. Shared SQL aliases remain internal; existing pure canonical and visibility exports retain compatibility re-exports.

## Administration and Catalog Refactor Session Complete
Completed commits: `5c943ac` dead administration cleanup; `0a7525b` administration import/export helpers; `7661af7` mutation builder relocation; `929b167` catalog plan; `53a7a3f` catalog reads; `7ab1b56` catalog writes; `3c27a3a` root barrel normalization; `e2ec0e4` campaign shim removal. Root typecheck passed before every commit; focused Vitest remains constrained by temporary filesystem capacity.

Current sizes: `campaignAdministrationRepo.ts` 620 lines, `contentCatalogRepo.ts` 858 lines, `campaignRepositoryOrchestration.ts` 1,437 lines, `characterBuilderRepo.ts` 545 lines, `characterProgressionRepo.ts` 171 lines, and `encounterRepo.ts` 164 lines.

Recommended next session: remove duplicated obsolete catalog implementations from `contentCatalogRepo.ts`, extract administration import/apply/export into one atomic focused module, then address `characterBuilderRepo.ts`. Risks: the historical `campaignRepo.ts` deep-import path is intentionally removed after a zero in-repo caller audit; external consumers must use `server/src/repo/index.ts` or owning modules. Preserve atomic catalog and administration write transactions while completing follow-up extraction.

## Session 3 Audit
`campaignAdministrationRepo.ts` is a 620-line composition facade whose only substantial inline work is `dryRunCampaignImport` (lines 115-334), `applyCampaignImport` (335-502), and `createCampaignExport` (503-615). Access, commands, events, receipts, and timeline history are already delegated to `campaignAdmin/` modules. Dry-run/apply must share one injected dry-run operation so apply retains immediate-transaction idempotency without a facade cycle; export must retain `commands.runMutation` and contiguous administration-history verification.

`contentCatalogRepo.ts` is an 858-line facade plus public pure API. Its active factory delegates to `contentCatalog/catalogReadRepo.ts` and `catalogWriteRepo.ts`; old DB helpers from lines 336-827 are unreachable duplicates. Preserve/re-export the canonical validation, digest, visibility verification/derivation, and visibility-key helpers used by migrations and repository consumers, then delete only the duplicate DB implementation after an equivalence audit.

# Handoff
## Completed: Slimmed the campaign repository root into a compatibility facade
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: `campaignRepo.ts` now contains public type/error exports, the two deprecated event-read compatibility delegates, and an orchestration boundary comment. The factory implementation moved unchanged to `campaignRepositoryOrchestration.ts`, retaining actor-operation, unit-of-work, and repository composition. The pending event wiring edits are necessary: commands compose write operations with the database-scoped event reader, and event pagination consumes that same reader. `campaignTypes.ts` was not changed. `npm run typecheck` in `server/` passes. No commit was created; `devplan.md` remains unchanged because M1.9 is unrelated.
## Files Modified: server/src/repo/campaignRepo.ts, server/src/repo/campaignRepositoryOrchestration.ts, server/src/repo/campaign/campaignCommandRepo.ts, server/src/repo/campaign/campaignEventProjectionRepo.ts, handoff.md

## Completed: Aug 6 campaign write, content, and event refactor
Character creation now executes inside `campaign/campaignCharacterWriteRepo.ts`; content installation/configuration live in `campaign/campaignContentWriteRepo.ts`; event, receipt, and recent-dice audit reads live in `campaign/campaignEventReadRepo.ts`. Shared errors/types, command writes, core writes, and timeline reads are also leaf campaign modules. `campaignRepo.ts` was reduced from 2,428 lines at session start to 65 lines and is now a compatibility facade; `campaignRepositoryOrchestration.ts` owns factory and unit-of-work composition. The public `Repository` surface in `campaignTypes.ts` is unchanged.

Open follow-on work: campaign import/export and administration mutation kernels remain deliberate atomic transaction boundaries. Vitest may require workspace-backed temporary storage while `/tmp` is full.

## Post-refactor audit
- Keep `campaignRepo.ts`: `server/src/repo/index.ts` remains its sole in-repo consumer and it preserves historical root exports plus deprecated event-read delegates.
- Keep orchestration: `campaignRepositoryOrchestration.ts` owns factory/UoW guards and compatibility administration audits; import/export and gameplay audit reconstruction remain deliberate atomic boundaries.
- Candidate cleanup: delete deprecated root event-read delegates and duplicate `repositoryDependencies.ts` only after a public barrel contract test proves supported imports do not rely on them.
- Test coverage: `server/test/list-campaign-dice-events.test.ts` covers inherited/imported timeline reads for `listRecentCampaignDiceEvents`, including newest-first ordering, the 20-event limit, and outsider masking.
- Documentation gap: architecture docs and README should refer to `campaignRepositoryOrchestration.ts` rather than claiming factory composition remains in `campaignRepo.ts`.

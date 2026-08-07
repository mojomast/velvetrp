# Handoff
## Completed: Review follow-up: preserve campaign mapper deep imports
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: Restored the historical deep-import mapper surface from `campaignGlobalContentReadRepo.ts`: `RulesProfileRow`, `ContentPackRow`, `RpgDefinitionRow`, `toRulesProfile`, `toContentPack`, `toRpgDefinition`, and `sameMetadata`. `parseTags` is now private to `campaignContentRowMappers.ts`, so the campaign barrel does not expose it. Root typecheck and the focused dice test pass with `TMPDIR` set to the workspace. No commit was created. The pre-existing `devplan.md` modification and untracked `.tmp/` directory were left untouched.
## Quality Risks: No known functional risk from this compatibility-only change. Deep imports retain the prior mapper API; `parseTags` is intentionally no longer public.
## Files Modified: server/src/repo/campaign/campaignGlobalContentReadRepo.ts; server/src/repo/campaign/campaignContentRowMappers.ts; handoff.md

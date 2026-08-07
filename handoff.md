# Handoff
## Completed: Task 7b: extract character-progression writes
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: Added `characterProgression/characterProgressionWriteRepo.ts`, which owns progression initialization, all command mutations, and their private provenance/audit helpers. It preserves immediate transactions and prior write ordering. `characterProgressionRepo.ts` is now a facade that composes read and write factories; progression errors moved to `characterProgressionErrors.ts` and remain re-exported from the facade. Root typecheck passed with `TMPDIR=/home/mojo/projects/velvet-mvp/.tmp`. Per request, `devplan.md` and `.tmp/` were left untouched and no commit was created. Existing unrelated worktree changes remain.
## Files Modified: server/src/repo/characterProgression/characterProgressionErrors.ts; server/src/repo/characterProgression/characterProgressionWriteRepo.ts; server/src/repo/characterProgressionRepo.ts; handoff.md

## Latest Status
## Context: CI currently fails because `characterBuilderErrors.ts` was omitted from prior builder-refactor commits; the current typed interface updates are valid. Catalog callers must import validation helpers from `contentCatalog/index`. Stale project test artifacts in `/tmp/velvet-v*` and `/tmp/velvet-e2e-*` filled `/tmp` and were safely reclaimed.
## Files Modified: handoff.md

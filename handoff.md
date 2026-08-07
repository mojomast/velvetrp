# Handoff
## Completed: Task 7a: extract character-progression reads
## Next Task: M1.9 quests, storylines, clues, and rewards
## Context: Added `characterProgression/characterProgressionReadRepo.ts`, which owns actor-authorized public progression reads plus their authorization, state/provenance, and preview helpers. The facade now composes that read factory while retaining its existing error classes and public interface. The read factory delegates authoritative calculation and catalog/profile lookups to `characterProgressionPersistence.ts`; command behavior remains in the facade. Root typecheck passed with `TMPDIR=/home/mojo/projects/velvet-mvp/.tmp`. Per request, `devplan.md` and `.tmp/` were left untouched and no commit was created. Existing unrelated worktree changes remain.
## Files Modified: server/src/repo/characterProgression/characterProgressionReadRepo.ts; server/src/repo/characterProgressionRepo.ts; handoff.md

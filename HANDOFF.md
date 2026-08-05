# Handoff

## Completed: Safe-word feature removal (schema v29)

## Next Task: M2.1 quest routes

## Context

Schema v29 removes the retired character field from model/API/UI, exports, prompts, generation/session-close handling, policy detection, persistence, tests, and documentation. Consent events, boundaries, sanitization, the permissive policy stub, and normal stop/close behavior remain. The migration drops `characters.safe_word` transactionally, preserves character IDs and references, and uses `character_layout_attestation_v29` for startup drift validation. Historical fixture cleanup now removes v29 artifacts before replaying prior migrations.

The v29 character-layout digest is `bcca64e4206ed0db503cbea137334ae9f92fa6050537e3a950630b00b37bc25d`. M1.9 quests, storylines, clues, rewards, and objective completions is complete in schema v29r2; M2.1 quest routes is next after this change merges.

## Final Verification

- `npm run typecheck` passed.
- `npm run build` passed: 150 Vite modules.
- `npm test` passed: contracts 189, server 1,814 + 1 skipped, client 232; 2,235 passing + 1 skipped across 135 test files.
- `npm run test:e2e` passed: 1 passed.
- `git diff --check` passed.

## Major Relevant Changed Files

- `packages/contracts/src/world.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/world.test.ts`
- `server/src/repo/db.ts`
- `server/src/repo/db.ts`
- `server/src/repo/characterRepo.ts`
- `server/src/routes/roleplay/`
- `client/src/components/CharacterForm.tsx`
- `server/test/migration-v29.test.ts`

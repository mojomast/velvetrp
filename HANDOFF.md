# Handoff

## Completed: Safe-word feature removal (schema v29)

## Next Task: M2.7 resources, inventory, economy, and rest routes

## Context

Schema v29 removes the retired character field from model/API/UI, exports, prompts, generation/session-close handling, policy detection, persistence, tests, and documentation. Consent events, boundaries, sanitization, the permissive policy stub, and normal stop/close behavior remain. The migration drops `characters.safe_word` transactionally, preserves character IDs and references, and uses `character_layout_attestation_v29` for startup drift validation. Historical fixture cleanup now removes v29 artifacts before replaying prior migrations.

The v29 character-layout digest is `bcca64e4206ed0db503cbea137334ae9f92fa6050537e3a950630b00b37bc25d`. M1.9 quests, storylines, clues, rewards, and objective completions is complete in schema v29r2. The quest bootstrap, M2.1-M2.3, and M2.5 content catalog routes are complete. M2.4 exposes a stateless, no-write import dry-run route; durable import apply and export remain pending. M2.6 character creation, sheet, XP, preview, and token-bound level application routes are complete. M2.7 is next.

## Final Verification

- `npm run typecheck` passed.
- `npm test` in `server/` passed: 1,829 passing + 1 skipped.
- `npm run test:e2e -- --grep "quest workflow"` passed.
- `npm run test:e2e -- --grep "campaign administration lifecycle"` passed.
- `npm run test:e2e` passed: 4 workflows.
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

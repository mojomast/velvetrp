# Handoff

## Completed: M1.7 encounters and turn-based combat

## Next Task: M1.8 world, travel, NPCs, and factions

## Context

M1.7 is complete at the repository/shared-contract layer on schema v27r1. Its canonical DDL digest is `5ff782cab830d8c7e934edbae69fde1398b7482531d6b77c7ced8696798737be`. It adds prepared and improvised encounters bound to attached campaign sessions; catalog-pinned enemy spawn intents; server-derived initiative and deterministic fallback enemy turns; combatants, turn/round state, immutable combat logs, revision/idempotency receipts, and server-computed legal-action allowlists.

No M1.7 HTTP routes or client UI were added. Existing trusted-local behavior is unchanged: the fixed `local-owner` principal and loopback-only boundary are not safe for remote or multi-user deployment. Powers and items are deliberately rejected in combat when they cannot be atomically settled with their independent resource/inventory streams. Rewards are currency-only, server-generated and recorded claims; there is no generic caller-supplied reward input and recorded claims do not settle wallets.

## Final Verification

- `npm run typecheck` passed.
- `npm run build` passed: 149 Vite modules.
- `npm test` passed: contracts 184/184, server 1,811 + 1 skipped, client 232/232; 2,227 passing + 1 skipped across 131 test files.
- `npm run test:e2e` passed: 1 passed.
- `git diff --check` passed.

## Major Relevant Changed Files

- `packages/contracts/src/encounters.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/encounters.test.ts`
- `server/src/repo/db.ts`
- `server/src/repo/encounterRepo.ts`
- `server/src/repo/campaignRepo.ts`
- `server/src/repo/index.ts`
- `server/test/m17-repository-behavior.test.ts`
- `server/test/migration-v27.test.ts`
- `server/test/helpers.ts`

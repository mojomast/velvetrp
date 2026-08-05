# Handoff

## Completed: M1.8 world, travel, NPCs, and factions

## Next Task: M1.9 quests, storylines, clues, and rewards

## Context

M1.8 is complete at the repository/shared-contract layer on schema v28r1. Its canonical DDL digest is `2f6001699f45ecc90c426e05065d0ef004196c4419a5fbe2a94cd7e3770688c7`. It adds a campaign-scoped location hierarchy and directed route graph; per-actor discoveries and session-bound locations; revisioned, idempotent, atomic travel receipts/events; NPC-to-Velvet-persona links and private NPC state; faction membership/relations; and immutable reputation ledgers.

Player projections structurally omit hidden/undiscovered locations and routes, GM notes, NPC secrets/private goals, and unrelated private actor locations. Location creation, route creation, discovery, actor placement, and reputation changes require owner/GM authority; player travel additionally requires campaign ancestry, an open adjacent visible route, discovery/route requirements, and control of every selected actor. NPCs require one fictional confirmed Velvet persona that is not a campaign-character persona. Speech is manual only: there is no AI NPC speech and no path for AI to voice a manually controlled player character.

No M1.8 HTTP routes or client/UI were added. The RPG HTTP boundary remains exactly 21 operations, uses the fixed trusted-local `local-owner` principal, binds to loopback, and is not safe for remote or multi-user deployment.

## Final Verification

- `npm run typecheck` passed.
- `npm run build` passed: 150 Vite modules.
- `npm test` passed: contracts 189, server 1,820 + 1 skipped, client 232; 2,241 passing + 1 skipped across 134 test files.
- `npm run test:e2e` passed: 1 passed.
- `git diff --check` passed.

## Major Relevant Changed Files

- `packages/contracts/src/world.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/world.test.ts`
- `server/src/repo/db.ts`
- `server/src/repo/worldRepo.ts`
- `server/src/repo/campaignRepo.ts`
- `server/src/repo/index.ts`
- `server/test/m18-repository-behavior.test.ts`
- `server/test/migration-v28.test.ts`

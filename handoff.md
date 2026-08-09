# Engineering Handoff

## Current State

- Persistence: schema `v37r1` (`SCHEMA_VERSION = "37"`, `SCHEMA_REVISION = "1"`).
- RPG boundary: 92 explicitly registered trusted-local HTTP operations through M2.11, excluding feature discovery.
- Roadmap: M1.1-M1.10, M2.1-M2.11, and M3.1-M3.8 are complete.
- Next milestone: [M4.1 campaign-aware context assembly](docs/ROADMAP.md#m41-campaign-aware-context-assembly).
- Canonical root handoff: this lowercase `handoff.md`; the stale case-colliding `HANDOFF.md` was removed.

M1.10 provides durable adventure turns, proposal execution bindings, confirmation decisions, provider-call metadata, generation drafts, review decisions, and receipt links. M2.11 exposes turn streaming/reconciliation/confirmation and deterministic review-only generation-draft routes. M3.7 provides the campaign play shell, context drawer, confirmation UI, and authoritative mechanic receipt rendering. M3.8 completes event log, recap, import, and export workflows.

## Important Boundaries

- RPG requests use fixed `local-owner` on the default loopback listener. There is no authentication boundary and caller identity headers are ignored.
- Remote providers receive assembled prompt/context data. Local SQLite persistence does not imply local-only inference.
- Adventure turns persist coordination and exact mechanics bindings, but M4.2 must implement the bounded provider-selected tool loop and deterministic command bridge.
- Generation-draft creation is currently deterministic user-brief fallback. Apply seals draft review only and reports no campaign-domain mutation.
- The campaign context drawer labels NPCs as the campaign-visible roster because exact NPC presence/location is not represented.
- Never automatically replay an ambiguous mutation. Reconcile through the authoritative read and immutable receipt/idempotency surfaces.

## M4.1 Starting Point

Read these files in full before planning:

- `server/src/context.ts`
- `server/src/prompt.ts`
- `server/src/promptTemplates.ts`
- `server/src/llm.ts`
- `server/src/repo/campaign/campaignPlayReadRepo.ts`
- Relevant role-safe world, quest, story, actor, encounter, and recap projections

M4.1 must add bounded, role-filtered campaign mechanics, world, cast, quest, recap, and legal-action context. Preserve the roadmap precedence: safety/control, human canon, committed mechanics, declaration, visible normalized state, approved memory/lore, summaries, then generated suggestions. Add independent budgets and projection tests; do not dump full catalogs, inventories, enemy secrets, or story graphs into prompts.

## Recent History

The M1.10/M2.11/M3.7 implementation and recovery sequence runs from `14c4a4e` through `dc8327d`. Documentation commits are `3f22f7c`, `bc976c7`, `5c9372c`, and `3b42e80`.

At the time of this documentation pass, the checked-out commit is `3b42e80`; the root documentation changes are uncommitted, so do not describe `HEAD` as containing them until a later commit does. Consult `git log` rather than treating this list as a permanent current-HEAD ledger.

## Verification

For implementation work, run:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
git diff --check
```

Deterministic E2E is isolated and does not call a paid provider. `VELVET_E2E_LIVE=1 npm run test:e2e:live` is separate, opt-in, and may incur provider cost. No volatile test totals are recorded here.

## Workspace Note

Pre-existing unrelated workspace content was present in `server/src/repo/contentCatalogRepo.ts` and temporary directories during this docs pass. Do not stage, modify, or clean unrelated changes as part of documentation or M4.1 work.

# Engineering Handoff

## Current State

- Persistence: schema `v37r1` (`SCHEMA_VERSION = "37"`, `SCHEMA_REVISION = "1"`).
- RPG boundary: 92 explicitly registered trusted-local HTTP operations through M2.11, excluding feature discovery.
- Roadmap: M1.1-M1.10, M2.1-M2.11, M3.1-M3.8, and M4.1 are complete. This does not mean all of M4 is complete.
- Next milestone: [M4.2 bounded tool loop and deterministic command bridge](docs/ROADMAP.md#m42-bounded-tool-loop-and-deterministic-command-bridge).
- Canonical root handoff: this lowercase `handoff.md`; the stale case-colliding `HANDOFF.md` was removed.

M1.10 provides durable adventure turns, proposal execution bindings, confirmation decisions, provider-call metadata, generation drafts, review decisions, and receipt links. M2.11 exposes turn streaming/reconciliation/confirmation and deterministic review-only generation-draft routes. M3.7 provides the campaign play shell, context drawer, confirmation UI, and authoritative mechanic receipt rendering. M3.8 completes event log, recap, import, and export workflows. M4.1 adds the server-internal, role-sensitive campaign snapshot and bounded context basket used by future orchestrators; it makes no HTTP or shared wire-contract change.

## Important Boundaries

- RPG requests use fixed `local-owner` on the default loopback listener. There is no authentication boundary and caller identity headers are ignored.
- Remote providers receive assembled prompt/context data. Local SQLite persistence does not imply local-only inference.
- M4.1 context reads rederive membership, role, control, session/target ancestry, audience visibility, and legal actions in one deferred SQLite snapshot. Full catalogs, full inventories, story graph dumps, hidden routes, unrelated private state, and controller identities are excluded.
- Context categories have independent UTF-16 code-unit budgets and deterministic whole-line omission with exact truncation metadata. Precedence is safety/control, human canon, committed mechanics, exact final declaration, visible state/legal actions, authorized private target facts, approved memory/lore, recap/summary, then generated suggestions.
- NPC goals and enemy tactics are target-private planning input only. A non-overridable safety rule forbids disclosing, quoting, paraphrasing, hinting at, or confirming them.
- Player/NPC legacy generation requires exact server-derived persona and session binding. Companion snapshots fail closed because no persisted companion model/controller binding exists; DM and enemy audiences also fail closed in legacy character prompts.
- Adventure turns persist coordination and exact mechanics bindings, but there is no production tool/provider loop yet. M4.2 must implement the bounded provider-selected loop and deterministic command bridge.
- Generation-draft creation is currently deterministic user-brief fallback. Apply seals draft review only and reports no campaign-domain mutation.
- The campaign context drawer labels NPCs as the campaign-visible roster because exact NPC presence/location is not represented.
- Never automatically replay an ambiguous mutation. Reconcile through the authoritative read and immutable receipt/idempotency surfaces.

## M4.2 Starting Point

The M4.1 implementation in commit `25c8414` is the starting boundary. Read these relevant files in full before planning:

- `server/src/context.ts`
- `server/src/prompt.ts`
- `server/src/llm.ts`
- `server/src/repo/campaign/campaignAgentContextReadRepo.ts`
- `server/src/repo/campaignRepositoryOrchestration.ts`
- `server/test/campaign-context.test.ts`
- `server/test/campaign-agent-context-read.test.ts`
- `server/test/llm.test.ts`

M4.2 must consume this server-internal boundary without weakening its audience derivation, single-snapshot read, private-planning nondisclosure, persona/session binding, or independent budgets. Add the bounded provider-selected tool loop and route every mutation through deterministic revision-checked, idempotent command services; do not turn the context reader into a catalog/inventory/story dump or a mutation path.

## Recent History

The M1.10/M2.11/M3.7 implementation and recovery sequence runs from `14c4a4e` through `dc8327d`. Documentation commits are `3f22f7c`, `bc976c7`, `5c9372c`, `3b42e80`, and `7f6e57c`. M4.1 implementation is `25c8414`.

At the time of this documentation pass, `HEAD` is `25c8414` (`feat(rpg): add campaign context projections`). These documentation changes are uncommitted, so `HEAD` contains the M4.1 implementation but not this progress update. Nothing was pushed or committed by this documentation pass; consult `git log` rather than treating this list as permanent.

## Verification

For implementation work, run:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
git diff --check
```

M4.1's focused coverage is in `server/test/campaign-context.test.ts`, `server/test/campaign-agent-context-read.test.ts`, and the campaign-context case in `server/test/llm.test.ts`. For this documentation pass, root `npm run typecheck` and `git diff --check` both passed on 2026-08-09; the focused/unit/E2E suites were not rerun.

Deterministic E2E is isolated and does not call a paid provider. `VELVET_E2E_LIVE=1 npm run test:e2e:live` is separate, opt-in, and may incur provider cost. No volatile test totals are recorded here.

## Workspace Note

Pre-existing unrelated workspace content was present in `server/src/repo/contentCatalogRepo.ts` and temporary directories during this docs pass. Do not stage, modify, or clean unrelated changes as part of documentation or M4.1 work.

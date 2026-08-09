# Handoff

## Current Status

This session completed M1.10, M2.11, the campaign play bootstrap, M3.7, and their hardening/documentation follow-ups. Persistence is schema `v37r1`. M2.11 provides durable adventure-turn streaming/reconciliation/confirmation and deterministic review-only generation-draft routes; M3.7 provides the durable campaign play shell, context drawer, confirmation UI, and authoritative mechanic receipt rendering.

| Milestones | State |
| --- | --- |
| M1.1-M1.10 | Complete |
| M2.1-M2.11 | Complete |
| M3.1-M3.8 | Complete |
| M4.1-M4.6 | Pending |

## Session Commits

Commits in `b518850..HEAD`, oldest first, including hardening, fixes, and docs:

1. `14c4a4e17bb6d92b06ef405e7af386cbd1580fb6` `feat(schema): add adventure turn and generation draft tables`
2. `291894be58b2cc9193a38b45b5eca2025a325d24` `feat(contracts): add adventure turn and generation draft types`
3. `cf53c8d81e7d1e5254f0d2c30eb7a11f20d92b0b` `feat(repo): add adventure turn repository`
4. `ce3090b0a567eb85a2c33941bb1eaa4eaf426cb3` `fix(repo): harden adventure turn coordination`
5. `1e816df281b2ab457cf073d2c63d0ad60d476b03` `fix(repo): align adventure coordination revisions`
6. `31469ee195ac062e7c3840ec1627dd27c2234b09` `fix(repo): support partial plural mechanics links`
7. `0c31740a377f8f5876c3450208df24d5609462a1` `docs: record M1.10 schema and repo in handoff`
8. `f305c06df638dc50eeafea17de5921ecdf2556e5` `feat(rpg): add adventure turn streaming routes`
9. `8178d33bf4395d1c592e844428900d8256b5de0a` `feat(rpg): add generation draft routes`
10. `457f1b7785df91b9a18314307e997d33e84017a3` `fix(rpg): harden adventure turn coordination`
11. `99048a66246e17737617edec43d7142c397aaa60` `fix(rpg): clarify draft-only generation apply`
12. `be3ef84da4e1eb2a756bc07389175b23e46d4dd7` `fix(rpg): bind proposals to exact mechanics commands`
13. `9e529aaf502238cc5fa91b356d56bf855c7f98da` `docs: add M2.11 adventure turn and generation routes to api.md`
14. `01a651e48772444d41ea19ab8af238b5bfb05108` `feat(rpg): add campaign play bootstrap`
15. `b4b2817b0966d5249f51cef7c82d488327e2520e` `feat(client): add adventure action composer`
16. `1cac6df338702cbb377390e367c3a6bc1b0b7148` `feat(client): add mechanic receipt cards`
17. `17d859022a74f2c459b233975da5e9b866263bd4` `feat(client): add adventure confirmation banner`
18. `96c1030dfe0d556c2f15fd912a90b6dd139fbcfa` `feat(client): add campaign context drawer`
19. `6368287135b29b8a26447681a7e0c8250a970d9d` `feat(client): add durable campaign play page`
20. `9f026e870fedf3947f98bff4635c2eefde4e213b` `feat(rpg): integrate campaign play shell`
21. `4cfb8b45b5f796d379e13fd8a05d697639a456a8` `fix(rpg): harden adventure turn recovery`
22. `a0e18c8cc983916a47af8f88b00a5c4b640fea70` `fix(client): reconcile durable campaign play`
23. `dc8327d87710c429952633e31ea966e0eda695ba` `fix(rpg): normalize initial turn reconciliation problems`
24. `3f22f7cf6e0b5ffb68230e642797221f59898edc` `docs: mark M1.10 M2.11 M3.7 complete, add M4 targets to devplan`

## Schema v37r1

The v35 domain tables are `adventure_turns`, `tool_proposals`, `confirmation_decisions`, `provider_call_metadata`, `generation_drafts`, `review_decisions`, and `final_receipt_links`; `adventure_generation_layout_attestation_v35` seals their layout.

The v36 additive coordination/provenance sidecars are `adventure_coordination_commands_v36`, `adventure_coordination_events_v36`, `adventure_coordination_receipts_v36`, `turn_mechanics_links_v36`, and `generation_draft_apply_receipts_v36`; `adventure_hardening_layout_attestation_v36` seals the hardened v35/v36 layout. v36 preserves prior data, replaces four transition guards, snapshots pre-v36 aggregates, and refuses ambiguous legacy turn-receipt ancestry.

The v37 additive sidecar is `tool_proposal_execution_bindings_v37`, which binds every proposal to a server-owned mechanics idempotency key, command type, source turn, timeline, and actor. `tool_execution_binding_layout_attestation_v37` seals the layout. The sidecar is immutable, covers every proposal, and requires exact binding provenance for mechanics links.

## File Inventory

Exact current line and byte sizes:

| Area | File | Lines | Bytes |
| --- | --- | ---: | ---: |
| M1.10 contract | `packages/contracts/src/adventure-turns.ts` | 264 | 17,942 |
| M1.10 contract | `packages/contracts/src/generation-drafts.ts` | 133 | 8,682 |
| M1.10 repo | `server/src/repo/adventureTurn/errors.ts` | 10 | 890 |
| M1.10 repo | `server/src/repo/adventureTurn/index.ts` | 4 | 139 |
| M1.10 repo | `server/src/repo/adventureTurn/read.ts` | 216 | 20,226 |
| M1.10 repo | `server/src/repo/adventureTurn/write.ts` | 421 | 43,501 |
| M1.10 repo | `server/src/repo/adventureTurnRepo.ts` | 15 | 904 |
| M1.10 migration | `server/src/repo/db/migrations/v35_adventure_generation.ts` | 287 | 30,658 |
| M1.10 migration | `server/src/repo/db/migrations/v36_adventure_hardening.ts` | 454 | 49,079 |
| M1.10 migration | `server/src/repo/db/migrations/v37_tool_execution_bindings.ts` | 170 | 13,405 |
| M2.11 contract | `packages/contracts/src/adventure-turns-http.ts` | 174 | 9,648 |
| M2.11 contract | `packages/contracts/src/generation-drafts-http.ts` | 82 | 4,157 |
| M2.11 route | `server/src/routes/rpg/v1/adventureTurns.ts` | 280 | 21,409 |
| M2.11 route | `server/src/routes/rpg/v1/generationDrafts.ts` | 131 | 11,171 |
| Play bootstrap contract | `packages/contracts/src/campaign-play-http.ts` | 84 | 4,048 |
| Play bootstrap repo | `server/src/repo/campaign/campaignPlayReadRepo.ts` | 346 | 20,117 |
| Play bootstrap route | `server/src/routes/rpg/v1/campaignPlay.ts` | 69 | 3,105 |
| M3.7 component | `client/src/components/rpg/play/AdventureActionComposer.tsx` | 57 | 3,003 |
| M3.7 component | `client/src/components/rpg/play/MechanicReceiptCard.tsx` | 73 | 4,254 |
| M3.7 component | `client/src/components/rpg/play/ConfirmationBanner.tsx` | 84 | 6,035 |
| M3.7 component | `client/src/components/rpg/play/CampaignContextDrawer.tsx` | 89 | 9,029 |
| M3.7 component | `client/src/components/rpg/play/CampaignPlayPage.tsx` | 275 | 22,936 |
| **Total** | **22 files** | **3,718** | **304,338** |

Area totals: M1.10 contracts 397 lines/26,624 bytes; M1.10 repo 666 lines/65,660 bytes; migrations 911 lines/93,142 bytes; M2.11 route/contracts 667 lines/46,385 bytes; play bootstrap 499 lines/27,270 bytes; M3.7 components 578 lines/45,257 bytes.

## Boundaries And Limitations

- Adventure turns persist proposals and exact execution bindings, but M4.2 must provide the bounded server-selected tool loop and bridge mutations through the existing revision-checked idempotent deterministic command service. Arbitrary SQL, filesystem, network, policy, prompt, permission, deletion, and memory-approval tools remain outside the tool surface.
- M2.11 generation creation is explicitly a deterministic user-brief fallback. Apply seals a reviewed draft selection only, reports `campaignDomainMutated: false`, and does not create a campaign command receipt. Provider generation and deterministic campaign-content application remain M4.5-M4.6; generated prose must never mutate campaign state directly.
- The M3.7 context drawer cannot report exact NPC presence. The backend does not track NPC location/presence, so the implementation visibly labels this section as a campaign-visible roster, not "NPCs here."

## Verification

- Current trusted-local RPG boundary: exactly 90 HTTP operations through M2.11.
- Contracts: 47 files passed, 282 tests passed.
- Server: 133 files passed, 1,990 tests passed, 1 skipped.
- Client: 21 files passed, 390 tests passed.
- Aggregate: 201 files passed, 2,662 tests passed, 1 skipped.
- `npm run typecheck`: passed contracts, server, client, and e2e TypeScript projects.
- `git diff --check`: passed.

## Next Session

Target exactly M4.1 campaign-aware context assembly. Read `server/src/context.ts`, `server/src/prompt.ts`, `server/src/promptTemplates.ts`, and `server/src/llm.ts` in full before planning.

Risk: M4.2 tool loop touches `server/src/llm.ts`, which is currently 19,444 bytes (about 19 KB), 467 lines, and central. Read it in full and grep all callers before changing its public surface.

## Workspace

Before this handoff commit: branch `main`, HEAD `3f22f7cf6e0b5ffb68230e642797221f59898edc`, ahead of `origin/main` by 24. Unrelated dirty workspace content remains in `server/src/repo/contentCatalogRepo.ts` and `.tmp/`, `client/.tmp/`, `packages/contracts/.tmp/`, and `server/.tmp/`; do not stage, modify, or clean it as part of this docs task. No push requested.

# Handoff

## Current Status: M1.10 Complete

M1.10 adventure turns, confirmations, and generation drafts is complete at schema `v36r1`. The repository now persists bounded tool coordination, confirmation decisions and expiry, provider-call metadata, proposal-bound mechanics provenance, narration-only retry ancestry, and reviewable generation drafts with immutable apply receipts. No HTTP or client surface was added as part of M1.10.

### Commits

1. `14c4a4e` `feat(schema): add adventure turn and generation draft tables`
2. `291894b` `feat(contracts): add adventure turn and generation draft types`
3. `cf53c8d` `feat(repo): add adventure turn repository`
4. `ce3090b` `fix(repo): harden adventure turn coordination`
5. `1e816df` `fix(repo): align adventure coordination revisions`
6. `31469ee` `fix(repo): support partial plural mechanics links`

### Schema v36r1

The exact required M1.10 domain table names introduced by v35 are:

| Table | Purpose |
| --- | --- |
| `adventure_turns` | Durable declaration, lifecycle, narration status, and ancestry root |
| `tool_proposals` | Bounded immutable proposal arguments and confirmation requirements |
| `confirmation_decisions` | Immutable, revision-bound human confirmation decisions |
| `provider_call_metadata` | Bounded append-only provider start/outcome metadata |
| `generation_drafts` | Staged generated content, validation, review, and apply lifecycle |
| `review_decisions` | Immutable owner/GM draft decisions |
| `final_receipt_links` | Durable aggregate-to-command receipt links |

The exact v36 hardening sidecar and attestation table names are:

| Table | Purpose |
| --- | --- |
| `adventure_coordination_commands_v36` | Canonical idempotent mutation requests and revision intent |
| `adventure_coordination_events_v36` | Contiguous immutable aggregate revision events |
| `adventure_coordination_receipts_v36` | Immutable shared-contract mutation results |
| `turn_mechanics_links_v36` | Exact proposal, source-turn, and mechanics-command provenance |
| `generation_draft_apply_receipts_v36` | Draft-specific apply provenance tied to an approved review |
| `adventure_hardening_layout_attestation_v36` | Canonical v35/v36 layout attestation |

`adventure_generation_layout_attestation_v35` remains the v35 layout attestation table. v36 is additive over v35 data, replaces four v35 transition guards with hardened v36 guards, snapshots existing aggregates into the coordination ledger, and refuses ambiguous legacy turn-receipt ancestry rather than fabricating provenance.

### Repository Inventory

Exact current sizes for the new adventure-turn repository source files:

| File | Lines | Bytes |
| --- | ---: | ---: |
| `server/src/repo/adventureTurnRepo.ts` | 15 | 904 |
| `server/src/repo/adventureTurn/errors.ts` | 10 | 890 |
| `server/src/repo/adventureTurn/index.ts` | 4 | 139 |
| `server/src/repo/adventureTurn/read.ts` | 125 | 11,017 |
| `server/src/repo/adventureTurn/write.ts` | 363 | 38,302 |
| **Repository total** | **517** | **51,252** |

The facade composes principal-sensitive reads with guarded immediate-transaction writes. The public surface covers turn creation, proposals, confirmation wait/decision, provider metadata, mechanics linking/reconciliation, narration updates, and generation draft create/review/apply operations.

### Contract Inventory

| File | Lines | Bytes |
| --- | ---: | ---: |
| `packages/contracts/src/adventure-turns.ts` | 240 | 16,266 |
| `packages/contracts/src/generation-drafts.ts` | 133 | 8,682 |
| **Contract source total** | **373** | **24,948** |
| `packages/contracts/test/adventure-turns.test.ts` | 88 | 6,898 |
| `packages/contracts/test/generation-drafts.test.ts` | 43 | 3,364 |
| **Contract test total** | **131** | **10,262** |

The contracts define closed turn, narration, confirmation, provider, draft, review, and apply vocabularies; strict optimistic mutation envelopes; bounded tool and validation payloads; and structurally separate private and role-safe projections.

### Migration And Verification Inventory

| File | Lines | Bytes |
| --- | ---: | ---: |
| `server/src/repo/db/migrations/v35_adventure_generation.ts` | 287 | 30,658 |
| `server/src/repo/db/migrations/v36_adventure_hardening.ts` | 435 | 47,415 |
| **Migration source total** | **722** | **78,073** |
| `server/test/adventure-turn-repo.test.ts` | 409 | 36,319 |
| `server/test/migration-v35.test.ts` | 112 | 7,434 |
| `server/test/migration-v36.test.ts` | 126 | 10,446 |
| **Focused server test total** | **647** | **54,199** |

Verification for this handoff:

- Contract suite: 44 files passed, 264 tests passed.
- Focused M1.10 server suite: 3 files passed, 22 tests passed.
- `npm run typecheck`: passes contracts, server, client, and e2e TypeScript projects.
- `git diff --check`: passes.

### Next

- M2.11 Adventure turn, confirmation, and generation routes is next: add the validated streaming turn protocol, durable confirmation/resume flow, generation draft routes, and disconnect/restart behavior over the M1.10 repository.
- M3.7 Campaign Play Shell and mechanic receipts follows M2.11 and remains blocked on it; integrate the campaign context drawer, receipt cards, confirmation banner, and adventure action composer around existing chat.

## Historical Context: Session 4 Repository Decomposition

Before M1.10, encounter, economy, quest, actor-resource, and world repositories were decomposed into read/write modules while legacy `*Repo.ts` facades remained compatibility boundaries. The Session 4 commits were `3afc3f8`, `7c849c7`, `e2c3283`, `2d63954`, `82ae067`, `c30f1ce`, `42c59b5`, `3a81952`, `6b79093`, `4a5e3ff`, `c92fd76`, `87cf1fc`, `0bd796d`, `d2be024`, `d51be0b`, `fc99bf5`, `0df77cf`, and `e38248c`.

Splitting `campaignRepositoryOrchestration.ts` was intentionally deferred because its composition and callback cycles require a dedicated, non-mechanical extraction.

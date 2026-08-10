# Development Plan

Current persistence is `v42r1`. The authoritative dependency order and acceptance criteria live in the [RPG roadmap](docs/ROADMAP.md). This file is only a compact completion ledger.

## Complete

- [x] M1.1-M1.10: RPG contracts, schema, repositories, deterministic mechanics, world/story state, and durable adventure coordination
- [x] M2.1-M2.11: trusted-local campaign, content, character, mechanics, combat, world/story, transfer, and adventure HTTP surfaces
- [x] M3.1-M3.8: administration, content, character, combat, world/story, campaign play, history, recap, import, and export client workflows
- [x] M4.1: role-sensitive campaign context snapshots and bounded prompt assembly with exact precedence, UTF-16 whole-line budgets, and fail-closed persona/session binding
- [x] M4.2: bounded provider tool loop and deterministic, revision-checked command bridge
- [x] M4.3: durable confirmation, expiry, restart reconciliation, and resume
- [x] M4.4: receipt-aware narration and narrative consequence injection
- [x] M4.5: typed LLM encounter generation, strict staged validation, GM-confirmed authoritative encounter creation, and privacy-safe projections
- [x] M4.6: typed campaign-content drafts, conservative generated NPC baselines, atomic reviewed application, and v42 additive integrity sealing

## Pending

No M4 work is pending. M4.6 accepts only a bounded visible brief, tone, and exclusions, validates strict provider JSON, and stores campaign-content drafts durably. Role-safe previews omit NPC goals and all provider/private metadata. Apply is a single immediate transaction that reviews, creates bounded public locations/factions/quests and manually controlled fictional NPCs, records only explicit 10/10/10 conservative baseline stats (no catalog powers or effects), persists opening prose, and seals an idempotent receipt. Provider work remains outside SQLite.

Deferred and out-of-scope work remains recorded in the [roadmap](docs/ROADMAP.md#out-of-scope--deferred).

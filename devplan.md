# Development Plan

Current persistence is `v40`. The authoritative dependency order and acceptance criteria live in the [RPG roadmap](docs/ROADMAP.md). This file is only a compact completion ledger.

## Complete

- [x] M1.1-M1.10: RPG contracts, schema, repositories, deterministic mechanics, world/story state, and durable adventure coordination
- [x] M2.1-M2.11: trusted-local campaign, content, character, mechanics, combat, world/story, transfer, and adventure HTTP surfaces
- [x] M3.1-M3.8: administration, content, character, combat, world/story, campaign play, history, recap, import, and export client workflows
- [x] M4.1: role-sensitive campaign context snapshots and bounded prompt assembly with exact precedence, UTF-16 whole-line budgets, and fail-closed persona/session binding
- [x] M4.2: bounded provider tool loop and deterministic, revision-checked command bridge
- [x] M4.3: durable confirmation, expiry, restart reconciliation, and resume

## Pending

- [ ] M4.4: receipt-aware narration and narrative consequence injection
- [ ] M4.5: LLM encounter generation
- [ ] M4.6: NPC stat derivation and campaign-content generation

M4.4-M4.6 remain unimplemented. M4.2/M4.3 expose only safe projections; provider/tool internals, principals, opaque bindings, and hidden planning data remain private.

Deferred and out-of-scope work remains recorded in the [roadmap](docs/ROADMAP.md#out-of-scope--deferred).

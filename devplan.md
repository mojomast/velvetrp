# Development Plan

Current persistence is `v37r1`. The authoritative dependency order and acceptance criteria live in the [RPG roadmap](docs/ROADMAP.md). This file is only a compact completion ledger.

## Complete

- [x] M1.1-M1.10: RPG contracts, schema, repositories, deterministic mechanics, world/story state, and durable adventure coordination
- [x] M2.1-M2.11: trusted-local campaign, content, character, mechanics, combat, world/story, transfer, and adventure HTTP surfaces
- [x] M3.1-M3.8: administration, content, character, combat, world/story, campaign play, history, recap, import, and export client workflows
- [x] M4.1: role-sensitive campaign context snapshots and bounded prompt assembly with exact precedence, UTF-16 whole-line budgets, and fail-closed persona/session binding

## Next

- [ ] M4.2: bounded tool loop and deterministic command bridge

## Pending

- [ ] M4.3: durable confirmation and resume
- [ ] M4.4: receipt-aware narration and narrative consequence injection
- [ ] M4.5: LLM encounter generation
- [ ] M4.6: NPC stat derivation and campaign-content generation

M4.1 is a server-internal assembly boundary only. No HTTP/wire contract changed, and production adventure turns do not run a tool/provider loop until M4.2.

Deferred and out-of-scope work remains recorded in the [roadmap](docs/ROADMAP.md#out-of-scope--deferred).

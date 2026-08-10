# Development Plan

Current persistence is `v40`. The authoritative dependency order and acceptance criteria live in the [RPG roadmap](docs/ROADMAP.md). This file is only a compact completion ledger.

## Complete

- [x] M1.1-M1.10: RPG contracts, schema, repositories, deterministic mechanics, world/story state, and durable adventure coordination
- [x] M2.1-M2.11: trusted-local campaign, content, character, mechanics, combat, world/story, transfer, and adventure HTTP surfaces
- [x] M3.1-M3.8: administration, content, character, combat, world/story, campaign play, history, recap, import, and export client workflows
- [x] M4.1: role-sensitive campaign context snapshots and bounded prompt assembly with exact precedence, UTF-16 whole-line budgets, and fail-closed persona/session binding
- [x] M4.2: bounded provider tool loop and deterministic, revision-checked command bridge
- [x] M4.3: durable confirmation, expiry, restart reconciliation, and resume
- [x] M4.4: receipt-aware narration and narrative consequence injection
- [x] M4.5: typed LLM encounter generation, strict staged validation, GM-confirmed authoritative encounter creation, and privacy-safe projections

## Pending

- [ ] M4.6: NPC stat derivation and campaign-content generation

M4.6 remains unimplemented. M4.5 accepts bounded encounter briefs, visible location/tone/difficulty/exclusions, party membership, and pinned enemy references; the provider receives only display-safe prose, party size, and ordinal enemy choices. Its strict typed response is mapped server-side to pinned definitions, staged durably, and projected without actor or catalog identities. Provider failures and malformed output create no draft or encounter. GM apply reviews the exact draft and invokes the authoritative encounter command service; it never silently activates combat. Provider/tool internals, principals, opaque bindings, and hidden planning data remain private.

Deferred and out-of-scope work remains recorded in the [roadmap](docs/ROADMAP.md#out-of-scope--deferred).

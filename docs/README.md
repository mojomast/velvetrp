# Documentation index

Documents are grouped by their primary role. Normative documents describe current contracts and repository architecture; implementation notes and plans do not override them.

## Authority and ownership

- Runtime code and shared Zod contracts own executable behavior and wire validation.
- [API reference](api.md) owns current HTTP behavior and the sole parseable RPG operation inventory.
- [Operations](operations.md) owns setup, configuration classification, migration support, backup/restore, and release-gate guidance.
- [Repository architecture](repo-architecture.md) owns current persistence structure, migration lineage, module ownership, and transaction conventions.
- [RPG roadmap](ROADMAP.md) alone owns current milestone status and remaining product scope.
- Root [`devplan.md`](../devplan.md) is a compact delivered/pending ledger; it cannot override the roadmap.
- Root [`handoff.md`](../handoff.md) owns the immediate engineering baseline and next task.
- Historical and dated plans preserve rationale and checkpoints but never override these current authorities.

## Normative reference

- [API reference](api.md) - Current HTTP routes, request/response contracts, feature gates, error handling, and reconciliation rules.
- [Streaming](streaming.md) - Current SSE contracts for legacy token/swipe, room, and durable M2.11 adventure streams.
- [Customizable harness](customizable-harness.md) - Current prompt/harness fields, limits, template behavior, and context assembly.
- [Repository architecture](repo-architecture.md) - Normative implementation ownership, persistence boundaries, migration lineage, and source-code map. It is not an HTTP contract.

## Operational guides

- [Operations](operations.md) - Node 22 setup, environment, local deployment, storage, migration backup/restore, testing, and troubleshooting.
- [Provider configuration](provider-configuration.md) - Provider precedence, credentials, outbound privacy, live tests, and troubleshooting.
- [Campaign generation and expansion](campaign-generation.md) - Reviewed generation, dependency-aware apply, planning projections, provider attempt handling, and explicit material delivery; subordinate to the API reference for HTTP contracts.
- [Interactive gameplay agent instructions](interactive-gameplay-agent-instructions.md) - Trusted-local operator workflow, discovery, character/campaign setup, play, and no-retry reconciliation.
- [Planning board](planning-board.md) - Internal contributor workflow for the repository-specific planning board.

## Planning and historical records

- [RPG roadmap](ROADMAP.md) - Current milestone sequencing plus preserved milestone history. Planned behavior is not a shipped contract.
- [Revision 2 integration plan](revision-2-integration-plan.md) - Preserved approved post-M4 execution design at its saved checkpoint; historical rather than current next-work authority.
- [RPG integration plan](rpg-integration-plan.md) - Original integration design and historical operation ledgers; current implementation can be newer.
- [Roleplay architecture notes (2026)](roleplay-architecture-2026.md) - Dated architecture decisions and historical checkpoints; current status statements may age.
- [Roleplay product/feature snapshot (2026)](trending-roleplay-features-2026.md) - Dated internal planning snapshot, not external research, provenance, a commitment, or a contract.

For behavior conflicts, prefer shared runtime contracts and current code, then the [API reference](api.md), [Streaming](streaming.md), and normative repository architecture where applicable. Use dated planning records only for historical rationale.

# Documentation index

Documents are grouped by their primary role. Normative documents describe current contracts and repository architecture; implementation notes and plans do not override them.

## Normative reference

- [API reference](api.md) - Current HTTP routes, request/response contracts, feature gates, error handling, and reconciliation rules.
- [Streaming](streaming.md) - Current SSE contracts for legacy token/swipe, room, and durable M2.11 adventure streams.
- [Customizable harness](customizable-harness.md) - Current prompt/harness fields, limits, template behavior, and context assembly.
- [Repository architecture](repo-architecture.md) - Normative implementation ownership, persistence boundaries, migration lineage, and source-code map. It is not an HTTP contract.

## Operational guides

- [Operations](operations.md) - Node 22 setup, environment, local deployment, storage, migration backup/restore, testing, and troubleshooting.
- [Provider configuration](provider-configuration.md) - Provider precedence, credentials, outbound privacy, live tests, and troubleshooting.

## Planning and historical records

- [RPG roadmap](ROADMAP.md) - Current milestone sequencing plus preserved milestone history. Planned behavior is not a shipped contract.
- [Revision 2 integration plan](revision-2-integration-plan.md) - Approved post-M4 actionable execution design, subordinate to roadmap scope and status.
- [RPG integration plan](rpg-integration-plan.md) - Original integration design and historical operation ledgers; current implementation can be newer.
- [Roleplay architecture notes (2026)](roleplay-architecture-2026.md) - Dated architecture decisions and historical checkpoints; current status statements may age.
- [Roleplay product/feature snapshot (2026)](trending-roleplay-features-2026.md) - Dated internal planning snapshot, not external research, provenance, a commitment, or a contract.

For behavior conflicts, prefer shared runtime contracts and current code, then the [API reference](api.md), [Streaming](streaming.md), and normative repository architecture where applicable. Use dated planning records only for historical rationale.

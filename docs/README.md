# Documentation index

Documents are grouped by their primary role. Normative documents describe current contracts and repository architecture; implementation notes and plans do not override them.

## Authority and ownership

- Runtime code and shared Zod contracts own executable behavior and wire validation.
- [API reference](api.md) owns current HTTP behavior and the sole parseable RPG operation inventory.
- [Operations](operations.md) owns setup, configuration classification, disposable development data, and release-gate guidance.
- [Repository architecture](repo-architecture.md) owns current persistence structure, schema ownership, module ownership, and transaction conventions.
- [RPG roadmap](ROADMAP.md) alone owns current milestone status and remaining product scope.
- Root [`devplan.md`](../devplan.md) is a compact delivered/pending ledger; it cannot override the roadmap.
- Root [`handoff.md`](../handoff.md) owns the immediate engineering baseline and next task.
- Historical and dated plans preserve rationale and checkpoints but never override these current authorities.

## Normative reference

- [API reference](api.md) - Current HTTP routes, request/response contracts, feature gates, error handling, and reconciliation rules.
- [Streaming](streaming.md) - Current SSE contracts for legacy token/swipe, room, and durable M2.11 adventure streams.
- [DM harness architecture](dm-harness-architecture.md) - Authoritative DM conversation and transcript, trust boundaries, subordinate harness preferences, actor sheet references, exact adventure tools/limits, ruleset attribution, provider requirements, and engineering checklist.
- [Exact combat sheet actions](combat-sheet-actions.md) - Exact combat consumable candidates, confirmation, authoritative settlement, replay, and excluded combat-power mechanics.
- [Vendor commerce](vendor-commerce.md) - Exact visible-vendor candidates, confirmation, authoritative prices and transfers, receipts, and replay.
- [Tactical maps](tactical-map.md) - Authoritative local maps, fog, movement previews, persistence, and accessible rendering.
- [SRD 5.1 coverage](srd-5.1-coverage.md) - Licensed rules coverage and explicit gaps.
- [Customizable harness](customizable-harness.md) - Current prompt/harness fields, limits, template behavior, and context assembly.
- [Repository architecture](repo-architecture.md) - Normative implementation ownership, persistence boundaries, current-schema ownership, and source-code map. It is not an HTTP contract.

## Operational guides

- [Operations](operations.md) - Node 22 setup, environment, local deployment, disposable storage, testing, and troubleshooting.
- [Provider configuration](provider-configuration.md) - Provider precedence, credentials, outbound privacy, live tests, and troubleshooting.
- [Provider hardening](provider-hardening.md) - Provider failure classification, privacy, and retry boundaries.
- [Administration UX](administration-ux.md) - Campaign administration interaction guidance.
- [Frontend control plane](frontend-control-plane.md) - Living Atlas campaign workspace, preparation, session recovery, and browser acceptance coverage.
- [Campaign hydration CLI](hydration-cli.md) - Reviewed recipe execution over HTTP, durable ledgers, and generation reconciliation.
- [DM evaluation](dm-evaluation.md) - Deterministic and live DM behavior evaluation guidance.
- [Campaign generation and expansion](campaign-generation.md) - Reviewed generation, dependency-aware apply, planning projections, provider attempt handling, and explicit material delivery; subordinate to the API reference for HTTP contracts.
- [Interactive gameplay agent instructions](interactive-gameplay-agent-instructions.md) - Trusted-local operator workflow, discovery, character/campaign setup, play, and no-retry reconciliation.
- [Planning board](planning-board.md) - Internal contributor workflow for the repository-specific planning board.

## Planning and historical records

- [Playability execution protocol](playability-execution.md) - Ordered three-plan program, small-context subagent workflow, API budget, milestone commits, and reusable execution trigger.
- [Playability progress](playability-progress.md) - Durable execution ledger with committed milestone handoffs, validation results, and remaining live budget.
- [Plan 1: Campaign readiness](plan-1-campaign-readiness.md) - Private provider-free preparation diagnostics and actionable GM remedies; planned, not an activation replacement.
- [Campaign readiness contract](campaign-readiness.md) - Versioned strict DTO, issue taxonomy, and bounded inspection coverage for GM preparation diagnostics.
- [Plan 2: Complete reviewed adventure](plan-2-reviewed-adventure.md) - Supported human/AI branch completion, deterministic recovery, bounded configured-provider evaluation, and source-bound observations.
- [The Last Harbor Light](reviewed-adventure.md) - Provider-free reviewed fixture, exact branch oracle, readiness observations, and P2 journey constraints.
- [Plan 3: Measured memory improvements](plan-3-memory-evaluation.md) - Persisted-context inspection, golden recall evaluation, and evidence-selected runtime improvements.
- [Bounded campaign memory](campaign-memory.md) - Implemented direct SQLite recall, source/authority scope, exact packing limits, scan limitations, immutable narration provenance, and migration behavior.
- [RPG memory framework evaluation](memory-framework-evaluation.md) - Research comparison of SQLite, LangGraph, Mem0, Graphiti/Zep, and Letta, with proposed evaluation gates rather than implementation claims.
- [AI dungeon master design](ai-dungeon-master.md) - Implemented human/AI director controls, bounded provider phases, campaign preparation, research, authority and secret boundaries, and current limitations.
- [RPG roadmap](ROADMAP.md) - Current milestone sequencing plus preserved milestone history. Planned behavior is not a shipped contract.
- [Harness Wars campaign report](harness-wars-campaign-report.md) - Recorded campaign hydration outcomes, canon inventory, and provider probes; not a runtime contract.
- [Revision 2 integration plan](revision-2-integration-plan.md) - Preserved approved post-M4 execution design at its saved checkpoint; historical rather than current next-work authority.
- [RPG integration plan](rpg-integration-plan.md) - Original integration design and historical operation ledgers; current implementation can be newer.
- [Roleplay architecture notes (2026)](roleplay-architecture-2026.md) - Dated architecture decisions and historical checkpoints; current status statements may age.
- [Roleplay product/feature snapshot (2026)](trending-roleplay-features-2026.md) - Dated internal planning snapshot, not external research, provenance, a commitment, or a contract.

For behavior conflicts, prefer shared runtime contracts and current code, then the [API reference](api.md), [Streaming](streaming.md), and normative repository architecture where applicable. Use dated planning records only for historical rationale.

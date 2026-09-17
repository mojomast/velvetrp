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
- [System One decision review](system-one-decision-review.md) - Read-only human review of the immutable System One decision log, turning incorrect verdicts into negative examples for a lane's evaluation corpus.
- [System One Director disagreement report](system-one-disagreement-report.md) - Read-only, deterministic comparison of the shadow Director lane's would-be selections against the authoritative provider composition, producing a review queue of divergent cases.
- [Administration UX](administration-ux.md) - Campaign administration interaction guidance.
- [Frontend control plane](frontend-control-plane.md) - Campaign Command Center workspace, preparation, session recovery, and browser acceptance coverage.
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
- [Context inspection contract](context-inspection.md) - GM-only bounded persisted-dispatch inspection lanes, withholding policy, and byte/token units.
- [Reviewed adventure runner](reviewed-adventure-runner.md) - Bounded provider-free and explicitly authorized live execution policy.
- [Reviewed adventure report template](reviewed-adventure-report-template.md) - Stable evidence and observation format for matched branches.
- [Bounded campaign memory](campaign-memory.md) - Implemented direct SQLite recall, source/authority scope, exact packing limits, scan limitations, immutable narration provenance, and migration behavior.
- [RPG memory framework evaluation](memory-framework-evaluation.md) - Research comparison of SQLite, LangGraph, Mem0, Graphiti/Zep, and Letta, with proposed evaluation gates rather than implementation claims.
- [Bounded NPC knowledge and rumors](npc-knowledge-rumors.md) - Research design and evaluation plan for per-agent observation ledgers, rumor propagation, and attribution/privacy/false-memory gates; the ledger and its gates are now shipped, the per-agent belief projection is not.
- [Plan 4: Living knowledge and rumors](plan-4-living-knowledge.md) - Implemented observation ledger across NPC dialogue, factions, gossip, quest offers, and evaluated attribution/privacy gates; the clue-source bridge is deferred with its schema blocker recorded.
- [Plan 5: A living-world Director](plan-5-living-director.md) - Ordered plan to give the AI Director ordered beat composition, bounded read grounding, world time/ambient beats, knowledge narration, and evaluation.
- [Jev (TypeSafe System One) integration](jev-integration.md) - Design for an optional typed-decision provider lane (choice/score/noul) with confidence-gated routing, deterministic fallback, and evaluation. The live API is verified and the W0 transport/settings/policy scaffolding plus the gated room-routing lane are implemented; disabled by default.
- [System One (Jev) room-routing benchmark](system-one-benchmark.md) - Generated Jev-vs-DeepSeek results for the room-routing lane: reliability, exact-set accuracy, latency, tokens in/out, and cost.
- [System One Director (L1) calibration](system-one-director-calibration.md) - Generated live calibration of the Director selector against the provider-free oracle, with coverage, Brier/ECE, and the promotion-gate verdict.
- [System One (Jev) Director-lane benchmark](system-one-director-benchmark.md) - Generated Jev-vs-DeepSeek results for the Director lane, including the gated lane that would ship, with latency, cost, and oracle accuracy.
- [System One (Jev) before-and-after benefit report](system-one-benefit-report.md) - Consolidated measured benefit of the Jev lanes: per-decision latency and cost savings, reliability, and quality versus the OpenAI-compatible path.
- [System One (Jev) cost-router benchmark](system-one-router-benchmark.md) - Generated live evaluation of the L7 handler-routing lane against a labeled corpus, with calibration and the promotion-gate verdict.
- [System One (Jev) narration benchmark](system-one-narration-benchmark.md) - Generated live evaluation of the L3 narration-verification lane against a labeled corpus, with calibration and the (not ready) promotion-gate verdict.
- [AI dungeon master design](ai-dungeon-master.md) - Implemented human/AI director controls, bounded provider phases, campaign preparation, research, authority and secret boundaries, and current limitations.
- [RPG roadmap](ROADMAP.md) - Current milestone sequencing plus preserved milestone history. Planned behavior is not a shipped contract.
- [Harness Wars campaign report](harness-wars-campaign-report.md) - Recorded campaign hydration outcomes, canon inventory, and provider probes; not a runtime contract.
- [Revision 2 integration plan](revision-2-integration-plan.md) - Preserved approved post-M4 execution design at its saved checkpoint; historical rather than current next-work authority.
- [RPG integration plan](rpg-integration-plan.md) - Original integration design and historical operation ledgers; current implementation can be newer.
- [Roleplay architecture notes (2026)](roleplay-architecture-2026.md) - Dated architecture decisions and historical checkpoints; current status statements may age.
- [Roleplay product/feature snapshot (2026)](trending-roleplay-features-2026.md) - Dated internal planning snapshot, not external research, provenance, a commitment, or a contract.
- [SRD 5.1 parity plan](srd-5.1-parity-plan.md) - Gap map and phased plan for full SRD 5.1 rules and content coverage; planning only.
- [OmniVoice Studio support plan](omnivoice-support-plan.md) - Proposed optional voiced narration design and remote OmniVoice builder handoff; planning only.

For behavior conflicts, prefer shared runtime contracts and current code, then the [API reference](api.md), [Streaming](streaming.md), and normative repository architecture where applicable. Use dated planning records only for historical rationale.

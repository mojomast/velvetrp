# Plan 4: Living knowledge and rumors

Status: in progress. P4.1 (observation ledger + write path) and P4.2 (bounded
co-presence propagation) are implemented and committed; later milestones are
planned, not implemented. Researched against current `main` after Plan 3
closeout. Design research and sources:
[docs/npc-knowledge-rumors.md](npc-knowledge-rumors.md). Follow [the shared
execution protocol](playability-execution.md); small-context subagents with
exact ownership; milestone commits must remain buildable.

## Outcome

One bounded, attributable, privacy-safe observation ledger shared across the
game, so that committed events shape what specific agents know and can act on
later. At minimum the NPC rumor case must work end to end (witnessed bet,
co-presence spread, a later NPC teasing the player with correct attribution),
plus at least two other interaction levels from the survey below. Every wired
level gets evaluation for attribution, privacy, and false-memory failures. If
a level cannot meet its gate, record it incomplete rather than overclaiming.

## Interaction levels (surveyed against current code)

| Level | Today | Knowledge opportunity | Authority guard |
| --- | --- | --- | --- |
| NPC -> NPC rumors | `campaign_npc_presence_v43` per session; Director narrates only present public NPCs | Witnesses at a committed receipt gain `witnessed` observations; co-presence and social links spread `told` chains | Hearsay never outranks a committed receipt; no cross-session spread by default |
| NPC -> player disclosure | `story_clue_sources_v34` `source_kind` closed to node/plot-point; `reveal_threshold` counts revealed sources | Extend clue sources with NPC observations, or bridge knowledge into the existing clue-reveal count | Existing threshold/visibility triggers preserved; player projection stays structural |
| World gossip pool | none | Campaign-scoped pool entries derived only from public receipts; present NPCs sample with "you heard it around" attribution | No "everyone knows"; pool never carries private receipts |
| Faction knowledge | `campaign_faction_relations_v28`, `campaign_reputation_ledger_v28`, `change_faction_reputation`; reputation already gates travel policy (`actorTravelPolicy.ts`) | Faction observations from member NPCs; deterministic faction reactions gated on knowledge + standing | Same ledger authority as reputation; no new reaction without its own command + receipt |
| Party / companion awareness | `companion_presence_links_v45` companion actors | Companions witness events; in-party recall of what the companion actually saw | Companion knowledge obeys actor-control privacy; never outranks player/committed state |
| Quest gating | `createCampaignQuest` has no knowledge gate | Knowledge-gated quest offers (GM-authored offers referencing a rumor) as an evaluated candidate | No automatic quest invention; offer must name its knowledge source |
| Economy / merchant memory | `merchant_state_json` on NPC metadata; deterministic commerce repo | Shopkeeper recalling credit, debt, past behavior via knowledge + relationship | Economy settlement stays deterministic; memory only shapes authorized offers/quotes |
| Encounter / enemy adaptation | generation drafts already receive `partyActorIds` and campaign context | Enemies that heard about party tactics affecting generated encounters | Deferred: requires separate approval and evaluation; never grants unfair hidden data |
| Cross-session spread | presence is per-session; recall is campaign-wide | Rumor moving between rooms through the gossip pool | Deferred until the campaign pool ships and privacy gates pass |
| GM diagnostics | context inspection lanes + provenance sidecars | Show which observations fed a dispatch; extend `source_kind` | No new raw payload exposure |

## Shared design

- **`agent_observations`** ledger: `campaign_id`, `timeline_id`, `agent_kind`
  (`npc` | `faction` | `companion` | `town`), `agent_id`, `source_command_id`,
  `observed_revision`, `channel` (`witnessed` | `told` | `refuted`),
  `relayer_agent_id`, `hop_count`, frozen `text`, `authority`
  (`rumor` | `verified` | `belief`). Written only from committed receipts and
  co-presence; never from narration or LLM extraction.
- **Writes** run inside the same immediate transaction as the underlying
  receipt (pattern: `campaignContextInspectionProvenanceWrite.ts`).
- **Propagation** is bounded fan-out at write time: witnesses are recorded when a
  committed event settles, and `told` rows spread on co-presence arrival with a
  hop cap. A per-agent cap (default 256) refuses new observations past the cap;
  immutable rows are never deleted or evicted. Reads use indexed agent/source
  queries with explicit limits.
- **Contradiction** uses semi-revision: both claims stored; read-time ranking
  `verified` > newer `committed-outcome` > older outcomes > `rumor`;
  corrections are `refuted` observations.
- **Reads** re-run the audience snapshot and agent filter before ranking;
  trust/disclosure gates use `campaign_npc_relationships_v32` trust where a
  level needs them.
- **Prompt integration** adds an `npc-knowledge` budget/layer in
  `server/src/context.ts`; entries are strictly labeled ("you witnessed",
  "you heard from Maren"); immutable rules forbid asserting outcomes or
  knowledge without a ledger row; `MEMORY_AUTHORITY` and `dmNarration.ts`
  wording updated narrowly.
- **Migration**: new SQL asset composed into the exact schema inventory with
  an exact-predecessor upgrade or delete/recreate; server build copies the
  asset alongside the existing four; no backfill of historical events.

## Milestones

### P4.1: Observation ledger and write path

Own: new `server/src/repo/db/npcKnowledgeSchema.sql`, observation write repo,
schema migration tests, orchestration wiring, build asset copy.

Gate: exact predecessor upgrade validates before commit and rolls back;
immutability triggers; no backfill; writes atomic with the source receipt;
zero provider calls; reopened digest stability. Run migration + focused writer
tests and server typecheck.
Commit: `feat(repo): record agent observations from committed receipts`.

### P4.2: Bounded propagation

Own: propagation engine and two wirings — witness fan-out at a committed
mechanical event (adventure check execution) and `told` fan-out on NPC
presence arrival — with hop cap (<= 2 default) and a write-time per-agent cap
(default 256). Immutable rows are never deleted.

Gate: deterministic caps; no cross-session spread by default; no LLM or
narration parsing; observation text derived only from public receipt data;
refuted corrections add rows and never delete; idempotent replay. Run
propagation + cap tests and server typecheck.
Commit: `feat(repo): propagate observations along co-presence`.

### P4.3: Trust-gated NPC reads and recall integration

Own: observation read repo, NPC audience construction in
`campaignAgentContextReadRepo.ts`, new recall source family
`npc-observation`.

Gate: authorization before ranking; actor/location/campaign scope; trust-gated
disclosure; attribution precision on fixture oracles; private material never
ranked. Run recall + privacy tests and server typecheck.
Commit: `feat(repo): expose per-NPC knowledge with disclosure gates`.

### P4.4: Director prompt integration

Own: `server/src/context.ts` budget/layer, `server/src/agent/dmNarration.ts`
labeled entries, `adventurePrompt.ts` authority wording.

Gate: authority strings byte-asserted; present-speaker constraint retained;
no outcome assertion; labeled hearsay only. Run prompt tests, DM narration
tests, server typecheck.
Commit: `feat(agent): feed labeled NPC knowledge to narration`.

### P4.5: Faction knowledge and reactions

Own: faction observation derivation from member NPCs and gated reaction
commands following `change_faction_reputation` precedent.

Gate: deterministic ledger; reaction requires its own command + receipt;
travel-policy precedent preserved. Run faction/reputation tests and server
typecheck.
Commit: `feat(repo): faction-level knowledge and gated reactions`.

### P4.6: World gossip pool

Own: campaign-scoped pool derived from public receipts; present-NPC sampling
with attribution.

Gate: no private receipt enters the pool; no "everyone knows" semantics;
player-facing projections stay structural. Run pool + privacy tests and
server typecheck.
Commit: `feat(repo): town-level rumor pool for present NPCs`.

### P4.7: Quest and story integration

Own: NPC-observation clue sources (or knowledge-to-clue bridge) and
knowledge-gated quest offers.

Gate: existing reveal thresholds and visibility triggers preserved; quest
offers are GM-authored and name their knowledge source; no automatic quest
invention. Run story/quest tests and server typecheck.
Commit: `feat(repo): gate clue disclosure and quest offers on knowledge`.

### P4.8: Evaluation program

Own: corpus/holdouts extension, evaluator additions (`attributionPrecision`,
`negationTermPass`, FANToM-style deterministic subset), hard negatives.

Gate: privacyPassRate = 1; negativePassRate = 1; frozen holdout digest pinned;
authority invariants byte-identical. Run evaluator tests, scripts typecheck.
Commit: `feat(eval): measure NPC knowledge attribution and privacy`.

### P4.9: Integrated report

Own: context-inspection E2E, affected memory E2E, docs, ROADMAP, devplan,
handoff.

Gate: browser reads exact recorded observations, not reconstruction; no paid
call on load/inspect/reload; actor/privacy boundaries; before/after metrics
and real limitations recorded. Optional live comparison stays inside the
shared remaining API budget with first attempts.
Commit: `docs(memory): record living knowledge evidence`.

## Deferred candidates

- Economy/merchant memory, encounter/enemy adaptation, cross-session spread,
  companion in-party awareness. Promotion trigger for each: the shared ledger
  ships with P4.3 gates green, the specific level has its own predeclared
  thresholds, and privacy/noninterference fixtures pass before any
  implementation.

## Evaluation and rollback

Three-layer evaluation from `docs/npc-knowledge-rumors.md` (retrieval,
epistemic projection, prose faithfulness) with fixture taxonomy, hard
negatives, frozen holdouts, deterministic G1-G7 gates, and optional capped
live L1-L6 gates. Rollback is a normal revert of the offending milestone
commit; the ledger is append-only with in-transaction eviction only, and no
historical row is ever rewritten.

## Honest limitations

Layer 2 (per-agent belief projection) does not exist today and no
FANToM-style claim may be made before P4.8. The ledger records what an agent
observed, not whether it understands the event. Rumor spread is capped and
co-presence-derived; believability still depends on the narration model.
No metric directly measures NPC honesty; the substitutes are belief-set
separation, citation fidelity, and contradiction rate.

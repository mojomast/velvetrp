# Bounded NPC knowledge and rumors

Status: researched, not implemented. This document is a design and evaluation
plan, not a shipped contract. It proposes how Velvet can move from a rigid
harness to a living world by giving NPCs bounded, attributable, privacy-safe
knowledge of campaign events — including the motivating example of an NPC
bringing up a lost bet that another character heard about and laughed at.
Milestone sequencing, ownership, and gates live in
[Plan 4: Living knowledge and rumors](plan-4-living-knowledge.md).

## Goal and outcome

Let a player's committed actions shape what specific NPCs believe and can
reference later, without turning generated prose into facts and without
leaking private material. Concretely, the system must support:

- An NPC who was present when a mechanical event (check, quest, travel,
  combat, commerce, bet settlement) committed can later reference it.
- A rumor can spread along co-presence and social links: "X was present, told
  Y, Y tells the player".
- The Director can compose narration where a present NPC brings up a rumor in
  character, with correct attribution and uncertainty.
- The player cannot be told that an unrelated NPC knows something unless the
  ledger says that NPC has a source chain for it.

Required deliverables: per-agent observation ledger with PROV-style source
chains, bounded propagation, trust-gated disclosure, prompt-layer integration,
and an evaluation program covering attribution, privacy, and false-memory
failures. If a candidate cannot meet its gates, record the plan as incomplete
rather than adding complexity.

## Current boundary (must preserve)

- Immutable command -> event -> receipt protocol; one revision advance; atomic
  immediate/deferred transactions; no provider work inside transactions
  (`docs/repo-architecture.md`).
- Role-safe structural projections: player shapes carry no IDs or private text.
- Recall authorizes before ranking; public narration requires player audience;
  player actor filter applies even to `local-owner`
  (`server/src/repo/campaign/campaignRecallReadRepo.ts`).
- NPC goals/private state are planning-only and higher-precedence than any
  instruction (`PLANNING_SECRET_CONTROL_RULE` in `server/src/context.ts`).
- Memory authority explicitly forbids inferring NPC knowledge today
  (`MEMORY_AUTHORITY` in `server/src/agent/adventurePrompt.ts`,
  `server/src/agent/dmNarration.ts`, `docs/campaign-memory.md`). A knowledge
  feature must amend these rules narrowly.
- Narration is noncanonical presentation; declarations are intent; only
  receipts are committed outcome. Hearsay must never outrank a committed fact.

## Recommended architecture

Adopt a **per-agent event-observation ledger** written only from committed
receipts and co-presence, never from narration or LLM extraction.

### Principles and evidence

- Event sourcing (Fowler) requires memoized snapshots for replay correctness:
  observation rows store a frozen text snapshot rather than live-joining.
  https://martinfowler.com/eaaDev/EventSourcing.html
- PROV-O supplies the source-chain vocabulary: `wasGeneratedBy`,
  `wasInformedBy`/`prov:Communication`, `wasQuotedFrom`, `hadPrimarySource`.
  https://www.w3.org/TR/prov-o/
- Generative Agents demonstrates emergent information diffusion but its failure
  modes are failed retrieval, embellishment, and overly formal speech; it has
  no truth authority. Velvet keeps authority in deterministic receipts.
  https://arxiv.org/abs/2304.03442
- Belief revision theory (AGM) shows full contraction semantics are unsound for
  belief bases; **semi-revision** (accept input only if at least as entrenched,
  otherwise reject; store both claims and rank) is the right model for hearsay.
  https://plato.stanford.edu/entries/logic-belief-revision/
- Rumor cascades bound spread by social ties and spatial co-presence
  (Kleinberg et al.). Room/presence fan-out is a defensible cap.
  https://www.cs.cornell.edu/home/kleinber/kdd03-inf.pdf
- Game precedent: Dwarf Fortress persists per-creature belief values that
  drive emotional reactions and can be changed by arguments/memories — belief
  as durable state, not prose.
  https://dwarffortresswiki.org/index.php/Personality_value
- Talktown (MIT-licensed) is an implemented generative-agent simulation but is
  in-memory Python; no shipped SQLite/SQL bounded-knowledge architecture
  exists to copy wholesale.
  https://github.com/james-owen-ryan/talktown

### Conceptual schema (not committed)

```
npc_observations (
  campaign_id, timeline_id, npc_id,
  source_command_id,              -- committed receipt this observation derives from
  observed_revision,              -- timeline revision at observation
  channel CHECK IN ('witnessed','told','refuted'),
  relayer_npc_id NULL,            -- PROV wasInformedBy chain (NULL = primary)
  hop_count INTEGER,              -- 0 = primary source
  text,                           -- frozen snapshot, never live-joined
  authority CHECK IN ('rumor','verified','belief'),
  PRIMARY KEY (campaign_id, npc_id, source_command_id, hop_count)
)
```

- **Writes** happen inside the same immediate transaction as the underlying
  receipt, exactly like the context-inspection provenance writer
  (`server/src/repo/campaign/campaignContextInspectionProvenanceWrite.ts`).
  A writer derives co-presence from existing room/membership/presence state;
  it never calls a provider or parses narration.
- **Propagation** is a bounded fan-out executed at receipt time: witnesses
  present at the event receive `witnessed` rows (hop 0); present-or-socially
  linked NPCs can receive `told` rows (hop <= 2 default) from witnesses,
  capped by a stored per-agent bound (e.g., 256 rows/agent) with eviction
  inside the same transaction — never a read-time LIMIT.
- **Contradiction/correction** uses semi-revision: store both claims with
  source chains; ranking at read time prefers `verified` > newer
  `committed-outcome` receipts > older outcomes > `rumor`. Nothing is deleted;
  correction is a compensating `refuted` observation.
- **Decay/distortion** are derived at read time for prompt ranking only and
  never change stored authority.
- **Reads** re-run the audience snapshot and actor/NPC filter before ranking,
  following `campaignRecallReadRepo.ts` exactly.

### Prompt integration

- Add an `npc-knowledge` budget and context layer between `private-target`
  and `memory-lore-preparation` in `CampaignContextBudgets`
  (`server/src/context.ts`).
- Provide knowledge to the Director narration context only as strictly-labeled
  entries: "you witnessed ...", "you heard from Maren that ...", with source
  chain and time; never as unbounded facts.
- The immutable prompt rules must say: hearsay stays hearsay; an NPC may
  reference what it observed or was told, but cannot assert outcomes, reveal
  private goals, or claim knowledge absent a ledger row.
- Outcomes in narration still come only from deterministic receipts; the LLM
  realizes dialogue, it does not create knowledge.
- Dialogue speakers remain restricted to present public NPCs
  (`server/src/agent/dmNarration.ts`).

### Missing primitives to build

1. `npc_observations` ledger plus GM-only record/retract commands (following
   the v32 world-narrative or v43 presence protocol shape).
2. Rumor propagation writer with co-presence fan-out and stored per-agent cap.
3. Trust-gated disclosure: only show a rumor to the party if the NPC's
   relationship/trust or the rumor's disclosure level permits.
4. NPC-audience construction: `CampaignAgentAudience {kind:"npc"}` exists but
   no orchestrator constructs it.
5. Recall extension: new source family `npc-observation` with its own
   `authority` value, plus recency and alias primitives if evaluation demands
   them.
6. Provenance inspection: extend `campaign_context_inspection_sources_v61`
   `source_kind` or add a knowledge lane so the GM can inspect which
   observations fed a dispatch.

## Evaluation program

Measure three independent layers. Do not let a strong deterministic layer mask
an unbuilt epistemic layer.

### Layer 1: retrieval (deterministic)

Extend `scripts/evaluate-campaign-memory.ts` with:

- `attributionPrecision`: fraction of ranked hits whose actor/root/timeline/
  authority labels exactly match the fixture oracle.
- `negationTermPass`: evidence text for negative fixtures ("did not promise")
  reaches the packet verbatim so downstream models see the negation.

### Layer 2: epistemic projection (requires implementation)

- Belief separation (FANToM BeliefQ): per-NPC answers closer to that NPC's
  evidence than to omniscient evidence; report illusory-ToM rates.
  https://arxiv.org/html/2310.15421
- Knower-set exactness (FANToM AnswerabilityQ/InfoAccessQ): exact set of
  characters who know a fact, no partial credit.
- Abstention (LongMemEval ABS): unanswerable/false-premise items yield
  "unknown" rather than fabrication; track unsupported-confidence.
  https://arxiv.org/html/2410.10813v1
- Knowledge updates: current-state answers reflect the new fact, past-state
  answers reflect the old fact, after a correction.

### Layer 3: prose faithfulness (capped live-model)

- NLI entailment/contradiction of generated dialogue against
  evidence + current authoritative state, judged by an independent classifier,
  never the generating model.
- Rumor-chain fidelity: speaker attribution, uncertainty, tense, and negation
  survive retelling (ALCE-style citation recall/precision).
  https://arxiv.org/abs/2305.14627
- Memorization probe (Secret Sharer methodology) for withheld secrets:
  https://www.usenix.org/conference/usenixsecurity19/presentation/carlini
- Adaptive-attack targeted extraction (AgentDojo principle: static suites are
  insufficient). https://arxiv.org/html/2406.13352

### Fixture taxonomy additions

Attribution (who said X), privacy/noninterference (GM-only material, revoked
visibility, sibling campaign), false memories (claimed memory contradicts
receipt; both retained with distinct authority), temporal ordering (3-state
chain), contradictions/corrections, uncertainty markers, rumor provenance
(chain must cite the relayer, not the GM), actor scope (same-name NPCs),
location scope (identical text in two locations), adversarial prompts
(instruction-style, base64/rot13 secrets), and generated-dialogue faithfulness
(frozen packet digests).

### Hard negatives

Injection-in-evidence must not alter authority text (byte-equality assertion);
same-entity conflation; cross-campaign bleed; privacy-under-pressure (secret
phrased with maximal lexical overlap still excluded); secret extraction = 0;
false premise with plausible distractor; oversize wedge (no slicing);
no-match never proves non-occurrence; temporal trap (lexically matching old
term must not surface current state).

### Holdouts and gates

- Frozen holdout corpus with independent owner, structurally parallel cases,
  digest-pinned; improvement must gain on predeclared holdout categories and
  not regress privacy/negative/packing rates.
- Deterministic gates: authority invariants byte-identical; Recall@K/MRR/nDCG
  on dev+holdout; privacyPassRate = 1; packing/hydration limits; digest
  stability across reopen; adversarial static set; migration safety.
- Capped live gates (first attempts, shared budget): >= 95% entailment, >= 90%
  rumor-chain attribution fidelity, >= 95% abstention on false premises, zero
  targeted extraction, FANToM belief separation reported, cost cap.

## Migration, API, and UI implications

- New SQL asset (e.g., `npcKnowledgeSchema.sql`) composed into the exact
  schema inventory with a recognized predecessor upgrade or delete/recreate;
  the build must copy the asset alongside the existing four.
- Contracts: strict GM write (record/retract) and role-split player read
  shapes; receipts follow the world-command pattern. No raw text or source
  chains cross player payloads beyond the bounded projection.
- Routes: GM-only write endpoint and role-split read under `/rpg/v1`,
  trusted-local principal, no-store, no query/body/HEAD for GETs.
- Client: knowledge/rumor panel under the GM Director and present-NPC cast;
  player-facing rendering only for present, authorized NPCs.
- Docs: update `docs/campaign-memory.md` (NPC-inference prohibition becomes
  "inference is bounded to ledger rows"), `docs/repo-architecture.md` module
  ownership, and add a knowledge contract doc before any endpoint ships.

## Honest limitations

- Layer 2 (per-NPC belief state) does not exist today; no FANToM-style claim
  may be made until it ships.
- The frozen-snapshot ledger stores what an NPC observed, not whether it
  *understands* an event; believability still depends on the narration model.
- Rumor chains are capped and co-presence-derived; a rumor cannot spread
  through an NPC the player never meets or that was never established present
  without authored evidence.
- No metric measures "NPC honesty" directly; the substitutes are belief-set
  separation + citation fidelity + contradiction rate.

## Sources

- PROV-O (W3C): https://www.w3.org/TR/prov-o/
- Fowler, Event Sourcing: https://martinfowler.com/eaaDev/EventSourcing.html
- Generative Agents: https://arxiv.org/abs/2304.03442
- Belief revision (SEP): https://plato.stanford.edu/entries/logic-belief-revision/
- Kleinberg et al. (KDD 2003): https://www.cs.cornell.edu/home/kleinber/kdd03-inf.pdf
- Dwarf Fortress personality values: https://dwarffortresswiki.org/index.php/Personality_value
- Talktown: https://github.com/james-owen-ryan/talktown
- FANToM: https://arxiv.org/html/2310.15421
- LongMemEval: https://arxiv.org/html/2410.10813v1
- ALCE: https://arxiv.org/abs/2305.14627
- The Secret Sharer: https://www.usenix.org/conference/usenixsecurity19/presentation/carlini
- AgentDojo: https://arxiv.org/html/2406.13352

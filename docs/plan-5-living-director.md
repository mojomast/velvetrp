# Plan 5: A living-world Director

Status: complete. P5.1 ordered composition, P5.2 bounded read grounding, P5.3
world time and ambient beats, P5.5 continuity and cast dialogue, P5.6 the
Director evaluation program, and P5.7 the integrated report and browser/E2E
evidence are implemented; P5.4 was delivered under Plan 4 (P4.4). Live evidence
and the remaining quota blocker are recorded in the P5.2/P5.7 notes and the
playability ledger. Researched against current `main` after
Plan 3 closeout; depends on Plan 4 for NPC knowledge, which is now delivered.
Follow [the shared execution protocol](playability-execution.md). Small-context
subagents with exact ownership; milestone commits must remain buildable.

## Outcome

Upgrade the AI Dungeon Master from a one-shot beat selector into a bounded
orchestrator that composes exact beats, grounds its planning in read-only world
state, drives world time and ambient life, and narrates with attributable NPC
knowledge — so the world feels alive without weakening server authority,
receipts, privacy, budgets, or the no-forced-endings rule. Required
deliverables: ordered beat composition, bounded read-tool grounding, world-time
and ambient beats, Plan 4 knowledge integration, continuity-preserving
narration, and a Director evaluation program. If a candidate cannot meet its
gate, record it incomplete rather than forcing it.

## Current Director state

- Two provider calls per beat maximum: private planning (`select_dm_beat`,
  one exact candidate or null) then public narration (`submit_dm_scene`:
  atmosphere + <=2 dialogue lines + one question). `campaignDmOrchestrator.ts`,
  `dmNarration.ts`.
- Candidate vocabulary is seven actions (`campaign-dm-http.ts`): encounter
  materialize/start/enemy-turn/complete, reveal/resolve-node, reveal-clue.
- Planning sees pre-assembled private context and cannot read further; narration
  sees public context plus the committed-result fallback and rejects
  mechanics/agency/ending language via `validDmScene`.
- History is verified receipt summaries only; prior atmospheric prose is not
  available, so scenes can reset.

## Research decisions

- **Workflow over free agent.** Keep a deterministic skeleton
  (gate -> plan -> gate -> narrate -> apply) with the LLM only inside phases;
  add agentic machinery only where a simpler workflow fails, and design tools
  as a first-class interface (poka-yoke: exact IDs, impossible-to-invent
  parameters). https://www.anthropic.com/research/building-effective-agents
- **Plan-and-execute with hard separation.** Planner emits exact candidates;
  executor applies receipts; narration has no tools. Planner and narrator use
  different budgets.
  https://blog.langchain.com/plan-and-execute-agents/ ·
  https://arxiv.org/abs/2305.04091
- **Ground every step in observations (ReAct).** Decisions terminate in tool
  observations, not assumptions.
  https://arxiv.org/abs/2210.03629
- **Make illegality unrepresentable.** Strict JSON schema with enum/const
  candidate IDs computed server-side. https://platform.openai.com/docs/guides/structured-outputs
- **Parallel reads, serial writes, one result per call.** Independent reads may
  run in parallel; mutations run sequentially with a receipt each, and a
  skipped/failed call returns an error receipt so the loop stays consistent.
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
- **Effort budgets and end-state evaluation.** Encode per-scene budgets;
  evaluate the resulting world state and checkpoints, not the step shape;
  durable resume from errors. https://www.anthropic.com/engineering/multi-agent-research-system
- **Director = selection over authored beats, not generation.** Façade's drama
  manager, Failbetter storylets/quality-based narrative, and Emily Short's
  quality/salience/waypoint structures all gate a legal candidate set and keep
  a default healing path; include dramatic-arc state so the system cannot
  wander into an unintended ending.
  https://ojs.aaai.org/index.php/AIIDE/article/view/18722 ·
  http://www.failbettergames.com/echo-bazaar-narrative-structures-part-two/ ·
  https://emshort.blog/2016/04/12/beyond-branching-quality-based-and-salience-based-narrative-structures/
- **Story sifting.** Sift the legal set to a small shortlist before selecting.
  https://doi.org/10.1007/978-3-030-33894-7_27
- **Two-level simulationist control.** Delegate in-world actor behavior to
  bounded simulation; reserve a thin top-level authority for coherence.
  https://doi.org/10.1109/TCIAIG.2013.2287297 · Comme il Faut:
  https://doi.org/10.1109/TCIAIG.2014.2304692
- **Hierarchical generation for long-range coherence.** Structure first, prose
  second, each level constraining the next — the precedent for planning then
  narration. https://arxiv.org/abs/2209.14958
- **Two output fidelity grades.** High-fidelity mechanical outputs vs
  suggestion-only prose must be explicit in the protocol.
  https://arxiv.org/abs/2308.07540
- **Intent -> exact candidates at the boundary.** Free player text maps to
  fixed action/beat candidates before the Director sees it.
  https://arxiv.org/abs/2406.00942
- **Living-world simulation is mostly deterministic, LLM only presents.**
  RimWorld's storyteller paces with tension curves, breathing room, adaptation
  scoring, and threat scaling — all deterministic, none model-authored; the
  model renders color. https://rimworldwiki.com/wiki/AI_Storytellers Game AI
  Pro provides the reusable techniques: event-based simulation, AI LOD,
  knowledge representation, ambient rule-based interactions, social dynamics,
  and Dwarf Fortress simulation principles. https://www.gameaipro.com/
- **Evaluation mirrors RPGBench's two layers** (objective state/rule checks +
  LLM-judge quality), NARRA-Gym dimensions, judge-bias discipline (distinct
  judge model, position-swap, critique-before-score, rubrics + references),
  and FActScore-style atomic receipt verification.
  https://arxiv.org/abs/2502.00595 · https://arxiv.org/abs/2605.08503 ·
  https://arxiv.org/abs/2306.05685 · https://arxiv.org/abs/2310.08491 ·
  https://arxiv.org/abs/2305.14251

## Budget amendment

The current "two provider calls per beat" invariant becomes: planning may make
up to three bounded provider calls including read-only grounding rounds;
narration remains one call; no more than four per beat, all reserved inside the
existing aggregate envelope, with an explicit stop condition.

Recorded and approved: the project owner explicitly authorized live provider
requests for living-Director development, which approves this amendment. It
still applies only inside the shared aggregate live envelope (USD, dispatch, and
token caps), reads remain read-only, and no ambiguous paid call is retried
automatically.

P5.5 raises the per-narration prompt ceiling from 8,000 to 12,000 tokens
(`DM_NARRATION_PROMPT_MAX_TOKENS`) so labeled continuity context fits. P5.7 then
raises the aggregate planning-plus-narration envelope from 24,000 to 32,000
tokens (`DM_AGGREGATE_TOKEN_CAP`) and the per-call completion headroom
(`DM_PLANNING_COMPLETION_MAX_TOKENS = 1024`, `DM_NARRATION_COMPLETION_MAX_TOKENS
= 1536`) so a reasoning model's hidden deliberation and the richer continuity,
grounding, and transition prompts fit without forcing deterministic fallbacks.
Narration remains one call, and the provider's own token and cost budget still
caps each beat, so the shared envelope remains bounded.

## Milestones

### P5.1: Ordered beat composition

Own: contracts selection schema v2 (ordered array, max 3, unique
`candidateId`/`digest`), planning tool and prompt, repository sequential
execution with per-candidate receipts and partial-completion blockers.

Gate: exact candidates only; deterministic order; partial failure records a
receipt and blocker without rollback of committed candidates; existing single
selection remains valid; no forced ending. Run contracts, director
planning/execution, recovery tests and typechecks.
Commits: `feat(contracts): allow ordered beat composition`, then
`feat(repo): execute ordered beat compositions`.

Implemented: `campaignDmCompositionSchema` carries an ordered, unique 1-3
candidate composition; the planning tool and prompt request `composition`
(empty = hold) while the orchestrator still accepts the legacy single
`selection`. `settleDmPlanning` normalizes single/array, validates every
candidate is advertised, and stores the ordered composition; `getDmProposal`
returns the first candidate plus the full `composition`. Execution commits each
candidate in its own transaction (first keeps the run-level command key, later
ones add an ordinal) into a new immutable `dm_composition_receipts` table, so a
later failure blocks with `composition-partial-after-N` and never rolls back an
earlier receipt; a successful run queues one narration over all summaries.
Known limitation: the current candidate model advertises only one domain per
beat, so a second same-domain story candidate is stale and blocks (the required
partial behavior) rather than fully succeeding; fully successful multi-candidate
compositions arrive with the P5.3 ambient/world-time domain or an explicit
revision re-resolution design. No forced ending is introduced.

### P5.2: Bounded read-only planning grounding

Own: read-tool registry (existing recall limits, quest objective read, public
world/NPC read, recent outcomes for a thread), parallel read execution, one
serial write, per-round cap and stop condition, provider request binding.

Gate: reads are server-authorized and read-only; no free-form queries;
recalled byte/hit limits preserved; mutations serialized with receipts; budget
amendment enforced; no provider call on inspection or page load. Run director
orchestrator, recall, budget guard tests and typecheck.
Commit: `feat(agent): ground director planning in bounded reads`.

Implemented: `server/src/agent/dmReadTools.ts` exposes exactly four closed,
strict read tools (`read_campaign_recall` with a topic enum, `read_quest_summary`,
`read_public_world`, `read_present_npcs`) and a strict parser that rejects
unknown tools, extra fields, bad topics, and any free-form text.
`readDmPlanningGrounding` authorizes the caller, requires the run to be
planning, runs read-only SQL/recall with byte bounds (summary <=6000 B; recall
hits <=8 within `CAMPAIGN_RECALL_MAX_BYTES`; quests/world <=16; present NPCs
<=12 using the exact `publicScene` public-cast predicate), and writes nothing.
The orchestrator runs the amendment loop: round 0 keeps the durable dispatch
path, reads execute in parallel via `Promise.all`, rounds 1-2 persist to the new
immutable `dm_planning_rounds` table, and the third call is forced to
`select_dm_beat`; total planning calls <=3 and narration stays 1. Aggregate
planning tokens/cost across rounds are enforced against
`min(24000, adventureTurnBudget.maxTotalTokens)` and the priced cap, and no
ambiguous paid call is retried. Added an exact predecessor upgrade recognizing
databases missing only `dm_planning_rounds`.

Live evidence (owner-authorized): two capped runs through the RouteTok proxy
(`projects/agentrouterrouter`, the already-authorized endpoint
`http://100.72.41.9:8787/v1`) using AgentRouter `deepseek-v4-flash` issued real
grounding reads in both runs — `read_campaign_recall`, `read_present_npcs`, and
`read_quest_summary`. The runner is `scripts/evaluate-live-director-grounding.ts`
(3 beats / 15 calls / 60k tokens / USD 0.05 hard sub-cap, sanitized audit; key
read at runtime, never printed). Combined spend: 8 dispatched
planning/narration calls, 38,596 tokens, ~USD 0.0043 at conservative pricing.
The reasoning model plus proxy latency exceeded the then-30s per-call DM
deadline, so early beats ended `unknown`
(`provider-outcome-unknown-no-automatic-retry`) rather than completing; that is
the intended no-retry fence, no ambiguous call was retried, and no beat forced
an ending. The planning and narration provider-call deadline is now
`DM_PROVIDER_DEADLINE_MS = 120_000`, applied to both the in-process abort timer
and the durable dispatch/round deadlines so they stay consistent. After the
change a 3-beat run completed every beat (6 calls) but the model chose to skip
reads, so the planning prompt now requires at least one grounding read before
deciding. A follow-up run then issued `read_campaign_recall` and
`read_quest_summary`, but its forced final selection round ended `unknown`, so
final selection quality remains model-dependent. Live grounding itself is
proven; raising or removing the forced-read instruction is a P5.6 evaluation
question.

Live reliability hardening: a reasoning model exposed two failures. With the
256-token planning cap it returned reasoning-only output (`finish_reason:
length`, no tool call), and a forced tool choice could return HTTP 400 in
thinking mode. The Director now sends `reasoning_effort: "none"` through a
bounded provider `bodyOverrides` (core body fields cannot be replaced), so
planning and narration return exact tool calls in tens of completion tokens.
Transition beats are also offered when the only blockers are table-wait codes
(`waiting-for-player-combat-action`,
`scene-resolution-requires-gm-binding-or-human-adjudication`), so an AI room
keeps pacing instead of dead-locking while the players decide. A 6-beat live run
then completed 6/6 beats with all four grounding reads and no unknown outcomes
(~53.6k tokens, ~USD 0.0057).

Live playtest campaign: `scripts/live-director-playtest.ts`
(`evaluate:director-playtest`) seeds a provider-free world (three locations,
three present NPCs with ledger knowledge, a four-node story chain with a clue,
and a quest) and drives N live beats through the real repository and
orchestrator, grading state, receipt fidelity, narration presence, leak markers,
and transition pacing. All read/inspection surfaces remain provider-free. The
raised completion headroom (`DM_PLANNING_COMPLETION_MAX_TOKENS = 1024`,
`DM_NARRATION_COMPLETION_MAX_TOKENS = 1536`, with an exact predecessor migration)
and graceful handling of a forced round that returns a grounding tool eliminated
the remaining `unknown` beats. Evidence: 40/40 beats across five seeds and both
engine modes completed with zero objective failures and all four grounding reads
(~76k tokens and ~USD 0.008 per eight-beat run). A pacing prompt tune (prefer an
advertised transition beat when no mechanical candidate can advance) raised
transition selection on stalled beats from about a quarter to about three
quarters, and a recovery check proves re-orchestrating a completed run never
spends a provider call. The campaign stopped when the agentrouter account quota
was exhausted (HTTP 403 `token quota is not enough`); the harness now aborts with
`provider-quota` rather than burning beats. The guarded
`scripts/test/live-director-playtest.test.ts` (set `LIVE_DIRECTOR_PLAYTEST=1`)
runs the harness as a test; the default scripts run keeps CI provider-free.

### P5.3: World time and ambient beats

Own: receipt-recorded world time (deterministic advancement command), ambient
presentation candidates, contract change making the narration question
optional for transition beats, `validDmScene` update.

Gate: world time is a receipt, never LLM-authored; ambient beats cannot mutate
domain state or assert outcomes; forced-ending checks retained; time advanced at
most a bounded amount per beat. Run world/director contracts, narration
heuristic, recovery tests and typechecks.
Commits: `feat(contracts): add world time and ambient beats`, then
`feat(repo): record world time and ambient presentation`.

Implemented: `campaignDmActionSchema` adds `advance-time` and `ambient-beat`, and
`dmNarrationTool`/`parseDmScene`/`validDmScene` make the narration `question`
optional only when the public scene marks `transition: true` (every committed
receipt is a transition beat); agency/outcome/ending rejections are unchanged.
The Director advertises the two transition candidates inside `if(!open)` and only
when the room has no blockers, so they are a pacing fallback rather than a way to
skip a required public rendering or a withheld GM binding. `advance-time` carries
a server-fixed, bounded step (`DM_WORLD_TIME_STEP_MINUTES = 30`, enforced max 60)
inside its binding; execution rechecks the elapsed revision, advances
`world_expeditions_v60.elapsed_minutes`, and writes an immutable
`dm_world_time_receipts` row in the same transaction as the run receipt.
`ambient-beat` writes only a presentation receipt
(`{kind:'ambient-presentation',stateChanged:false}`) and no domain command, so it
cannot mutate state or assert an outcome. The `dm_receipts` and
`dm_composition_receipts` action CHECKs and their authority triggers were
extended so `advance-time` requires the matching world-time receipt and
`ambient-beat` requires no domain command. A new exact predecessor upgrade
rebuilds only those two receipt tables and their triggers, preserving rows. No
new HTTP operation. Known limitation: the model still chooses when to pace;
because the step size and elapsed guard are server-authored, a transition can
never move time by an arbitrary or LLM-invented amount.

### P5.4: Knowledge-aware narration (Plan 4 dependency)

Own: Director public-context assembly and narration prompt entries using only
`agent_observations` rows; present-NPC dialogue offered only when that NPC has a
relevant observation; labeled hearsay wording; `MEMORY_AUTHORITY` amendment.

Gate: exact plan-4 attribution/privacy gates; hearsay never asserted as fact;
no NPC speaks without a ledger row; no outcome assertion. Blocked until Plan 4
P4.3/P4.4 gates pass. Run knowledge/attribution, DM narration tests and
typechecks.
Commit: `feat(agent): narrate with labeled NPC knowledge`.

Delivered under Plan 4 as `85d9d0d`: the `npcKnowledge` channel in
`publicScene` lists only present public NPCs that have ledger rows, trust-gates
hearsay on an explicit relationship, and the narration prompt requires
attribution. `campaign-dm-knowledge.test.ts` covers present labeling, absent
exclusion, trust gating, bounds, and the attribution rule, so P5.4 needs no
separate commit.

### P5.5: Continuity and richer cast dialogue

Own: labeled non-authoritative prior-scene flavor in public context; up to four
dialogue lines and NPC-to-NPC exchanges; present-public-NPC and no-player-speech
constraints retained.

Gate: prior prose is presentation-only and cannot become canon or history;
speaker enum still constrained; mechanics/agency/ending rejection unchanged;
scene does not reset location identity. Run narration contract, heuristic,
prompt-injection tests and typechecks.
Commit: `feat(agent): preserve scene continuity and cast dialogue`.

Implemented: `publicScene` carries `priorScenes`, the last two published
atmospheric prose tails under the same public-source guard as `history`, so a
run that revealed non-public story text cannot leak through it. The narration
contract now allows up to four dialogue lines, including NPC-to-NPC exchange,
while `parseDmScene` still rejects any speaker outside the advertised present
public cast and never accepts a player line. `validDmScene` is unchanged for
mechanics/agency/ending rejection; continuity prose is labeled non-authoritative
and never enters canonical `history` or receipts. The prompt pins the supplied
place identity so a scene cannot relocate the party. Raising the continuity
context required the narration prompt ceiling amendment above. Known
limitation: prior prose influences mood and place only; it is not memory and
cannot be cited as fact by an NPC.

### P5.6: Director evaluation program

Own: extend `server/test/evals/` corpus and `dm-evaluation.md`; deterministic
candidate-choice oracle (given state, expected exact candidate/composition);
RPGBench-style objective checks (receipt fidelity, attribution, no coercion,
leakage) plus rubric fixtures.

Gate: deterministic pass rates predeclared; frozen corpus digest; authority
strings byte-identical; no live gate required. Run DM evaluation suite and
server typecheck.
Commit: `feat(eval): measure director orchestration quality`.

Implemented: `server/test/evals/dm-director-evaluation.test.ts` asserts the legal
exact action set per state with a candidate-choice oracle, commits an ordered
transition composition with exact receipt fidelity, proves GM-only story text
never reaches a public surface while the authority string stays byte-identical,
freezes the rubric digest, and requires every rubric dimension to pass at
baseline with a discriminating fail anchor. The frozen corpus lives at
`server/test/fixtures/dm-evals/director-rubric.v1.json` (digest
`7044aeb5e6fd11a0010f97a4bc1ad77fc32653f7407559b15c894a8b8af2c274`).
`campaign-dm-ambient-time.test.ts` additionally locks the transition-pacing
oracle while a revealed scene waits on the table. No live gate is required.

### P5.7: Integrated report

Own: Director browser E2E, affected DM/memory E2E, docs, ROADMAP, devplan,
handoff.

Gate: browser proves composition/ambient/knowledge behavior, no paid call on
load/reload, map/conversation retained; before/after quality and cost recorded;
optional capped live rubric with first attempts within the shared budget.
Commit: `docs(director): record living-world director evidence`.

Implemented: `e2e/tests/campaign-dm-living.spec.ts` drives the real client against
an isolated in-process server and disposable SQLite with an injected
deterministic provider. It proves an ordered `ambient-beat` + `advance-time`
composition renders in the DM chronicle, the transition scene is accepted
without a question, the narrator input is a transition carrying the present
NPC's ledger knowledge, the database holds two ordered composition receipts and
30 advanced minutes, and a reload reads state without spending a provider call.
The existing DM, memory, and readiness browser specs still pass. `ai-dungeon-master.md`
and `ROADMAP.md` were reconciled to the composition, transition, grounding,
continuity, and completion-headroom behavior. Live quality evidence is the
capped playtest campaign above; no browser path spends a paid call on load,
inspection, focus, or reload.

## Deferred candidates

- Enemy/faction tactical adaptation to party behavior (inherits Plan 4's
  deferred enemy adaptation; needs separate approval and its own gates).
- Autonomous per-actor NPC agents (Versu-style) beyond the observation ledger.
- Learned salience/utility scoring for candidate surfacing.
- Multi-beat autoplay without a player decision between beats.

Promotion trigger: the shared ledger and composition ship with gates green, the
candidate has its own predeclared thresholds, and privacy/noninterference
fixtures pass before implementation.

## Evaluation blueprint

- **Layer A, deterministic (every commit):** receipts vs state store
  (atomic fact checks), attribution fidelity, no forced endings/coercion,
  no leakage/format violations, parallel-vs-serial write discipline.
- **Layer B, rubric judge (capped, separate judge model):** responsiveness and
  agency, non-railroading, coherence, pacing, dramatic quality, interestingness,
  characterization, diegetic faithfulness — each with anchor examples and
  reference outputs; pairwise with swapped positions for A/B, absolute for
  trends; validate against a small human-gold set and report agreement.
- **Live gates:** objective layer caps are hard (e.g., zero receipt/attribution
  violations in sampled turns); subjective scores are tracked, canaried, and
  never hard-gate alone. First attempts only.

## Migration, API, and UI implications

- Contract changes: ordered selection, optional narration question, world-time
  command, knowledge-labeled narration. Strict schemas and unknown-field
  rejection retained.
- No new persistence beyond world-time receipts (Plan 4 owns the knowledge
  ledger); world time is a domain command with a receipt.
- UI: Director panel may show the composed beat and world time; player-facing
  text never exposes dispatch/tool internals.
- Docs: update `dm-evaluation.md`, `ai-dungeon-master.md`, `docs/ROADMAP.md`,
  and the API inventory if the operation count changes.

## Honest limitations

- Composition and grounding improve direction, not prose quality; the narration
  model still determines believability.
- Ambient/world-time simulation is intentionally shallow; it is pacing and
  color, not a full world simulation.
- Plan 4 gates are a hard dependency for knowledge narration; without them the
  Director correctly avoids inventing NPC knowledge.
- No single metric proves "living world"; the substitutes are receipt
  fidelity, attribution, pacing, and player-agency preservation under the
  rubric.

## Sources

- Anthropic, Building Effective Agents: https://www.anthropic.com/research/building-effective-agents
- Anthropic, multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Claude parallel tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
- ReAct: https://arxiv.org/abs/2210.03629
- Plan-and-execute: https://blog.langchain.com/plan-and-execute-agents/ · Plan-and-Solve: https://arxiv.org/abs/2305.04091
- OpenAI structured outputs: https://platform.openai.com/docs/guides/structured-outputs
- Façade drama manager: https://ojs.aaai.org/index.php/AIIDE/article/view/18722
- Versu: https://doi.org/10.1109/TCIAIG.2013.2287297 · Comme il Faut: https://doi.org/10.1109/TCIAIG.2014.2304692
- Storylets design space: https://doi.org/10.1007/978-3-030-04028-4_14 · Felt story sifting: https://doi.org/10.1007/978-3-030-33894-7_27
- Failbetter narrative structures: http://www.failbettergames.com/echo-bazaar-narrative-structures-part-two/
- Emily Short, quality/salience/waypoint: https://emshort.blog/2016/04/12/beyond-branching-quality-based-and-salience-based-narrative-structures/
- Dramatron: https://arxiv.org/abs/2209.14958
- CALYPSO: https://arxiv.org/abs/2308.07540 · Thespian: https://arxiv.org/abs/2308.01872
- PWIM: https://arxiv.org/abs/2406.00942 · Drama Llama: https://arxiv.org/abs/2501.09099
- Hidden Door: https://www.hiddendoor.co
- RimWorld AI Storytellers: https://rimworldwiki.com/wiki/AI_Storytellers
- Game AI Pro (free chapters): https://www.gameaipro.com/
- RPGBench: https://arxiv.org/abs/2502.00595 · NARRA-Gym: https://arxiv.org/abs/2605.08503
- MT-Bench judge: https://arxiv.org/abs/2306.05685 · fairness: https://arxiv.org/abs/2305.17926 · self-preference: https://arxiv.org/abs/2404.13076 · Prometheus: https://arxiv.org/abs/2310.08491
- FActScore: https://arxiv.org/abs/2305.14251 · OpenMEVA: https://arxiv.org/abs/2105.08920
- Hamel evals: https://hamel.dev/blog/posts/evals/ · SRE canarying: https://sre.google/workbook/canarying-releases/

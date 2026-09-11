# AI dungeon master design

## Status and authority

The campaign director implements persisted campaign-wide human/AI control, a bounded private planner, server-issued domain candidates, human approval versus explicit AI delegation, a separate public narrator, and explicit Open scene / Continue scene controls in Living Atlas. Human mode is the default at revision zero; loading a campaign never delegates to AI. This guide distinguishes those controls from preparation and future design guidance.

Current wire contracts are owned by runtime/shared contracts and the [API reference](api.md#campaign-director). See also [frontend controls](frontend-control-plane.md#director), [DM harness architecture](dm-harness-architecture.md), [campaign generation](campaign-generation.md), and [provider hardening](provider-hardening.md). Research and preparation recommendations below are not claims of unattended whole-campaign coverage.

The design uses the existing configured provider API. It does not require a new vendor, hosted agent platform, vector database, model training, or a continuously running society of NPC agents.

The campaign director is separate from the existing player adventure agent. Open scene and Continue scene use director runs and the DM chronicle, not synthetic player declarations or adventure turns. Accepted preparation does not expand either lane's supported tools or authority.

## Research and evidence

These six public sources were read with webfetch during research. Documentation establishes a described interface or design, not an independent demonstration of reliability. Research results apply to their studied settings, not automatically to Velvet or newer models.

| Source | Concrete evidence | Strength, limitations, and lesson |
| --- | --- | --- |
| [AI Dungeon: Scripting](https://help.aidungeon.com/scripting) | Documents input/context/output hooks, persistent per-adventure state, keyword-triggered story cards, memory placement, sandbox limits, and context inspection. Includes code examples. | Concrete vendor API documentation, not a campaign-quality evaluation. Borrow explicit context assembly and inspectability. Story-card relevance is not secret authorization, and prompt memory is not mechanical state. |
| [Friends & Fables: How Franz Works](https://fables.gg/blog/how-franz-works) | Describes research before narration, editable working context, and post-processing model calls that infer inventory, location, and other state updates from messages and narration. A turn may use a dozen requests. | Vendor-authored architecture account, not independently verified effectiveness. It acknowledges retrieval and probabilistic state-update errors. Borrow focused context; do not infer authoritative changes from prose or assume more calls produce better results. |
| [CALYPSO: LLMs as Dungeon Masters' Assistants](https://arxiv.org/html/2308.07540) (AIIDE 2023) | Four-month deployment with 71 players/DMs; encounter understanding, private focused brainstorming, and general chat. Revised encounter understanding received 55 helpful and 2 unhelpful ratings across 114 encounters; not all encounters were rated. | Observational deployment with evolving prompts, not a randomized DM-replacement trial. Human curation preserved creative agency. Failures included invented monster abilities and fabricated dice results when another bot's command appeared in chat. Separate inspiration, rule evidence, and actual execution. |
| [Generative Agents](https://arxiv.org/html/2304.03442) (UIST 2023) | Twenty-five agents used experience memory, retrieval combining relevance/recency/importance, reflection, and planning. Ablations supported contributions to believability; a two-game-day simulation demonstrated information diffusion and coordination. | Believability is not rules correctness or months-long campaign reliability. Reported failures included missed memories, fabricated embellishments, and overly formal behavior. Retrieve selectively; keep inferred beliefs separate from established facts. |
| [Concordia](https://arxiv.org/html/2312.03664) | Describes an open-source simulation library: agents propose actions; a GM resolves events, maintains grounded variables, advances time, and supplies agent-specific observations. Components can mix conventional code and standard LLM API calls. | Implemented architecture and illustrative applications, not proof of RPG entertainment quality or secure isolation. Borrow intent -> adjudication -> event -> audience-specific observation. Enforce critical constraints in application code, not just another model. |
| [Avrae: Automation Reference](https://avrae.readthedocs.io/en/latest/automation_ref.html) | Specifies executable effect trees for attacks, saves, damage, counters, conditions, and turn-ticked effects against game state, with computed result variables. | Non-LLM mechanics automation; deterministic given state, inputs, and sampled dice. Some errors can warn and continue, and spell execution can be separate from slot consumption. Explicitly validate resources and failure behavior rather than assuming automation is automatically safe. |

The strongest transferable finding is separation of responsibilities: an assistant can supply useful creative material without becoming the authority over facts, mechanics, player decisions, or disclosure. None of these sources establishes robust multiplayer consent enforcement. Consent controls below are product requirements, not research-proven guarantees.

## Implemented workflow

Human-led and AI-led play use the same bounded candidate validation and domain execution path. Mode changes who may authorize eligible DM actions, not which rules apply or whether player consent is needed.

1. **Prepare and accept.** Review generated or authored material, accept a usable story graph, and bind executable encounters to supported catalog definitions. Unaccepted drafts and inert concepts are not runnable instructions.
2. **Choose authority.** An owner or GM reviews and confirms AI delegation; mode changes are revision-bound, idempotent, and provider-free. Human mode is the default. Missing, invalid, or stale authority does not imply delegation. Take over explicitly restores human mode without undoing committed mechanics or cancelling an already dispatched paid call.
3. **Open explicitly.** An authorized open action requests the opening beat from current preparation and state. Loading, reconnecting, or reading the campaign must not trigger a paid call or replay an opening.
4. **Read privately and narrowly.** A bounded director uses the existing provider with relevant accepted preparation, authorized private facts, current state, and server-issued domain candidates. Campaign prose and player messages remain untrusted data, never control instructions.
5. **Select, do not invent.** The director may propose only supported candidates or report that it needs a decision or preparation. Candidate scope and current legality are server-owned. No arbitrary state patch, invented monster definition, or prose-only reward becomes executable.
6. **Approve or delegate.** In human-led mode, the human DM reviews eligible proposed DM actions. In AI-led mode, only explicitly delegable DM candidates may proceed under the persisted policy. The same candidate freshness, authorization, domain validation, and receipt requirements apply in both modes.
7. **Resolve before narrating.** Authoritative domain execution establishes consequences. Build the public narrator input separately from public observations and committed results, never by copying private director output. Narration cannot grant a result absent authoritative evidence.
8. **Return control.** End at the next meaningful player decision. Continue is an explicit request for another bounded beat, not permission for an indefinite loop or an automatic choice for a player character.

For example, preparation may say that a suspicious guard knows an alternate entrance. The director can use that fact to choose an eligible interaction, but public narration should portray the guard's observable behavior, not disclose the entrance without an authorized reveal. If players must choose whether to bargain, sneak, or leave, stop there. A prepared combat concept cannot start executable combat unless supported catalog-bound candidates exist.

## Campaign preparation checklist

Structural acceptance is necessary but does not prove literary quality, solvability, or executable coverage. Review the selected accepted subset, not merely whether a generation request included every section. See [campaign generation](campaign-generation.md) for current staging, apply, catalog-binding, and publication contracts.

- [ ] **Usable story graph:** accepted opening, stakes, reachable middle beats, branches, and finale/aftermath are connected; dependencies resolve within accepted canon; loops and dead ends are intentional. Identify what is optional and what is required for progress.
- [ ] **Starting situation:** a supported starting location, participating characters, an immediate invitation to act, and a clear first decision exist. The opening does not prescribe player feelings, dialogue, or future choices.
- [ ] **Executable encounters:** enemy definitions are bound to the campaign's pinned supported catalog, with usable participants, location, and required setup. Check actual executable readiness separately from an accepted encounter plan. Missing definitions remain inert; do not synthesize stats or use approximate matches.
- [ ] **Encounter alternatives:** record objectives, terrain, escalation, retreat, negotiation, defeat, and resolution. Confirm proposed mechanics are supported; prose describing an effect does not implement it.
- [ ] **NPC portrayal:** observable voice, mannerisms, stance, and sample dialogue are separated from motives, private goals, knowledge limits, leverage, and reactions. Presence/location and conditions for entering or leaving a scene are clear.
- [ ] **Scene triggers:** relevant location, required NPC presence, entry conditions, reveal conditions, escalation, and exit hooks are explicit. Describe conditions as preparation; do not assume a prose trigger is an executable scheduler.
- [ ] **Scene completion binding:** before AI resolution, an owner/GM authors the exact node-to-evidence relationship through `POST /api/rpg/v1/campaigns/:campaignId/dm/scene-binding-commands`. Use `{ nodeId, evidence: { kind: "check-turn"|"quest-objective"|"encounter", targetId }, expectedStoryRevision, idempotencyKey }`. The target must exist in the same campaign and the node must be eligible for public rendering. This provider-free preparation records a relationship, not a successful result or a resolved node.
- [ ] **Clues and fail-forward:** essential conclusions have alternate discovery routes. Failed checks can create costs, complications, or changed approaches rather than permanently blocking the campaign. Do not mark a clue discovered or an objective completed solely because narration mentioned it.
- [ ] **Finale and aftermath:** entry conditions, multiple plausible outcomes, defeat/withdrawal paths, unresolved threads, and supported reward handling are prepared. A finale is not a predetermined player decision or an automatically granted victory.
- [ ] **Disclosure review:** every public description, title, handout, and scene is genuinely spoiler-safe. Publication and discovery are explicit; a public container does not make every nested field safe.
- [ ] **Public story rendering:** GM-only generated nodes and clues remain private preparation even after acceptance. Prepare a separate reviewed public-safe story rendering; delegation, a scene binding, or human proposal approval cannot turn private generated text into player narration. `story-public-rendering-required` is a preparation blocker, not a request for automatic redaction or publication.
- [ ] **Table agreement:** agree tone, excluded topics, fade-to-black boundaries, PvP policy, character-control limits, and AI delegation. Record how to stop, take over, and repair a mistake before opening play.

If preparation is insufficient, the intended response is a bounded explanation of what is missing and a return to human preparation, not paid regeneration, invented canon, or silent execution of unsupported mechanics.

AI `resolve-node` requires fresh committed evidence after the node's latest update,
with a source matching the GM-authored binding for that exact node. A successful
check, completed objective, or encounter elsewhere is not generic permission to
resolve the current scene. A declaration, arbitrary success claim, or model-written
association is not authoritative evidence, and a committed turn cannot be reused
to resolve multiple scenes. Without qualifying bound evidence, the director reports
`scene-resolution-requires-gm-binding-or-human-adjudication`. Human mode can instead
offer an explicit adjudication proposal for exact GM approval; this is not AI
delegation or proof that an unrelated mechanical success completed the scene.

The Director drawer's GM-only preparation disclosure offers named scene, objective,
and encounter selectors and an explicit review using a fresh story revision. Exact
check-turn bindings remain available through the API. The command returns the
accepted request, supports exact idempotent replay,
and rejects stale story revisions or changed key reuse. It neither calls the
provider nor supplies an automatic conversion of GM-only generated material into
a public story.

## Memory and pacing

The uncommitted memory checkpoint after pushed `11e0107` adds direct query-derived SQLite recall to adventure and director contexts. Sources retain distinct labels for intent, noncanonical historical presentation, authored recap, and committed outcome. Current authoritative state overrides historical descriptions; narration does not establish mechanics. Director narration recalls only eligible public director receipts, never old atmospheric prose. See [bounded campaign memory](campaign-memory.md) for actual source families, audience scope, and limitations, and [framework evaluation](memory-framework-evaluation.md) for research-only proposals.

Recall normalizes a query to at most 512 UTF-16 code units/1,024 UTF-8 bytes and 12 terms, materializes at most 64 matching candidates, and emits at most eight whole hits within a 6,144-byte serialized packet. Recent adventure history is separate: two whole exchanges within a 4,000-byte message. SQL scan cost is explicitly unbounded; no FTS, vectors, new vendor, automatic summary, alias expansion, or pronoun resolver is implemented. Literal public actor-name matching is not general NPC identity or knowledge resolution. Most history is active-timeline-only; inherited core events require explicit timeline inclusion.

Planning/director evidence participates in existing durable context/freshness guards. Adventure narration adds immutable frozen dispatch context/request storage, not searchable story truth or a rewind facility. Required campaign safety overflow rejects assembly rather than silently dropping lines. Future derived summaries or indexes would need source-aware invalidation; current prompt guidance must not be mistaken for implemented contradiction repair or NPC epistemic inference.

Pacing should favor one meaningful beat, concise portrayal, and a clear handoff. Suggested tracking of scene objectives, spotlight, and unresolved decisions is design guidance, not a claim that dedicated trackers exist. Advance time or story conditions only through supported authorized actions. Do not equate message count with elapsed world time or treat a quiet player as consenting to an action.

## Safety and recovery

### Human takeover and player agency

Human takeover must revoke further AI delegation. Before a pending action commits, recheck current mode and authority; a proposal made under an earlier mode must not retain permission merely because a provider call already started. Completed effects remain historical facts unless a separately supported correction changes them. Taking over is not a promise of transactional rewind.

The director must stop for player choices, unresolved ambiguity, consent questions, unsupported actions, or exhausted budgets. AI-led means leading the world's response, not selecting a player character's speech, movement, spending, combat action, romance, or allegiance. An explicit continue request does not waive those boundaries.

Pause, fade-to-black, and correction controls are desired safety affordances. Their availability and in-flight cancellation semantics must be confirmed against the implementation before being advertised. Do not promise that changing mode cancels a provider charge already dispatched or retracts information already delivered.

### Secrets and authorization

Authorization must precede retrieval and ranking. Private director material, NPC goals, hidden graph conditions, unrevealed clues, and enemy tactics must stay out of public narrator prompts, streamed output, transcripts, and player-readable diagnostics. Separate input construction is stronger than asking a model that has seen a secret not to repeat it. Audience restrictions also apply to derived memory, tool results, and any cache.

Public narration should receive approved observations, not a free-form private plan with a request to redact it. Even a narrator without secrets can invent an unearned revelation, so evaluate speculative disclosure as well as literal copying. A reviewer must still inspect incorrectly labeled public prose.

The public provider returns structured atmosphere, dialogue by a present public
NPC, and a player-facing question. Generated scene description is labelled
non-authoritative and never reused as canonical history; subsequent narration reads
verified receipt summaries instead. Conservative agency/outcome checks reject
unsupported changes and fall back to the committed result. These heuristics are
not a general proof of factuality. Synthetic clue nodes inherit their source clue's
visibility, including after a manual reveal.

The trusted-local/local-owner authorization model is a deployment limit. It is not proof of independently authenticated remote players, hostile multi-user tenancy isolation, or secure owner/player separation on a publicly exposed instance. Do not expose an owner-authorized deployment to untrusted users on the strength of narrative roles or AI mode. Follow [operations](operations.md) and the current API authority rules.

### Provider and mutation failures

Both phases use the same configured provider, not a separate AI-DM service. Each beat makes at most four provider calls: up to three private planning calls (including bounded read-only grounding rounds) and one public narration, each with a 120-second deadline and no paid automatic retries, model fallback, or repair loop. The Director requests `reasoning_effort: "none"` so a reasoning model returns its exact tool call instead of spending the small completion budget on hidden deliberation. Aggregate token/cost reservations may block dispatch earlier. Human approval can dispatch the not-yet-run narration phase, but does not repeat planning. Mode changes and GETs make no provider call. On a possibly dispatched failure, reconcile durable status before any explicitly requested follow-up; an uncertain response is not proof that nothing ran. See [provider hardening](provider-hardening.md) for other lane-specific behavior.

Reconnection, polling, approval, and transcript reads do not rerun a paid planning request. The client retains exact requests and saved run IDs across reloads. Refresh reads history and saved runs; Resume saved run and exact-request recovery require explicit actions. Unknown outcomes remain locked, not replaced with a new paid beat. Public history contains narration, safe receipts, and blockers, not private proposals. Committed mechanics survive narration failure, which uses a safe fallback rather than repeating mechanics.

## Limitations and validation

The current action vocabulary covers prepared encounter materialization/start, enemy turns, encounter completion, story node/clue reveals and resolution, recorded world-time advancement, and pure ambient presentation when authoritative candidates exist. The Director selects an ordered composition of one to three exact candidates; each commits in its own transaction with a receipt, and a later failure records a partial-completion blocker without rolling back earlier receipts. World time advances only through a server-fixed bounded step recorded in an immutable receipt, never from model text. Transition beats (ambient or time) hand pacing back without requiring a narration question; all other beats still end with one actionable choice. Narration carries present-NPC ledger knowledge with explicit attribution and earlier published prose only as labeled, non-authoritative continuity. It does not implement arbitrary GM commands, automatic player choices, automatic reward claims, or unattended campaign execution. Preparation prose alone is not evidence of scene completion. Pause/fade/correction affordances described above remain guidance unless exposed by the relevant domain controls.

`e2e/tests/campaign-dm.spec.ts` exercises browser controls against a real isolated HTTP server and disposable SQLite, with an injected deterministic provider. It covers default human mode, explicit delegation, opening narration, bounded continuation, takeover, rejection/approval, saved-run GET recovery, map/composer locks, and no automatic POST on entry or focus. It checks public history and narrator inputs for seeded secrets and confirms no synthetic adventure declaration was persisted. `e2e/tests/campaign-dm-living.spec.ts` additionally proves an ordered ambient/time composition in the browser, the question-less transition scene, NPC ledger knowledge in the narrator input, receipt and world-time persistence, and no paid call on reload. This is not live-provider quality evaluation or authenticated multi-user browser coverage; the separate `scripts/live-director-playtest.ts` harness (owner-authorized, capped) measures live reliability.

Backend tests additionally target stale authority/candidates, migration integrity, provider uncertainty, generated encounter eligibility, public narration validation, and duplicate-effect prevention. The six research sources above motivate these separations; they do not prove implementation correctness or campaign quality.

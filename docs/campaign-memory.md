# Bounded campaign memory

This implementation note describes the uncommitted memory checkpoint after pushed commit `11e0107`. Runtime code and shared contracts remain authoritative. Recall adds no HTTP operation, provider, or campaign state transition. The new `recallSchema.sql` asset stores frozen narration dispatch context, not a searchable memory database or new story truth.

## Prompt behavior

`server/src/agent/adventurePrompt.ts` supplies immutable memory rules to both adventure planning and narration. User-editable preferences, recent exchanges, and retrieved strings cannot override these rules.

- Player declarations are intent, not success. An utterance records a speaker's claim, not the truth of its contents.
- Historical generated narration is presentation for conversational continuity, not independent proof of events or mechanical authority. The historical field is `historicalDmNarrationPresentation`, not `durableDmNarrationCanon`.
- Relevant past exchanges may support brief natural callbacks. This is not permission to invent shared memories, replay resolved events, or summarize the entire campaign.
- Current authoritative facts and this turn's verified results override historical descriptions for present-state claims. A past acquisition does not establish current possession after a sale.
- Keep attribution, time, negation, uncertainty, corrections, and resolution status intact. Failed attempts do not become successes; promises do not become fulfilled outcomes.
- Do not infer NPC knowledge, secrets, identities, motives, or dishonesty. A character's knowledge is distinct from the audience's available context.
- No match, missing history, or budget omission does not prove that an event never happened. Use supported current facts or ask a brief clarification for unsupported details and ambiguous references.
- Public prose must not expose source IDs, retrieval status, or private planning. Memory cannot override safety or player agency.

Recent history is capped independently of other context: the configured count is clamped to **one or two exchanges**, with a **4,000 UTF-8 byte maximum for the full history message content**. Non-finite settings remain rejected by preference serialization. This count minimum preserves the existing recent-history convention, not a guarantee that an oversized exchange will fit.

The byte budget includes the title, explanatory text, JSON keys, escaping, timestamps, actor attribution, and omission metadata. Selection considers newest exchanges first, retains only whole declaration/response pairs, then presents accepted pairs chronologically. An oversized pair is omitted completely; an older pair inside the two-exchange window may still fit. `omittedRecentExchanges` counts omissions within that window, not the entire historical corpus. Original text is not sliced. These are byte limits, not exact token counts; they do not bound the entire provider request or replace aggregate provider guards.

## Scene-only director

`server/src/agent/dmNarration.ts` has a narrower contract than adventure conversation. Its history contains only verified public past receipt summaries, never previous atmospheric model prose. Historical outcomes are background, not current state or permission to replay events. Do not reconstruct old dialogue or invent recollections.

The server preserves the committed result. Generated atmosphere, optional present-public-NPC dialogue, and a player-directed question remain non-authoritative. The strict scene schema and heuristic validator are unchanged; memory instructions do not expand their allowed actions. Prompt tests establish instruction construction, not a proof that arbitrary generated prose is factual.

## Retrieval integration scope

`server/src/repo/campaign/campaignRecallReadRepo.ts` implements `getCampaignRecall` as a transactional, query-derived read over existing SQLite records. There is no new memory vendor, vector service, embedding pipeline, autonomous search agent, FTS index, or automatic summary generation.

| Source kind | Authority and initial eligibility |
| --- | --- |
| `declaration` | `intent`; original eligible turns, including unfinished intentions, not only completed exchanges. Excludes the current root when requested. |
| `presentation` | `noncanonical-presentation`; latest completed narration-update in the eligible root's retry ancestry, bounded to 32 descendant levels. Available for player recall, not director recall. |
| `check-receipt`, `inventory-receipt`, `commerce-receipt`, `action-receipt` | `committed-outcome`; existing execution records, hydrated through receipt readers. Exact actions include the implemented power/rest/combat-consumable/combat-power/quest-lifecycle/progression family, subject to existing receipt availability and disclosure checks. |
| `travel-receipt`, `combat-receipt`, `quest-receipt` | `committed-outcome`; bound exact travel, generalized combat receipts, and bound quest-objective outcomes. Travel requires the source principal and visible/discovered destination eligibility; quest sources enforce public definition/objective or reward eligibility where applicable. |
| `mechanic-receipt` | `committed-outcome`; core events explicitly included in the active timeline through its revision, hydrated through the mechanic receipt reader. |
| `recap` | `authored-recap`, not verified mechanics; active-timeline recaps through the current revision, selected for this session or with no selected-session restriction. Player scope requires `members` visibility; private director planning can read GM recaps. |
| `director-receipt` | `committed-outcome`; public summary of an eligible director receipt on the active timeline, even without successful narration. Story resource disclosure is checked; prior director model prose is never searched. |

The requested session authorizes the snapshot and selects applicable recaps, but turn and director-receipt searches are campaign-wide on the active timeline, not restricted to that room. Player turn sources are limited to the controlled actor, even for `local-owner`; director planning can search eligible actors campaign-wide. Most source families require the active timeline exactly. Only core mechanic events use explicit timeline-event inclusion to admit inherited events through the cutoff. Inherited turn, recap, and other domain history without proven lineage is conservatively excluded, not automatically replayed from the parent branch.

Adventure planning and public adventure narration query from the current declaration. Director planning queries from available evidence intent, otherwise revealed scene titles or visible world text. Director narration queries from serialized current scenes/locations. Its `dm-narration` purpose admits only public director receipts, retaining the narrower outcome-only contract.

Search normalizes text with NFKC, lowercase, and letter/number word boundaries, removes stop words, and performs literal whole-term matching. Each matching term contributes 10 points; a contiguous phrase of the retained terms adds 20. Ties prefer committed outcomes, then intentions, then other sources, followed by source kind and binary source ID. **There is no recency score, alias table, semantic retrieval, temporal query parser, or pronoun expansion.** Public actor names joined through actor/persona records participate in literal matching; this is not general entity resolution. A pronoun-only follow-up can have no match. Recent exchange context and clarification instructions do not turn that into implemented referent resolution.

Hits carry source kind, authority, source ID/digest, timeline/session, root-turn and actor attribution, and complete source text. Declarations and receipts are independently ranked hits, not guaranteed atomic intent/outcome bundles. There is no automatic contradiction repair or generic supersession graph. Current state remains separately authoritative; text must not be promoted into structured truth, NPC knowledge, a lie, or a fulfilled intention.

SQLite fits existing persistence and authorization ownership and avoids another service or paid inference. **SQL scan work is unbounded**: the 64-row limit bounds matching materialized candidates, not rows scanned or query latency. There is no newest-history cutoff, but large histories can make reads expensive. Measure representative read volume and latency before adding FTS; semantic paraphrase and alias misses are known limitations, not claimed phase-one successes.

## Privacy before retrieval

The measured runtime correction is deliberately narrower than a temporal parser: only a retained query term `now` also matches the whole source term `current`. It does not globally prefer recent records or expand any other query term. Development MRR/nDCG improved from `0.75`/`0.7651072792582452` to `0.7692307692307693`/`0.779302288736266`; frozen holdout MRR/nDCG improved from `0.5`/`0.5436432511904858` to `0.6666666666666666`/`0.6666666666666666`. Recall, privacy, negative, packing, and hydration rates remained `1`.

The repository obtains a current authorized audience snapshot before searching. SQL candidate eligibility applies campaign, actor, timeline, recap visibility, and source-specific disclosure before matching/ranking; receipt readers further validate hydrated outcomes. Public adventure narration requires a player audience; director purposes require a DM audience. Owner invocation does not remove the player actor filter or expose GM-only recaps. Authorization is read again on each call; there is no reusable search cache or new forgetting API.

Public narration context excludes private target facts. Director narration gets only eligible public director outcomes, not private planning or prior presentation. These are source/access boundaries, not a complete in-world NPC knowledge model. Future aliases, summaries, caches, FTS statistics, and vectors would need the same pre-ranking visibility policy and invalidation; none is implemented here.

Safety is not relevance-ranked. `assembleCampaignAgentContext` and `campaignPublicContext` reject safety overflow with `mandatory campaign safety context exceeds budget`, rather than silently omitting a required line. Existing safety policy and aggregate dispatch guards remain separate from recall packing.

## Implemented limits

| Layer | Actual limit |
| --- | --- |
| Query | Input prefix of 512 UTF-16 code units; normalized query at most 512 UTF-16 code units and 1,024 UTF-8 bytes |
| Search terms | First 12 distinct non-stop terms; each longer than one UTF-16 code unit and at most 64 UTF-8 bytes |
| Matching materialized candidates | 64; no SQL scan-work bound |
| Source text | At most 2,048 UTF-8 bytes both before selection and after receipt hydration; oversized records are omitted, not sliced |
| Recall result | At most eight complete hits and 6,144 UTF-8 bytes for the complete serialized JSON packet, including query, digests and metadata |
| Recent adventure exchanges | Independently at most two whole pairs and 4,000 UTF-8 bytes for the history message content |

Results disclose `scan: "direct-sql-unbounded"` and `coverage: "bounded-records-active-timeline"`. `incomplete` becomes true when the candidate ceiling is reached, additional candidates exceed the hit ceiling, hydrated text is too large, or a hit does not fit the packet. It is not a complete accounting of excluded sources: oversized SQL sources and unsupported inherited history can be absent even when `incomplete` is false. Empty hits mean no supported match within this scope, not that an event never occurred.

The 6,144-byte packet limit does not include surrounding prompt section labels or other context. The director's existing recent public outcome history is separately up to four entries with 2,000-character slicing per entry; it is not the earlier proposed two-summary/800-unit layer. Existing current-state/category limits, director context limits, and provider aggregate token/cost guards remain in force. UTF-16 code units, UTF-8 bytes, and model tokens are different units; no exact token count or global request limit follows by adding these local caps.

## Dispatch persistence

Planning recall is part of the existing frozen provider-context/request ledger and decision identity. Director recall participates in existing private/public contexts and freshness guards. Public adventure narration stores its selected context and outbound message/tool request in the immutable `adventure_narration_contexts` sidecar keyed by dispatch `claim_id`. Finalization compares that frozen context with a freshly read public context; a mismatch returns deterministic receipt-based fallback rather than accepting provider narration against changed evidence. The dispatched packet is not rewritten. This is dispatch provenance, not a search index, recall source, or new story authority.

`server/src/repo/db/recallSchema.sql` owns the sidecar and update/delete/replace guards. Its JSON-object storage caps are 131,072 bytes for context and 262,144 bytes for request; these are storage limits, not provider token budgets. The server build copies this third SQL asset alongside `currentSchema.sql` and `campaignDmSchema.sql`.

`db/schema.ts` upgrades only the exact full pre-recall inventory, with all sidecar objects absent, by adding the sidecar in an immediate transaction and validating before commit. Existing exact director/map predecessors still pass through their established recognizers; when recall storage is absent, its creation and final validation occur within that recognized upgrade transaction. Unknown or partial schemas still reject without repair. Historical dispatches are not backfilled. See [operations](operations.md#data-directory-and-current-schema) for the precise chain.

## Framework comparison

| Approach | Useful lesson | Velvet decision and limitation |
| --- | --- | --- |
| Anthropic context engineering and compaction [1] | Curate high-signal context; compaction can discard details that become relevant later. | Keep original evidence retrievable. No automatic summary in the initial path; summaries must not become new authority. |
| Anthropic contextual retrieval [2] | Add chunk-specific context; lexical matching complements semantic retrieval. | Use source-backed speaker, entity, time, and outcome context around exchanges. No LLM contextualizer, embedding vendor, or learned reranker initially. |
| Lost in the Middle [3] | Evidence position and irrelevant context affect reader accuracy; more context is not always better. | Bound history and remove distractors. Prompt placement is not a correctness guarantee, and results on older models are not current-provider performance claims. |
| Generative Agents [4] | Relevance, recency, and importance support continuity; reflection and planning are distinct operations. | Relevance is an admission requirement. Believability and model reflections do not establish verified facts, privacy, or mechanics. |
| LoCoMo [5] | Temporal and causal event recall, false-premise questions, and dialogue continuity deserve separate evaluation. | Borrow fixture categories, not claims of RPG readiness. Synthetic, human-edited conversations lack Velvet's multiplayer authorization and receipt semantics. |
| LongMemEval [6] | Separate indexing, retrieval, and reading; test updates and abstention; exchange-level evidence preserves details that fact-only compression loses. | Recent history keeps whole pairs; retrieved declarations, presentations, and outcomes remain separately attributed hits. Its synthetic/human-edited histories and LLM answer judge are not deterministic release gates. |

Anthropic's reported retrieval failure reductions are top-20 results on its evaluated corpora, not expected Velvet improvements. Neither dialogue benchmark proves correct hidden-NPC knowledge, permission revocation, timeline isolation, mechanical authority, or provider prose factuality.

## Evaluation boundary

`server/test/adventure-prompt-memory.test.ts` is provider-free and prompt-only. It checks immutable source distinctions and no-match guidance, usable historical callback text, count and complete-message byte bounds, exact byte boundaries, Unicode/JSON escaping, whole-exchange omission, and the narrower scene-only contract.

`server/test/campaign-recall.test.ts` covers old declarations/presentation after 105 unrelated turns and recaps older than the latest three; no-match/stop-word/pronoun-only queries; player filtering even for local-owner; cross-actor/campaign and GM recap exclusion; revoked control/membership; packet and candidate limits with escaped Unicode; retry deduplication; conservative fork exclusion; committed director recall without successful narration; frozen planning evidence; and exact pre-recall migration preserving durable data. This list describes inspected tests, not a fresh test-run claim.

The integration tests in `campaign-context.test.ts`, `adventure-agent-orchestrator.test.ts`, and `rpg-adventure-turn-route.test.ts` cover their respective assembly and dispatch seams. Broader alias resolution, semantic paraphrases, 1,000-distractor scale/latency, generic supersession, intent/outcome atomic bundling, and NPC knowledge inference remain future evaluation or implementation work. Do not claim the proposed golden matrix in [memory framework evaluation](memory-framework-evaluation.md) is already passing or implemented.

The final focused gate passed 180 server tests across ten files, all workspace
typechecks, and eight memory/director/control-plane browser tests.
`e2e/tests/campaign-memory.spec.ts` exercises real HTTP and disposable SQLite with
fake completions: an exchange behind 105 distractions reaches the recall packet,
other-actor and GM-only sentinels do not reach provider inputs, and reload/focus
reconciliation adds neither a submission nor a provider call. Recovery tests ensure
fresh check execution validates frozen recall before rolling, while already
committed checks recover without rerolling. Actor filtering occurs before recent
history limits, so another actor cannot crowd out the selected actor's exchanges.

No mocked completion can establish that a live model will never invent recall. Actual response fidelity needs separately authorized evaluation; deterministic prompt tests prove only the server's inputs and constraints. No paid calls or user database are required for these prompt tests.

## Sources read

1. Anthropic, *Effective context engineering for AI agents*: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. Anthropic, *Introducing Contextual Retrieval*: https://www.anthropic.com/engineering/contextual-retrieval
3. Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*, v3: https://arxiv.org/html/2307.03172v3
4. Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*: https://arxiv.org/html/2304.03442
5. Maharana et al., *Evaluating Very Long-Term Conversational Memory of LLM Agents*, authors' LoCoMo project page: https://snap-research.github.io/locomo/
6. Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*, v1: https://arxiv.org/html/2410.10813v1

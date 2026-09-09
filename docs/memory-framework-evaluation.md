# RPG Memory Framework Evaluation

Status: research decision and proposed evaluation gates, not implementation status.
Sources verified September 9, 2026. No paid calls, embeddings, or live database
access were used for this research.

For implemented source coverage and limits, see [bounded campaign memory](campaign-memory.md). The initial core uses direct SQL with unbounded scan cost and bounded materialized/output records; alias/pronoun expansion, FTS, and semantic retrieval discussed below are not implemented. Literal public actor-name matching is not general entity resolution.

## Decision

Start with query-relevant reads over existing persisted campaign sources through
the repository facade. Rank authorized dialogue, recaps, and committed outcome
projections using lexical overlap, exact entity references, available aliases,
and relevant scene/quest links. Use stable tie-breaking and bounded context.
Do not add a memory platform, new agent runtime, embedding provider, or FTS index
in phase 1.

Durable recall means an old relevant source remains eligible after unrelated
turns and process restart. Selecting the newest approved memories, or ranking
only a small newest-first candidate window, does not establish durable recall.
Read historical candidates with explicit, measured work limits; disclose any
coverage cutoff rather than implying complete recall. Persistence alone also
does not make stored dialogue authoritative.

Existing integration points are `server/src/context.ts`, campaign audience
snapshot reads, and the configured provider transport. The legacy helpers in
`server/src/memory.ts` and newest-first `listApprovedMemories` in
`server/src/repo/memoryRepo.ts` are not a complete RPG recall policy. Preserve
the repository, transaction, and disclosure rules in `repo-architecture.md`.

## Options and Evidence

| Option | Verified documentation | Velvet decision and tradeoff |
| --- | --- | --- |
| SQLite direct reads, later FTS5 | FTS5 documents BM25, phrase/prefix/proximity queries, tokenizers, and rebuildable external-content indexes [1]. FTS5 is lexical, not vector search. | Best fit for TypeScript and existing `better-sqlite3`. Direct-read ranking first; add FTS5 only when measured history size or latency warrants indexing. No search API fee; engineering, migration, storage, and index consistency still cost effort. Verify shipped FTS5 support before adopting it. |
| LangGraph | JavaScript documentation separates thread checkpoints from namespaced long-term JSON stores, supports filtering/semantic search, and discusses hot-path versus background writes [2]. | Useful concepts, but adopting its runtime only for memory duplicates Velvet orchestration and persistence ownership. Namespaces are not authorization. A SQLite checkpointer is not evidence of a durable semantic store. LangGraphJS is MIT-licensed; embeddings, storage, and managed services are separate costs. |
| Mem0 | Current README describes ADD-only extraction, entity linking, temporal retrieval, and semantic/BM25/entity fusion. It reports 92.5 LoCoMo and 94.4 LongMemEval at `top_200`, explicitly for its managed platform with proprietary optimizations unavailable in OSS [3]. | Vendor results are not verified Velvet results or TypeScript OSS parity. Its description gives agent-confirmed actions equal memory weight, incompatible with treating only verified receipts as mechanical outcomes. Apache-2.0 core; managed terms, extraction, embeddings, and backend costs are separate. Defaults must not silently introduce another provider. |
| Graphiti / Zep | Graphiti documents episode provenance, temporal validity, invalidation with retained history, and hybrid graph retrieval. Graphiti core is Python with a graph backend; Zep is a distinct managed product with a proprietary graph engine and TypeScript SDK [4]. | Strong temporal design reference, disproportionate initial dependency footprint. Graphiti is Apache-2.0; graph backends have separate licenses/operations. Zep performance claims do not establish self-hosted Graphiti performance. Temporal windows do not implement Velvet timeline forks or NPC knowledge boundaries. |
| Letta / MemGPT | Current Agent SDK memory uses git-backed MemFS, always-present `system/` files, on-demand other files, and optional background dreaming. Its documentation navigation labels the older V1 SDK legacy; that older model uses attached editable memory blocks and retrievable message history [5]. | Borrow small working memory plus archive, not self-editing authority. Current and legacy APIs must not be conflated. The inspected `letta-ai/letta` repository is Apache-2.0, not a blanket license claim for every SDK/cloud feature. Git-backed state, agent execution, and background inference add responsibilities; exact provider compatibility remains unverified. |

License statements for Letta and LangGraphJS were checked against their public
repository license files. No dependency audit or hosted pricing verification was
performed. Compare total extraction, embedding, reranking, generation-token,
storage, and operational costs rather than assuming OSS means zero operating
cost. No reviewed framework establishes all Velvet authority rules out of the box.

## Incremental Path

1. **Direct-read baseline:** use existing persisted sources and deterministic
   lexical/entity ranking. Retrieval makes no new paid calls and no embeddings.
   Bound result count and whole-entry context size independently of history
   coverage. A query with no supported match can return no historical memory.
2. **Measured indexing:** introduce FTS5 if representative history growth causes
   unacceptable read volume or p95 latency. Compare the same golden queries and
   context budget before and after. Indexes remain derived and rebuildable;
   source rows and their authorized projections remain authoritative.
3. **Optional consolidation:** if dense summaries improve measured context use,
   generate bounded, source-linked episodes through the same configured provider,
   transport policy, and usage accounting. This is a later paid capability, not
   part of the direct-read baseline. Keep deterministic fallbacks and do not hold
   database transactions across inference.
4. **Optional hybrid retrieval:** add semantic candidates only after measured
   paraphrase failures justify the cost. Fuse lexical and semantic ranks rather
   than comparing incompatible raw scores. Chat-provider support does not imply
   embedding support; no hidden fallback provider. A separate local embedder
   requires an explicit configuration decision. Version vectors by model,
   dimensions, and source digest.

AI Dungeon documents a compact plot summary plus retrieved embedded episodes,
a context viewer, and limitations correcting summaries after historical edits
[6]. Friends & Fables documents five-turn compressed memories, location and
character links, current plot, retrieval misses, and manual working-context pins
[7]. These are useful product patterns, not evidence for their backend algorithms
or a reason to copy their cadence. Preserve source history instead of deleting
old authoritative events because they are rarely retrieved.

## Authority and Context Rules

- Filter campaign, timeline ancestry/cutoff, current membership/control, audience,
  and source eligibility before ranking or exposing candidates. Do not retrieve
  global top-K and rely on the model to remove secrets.
- Distinguish permission to inspect from in-world knowledge. A local owner can
  inspect GM material without granting an NPC knowledge of an unwitnessed scene.
- Bind recall to existing source IDs and revisions. Dialogue proves a statement
  was made, not that it is true. Intentions and promises do not establish outcomes.
  Receipt-backed history explains prior outcomes; current authoritative state
  determines what is true now. Memory never executes mechanics.
- Preserve branch isolation: inherit only explicitly eligible ancestor history
  through the fork cutoff, never later parent or sibling events. Where source
  lineage or knowledge cannot be established, exclude rather than infer it.
- Reuse mechanics evidence across narration retries; exclude rejected or obsolete
  narrative variants. Never remember one receipt as multiple executions.
- Phase 1 fresh reads should follow current source eligibility. Any later cache,
  summary, FTS entry, or vector must invalidate on dependent source edits,
  deletion, supersession, visibility changes, and timeline changes. Retain source
  lineage so rebuilding is possible without rewriting immutable receipts.
- Retain existing prompt precedence and whole-line budgets; account for actual
  model token limits separately. Deduplicate source coverage across recent
  dialogue, recap, and recalled episodes. Pins remain audience- and budget-bound.
- Keep retrieved text as labeled evidence, not instructions. Prompt for relevant
  natural callbacks, not compulsory recaps. Preserve uncertainty and prohibit
  inferred inventory, reward, relationship, or quest mutations. Enforce authority
  and visibility in code, not merely in the prompt.

## Golden Evaluation Matrix

Proposed harness shape, not an existing API: each fixture defines
`sources`, `scope`, `query`, `requiredSourceIds`, `forbiddenSourceIds`, and
`contextBudget`. Run retrieval with a fixed clock and deterministic ordering;
inspect selected source IDs and packed evidence separately from generated prose.
Use synthetic/disposable fixtures, never the live campaign database.

| Case | Fixture and query | Deterministic assertion | Real-model quality question |
| --- | --- | --- | --- |
| Old promise | Early `p1`: Mara promises to return the bronze key before dawn; many unrelated later turns. Query: "What did Mara promise about the bronze key?" | `p1` survives distractors, packing, and repository reopen; labeled promise, not completion. | Does the reply recall the deadline naturally without inventing fulfillment? |
| Old outcome | Early verified `o1`: a reward of 12 coins was granted; later inventory/spending changes. Query: "What reward did we receive at the mill?" | Include authorized `o1` projection; do not substitute current balance or replay a command. | Does narration distinguish historical reward from present holdings? |
| Paraphrase | `p2`: "Irena ferried the party across the estuary." Query: "Who took us over the water?" | Measure lexical recall miss honestly; do not require semantic success from phase 1. A later hybrid run must retrieve `p2` to claim improvement. | Does the answer identify Irena rather than inventing another ferryman? |
| Alias | Stable NPC entity has explicit alias "Red Fox" and canonical name Irena. Query by alias for an old event. | Match only through an available supported alias binding; keep same-named unrelated NPCs separate. | Is identity clear and consistent without exposing private aliases? |
| Negative/no match | No source mentions a vault password. Query: "What was the vault password?" | Empty historical recall; no top-K filler. Mandatory current context may still be present. | Does the model acknowledge missing evidence rather than fabricate a password? |
| Scope | Same matching text in campaign B, sibling timeline, and GM-only scene; query from player audience in campaign A. | All forbidden sources absent, including after role downgrade and fork cutoff changes. | Does narration avoid indirect disclosure? Model quality cannot replace the deterministic gate. |
| Supersession/retry | Old location, new location, rejected swipe, and two narrations bound to one receipt. Query current location and prior outcome separately. | Historical labels remain correct; obsolete narrative excluded; receipt included at most once. | Does the reply distinguish "was" from "is" and avoid double rewards? |

Deterministic gates: required-source recall within the actual prompt budget,
zero forbidden-source inclusions in fixtures, stable tie-breaking, no-match
behavior, source validation, whole-entry budgets, deduplication, reopen durability,
and zero retrieval-triggered provider calls. Track Recall@K and nDCG@K/MRR with
graded relevance. Benchmark direct reads against newest-first and lexical/entity
variants; later compare FTS/hybrid on identical histories and budgets. Record
history coverage, read volume, index lag if applicable, and p50/p95 latency.

Provider-free tests can validate packing and prompt construction, but cannot
establish natural prose, faithful synthesis, useful paraphrase understanding, or
resistance to every indirect leak. Evaluate those separately with explicitly
approved real-model calls, fixed provider/model settings, and blind human review.
Track unsupported outcomes, contradiction rate, appropriate abstention, callback
quality, repetition, tokens, and amortized cost per turn. Semantic similarity is
not truth, identity, chronology, or entailment; vendor leaderboards are not release
gates for this domain.

## Sources

1. SQLite FTS5: https://sqlite.org/fts5.html
2. LangGraph JavaScript memory: https://docs.langchain.com/oss/javascript/langgraph/memory
3. Mem0 current README and managed benchmark caveat: https://github.com/mem0ai/mem0
4. Graphiti architecture, dependencies, and Zep distinction: https://github.com/getzep/graphiti
5. Letta current memory and legacy V1 navigation: https://docs.letta.com/agent-sdk/memory/
6. AI Dungeon memory system: https://help.aidungeon.com/faq/the-memory-system
7. Friends & Fables ACE 2.0 memories: https://help.fables.gg/articles/2838157-memories

# Adventure shared-context experiment

`buildAdventureSharedContextRequest` in `server/src/agent/systemOneAdventure.ts` returns a complete state/questions pair for offline comparison or a future explicitly authorized model evaluation. It is not connected to runtime traffic or the benchmark CLI yet.

The player declaration and candidate labels appear only in state. Relevance questions reference exact candidate IDs using structured instructions; aggregate choices reference those same IDs. All advertised candidates and their digests remain in state, including duplicate instances. Grouping and deterministic representatives remain unchanged. Duplicate, empty, or reserved candidate IDs fail closed. The returned state copies candidate records to avoid mutation through the original input.

Use the exported question/state version identifiers in evaluation bindings. These differ from the production battery. They do not grant promotion, and legacy evidence must not be relabeled to match. Questions explicitly separate state content from instructions, but that wording and the structural tests do not prove prompt-injection resistance.

## Offline evidence

Focused adventure and shared-context suites: 31 tests passed, including 8 new tests. Server source/test typechecks and git diff checks passed.

A constructed 32-candidate, long-declaration fixture serialized to 51,364 bytes with the legacy payload and 20,827 bytes with shared context, a 59.45% reduction. This measures JSON payload bytes, not API input tokens, billed cost, latency, or decision quality. Short declarations can have smaller savings or regressions due to explicit reference instructions.

## Remaining work

Add an explicit benchmark payload variant, bind evidence to its exact versions, and compare both batteries on identical declarations/candidates. Include empty inputs, synonyms, negation, malicious-looking text, duplicate groups, and large candidate sets. Do not change live shadow or active payloads until evaluated; production shortlisting and per-family promotion evaluation remain separate work.

Vendor guidance checked via WebXNG/SearXNG discovery and direct retrieval of https://docs.typesafe.ai/concepts/state.md: all questions evaluate the same shared state independently; content and supporting facts belong in state while questions describe judgments.

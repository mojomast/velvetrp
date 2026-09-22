# Adventure shared-context experiment

`buildAdventureSharedContextRequest` in `server/src/agent/systemOneAdventure.ts` returns a complete state/questions pair for offline comparison or a future explicitly authorized model evaluation. It is not connected to runtime traffic or the benchmark CLI yet.

The player declaration and candidate labels appear only in state. Relevance questions reference exact candidate IDs using structured instructions; aggregate choices reference those same IDs. All advertised candidates and their digests remain in state, including duplicate instances. Grouping and deterministic representatives remain unchanged. Duplicate, empty, or reserved candidate IDs fail closed. The returned state copies candidate records to avoid mutation through the original input.

Use the exported question/state version identifiers in evaluation bindings. These differ from the production battery. They do not grant promotion, and legacy evidence must not be relabeled to match. Questions explicitly separate state content from instructions, but that wording and the structural tests do not prove prompt-injection resistance.

## Offline evidence

Focused adventure and shared-context suites: 31 tests passed, including 8 new tests. Server source/test typechecks and git diff checks passed.

A constructed 32-candidate, long-declaration fixture serialized to 51,364 bytes with the legacy payload and 20,827 bytes with shared context, a 59.45% reduction. This measures JSON payload bytes, not API input tokens, billed cost, latency, or decision quality. Short declarations can have smaller savings or regressions due to explicit reference instructions.

## First live paired check (2026-09-22)

The benchmark CLI ran both payload variants over the same 135-case corpus with three repeats
against jev-1.13.0 (paid calls, owner-approved). Legacy: 10 acted calls at the composed default
with 100% acted accuracy, Brier 0.0001, and 99.8% stability (one conflict). Shared context: 84
acted calls at the same default with 100% acted accuracy in this sample, a recommended sweep
threshold of 0.45, 99.3% stability (three conflicts), and a higher raw recommended Brier
(0.0234); at lower sweep thresholds its acted accuracy is 97.5% (three wrong picks among 120)
while legacy stays at 100%. Across the corpus the shared payload serializes 20.7% smaller in
bytes (77 of 135 cases shrink; 58 small-candidate cases grow by up to 23%), the composed mean top
signal shifts from 0.528 to 0.714, and per case 26 cases act only under shared context while none
act only under legacy in this sample. Every readout carries request and corpus digests, exact
payload/state bindings, and an approval-eligibility flag.

This is evidence that the payload changes the operating point, not a promotion argument: the
payload remains evaluation-only, curated benchmark cases bypass production shortlisting, and
per-family production-path metrics are still required before any decision.

## Remaining work

The variant and version-bound evidence now exist, and both batteries have been compared on
identical declarations/candidates once. What remains is the automated paired runner: fixed
per-attempt evidence and failure capture, offline regression tests over empty inputs, synonyms,
negation, malicious-looking text, duplicate groups, and large candidate sets, plus measured
provider tokens/cost/latency reported separately from payload bytes. Do not change live shadow or
active payloads until that evaluation is complete; production shortlisting and per-family
promotion evaluation remain separate work.

Vendor guidance checked via WebXNG/SearXNG discovery and direct retrieval of https://docs.typesafe.ai/concepts/state.md: all questions evaluate the same shared state independently; content and supporting facts belong in state while questions describe judgments.

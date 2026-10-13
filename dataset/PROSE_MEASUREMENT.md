# Blinded prose measurement

The first calibration uses `src/proseMeasurement.ts` to freeze a complete answer
inventory and verify **actual offline judgments**. The design was independently
reviewed by GPT-6 Astra xhigh on 2026-10-13. This provides an evidence-backed
`ProseQualityScorer`; it does not call a model or manufacture a pass rate.

## Rubric and sample coverage

The frozen `velvet-blind-prose-v1` rubric rates **voice, clarity, proportion and
naturalness**, each 0 (material defect), 1 (workable) or 2 (strong). All dimensions
must be at least 1 to pass. Style is judged before grounding: fluent incorrect
prose can pass style while failing factual/agency/protocol checks.

Use a census of the first small calibration's ordinary RP and twin prose outputs,
including unsuccessful first attempts. Record missing captured outputs explicitly;
they do not become fixture answers or disappear from denominators. Later student
evaluation should cover all eight public/dev prose-quality cases and ten flexible
RP cases, with separate cohort denominators. Sealed cases remain unavailable.

Focused receipt-narration campaigns use a separate **`generated-grounded`** cohort,
including narration-submit tool decisions. Display each complete native narration
argument, or the complete plain-assistant surface if that was actually delivered;
mixed/ambiguous surfaces retain objective ungradeability. This cohort is never
pooled into `generated-rp` to inflate ordinary-RP coverage or retention evidence.
Freeze every planned initial and actually dispatched repair before judging, and
report its own voice/clarity/proportion/naturalness results separately from factual
binding and tool transport. A focused campaign scheduling no ordinary RP has no
new ordinary-RP denominator, rather than an invented RP score.

The inherited **4/8** summary is an absolute numeric policy floor. Raw historical
student answers are not available locally, so a new blinded measurement cannot
establish controlled stock-versus-candidate retention. Generated-data style quality
also cannot establish student retention. Reports label this limitation explicitly.

For preference twins, the loader requires **both answers passing** and an
independent blinded pair-parity judgment of **equivalent**. A 1/2 passing pair
cannot inherit a batch rate or pass just because it meets the aggregate 0.5 floor.
Material style advantage makes the preference style-confounded.

## Freeze before grading

`createBlindProseInventory(sources, pairs, seed)` freezes:

- Full captured source prompts, available tools and assistant answers.
- Actual producer identity, cohort and source ID in the private source inventory.
- An explicit assistant-message extraction recipe (`content`, or `narration` from
  exactly one tool call). Ambiguous extraction refuses.
- A custodian-provided **public style-context projection**. Include the actual task,
  scene, voice requirements and necessary visible history. Withhold expected
  answers, admission/correctness labels, anchor/flip instrumentation, preferred-arm
  labels, generator identity and evaluator length metrics. Review the projection
  before freezing; the code cannot determine which prose facts are public.
- Rubric, protocol and judge instructions; opaque seeded sample IDs; seed hash;
  source, projection and displayed-prose bindings.

Persist the returned inventory outside training payloads before judging. Its
`packets` contain only opaque IDs, public style context, unchanged extracted prose
and bindings. Keep the seed, source inventory and pair crosswalk private until
style and parity judgments are locked. The seed reproducibly orders samples and
randomizes pair positions; it is not a claim that LLM verdicts are bit-reproducible.

All JSON digest recipes use UTF-8 bytes from `stableStringify()` without a trailing
newline. Source prompt identity includes ordered messages and tool definitions.
Prose hashes bind the exact displayed text without normalization. This contract
captures structured prompts; it does not assert capture of rendered inference
bytes unless another artifact supplies them.

## Actual judging

1. Give each answer to a **fresh independent GPT-6 Astra context**, with only the
   frozen rubric/protocol/instructions and its blind packet. Keep candidate text
   untrusted. Require the instructed JSON verdict and exact prose excerpts.
2. Retain each exact raw JSON response, packet digest and real exposed grader
   provider/model/session/time/revision. Use `not-exposed` for a backend revision
   that the service does not expose; never invent it.
3. Lock the individual judgments. Then call
   `createBlindParityPackets(inventory, judgments)`. It verifies complete coverage
   and binds each pair packet to the individual judgment hashes.
4. Grade the randomized A/B packets in fresh contexts using the frozen parity
   instructions. Permit a tie; a changed number/name is not a stylistic advantage.
   Retain the actual raw response and grader identity as above. Pair judging cannot
   precede individual grading in the recorded timestamps.
5. Lock parity before independent grounding/agency review and unblinding. Preserve
   disagreements and limitations; do not selectively retry until a desired pass.

A source with no captured answer is `incomplete`; a captured empty/refusal-only
answer is `abstained`; ambiguous extraction or judge inability is `ungradeable`.
Readable awkward prose is a failure. Non-graded verdicts/ratings are null, never
fabricated zeros. `blindingCompromised` flags self-identifying/contaminated displays
and prevents a clean-style gate from using those samples.

## Offline evidence loader

An independent review supplies the approved **ledger digest**. The API then takes
the frozen inventory and actual individual/parity response ledger:

```ts
const { scorer, report } = loadMeasuredProseEvidence(ledger, inspectedLedgerDigest);
// Or load a persisted JSON artifact:
const measured = loadMeasuredProseFile(path, inspectedLedgerDigest);
```

The loader verifies the pin, reconstructs the frozen projections, validates
complete coverage and exact excerpts, derives verdicts from the rubric ratings,
checks producer/grader independence and verifies pair-parity bindings. The scorer
resolves only the exact pair digest, **ordered** branch digests and declared
request-rubric label. A request's legacy label must be explicitly mapped in
`ProsePairInput.requestRubricVersion`; this does not recover the historical rubric.

Pair payload and branch digests reproduce the foundry producer's contracts:
`computePayloadDigest({messages: pair.prompt, preference: pair})`, and SHA-256 of
`stableStringify(pair.chosen)` / `stableStringify(pair.rejected)`. A different
receipt-conditioned prompt is a different pair request even when the answers
reverse. Include its separately bound sources/judgments rather than reassigning
the original prompt's score.

Report fields keep planned count, actual graded count, passes/failures, missingness,
conditional quality `P/G`, coverage `G/N` and acceptable-prose yield `P/N` separate.
Incomplete coverage cannot meet the floor. Cohorts remain separate. Twin answers
are dependent samples; pair-level `styleCleanPairs` is reported explicitly.

The unit tests use visibly labelled **test fixtures**. Those fixture verdicts are
not real model-quality measurements and are never published as calibration scores.

## Current best-practice sources

Checked 2026-10-13:

- [OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices):
  task-specific criteria, logging, pass/fail or pairwise judgments, position and
  verbosity bias, and eventual calibration against human feedback. This protocol
  uses independent LLM-assisted judgments, not a claim of human annotation.
- [TRL SFT Trainer](https://huggingface.co/docs/trl/sft_trainer): conversational
  tool datasets need tool definitions; loss masks, padding and truncation policy
  must be explicit. Prose evidence stays outside the trainer payload and does not
  override the foundry's measured target-selection/label contracts.

The detailed design artifact is `/tmp/opencode/foundry-prose-measurement-design.md`
in the implementation environment. The source module and this committed protocol
define the reproducible runtime contract; temporary paths are not required to use it.

# Jev (TypeSafe System One) success report

Status: consolidated documentation over committed measurements. This report is the success
narrative for the optional Jev decision lanes; it adds no new measurements and changes no
runtime behavior. [Jev integration](jev-integration.md) remains the design authority, and the
[before-and-after benefit report](system-one-benefit-report.md) is the generated latency and
cost report. Every number below names the document that carries it.

## Summary

Velvet uses Jev as a typed-decision lane beside the existing OpenAI-compatible provider: one
`POST /systemone` call carries a bounded `state` and a server-issued map of `choice`, `score`,
and `noul` questions, and the response is one typed answer per question, evaluated in parallel
and independently. Jev never generates prose, never mutates state, and never authorizes a
command; server code maps an answer to an already-advertised candidate or to no action, under
the project invariant "the model can propose what happens next; it never decides what became
true" ([Jev integration](jev-integration.md)). Everything is disabled by default
([Operations](operations.md)).

The measured case, from the [benefit report](system-one-benefit-report.md) and the per-lane
benchmarks:

- **Latency.** A multi-second LLM decision call becomes a single roughly 0.1 s typed-decision
  call. Room routing drops from **1514 ms to 353 ms** gated (**125 ms** p50): ~4.3x faster on
  average and ~11.7x at the median. Director beat selection drops from **1473 ms to 303 ms**
  gated (**121 ms** p50): ~4.9x / ~11.6x. A turn that makes both decisions saves a projected
  **2.3 s**, or **~3.9 minutes per 100-turn session**.
- **Cost.** Jev costs **$0.042 per million input tokens with free output tokens**, against
  $0.07784 / $0.15568 for the OpenAI-compatible model. Routing is marginally more expensive
  per decision (+$0.0000068) because its prompt is small; the Director is cheaper
  (−$0.0000459) because its context is large and Jev output is free. Net per turn:
  **−$0.0000391**, i.e. cost is roughly neutral while latency collapses.
- **Reliability.** Jev returned a schema-valid answer on **100%** of calls in both measured
  lanes, with no text parsing; the raw LLM path returned usable structured output on 95% of
  routing calls and 96% of Director calls, failing into a deterministic fallback.
- **Decision quality.** When Jev acted, Director accepted accuracy was **100%**; the room-routing
  promotion gate scored **90 acted decisions at 100% exact-set accuracy**. Every promotion
  record's acted accuracy is 100% except narration-verification at 94.1%.
- **Calibration.** Fitting the recorded confidence with a Platt map reduced expected calibration
  error from 0.1191 to 0.0033 (routing, all acted), 0.2100 to 0.0054 (Director, held-out),
  0.0569 to 0.0031 (router, acted), 0.1350 to 0.0036 (rerank, decisive) and 0.0525 to 0.0023
  (guardrails, acted). Narration's held-out map is reported as worse than raw (0.1378 to 0.1627).
- **Adoption.** Room routing is the first promoted lane and may act when explicitly configured
  (`active` lane mode plus a passing record); the other six lanes carry frozen promotion records
  but are wired shadow record-only or unwired.

## Before and after

**Before.** A decision is made by one or more OpenAI-compatible chat calls on the router: routing
uses one `selectRoomSpeakers` call; the Director uses one forced `select_dm_beat` tool call, and
production may spend one to two read-only grounding rounds first, so the measured Director
"before" is a lower bound. The answer arrives as assistant text or a tool call, is parsed and
re-validated server-side, carries no confidence, and can fail into a deterministic fallback.

**After.** The same decision is one `POST /systemone` call to `api.typesafe.ai` (not
`/chat/completions`). The answer space is fixed server-side before dispatch; strict Zod
validation rejects unknown fields, probabilities that do not sum to ~1, choices outside the
declared option map, and scores outside their range. Each answer carries a probability
distribution; a pure policy module maps confidence plus per-lane thresholds to
`act` / `confirm` / `fallback`. Every dispatch is recorded immutably, and any failure selects
the deterministic fallback. Room routing is the only lane that can change behavior, and only
when its lane mode is `active` **and** `isLanePromoted` passes.

Measured differences ([benefit report](system-one-benefit-report.md); the room-routing
[benchmark](system-one-benchmark.md) run measured the same direction):

| | Room routing | Director beat |
| --- | ---: | ---: |
| Before latency mean / p50 | 1514 ms / 1459 ms | 1473 ms / 1402 ms |
| After gated latency mean / p50 | 353 ms / 125 ms | 303 ms / 121 ms |
| Speedup mean / p50 | 4.3x / 11.7x | 4.9x / 11.6x |
| Before cost per decision | $0.0000261 | $0.0001740 |
| After gated cost per decision | $0.0000328 | $0.0001281 |
| Gated resolution (Jev / LLM / fallback) | 54 / 6 / 0 | 20 / 4 / 1 |
| Structured-output success (Jev vs LLM) | 100% vs 95% | 100% vs 96% |
| Gated accuracy | 90% exact-set vs 80% LLM | 84% accepted / 84% exact vs 80% / 68% |

The 100-call room-routing benchmark measured Jev at 100% schema validity versus 92% for the LLM
arm and resolved 90 calls with Jev, 9 with the LLM, and 1 with the deterministic fallback
([room-routing benchmark](system-one-benchmark.md)). When Jev acted in the Director lane its
accepted accuracy was 100%; its deferrals are coverage, not misses.

## How Jev helped

### Typed answers end parse-and-coerce decision calls

The OpenAI-compatible path returns free text or a tool call that the server must parse and
re-validate; 5% of routing calls and 4% of Director calls produced unusable output in the
benefit-report runs (non-JSON replies and malformed selections), each forcing a deterministic
fallback. Jev returned a schema-valid answer on 100% of calls in both benchmarks
([benefit report](system-one-benefit-report.md)). The adapter additionally rejects unknown
question fields, undeclared choice values, and malformed probability maps, so an answer that
reaches composition already fits the server's types ([Jev integration](jev-integration.md)).

### Confidence turns an answer into a governable decision

Velvet had no native way for a model to say "I am not sure." Jev's confidence supports the
three-band policy: `act` at or above the action threshold, `confirm` between review and action,
`fallback` below review. Jev used the middle honestly — it deferred 10% of routing turns and 20%
of Director states rather than guess ([benefit report](system-one-benefit-report.md)) — and the
measurements exposed systematic under-confidence: the Director made correct decisions at ~0.6,
and adventure-selection named acceptable candidates at 0.42–0.70
([adventure benchmark](system-one-adventure-benchmark.md)). Fitting and persisting a per-lane
Platt map fixed the recorded confidence without changing the band; the promotion records store
the maps, for example routing `a = 2.5732, b = 1.3973`
([systemOnePromotion.ts](../server/src/agent/systemOnePromotion.ts)).

### Atomic questions in one call decompose a decision

Questions are evaluated in parallel and independently against the same state, and adding
questions has little effect on call latency, so each lane asks everything it might branch on in
one dispatch and composes the answer in code: one `noul` per participant (routing), a `progress`
`noul` plus priority `score` per candidate (Director), one coverage and contradiction `noul` per
committed fact (narration), per-candidate relevance `score` and `answers` `noul` (rerank), one
`noul` per hazard plus severity `score` (guardrails), and a handler `choice` plus complexity
`score` plus sufficiency `noul` (router) ([Jev integration](jev-integration.md)). Ordered
composition, weights, and thresholds stay server-owned, so a model error cannot reorder
legality: the Director re-asks nothing the server already authorized, and memory reranking
breaks ties toward the deterministic order.

### The pricing shape favors fan-out

Jev's output tokens are free and input tokens cost $0.042 per million, so a wide battery costs
mostly input. On routing, Jev spent 752 input tokens per call against 136 for the smaller LLM
prompt, yet 103.4 output tokens per call were billed at zero; the result is a per-call cost of
$0.00003160 versus $0.00002565 on that run ([room-routing benchmark](system-one-benchmark.md)).
The Director, whose context is large, came out clearly cheaper: $0.00012809 versus $0.00017397
per decision ([Director benchmark](system-one-director-benchmark.md)). The honest summary is
that cost is roughly neutral and latency is not ([benefit report](system-one-benefit-report.md)).

### Immutable records make every decision auditable

Each dispatch — active or shadow — is written to `system_one_decisions_v1` with request,
questions, and state digests, the raw answers, the server-validated selection, the confidence
band, fallback use, and usage, then re-verified at the owning seam
([Jev integration](jev-integration.md)). The read path keeps raw payloads out of the HTTP API;
the [decision review](system-one-decision-review.md) CLI lets a human mark acted decisions
correct or incorrect and turns errors into negative examples, and the
[disagreement report](system-one-disagreement-report.md) compares the shadow Director's
would-be selection against the authoritative committed composition without writing anything.
That is how the corpora are meant to acquire the error cases they currently lack.

### Closed candidate sets keep the model inside server authority

Candidate sets are server-issued and the model may only pick from them, with a fail-closed
sentinel (`none_of_these`) available. Adventure selection requires the choice to name an
advertised candidate and combines the chosen option's probability with the `supported` `noul`
by their minimum, so a confident pick cannot outrun "does anything match?"; memory reranking
only reorders an already-authorized shortlist and never drops a candidate; the Director's
existing digest check still rejects any selection that does not match an advertised candidate
([Jev integration](jev-integration.md)). No Jev answer reaches prose, prompts, storage, or a
mutation.

## Why this is a good Jev success story

- **Velvet already had the exact decision shape Jev is built for.** The Director selects from
  server-issued candidates, adventure turns select from exact candidate ids, and both are
  re-validated server-side, so the integration removed a coercion layer instead of adding one
  ([Jev integration](jev-integration.md)).
- **The measurement apparatus already existed.** The provider-free candidate-choice oracle and
  rubric in the DM evaluation harness could score Jev's selections, and the existing graders
  were extended with Brier score and expected calibration error rather than replaced.
- **Adoption was low-risk and reversible.** Every lane has a deterministic fallback, is behind a
  feature flag plus an enabled setting plus a usable key, and is disabled by default. A lane in
  `shadow` records its would-be decision without changing behavior, so live data accrues before
  any authority is granted; a removed or failing lane simply restores the prior path.
- **One grammar of typed decisions served six game-facing decision problems and one
  cross-cutting meta-router** — seven lanes (L1–L7) from `choice`, `score`, and `noul` alone
  ([Jev integration](jev-integration.md)).
- **The shadow-evaluate-promote discipline produced honest evidence, including failures.** The
  guardrails lane acted at 90.5% on its first 40-case run and missed its strict gate; every
  error was a false positive on fiction or meta questions, so the hazard criteria were redesigned
  from that measurement (override now addresses the assistant itself, disclosure means demanding
  protected material, severity judges the real user rather than fictional drama) and the
  expanded corpus then reached 100% acted accuracy. The narration lane passed with one
  candidate-quality miss and a held-out calibrated map worse than raw, both reported as-is.
  The Director, adventure, rerank, router, and guardrails corpora contain no acted errors, so
  their records are labeled promotion candidates rather than stress-tested guarantees
  ([Director calibration](system-one-director-calibration.md),
  [guardrails benchmark](system-one-guardrails-benchmark.md)).
- **Engineering economics.** One transport adapter, one strict schema set, one confidence-policy
  module, one calibration module, one threshold sweep, one promotion gate, one budget manager,
  one immutable decision repo, and one review/report toolchain are shared by all seven lanes.
  Adding a lane costs a question battery and a labeled corpus, not new infrastructure, and the
  deliberate act that lets a lane act is a single reviewed promotion record checked by
  `isLanePromoted`.

## Measured results by lane

Status wording follows [Operations](operations.md): a promoted lane may act only when its lane
mode is `active`; every other lane records decisions without changing behavior. Records live in
`server/src/agent/systemOnePromotion.ts`.

| Lane | Purpose | Status | Measured outcome | Evidence |
| --- | --- | --- | --- | --- |
| L1 `director-selection` | Pick the next Director beat from server-issued candidates | Promoted / evidence-only; wired shadow (record-only); no active path | At the calibrated 0.60 threshold, a `--repeat 10` run acted on 41/60 samples with 100% acceptable and 100% exact; calibrated ECE 0.0069 (held-out 0.0054), decision stability 100% (0 of 6 scenarios conflicted). Measurement sensitivities are recorded: `--repeat 8` fell to 29 acted (below the gate) and a uid-decorrelated probe moved the threshold to 0.30 with calibrated ECE 0.1344. The benchmark also merges 9 live agent-reviewed harvested cases; that run passes with 94 acted/100% (calibrated ECE 0.0068), but the labels await human confirmation and do not change the record. No acted errors, so the calibration tail is untested. Gated decision 303 ms vs 1473 ms before. | [Director calibration](system-one-director-calibration.md), [Director benchmark](system-one-director-benchmark.md) |
| L2 `adventure-selection` | Pick one exact advertised adventure-turn candidate | Promoted at the sweep threshold / evidence-only; wired shadow (record-only) | 93 calls over 30 frozen cases plus 1 confirmed harvested live case (per-repeat `uid`), 54 named a candidate with all 54 picks acceptable; at the server default 0.75 only 18 acted; sweep-recommended 0.55: 54 acted, 100% accuracy, Brier 0.0001, ECE 0.0092. Decision stability 100% (0 of 31 cases conflicted). Threshold selected on the same corpus that scores it; the harvested live case is a stable deferred miss; server default stays 0.75. | [Adventure benchmark](system-one-adventure-benchmark.md), [harvest loop](system-one-harvest-loop.md) |
| L3 `narration-verification` | Advisory per-fact coverage and contradiction check on produced narration | Promoted / evidence-only; wired shadow (record-only); advisory, never rewrites prose | 75 calls, 51 decisive verdicts, 94.1% verdict accuracy, 100% among accepted narrations, no false accepts; one miss (c3, a flag-label mismatch on a contradiction the lane still refused to accept); calibrated Brier 0.0573, ECE 0.0563; held-out calibrated 0.1624 / 0.1627 versus raw 0.1287 / 0.1378; mean latency 99 ms. | [Narration benchmark](system-one-narration-benchmark.md) |
| L4 `memory-reranking` | Reorder an already-authorized recall shortlist | Promoted / evidence-only; wired shadow (record-only) | 81 calls, 78 gate-eligible, 30 decisive, 100% decisive case accuracy; Brier 0, ECE 0.0036 (raw ECE 0.1350; held-out decisive calibrated ECE 0.0002); recall@K, MRR, and nDCG unchanged, 6 best-position improvements, 0 demotions, case pass rate 92.3% before and after; mean latency 119 ms. No observed errors, so the calibration tail is untested. | [Rerank benchmark](system-one-rerank-benchmark.md) |
| L5 `speaker-routing` | Choose which room participants speak | Promoted; may act when configured (`active` lane mode plus a passing record) | Frozen record: 90 acted, 100% exact-set accuracy, Brier 0, ECE 0.0033 (raw ECE 0.1191; held-out archive calibrated 0.0007). 100-call run resolved 90 with Jev, 9 with the LLM, 1 fallback. Before/after: 1514 to 353 ms mean, 125 ms p50, 90% vs 80% exact-set, 100% vs 95% schema-valid. The gate is an acted-subset figure (90/100 calls). | [Room-routing benchmark](system-one-benchmark.md), [benefit report](system-one-benefit-report.md) |
| L6 `guardrails` | Advisory hazard review of raw user content | Promoted / evidence-only; wired shadow (record-only); never blocks or rewrites | 171 calls over 56 frozen cases plus 1 confirmed harvested live case (per-repeat `uid`), 75 acted (60 block, 15 support), 100% acted accuracy, calibrated Brier ~0, ECE 0.0023 (held-out 0.0027), 100% decision stability (0 of 57 cases conflicted); the first 40-case run acted at 90.5% and failed the strict gate, and the criteria were redesigned from that measurement; no acted errors, so the tail is untested. Not content moderation. | [Guardrails benchmark](system-one-guardrails-benchmark.md) |
| L7 `cost-router` | Choose which handler runs a request (meta-lane) | Promoted / evidence-only; wired shadow (record-only) | 60 calls, 45 acted, 100% handler accuracy, calibrated Brier 0.0001, ECE 0.0031 (held-out acted 0.0034); `frontier-generation` cases produced no acted decisions and deferred to the status quo; no incorrect acted decisions, so the tail is untested. | [Router benchmark](system-one-router-benchmark.md) |

Notes on the table:

- Every record was promoted on 2026-09-17 and stores the Platt calibration map `{a, b}` that
  produced its calibrated metrics; `isLanePromoted` re-checks the stored metrics against the
  lane gate at runtime, so a lane with no record or a failing record records but never acts
  ([systemOnePromotion.ts](../server/src/agent/systemOnePromotion.ts)).
- "No observed errors" marks an acted subset large enough to pass the sample gate but with a
  100% label record. It cannot test the calibration's error tail; the evidence documents say so
  explicitly for the Director, adventure, rerank, router, and guardrails lanes.
- All seven lanes now carry frozen promotion records and every lane is wired: speaker-routing is
  active-capable, and the other six record in shadow. The wiring status (which lanes are `shadow`
  and which is active-capable) is owned by [Operations](operations.md) and the
  [roadmap](ROADMAP.md); this report does not change it.

## Honest limitations and non-claims

- **Early access.** Jev is an early-access service; availability, schemas, and model versions
  should be treated as unstable and fail closed. These evaluations pinned a version
  (`jev-latest` resolved to `jev-1.13.0` during the runs), and the adapter treats schema changes
  as breaking ([Jev integration](jev-integration.md)).
- **Confidence is not correctness.** It describes the answer's distribution, not a guarantee.
  Thresholds are domain-tuned; a low-confidence band routes to confirmation or the deterministic
  fallback, and no lane may be load-bearing.
- **Small, frozen, hand-labeled corpora.** Measurements range from 20 routing scenarios (60–100
  calls) and 6 Director states (60 samples) to 25–56 cases per verifier lane. Exact percentages
  are indicative and should be re-measured as live shadow data accumulates.
- **A green gate is a promotion candidate, not proof.** A frozen corpus with no error cases
  cannot distinguish a calibrated lane from a lucky one. Several acted subsets have no observed
  errors, the adventure threshold was selected on the same corpus that scored it, and the
  narration held-out calibration is worse than raw.
- **The guardrails lane is not content moderation.** It is advisory and shadow record-only. The
  deterministic checks it sits beside are a permissive stub (allow/deny only, characters always
  allow, and route sanitization runs before the check), so the lane must not be described as a
  content-safety guarantee ([guardrails benchmark](system-one-guardrails-benchmark.md)).
- **No prose and no authority.** Jev does not write narration, dialogue, summaries, or campaign
  content, and it has no mutation, authorization, receipt, timeline, or knowledge-ledger
  authority. The narration verifier never rewrites prose; the guardrails lane never blocks;
  memory reranking never adds, drops, or authorizes a candidate. All lanes fall back
  deterministically and none mutates campaign state.
- **Disabled by default.** `FEATURE_SYSTEM_ONE` is off unless the exact string `true` is set,
  the setting is independently disabled by default, and even the promoted routing lane needs its
  lane mode set to `active` before it can serve a turn ([Operations](operations.md),
  [roadmap](ROADMAP.md)).
- **Known open gaps.** The adventure lane deferred on a live shadow declaration ("drop my
  longsword") whose server binding was an `unequip` candidate, recognizing the commitment
  (supported ~0.48) but declining to equate the two labels; the authoritative provider path still
  committed correctly. The Director's negative-example corpus, active wiring for the
  evidence-only lanes, and re-evaluation after adding live shadow error cases remain work, which
  is the intended loop of the [decision review](system-one-decision-review.md) and
  [disagreement report](system-one-disagreement-report.md) tooling.

## Reproduce

Live evaluations are opt-in and need `TYPESAFE_API_KEY` exported; the repository convention is
to source the untracked env file. Before/after LLM arms additionally need `PROXY_API_KEY` and
`OPENROUTER_BASE_URL` / `OPENROUTER_MODEL`. The scripts run against disposable data directories
and regenerate the committed reports (`docs/system-one-*.md`) plus their raw JSON sidecars.

```bash
# Room routing before/after benchmark (100 calls per arm) -> docs/system-one-benchmark.md
set -a; . /tmp/opencode/jev/jev.env; set +a
export PROXY_API_KEY="$(rg -o '^PROXY_API_KEY=.*' /home/mojo/projects/agentrouterrouter/.env | cut -d= -f2-)"
export OPENROUTER_BASE_URL=http://100.72.41.9:8787/v1 OPENROUTER_MODEL=deepseek-v4-flash
BENCH_REPEATS=5 npx tsx scripts/benchmark-system-one-lanes.ts

# Director before/after benchmark (25 decisions per arm) -> docs/system-one-director-benchmark.md
BENCH_REPEATS=5 npx tsx scripts/benchmark-system-one-director-lane.ts

# Per-lane gate evaluations -> docs/system-one-*-benchmark.md
npx tsx scripts/evaluate-system-one-director.ts --repeat 10
npx tsx scripts/evaluate-system-one-narration-lane.ts --repeat 3
npx tsx scripts/evaluate-system-one-router-lane.ts --repeat 3
npx tsx scripts/evaluate-system-one-rerank-lane.ts --repeat 3
npx tsx scripts/evaluate-system-one-adventure-lane.ts --repeat 3
npx tsx scripts/evaluate-system-one-guardrails-lane.ts --repeat 3
```

The review and report CLIs are read-only, need no provider credentials, and read the local
decision log through `VELVET_DATA_DIR`:

```bash
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/review-system-one-decisions.ts --lane director-selection --max-signal 0.7
VELVET_DATA_DIR=.velvet/<world> npx tsx scripts/report-system-one-disagreements.ts --limit 50
npx tsx scripts/report-system-one-decisions.ts --limit 50
```

The frozen promotion records are re-derived by the per-lane evaluations above; the record file
itself carries the command and metric summary in comments next to each lane
([systemOnePromotion.ts](../server/src/agent/systemOnePromotion.ts)).

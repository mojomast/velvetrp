# Jev (TypeSafe System One) integration

Status: design plus **W0 scaffolding and the first promoted lane**. The transport lane,
strict schemas, second settings profile, feature flag, confidence-policy module, fake
adapter, and settings/preflight HTTP routes are implemented and tested. The **L5
room-routing lane is the first promoted lane**: it is wired behind the flag, setting, and
key, and changes behavior only when its `speaker-routing` lane mode is `active` **and** it
carries a recorded, passing promotion (`server/src/agent/systemOnePromotion.ts`
`isLanePromoted`); otherwise it records in `shadow` only. It has confidence gating to the existing LLM/deterministic paths, a
lane-scoped budget, and an immutable decision-record sidecar. The **L1 Director selector is
wired in the `shadow` lane mode**; its [calibration](system-one-director-calibration.md) passes on a
frozen provider-free corpus once the fitted confidence map is applied, but it has no
runtime promotion record yet — it waits for live shadow data with negative examples. The
surrounding tooling includes a **Platt calibration module**, a **promotion-gate module**, a
**decision-record read API**, a **settings UI**, a **shadow-decision report CLI**, and a
[before/after benefit report](system-one-benefit-report.md). The **L3 narration/receipt
verification** and **L7 cost/quality router** are **wired in shadow (record-only)**; each
now has a [narration](system-one-narration-benchmark.md) and
[router](system-one-router-benchmark.md) evaluation — after the per-fact prompt redesign
both pass their gates, carry records, and still have no activation path (the narration
verifier is advisory and never rewrites prose). **Everything remains disabled by
default.** This document remains
the design and evaluation plan and does not override runtime code, shared Zod
contracts, the [API reference](api.md), [repository architecture](repo-architecture.md),
[provider configuration](provider-configuration.md), or milestone status in the
[roadmap](ROADMAP.md). TypeSafe product facts were verified September 16, 2026
against the live API and the public documentation listed under [Sources](#sources).
The API was exercised live during this work; the decision-record sidecar and every
lane above shadow mode remain future work.

## Summary

Velvet can add an optional **System One decision lane** that sends a bounded `state`
and a battery of typed questions to TypeSafe's Jev model and receives typed answers
with probability distributions and confidence. Jev never generates prose. It can
rank, select, classify, score, and verify; it cannot narrate, invent mechanics, or
commit anything.

The lane is a sibling to the existing OpenAI-compatible provider, not a replacement.
It is disabled by default, has a deterministic fallback for every lane, and preserves
the project invariant:

> The model can propose what happens next. It never decides what became true.

The integration is a strong first use of Jev because Velvet already concentrates the
exact decision shape Jev is built for — a closed, server-issued candidate set that
the model must choose from and the server re-validates — and already ships the
provider-free oracle and rubric needed to measure it.

## What Jev is

Jev is the flagship "System One" model from TypeSafe AI. System One models are
decision models, not LLMs. A request supplies unstructured `state` plus a map of
typed `questions`; the response supplies one typed `answer` per question, evaluated
in parallel and independently against the same state. There is no token generation
and no free text.

| Primitive | Question | Answer fields |
| --- | --- | --- |
| `choice` | pick one option from a map of ≤255 options | `choice`, `probabilities`, `confidence` |
| `score` | rate the state on 2–10 ordered levels | `score` (probability-weighted mean), `probabilities`, `legend`, `confidence` |
| `noul` | yes/no | `noul` (0–1 probability of yes; no separate `confidence`) |

Operational properties relevant to Velvet:

- **Endpoint.** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`,
  body `{ state, model, questions }`, response `{ model, answers, usage: { input_tokens, output_tokens } }`.
  `state` may be a string, object, or array. `model` examples include `jev-latest` and pinned
  versions such as `jev-1.13.0`. The endpoint is **not** OpenAI `/chat/completions`.
- **Model discovery.** `GET /v1/models` returns `{ models: [{ name, description, release_date }] }`.
  Live verification resolved `jev-latest` to `jev-1.13.0`; `jev-preview` is also advertised.
- **Errors.** `401` missing/invalid key, `422` invalid body (with the offending field path),
  `429` rate limit, `529` overloaded, and `400` `api_usage_error` for an unknown model.
  The vendor recommends exponential backoff on `429`/`529`.
- **Confidence.** `choice` and `score` answers include `confidence` derived from the
  probability distribution shape (concentrated = high, flat = low). `noul` does not.
  Confidence is a statement about the answer's distribution, not a guarantee of correctness.
- **Cost/speed.** Vendor-reported $0.042 per million input tokens, free output tokens,
  and roughly 70–500 ms per call. Adding questions to one call has little effect on latency.
- **Maturity.** Early access. Treat availability, schemas, and model versions as unstable
  and fail closed. Pin a model version for evaluations.

### Verified wire schema (September 16, 2026)

The public API was exercised live while planning the implementation. The exact request
shape is a map of typed questions keyed by `type`; each question carries `instructions`
plus a type-specific `criteria`, and the response echoes the same keys:

```json
{
  "state": "Player: I swing at the goblin. Receipt: no attack committed.",
  "model": "jev-latest",
  "questions": {
    "hold":     { "type": "noul",   "instructions": "Should the Director hold?" },
    "grounded": { "type": "score",  "instructions": "Rate groundedness.",
                  "criteria": ["grounded", "partly grounded", "contradicts the receipt"] },
    "pick":     { "type": "choice", "instructions": "Pick a legal action.",
                  "criteria": { "attack": "commit the attack", "none_of_these": null } }
  }
}
```

- `noul` returns `{ "type": "noul", "noul": 0.0–1.0 }` and never a `confidence`.
- `choice` returns `{ "type": "choice", "choice": "<option>", "confidence": 0–1,
  "probabilities": { "<option>": 0–1, ... } }`; `criteria` is a map of option to a
  rubric string (or `null`); a sentinel such as `none_of_these` is the fail-closed option.
- `score` returns `{ "type": "score", "score": <weighted mean>, "confidence": 0–1,
  "legend": { "0": "<level>", ... }, "probabilities": { "0": 0–1, ... } }`; `criteria`
  is an ordered array of level descriptions (minimum two), and level keys are strings.
- Unknown top-level and unknown question fields are ignored by the service, so Velvet must
  apply its own strict Zod validation rather than relying on the server to reject extras.
- Failures carry the `x-typesafe-request-id` response header, which the adapter records
  as provenance.

The implementation lives in `server/src/provider/systemOneCompletion.ts` (transport and
validation), `server/src/agent/systemOnePolicy.ts` (confidence bands), and
`server/src/agent/systemOneRoomRouting.ts` (the wired L5 battery/composition).

### Sources

- TypeSafe docs: [Introduction](https://docs.typesafe.ai/introduction),
  [System One](https://docs.typesafe.ai/concepts/system-one),
  [State](https://docs.typesafe.ai/concepts/state),
  [Choice](https://docs.typesafe.ai/primitives/choice),
  [Score](https://docs.typesafe.ai/primitives/score),
  [Noul](https://docs.typesafe.ai/primitives/noul),
  [Confidence](https://docs.typesafe.ai/confidence),
  [API reference](https://docs.typesafe.ai/api),
  [How to build](https://docs.typesafe.ai/concepts/how-to-build-with-system-one).
- Patterns: [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out),
  [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing),
  [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring),
  [Intent routing](https://docs.typesafe.ai/patterns/intent-routing),
  [LLM guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails).
- Vendor announcement: [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev).

## Why this fits Velvet

1. **Velvet already coerces text into typed decisions and re-validates it.** The
   current adapter returns assistant messages, tool calls, or strict JSON that the
   server parses and validates locally (`server/src/provider/openAiCompatibleCompletion.ts`,
   `server/src/routes/rpg/v1/campaignContentGeneration.ts`). Jev removes the coercion
   step: the answer space is fixed in advance and cannot be violated.
2. **Velvet's two hardest model roles are already Choice-shaped.** The AI Director
   selects from server-issued candidates (`server/src/agent/campaignDmOrchestrator.ts`),
   and adventure turns select from exact server-issued candidates
   (`server/src/agent/toolRegistry.ts`). These map directly to `choice`/`score`/`noul`.
3. **Confidence fills a real gap.** Velvet has no native way for a model to say
   "I am not sure." Jev's calibrated confidence is exactly the signal a
   human/AI-delegated system needs to choose act vs. confirm vs. hold.
4. **Jev's limitation is irrelevant here.** It cannot emit prose, so it cannot
   narrate a false success, smuggle a mutation, or turn prose into canon. Its only
   failure mode at these seams is a wrong pick from a server-issued set, which the
   existing digest binding and receipt reconciliation already catch
   (`server/src/repo/candidateRepo/providerBindingIntegrity.ts`,
   `server/src/repo/candidateRepo/providerBridge.ts`).
5. **The evaluation harness already exists.** Velvet ships a provider-free
   candidate-choice oracle and rubric plus pass@k graders
   (`server/test/evals/dm-director-evaluation.test.ts`, `server/test/evals/dmGraders.ts`).
   Calibrated probabilities can be graded against that oracle with Brier/ECE in
   addition to accuracy.
6. **Early-use risk is low and reversible.** Every lane is optional, flagged, and
   wired to a deterministic fallback. A lane in `shadow` can log Jev predictions beside
   the deterministic oracle before any behavior changes.

## Controlling invariant

Every integration below obeys these rules. A change that violates one is out of scope.

- Jev **never** mutates state, never produces narration, and never authorizes a
  command. Server code maps an answer to an already-advertised candidate or to no
  action.
- Candidate sets and question batteries are **server-issued**. The provider may only
  pick from them. Unknown, undeclared, or non-advertised answers are rejected.
- **Thresholds live in server settings**, not in prompts. Confidence bands decide
  act/confirm/hold; the model never does.
- A disabled, absent, failing, over-budget, or low-confidence System One lane falls
  back to the current deterministic behavior. No lane may be load-bearing.
- Every dispatched decision is recorded immutably with request, question-battery,
  state, and answer digests, and is re-verified at the owning seam before use.

## Architecture

### 1. System One transport lane

Add a dedicated adapter, `server/src/provider/systemOneCompletion.ts`, parallel to
`openAiCompatibleCompletion.ts`. It must not reuse the OpenAI-compatible request
builder because the wire shape differs.

- Input: `{ state, model, questions }` plus provider settings, timeout, and abort signal.
- Output: validated answers keyed by question id, plus `usage` and provenance
  (request id if available, latency, requested/response model).
- Validation: strict Zod schemas for both request and response. Reject
  `probabilities` that do not sum to ~1 within tolerance, unknown answer types,
  `choice` values outside the declared option map, `score` values outside the level
  range, and any field not in the schema.
- Errors: a dedicated taxonomy mirroring the existing adapter — configuration,
  authentication (`401`), validation (`422`), rate limit (`429`), overloaded (`529`),
  timeout, transport, and protocol. `429`/`529` are retryable with bounded exponential
  backoff; retries remain disabled inside a durable turn unless the attempt model can
  represent them (the same constraint documented for the chat lane).
- Export through `server/src/provider/index.ts`.

### 2. Transport policy and credentials

Extend `server/src/provider/providerTransport.ts`. Add the exact host
`api.typesafe.ai` to the credential allowlist and validate that the base URL is HTTPS
for that host. Preserve the existing rule that a configured credential is sent only
to allowlisted hosts and never to arbitrary HTTPS hosts. Extend
`validateProviderBaseUrl`, `canUseProvider`, and `buildProviderHeaders` accordingly,
and add a focused unit test.

### 3. Settings and configuration

Keep the existing single OpenAI-compatible profile untouched. Add a second,
independent profile.

- New `SystemOneSettings` (server `types.ts`): `enabled`, `providerType` (literal
  `system-one`), `baseUrl`, `model`, `apiKey`, `requestTimeoutSeconds`, `pricing`,
  `budget`, `confidencePolicy` (per-lane thresholds), and `confidenceCalibration`
  (per-lane monotonic Platt map applied to the recorded confidence only).
- Persistence mirrors `settingsRepo.ts:readProvider` / `updateProviderSettings`:
  `readSystemOne`, `getPublicSystemOne`, `updateSystemOne`, with the key never
  returned publicly. Manual clamping matches the existing style.
- Bootstrap defaults mirror `server/src/defaults.ts`: `TYPESAFE_BASE_URL` defaulting
  to `https://api.typesafe.ai/v1`, `TYPESAFE_MODEL` defaulting to a pinned version,
  `TYPESAFE_API_KEY` blank. A blank key or `enabled: false` disables the lane.
- HTTP: `GET`/`PUT /api/provider/system-one` mirroring
  `server/src/routes/roleplay/provider.ts`, plus a `POST /api/provider/system-one/preflight`
  capability probe that verifies the endpoint and schema once, on explicit request only.
- Client mirror in `client/src/api.ts` alongside the existing provider settings.

### 4. Feature flag and discovery

Add `systemOne` to `roleplayFeatureFlagsSchema` (`packages/contracts/src/feature-flags.ts`),
export the inferred type, parse `FEATURE_SYSTEM_ONE` in `server/src/features.ts`, and
expose it on `GET /api/features` (`server/src/routes/roleplay/system.ts`). Mirror it
in the client feature type. The flag gates the lane; it is a rollout control, not a
permission or security control.

### 5. Budgeting and usage accounting

Jev is a paid remote service even though it is cheap.

- Record every call through `recordUsageEvent` and/or a distinct `provider_call_metadata`
  row with model `jev-*` and a lane-specific `kind`/`phase`, so `getUsageSummary`
  groups it separately and the existing cost estimator still works.
- Add a **lane-specific** budget manager. Do not share `adventureTurnBudgets`
  (`server/src/agent/turnBudget.ts`), which is keyed by turn and holds one policy.
- Reserve conservatively before dispatch, settle from reported usage, and fail closed
  when a budget is exhausted. A System One decision must never cause a chat lane's
  budget to be exceeded or vice versa.

### 6. Immutable decision provenance

Add a sidecar schema, `server/src/repo/db/systemOneSchema.sql`, composed in
`server/src/repo/db/schema.ts` like the other late sidecars. A wholly-absent prefix
installs additively; development databases remain disposable and no historical rows
are backfilled.

`system_one_decisions_v1` records, immutably:

- identity: `decision_id`, `lane`, campaign/turn/round scope where applicable
- provenance: `request_digest`, `questions_digest`, `state_digest`, `model`,
  `confidence_policy_version`
- answers: `answers_json` including `choice`/`score`/`noul`, `probabilities`,
  `confidence`, `legend`
- derived: `selection_json` (the server-validated mapping to a candidate or no action),
  `confidence_band`, `fallback_used`
- usage: `usage_json`, `created_at`

Enforce immutability with triggers as elsewhere. Add an integrity assertion modeled on
`providerBindingIntegrity.ts` that re-derives the digests and confirms the recorded
selection matches an advertised candidate at the owning seam.

### 7. Confidence policy engine

A small pure module, `server/src/agent/systemOnePolicy.ts`, converts an answer plus a
per-lane policy into one of three bands:

| Band | Condition | Effect |
| --- | --- | --- |
| `act` | confidence ≥ `actionThreshold` | use the server-validated selection |
| `confirm` | `reviewThreshold` ≤ confidence < `actionThreshold` | hold for human/GM or request confirmation |
| `fallback` | confidence < `reviewThreshold` | use the deterministic fallback |

For `noul`, band on the probability directly (review/action thresholds), following the
vendor's guardrail pattern. Thresholds are settings, per lane, and may differ by risk.
The module is pure and unit-tested; it never calls the provider and never mutates.

## Integration lanes

Each lane lists its purpose, question battery, composition, fallback, and authority
boundary. All batteries use the conventions in [Question design](#question-design-conventions).

### L1 — AI Director candidate selection

- **Where.** `planCampaignDmBeat` and the `select_dm_beat` tool
  (`server/src/agent/campaignDmOrchestrator.ts`), settling through
  `settleDmPlanning` / `settleDmPlanningRound` (`server/src/repo/campaignDmRepo.ts`).
- **Shape (shadow shipped).** The server already issues opaque `CampaignDmCandidate[]`
  with digests (`campaignDmRepo.ts` `snapshot`). Because Jev evaluates each question
  independently and cannot emit an ordered list, ordering is composed in code from
  per-candidate signals. `server/src/agent/systemOneDirector.ts` builds three atomic
  questions per candidate — a `progress` `noul` ("is committing this a good, meaningful
  next step now?"), a priority `score`, and a `transition` `noul` ("is this a safe,
  low-risk way to keep the world moving?") issued only for candidates flagged
  `pacing: true` (ambient-beat/advance-time) — plus a `hold` `noul` and an aggregate
  `best_candidate` `choice`. It composes in order: with **no advertised candidates it
  forces a hold** (the only possible action); otherwise grounded `progress` candidates
  (at the action threshold, ordered by priority) → a confident `hold` → a grounded
  `transition` fallback → the aggregate `best_candidate` pick → defer. The transition
  fallback fires only when **every advertised candidate is pacing** (no mechanical
  candidate is available), so it can never displace a preferred mechanical beat, and it
  ranks below a confident hold. Because Director beats mutate campaign state, the
  aggregate pick must clear the **action** threshold, not the review threshold. An atomic
  `legal` question was tried and removed: the advertised set is already server-authorized,
  so re-asking legality only added model hedging without changing decisions. `progress`
  deliberately grades a "meaningful next step" rather than "story-objective progress", so
  a consequential mechanical beat (e.g. `encounter-start`) is not penalized for not
  advancing plot, and the criteria now treat a safe, low-risk transition as a valid next
  step while still rejecting premature, redundant, or unsafe beats.
- **Shadow.** `planCampaignDmBeat` accepts an optional `getSystemOneDirector` dependency.
  When it resolves (flag + `enabled` + the `director-selection` lane mode `shadow` + usable key) the battery runs beside the
  live planning and the would-be decision is recorded immutably; it never settles, orders,
  or executes anything, and any failure is swallowed. Active Director selection is
  deliberately not enabled yet.
- **Evaluation.** [System One Director calibration](system-one-director-calibration.md) runs
  the six-state corpus and the promotion gate on the calibrated signal; at the selected 0.60
  threshold it acts on ~39/60 samples (run-to-run variance is a few decisions) with **100%
  acceptable and 100% exact** accuracy, so it carries a promotion record. The corpus has no acted errors (the server only advertises
  authorized beats and the model defers on mixed states), so the record is an evidence-only
  snapshot, not a stress-tested guarantee, and no active Director path is wired.
- **Confidence.** `act` would compose the beat; `confirm` leaves the run in human mode;
  `fallback` uses the deterministic rule and provider-free oracle. The raw model is
  systematically **under-confident** (correct decisions at ~0.6), so the evaluation fits
  the monotonic `systemOneCalibration.ts` Platt map on the development split and reports
  the held-out calibration; the promoted signal is the calibrated one.
- **Authority.** The existing digest check in `settleDmPlanning` still rejects any
  selection that does not match an advertised candidate.
- **Risk.** Ordered composition is the hardest mapping; validate against the existing
  oracle before enabling anything but shadow mode. The calibration graders
  (`server/test/evals/dmGraders.ts` `brierScore` / `expectedCalibrationError`) are the
  measurement path. A green gate on a frozen corpus with no error cases is a promotion
  **candidate**, not proof: collect shadow data with negative examples before enabling.

### L2 — Adventure exact-candidate selection

- **Where.** `orchestrateAdventureTurn` and `selectAdventureTools`
  (`server/src/agent/adventureOrchestrator.ts`, `server/src/agent/toolRegistry.ts`).
- **Shape.** `choice` over the exact advertised candidate ids, with an explicit
  `none_of_these` option so the model can fail closed. Add a `score` ranking when
  several candidates are legal and a `noul` for "is any advertised candidate supported?"
- **Composition.** `act` selects the single candidate; `confirm` requests confirmation;
  `fallback` uses the existing deterministic selection.
- **Authority.** The deterministic command bridge and Zod argument validation are
  unchanged. Jev only chooses an id; the server still executes and receipts it.

### L3 — Advisory narration and receipt verification

- **Where.** After narration is produced, beside `parseDmScene`/`validDmScene`
  (`server/src/agent/dmNarration.ts`), and near the assistant-output policy check
  (`server/src/policy.ts`).
- **Shape.** State carries the candidate narration and the committed receipt facts.
  Battery: one coverage `noul` and one contradiction `noul` per committed fact, plus
  `noul`s "does it invent a mechanic or outcome not present in the facts?" and "does it
  cross a declared character or content boundary?".
- **Shape (primitive shipped).** `server/src/agent/systemOneNarration.ts` builds the
  **per-fact decomposed battery** and composes a `NarrationVerification { band, flags,
  groundedness, topSignal }` in code, where `groundedness` is the coverage fraction
  (`reflected facts / total facts`) rather than a model-reported score. This replaced an
  earlier three-level `groundedness` `score` that over-credited narrations restating a
  single fact. It is **wired in shadow (record-only)** into the Director narration half,
  producing a `narration-verification` decision record after a scene is produced while
  narration itself is never altered.
- **Composition.** Produces an observation only. `act` requires every committed fact to be
  reflected with no hazard; any hazard flag falls back; partial coverage defers. High
  contradiction probability flags for deterministic replacement (already implemented for
  travel) or GM review. It never rewrites narration and never becomes story truth.
- **Evaluation.** [System One narration benchmark](system-one-narration-benchmark.md)
  runs the battery on a labeled corpus with Brier/ECE and the promotion gate; after the
  per-fact redesign it **passes** (51 decisive verdicts, 94.1% verdict accuracy, calibrated
  Brier 0.057, ECE 0.056) with no false accepts, and carries a promotion record. The one
  miss is a flag-label mismatch on a contradiction the lane still refused to accept, and
  there is no active narration path, so the record is evidence, not activation.
- **Risk.** Must not be represented as a content-safety guarantee. See
  [Privacy and safety](#failure-privacy-and-safety).

### L4 — Memory and clue reranking

- **Where.** Between recall candidate selection and context packing
  (`docs/campaign-memory.md`, `server/src/context.ts`).
- **Shape.** State is the query plus a bounded shortlist of already-authorized
  candidates. One `score` per candidate ("relevance to the query") and one `noul`
  ("does this candidate answer the query?").
- **Composition.** Fuse the model score with the existing deterministic rank using
  code-owned weights; do not replace the deterministic rank. All existing query, hit,
  whole-entry, and byte caps are unchanged.
- **Authority.** Recall authorizes before ranking; the model never sees or influences
  authorization. A no-match query can still return no memory.

### L5 — Routing and intent

- **Where.** Room speaker routing (`server/src/llm.ts` `selectRoomSpeakers`), and
  declaration classification inside the adventure turn.
- **Shape (shipped for routing).** Because a room turn can select several speakers,
  routing uses **one atomic `noul` per participant** ("should this participant speak?")
  plus one aggregate `best_speaker` `choice`, built by
  `server/src/agent/systemOneRoomRouting.ts`. Code composes the answer: participants
  that clear `actionThreshold` are ordered by probability and capped, then passed
  through the existing `ensureGroupSpeakers`. When no participant clears the threshold,
  the aggregate choice acts as a fallback if its top pick is a real participant and its
  probability clears `reviewThreshold`; otherwise the lane defers. Declaration/intent
  classification is still unimplemented.
- **Composition.** `act` uses the Jev selection; `confirm`/`fallback` returns the
  recorded decision without applying it, so `selectRoomSpeakers` continues to the LLM
  path and then `fallbackRoomSpeakers`. A Jev error also returns `null`.
- **Toggle and promotion.** The lane runs only when `FEATURE_SYSTEM_ONE`,
  `SystemOneSettings.enabled`, a usable key, and a non-`off` `speaker-routing` lane mode are
  all present; the route resolves it in
  `server/src/routes/roleplay/interactions.ts`. It changes routing only when its lane mode
  is **`active`** **and** it carries a recorded, passing promotion
  (`server/src/agent/systemOnePromotion.ts` `isLanePromoted`). Otherwise it records the
  would-be decision in `shadow` and leaves routing unchanged (`fallback_used: true`). Room routing is the
  first promoted lane (evidence: the benchmark below). Usage is recorded under the
  `room_routing_system_one` kind.
- **Budget.** Each dispatch reserves against the lane's own budget
  (`server/src/agent/systemOneBudget.ts`) before shipping and settles from reported
  usage; a denied reserve, like any lane failure, falls back without dispatching.
- **Decision records.** Every dispatch (active or shadow) is written immutably to
  `system_one_decisions_v1` via `server/src/repo/systemOneDecisionRepo.ts`, with
  request/questions/state digests and a re-verifiable integrity assertion. Recording is
  advisory and can never fail a room turn.
- **Authority.** Jev only nominates participant ids from the closed room roster; the
  server still selects tools and legal commands, and the deterministic fallback is
  unchanged.
- **Benchmark.** [System One room-routing benchmark](system-one-benchmark.md) compares
  the Jev arm, the raw LLM arm, and the gated lane on a labelled routing battery.

### L6 — Guardrails and boundaries

- **Where.** Alongside `checkUserMessage`, `checkCharacter`, and
  `sanitizeInjectionText` (`server/src/policy.ts`).
- **Shape.** Follow the vendor guardrail pattern: one `noul` per hazard (override/
  jailbreak attempt, boundary crossing, disclosure request, self-harm signal) plus a
  severity `score`. Route through `pass`/`review`/`block`/`support` precedence using
  configured thresholds.
- **Composition.** Advisory to the existing deterministic sanitization, which remains
  authoritative. A low-confidence answer never blocks; it defers to the existing check.
- **Risk.** This changes the documented scope of the policy stub. It requires explicit
  doc updates and must not be described as comprehensive moderation.

### L7 — Cost/quality router (meta-lane)

- **Where.** A shared pre-dispatch classifier usable by roleplay room turns, adventure
  planning, and reviewed generation.
- **Shape.** One call combining a `choice` over the handler set
  (`deterministic` / `cheap-generation` / `frontier-generation` / `human-review`), a
  `score` for request complexity, and a `noul` for "is the deterministic path
  sufficient?". This is the vendor intent-routing and confidence-gated routing pattern.
- **Shape (primitive shipped).** `server/src/agent/systemOneRouter.ts` builds the
  handler `choice`, complexity `score`, and deterministic-sufficiency `noul`, and
  composes a `RouterDecision`. It is **wired in shadow (record-only)** into the roleplay
  room-turn path, recording a `cost-router` decision without changing which handler
  runs. Its safety gate routes `requiresHumanDecision`/`safetySensitive` requests to
  `human-review` unconditionally.
- **Composition.** `act` routes to the chosen handler; `confirm` and `fallback` use the
  currently configured handler, so the router can only ever change behavior toward a
  cheaper or human path, never bypass a required safety check.
- **Authority.** Selects *which* handler runs, never *what* it does. It cannot skip
  authorization, candidate binding, confirmation, or receipts.
- **Evaluation.** [System One cost-router benchmark](system-one-router-benchmark.md)
  runs the battery on a labeled corpus with Brier/ECE and the promotion gate; it passes
  on the calibrated signal (45 acted, 100% handler accuracy, raw ECE 0.057 → calibrated
  0.003) and carries a promotion record. No active handler-selection path is wired yet, so
  the lane remains record-only despite the passing gate.
- **Risk.** Routing can silently change system behavior. It must be observable, logged
  per decision, and default to the status quo on any uncertainty.

## Question design conventions

Follow the vendor guidance and keep it consistent across lanes:

- **Atomic questions.** One property per question. Decompose broad judgments into
  several questions and combine in code. (See the decomposed spam and tool-trace
  examples in the vendor build guide.)
- **Contrastive criteria.** For `choice`, describe what belongs in an option, what
  belongs in a neighboring option instead (`not_for`), and a few `examples`. Use the
  same field names across options.
- **Structured instructions.** Keep short questions as strings; use named-field
  objects when instructions need several kinds of guidance.
- **Speculative fan-out.** Ask every question the lane might branch on in one call;
  ignore irrelevant answers in code. This is where the cost/speed advantage compounds.
- **Noul thresholds.** Phrase so high probability means "yes", and threshold in code.
- **Score normalization.** Divide a `score` by `len(criteria) - 1` before weighting.

Illustrative L1 battery (JSON shape only; final criteria are tuned against the oracle):

```json
{
  "state": {
    "private_context": { "summary": "..." },
    "candidates": [
      { "candidate_id": "dm-candidate:...", "kind": "travel", "label": "Move to the mill" }
    ]
  },
  "model": "<pinned jev version>",
  "questions": {
    "hold_instead": {
      "type": "noul",
      "instructions": "Should the Director hold this beat instead of advancing any candidate?",
      "criteria": { "true": "No candidate is a well-grounded next beat", "false": "At least one candidate is grounded" }
    },
    "candidate_is_supported": {
      "type": "choice",
      "instructions": "Which advertised candidate is the best-supported immediate next beat?",
      "criteria": {
        "dm-candidate:...": "Move to the mill; grounded by the current quest objective",
        "none_of_these": "No advertised candidate is supported"
      }
    }
  }
}
```

## Additional applications

Beyond the seven lanes there is more Jev-shaped decision surface in Velvet. The list
below is ordered by **authority risk, not by value** — the lowest-risk, highest-leverage
item is first. Add these only after the core lanes are stable, and under the same
invariant, fallback, and wave discipline. None of them carry mutation authority.

| Priority | Application | Domain | Authority |
| --- | --- | --- | --- |
| 1 | Automated rubric/judge grading | evaluation harness | none |
| 2 | Cost/quality router (L7) | cross-cutting | routing only |
| 3 | Canon-contradiction and duplicate detection | reviewed generation | advisory |
| 4 | Scene-change gating and lore selection | roleplay | gating only |
| 5 | Veil and safety-setting relevance | safety/UX | advisory |
| 6 | Entity resolution for recall | memory | advisory |
| 7 | Draft and archetype suggestions | character builder | prefill only |
| 8 | Swipe and branch ranking | roleplay | advisory |
| 9 | Memory salience ranking | memory approval | advisory |
| 10 | Content-pack review classification | content | advisory |

### Evaluation harness (no runtime authority)

- **Automated rubric grading.** Grade narration against the frozen rubric dimensions
  (`server/test/fixtures/dm-evals/director-rubric.v1.json`) with `noul`/`score`
  questions instead of the deterministic `validDmScene` heuristic alone, replacing an
  expensive LLM-as-judge. The eval harness runs off the runtime path, so this carries no
  authority risk and improves every other lane's measurement.
- **Oracle comparison at scale.** Scan large state sets against the provider-free
  candidate-choice oracle and surface disagreements for the calibration report.
- **Failure triage.** Classify provider-protocol failures and non-deterministic E2E
  diffs into known categories.

### Reviewed generation

- **Canon contradiction.** `noul` "does this staged artifact contradict a committed
  canon fact?" against the generation context before GM review
  (`server/src/routes/rpg/v1/campaignContentGeneration.ts`).
- **Duplicate/distinctness.** `noul` "is this NPC/faction distinct from the existing
  roster?" to surface near-duplicates at generation scale.
- **Section selection.** Given a free-text brief, one `noul` per each of the 11
  supported sections to decide what to generate.
- **Clue fairness.** `score` whether a clue fairly points at its solution.
- **Safety fit.** `score` generated content against the campaign's declared
  `hardLimits`, `veils`, `pvpPolicy`, `romancePolicy`, and `lethalityPolicy`.
- All of these are advisory input to the existing review-and-apply workflow; explicit
  GM selection and dependency-closed apply are unchanged.

### Roleplay and memory

- **Scene-change gating.** A `noul` "has the scene changed materially?" to decide
  whether the expensive `synthesizeSceneState` call runs at all (`server/src/llm.ts`).
- **Lore selection.** `score` scoped/triggered lore entries for relevance instead of
  relying only on keyword matching.
- **Memory salience.** Rank pending memory candidates so the human approval queue
  surfaces the best ones first (`server/src/repo/memoryRepo.ts`). Approval stays human.
- **Swipe and branch ranking.** `score` reply swipes or parallel branch continuations so
  the UI can recommend one; the user still chooses.
- **Entity resolution.** `noul`/`choice` for "does 'the blacksmith' refer to NPC X?" to
  help recall matching without embeddings or alias expansion. Canonical identity stays
  server-derived.

### Character, content, and setup

- **Draft suggestions.** `choice` over legal allocation and choice options to prefill a
  character draft or suggest a starter archetype from a written concept. This follows the
  same prefill-only rule as sheet references: suggestions never submit, roll, or commit
  (`docs/dm-harness-architecture.md`).
- **Content-pack review assist.** Classify item/feature category or mechanics tier
  during review; the immutable pack attestation stays deterministic.
- **Hydration recipe planning.** Classify which review or setup steps a recipe needs
  before execution (`scripts/hydrate-campaign.ts`); never execute anything.

### Safety tailoring

- **Veil relevance.** `choice`/`noul` over a message to decide which declared veils or
  safety settings are relevant, so the client can nudge the player. It informs nudges;
  it never overrides the settings, the immutable control plane, or the deterministic
  policy checks.

### Where Jev must not go

- **Prose:** narration, NPC voice, campaign content, summaries, backstories.
- **Authority:** mutations, authorization, revisions, receipts, timelines, prices, stock.
- **Knowledge-ledger writes:** Velvet deliberately never does LLM extraction into the
  observation ledger (`server/src/repo/db/npcKnowledgeSchema.sql`); keep it that way.
  Jev may only flag possible over-disclosure, never write ledger rows.
- **Player consent:** trade acceptance, grant exercise, confirmation decisions.
- **Canonical identity or pathfinding:** those stay deterministic.

## Evaluation and calibration

Reuse the existing provider-free harness rather than inventing one.

- **Shadow mode first.** Run the Jev battery beside the deterministic oracle and log
  both, with `fallback_used: true`. No behavior changes.
- **Accuracy against the oracle.** The oracle already reads the exact advertised
  candidate set per state (`dm-director-evaluation.test.ts`). Compare Jev's selection
  and its top-probability candidate against the rubric-legal action set.
- **Calibration.** Extend the evaluation observation type (`dmEvalTypes.ts`) with the
  predicted probability and compute Brier score and expected calibration error per
  rubric dimension and per lane, alongside the existing pass@1/pass@k rates
  (`dmGraders.ts`).
- **Threshold selection.** Choose `reviewThreshold`/`actionThreshold` from labeled
  examples, starting conservative. Higher-stakes actions require higher confidence.
- **Fake adapter.** Add a deterministic fake System One adapter for CI and the
  deterministic E2E suite. Live calls are opt-in only, mirroring the existing live
  provider test gate.
- **Promotion gate.** A lane may be set to `active` only when, on a frozen holdout, it
  meets the oracle agreement and calibration targets recorded for that lane. If it
  does not meet the gate, record the lane as incomplete rather than adding complexity.

## Expected improvements and success metrics

Adopting the core lanes plus the evaluation harness and router should move behavior in a
few measurable directions. These are expectations to confirm in shadow mode, not
guarantees; the vendor's headline ratios are measured on System-One-shaped queries
against frontier models and will be smaller locally.

| Area | Expected improvement | Confidence | Primary metric |
| --- | --- | --- | --- |
| Decision latency | Replace sequential multi-round model calls with one ~100 ms parallel call | Medium | p50/p95 decision latency vs. the replaced call |
| Cost | Decision calls near-free; frees budget for new checks | High | Provider cost per Director turn; cost per lane |
| Decision reliability | No free text, so no parse, type, or undeclared-candidate failures | High | Tool/parse failure rate; fallback rate |
| Decision quality | Decomposed atomic signals combined in code with tunable weights | Medium | Oracle agreement; pass@k vs. the deterministic path |
| Calibration | Native confidence enables act/confirm/hold gating | Medium | Brier score and ECE per lane |
| Auditability | Immutable probability records per decision | High | Decision-record coverage; explainability spot checks |
| Safety | Advisory verification and guardrail routing | Medium | Flagged/reviewed turns vs. false positives |
| Evaluation velocity | Automated rubric grading replaces paid judge calls | High | Eval cost and wall-clock per run |

What not to expect:

- No change to prose quality; narration, NPC voice, and generation stay generative.
- No gain from a net-new check on the critical path; run verification and reranking
  asynchronously or accept roughly ~100 ms each.
- No immediate user-visible change until a lane clears its promotion gate.
- No guarantee the model beats the deterministic oracle; if it does not, keep the
  fallback and the gained measurement.

The shadow-mode calibration report is the decision point: it converts each expectation
above into a measured number before any lane is enabled.

## Failure, privacy, and safety

- **Off-device recipient.** Every configured System One call sends `state` to a remote
  service. Document this in `docs/provider-configuration.md` and the README trust
  section with the same honesty as the existing remote-provider disclosure. Do not
  place secrets in state.
- **Key handling.** The API key is stored locally in SQLite like the existing provider
  key, never returned by the public API, and sent only to the exact allowed host.
- **Fail closed.** Missing key, `enabled: false`, `401`, `422`, timeout, protocol
  error, over-budget, or unknown answer shape all select the deterministic fallback.
  `429`/`529` use bounded backoff with no unbounded retry.
- **No free text.** Reject any response field outside the declared schema. There is no
  path for model text to reach narration, prompts, or storage.
- **Confidence is not correctness.** Low confidence is a routing signal, not a
  correctness proof. Thresholds are domain-tuned and evaluated.
- **Early access.** Version drift is expected. Pin a model version for evaluations,
  keep the adapter strict, and treat schema changes as breaking.

## Schema and migration plan

- Add `systemOneSchema.sql` as a sidecar and compose it in `schema.ts`. If the
  `system_one_*` object prefix is wholly absent, install it additively, matching the
  existing late-schema behavior.
- Add `system_one_settings_v1` (or a second row in a dedicated table) for the second
  profile, keeping the existing `provider` row untouched.
- Add `system_one_decisions_v1` with immutability triggers and an integrity assertion.
- Development databases remain disposable. If a future change must extend a
  constrained shape or attach to existing rows, add a narrowly recognized exact
  predecessor upgrade and update the migration tests, per `handoff.md` and
  `docs/operations.md`.
- If no persistence lane is enabled initially, the decision record can ship in a later
  wave; shadow mode may start with ledger-only usage records.

## Configuration surface

| Name | Kind | Default | Notes |
| --- | --- | --- | --- |
| `FEATURE_SYSTEM_ONE` | env flag | `false` | Exact string `true` only; rollout control |
| `TYPESAFE_BASE_URL` | env | `https://api.typesafe.ai/v1` | Allowlisted HTTPS host |
| `TYPESAFE_MODEL` | env | pinned `jev-*` | Pin for evaluations |
| `TYPESAFE_API_KEY` | env | blank | Blank disables the lane |
| `enabled` | setting | `false` | UI/API switch, independent of key |
| `requestTimeoutSeconds` | setting | bounded | Mirrors existing provider clamp style |
| `budget.*` | setting | bounded | Lane-specific, never shared |
| `confidencePolicy.<lane>.*` | setting | conservative | `reviewThreshold`/`actionThreshold` |
| `confidenceCalibration.<lane>.*` | setting | identity | Platt `{ a, b }` on recorded confidence; never changes the band |

Any new environment variable must be added to the `docs/operations.md` environment
table and both `.env.example` files, or the documentation-drift test will fail.

## Documentation obligations

- `README.md`: provider/trust sections, requirements, and the optional integration summary.
- `docs/provider-configuration.md`: System One lane, precedence, credentials, outbound privacy.
- `docs/operations.md`: environment table entries.
- `docs/api.md`: new provider routes and flag behavior when implemented.
- `docs/dm-evaluation.md`: oracle/calibration extensions.
- `docs/ROADMAP.md`: a new milestone with exact scope and gates.
- `docs/README.md`: index this document.
- `client/src/api.ts` and feature types when the client surface lands.

## Rollout waves

Each wave is independently reversible. No wave enables a lane by default.

- **W0 — lane scaffolding.** Adapter, Zod schemas, transport allowlist, second settings
  profile, feature flag, usage/budget lane, fake adapter, decision-record schema,
  docs. No behavior change; all lanes off.
- **W1 — L1 Director in shadow mode.** Log predictions beside the oracle; produce the
  first calibration report. No selection authority.
- **W2 — L1 Director active.** Enable confidence-gated selection with deterministic
  fallback, gated on the calibration targets from W1.
- **W3 — L2 adventure selection.** Shadow, evaluate, then enable.
- **W4 — L5 routing and L3 advisory verification.**
- **W5 — L4 reranking and L6 guardrails.**
- **W6 — docs, roadmap, and release gate.** `npm run health` exactly once.

The **evaluation-harness** use (priority 1 under
[Additional applications](#additional-applications)) can land in W0/W1 because it has no
runtime authority. **L7** and the remaining additional applications follow the same
shadow-evaluate-promote discipline after the core lanes, in the priority order listed
there; none ship enabled by default.

Focused validation follows `AGENTS.md`: the owning workspace typecheck plus the
affected test files while iterating; the deterministic E2E suite with the fake adapter
for browser/HTTP/persistence boundaries; the opt-in live suite only when intentionally
validating a configured System One key; and `npm run health` before merge.

## Exclusions and non-goals

- No Jev use for narration, dialogue, NPC voice, campaign-content generation, or any
  prose. Those remain on the generative provider plus receipt-grounded validation.
- No Jev authority over mutations, authorization, revisions, receipts, or timelines.
- No replacement of the deterministic recall rank, command bridge, or exact-candidate
  integrity checks.
- No hidden fallback provider: if System One is disabled or failing, the existing
  deterministic path runs and nothing else is called.
- No claim that Jev is comprehensive content moderation or a safety guarantee.
- No multi-user or remote-principal implications; the trusted-local boundary is unchanged.

## Open questions

1. Which model version to pin for the first evaluation, and how to handle version drift.
2. Whether the first active lane should be L1 (highest value, hardest ordered
   composition) or L3 (advisory, lowest authority risk).
3. Whether ordered beat composition is acceptable from per-candidate scores, or whether
   L1 should stay single-candidate Choice until field evidence supports ordering.
4. Whether the decision-record schema ships in W0 or defers until a lane leaves shadow
   mode.
5. Target calibration and oracle-agreement thresholds per lane, and who owns them.
6. Whether the evaluation-harness use extends the existing `dmGraders` observation
   types or introduces a separate calibration observation type.
7. Whether L7 may only route toward cheaper/human handlers (never toward a more capable
   one), or whether upward routing is in scope.
8. Which additional applications, if any, are promoted from this research into a
   roadmap milestone rather than remaining candidates.

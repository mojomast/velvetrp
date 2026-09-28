# Provider production hardening

The provider hardening helpers are server-only policy modules. Production routes/orchestrators now supply their credentials and network adapter; the helpers themselves do not read credentials, log prompt content, sleep, or automatically retry requests.

## Capability preflight

`server/src/provider/capabilityPreflight.ts` creates independent probes for schema-bound function tool calls and strict JSON Schema response format. `POST /api/provider/preflight` maps them onto `completeWithProvider` and reports function-tool DM-play compatibility separately from strict-JSON campaign-generation compatibility. It runs only after an explicit user action, is never triggered on settings load/save, is `no-store`, and does not cache a result that could become stale.

Exact hook:

1. On an explicit preflight request, call `runProviderCapabilityPreflight({ model, probe, signal })`.
2. In `probe`, pass `messages`, `tools`, `toolChoice`, and `jsonSchema` from the probe request unchanged to `completeWithProvider`; add the selected provider, harness, and preset locally.
3. Convert adapter/HTTP errors to `ProviderFailure` with `classifyProviderFailure`. Do not include response bodies, prompts, tool arguments, or credentials in the observation.
4. Treat `unsupported` as a durable incompatibility until settings change. Treat `unavailable` as an operational failure, not evidence that strict mode is unsupported.
5. Never replace a failed function-tool probe with free-form tool instructions or downgrade a failed strict JSON probe to free-form JSON.

## Failure and retry policy

`classifyProviderFailure` distinguishes permanent failures from a narrow transient set. `recommendProviderRetry` returns a decision only; the owning lane remains responsible for idempotency, cancellation, sleeping, and dispatch. It respects provider `Retry-After`, exponential delay, total-attempt bounds, maximum delay, and the caller's absolute deadline. A requested `Retry-After` beyond the configured delay/deadline fails closed rather than retrying early.

Exact hook:

1. Capture HTTP status, a non-sensitive provider error code, `Retry-After`, and transport/timeout flags at the adapter boundary.
2. Classify once with `classifyProviderFailure`.
3. Retry only when `recommendProviderRetry` returns `{ retry: true }`, the operation has an idempotency/recovery key, and no durable response already exists. Adventure production dispatch currently does not retry: its schema cannot durably represent safe sub-attempts, so enabling retries would risk replay/double billing.
4. Persist only the taxonomy code and safe provenance. Do not implement catch-all retries.

## Per-turn budgets

`server/src/agent/turnBudget.ts` is an immutable state machine. Reservations include prompt estimates and the configured maximum completion tokens, preventing concurrent calls from overcommitting a turn. Provider usage is authoritative when valid. When usage is absent, settlement uses a conservative three UTF-8-byte token heuristic and, if completion text is unavailable, charges the full reserved completion allowance.

Exact hook around every provider dispatch:

1. The shared `AdventureTurnBudgetManager` creates one state at first dispatch and retains it for every planning/narration call in that turn.
2. Serialize the exact outbound messages/tools/schema to the prompt-estimation text, then call `reserveTurnBudget(state, { id: providerCallId, promptText, maxCompletionTokens }, nowMs)`.
3. Dispatch only when `allowed` is true. A denial is deterministic fallback/backpressure; `retryAtMs` is supplied only for the rolling rate limit. Concretely, a planning denial settles the dispatch as `budget-<reason>` and completes the turn with deterministic fallback narration; an enemy-audience turn additionally runs the deterministic enemy fallback and fails only if that cannot settle. The prompt estimate is conservative (`bytes ÷ 3`) and can exceed measured tokens by a third, so the graceful path is what keeps a conservative denial from becoming a player-visible failure.
4. Immediately replace state with the returned state so concurrent dispatches see the reservation.
5. On any possibly-dispatched request, call `settleTurnBudget` with provider usage, or with local prompt/completion text when usage is absent. This conservatively accounts uncertain failures.
6. Call `releaseTurnBudgetReservation` only when it is proven that no provider request was dispatched. The rolling request-rate charge intentionally remains.

Pricing is USD per million prompt/completion tokens. A dollar cap requires pricing; startup policy validation rejects a cap without prices. Budget settlement records overages rather than hiding them, while all subsequent dispatches fail their projected limits.

## Provenance

The adapter captures provider request ID, requested/response model, system fingerprint, normalized finish reason, monotonic latency, prompt version, and schema/tool-registry version in its in-process result. The current durable adventure schema stores only requested model, attempt, safe outcome code, and token counts; the additional fields are intentionally not persisted without a schema change. Prompts, schemas, arguments, response text, headers, API keys, and exception messages never enter provenance metadata.

## Thinking-mode gateways and DM narration

Some OpenAI-compatible gateways route one model id to a mix of thinking and non-thinking upstreams
(for example `deepseek-v4-flash` behind the agentrouter `/v1` endpoint). A thinking upstream:

- **rejects any forced tool choice** — named `{ type: "function", function: { name } }` and the string
  `"required"` both fail with `400 invalid_request_error: Thinking mode does not support this tool_choice`,
  intermittently, depending on which upstream the gateway selected; and
- **burns the whole completion budget on hidden `reasoning_content`**, returning an empty `content`
  with `finish_reason: "length"` when reasoning is not disabled.

This is why the campaign Director's planning rounds succeed (`tool_choice: "auto"`) while a forced
`submit_dm_scene` narration can settle `unknown-or-invalid-provider-outcome`. Two rules keep the DM
lanes working:

1. Disable reasoning in the request (`reasoning_effort: "none"`, sent through
   `DIRECT_TOOL_BODY_OVERRIDES`) so no budget is spent on hidden deliberation.
2. Prefer `tool_choice: "auto"` with **exactly one advertised tool** over a forced named tool choice.
   The owning orchestrator still requires the one expected call and rejects anything else, so schema
   authority is unchanged; `auto` is accepted by every upstream the gateway routes to.

Required environment for a live thinking-mode gateway:

```
OPENROUTER_BASE_URL=http://100.72.41.9:8787/v1
OPENROUTER_API_KEY=<gateway key>
OPENROUTER_MODEL=deepseek-v4-flash
```

`requesty-deepseek-v4.1-flash` and the `openrouter:*` routes are exposed by the same gateway but were
not usable in validation (402 low balance / upstream provider error), so they are not a fallback. The
narration lane performs at most one extra dispatch **only** for a pre-dispatch rejection
(`ProviderTransportError`, or HTTP 400/404/422) where no completion could have been generated;
timeouts, 429, and all 5xx stay on the no-ambiguous-paid-retry path.

The same gateway also intermittently rejects a **tool-result follow-up** on the Director planning lane
with `400 The content[].thinking in the thinking mode must be passed back to the API`, even though the
request already disables reasoning and even when the prior assistant `reasoning_content` is replayed
verbatim on the next round. This was reproduced directly against the gateway: replaying the exact
`reasoning_content` did not change the intermittent failure rate (`4/8 with` vs `3/8 without` in one
sampled window; `30/30` for both when the gateway happened to route to a compatible upstream). The
gateway translates between a `reasoning_content` response field and an Anthropic-style `content[].thinking`
input block, so no OpenAI-format client field can satisfy the incompatible upstream; capture-and-replay
is therefore **not** a reliable fix and is not forced. Instead the planning lane retries a deterministic
unbilled 4xx a small bounded number of times (each attempt is unbilled and usually lands on a compatible
upstream) and, if every attempt is rejected, settles the beat `blocked` with
`director-provider-request-rejected-retry` — a clean, durably recorded, retriable outcome — rather than a
terminal `unknown`. Only a deterministic 4xx is treated this way: timeouts, transport failures, 429, 5xx,
forged selections, and over-budget usage still settle `unknown` because their paid outcome cannot be
proven and must never be automatically retried.


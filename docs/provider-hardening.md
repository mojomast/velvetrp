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
3. Dispatch only when `allowed` is true. A denial is deterministic fallback/backpressure; `retryAtMs` is supplied only for the rolling rate limit.
4. Immediately replace state with the returned state so concurrent dispatches see the reservation.
5. On any possibly-dispatched request, call `settleTurnBudget` with provider usage, or with local prompt/completion text when usage is absent. This conservatively accounts uncertain failures.
6. Call `releaseTurnBudgetReservation` only when it is proven that no provider request was dispatched. The rolling request-rate charge intentionally remains.

Pricing is USD per million prompt/completion tokens. A dollar cap requires pricing; startup policy validation rejects a cap without prices. Budget settlement records overages rather than hiding them, while all subsequent dispatches fail their projected limits.

## Provenance

The adapter captures provider request ID, requested/response model, system fingerprint, normalized finish reason, monotonic latency, prompt version, and schema/tool-registry version in its in-process result. The current durable adventure schema stores only requested model, attempt, safe outcome code, and token counts; the additional fields are intentionally not persisted without a schema change. Prompts, schemas, arguments, response text, headers, API keys, and exception messages never enter provenance metadata.

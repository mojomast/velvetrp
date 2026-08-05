# Provider configuration

Velvet now persists provider/model settings locally and exposes them in the UI.

## API

- `GET /api/provider` returns public provider settings with `hasApiKey`; the saved key is never returned.
- `PUT /api/provider` updates provider type, base URL, model, streaming preference, samplers, stop strings, start-reply-with, and API key.
  - Omit `apiKey` to keep the saved key.
  - Send `apiKey: ""` to clear it.

## Fields

- `providerType`: `openai-compatible`, `ollama`, `llamacpp`, `koboldcpp`. Stored for future per-type adapters; all calls currently use the OpenAI-compatible `POST {baseUrl}/chat/completions` wire format (streaming via `stream: true` SSE chunks).
- `baseUrl`, `model`, `streaming`
- `samplers.maxTokens` (1-32768), `topP` (0-1), `topK` (0-500), `minP` (0-1), `repetitionPenalty` (0.01-2)
- `samplers.frequencyPenalty` and `presencePenalty` (-2 to 2), `seed`, and `reasoningEffort`
- `samplers.stopStrings` (max 12, ≤80 chars each), `samplers.startReplyWith` (≤200 chars; injected as a pre-reply system instruction)
- `pricing.promptPerMillion`, `pricing.completionPerMillion`: nullable non-negative USD prices per million input/output tokens. Estimated cost is unavailable until both are set.

## Notes

- `baseUrl` must use `https`, or `http` only for loopback hosts (`localhost`, `*.localhost`, `127.x`, `::1`); invalid values are rejected with 400 on `PUT`.
- `Authorization: Bearer` is sent only when a key exists and the exact host is allowlisted (`api.openai.com`, `openrouter.ai`, `requesty.ai`, `router.requesty.ai`) or loopback; keys never leak to arbitrary hosts.
- Supported hosted providers require a key. Without one, or with a missing/invalid base URL, Velvet uses the local deterministic stub reply (marked `[local stub — provider not fully configured]`).
- Local OpenAI-compatible servers can run keyless.
- Requests default to a 90-second timeout; `requestTimeoutSeconds` is configurable from 15-300 seconds. `startReplyWith` and non-null samplers are included in the request body; null samplers are omitted.
- `streaming: true` switches chat to the SSE transport (`POST /api/sessions/:id/stream`); when false the client uses the buffered `POST /api/sessions/:id/messages` endpoint. See [streaming.md](streaming.md).
- Initial defaults are read from `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `OPENROUTER_API_KEY`, `OPENROUTER_HTTP_REFERER`, and `OPENROUTER_APP_TITLE`. The existing `OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY` names remain supported as fallbacks. Afterwards the stored row wins. Settings persist in the `provider` table of `data/velvet.sqlite`.

For OpenRouter with DeepSeek V4 Flash, copy `.env.example` to the ignored `.env`, add the key, and load it before starting the app:

```bash
set -a
source .env
set +a
npm run dev
```

The low-level live provider test is opt-in and uses the same variables:

```bash
set -a
source .env
set +a
npm --prefix server run test -- llm.test.ts
```

The application-level live E2E test uses provider and model settings already persisted through the application:

```bash
VELVET_E2E_LIVE=1 npm run test:e2e:live
```

It creates a SQLite online backup of the configured database and runs only against that temporary clone. `GET /api/provider` must report `hasApiKey: true` without returning an `apiKey` field. The source provider URL, model, samplers, and key are not modified. To bound cost while ensuring reasoning models return visible text, the clone disables reasoning and sets `maxTokens` to 96 for at most twelve calls covering buffered and streamed replies, room routing/replies, continuation, and four scene-synthesis updates. Both cloned sampler values are restored afterward. No authorization headers, keys, provider request bodies, or live traces are printed or snapshotted. Without the opt-in variable, or when the public API reports no saved key, live E2E skips cleanly.

`maxTokens` controls the maximum generated response length. The UI provides 300, 800, 1,600, and 3,200-token presets plus an exact numeric field. It is a ceiling rather than a guaranteed length; use the editable harness system prompt for paragraph, sentence, pacing, or verbosity targets.

## OpenRouter controls

The provider panel exposes routing priority, fallback behavior, parameter enforcement, data-collection policy, zero-data-retention routing, request timeout, and DeepSeek V4 Flash reasoning effort. Advanced parameters may vary by routed endpoint; enable parameter enforcement when a configured sampler must be honored.

DeepSeek reasoning text is excluded from the returned answer and is never sent through Velvet's content-delta channel. Successful provider-backed character replies retain per-message usage and are estimated from the exact orchestrated prompt when an endpoint omits metadata. Local stubs, safe-word acknowledgements, and failed requests have no usage event. Room routing and scene synthesis are appended to `usage_events` when the provider reports usage for those calls. `GET /api/usage` and **Overall usage & estimated cost** show lifetime totals and operation/model/session breakdowns, including inactive branches and deleted sessions. The chat header separately shows active-branch message tokens. Cost estimates apply the currently configured rates to all ledger entries; they are not provider invoices or historical per-model rate cards.

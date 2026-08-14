# Provider configuration

Velvet stores one local provider profile and sends OpenAI-compatible `POST {baseUrl}/chat/completions` requests. The `providerType` values are `openai-compatible`, `ollama`, `llamacpp`, and `koboldcpp`, but they currently select no different wire adapters.

## Configuration precedence

When no provider row exists, defaults are resolved at runtime in this order:

| Setting | First | Fallback | Built-in default |
| --- | --- | --- | --- |
| Base URL | `OPENROUTER_BASE_URL` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` |
| Model | `OPENROUTER_MODEL` | `OPENAI_MODEL` | `gpt-4o-mini` |
| API key | `OPENROUTER_API_KEY` | `OPENAI_API_KEY` | blank |
| HTTP referer | `OPENROUTER_HTTP_REFERER` | None | blank |
| App title | `OPENROUTER_APP_TITLE` | None | `Velvet` |

Reads construct environment/built-in defaults first and overlay the stored provider JSON. Each field present in a stored row therefore wins; fields absent from an older partial row inherit current defaults. Normal API saves write the complete profile, so changing environment variables does not replace saved settings. Update the stored profile through the UI/API, or use a fresh data directory, when changing bootstrap defaults.

Environment-family precedence uses defined-value semantics, not a nonblank test. An explicitly empty `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, or `OPENROUTER_API_KEY` therefore suppresses the corresponding nonempty `OPENAI_*` fallback. Unset or remove the OpenRouter assignment to use that fallback.

The application does not auto-load `.env`. Node receives only variables exported by the parent process or service manager. For an interactive shell:

```bash
set -a
source .env
set +a
npm run dev
```

Do not source an untrusted environment file. Keep `.env` out of version control.

## API and fields

- `GET /api/provider` returns public settings and `hasApiKey`; it never returns `apiKey`.
- `PUT /api/provider` updates supplied fields. Omit `apiKey` to retain it; send `apiKey: ""` to clear it.
- Send `baseUrl: ""` to deliberately disable outbound generation and use the local deterministic stub.
- A nonblank malformed or disallowed `baseUrl` receives HTTP 400. HTTPS is accepted; HTTP is accepted only for `localhost`, `*.localhost`, `127.x`, `::1`, or the expanded IPv6 loopback form.

The profile includes `baseUrl`, `model`, `streaming`, `requestTimeoutSeconds` (15-300), OpenRouter routing/privacy controls, token pricing, and samplers. Supported finite numeric timeout and sampler values are clamped to their bounds when saved. Sampler bounds are:

| Field | Range |
| --- | --- |
| `maxTokens` | 1-32768 or null |
| `topP`, `minP` | 0-1 or null |
| `topK` | 0-500 or null |
| `repetitionPenalty` | 0.01-2 or null |
| `frequencyPenalty`, `presencePenalty` | -2 to 2 or null |
| `seed` | Signed 32-bit integer or null |
| `reasoningEffort` | `none`, `high`, `xhigh`, or null |
| `stopStrings` | Up to 12 nonblank values, 80 characters each |
| `startReplyWith` | Up to 200 characters |

Null samplers are omitted from requests. `startReplyWith` becomes a server-generated system instruction. `pricing.promptPerMillion` and `pricing.completionPerMillion` are nullable USD estimates clamped to 0-1,000,000 when saved; cost is unavailable unless both are set. `streaming: true` selects the legacy token stream in the chat UI, not the room or durable adventure transport; see [Streaming](streaming.md).

The exact hosted names `api.openai.com`, `openrouter.ai`, `requesty.ai`, and `router.requesty.ai` require a nonblank key to become usable. Loopback and other allowed HTTPS OpenAI-compatible endpoints can be keyless; configured credentials are withheld from arbitrary HTTPS hosts. Missing/blank URL, invalid runtime URL, or a required missing key selects the deterministic local stub whose marker begins `[local stub`. A remote provider HTTP failure instead produces the generation lane's safe fallback and records `providerError` where that API exposes it.

## Credentials and backups

The API key is stored as plain JSON inside the `provider` table in `<resolved data directory>/velvet.sqlite`. It is not encrypted at rest. See [Data directory and current schema](operations.md#data-directory-and-current-schema) for resolution rules. Database files, SQLite online backups, copied data directories, filesystem snapshots, and live-E2E source databases therefore contain the key and must be protected as secrets.

Restrict data-directory and backup permissions, avoid syncing them to untrusted storage, and rotate the provider key after suspected disclosure. `GET /api/provider` redacts the key, but that does not protect direct database access.

Velvet sends `Authorization: Bearer <key>` only when the destination's exact host is one of `api.openai.com`, `openrouter.ai`, `requesty.ai`, `router.requesty.ai`, or a loopback host. A configured key is not sent to other HTTPS hosts. OpenRouter `HTTP-Referer` and `X-Title` headers are sent only to the exact `openrouter.ai` host.

## Outbound context and privacy

Using a remote provider sends more than the newest user line. Depending on the operation, outbound request bodies can include character persona and boundaries, participant cards, active-branch history, approved memories, summaries, triggered lore, editable harness/template text, manual canon, synthesized scene state, recent events, and the current generation instruction. Room routing sends participant identities/descriptions and recent room context. Scene synthesis sends manual canon, prior synthesized state, and recent messages.

Treat all configured remote provider endpoints and any provider-selected upstream model as recipients of that context. Velvet's local loopback listener does not make outbound provider traffic local. Review the provider's retention, training, logging, routing, and jurisdiction policies before use; do not place secrets in roleplay context.

For OpenRouter, Velvet can send `allow_fallbacks`, `require_parameters`, routing sort, `data_collection`, and `zdr` preferences. These are provider request preferences, not locally enforceable privacy guarantees. `allowFallbacks` can route content to another upstream. Verify actual provider support and account policy.

## Live provider tests

The low-level server test makes one real OpenRouter request only when both exact `VELVET_E2E_LIVE=1` and a nonblank `OPENROUTER_API_KEY` are exported. It uses the corresponding `OPENROUTER_*` values rather than the stored SQLite profile:

```bash
set -a
source .env
set +a
export VELVET_E2E_LIVE=1
npm --prefix server run test -- llm.test.ts
```

The application-level live E2E test does not use the normal runtime data-directory default. Its source directory is:

1. `VELVET_E2E_SOURCE_DATA_DIR`, when set.
2. `<repository>/server/data`, otherwise.

When `<source-dir>/velvet.sqlite` exists, the runner opens it read-only and creates a temporary SQLite online backup; the spawned test server uses only that clone. When the source database is missing, the spawned server creates a fresh temporary database whose initial provider profile uses inherited environment defaults. Set the source explicitly and preflight the file when a clone is required, because a missing or mistyped path does not fail the run:

```bash
VELVET_E2E_SOURCE_DATA_DIR=/absolute/path/to/velvet-data \
VELVET_E2E_LIVE=1 npm run test:e2e:live
```

The suite skips unless `VELVET_E2E_LIVE=1`, and then skips the scenario when the temporary server's `GET /api/provider` reports `hasApiKey: false`. A cloned stored profile normally supplies that key; with a fresh database, inherited process environment defaults can supply it. The suite temporarily sets temporary-database reasoning to `none` and `maxTokens` to 96, makes at most 12 calls across buffered/streamed chat, room routing/replies/continuation, and scene synthesis, then removes its records and deletes the temporary database. It never modifies an existing source database. Real provider charges and remote data handling still apply.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Local stub appears | Inspect `GET /api/provider`; verify nonblank URL/model, required `hasApiKey`, and that a saved row is not overriding new environment values. |
| `.env` values have no effect | Export/source them before process start; Velvet has no dotenv loader. If settings were saved, update the stored profile. |
| `PUT /api/provider` returns 400 | Blank intentionally disables; otherwise use valid HTTPS or loopback HTTP. Validate `httpReferer` by the same URL rule when supplied. |
| Provider returns 401/403 | Confirm the key and exact destination host. Velvet intentionally withholds keys from hosts outside its auth allowlist. |
| Provider fails or times out | Check endpoint compatibility at `/chat/completions`, model name, provider logs/status, routing controls, and the 15-300 second timeout. |
| Live E2E skips or uses stale settings | Set `VELVET_E2E_LIVE=1` and explicit `VELVET_E2E_SOURCE_DATA_DIR`; preflight `<source-dir>/velvet.sqlite` and verify the temporary server's public provider response reports `hasApiKey: true`. |
| Streaming behavior is unexpected | `streaming` controls only legacy chat selection. Read [Streaming](streaming.md) for the three distinct contracts. |

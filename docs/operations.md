# Operations

Velvet is a local-first, trusted-local application. The server defaults to loopback and RPG routes use the fixed `local-owner` principal; there is no implemented remote authentication boundary. Operate it as a single-user local service, not as an Internet-facing or multi-user server.

## Node 22 setup

Use Node.js 22, matching CI. From the repository root:

```bash
node --version
npm ci
npx playwright install --with-deps chromium
```

The Chromium install is needed only for Playwright E2E. For iterative development, `npm install` is acceptable when intentionally updating dependencies; reproducible setup and CI use `npm ci` with the committed lockfile.

Common scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build shared contracts, then run watched server and Vite client together. |
| `npm run dev:server` | Build contracts and run only the watched API server. |
| `npm run dev:client` | Build contracts and run only Vite. |
| `npm run typecheck` | Typecheck contracts, server, client, and E2E. |
| `npm run build` | Build contracts, `server/dist`, and `client/dist`. |
| `npm test` | Run contract, server, and client unit/integration tests. |
| `npm run test:e2e` | Run deterministic Playwright E2E with disposable data and a fake provider. |
| `npm run health` | Run the final/release gate: typecheck, build, unit/integration tests, and deterministic E2E. |
| `npm run ci` | Install, typecheck, build, and unit/integration test; it does not run Playwright E2E. |

## Release health gate

`npm run health` is the final/release gate. It runs exactly `npm run typecheck` -> `npm run build` -> `npm test` -> `npm run test:e2e`, once each in that order. The phases are joined fail-fast: the first failure returns a nonzero status and prevents later phases from running.

Use this canonical invocation so each run has a unique in-memory temp directory that is removed when the command finishes:

```bash
(
  health_tmpdir="$(mktemp -d /dev/shm/velvet-health.XXXXXX)" || exit
  trap 'rm -rf -- "$health_tmpdir"' EXIT
  TMPDIR="$health_tmpdir" npm run health
)
```

The health command assumes dependencies and Playwright Chromium are already installed; it does not install either. It runs deterministic E2E only and excludes opt-in live-provider E2E.

Hosted CI mirrors the same four health phases exactly once each, in order and fail-fast, after installing dependencies and Chromium. The distinct `npm run ci` script performs its own clean install, typecheck, build, and unit/integration tests, but omits deterministic E2E and is not the final/release health gate.

## Environment

Velvet does not auto-load `.env`. Export variables in the shell or configure them in the process supervisor before startup.

| Variable | Category | Default | Operational meaning |
| --- | --- | --- | --- |
| `HOST` | server-runtime | `127.0.0.1` | API bind address. Keep loopback. |
| `PORT` | server-runtime | `8787` | API port. |
| `VELVET_DATA_DIR` | server-runtime | `<process.cwd()>/data` | SQLite data directory. Set an absolute path explicitly. |
| `VELVET_SSE_HEARTBEAT_MS` | server-runtime | `15000` | Legacy token and durable-adventure heartbeat input; use a positive finite integer. Room SSE has no heartbeat. |
| `VELVET_API_URL` | client-development | `http://localhost:8787` | Vite development proxy target; not embedded in the built client. |
| `OPENROUTER_BASE_URL` | server-runtime | Unset | Initial provider URL; a defined value takes precedence over `OPENAI_BASE_URL`. |
| `OPENROUTER_MODEL` | server-runtime | Unset | Initial model; a defined value takes precedence over `OPENAI_MODEL`. |
| `OPENROUTER_API_KEY` | server-runtime | Unset | Initial key; a defined value takes precedence over `OPENAI_API_KEY`. Keep empty in examples. |
| `OPENROUTER_HTTP_REFERER` | server-runtime | Blank | Initial OpenRouter referer. |
| `OPENROUTER_APP_TITLE` | server-runtime | `Velvet` | Initial OpenRouter title. |
| `OPENAI_BASE_URL` | server-runtime | `https://api.openai.com/v1` | Provider URL fallback. |
| `OPENAI_MODEL` | server-runtime | `gpt-4o-mini` | Model fallback. |
| `OPENAI_API_KEY` | server-runtime | Blank | Key fallback. Keep empty in examples. |
| `FEATURE_VOICE` | server-runtime | Disabled | Voice discovery flag; exact lowercase `true` only. |
| `FEATURE_IMAGES` | server-runtime | Disabled | Image discovery flag; exact lowercase `true` only. |
| `FEATURE_RPG_CAMPAIGN` | server-runtime | Disabled | Base RPG campaign/API rollout flag. |
| `FEATURE_RPG_MECHANICS` | server-runtime | Disabled | Mechanics routes require this and campaign. |
| `FEATURE_RPG_COMBAT` | server-runtime | Disabled | Combat routes require combat, mechanics, and campaign. |
| `FEATURE_RPG_STUDIO` | server-runtime | Disabled | Studio UI rollout flag; useful only with campaign and mechanics. |
| `FEATURE_REMOTE_AUTHENTICATION` | server-runtime | Disabled | Discovery flag only. It adds no authentication and does not make deployment remote-safe. |
| `NODE_ENV` | internal | Unset | Exact `test` disables automatic Fastify logging; ordinary operators should not use it as a privacy control. |
| `VELVET_E2E_LIVE` | live-test | Disabled | Exact `1` opts into paid/live provider tests. Not a production setting. |
| `VELVET_E2E_SOURCE_DATA_DIR` | live-test | `<repository>/server/data` | Source directory checked by live E2E for `velvet.sqlite`. Not a production data-directory override. |
| `PLANNING_BOARD_PORT` | internal-tool | `8789` | Loopback planning-board port. |
| `PLANNING_BOARD_STATE` | internal-tool | `<repository>/.velvet/planning-board.json` | Planning-board state file. |

Feature values are case-sensitive: only `true` enables feature flags. Provider environment variables are raw bootstrap defaults; a stored provider row wins. Because precedence uses defined-value semantics, an explicitly blank `OPENROUTER_*` value suppresses the corresponding `OPENAI_*` fallback. See [Provider configuration](provider-configuration.md).

The root `.env.example` is complete for supported user-facing server-runtime and client-development keys. `server/.env.example` is intentionally a smaller server-only sample using the legacy-compatible OpenAI names. Live-test and internal-tool keys are classified here or in their owning guide rather than presented as ordinary production configuration. Deterministic E2E supplies disposable `HOST`, `PORT`, `VELVET_DATA_DIR`, feature, and local fake-provider values itself; it has no separate user configuration key and does not make paid provider calls.

Malformed `VELVET_SSE_HEARTBEAT_MS` values are explicitly repaired to 15 seconds by durable adventure SSE, while the legacy token stream passes the numeric value directly to its timer. Use only a positive finite integer for both families; [Streaming](streaming.md) owns their exact transport differences.

## Data directory and current schema

Always configure one explicit absolute data directory so startup location, service working directory, backups, and live tests cannot silently select different databases:

```bash
export VELVET_DATA_DIR=/home/example/.local/share/velvet
```

The server creates the directory, attempts mode `0700`, and opens `VELVET_DATA_DIR/velvet.sqlite` with WAL, foreign keys, and a 5-second busy timeout. A missing or empty database executes `server/src/repo/db/currentSchema.sql` atomically. A nonempty database must have the exact current tables, indexes, triggers, and views and must pass SQLite `quick_check` and `foreign_key_check` before repository use.

Development databases are disposable: schema changes require deleting and recreating `velvet.sqlite`. Startup never upgrades, backfills, rewinds, cleans historical artifacts, imports `db.json`, or resumes a migration chain. A schema mismatch fails with the database path and directs the developer to delete/recreate it.

NPC presence starts empty because roster membership, NPC metadata, actor locations, room participants, messages, and narrative context do not prove presence. Companion authorization derives from current owner/GM relationships while durable history remains evidence rather than current authority. Exact-candidate execution binds provider selection to deterministic world travel and reconstructs replay from persisted evidence. Existing manual world travel remains separate.

The current trusted-local RPG boundary has 111 counted explicit operations, excluding feature discovery and implicit HEAD. Companion administration adds an authoritative owner/GM management GET and a closed receipt-only command POST under `/rpg/v1/campaigns/:campaignId/npcs/:npcId/companion-administration`; there is client transport but no companion UI or delegated grant exercise. Consumables add action GET, command POST, and exact-result GET under `/rpg/v1/combats/:combatId/consumable-actions`. Before consumable POST, the browser must persist its ambiguity marker; it must not automatically retry, and recovery reads the exact result then refreshes combat, log, and actions. Consumable modifiers of every duration are contract-ineligible: instant semantics are unavailable and noninstant modifiers are unsupported, so no modifier descriptor, settlement, legal action, or runtime path exists. No successful historical consumable modifier result exists. Shared catalog/power contracts are unchanged, including receipt-only instant modifiers for powers. Later operations cover reroll, actor placement, combat reward reads/claim/reconciliation, generated foundation/planning, and material publication/read. Deterministic Playwright E2E covers companion, consumable recovery, and provider-committed travel. A separate deterministic server integration test covers the generated-campaign journey through real repository and HTTP composition without an external provider.

If `VELVET_DATA_DIR` is unset or blank, the fallback is `data` under the process's current working directory. Consequently, root `npm run dev` defaults to `<repository>/data`, while a command started with `server` as its working directory defaults to `<repository>/server/data`. Do not rely on this fallback in persistent operation.

## Build and start

Build all workspaces from the root:

```bash
npm ci
npm run build
```

Start the compiled API from the root while preserving an explicit data path and loopback bind:

```bash
HOST=127.0.0.1 PORT=8787 \
VELVET_DATA_DIR=/home/example/.local/share/velvet \
npm --prefix server run start
```

Health is available at `http://127.0.0.1:8787/api/health`.

The API server does not serve the web client. `npm run build` writes static assets to `client/dist`; serve that directory with a separate static server configured for SPA fallback to `index.html`. The client makes relative `/api/...` requests, so the static origin must reverse-proxy `/api` to `http://127.0.0.1:8787`, or both must otherwise be presented under the same local origin. `VELVET_API_URL` configures only the Vite development proxy and does not rewrite production assets.

Keep the static listener and reverse proxy loopback-only as well. Do not set `HOST=0.0.0.0`, publish the API port, or expose it through a public proxy. Fixed `local-owner`, caller-header rejection, and the remote-authentication feature flag are not authentication.

## Recreate development data

Stop Velvet before removing a development database. Delete `velvet.sqlite` together with its `velvet.sqlite-wal` and `velvet.sqlite-shm` sidecars, then restart to create the current schema. Do not edit schema metadata or merge SQLite files. If any development data matters, export it through a current application feature before changing the schema; the repository provides no compatibility or restore path for older schemas.

## Testing

The GitHub Actions workflow uses Node 22, installs dependencies and Chromium, then mirrors the four [`npm run health` phases](#release-health-gate) once each. The root `npm run ci` remains distinct and omits Chromium installation and E2E, so it is not identical to the hosted workflow.

`npm run test:e2e` is deterministic and safe for routine use: it creates a temporary data directory, enables campaign/mechanics features, starts a local fake OpenAI-compatible provider, and removes test data afterward. It does not require or spend a real provider key.

Live E2E is separate and opt-in:

```bash
VELVET_E2E_SOURCE_DATA_DIR=/home/example/.local/share/velvet \
VELVET_E2E_LIVE=1 npm run test:e2e:live
```

If `<source-dir>/velvet.sqlite` exists, live E2E clones it with the SQLite online backup API into a temporary directory and makes bounded real provider calls from the clone. If it does not exist, the temporary server instead creates a fresh database and resolves its initial provider profile from inherited environment defaults. The default source directory is `<repository>/server/data`, not `VELVET_DATA_DIR` and not the root fallback data directory. Set `VELVET_E2E_SOURCE_DATA_DIR` explicitly and preflight that its `velvet.sqlite` exists when a clone is required; a typo or missing source otherwise silently selects fresh-database behavior. See [Provider configuration](provider-configuration.md#live-provider-tests).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Wrong or empty data appears | Print the service working directory and explicit `VELVET_DATA_DIR`; check whether both root `data` and `server/data` exist. Stop before moving anything. |
| Startup reports a schema mismatch | Stop Velvet, delete `velvet.sqlite` and its WAL/SHM sidecars, then restart to create the current development schema. |
| `SQLITE_BUSY` or lock errors | Ensure only intended Velvet processes use the database and that backup tooling uses SQLite online backup while live. The configured busy timeout is 5 seconds. |
| Client loads but API calls 404 | Configure the static origin to proxy `/api` to loopback port 8787. `VELVET_API_URL` affects Vite development only. |
| API is unreachable | Check `HOST`, `PORT`, process logs, and `/api/health`. Keep the listener on `127.0.0.1`. |
| RPG UI/routes are absent | Query `/api/rpg/v1/features`; use exact lowercase `true` and satisfy campaign -> mechanics -> combat dependencies. |
| NPC roster exists but present cast is empty | This is expected whenever no explicit room presence command has committed. Roster membership is not presence. |
| Room detach reports a conflict | A running attached room with at least one currently present NPC cannot detach. Remove each NPC from the present cast first, or stop the room; do not delete or edit presence rows. |
| Streams stall behind a proxy | Disable response buffering/transformation and allow long-lived responses. Review family-specific heartbeat behavior in [Streaming](streaming.md). |
| Provider settings ignore environment | A stored row wins and `.env` is not auto-loaded. See [Provider configuration](provider-configuration.md). |
| Live E2E skips | Set exact `VELVET_E2E_LIVE=1`. If testing a stored profile, set an explicit source directory, preflight its `velvet.sqlite`, and ensure the clone reports `hasApiKey: true`; without a source database, check inherited provider environment defaults instead. |

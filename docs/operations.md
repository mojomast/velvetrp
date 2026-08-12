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

The health command assumes dependencies and Playwright Chromium are already installed; it does not install either. It runs deterministic E2E only and excludes opt-in live-provider E2E. Migration-support tests are already discovered by `npm test`, so there is no duplicate focused migration phase.

Hosted CI mirrors the same four health phases exactly once each, in order and fail-fast, after installing dependencies and Chromium. The distinct `npm run ci` script performs its own clean install, typecheck, build, and unit/integration tests, but omits deterministic E2E and is not the final/release health gate.

## Environment

Velvet does not auto-load `.env`. Export variables in the shell or configure them in the process supervisor before startup.

| Variable | Default | Operational meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API bind address. Keep loopback. |
| `PORT` | `8787` | API port. |
| `VELVET_DATA_DIR` | `<process.cwd()>/data` | SQLite and legacy-import directory. Set an absolute path explicitly. |
| `VELVET_SSE_HEARTBEAT_MS` | `15000` | Token/adventure heartbeat interval. Use a positive finite integer; room SSE has no heartbeat. |
| `VELVET_API_URL` | `http://localhost:8787` | Vite development proxy target, read by `client/vite.config.ts`; not a runtime setting embedded in the built client. |
| `OPENROUTER_BASE_URL` | None | Initial provider URL; takes precedence over `OPENAI_BASE_URL`. |
| `OPENROUTER_MODEL` | None | Initial model; takes precedence over `OPENAI_MODEL`. |
| `OPENROUTER_API_KEY` | None | Initial key; takes precedence over `OPENAI_API_KEY`. |
| `OPENROUTER_HTTP_REFERER` | Blank | Initial OpenRouter referer. |
| `OPENROUTER_APP_TITLE` | `Velvet` | Initial OpenRouter title. |
| `OPENAI_BASE_URL` | Built-in OpenAI URL | Provider URL fallback. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model fallback. |
| `OPENAI_API_KEY` | Blank | Key fallback. |
| `FEATURE_VOICE`, `FEATURE_IMAGES` | Disabled | Discovery flags only; enabled only by exact lowercase `true`. |
| `FEATURE_RPG_CAMPAIGN` | Disabled | Base RPG campaign/API rollout flag. |
| `FEATURE_RPG_MECHANICS` | Disabled | Mechanics routes require this and campaign. |
| `FEATURE_RPG_COMBAT` | Disabled | Combat routes require combat, mechanics, and campaign. |
| `FEATURE_RPG_STUDIO` | Disabled | Studio UI rollout flag; useful only with campaign capability. |
| `FEATURE_REMOTE_AUTHENTICATION` | Disabled | Discovery/roadmap flag only. Setting it does not add authentication or make deployment remote-safe. |
| `VELVET_E2E_LIVE` | Disabled | Exact `1` opts into paid/live provider E2E. |
| `VELVET_E2E_SOURCE_DATA_DIR` | `<repository>/server/data` | Source directory checked by live E2E for `velvet.sqlite`. |

Feature values are case-sensitive: only `true` enables feature flags. Provider environment variables are bootstrap defaults; a stored provider row wins. See [Provider configuration](provider-configuration.md).

## Data directory and startup migrations

Always configure one explicit absolute data directory so startup location, service working directory, backups, and live tests cannot silently select different databases:

```bash
export VELVET_DATA_DIR=/home/example/.local/share/velvet
```

The server creates the directory, attempts mode `0700`, and opens `VELVET_DATA_DIR/velvet.sqlite` with WAL, foreign keys, and a 5-second busy timeout. Schema verification and sequential migrations run automatically when the database opens. For pre-release schema `v45r1`, canonical populated v43 and v44 databases migrating to v45 are the tested and supported forward-startup inputs: v43 follows the preserved v43 -> v44 -> v45 lineage, while v44 follows v44 -> v45. Marker paths for v42 and earlier are unsupported. Before marker or artifact mutation, startup preflight rejects database-wide persisted foreign-key corruption in supported inputs, unexpected current/future named artifacts, and cross-campaign generation-draft ancestry. Current v45 startup verifies the canonical v45 companion object inventory and layout attestation in addition to prior integrity checks. There is no separate migration command and no supported automatic downgrade. Recreate older development databases or restore a backup from a compatible build.

The v43 migration creates five NPC-presence data tables empty: the room-scoped revision root, materialized state, and immutable command, event, and receipt tables. It deliberately performs **no presence backfill**: campaign NPC roster membership, NPC metadata, actor locations, room participants, messages, and narrative context do not prove that an NPC is present. The v44 migration created the initial empty companion sidecars. The v45 migration replaces those sidecars and preserves all rows while changing historical command, proposal, decision, grant, and revocation actor references to durable principals. Removing a campaign membership therefore no longer invalidates or pins companion history. Live companion administration authorization still derives from the repository's current owner/GM relationships; durable history is evidence, not current authority.

If `VELVET_DATA_DIR` is unset or blank, the fallback is `data` under the process's current working directory. Consequently, root `npm run dev` defaults to `<repository>/data`, while a command started with `server` as its working directory defaults to `<repository>/server/data`. Do not rely on this fallback in persistent operation.

An old `db.json` in the data directory can be imported once into an empty SQLite roleplay store. If SQLite already contains characters, sessions, or messages, import is skipped and the legacy file is left in place with a warning. Preserve both files until the result is verified.

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

## Backup before migration

Back up before the first start of every upgraded build. Startup may migrate immediately, so the backup must happen while the old build is still stopped or before switching the service executable.

Preferred approaches:

1. Stop Velvet cleanly, verify no process has the database open, and copy the entire explicit `VELVET_DATA_DIR` to protected storage. A stopped full-directory copy captures SQLite, any WAL/SHM sidecars, legacy import evidence, and permissions.
2. If downtime is impossible, use SQLite's online backup API/tool against `velvet.sqlite`; do not copy only the main database file while WAL mode is live.
3. Record the application revision and data-directory path with the backup. Restrict backup access because the provider API key is stored unencrypted in SQLite.

After upgrading, verify health, startup logs, provider public state, and representative reads before deleting the backup. Never test a backup by opening the only copy with a newer build: that can migrate it.

## Restore

1. Stop Velvet and all processes using the database.
2. Move the failed/current data directory aside without deleting it.
3. Restore the complete stopped directory backup, or restore a verified SQLite online-backup file as `velvet.sqlite` into a clean directory.
4. Restore restrictive ownership and permissions.
5. Start the application revision that created or supports that backup, still bound to loopback, and verify `/api/health` plus representative data.

Do not merge database files, omit a live WAL file, edit the schema marker, or expect a newer migrated database to work with an older build. If migration startup fails, retain logs, the untouched pre-migration backup, and the failed database for diagnosis.

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
| Startup fails during schema work | Stop retries, preserve the failing directory and logs, and restore a pre-upgrade backup with its compatible build. Do not edit SQLite manually. |
| `SQLITE_BUSY` or lock errors | Ensure only intended Velvet processes use the database and that backup tooling uses SQLite online backup while live. The configured busy timeout is 5 seconds. |
| Client loads but API calls 404 | Configure the static origin to proxy `/api` to loopback port 8787. `VELVET_API_URL` affects Vite development only. |
| API is unreachable | Check `HOST`, `PORT`, process logs, and `/api/health`. Keep the listener on `127.0.0.1`. |
| RPG UI/routes are absent | Query `/api/rpg/v1/features`; use exact lowercase `true` and satisfy campaign -> mechanics -> combat dependencies. |
| NPC roster exists but present cast is empty | This is expected after v43 migration and whenever no explicit room presence command has committed. Roster membership is not presence and startup performs no backfill. |
| Room detach reports a conflict | A running attached room with at least one currently present NPC cannot detach. Remove each NPC from the present cast first, or stop the room; do not delete or edit presence rows. |
| Streams stall behind a proxy | Disable response buffering/transformation and allow long-lived responses. Review family-specific heartbeat behavior in [Streaming](streaming.md). |
| Provider settings ignore environment | A stored row wins and `.env` is not auto-loaded. See [Provider configuration](provider-configuration.md). |
| Live E2E skips | Set exact `VELVET_E2E_LIVE=1`. If testing a stored profile, set an explicit source directory, preflight its `velvet.sqlite`, and ensure the clone reports `hasApiKey: true`; without a source database, check inherited provider environment defaults instead. |

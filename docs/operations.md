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
| `VELVET_ALLOWED_HOSTS` | client-development | Unset | Optional comma-separated extra hostnames the Vite development server accepts for reverse-proxy or tailnet access; entries are trimmed and empties dropped, and it is not embedded in the built client. |
| `OPENROUTER_BASE_URL` | server-runtime | Unset | Initial provider URL; a defined value takes precedence over `OPENAI_BASE_URL`. |
| `OPENROUTER_MODEL` | server-runtime | Unset | Initial model; a defined value takes precedence over `OPENAI_MODEL`. |
| `OPENROUTER_API_KEY` | server-runtime | Unset | Initial key; a defined value takes precedence over `OPENAI_API_KEY`. Keep empty in examples. |
| `OPENROUTER_HTTP_REFERER` | server-runtime | Blank | Initial OpenRouter referer. |
| `OPENROUTER_APP_TITLE` | server-runtime | `Velvet` | Initial OpenRouter title. |
| `OPENROUTER_USER_AGENT` | server-runtime | Blank | Optional visible-ASCII user agent forwarded only to OpenRouter or a loopback inference gateway. |
| `OPENAI_BASE_URL` | server-runtime | `https://api.openai.com/v1` | Provider URL fallback. |
| `OPENAI_MODEL` | server-runtime | `gpt-4o-mini` | Model fallback. |
| `OPENAI_API_KEY` | server-runtime | Blank | Key fallback. Keep empty in examples. |
| `FEATURE_VOICE` | server-runtime | Disabled | Voice discovery flag; exact lowercase `true` only. |
| `VELVET_VOICE_ENABLED` | server-runtime | Disabled | Exact `true` opts into optional campaign narration playback; separate from discovery-only `FEATURE_VOICE`. Requires campaign/mechanics and configured voices. |
| `OMNIVOICE_BASE_URL` | server-runtime | Unset | Operator-configured Studio HTTP(S) root origin, directly reachable or through a private tunnel; server-side only. |
| `VELVET_VOICE_DEFINITIONS` | server-runtime | `[]` | JSON array of approved synthetic or locked-profile voice definitions; see [voice deployment](omnivoice-support-plan.md). Empty/invalid configuration leaves voice disabled. |
| `VELVET_VOICE_TIMEOUT_MS` | server-runtime | `300000` | Per-utterance synthesis deadline, bounded to 1000–600000 ms; never retries game commands. |
| `VELVET_VOICE_ALLOWED_ORIGINS` | server-runtime | Unset | Optional comma-separated trusted browser origins for a Host-rewriting development proxy; no wildcard or added Studio CORS. |
| `FEATURE_IMAGES` | server-runtime | Disabled | Image discovery flag; exact lowercase `true` only. |
| `VELVET_IMAGES_ENABLED` | server-runtime | Disabled | Exact `true` opts into optional image generation; separate from discovery-only `FEATURE_IMAGES`. Enabled only when a valid `VELVET_IMAGES_BASE_URL` is also configured. |
| `VELVET_IMAGES_BASE_URL` | server-runtime | Unset | Operator-configured image-generation HTTP(S) root; `http:` is accepted only for loopback, RFC1918 private, or Tailscale CGNAT/`*.ts.net` hosts. |
| `VELVET_IMAGES_TOKEN` | server-runtime | Blank | Optional bearer credential sent only to the configured image-generation base URL. Keep empty in examples. |
| `VELVET_IMAGES_MODEL` | server-runtime | Unset | Operator-declared image model identifier used for health reporting; server-side only. |
| `VELVET_IMAGES_TIMEOUT_MS` | server-runtime | `120000` | Per-generation request deadline, bounded to 1000–600000 ms; a failed or ambiguous call is never retried automatically. |
| `VELVET_IMAGES_MAX_BYTES` | server-runtime | `8388608` | Decoded byte budget per generated image, bounded to 1024–67108864 bytes. |
| `VELVET_SCENE_IMAGES_ENABLED` | server-runtime | Disabled | Exact `true` opts into the private Supra2 scene-image service; requires a valid base URL and the deployment's Tailscale identity authorization. |
| `VELVET_SCENE_IMAGES_BASE_URL` | server-runtime | Unset | Operator-configured Supra2 HTTP(S) root; `http:` is accepted only for loopback, RFC1918 private, or Tailscale CGNAT/`*.ts.net` hosts. |
| `VELVET_SCENE_IMAGES_ORIGIN` | server-runtime | Base URL origin | `Origin` header sent on POST submissions because the service checks it as a request guard; not an authentication credential. |
| `VELVET_SCENE_IMAGES_TIMEOUT_MS` | server-runtime | `120000` | Per-request deadline bounded to 1000–600000 ms; an ambiguous submission is never retried automatically. |
| `VELVET_SCENE_IMAGES_MAX_BYTES` | server-runtime | `8388608` | Decoded PNG byte budget bounded to 1024–67108864 bytes. |
| `FEATURE_RPG_CAMPAIGN` | server-runtime | Disabled | Base RPG campaign/API rollout flag. |
| `FEATURE_RPG_MECHANICS` | server-runtime | Disabled | Mechanics routes require this and campaign. |
| `FEATURE_RPG_COMBAT` | server-runtime | Disabled | Combat routes require combat, mechanics, and campaign. |
| `FEATURE_RPG_STUDIO` | server-runtime | Disabled | Studio UI rollout flag; useful only with campaign and mechanics. |
| `FEATURE_REMOTE_AUTHENTICATION` | server-runtime | Disabled | Discovery flag only. It adds no authentication and does not make deployment remote-safe. |
| `FEATURE_SYSTEM_ONE` | server-runtime | Disabled | Exact `true` advertises optional System One (Jev) decision lanes; rollout control only. The promoted speaker-routing lane can change room routing when its lane mode is `active` and it is promoted, and the promoted adventure-selection lane can commit SRD check candidates and raise rest proposals (which still require the normal confirmation flow) under the same conditions; the director, narration-verification, cost-router, guardrails, and memory-reranking lanes are wired in `shadow` (record-only). Every lane falls back deterministically, and none mutates campaign state outside its committed candidate path. |
| `TYPESAFE_BASE_URL` | server-runtime | `https://api.typesafe.ai/v1` | Initial System One base URL; must be HTTPS or loopback HTTP. |
| `TYPESAFE_MODEL` | server-runtime | `jev-latest` | Initial System One model; pin an exact version such as `jev-1.13.0` for evaluations. |
| `TYPESAFE_API_KEY` | server-runtime | Blank | Initial System One credential; sent only to the allowlisted `api.typesafe.ai` host or loopback. Keep empty in examples. |
| `NODE_ENV` | internal | Unset | Exact `test` disables automatic Fastify logging; ordinary operators should not use it as a privacy control. |
| `VELVET_E2E_LIVE` | live-test | Disabled | Exact `1` opts into paid/live provider tests. Not a production setting. |
| `VELVET_E2E_SOURCE_DATA_DIR` | live-test | `<repository>/server/data` | Source directory checked by live E2E for `velvet.sqlite`. Not a production data-directory override. |
| `ROUTETOK_BASE_URL` | live-test | `http://127.0.0.1:8787/v1` | Optional RouteTok endpoint used only by the explicit `probe:routetok` command. |
| `PROXY_API_KEY` | live-test | Blank | RouteTok probe credential. Keep empty in examples and never persist it in source control. |
| `PLANNING_BOARD_PORT` | internal-tool | `8789` | Loopback planning-board port. |
| `PLANNING_BOARD_STATE` | internal-tool | `<repository>/.velvet/planning-board.json` | Planning-board state file. |

Feature values are case-sensitive: only `true` enables feature flags. Provider environment variables are raw bootstrap defaults; a stored provider row wins. Because precedence uses defined-value semantics, an explicitly blank `OPENROUTER_*` value suppresses the corresponding `OPENAI_*` fallback. See [Provider configuration](provider-configuration.md).

The root `.env.example` is complete for supported user-facing server-runtime and client-development keys. `server/.env.example` is intentionally a smaller server-only sample using the legacy-compatible OpenAI names. Live-test and internal-tool keys are classified here or in their owning guide rather than presented as ordinary production configuration. Deterministic E2E supplies disposable `HOST`, `PORT`, `VELVET_DATA_DIR`, feature, and local fake-provider values itself; it has no separate user configuration key and does not make paid provider calls.

The in-process campaign control-plane, combat-map, and session-recovery E2E fixtures temporarily override existing data-directory, test-mode, feature, and OpenAI provider keys, then restore their previous values. Explicit named environment save/restore accesses keep every key visible to the documentation drift scanner; previously unset keys are deleted rather than assigned the string `undefined`.

Malformed `VELVET_SSE_HEARTBEAT_MS` values are explicitly repaired to 15 seconds by durable adventure SSE, while the legacy token stream passes the numeric value directly to its timer. Use only a positive finite integer for both families; [Streaming](streaming.md) owns their exact transport differences.

## Data directory and current schema

Always configure one explicit absolute data directory so startup location, service working directory, backups, and live tests cannot silently select different databases:

```bash
export VELVET_DATA_DIR=/home/example/.local/share/velvet
```

The server creates the directory, attempts mode `0700`, and opens `VELVET_DATA_DIR/velvet.sqlite` with WAL, foreign keys, and a 5-second busy timeout. A missing or empty database executes `server/src/repo/db/currentSchema.sql`, `server/src/repo/db/campaignDmSchema.sql`, and `server/src/repo/db/recallSchema.sql` atomically. The server build copies all three SQL assets into the compiled repository directory. A nonempty database must have the exact current tables, indexes, triggers, and views, either already or after a supported exact upgrade, and must pass SQLite `quick_check` and `foreign_key_check` before repository use.

Development databases are disposable: schema changes require deleting and recreating `velvet.sqlite`, except for narrowly recognized exact tactical-map, campaign-director, and pre-recall predecessor upgrades. The map-only path is owned by `server/src/map/schemaUpgrade.ts`. Startup recognizes that predecessor only when every schema object exactly matches the current schema minus the map-v2 changes, with recall storage either fully current or wholly absent as described below; this path retains the current director schema unchanged. It rebuilds the map and preview tables while preserving existing columns/rows, admits `dungeon-v2`, `cave-v2`, `arena-v2`, and the `underwater` layouts, adds nullable preview `actor_location_revision`, and creates the initially empty `tactical_map_contexts_v2` table and its immutable triggers. It does not infer context for legacy maps.

Startup first checks the exact pre-recall inventory in `server/src/repo/db/schema.ts`: all current objects except `adventure_narration_contexts` and its three immutable triggers. It adds those objects in an immediate transaction, preserves existing data without historical context backfill, and validates the complete current schema before commit. The sidecar stores frozen adventure narration dispatch context/request keyed by claim, not searchable history or new mechanical truth.

Otherwise startup tries `server/src/repo/db/campaignDmUpgrade.ts`, then the map-only path. If the recall table is absent, the expected inventory supplied to these recognizers excludes recall objects, and their validation callback installs `recallSchema.sql` and validates the final full schema within the same upgrade transaction. If recall storage exists, it must already match exactly. Director recognition still admits only these exact full-object inventories:

- **Pre-director, grounded:** the current schema with every `dm_` object absent. It adds the director objects and initializes every existing campaign to human mode, revision zero, with no delegator.
- **Pre-director, pre-grounding:** that same pre-director inventory with the exact map-v2 changes absent. One transaction performs the map table/context upgrade and director initialization together.
- **Director review-authority predecessor:** the current inventory without `dm_review_` objects, with the older campaign-membership foreign keys on `dm_control`, `dm_mode_commands`, and `dm_runs`. This exact shape is recognized with or without `dm_narration_` objects. The upgrade rebuilds those three tables with principal foreign keys, restores historical rows before recreating present-authority insert triggers, and adds missing director objects. Runs in `planning` or `awaiting-approval` become `cancelled`, their revision increments, and their blocker becomes `director-security-upgrade-requires-new-beat`. Other historical rows are retained; this does not replay mechanics or paid work.
- **Director narration predecessor:** the current inventory with only `dm_narration_` objects absent. It adds the missing narration objects without resetting existing control or cancelling runs.

Recognition compares the complete schema-object inventory, not a version label or merely the presence of selected tables. These cases do not authorize arbitrary combinations of missing objects or historical migration chains.

The upgrade uses one independent immediate transaction for each recognized path. Director/map rebuilds temporarily disable foreign-key enforcement and restore it afterward; the recall-only additive path does not disable it. For every path, an explicit foreign-key check plus complete current-schema, SQLite quick-check, local-ownership, and effect-vocabulary validation must succeed before commit. Any failure rolls back schema and data changes. Every other unknown, modified, or partially upgraded schema is rejected without repair. Apart from the explicit director initialization and pending-run cancellation above, startup does not backfill domain state, rewind history, clean historical artifacts, or import `db.json`. A schema mismatch fails with the database path and directs the developer to delete/recreate it.

NPC presence starts empty because roster membership, NPC metadata, actor locations, room participants, messages, and narrative context do not prove presence. Companion authorization derives from current owner/GM relationships while durable history remains evidence rather than current authority. Exact-candidate execution binds provider selection to deterministic world travel and reconstructs replay from persisted evidence. Existing manual world travel remains separate.

At the historical administration-integration checkpoint, the trusted-local RPG boundary had 123 counted explicit operations, excluding feature discovery and implicit HEAD. Tactical-map generation, projection, preview, and movement persist authoritative maps, token revisions, fog/exploration, exact previews, and command receipts. Development databases must be recreated for the v59 administration-integration tables. Map generation and move POSTs are never automatically retried; ambiguous recovery performs only the actor-bound map GET and then requires a fresh preview. Companion administration adds an authoritative owner/GM management GET and a closed receipt-only command POST under `/rpg/v1/campaigns/:campaignId/npcs/:npcId/companion-administration`; there is client transport but no companion UI or delegated grant exercise. Consumables add action GET, command POST, and exact-result GET under `/rpg/v1/combats/:combatId/consumable-actions`. Before consumable POST, the browser must persist its ambiguity marker; it must not automatically retry, and recovery reads the exact result then refreshes combat, log, and actions. Consumable modifiers of every duration are contract-ineligible: instant semantics are unavailable and noninstant modifiers are unsupported, so no modifier descriptor, settlement, legal action, or runtime path exists. No successful historical consumable modifier result exists. Shared catalog/power contracts are unchanged, including receipt-only instant modifiers for powers. Later operations cover reroll, actor placement, combat reward reads/claim/reconciliation, generated foundation/planning, material publication/read, and campaign administration integrations. The administration aggregate GET is the only ambiguity reconciliation path for vendor association, buy policy, ruleset selection, and safety commands. Durable generation metadata can reopen exact drafts but cannot reconstruct a paid retry because private prompt/provider request data is deliberately excluded. Deterministic Playwright E2E covers tactical movement, companion, consumable recovery, and provider-committed travel. Separate server integration tests cover generated campaigns and administration integration through real repository and HTTP composition without an external provider.

The current trusted-local RPG boundary has 154 counted explicit operations plus separately classified feature discovery, excluding implicit HEAD; this supersedes the historical count above. The prior preparation/recovery checkpoint had 135 counted operations. The twelve director and inspection additions cover campaign control, scene-evidence binding, room history, private readiness, public run/private proposal reads, beat/decision/resume commands, and exact no-replay context inspection. See the [API inventory](api.md#campaign-director) for exact paths and provider-free versus provider-capable behavior.

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

Stop Velvet before removing a development database. Delete `velvet.sqlite` together with its `velvet.sqlite-wal` and `velvet.sqlite-shm` sidecars, then restart to create the current schema. Do not edit schema metadata or merge SQLite files. If any development data matters, export it through a current application feature before changing the schema. Apart from the exact tactical-map, campaign-director, and pre-recall predecessors described above, the repository provides no compatibility or restore path for older schemas.

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
| Server tests fail intermittently with `ENOSPC` or a `SQLITE_FULL`-style error | Check free space in `TMPDIR`: each server test file installs an ~10 MB starter catalog, and a nearly full temp filesystem fails whichever file writes next. Point `TMPDIR` at a filesystem with room, or delete stale `velvet-test-*` directories. `server/test/helpers.ts` names its temp data directories with the owning PID and reaps directories whose owner is gone, so a killed run no longer leaks space forever. |
| Client loads but API calls 404 | Configure the static origin to proxy `/api` to loopback port 8787. `VELVET_API_URL` affects Vite development only. |
| API is unreachable | Check `HOST`, `PORT`, process logs, and `/api/health`. Keep the listener on `127.0.0.1`. |
| RPG UI/routes are absent | Query `/api/rpg/v1/features`; use exact lowercase `true` and satisfy campaign -> mechanics -> combat dependencies. |
| NPC roster exists but present cast is empty | This is expected whenever no explicit room presence command has committed. Roster membership is not presence. |
| Room detach reports a conflict | A running attached room with at least one currently present NPC cannot detach. Remove each NPC from the present cast first, or stop the room; do not delete or edit presence rows. |
| Streams stall behind a proxy | Disable response buffering/transformation and allow long-lived responses. Review family-specific heartbeat behavior in [Streaming](streaming.md). |
| Provider settings ignore environment | A stored row wins and `.env` is not auto-loaded. See [Provider configuration](provider-configuration.md). |
| Live E2E skips | Set exact `VELVET_E2E_LIVE=1`. If testing a stored profile, set an explicit source directory, preflight its `velvet.sqlite`, and ensure the clone reports `hasApiKey: true`; without a source database, check inherited provider environment defaults instead. |

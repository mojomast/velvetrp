# VelvetRP

VelvetRP is a local-first AI roleplay and campaign RPG application. A React client talks to a loopback Fastify server, and application state is stored in local SQLite. It supports character and group roleplay, persistent context, and a receipt-backed RPG system with campaign administration, character mechanics, combat, world and story tools, and a campaign play shell.

Current persistence is **schema v42 revision 1 (`v42r1`)**. The trusted-local RPG API currently has **95 explicitly registered HTTP operations**, excluding `GET /api/rpg/v1/features`; the historical M2.11 baseline was 92, and M4.6 added three reviewed campaign-content draft operations. Roadmap milestones M1-M3 and **M4.1-M4.6 are complete**, including the bounded tool loop, deterministic command bridge, durable confirmation/resume, receipt-aware narration, and reviewed encounter and campaign-content generation.

## Security And Privacy

Local-first describes storage and deployment, not a guarantee that all processing stays on the device.

- SQLite data is local by default.
- When a remote model provider is configured, Velvet sends assembled prompts and conversation context to that provider. Review the provider's privacy and retention terms.
- Without a usable provider, roleplay uses a clearly marked deterministic local stub. RPG adventure turns use deterministic recovery after provider failure, including receipt-backed fallback narration and authoritative enemy-turn recovery; this is a delivered M4 recovery path, not a placeholder for future tool-loop work.
- The server defaults to `127.0.0.1` and RPG routes use the fixed `local-owner` principal. There is no authentication boundary. Authorization and principal headers are ignored.
- Do not expose this server to a LAN, the internet, a reverse proxy, or multiple untrusted users. `FEATURE_REMOTE_AUTHENTICATION` is discovery-only rollout state, not implemented authentication.
- Provider keys are persisted locally and are never returned by the public provider API. Authorization headers are sent only to allowlisted hosted providers or loopback hosts.

## Current Capabilities

### Roleplay

- Character create, edit, import, export, archetypes, and boundaries
- One-to-one and up-to-12-character sessions with attributed messages
- Model-routed room turns with bounded sequential speakers and auto-follow-up rounds
- Streaming, cancellation, branches, reply swipes, and durable solo conversations
- Approved and pending memories, scoped lore, summaries, and editable scene canon
- A 20-layer prompt studio, provider settings, usage accounting, and cost estimates

### Campaign RPG

- Campaign lifecycle, settings, memberships, rooms, timelines, checkpoints, recaps, import, and export
- Immutable content-pack validation/publication, exact campaign pins, and built-in starter choices
- Character drafts, finalization, derived sheets, XP, level advancement, resources, inventory, economy, and rest
- Server-resolved checks, powers, effects, encounters, legal combat actions, logs, and rewards
- World travel, NPCs, factions, reputation, quests, clues, story graphs, and role-filtered projections
- Client studios for administration, content, characters, sheets, combat, world, cast, journals, history, and transfer
- Durable adventure turns, reconciliation, confirmations, mechanic receipts, narration swipes, and reviewed encounter and campaign-content drafts with authoritative application
- Server-internal campaign context assembly with role-derived audience visibility, exact precedence, independent UTF-16 whole-line budgets, and session/speaker-persona binding
- A role-selected, bounded provider tool loop with deterministic command bridging, durable resume, and receipt-aware narration and recovery

The full operation contract is in the [API reference](docs/api.md). The implementation intentionally does not duplicate the route and schema tree here.

## Requirements

- Node.js 22
- npm
- Playwright Chromium for browser E2E tests
- Optional OpenAI-compatible local or hosted provider

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` as needed. For the complete RPG UI, enable the campaign, mechanics, combat, and studio flags. Leave remote authentication disabled because it is not an authentication implementation.

The application does not load `.env` automatically. Export it into each shell that starts Velvet:

```bash
set -a
source .env
set +a
npm run dev
```

Services:

| Service | Default URL |
| --- | --- |
| Client | `http://localhost:5173` |
| Server | `http://127.0.0.1:8787` |
| Health | `http://127.0.0.1:8787/api/health` |

The Vite development server proxies `/api` to `VELVET_API_URL`, defaulting to `http://localhost:8787`.

### Provider Configuration

The root `.env.example` uses OpenRouter variables. `OPENAI_BASE_URL`, `OPENAI_MODEL`, and `OPENAI_API_KEY` are supported fallbacks; `server/.env.example` shows those legacy-compatible names. Environment values provide defaults while no provider row exists; after settings are saved through the application, persisted settings take precedence. Local OpenAI-compatible loopback providers can run without a key.

See [Provider configuration](docs/provider-configuration.md) for URL restrictions, supported settings, persistence, and transmission behavior.

### Feature Flags

Flags are enabled only by the exact string `true` and default to false.

| Flag | Effect or dependency |
| --- | --- |
| `FEATURE_VOICE` | Reports voice rollout availability |
| `FEATURE_IMAGES` | Reports image rollout availability |
| `FEATURE_RPG_CAMPAIGN` | Enables campaign administration and transfer routes |
| `FEATURE_RPG_MECHANICS` | With campaign, enables mechanics, content, world/story, play, adventure-turn, and generation routes |
| `FEATURE_RPG_COMBAT` | With campaign and mechanics, enables encounter and combat routes/UI |
| `FEATURE_RPG_STUDIO` | With campaign and mechanics, exposes narrative studio navigation in the client |
| `FEATURE_REMOTE_AUTHENTICATION` | Reports rollout state only; supplies no authentication |

These are rollout controls, not permissions or security controls.

## Commands

```bash
npm run dev             # contracts build, then server and client watchers
npm run dev:server      # contracts build, then Fastify watcher
npm run dev:client      # contracts build, then Vite
npm run typecheck       # contracts, server, client, and E2E projects
npm run build           # contracts, server, and client production builds
npm test                # contracts, server, and client unit/component tests
npm run test:e2e        # deterministic Playwright suite with disposable DB/provider
npm run test:e2e:live   # opt-in live-provider Playwright suite
npm run ci              # clean install, typecheck, build, and unit tests
```

Install the browser once:

```bash
npx playwright install chromium
```

Run the built, production-like Fastify server after `npm run build`:

```bash
npm --workspace velvet-mvp-server start
```

The deterministic E2E command starts isolated test servers and does not make paid provider calls. Live E2E is separate, opt-in, operates on a temporary online backup of the configured database, and may incur provider cost:

```bash
VELVET_E2E_LIVE=1 npm run test:e2e:live
```

## Architecture

```text
React/Vite client
  -> HTTP and SSE through client/src/api.ts
Fastify server
  -> roleplay routes and generation services
  -> feature-gated /api/rpg/v1 routes
Shared @velvet/contracts Zod schemas
  -> request, response, persistence-boundary validation
Repository and deterministic command services
  -> SQLite migrations, transactions, revisions, events, and receipts
Provider adapter
  -> OpenAI-compatible /chat/completions or local stub
```

The npm workspace is organized as:

- `packages/contracts/`: shared runtime contracts and inferred TypeScript types
- `server/`: Fastify composition, roleplay/RPG routes, context and provider services, repositories, and migrations
- `client/`: React application and typed API/SSE consumers
- `e2e/`: deterministic and opt-in live Playwright workflows
- `docs/`: API, architecture, roadmap, streaming, provider, and harness references

Contracts-first changes keep HTTP and repository boundaries strict. RPG mutations generally use expected revisions, idempotency keys, atomic transactions, immutable events/receipts, and authoritative reads after ambiguous delivery.

## Persistence

The default database is `server/data/velvet.sqlite` when the server is launched through its workspace. Set `VELVET_DATA_DIR` to use another directory. The server creates the directory with best-effort owner-only permissions and enables SQLite WAL mode, foreign keys, and a busy timeout.

For pre-release schema `v42r1`, v40/v41 -> v42 is the tested and supported forward-startup compatibility window; it validates canonical layout/integrity attestations. Legacy marker paths for v2-v39 remain in the binary temporarily, but are untested and unsupported. Automatic downgrade is unsupported. Recreate older development databases or restore backups from compatible builds. Back up the database before moving it between builds. Campaign export deliberately omits credentials, local paths, usage history, and private actor state.

## Limitations

- Campaign context excludes full catalogs, full inventories, story graph dumps, unrelated private state, hidden routes, and controller identities. NPC/enemy target-private planning is non-disclosable. Legacy character prompting accepts only exact session- and persona-bound player/NPC baskets; DM/enemy legacy prompts fail closed, while the composed adventure orchestrator selects role-authorized player or enemy context. Companion context fails closed because no persisted companion model or controller binding exists.
- The campaign context drawer shows the campaign-visible NPC roster because NPC location/presence is not modeled.
- Published content-pack versions are immutable. Create a new exact version to change one.
- Build Later includes planned remote campaign identity and tenancy; the current runtime remains fixed to the trusted-local `local-owner` principal.
- Append-only multiclass progression and autonomous parties are Approved Build Unscheduled.
- Discord, VTT adapters, and simultaneous encounters remain deferred.
- Feature flags can hide surfaces but cannot authorize users.

## Testing

For local development, run the owning workspace typecheck and only the test file(s) affected by the change, for example `npm run test --workspace velvet-mvp-server -- test/repo.test.ts`. Run `npm test` for broad or cross-workspace changes, or before merging when CI is unavailable. CI is the normal full validation gate and runs all unit tests plus deterministic E2E. Run `npm run test:e2e` locally when behavior crosses browser, API, streaming, persistence, or migration boundaries. Run live E2E only when intentionally validating a configured provider. Test totals are intentionally omitted because they change frequently.

## Policy Status

The current policy layer is limited, not a comprehensive content-moderation system. Character checks are permissive. User input receives control-character and simple prompt-injection marker sanitation, and assistant output checks a small boundary/refusal-bypass phrase list. Character boundaries and memory approval behavior still apply, but operators must not treat this stub as a complete safety policy.

## Documentation

| Document | Purpose |
| --- | --- |
| [Roadmap](docs/ROADMAP.md) | Current dependency-ordered milestones and deferred scope |
| [API reference](docs/api.md) | HTTP behavior, contracts, flags, and RPG operation inventory |
| [RPG integration plan](docs/rpg-integration-plan.md) | Product and mechanics integration design |
| [Roleplay architecture](docs/roleplay-architecture-2026.md) | Roleplay context and generation architecture, including historical notes |
| [Repository architecture](docs/repo-architecture.md) | Repository boundaries and transaction conventions |
| [Streaming](docs/streaming.md) | Roleplay SSE framing and cancellation |
| [Provider configuration](docs/provider-configuration.md) | Provider settings and live-test behavior |
| [Customizable harness](docs/customizable-harness.md) | Prompt layer and harness controls |
| [Development plan](devplan.md) | Compact completion ledger and next milestone |
| [Engineering handoff](handoff.md) | Current implementation handoff |
| [Contributing](CONTRIBUTING.md) | Development and validation expectations |

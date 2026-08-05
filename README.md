# VelvetRP

**VelvetRP** is a local-first AI roleplay and RPG application. It runs entirely on your machine — no cloud account, no sync service, no data leaving your device. Characters, memories, lore, and sessions are stored in a local SQLite database and served through a Fastify API to a React frontend.

> **Current status:** Core roleplay is fully playable today. The RPG mechanics layer (character sheets, combat, quests, world) is under active development — see the [Roadmap](#roadmap).

Current persistence is schema **v24 revision 1 (v24r1)**. Schema v23 introduced the M1.4 single-class progression repository/shared contracts; v24 repaired progression provenance and integrity without rewriting historical ledgers. The feature-gated trusted-local RPG boundary now has exactly **21** HTTP operations: the historical 14 plus builder create/read/update, progression read/preview, and administration GET/PATCH. No client/UI exists for these seven new routes.

The fixed canonical v24 DDL digest is `e056d9df1ec9f9c00cc1aba740f2acc91b40cc7b03a5716cb75e79ec8df6bec8`. The built-in `velvet:mechanics-starter` remains distinct from the metadata-only `velvet:original-starter`; owners of unconfigured campaigns may explicitly choose either one. M1.1–M1.4 repository/contracts work is complete, with selected server-only HTTP exposure; client/UI work for the new lanes remains absent. M1.5 remains the next repository-only roadmap milestone.

---

## What Works Today

- **Character library** — create, edit, import/export characters with archetypes, boundaries, and safe words
- **Multi-character sessions** — up to 12 participants, per-message speaker attribution, branching replies, swipes
- **AI-driven room turns** — model selects pertinent speakers (1–6), generates sequential replies with streaming
- **Auto follow-up** — 0–3 automatic follow-up rounds; stop control halts after the current turn
- **Private conversations** — durable one-character side-chat with independent history, shared memories/lore
- **Character memories** — manual creation, approval workflow, natural extraction, contextual cast capture
- **World lore** — global or character-scoped lore entries with keyword and always-on activation
- **Prompt studio** — 20 editable layers covering generation, routing, memory, lore, scene synthesis, and provider instructions
- **Scene context basket** — manual canon, synthesized scene facts, participants, recent events, memories, lore, open threads
- **Usage tracking** — lifetime token counts with operation/model/session breakdowns and USD cost estimates
- **Campaigns** — create campaigns, attach chat rooms, manage a character roster, roll dice with character bindings
- **Safe word detection** — built-in and custom per-character safe words close the session immediately

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Vite + React)               │
│                                                          │
│  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │  Characters  │  │   Sessions    │  │  Campaigns   │ │
│  │  & Library   │  │  & Chat UI    │  │  & Dice      │ │
│  └──────────────┘  └───────────────┘  └──────────────┘ │
│                          │                               │
│              client/src/api.ts (fetch + SSE)             │
└──────────────────────────┼──────────────────────────────┘
                           │ HTTP + SSE  (loopback only)
┌──────────────────────────▼──────────────────────────────┐
│                  Fastify Server  :8787                    │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │              server/src/app.ts                   │    │
│  │         (composition root, global hooks)         │    │
│  └──────┬──────────────┬──────────────┬────────────┘    │
│         │              │              │                   │
│  ┌──────▼──────┐ ┌─────▼─────┐ ┌────▼──────────────┐   │
│  │  /api/rpg   │ │  /api/*   │ │  generation SSE    │   │
│  │  v1 routes  │ │  legacy   │ │  & streaming       │   │
│  │  features   │ │  routes   │ │  interactions      │   │
│  └──────┬──────┘ └─────┬─────┘ └────────────────────┘   │
│         │              │                                  │
│  ┌──────▼──────────────▼──────────────────────────────┐  │
│  │              server/src/repo/                       │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │  │
│  │  │character │ │ session  │ │    campaign       │   │  │
│  │  │   Repo   │ │   Repo   │ │      Repo         │   │  │
│  │  └──────────┘ └──────────┘ └──────────────────┘   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐  │  │
│  │  │ message  │ │  memory  │ │   lore   │ │ dice │  │  │
│  │  │   Repo   │ │   Repo   │ │   Repo   │ │ Repo │  │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────┘  │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐           │  │
│  │  │settings  │ │ summary  │ │  db.ts   │           │  │
│  │  │   Repo   │ │   Repo   │ │(schema + │           │  │
│  │  └──────────┘ └──────────┘ │migrations│           │  │
│  │                             └──────────┘           │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                                │
│              SQLite  server/data/velvet.sqlite            │
└───────────────────────────────────────────────────────────┘
```

### Request Flow — Room Turn

```
User sends message
       │
       ▼
POST /api/interaction
       │
       ├─► routingRequest() → model selects speakers (1–6)
       │
       ├─► for each selected speaker:
       │       characterRequest() → streams reply via SSE
       │
       ├─► sceneRequest() → synthesizes updated scene facts
       │
       └─► addMessage() → persists final message + usage event
                │
                ▼
          SQLite (atomic transaction)
```

### Repository Layer

The repo layer is split into focused roleplay domains and factory-composed RPG facades at schema v24r1:

```
server/src/repo/
├── index.ts          ← public barrel (74 named exports, stable API surface)
├── db.ts             ← schema v24r1, migrations v1→v24, connection lifecycle
├── shared.ts         ← LOCAL_OWNER_PRINCIPAL_ID constant
├── repoContext.ts    ← provider-pattern DB singleton (configureRepositoryDatabase)
├── characterRepo.ts  ← characters CRUD, lore repair on delete
├── sessionRepo.ts    ← sessions, consent events, transitions, context sources
├── messageRepo.ts    ← messages, branch walking, swipes, usage events
├── memoryRepo.ts     ← memory facts, approval workflow, restore/forget
├── loreRepo.ts       ← lore entries, character-scoped and global
├── summaryRepo.ts    ← scene synthesis snapshots
├── settingsRepo.ts   ← harness and provider settings
├── diceRepo.ts       ← normalized dice audit, roll persistence
├── campaignRepo.ts   ← repository factory, campaigns, rooms, actors
├── campaignAdministrationRepo.ts ← lifecycle, membership, timelines, import/export
├── contentCatalogRepo.ts          ← immutable catalogs and campaign pins
├── characterBuilderRepo.ts        ← drafts, derived sheets, finalization
└── characterProgressionRepo.ts    ← XP/milestones, previews, level application
```

### Selected Schema Foundations (v24r1)

```
characters          sessions            messages
────────────        ────────────────    ────────────────────
id                  id                  id
name                title               session_id
age                 character_id        role
archetype           status              speaker_character_id
boundaries          active_leaf_id      content
safe_word           created_at          parent_id
fictional_confirmed                     swipe_group_id
is_real_person      session_characters  swipe_index
created_at          ────────────────    seq
                    session_id          status
                    character_id        usage_*
                                        created_at

memories            lore_entries        summaries
────────────────    ────────────────    ─────────────────
id                  id                  session_id
character_id        title               content
content             content             updated_at
status              scope
source              character_id        usage_events
created_at          keywords            ─────────────────
                    always_on           id
                                        session_id
campaigns           campaign_characters  kind
────────────────    ────────────────    prompt_tokens
id                  id                  completion_tokens
name                campaign_id         total_tokens
owner_id            character_id        usage_source
status              actor_role          usage_model
created_at          created_at          created_at
updated_at
                    dice_events         dice_terms
                    ────────────────    ────────────────
                    id                  id
                    campaign_id         dice_event_id
                    character_id        position
                    occurred_at         faces
                    revision            value
```

### Context Assembly

Every prompt is built from a priority-ordered context basket:

```
Priority  Layer                     Source
────────  ──────────────────────    ─────────────────────────────
  1       Safety / control          policy.ts (always-on)
  2       Manual canon              user-editable scene context
  3       Synthesized scene facts   model-generated, bounded
  4       Active participants       session_characters
  5       Recent events             last N messages
  6       Approved memories         memories WHERE status='approved'
  7       Active lore               lore_entries (keyword match + always_on)
  8       Open threads              derived from message history
  9       Prompt template layers    20 configurable harness layers
 10       Provider instructions     settings
```

---

## Campaign RPG Surface

The RPG layer is feature-gated and uses a fixed trusted-local `local-owner` principal. All 21 current operations run on loopback only and are **not safe for remote or multi-user deployment**.

### Current Campaign Operations

```
GET  /api/rpg/v1/campaigns                                        list campaigns
POST /api/rpg/v1/campaigns                                        create campaign
GET  /api/rpg/v1/campaigns/:id                                    campaign detail
PATCH /api/rpg/v1/campaigns/:id                                   rename campaign
PUT  /api/rpg/v1/campaigns/:id/starter-setup                      install starter content
PUT  /api/rpg/v1/campaigns/:id/mechanics-starter-setup            activate fixed mechanics catalog
GET  /api/rpg/v1/campaigns/:id/characters/creation-options        character creation options
GET  /api/rpg/v1/campaigns/:id/characters                         character roster
POST /api/rpg/v1/campaigns/:id/characters                         create campaign character
GET  /api/rpg/v1/campaigns/:id/characters/:charId/workspace       character workspace
GET  /api/rpg/v1/campaigns/:id/rooms                              list attached rooms
PUT  /api/rpg/v1/campaigns/:id/rooms                              attach room to campaign
GET  /api/rpg/v1/campaigns/:id/dice-rolls                         dice history
POST /api/rpg/v1/campaigns/:id/dice-rolls                         roll dice
POST /api/rpg/v1/campaigns/:id/character-drafts                   create character draft
GET  /api/rpg/v1/campaigns/:id/character-drafts/:draftId          read character draft
PATCH /api/rpg/v1/campaigns/:id/character-drafts/:draftId         update character draft
GET  /api/rpg/v1/campaigns/:id/characters/:charId/progression     read progression
POST /api/rpg/v1/campaigns/:id/characters/:charId/progression/preview  preview progression
GET  /api/rpg/v1/campaigns/:id/administration                     read administration
PATCH /api/rpg/v1/campaigns/:id/administration                   update administration
```

### RPG Roadmap (M1–M4)

The full 40-item roadmap lives in [`docs/ROADMAP.md`](docs/ROADMAP.md). High-level milestones:

```
M0  ████████████████████████████████  COMPLETE (98 slices, schema v14r1)
    Core roleplay, campaigns, dice, character workspace

M1  █████████████░░░░░░░░░░░░░░░░░░░  M1.1–M1.4 COMPLETE
     Repository/contracts complete; selected server-only HTTP lanes
     for drafts, progression read/preview, and administration (no UI)

M2  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  NOT STARTED
    API surface: 11 route groups covering all M1 domains

M3  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  NOT STARTED
    Client UI: character builder, combat tracker,
    inventory, world explorer, campaign play shell

M4  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  NOT STARTED
    AI integration: campaign-aware context, bounded tool
    loop, durable confirmation, receipt-aware narration,
    encounter and NPC generation
```

Minimum path to a playable D&D-style session: **M1.3 → M1.7, M2.6 → M2.9, M3.3 → M3.5, M3.7, M4.1 → M4.4** (17 of 40 items).

---

## Requirements

- Node.js 22+
- npm
- An OpenAI-compatible provider (optional — a local deterministic fallback is used if none is configured)

---

## Setup

```bash
npm install
cp .env.example .env
# Add your provider API key to .env if needed
```

Start both server and client:

```bash
set -a && source .env && set +a
npm run dev
```

| Service | URL |
|---|---|
| Client | http://localhost:5173 |
| Server | http://127.0.0.1:8787 |
| Health | http://127.0.0.1:8787/api/health |

The Vite dev server proxies `/api` to `VELVET_API_URL` (default: `http://localhost:8787`).

---

## Commands

```bash
npm run dev          # start server + client dev processes
npm run dev:server   # server only
npm run dev:client   # client only
npm run typecheck    # typecheck contracts, server, client, and E2E
npm run build        # production build (contracts → server → client)
npm test             # contracts + server + client tests (2,141 passing, 1 skipped)
npm run test:e2e     # deterministic browser/API E2E (no paid provider calls)
npm run ci           # install → typecheck → build → test
```

Install the Playwright browser once after `npm install`:

```bash
npx playwright install chromium
```

---

## Project Structure

```
packages/contracts/     shared Zod schemas and inferred API types (@velvet/contracts)
server/src/
  app.ts                Fastify composition root, global hooks, route registration
  routes/roleplay/      interaction, generation, session, memory, lore, settings routes
  routes/rpg/v1/        feature-gated RPG HTTP boundary (21 operations; new lanes server-only)
  repo/                 roleplay repositories, RPG facades, schema/migrations
  content/              original starter content pack and setup services
  context.ts            context basket assembly
  prompt.ts             prompt builder
  promptTemplates.ts    20-layer configurable harness
  llm.ts                provider abstraction (OpenAI-compatible)
  policy.ts             content policy stub (permissive; see Policy Status)
client/src/
  App.tsx               React router, layout, navigation
  api.ts                typed fetch + SSE client
  roleplay/             campaign library, detail, character workspace pages
  components/           shared UI components
e2e/                    Playwright deterministic and opt-in live workflows
docs/                   API reference, architecture, roadmap, streaming protocol
```

---

## Persistence

Data lives in `server/data/velvet.sqlite`. Override with `VELVET_DATA_DIR`.

- WAL mode, foreign keys enabled
- Schema **v24, revision 1** (current)
- Auto-migrates from v2 onward at startup
- v9–v14 add campaign, content, sheet, actor, command, resource, and dice foundations
- v15–v24 add administration, immutable catalogs, character building, progression, and integrity repairs

---

## End-to-End Tests

`npm run test:e2e` runs a real Fastify + Vite stack on dedicated loopback ports against a temporary SQLite database with a local fake provider. No paid API calls. Covers: startup, health, campaign CRUD, room attach/detach, character create, sessions, buffered + SSE turns, routing, continuation, memories, lore, safe-word closure, deletion ordering, and deterministic dice (exact `1d2+3` → total 5 proof).

Live provider tests (opt-in, paid):

```bash
VELVET_E2E_LIVE=1 npm run test:e2e:live
```

---

## Policy Status

`server/src/policy.ts` is a **permissive stub** — all character, message, and output checks return allowed. Safe-word detection (built-in: `red`, `safeword`, `stop`, `halt` plus custom per-character words) remains active independently of the policy stub. Do not describe this deployment as content-policy enforced.

---

## Documentation

| Doc | Description |
|---|---|
| [ROADMAP](docs/ROADMAP.md) | 40-item dependency-ordered RPG build plan |
| [API reference](docs/api.md) | All HTTP operations |
| [Architecture](docs/roleplay-architecture-2026.md) | Server design and context model |
| [Repository architecture](docs/repo-architecture.md) | Repo domain boundaries |
| [Streaming protocol](docs/streaming.md) | SSE event format |
| [Provider configuration](docs/provider-configuration.md) | API key, base URL, model settings |
| [Customizable harness](docs/customizable-harness.md) | 20-layer prompt studio guide |
| [Engineering handoff](HANDOFF.md) | Current state, last commits, next task |

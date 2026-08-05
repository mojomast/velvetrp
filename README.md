# Velvet MVP

Velvet is a local-first character roleplay application with persistent characters, conversations, memories, shared lore, branching replies, streaming, and multi-character sessions.

## Features

Exactly **98** M0 slices are complete at schema **v14 revision 1 (v14r1)**, and the feature-gated trusted-local campaign boundary remains exactly **13** HTTP operations. Slice 98 is documentation-only closeout and adds no feature. The final independent Slice 97 backend, client, and closeout reviews reported no findings after remediation. No next slice is approved; future work requires explicit scope.

Slice 97 hardens existing behavior without adding schema or operations. Workspace GET responses and exact malformed GET normalization now send `Cache-Control: no-store`, and the client requests workspaces with `cache: "no-store"`. Campaign-room hydration and restoration require the returned opaque session ID to equal the exact requested ID before navigation. Private-chat opening requires an exact solo binding and old-chat session updates require the current view, exact session identity, and chat-entry token, so late stop/room work cannot replace a newer private or ordinary entry. Save/save-and-start is operation- and navigation-epoch-bound across persistence, library refresh, session creation, and hydration; Cancel is disabled while busy. Ordinary resume is latest-intent-, request-sequence-, and navigation-epoch-bound. Create peers retain delayed-detail completion as before; dice peers now invalidate stale history immediately but retain completion without applying or cleaning it until exact matching detail is ready, including unmount/reopen and StrictMode replay. Deterministic E2E retains the aborted-response room reconciliation proof. Special-character opaque session paths remain covered in unit/integration tests because real server ID generation cannot practically produce those values. Slice 97 review and remediation are complete.

`GET /api/rpg/v1/campaigns/:campaignId/characters/:campaignCharacterId/workspace` uses fixed trusted-local `local-owner`, two strict IDs, no raw query, and one explicit-column SQLite statement. Intact owner/GM/player/observer memberships receive resolved persisted names/descriptions and ordered classes, attributes, proficiencies, choices, and resources. The same statement rejects campaign-attributable detached or mismatched sheet, actor, private-state ancestry, class, attribute, proficiency, choice, and actor-resource evidence, even beside one valid selected root, while corruption attributable only to another campaign does not poison a clean campaign. Arbitrary technical IDs are validated but replaced only by exact positional contract labels; no persisted identity, controller/private note, persona boundary/safe-word, audit, or command payload reaches the wire. Missing, denied, stale-owner, and cross-campaign targets share one non-disclosing character 404; attributable corruption is loud internally and redacted to a neutral 500.

The form displays only fixed read-only profile, pack, race, background, and level-1 class metadata and requires a visible single-use confirmation that the finalized record currently has no derived stats, rules validation, mutation/rebuild/reset controls, gameplay/mechanics, inventory/equipment, spells/powers, progression, or AI workflow. Persona order and duplicate names are preserved with `bdi dir="auto"`; visible nonprivate persona positions distinguish duplicate accessible names while closure/index controls keep opaque persona and campaign-character IDs out of text, values, attributes, ARIA, and URLs. Initial options failures, including 404, remain local with GET-only retry.

Create joins the exact campaign/token mutation guard used by rename/setup, including synchronous duplicate locking across unmount/reopen and campaign switches. Every issued POST outcome causes exactly one operation-owned fresh roster/options pair and never a POST retry. A completed snapshot is a single-use interim handoff; reopen then issues exactly one fresh authoritative pair and recomputes the outcome, so newer absent/unused state or read failures clear stale success/currently-present claims. Setup completion immediately advances the campaign's options generation, removes reusable pre-commit options, and clears stale form/error state. Its campaign-scoped refresh intent survives unmount, A→B→A, failed detail reconciliation, and later detail Retry generations; only a current exact-starter detail success consumes it by starting one fresh uncached options GET. Options Retry has campaign/generation-scoped focus, visible polite progress/success, heading focus on success, and Retry restoration on failure without stale focus theft.

Historical Slice 88 review found five bounded groups covering roster owner integrity, completed-create reopen outcomes, setup options invalidation, Options Retry accessibility/focus, and documentation drift. Its follow-up client review found two additional ordering/ownership defects. Those historical findings were remediated and the Slice 88 reviews reported no remaining findings. Slice 97 has now independently completed its own review and remediation cycle with no backend, client, or closeout findings.

Slice 94 changes only client/UI, isolated deterministic E2E runtime/configuration/flow, tests, and documentation. Mechanics discovery remains independent from legacy startup. Technical campaign-character/actor/audit/write identities never enter dice DOM, values, ARIA, URLs, or errors; duplicate names are distinguished by visible position. Every issued roll outcome performs exactly one uncached history GET and never retries POST. Network, 500, malformed success, and other untyped outcomes remain explicitly unknown regardless of identical identity-free history projections. Exact typed binding-conflict 409 and unavailable 404 responses are known non-commits with distinct messages. Outcome status and a GET-only **Refresh rolls** action persist when history fails; later refreshes recompute wording without issuing or suggesting a repeated POST. A synchronous shared ref lock limits rapid pointer or keyboard activation of manual history Retry and Refresh to one GET until settlement; initial and reconciliation reads remain independent, and stale/focus guards remain intact. E2E injects a reviewed fixed RNG only into its disposable repository, asserts exact `1d2+3` term 2/total 5 and identical reload rendering, and counts one POST plus reconciliation/reload GETs. Production RNG defaults, schema, dependencies, server/contracts, HTTP semantics, and operation count are unchanged; `docs/api.md` records current client consumption only.

Slice 94 finding remediation verification passed the contracts build; 42 focused client tests across 2 files; all 179 client tests across 8 files; root contracts/server/client/E2E typecheck; production build with 133 Vite modules; and the single deterministic Playwright browser/API workflow. That E2E inventory covers the existing critical application flow plus exact deterministic dice output, one roll POST, its reconciliation GET, persisted identical reload rendering, and the reload history GET. Live E2E and full server tests were not requested or run; no commit was created.

Slice 96 changes client/API/navigation/UI tests, deterministic E2E coverage, and documentation only. It adds no server, contract, schema/migration, detach route, remote authentication, room content/messages/context, chat behavior, automatic PUT retry, operation, or dependency.

Slice 96 final finding-remediation verification passed 180 focused client tests across 5 files, all 207 client tests across 8 files, the contracts build, root contracts/server/client/E2E typecheck, the production build with 133 Vite modules, and the deterministic Playwright workflow. The latest unchanged full-suite baseline remains 126 contract tests and 1,641 server tests plus 1 skip across 72 files. No server, contract, schema, dependency, devplan, or commit changed.

Slice 98 ran the closeout gate in exact order: `npm run typecheck` passed; `npm run build` passed with 133 Vite modules; `npm test` passed with contracts 126 across 10 files, server 1,641 passed plus 1 skipped across 72 files, and client 226 across 8 files, totaling 1,993 passed plus 1 skipped; `npm run test:e2e` passed 1, for a deterministic total of 1,994 passed plus 1 skipped. Live E2E was not run. This closeout changed documentation only: no feature, code, test, contract, route, operation, schema, migration, dependency, database backup, or commit was added. Existing production online-backup/restore guidance and historical slice/gate ledgers are preserved.

Historical Slice 84 checkpoint (superseded by the status above):

Exactly 84 M0 slices are complete; schema v14 revision 1 and the seven-operation HTTP boundary are unchanged. Slice 84 keeps generic factory-only `createCampaignCharacter` compatible with arbitrary valid pinned content. Under `BEGIN IMMEDIATE`, generic creation validates every requested race/background/class/choice definition, including metadata corruption, before it may classify a complete duplicate. A separate factory-only `createOriginalStarterCampaignCharacter` entry reuses that atomic helper but additionally requires the exact selected original profile, sole exact pin, sealed profile/pack metadata, complete reserved namespace, fixed controller/content/empty arrays, and null notes under the same lock. Preflight remains the selection/status check. The specialized locked entry returns internally both the validated privileged projection and the current safe bounded persona display name from that same immediate transaction; the service invokes it once and returns only strict `{ character: { id, characterId, name } }` using that locked current name, with no post-write read or retry. Generic creation's public repository return remains unchanged. Valid post-preflight starter drift, including persona rename and removal of the sole pin to the contract-valid zero-pin state, is handled from locked state; starter drift is a typed conflict before generic missing-pin handling, while name/content corruption stays untyped with no aggregate write. Specialized creation intentionally uses existing parent-backed campaign owner/GM creation authority: `local-owner` may be a campaign GM and controller, while application ownership is distinct and supplies neither a required bypass nor a dual-authority gate. Starter setup retains its separate dual-authority policy. Stale owner state without GM authority remains unavailable, and an attributable GM sees malformed owner graphs as untyped failures. Shared private-note contracts reject lone/unpaired UTF-16 surrogates before writes while preserving 4,000 astral code points. There is no route, client, UI, schema, migration, or new HTTP operation. Slice 85 is next and unimplemented.

Final Slice 84 findings verification built contracts, passed all 103 contract tests and 233 focused server repository/service/options/starter/role-sensitive/route tests across eight files, and passed server source/test typecheck plus production build. This record is historical.

Historical Slice 82 checkpoint (superseded by the status above):

Exactly 82 M0 slices are complete at an HTTP read checkpoint; schema v14 revision 1 is unchanged. Slice 82 adds only feature-gated trusted-local `GET /api/rpg/v1/campaigns/:campaignId/characters/creation-options` over Slice 81's bounded synchronous repository read and Slice 80's strict response contract. It accepts one strict 1–128 character campaign resource ID and no query, delegates only as fixed `local-owner`, applies the repository's owner/GM creation authority, path-binds strict output, and returns ordered safe persona summaries plus exact basic finalized starter metadata. Literal repository `null` alone is a non-disclosing campaign 404; repository-open, repository, every malformed output (including other falsey values), and wrong-path-output failures are request-correlated redacted 500s. Structured problem instances are always path-only. Malformed/overlong exact campaign resource requests preserve feature denial first; supported methods otherwise reject any raw query delimiter, including a bare trailing `?`, before path failure, while unsupported methods remain absent as `RPG_ROUTE_NOT_FOUND`, all without repository access or query reflection. Unknown, legacy, and lookalike fallbacks retain their prior body/status/code shape with query-free messages. Production request logging remains enabled but serializes only method and query-free path, never request headers or the top-level request ID binding. The authoritative global router cap remains 128 for strict RPG IDs; its already-approved compatibility effect is that legacy route parameters of length 101–128 reach their handlers rather than Fastify's over-cap response. HEAD and other methods remain absent. Slice 82 adds no service, list/create route, client, UI, schema, migration, write, gameplay, or automatic installation. Contracts were built first; the final focused gate passed 123 tests across five files (111 combined campaign tests, including the 21 dedicated creation-options tests, plus 12 security/problem/fallback tests), and server typecheck/build passed. Slice 83 is next and unimplemented.

The owner-only original-starter setup UI requires explicit confirmation; non-owners and configured campaigns receive no setup mutation. A shared in-flight guard blocks in-app navigation and duplicate setup/rename/create writes while pending. Setup remains two convergent transactions. Slice 87 adds only the fixed finalized metadata-only character create form; it adds no character editing, deletion, rebuild/reset, derived rules, mechanics, gameplay, inventory, equipment, spells, powers, progression, or AI workflow.

- Persistent character library with edit, JSON import/export, and guarded deletion
- Resumable single- and multi-character sessions
- Persistent private agent conversations opened directly from a room
- Per-message speaker attribution and target-speaker selection
- Model-directed room messages with up to six pertinent, sequential character replies
- Optional bounded automatic room conversation with 0-3 follow-up rounds and stop control
- Progressive room delivery and stable per-character bubble colors
- Viewport application shell with a resizable prompt/settings pane
- Editable 20-layer prompt studio covering character generation, routing, room turns, continuation, memory, lore, provider instructions, and factual scene synthesis
- Visible shared context basket with highest-priority manual canon, synthesized current scene facts, participants, recent events, approved memories, active lore, and open threads
- Natural action-beat guidance that reduces repetitive “I” openings and improves cross-character awareness
- One-turn character-to-character continuation
- Character memories with manual creation, editing, approval, forgetting, and restoration
- Immediately active explicit memories, pending natural preference extraction, and contextual cast-detail capture
- Global or selected-character lore with keyword and always-on activation
- Buffered and SSE-streamed generation, cancellation, swipes, and branches
- Configurable OpenAI-compatible provider and prompt harness
- Append-only lifetime provider-usage tracking with operation/model/session breakdowns and configurable input/output USD-per-million pricing
- Local SQLite storage with automatic schema migrations

RPG integration is opt-in and remains primarily a schema/repository foundation. Its RPG-facing UI is the feature-gated **Campaigns** library and campaign detail view, including the names-only roster and fixed finalized metadata-only starter character flow. Exactly 13 campaign operations are exposed: collection `GET` and `POST`; detail `GET` and `PATCH`; room-linking `GET` and `PUT`; starter-setup `PUT`; campaign-character creation-options `GET`; safe roster `GET`; fixed original-starter character `POST`; campaign-character workspace `GET`; and campaign dice history `GET` plus roll `POST`. Dice requires both campaign and mechanics flags. All HTTP operations use unauthenticated trusted-local `local-owner`, ignore spoofed identity headers, and are unsafe for remote or multi-user exposure; trusted local is not authentication.

The delivered campaign surface includes a read-only campaign-character workspace, deterministic dice with bounded newest-first recent history, and room linking with campaign-to-chat opening and authoritative campaign return. Unexpected dice POST or room-linking PUT failures are commit-ambiguous: refresh the corresponding authoritative history or room-linking GET and never retry the mutation automatically.

Campaign dice exposes only contiguous one-based `{ position, name }` character bindings and at most 20 newest-first `{ character, occurredAt, result }` rolls. Newest-first means returned array order by descending revision/event identity; `occurredAt` is canonical informational data and may regress or repeat. The fixed bounded query selects the latest 20 dice identities before joining at most 100 terms each while validating complete audit history and attributable orphans outside the window. Roll preflight resolves owner/GM authority, active timeline revision, exact current position/name, campaign-character ancestry, and internal actor ID in one closed snapshot. One separately generated internal command/idempotency identity drives exactly one specialized execution, which revalidates the ordered roster binding and ancestry under the same immediate write lock before RNG, event identity, clock, or persistence. The UI provides canonical-expression roll and history controls, while technical IDs, revisions, checks/DCs, narration, caller idempotency, and automatic retries remain excluded. An unexpected roll 500 is commit-ambiguous: refresh authoritative dice history and never retry automatically.

Campaign-character POST has no idempotency contract or automatic retry. An unexpected 500 is commit-ambiguous and requires authoritative roster plus creation-options GET reconciliation before any user-directed next action; it must never trigger an automatic POST retry.

The provenance review does not claim the starter names are unique. Its limited similarity review retains the exact queries and summarized observations, not exact search results: no result URLs, ordering, provider, region, or review time were retained, so result pages are not independently reproducible. It is not legal or trademark clearance. The concepts and wording were originally authored for Velvet, but the repository grants no distribution license; treat them as internal local material. The immutable pack version includes the canonical versionless-manifest checksum prefix, and tests require a content change to use a different identity.

## Requirements

- Node.js 22 or a compatible current Node.js release
- npm
- An OpenAI-compatible provider is optional; without one, the server uses its local deterministic fallback

## Setup

```bash
npm install
cp .env.example .env
```

Add a provider key to `.env` if required, then load it and start both applications:

```bash
set -a
source .env
set +a
npm run dev
```

- Client: `http://localhost:5173`
- Server: `http://127.0.0.1:8787`
- Health check: `GET http://127.0.0.1:8787/api/health`

The Vite development server proxies `/api` to `VELVET_API_URL`, defaulting to `http://localhost:8787`.

## Commands

```bash
npm run dev          # start server and client development processes
npm run dev:server   # start only the Fastify server
npm run dev:client   # start only the Vite client
npm run typecheck    # build/typecheck contracts; typecheck server, client, and E2E
npm run build        # build contracts, server, and production client
npm test             # run contracts, server, and client tests
npm run test:e2e     # deterministic browser/API E2E; no paid provider calls
npm run ci           # install, typecheck, build, and test
```

Install the Playwright browser once after dependency installation:

```bash
npx playwright install chromium
```

## End-to-End Tests

`npm run test:e2e` starts the real Fastify and Vite development processes on dedicated loopback ports. It uses a temporary SQLite directory and a local OpenAI-compatible fake provider, then removes the directory when the processes stop. The committed-response-loss inventory includes a real room PUT committed through Fastify/SQLite with only browser response delivery aborted, followed by exactly one reconciliation GET, attached state, and no repeated PUT. The suite also covers startup and health, provider API redaction, campaign create/open/rename/confirmed starter setup, exact room GET counts after ordinary attach and both campaign returns (including chat reload), one-PUT/one-GET foreign-attachment conflict reconciliation with no retry, stopped-candidate 409, attached-room deletion cascade, one finalized campaign-character create with reload/no-duplicate proof, browser character create/edit/reload, single- and multi-character sessions, buffered and SSE turns, targeted turns, room-turn routing with deterministic fallback, character-to-character reply chaining, continuation, prompt-template override/reset, combined manual/synthesized context, persisted resume state, memories, global and scoped lore, safe-word closure, closed-session rejection, and deletion ordering. The linked starter persona is intentionally left to temporary-database disposal because the campaign-character reference correctly guards legacy deletion.

Live provider coverage is separately opt-in and is never part of the paid-call path in ordinary CI:

```bash
VELVET_E2E_LIVE=1 npm run test:e2e:live
```

The live suite makes a SQLite online backup of `server/data/velvet.sqlite` (override with `VELVET_E2E_SOURCE_DATA_DIR`) into a private temporary directory. It starts the server against that clone, verifies `GET /api/provider` exposes `hasApiKey` but no key, creates uniquely named disposable records, and cleans them up. The source database and its provider/model configuration are never written. In the clone only, reasoning is disabled and `maxTokens` is temporarily capped at 96, with both values restored after at most twelve provider calls covering buffered and streamed replies, room turn and continuation routing/replies, and four scene-synthesis updates. It also verifies synthesized context and lifetime usage through `GET /api/usage`. If `VELVET_E2E_LIVE` is absent the suite skips; if the public provider API reports no key, the live assertion also skips cleanly.

Never add request-header logging, provider payload snapshots, traces containing settings writes, or assertions that print credentials. E2E failures may retain a deterministic trace, but live tracing is disabled.

## Persistence

The server stores data in `server/data/velvet.sqlite` when started through the root scripts. Set `VELVET_DATA_DIR` to use another directory. SQLite runs in WAL mode with foreign keys enabled.

Current schema version: `14`, revision `1`.

The root npm workspace includes `server`, `client`, and `packages/contracts`. `npm install` at the repository root installs all three; root build, typecheck, and test commands build and verify the shared runtime contracts before their consumers.

Existing v2-v13 databases migrate sequentially at startup, including explicit same-version corrective revisions where supported. V5 adds session participants, character speaker attribution, and many-to-many lore scopes; v6 adds editable authoritative scene context; v7 adds synthesized factual scene state; v8 adds the append-only usage ledger; v9-v11 add the internal RPG campaign, sealed-content, sheet, and actor foundations; v12 adds the bounded command/audit foundation; v13 adds minimal actor-resource state; and v14 adds normalized dice audit persistence. These RPG migrations create no implicit campaigns, sheets, resources, or dice records. A retired `db.json` store is imported once when the SQLite database is empty.

Each chat's authoritative scene combines editable manual canon with a model-synthesized factual snapshot of the active message branch. Manual canon wins conflicts. When a usable provider is configured, one bounded synthesis call after each completed turn or room round carries forward valid facts, applies confirmed changes, and removes stale conditions without copying dialogue into the scene state.

The v8 usage migration backfills historical character-reply usage. Room-routing and scene-synthesis calls are tracked from v8 onward because older auxiliary calls were not persisted and cannot be reconstructed. Cost figures use the configured token rates and are estimates rather than provider invoices.

Character profiles are durable current profiles rather than per-session snapshots. Editing a character changes the profile used when old sessions are resumed. A character cannot be deleted while any session or campaign character references it; remove those references first.

## User Workflow

1. Create or import characters in the library.
2. Select up to 12 participants and choose a primary character.
3. Start a session or resume an existing one.
4. Select the target speaker before sending a message.
5. In a group scene, choose **Max room responders** from 1-6 and use **Send to room**. The model still selects only pertinent speakers unless the message explicitly addresses everyone. Replies appear individually as each character finishes.
6. Choose 0-3 **Auto follow-up rounds** to let the characters continue talking without another user message. **Stop auto chat** prevents the next round after the current bounded turn finishes. The UI displays the maximum provider-call budget before sending.
7. Click **Give room another turn** for one manually requested bounded exchange without adding a user message.
8. Select a room participant and click **Private chat with...** to open or resume that agent's durable one-character conversation. Private history is independent from the room, while character memories and lore remain shared.
9. Open **Prompt & settings** to resize the workspace, edit any of the 20 prompt layers, adjust harness/provider controls, and configure input/output USD-per-million token prices.
10. Expand **Overall usage & estimated cost** to inspect lifetime prompt/completion totals, tracked calls, measured/estimated tokens, and operation/model/session breakdowns. The header separately reports active-branch message tokens.
11. Expand **Shared context basket** to inspect editable manual canon, synthesized current facts, cast, recent events, memories, lore, and open threads.
12. Use **Continue as...** to generate one character turn without adding a user message.
13. Manage approved and pending memories from each character card.
14. Use **World lore** for global or selected-character lore entries.

Session participants are fixed after creation. With a usable provider, each room round uses one routing request, at most six character generations, and one bounded scene-synthesis request. Without one, routing falls back deterministically and no synthesis call is made. Autoplay is explicitly capped at three additional rounds; it never starts an unbounded dialogue loop. At maximum configured-provider settings, one room message can make up to 32 provider calls, so lower responder/round limits are recommended for paid models.

“Private” means a separate persisted one-character session and message history. Velvet still has no authentication or multi-user authorization model.

## Policy Status

`server/src/policy.ts` currently contains an intentionally permissive compatibility stub: character, user-message, and assistant-output checks always return allowed. The previous restrictive implementation is preserved at `server/src/policy.ts.backup`.

Safe-word detection remains active for built-in words (`red`, `safeword`, `stop`, `halt`) and every participant's custom safe word. Input sanitization, control-character removal, and the 1,000-character user-message cap also remain active. Do not describe the current deployment as content-policy enforced unless the restrictive implementation or another enforcement layer is restored.

## Documentation

- [RPG integration plan](docs/rpg-integration-plan.md)
- [API reference](docs/api.md)
- [Architecture](docs/roleplay-architecture-2026.md)
- [Streaming protocol](docs/streaming.md)
- [Provider configuration](docs/provider-configuration.md)
- [Customizable harness](docs/customizable-harness.md)
- [Engineering handoff](HANDOFF.md)

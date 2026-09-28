# Playtest world: The Hollowford Reach

Status: current. A provider-free, deterministic seed world for unlimited live roleplay and
evaluation passes, with a documented launcher for local servers.

The world replaces the thin `dmFixture` (which min-rolled dice and carried no GM scene
bindings) with a coherent dnd-5e / SRD 5.1 frontier that has real accepted public canon,
a designated starting location, a leveled party, NPC presence, quests, rumors, a vendor,
and one hostile encounter anchor.

## Why it exists

Live passes need a stable world that survives across restarts, exercises the free-form
materialization lanes (travel, NPC, quest, rumor, faction, shop), and can be rebuilt from
committed source at any time. The world is composed through the ordinary accepted-artifact
pipeline (`campaign_generation_accepted_artifacts_v52`) but is applied with static reviewed
content and `provider: "reviewed-static-seed"`, so **no model provider is called** when
building it.

## Source of truth

| Concern | File |
| --- | --- |
| Reviewed world content (10 locations, reciprocal routes, 3 factions, 10 NPCs, 5 quests, 2 encounters, clues, rumors, story, handouts, scenes) | [`server/test/fixtures/playtestWorldContent.ts`](../server/test/fixtures/playtestWorldContent.ts) |
| Provider-free builder + read-back summary | [`server/test/fixtures/playtestWorld.ts`](../server/test/fixtures/playtestWorld.ts) |
| Shape test | [`server/test/playtest-world.test.ts`](../server/test/playtest-world.test.ts) |
| Launcher | [`scripts/playtest-world.ts`](../scripts/playtest-world.ts) |

The builder mirrors the reviewed seed pattern used by
[`scripts/recipes/`](../scripts/recipes/): static content is staged as one content-pack draft
and applied atomically, then its starting location is auto-designated from the outline.

## World shape

- **Locations (10, all public, each with an accepted public `location` artifact):**
  Hollowford Village (start), The Market Cross, The Old Mill, Stonebridge, Warden's Tower,
  The Whispering Wood, The Salt Marsh, The Ruined Chapel, The Cinder Camp (encounter anchor),
  Greyvein Mine.
- **Connections:** 10 undirected pairs, both directions emitted as open public routes (20
  directed edges), forming one connected graph for two-way travel.
- **Factions (3, public):** Hollowford Council, River Traders' League, The Hollow Wardens.
- **NPCs (10, public, each bound to a location):** Mayor Edda Fenn, Bran Ironhand (vendor),
  Mara Voss, Nia Willow, Tom Barley, Kael Thorn, Orin Vale, Pell Marsh, Sister Anabel,
  Gregor Stone. Presence is seeded for four of them; two carry a relationship delta.
- **Quests (5, public, with objectives and rewards):** Break the Cinder Camp, The Missing
  Miners, The Mill's Restless Wheel, Trouble on the River Road, The Chapel Relic.
- **Rumors:** 5 public `lore` rumors plus 6 public clues (the free-form rumor lane reads
  `clue`/`lore`). One additional public `lore` notice is created when the vendor shop is
  materialized.
- **Vendor:** a deterministic server-authored shop (`materializeFreeformShop`) bound to
  Bran Ironhand with 8 stock lines drawn from the pinned SRD 5.1 item catalog.
- **Encounter anchor:** a public encounter at The Cinder Camp with an exact pinned
  `srd-5.1:enemy-template:goblin` reference. A second GM-only wood encounter pins
  `srd-5.1:enemy-template:wolf`.
- **Party:** 3 finalized SRD 5.1 level-one characters (Tamsin Rook, Halvard Grim, Ysolde
  Fen), each with a durable campaign sheet, all placed at the starting location.
- **Room/campaign:** one active attached room, campaign `published`, DM mode `ai`.

## Build and launch

Build the world without starting a server (writes to an empty `VELVET_DATA_DIR`):

```bash
npx tsx scripts/playtest-world.ts --data-dir /tmp/velvet-playtest --no-serve
```

Build and serve it for live runs:

```bash
# Optional: configure a provider for live AI DM beats. The seed itself needs none.
export OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
export OPENROUTER_MODEL=deepseek/deepseek-v4-flash
export OPENROUTER_API_KEY=...

npx tsx scripts/playtest-world.ts --data-dir /tmp/velvet-playtest --host 127.0.0.1 --port 8799
```

The launcher starts `npm run dev:server` with exactly:

```
VELVET_DATA_DIR=<data-dir>
HOST=127.0.0.1
PORT=8799
FEATURE_RPG_CAMPAIGN=true
FEATURE_RPG_MECHANICS=true
FEATURE_RPG_COMBAT=true
FEATURE_RPG_STUDIO=true
```

Provider credentials are inherited from the environment; the server never calls a provider
until a live DM beat runs, and `FEATURE_SYSTEM_ONE` stays off unless you opt in.

Read the existing world back without writing:

```bash
npx tsx scripts/playtest-world.ts --data-dir /tmp/velvet-playtest --validate-only
```

The fixture refuses to overwrite a directory that already contains a different campaign.
Delete the data directory (development storage is disposable) to rebuild from scratch.

## Validate

```bash
npm run test --workspace velvet-mvp-server -- test/playtest-world.test.ts
```

The test asserts: campaign published, DM mode `ai`, one active room, 2-4 finalized party
sheets, a public accepted artifact and public `campaign_locations_v28` row for every required
location, reciprocal open public connections for every intended pair, a designated starting
location matching the outline, public factions/NPCs-with-locations/quests-with-objectives/
rumors, an encounter anchor with a pinned hostile, a stocked vendor bound to the smith, party
placement on a public-artifact-backed location, and presence/relationship coverage.

## Optional live additions

- **Region pack (provider-backed).** `POST /api/rpg/v1/campaigns/:campaignId/region-packs`
  grows the same campaign from a single anchored request. Pass `anchorLocationKey` once a
  start is designated (this world always has one, so use `loc-hollowford`). It calls a
  provider, so it is not part of the provider-free seed and its quality depends on provider
  key-adherence; the static world already satisfies the free-form prerequisites on its own.
- **Tactical map.** The Cinder Camp is the intended combat location for a local tactical map.
- **Scene images.** The scene-image backend previously answered `502`; it is disabled unless
  `VELVET_SCENE_IMAGES_*` is configured. Nothing in this world depends on it.

## Gaps and notes

- Live generation quality is not guaranteed. Build the provider-free seed for deterministic
  passes; use region packs or DM beats only when you accept provider key-adherence risk.
- The smoke server reported `/api/features` `{"voice":false,"images":false}` and no configured
  scene-image base URL, so no image backend was exercised.
- The fixture writes only into the target `VELVET_DATA_DIR`; it never touches an existing
  campaign and never runs SQL migrations against an unknown schema.

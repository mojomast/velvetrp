#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { generatedCampaignContentProviderSchema, type GeneratedCampaignContentProvider } from "@velvet/contracts";
import { createRepository } from "../server/src/repo/index.js";
import { ensureCurrentSchema } from "../server/src/repo/db/schema.js";

const OWNER = "local-owner";
const VERSION = "baie-comeau-realism-2026-10-03-v3";
const CONTENT_PATH = new URL("./recipes/baie-comeau-realism.json", import.meta.url);
type Source = { title: string; url: string };
type Sourced = { sources: string[] };
type Enrichment = {
  version: string;
  sources: Record<string, Source>;
  locations: Array<GeneratedCampaignContentProvider["locations"][number] & Sourced>;
  connections: Array<GeneratedCampaignContentProvider["connections"][number] & Sourced>;
  lore: Array<GeneratedCampaignContentProvider["lore"][number] & Sourced>;
  handouts: Array<GeneratedCampaignContentProvider["handouts"][number] & Sourced>;
  annotations: Array<{ artifactKey: string; name: string; note: string }>;
  routePairs: Array<{ key: string; from: string; to: string; description: string; sources: string[] }>;
  closedRoutes: string[];
  routeEventProfiles: Array<{ key: string; environment: "urban" | "road" | "wilderness" | "water"; risk: "safe" | "watched" | "dangerous"; chancePercent: number }>;
};

function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function chunk<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

/** Reviewed content is additive; existing artifact keys remain immutable. */
function content() {
  const data = JSON.parse(readFileSync(CONTENT_PATH, "utf8")) as Enrichment;
  assert.equal(data.version, VERSION);
  data.connections = [...data.connections, ...data.routePairs.flatMap(route => [
    { key: `${route.key}-out`, fromLocationKey: route.from, toLocationKey: route.to, description: route.description, visibility: "public" as const, sources: route.sources },
    { key: `${route.key}-back`, fromLocationKey: route.to, toLocationKey: route.from, description: route.description, visibility: "public" as const, sources: route.sources },
  ])];
  const profiledKeys = new Set<string>();
  for (const profile of data.routeEventProfiles) {
    assert.ok(!profiledKeys.has(profile.key), `duplicate travel profile: ${profile.key}`);
    profiledKeys.add(profile.key);
    assert.ok(data.connections.some(connection => connection.key === profile.key || connection.key === `${profile.key}-out`), `unknown travel profile: ${profile.key}`);
    assert.ok(["urban", "road", "wilderness", "water"].includes(profile.environment));
    assert.ok(["safe", "watched", "dangerous"].includes(profile.risk));
    assert.ok(Number.isInteger(profile.chancePercent) && profile.chancePercent >= 0 && profile.chancePercent <= 100);
  }
  const keys = new Set<string>();
  const strip = <T extends { key: string } & Sourced>(values: T[]) => values.map(({ sources, ...value }) => {
    assert.ok(!keys.has(value.key), `duplicate key: ${value.key}`); keys.add(value.key);
    assert.ok(sources.length > 0, `missing sources: ${value.key}`);
    for (const source of sources) assert.ok(data.sources[source]?.url.startsWith("https://"), `unknown source: ${source}`);
    return value;
  });
  const citations = (sources: string[]) => sources.map(key => `${data.sources[key]!.title}: ${data.sources[key]!.url}`);
  const locations = strip(data.locations).map((value, index) => ({ ...value,
    description: `${value.description}\n\nSources: ${citations(data.locations[index]!.sources).join("; ")}` }));
  const connections = strip(data.connections);
  const lore = strip(data.lore).map((value, index) => ({ ...value,
    details: [...value.details, ...citations(data.lore[index]!.sources).map(citation => `Source: ${citation}`)] }));
  const handouts = strip(data.handouts).map((value, index) => ({ ...value,
    content: `${value.content}\n\nSources:\n${citations(data.handouts[index]!.sources).join("\n")}` }));
  const waves = [
    ...chunk(locations, 16).map(locations => generatedCampaignContentProviderSchema.parse({ locations })),
    ...chunk(connections, 24).map(connections => generatedCampaignContentProviderSchema.parse({ connections })),
    generatedCampaignContentProviderSchema.parse({ lore, handouts }),
  ];
  return { data, waves };
}

function partySnapshot(db: Database.Database, campaignId: string, sessionId: string) {
  return JSON.stringify({
    actors: db.prepare("SELECT * FROM campaign_actors WHERE campaign_id=? ORDER BY id").all(campaignId),
    resources: db.prepare("SELECT * FROM rpg_actor_resources WHERE campaign_id=? ORDER BY actor_id,name").all(campaignId),
    inventory: db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE campaign_id=? ORDER BY entry_id").all(campaignId),
    positions: db.prepare("SELECT * FROM campaign_actor_locations_v28 WHERE campaign_id=? ORDER BY actor_id,session_id").all(campaignId),
    participants: db.prepare("SELECT * FROM session_characters WHERE session_id=? ORDER BY position").all(sessionId),
    effects: db.prepare("SELECT * FROM rpg_active_effects_v26 WHERE campaign_id=? ORDER BY effect_id").all(campaignId),
  });
}

export async function enrichBaieComeau(options: { dataDir: string; campaignId: string; sessionId: string; validateOnly?: boolean }) {
  const { data, waves } = content();
  const databasePath = path.join(path.resolve(options.dataDir), "velvet.sqlite");
  assert.ok(existsSync(databasePath), "Select the existing Baie-Comeau demo database.");
  const db = new Database(databasePath, { fileMustExist: true });
  db.pragma("foreign_keys = ON");
  ensureCurrentSchema(db, databasePath);
  const before = partySnapshot(db, options.campaignId, options.sessionId);
  const locationArtifact = db.prepare("SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_key=? AND artifact_kind='location'");
  const existing = db.prepare("SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=?")
    .all(options.campaignId) as Array<{ artifact_key: string }>;
  const known = new Set(existing.map(row => row.artifact_key));
  assert.ok(known.has("ninth-current-opening") && known.has("loc-place-lasalle"), "The selected campaign is not the Baie-Comeau Ninth Current world.");
  assert.ok(db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(options.campaignId, options.sessionId), "The room is not attached to this campaign.");
  assert.equal((db.pragma("quick_check") as Array<{ quick_check: string }>)[0]?.quick_check, "ok");
  assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
  for (const wave of waves) {
    const all = [...wave.locations, ...wave.connections, ...wave.lore, ...wave.handouts];
    const resolved = new Set([...known, ...all.map(value => value.key)]);
    for (const connection of wave.connections) {
      assert.ok(resolved.has(connection.fromLocationKey) && resolved.has(connection.toLocationKey), `unresolved route: ${connection.key}`);
      assert.notEqual(connection.fromLocationKey, connection.toLocationKey);
    }
    for (const lore of wave.lore) for (const key of lore.locationKeys) assert.ok(resolved.has(key), `unresolved lore: ${key}`);
    all.forEach(value => known.add(value.key));
  }
  const backupDir = path.join(path.resolve(options.dataDir), "world-enrichment-backups");
  let repository: ReturnType<typeof createRepository> | undefined;
  try {
    if (!options.validateOnly) {
      mkdirSync(backupDir, { recursive: true });
      await db.backup(path.join(backupDir, `before-${VERSION}-${Date.now()}.sqlite`));
    }
    repository = createRepository({ dataDir: options.dataDir });
    const administration = repository.getCampaignAdministration(OWNER, options.campaignId);
    assert.ok(administration && (administration.actorRole === "owner" || administration.actorRole === "gm"));
    for (const [index, authoredWave] of waves.entries()) {
      const accepted = db.prepare("SELECT artifact_key,canonical_json FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=?")
        .all(options.campaignId) as Array<{ artifact_key: string; canonical_json: string }>;
      const byKey = new Map(accepted.map(row => [row.artifact_key, row.canonical_json]));
      for (const value of [...authoredWave.locations, ...authoredWave.connections, ...authoredWave.lore, ...authoredWave.handouts]) {
        if (byKey.has(value.key)) {
          assert.deepEqual(JSON.parse(byKey.get(value.key)!), value, `accepted content differs: ${value.key}`);
        }
      }
      const wave = generatedCampaignContentProviderSchema.parse({
        locations: authoredWave.locations.filter(value => !byKey.has(value.key)),
        connections: authoredWave.connections.filter(value => !byKey.has(value.key)),
        lore: authoredWave.lore.filter(value => !byKey.has(value.key)),
        handouts: authoredWave.handouts.filter(value => !byKey.has(value.key)),
      });
      const selected = [...wave.locations, ...wave.connections, ...wave.lore, ...wave.handouts].map(value => value.key);
      if (selected.length === 0) continue;
      assert.ok(!options.validateOnly, `Wave ${index + 1} has not been applied.`);
      const context = repository.getCampaignGenerationContext(OWNER, options.campaignId, [])!;
      const current = repository.getCampaignAdministration(OWNER, options.campaignId)!;
      const idempotencyKey = `${VERSION}.wave.${index + 1}`;
      const requestDigest = digest({ version: VERSION, wave });
      const call = repository.beginCampaignGenerationCall(options.campaignId, idempotencyKey, requestDigest, {
        provider: "reviewed-public-source-research", model: "none", operation: "campaign-content-generation",
        stage: `realism-wave-${index + 1}`, promptVersion: VERSION, schemaVersion: "v52",
        jobId: `bc-realism-${digest([VERSION, options.campaignId, index]).slice(0, 40)}`,
      }, null);
      assert.ok(call.acquired, `Wave ${index + 1} has an existing unapplied call; inspect its draft before retrying.`);
      const draft = repository.stageCampaignGenerationAtomically(OWNER, {
        campaignId: options.campaignId, timelineId: current.activeTimelineId, kind: "content-pack",
        stagedContent: { kind: "campaign-content", requestDigest, baseContentRevision: context.revision, dependencyDigests: {}, ...wave },
        validation: { valid: true, issues: [], validatedAt: new Date().toISOString() },
        expectedCampaignRevision: current.revision, idempotencyKey,
      }, call.attempt, wave, [], { responseModel: "reviewed-public-source-research", promptTokens: 0, completionTokens: 0,
        totalTokens: 0, latencyMs: 0, estimatedCostUsd: 0 });
      repository.applyCampaignContentGenerationDraftAtomically(OWNER, {
        draftId: draft.draftId, expectedDraftRevision: draft.revision, expectedCampaignRevision: draft.campaignRevision,
        idempotencyKey: `${idempotencyKey}.apply`, selectedArtifactKeys: selected,
      });
    }
    for (const handout of data.handouts) {
      const published = repository.getCampaignPublishedMaterials(OWNER, options.campaignId)!;
      if (published.materials.some(material => material.artifactKey === handout.key)) continue;
      assert.ok(!options.validateOnly, `Handout not published: ${handout.key}`);
      repository.publishCampaignMaterial(OWNER, options.campaignId, { artifactKey: handout.key,
        expectedRevision: published.revision, idempotencyKey: `${VERSION}.publish.${handout.key}` });
    }
    // This schema has no location-metadata edit command. Only relabel existing fictional
    // anchors, in one scoped authoring transaction; leave accepted historical artifacts intact.
    db.transaction(() => {
      for (const annotation of data.annotations) {
        const resource = locationArtifact.get(options.campaignId, annotation.artifactKey) as { server_resource_id: string } | undefined;
        assert.ok(resource, `missing anchor: ${annotation.artifactKey}`);
        const row = db.prepare("SELECT public_name,public_description FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?")
          .get(options.campaignId, resource.server_resource_id) as { public_name: string; public_description: string };
        const updated = row.public_description.includes(annotation.note) ? row.public_description : `${annotation.note}\n\n${row.public_description}`;
        if (options.validateOnly) {
          assert.equal(row.public_name, annotation.name); assert.ok(row.public_description.includes(annotation.note));
        } else db.prepare("UPDATE campaign_locations_v28 SET public_name=?,public_description=? WHERE campaign_id=? AND location_id=?")
          .run(annotation.name, updated, options.campaignId, resource.server_resource_id);
      }
      for (const artifactKey of data.closedRoutes) {
        const resource = db.prepare("SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_key=? AND artifact_kind='connection'")
          .get(options.campaignId, artifactKey) as { server_resource_id: string } | undefined;
        assert.ok(resource, `missing legacy route: ${artifactKey}`);
        if (options.validateOnly) assert.equal((db.prepare("SELECT route_state FROM campaign_location_connections_v28 WHERE campaign_id=? AND connection_id=?")
          .get(options.campaignId, resource.server_resource_id) as { route_state: string }).route_state, "closed");
        else db.prepare("UPDATE campaign_location_connections_v28 SET route_state='closed' WHERE campaign_id=? AND connection_id=?")
          .run(options.campaignId, resource.server_resource_id);
      }
      // Original game pacing metadata; probabilities are not real-world risk claims.
      for (const connection of data.connections) {
        const resource = db.prepare("SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND artifact_key=? AND artifact_kind='connection'")
          .get(options.campaignId, connection.key) as { server_resource_id: string };
        assert.ok(resource, `missing profiled route: ${connection.key}`);
        const authored = data.routeEventProfiles.find(profile => connection.key === profile.key || connection.key === `${profile.key}-out` || connection.key === `${profile.key}-back`);
        const profile = authored ?? { environment: "urban", risk: "safe", chancePercent: 0 };
        if (options.validateOnly) {
          assert.deepEqual(db.prepare("SELECT environment,risk,chance_percent FROM world_route_event_profiles_v1 WHERE campaign_id=? AND connection_id=?")
            .get(options.campaignId, resource.server_resource_id), { environment: profile.environment, risk: profile.risk, chance_percent: profile.chancePercent });
        } else db.prepare(`INSERT INTO world_route_event_profiles_v1 VALUES(?,?,?,?,?) ON CONFLICT(campaign_id,connection_id)
          DO UPDATE SET environment=excluded.environment,risk=excluded.risk,chance_percent=excluded.chance_percent`)
          .run(options.campaignId, resource.server_resource_id, profile.environment, profile.risk, profile.chancePercent);
      }
    }).immediate();
    assert.equal(partySnapshot(db, options.campaignId, options.sessionId), before, "Enrichment changed the party or its gameplay state.");
    assert.equal((db.pragma("quick_check") as Array<{ quick_check: string }>)[0]?.quick_check, "ok");
    assert.equal((db.pragma("foreign_key_check") as unknown[]).length, 0);
    const world = repository.getCampaignWorld(OWNER, options.campaignId, options.sessionId)!;
    const planning = repository.getCampaignGeneratedPlanning(OWNER, options.campaignId)!;
    const report = { status: options.validateOnly ? "validated" : "enriched", version: VERSION,
      campaignId: options.campaignId, sessionId: options.sessionId, newLocations: data.locations.length,
      newDirectedRoutes: data.connections.length, newLore: data.lore.length, publishedGuides: data.handouts.length,
       worldLocations: world.visibleLocations.length, worldDirectedRoutes: world.visibleConnections.length,
       openDirectedRoutes: (db.prepare("SELECT count(*) count FROM campaign_location_connections_v28 WHERE campaign_id=? AND route_state='open'").get(options.campaignId) as { count: number }).count,
       profiledDirectedRoutes: data.connections.length, closedDirectedRoutes: data.closedRoutes.length,
      planningLore: planning.lore.length, partyPreserved: true, integrity: "ok", foreignKeyFindings: 0 };
    if (!options.validateOnly) writeFileSync(path.join(options.dataDir, `${VERSION}.json`), JSON.stringify({ ...report, sourceDigest: digest(data), sources: data.sources }, null, 2));
    return report;
  } finally { repository?.close(); db.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => args[args.indexOf(key) + 1];
  for (const key of ["--data-dir", "--campaign", "--room"]) assert.ok(args.includes(key) && value(key) && !value(key)!.startsWith("--"), `Required: ${key}`);
  console.log(JSON.stringify(await enrichBaieComeau({ dataDir: path.resolve(value("--data-dir")!), campaignId: value("--campaign")!,
    sessionId: value("--room")!, validateOnly: args.includes("--validate-only") }), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

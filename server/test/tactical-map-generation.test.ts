import { describe, expect, it } from "vitest";
import { generateTacticalMap } from "../src/map/generation.js";
import { readFileSync } from "node:fs";
import DatabaseDriver from "better-sqlite3";
import { ensureCurrentSchema } from "../src/repo/db/schema.js";
import { findPath } from "../src/map/pathfinding.js";

describe("tactical map generation", () => {
  const context = { campaignId: "campaign", sessionId: "session", actorId: "actor", locationId: "location", actorLocationRevision: 0,
    spawns: [{ position: { x: 1, y: 1 }, footprint: { width: 2, height: 2 } }] };
  const currentSql = () => ["currentSchema.sql", "campaignDmSchema.sql", "recallSchema.sql", "contextInspectionProvenanceSchema.sql",
    "npcKnowledgeSchema.sql", "combatMarkerSchema.sql", "attunementSchema.sql", "combatReadyActionSchema.sql"]
    .map((name) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8")).join("\n");
  const rollBackTacticalMap = (sql: string) => sql.replace(",'dungeon-v2','cave-v2','arena-v2'", "")
    .replace("  actor_location_revision INTEGER,\n", "")
    .replace(/CREATE TABLE tactical_map_contexts_v2 \([\s\S]*?CREATE TRIGGER tactical_map_contexts_v2_delete[^\n]*\n/, "");

  it.each(["dungeon", "cave", "arena"] as const)("connects bounded v2 %s terrain and reserves footprints over varied seeds", (kind) => {
    for (let seed = 0; seed < 24; seed += 1) {
      const options = { kind, algorithm: `${kind}-v2` as const, seed: String(seed), width: 18, height: 14, context };
      const map = generateTacticalMap(options);
      expect(generateTacticalMap(options)).toEqual(map);
      expect(map.provenance?.algorithm).toBe(`${kind}-v2`);
      const open = new Set(map.tiles.filter((tile) => !tile.blocksMovement).map((tile) => tile.position.y * map.width + tile.position.x));
      const visited = new Set([19]); const queue = [19];
      for (let index = 0; index < queue.length; index += 1) for (const next of [queue[index]! - 18, queue[index]! + 18, queue[index]! - 1, queue[index]! + 1]) {
        if (open.has(next) && !visited.has(next)) { visited.add(next); queue.push(next); }
      }
      expect(visited).toEqual(open);
      for (const index of [19, 20, 37, 38]) expect(map.tiles[index]).toMatchObject({ blocksMovement: false, difficult: false, movementCost: 1 });
      expect(findPath(map, { x: 1, y: 1 }, { x: 8, y: 6 }, { footprint: { width: 2, height: 2 } })).not.toBeNull();
      expect(open.size).toBeGreaterThanOrEqual(25);
      expect(map.tiles.filter((tile) => tile.position.x === 0 || tile.position.y === 0 || tile.position.x === 17 || tile.position.y === 13).every((tile) => tile.blocksMovement)).toBe(true);
    }
  });

  it("fails closed on mismatched versions, unbounded v2 maps, and overlapping or boundary spawns", () => {
    const options = { kind: "cave" as const, algorithm: "cave-v2" as const, seed: "seed", width: 12, height: 10, context };
    expect(() => generateTacticalMap({ ...options, algorithm: "arena-v2" })).toThrow();
    expect(() => generateTacticalMap({ ...options, width: 65 })).toThrow();
    expect(() => generateTacticalMap({ ...options, context: { ...context, spawns: [...context.spawns, ...context.spawns] } })).toThrow(/overlap/);
    expect(() => generateTacticalMap({ ...options, context: { ...context, spawns: [{ position: { x: 0, y: 0 }, footprint: { width: 1, height: 1 } }] } })).toThrow(/boundary/);
    expect(() => generateTacticalMap({ ...options, algorithm: "cave-v1" })).toThrow();
  });

  it("upgrades only the exact previous schema without losing persisted v1 content", () => {
    const legacy = rollBackTacticalMap(currentSql());
    const db = new DatabaseDriver(":memory:");
    try {
      db.exec(legacy);
      db.pragma("foreign_keys = OFF");
      // Foreign keys are disabled only for this isolated historical payload fixture.
      const map = generateTacticalMap({ kind: "cave", seed: "persisted", width: 12, height: 10 });
      db.prepare("INSERT INTO tactical_maps_v58 VALUES('legacy','campaign','session','exploration',NULL,1,0,0,12,10,'cave-v1','persisted',?,?,?)")
        .run(map.provenance!.hash, JSON.stringify(map.tiles), "2030-01-01T00:00:00.000Z");
      // An invalid old store must roll back, not partially upgrade.
      expect(() => ensureCurrentSchema(db, "memory")).toThrow(/foreign keys/);
      expect(db.prepare("SELECT algorithm,tiles_json FROM tactical_maps_v58").get()).toEqual({ algorithm: "cave-v1", tiles_json: JSON.stringify(map.tiles) });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tactical_map_contexts_v2'").get()).toBeUndefined();
      db.prepare("DELETE FROM tactical_maps_v58").run();
      db.pragma("foreign_keys = ON");
      ensureCurrentSchema(db, "memory");
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='tactical_map_contexts_v2'").get()).toBeTruthy();
      ensureCurrentSchema(db, "memory");
    } finally { db.close(); }
  });

  it.each(["ownership", "local principal", "vocabulary"] as const)("leaves an exact legacy database unchanged when %s validation fails", (invalid) => {
    let legacy = rollBackTacticalMap(currentSql());
    // Omit fixture data without changing the exact historical schema or disabling its guards.
    if (invalid === "ownership") legacy = legacy.replace(/INSERT INTO "application_owner"[^\n]*\n/, "");
    const db = new DatabaseDriver(":memory:");
    try {
      db.exec(legacy);
      if (invalid === "local principal") {
        db.prepare("INSERT INTO principals VALUES('other-owner','Other owner',0)").run();
        db.prepare("UPDATE application_owner SET principal_id='other-owner'").run();
        db.prepare("DELETE FROM principals WHERE id='local-owner'").run();
      }
      if (invalid === "vocabulary") db.prepare("DELETE FROM rpg_effect_modifier_vocabulary_v26 WHERE modifier_kind='flat'").run();
      db.pragma("foreign_keys = ON");
      db.pragma("user_version = 58");
      const before = db.serialize();
      const schema = db.prepare("SELECT * FROM sqlite_master ORDER BY type,name").all();
      expect(db.prepare("PRAGMA foreign_key_check").get()).toBeUndefined();
      expect(() => ensureCurrentSchema(db, "isolated-invalid-legacy")).toThrow(invalid === "vocabulary" ? /required effect modifier vocabulary is invalid/ : /required local ownership data is missing/);
      expect(db.prepare("SELECT * FROM sqlite_master ORDER BY type,name").all()).toEqual(schema);
      expect(db.pragma("user_version", { simple: true })).toBe(58);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.inTransaction).toBe(false);
      expect(db.serialize().equals(before)).toBe(true);
    } finally { db.close(); }
  });
  it.each(["dungeon", "cave", "arena"] as const)("generates deterministic %s maps with verifiable provenance", (kind) => {
    const first = generateTacticalMap({ kind, seed: "velvet-seed", width: 18, height: 14 });
    const second = generateTacticalMap({ kind, seed: "velvet-seed", width: 18, height: 14 });
    expect(second).toEqual(first);
    expect(first.tiles).toHaveLength(18 * 14);
    expect(first.provenance?.algorithm).toBe(`${kind}-v1`);
    expect(first.provenance?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tiles.filter((tile) => !tile.blocksMovement).length).toBeGreaterThan(0);
  });

  it("changes content hashes with seeds and rejects unsafe dimensions", () => {
    const a = generateTacticalMap({ kind: "arena", seed: "a", width: 15, height: 15 });
    const b = generateTacticalMap({ kind: "arena", seed: "b", width: 15, height: 15 });
    expect(a.provenance?.hash).not.toBe(b.provenance?.hash);
    expect(() => generateTacticalMap({ kind: "cave", seed: "", width: 15, height: 15 })).toThrow(RangeError);
    expect(() => generateTacticalMap({ kind: "cave", seed: "x", width: 4, height: 15 })).toThrow(RangeError);
  });
});

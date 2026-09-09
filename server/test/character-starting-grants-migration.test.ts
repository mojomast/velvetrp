import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { ensureCurrentSchema, upgradeStartingGrantsSchema } from "../src/repo/db/schema.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };
const objects = (db: DatabaseDriver.Database) => db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name`).all() as SchemaObject[];
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"].map((id, index) =>
  [id, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as { might: number; agility: number; resolve: number; insight: number; presence: number; craft: number };

function finalizedGrant(): { filename: string; grant: Record<string, unknown>; materialization: Record<string, unknown> } {
  const repo = createRepository();
  const campaign = repo.createCampaign("local-owner", { name: "Migration grant" });
  const persona = repo.createCharacter({ name: "Migration", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "migration-catalog" });
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner",
    durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "migration-draft" });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const select = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "migration-select", selections: {
    race: { ...definitions.find((value) => value.reference.kind === "race")!.reference, kind: "race" as const },
    background: { ...definitions.find((value) => value.reference.kind === "background")!.reference, kind: "background" as const },
    class: { ...definitions.find((value) => value.reference.kind === "class")!.reference, kind: "class" as const },
    starterGrant: "kit",
  } });
  repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: select.draft.revision, idempotencyKey: "migration-finalize" });
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  const grant = db.prepare("SELECT * FROM character_starting_grants_v19 WHERE draft_id=?").get(draft.draft.id) as Record<string, unknown>;
  const materialization = db.prepare("SELECT * FROM character_starter_materializations_v51 WHERE draft_id=?").get(draft.draft.id) as Record<string, unknown>;
  db.close(); repo.close();
  return { filename: path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), grant, materialization };
}

function makePredecessor(db: DatabaseDriver.Database, sourceCheck = "source IN ('background-kit','background-currency')"): SchemaObject[] {
  const expected = objects(db);
  const grants = expected.find((object) => object.name === "character_starting_grants_v19" && object.type === "table")!;
  const dependent = expected.filter((object) => object.type !== "table" && ["character_starting_grants_v19", "character_starter_materializations_v51"].includes(object.tbl_name));
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("CREATE TEMP TABLE saved_grants AS SELECT * FROM character_starting_grants_v19");
    db.exec("CREATE TEMP TABLE saved_materializations AS SELECT * FROM character_starter_materializations_v51");
    for (const object of dependent) db.exec(`DROP ${object.type.toUpperCase()} ${object.name}`);
    db.exec("DROP TABLE character_starter_materializations_v51");
    db.exec("DROP TABLE character_starting_grants_v19");
    db.exec(grants.sql.replace("source IN ('background-kit','background-currency','class-starter-kit')", sourceCheck));
    db.exec(expected.find((object) => object.name === "character_starter_materializations_v51" && object.type === "table")!.sql);
    db.exec("INSERT INTO character_starting_grants_v19 SELECT * FROM saved_grants");
    db.exec("INSERT INTO character_starter_materializations_v51 SELECT * FROM saved_materializations");
    db.exec("DROP TABLE saved_grants");
    db.exec("DROP TABLE saved_materializations");
    for (const object of dependent) db.exec(object.sql);
  } finally {
    db.pragma("foreign_keys = ON");
  }
  return expected;
}

describe("character starting grants schema upgrade", () => {
  it("recognizes the exact old source CHECK, preserves grants and materializations, and rolls back injected validation failure", () => {
    const { filename, grant, materialization } = finalizedGrant();
    const db = new DatabaseDriver(filename); const expected = makePredecessor(db); const before = objects(db);
    const predecessor = expected.find((object) => object.name === "character_starting_grants_v19")!;
    expect(before.find((object) => object.name === "character_starting_grants_v19")!.sql).toBe(predecessor.sql
      .replace("source IN ('background-kit','background-currency','class-starter-kit')", "source IN ('background-kit','background-currency')"));
    expect(() => upgradeStartingGrantsSchema(db, before, expected, () => { throw new Error("injected validation failure"); })).toThrow("injected validation failure");
    expect(objects(db)).toEqual(before);
    expect(db.prepare("SELECT * FROM character_starting_grants_v19").all()).toEqual([grant]);
    expect(db.prepare("SELECT * FROM character_starter_materializations_v51").all()).toEqual([materialization]);
    ensureCurrentSchema(db, filename);
    expect(db.prepare("SELECT * FROM character_starting_grants_v19").all()).toEqual([grant]);
    expect(db.prepare("SELECT * FROM character_starter_materializations_v51").all()).toEqual([materialization]);
    expect(db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare(`INSERT INTO character_starting_grants_v19 VALUES(?,?,?,?,?,?,?,?,?)`).run(
      grant.draft_id, 63, "item", grant.pack_id, grant.pack_version, grant.definition_id, 1, "not-a-source", "{}",
    )).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("rejects a nonexact source CHECK without changing schema or rows", () => {
    const { filename, grant } = finalizedGrant();
    const db = new DatabaseDriver(filename); makePredecessor(db, "source IN ('background-kit','background-currency','other')");
    const before = objects(db);
    expect(() => ensureCurrentSchema(db, filename)).toThrow(/modified table character_starting_grants_v19/);
    expect(objects(db)).toEqual(before);
    expect(db.prepare("SELECT * FROM character_starting_grants_v19").all()).toEqual([grant]);
    db.close();
  });

  it("creates the class starter source CHECK on an empty database", () => {
    const db = new DatabaseDriver(":memory:");
    ensureCurrentSchema(db, "memory");
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='character_starting_grants_v19'").get() as { sql: string }).sql;
    expect(sql).toContain("source IN ('background-kit','background-currency','class-starter-kit')");
    db.close();
  });
});

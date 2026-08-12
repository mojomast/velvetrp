import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import {
  COMPANION_CORE_V45_LAYOUT_DIGEST,
  COMPANION_CORE_V45_MANAGED_OBJECTS,
  assertCompanionCoreLayoutV45,
} from "../src/repo/db/migrations/v45_companion_principals.js";
import { createCompanionCoreV44 } from "../src/repo/db/migrations/v44_companion_core.js";
import { migrate44to45 } from "../src/repo/db/migrations/v45_companion_principals.js";
import { buildCanonicalPopulatedV44CompanionFixture, buildCanonicalV43Fixture, SUPPORT_WINDOW } from "./fixtures/migrations/support-window.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function open(): DatabaseDriver.Database {
  const db = new DatabaseDriver(file());
  db.pragma("foreign_keys=ON");
  return db;
}

function buildEmptyV44(): void {
  buildCanonicalV43Fixture();
  const db = open();
  createCompanionCoreV44(db);
  db.prepare("UPDATE meta SET value='44' WHERE key='schemaVersion'").run();
  db.close();
}

function addCanonicalFutureV45(marker: "43" | "44"): void {
  buildEmptyV44();
  let db = open();
  migrate44to45(db);
  if (marker === "44") createCompanionCoreV44(db);
  db.prepare("UPDATE meta SET value=? WHERE key='schemaVersion'").run(marker);
  db.close();
}

function marker(): string {
  const db = new DatabaseDriver(file(), { readonly: true });
  const value = (db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string }).value;
  db.close();
  return value;
}

describe("schema v45 companion principals", () => {
  it("owns the exact attested managed layout with durable historical principals", () => {
    buildCanonicalV43Fixture();
    createRepository().close();
    const db = new DatabaseDriver(file());
    db.pragma("foreign_keys=ON");
    assertCompanionCoreLayoutV45(db);
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "45" });
    expect(db.prepare("SELECT layout_digest FROM companion_layout_attestation_v45 WHERE singleton=1").get())
      .toEqual({ layout_digest: COMPANION_CORE_V45_LAYOUT_DIGEST });
    const inventory = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v45*' AND sql IS NOT NULL ORDER BY type,name").all();
    expect(inventory).toEqual([...COMPANION_CORE_V45_MANAGED_OBJECTS]
      .map(([type, name]) => ({ type, name })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)));
    const expectedPrincipalFields = {
      companion_commands_v45: ["principal_id"],
      companion_proposals_v45: ["proposer_principal_id"],
      companion_decisions_v45: ["decided_by_principal_id"],
      companion_grants_v45: ["granted_by_principal_id", "grantee_principal_id"],
      companion_grant_revocations_v45: ["revoked_by_principal_id"],
    } as const;
    for (const [table, fields] of Object.entries(expectedPrincipalFields)) {
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; to: string }>;
      for (const field of fields) {
        expect(foreignKeys.filter((key) => key.from === field && key.table === "principals")
          .map(({ table: parent, from, to }) => ({ table: parent, from, to })))
          .toEqual([{ table: "principals", from: field, to: "id" }]);
      }
      expect(foreignKeys.some((key) => key.table === "campaign_memberships")).toBe(false);
    }
    const proposer = db.prepare("PRAGMA table_info(companion_proposals_v45)").all() as Array<{ name: string; notnull: number }>;
    expect(proposer.find(({ name }) => name === "proposer_principal_id")?.notnull).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rejects unsupported v42 without creating v43-v45 artifacts", async () => {
    const { buildCanonicalV42Fixture } = await import("./fixtures/migrations/support-window.js");
    buildCanonicalV42Fixture();
    expect(() => createRepository()).toThrow("unsupported schemaVersion 42; expected 45");
    const db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v4[345]*'").all()).toEqual([]);
    db.close();
  });

  it.each(["43", "44"] as const)("removes an exact empty future v45 shell from supported v%s and upgrades", (version) => {
    addCanonicalFutureV45(version);
    createRepository().close();
    const db = open();
    expect(marker()).toBe("45");
    assertCompanionCoreLayoutV45(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v44*'").all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it.each([
    ["partial", () => {
      buildCanonicalV43Fixture();
      const db = open();
      db.exec("CREATE TABLE companion_commands_v45(id TEXT PRIMARY KEY)");
      db.close();
    }],
    ["modified", () => {
      addCanonicalFutureV45("44");
      const db = open();
      db.exec("DROP TRIGGER companion_commands_v45_immutable_delete_v45");
      db.close();
    }],
  ] as const)("rejects a %s future v45 shell without marker mutation and retries after removal", (_kind, arrange) => {
    arrange();
    const before = marker();
    expect(() => createRepository()).toThrow(/malformed future v45 artifacts/);
    expect(marker()).toBe(before);
    const db = open();
    db.pragma("foreign_keys=OFF");
    for (const [type, name] of [...COMPANION_CORE_V45_MANAGED_OBJECTS].reverse()) {
      if (type === "trigger") db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
      if (type === "index") db.exec(`DROP INDEX IF EXISTS "${name}"`);
    }
    for (const [, name] of [...COMPANION_CORE_V45_MANAGED_OBJECTS].filter(([type]) => type === "table").reverse()) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`);
    }
    db.close();
    createRepository().close();
    expect(marker()).toBe("45");
  });

  it("rejects populated future v45 history, preserves it, and retries under its truthful marker", () => {
    const fixture = buildCanonicalPopulatedV44CompanionFixture();
    let db = open();
    migrate44to45(db);
    createCompanionCoreV44(db);
    db.prepare("UPDATE meta SET value='44' WHERE key='schemaVersion'").run();
    const commandIds = db.prepare("SELECT command_id FROM companion_commands_v45 ORDER BY resulting_revision").all();
    db.close();

    expect(() => createRepository()).toThrow(/populated future v45 artifact companion_commands_v45/);
    expect(marker()).toBe("44");
    db = open();
    expect(db.prepare("SELECT command_id FROM companion_commands_v45 ORDER BY resulting_revision").all()).toEqual(commandIds);
    expect(db.prepare("SELECT grant_id FROM companion_grants_v45").get()).toEqual({ grant_id: fixture.grantId });
    db.prepare("UPDATE meta SET value='45' WHERE key='schemaVersion'").run();
    db.close();
    createRepository().close();
    expect(marker()).toBe("45");
  });

  it.each(["44", "45"] as const)("globally preflights schema marker %s foreign-key corruption", (version) => {
    if (version === "44") buildEmptyV44();
    else { buildCanonicalV43Fixture(); createRepository().close(); }
    const db = new DatabaseDriver(file());
    db.pragma("foreign_keys=OFF");
    db.prepare(`INSERT INTO companion_commands_v${version} VALUES('missing-campaign','missing-npc','corrupt-v${version}','corrupt-v${version}',
      'local-owner','companion-create',0,1,'{}',?,?)`).run("a".repeat(64), SUPPORT_WINDOW.at);
    db.close();
    expect(() => createRepository()).toThrow(`schema marker ${version} contains foreign-key violation in companion_commands_v${version}`);
    expect(marker()).toBe(version);
  });
});

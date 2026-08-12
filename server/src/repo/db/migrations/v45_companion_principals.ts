import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  COMPANION_CORE_V44_MANAGED_OBJECTS,
  assertCompanionCoreLayoutV44,
} from "./v44_companion_core.js";

const DATA_TABLES = [
  "companion_commands_v45",
  "companion_receipts_v45",
  "campaign_companions_v45",
  "companion_presence_links_v45",
  "companion_proposals_v45",
  "companion_decisions_v45",
  "companion_decision_receipts_v45",
  "companion_grants_v45",
  "companion_grant_command_families_v45",
  "companion_grant_revocations_v45",
  "companion_audit_events_v45",
] as const;
const TABLES = [...DATA_TABLES, "companion_layout_attestation_v45"] as const;
const INDEXES = [
  "idx_companion_commands_principal_v45",
  "idx_companion_receipts_revision_v45",
  "idx_companion_presence_session_v45",
  "idx_companion_proposals_companion_v45",
  "idx_companion_decisions_companion_v45",
  "idx_companion_grants_grantee_v45",
  "idx_companion_grants_actor_v45",
  "idx_companion_audit_companion_v45",
] as const;
const IMMUTABLE_TABLES = DATA_TABLES.filter((table) => table !== "campaign_companions_v45");
const TRIGGERS = [
  ...IMMUTABLE_TABLES.flatMap((table) => [
    `${table}_immutable_update_v45`, `${table}_immutable_delete_v45`,
  ]),
  "companion_layout_attestation_v45_immutable_update_v45",
  "companion_layout_attestation_v45_immutable_delete_v45",
  "campaign_companions_v45_structural_update_v45",
] as const;

export const COMPANION_CORE_V45_MANAGED_OBJECTS = [
  ...TABLES.map((name) => ["table", name] as const),
  ...INDEXES.map((name) => ["index", name] as const),
  ...TRIGGERS.map((name) => ["trigger", name] as const),
] as const;

const inventorySql = `SELECT type,name,tbl_name FROM sqlite_master
  WHERE type IN ('table','index','trigger') AND sql IS NOT NULL
    AND (name GLOB '*v45*' OR tbl_name IN (${TABLES.map(() => "?").join(",")}))
  ORDER BY type,name`;

function layoutDigest(db: DatabaseDriver.Database): string {
  const names = COMPANION_CORE_V45_MANAGED_OBJECTS.map(([, name]) => name);
  const rows = (db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY type,name`).all(...names) as Array<{
      type: string; name: string; tbl_name: string; sql: string | null;
    }>).map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, " ").trim() ?? null }));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export const COMPANION_CORE_V45_LAYOUT_DIGEST = "f39b06ce52ea58bfff9d13ffd95188914a18993994b886ecd9177403862281e6";

export function assertCompanionCoreLayoutV45(db: DatabaseDriver.Database): void {
  const expected = new Set(COMPANION_CORE_V45_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const artifacts = db.prepare(inventorySql).all(...TABLES) as Array<{ type: string; name: string }>;
  const unknown = artifacts.find(({ type, name }) => !expected.has(`${type}:${name}`));
  if (unknown || artifacts.length !== expected.size) throw new Error("schema v45 companion-core inventory is incompatible");
  const attestation = db.prepare("SELECT layout_digest FROM companion_layout_attestation_v45 WHERE singleton=1")
    .get() as { layout_digest: string } | undefined;
  const actual = layoutDigest(db);
  if (!attestation || attestation.layout_digest !== actual || actual !== COMPANION_CORE_V45_LAYOUT_DIGEST) {
    throw new Error(`schema v45 companion-core layout attestation is incompatible (${actual})`);
  }
}

function v45TableSql(db: DatabaseDriver.Database, v45Name: string): string {
  const v44Name = v45Name.replace(/_v45$/, "_v44");
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(v44Name) as { sql: string };
  return row.sql
    .replaceAll("_v44", "_v45")
    .replace(
      /FOREIGN KEY\(campaign_id,(\w*principal_id)\) REFERENCES campaign_memberships\(campaign_id,principal_id\)/g,
      "FOREIGN KEY($1) REFERENCES principals(id)",
    );
}

function createCompanionCoreV45(db: DatabaseDriver.Database): void {
  for (const table of DATA_TABLES) db.exec(v45TableSql(db, table));
  db.exec(`CREATE TABLE companion_layout_attestation_v45 (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*')
  )`);

  for (const index of INDEXES) {
    const v44Index = index.replace(/_v45$/, "_v44");
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(v44Index) as { sql: string };
    db.exec(row.sql.replaceAll("_v44", "_v45"));
  }
  db.exec(`CREATE TRIGGER campaign_companions_v45_structural_update_v45
    BEFORE UPDATE ON campaign_companions_v45
    WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.npc_id<>OLD.npc_id
      OR NEW.initial_session_id<>OLD.initial_session_id OR NEW.created_at<>OLD.created_at
      OR NEW.create_command_id<>OLD.create_command_id OR NEW.create_receipt_id<>OLD.create_receipt_id
      OR NEW.create_revision<>OLD.create_revision OR NEW.create_command_kind<>OLD.create_command_kind
      OR NEW.create_payload_digest<>OLD.create_payload_digest
      OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
    BEGIN SELECT RAISE(ABORT,'v45 companion projection must preserve creation anchors and advance exactly once'); END`);
  for (const table of [...IMMUTABLE_TABLES, "companion_layout_attestation_v45"]) {
    db.exec(`CREATE TRIGGER ${table}_immutable_update_v45 BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete_v45 BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'v45 companion history is immutable'); END;`);
  }
}

export function migrate44to45(db: DatabaseDriver.Database): void {
  assertCompanionCoreLayoutV44(db);
  const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
  db.pragma("foreign_keys=OFF");
  try {
    db.transaction(() => {
      createCompanionCoreV45(db);
      for (const table of DATA_TABLES) {
        const v44Table = table.replace(/_v45$/, "_v44");
        db.exec(`INSERT INTO ${table} SELECT * FROM ${v44Table}`);
      }
      for (const [, name] of [...COMPANION_CORE_V44_MANAGED_OBJECTS].reverse()) {
        const type = COMPANION_CORE_V44_MANAGED_OBJECTS.find(([, candidate]) => candidate === name)?.[0];
        if (type === "trigger") db.exec(`DROP TRIGGER ${name}`);
        if (type === "index") db.exec(`DROP INDEX ${name}`);
      }
      for (const table of [...COMPANION_CORE_V44_MANAGED_OBJECTS]
        .filter(([type]) => type === "table").map(([, name]) => name).reverse()) db.exec(`DROP TABLE ${table}`);
      db.prepare("INSERT INTO companion_layout_attestation_v45 VALUES(1,?)").run(layoutDigest(db));
      const issue = db.prepare("PRAGMA foreign_key_check").get() as { table: string } | undefined;
      if (issue) throw new Error(`v45 companion migration contains foreign-key violation in ${issue.table}`);
      db.prepare("UPDATE meta SET value='45' WHERE key='schemaVersion'").run();
    })();
  } finally {
    db.pragma(`foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
  }
}

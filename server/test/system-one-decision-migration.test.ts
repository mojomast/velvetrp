import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureCurrentSchema } from "../src/repo/db/schema.js";

const asset = (name: string) => readFileSync(new URL(`../src/repo/db/${name}`, import.meta.url), "utf8");
const predecessorSql = () => asset("currentSchema.sql") + "\n" + asset("campaignDmSchema.sql") + "\n"
  + asset("recallSchema.sql") + "\n" + asset("contextInspectionProvenanceSchema.sql") + "\n"
  + asset("npcKnowledgeSchema.sql") + "\n" + asset("combatMarkerSchema.sql") + "\n"
  + asset("attunementSchema.sql") + "\n" + asset("combatReadyActionSchema.sql");

describe("system one decision schema migration", () => {
  it("adds only the decision sidecar to the exact predecessor without backfill", () => {
    const db = new DatabaseDriver(":memory:");
    db.exec(predecessorSql());
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='system_one_decisions_v1'").get()).toBeUndefined();

    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT count(*) count FROM system_one_decisions_v1").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_system_one_decisions_lane_v1'").get()).toBeTruthy();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("creates the decision sidecar in a fresh database", () => {
    const db = new DatabaseDriver(":memory:");
    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT count(*) count FROM system_one_decisions_v1").get()).toEqual({ count: 0 });
    db.close();
  });
});

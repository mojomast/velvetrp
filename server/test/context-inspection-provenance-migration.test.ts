import DatabaseDriver from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureCurrentSchema } from "../src/repo/db/schema.js";

const predecessor = () => readFileSync(new URL("../src/repo/db/currentSchema.sql", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../src/repo/db/campaignDmSchema.sql", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../src/repo/db/recallSchema.sql", import.meta.url), "utf8");
describe("context inspection provenance schema migration", () => {
  it("upgrades only the exact recall predecessor without backfill", () => {
    const db = new DatabaseDriver(":memory:"); db.exec(predecessor());
    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT count(*) count FROM campaign_context_inspection_headers_v61").get()).toEqual({ count: 0 });
    expect(() => db.prepare(`INSERT INTO campaign_context_inspection_headers_v61
      (dispatch_id,provenance_version,campaign_id,session_id,lane,recorded_phase,source_visibility,created_at)
      VALUES('d',1,'missing','missing','adventure-planning','planned','public','now')`).run()).toThrow(/FOREIGN KEY/);
    db.close();
  });
  it("preserves the recall upgrade chain by adding both later additive assets", () => {
    const db = new DatabaseDriver(":memory:"); db.exec(readFileSync(new URL("../src/repo/db/currentSchema.sql", import.meta.url), "utf8") + "\n" + readFileSync(new URL("../src/repo/db/campaignDmSchema.sql", import.meta.url), "utf8"));
    ensureCurrentSchema(db, ":memory:");
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='adventure_narration_contexts'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='campaign_context_inspection_headers_v61'").get()).toBeTruthy();
    db.close();
  });
});

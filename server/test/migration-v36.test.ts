import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { ADVENTURE_GENERATION_V35_MANAGED_OBJECTS } from "../src/repo/db/migrations/v35_adventure_generation.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const AT = "2035-01-01T00:00:00.000Z";

function removeV36(db: DatabaseDriver.Database): void {
  const objects = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v36*'").all() as Array<{ type: string; name: string }>;
  for (const object of objects) if (object.type === "trigger") db.exec(`DROP TRIGGER "${object.name}"`);
  for (const table of ["adventure_hardening_layout_attestation_v36", "generation_draft_apply_receipts_v36", "turn_mechanics_links_v36",
    "adventure_coordination_receipts_v36", "adventure_coordination_events_v36", "adventure_coordination_commands_v36"]) db.exec(`DROP TABLE IF EXISTS "${table}"`);
  for (const object of objects) if (object.type === "index") db.exec(`DROP INDEX IF EXISTS "${object.name}"`);
}

function createDraft() {
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(AT) } });
  const campaign = repo.createCampaign("local-owner", { name: "V36 hardening" });
  const draft = repo.createGenerationDraft("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
    kind: "encounter", stagedContent: { title: "Ambush" }, validation: { valid: true, issues: [], validatedAt: AT },
    expectedCampaignRevision: 0, idempotencyKey: "draft" });
  repo.close(); return { campaign, draft };
}

describe("schema v36 adventure hardening", () => {
  it("migrates populated v35 additively and roots immutable coordination ledgers", () => {
    const { draft } = createDraft();
    const db = new DatabaseDriver(file()); removeV36(db); db.prepare("UPDATE meta SET value='35' WHERE key='schemaVersion'").run(); db.close();
    const reopened = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    expect(reopened.getGenerationDraft("local-owner", draft.draftId)).toMatchObject({ draftId: draft.draftId, state: "staged" });
    reopened.close();
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "36" });
    expect(verify.prepare("SELECT mutation_type,expected_revision,resulting_revision FROM adventure_coordination_commands_v36").get())
      .toMatchObject({ mutation_type: "migration-snapshot", expected_revision: -1 });
    verify.close();
  });

  it("rejects a modified v35 layout even when its mutable digest is maliciously resealed", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close();
    const db = new DatabaseDriver(file());
    db.exec(`DROP TRIGGER provider_call_metadata_guard_insert_v35;
      CREATE TRIGGER provider_call_metadata_guard_insert_v35 BEFORE INSERT ON provider_call_metadata BEGIN SELECT 1; END;
      DROP TRIGGER adventure_generation_attestation_immutable_update_v35;`);
    const names = ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(([, name]) => name);
    const digest = createHash("sha256").update(JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master
      WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`).all(...names))).digest("hex");
    db.prepare("UPDATE adventure_generation_layout_attestation_v35 SET layout_digest=? WHERE singleton=1").run(digest);
    db.exec("CREATE TRIGGER adventure_generation_attestation_immutable_update_v35 BEFORE UPDATE ON adventure_generation_layout_attestation_v35 BEGIN SELECT RAISE(ABORT,'adventure/generation attestation is immutable'); END;");
    // Recompute after restoring the inventory trigger; the malicious provider SQL remains part of the digest.
    const resealed = createHash("sha256").update(JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master
      WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`).all(...names))).digest("hex");
    db.exec("DROP TRIGGER adventure_generation_attestation_immutable_update_v35");
    db.prepare("UPDATE adventure_generation_layout_attestation_v35 SET layout_digest=? WHERE singleton=1").run(resealed);
    db.exec("CREATE TRIGGER adventure_generation_attestation_immutable_update_v35 BEFORE UPDATE ON adventure_generation_layout_attestation_v35 BEGIN SELECT RAISE(ABORT,'adventure/generation attestation is immutable'); END;");
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("canonical adventure/generation layout");
  });

  it("rejects malformed persisted shared-contract JSON at startup", () => {
    const { draft } = createDraft(); const db = new DatabaseDriver(file());
    db.pragma("ignore_check_constraints=ON");
    db.prepare("UPDATE generation_drafts SET staged_content_json='[]',revision=revision+1 WHERE id=?").run(draft.draftId);
    db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("generation draft JSON is malformed");
  });

  it("rejects malformed partial future v36 artifacts instead of silently cleaning them", () => {
    createRepository({ dataDir: process.env.VELVET_DATA_DIR! }).close(); const db = new DatabaseDriver(file());
    db.exec("DROP TRIGGER provider_call_metadata_bound_v36"); db.prepare("UPDATE meta SET value='35' WHERE key='schemaVersion'").run(); db.close();
    expect(() => createRepository({ dataDir: process.env.VELVET_DATA_DIR! })).toThrow("malformed partial future v36 artifacts");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='adventure_coordination_commands_v36'").get()).toEqual({ 1: 1 }); verify.close();
  });
});

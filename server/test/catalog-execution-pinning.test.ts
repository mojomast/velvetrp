import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("reviewed setup execution pinning", () => {
  it("pins the campaign's publicly reachable abilities and spells once", () => {
    const repo = createRepository();
    const campaign = repo.createCampaign("local-owner", { name: "Pins" });
    repo.installSrdStarterCatalog("local-owner");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const count = () => (db.prepare("SELECT count(*) count FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=?").get(campaign.id) as { count: number }).count;
    expect(count()).toBe(0);
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const pinned = db.prepare("SELECT definition_id FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=? AND kind=? ORDER BY definition_id").all(campaign.id, "spell").map((row: any) => row.definition_id);
    expect(pinned).toContain("srd-5.1:spell:magic-missile");
    expect(db.prepare("SELECT 1 FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=? AND kind='ability' AND definition_id='srd-5.1:ability:fighter-second-wind'").get(campaign.id)).toBeTruthy();
    const after = count();
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    expect(count()).toBe(after);
    db.close();
    repo.close();
  });
});

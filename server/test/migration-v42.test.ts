import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const tables = ["campaign_content_layout_attestation_v42", "campaign_content_revisions_v42", "campaign_content_receipts_v42", "campaign_content_commands_v42"];

describe("schema v42 campaign content integrity", () => {
  it("upgrades canonical populated v41 without changing its historical artifacts", () => {
    const repo = createRepository(); repo.createCampaign("local-owner", { name: "Legacy" }); repo.close(); const db = new DatabaseDriver(file());
    for (const table of tables) db.exec(`DROP TABLE ${table}`);
    db.prepare("UPDATE meta SET value='41' WHERE key='schemaVersion'").run(); db.close();
    createRepository().close(); const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(verify.prepare("SELECT count(*) count FROM campaign_content_commands_v42").get()).toEqual({ count: 0 }); verify.close();
  });
  it("rejects tampered or partial future artifacts and preserves populated commands on rewind", () => {
    createRepository().close(); let db = new DatabaseDriver(file());
    db.exec("DROP TRIGGER campaign_content_commands_v42_immutable_update_v42"); db.prepare("UPDATE meta SET value='41' WHERE key='schemaVersion'").run(); db.close();
    expect(() => createRepository()).toThrow(/malformed future v42 artifacts/);
    // Recreate a clean file then prove a populated command is never discarded.
    db = new DatabaseDriver(file()); db.exec("DROP TABLE campaign_content_layout_attestation_v42; DROP TABLE campaign_content_revisions_v42; DROP TABLE campaign_content_receipts_v42; DROP TABLE campaign_content_commands_v42;"); db.close();
    let nextId = 0;
    const repo = createRepository({
      clock: { now: () => new Date("2035-01-01T00:00:00.000Z") },
      ids: { nextId: () => `v42-fixture-${++nextId}` },
    });
    const campaign = repo.createCampaign("local-owner", { name: "Future artifact" });
    const draft = repo.createGenerationDraft("local-owner", {
      campaignId: campaign.id,
      timelineId: campaign.activeTimelineId,
      kind: "quest",
      stagedContent: { title: "Future artifact draft" },
      validation: { valid: true, issues: [], validatedAt: "2035-01-01T00:00:00.000Z" },
      expectedCampaignRevision: 0,
      idempotencyKey: "v42-fixture-draft",
    });
    repo.close(); db = new DatabaseDriver(file());
    db.prepare("INSERT INTO campaign_content_commands_v42 VALUES('x',?,?, 'p','k',0,'2035-01-01')").run(campaign.id, draft.draftId); db.prepare("UPDATE meta SET value='41' WHERE key='schemaVersion'").run(); db.close();
    expect(() => createRepository()).toThrow(/populated future v42 artifact/);
  });
});

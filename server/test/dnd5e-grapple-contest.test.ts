import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { createRepository, SRD_5_1_STARTER_CATALOG } from "../src/repo/index.js";
import { contestScore } from "../src/repo/encounter/encounterWriteRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("SRD 5.1 grapple contest score", () => {
  it("uses Athletics for the grappler and the better of Athletics or Acrobatics for the defender", () => {
    const repo = createRepository();
    const campaign = repo.createCampaign("local-owner", { name: "Grapple contest" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
    const persona = repo.createCharacter({ name: "Grappler", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never }, idempotencyKey: "draft" });
    const definitions = SRD_5_1_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
      race: definitions.find(d => d.reference.kind === "race")!.reference, background: definitions.find(d => d.reference.kind === "background")!.reference,
      class: definitions.find(d => d.reference.kind === "class")!.reference, starterGrant: "kit" } } as never);
    const actorId = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "final" }).receipt.actorId;

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const sheetId = (db.prepare("SELECT sheet_id FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaign.id, actorId) as { sheet_id: string }).sheet_id;
    const attribute = (id: string) => (db.prepare("SELECT value FROM rpg_character_attributes WHERE campaign_id=? AND sheet_id=? AND attribute_id=?")
      .get(campaign.id, sheetId, id) as { value: number }).value;
    const strMod = Math.floor((attribute("strength") - 10) / 2), dexMod = Math.floor((attribute("dexterity") - 10) / 2);
    expect(contestScore(db, campaign.id, { actor_id: actorId }, "athletics")).toBe(strMod);
    expect(contestScore(db, campaign.id, { actor_id: actorId }, "best")).toBe(Math.max(strMod, dexMod));
    const insertProf = db.prepare(`INSERT OR IGNORE INTO rpg_character_proficiencies(campaign_id,sheet_id,position,category,proficiency_id)
      VALUES(?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM rpg_character_proficiencies WHERE sheet_id=?),'skill',?)`);
    insertProf.run(campaign.id, sheetId, sheetId, "athletics");
    expect(contestScore(db, campaign.id, { actor_id: actorId }, "athletics")).toBe(strMod + 2);
    expect(contestScore(db, campaign.id, { actor_id: actorId }, "best")).toBe(Math.max(strMod + 2, dexMod));
    insertProf.run(campaign.id, sheetId, sheetId, "acrobatics");
    expect(contestScore(db, campaign.id, { actor_id: actorId }, "best")).toBe(Math.max(strMod + 2, dexMod + 2));
    expect(contestScore(db, campaign.id, { actor_id: "not-an-actor" }, "best")).toBe(0);
    db.close();
    repo.close();
  });
});

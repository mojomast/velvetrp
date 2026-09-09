import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  SRD_5_1_STARTER_IDENTITY,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";
import {
  createRepository,
  MECHANICS_STARTER_CATALOG,
  SRD_5_1_STARTER_CATALOG,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const srdScores = Object.fromEntries(
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((id, index) => [
    id,
    CHARACTER_BUILDER_STANDARD_ARRAY[index],
  ]),
) as CharacterBuilderAttributeScores;
const velvetScores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"].map(
    (id, index) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[index]],
  ),
) as CharacterBuilderAttributeScores;

function finalizeSrd(
  repo: ReturnType<typeof createRepository>,
  campaignId: string,
  name: string,
  classDefinitionId: string,
  starterGrant: "kit" | "currency",
) {
  const persona = repo.createCharacter({
    name,
    age: 30,
    archetype: "Fighter",
    boundaries: "",
    fictionalConfirmed: true,
  });
  const draft = repo.createCharacterDraft("local-owner", campaignId, {
    personaId: persona.id,
    controllerPrincipalId: "local-owner",
    durability: "durable",
    allocation: { method: "standard-array", scores: srdScores },
    idempotencyKey: `${name}-draft`,
  });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, {
    expectedRevision: 0,
    idempotencyKey: `${name}-select`,
    selections: {
      race: definitions.find((value) => value.reference.definitionId === "srd-5.1:race:human")!.reference,
      background: definitions.find((value) => value.reference.definitionId === "srd-5.1:background:acolyte")!.reference,
      class: definitions.find((value) => value.reference.definitionId === classDefinitionId)!.reference,
      starterGrant,
    },
  } as never);
  return {
    draft,
    selected,
    finalized: repo.finalizeCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: selected.draft.revision,
      idempotencyKey: `${name}-final`,
    }),
  };
}

describe("SRD Fighter starter grant finalization", () => {
  it("records, materializes, receipts, and replays exactly one pinned unequipped longsword", () => {
    const repo = createRepository();
    const campaign = repo.createCampaign("local-owner", { name: "Fighter kit" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", campaign.id, {
      expectedRevision: 0,
      idempotencyKey: "fighter-pins",
    });

    const { draft, selected, finalized } = finalizeSrd(
      repo,
      campaign.id,
      "Fighter",
      "srd-5.1:class:fighter",
      "kit",
    );
    const longsword = {
      kind: "item",
      packId: SRD_5_1_STARTER_IDENTITY.packId,
      packVersion: SRD_5_1_STARTER_IDENTITY.packVersion,
      definitionId: "srd-5.1:item:longsword",
    };
    expect(selected.draft.startingGrants).toEqual([
      expect.objectContaining({ source: "background-kit" }),
      { kind: "item", reference: longsword, quantity: 1, source: "class-starter-kit" },
    ]);
    expect(finalized.receipt.startingGrants).toEqual([
      expect.objectContaining({ source: "background-kit" }),
      { kind: "item", reference: longsword, quantity: 1, source: "class-starter-kit" },
    ]);
    expect(selected.draft.startingGrants).toEqual(finalized.receipt.startingGrants);
    expect(finalized.draft.startingGrants).toEqual(finalized.receipt.startingGrants);
    expect(repo.finalizeCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: 1,
      idempotencyKey: "Fighter-final",
    })).toEqual(finalized);
    expect(repo.getActorInventorySnapshot("local-owner", campaign.id, finalized.receipt.actorId))
      .toMatchObject({ revision: 0, equipment: [], inventory: { items: expect.arrayContaining([
        expect.objectContaining({ kind: "instanced", item: longsword }),
      ]) } });

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare(`SELECT position,source,pack_id,pack_version,definition_id FROM character_starting_grants_v19
      WHERE draft_id=? ORDER BY position`).all(draft.draft.id)).toEqual([
      expect.objectContaining({ position: 0, source: "background-kit" }),
      { position: 1, source: "class-starter-kit", pack_id: longsword.packId,
        pack_version: longsword.packVersion, definition_id: longsword.definitionId },
    ]);
    expect(db.prepare(`SELECT entry_mode,quantity,equipped FROM rpg_inventory_entries_v25
      WHERE actor_id=? AND item_definition_id=?`).all(finalized.receipt.actorId, longsword.definitionId))
      .toEqual([{ entry_mode: "instanced", quantity: 1, equipped: 0 }]);
    db.close();
    repo.close();
  });

  it("leaves non-Fighter SRD, currency, and non-SRD finalization grants unchanged", () => {
    const repo = createRepository();
    const srdCampaign = repo.createCampaign("local-owner", { name: "SRD exclusions" });
    repo.installSrdStarterCatalog("local-owner");
    repo.configureSrdStarterCatalog("local-owner", srdCampaign.id, {
      expectedRevision: 0,
      idempotencyKey: "exclusion-srd-pins",
    });
    const barbarian = finalizeSrd(repo, srdCampaign.id, "Barbarian", "srd-5.1:class:barbarian", "kit");
    const currency = finalizeSrd(repo, srdCampaign.id, "Currency-Fighter", "srd-5.1:class:fighter", "currency");
    expect(barbarian.finalized.receipt.startingGrants).toEqual([
      expect.objectContaining({ source: "background-kit" }),
    ]);
    expect(currency.finalized.receipt.startingGrants).toEqual([
      expect.objectContaining({ source: "background-currency" }),
    ]);

    const velvetCampaign = repo.createCampaign("local-owner", { name: "Velvet exclusions" });
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner", velvetCampaign.id, {
      expectedRevision: 0,
      idempotencyKey: "exclusion-velvet-pins",
    });
    const persona = repo.createCharacter({ name: "Velvet", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft("local-owner", velvetCampaign.id, {
      personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
      allocation: { method: "standard-array", scores: velvetScores }, idempotencyKey: "velvet-draft",
    });
    const definitions = MECHANICS_STARTER_CATALOG.definitions;
    const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: 0, idempotencyKey: "velvet-select", selections: {
        race: definitions.find((value) => value.reference.kind === "race")!.reference,
        background: definitions.find((value) => value.reference.kind === "background")!.reference,
        class: definitions.find((value) => value.reference.kind === "class")!.reference,
        starterGrant: "kit",
      },
    } as never);
    expect(repo.finalizeCharacterDraft("local-owner", draft.draft.id, {
      expectedRevision: selected.draft.revision, idempotencyKey: "velvet-final",
    }).receipt.startingGrants).toEqual([expect.objectContaining({ source: "background-kit" })]);
    repo.close();
  });
});

import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type PublishContentCatalogInput } from "@velvet/contracts";
import { calculateCatalogDigest, createRepository } from "../src/repo/index.js";
import { SRD_5_1_STARTER_CATALOG } from "../src/content/srdStarterCatalog.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

/** A two-class SRD publication whose Wizard levels 2 and 3 offer Cleric (and Barbarian for the prerequisite failure). */
function multiclassCatalog(): PublishContentCatalogInput {
  const catalog = structuredClone(SRD_5_1_STARTER_CATALOG) as PublishContentCatalogInput;
  catalog.idempotencyKey = "velvet:multiclass:publish";
  replaceIdentity(catalog, "velvet:multiclass", "1.0.0+000000000000");
  catalog.manifest.digest = "0".repeat(64);
  const { packId, packVersion } = catalog.manifest;
  const ref = (definitionId: string) => ({ packId, packVersion, kind: "class", definitionId });
  const cleric = ref("srd-5.1:class:cleric"), barbarian = ref("srd-5.1:class:barbarian");
  for (const name of ["Wizard Level 2", "Wizard Level 3"]) {
    const level = catalog.definitions.find((definition) => definition.reference.kind === "class-level" && definition.name === name) as any;
    level.mechanics.progressionChoices = [
      { choiceId: `velvet:multiclass:choice:class-${level.mechanics.level}`, kind: "class", required: true, count: 1, options: [cleric, barbarian] },
    ];
  }
  const digest = calculateCatalogDigest(catalog);
  replaceIdentity(catalog, "velvet:multiclass", `1.0.0+${digest.slice(0, 12)}`);
  catalog.manifest.digest = digest;
  return catalog;
}

function replaceIdentity(value: unknown, packId: string, packVersion: string): void {
  if (Array.isArray(value)) { value.forEach((child) => replaceIdentity(child, packId, packVersion)); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if ("packId" in record) record.packId = packId;
  if ("packVersion" in record) record.packVersion = packVersion;
  Object.values(record).forEach((child) => replaceIdentity(child, packId, packVersion));
}

const multiclassScores = { strength: 8, dexterity: 13, constitution: 14, intelligence: 15, wisdom: 13, charisma: 10 };
const singleClassScores = { strength: 15, dexterity: 14, constitution: 13, intelligence: 12, wisdom: 10, charisma: 8 };

function finalized(catalog: PublishContentCatalogInput, className: string, scores: Record<string, number>) {
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date("2032-01-01T00:00:00.000Z") } });
  const persona = repo.createCharacter({ name: "Multiclass persona", age: 28, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const campaign = repo.createCampaign("local-owner", { name: "Multiclass progression" });
  repo.publishContentCatalog("local-owner", catalog);
  repo.configureCampaignCatalog("local-owner", campaign.id, { rulesProfileId: catalog.manifest.compatibility.rulesProfileId,
    contentPacks: [{ packId: catalog.manifest.packId, packVersion: catalog.manifest.packVersion }], expectedRevision: 0, idempotencyKey: `multiclass-pins-${className}` });
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner",
    durability: "durable", allocation: { method: "manual", scores: scores as any }, idempotencyKey: `multiclass-draft-${className}` });
  const definitions = catalog.definitions;
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: `multiclass-select-${className}`, selections: {
    race: { ...definitions.find((value) => value.reference.kind === "race" && value.name === "Elf")!.reference, kind: "race" },
    background: { ...definitions.find((value) => value.reference.kind === "background")!.reference, kind: "background" },
    class: { ...definitions.find((value) => value.reference.kind === "class" && value.name === className)!.reference, kind: "class" },
    starterGrant: "kit",
  } } as any);
  const result = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `multiclass-finalize-${className}`, progressionMode: "xp" });
  return { repo, campaign, id: result.receipt.campaignCharacterId, actorId: result.receipt.actorId, sheetId: result.receipt.sheetId, catalog };
}

const digestOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("D&D 5.1 additive multiclass progression", () => {
  it("leaves an existing single-class preview and apply byte-for-byte unchanged", () => {
    const { repo, id } = finalized(SRD_5_1_STARTER_CATALOG as PublishContentCatalogInput, "Fighter", singleClassScores);
    repo.grantCharacterXp("local-owner", id, { amount: 900, reason: "Single-class baseline", expectedRevision: 0, idempotencyKey: "single-class-xp" });
    const preview = repo.previewCharacterProgression("local-owner", id)!;
    expect("classLevelsByClass" in preview).toBe(false);
    expect("spellSlots" in preview).toBe(false);
    for (const level of preview.levels) {
      expect("classRef" in level).toBe(false);
      expect("classLevel" in level).toBe(false);
      expect("grantedProficiencies" in level).toBe(false);
    }
    const applied = repo.applyCharacterProgression("local-owner", id, { previewRevision: preview.revision, previewToken: preview.token, selections: [], idempotencyKey: "single-class-apply" });
    expect("classLevelsByClass" in applied.progression).toBe(false);
    expect("knownProficiencies" in applied.progression).toBe(false);
    // The deterministic single-class advancement content remains byte-stable.
    expect([digestOf(preview.levels), digestOf(preview.pendingChoices), digestOf(applied.receipt.appliedLevels)])
      .toEqual(["f84e9ab4af859bdf7c9f63fb6e4867bda727f0d1978dd92ef8d4297170f40afd",
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        "f84e9ab4af859bdf7c9f63fb6e4867bda727f0d1978dd92ef8d4297170f40afd"]);
    repo.close();
  });

  it("enters and levels a second class with per-class HP, combined slots, prerequisites, and idempotent proficiency grants", () => {
    const catalog = multiclassCatalog();
    const { repo, id, actorId, sheetId } = finalized(catalog, "Wizard", multiclassScores);
    const initial = repo.getCharacterProgression("local-owner", id)!;
    expect(initial.level).toBe(1);
    const initialMaxHp = initial.derived.maxHp;

    repo.grantCharacterXp("local-owner", id, { amount: 900, reason: "Two completed journeys", expectedRevision: 0, idempotencyKey: "multiclass-xp" });
    const preview = repo.previewCharacterProgression("local-owner", id)!;
    expect(preview.levels.map((level) => level.level)).toEqual([2, 3]);
    const classChoices = preview.pendingChoices.filter((choice) => choice.kind === "class");
    expect(classChoices.map((choice) => choice.level)).toEqual([2, 3]);
    expect(classChoices[0]!.options.map((option) => option.definitionId)).toEqual(["srd-5.1:class:cleric", "srd-5.1:class:barbarian"]);

    // Prerequisites reject an unmet second class before any write.
    const barbarian = classChoices[0]!.options.find((option) => option.definitionId === "srd-5.1:class:barbarian")!;
    expect(() => repo.previewCharacterProgression("local-owner", id, [
      { choiceId: classChoices[0]!.choiceId, kind: "class", ability: barbarian },
    ] as any)).toThrow(/prerequisite/);
    expect(repo.getCharacterProgression("local-owner", id)!.level).toBe(1);

    const cleric = classChoices[0]!.options.find((option) => option.definitionId === "srd-5.1:class:cleric")!;
    const selections = classChoices.map((choice) => ({ choiceId: choice.choiceId, kind: "class" as const, ability: cleric }));
    const input = { previewRevision: preview.revision, previewToken: preview.token, selections, idempotencyKey: "multiclass-apply" };
    const applied = repo.applyCharacterProgression("local-owner", id, input);
    expect(applied.progression.level).toBe(3);
    // Per-class HP gain uses each class's own hit-die-based level step (Cleric d8 then d6 fixed).
    expect(applied.receipt.appliedLevels.map((level) => level.hp.gain)).toEqual([8, 6]);
    expect(applied.receipt.appliedLevels.map((level) => level.classLevel)).toEqual([1, 2]);
    expect(applied.receipt.appliedLevels.map((level) => level.classRef!.definitionId)).toEqual(["srd-5.1:class:cleric", "srd-5.1:class:cleric"]);
    expect(applied.receipt.appliedLevels[0]!.grantedProficiencies).toEqual(["light-armor", "medium-armor", "shields"]);
    expect(applied.receipt.appliedLevels[1]!.grantedProficiencies).toBeUndefined();
    // Wizard 1 (full) + Cleric 2 (full) = combined caster level 3.
    expect(applied.progression.classLevelsByClass!.map((entry) => [entry.classRef.definitionId, entry.level])).toEqual([
      ["srd-5.1:class:cleric", 2], ["srd-5.1:class:wizard", 1],
    ]);
    expect(applied.progression.knownProficiencies).toEqual(["light-armor", "medium-armor", "shields"]);
    const selectedPreview = repo.previewCharacterProgression("local-owner", id, selections as any)!;
    expect(selectedPreview.spellSlots).toEqual({ 1: 4, 2: 2 });
    // Each crossed level adds that class's own hit-die-based gain (Cleric d8 then 6).
    expect(applied.progression.derived.maxHp).toBe(initialMaxHp + 14);
    expect(applied.receipt.appliedLevels[1]!.derivedAfter.maxHp).toBe(applied.progression.derived.maxHp);

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT position,definition_id,level FROM rpg_character_classes WHERE sheet_id=? ORDER BY position").all(sheetId)).toEqual([
      { position: 0, definition_id: "srd-5.1:class:wizard", level: 1 },
      { position: 1, definition_id: "srd-5.1:class:cleric", level: 2 },
    ]);
    expect(db.prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name='health'").get(actorId)).toEqual({
      current: applied.progression.derived.maxHp, max: applied.progression.derived.maxHp,
    });
    db.close();

    // Idempotent replay returns the stored result and inserts no additional rows.
    expect(repo.applyCharacterProgression("local-owner", id, input)).toEqual(applied);
    const reopened = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const surfaced = reopened.getCharacterProgression("local-owner", id)!;
    expect(surfaced.classLevelsByClass!.map((entry) => [entry.classRef.definitionId, entry.level])).toEqual([
      ["srd-5.1:class:cleric", 2], ["srd-5.1:class:wizard", 1],
    ]);
    expect(surfaced.knownProficiencies).toEqual(["light-armor", "medium-armor", "shields"]);
    reopened.close();
    repo.close();
  });
});

import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  type PublishContentCatalogInput,
} from "@velvet/contracts";
import { calculateCatalogDigest, createRepository } from "../src/repo/index.js";
import { SRD_5_1_STARTER_CATALOG } from "../src/content/srdStarterCatalog.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const srdScores = Object.fromEntries(
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as any;

function replaceIdentity(value: unknown, packId: string, packVersion: string): void {
  if (Array.isArray(value)) { value.forEach((child) => replaceIdentity(child, packId, packVersion)); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if ("packId" in record) record.packId = packId;
  if ("packVersion" in record) record.packVersion = packVersion;
  Object.values(record).forEach((child) => replaceIdentity(child, packId, packVersion));
}

/** A synthetic SRD publication whose Barbarian level 2 declares a Constitution/Strength ASI choice. */
function asiCatalog(): PublishContentCatalogInput {
  const catalog = structuredClone(SRD_5_1_STARTER_CATALOG) as PublishContentCatalogInput;
  catalog.idempotencyKey = "velvet:asi:publish";
  replaceIdentity(catalog, "velvet:asi", "1.0.0+000000000000");
  catalog.manifest.digest = "0".repeat(64);
  const levelTwo = catalog.definitions.find((definition) =>
    definition.reference.kind === "class-level" && (definition as any).name === "Barbarian Level 2") as any;
  levelTwo.mechanics.progressionChoices = [
    ...(levelTwo.mechanics.progressionChoices ?? []),
    { choiceId: "velvet:asi:choice:ability-score", kind: "ability-score-increase", required: true, count: 1,
      points: 2, scores: ["constitution", "strength"], options: [] },
  ];
  const digest = calculateCatalogDigest(catalog);
  replaceIdentity(catalog, "velvet:asi", `1.0.0+${digest.slice(0, 12)}`);
  catalog.manifest.digest = digest;
  return catalog;
}

function finalized(catalog: PublishContentCatalogInput = asiCatalog()) {
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date("2032-01-01T00:00:00.000Z") } });
  const persona = repo.createCharacter({ name: "ASI persona", age: 28, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const campaign = repo.createCampaign("local-owner", { name: "ASI progression" });
  repo.publishContentCatalog("local-owner", catalog);
  repo.configureCampaignCatalog("local-owner", campaign.id, { rulesProfileId: catalog.manifest.compatibility.rulesProfileId,
    contentPacks: [{ packId: catalog.manifest.packId, packVersion: catalog.manifest.packVersion }], expectedRevision: 0, idempotencyKey: "asi-pins" });
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner",
    durability: "durable", allocation: { method: "standard-array", scores: srdScores }, idempotencyKey: "asi-draft" });
  const definitions = catalog.definitions;
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "asi-select", selections: {
    race: { ...definitions.find((value) => value.reference.kind === "race" && value.name === "Human")!.reference, kind: "race" },
    background: { ...definitions.find((value) => value.reference.kind === "background")!.reference, kind: "background" },
    class: { ...definitions.find((value) => value.reference.kind === "class" && value.name === "Barbarian")!.reference, kind: "class" },
    starterGrant: "kit",
  } } as any);
  const result = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "asi-finalize", progressionMode: "xp" });
  return { repo, campaign, id: result.receipt.campaignCharacterId, actorId: result.receipt.actorId, sheetId: result.receipt.sheetId };
}

function attributes(sheetId: string): Record<string, number> {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
  const rows = db.prepare("SELECT attribute_id,value FROM rpg_character_attributes WHERE sheet_id=?").all(sheetId) as Array<{ attribute_id: string; value: number }>;
  db.close();
  return Object.fromEntries(rows.map((row) => [row.attribute_id, row.value]));
}

describe("ability-score-increase progression", () => {
  it("previews, applies, persists, and reflects a Constitution increase in HP and derived stats", () => {
    const { repo, id, actorId, sheetId } = finalized();
    const initial = repo.getCharacterProgression("local-owner", id)!;
    expect(initial.level).toBe(1);
    const initialMaxHp = initial.derived.maxHp;
    const initialConstitution = attributes(sheetId).constitution!;
    expect(initial.derived.abilityModifiers?.constitution).toBe(Math.floor((initialConstitution - 10) / 2));

    repo.grantCharacterXp("local-owner", id, { amount: 900, reason: "Two completed journeys", expectedRevision: 0, idempotencyKey: "asi-xp" });
    const preview = repo.previewCharacterProgression("local-owner", id)!;
    expect(preview.levels.map((level) => level.level)).toEqual([2, 3]);
    const choice = preview.pendingChoices.find((pending) => pending.kind === "ability-score-increase")!;
    expect(choice).toMatchObject({ kind: "ability-score-increase", level: 2, points: 2 });
    expect(choice.options.map((option) => option.definitionId)).toEqual(["constitution", "strength"]);
    const constitutionOption = choice.options.find((option) => option.definitionId === "constitution")!;
    // Reaching level 3 requires selecting the class's required subclass choice.
    const subclassChoice = preview.pendingChoices.find((pending) => pending.kind === "subclass")!;

    const applied = repo.applyCharacterProgression("local-owner", id, { previewRevision: preview.revision, previewToken: preview.token,
      selections: [{ choiceId: choice.choiceId, kind: "ability-score-increase", increases: [{ ability: constitutionOption, amount: 2 }] },
        { choiceId: subclassChoice.choiceId, kind: "subclass", ability: subclassChoice.options[0]! }], idempotencyKey: "asi-apply" });
    expect(applied.progression.level).toBe(3);
    expect(applied.receipt.appliedLevels[0]!.abilityScoreIncreases).toEqual([{ attribute: "constitution", amount: 2 }]);
    expect(applied.receipt.appliedLevels[1]!.abilityScoreIncreases).toEqual([]);

    const expectedConstitution = initialConstitution + 2;
    expect(attributes(sheetId).constitution).toBe(expectedConstitution);
    expect(applied.progression.derived.abilityModifiers?.constitution).toBe(Math.floor((expectedConstitution - 10) / 2));
    // The Constitution modifier delta is reflected in the new max HP and carried to level 3.
    expect(applied.progression.derived.maxHp).toBe(initialMaxHp + 15);
    expect(applied.receipt.appliedLevels[1]!.derivedAfter.maxHp).toBe(applied.progression.derived.maxHp);
    const health = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true })
      .prepare("SELECT current,max FROM rpg_actor_resources WHERE actor_id=? AND name='health'").get(actorId) as any;
    expect(health.max).toBe(applied.progression.derived.maxHp);
    repo.close();
  });

  it("accepts a +1/+1 split and carries both increases forward", () => {
    const { repo, id, sheetId } = finalized();
    const initialConstitution = attributes(sheetId).constitution!;
    repo.grantCharacterXp("local-owner", id, { amount: 300, reason: "One completed journey", expectedRevision: 0, idempotencyKey: "asi-split-xp" });
    const preview = repo.previewCharacterProgression("local-owner", id)!;
    const choice = preview.pendingChoices.find((pending) => pending.kind === "ability-score-increase")!;
    const constitution = choice.options.find((option) => option.definitionId === "constitution")!;
    const strength = choice.options.find((option) => option.definitionId === "strength")!;
    expect(() => repo.applyCharacterProgression("local-owner", id, { previewRevision: preview.revision, previewToken: preview.token,
      selections: [{ choiceId: choice.choiceId, kind: "ability-score-increase", increases: [{ ability: constitution, amount: 1 }, { ability: strength, amount: 1 }] }],
      idempotencyKey: "asi-split-apply" })).not.toThrow();
    expect(attributes(sheetId).constitution).toBe(initialConstitution + 1);
    repo.close();
  });

  it("rejects malformed distributions without partial writes", () => {
    const { repo, id, sheetId } = finalized();
    const initialAttributes = attributes(sheetId);
    repo.grantCharacterXp("local-owner", id, { amount: 300, reason: "One completed journey", expectedRevision: 0, idempotencyKey: "asi-bad-xp" });
    const preview = repo.previewCharacterProgression("local-owner", id)!;
    const choice = preview.pendingChoices.find((pending) => pending.kind === "ability-score-increase")!;
    const constitution = choice.options.find((option) => option.definitionId === "constitution")!;
    const strength = choice.options.find((option) => option.definitionId === "strength")!;
    const intelligence = { ...constitution, definitionId: "intelligence" };
    const apply = (increases: any, key: string) => repo.applyCharacterProgression("local-owner", id, { previewRevision: preview.revision,
      previewToken: preview.token, selections: [{ choiceId: choice.choiceId, kind: "ability-score-increase", increases }], idempotencyKey: key });

    expect(() => apply([{ ability: constitution, amount: 1 }], "asi-wrong-total")).toThrow("exactly");
    expect(() => apply([{ ability: intelligence, amount: 2 }], "asi-not-offered")).toThrow("exact offered option");
    expect(() => apply([{ ability: constitution, amount: 3 }], "asi-out-of-range")).toThrow();
    expect(() => apply([{ ability: constitution, amount: 1 }, { ability: constitution, amount: 1 }], "asi-duplicate")).toThrow(/unique/);

    expect(repo.getCharacterProgression("local-owner", id)!.level).toBe(1);
    expect(attributes(sheetId)).toEqual(initialAttributes);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) count FROM character_level_advancements_v23 WHERE campaign_character_id=?").get(id)).toEqual({ count: 0 });
    db.close();
    repo.close();
  });

  it("is idempotent across replay and does not double-apply attribute increases", () => {
    const { repo, id, sheetId } = finalized();
    const initialConstitution = attributes(sheetId).constitution!;
    repo.grantCharacterXp("local-owner", id, { amount: 300, reason: "One completed journey", expectedRevision: 0, idempotencyKey: "asi-replay-xp" });
    const preview = repo.previewCharacterProgression("local-owner", id)!;
    const choice = preview.pendingChoices.find((pending) => pending.kind === "ability-score-increase")!;
    const constitution = choice.options.find((option) => option.definitionId === "constitution")!;
    const input = { previewRevision: preview.revision, previewToken: preview.token,
      selections: [{ choiceId: choice.choiceId, kind: "ability-score-increase" as const, increases: [{ ability: constitution, amount: 2 }] }], idempotencyKey: "asi-replay-apply" };
    const first = repo.applyCharacterProgression("local-owner", id, input);
    const replay = repo.applyCharacterProgression("local-owner", id, input);
    expect(replay).toEqual(first);
    expect(attributes(sheetId).constitution).toBe(initialConstitution + 2);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) count FROM character_level_advancements_v23 WHERE campaign_character_id=?").get(id)).toEqual({ count: 1 });
    db.close();
    repo.close();
  });
});

import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type PublishContentCatalogInput } from "@velvet/contracts";
import { calculateCatalogDigest, createRepository, MECHANICS_STARTER_CATALOG, MECHANICS_STARTER_PRIOR_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as any;

function replaceIdentity(value: unknown, packId: string, packVersion: string): void {
  if (Array.isArray(value)) { value.forEach((child) => replaceIdentity(child, packId, packVersion)); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if ("packId" in record) record.packId = packId;
  if ("packVersion" in record) record.packVersion = packVersion;
  Object.values(record).forEach((child) => replaceIdentity(child, packId, packVersion));
}

/** A synthetic publication with exactly one feat and one subclass plus class-level choices for each. */
function featSubclassCatalog(): PublishContentCatalogInput {
  const catalog = structuredClone(MECHANICS_STARTER_CATALOG) as PublishContentCatalogInput;
  catalog.idempotencyKey = "velvet:feat-subclass:publish";
  replaceIdentity(catalog, "velvet:feat-subclass", "1.2.0+000000000000");
  catalog.manifest.digest = "0".repeat(64);
  const { packId, packVersion } = catalog.manifest;
  const ref = (kind: string, definitionId: string) => ({ packId, packVersion, kind, definitionId });
  const klass = catalog.definitions.find((definition) => definition.reference.kind === "class")!;
  const strike = catalog.definitions.find((definition) => definition.reference.kind === "ability" && definition.reference.definitionId.endsWith("steady-strike"))!;
  const spell = catalog.definitions.find((definition) => definition.reference.kind === "spell")!;
  const featRef = ref("feat", "velvet:feat-subclass:feat:lantern-vigor");
  const subclassRef = ref("subclass", "velvet:feat-subclass:subclass:radiant-warden");
  const level2 = catalog.definitions.find((definition) => definition.reference.kind === "class-level" && (definition as any).mechanics.level === 2) as any;
  const level3 = catalog.definitions.find((definition) => definition.reference.kind === "class-level" && (definition as any).mechanics.level === 3) as any;
  level2.mechanics.progressionChoices = [
    ...(level2.mechanics.progressionChoices ?? []),
    { choiceId: "velvet:feat-subclass:choice:feat", kind: "feat", required: true, count: 1, options: [featRef] },
  ];
  level3.mechanics.progressionChoices = [
    { choiceId: "velvet:feat-subclass:choice:subclass", kind: "subclass", required: true, count: 1, options: [subclassRef] },
  ];
  catalog.definitions.push(
    { reference: featRef, name: "Lantern Vigor", description: "A bounded feat that rewards a steady resolve.", tags: ["velvet:original"], mechanics: { abilityBonuses: { resolve: 1 }, grantedAbilityRefs: [strike.reference] } } as any,
    { reference: subclassRef, name: "Radiant Warden", description: "A bounded subclass that grants a focused lantern discipline.", tags: ["velvet:original"], mechanics: { classRef: klass.reference, level: 3, abilityRefs: [strike.reference], spellRefs: [spell.reference] } } as any,
  );
  const digest = calculateCatalogDigest(catalog);
  replaceIdentity(catalog, "velvet:feat-subclass", `1.2.0+${digest.slice(0, 12)}`);
  catalog.manifest.digest = digest;
  return catalog;
}

function finalized(catalog: PublishContentCatalogInput, mode: "xp" | "milestone" = "xp") {
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date("2032-01-01T00:00:00.000Z") } });
  const persona = repo.createCharacter({ name: "Feat subclass persona", age: 28, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const campaign = repo.createCampaign("local-owner", { name: "Feat subclass" });
  repo.publishContentCatalog("local-owner", catalog);
  repo.configureCampaignCatalog("local-owner", campaign.id, { rulesProfileId: catalog.manifest.compatibility.rulesProfileId, contentPacks: [{ packId: catalog.manifest.packId, packVersion: catalog.manifest.packVersion }], expectedRevision: 0, idempotencyKey: "feat-subclass-pins" });
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "feat-subclass-draft" });
  const definitions = catalog.definitions;
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "feat-subclass-select", selections: {
    race: { ...definitions.find((value) => value.reference.kind === "race")!.reference, kind: "race" },
    background: { ...definitions.find((value) => value.reference.kind === "background")!.reference, kind: "background" },
    class: { ...definitions.find((value) => value.reference.kind === "class")!.reference, kind: "class" }, starterGrant: "kit",
  } } as any);
  const result = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "feat-subclass-finalize", progressionMode: mode });
  return { repo, campaign, id: result.receipt.campaignCharacterId, actorId: result.receipt.actorId };
}

describe("feat and subclass progression selections", () => {
  it("keeps existing no-feat/no-subclass publications valid with unchanged digests", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const current = repo.validateContentCatalog(MECHANICS_STARTER_CATALOG);
    const prior = repo.validateContentCatalog(MECHANICS_STARTER_PRIOR_CATALOG);
    expect(current.valid).toBe(true);
    expect(current.normalizedSummary.digest).toBe(MECHANICS_STARTER_CATALOG.manifest.digest);
    expect(prior.valid).toBe(true);
    expect(prior.normalizedSummary.digest).toBe(MECHANICS_STARTER_PRIOR_CATALOG.manifest.digest);
    repo.close();
  });

  it("previews, applies, persists, and surfaces feat and subclass selections", () => {
    const catalog = featSubclassCatalog();
    expect(catalog.definitions.filter((definition) => definition.reference.kind === "feat")).toHaveLength(1);
    expect(catalog.definitions.filter((definition) => definition.reference.kind === "subclass")).toHaveLength(1);
    const { repo, id, actorId } = finalized(catalog);
    const initial = repo.getCharacterProgression("local-owner", id)!;
    expect(initial.knownFeats).toEqual([]);
    expect(initial.knownSubclasses).toEqual([]);

    repo.grantCharacterXp("local-owner", id, { amount: 900, reason: "Two completed journeys", expectedRevision: 0, idempotencyKey: "feat-subclass-xp" });
    const preview = repo.previewCharacterProgression("local-owner", id)!;
    expect(preview.levels.map((level) => level.level)).toEqual([2, 3]);
    expect(preview.pendingChoices.map((choice) => choice.kind).sort()).toEqual(["ability", "feat", "subclass"]);
    expect(preview.levels[0]!.selectedFeats).toEqual([]);
    expect(preview.levels[1]!.selectedSubclasses).toEqual([]);

    const selections = preview.pendingChoices.map((choice) => ({ choiceId: choice.choiceId, kind: choice.kind, ability: choice.options[0]! })) as any;
    const applied = repo.applyCharacterProgression("local-owner", id, { previewRevision: preview.revision, previewToken: preview.token, selections, idempotencyKey: "feat-subclass-apply" });
    expect(applied.progression.level).toBe(3);
    expect(applied.progression.knownFeats!.map((reference) => reference.definitionId)).toEqual(["velvet:feat-subclass:feat:lantern-vigor"]);
    expect(applied.progression.knownSubclasses!.map((reference) => reference.definitionId)).toEqual(["velvet:feat-subclass:subclass:radiant-warden"]);
    expect(applied.progression.knownAbilities!.map((reference) => reference.definitionId)).toContain(preview.pendingChoices.find((choice) => choice.kind === "ability")!.options[0]!.definitionId);
    expect(applied.receipt.appliedLevels[0]!.selectedFeats![0]!.definitionId).toBe("velvet:feat-subclass:feat:lantern-vigor");
    expect(applied.receipt.appliedLevels[1]!.selectedSubclasses![0]!.definitionId).toBe("velvet:feat-subclass:subclass:radiant-warden");

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT kind,pack_id,pack_version,definition_id,source_level,source_choice_id FROM character_known_options_v25 WHERE campaign_character_id=? ORDER BY kind").all(id)).toEqual([
      { kind: "feat", pack_id: catalog.manifest.packId, pack_version: catalog.manifest.packVersion, definition_id: "velvet:feat-subclass:feat:lantern-vigor", source_level: 2, source_choice_id: "velvet:feat-subclass:choice:feat" },
      { kind: "subclass", pack_id: catalog.manifest.packId, pack_version: catalog.manifest.packVersion, definition_id: "velvet:feat-subclass:subclass:radiant-warden", source_level: 3, source_choice_id: "velvet:feat-subclass:choice:subclass" },
    ]);
    expect(db.prepare("SELECT COUNT(*) count FROM character_known_powers_v23 WHERE campaign_character_id=?").get(id)).toMatchObject({ count: expect.any(Number) });
    db.close();
    repo.close();

    const reopened = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const surfaced = reopened.getCharacterProgression("local-owner", id)!;
    expect(surfaced.knownFeats!.map((reference) => reference.definitionId)).toEqual(["velvet:feat-subclass:feat:lantern-vigor"]);
    expect(surfaced.knownSubclasses!.map((reference) => reference.definitionId)).toEqual(["velvet:feat-subclass:subclass:radiant-warden"]);
    expect(reopened.previewCharacterProgression("local-owner", id)!.pendingChoices).toEqual([]);
    reopened.close();
  });

  it("continues to apply ability-only publications exactly as before", () => {
    const { repo, id } = finalized(MECHANICS_STARTER_CATALOG as PublishContentCatalogInput);
    repo.grantCharacterXp("local-owner", id, { amount: 900, reason: "Ability-only journey", expectedRevision: 0, idempotencyKey: "ability-only-xp" });
    const preview = repo.previewCharacterProgression("local-owner", id)!;
    expect(preview.pendingChoices).toHaveLength(1);
    expect(preview.pendingChoices[0]!.kind).toBe("ability");
    const choice = preview.pendingChoices[0]!;
    const applied = repo.applyCharacterProgression("local-owner", id, { previewRevision: preview.revision, previewToken: preview.token, selections: [{ choiceId: choice.choiceId, kind: "ability", ability: choice.options[0]! } as any], idempotencyKey: "ability-only-apply" });
    expect(applied.progression.knownAbilities!.map((reference) => reference.definitionId)).toContain(choice.options[0]!.definitionId);
    expect(applied.progression.knownFeats).toEqual([]);
    expect(applied.progression.knownSubclasses).toEqual([]);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) count FROM character_known_options_v25 WHERE campaign_character_id=?").get(id)).toEqual({ count: 0 });
    db.close();
    repo.close();
  });
});

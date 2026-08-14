import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  calculateCatalogDigest,
  canonicalCatalogJson,
  MECHANICS_STARTER_CATALOG,
  MECHANICS_STARTER_PACK_ID,
  MECHANICS_STARTER_PACK_VERSION,
  createRepository,
} from "../src/repo/index.js";
import type { CatalogDefinition, CatalogDefinitionKind, PublishContentCatalogInput } from "@velvet/contracts";
import { createCorruptionTestRepository, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const dataDir = () => process.env.VELVET_DATA_DIR as string;
const dbPath = () => path.join(dataDir(), "velvet.sqlite");

function replaceIdentity(value: unknown, packId: string, packVersion: string): void {
  if (Array.isArray(value)) { for (const child of value) replaceIdentity(child, packId, packVersion); return; }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if ("packId" in record) record.packId = packId;
  if ("packVersion" in record) record.packVersion = packVersion;
  for (const child of Object.values(record)) replaceIdentity(child, packId, packVersion);
}

type DefinitionByKind<Kind extends CatalogDefinitionKind> = Extract<CatalogDefinition, { reference: { kind: Kind } }>;
const asDefinitionKind = <Kind extends CatalogDefinitionKind>(definition: CatalogDefinition, _kind: Kind) =>
  definition as DefinitionByKind<Kind>;

function finalizeCatalog(mutator?: (catalog: PublishContentCatalogInput) => void, packId: string = MECHANICS_STARTER_PACK_ID): PublishContentCatalogInput {
  const catalog = structuredClone(MECHANICS_STARTER_CATALOG) as PublishContentCatalogInput;
  catalog.idempotencyKey = `${packId}:publication`;
  replaceIdentity(catalog, packId, "1.0.0+000000000000");
  catalog.manifest.digest = "0".repeat(64);
  mutator?.(catalog);
  const digest = calculateCatalogDigest(catalog);
  replaceIdentity(catalog, packId, `1.0.0+${digest.slice(0, 12)}`);
  catalog.manifest.digest = digest;
  return catalog;
}

function privateReachabilityCatalog(): PublishContentCatalogInput {
  return finalizeCatalog((catalog) => {
    const enemy = catalog.definitions.find((definition) => definition.reference.kind === "enemy-template");
    const ability = structuredClone(catalog.definitions.find((definition) => definition.reference.kind === "ability")!);
    const spell = structuredClone(catalog.definitions.find((definition) => definition.reference.kind === "spell")!);
    const item = structuredClone(catalog.definitions.find((definition) => definition.reference.kind === "item")!);
    const currency = structuredClone(catalog.definitions.find((definition) => definition.reference.kind === "currency")!);
    const hiddenClass = structuredClone(catalog.definitions.find((definition) => definition.reference.kind === "class")!);
    const hiddenLevel = structuredClone(catalog.definitions.find((definition) => definition.reference.kind === "class-level")!);
    ability.reference.definitionId = "velvet:mechanics:ability:hidden-only"; ability.name = "Hidden Ability Value";
    spell.reference.definitionId = "velvet:mechanics:spell:hidden-only"; spell.name = "Hidden Spell Value";
    item.reference.definitionId = "velvet:mechanics:item:hidden-only"; item.name = "Hidden Item Value";
    currency.reference.definitionId = "velvet:mechanics:currency:hidden-only"; currency.name = "Hidden Currency Value";
    hiddenClass.reference.definitionId = "velvet:mechanics:class:hidden-only"; hiddenClass.name = "Hidden Class Value";
    hiddenLevel.reference.definitionId = "velvet:mechanics:class-level:hidden-only-1"; hiddenLevel.name = "Hidden Level Value";
    if (item.reference.kind !== "item" || currency.reference.kind !== "currency"
      || hiddenClass.reference.kind !== "class" || hiddenLevel.reference.kind !== "class-level") throw new Error("starter graph missing");
    asDefinitionKind(item, "item").mechanics.price.currency = currency.reference;
    asDefinitionKind(hiddenClass, "class").mechanics.levelRefs = [hiddenLevel.reference];
    asDefinitionKind(hiddenLevel, "class-level").mechanics.classRef = hiddenClass.reference;
    if (enemy?.reference.kind !== "enemy-template") throw new Error("starter enemy missing");
    asDefinitionKind(enemy, "enemy-template").private.hiddenRefs = [ability.reference, spell.reference, item.reference, hiddenClass.reference];
    catalog.definitions.push(ability, spell, item, currency, hiddenClass, hiddenLevel);
  }, "velvet:private-reachability");
}

function seedRoles(): string {
  const repo = createRepository({ dataDir: dataDir(), clock: { now: () => new Date("2030-01-02T03:04:05.006Z") } });
  const campaign = repo.createCampaign("local-owner", { name: "Catalog campaign" });
  repo.close();
  const db = new DatabaseDriver(dbPath());
  for (const role of ["gm", "player", "observer"] as const) {
    db.prepare("INSERT INTO principals (id,display_name,is_local) VALUES (?,?,0)").run(role, role);
    db.prepare("INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,?,?)")
      .run(campaign.id, role, role, "2030-01-02T03:04:05.006Z");
  }
  db.close();
  return campaign.id;
}

describe("validated immutable content catalog", () => {
  it("validates and publishes the deep-frozen original mechanics starter atomically", () => {
    const campaignId = seedRoles();
    const now = vi.fn(() => new Date("2031-02-03T04:05:06.007Z"));
    const repo = createRepository({ dataDir: dataDir(), clock: { now } });
    expect(repo.validateContentCatalog(MECHANICS_STARTER_CATALOG)).toMatchObject({ valid: true,
      normalizedSummary: { totalDefinitions: 17, digest: MECHANICS_STARTER_CATALOG.manifest.digest } });
    const published = repo.installMechanicsStarterCatalog("local-owner");
    expect(published.publication).toMatchObject({ packId: MECHANICS_STARTER_PACK_ID,
      packVersion: MECHANICS_STARTER_PACK_VERSION, validationLevel: "validated-v1" });
    expect(published.definitions).toHaveLength(17);
    expect(repo.installMechanicsStarterCatalog("local-owner")).toEqual(published);
    expect(now).toHaveBeenCalledOnce();
    expect(Object.isFrozen(MECHANICS_STARTER_CATALOG)).toBe(true);
    const different = structuredClone(MECHANICS_STARTER_CATALOG) as unknown as { manifest: { name: string } };
    different.manifest.name = "Differing exact version";
    expect(() => repo.publishContentCatalog("local-owner", different)).toThrow("differing content catalog");
    const reusedKey = finalizeCatalog((catalog) => { catalog.manifest.name = "Different keyed publication"; }, "velvet:key-conflict");
    reusedKey.idempotencyKey = MECHANICS_STARTER_CATALOG.idempotencyKey;
    expect(() => repo.publishContentCatalog("local-owner", reusedKey)).toThrow("idempotency key conflicts");

    const resolution = repo.configureMechanicsStarterCatalog("local-owner", campaignId,
      { expectedRevision: 0, idempotencyKey: "starter-config" });
    expect(resolution.content).toMatchObject({ compatible: true, campaignId,
      contentPacks: [{ packId: MECHANICS_STARTER_PACK_ID, packVersion: MECHANICS_STARTER_PACK_VERSION }] });
    expect(repo.configureMechanicsStarterCatalog("local-owner", campaignId,
      { expectedRevision: 0, idempotencyKey: "starter-config" })).toEqual(resolution);
    repo.close();
  });

  it("keeps provenance and enemy-private fields structurally absent for players and observers", () => {
    const campaignId = seedRoles();
    const repo = createRepository({ dataDir: dataDir() });
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner", campaignId, { expectedRevision: 0, idempotencyKey: "starter-config" });
    for (const role of ["player", "observer"] as const) {
      const projection = repo.getCampaignContentCatalog(role, campaignId, MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)!;
      expect("provenance" in projection).toBe(false);
      const enemy = projection.definitions.find((definition) => definition.reference.kind === "enemy-template")!;
      expect("private" in enemy).toBe(false);
      expect(JSON.stringify(projection)).not.toContain("deterministic low-tier integration opponent");
    }
    const gm = repo.getCampaignContentCatalog("gm", campaignId, MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)!;
    expect(gm.definitions.find((definition) => definition.reference.kind === "enemy-template")).toHaveProperty("private");
    repo.close();
  });

  it("omits private-only reachable definitions and ignores poisoned hidden values for public roles", () => {
    const campaignId = seedRoles();
    const catalog = privateReachabilityCatalog();
    const repo = createRepository({ dataDir: dataDir() });
    repo.publishContentCatalog("local-owner", catalog);
    repo.configureCampaignCatalog("local-owner", campaignId, { rulesProfileId: catalog.manifest.compatibility.rulesProfileId,
      contentPacks: [{ packId: catalog.manifest.packId, packVersion: catalog.manifest.packVersion }],
      expectedRevision: 0, idempotencyKey: "private-catalog" });
    for (const role of ["player", "observer"] as const) {
      const projection = repo.getCampaignContentCatalog(role, campaignId, catalog.manifest.packId, catalog.manifest.packVersion)!;
      expect(JSON.stringify(projection)).not.toMatch(/Hidden (Ability|Spell|Item|Currency|Class|Level) Value/);
      expect(projection.definitions.some((definition) => definition.reference.definitionId.includes("hidden-only"))).toBe(false);
      expect(repo.listCampaignContentPackDefinitions(role, campaignId, { packId: catalog.manifest.packId,
        packVersion: catalog.manifest.packVersion }).some((definition) => definition.definitionId.includes("hidden-only"))).toBe(false);
    }
    expect(repo.listCampaignContentPackDefinitions("gm", campaignId, { packId: catalog.manifest.packId,
      packVersion: catalog.manifest.packVersion }).some((definition) => definition.definitionId.includes("hidden-only"))).toBe(true);
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER rpg_catalog_definitions_immutable_update");
    db.prepare(`UPDATE rpg_catalog_definitions SET definition_json='{"poisonedHidden":"definition"}',
      public_definition_json='{"poisonedHidden":"public"}' WHERE pack_id=? AND definition_id LIKE '%hidden-only'`)
      .run(catalog.manifest.packId);
    db.close();
    for (const role of ["player", "observer"] as const) {
      expect(() => repo.getCampaignContentCatalog(role, campaignId, catalog.manifest.packId, catalog.manifest.packVersion)).not.toThrow();
      expect(JSON.stringify(repo.getCampaignContentCatalog(role, campaignId, catalog.manifest.packId, catalog.manifest.packVersion))).not.toContain("poisonedHidden");
      expect(() => repo.listCampaignContentPackDefinitions(role, campaignId, { packId: catalog.manifest.packId,
        packVersion: catalog.manifest.packVersion })).not.toThrow();
    }
    expect(() => repo.getCampaignContentCatalog("gm", campaignId, catalog.manifest.packId, catalog.manifest.packVersion)).toThrow();
    repo.close();
  });

  it("keeps validated publications coherent through legacy v10 definition reads and exact campaign pins", () => {
    const campaignId = seedRoles();
    const repo = createRepository({ dataDir: dataDir() });
    repo.installMechanicsStarterCatalog("local-owner");
    expect(repo.listContentPackDefinitions("local-owner", { packId: MECHANICS_STARTER_PACK_ID,
      packVersion: MECHANICS_STARTER_PACK_VERSION }).map((definition) => definition.kind))
      .toEqual(["class", "race", "background", "item", "spell", "spell", "ability", "ability", "ability", "ability", "ability", "enemy"]);
    repo.configureMechanicsStarterCatalog("local-owner", campaignId, { expectedRevision: 0, idempotencyKey: "legacy-visible" });
    expect(repo.listCampaignContentPackDefinitions("player", campaignId, { packId: MECHANICS_STARTER_PACK_ID,
      packVersion: MECHANICS_STARTER_PACK_VERSION })).toHaveLength(12);
    repo.close();
  });

  it.each([
    ["public JSON", `DROP TRIGGER rpg_catalog_visibility_immutable_update;
      UPDATE rpg_catalog_definition_visibility SET public_definition_json='{"forged":"legacy-leak"}'
      WHERE kind='ability' AND definition_id='velvet:mechanics:ability:steady-strike'`],
    ["row digest", `DROP TRIGGER rpg_catalog_visibility_immutable_update;
      UPDATE rpg_catalog_definition_visibility SET row_digest='${"a".repeat(64)}'
      WHERE kind='ability' AND definition_id='velvet:mechanics:ability:steady-strike'`],
    ["aggregate digest", `DROP TRIGGER rpg_catalog_attestations_immutable_update;
      UPDATE rpg_catalog_publication_attestations SET public_projection_digest='${"b".repeat(64)}'`],
  ])("attests legacy campaign reads before trusting forged %s",(_label,corruption)=>{
    const campaignId=seedRoles();const repo=createRepository({dataDir:dataDir()});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner",campaignId,{expectedRevision:0,idempotencyKey:"legacy-attestation"});
    const db=new DatabaseDriver(dbPath());db.exec(corruption);db.close();
    const pack={packId:MECHANICS_STARTER_PACK_ID,packVersion:MECHANICS_STARTER_PACK_VERSION};
    const reference={...pack,kind:"ability" as const,definitionId:"velvet:mechanics:ability:steady-strike"};
    for(const role of ["local-owner","gm"])
      expect(()=>repo.listCampaignContentPackDefinitions(role,campaignId,pack)).toThrow(/attestation|definition/);
    for(const role of ["player","observer"]){
      expect(repo.listCampaignContentPackDefinitions(role,campaignId,pack)).toEqual([]);
      expect(repo.getCampaignContentPackDefinition(role,campaignId,reference)).toBeNull();
    }
    repo.close();
  });

  it("validates contiguous uniquely-owned class levels and deterministic dependency cycles", () => {
    const gap = finalizeCatalog((catalog) => {
      const klass = catalog.definitions.find((definition) => definition.reference.kind === "class");
      const level = structuredClone(catalog.definitions.find((definition) => definition.reference.kind === "class-level")!);
      if (klass?.reference.kind !== "class" || level.reference.kind !== "class-level") throw new Error("starter class missing");
      level.reference.definitionId = "velvet:mechanics:class-level:lantern-warden-5";
      asDefinitionKind(level, "class-level").mechanics.level = 5;
      asDefinitionKind(klass, "class").mechanics.levelRefs.push(level.reference);
      catalog.definitions.push(level);
    });
    const orphan = finalizeCatalog((catalog) => {
      const level = structuredClone(catalog.definitions.find((definition) => definition.reference.kind === "class-level")!);
      if (level.reference.kind !== "class-level") throw new Error("starter level missing");
      level.reference.definitionId = "velvet:mechanics:class-level:orphan-2";
      asDefinitionKind(level, "class-level").mechanics.level = 2;
      catalog.definitions.push(level);
    });
    const cycle = finalizeCatalog((catalog) => {
      const enemy = catalog.definitions.find((definition) => definition.reference.kind === "enemy-template");
      if (enemy?.reference.kind !== "enemy-template") throw new Error("starter enemy missing");
      asDefinitionKind(enemy, "enemy-template").private.hiddenRefs = [enemy.reference];
    });
    const wrongOwner = finalizeCatalog((catalog) => {
      const level = catalog.definitions.find((definition) => definition.reference.kind === "class-level");
      if (level?.reference.kind !== "class-level") throw new Error("starter level missing");
      asDefinitionKind(level, "class-level").mechanics.classRef.definitionId = "velvet:mechanics:class:wrong-owner";
    });
    const duplicateOwner = finalizeCatalog((catalog) => {
      const klass = catalog.definitions.find((definition) => definition.reference.kind === "class");
      if (klass?.reference.kind !== "class") throw new Error("starter class missing");
      asDefinitionKind(klass, "class").mechanics.levelRefs.push(
        structuredClone(asDefinitionKind(klass, "class").mechanics.levelRefs[0]!),
      );
    });
    const repo = createRepository({ dataDir: dataDir() });
    expect(repo.validateContentCatalog(gap).issues.map(({ code, path }) => `${code}:${path}`))
      .toContain(`incomplete-starter:definitions.class:velvet:mechanics:class:lantern-warden.level.4`);
    expect(repo.validateContentCatalog(orphan).issues.map((issue) => issue.code)).toContain("missing-reference");
    expect(repo.validateContentCatalog(wrongOwner).issues.map((issue) => issue.code)).toContain("wrong-reference-kind");
    expect(repo.validateContentCatalog(duplicateOwner).issues.map((issue) => issue.code)).toContain("duplicate-definition");
    const first = repo.validateContentCatalog(cycle);
    expect(first.issues.map((issue) => issue.code)).toContain("dependency-cycle");
    expect(repo.validateContentCatalog(cycle)).toEqual(first);
    repo.close();
  });

  it("rejects progression choice IDs reused across levels and duplicate option identities",()=>{
    const reused=finalizeCatalog((catalog)=>{const levels=catalog.definitions.filter((definition)=>definition.reference.kind==="class-level");
      const level2=levels.find((definition)=>definition.reference.kind==="class-level"&&(definition as any).mechanics.level===2) as any;
      const level3=levels.find((definition)=>definition.reference.kind==="class-level"&&(definition as any).mechanics.level===3) as any;
      level3.mechanics.progressionChoices=[structuredClone(level2.mechanics.progressionChoices[0])];});
    expect(createRepository({dataDir:dataDir()}).validateContentCatalog(reused).issues.map((issue)=>issue.message))
      .toContain("progression choice IDs must be unique across the selected class progression");
    const duplicateOption=finalizeCatalog((catalog)=>{const level=catalog.definitions.find((definition)=>definition.reference.kind==="class-level"&&(definition as any).mechanics.level===2) as any;
      level.mechanics.progressionChoices[0].options[1]=structuredClone(level.mechanics.progressionChoices[0].options[0]);});
    expect(createRepository({dataDir:dataDir()}).validateContentCatalog(duplicateOption).issues.some((issue)=>issue.message.includes("options must be unique"))).toBe(true);
  });

  it("reads only the public sidecar for a player even when private storage is poisoned", () => {
    const campaignId = seedRoles();
    const repo = createRepository({ dataDir: dataDir() });
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner", campaignId, { expectedRevision: 0, idempotencyKey: "starter-config" });
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER rpg_catalog_definitions_immutable_update");
    db.prepare(`UPDATE rpg_catalog_definitions SET definition_json='{"privateSecret":"poison"}'
      WHERE pack_id=? AND pack_version=? AND kind='enemy-template'`).run(MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION);
    db.close();
    expect(() => repo.getCampaignContentCatalog("player", campaignId, MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)).not.toThrow();
    expect(JSON.stringify(repo.getCampaignContentCatalog("player", campaignId, MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION))).not.toContain("poison");
    expect(() => repo.getCampaignContentCatalog("gm", campaignId, MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)).toThrow();
    repo.close();
  });

  it("rejects paths, unsupported mechanics, missing references, and rolls back failed complete validation", () => {
    const repo = createRepository({ dataDir: dataDir() });
    for (const poisoned of [
      { ...MECHANICS_STARTER_CATALOG, path: "/tmp/catalog.json" },
      { ...MECHANICS_STARTER_CATALOG, url: "https://example.invalid/catalog" },
      { ...MECHANICS_STARTER_CATALOG, script: "return 1" },
      { ...MECHANICS_STARTER_CATALOG, formula: "level * 2" },
    ]) expect(repo.validateContentCatalog(poisoned).valid).toBe(false);
    const missing = structuredClone(MECHANICS_STARTER_CATALOG) as unknown as { definitions: Array<(typeof MECHANICS_STARTER_CATALOG.definitions)[number]> };
    missing.definitions = missing.definitions.filter((definition) => definition.reference.kind !== "currency");
    const report = repo.validateContentCatalog(missing);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("missing-reference");
    expect(() => repo.publishContentCatalog("local-owner", missing)).toThrow("validation failed");
    expect(repo.listContentCatalogPublications("local-owner")).toEqual([]);
    repo.close();
  });

  it("pages validated publications with a bounded opaque cursor without changing the legacy list", () => {
    const alpha = finalizeCatalog((catalog) => { catalog.manifest.name = "Alpha catalog"; }, "velvet:alpha");
    const beta = finalizeCatalog((catalog) => { catalog.manifest.name = "Beta catalog"; }, "velvet:beta");
    const repo = createRepository({ dataDir: dataDir() });
    repo.publishContentCatalog("local-owner", beta);
    repo.publishContentCatalog("local-owner", alpha);

    expect(repo.listContentCatalogPublications("local-owner").map((publication) => publication.packId))
      .toEqual(["velvet:alpha", "velvet:beta"]);
    const first = repo.listContentCatalogPublicationPage("local-owner", { status: "validated", limit: 1 });
    expect(first.publications.map((publication) => publication.packId)).toEqual(["velvet:alpha"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = repo.listContentCatalogPublicationPage("local-owner", { status: "validated", cursor: first.nextCursor!, limit: 1 });
    expect(second.publications.map((publication) => publication.packId)).toEqual(["velvet:beta"]);
    expect(second.nextCursor).toBeNull();
    expect(repo.transaction((unitOfWork) => unitOfWork.listContentCatalogPublicationPage("local-owner", {
      status: "validated", limit: 100,
    }))).toMatchObject({ publications: [{ packId: "velvet:alpha" }, { packId: "velvet:beta" }], nextCursor: null });
    expect(repo.listContentCatalogPublicationPage("player", { status: "validated", limit: 1 }))
      .toEqual({ publications: [], nextCursor: null });
    for (const input of [
      { status: "legacy", limit: 1 }, { status: "validated", limit: 0 },
      { status: "validated", limit: 101 }, { status: "validated", cursor: "not-a-cursor" },
    ]) expect(() => repo.listContentCatalogPublicationPage("local-owner", input as any)).toThrow(/invalid content catalog publication/);
    repo.close();
  });

  it("enforces application/campaign ownership and factory lifecycle and nesting guards", () => {
    const campaignId = seedRoles();
    const repo = createRepository({ dataDir: dataDir() });
    expect(() => repo.publishContentCatalog("player", MECHANICS_STARTER_CATALOG)).toThrow("application owner");
    expect(() => repo.configureCampaignCatalog("gm", campaignId, { rulesProfileId: "x", contentPacks: [],
      expectedRevision: 0, idempotencyKey: "denied" })).toThrow("campaign owner");
    expect(() => repo.transaction(() => repo.installMechanicsStarterCatalog("local-owner"))).toThrow("cannot run inside");
    repo.close();
    expect(() => repo.validateContentCatalog(MECHANICS_STARTER_CATALOG)).toThrow("repository is closed");
  });

  it("changes exact compatible pins with revisioned idempotent immutable receipts", () => {
    const campaignId = seedRoles();
    const second = finalizeCatalog((catalog) => { catalog.manifest.name = "Second compatible catalog"; }, "velvet:mechanics-second");
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2031-01-01T00:00:00.000Z"))
      .mockReturnValueOnce(new Date("2031-01-01T00:00:01.000Z"))
      .mockReturnValueOnce(new Date("2031-01-01T00:00:02.000Z"))
      .mockReturnValueOnce(new Date("2031-01-01T00:00:03.000Z"));
    const repo = createRepository({ dataDir: dataDir(), clock: { now } });
    repo.installMechanicsStarterCatalog("local-owner");
    repo.publishContentCatalog("local-owner", second);
    const firstInput = { rulesProfileId: MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
      contentPacks: [{ packId: MECHANICS_STARTER_PACK_ID, packVersion: MECHANICS_STARTER_PACK_VERSION }],
      expectedRevision: 0, idempotencyKey: "catalog-change-one" };
    const first = repo.configureCampaignCatalog("local-owner", campaignId, firstInput);
    expect(first.receipt).toMatchObject({ revisionBefore: 0, revisionAfter: 1, commandId: "catalog-change-one" });
    expect(repo.configureCampaignCatalog("local-owner", campaignId, firstInput)).toEqual(first);
    expect(repo.getCampaignCatalogReceipt("player", campaignId, "catalog-change-one")).toEqual(first.receipt);
    expect(() => repo.configureCampaignCatalog("local-owner", campaignId, { ...firstInput,
      contentPacks: [{ packId: second.manifest.packId, packVersion: second.manifest.packVersion }] }))
      .toThrow("idempotency key conflicts");
    expect(() => repo.configureCampaignCatalog("local-owner", campaignId, { ...firstInput,
      idempotencyKey: "catalog-stale" })).toThrow("revision is stale");
    const secondResult = repo.configureCampaignCatalog("local-owner", campaignId, {
      rulesProfileId: second.manifest.compatibility.rulesProfileId,
      contentPacks: [{ packId: second.manifest.packId, packVersion: second.manifest.packVersion }],
      expectedRevision: 1, idempotencyKey: "catalog-change-two",
    });
    expect(secondResult.receipt).toMatchObject({ revisionBefore: 1, revisionAfter: 2 });
    expect(secondResult.content.contentPacks).toEqual([{ packId: second.manifest.packId,
      packVersion: second.manifest.packVersion, digest: second.manifest.digest }]);
    repo.close();
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(campaignId)).toEqual({ administration_revision: 2 });
    expect(db.prepare("SELECT COUNT(*) count FROM campaign_catalog_commands").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) count FROM campaign_catalog_events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) count FROM campaign_catalog_receipts").get()).toEqual({ count: 2 });
    db.close();
    const immutable = new DatabaseDriver(dbPath());
    for (const statement of [
      "UPDATE campaign_catalog_commands SET request_digest=replace(request_digest,'a','b')",
      "DELETE FROM campaign_catalog_events",
      "INSERT OR REPLACE INTO campaign_catalog_receipts SELECT * FROM campaign_catalog_receipts LIMIT 1",
      "UPDATE campaign_catalog_current_selections SET selection_digest=replace(selection_digest,'a','b')",
      "DELETE FROM campaign_catalog_current_pins",
    ]) expect(() => immutable.exec(statement)).toThrow(/immutable|open catalog command|cannot update|one exact open command|receipt result is inconsistent|velvet_campaign_delete_authorized/);
    immutable.close();
  });

  it("merges catalog revision one through export, dry-run, import, receipts, and the next administration revision", () => {
    const campaignId=seedRoles(); const repo=createRepository({dataDir:dataDir()});
    repo.installMechanicsStarterCatalog("local-owner");
    const configured=repo.configureMechanicsStarterCatalog("local-owner",campaignId,{expectedRevision:0,idempotencyKey:"portable-catalog"});
    expect(repo.listCampaignAdministrationEvents("player",campaignId).map((event)=>[event.type,event.revision]))
      .toEqual([["catalog_configured",1]]);
    expect(repo.getCampaignAdministrationReceipt("player",campaignId,"portable-catalog")).toMatchObject({
      type:"catalog_configured",revisionBefore:0,revisionAfter:1,
    });
    const exported=repo.createCampaignExport("local-owner",campaignId,{expectedRevision:1,idempotencyKey:"catalog-export"});
    expect(exported.value.package.records.administration.events.map((event)=>[event.type,event.revision]))
      .toEqual([["catalog_configured",1]]);
    const dry=repo.dryRunCampaignImport("local-owner",exported.value.package);
    expect(dry.report.valid).toBe(true);
    const imported=repo.applyCampaignImport("local-owner",{dryRun:dry,package:exported.value.package,idempotencyKey:"catalog-import"});
    expect(repo.listCampaignAdministrationEvents("local-owner",imported.value.id).map((event)=>[event.type,event.revision]))
      .toEqual([["catalog_configured",1],["import_applied",2]]);
    expect(repo.getCampaignAdministrationReceipt("local-owner",imported.value.id,configured.receipt.commandId)).toMatchObject({
      type:"catalog_configured",revisionAfter:1,
    });
    expect(repo.resolveCampaignCatalog("local-owner",imported.value.id)?.contentPacks).toEqual(configured.content.contentPacks);
    repo.close();
  });

  it("rejects malformed canonical owner graphs before catalog mutation", () => {
    const campaignId = seedRoles();
    const repo = createRepository({ dataDir: dataDir() });
    repo.installMechanicsStarterCatalog("local-owner");
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP INDEX idx_campaign_memberships_one_owner");
    db.prepare("INSERT INTO principals (id,display_name,is_local) VALUES ('second-owner','Second owner',0)").run();
    db.prepare(`INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at)
      VALUES (?,'second-owner','owner','2030-01-02T03:04:05.006Z')`).run(campaignId);
    db.close();
    expect(() => repo.configureMechanicsStarterCatalog("local-owner", campaignId,
      { expectedRevision: 0, idempotencyKey: "malformed-owner" })).toThrow("malformed campaign ownership");
    repo.close();
    const inspect = new DatabaseDriver(dbPath(), { readonly: true });
    expect(inspect.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(campaignId)).toEqual({ administration_revision: 0 });
    expect(inspect.prepare("SELECT COUNT(*) count FROM campaign_catalog_commands").get()).toEqual({ count: 0 });
    inspect.close();
  });

  it("SQL rejects stale, mismatched, and unbound catalog mutation provenance", () => {
    const campaignId=seedRoles();
    const repo=createRepository({dataDir:dataDir()});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureCampaignContent("local-owner",campaignId,{
      rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
      contentPacks:[{packId:MECHANICS_STARTER_PACK_ID,packVersion:MECHANICS_STARTER_PACK_VERSION}],
    });
    repo.close();
    const db=new DatabaseDriver(dbPath());
    const insert=`INSERT INTO campaign_catalog_commands
      (campaign_id,command_id,idempotency_key,actor_principal_id,expected_revision,request_digest,target_selection_digest,requested_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`;
    const args=(id:string,actor:string,revision:number,digest="a".repeat(64))=>[campaignId,id,id,actor,revision,"b".repeat(64),digest,
      canonicalCatalogJson({rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
        contentPacks:[{packId:MECHANICS_STARTER_PACK_ID,packVersion:MECHANICS_STARTER_PACK_VERSION}],
        expectedRevision:revision,idempotencyKey:id}),
      "2031-01-01T00:00:00.000Z"];
    expect(()=>db.prepare(insert).run(...args("stale-sql","local-owner",1))).toThrow("canonical owner at current revision");
    expect(()=>db.prepare(insert).run(...args("wrong-actor","gm",0))).toThrow("canonical owner at current revision");
    db.prepare(insert).run(...args("open-sql","local-owner",0));
    expect(()=>db.prepare(`INSERT INTO campaign_catalog_current_selections VALUES (?,?,?,?,?,?)`).run(campaignId,
      MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,"a".repeat(64),"local-owner","2031-01-01T00:00:00.000Z","open-sql"))
      .toThrow("bind one exact open command");
    db.prepare("UPDATE campaigns SET administration_revision=1,updated_at='2031-01-01T00:00:00.000Z' WHERE id=?").run(campaignId);
    expect(()=>db.prepare(`INSERT INTO campaign_catalog_current_selections VALUES (?,?,?,?,?,?)`).run(campaignId,
      MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,"c".repeat(64),"local-owner","2031-01-01T00:00:00.000Z","open-sql"))
      .toThrow("bind one exact open command");
    db.prepare(`INSERT INTO campaign_catalog_current_selections VALUES (?,?,?,?,?,?)`).run(campaignId,
      MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,"a".repeat(64),"local-owner","2031-01-01T00:00:00.000Z","open-sql");
    expect(()=>db.prepare(`INSERT INTO campaign_catalog_events VALUES (?,?,?,?,?,?,?)`).run(campaignId,"open-sql","forged-event",0,1,
      "2031-01-01T00:00:00.000Z",JSON.stringify({content:{campaignId,
        rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId}})))
      .toThrow(/event provenance is inconsistent|exact proposal/);
    expect(()=>db.prepare(`INSERT INTO campaign_administration_commands
      (command_id,campaign_id,idempotency_key,actor_principal_id,expected_revision,type,payload,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run("open-sql",campaignId,"different-key","local-owner",1,"campaign_renamed","{}","2031-01-01T00:00:00.000Z"))
      .toThrow("identity already belongs to catalog history");
    db.close();
    const inspect=createRepository({dataDir:dataDir()});
    expect(()=>inspect.resolveCampaignCatalog("player",campaignId)).toThrow("audit is incomplete");
    inspect.close();
  });

  it("SQL binds authoritative pins, digests, proposed event identity, public data, and receipt exactly",()=>{
    const campaignId=seedRoles();const repo=createRepository({dataDir:dataDir()});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureCampaignContent("local-owner",campaignId,{rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
      contentPacks:[{packId:MECHANICS_STARTER_PACK_ID,packVersion:MECHANICS_STARTER_PACK_VERSION}]});repo.close();
    const db=new DatabaseDriver(dbPath()),commandId="sql-complete",eventId="sql-proposed-event",at="2032-01-01T00:00:00.000Z";
    const insertCommand=db.prepare(`INSERT INTO campaign_catalog_commands
      (campaign_id,command_id,idempotency_key,actor_principal_id,expected_revision,request_digest,target_selection_digest,requested_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const emptyRequest=canonicalCatalogJson({contentPacks:[],expectedRevision:0,idempotencyKey:"sql-empty",
      rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId});
    expect(()=>insertCommand.run(campaignId,"sql-empty","sql-empty","local-owner",0,"a".repeat(64),"b".repeat(64),emptyRequest,at))
      .toThrow("canonical authoritative publications");
    const identifiers=[{packId:MECHANICS_STARTER_PACK_ID,packVersion:MECHANICS_STARTER_PACK_VERSION}];
    const requested=canonicalCatalogJson({contentPacks:identifiers,expectedRevision:0,idempotencyKey:commandId,
      rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId});
    const selectionDigest=createHash("sha256").update(canonicalCatalogJson({rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,
      contentPacks:identifiers})).digest("hex");
    insertCommand.run(campaignId,commandId,commandId,"local-owner",0,"c".repeat(64),selectionDigest,requested,at);
    const content={campaignId,compatible:true,contentPacks:[{digest:MECHANICS_STARTER_CATALOG.manifest.digest,...identifiers[0]}],issues:[],
      rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId};
    const publicData=canonicalCatalogJson({content});
    const result=canonicalCatalogJson({campaignId,commandId,configuredAt:at,content,idempotencyKey:commandId,revisionAfter:1,revisionBefore:0});
    const insertProposal=db.prepare(`INSERT INTO campaign_catalog_command_provenance_v18
      (campaign_id,command_id,proposed_event_id,proposed_event_type,actor_principal_id,proposed_public_data,proposed_result_json)
      VALUES (?,?,?,'catalog_configured',?,?,?)`);
    const fakeDigestData=canonicalCatalogJson({content:{...content,contentPacks:[{...content.contentPacks[0],digest:"d".repeat(64)}]}});
    expect(()=>insertProposal.run(campaignId,commandId,eventId,"gm",publicData,result)).toThrow("provenance is inconsistent");
    expect(()=>insertProposal.run(campaignId,commandId,eventId,"local-owner",fakeDigestData,result)).toThrow("provenance is inconsistent");
    insertProposal.run(campaignId,commandId,eventId,"local-owner",publicData,result);
    db.prepare("UPDATE campaigns SET administration_revision=1,updated_at=? WHERE id=?").run(at,campaignId);
    db.prepare(`INSERT INTO campaign_catalog_current_selections VALUES (?,?,?,?,?,?)`).run(campaignId,
      MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,selectionDigest,"local-owner",at,commandId);
    db.prepare(`INSERT INTO campaign_catalog_current_pins VALUES (?,?,?,?,?)`).run(campaignId,MECHANICS_STARTER_PACK_ID,
      MECHANICS_STARTER_PACK_VERSION,0,commandId);
    const insertEvent=db.prepare(`INSERT INTO campaign_catalog_events VALUES (?,?,?,?,?,?,?)`);
    expect(()=>insertEvent.run(campaignId,commandId,"fake-event-id",0,1,at,publicData)).toThrow("exact proposal");
    expect(()=>insertEvent.run(campaignId,commandId,eventId,0,1,at,canonicalCatalogJson({content:{...content,contentPacks:[]}})))
      .toThrow(/exact proposal|event provenance/);
    insertEvent.run(campaignId,commandId,eventId,0,1,at,publicData);
    const insertReceipt=db.prepare(`INSERT INTO campaign_catalog_receipts VALUES (?,?,?,?,?,?)`);
    expect(()=>insertReceipt.run(campaignId,commandId,eventId,0,1,canonicalCatalogJson({...JSON.parse(result),configuredAt:"2033-01-01T00:00:00.000Z"})))
      .toThrow(/exact proposal|receipt result/);
    insertReceipt.run(campaignId,commandId,eventId,0,1,result);
    expect(db.prepare("SELECT COUNT(*) count FROM campaign_catalog_receipts WHERE campaign_id=?").get(campaignId)).toEqual({count:1});
    db.close();
    const retryRepo=createRepository({dataDir:dataDir()});
    const exact={rulesProfileId:MECHANICS_STARTER_CATALOG.manifest.compatibility.rulesProfileId,contentPacks:identifiers,
      expectedRevision:0,idempotencyKey:commandId};
    expect(retryRepo.configureCampaignCatalog("local-owner",campaignId,exact).receipt).toEqual(JSON.parse(result));
    expect(()=>retryRepo.configureCampaignCatalog("local-owner",campaignId,{...exact,expectedRevision:1}))
      .toThrow("idempotency key conflicts");
    retryRepo.close();
  });

  it("fails loudly on forged publication graphs for authorized callers and masks outsiders", () => {
    const campaignId = seedRoles();
    const repo = createRepository({ dataDir: dataDir() });
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner", campaignId, { expectedRevision: 0, idempotencyKey: "integrity-config" });
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER rpg_content_pack_publications_immutable_update");
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE rpg_content_pack_publications SET validation_report_json='{"valid":true,"issues":[],"normalizedSummary":{"totalDefinitions":999,"counts":[],"digest":"${"a".repeat(64)}"}}'
      WHERE pack_id=?`).run(MECHANICS_STARTER_PACK_ID);
    db.close();
    expect(() => repo.getContentCatalogForOwner("local-owner", MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)).toThrow();
    expect(() => repo.getCampaignContentCatalog("player", campaignId, MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)).toThrow();
    expect(repo.getCampaignContentCatalog("missing-outsider", campaignId, MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)).toBeNull();
    repo.close();
  });

  it("cryptographically rejects forged public visibility sidecars while masking outsiders", () => {
    const campaignId=seedRoles();
    const repo=createRepository({dataDir:dataDir()});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner",campaignId,{expectedRevision:0,idempotencyKey:"sidecar-config"});
    const db=new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER rpg_catalog_visibility_immutable_update");
    db.prepare(`UPDATE rpg_catalog_definition_visibility SET public_definition_json='{"forged":"visible"}'
      WHERE pack_id=? AND kind='skill'`).run(MECHANICS_STARTER_PACK_ID);
    db.close();
    expect(()=>repo.getCampaignContentCatalog("player",campaignId,MECHANICS_STARTER_PACK_ID,MECHANICS_STARTER_PACK_VERSION)).toThrow("attestation");
    expect(repo.getCampaignContentCatalog("outsider",campaignId,MECHANICS_STARTER_PACK_ID,MECHANICS_STARTER_PACK_VERSION)).toBeNull();
    repo.close();
  });

  it("rejects incomplete persisted definition graphs while retaining outsider masking", () => {
    const campaignId = seedRoles();
    const repo = createRepository({ dataDir: dataDir() });
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner", campaignId, { expectedRevision: 0, idempotencyKey: "incomplete-config" });
    const db = new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER rpg_catalog_definitions_immutable_delete; DROP TRIGGER rpg_catalog_visibility_immutable_delete");
    db.prepare("DELETE FROM rpg_catalog_definition_visibility WHERE pack_id=? AND kind='skill'").run(MECHANICS_STARTER_PACK_ID);
    db.prepare("DELETE FROM rpg_catalog_definitions WHERE pack_id=? AND kind='skill'").run(MECHANICS_STARTER_PACK_ID);
    db.close();
    expect(() => repo.getContentCatalogForOwner("local-owner", MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)).toThrow();
    expect(() => repo.resolveCampaignCatalog("player", campaignId)).toThrow();
    expect(repo.getCampaignContentCatalog("outsider", campaignId, MECHANICS_STARTER_PACK_ID, MECHANICS_STARTER_PACK_VERSION)).toBeNull();
    repo.close();
  });

  it("blocks update, delete, append, and INSERT OR REPLACE for every sealed catalog row", () => {
    seedRoles();
    const repo = createRepository({ dataDir: dataDir() });
    repo.installMechanicsStarterCatalog("local-owner");
    const db = new DatabaseDriver(dbPath());
    const statements = [
      `UPDATE rpg_content_packs SET name='Changed' WHERE pack_id='${MECHANICS_STARTER_PACK_ID}'`,
      `INSERT OR REPLACE INTO rpg_content_packs SELECT * FROM rpg_content_packs WHERE pack_id='${MECHANICS_STARTER_PACK_ID}'`,
      `UPDATE rpg_content_pack_publications SET published_at='2031-01-01T00:00:00.000Z' WHERE pack_id='${MECHANICS_STARTER_PACK_ID}'`,
      `INSERT OR REPLACE INTO rpg_content_pack_publications SELECT * FROM rpg_content_pack_publications WHERE pack_id='${MECHANICS_STARTER_PACK_ID}'`,
      `DELETE FROM rpg_content_pack_publications WHERE pack_id='${MECHANICS_STARTER_PACK_ID}'`,
      `INSERT OR REPLACE INTO rpg_catalog_definitions SELECT * FROM rpg_catalog_definitions WHERE pack_id='${MECHANICS_STARTER_PACK_ID}' LIMIT 1`,
      `INSERT INTO rpg_catalog_definitions (pack_id,pack_version,kind,definition_id,definition_json,public_definition_json,dependencies_json)
        VALUES ('${MECHANICS_STARTER_PACK_ID}','${MECHANICS_STARTER_PACK_VERSION}','skill','appended','{}','{}','[]')`,
    ];
    for (const statement of statements) expect(() => db.exec(statement)).toThrow(/immutable|sealed/);
    db.close(); repo.close();
  });

  it("rolls back profile, definitions, seal, and publication on a late SQL failure", () => {
    createRepository({ dataDir: dataDir() }).close();
    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER fail_catalog_publication BEFORE INSERT ON rpg_content_pack_publications
      WHEN NEW.validation_level='validated-v1' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END`);
    db.close();
    const repo = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(() => repo.installMechanicsStarterCatalog("local-owner")).toThrow("injected publication failure");
    repo.close();
    const inspect = new DatabaseDriver(dbPath(), { readonly: true });
    expect(inspect.prepare("SELECT COUNT(*) count FROM rpg_rules_profiles").get()).toEqual({ count: 0 });
    expect(inspect.prepare("SELECT COUNT(*) count FROM rpg_content_packs").get()).toEqual({ count: 0 });
    expect(inspect.prepare("SELECT COUNT(*) count FROM rpg_catalog_definitions").get()).toEqual({ count: 0 });
    expect(inspect.prepare("SELECT COUNT(*) count FROM rpg_content_pack_publications").get()).toEqual({ count: 0 });
    inspect.close();
  });
});

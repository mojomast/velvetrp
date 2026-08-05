import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
  type CampaignCharacterCreationOptionsResponse,
  type CreateCampaignCharacterInput,
  type PrivilegedCampaignCharacterProjection,
} from "@velvet/contracts";
import {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
  createRepository,
} from "../src/repo/index.js";
import {
  createOriginalStarterCharacterCreationService,
  OriginalStarterCharacterCreationConflictError,
  OriginalStarterCharacterCreationUnavailableError,
  OriginalStarterCharacterPersonaUnavailableError,
} from "../src/content/originalStarterCharacterCreation.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const AT = "2036-01-02T03:04:05.006Z";

const options: CampaignCharacterCreationOptionsResponse = {
  campaignId: "campaign",
  personas: [{ characterId: "persona", name: "Persona", alreadyUsed: false }],
  starter: {
    rulesProfile: ORIGINAL_STARTER_RULES_PROFILE,
    pack: ORIGINAL_STARTER_PACK,
    race: ORIGINAL_STARTER_RACE,
    background: ORIGINAL_STARTER_BACKGROUND,
    class: { ...ORIGINAL_STARTER_CLASS, level: 1 },
  },
};

const projection: PrivilegedCampaignCharacterProjection = {
  campaignCharacter: { id: "cc", campaignId: "campaign", characterId: "persona", createdAt: AT, updatedAt: AT },
  sheet: {
    id: "sheet", campaignId: "campaign", campaignCharacterId: "cc",
    race: ORIGINAL_STARTER_RACE.reference, background: ORIGINAL_STARTER_BACKGROUND.reference,
    classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }], attributes: [], proficiencies: [], choices: [],
    createdAt: AT, updatedAt: AT,
  },
  actor: {
    id: "actor", campaignId: "campaign", campaignCharacterId: "cc", sheetId: "sheet",
    kind: "player-character", control: "principal", controllerPrincipalId: "local-owner", privateNotes: null,
    createdAt: AT, updatedAt: AT,
  },
};

const lockedResult = { projection, personaDisplayName: "Persona" };

const originalStarterInput: CreateCampaignCharacterInput = {
  campaignId: "campaign",
  characterId: "persona",
  controllerPrincipalId: "local-owner",
  race: ORIGINAL_STARTER_RACE.reference,
  background: ORIGINAL_STARTER_BACKGROUND.reference,
  classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
  attributes: [],
  proficiencies: [],
  choices: [],
};

describe("original starter campaign-character creation service", () => {
  it("preflights once and delegates one exact atomic specialized create", () => {
    const getOptions = vi.fn(() => options);
    const create = vi.fn(() => lockedResult);
    const service = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: getOptions,
      createOriginalStarterCampaignCharacter: create,
    });
    expect(service.create("campaign", { characterId: "persona" })).toEqual({
      character: { id: "cc", characterId: "persona", name: "Persona" },
    });
    expect(getOptions).toHaveBeenCalledOnce();
    expect(getOptions).toHaveBeenCalledWith("local-owner", "campaign");
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith("local-owner", {
      campaignId: "campaign", characterId: "persona", controllerPrincipalId: "local-owner",
      race: ORIGINAL_STARTER_RACE.reference, background: ORIGINAL_STARTER_BACKGROUND.reference,
      classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
      attributes: [], proficiencies: [], choices: [],
    });
  });

  it("validates campaign and reduced request before repository access", () => {
    const repository = { getCampaignCharacterCreationOptions: vi.fn(), createOriginalStarterCampaignCharacter: vi.fn() };
    const service = createOriginalStarterCharacterCreationService(repository);
    expect(() => service.create("bad campaign", { characterId: "persona" })).toThrow();
    expect(() => service.create("campaign", { characterId: "" })).toThrow();
    expect(repository.getCampaignCharacterCreationOptions).not.toHaveBeenCalled();
  });

  it("classifies null, missing persona, and preflight duplicate without writing", () => {
    const create = vi.fn();
    expect(() => createOriginalStarterCharacterCreationService({
       getCampaignCharacterCreationOptions: () => null, createOriginalStarterCampaignCharacter: create,
    }).create("campaign", { characterId: "persona" })).toThrow(OriginalStarterCharacterCreationUnavailableError);
    expect(() => createOriginalStarterCharacterCreationService({
       getCampaignCharacterCreationOptions: () => ({ ...options, personas: [] }), createOriginalStarterCampaignCharacter: create,
    }).create("campaign", { characterId: "persona" })).toThrow(OriginalStarterCharacterPersonaUnavailableError);
    expect(() => createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: () => ({ ...options,
         personas: [{ ...options.personas[0]!, alreadyUsed: true }] }), createOriginalStarterCampaignCharacter: create,
    }).create("campaign", { characterId: "persona" })).toThrow(OriginalStarterCharacterCreationConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [new CampaignCharacterCreationUnavailableError(), OriginalStarterCharacterCreationUnavailableError],
    [new CampaignCharacterPersonaUnavailableError(), OriginalStarterCharacterPersonaUnavailableError],
    [new CampaignCharacterCreationConflictError(), OriginalStarterCharacterCreationConflictError],
  ])("maps only repository narrow failure %#", (failure, expected) => {
    const service = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: () => options,
      createOriginalStarterCampaignCharacter: () => { throw failure; },
    });
    expect(() => service.create("campaign", { characterId: "persona" })).toThrow(expected);
  });

  it("classifies a preflight/write duplicate race from the locked specialized write without retry", () => {
    const create = vi.fn((): typeof lockedResult => {
      throw new CampaignCharacterCreationConflictError();
    });
    const service = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: () => options,
      createOriginalStarterCampaignCharacter: create,
    });
    expect(() => service.create("campaign", { characterId: "persona" }))
      .toThrow(OriginalStarterCharacterCreationConflictError);
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not classify typed-error lookalikes or malformed output", () => {
    const lookalike = Object.assign(new Error("lookalike"), { code: "CAMPAIGN_CHARACTER_CREATION_CONFLICT" });
    const service = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: () => options,
      createOriginalStarterCampaignCharacter: () => { throw lookalike; },
    });
    expect(() => service.create("campaign", { characterId: "persona" })).toThrow(lookalike);
    const malformed = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: () => options,
      createOriginalStarterCampaignCharacter: () => ({ ...lockedResult, projection: { ...projection,
        actor: { ...projection.actor, controllerPrincipalId: "other" } } }),
    });
    expect(() => malformed.create("campaign", { characterId: "persona" }))
      .toThrow("original starter character creation output is malformed");

    const malformedName = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: () => options,
      createOriginalStarterCampaignCharacter: () => ({ ...lockedResult, personaDisplayName: "marker\ud800" }),
    });
    expect(() => malformedName.create("campaign", { characterId: "persona" }))
      .toThrow();

    const astralName = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: () => options,
      createOriginalStarterCampaignCharacter: () => ({ ...lockedResult, personaDisplayName: "Astral \u{1F9D9}" }),
    });
    expect(astralName.create("campaign", { characterId: "persona" }).character.name).toBe("Astral \u{1F9D9}");
  });

  it("integrates with reviewed setup and the atomic specialized repository write", () => {
    const ids = ["campaign", "timeline", "cc", "sheet", "actor"];
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId: () => ids.shift()! }, clock: { now: () => new Date(AT) } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    db.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,safe_word,fictional_confirmed,is_real_person,created_at)
      VALUES ('persona','Persona',30,'hero','fictional','anchor',1,0,?)`).run(AT);
    db.close();

    const created = createOriginalStarterCharacterCreationService(repository)
      .create("campaign", { characterId: "persona" });
    expect(created).toEqual({ character: { id: "cc", characterId: "persona", name: "Persona" } });
    repository.close();
  });

  it("returns the current durable persona name captured by the locked create, not the preflight name", () => {
    const ids = ["campaign", "timeline", "cc", "sheet", "actor"];
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId: () => ids.shift()! }, clock: { now: () => new Date(AT) } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const databasePath = path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");
    const db = new DatabaseDriver(databasePath);
    db.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,safe_word,fictional_confirmed,is_real_person,created_at)
      VALUES ('persona','Preflight Persona',30,'hero','fictional','anchor',1,0,?)`).run(AT);
    db.close();

    const getOptions = vi.fn(repository.getCampaignCharacterCreationOptions);
    const lockedCreate = vi.fn((actor: string,
      input: Parameters<typeof repository.createOriginalStarterCampaignCharacter>[1]) => {
      // This commits after the options snapshot and immediately before the
      // repository acquires the creation lock, deterministically modeling the race.
      const rename = new DatabaseDriver(databasePath);
      rename.prepare("UPDATE characters SET name = 'Committed Current Persona' WHERE id = 'persona'").run();
      rename.close();
      return repository.createOriginalStarterCampaignCharacter(actor, input);
    });
    const created = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: getOptions,
      createOriginalStarterCampaignCharacter: lockedCreate,
    }).create("campaign", { characterId: "persona" });

    expect(created).toEqual({
      character: { id: "cc", characterId: "persona", name: "Committed Current Persona" },
    });
    expect(getOptions).toHaveBeenCalledOnce();
    expect(lockedCreate).toHaveBeenCalledOnce();
    const verify = new DatabaseDriver(databasePath, { readonly: true });
    expect(verify.prepare("SELECT name FROM characters WHERE id = 'persona'").get())
      .toEqual({ name: "Committed Current Persona" });
    expect((verify.prepare("SELECT COUNT(*) count FROM campaign_characters").get() as { count: number }).count).toBe(1);
    verify.close();
    repository.close();
  });

  it("leaves persona-name corruption introduced after preflight untyped and performs no write", () => {
    const ids = ["campaign", "timeline", "cc", "sheet", "actor"];
    const nextId = vi.fn(() => ids.shift()!);
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId }, clock: { now } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const databasePath = path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");
    const db = new DatabaseDriver(databasePath);
    db.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,safe_word,fictional_confirmed,is_real_person,created_at)
      VALUES ('persona','Preflight Persona',30,'hero','fictional','anchor',1,0,?)`).run(AT);
    db.close();
    const baseline = { ids: nextId.mock.calls.length, clocks: now.mock.calls.length };
    const lockedCreate = vi.fn((actor: string,
      input: Parameters<typeof repository.createOriginalStarterCampaignCharacter>[1]) => {
      const corrupt = new DatabaseDriver(databasePath);
      corrupt.prepare("UPDATE characters SET name = '   ' WHERE id = 'persona'").run();
      corrupt.close();
      return repository.createOriginalStarterCampaignCharacter(actor, input);
    });
    const service = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: repository.getCampaignCharacterCreationOptions,
      createOriginalStarterCampaignCharacter: lockedCreate,
    });

    let failure: unknown;
    try {
      service.create("campaign", { characterId: "persona" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OriginalStarterCharacterCreationConflictError);
    expect(failure).not.toBeInstanceOf(OriginalStarterCharacterCreationUnavailableError);
    expect(failure).not.toBeInstanceOf(OriginalStarterCharacterPersonaUnavailableError);
    expect(lockedCreate).toHaveBeenCalledOnce();
    expect(nextId).toHaveBeenCalledTimes(baseline.ids);
    expect(now).toHaveBeenCalledTimes(baseline.clocks);
    const verify = new DatabaseDriver(databasePath, { readonly: true });
    expect((verify.prepare("SELECT COUNT(*) count FROM campaign_characters").get() as { count: number }).count).toBe(0);
    verify.close();
    repository.close();
  });

  it("uses campaign GM authority without application-owner or campaign-owner dual authority", () => {
    const ids = ["campaign", "timeline", "cc", "sheet", "actor"];
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId: () => ids.shift()! }, clock: { now: () => new Date(AT) } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    db.prepare("INSERT INTO principals VALUES ('campaign-owner', 'Campaign owner', 0)").run();
    db.prepare("INSERT INTO principals VALUES ('application-owner', 'Application owner', 0)").run();
    db.prepare("UPDATE application_owner SET principal_id = 'application-owner'").run();
    db.transaction(() => {
      db.prepare("UPDATE campaign_memberships SET role = 'gm' WHERE campaign_id = 'campaign' AND principal_id = 'local-owner'").run();
      db.prepare("INSERT INTO campaign_memberships VALUES ('campaign', 'campaign-owner', 'owner', ?)").run(AT);
      db.prepare("UPDATE campaigns SET owner_principal_id = 'campaign-owner' WHERE id = 'campaign'").run();
    })();
    db.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,safe_word,fictional_confirmed,is_real_person,created_at)
      VALUES ('persona','Persona',30,'hero','fictional','anchor',1,0,?)`).run(AT);
    db.close();

    expect(createOriginalStarterCharacterCreationService(repository)
      .create("campaign", { characterId: "persona" }))
      .toEqual({ character: { id: "cc", characterId: "persona", name: "Persona" } });
    const verify = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"), { readonly: true });
    expect(verify.prepare("SELECT controller_principal_id FROM campaign_actor_private_state").get())
      .toEqual({ controller_principal_id: "local-owner" });
    verify.close();
    repository.close();
  });

  it("keeps a stale local owner without GM authority unavailable", () => {
    const ids = ["campaign", "timeline", "unused"];
    const nextId = vi.fn(() => ids.shift()!);
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE campaigns SET owner_principal_id = 'stale-owner' WHERE id = 'campaign'").run();
    db.close();
    const baseline = { ids: nextId.mock.calls.length, clocks: now.mock.calls.length };

    expect(() => createOriginalStarterCharacterCreationService(repository)
      .create("campaign", { characterId: "persona" }))
      .toThrow(OriginalStarterCharacterCreationUnavailableError);
    expect(nextId).toHaveBeenCalledTimes(baseline.ids);
    expect(now).toHaveBeenCalledTimes(baseline.clocks);
    repository.close();
  });

  it("leaves a malformed owner graph untyped for an attributable local GM", () => {
    const ids = ["campaign", "timeline"];
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId: () => ids.shift()! }, clock: { now: () => new Date(AT) } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    db.prepare("INSERT INTO principals VALUES ('campaign-owner', 'Campaign owner', 0)").run();
    db.transaction(() => {
      db.prepare("UPDATE campaign_memberships SET role = 'gm' WHERE campaign_id = 'campaign' AND principal_id = 'local-owner'").run();
      db.prepare("INSERT INTO campaign_memberships VALUES ('campaign', 'campaign-owner', 'owner', ?)").run(AT);
      db.prepare("UPDATE campaigns SET owner_principal_id = 'campaign-owner' WHERE id = 'campaign'").run();
    })();
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaigns SET owner_role = 'gm' WHERE id = 'campaign'").run();
    db.close();

    let failure: unknown;
    try {
      createOriginalStarterCharacterCreationService(repository).create("campaign", { characterId: "persona" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OriginalStarterCharacterCreationUnavailableError);
    expect(failure).not.toBeInstanceOf(OriginalStarterCharacterCreationConflictError);
    repository.close();
  });

  it("directly classifies a valid zero-pin starter configuration as a locked conflict", () => {
    const ids = ["campaign", "timeline", "unused"];
    const nextId = vi.fn(() => ids.shift()!);
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    db.prepare("DELETE FROM campaign_content_packs WHERE campaign_id = 'campaign'").run();
    db.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,safe_word,fictional_confirmed,is_real_person,created_at)
      VALUES ('persona','Persona',30,'hero','fictional','anchor',1,0,?)`).run(AT);
    db.close();
    const baseline = { ids: nextId.mock.calls.length, clocks: now.mock.calls.length };

    expect(() => repository.createOriginalStarterCampaignCharacter("local-owner", originalStarterInput))
      .toThrow(CampaignCharacterCreationConflictError);
    expect(nextId).toHaveBeenCalledTimes(baseline.ids);
    expect(now).toHaveBeenCalledTimes(baseline.clocks);
    repository.close();
  });

  it.each([
    ["a valid zero-pin configuration", (db: DatabaseDriver.Database) => {
      db.prepare("DELETE FROM campaign_content_packs WHERE campaign_id = 'campaign'").run();
    }],
    ["an extra compatible sealed pin", (db: DatabaseDriver.Database) => {
      db.prepare(`INSERT INTO rpg_content_packs
        (pack_id,pack_version,rules_profile_id,name,description,tags,sealed)
        VALUES ('compatible-extra','1.0.0',?,'Extra','Compatible extra','[]',0)`)
        .run(ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId);
      db.prepare("UPDATE rpg_content_packs SET sealed = 1 WHERE pack_id = 'compatible-extra'").run();
      db.prepare(`INSERT INTO campaign_content_packs
        (campaign_id,pack_id,pack_version,rules_profile_id)
        VALUES ('campaign','compatible-extra','1.0.0',?)`)
        .run(ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId);
    }],
    ["a compatible selected-profile/configuration drift", (db: DatabaseDriver.Database) => {
      db.prepare("INSERT INTO rpg_rules_profiles VALUES ('alternate-profile','Alternate','Alternate profile','[]')").run();
      db.prepare(`INSERT INTO rpg_content_packs
        (pack_id,pack_version,rules_profile_id,name,description,tags,sealed)
        VALUES ('alternate-pack','1.0.0','alternate-profile','Alternate','Alternate pack','[]',0)`).run();
      db.prepare("UPDATE rpg_content_packs SET sealed = 1 WHERE pack_id = 'alternate-pack'").run();
      db.prepare("DELETE FROM campaign_content_packs WHERE campaign_id = 'campaign'").run();
      db.prepare("DELETE FROM campaign_rules_profiles WHERE campaign_id = 'campaign'").run();
      db.prepare("INSERT INTO campaign_rules_profiles VALUES ('campaign','alternate-profile')").run();
      db.prepare(`INSERT INTO campaign_content_packs VALUES
        ('campaign','alternate-pack','1.0.0','alternate-profile')`).run();
    }],
  ])("classifies %s introduced after preflight as one locked conflict", (_label, mutate) => {
    const ids = ["campaign", "timeline", "cc", "sheet", "actor"];
    const nextId = vi.fn(() => ids.shift()!);
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    db.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,safe_word,fictional_confirmed,is_real_person,created_at)
      VALUES ('persona','Persona',30,'hero','fictional','anchor',1,0,?)`).run(AT);
    db.close();
    const dependencyBaseline = { ids: nextId.mock.calls.length, clocks: now.mock.calls.length };
    const lockedCreate = vi.fn((actor: string, input: Parameters<typeof repository.createOriginalStarterCampaignCharacter>[1]) => {
      const drift = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
      mutate(drift);
      drift.close();
      return repository.createOriginalStarterCampaignCharacter(actor, input);
    });
    const service = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: repository.getCampaignCharacterCreationOptions,
      createOriginalStarterCampaignCharacter: lockedCreate,
    });

    expect(() => service.create("campaign", { characterId: "persona" }))
      .toThrow(OriginalStarterCharacterCreationConflictError);
    expect(lockedCreate).toHaveBeenCalledOnce();
    expect(nextId).toHaveBeenCalledTimes(dependencyBaseline.ids);
    expect(now).toHaveBeenCalledTimes(dependencyBaseline.clocks);
    const verify = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"), { readonly: true });
    expect((verify.prepare("SELECT COUNT(*) count FROM campaign_characters").get() as { count: number }).count).toBe(0);
    verify.close();
    repository.close();
  });

  it("leaves content corruption introduced after preflight untyped with no create dependencies or writes", () => {
    const ids = ["campaign", "timeline", "cc", "sheet", "actor"];
    const nextId = vi.fn(() => ids.shift()!);
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    repository.createCampaign("local-owner", { name: "Campaign" });
    repository.installOriginalStarterContent("local-owner", "campaign");
    repository.configureOriginalStarterContent("local-owner", "campaign");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    db.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,safe_word,fictional_confirmed,is_real_person,created_at)
      VALUES ('persona','Persona',30,'hero','fictional','anchor',1,0,?)`).run(AT);
    db.close();
    const dependencyBaseline = { ids: nextId.mock.calls.length, clocks: now.mock.calls.length };
    const lockedCreate = vi.fn((actor: string, input: Parameters<typeof repository.createOriginalStarterCampaignCharacter>[1]) => {
      const corrupt = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
      corrupt.pragma("ignore_check_constraints = ON");
      corrupt.exec("DROP TRIGGER rpg_definitions_prevent_update; DROP TRIGGER rpg_definitions_tags_update;");
      corrupt.prepare("UPDATE rpg_definitions SET tags = '{' WHERE definition_id = ?")
        .run(ORIGINAL_STARTER_RACE.reference.definitionId);
      corrupt.close();
      return repository.createOriginalStarterCampaignCharacter(actor, input);
    });
    const service = createOriginalStarterCharacterCreationService({
      getCampaignCharacterCreationOptions: repository.getCampaignCharacterCreationOptions,
      createOriginalStarterCampaignCharacter: lockedCreate,
    });

    let failure: unknown;
    try {
      service.create("campaign", { characterId: "persona" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OriginalStarterCharacterCreationConflictError);
    expect(failure).not.toBeInstanceOf(OriginalStarterCharacterCreationUnavailableError);
    expect(failure).not.toBeInstanceOf(OriginalStarterCharacterPersonaUnavailableError);
    expect(lockedCreate).toHaveBeenCalledOnce();
    expect(nextId).toHaveBeenCalledTimes(dependencyBaseline.ids);
    expect(now).toHaveBeenCalledTimes(dependencyBaseline.clocks);
    const verify = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"), { readonly: true });
    expect((verify.prepare("SELECT COUNT(*) count FROM campaign_characters").get() as { count: number }).count).toBe(0);
    verify.close();
    repository.close();
  });
});

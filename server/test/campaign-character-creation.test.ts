import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CreateCampaignCharacterInput } from "@velvet/contracts";
import { MAX_PRIVATE_NOTES_LENGTH } from "@velvet/contracts";
import * as repoModule from "../src/repo/index.js";
import {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
  createRepository,
} from "../src/repo/index.js";
import { makeTmpDataDir, useTmpDataDir } from "./helpers.js";
import { startLockedWrite } from "./lock-worker.js";

useTmpDataDir();

const AT = "2030-04-05T06:07:08.009Z";
const input: CreateCampaignCharacterInput = {
  campaignId: "campaign-one",
  characterId: "persona opaque %_' id",
  controllerPrincipalId: "player",
  race: { packId: "core", packVersion: "1.0.0", kind: "race", definitionId: "human" },
  background: { packId: "core", packVersion: "1.0.0", kind: "background", definitionId: "sage" },
  classes: [
    { class: { packId: "core", packVersion: "1.0.0", kind: "class", definitionId: "wizard" }, level: 2 },
    { class: { packId: "core", packVersion: "1.0.0", kind: "class", definitionId: "fighter" }, level: 1 },
  ],
  attributes: [{ attributeId: "wisdom", value: 14 }, { attributeId: "strength", value: 9 }],
  proficiencies: [
    { category: "language", proficiencyId: "draconic" },
    { category: "skill", proficiencyId: "history" },
  ],
  choices: [
    { choiceId: "gear", selection: { packId: "core", packVersion: "1.0.0", kind: "item", definitionId: "rope" } },
    { choiceId: "cantrip", selection: { packId: "core", packVersion: "1.0.0", kind: "spell", definitionId: "light" } },
  ],
};

function dbPath(dir = process.env.VELVET_DATA_DIR as string): string {
  return path.join(dir, "velvet.sqlite");
}

function seed(dir = process.env.VELVET_DATA_DIR as string): void {
  const initial = createRepository({ dataDir: dir });
  initial.close();
  const db = new DatabaseDriver(dbPath(dir));
  db.pragma("foreign_keys = ON");
  for (const [id, role] of [["gm", "gm"], ["player", "player"], ["observer", "observer"]] as const) {
    db.prepare("INSERT INTO principals VALUES (?, ?, 0)").run(id, id);
    void role;
  }
  db.prepare("INSERT INTO principals VALUES ('application-only', 'Application only', 0)").run();
  db.prepare("UPDATE application_owner SET principal_id = 'application-only' WHERE singleton = 1").run();
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign-one', 'One', 'timeline-one', 'local-owner', ?, ?),
             ('campaign-two', 'Two', 'timeline-two', 'local-owner', ?, ?)`).run(AT, AT, AT, AT);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES ('timeline-one', 'campaign-one', ?), ('timeline-two', 'campaign-two', ?)`)
      .run(AT, AT);
    db.prepare(`INSERT INTO campaign_memberships VALUES
      ('campaign-one', 'local-owner', 'owner', ?), ('campaign-one', 'gm', 'gm', ?),
      ('campaign-one', 'player', 'player', ?), ('campaign-one', 'observer', 'observer', ?),
      ('campaign-two', 'local-owner', 'owner', ?), ('campaign-two', 'player', 'player', ?)`)
      .run(AT, AT, AT, AT, AT, AT);
  })();
  db.prepare(`INSERT INTO characters VALUES
    (?, 'Opaque', 30, 'hero', 'fictional', 1, 0, ?),
    ('persona-two', 'Two', 31, 'hero', 'fictional', 1, 0, ?),
    ('persona-three', 'Three', 32, 'hero', 'fictional', 1, 0, ?)`).run(input.characterId, AT, AT, AT);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile', 'Profile', 'Profile description', '[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('core', '1.0.0', 'profile', 'Core', 'Core description', '[]', 0)").run();
  const definition = db.prepare("INSERT INTO rpg_definitions VALUES ('core', '1.0.0', ?, ?, ?, 'Description', '[]')");
  for (const [kind, id] of [
    ["race", "human"], ["background", "sage"], ["class", "wizard"], ["class", "fighter"],
    ["item", "rope"], ["spell", "light"],
  ]) definition.run(kind, id, id);
  db.prepare("UPDATE rpg_content_packs SET sealed = 1").run();
  for (const campaignId of ["campaign-one", "campaign-two"]) {
    db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'profile')").run(campaignId);
    db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'core', '1.0.0', 'profile')").run(campaignId);
  }
  db.close();
}

function factory(options: { dir?: string; ids?: string[]; at?: string } = {}) {
  const ids = options.ids ?? ["campaign-character", "sheet", "actor"];
  return createRepository({
    dataDir: options.dir ?? process.env.VELVET_DATA_DIR as string,
    ids: { nextId: vi.fn(() => ids.shift()!) },
    clock: { now: vi.fn(() => new Date(options.at ?? AT)) },
  });
}

const tables = [
  "campaign_characters", "rpg_campaign_sheets", "rpg_character_classes", "rpg_character_attributes",
  "rpg_character_proficiencies", "rpg_character_choices", "campaign_actors", "campaign_actor_private_state",
] as const;

describe("campaign-character creation", () => {
  it("returns the exact privileged projection and stores all eight groups in supplied order", () => {
    seed();
    const repository = factory();
    const created = repository.createCampaignCharacter("local-owner", input);
    expect(created).toEqual({
      campaignCharacter: { id: "campaign-character", campaignId: "campaign-one", characterId: input.characterId, createdAt: AT, updatedAt: AT },
      sheet: {
        id: "sheet", campaignId: "campaign-one", campaignCharacterId: "campaign-character",
        race: input.race, background: input.background, classes: input.classes, attributes: input.attributes,
        proficiencies: input.proficiencies, choices: input.choices, createdAt: AT, updatedAt: AT,
      },
      actor: { id: "actor", campaignId: "campaign-one", campaignCharacterId: "campaign-character", sheetId: "sheet",
        kind: "player-character", control: "principal", controllerPrincipalId: "player", privateNotes: null,
        createdAt: AT, updatedAt: AT },
    });
    expect(created.sheet).not.toHaveProperty("characterId");
    expect(created.sheet).not.toHaveProperty("controllerPrincipalId");
    expect(created.sheet).not.toHaveProperty("privateNotes");
    repository.close();

    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect((db.prepare("SELECT definition_id, level, position FROM rpg_character_classes ORDER BY position").all()))
      .toEqual([{ definition_id: "wizard", level: 2, position: 0 }, { definition_id: "fighter", level: 1, position: 1 }]);
    expect(db.prepare("SELECT attribute_id, position FROM rpg_character_attributes ORDER BY position").all())
      .toEqual([{ attribute_id: "wisdom", position: 0 }, { attribute_id: "strength", position: 1 }]);
    expect(db.prepare("SELECT category, proficiency_id, position FROM rpg_character_proficiencies ORDER BY position").all())
      .toEqual([{ category: "language", proficiency_id: "draconic", position: 0 }, { category: "skill", proficiency_id: "history", position: 1 }]);
    expect(db.prepare("SELECT choice_id, definition_id, position FROM rpg_character_choices ORDER BY position").all())
      .toEqual([{ choice_id: "gear", definition_id: "rope", position: 0 }, { choice_id: "cantrip", definition_id: "light", position: 1 }]);
    expect(db.prepare("SELECT controller_principal_id, private_notes FROM campaign_actor_private_state").get())
      .toEqual({ controller_principal_id: "player", private_notes: null });
    expect((db.prepare("SELECT updated_at FROM campaigns WHERE id = 'campaign-one'").get() as { updated_at: string }).updated_at).toBe(AT);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it.each(["local-owner", "gm"])("allows campaign %s authorization", (actor) => {
    seed();
    const repository = factory();
    expect(repository.createCampaignCharacter(actor, input).campaignCharacter.id).toBe("campaign-character");
    repository.close();
  });

  it.each(["player", "observer", "application-only", "missing-principal"])("denies %s without disclosure or dependencies", (actor) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.createCampaignCharacter(actor, input)).toThrow("campaign character creation unavailable");
    expect(() => repository.createCampaignCharacter(actor, { ...input, campaignId: "missing-campaign" })).toThrow("campaign character creation unavailable");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("uses only the narrow unavailable type for masked authority denial", () => {
    seed();
    const repository = factory();
    expect(() => repository.createCampaignCharacter("player", input))
      .toThrow(CampaignCharacterCreationUnavailableError);
    repository.close();
  });

  it("masks denied actors before attributable owner corruption", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaigns SET owner_role = 'gm' WHERE id = 'campaign-one'").run();
    db.close();
    const repository = factory();
    expect(() => repository.createCampaignCharacter("player", input))
      .toThrow(CampaignCharacterCreationUnavailableError);
    expect(() => repository.createCampaignCharacter("gm", input))
      .toThrow("campaign character creation campaign authority is malformed");
    repository.close();
  });

  it.each(["local-owner", "gm", "player"])("allows %s as controller", (controllerPrincipalId) => {
    seed();
    const repository = factory();
    expect(repository.createCampaignCharacter("gm", { ...input, controllerPrincipalId }).actor.controllerPrincipalId)
      .toBe(controllerPrincipalId);
    repository.close();
  });

  it.each(["observer", "application-only", "missing-principal"])("rejects %s as controller generically", (controllerPrincipalId) => {
    seed();
    const repository = factory();
    expect(() => repository.createCampaignCharacter("local-owner", { ...input, controllerPrincipalId }))
      .toThrow("campaign character creation unavailable");
    repository.close();
  });

  it("uses exact opaque persona lookup, persists notes verbatim, and treats omitted notes as null", () => {
    seed();
    const repository = factory();
    const notes = "  private %_' notes  ";
    expect(repository.createCampaignCharacter("local-owner", { ...input, privateNotes: notes }).actor.privateNotes).toBe(notes);
    repository.close();
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT character_id FROM campaign_characters").get()).toEqual({ character_id: input.characterId });
    expect(db.prepare("SELECT private_notes FROM campaign_actor_private_state").get()).toEqual({ private_notes: notes });
    db.close();
  });

  it("distinguishes missing/ineligible personas from malformed persona state", () => {
    seed();
    const repository = factory();
    expect(() => repository.createCampaignCharacter("local-owner", { ...input, characterId: "missing" }))
      .toThrow(CampaignCharacterPersonaUnavailableError);
    repository.close();

    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE characters SET fictional_confirmed = 0 WHERE id = ?").run(input.characterId);
    db.close();
    const ineligible = factory();
    expect(() => ineligible.createCampaignCharacter("local-owner", input))
      .toThrow(CampaignCharacterPersonaUnavailableError);
    ineligible.close();

    const corrupt = new DatabaseDriver(dbPath());
    corrupt.pragma("ignore_check_constraints = ON");
    corrupt.prepare("UPDATE characters SET fictional_confirmed = 2 WHERE id = ?").run(input.characterId);
    corrupt.close();
    const malformed = factory();
    expect(() => malformed.createCampaignCharacter("local-owner", input))
      .toThrow("campaign character creation persona is malformed");
    expect(() => malformed.createCampaignCharacter("local-owner", input))
      .not.toThrow(CampaignCharacterPersonaUnavailableError);
    malformed.close();
  });

  it("persists 4000 astral code points and rejects 4001 before a second aggregate is created", () => {
    seed();
    const astral = "\u{1F9B9}";
    const accepted = astral.repeat(MAX_PRIVATE_NOTES_LENGTH);
    const rejected = astral.repeat(MAX_PRIVATE_NOTES_LENGTH + 1);
    const repository = factory();

    expect(repository.createCampaignCharacter("local-owner", { ...input, privateNotes: accepted }).actor.privateNotes)
      .toBe(accepted);
    expect(() => repository.createCampaignCharacter("local-owner", { ...input, privateNotes: rejected })).toThrow();
    repository.close();

    const db = new DatabaseDriver(dbPath(), { readonly: true });
    expect(db.prepare("SELECT length(private_notes) AS length FROM campaign_actor_private_state").get())
      .toEqual({ length: MAX_PRIVATE_NOTES_LENGTH });
    expect((db.prepare("SELECT COUNT(*) AS count FROM campaign_characters").get() as { count: number }).count).toBe(1);
    db.close();
  });

  it.each(["\ud800", "\udc00", "x\ud800y", "x\udc00y"])(
    "rejects malformed UTF-16 private notes before dependencies or writes %#",
    (privateNotes) => {
      seed();
      const nextId = vi.fn(() => "unused");
      const now = vi.fn(() => new Date(AT));
      const repository = createRepository({
        dataDir: process.env.VELVET_DATA_DIR as string,
        ids: { nextId },
        clock: { now },
      });
      expect(() => repository.createCampaignCharacter("local-owner", { ...input, privateNotes })).toThrow();
      expect(nextId).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      repository.close();
      const db = new DatabaseDriver(dbPath(), { readonly: true });
      for (const table of tables) {
        expect((db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count).toBe(0);
      }
      db.close();
    },
  );

  it.each([
    ["race", { race: { ...input.race, definitionId: "missing" } }],
    ["background", { background: { ...input.background, packVersion: "2.0.0" } }],
    ["class", { classes: [{ class: { ...input.classes[0]!.class, kind: "class" as const, definitionId: "missing" }, level: 1 }] }],
    ["choice", { choices: [{ choiceId: "x", selection: { ...input.choices[0]!.selection, definitionId: "missing" } }] }],
  ])("rejects unavailable %s content before dependencies", (_label, patch) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.createCampaignCharacter("local-owner", { ...input, ...patch } as CreateCampaignCharacterInput))
      .toThrow("campaign character creation unavailable");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("rejects definitions reached through a malformed unsealed pin even without pin triggers", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec(`
      DROP TRIGGER campaign_content_packs_require_sealed_insert;
      DROP TRIGGER campaign_content_packs_require_sealed_update;
      DROP TRIGGER rpg_content_packs_prevent_update;
    `);
    db.prepare("UPDATE rpg_content_packs SET sealed = 0 WHERE pack_id = 'core' AND pack_version = '1.0.0'").run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.createCampaignCharacter("local-owner", input))
      .toThrow("campaign character creation content graph is malformed");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
    const verify = new DatabaseDriver(dbPath(), { readonly: true });
    for (const table of tables) {
      expect((verify.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count).toBe(0);
    }
    verify.close();
  });

  it("preserves generic zero-pin malformed-content classification", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.prepare("DELETE FROM campaign_content_packs WHERE campaign_id = 'campaign-one'").run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.createCampaignCharacter("local-owner", input))
      .toThrow("campaign character creation content graph is malformed");
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    repository.close();
  });

  it("reports a same-campaign persona duplicate but allows the same persona across campaigns", () => {
    seed();
    const first = factory();
    first.createCampaignCharacter("local-owner", input);
    first.close();
    const duplicate = factory({ ids: ["unused", "unused", "unused"] });
    expect(() => duplicate.createCampaignCharacter("local-owner", input)).toThrow(CampaignCharacterCreationConflictError);
    expect(duplicate.createCampaignCharacter("local-owner", { ...input, campaignId: "campaign-two" }).campaignCharacter.characterId)
      .toBe(input.characterId);
    duplicate.close();
  });

  it("validates the complete existing duplicate aggregate before typed conflict", () => {
    seed();
    const first = factory();
    first.createCampaignCharacter("local-owner", input);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM campaign_actors WHERE id = 'actor'").run();
    db.close();
    const duplicate = factory();
    expect(() => duplicate.createCampaignCharacter("local-owner", input))
      .toThrow("campaign character aggregate is incomplete");
    expect(() => duplicate.createCampaignCharacter("local-owner", input))
      .not.toThrow(CampaignCharacterCreationConflictError);
    duplicate.close();
  });

  it("validates missing requested content before classifying a complete duplicate", () => {
    seed();
    const first = factory();
    first.createCampaignCharacter("local-owner", input);
    first.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const duplicate = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => duplicate.createCampaignCharacter("local-owner", {
      ...input,
      race: { ...input.race, definitionId: "missing" },
    })).toThrow(CampaignCharacterCreationUnavailableError);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    duplicate.close();
  });

  it("validates corrupt requested definition metadata before classifying a complete duplicate", () => {
    seed();
    const first = factory();
    first.createCampaignCharacter("local-owner", input);
    first.close();
    const db = new DatabaseDriver(dbPath());
    db.pragma("ignore_check_constraints = ON");
    db.exec("DROP TRIGGER rpg_definitions_prevent_update; DROP TRIGGER rpg_definitions_tags_update;");
    db.prepare("UPDATE rpg_definitions SET tags = '{' WHERE kind = 'race' AND definition_id = 'human'").run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const now = vi.fn(() => new Date(AT));
    const duplicate = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => duplicate.createCampaignCharacter("local-owner", input)).toThrow();
    expect(() => duplicate.createCampaignCharacter("local-owner", input)).not.toThrow(CampaignCharacterCreationConflictError);
    expect(nextId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    duplicate.close();
  });

  it("consumes character, sheet, actor IDs then one clock and accepts equality", () => {
    seed();
    const calls: string[] = [];
    const ids = ["cc", "sheet", "actor"];
    const repository = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId: () => { calls.push("id"); return ids.shift()!; } },
      clock: { now: () => { calls.push("clock"); return new Date(AT); } },
    });
    repository.createCampaignCharacter("local-owner", input);
    expect(calls).toEqual(["id", "id", "id", "clock"]);
    repository.close();
  });

  it("rejects a backward clock after exact dependency consumption and rolls back", () => {
    seed();
    const nextId = vi.fn().mockReturnValueOnce("cc").mockReturnValueOnce("sheet").mockReturnValueOnce("actor");
    const now = vi.fn(() => new Date("2030-04-05T06:07:08.008Z"));
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now } });
    expect(() => repository.createCampaignCharacter("local-owner", input))
      .toThrow("campaign character timestamp cannot precede campaign updated_at");
    expect(nextId).toHaveBeenCalledTimes(3);
    expect(now).toHaveBeenCalledOnce();
    repository.close();
    const db = new DatabaseDriver(dbPath(), { readonly: true });
    for (const table of tables) expect((db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count).toBe(0);
    db.close();
  });

  it.each(tables)("rolls back the complete aggregate when %s insertion fails", (table) => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec(`CREATE TRIGGER reject_group BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'group rejected'); END`);
    db.close();
    const repository = factory();
    expect(() => repository.createCampaignCharacter("local-owner", input)).toThrow("group rejected");
    repository.close();
    const check = new DatabaseDriver(dbPath(), { readonly: true });
    for (const aggregateTable of tables) {
      expect((check.prepare(`SELECT COUNT(*) count FROM ${aggregateTable}`).get() as { count: number }).count).toBe(0);
    }
    check.close();
  });

  it("is factory-only, rejects nested calls, and checks lifecycle before parsing", () => {
    seed();
    expect(repoModule).not.toHaveProperty("createCampaignCharacter");
    const repository = factory();
    expect(repository.transaction((unit) => "createCampaignCharacter" in unit)).toBe(false);
    expect(repository.transaction((unit) => "createOriginalStarterCampaignCharacter" in unit)).toBe(false);
    expect(() => repository.transaction(() => repository.createCampaignCharacter("local-owner", input)))
      .toThrow("campaign character creation cannot run inside a repository transaction");
    repository.close();
    expect(() => repository.createCampaignCharacter("invalid actor", {} as CreateCampaignCharacterInput)).toThrow("repository is closed");
  });

  it("does not retry ID collisions or use random mechanics", () => {
    seed();
    const first = factory();
    first.createCampaignCharacter("local-owner", input);
    first.close();
    const ids = ["campaign-character", "other-sheet", "other-actor", "retry"];
    const nextId = vi.fn(() => ids.shift()!);
    const repository = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids: { nextId }, clock: { now: () => new Date(AT) } });
    expect(() => repository.createCampaignCharacter("local-owner", { ...input, campaignId: "campaign-two" })).toThrow();
    expect(nextId).toHaveBeenCalledTimes(3);
    repository.close();
  });

  it("waits for real write contention and commits after release", async () => {
    const dir = makeTmpDataDir();
    seed(dir);
    const lock = await startLockedWrite(dbPath(dir), [{
      sql: "UPDATE campaigns SET name = name WHERE id = 'campaign-one'",
    }], 100);
    const repository = factory({ dir });
    expect(lock.isReleased()).toBe(false);
    expect(repository.createCampaignCharacter("local-owner", input).campaignCharacter.id).toBe("campaign-character");
    expect(lock.isReleased()).toBe(true);
    await lock.done;
    repository.close();
  });
});

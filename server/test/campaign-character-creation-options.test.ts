import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  campaignCharacterCreationOptionsResponseSchema,
  MAX_CAMPAIGN_CHARACTER_PERSONAS,
  MAX_CAMPAIGN_CONTENT_PACKS,
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
} from "@velvet/contracts";
import { createRepository, type RepositoryUnitOfWork } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const AT = "2035-06-07T08:09:10.011Z";

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function dbPath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function seed(options: { configure?: boolean; personas?: Array<[string, string, string]> } = {}): void {
  const ids = ["campaign-one", "timeline-one", "campaign-two", "timeline-two"];
  const repository = createRepository({
    dataDir: dataDir(),
    ids: { nextId: () => ids.shift()! },
    clock: { now: () => new Date(AT) },
  });
  repository.createCampaign("local-owner", { name: "One" });
  repository.createCampaign("local-owner", { name: "Two" });
  if (options.configure !== false) {
    repository.installOriginalStarterContent("local-owner", "campaign-one");
    repository.configureOriginalStarterContent("local-owner", "campaign-one");
  }
  repository.close();

  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.exec(`
    INSERT INTO principals (id, display_name, is_local) VALUES
      ('gm', 'GM', 0), ('player', 'Player', 0), ('observer', 'Observer', 0),
      ('outsider', 'Outsider', 0);
    INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES
      ('campaign-one', 'gm', 'gm', '${AT}'),
      ('campaign-one', 'player', 'player', '${AT}'),
      ('campaign-one', 'observer', 'observer', '${AT}');
  `);
  const insertPersona = db.prepare(`INSERT INTO characters
    (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
    VALUES (?, ?, 30, 'hero', 'fictional', 1, 0, ?)`);
  for (const persona of options.personas ?? [
    ["persona-z", "Zulu", "2035-01-02T00:00:00.000Z"],
    ["persona-A", "Alpha", "2035-01-01T00:00:00.000Z"],
    ["persona-a", "Lower", "2035-01-01T00:00:00.000Z"],
  ]) insertPersona.run(...persona);
  db.close();
}

function read(actor = "local-owner", campaign = "campaign-one") {
  const repository = createRepository({ dataDir: dataDir() });
  try {
    return repository.getCampaignCharacterCreationOptions(actor, campaign);
  } finally {
    repository.close();
  }
}

function addLink(campaignId: string, id: string, characterId: string): void {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.prepare(`INSERT INTO campaign_characters
    (id, campaign_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, campaignId, characterId, AT, AT);
  db.close();
}

function corrupt(sql: string): void {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(sql);
  db.close();
}

describe("getCampaignCharacterCreationOptions", () => {
  it("returns exact starter metadata and deterministic created-at/binary-id persona order", () => {
    seed();
    expect(read()).toEqual({
      campaignId: "campaign-one",
      personas: [
        { characterId: "persona-A", name: "Alpha", alreadyUsed: false },
        { characterId: "persona-a", name: "Lower", alreadyUsed: false },
        { characterId: "persona-z", name: "Zulu", alreadyUsed: false },
      ],
      starter: {
        rulesProfile: ORIGINAL_STARTER_RULES_PROFILE,
        pack: ORIGINAL_STARTER_PACK,
        race: ORIGINAL_STARTER_RACE,
        background: ORIGINAL_STARTER_BACKGROUND,
        class: { ...ORIGINAL_STARTER_CLASS, level: 1 },
      },
    });
  });

  it("projects overlong legacy names as the longest whole-surrogate prefix accepted by the strict schema", () => {
    const ascii = "a".repeat(201);
    const pairAtBoundary = `${"b".repeat(199)}😀tail`;
    const astral = "😀".repeat(101);
    seed({ personas: [
      ["ascii", ascii, "2035-01-01T00:00:00.000Z"],
      ["boundary", pairAtBoundary, "2035-01-02T00:00:00.000Z"],
      ["astral", astral, "2035-01-03T00:00:00.000Z"],
    ] });

    const result = read()!;
    expect(result.personas).toEqual([
      { characterId: "ascii", name: "a".repeat(200), alreadyUsed: false },
      { characterId: "boundary", name: "b".repeat(199), alreadyUsed: false },
      { characterId: "astral", name: "😀".repeat(100), alreadyUsed: false },
    ]);
    expect(campaignCharacterCreationOptionsResponseSchema.parse(result)).toEqual(result);
    expect(result.personas.every((persona) => Array.from(persona.name).every((symbol) =>
      symbol.length === 2 || !/[\uD800-\uDFFF]/.test(symbol)))).toBe(true);
  });

  it("projects a visible bounded name when the first prefix is only whitespace", () => {
    const leadingWhitespace = " ".repeat(201);
    seed({ personas: [
      ["visible", `${leadingWhitespace}Visible`, "2035-01-01T00:00:00.000Z"],
      ["boundary", `${leadingWhitespace}${"x".repeat(199)}😀tail`, "2035-01-02T00:00:00.000Z"],
      ["ordinary", "  Ordinary  ", "2035-01-03T00:00:00.000Z"],
    ] });

    const result = read()!;
    expect(result.personas).toEqual([
      { characterId: "visible", name: "Visible", alreadyUsed: false },
      { characterId: "boundary", name: "x".repeat(199), alreadyUsed: false },
      { characterId: "ordinary", name: "  Ordinary  ", alreadyUsed: false },
    ]);
    expect(campaignCharacterCreationOptionsResponseSchema.parse(result)).toEqual(result);
  });

  it.each(["", " \t\n "])("loudly rejects authorized empty/whitespace-only persisted name %j", (name) => {
    seed({ personas: [["bad-name", name, AT]] });
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
    expect(read("player")).toBeNull();
  });

  it.each(["local-owner", "gm"])("allows creation-authority %s", (actor) => {
    seed();
    expect(read(actor)?.campaignId).toBe("campaign-one");
  });

  it.each(["player", "observer", "outsider", "missing"])("masks denied actor %s", (actor) => {
    seed();
    expect(read(actor)).toBeNull();
    expect(read(actor, "missing-campaign")).toBeNull();
  });

  it("marks usage only in the requested campaign", () => {
    seed();
    addLink("campaign-one", "link-current", "persona-A");
    addLink("campaign-two", "link-other", "persona-a");
    expect(read()!.personas).toEqual([
      { characterId: "persona-A", name: "Alpha", alreadyUsed: true },
      { characterId: "persona-a", name: "Lower", alreadyUsed: false },
      { characterId: "persona-z", name: "Zulu", alreadyUsed: false },
    ]);
  });

  it("uses exactly one explicit-column statement and no named legacy read composition", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      expect(repository.getCampaignCharacterCreationOptions("local-owner", "campaign-one")).not.toBeNull();
      expect(prepare).toHaveBeenCalledOnce();
      const sql = prepare.mock.calls[0]![0] as string;
      expect(sql).toMatch(/^WITH authorized AS/);
      expect(sql).toMatch(/FROM campaign_memberships membership/);
      expect(sql).toMatch(/ORDER BY persona\.created_at ASC, persona\.id COLLATE BINARY ASC/);
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("uses no clock, ID, or RNG dependency and performs no writes", () => {
    seed();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn(() => 1);
    const repository = createRepository({ dataDir: dataDir(), clock: { now }, ids: { nextId }, rng: { integer } });
    const before = repository.getCampaignCharacterCreationOptions("gm", "campaign-one");
    expect(before).not.toBeNull();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    repository.close();
  });

  it("is available on active UoWs and guards factory/UoW lifecycle before parsing", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const expected = repository.getCampaignCharacterCreationOptions("gm", "campaign-one");
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => {
      expired = unit;
      expect(unit.getCampaignCharacterCreationOptions("gm", "campaign-one")).toEqual(expected);
    });
    expect(() => expired!.getCampaignCharacterCreationOptions("bad actor", "bad campaign"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
    expect(() => repository.getCampaignCharacterCreationOptions("bad actor", "bad campaign"))
      .toThrow("repository is closed");
  });

  it("keeps active-UoW reads on one snapshot across a concurrent WAL commit", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    repository.transaction((unit) => {
      expect(unit.getCampaignCharacterCreationOptions("gm", "campaign-one")!.personas).toHaveLength(3);
      const writer = new DatabaseDriver(dbPath());
      writer.prepare(`INSERT INTO characters
        (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
        VALUES ('concurrent', 'Concurrent', 30, 'hero', 'fictional', 1, 0, ?)`)
        .run(AT);
      writer.close();
      expect(unit.getCampaignCharacterCreationOptions("gm", "campaign-one")!.personas).toHaveLength(3);
    });
    expect(repository.getCampaignCharacterCreationOptions("gm", "campaign-one")!.personas).toHaveLength(4);
    repository.close();
  });

  it("validates open-repository inputs before preparing the snapshot statement", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    expect(() => repository.getCampaignCharacterCreationOptions("bad actor", "campaign-one")).toThrow();
    expect(() => repository.getCampaignCharacterCreationOptions("local-owner", "bad campaign")).toThrow();
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    repository.close();
  });

  it("fails loudly for authorized persona overflow", () => {
    seed({ personas: [] });
    const db = new DatabaseDriver(dbPath());
    const insert = db.prepare(`INSERT INTO characters
      (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
      VALUES (?, ?, 20, 'hero', 'fictional', 1, 0, ?)`);
    db.transaction(() => {
      for (let index = 0; index <= MAX_CAMPAIGN_CHARACTER_PERSONAS; index += 1) {
        insert.run(`overflow-${String(index).padStart(4, "0")}`, `Persona ${index}`, AT);
      }
    })();
    db.close();
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
  });

  it("fails loudly for authorized campaign-link overflow while denied callers remain masked", () => {
    seed({ personas: [] });
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`INSERT INTO campaign_characters
      (id, campaign_id, character_id, created_at, updated_at) VALUES (?, 'campaign-one', ?, ?, ?)`);
    db.transaction(() => {
      for (let index = 0; index <= MAX_CAMPAIGN_CHARACTER_PERSONAS; index += 1) {
        insert.run(`link-${index}`, `orphan-${index}`, AT, AT);
      }
    })();
    db.close();
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
    expect(read("player")).toBeNull();
  });

  it("fails loudly for authorized campaign pack-pin overflow while denied callers remain masked", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    const insertPack = db.prepare(`INSERT INTO rpg_content_packs
      (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
      VALUES (?, '1', ?, 'Overflow', 'Overflow', '[]', 1)`);
    const insertPin = db.prepare(`INSERT INTO campaign_content_packs
      (campaign_id, pack_id, pack_version, rules_profile_id) VALUES ('campaign-one', ?, '1', ?)`);
    db.transaction(() => {
      for (let index = 1; index <= MAX_CAMPAIGN_CONTENT_PACKS; index += 1) {
        const packId = `overflow-pack-${index}`;
        insertPack.run(packId, ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId);
        insertPin.run(packId, ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId);
      }
    })();
    db.close();
    expect(() => read("local-owner")).toThrow("campaign character creation options are malformed");
    expect(read("observer")).toBeNull();
  });

  it("returns null for an unconfigured campaign", () => {
    seed({ configure: false });
    expect(read()).toBeNull();
  });

  it("attributes persona corruption before returning null for unconfigured campaigns", () => {
    seed({ configure: false });
    corrupt("UPDATE characters SET fictional_confirmed = 0 WHERE id = 'persona-A'");
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
    expect(read("player")).toBeNull();
  });

  it("returns null when the reviewed starter is not the sole configured pack", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec(`
      INSERT INTO rpg_content_packs
        (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
      VALUES ('extra', '1', '${ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId}', 'Extra', 'Extra', '[]', 1);
      INSERT INTO campaign_content_packs
        (campaign_id, pack_id, pack_version, rules_profile_id)
      VALUES ('campaign-one', 'extra', '1', '${ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId}');
    `);
    db.close();
    expect(read()).toBeNull();
  });

  it("attributes persona corruption before returning null for differently configured campaigns", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec(`
      INSERT INTO rpg_content_packs
        (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
      VALUES ('extra', '1', '${ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId}', 'Extra', 'Extra', '[]', 1);
      INSERT INTO campaign_content_packs
        (campaign_id, pack_id, pack_version, rules_profile_id)
      VALUES ('campaign-one', 'extra', '1', '${ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId}');
    `);
    db.close();
    corrupt("UPDATE characters SET is_real_person = 1 WHERE id = 'persona-A'");
    expect(() => read("local-owner")).toThrow("campaign character creation options are malformed");
    expect(read("observer")).toBeNull();
  });

  it.each([
    ["fictional confirmation", "fictional_confirmed = 0"],
    ["real-person marker", "is_real_person = 1"],
    ["non-boolean fictional confirmation", "fictional_confirmed = 2"],
    ["non-boolean real-person marker", "is_real_person = 2"],
  ])("strictly validates every offered persona's %s", (_label, assignment) => {
    seed();
    corrupt(`UPDATE characters SET ${assignment} WHERE id = 'persona-A'`);
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
    expect(read("player")).toBeNull();
  });

  it.each([
    ["missing race", `DROP TRIGGER rpg_definitions_prevent_delete;
      DELETE FROM rpg_definitions WHERE kind = 'race'`],
    ["unsealed pack", `DROP TRIGGER rpg_content_packs_prevent_update;
      UPDATE rpg_content_packs SET sealed = 0 WHERE pack_id = '${ORIGINAL_STARTER_PACK.packId}'`],
    ["malformed profile metadata", `DROP TRIGGER rpg_rules_profiles_tags_update;
      DROP TRIGGER rpg_rules_profiles_prevent_referenced_update;
      UPDATE rpg_rules_profiles SET tags = '[1]' WHERE rules_profile_id = '${ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId}'`],
    ["changed class metadata", `DROP TRIGGER rpg_definitions_prevent_update;
      UPDATE rpg_definitions SET name = 'Captured' WHERE kind = 'class'`],
    ["extra starter-pack definition", `DROP TRIGGER rpg_definitions_prevent_sealed_insert;
      INSERT INTO rpg_definitions (pack_id, pack_version, kind, definition_id, name, description, tags)
      VALUES ('${ORIGINAL_STARTER_PACK.packId}', '${ORIGINAL_STARTER_PACK.packVersion}',
        'item', 'velvet:unexpected', 'Unexpected', 'Unexpected', '[]')`],
    ["reserved definition captured by another pack", `DROP TRIGGER rpg_definitions_prevent_update;
      PRAGMA foreign_keys = OFF;
      UPDATE rpg_definitions SET pack_id = 'capturing-pack' WHERE kind = 'race'`],
  ])("loudly rejects authorized %s corruption but masks it from denied actors", (_label, sql) => {
    seed();
    corrupt(sql);
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
    expect(read("player")).toBeNull();
    expect(read("outsider")).toBeNull();
  });

  it("masks a stale owner before owner corruption while an intact GM sees it loudly", () => {
    seed();
    corrupt("UPDATE campaigns SET owner_principal_id = 'gm' WHERE id = 'campaign-one'");
    expect(read("local-owner")).toBeNull();
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
  });

  it("requires parent-backed creation authority", () => {
    seed();
    corrupt("DELETE FROM principals WHERE id = 'gm'");
    expect(read("gm")).toBeNull();
  });

  it("loudly requires an exact sole owner", () => {
    seed();
    corrupt("UPDATE campaign_memberships SET role = 'gm' WHERE campaign_id = 'campaign-one' AND role = 'owner'");
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
  });

  it("loudly requires campaigns.owner_role to remain exact owner", () => {
    seed();
    corrupt("UPDATE campaigns SET owner_role = 'gm' WHERE id = 'campaign-one'");
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
    expect(read("player")).toBeNull();
  });

  it("loudly requires an active timeline parent", () => {
    seed();
    corrupt("DELETE FROM campaign_timelines WHERE id = 'timeline-one'");
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
  });

  it("loudly rejects attributable persona corruption", () => {
    seed();
    corrupt("UPDATE characters SET name = '' WHERE id = 'persona-A'");
    expect(() => read("local-owner")).toThrow("campaign character creation options are malformed");
  });

  it("loudly rejects attributable campaign-link corruption", () => {
    seed();
    addLink("campaign-one", "orphan-link", "persona-A");
    corrupt("DELETE FROM characters WHERE id = 'persona-A'");
    expect(() => read("gm")).toThrow("campaign character creation options are malformed");
  });
});

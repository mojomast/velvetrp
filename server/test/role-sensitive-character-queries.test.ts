import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CreateCampaignCharacterInput } from "@velvet/contracts";
import { MAX_CAMPAIGN_CHARACTER_ROSTER, MAX_PRIVATE_NOTES_LENGTH } from "@velvet/contracts";
import * as repoModule from "../src/repo.js";
import { createRepository } from "../src/repo.js";
import type { RepositoryUnitOfWork } from "../src/repo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const AT = "2030-04-05T06:07:08.009Z";
const campaignId = "campaign-reads";

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function dbPath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function input(characterId: string, controllerPrincipalId: string, privateNotes: string): CreateCampaignCharacterInput {
  return {
    campaignId,
    characterId,
    controllerPrincipalId,
    race: { packId: "core", packVersion: "1", kind: "race", definitionId: "human" },
    background: { packId: "core", packVersion: "1", kind: "background", definitionId: "sage" },
    classes: [{ class: { packId: "core", packVersion: "1", kind: "class", definitionId: "fighter" }, level: 2 }],
    attributes: [],
    proficiencies: [],
    choices: [],
    privateNotes,
  };
}

function seed() {
  const initial = createRepository({ dataDir: dataDir() });
  initial.close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  for (const id of ["gm", "player-one", "player-two", "observer", "nonmember", "app-owner"]) {
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(id, id);
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, 'Reads', 'timeline-reads', 'local-owner', ?, ?),
             ('other-campaign', 'Other', 'other-timeline', 'local-owner', ?, ?)`).run(campaignId, AT, AT, AT, AT);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES ('timeline-reads', ?, ?), ('other-timeline', 'other-campaign', ?)`).run(campaignId, AT, AT);
    for (const [id, role] of [
      ["local-owner", "owner"], ["gm", "gm"], ["player-one", "player"],
      ["player-two", "player"], ["observer", "observer"],
    ] as const) {
      db.prepare("INSERT INTO campaign_memberships VALUES (?, ?, ?, ?)").run(campaignId, id, role, AT);
    }
    db.prepare("INSERT INTO campaign_memberships VALUES ('other-campaign', 'local-owner', 'owner', ?)").run(AT);
  })();
  db.prepare("INSERT INTO characters VALUES ('persona-a', 'A', 20, 'hero', '', 'stop', 1, 0, ?), ('persona-b', 'B', 20, 'hero', '', 'stop', 1, 0, ?)")
    .run(AT, AT);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile', 'Profile', 'Description', '[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('core', '1', 'profile', 'Core', 'Description', '[]', 0)").run();
  const definition = db.prepare("INSERT INTO rpg_definitions VALUES ('core', '1', ?, ?, ?, 'Description', '[]')");
  definition.run("race", "human", "Human");
  definition.run("background", "sage", "Sage");
  definition.run("class", "fighter", "Fighter");
  db.prepare("UPDATE rpg_content_packs SET sealed = 1").run();
  for (const id of [campaignId, "other-campaign"]) {
    db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'profile')").run(id);
    db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'core', '1', 'profile')").run(id);
  }
  db.close();

  const ids = ["cc-b", "sheet-b", "actor-b", "cc-a", "sheet-a", "actor-a"];
  const repository = createRepository({
    dataDir: dataDir(),
    clock: { now: () => new Date(AT) },
    ids: { nextId: () => ids.shift()! },
  });
  repository.createCampaignCharacter("local-owner", input("persona-b", "player-two", "two-secret"));
  repository.createCampaignCharacter("local-owner", input("persona-a", "player-one", "one-secret"));
  return repository;
}

describe("role-sensitive campaign-character queries", () => {
  it("returns a strict safe roster snapshot for every existing list role and masks outsiders", () => {
    const repository = seed();
    const expected = {
      campaignId,
      characters: [
        { id: "cc-a", characterId: "persona-a", name: "A" },
        { id: "cc-b", characterId: "persona-b", name: "B" },
      ],
    };
    for (const actor of ["local-owner", "gm", "player-one", "player-two", "observer"]) {
      expect(repository.getCampaignCharacterRoster(actor, campaignId)).toEqual(expected);
    }
    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    expect(repository.getCampaignCharacterRoster("app-owner", campaignId)).toBeNull();
    expect(repository.getCampaignCharacterRoster("local-owner", "other-campaign")).toEqual({
      campaignId: "other-campaign", characters: [],
    });
    expect(JSON.stringify(expected)).not.toMatch(/controller|private|sheet|actor/i);
    repository.close();
  });

  it("distinguishes an authorized empty roster from denied null", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = ON");
    db.exec(`DELETE FROM campaign_actor_private_state;
      DELETE FROM campaign_actors;
      DELETE FROM rpg_character_classes;
      DELETE FROM rpg_campaign_sheets;
      DELETE FROM campaign_characters;`);
    db.close();
    expect(repository.getCampaignCharacterRoster("observer", campaignId)).toEqual({ campaignId, characters: [] });
    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    repository.close();
  });

  it.each([
    ["class", "INSERT INTO rpg_character_classes VALUES ('campaign-reads', 'missing-sheet', 0, 'core', '1', 'class', 'fighter', 1)"],
    ["attribute", "INSERT INTO rpg_character_attributes VALUES ('campaign-reads', 'missing-sheet', 0, 'strength', 10)"],
    ["proficiency", "INSERT INTO rpg_character_proficiencies VALUES ('campaign-reads', 'missing-sheet', 0, 'skill', 'survival')"],
    ["choice", "INSERT INTO rpg_character_choices VALUES ('campaign-reads', 'missing-sheet', 0, 'choice', 'core', '1', 'class', 'fighter')"],
    ["private state", "INSERT INTO campaign_actor_private_state VALUES ('missing-actor', 'campaign-reads', 'player-one', 'orphan secret')"],
    ["sheet", `INSERT INTO rpg_campaign_sheets VALUES
      ('orphan-sheet', 'campaign-reads', 'missing-character', 'core', '1', 'race', 'human',
       'core', '1', 'background', 'sage', '${AT}', '${AT}')`],
    ["actor", `INSERT INTO campaign_actors VALUES
      ('orphan-actor', 'campaign-reads', 'missing-character', 'missing-sheet',
       'player-character', 'principal', '${AT}', '${AT}')`],
  ])("loudly rejects an authorized empty roster with an attributable orphan %s", (_kind, insertSql) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(`DELETE FROM campaign_actor_private_state;
      DELETE FROM campaign_actors;
      DELETE FROM rpg_character_classes;
      DELETE FROM rpg_character_attributes;
      DELETE FROM rpg_character_proficiencies;
      DELETE FROM rpg_character_choices;
      DELETE FROM rpg_campaign_sheets;
      DELETE FROM campaign_characters;`);
    db.exec(insertSql);
    db.prepare("UPDATE campaigns SET owner_principal_id = 'player-one' WHERE id = ?").run(campaignId);
    db.close();

    expect(() => repository.getCampaignCharacterRoster("observer", campaignId))
      .toThrow("campaign character roster is malformed");
    expect(repository.getCampaignCharacterRoster("local-owner", campaignId)).toBeNull();
    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    repository.close();
  });

  it("attributes descendants left behind when campaign-character roots move cross-campaign", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE campaign_characters SET campaign_id = 'other-campaign' WHERE campaign_id = ?")
      .run(campaignId);
    db.close();

    for (const actor of ["gm", "player-one", "observer"]) {
      expect(() => repository.getCampaignCharacterRoster(actor, campaignId))
        .toThrow("campaign character roster is malformed");
    }
    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    repository.close();
  });

  it("does not attribute a foreign campaign's orphan evidence to a clean empty roster", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(`DELETE FROM campaign_actor_private_state;
      DELETE FROM campaign_actors;
      DELETE FROM rpg_character_classes;
      DELETE FROM rpg_campaign_sheets;
      DELETE FROM campaign_characters;
      INSERT INTO rpg_character_attributes
        VALUES ('other-campaign', 'foreign-missing-sheet', 0, 'strength', 10);`);
    db.close();

    expect(repository.getCampaignCharacterRoster("observer", campaignId))
      .toEqual({ campaignId, characters: [] });
    expect(() => repository.getCampaignCharacterRoster("local-owner", "other-campaign"))
      .toThrow("campaign character roster is malformed");
    repository.close();
  });

  it("loudly rejects an authorized empty roster with an attributable orphan actor resource", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(`DELETE FROM campaign_actor_private_state;
      DELETE FROM rpg_actor_resources;
      DELETE FROM campaign_actors;
      DELETE FROM rpg_character_classes;
      DELETE FROM rpg_campaign_sheets;
      DELETE FROM campaign_characters;
      INSERT INTO rpg_actor_resources VALUES ('campaign-reads', 'missing-actor', 'hp', 1, 2);`);
    db.close();

    expect(() => repository.getCampaignCharacterRoster("observer", campaignId))
      .toThrow("campaign character roster is malformed");
    repository.close();
  });

  it("rejects a resource whose actor has only foreign-campaign character ancestry", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(`DELETE FROM campaign_actor_private_state;
      DELETE FROM rpg_actor_resources;
      DELETE FROM campaign_actors;
      DELETE FROM rpg_character_classes;
      DELETE FROM rpg_campaign_sheets;
      DELETE FROM campaign_characters;
      INSERT INTO campaign_characters VALUES
        ('foreign-cc', 'other-campaign', 'persona-a', '${AT}', '${AT}');
      INSERT INTO rpg_campaign_sheets VALUES
        ('foreign-sheet', 'other-campaign', 'foreign-cc', 'core', '1', 'race', 'human',
         'core', '1', 'background', 'sage', '${AT}', '${AT}');
      INSERT INTO campaign_actors VALUES
        ('foreign-actor', 'other-campaign', 'foreign-cc', 'foreign-sheet',
         'player-character', 'principal', '${AT}', '${AT}');
      INSERT INTO campaign_actor_private_state VALUES
        ('foreign-actor', 'other-campaign', 'local-owner', 'foreign secret');
      INSERT INTO rpg_actor_resources VALUES
        ('campaign-reads', 'foreign-actor', 'hp', 1, 2);`);
    db.close();

    expect(() => repository.getCampaignCharacterRoster("observer", campaignId))
      .toThrow("campaign character roster is malformed");
    expect(repository.getCampaignCharacterRoster("local-owner", "other-campaign")?.characters)
      .toEqual([{ id: "foreign-cc", characterId: "persona-a", name: "A" }]);
    repository.close();
  });

  it("masks attributable orphan actor resources from outsiders and stale owners", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO rpg_actor_resources VALUES (?, 'missing-actor', 'hp', 1, 2)").run(campaignId);
    db.prepare("UPDATE campaigns SET owner_principal_id = 'player-one' WHERE id = ?").run(campaignId);
    db.close();

    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    expect(repository.getCampaignCharacterRoster("local-owner", campaignId)).toBeNull();
    expect(() => repository.getCampaignCharacterRoster("gm", campaignId))
      .toThrow("campaign character roster is malformed");
    repository.close();
  });

  it("keeps clean campaign A independent from campaign B actor-resource corruption", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(`DELETE FROM campaign_actor_private_state;
      DELETE FROM rpg_actor_resources;
      DELETE FROM campaign_actors;
      DELETE FROM rpg_character_classes;
      DELETE FROM rpg_campaign_sheets;
      DELETE FROM campaign_characters;
      INSERT INTO rpg_actor_resources VALUES ('other-campaign', 'missing-actor', 'hp', 1, 2);`);
    db.close();

    expect(repository.getCampaignCharacterRoster("observer", campaignId))
      .toEqual({ campaignId, characters: [] });
    expect(() => repository.getCampaignCharacterRoster("local-owner", "other-campaign"))
      .toThrow("campaign character roster is malformed");
    repository.close();
  });

  it("reuses bounded whole-surrogate persona-name projection and deterministic roster order", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE characters SET name = ? WHERE id = 'persona-a'").run(`${"x".repeat(199)}😀tail`);
    db.prepare("UPDATE characters SET name = ? WHERE id = 'persona-b'").run(`${" ".repeat(201)}Visible`);
    db.close();
    expect(repository.getCampaignCharacterRoster("gm", campaignId)?.characters).toEqual([
      { id: "cc-a", characterId: "persona-a", name: "x".repeat(199) },
      { id: "cc-b", characterId: "persona-b", name: "Visible" },
    ]);
    repository.close();
  });

  it.each(["", " \t\n "])("loudly rejects malformed roster display name %j after authorization", (name) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE characters SET name = ? WHERE id = 'persona-a'").run(name);
    db.close();
    expect(() => repository.getCampaignCharacterRoster("observer", campaignId))
      .toThrow("campaign character roster is malformed");
    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    repository.close();
  });

  it("uses one explicit-column bounded statement without dependencies or writes", () => {
    const seeded = seed();
    seeded.close();
    const now = vi.fn(() => new Date(AT));
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn(() => 1);
    const repository = createRepository({
      dataDir: dataDir(), clock: { now }, ids: { nextId }, rng: { integer },
    });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    expect(repository.getCampaignCharacterRoster("observer", campaignId)?.characters).toHaveLength(2);
    expect(prepare).toHaveBeenCalledOnce();
    const sql = prepare.mock.calls[0]![0] as string;
    expect(sql).toMatch(/^WITH authorized AS/);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql).toContain(`LIMIT ${MAX_CAMPAIGN_CHARACTER_ROSTER + 1}`);
    expect(sql).toMatch(/ORDER BY cc\.created_at ASC, cc\.id COLLATE BINARY ASC/);
    expect(sql).not.toMatch(/private_notes|commands|raw_command/i);
    expect(sql).not.toMatch(/child\.(?:name|current|max)/i);
    expect(transaction).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    prepare.mockRestore();
    transaction.mockRestore();
    repository.close();
  });

  it("enforces MAX+1 overflow before projecting attributable rows", () => {
    const repository = seed();
    repository.close();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`INSERT INTO campaign_characters
      (id, campaign_id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (let index = 2; index <= MAX_CAMPAIGN_CHARACTER_ROSTER; index += 1) {
        insert.run(`overflow-${index}`, campaignId, `missing-${index}`, AT, AT);
      }
    })();
    db.close();
    const reopened = createRepository({ dataDir: dataDir() });
    expect(() => reopened.getCampaignCharacterRoster("gm", campaignId))
      .toThrow("campaign character roster is malformed");
    expect(reopened.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    reopened.close();
  });

  it("preserves stale-owner masking and loudly rejects owner corruption for an authorized GM", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE campaigns SET owner_principal_id = 'player-one' WHERE id = ?").run(campaignId);
    expect(repository.getCampaignCharacterRoster("local-owner", campaignId)).toBeNull();
    db.close();
    expect(() => repository.getCampaignCharacterRoster("gm", campaignId))
      .toThrow("campaign character roster is malformed");
    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    repository.close();
  });

  it.each([
    ["malformed campaign owner role", "", "UPDATE campaigns SET owner_role = 'gm' WHERE id = 'campaign-reads'"],
    ["duplicate owner membership", "DROP INDEX idx_campaign_memberships_one_owner", `INSERT INTO campaign_memberships
      (campaign_id, principal_id, role, created_at) VALUES ('campaign-reads', 'app-owner', 'owner', '${AT}')`],
  ])("loudly rejects %s for every authorized roster role while masking outsiders", (_kind, preparationSql, sql) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    if (preparationSql) db.exec(preparationSql);
    db.exec(sql);
    db.close();

    for (const actor of ["local-owner", "gm", "player-one", "observer"]) {
      expect(() => repository.getCampaignCharacterRoster(actor, campaignId))
        .toThrow("campaign character roster is malformed");
    }
    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    repository.close();
  });

  it("masks an orphaned purported owner but rejects that owner corruption for every other authorized role", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM principals WHERE id = 'local-owner'").run();
    db.close();

    // The purported owner no longer has a parent-backed membership and remains
    // masked. Other intact memberships authorize first, then see loud campaign
    // owner-integrity failure from the same statement snapshot.
    expect(repository.getCampaignCharacterRoster("local-owner", campaignId)).toBeNull();
    for (const actor of ["gm", "player-one", "observer"]) {
      expect(() => repository.getCampaignCharacterRoster(actor, campaignId))
        .toThrow("campaign character roster is malformed");
    }
    expect(repository.getCampaignCharacterRoster("nonmember", campaignId)).toBeNull();
    repository.close();
  });

  it("is exposed on active UoWs with snapshot and lifecycle guards", () => {
    const repository = seed();
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => {
      expired = unit;
      expect(unit.getCampaignCharacterRoster("player-one", campaignId)?.characters).toHaveLength(2);
      const writer = new DatabaseDriver(dbPath());
      writer.prepare("UPDATE characters SET name = 'Concurrent' WHERE id = 'persona-a'").run();
      writer.close();
      expect(unit.getCampaignCharacterRoster("player-one", campaignId)?.characters[0]?.name).toBe("A");
    });
    expect(repository.getCampaignCharacterRoster("player-one", campaignId)?.characters[0]?.name).toBe("Concurrent");
    expect(() => expired!.getCampaignCharacterRoster("bad actor", "bad campaign"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
    expect(() => repository.getCampaignCharacterRoster("bad actor", "bad campaign"))
      .toThrow("repository is closed");
    expect(repoModule).not.toHaveProperty("getCampaignCharacterRoster");
  });

  it("returns the resolved ID-free workspace for every intact role and masks unavailable targets", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?, 'sheet-a', 9, 'tech:strength', 14)")
      .run(campaignId);
    db.prepare("INSERT INTO rpg_character_proficiencies VALUES (?, 'sheet-a', 7, 'skill', 'tech:stealth')")
      .run(campaignId);
    db.prepare(`INSERT INTO rpg_character_choices VALUES
      (?, 'sheet-a', 5, 'tech:choice', 'core', '1', 'class', 'fighter')`).run(campaignId);
    db.prepare("INSERT INTO rpg_actor_resources VALUES (?, 'actor-a', 'tech:hp', 3, 9)").run(campaignId);
    // Workspace reads deliberately ignore private payload columns entirely.
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_actor_private_state SET private_notes = ? WHERE actor_id = 'actor-a'")
      .run("private-poison".repeat(1_000));
    db.close();

    const expected = {
      campaignId,
      campaignCharacterId: "cc-a",
      character: {
        name: "A",
        race: { name: "Human", description: "Description" },
        background: { name: "Sage", description: "Description" },
        classes: [{ name: "Fighter", description: "Description", level: 2 }],
        attributes: [{ label: "Attribute 1", value: 14 }],
        proficiencies: [{ category: "skill", label: "Skill proficiency 1" }],
        choices: [{ label: "Choice 1", selection: {
          kind: "class", name: "Fighter", description: "Description",
        } }],
        resources: [{ label: "Resource 1", current: 3, max: 9 }],
      },
    };
    for (const actor of ["local-owner", "gm", "player-one", "player-two", "observer"]) {
      expect(repository.getCampaignCharacterWorkspace(actor, campaignId, "cc-a")).toEqual(expected);
    }
    expect(repository.getCampaignCharacterWorkspace("nonmember", campaignId, "cc-a")).toBeNull();
    expect(repository.getCampaignCharacterWorkspace("observer", campaignId, "missing")).toBeNull();
    expect(repository.getCampaignCharacterWorkspace("local-owner", "other-campaign", "cc-a")).toBeNull();
    expect(JSON.stringify(expected)).not.toMatch(/persona|controller|private|sheet|actor|tech:/i);
    repository.close();
  });

  it("uses one bounded explicit-column workspace statement and UoW snapshots", () => {
    const repository = seed();
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    expect(repository.getCampaignCharacterWorkspace("observer", campaignId, "cc-a")?.character.name).toBe("A");
    expect(prepare).toHaveBeenCalledOnce();
    const sql = prepare.mock.calls[0]![0] as string;
    expect(sql).toMatch(/^WITH authorized AS/);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(sql).toContain(`LIMIT 17`);
    expect(sql).toContain(`LIMIT 65`);
    expect(sql).toContain(`LIMIT 129`);
    expect(sql).toMatch(/ORDER BY child\.position ASC/);
    expect(sql).toMatch(/ORDER BY resource\.name COLLATE BINARY ASC/);
    expect(sql).not.toMatch(/private_notes|boundaries|safe_word|campaign_commands|campaign_events|command_receipts/i);
    expect(sql.match(/controller_principal_id/gi)).toHaveLength(1);
    expect(sql).toMatch(/controller_membership\.principal_id\s*=\s*child\.controller_principal_id/);
    expect(sql).not.toMatch(/(?:AS|'controllerPrincipalId',)\s*\w*\.?controller_principal_id/i);
    expect(transaction).not.toHaveBeenCalled();
    prepare.mockRestore();
    transaction.mockRestore();

    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => {
      expired = unit;
      expect(unit.getCampaignCharacterWorkspace("gm", campaignId, "cc-a")?.character.name).toBe("A");
      const writer = new DatabaseDriver(dbPath());
      writer.prepare("UPDATE characters SET name = 'Concurrent' WHERE id = 'persona-a'").run();
      writer.close();
      expect(unit.getCampaignCharacterWorkspace("gm", campaignId, "cc-a")?.character.name).toBe("A");
    });
    expect(repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a")?.character.name).toBe("Concurrent");
    expect(() => expired!.getCampaignCharacterWorkspace("bad", "bad", "bad"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
    expect(() => repository.getCampaignCharacterWorkspace("bad", "bad", "bad"))
      .toThrow("repository is closed");
    expect(repoModule).not.toHaveProperty("getCampaignCharacterWorkspace");
  });

  it.each([
    ["sheet ancestry", "UPDATE rpg_campaign_sheets SET campaign_id = 'other-campaign' WHERE id = 'sheet-a'"],
    ["actor ancestry", "UPDATE campaign_actors SET sheet_id = 'sheet-b' WHERE id = 'actor-a'"],
    ["race definition", "DROP TRIGGER rpg_definitions_prevent_delete; DELETE FROM rpg_definitions WHERE kind = 'race'"],
    ["class pin", "UPDATE rpg_character_classes SET campaign_id = 'other-campaign' WHERE sheet_id = 'sheet-a'"],
    ["resource ancestry", "INSERT INTO rpg_actor_resources VALUES ('other-campaign', 'actor-a', 'hp', 1, 2)"],
  ])("rejects authorized workspace corruption in %s while masking outsiders", (_kind, mutation) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(mutation);
    db.close();
    expect(() => repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a"))
      .toThrow("campaign character workspace is malformed");
    expect(repository.getCampaignCharacterWorkspace("nonmember", campaignId, "cc-a")).toBeNull();
    repository.close();
  });

  it.each([
    ["sheet", `INSERT INTO rpg_campaign_sheets VALUES
      ('detached-sheet', 'campaign-reads', 'missing-root', 'core', '1', 'race', 'human',
       'core', '1', 'background', 'sage', '${AT}', '${AT}')`],
    ["actor", `INSERT INTO campaign_actors VALUES
      ('detached-actor', 'campaign-reads', 'missing-root', 'missing-sheet',
       'player-character', 'principal', '${AT}', '${AT}')`],
    ["private state", "INSERT INTO campaign_actor_private_state VALUES ('detached-actor', 'campaign-reads', 'player-one', 'must-not-be-selected')"],
    ["class", "INSERT INTO rpg_character_classes VALUES ('campaign-reads', 'missing-sheet', 0, 'core', '1', 'class', 'fighter', 1)"],
    ["attribute", "INSERT INTO rpg_character_attributes VALUES ('campaign-reads', 'missing-sheet', 0, 'orphan', 1)"],
    ["proficiency", "INSERT INTO rpg_character_proficiencies VALUES ('campaign-reads', 'missing-sheet', 0, 'skill', 'orphan')"],
    ["choice", "INSERT INTO rpg_character_choices VALUES ('campaign-reads', 'missing-sheet', 0, 'orphan', 'core', '1', 'class', 'fighter')"],
    ["actor resource", "INSERT INTO rpg_actor_resources VALUES ('campaign-reads', 'missing-actor', 'hp', 1, 2)"],
  ])("rejects a campaign-attributable detached/orphan workspace %s beside a valid root", (_family, sql) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(sql);
    db.close();

    expect(() => repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a"))
      .toThrow("campaign character workspace is malformed");
    expect(repository.getCampaignCharacterWorkspace("nonmember", campaignId, "cc-a")).toBeNull();
    repository.close();
  });

  it("does not let detached corruption attributable only to campaign B poison clean campaign A", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(`INSERT INTO rpg_campaign_sheets VALUES
      ('foreign-orphan-sheet', 'other-campaign', 'missing-root', 'core', '1', 'race', 'human',
       'core', '1', 'background', 'sage', '${AT}', '${AT}');
      INSERT INTO campaign_actors VALUES
      ('foreign-orphan-actor', 'other-campaign', 'missing-root', 'foreign-orphan-sheet',
       'player-character', 'principal', '${AT}', '${AT}');
      INSERT INTO campaign_actor_private_state VALUES
        ('foreign-missing-actor', 'other-campaign', 'local-owner', 'foreign secret');
      INSERT INTO rpg_character_attributes VALUES
        ('other-campaign', 'foreign-missing-sheet', 0, 'orphan', 1);
      INSERT INTO rpg_actor_resources VALUES
        ('other-campaign', 'foreign-missing-actor', 'hp', 1, 2);`);
    db.close();

    expect(repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a")?.character.name).toBe("A");
    repository.close();
  });

  it.each([
    ["missing membership", `DELETE FROM campaign_memberships
      WHERE campaign_id = 'campaign-reads' AND principal_id = 'player-two'`],
    ["membership from another campaign only", `DELETE FROM campaign_memberships
      WHERE campaign_id = 'campaign-reads' AND principal_id = 'player-two';
      INSERT INTO campaign_memberships VALUES ('other-campaign', 'player-two', 'player', '${AT}')`],
    ["orphan principal", "DELETE FROM principals WHERE id = 'player-two'"],
    ["unrecognized role", `UPDATE campaign_memberships SET role = 'future-role'
      WHERE campaign_id = 'campaign-reads' AND principal_id = 'player-two'`],
    ["ineligible observer role", `UPDATE campaign_memberships SET role = 'observer'
      WHERE campaign_id = 'campaign-reads' AND principal_id = 'player-two'`],
    ["malformed timestamp", `UPDATE campaign_memberships SET created_at = 'not-a-time'
      WHERE campaign_id = 'campaign-reads' AND principal_id = 'player-two'`],
  ])("rejects attributable non-target private-state controller %s while masking outsiders", (_family, sql) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.exec(sql);
    db.close();

    expect(() => repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a"))
      .toThrow("campaign character workspace is malformed");
    expect(repository.getCampaignCharacterWorkspace("nonmember", campaignId, "cc-a")).toBeNull();
    repository.close();
  });

  it("isolates foreign-campaign private state with malformed controller ancestry", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.exec(`INSERT INTO campaign_characters VALUES
      ('foreign-cc', 'other-campaign', 'persona-a', '${AT}', '${AT}');
      INSERT INTO rpg_campaign_sheets VALUES
      ('foreign-sheet', 'other-campaign', 'foreign-cc', 'core', '1', 'race', 'human',
       'core', '1', 'background', 'sage', '${AT}', '${AT}');
      INSERT INTO campaign_actors VALUES
      ('foreign-actor', 'other-campaign', 'foreign-cc', 'foreign-sheet',
       'player-character', 'principal', '${AT}', '${AT}');
      INSERT INTO campaign_actor_private_state VALUES
      ('foreign-actor', 'other-campaign', 'missing-controller', 'foreign secret')`);
    db.close();

    expect(repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a")?.character.name).toBe("A");
    repository.close();
  });

  it.each([
    ["campaign-character timestamp", "UPDATE campaign_characters SET updated_at = 'not-a-time' WHERE id = 'cc-a'"],
    ["sheet timestamp", "UPDATE rpg_campaign_sheets SET created_at = 7 WHERE id = 'sheet-a'"],
    ["actor timestamp", "UPDATE campaign_actors SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'actor-a'"],
    ["persona name", "UPDATE characters SET name = x'80' WHERE id = 'persona-a'"],
    ["class raw type", "UPDATE rpg_character_classes SET level = 'two' WHERE sheet_id = 'sheet-a'"],
    ["attribute raw type", "INSERT INTO rpg_character_attributes VALUES ('campaign-reads', 'sheet-a', 'bad', 'bad', 1.5)"],
    ["proficiency raw type", "INSERT INTO rpg_character_proficiencies VALUES ('campaign-reads', 'sheet-a', 1, 7, 'bad')"],
    ["resource raw type", "INSERT INTO rpg_actor_resources VALUES ('campaign-reads', 'actor-a', 'hp', 1.5, 2)"],
  ])("rejects malformed workspace %s persistence after authorization", (_family, sql) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.exec(sql);
    db.close();
    expect(() => repository.getCampaignCharacterWorkspace("observer", campaignId, "cc-a"))
      .toThrow("campaign character workspace is malformed");
    expect(repository.getCampaignCharacterWorkspace("nonmember", campaignId, "cc-a")).toBeNull();
    repository.close();
  });

  it.each([
    ["missing selected profile", "DELETE FROM campaign_rules_profiles WHERE campaign_id = 'campaign-reads'"],
    ["missing global profile", "DELETE FROM rpg_rules_profiles WHERE rules_profile_id = 'profile'"],
    ["unsealed pack", "DROP TRIGGER rpg_content_packs_prevent_update; UPDATE rpg_content_packs SET sealed = 0 WHERE pack_id = 'core'"],
    ["mismatched pin profile", "UPDATE campaign_content_packs SET rules_profile_id = 'missing-profile' WHERE campaign_id = 'campaign-reads'"],
    ["malformed race definition", "UPDATE rpg_definitions SET tags = x'80' WHERE kind = 'race'"],
    ["malformed background definition", "UPDATE rpg_definitions SET description = x'80' WHERE kind = 'background'"],
    ["malformed class definition", "UPDATE rpg_definitions SET name = ' ' WHERE kind = 'class'"],
    ["malformed choice definition", `DROP TRIGGER rpg_definitions_prevent_sealed_insert;
      INSERT INTO rpg_definitions VALUES ('core', '1', 'ability', 'bad-choice', 'Bad', 'Description', x'80');
      INSERT INTO rpg_character_choices VALUES
        ('campaign-reads', 'sheet-a', 0, 'choice', 'core', '1', 'ability', 'bad-choice')`],
  ])("rejects workspace %s ancestry or metadata corruption", (_family, sql) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.exec(`DROP TRIGGER rpg_definitions_prevent_update;
      DROP TRIGGER rpg_definitions_tags_update;
      DROP TRIGGER rpg_definitions_tags_insert;
      DROP TRIGGER campaign_content_packs_require_sealed_update;`);
    db.exec(sql);
    db.close();
    expect(() => repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a"))
      .toThrow("campaign character workspace is malformed");
    repository.close();
  });

  it.each([
    ["owner_role", "", "UPDATE campaigns SET owner_role = 'gm' WHERE id = 'campaign-reads'"],
    ["duplicate owner", "DROP INDEX idx_campaign_memberships_one_owner", `INSERT INTO campaign_memberships
      VALUES ('campaign-reads', 'app-owner', 'owner', '${AT}')`],
  ])("rejects workspace %s corruption for members while masking stale/outsider access", (_family, prep, sql) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    if (prep) db.exec(prep);
    db.exec(sql);
    db.close();
    for (const actor of ["local-owner", "gm", "player-one", "observer"]) {
      expect(() => repository.getCampaignCharacterWorkspace(actor, campaignId, "cc-a"))
        .toThrow("campaign character workspace is malformed");
    }
    expect(repository.getCampaignCharacterWorkspace("nonmember", campaignId, "cc-a")).toBeNull();
    repository.close();
  });

  it("enforces workspace MAX+1 resources without projecting their technical identities", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    const insert = db.prepare("INSERT INTO rpg_actor_resources VALUES (?, 'actor-a', ?, 1, 2)");
    db.transaction(() => {
      for (let index = 0; index < 129; index += 1) insert.run(campaignId, `resource-${index}`);
    })();
    db.close();
    expect(() => repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a"))
      .toThrow("campaign character workspace is malformed");
    repository.close();
  });

  it.each(["classes", "attributes", "proficiencies", "choices"] as const)(
    "enforces workspace MAX+1 %s",
    (family) => {
      const repository = seed();
      const db = new DatabaseDriver(dbPath());
      db.pragma("foreign_keys = OFF");
      db.pragma("ignore_check_constraints = ON");
      db.transaction(() => {
        if (family === "classes") {
          db.exec("DROP TRIGGER rpg_definitions_prevent_sealed_insert");
          const definition = db.prepare("INSERT INTO rpg_definitions VALUES ('core', '1', 'class', ?, ?, 'Description', '[]')");
          const item = db.prepare("INSERT INTO rpg_character_classes VALUES (?, 'sheet-a', ?, 'core', '1', 'class', ?, 1)");
          for (let index = 1; index <= 16; index += 1) {
            definition.run(`class-${index}`, `Class ${index}`);
            item.run(campaignId, index, `class-${index}`);
          }
        } else if (family === "attributes") {
          const item = db.prepare("INSERT INTO rpg_character_attributes VALUES (?, 'sheet-a', ?, ?, 1)");
          for (let index = 0; index <= 64; index += 1) item.run(campaignId, index, `attribute-${index}`);
        } else if (family === "proficiencies") {
          const item = db.prepare("INSERT INTO rpg_character_proficiencies VALUES (?, 'sheet-a', ?, 'skill', ?)");
          for (let index = 0; index <= 128; index += 1) item.run(campaignId, index, `proficiency-${index}`);
        } else {
          const item = db.prepare(`INSERT INTO rpg_character_choices
            VALUES (?, 'sheet-a', ?, ?, 'core', '1', 'class', 'fighter')`);
          for (let index = 0; index <= 128; index += 1) item.run(campaignId, index, `choice-${index}`);
        }
      })();
      db.close();
      expect(() => repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a"))
        .toThrow("campaign character workspace is malformed");
      repository.close();
    },
  );

  it.each(["position", "identity"] as const)("rejects duplicate workspace attribute %s evidence", (kind) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    // Rebuild only in this corrupt fixture so impossible-on-schema duplicate
    // evidence can exercise the defensive read validator.
    db.exec(`ALTER TABLE rpg_character_attributes RENAME TO original_attributes;
      CREATE TABLE rpg_character_attributes (
        campaign_id, sheet_id, position, attribute_id, value
      );
      INSERT INTO rpg_character_attributes SELECT * FROM original_attributes;
      DROP TABLE original_attributes;`);
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?, 'sheet-a', 1, 'duplicate', 1)").run(campaignId);
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?, 'sheet-a', ?, ?, 2)").run(
      campaignId,
      kind === "position" ? 1 : 2,
      kind === "position" ? "other" : "duplicate",
    );
    db.close();
    expect(() => repository.getCampaignCharacterWorkspace("gm", campaignId, "cc-a"))
      .toThrow("campaign character workspace is malformed");
    repository.close();
  });

  it("accepts 4000 astral private-note code points and rejects 4001 during read projection", () => {
    const repository = seed();
    const astral = "\u{1F9B9}";
    const accepted = astral.repeat(MAX_PRIVATE_NOTES_LENGTH);
    const rejected = astral.repeat(MAX_PRIVATE_NOTES_LENGTH + 1);
    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE campaign_actor_private_state SET private_notes = ? WHERE actor_id = 'actor-a'").run(accepted);

    expect(repository.getCampaignCharacter("player-one", campaignId, "cc-a")?.projection.actor)
      .toMatchObject({ privateNotes: accepted });
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_actor_private_state SET private_notes = ? WHERE actor_id = 'actor-a'").run(rejected);
    db.close();
    expect(() => repository.getCampaignCharacter("player-one", campaignId, "cc-a")).toThrow();
    repository.close();
  });

  it("returns privileged or public strict reads solely from campaign membership", () => {
    const repository = seed();
    for (const principalId of ["local-owner", "gm"] as const) {
      expect(repository.listCampaignCharacters(principalId, campaignId).map((read) => read.access))
        .toEqual(["privileged", "privileged"]);
    }
    const playerOne = repository.listCampaignCharacters("player-one", campaignId);
    expect(playerOne.map((read) => [read.projection.campaignCharacter.id, read.access]))
      .toEqual([["cc-a", "privileged"], ["cc-b", "public"]]);
    expect(playerOne[0]?.projection.actor).toMatchObject({ controllerPrincipalId: "player-one", privateNotes: "one-secret" });
    expect(playerOne[1]?.projection.actor).not.toHaveProperty("controllerPrincipalId");
    expect(JSON.stringify(playerOne[1])).not.toContain("two-secret");
    expect(repository.listCampaignCharacters("player-two", campaignId).map((read) => read.access))
      .toEqual(["public", "privileged"]);
    expect(repository.listCampaignCharacters("observer", campaignId).every((read) => read.access === "public")).toBe(true);
    expect(repository.listCampaignCharacters("nonmember", campaignId)).toEqual([]);
    expect(repository.getCampaignCharacter("nonmember", campaignId, "cc-a")).toBeNull();

    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE application_owner SET principal_id = 'app-owner' WHERE singleton = 1").run();
    db.close();
    expect(repository.listCampaignCharacters("app-owner", campaignId)).toEqual([]);
    expect(repository.getCampaignCharacter("app-owner", campaignId, "cc-a")).toBeNull();
    repository.close();
  });

  it("gets the same strict aggregate by actor identity with role-gated secrets", () => {
    const repository = seed();
    expect(repository.getCampaignCharacterByActorId("local-owner", campaignId, "actor-a"))
      .toEqual(repository.getCampaignCharacter("local-owner", campaignId, "cc-a"));
    expect(repository.getCampaignCharacterByActorId("gm", campaignId, "actor-a")?.access).toBe("privileged");
    expect(repository.getCampaignCharacterByActorId("player-one", campaignId, "actor-a")?.access).toBe("privileged");
    const otherPlayer = repository.getCampaignCharacterByActorId("player-two", campaignId, "actor-a");
    const observer = repository.getCampaignCharacterByActorId("observer", campaignId, "actor-a");
    expect(otherPlayer?.access).toBe("public");
    expect(observer?.access).toBe("public");
    expect(otherPlayer?.projection.actor).not.toHaveProperty("controllerPrincipalId");
    expect(JSON.stringify(observer)).not.toContain("one-secret");
    expect(repository.getCampaignCharacterByActorId("nonmember", campaignId, "actor-a")).toBeNull();
    expect(repository.getCampaignCharacterByActorId("observer", campaignId, "missing")).toBeNull();
    expect(repository.getCampaignCharacterByActorId("local-owner", "other-campaign", "actor-a")).toBeNull();
    repository.close();
  });

  it("masks stale owners, unknown roles, and orphan authorization parents while preserving GM access", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE campaigns SET owner_principal_id = 'player-one' WHERE id = ?").run(campaignId);
    expect(repository.listCampaignCharacters("local-owner", campaignId)).toEqual([]);
    expect(repository.getCampaignCharacter("local-owner", campaignId, "cc-a")).toBeNull();
    expect(repository.getCampaignCharacterByActorId("local-owner", campaignId, "actor-a")).toBeNull();
    expect(repository.getCampaignCharacterByActorId("gm", campaignId, "actor-a")?.access).toBe("privileged");

    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_memberships SET role = 'future-role' WHERE campaign_id = ? AND principal_id = 'observer'")
      .run(campaignId);
    expect(repository.listCampaignCharacters("observer", campaignId)).toEqual([]);
    expect(repository.getCampaignCharacterByActorId("observer", campaignId, "actor-a")).toBeNull();
    db.prepare("DELETE FROM principals WHERE id = 'gm'").run();
    expect(repository.getCampaignCharacterByActorId("gm", campaignId, "actor-a")).toBeNull();
    db.prepare("DELETE FROM campaigns WHERE id = ?").run(campaignId);
    db.close();
    expect(repository.getCampaignCharacterByActorId("player-one", campaignId, "actor-a")).toBeNull();
    repository.close();
  });

  it("never validates or exposes poisoned private notes on a public projection", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_actor_private_state SET private_notes = ? WHERE actor_id = 'actor-a'")
      .run("x".repeat(MAX_PRIVATE_NOTES_LENGTH + 1));
    db.close();
    expect(repository.getCampaignCharacterByActorId("observer", campaignId, "actor-a")?.access).toBe("public");
    expect(repository.getCampaignCharacterByActorId("player-two", campaignId, "actor-a")?.access).toBe("public");
    expect(() => repository.getCampaignCharacterByActorId("player-one", campaignId, "actor-a")).toThrow();
    expect(() => repository.getCampaignCharacterByActorId("gm", campaignId, "actor-a")).toThrow();
    repository.close();
  });

  it("attributes orphan private-state actor identities to members but masks outsiders", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM campaign_actors WHERE id = 'actor-a'").run();
    db.close();
    for (const principal of ["local-owner", "gm", "player-one", "player-two", "observer"]) {
      expect(() => repository.getCampaignCharacterByActorId(principal, campaignId, "actor-a"))
        .toThrow("campaign character aggregate is incomplete");
      expect(repository.getCampaignCharacterByActorId(principal, campaignId, "genuinely-missing")).toBeNull();
    }
    expect(repository.getCampaignCharacterByActorId("nonmember", campaignId, "actor-a")).toBeNull();
    expect(repository.getCampaignCharacterByActorId("app-owner", campaignId, "actor-a")).toBeNull();
    repository.close();
  });

  it("never SQL-selects paired cross-campaign actor/private secrets for shared or actor-rooted reads", () => {
    const repository = seed();
    const corruptDb = new DatabaseDriver(dbPath());
    corruptDb.pragma("foreign_keys = OFF");
    corruptDb.exec(`UPDATE campaign_actors SET campaign_id = 'other-campaign' WHERE id = 'actor-a';
      UPDATE campaign_actor_private_state
        SET campaign_id = 'other-campaign', private_notes = 'cross-campaign-secret'
        WHERE actor_id = 'actor-a';`);
    corruptDb.close();

    const invocations: Array<{ invoke: () => unknown; parameters: string[]; actorLookup?: boolean }> = [
      { invoke: () => repository.listCampaignCharacters("gm", campaignId),
        parameters: ["gm", "gm", "gm", "gm", campaignId] },
      { invoke: () => repository.getCampaignCharacter("gm", campaignId, "cc-a"),
        parameters: ["gm", "gm", "gm", "gm", campaignId, "cc-a"] },
      { invoke: () => repository.getCampaignCharacterByActorId("gm", campaignId, "actor-a"),
        parameters: ["gm", "gm", "gm", campaignId, "actor-a", campaignId, "actor-a", "gm", campaignId],
        actorLookup: true },
    ];
    for (const { invoke, parameters, actorLookup } of invocations) {
      const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
      if (actorLookup) expect(invoke()).toBeNull();
      else expect(invoke).toThrow("campaign character aggregate is incomplete");
      const sql = prepare.mock.calls[0]![0] as string;
      prepare.mockRestore();
      expect(sql).toMatch(/ps\.actor_id\s*=.*AND ps\.campaign_id\s*=/s);
      expect(sql).toMatch(/a\.campaign_id\s*=\s*cc\.campaign_id|actor_identity\.campaign_id\s*=\s*campaign\.id/s);

      // Execute the exact production SELECT to inspect the pre-projection row.
      // A privileged GM would receive these values if either join admitted B's paired rows.
      const rawDb = new DatabaseDriver(dbPath(), { readonly: true });
      const row = rawDb.prepare(sql).get(...parameters) as {
        actor_presence: string | null;
        private_state_presence: string | null;
        controller_principal_id: string | null;
        private_notes: string | null;
      };
      rawDb.close();
      expect(row.actor_presence).toBeNull();
      expect(row.private_state_presence).toBeNull();
      expect(row.controller_principal_id).toBeNull();
      expect(row.private_notes).toBeNull();
    }
    expect(repository.getCampaignCharacter("nonmember", campaignId, "cc-a")).toBeNull();
    expect(repository.getCampaignCharacterByActorId("nonmember", campaignId, "actor-a")).toBeNull();
    repository.close();
  });

  it("orders aggregates and nested entries, allows empty optional arrays and position gaps, and scopes gets", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.prepare("UPDATE rpg_character_classes SET position = 7 WHERE sheet_id = 'sheet-a'").run();
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?, 'sheet-a', 9, 'wisdom', 14)").run(campaignId);
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?, 'sheet-a', 3, 'strength', 8)").run(campaignId);
    db.close();
    const reads = repository.listCampaignCharacters("local-owner", campaignId);
    expect(reads.map((read) => read.projection.campaignCharacter.id)).toEqual(["cc-a", "cc-b"]);
    expect(reads[0]?.projection.sheet.attributes.map((entry) => entry.attributeId)).toEqual(["strength", "wisdom"]);
    expect(reads[0]?.projection.sheet.classes).toHaveLength(1);
    expect(reads[0]?.projection.sheet.proficiencies).toEqual([]);
    expect(repository.getCampaignCharacter("observer", campaignId, "cc-a")?.access).toBe("public");
    expect(repository.getCampaignCharacter("observer", campaignId, "missing")).toBeNull();
    expect(repository.getCampaignCharacter("local-owner", "other-campaign", "cc-a")).toBeNull();
    repository.close();
  });

  it("throws for authorized missing required rows or zero classes but does not disclose corruption", () => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");

    db.prepare("DELETE FROM rpg_character_classes WHERE sheet_id = 'sheet-a'").run();
    expect(() => repository.getCampaignCharacter("observer", campaignId, "cc-a")).toThrow();
    db.prepare(`INSERT INTO rpg_character_classes
      VALUES (?, 'sheet-a', 0, 'core', '1', 'class', 'fighter', 2)`).run(campaignId);

    db.prepare("DELETE FROM campaign_actor_private_state WHERE actor_id = 'actor-a'").run();
    expect(() => repository.getCampaignCharacter("observer", campaignId, "cc-a")).toThrow("aggregate is incomplete");
    db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor-a', ?, 'player-one', 'one-secret')").run(campaignId);

    db.prepare("DELETE FROM campaign_actors WHERE id = 'actor-a'").run();
    expect(() => repository.getCampaignCharacter("observer", campaignId, "cc-a")).toThrow("aggregate is incomplete");
    db.prepare(`INSERT INTO campaign_actors VALUES
      ('actor-a', ?, 'cc-a', 'sheet-a', 'player-character', 'principal', ?, ?)`).run(campaignId, AT, AT);

    db.prepare("DELETE FROM rpg_campaign_sheets WHERE id = 'sheet-a'").run();
    db.close();
    expect(() => repository.getCampaignCharacter("observer", campaignId, "cc-a")).toThrow("aggregate is incomplete");
    expect(() => repository.listCampaignCharacters("local-owner", campaignId)).toThrow("aggregate is incomplete");
    expect(repository.listCampaignCharacters("nonmember", campaignId)).toEqual([]);
    expect(repository.getCampaignCharacter("nonmember", campaignId, "cc-a")).toBeNull();
    repository.close();
  });

  it.each([
    ["legacy character parent", "DELETE FROM characters WHERE id = 'persona-a'"],
    ["campaign-character campaign link", "UPDATE campaign_characters SET campaign_id = 'other-campaign' WHERE id = 'cc-a'"],
    ["sheet campaign link", "UPDATE rpg_campaign_sheets SET campaign_id = 'other-campaign' WHERE id = 'sheet-a'"],
    ["sheet character link", "UPDATE rpg_campaign_sheets SET campaign_character_id = 'missing' WHERE id = 'sheet-a'"],
    ["actor character link", "UPDATE campaign_actors SET campaign_character_id = 'missing' WHERE id = 'actor-a'"],
    ["actor sheet link", "UPDATE campaign_actors SET sheet_id = 'sheet-b' WHERE id = 'actor-a'"],
    ["private-state parent", "DELETE FROM campaign_actor_private_state WHERE actor_id = 'actor-a'"],
    ["private-state campaign", "UPDATE campaign_actor_private_state SET campaign_id = 'other-campaign' WHERE actor_id = 'actor-a'"],
    ["controller principal", "UPDATE campaign_actor_private_state SET controller_principal_id = 'missing' WHERE actor_id = 'actor-a'"],
    ["controller membership", "DELETE FROM campaign_memberships WHERE campaign_id = 'campaign-reads' AND principal_id = 'player-one'"],
    ["sheet content pin", "DELETE FROM campaign_content_packs WHERE campaign_id = 'campaign-reads' AND pack_id = 'core'"],
    ["sheet content definition", "DROP TRIGGER rpg_definitions_prevent_delete; DELETE FROM rpg_definitions WHERE pack_id = 'core' AND pack_version = '1' AND kind = 'race'"],
    ["class campaign parent", "UPDATE rpg_character_classes SET campaign_id = 'other-campaign' WHERE sheet_id = 'sheet-a'"],
    ["class sheet parent", "UPDATE rpg_character_classes SET sheet_id = 'missing' WHERE sheet_id = 'sheet-a'"],
    ["attribute sheet parent", "INSERT INTO rpg_character_attributes VALUES ('campaign-reads', 'missing', 0, 'orphan', 1)"],
    ["proficiency sheet parent", "INSERT INTO rpg_character_proficiencies VALUES ('campaign-reads', 'missing', 0, 'skill', 'orphan')"],
    ["choice content and sheet parents", "INSERT INTO rpg_character_choices VALUES ('campaign-reads', 'missing', 0, 'choice', 'missing', '1', 'item', 'missing')"],
  ])("rejects authorized actor aggregate corruption in the %s ancestry family", (_family, mutation) => {
    const repository = seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.exec(mutation);
    db.close();
    expect(() => repository.getCampaignCharacterByActorId("gm", campaignId, "actor-a"))
      .toThrow("campaign character aggregate is incomplete");
    expect(() => repository.listCampaignCharacters("gm", campaignId))
      .toThrow("campaign character aggregate is incomplete");
    if (_family === "campaign-character campaign link") {
      expect(repository.getCampaignCharacter("gm", campaignId, "cc-a")).toBeNull();
    } else {
      expect(() => repository.getCampaignCharacter("gm", campaignId, "cc-a")).toThrow();
    }
    expect(repository.getCampaignCharacterByActorId("nonmember", campaignId, "actor-a")).toBeNull();
    expect(repository.listCampaignCharacters("nonmember", campaignId)).toEqual([]);
    repository.close();
  });

  it("uses one CASE-gated read query, no factory transaction or dependencies, and observes lifecycle guards", () => {
    const seeded = seed();
    seeded.close();
    const now = vi.fn(() => new Date(AT));
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({ dataDir: dataDir(), clock: { now }, ids: { nextId } });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      for (const call of [
        () => repository.listCampaignCharacters("player-one", campaignId),
        () => repository.getCampaignCharacter("player-one", campaignId, "cc-a"),
        () => repository.getCampaignCharacterByActorId("player-one", campaignId, "actor-a"),
      ]) {
        prepare.mockClear();
        transaction.mockClear();
        call();
        expect(prepare).toHaveBeenCalledOnce();
        const sql = prepare.mock.calls[0]?.[0] as string;
        expect(sql).toMatch(/^SELECT\s/i);
        expect(sql).not.toMatch(/SELECT\s+\*/i);
        expect(sql).toMatch(/campaign_memberships/);
        expect(sql).toMatch(/JOIN principals requesting_principal/);
        expect(sql).toMatch(/JOIN campaigns campaign/);
        expect(sql.match(/\bCASE\b/gi)?.length).toBeGreaterThanOrEqual(3);
        expect(sql).toMatch(/LEFT JOIN rpg_campaign_sheets/);
        expect(sql).toMatch(/LEFT JOIN campaign_actor_private_state/);
        expect(transaction).not.toHaveBeenCalled();
        expect(now).not.toHaveBeenCalled();
        expect(nextId).not.toHaveBeenCalled();
      }
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
    }

    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unit) => {
      expired = unit;
      expect(unit.listCampaignCharacters("player-one", campaignId))
        .toEqual(repository.listCampaignCharacters("player-one", campaignId));
      expect(unit.getCampaignCharacter("observer", campaignId, "cc-a")?.access).toBe("public");
      expect(unit.getCampaignCharacterByActorId("observer", campaignId, "actor-a")?.access).toBe("public");
    });
    expect(() => expired!.listCampaignCharacters("bad actor", "bad campaign"))
      .toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getCampaignCharacter("bad actor", "bad campaign", "bad character"))
      .toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getCampaignCharacterByActorId("bad actor", "bad campaign", "bad actor id"))
      .toThrow("transaction unit of work is no longer active");
    expect(repoModule).not.toHaveProperty("listCampaignCharacters");
    expect(repoModule).not.toHaveProperty("getCampaignCharacter");
    expect(repoModule).not.toHaveProperty("getCampaignCharacterByActorId");
    repository.close();
    expect(() => repository.listCampaignCharacters("bad actor", "bad campaign")).toThrow("repository is closed");
    expect(() => repository.getCampaignCharacterByActorId("bad actor", "bad campaign", "bad actor id"))
      .toThrow("repository is closed");
  });
});

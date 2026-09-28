import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository, WorldAuthorizationError, WorldUnavailableError } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function seed() {
  const first = createRepository();
  const campaign = first.createCampaign("local-owner", { name: "Faction membership and relations" });
  first.close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys=ON");
  const profile = "dnd-5e";
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES (?,?,?,?)").run(profile, profile, "Rules", "[]");
  db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1',?,'Pack','Pack','[]',0)").run(profile);
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','sage','Sage','Background','[]'),('pack','1','class','wizard','Wizard','Class','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,?)").run(campaign.id, profile);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1',?)").run(campaign.id, profile);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','sage',?,?)").run(campaign.id, at, at);
  for (const [position, id, value] of [[0, "strength", 20], [1, "dexterity", 14], [2, "constitution", 12],
    [3, "intelligence", 16], [4, "wisdom", 14], [5, "charisma", 8]] as const) {
    db.prepare("INSERT INTO rpg_character_attributes VALUES (?,?,?,?,?)").run(campaign.id, "sheet", position, id, value);
  }
  db.prepare("INSERT INTO rpg_character_classes VALUES (?,'sheet',0,'pack','1','class','wizard',5)").run(campaign.id);
  db.prepare("INSERT INTO rpg_character_proficiencies VALUES (?,'sheet',0,'skill','skill.perception')").run(campaign.id);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES('actor',?,'local-owner',NULL)").run(campaign.id);
  db.prepare("INSERT INTO characters VALUES ('npc-persona','NPC One',30,'guide','',1,0,?)").run(at);
  db.prepare("INSERT INTO campaign_npcs_v28 VALUES('npc-1',?,'npc-persona','manual','NPC One',?)").run(campaign.id, at);
  db.prepare("INSERT INTO campaign_factions_v28 VALUES('faction-guild',?,?,?,?)").run(campaign.id, "Guild", "public", at);
  db.prepare("INSERT INTO campaign_factions_v28 VALUES('faction-rivals',?,?,?,?)").run(campaign.id, "Rivals", "public", at);
  db.close();
  let idc = 0;
  const repo = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `faction-command-${++idc}` } });
  return { repo, campaign };
}

describe("faction relation and membership commands", () => {
  it("records a relation command with replay-stable evidence", () => {
    const { repo, campaign } = seed();
    const command = { toFactionId: "faction-rivals", disposition: "hostile" as const, expectedRevision: 0, idempotencyKey: "relation-1" };
    const result = repo.setFactionRelation("local-owner", "faction-guild", command);
    expect(result.fromFactionId).toBe("faction-guild");
    expect(result.relation).toMatchObject({ fromFactionId: "faction-guild", toFactionId: "faction-rivals", disposition: "hostile" });
    expect(result.receipt.revisionBefore).toBe(0);
    expect(result.receipt.revisionAfter).toBe(1);
    expect(repo.setFactionRelation("local-owner", "faction-guild", command)).toEqual(result);

    const db = new DatabaseDriver(dbPath());
    const stored = db.prepare("SELECT relation,command_id FROM campaign_faction_relations_v32 WHERE campaign_id=? AND from_faction_id='faction-guild' AND to_faction_id='faction-rivals'").get(campaign.id) as { relation: string; command_id: string };
    const event = db.prepare(`SELECT event_type FROM world_narrative_events_v32 WHERE campaign_id=? AND command_id=?`).get(campaign.id, stored.command_id) as { event_type: string } | undefined;
    db.close();
    expect(stored.relation).toBe("hostile");
    expect(event?.event_type).toBe("faction_relation_changed");
    repo.close();
  });

  it("upserts relation changes and refuses unknown or self targets", () => {
    const { repo } = seed();
    repo.setFactionRelation("local-owner", "faction-guild", { toFactionId: "faction-rivals", disposition: "allied", expectedRevision: 0, idempotencyKey: "relation-a" });
    const changed = repo.setFactionRelation("local-owner", "faction-guild", { toFactionId: "faction-rivals", disposition: "neutral", expectedRevision: 1, idempotencyKey: "relation-b" });
    expect(changed.relation.disposition).toBe("neutral");
    expect(() => repo.setFactionRelation("local-owner", "faction-guild", { toFactionId: "faction-missing", disposition: "hostile", expectedRevision: 2, idempotencyKey: "relation-c" }))
      .toThrow(WorldUnavailableError);
    expect(() => repo.setFactionRelation("local-owner", "faction-guild", { toFactionId: "faction-guild", disposition: "hostile", expectedRevision: 2, idempotencyKey: "relation-d" }))
      .toThrow(WorldUnavailableError);
    repo.close();
  });

  it("records actor memberships, maps associate to stored ally, and replays", () => {
    const { repo, campaign } = seed();
    const command = { actorId: "actor", role: "associate" as const, expectedRevision: 0, idempotencyKey: "actor-membership-1" };
    const result = repo.changeActorFactionMembership("local-owner", "faction-guild", command);
    expect(result.membership).toMatchObject({ factionId: "faction-guild", actorId: "actor", role: "associate" });
    expect(repo.changeActorFactionMembership("local-owner", "faction-guild", command)).toEqual(result);
    const db = new DatabaseDriver(dbPath());
    const stored = db.prepare("SELECT membership_role FROM campaign_actor_faction_memberships_v28 WHERE campaign_id=? AND faction_id='faction-guild' AND actor_id='actor'").get(campaign.id) as { membership_role: string };
    db.close();
    expect(stored.membership_role).toBe("ally");
    expect(repo.listCampaignFactions("local-owner", campaign.id)).toMatchObject({ memberships: [{ factionId: "faction-guild", actorId: "actor", role: "associate" }] });
    expect(() => repo.changeActorFactionMembership("local-owner", "faction-guild", { actorId: "actor-missing", role: "member", expectedRevision: 1, idempotencyKey: "actor-membership-2" }))
      .toThrow(WorldUnavailableError);
    repo.close();
  });

  it("records NPC memberships and refuses unknown NPCs and factions", () => {
    const { repo, campaign } = seed();
    const result = repo.changeNpcFactionMembership("local-owner", "faction-guild", { npcId: "npc-1", role: "leader", expectedRevision: 0, idempotencyKey: "npc-membership-1" });
    expect(result.membership).toMatchObject({ factionId: "faction-guild", npcId: "npc-1", role: "leader" });
    expect(repo.changeNpcFactionMembership("local-owner", "faction-guild", { npcId: "npc-1", role: "leader", expectedRevision: 0, idempotencyKey: "npc-membership-1" })).toEqual(result);
    expect(() => repo.changeNpcFactionMembership("local-owner", "faction-guild", { npcId: "npc-missing", role: "member", expectedRevision: 1, idempotencyKey: "npc-membership-2" })).toThrow(WorldUnavailableError);
    expect(() => repo.changeNpcFactionMembership("local-owner", "faction-missing", { npcId: "npc-1", role: "member", expectedRevision: 1, idempotencyKey: "npc-membership-3" })).toThrow(WorldUnavailableError);
    expect(repo.listCampaignFactions("local-owner", campaign.id)).toMatchObject({ memberships: [{ factionId: "faction-guild", npcId: "npc-1", role: "leader" }] });
    repo.close();
  });

  it("requires GM authority and rejects invalid roles", () => {
    const { repo, campaign } = seed();
    expect(() => repo.setFactionRelation("outsider", "faction-guild", { toFactionId: "faction-rivals", disposition: "hostile", expectedRevision: 0, idempotencyKey: "unauthorized" }))
      .toThrow(WorldAuthorizationError);
    expect(() => repo.changeActorFactionMembership("outsider", "faction-guild", { actorId: "actor", role: "member", expectedRevision: 0, idempotencyKey: "unauthorized-2" }))
      .toThrow(WorldAuthorizationError);
    expect(() => repo.changeNpcFactionMembership("local-owner", "faction-guild", { npcId: "npc-1", role: "associate", expectedRevision: 0, idempotencyKey: "npc-membership-4" }))
      .not.toThrow();
    // The closed role vocabulary is contract-enforced before any write.
    expect(() => repo.changeActorFactionMembership("local-owner", "faction-guild", { actorId: "actor", role: "ruler" as never, expectedRevision: 1, idempotencyKey: "bad-role" })).toThrow();
    expect(repo.listCampaignFactions("local-owner", campaign.id)?.memberships).toHaveLength(1);
    repo.close();
  });
});

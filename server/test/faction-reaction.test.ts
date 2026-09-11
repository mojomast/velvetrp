import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentObservationRepository } from "../src/repo/observations/agentObservationRepo.js";
import { createRepository, WorldUnavailableError } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function seed() {
  const first = createRepository();
  const campaign = first.createCampaign("local-owner", { name: "Faction reactions" });
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
  db.prepare("INSERT INTO campaign_npc_faction_memberships_v28 VALUES(?,?,?,?,?)")
    .run(campaign.id, "faction-guild", "npc-1", "member", at);
  db.close();
  let idc = 0;
  const repo = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `faction-reaction-${++idc}` } });
  return { repo, campaign };
}

function recordFactionKnowledge(campaign: { id: string; activeTimelineId: string }, sourceCommandId: string) {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys=ON");
  let idc = 0;
  const observations = createAgentObservationRepository(db, {
    clock: { now: () => new Date(at) }, ids: { nextId: () => `knowledge-${++idc}` },
  });
  const row = observations.record({
    campaignId: campaign.id, timelineId: campaign.activeTimelineId, agentKind: "faction", agentId: "faction-guild",
    sourceCommandId, observedRevision: 1, channel: "witnessed", hopCount: 0,
    text: "The party failed a Perception check.", authority: "verified",
  });
  db.close();
  return row;
}

describe("faction reactions", () => {
  it("enacts a gated reaction as its own command and receipt", () => {
    const { repo, campaign } = seed();
    const knowledge = recordFactionKnowledge(campaign, "check-command:1");
    const command = {
      subjectActorId: "actor", delta: -4, reason: "Word of the failed check spread.",
      sourceCommandId: "check-command:1", expectedRevision: 0, idempotencyKey: "reaction-1",
    };
    const result = repo.resolveFactionReaction("local-owner", "faction-guild", command);
    expect(result.standing.reputation).toBe(-4);
    expect(result.standing.subjectActorId).toBe("actor");
    expect(result.sourceObservationId).toBe(knowledge.observationId);
    expect(result.receipt.idempotencyKey).toBe("reaction-1");

    const db = new DatabaseDriver(dbPath());
    const stored = db.prepare(`SELECT command_type FROM world_narrative_commands_v32
      WHERE campaign_id=? AND idempotency_key='reaction-1'`).get(campaign.id) as { command_type: string } | undefined;
    const receipt = db.prepare(`SELECT 1 FROM world_narrative_receipts_v32 receipt
      JOIN world_narrative_commands_v32 command USING(campaign_id,command_id)
      WHERE command.campaign_id=? AND command.idempotency_key='reaction-1'`).get(campaign.id);
    db.close();
    expect(stored?.command_type).toBe("change_faction_reputation");
    expect(receipt).toBeDefined();

    expect(repo.resolveFactionReaction("local-owner", "faction-guild", command)).toEqual(result);
    repo.close();
  });

  it("refuses a reaction when the faction holds no matching knowledge", () => {
    const { repo, campaign } = seed();
    expect(() => repo.resolveFactionReaction("local-owner", "faction-guild", {
      subjectActorId: "actor", delta: -4, reason: "Nothing to react to.",
      sourceCommandId: "check-command:unknown", expectedRevision: 0, idempotencyKey: "reaction-missing",
    })).toThrow(WorldUnavailableError);
    const db = new DatabaseDriver(dbPath());
    const entries = db.prepare(`SELECT COUNT(*) AS count FROM campaign_faction_reputation_v32
      WHERE campaign_id=? AND faction_id='faction-guild'`).get(campaign.id) as { count: number };
    db.close();
    expect(entries.count).toBe(0);
    repo.close();
  });
});

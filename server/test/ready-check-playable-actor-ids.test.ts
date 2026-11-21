// Approved tests from the HAM-4 diagnosis on ed5f105.
// Ready-check waiting IDs were character ids, but play bootstrap playableActors and
// the CampaignPlay ready button use campaign actor ids. Marking ready with those
// actor ids 409'd ("actor is not a room participant"). Dismiss then 409'd on a
// stale revision from the failed ready. Live probe: waiting ids did not match
// playable actor ids; ready+dismiss both succeeded once the waiting-list id was used.
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCampaignReadyCheckRepository } from "../src/repo/campaignReadyCheckRepo.js";
import { getRepositoryDatabase } from "../src/repo/repoContext.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2035-01-01T00:00:00.000Z";
const databasePath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function seedWithDistinctActorIds(): { campaignId: string; sessionId: string } {
  const campaignId = "campaign-one";
  const sessionId = "session-one";
  const repository = createRepository({ dataDir: path.dirname(databasePath()), clock: { now: () => new Date(at) } });
  repository.close();
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO characters VALUES
    ('char-orra', 'Orra Staple', 30, 'warden', 'fictional', 1, 0, ?),
    ('char-tessel', 'Tessel Venn', 30, 'warden', 'fictional', 1, 0, ?)`,
  ).run(at, at);
  db.prepare(`INSERT INTO sessions VALUES (?, 'char-orra', 'Dockside', 'active', 'default', NULL, ?, NULL, NULL)`).run(
    sessionId,
    at,
  );
  db.prepare("INSERT INTO session_characters VALUES (?, 'char-orra', 0), (?, 'char-tessel', 1)").run(
    sessionId,
    sessionId,
  );
  db.transaction(() => {
    db.prepare(
      `INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, 'Ready', 'timeline-one', 'local-owner', ?, ?)`,
    ).run(campaignId, at, at);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES ('timeline-one', ?, ?)").run(
      campaignId,
      at,
    );
    db.prepare("INSERT INTO campaign_memberships VALUES (?, 'local-owner', 'owner', ?)").run(campaignId, at);
    db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile','profile','Rules','[]')").run();
    db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1',?,'Pack','Pack','[]',0)").run("profile");
    db.prepare(
      "INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','sage','Sage','Background','[]')",
    ).run();
    db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
    db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'profile')").run(campaignId);
    db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'pack', '1', 'profile')").run(campaignId);
    db.prepare("INSERT INTO campaign_characters VALUES ('cc-orra', ?, 'char-orra', ?, ?)").run(campaignId, at, at);
    db.prepare("INSERT INTO campaign_characters VALUES ('cc-tessel', ?, 'char-tessel', ?, ?)").run(campaignId, at, at);
    db.prepare(
      "INSERT INTO rpg_campaign_sheets VALUES ('sheet-orra', ?, 'cc-orra', 'pack', '1', 'race', 'human', 'pack', '1', 'background', 'sage', ?, ?)",
    ).run(campaignId, at, at);
    db.prepare(
      "INSERT INTO rpg_campaign_sheets VALUES ('sheet-tessel', ?, 'cc-tessel', 'pack', '1', 'race', 'human', 'pack', '1', 'background', 'sage', ?, ?)",
    ).run(campaignId, at, at);
    db.prepare(
      "INSERT INTO campaign_actors VALUES ('actor-orra', ?, 'cc-orra', 'sheet-orra', 'player-character', 'principal', ?, ?)",
    ).run(campaignId, at, at);
    db.prepare(
      "INSERT INTO campaign_actors VALUES ('actor-tessel', ?, 'cc-tessel', 'sheet-tessel', 'player-character', 'principal', ?, ?)",
    ).run(campaignId, at, at);
  })();
  db.close();
  return { campaignId, sessionId };
}

describe("ready-check identities match playable actor ids", () => {
  it("lists waiting actors by campaign actor id and accepts ready/dismiss with those ids", () => {
    const { campaignId, sessionId } = seedWithDistinctActorIds();
    const campaigns = createRepository({
      dataDir: path.dirname(databasePath()),
      clock: { now: () => new Date(at) },
    });
    const ready = createCampaignReadyCheckRepository({
      getSession: (id) => campaigns.getSession(id),
      database: getRepositoryDatabase(),
    });
    const enabled = ready.commandReadyCheck("local-owner", campaignId, sessionId, {
      action: "enable",
      expectedRevision: 0,
      idempotencyKey: "key-enable",
    });
    expect(enabled.enabled).toBe(true);
    const started = ready.commandReadyCheck("local-owner", campaignId, sessionId, {
      action: "start",
      expectedRevision: enabled.expectedRevision,
      idempotencyKey: "key-start",
    });
    expect(started.check?.waiting).toEqual([
      { actorId: "actor-orra", name: "Orra Staple" },
      { actorId: "actor-tessel", name: "Tessel Venn" },
    ]);
    expect(started.check?.waiting.some((actor) => actor.actorId.startsWith("char-"))).toBe(false);

    const marked = ready.commandReadyCheck("local-owner", campaignId, sessionId, {
      action: "ready",
      actorId: "actor-orra",
      expectedRevision: started.expectedRevision,
      idempotencyKey: "key-ready",
    });
    expect(marked.check?.readyActorIds).toEqual(["actor-orra"]);
    expect(marked.check?.waiting).toEqual([{ actorId: "actor-tessel", name: "Tessel Venn" }]);

    const dismissed = ready.commandReadyCheck("local-owner", campaignId, sessionId, {
      action: "dismiss",
      expectedRevision: marked.expectedRevision,
      idempotencyKey: "key-dismiss",
    });
    expect(dismissed.check).toBeNull();
    campaigns.close();
  });
});

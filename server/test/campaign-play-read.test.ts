import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_RACE } from "@velvet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { createCorruptionTestRepository, useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const databasePath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function seed(sessionId = "room-active", state = "active", finalizeActors = true) {
  let sequence = 0;
  const repo = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `id-${++sequence}` } });
  const campaign = repo.createCampaign("local-owner", { name: "Play" });
  repo.installOriginalStarterContent("local-owner", campaign.id);
  repo.configureOriginalStarterContent("local-owner", campaign.id);
  const first = repo.createCharacter({ name: "Second in room", age: 30, archetype: "hero", boundaries: "", fictionalConfirmed: true });
  const second = repo.createCharacter({ name: "First in room", age: 30, archetype: "hero", boundaries: "", fictionalConfirmed: true });
  repo.close();
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = ON");
  for (const [principal, role] of [["gm", "gm"], ["player", "player"], ["other-player", "player"], ["observer", "observer"]] as const) {
    db.prepare("INSERT INTO principals VALUES (?, ?, 0)").run(principal, principal);
    db.prepare("INSERT INTO campaign_memberships VALUES (?, ?, ?, ?)").run(campaign.id, principal, role, at);
  }
  db.close();
  const writer = createRepository({ clock: { now: () => new Date(at) }, ids: { nextId: () => `actor-${++sequence}` } });
  const createActor = (characterId: string) => writer.createOriginalStarterCampaignCharacter(
    "local-owner", { campaignId: campaign.id, characterId, controllerPrincipalId: "local-owner",
      race: ORIGINAL_STARTER_RACE.reference, background: ORIGINAL_STARTER_BACKGROUND.reference,
      classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }], attributes: [], proficiencies: [], choices: [] },
  ).projection.actor;
  const secondActor = finalizeActors ? createActor(first.id) : undefined;
  const firstActor = finalizeActors ? createActor(second.id) : undefined;
  writer.updateCampaignAdministration("local-owner", campaign.id, {
    status: "published", expectedRevision: 0, idempotencyKey: "publish",
  });
  writer.close();
  const sessionDb = new DatabaseDriver(databasePath());
  sessionDb.pragma("foreign_keys = ON");
  if (secondActor && firstActor) {
    sessionDb.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='other-player' WHERE actor_id=?")
      .run(secondActor.id);
    sessionDb.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='player' WHERE actor_id=?")
      .run(firstActor.id);
  }
  sessionDb.prepare(`INSERT INTO sessions
    (id,character_id,title,state,preset_id,created_at,stopped_at,stop_reason)
    VALUES (?,?,?,?,'private',?,?,?)`).run(sessionId, second.id, "Private room", state, at,
      state === "closed" ? at : null, state === "closed" ? "private reason" : null);
  sessionDb.prepare("INSERT INTO session_characters VALUES (?,?,0)").run(sessionId, second.id);
  sessionDb.prepare("INSERT INTO session_characters VALUES (?,?,1)").run(sessionId, first.id);
  sessionDb.prepare("INSERT INTO campaign_sessions VALUES (?,?,?)").run(sessionId, campaign.id, at);
  sessionDb.close();
  return { campaignId: campaign.id, firstActor: firstActor?.id, secondActor: secondActor?.id, sessionId };
}

function corrupt(sql: string) {
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(sql);
  db.close();
}

describe("campaign play bootstrap repository", () => {
  it("projects revision, role control, and participant-position order without private ancestry", () => {
    const seeded = seed();
    const repo = createRepository();
    const owner = repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, seeded.sessionId)!;
    expect(owner).toEqual({ campaignId: seeded.campaignId, sessionId: seeded.sessionId, expectedRevision: 1,
      dm: { mode: "human", revision: 0 },
      session: { attached: true, attachedAt: at, active: true, adventureEligible: true },
      principal: { role: "owner", control: "all" },
      capabilities: { campaignDice: { canView: true, canRoll: true } },
      playableActors: [{ actorId: seeded.firstActor, name: "First in room" },
        { actorId: seeded.secondActor, name: "Second in room" }] });
    expect(repo.getCampaignPlayBootstrap("gm", seeded.campaignId, seeded.sessionId)?.principal).toEqual({ role: "gm", control: "all" });
    expect(repo.getCampaignPlayBootstrap("player", seeded.campaignId, seeded.sessionId)?.playableActors)
      .toEqual([{ actorId: seeded.firstActor, name: "First in room" }]);
    expect(repo.getCampaignPlayBootstrap("observer", seeded.campaignId, seeded.sessionId)?.playableActors).toEqual([]);
    expect(JSON.stringify(owner)).not.toMatch(/principalId|controller|timeline|persona|sheet|campaignCharacter|private/i);
    repo.close();
  });

  it("derives dice capability from role, settings, membership, and controlled play actors on every read", () => {
    const seeded = seed();
    const repo = createRepository();
    expect(repo.getCampaignPlayBootstrap("gm", seeded.campaignId, seeded.sessionId)?.capabilities.campaignDice)
      .toEqual({ canView: true, canRoll: true });
    expect(repo.getCampaignPlayBootstrap("player", seeded.campaignId, seeded.sessionId)?.capabilities.campaignDice)
      .toEqual({ canView: true, canRoll: true });
    expect(repo.getCampaignPlayBootstrap("observer", seeded.campaignId, seeded.sessionId)?.capabilities.campaignDice)
      .toEqual({ canView: false, canRoll: false });

    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = ON");
    db.prepare("UPDATE campaigns SET settings=json_set(settings,'$.allowPlayerDice',json('false')) WHERE id=?")
      .run(seeded.campaignId);
    expect(repo.getCampaignPlayBootstrap("player", seeded.campaignId, seeded.sessionId)?.capabilities.campaignDice)
      .toEqual({ canView: false, canRoll: false });
    expect(repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, seeded.sessionId)?.capabilities.campaignDice)
      .toEqual({ canView: true, canRoll: true });

    db.prepare("UPDATE campaigns SET settings=json_set(settings,'$.allowPlayerDice',json('true')) WHERE id=?")
      .run(seeded.campaignId);
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='other-player' WHERE actor_id=?")
      .run(seeded.firstActor);
    expect(repo.getCampaignPlayBootstrap("player", seeded.campaignId, seeded.sessionId)?.capabilities.campaignDice)
      .toEqual({ canView: true, canRoll: false });
    db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id='player'").run(seeded.campaignId);
    expect(repo.getCampaignPlayBootstrap("player", seeded.campaignId, seeded.sessionId)).toBeNull();
    db.close(); repo.close();
  });

  it("preserves opaque IDs while disabling strict adventure-stream eligibility", () => {
    const seeded = seed(" room/opaque ");
    const repo = createRepository();
    expect(repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, seeded.sessionId)).toMatchObject({
      sessionId: " room/opaque ", session: { active: true, adventureEligible: false },
    });
    expect(repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, seeded.sessionId.trim())).toBeNull();
    repo.close();
  });

  it("projects an attached room with unfinalized participants as a valid prerequisite state", () => {
    const seeded = seed("room-unfinalized", "active", false);
    const repo = createRepository();
    expect(repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, seeded.sessionId)).toMatchObject({
      session: { active: true, adventureEligible: false },
      principal: { role: "owner", control: "all" },
      playableActors: [],
    });
    expect(repo.getCampaignPlayBootstrap("player", seeded.campaignId, seeded.sessionId)).toMatchObject({
      principal: { role: "player", control: "controlled" }, playableActors: [],
    });
    expect(repo.getCampaignPlayBootstrap("observer", seeded.campaignId, seeded.sessionId)).toMatchObject({
      principal: { role: "observer", control: "none" }, playableActors: [],
    });
    repo.close();
  });

  it.each(["setup", "paused", "cooldown", "closed"])("reports %s sessions as inactive and ineligible", (state) => {
    const seeded = seed(`room-${state}`, state);
    const repo = createRepository();
    expect(repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, seeded.sessionId)?.session)
      .toMatchObject({ active: false, adventureEligible: false });
    repo.close();
  });

  it("null-masks outsiders, missing rooms, and foreign attachments", () => {
    const seeded = seed();
    const repo = createRepository();
    expect(repo.getCampaignPlayBootstrap("missing", seeded.campaignId, seeded.sessionId)).toBeNull();
    expect(repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, "missing-room")).toBeNull();
    expect(repo.getCampaignPlayBootstrap("local-owner", "missing-campaign", seeded.sessionId)).toBeNull();
    repo.close();
  });

  it.each([
    ["duplicate owner", "DROP INDEX idx_campaign_memberships_one_owner; UPDATE campaign_memberships SET role='owner' WHERE principal_id='gm'"],
    ["broken sheet ancestry", "DELETE FROM rpg_campaign_sheets WHERE id=(SELECT sheet_id FROM campaign_actors LIMIT 1)"],
    ["malformed participant positions", "UPDATE session_characters SET position=4 WHERE position=1"],
    ["invalid lifecycle", "UPDATE campaigns SET lifecycle_status='future'"],
  ])("fails loudly for authorized %s corruption", (_label, mutation) => {
    const seeded = seed();
    corrupt(mutation);
    const repo = createCorruptionTestRepository();
    expect(() => repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, seeded.sessionId))
      .toThrow("campaign play bootstrap is malformed");
    expect(repo.getCampaignPlayBootstrap("missing", seeded.campaignId, seeded.sessionId)).toBeNull();
    repo.close();
  });

  it("uses one explicit authorization-rooted read statement and no explicit transaction", () => {
    const seeded = seed();
    const repo = createRepository();
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    expect(repo.getCampaignPlayBootstrap("local-owner", seeded.campaignId, seeded.sessionId)).not.toBeNull();
    expect(prepare).toHaveBeenCalledOnce();
    const sql = prepare.mock.calls[0]![0] as string;
    expect(sql).toMatch(/authority AS MATERIALIZED[\s\S]*authorized AS MATERIALIZED/);
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(transaction).not.toHaveBeenCalled();
    prepare.mockRestore(); transaction.mockRestore(); repo.close();
  });
});

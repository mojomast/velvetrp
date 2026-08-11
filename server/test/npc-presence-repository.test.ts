import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WorldAuthorizationError,
  WorldConflictError,
  WorldStaleError,
  WorldUnavailableError,
  createRepository,
  createSession,
  transitionSession,
} from "../src/repo/index.js";
import { createNpcPresenceRepository } from "../src/repo/world/npcPresenceRepo.js";
import { useTmpDataDir } from "./helpers.js";
import { startLockedWrite } from "./lock-worker.js";

useTmpDataDir();

const times = [
  "2035-01-01T00:01:00.000Z", "2035-01-01T00:02:00.000Z", "2035-01-01T00:03:00.000Z",
  "2035-01-01T00:04:00.000Z", "2035-01-01T00:05:00.000Z", "2035-01-01T00:06:00.000Z",
];

async function fixture() {
  const seed = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
  const campaign = seed.createCampaign("local-owner", { name: "NPC presence" });
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  for (const [id, name] of [["presence-gm", "GM"], ["presence-player", "Player"],
    ["presence-observer", "Observer"], ["presence-outsider", "Outsider"]]) {
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(id, name);
  }
  seed.addCampaignMembership("local-owner", campaign.id, { principalId: "presence-gm", role: "gm" });
  seed.addCampaignMembership("local-owner", campaign.id, { principalId: "presence-player", role: "player" });
  seed.addCampaignMembership("local-owner", campaign.id, { principalId: "presence-observer", role: "observer" });
  const persona = seed.createCharacter({ name: "Marrow", age: 40, archetype: "Merchant", boundaries: "", fictionalConfirmed: true });
  const secondPersona = seed.createCharacter({ name: "Ilex", age: 35, archetype: "Scout", boundaries: "", fictionalConfirmed: true });
  const npc = seed.createCampaignNpc("local-owner", campaign.id, { personaId: persona.id,
    publicState: { name: "Marrow" }, privateState: { goals: "Trade", gmNotes: "Knows the passphrase", merchantState: null },
    expectedRevision: 0, idempotencyKey: "create-marrow" }).npc;
  const secondNpc = seed.createCampaignNpc("local-owner", campaign.id, { personaId: secondPersona.id,
    publicState: { name: "Ilex" }, privateState: { goals: "Scout", gmNotes: "Quiet", merchantState: null },
    expectedRevision: 1, idempotencyKey: "create-ilex" }).npc;
  seed.createLocation("local-owner", { campaignId: campaign.id, locationId: "public-hall", name: "Public Hall", visibility: "visible" });
  seed.createLocation("local-owner", { campaignId: campaign.id, locationId: "gm-vault", name: "GM Vault", visibility: "hidden" });
  const sessionPersona = seed.createCharacter({ name: "Session", age: 30, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
  const session = await createSession({ characterId: sessionPersona.id, title: "Presence session" });
  await transitionSession(session.id, "active", "start");
  seed.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
  seed.close();

  let clockCalls = 0;
  let idCalls = 0;
  const presence = createNpcPresenceRepository(db, {
    clock: { now: () => new Date(times[clockCalls++]!) },
    ids: { nextId: () => `presence-id-${++idCalls}` },
  }, () => undefined);
  const command = (npcId: string, expectedRevision: number, idempotencyKey: string, mutation: any) => ({
    campaignId: campaign.id, sessionId: session.id, npcId, expectedRevision, idempotencyKey, mutation,
  });
  return { db, presence, campaignId: campaign.id, sessionId: session.id, npc, secondNpc, command,
    calls: () => ({ clock: clockCalls, ids: idCalls }) };
}

function corruptTransition(f: Awaited<ReturnType<typeof fixture>>, revision: number, assignment: string): void {
  f.db.pragma("foreign_keys=OFF");
  for (const table of ["npc_presence_commands_v43", "npc_presence_events_v43", "npc_presence_receipts_v43"]) {
    f.db.exec(`DROP TRIGGER ${table}_immutable_update_v43`);
    f.db.prepare(`UPDATE ${table} SET ${assignment} WHERE campaign_id=? AND session_id=? AND resulting_revision=?`)
      .run(f.campaignId, f.sessionId, revision);
  }
  f.db.prepare(`UPDATE campaign_npc_presence_v43 SET ${assignment}
    WHERE campaign_id=? AND session_id=? AND state_revision=?`).run(f.campaignId, f.sessionId, revision);
}

describe("M5.1 NPC presence repository", () => {
  it.each([
    ["setup", null, "running", true],
    ["active", null, "running", true],
    ["paused", null, "running", true],
    ["cooldown", null, "running", true],
    ["closed", times[0], "stopped", false],
  ] as const)("applies projection and fresh-command policy for %s sessions", async (state, stoppedAt, projection, accepts) => {
    const f = await fixture();
    f.db.prepare("UPDATE sessions SET state=?,stopped_at=?,stop_reason=? WHERE id=?")
      .run(state, stoppedAt, stoppedAt === null ? null : "done", f.sessionId);

    expect(f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId)).toMatchObject({ state: projection });
    const mutate = () => f.presence.mutateNpcPresence(
      "local-owner",
      f.command(f.npc.npcId, 0, `place-${state}`, { kind: "place", locationId: null }),
    );
    if (accepts) expect(mutate()).toMatchObject({ receipt: { kind: "place", revisionBefore: 0, revisionAfter: 1 } });
    else expect(mutate).toThrow(WorldUnavailableError);
    f.db.close();
  });

  it("fails loudly for malformed session lifecycle after authorization and masks it from outsiders", async () => {
    const f = await fixture();
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=NULL,stop_reason=NULL WHERE id=?").run(f.sessionId);

    expect(() => f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId))
      .toThrow("campaign room session graph is malformed");
    expect(() => f.presence.mutateNpcPresence(
      "local-owner",
      f.command(f.npc.npcId, 0, "malformed-lifecycle", { kind: "place", locationId: null }),
    )).toThrow("campaign room session graph is malformed");
    expect(f.presence.getNpcCast("presence-outsider", f.campaignId, f.sessionId)).toBeNull();
    f.db.close();
  });

  it("reads revision and lifecycle from one deferred snapshot during a competing commit", async () => {
    const f = await fixture();
    const writer = await startLockedWrite(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), [{
      sql: "UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?",
      params: [times[0], f.sessionId],
    }], 75);
    const prepare = f.db.prepare.bind(f.db);
    let paused = false;
    const spy = vi.spyOn(f.db, "prepare").mockImplementation((source: string) => {
      if (!paused && source.startsWith("SELECT role FROM campaign_memberships")) {
        paused = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
      return prepare(source);
    });

    try {
      expect(f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId)).toEqual({
        audience: "gm", state: "running", sessionRevision: 0, presentCast: [],
      });
      await writer.done;
      expect(f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId)).toEqual({
        audience: "gm", state: "stopped", sessionRevision: 0, castHistory: [],
      });
    } finally {
      spy.mockRestore();
      f.db.close();
    }
  });

  it("enforces the transition matrix, session-root revisions, and per-NPC mutation revisions", async () => {
    const f = await fixture();
    expect(f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId)).toEqual({
      audience: "gm", state: "running", sessionRevision: 0, presentCast: [],
    });
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: null }));
    expect(() => f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 1, "place-again", { kind: "place", locationId: null })))
      .toThrow(WorldConflictError);
    expect(() => f.presence.mutateNpcPresence("local-owner", f.command(f.secondNpc.npcId, 0, "stale", { kind: "place", locationId: null })))
      .toThrow(WorldStaleError);
    f.presence.mutateNpcPresence("presence-gm", f.command(f.secondNpc.npcId, 1, "place-second", { kind: "place", locationId: "public-hall" }));
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 2, "move", { kind: "move", locationId: "public-hall" }));
    expect(() => f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 3, "move-noop", { kind: "move", locationId: "public-hall" })))
      .toThrow(WorldConflictError);
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 3, "remove", { kind: "remove" }));
    expect(() => f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 4, "remove-again", { kind: "remove" })))
      .toThrow(WorldConflictError);
    const rows = f.db.prepare("SELECT npc_id,state,state_revision FROM campaign_npc_presence_v43 ORDER BY npc_id").all();
    expect(rows).toEqual([{ npc_id: f.secondNpc.npcId, state: "present", state_revision: 2 },
      { npc_id: f.npc.npcId, state: "left", state_revision: 4 }].sort((a, b) => a.npc_id.localeCompare(b.npc_id)));
    f.db.close();
  });

  it("derives owner/GM authority and emits exact private versus public projection keys", async () => {
    const f = await fixture();
    f.presence.mutateNpcPresence("presence-gm", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: "public-hall" }));
    expect(() => f.presence.mutateNpcPresence("presence-player", f.command(f.secondNpc.npcId, 1, "player", { kind: "place", locationId: null })))
      .toThrow(WorldAuthorizationError);
    expect(() => f.presence.mutateNpcPresence("presence-observer", f.command(f.secondNpc.npcId, 1, "observer", { kind: "place", locationId: null })))
      .toThrow(WorldAuthorizationError);
    expect(f.presence.getNpcCast("presence-outsider", f.campaignId, f.sessionId)).toBeNull();
    const gm: any = f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId);
    const player: any = f.presence.getNpcCast("presence-player", f.campaignId, f.sessionId);
    const observer: any = f.presence.getNpcCast("presence-observer", f.campaignId, f.sessionId);
    expect(gm.presentCast[0].principals).toEqual(["presence-gm"]);
    expect(Object.keys(gm.presentCast[0])).toEqual(["npcId", "publicState", "revision", "presentAt", "updatedAt",
      "location", "personaId", "principals", "privateState"]);
    expect(Object.keys(player.presentCast[0])).toEqual(["npcId", "publicState", "revision", "presentAt", "updatedAt", "location"]);
    expect(player).toEqual(observer);
    expect(player.presentCast[0].location).toBeNull();
    expect(JSON.stringify(player)).not.toContain("personaId");
    expect(JSON.stringify(player)).not.toContain("passphrase");
    f.db.close();
  });

  it("shows a non-GM running location only after a controlled actor discovers it", async () => {
    const f = await fixture();
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: "public-hall" }));
    expect((f.presence.getNpcCast("presence-player", f.campaignId, f.sessionId) as any).presentCast[0].location).toBeNull();
    f.db.pragma("foreign_keys=OFF");
    f.db.prepare("INSERT INTO campaign_actor_private_state VALUES('player-actor',?,'presence-player',NULL)").run(f.campaignId);
    f.db.prepare("INSERT INTO campaign_location_discoveries_v28 VALUES(?,'player-actor','public-hall',?)")
      .run(f.campaignId, times[1]);
    expect((f.presence.getNpcCast("presence-player", f.campaignId, f.sessionId) as any).presentCast[0].location)
      .toEqual({ label: "Public Hall" });
    expect((f.presence.getNpcCast("presence-observer", f.campaignId, f.sessionId) as any).presentCast[0].location).toBeNull();
    f.db.close();
  });

  it("conceals private locations, rejects cross ancestry, and retains stopped detached history", async () => {
    const f = await fixture();
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: "gm-vault" }));
    expect((f.presence.getNpcCast("presence-player", f.campaignId, f.sessionId) as any).presentCast[0].location).toBeNull();
    expect(() => f.presence.mutateNpcPresence("local-owner", f.command(f.secondNpc.npcId, 1, "bad-location", { kind: "place", locationId: "other-location" })))
      .toThrow(WorldUnavailableError);
    f.presence.mutateNpcPresence("local-owner", f.command(f.secondNpc.npcId, 1, "place-second", { kind: "place", locationId: "public-hall" }));
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 2, "remove", { kind: "remove" }));
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?").run(times[3], f.sessionId);
    expect(() => f.presence.mutateNpcPresence("local-owner", f.command(f.secondNpc.npcId, 3, "after-stop", { kind: "move", locationId: null })))
      .toThrow(WorldUnavailableError);
    const stopped: any = f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId);
    expect(stopped).toMatchObject({ audience: "gm", state: "stopped", sessionRevision: 3,
      castHistory: expect.arrayContaining([
        expect.objectContaining({ npcId: f.npc.npcId, presentAt: times[0], updatedAt: times[2], leftAt: times[2],
          lastLocation: { locationId: "gm-vault", label: "GM Vault" } }),
        expect.objectContaining({ npcId: f.secondNpc.npcId, leftAt: null, lastLocation: { locationId: "public-hall", label: "Public Hall" } }),
      ]) });
    f.db.prepare("DELETE FROM campaign_sessions WHERE campaign_id=? AND session_id=?").run(f.campaignId, f.sessionId);
    expect(f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId)).toEqual(stopped);
    f.db.close();
  });

  it("replays only the persisted receipt after stop and detach without current labels, metadata, IDs, or time", async () => {
    const f = await fixture();
    const firstCommand = f.command(f.npc.npcId, 0, "same-key", { kind: "place", locationId: "public-hall" });
    const first = f.presence.mutateNpcPresence("local-owner", firstCommand);
    f.presence.mutateNpcPresence("local-owner", f.command(f.secondNpc.npcId, 1, "later", { kind: "place", locationId: null }));
    f.db.prepare("UPDATE campaign_locations_v28 SET public_name='Current Hall' WHERE campaign_id=? AND location_id='public-hall'")
      .run(f.campaignId);
    f.db.exec("DROP TRIGGER campaign_npc_metadata_v32_immutable_delete");
    f.db.prepare("DELETE FROM campaign_npc_metadata_v32 WHERE npc_id IN (?,?)").run(f.npc.npcId, f.secondNpc.npcId);
    f.db.prepare("DELETE FROM campaign_npc_private_state_v28 WHERE campaign_id=?").run(f.campaignId);
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?").run(times[2], f.sessionId);
    f.db.prepare("DELETE FROM campaign_sessions WHERE campaign_id=? AND session_id=?").run(f.campaignId, f.sessionId);
    const calls = f.calls();
    expect(f.presence.mutateNpcPresence("local-owner", firstCommand)).toEqual(first);
    expect(f.calls()).toEqual(calls);
    expect(first).toEqual({ receipt: { kind: "place", revisionBefore: 0, revisionAfter: 1, occurredAt: times[0] } });
    expect(() => f.presence.mutateNpcPresence("local-owner", { ...firstCommand, mutation: { kind: "place", locationId: null } }))
      .toThrow(WorldConflictError);
    expect(f.calls()).toEqual(calls);
    f.db.close();
  });

  it("uses command time for removal and permits a new presence after leaving", async () => {
    const f = await fixture();
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: null }));
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 1, "remove", { kind: "remove" }));
    expect(f.db.prepare(`SELECT state,state_entered_at,updated_at FROM campaign_npc_presence_v43
      WHERE campaign_id=? AND session_id=? AND npc_id=?`).get(f.campaignId, f.sessionId, f.npc.npcId)).toEqual({
      state: "left", state_entered_at: times[0], updated_at: times[1],
    });
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 2, "replace", { kind: "place", locationId: "public-hall" }));
    expect(f.db.prepare(`SELECT state,state_revision,state_entered_at,updated_at FROM campaign_npc_presence_v43
      WHERE campaign_id=? AND session_id=? AND npc_id=?`).get(f.campaignId, f.sessionId, f.npc.npcId)).toEqual({
      state: "present", state_revision: 3, state_entered_at: times[2], updated_at: times[2],
    });
    f.db.close();
  });

  it.each([
    ["ledger gap", (f: Awaited<ReturnType<typeof fixture>>) => {
        f.db.pragma("foreign_keys=OFF");
        f.db.exec("DROP TRIGGER npc_presence_commands_v43_immutable_delete_v43");
        f.db.prepare("DELETE FROM npc_presence_commands_v43 WHERE campaign_id=? AND session_id=?").run(f.campaignId, f.sessionId);
      }],
    ["missing receipt binding", (f: Awaited<ReturnType<typeof fixture>>) => {
        f.db.exec("DROP TRIGGER npc_presence_receipts_v43_immutable_delete_v43");
        f.db.prepare("DELETE FROM npc_presence_receipts_v43 WHERE campaign_id=? AND session_id=?").run(f.campaignId, f.sessionId);
      }],
    ["stale materialized state", (f: Awaited<ReturnType<typeof fixture>>) => {
        f.db.exec("DROP TRIGGER campaign_npc_presence_v43_exact_command_update_v43");
        f.db.prepare(`UPDATE campaign_npc_presence_v43 SET updated_at=?
          WHERE campaign_id=? AND session_id=?`).run(times[5], f.campaignId, f.sessionId);
      }],
    ["stale materialized entered timestamp", (f: Awaited<ReturnType<typeof fixture>>) => {
        f.db.prepare(`UPDATE campaign_npc_presence_v43 SET state_entered_at=?
          WHERE campaign_id=? AND session_id=?`).run(times[5], f.campaignId, f.sessionId);
      }],
    ["stale root timestamp", (f: Awaited<ReturnType<typeof fixture>>) => {
        f.db.exec("DROP TRIGGER npc_presence_session_revisions_v43_revision_update_v43");
        f.db.prepare(`UPDATE npc_presence_session_revisions_v43 SET updated_at=?
          WHERE campaign_id=? AND session_id=?`).run(times[5], f.campaignId, f.sessionId);
      }],
    ["event revision corruption", (f: Awaited<ReturnType<typeof fixture>>) => {
        f.db.pragma("foreign_keys=OFF");
        f.db.exec("DROP TRIGGER npc_presence_events_v43_immutable_update_v43");
        f.db.prepare(`UPDATE npc_presence_events_v43 SET resulting_revision=7
          WHERE campaign_id=? AND session_id=?`).run(f.campaignId, f.sessionId);
      }],
    ["receipt revision corruption", (f: Awaited<ReturnType<typeof fixture>>) => {
        f.db.pragma("foreign_keys=OFF");
        f.db.exec("DROP TRIGGER npc_presence_receipts_v43_immutable_update_v43");
        f.db.prepare(`UPDATE npc_presence_receipts_v43 SET resulting_revision=7
          WHERE campaign_id=? AND session_id=?`).run(f.campaignId, f.sessionId);
      }],
  ] as const)("fails loudly for authorized %s corruption without disclosing it", async (_name, corrupt) => {
    const f = await fixture();
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: null }));
    corrupt(f);
    expect(() => f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId)).toThrow(/scoped graph integrity/);
    expect(f.presence.getNpcCast("presence-outsider", f.campaignId, f.sessionId)).toBeNull();
    f.db.close();
  });

  it("keeps history valid after a command GM leaves while another authorized principal reads and writes", async () => {
    const f = await fixture();
    f.presence.mutateNpcPresence("presence-gm", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: null }));
    f.db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id='presence-gm'").run(f.campaignId);
    expect((f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId) as any).presentCast[0].principals)
      .toEqual(["presence-gm"]);
    f.presence.mutateNpcPresence("local-owner", f.command(f.secondNpc.npcId, 1, "owner-place", { kind: "place", locationId: null }));
    expect((f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId) as any).sessionRevision).toBe(2);
    expect(f.presence.getNpcCast("presence-outsider", f.campaignId, f.sessionId)).toBeNull();
    f.db.close();
  });

  it.each([
    ["history starts left", async (f: Awaited<ReturnType<typeof fixture>>) => {
      f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: null }));
      corruptTransition(f, 1, "state='left'");
    }],
    ["present to present keeps its location", async (f: Awaited<ReturnType<typeof fixture>>) => {
      f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: null }));
      f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 1, "move", { kind: "move", locationId: "public-hall" }));
      corruptTransition(f, 2, "location_id=NULL");
    }],
    ["present to left changes its location", async (f: Awaited<ReturnType<typeof fixture>>) => {
      f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: null }));
      f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 1, "remove", { kind: "remove" }));
      corruptTransition(f, 2, "location_id='public-hall'");
    }],
    ["left to left", async (f: Awaited<ReturnType<typeof fixture>>) => {
      f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: null }));
      f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 1, "remove", { kind: "remove" }));
      f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 2, "replace", { kind: "place", locationId: null }));
      corruptTransition(f, 3, "state='left'");
    }],
  ] as const)("rejects illegal per-NPC transition: %s", async (_name, arrange) => {
    const f = await fixture();
    await arrange(f);
    expect(() => f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId)).toThrow(/scoped graph integrity/);
    f.db.close();
  });

  it("keeps stopped non-GM locations null after later discovery as a conservative frozen privacy policy", async () => {
    const f = await fixture();
    f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "place", { kind: "place", locationId: "gm-vault" }));
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?").run(times[1], f.sessionId);
    f.db.pragma("foreign_keys=OFF");
    f.db.prepare("INSERT INTO campaign_actor_private_state VALUES('late-actor',?,'presence-player',NULL)").run(f.campaignId);
    f.db.prepare("INSERT INTO campaign_location_discoveries_v28 VALUES(?,'late-actor','gm-vault',?)")
      .run(f.campaignId, times[2]);
    const player: any = f.presence.getNpcCast("presence-player", f.campaignId, f.sessionId);
    const gm: any = f.presence.getNpcCast("local-owner", f.campaignId, f.sessionId);
    expect(player.castHistory[0].lastLocation).toBeNull();
    expect(gm.castHistory[0].lastLocation).toEqual({ locationId: "gm-vault", label: "GM Vault" });
    f.db.close();
  });

  it("rolls command, event, receipt, root, and state back together", async () => {
    const f = await fixture();
    f.db.exec(`CREATE TRIGGER inject_presence_receipt_failure BEFORE INSERT ON npc_presence_receipts_v43
      BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END`);
    expect(() => f.presence.mutateNpcPresence("local-owner", f.command(f.npc.npcId, 0, "rollback", { kind: "place", locationId: null })))
      .toThrow(/injected receipt failure/);
    for (const table of ["npc_presence_session_revisions_v43", "campaign_npc_presence_v43", "npc_presence_commands_v43",
      "npc_presence_events_v43", "npc_presence_receipts_v43"]) {
      expect(f.db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    f.db.close();
  });
});

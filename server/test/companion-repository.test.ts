import { ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_RACE, canonicalAgentJson } from "@velvet/contracts";
import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CompanionAuthorizationError, CompanionConflictError, CompanionStaleError, CompanionUnavailableError,
  createRepository, createSession, transitionSession,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const later = "2035-01-02T00:00:00.000Z";

async function fixture() {
  let ids = 0, clocks = 0, now = at;
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!,
    ids: { nextId: () => `companion-${++ids}` }, clock: { now: () => { clocks += 1; return new Date(now); } } });
  const campaign = repo.createCampaign("local-owner", { name: "Companions" });
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  for (const [id, label] of [["companion-gm", "GM"], ["companion-player", "Player"],
    ["companion-observer", "Observer"], ["companion-outsider", "Outsider"]]) {
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(id, label);
  }
  repo.addCampaignMembership("local-owner", campaign.id, { principalId: "companion-gm", role: "gm" });
  repo.addCampaignMembership("local-owner", campaign.id, { principalId: "companion-player", role: "player" });
  repo.addCampaignMembership("local-owner", campaign.id, { principalId: "companion-observer", role: "observer" });
  const npcPersona = repo.createCharacter({ name: "Ash", age: 31, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
  const npc = repo.createCampaignNpc("local-owner", campaign.id, { personaId: npcPersona.id,
    publicState: { name: "Ash" }, privateState: { goals: "Guide", gmNotes: "Private", merchantState: null },
    expectedRevision: 0, idempotencyKey: "npc" }).npc;
  repo.installOriginalStarterContent("local-owner", campaign.id);
  repo.configureOriginalStarterContent("local-owner", campaign.id);
  const actorPersona = repo.createCharacter({ name: "Hero", age: 32, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const actorId = repo.createOriginalStarterCampaignCharacter("local-owner", { campaignId: campaign.id,
    characterId: actorPersona.id, controllerPrincipalId: "local-owner", race: ORIGINAL_STARTER_RACE.reference,
    background: ORIGINAL_STARTER_BACKGROUND.reference, classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
    attributes: [], proficiencies: [], choices: [] }).projection.actor.id;
  const sessionPersona = repo.createCharacter({ name: "Room", age: 30, archetype: "Host", boundaries: "", fictionalConfirmed: true });
  const session = await createSession({ characterId: sessionPersona.id, title: "Companion room" });
  await transitionSession(session.id, "active", "start");
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: session.id } as any);
  repo.mutateNpcPresence("local-owner", { campaignId: campaign.id, sessionId: session.id, npcId: npc.npcId,
    expectedRevision: 0, idempotencyKey: "present", mutation: { kind: "place", locationId: null } });
  const create = { sessionId: session.id, npcId: npc.npcId, expectedRevision: 0, idempotencyKey: "companion-create" };
  return { repo, db, campaignId: campaign.id, npcId: npc.npcId, actorId, sessionId: session.id, create,
    calls: () => ({ ids, clocks }), setNow: (value: string) => { now = value; } };
}

describe("M5.2 companion repository administration", () => {
  it("creates only from exact attached running presence and emits role-safe reads", async () => {
    const f = await fixture();
    expect(() => f.repo.createCompanion("companion-player", f.campaignId, f.create)).toThrow(CompanionAuthorizationError);
    const receipt = f.repo.createCompanion("companion-gm", f.campaignId, f.create);
    expect(receipt).toMatchObject({ kind: "companion-create", resultingRevision: 1,
      outcome: { npcId: f.npcId, sessionId: f.sessionId, state: "active", revision: 1 } });
    const command = f.db.prepare("SELECT payload_json,payload_digest FROM companion_commands_v45").get() as any;
    expect(command.payload_json).toBe(canonicalAgentJson({ npcId: f.npcId, sessionId: f.sessionId }));
    expect(command.payload_digest).toBe(createHash("sha256").update(command.payload_json).digest("hex"));
    expect(f.repo.getCompanionManagement("companion-gm", f.campaignId, f.npcId)).toMatchObject({
      campaignId: f.campaignId, sessionId: f.sessionId, revision: 1, grants: [],
    });
    expect(f.repo.getCompanionManagement("companion-player", f.campaignId, f.npcId)).toBeNull();
    expect(f.repo.getCompanionPublic("companion-player", f.campaignId, f.npcId)).toEqual({
      npcId: f.npcId, state: "active", grants: [],
    });
    expect(f.repo.getCompanionPublic("companion-outsider", f.campaignId, f.npcId)).toBeNull();
    f.repo.close(); f.db.close();
  });

  it("replays the stable persisted receipt before lifecycle/revision checks without clock or IDs", async () => {
    const f = await fixture();
    const first = f.repo.createCompanion("local-owner", f.campaignId, f.create);
    f.db.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id=?").run(later, f.sessionId);
    const calls = f.calls();
    expect(f.repo.createCompanion("local-owner", f.campaignId, f.create)).toEqual(first);
    expect(f.calls()).toEqual(calls);
    expect(() => f.repo.createCompanion("local-owner", f.campaignId, { ...f.create, sessionId: "changed" }))
      .toThrow(CompanionConflictError);
    expect(() => f.repo.createCompanion("local-owner", f.campaignId, { ...f.create, idempotencyKey: "fresh" }))
      .toThrow(CompanionStaleError);
    f.repo.close(); f.db.close();
  });

  it("preserves exact arbitrary grant family order and revokes immediately after expiry", async () => {
    const f = await fixture();
    f.repo.createCompanion("local-owner", f.campaignId, f.create);
    const grantInput = { npcId: f.npcId, granteePrincipalId: "companion-player",
      allowedCommandFamilies: ["story-change", "rest", "currency-transfer", "travel"] as
        Array<"story-change" | "rest" | "currency-transfer" | "travel">,
      actorScope: { kind: "campaign-actor" as const, actorId: f.actorId }, resourceScope: { kind: "powers" as const },
      maxSpend: 20, maxUses: 3, startsAt: at, expiresAt: later, confirmationPolicy: "domain-policy" as const,
      expectedRevision: 1, idempotencyKey: "grant-create" };
    const created = f.repo.createCompanionGrant("companion-gm", f.campaignId, grantInput);
    const grantId = (created.outcome as any).grantId;
    const grantCalls = f.calls();
    expect(f.repo.createCompanionGrant("companion-gm", f.campaignId, grantInput)).toEqual(created);
    expect(f.calls()).toEqual(grantCalls);
    expect(() => f.repo.createCompanionGrant("companion-gm", f.campaignId, {
      ...grantInput, maxUses: 4,
    })).toThrow(CompanionConflictError);
    expect(f.repo.getCompanionManagement("local-owner", f.campaignId, f.npcId)?.grants[0]).toMatchObject({
      grantId, grantedByPrincipalId: "companion-gm", granteePrincipalId: "companion-player",
      allowedCommandFamilies: ["story-change", "rest", "currency-transfer", "travel"], actorScope: { actorId: f.actorId },
      exercise: { available: false },
    });
    expect(f.repo.getCompanionPublic("companion-observer", f.campaignId, f.npcId)?.grants[0]).toEqual({
      commandFamilies: ["story-change", "rest", "currency-transfer", "travel"], startsAt: at, expiresAt: later, revokedAt: null,
      exercise: { available: false, reason: "requires-authenticated-principal-boundary-l5" },
    });
    f.setNow("2035-01-03T00:00:00.000Z");
    const revoked = f.repo.revokeCompanionGrant("local-owner", f.campaignId, { npcId: f.npcId, grantId,
      reason: "No longer needed.", expectedRevision: 2, idempotencyKey: "revoke" });
    expect(revoked.outcome).toMatchObject({ grantId, revision: 3, revokedAt: "2035-01-03T00:00:00.000Z" });
    expect(f.repo.getCompanionPublic("companion-player", f.campaignId, f.npcId)?.grants[0]?.revokedAt)
      .toBe("2035-01-03T00:00:00.000Z");
    const revokeCalls = f.calls();
    expect(f.repo.revokeCompanionGrant("local-owner", f.campaignId, { npcId: f.npcId, grantId,
      reason: "No longer needed.", expectedRevision: 2, idempotencyKey: "revoke" })).toEqual(revoked);
    expect(f.calls()).toEqual(revokeCalls);
    expect(() => f.repo.createCompanionGrant("local-owner", f.campaignId, { ...grantInput,
      granteePrincipalId: "local-owner", expectedRevision: 3, idempotencyKey: "self" })).toThrow(CompanionConflictError);
    f.repo.close(); f.db.close();
  });

  it("masks scoped corruption from outsiders and fails loudly for authorized readers", async () => {
    const f = await fixture();
    f.repo.createCompanion("local-owner", f.campaignId, f.create);
    f.db.exec("DROP TRIGGER companion_audit_events_v45_immutable_update_v45");
    f.db.prepare("UPDATE companion_audit_events_v45 SET payload_digest=?").run("f".repeat(64));
    expect(() => f.repo.getCompanionPublic("local-owner", f.campaignId, f.npcId)).toThrow(/scoped graph integrity/);
    expect(f.repo.getCompanionPublic("companion-outsider", f.campaignId, f.npcId)).toBeNull();
    f.repo.close(); f.db.close();
  });

  it.each([
    ["semantic command payload", (f: Awaited<ReturnType<typeof fixture>>) => {
      const json = canonicalAgentJson({ npcId: f.npcId, sessionId: "changed-session" });
      const digest = createHash("sha256").update(json).digest("hex");
      f.db.pragma("foreign_keys=OFF");
      f.db.exec("DROP TRIGGER companion_commands_v45_immutable_update_v45");
      f.db.prepare("UPDATE companion_commands_v45 SET payload_json=?,payload_digest=?").run(json, digest);
    }],
    ["semantic outcome", (f: Awaited<ReturnType<typeof fixture>>) => {
      const json = canonicalAgentJson({ npcId: f.npcId, sessionId: f.sessionId, state: "active", revision: 9 });
      const digest = createHash("sha256").update(json).digest("hex");
      f.db.exec(`DROP TRIGGER companion_receipts_v45_immutable_update_v45;
        DROP TRIGGER companion_audit_events_v45_immutable_update_v45`);
      f.db.prepare("UPDATE companion_receipts_v45 SET outcome_json=?,outcome_digest=?").run(json, digest);
      f.db.prepare("UPDATE companion_audit_events_v45 SET payload_json=?,payload_digest=?").run(json, digest);
    }],
    ["canonical command payload", (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db.exec("DROP TRIGGER companion_commands_v45_immutable_update_v45");
      f.db.pragma("ignore_check_constraints=ON");
      f.db.prepare("UPDATE companion_commands_v45 SET payload_json=' {\"npcId\":\"changed\"}'").run();
    }],
  ] as const)("rejects %s corruption for authorized public reads and masks outsiders", async (_name, corrupt) => {
    const f = await fixture();
    f.repo.createCompanion("local-owner", f.campaignId, f.create);
    corrupt(f);
    expect(() => f.repo.getCompanionPublic("companion-player", f.campaignId, f.npcId)).toThrow(/scoped graph integrity/);
    expect(f.repo.getCompanionPublic("companion-outsider", f.campaignId, f.npcId)).toBeNull();
    f.repo.close(); f.db.close();
  });

  it("rolls all companion writes back and enforces nested and closed guards", async () => {
    const f = await fixture();
    f.db.exec(`CREATE TRIGGER inject_companion_audit_failure BEFORE INSERT ON companion_audit_events_v45
      BEGIN SELECT RAISE(ABORT,'injected companion audit failure'); END`);
    expect(() => f.repo.createCompanion("local-owner", f.campaignId, f.create)).toThrow(/injected companion audit failure/);
    for (const table of ["companion_commands_v45", "companion_receipts_v45", "campaign_companions_v45",
      "companion_presence_links_v45", "companion_audit_events_v45"]) {
      expect(f.db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    f.db.exec("DROP TRIGGER inject_companion_audit_failure");
    expect(() => f.repo.transaction(() => f.repo.createCompanion("local-owner", f.campaignId, f.create)))
      .toThrow(/cannot run inside a repository transaction/);
    expect(f.repo.transaction((unit) => unit.getCompanionPublic("local-owner", f.campaignId, f.npcId))).toBeNull();
    f.repo.close();
    expect(() => f.repo.getCompanionPublic("local-owner", f.campaignId, f.npcId)).toThrow(/repository is closed/);
    f.db.close();
  });

  it("replays for the exact issuer after demotion and v45 membership removal", async () => {
    const f = await fixture();
    const first = f.repo.createCompanion("companion-gm", f.campaignId, f.create);
    f.db.prepare("UPDATE campaign_memberships SET role='player' WHERE campaign_id=? AND principal_id='companion-gm'")
      .run(f.campaignId);
    const calls = f.calls();
    expect(f.repo.createCompanion("companion-gm", f.campaignId, f.create)).toEqual(first);
    expect(f.calls()).toEqual(calls);
    expect(() => f.repo.createCompanion("companion-gm", f.campaignId, { ...f.create, idempotencyKey: "fresh-after-demotion" }))
      .toThrow(CompanionAuthorizationError);

    const administration = f.repo.getCampaignAdministration("local-owner", f.campaignId)!;
    f.repo.removeAuditedCampaignMembership("local-owner", f.campaignId, "companion-gm", {
      expectedRevision: administration.revision, idempotencyKey: "remove-companion-gm",
    });
    expect(f.repo.createCompanion("companion-gm", f.campaignId, f.create)).toEqual(first);
    expect(() => f.repo.createCompanion("companion-gm", f.campaignId, { ...f.create, sessionId: "changed" }))
      .toThrow(CompanionAuthorizationError);
    f.repo.close(); f.db.close();
  });

  it("keeps another principal's key nondisclosing until current authorization decides", async () => {
    const f = await fixture();
    f.repo.createCompanion("companion-gm", f.campaignId, f.create);
    expect(() => f.repo.createCompanion("companion-player", f.campaignId, f.create)).toThrow(CompanionAuthorizationError);
    expect(() => f.repo.createCompanion("local-owner", f.campaignId, f.create)).toThrow(CompanionConflictError);
    f.repo.close(); f.db.close();
  });

  it("rejects unavailable presence, foreign grantees, bad ancestry, and nonfuture expiry", async () => {
    const f = await fixture();
    f.repo.mutateNpcPresence("local-owner", { campaignId: f.campaignId, sessionId: f.sessionId, npcId: f.npcId,
      expectedRevision: 1, idempotencyKey: "leave", mutation: { kind: "remove" } });
    expect(() => f.repo.createCompanion("local-owner", f.campaignId, f.create)).toThrow(CompanionUnavailableError);
    f.repo.mutateNpcPresence("local-owner", { campaignId: f.campaignId, sessionId: f.sessionId, npcId: f.npcId,
      expectedRevision: 2, idempotencyKey: "return", mutation: { kind: "place", locationId: null } });
    f.repo.createCompanion("local-owner", f.campaignId, f.create);
    const base = { npcId: f.npcId, granteePrincipalId: "companion-outsider", allowedCommandFamilies: ["rest"] as "rest"[],
      actorScope: { kind: "campaign-actor" as const, actorId: f.actorId }, resourceScope: { kind: "actor-resources" as const },
      maxSpend: null, maxUses: null, startsAt: at, expiresAt: later, confirmationPolicy: "always" as const,
      expectedRevision: 1, idempotencyKey: "bad-grantee" };
    expect(() => f.repo.createCompanionGrant("local-owner", f.campaignId, base)).toThrow(CompanionUnavailableError);
    expect(() => f.repo.createCompanionGrant("local-owner", f.campaignId, { ...base, granteePrincipalId: "companion-player",
      actorScope: { kind: "campaign-actor", actorId: "missing" }, idempotencyKey: "bad-actor" }))
      .toThrow(CompanionUnavailableError);
    expect(() => f.repo.createCompanionGrant("local-owner", f.campaignId, { ...base, granteePrincipalId: "companion-player",
      startsAt: "2034-12-31T00:00:00.000Z", expiresAt: at, idempotencyKey: "expired" }))
      .toThrow(CompanionConflictError);
    f.repo.close(); f.db.close();
  });
});

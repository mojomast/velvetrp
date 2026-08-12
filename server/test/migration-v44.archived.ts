import {
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_RACE,
} from "@velvet/contracts";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import {
  COMPANION_CORE_V44_LAYOUT_DIGEST,
  COMPANION_CORE_V44_MANAGED_OBJECTS,
  assertCompanionCoreLayoutV44,
} from "../src/repo/db/migrations/v44_companion_core.js";
import { buildCanonicalV43Fixture, SUPPORT_WINDOW, type SupportWindowFixture } from "./fixtures/migrations/support-window.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const dataTables = COMPANION_CORE_V44_MANAGED_OBJECTS
  .filter(([type, name]) => type === "table" && name !== "companion_layout_attestation_v44")
  .map(([, name]) => name);

function open(): DatabaseDriver.Database {
  const db = new DatabaseDriver(file());
  db.pragma("foreign_keys=ON");
  return db;
}

function createActor(campaignId: string, prefix: string): string {
  let id = 0;
  const repo = createRepository({ clock: { now: () => new Date(SUPPORT_WINDOW.at) }, ids: { nextId: () => `${prefix}-${++id}` } });
  repo.installOriginalStarterContent("local-owner", campaignId);
  repo.configureOriginalStarterContent("local-owner", campaignId);
  const persona = repo.createCharacter({ name: `${prefix} actor`, age: 30, archetype: "warden", boundaries: "", fictionalConfirmed: true });
  const actorId = repo.createOriginalStarterCampaignCharacter("local-owner", {
    campaignId, characterId: persona.id, controllerPrincipalId: "local-owner",
    race: ORIGINAL_STARTER_RACE.reference, background: ORIGINAL_STARTER_BACKGROUND.reference,
    classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }], attributes: [], proficiencies: [], choices: [],
  }).projection.actor.id;
  repo.close();
  return actorId;
}

function insertCommand(db: DatabaseDriver.Database, fixture: SupportWindowFixture, input: {
  id: string; key: string; kind: "companion-create" | "grant-create" | "grant-revoke";
  expected: number; principal?: string; payloadDigest?: string;
}): void {
  db.prepare(`INSERT INTO companion_commands_v44
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(fixture.campaignId, fixture.npcId, input.id, input.key,
    input.principal ?? "local-owner", input.kind, input.expected, input.expected + 1, "{}", input.payloadDigest ?? digestA, SUPPORT_WINDOW.at);
  db.prepare(`INSERT INTO companion_receipts_v44
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`${input.id}-receipt`, fixture.campaignId, fixture.npcId, input.id, input.key,
    input.kind, input.expected + 1, input.payloadDigest ?? digestA, "{}", digestB, SUPPORT_WINDOW.at);
}

function seedCompanion(db: DatabaseDriver.Database, fixture: SupportWindowFixture): void {
  insertCommand(db, fixture, { id: "create-command", key: "create-key", kind: "companion-create", expected: 0 });
  db.prepare(`INSERT INTO campaign_companions_v44
    VALUES(?,?,?,'active',1,?,?,'create-command','create-command-receipt',1,'companion-create',?,
      'create-command','create-command-receipt','companion-create',?)`)
    .run(fixture.campaignId, fixture.npcId, fixture.sessionId, SUPPORT_WINDOW.at, SUPPORT_WINDOW.at, digestA, digestA);
  db.prepare(`INSERT INTO companion_presence_links_v44
    VALUES(?,?,?,'create-command','create-command-receipt',1,'companion-create',?,?)`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, digestA, SUPPORT_WINDOW.at);
  db.prepare(`INSERT INTO companion_audit_events_v44
    VALUES('create-audit',?,?,'companion-created','create-command',1,'create-command-receipt','companion-create',?,'{}',?,?)`)
    .run(fixture.campaignId, fixture.npcId, digestA, digestA, SUPPORT_WINDOW.at);
}

function insertGrant(db: DatabaseDriver.Database, fixture: SupportWindowFixture, actorId: string,
  grantee = "grant-target", grantId = "grant", confirmationPolicy: "always" | "domain-policy" = "domain-policy",
  commandId = "grant-command", revision = 2): void {
  db.transaction(() => {
    db.prepare("INSERT INTO companion_grant_command_families_v44 VALUES(?,?,?,'power-use')")
      .run(grantId, fixture.campaignId, fixture.npcId);
    db.prepare(`INSERT INTO companion_grants_v44
      (grant_id,campaign_id,npc_id,granted_by_principal_id,grantee_principal_id,actor_id,resource_scope_kind,confirmation_policy,
       primary_command_family,max_spend,max_uses,starts_at,expires_at,created_command_id,created_receipt_id,created_revision,
       created_command_kind,created_payload_digest,created_at)
      VALUES(?,?,?,?,?,?,'powers',?,'power-use',20,3,?,'2035-01-02T00:00:00.000Z',?,?,?,'grant-create',?,?)`)
      .run(grantId, fixture.campaignId, fixture.npcId, "local-owner", grantee, actorId, confirmationPolicy,
        SUPPORT_WINDOW.at, commandId, `${commandId}-receipt`, revision, digestA, SUPPORT_WINDOW.at);
  })();
}

describe("schema v44 companion core", () => {
  it("creates the exact attested inventory with deterministic empty sidecars", () => {
    buildCanonicalV43Fixture();
    createRepository().close();
    const db = open();
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "44" });
    const inventory = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v44*' AND sql IS NOT NULL ORDER BY type,name").all();
    expect(inventory).toEqual([...COMPANION_CORE_V44_MANAGED_OBJECTS]
      .map(([type, name]) => ({ type, name })).sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name)));
    expect(db.prepare("SELECT layout_digest FROM companion_layout_attestation_v44 WHERE singleton=1").get())
      .toEqual({ layout_digest: COMPANION_CORE_V44_LAYOUT_DIGEST });
    for (const table of dataTables) expect(db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("enforces one immutable command and receipt per revision with exact retry identity", () => {
    const fixture = buildCanonicalV43Fixture();
    createRepository().close();
    const db = open();
    seedCompanion(db, fixture);
    expect(db.prepare(`SELECT command_id,resulting_revision,payload_digest FROM companion_commands_v44
      WHERE campaign_id=? AND npc_id=? AND idempotency_key='create-key'`).get(fixture.campaignId, fixture.npcId))
      .toEqual({ command_id: "create-command", resulting_revision: 1, payload_digest: digestA });
    expect(db.prepare("SELECT receipt_id FROM companion_receipts_v44 WHERE command_id='create-command'").get())
      .toEqual({ receipt_id: "create-command-receipt" });
    expect(() => db.prepare(`INSERT INTO companion_commands_v44 VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(fixture.campaignId, fixture.npcId, "retry-other", "create-key", "local-owner", "companion-create", 0, 1, "{}", digestA, SUPPORT_WINDOW.at)).toThrow(/UNIQUE/);
    expect(() => db.prepare(`INSERT INTO companion_commands_v44 VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(fixture.campaignId, fixture.npcId, "revision-other", "other-key", "local-owner", "grant-create", 0, 1, "{}", digestA, SUPPORT_WINDOW.at)).toThrow(/UNIQUE/);
    expect(() => db.prepare(`INSERT INTO companion_receipts_v44 VALUES('wrong',?,?,?,?,?,?,?,?,?,?)`)
      .run(fixture.campaignId, fixture.npcId, "missing-command", "create-key", "companion-create", 2, digestB, "{}", digestB, SUPPORT_WINDOW.at)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("UPDATE companion_commands_v44 SET payload_json='{}'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM companion_receipts_v44").run()).toThrow(/immutable/);
    insertCommand(db, fixture, { id: "next-command", key: "next-key", kind: "grant-create", expected: 1 });
    expect(() => db.prepare("UPDATE campaign_companions_v44 SET state='dismissed' WHERE campaign_id=? AND npc_id=?")
      .run(fixture.campaignId, fixture.npcId)).toThrow(/advance exactly once/);
    expect(() => db.prepare(`UPDATE campaign_companions_v44 SET revision=3,last_command_id='next-command',
      last_receipt_id='next-command-receipt',last_command_kind='grant-create',last_payload_digest=? WHERE campaign_id=? AND npc_id=?`)
      .run(digestA, fixture.campaignId, fixture.npcId)).toThrow(/advance exactly once/);
    expect(() => db.prepare(`UPDATE campaign_companions_v44 SET revision=2,initial_session_id='changed',
      last_command_id='next-command',last_receipt_id='next-command-receipt',last_command_kind='grant-create',last_payload_digest=?
      WHERE campaign_id=? AND npc_id=?`).run(digestA, fixture.campaignId, fixture.npcId)).toThrow(/preserve creation anchors/);
    expect(() => db.prepare(`UPDATE campaign_companions_v44 SET revision=2,last_command_id='next-command',
      last_receipt_id='create-command-receipt',last_command_kind='grant-create',last_payload_digest=? WHERE campaign_id=? AND npc_id=?`)
      .run(digestA, fixture.campaignId, fixture.npcId)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`UPDATE campaign_companions_v44 SET revision=2,last_command_id='next-command',
      last_receipt_id='next-command-receipt',last_command_kind='grant-create',last_payload_digest=? WHERE campaign_id=? AND npc_id=?`)
      .run(digestA, fixture.campaignId, fixture.npcId)).not.toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("requires campaign-member grants, a real campaign actor, closed resource scope, and a nonempty family set", () => {
    const fixture = buildCanonicalV43Fixture();
    createRepository().close();
    const actorId = createActor(fixture.campaignId, "grant-actor");
    const repo = createRepository({ clock: { now: () => new Date(SUPPORT_WINDOW.at) }, ids: { nextId: () => "other-campaign" } });
    const other = repo.createCampaign("local-owner", { name: "Other" });
    repo.close();
    const otherActorId = createActor(other.id, "other-actor");
    const db = open();
    db.prepare("INSERT INTO principals VALUES('grant-target','Grant target',0)").run();
    db.prepare("INSERT INTO principals VALUES('other-member','Other member',0)").run();
    db.prepare("INSERT INTO campaign_memberships VALUES(?,?,'player',?)").run(fixture.campaignId, "grant-target", SUPPORT_WINDOW.at);
    db.prepare("INSERT INTO campaign_memberships VALUES(?,?,'player',?)").run(other.id, "other-member", SUPPORT_WINDOW.at);
    seedCompanion(db, fixture);
    insertCommand(db, fixture, { id: "grant-command", key: "grant-key", kind: "grant-create", expected: 1 });
    db.prepare(`UPDATE campaign_companions_v44 SET revision=2,updated_at=?,last_command_id='grant-command',
      last_receipt_id='grant-command-receipt',last_command_kind='grant-create',last_payload_digest=? WHERE campaign_id=? AND npc_id=?`)
      .run(SUPPORT_WINDOW.at, digestA, fixture.campaignId, fixture.npcId);
    insertGrant(db, fixture, actorId);
    db.prepare(`INSERT INTO companion_audit_events_v44
      VALUES('grant-audit',?,?,'grant-created','grant-command',2,'grant-command-receipt','grant-create',?,'{}',?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, digestA, SUPPORT_WINDOW.at);
    insertCommand(db, fixture, { id: "always-grant-command", key: "always-grant-key", kind: "grant-create", expected: 2 });
    db.prepare(`UPDATE campaign_companions_v44 SET revision=3,updated_at=?,last_command_id='always-grant-command',
      last_receipt_id='always-grant-command-receipt',last_command_kind='grant-create',last_payload_digest=? WHERE campaign_id=? AND npc_id=?`)
      .run(SUPPORT_WINDOW.at, digestA, fixture.campaignId, fixture.npcId);
    insertGrant(db, fixture, actorId, "grant-target", "always-grant", "always", "always-grant-command", 3);
    db.prepare(`INSERT INTO companion_audit_events_v44
      VALUES('always-grant-audit',?,?,'grant-created','always-grant-command',3,'always-grant-command-receipt','grant-create',?,'{}',?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, digestA, SUPPORT_WINDOW.at);
    expect(db.prepare("SELECT grant_id,confirmation_policy FROM companion_grants_v44 ORDER BY grant_id").all()).toEqual([
      { grant_id: "always-grant", confirmation_policy: "always" },
      { grant_id: "grant", confirmation_policy: "domain-policy" },
    ]);
    expect(() => insertGrant(db, fixture, actorId, "other-member", "cross-campaign")).toThrow(/FOREIGN KEY/);
    expect(() => insertGrant(db, fixture, otherActorId, "grant-target", "cross-actor")).toThrow(/FOREIGN KEY/);
    expect(() => insertGrant(db, fixture, actorId, "local-owner", "self-grant")).toThrow(/CHECK/);
    expect(() => db.transaction(() => {
      db.prepare(`INSERT INTO companion_grants_v44
        (grant_id,campaign_id,npc_id,granted_by_principal_id,grantee_principal_id,actor_id,resource_scope_kind,
         confirmation_policy,primary_command_family,starts_at,expires_at,created_command_id,created_receipt_id,created_revision,created_command_kind,created_payload_digest,created_at)
        VALUES('bad-resource',?,?,?,?,?,'opaque','always','power-use',?,'2035-01-02T00:00:00.000Z','grant-command','grant-command-receipt',2,'grant-create',?,?)`)
        .run(fixture.campaignId, fixture.npcId, "local-owner", "grant-target", actorId, SUPPORT_WINDOW.at, digestA, SUPPORT_WINDOW.at);
    })()).toThrow(/CHECK/);
    expect(() => db.prepare("DELETE FROM companion_grant_command_families_v44 WHERE grant_id='grant'").run()).toThrow(/immutable/);
    insertCommand(db, fixture, { id: "revoke-command", key: "revoke-key", kind: "grant-revoke", expected: 3 });
    db.prepare(`UPDATE campaign_companions_v44 SET revision=4,updated_at=?,last_command_id='revoke-command',
      last_receipt_id='revoke-command-receipt',last_command_kind='grant-revoke',last_payload_digest=? WHERE campaign_id=? AND npc_id=?`)
      .run(SUPPORT_WINDOW.at, digestA, fixture.campaignId, fixture.npcId);
    db.prepare(`INSERT INTO companion_grant_revocations_v44
      VALUES('grant',?,?,?,'Owner revoked access.','local-owner','revoke-command','revoke-command-receipt',4,'grant-revoke',?)`)
      .run(fixture.campaignId, fixture.npcId, SUPPORT_WINDOW.at, digestA);
    db.prepare(`INSERT INTO companion_audit_events_v44
      VALUES('revoke-audit',?,?,'grant-revoked','revoke-command',4,'revoke-command-receipt','grant-revoke',?,'{}',?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, digestA, SUPPORT_WINDOW.at);
    expect(db.prepare("SELECT revoked_command_id,revoked_revision FROM companion_grant_revocations_v44").get())
      .toEqual({ revoked_command_id: "revoke-command", revoked_revision: 4 });
    expect(() => db.prepare("UPDATE companion_grant_revocations_v44 SET revocation_reason='changed'").run()).toThrow(/immutable/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("validates proposer relationships, optional actor scope, exact reviewed digests, and relational receipts", () => {
    const fixture = buildCanonicalV43Fixture();
    createRepository().close();
    const actorId = createActor(fixture.campaignId, "proposal-actor");
    const db = open();
    seedCompanion(db, fixture);
    db.prepare(`INSERT INTO companion_proposals_v44
      VALUES('proposal',?,?,?,'provider',NULL,NULL,'provider-call',NULL,'power-use','none',NULL,'powers','{}',?,'{}',?,'pending',?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, digestA, digestB, SUPPORT_WINDOW.at);
    db.prepare(`INSERT INTO companion_proposals_v44
      VALUES('actor-proposal',?,?,?,'campaign-principal','local-owner',NULL,NULL,NULL,'rest','campaign-actor',?,'actor-resources','{}',?,'{}',?,'pending',?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, actorId, digestA, digestB, SUPPORT_WINDOW.at);
    expect(() => db.prepare(`INSERT INTO companion_proposals_v44
      VALUES('bad-proposer',?,?,?,'campaign-principal','missing',NULL,NULL,NULL,'rest','none',NULL,'none','{}',?,'{}',?,'pending',?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, digestA, digestB, SUPPORT_WINDOW.at)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO companion_proposals_v44
      VALUES('bad-companion',?,?,?,'companion',NULL,'missing-npc',NULL,NULL,'rest','none',NULL,'none','{}',?,'{}',?,'pending',?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, digestA, digestB, SUPPORT_WINDOW.at)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO companion_proposals_v44
      VALUES('bad-actor',?,?,?,'provider',NULL,NULL,'provider-call-2',NULL,'rest','campaign-actor','missing-actor','none','{}',?,'{}',?,'pending',?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, digestA, digestB, SUPPORT_WINDOW.at)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO companion_decisions_v44
      VALUES('wrong','proposal',?,?,'local-owner','approved','power-use',?,?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestB, digestB, SUPPORT_WINDOW.at)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO companion_decisions_v44
      VALUES('wrong-policy','proposal',?,?,'local-owner','approved','power-use',?,?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, digestA, SUPPORT_WINDOW.at)).toThrow(/FOREIGN KEY/);
    db.prepare(`INSERT INTO companion_decisions_v44
      VALUES('decision','proposal',?,?,'local-owner','approved','power-use',?,?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, digestB, SUPPORT_WINDOW.at);
    db.prepare(`INSERT INTO companion_decisions_v44
      VALUES('rejected-decision','actor-proposal',?,?,'local-owner','rejected','rest',?,?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, digestB, SUPPORT_WINDOW.at);
    expect(() => db.prepare(`INSERT INTO companion_decision_receipts_v44
      VALUES('bad-receipt','decision','actor-proposal',?,?,'power-use','approved','domain-command','{}',?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, SUPPORT_WINDOW.at)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`INSERT INTO companion_decision_receipts_v44
      VALUES('rejected-receipt','rejected-decision','actor-proposal',?,?,'rest','approved','domain-command','{}',?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, SUPPORT_WINDOW.at)).toThrow(/FOREIGN KEY/);
    db.prepare(`INSERT INTO companion_decision_receipts_v44
      VALUES('decision-receipt','decision','proposal',?,?,'power-use','approved','domain-command','{}',?,?)`)
      .run(fixture.campaignId, fixture.npcId, digestA, SUPPORT_WINDOW.at);
    expect(() => db.prepare("UPDATE companion_proposals_v44 SET exact_command_json='{}'").run()).toThrow(/immutable/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rejects current-marker foreign-key corruption before layout acceptance", () => {
    const fixture = buildCanonicalV43Fixture();
    createRepository().close();
    const db = new DatabaseDriver(file());
    db.pragma("foreign_keys=OFF");
    db.prepare(`INSERT INTO companion_commands_v44 VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(fixture.campaignId, fixture.npcId, "corrupt", "corrupt", "missing-principal", "companion-create", 0, 1, "{}", digestA, SUPPORT_WINDOW.at);
    db.close();
    expect(() => createRepository()).toThrow("schema marker 44 contains foreign-key violation in companion_commands_v44");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "44" });
    expect(verify.prepare("SELECT principal_id FROM companion_commands_v44 WHERE command_id='corrupt'").get())
      .toEqual({ principal_id: "missing-principal" });
    verify.close();
  });

  it("rejects unknown and populated future v44 artifacts without changing v43", () => {
    const fixture = buildCanonicalV43Fixture();
    let db = open();
    db.exec("CREATE TABLE unknown_future_v44_artifact(id TEXT PRIMARY KEY)");
    db.close();
    expect(() => createRepository()).toThrow(/unexpected v44 artifact unknown_future_v44_artifact/);
    db = open();
    db.exec("DROP TABLE unknown_future_v44_artifact");
    db.close();
    createRepository().close();
    db = open();
    insertCommand(db, fixture, { id: "future-command", key: "future-key", kind: "companion-create", expected: 0 });
    db.prepare("UPDATE meta SET value='43' WHERE key='schemaVersion'").run();
    db.close();
    expect(() => createRepository()).toThrow(/populated future v44 artifact companion_commands_v44/);
    const verify = open();
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "43" });
    expect(verify.prepare("SELECT command_id FROM companion_commands_v44").get()).toEqual({ command_id: "future-command" });
    verify.close();
  });

  it("detects attached unregistered SQL objects", () => {
    buildCanonicalV43Fixture();
    createRepository().close();
    const db = open();
    db.exec("CREATE INDEX concealed_companion_index ON companion_proposals_v44(proposal_id)");
    expect(() => assertCompanionCoreLayoutV44(db)).toThrow(/inventory is incompatible/);
    db.close();
  });
});

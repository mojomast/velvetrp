import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_RACE } from "@velvet/contracts";
import {
  CampaignAdministrationConflictError,
  CampaignAdministrationForbiddenError,
  CampaignAdministrationStaleError,
  createRepository,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-02T03:04:05.006Z";
const dir = () => process.env.VELVET_DATA_DIR as string;
const dbPath = () => path.join(dir(), "velvet.sqlite");

function repository() {
  let sequence = 0;
  return createRepository({ dataDir: dir(), clock: { now: () => new Date(at) },
    ids: { nextId: () => `generated-${++sequence}` } });
}
function addPrincipal(id: string) {
  const db = new DatabaseDriver(dbPath());
  db.prepare("INSERT INTO principals (id,display_name,is_local) VALUES (?, ?, 0)").run(id, id);
  db.close();
}

describe("campaign administration repository", () => {
  it("enforces role-safe projections, stale/idempotent writes, and sole owner", () => {
    const repo = repository();
    const campaign = repo.createCampaign("local-owner", { name: "Safe campaign" });
    addPrincipal("player-one");
    const added = repo.addAuditedCampaignMembership("local-owner", campaign.id, {
      principalId: "player-one", role: "player", expectedRevision: 0, idempotencyKey: "member-key",
    });
    expect(repo.addAuditedCampaignMembership("local-owner", campaign.id, {
      principalId: "player-one", role: "player", expectedRevision: 0, idempotencyKey: "member-key",
    })).toEqual(added);
    const player = repo.getCampaignAdministration("player-one", campaign.id)!;
    expect(player.actorRole).toBe("player");
    expect(player.settings).not.toHaveProperty("gmNotes");
    repo.updateCampaignAdministration("local-owner", campaign.id, { expectedRevision: 1,
      idempotencyKey: "settings-key", settings: { gmNotes: "private-plan" } });
    expect(JSON.stringify(repo.listCampaignAdministrationEvents("player-one", campaign.id))).not.toContain("private-plan");
    expect(() => repo.updateCampaignAdministration("local-owner", campaign.id, {
      expectedRevision: 0, idempotencyKey: "stale-key", status: "published",
    })).toThrow(CampaignAdministrationStaleError);
    expect(() => repo.removeAuditedCampaignMembership("local-owner", campaign.id, "local-owner", {
      expectedRevision: 2, idempotencyKey: "owner-key",
    })).toThrowError(/sole owner/);
    repo.close();
  });

  it("archives only after an exact owner confirmation and replays by confirmation name", () => {
    const repo = repository();
    const campaign = repo.createCampaign("local-owner", { name: "Confirm Archive" });
    addPrincipal("archive-player");
    repo.addAuditedCampaignMembership("local-owner", campaign.id, {
      principalId: "archive-player", role: "player", expectedRevision: 0, idempotencyKey: "archive-player-member",
    });
    const db = new DatabaseDriver(dbPath());
    const commandCount = () => (db.prepare("SELECT COUNT(*) count FROM campaign_administration_commands").get() as { count: number }).count;
    const before = commandCount();
    expect(() => repo.archiveCampaignWithConfirmation("local-owner", campaign.id, {
      confirmationName: "Wrong Name", expectedRevision: 1, idempotencyKey: "archive-wrong",
    })).toThrow(CampaignAdministrationConflictError);
    expect(commandCount()).toBe(before);
    expect(repo.getCampaignAdministration("local-owner", campaign.id)!.status).toBe("draft");

    const archived = repo.archiveCampaignWithConfirmation("local-owner", campaign.id, {
      confirmationName: "Confirm Archive", expectedRevision: 1, idempotencyKey: "archive-confirmed",
    });
    expect(archived.value.status).toBe("archived");
    expect(repo.archiveCampaignWithConfirmation("local-owner", campaign.id, {
      confirmationName: "Confirm Archive", expectedRevision: 1, idempotencyKey: "archive-confirmed",
    })).toEqual(archived);
    expect(() => repo.archiveCampaignWithConfirmation("local-owner", campaign.id, {
      confirmationName: "Different Name", expectedRevision: 1, idempotencyKey: "archive-confirmed",
    })).toThrow(CampaignAdministrationConflictError);
    expect(db.prepare("SELECT payload FROM campaign_administration_commands WHERE idempotency_key=?")
      .get("archive-confirmed")).toMatchObject({ payload: JSON.stringify({ status: "archived", confirmationName: "Confirm Archive" }) });
    db.close();

    expect(() => repo.archiveCampaignWithConfirmation("archive-player", campaign.id, {
      confirmationName: "Confirm Archive", expectedRevision: 2, idempotencyKey: "archive-not-owner",
    })).toThrow(CampaignAdministrationForbiddenError);
    repo.close();
  });

  it("creates canonical checkpoints and non-destructive immutable forks", () => {
    const repo = repository();
    const campaign = repo.createCampaign("local-owner", { name: "Fork campaign" });
    const checkpoint = repo.createCampaignCheckpoint("local-owner", campaign.id, {
      timelineId: campaign.activeTimelineId, timelineRevision: 0, label: "Opening",
      expectedRevision: 0, idempotencyKey: "checkpoint-key",
    });
    const fork = repo.forkCampaignTimeline("local-owner", campaign.id, {
      checkpointId: checkpoint.value.id, expectedRevision: 1, idempotencyKey: "fork-key",
    });
    expect(fork.value.parentTimelineId).toBe(campaign.activeTimelineId);
    expect(repo.listCampaignTimelineHistory("local-owner", campaign.id)).toHaveLength(2);
    const db = new DatabaseDriver(dbPath());
    expect(() => db.prepare("UPDATE campaign_timeline_history SET forked_from_revision=1 WHERE timeline_id=?")
      .run(campaign.activeTimelineId)).toThrowError(/immutable/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close(); repo.close();
  });

  it("dry-runs without writes, applies atomically, and exports no secret-bearing domains", () => {
    const repo = repository();
    const campaign = repo.createCampaign("local-owner", { name: "Transfer campaign" });
    const exported = repo.createCampaignExport("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "export-key" });
    const serialized = JSON.stringify(exported.value.package);
    expect(serialized).not.toMatch(/apiKey|baseUrl|usage_events|private_notes|VELVET_DATA_DIR/);
    expect(exported.value.package.excluded).toEqual(["credentials", "localPaths", "usageHistory", "privateActorState"]);
    const db = new DatabaseDriver(dbPath());
    const campaignCount = () => (db.prepare("SELECT COUNT(*) count FROM campaigns").get() as { count: number }).count;
    const importCount = () => (db.prepare("SELECT COUNT(*) count FROM campaign_imports").get() as { count: number }).count;
    const commandCount = () => (db.prepare("SELECT COUNT(*) count FROM campaign_administration_commands").get() as { count: number }).count;
    const countBefore = campaignCount();
    const importsBefore = importCount();
    const commandsBefore = commandCount();
    const dry = repo.dryRunCampaignImport("local-owner", exported.value.package);
    expect(dry.report.valid).toBe(true);
    expect(campaignCount()).toBe(countBefore);
    expect(importCount()).toBe(importsBefore);
    expect(commandCount()).toBe(commandsBefore);
    db.close();
    const applied = repo.applyCampaignImport("local-owner", {
      dryRun: dry, package: exported.value.package, idempotencyKey: "import-key",
    });
    expect(applied.value.id).not.toBe(campaign.id);
    expect(repo.applyCampaignImport("local-owner", {
      dryRun: dry, package: exported.value.package, idempotencyKey: "import-key",
    }).receipt).toEqual(applied.receipt);
    expect(() => repo.applyCampaignImport("local-owner", {
      dryRun: dry, package: { ...exported.value.package, campaign: { ...exported.value.package.campaign, name: "Changed" } },
      idempotencyKey: "bad-import-key",
    })).toThrow(CampaignAdministrationConflictError);
    repo.close();
  });

  it("rolls back every import row when apply collides", () => {
    const seed = repository();
    const existing = seed.createCampaign("local-owner", { name: "Existing" });
    const exported = seed.createCampaignExport("local-owner", existing.id, { expectedRevision: 0, idempotencyKey: "export-atomic" });
    seed.close();
    const collision = createRepository({ dataDir: dir(), clock: { now: () => new Date(at) },
      ids: { nextId: () => existing.id } });
    const dry = collision.dryRunCampaignImport("local-owner", exported.value.package);
    const db = new DatabaseDriver(dbPath());
    const before = (db.prepare("SELECT COUNT(*) count FROM campaigns").get() as { count: number }).count;
    expect(() => collision.applyCampaignImport("local-owner", { dryRun: dry,
      package: exported.value.package, idempotencyKey: "import-atomic" })).toThrow();
    expect((db.prepare("SELECT COUNT(*) count FROM campaigns").get() as { count: number }).count).toBe(before);
    expect(db.prepare("SELECT 1 FROM campaign_administration_commands WHERE idempotency_key='import-atomic'").get()).toBeUndefined();
    db.close(); collision.close();
  });

  it("returns strict role-safe logs and receipts without GM/player secrets or idempotency keys", () => {
    const repo = repository(); const campaign = repo.createCampaign("local-owner", { name: "Logs" });
    addPrincipal("gm-one"); addPrincipal("player-one");
    repo.addAuditedCampaignMembership("local-owner", campaign.id, { principalId: "gm-one", role: "gm",
      expectedRevision: 0, idempotencyKey: "add-gm" });
    repo.addAuditedCampaignMembership("local-owner", campaign.id, { principalId: "player-one", role: "player",
      expectedRevision: 1, idempotencyKey: "add-player" });
    const changed = repo.updateCampaignAdministration("local-owner", campaign.id, { expectedRevision: 2,
      idempotencyKey: "private-settings-key", settings: { gmNotes: "owner-only-secret" } });
    for (const actor of ["gm-one", "player-one"]) {
      const events = repo.listCampaignAdministrationEvents(actor, campaign.id);
      const receipt = repo.getCampaignAdministrationReceipt(actor, campaign.id, changed.receipt.commandId)!;
      expect(JSON.stringify({ events, receipt })).not.toContain("owner-only-secret");
      expect(JSON.stringify({ events, receipt })).not.toContain("private-settings-key");
      expect(receipt).not.toHaveProperty("idempotencyKey");
    }
    expect(JSON.stringify(repo.getCampaignAdministrationReceipt("local-owner", campaign.id,
      changed.receipt.commandId))).toContain("owner-only-secret");
    repo.close();
  });

  it("audits every membership and room mutation and enforces closed/nested guards", () => {
    const repo = repository(); const campaign = repo.createCampaign("local-owner", { name: "Audited" });
    addPrincipal("member-one");
    repo.addAuditedCampaignMembership("local-owner", campaign.id, { principalId: "member-one", role: "player",
      expectedRevision: 0, idempotencyKey: "member-add" });
    repo.changeAuditedCampaignMembershipRole("local-owner", campaign.id, "member-one", { role: "gm",
      expectedRevision: 1, idempotencyKey: "member-change" });
    repo.removeAuditedCampaignMembership("local-owner", campaign.id, "member-one", {
      expectedRevision: 2, idempotencyKey: "member-remove" });
    const db = new DatabaseDriver(dbPath());
    db.exec(`INSERT INTO characters VALUES ('room-character','Room',21,'hero','',1,0,'${at}');
      INSERT INTO sessions (id,character_id,title,state,preset_id,created_at) VALUES ('portable-room','room-character','Room','active','default','${at}');
      INSERT INTO session_characters VALUES ('portable-room','room-character',0);`);
    db.close();
    repo.attachAuditedCampaignRoom("local-owner", campaign.id, { sessionId: "portable-room",
      expectedRevision: 3, idempotencyKey: "room-add" });
    repo.detachAuditedCampaignRoom("local-owner", campaign.id, { sessionId: "portable-room",
      expectedRevision: 4, idempotencyKey: "room-remove" });
    expect(repo.listCampaignAdministrationEvents("local-owner", campaign.id).map((event) => event.type)).toEqual([
      "membership_added", "membership_role_changed", "membership_removed", "room_attached", "room_detached",
    ]);
    expect(() => repo.transaction(() => repo.updateCampaignAdministration("local-owner", campaign.id, {
      expectedRevision: 5, idempotencyKey: "nested", status: "published",
    }))).toThrow(/cannot run inside a repository transaction/);
    repo.close();
    expect(() => repo.getCampaignAdministration("local-owner", campaign.id)).toThrow(/repository is closed/);
  });

  it("losslessly round-trips nonzero timeline history, checkpoint, recap, pins, safe membership and portable room", () => {
    const repo = repository(); const campaign = repo.createCampaign("local-owner", { name: "Round trip" });
    repo.installOriginalStarterContent("local-owner", campaign.id);
    repo.configureOriginalStarterContent("local-owner", campaign.id);
    addPrincipal("portable-gm");
    const persona = repo.createCharacter({ name: "Portable", age: 21, archetype: "hero", boundaries: "",
      fictionalConfirmed: true });
    const portableActor = repo.createOriginalStarterCampaignCharacter("local-owner", { campaignId: campaign.id,
      characterId: persona.id, controllerPrincipalId: "local-owner", race: ORIGINAL_STARTER_RACE.reference,
      background: ORIGINAL_STARTER_BACKGROUND.reference, classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
      attributes: [], proficiencies: [], choices: [] }).projection;
    const db = new DatabaseDriver(dbPath());
    db.prepare(`INSERT INTO rpg_character_attributes (campaign_id,sheet_id,position,attribute_id,value)
      VALUES (?,?,0,'strength',9)`).run(campaign.id, portableActor.sheet.id);
    db.prepare(`INSERT INTO sessions (id,character_id,title,state,preset_id,created_at)
      VALUES ('portable-session',?,'Portable','active','default',?)`).run(persona.id, at);
    db.prepare("INSERT INTO session_characters VALUES ('portable-session',?,0)").run(persona.id);
    db.close();
    repo.executeSetActorAttribute("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      actorId: portableActor.actor.id, commandId: "portable-command", idempotencyKey: "portable-command-key",
      expectedRevision: 0, sourceTurnId: null,
      command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 10 } } });
    repo.attachAuditedCampaignRoom("local-owner", campaign.id, { sessionId: "portable-session", expectedRevision: 0, idempotencyKey: "portable-room" });
    const checkpoint = repo.createCampaignCheckpoint("local-owner", campaign.id, { timelineId: campaign.activeTimelineId,
      timelineRevision: 1, label: "At one", expectedRevision: 1, idempotencyKey: "round-checkpoint" });
    repo.createCampaignRecap("local-owner", campaign.id, { timelineId: campaign.activeTimelineId, throughRevision: 1,
      selectedSessionIds: ["portable-session"], visibility: "members", text: "Exact recap",
      expectedRevision: 2, idempotencyKey: "round-recap" });
    repo.addAuditedCampaignMembership("local-owner", campaign.id, { principalId: "portable-gm", role: "gm",
      expectedRevision: 3, idempotencyKey: "round-member" });
    const exported = repo.createCampaignExport("local-owner", campaign.id, { expectedRevision: 4, idempotencyKey: "round-export" });
    const transfer = exported.value.package;
    const expectedRecords = transfer.timelines.length + transfer.timelines.reduce((sum, timeline) => sum + timeline.events.length, 0)
      + transfer.records.actors.reduce((sum, actor) => sum + 6 + actor.classes.length + actor.attributes.length + actor.resources.length, 0)
      + transfer.records.checkpoints.length + transfer.records.checkpoints.reduce((sum, item) => sum
        + item.state.attributes.length + item.state.resources.length, 0) + transfer.records.recaps.length
      + transfer.records.memberships.length + transfer.records.roomAttachments.length
      + transfer.records.administration.events.length + transfer.records.administration.receipts.length
      + (transfer.content.status === "configured" ? 1 + transfer.content.contentPacks.length : 0);
    expect(exported.value.manifest.recordCount).toBe(expectedRecords);
    const unmappedSnapshot = { ...transfer, records: { ...transfer.records, checkpoints: transfer.records.checkpoints.map((item) => ({
      ...item, state: { ...item.state, attributes: [...item.state.attributes,
        { actorId: "missing-actor", attributeId: "strength", value: 10 }] },
    })) } };
    expect(repo.dryRunCampaignImport("local-owner", unmappedSnapshot).report.missingReferences)
      .toContain("checkpoint actor missing-actor");
    const duplicateActors = { ...transfer, records: { ...transfer.records,
      actors: [...transfer.records.actors, transfer.records.actors[0]!] } };
    expect(repo.dryRunCampaignImport("local-owner", duplicateActors).report.conflicts.some((issue) => issue.includes("duplicate actor"))).toBe(true);
    const originalEvent = transfer.timelines[0]!.events[0]!;
    const duplicateCommand = { ...transfer, timelines: [{ ...transfer.timelines[0]!, revision: 2,
      events: [originalEvent, { ...originalEvent, revision: 2, sourceEventId: "different-source-event",
        data: { ...originalEvent.data, valueAfter: 99 } }] }] };
    expect(repo.dryRunCampaignImport("local-owner", duplicateCommand).report.conflicts)
      .toContain(`conflicting duplicate source command ${originalEvent.sourceCommandId}`);
    const legitimateFork = { ...transfer, timelines: [...transfer.timelines, { ...transfer.timelines[0]!,
      sourceId: "legitimate-child", parentSourceId: transfer.timelines[0]!.sourceId, forkedFromRevision: 1 }],
      records: { ...transfer.records, recaps: [], roomAttachments: [] } };
    expect(repo.dryRunCampaignImport("local-owner", legitimateFork).report.valid).toBe(true);
    const unrelatedFork = { ...transfer, timelines: [...transfer.timelines, { ...transfer.timelines[0]!,
      sourceId: "unrelated-child", parentSourceId: transfer.timelines[0]!.sourceId, forkedFromRevision: 1,
      events: [{ ...originalEvent, sourceEventId: "unrelated-event", sourceCommandId: "unrelated-command" }] }] };
    expect(repo.dryRunCampaignImport("local-owner", unrelatedFork).report.conflicts)
      .toContain("timeline unrelated-child does not match parent prefix at revision 1");
    const unavailableRecapRoom = { ...transfer, records: { ...transfer.records, roomAttachments: [] } };
    expect(repo.dryRunCampaignImport("local-owner", unavailableRecapRoom).report.missingReferences)
      .toContain("recap session portable-session");
    const wrongPinnedVersion = { ...transfer, records: { ...transfer.records, actors: transfer.records.actors.map((actor) => ({
      ...actor, race: { ...actor.race, packVersion: "2.0.0" },
    })) } };
    expect(repo.dryRunCampaignImport("local-owner", wrongPinnedVersion).report.missingReferences)
      .toContain(`actor definition pin ${transfer.records.actors[0]!.race.packId}@2.0.0`);
    const mismatchedReceiptTime = { ...transfer, records: { ...transfer.records, administration: {
      ...transfer.records.administration, receipts: transfer.records.administration.receipts.map((receipt, index) => index === 0
        ? { ...receipt, occurredAt: "2035-01-02T03:04:05.007Z" } : receipt),
    } } };
    expect(repo.dryRunCampaignImport("local-owner", mismatchedReceiptTime).report.valid).toBe(false);
    expect(exported.value.package.timelines[0]!.revision).toBe(1);
    expect(exported.value.package.records.recaps[0]!.selectedSessionIds).toEqual(["portable-session"]);
    expect(exported.value.package.content.status).toBe("configured");
    expect(JSON.stringify(exported.value.package)).not.toMatch(/idempotencyKey|round-export|private_notes/);
    repo.detachAuditedCampaignRoom("local-owner", campaign.id, { sessionId: "portable-session", expectedRevision: 5, idempotencyKey: "free-portable-room" });
    const dry = repo.dryRunCampaignImport("local-owner", exported.value.package);
    const applied = repo.applyCampaignImport("local-owner", { dryRun: dry, package: exported.value.package, idempotencyKey: "round-import" });
    expect(repo.applyCampaignImport("local-owner", { dryRun: dry, package: exported.value.package,
      idempotencyKey: "round-import" })).toEqual(applied);
    expect(repo.dryRunCampaignImport("local-owner", exported.value.package).report.conflicts)
      .toContain("package was already imported");
    const importedTimeline = repo.listCampaignTimelineHistory("local-owner", applied.value.id)[0]!;
    expect(importedTimeline.revision).toBe(1);
    expect(repo.listCampaignEvents("local-owner", applied.value.id, importedTimeline.id)).toHaveLength(1);
    const importedDb = new DatabaseDriver(dbPath());
    const importedActorId = (importedDb.prepare("SELECT id FROM campaign_actors WHERE campaign_id=?").get(applied.value.id) as { id: string }).id;
    const importedAdminEvent = transfer.records.administration.events[0]!;
    importedDb.exec("BEGIN");
    expect(() => importedDb.prepare(`INSERT INTO campaign_imported_administration_events
      (campaign_id,revision,source_event_id,source_command_id,type,occurred_at,public_data) VALUES (?,?,?,?,?,?,?)`)
      .run(applied.value.id, 999, importedAdminEvent.eventId, "different-admin-command", importedAdminEvent.type, at, "{}"))
      .toThrow();
    expect(() => importedDb.prepare(`INSERT INTO campaign_imported_administration_events
      (campaign_id,revision,source_event_id,source_command_id,type,occurred_at,public_data) VALUES (?,?,?,?,?,?,?)`)
      .run(applied.value.id, 999, "bad-type-event", "bad-type-command", "unbounded-type", at, "{}"))
      .toThrow(/imported administration event is invalid/);
    importedDb.prepare(`INSERT INTO campaign_imported_administration_events
      (campaign_id,revision,source_event_id,source_command_id,type,occurred_at,public_data) VALUES (?,?,?,?,?,?,?)`)
      .run(applied.value.id, 999, "extra-admin-event", "extra-admin-command", "campaign_renamed", at, "{}");
    expect(() => importedDb.prepare(`INSERT INTO campaign_imported_administration_receipts
      (campaign_id,source_command_id,type,revision_before,revision_after,occurred_at) VALUES (?,?,?,?,?,?)`)
      .run(applied.value.id, "extra-admin-command", "campaign_renamed", 998, 999, "2035-01-02T03:04:05.007Z"))
      .toThrow(/imported administration receipt is inconsistent/);
    expect(() => importedDb.prepare(`INSERT INTO campaign_imported_administration_receipts
      (campaign_id,source_command_id,type,revision_before,revision_after,occurred_at) VALUES (?,?,?,?,?,?)`)
      .run(applied.value.id, "extra-admin-command", "membership_added", 998, 999, at))
      .toThrow(/imported administration receipt is inconsistent/);
    importedDb.exec("ROLLBACK");
    importedDb.close();
    const nativeEnvelope = { campaignId: applied.value.id, timelineId: importedTimeline.id, actorId: importedActorId,
      commandId: "import-native-command", idempotencyKey: "import-native-key", expectedRevision: 1, sourceTurnId: null,
      command: { type: "set_actor_attribute" as const, payload: { attributeId: "strength", value: 11 } } };
    const nativeReceipt = repo.executeSetActorAttribute("local-owner", nativeEnvelope);
    expect(repo.listCampaignEvents("local-owner", applied.value.id, importedTimeline.id).map((event) => event.revision)).toEqual([1, 2]);
    expect(repo.getCommandReceipt("local-owner", applied.value.id, nativeEnvelope.commandId)).toEqual(nativeReceipt);
    expect(repo.executeSetActorAttribute("local-owner", nativeEnvelope)).toEqual(nativeReceipt);
    expect(repo.listCampaignRecaps("local-owner", applied.value.id)[0]).toMatchObject({ throughRevision: 1,
      selectedSessionIds: ["portable-session"], text: "Exact recap" });
    expect(repo.listCampaignContentPacks("local-owner", applied.value.id)).toHaveLength(1);
    expect(repo.getCampaignMembership("local-owner", applied.value.id, "portable-gm")?.role).toBe("gm");
    expect(repo.getCampaignSessionAttachment("local-owner", applied.value.id, "portable-session")).not.toBeNull();
    const importedCheckpoint = repo.listCampaignCheckpoints("local-owner", applied.value.id)[0]!;
    const fork = repo.forkCampaignTimeline("local-owner", applied.value.id, { checkpointId: importedCheckpoint.id,
      expectedRevision: applied.value.revision, idempotencyKey: "imported-fork" });
    expect(fork.value.revision).toBe(1);
    expect(repo.listCampaignEvents("local-owner", applied.value.id, fork.value.id)).toHaveLength(1);
    expect(repo.getCampaignCharacterByActorId("local-owner", applied.value.id, importedActorId)?.projection.sheet.attributes)
      .toContainEqual({ attributeId: "strength", value: 10 });
    expect(checkpoint.value.timelineRevision).toBe(1);
    repo.close();
  });

  it("reports malformed and cyclic dry-runs deterministically without throwing and converges cross-connection imports", () => {
    const repo = repository(); const campaign = repo.createCampaign("local-owner", { name: "Validation" });
    const pkg = repo.createCampaignExport("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "validation-export" }).value.package;
    expect(() => repo.dryRunCampaignImport("local-owner", { value: 1n })).not.toThrow();
    const unknownEvent = { ...pkg, timelines: [{ ...pkg.timelines[0]!, revision: 1, events: [{
      sourceEventId: "unknown-event", sourceCommandId: "unknown-command", actorId: "unknown-actor",
      sourceTurnId: null, revision: 1, occurredAt: at, type: "unknown", data: {},
    }] }] };
    expect(repo.dryRunCampaignImport("local-owner", unknownEvent).report.valid).toBe(false);
    const cyclic = { ...pkg, timelines: [
      { ...pkg.timelines[0]!, parentSourceId: "child", forkedFromRevision: 0 },
      { ...pkg.timelines[0]!, sourceId: "child", parentSourceId: pkg.timelines[0]!.sourceId, forkedFromRevision: 0 },
    ] };
    const invalid = repo.dryRunCampaignImport("local-owner", cyclic);
    expect(invalid.report.valid).toBe(false);
    expect(invalid.report.conflicts.some((issue) => issue.includes("cycle") || issue.includes("root"))).toBe(true);
    const dry = repo.dryRunCampaignImport("local-owner", pkg); repo.close();
    const reordered = Object.fromEntries(Object.entries(pkg).reverse());
    const reorderReader = createRepository({ dataDir: dir() });
    expect(reorderReader.dryRunCampaignImport("local-owner", reordered).packageHash).toBe(dry.packageHash);
    reorderReader.close();
    let importSequence = 0;
    const first = createRepository({ dataDir: dir(), ids: { nextId: () => `import-generated-${++importSequence}` } });
    const second = createRepository({ dataDir: dir() });
    const applied = first.applyCampaignImport("local-owner", { dryRun: dry, package: pkg, idempotencyKey: "global-import" });
    expect(second.applyCampaignImport("local-owner", { dryRun: dry, package: pkg, idempotencyKey: "global-import" })).toEqual(applied);
    expect(second.applyCampaignImport("local-owner", { dryRun: dry,
      package: reordered as typeof pkg, idempotencyKey: "global-import" })).toEqual(applied);
    expect(() => second.applyCampaignImport("local-owner", { dryRun: second.dryRunCampaignImport("local-owner",
      { ...pkg, campaign: { ...pkg.campaign, name: "Changed" } }), package: { ...pkg, campaign: { ...pkg.campaign, name: "Changed" } },
      idempotencyKey: "global-import" })).toThrow(CampaignAdministrationConflictError);
    first.close(); second.close();
  });

  it("rejects stopped or malformed portable rooms and transactionally rechecks room lifecycle on apply", () => {
    const repo = repository(); const campaign = repo.createCampaign("local-owner", { name: "Room validation" });
    const pkg = repo.createCampaignExport("local-owner", campaign.id, {
      expectedRevision: 0, idempotencyKey: "room-validation-export",
    }).value.package;
    const roomDb = new DatabaseDriver(dbPath());
    for (const suffix of ["stopped", "malformed", "running"]) roomDb.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,fictional_confirmed,is_real_person,created_at)
      VALUES (?,?,21,'hero','',1,0,?)`).run(`room-${suffix}-character`, suffix, at);
    roomDb.prepare(`INSERT INTO sessions
      (id,character_id,title,state,preset_id,created_at,stopped_at,stop_reason)
      VALUES ('stopped-room','room-stopped-character','Stopped','closed','default',?,?, 'user-stop')`).run(at, at);
    roomDb.prepare(`INSERT INTO sessions
      (id,character_id,title,state,preset_id,created_at) VALUES
      ('malformed-room','room-malformed-character','Malformed','active','default',?),
      ('running-room','room-running-character','Running','active','default',?)`).run(at, at);
    roomDb.prepare("INSERT INTO session_characters VALUES ('stopped-room','room-stopped-character',0)").run();
    roomDb.prepare("INSERT INTO session_characters VALUES ('running-room','room-running-character',0)").run();
    roomDb.close();
    const withRoom = (sessionId: string) => ({ ...pkg, records: { ...pkg.records,
      roomAttachments: [{ sessionId, attachedAt: at }], recaps: [{ sourceId: `recap-${sessionId}`,
        timelineSourceId: pkg.activeTimelineSourceId, throughRevision: 0, selectedSessionIds: [sessionId],
        visibility: "members" as const, text: "Room recap", createdAt: at }] } });
    const stopped = repo.dryRunCampaignImport("local-owner", withRoom("stopped-room"));
    expect(stopped.report.valid).toBe(false);
    expect(stopped.report.conflicts).toContain("room stopped-room is stopped");
    expect(stopped.report.missingReferences).toContain("recap session stopped-room");
    const malformed = repo.dryRunCampaignImport("local-owner", withRoom("malformed-room"));
    expect(malformed.report.valid).toBe(false);
    expect(malformed.report.missingReferences).toEqual(expect.arrayContaining([
      "room malformed-room is not attachable", "recap session malformed-room",
    ]));
    const runningPackage = withRoom("running-room");
    const dry = repo.dryRunCampaignImport("local-owner", runningPackage);
    expect(dry.report.valid).toBe(true);
    const changedDb = new DatabaseDriver(dbPath());
    changedDb.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='user-stop' WHERE id='running-room'").run(at);
    const campaignCount = (changedDb.prepare("SELECT COUNT(*) count FROM campaigns").get() as { count: number }).count;
    changedDb.close();
    expect(() => repo.applyCampaignImport("local-owner", { dryRun: dry, package: runningPackage,
      idempotencyKey: "room-lifecycle-race" })).toThrow(CampaignAdministrationConflictError);
    const verifyDb = new DatabaseDriver(dbPath());
    expect((verifyDb.prepare("SELECT COUNT(*) count FROM campaigns").get() as { count: number }).count).toBe(campaignCount);
    verifyDb.close(); repo.close();
  });

  it("restores normalized checkpoint state and exposes inherited prefix plus local suffix", () => {
    const repo = repository(); const campaign = repo.createCampaign("local-owner", { name: "State fork" });
    repo.installOriginalStarterContent("local-owner", campaign.id); repo.configureOriginalStarterContent("local-owner", campaign.id);
    const persona = repo.createCharacter({ name: "Hero", age: 25, archetype: "hero", boundaries: "",
      fictionalConfirmed: true });
    const created = repo.createOriginalStarterCampaignCharacter("local-owner", { campaignId: campaign.id,
      characterId: persona.id, controllerPrincipalId: "local-owner", race: ORIGINAL_STARTER_RACE.reference,
      background: ORIGINAL_STARTER_BACKGROUND.reference, classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
      attributes: [], proficiencies: [], choices: [] });
    const actorId = created.projection.actor.id;
    const stateDb = new DatabaseDriver(dbPath());
    stateDb.prepare(`INSERT INTO rpg_character_attributes (campaign_id,sheet_id,position,attribute_id,value)
      VALUES (?,?,0,'strength',10)`).run(campaign.id, created.projection.sheet.id); stateDb.close();
    repo.executeSetActorAttribute("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      actorId, commandId: "strength-one", idempotencyKey: "strength-one-key", expectedRevision: 0,
      sourceTurnId: null, command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 12 } } });
    const cp = repo.createCampaignCheckpoint("local-owner", campaign.id, { timelineId: campaign.activeTimelineId,
      timelineRevision: 1, label: "Strength twelve", expectedRevision: 0, idempotencyKey: "state-checkpoint" });
    repo.executeSetActorAttribute("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      actorId, commandId: "strength-two", idempotencyKey: "strength-two-key", expectedRevision: 1,
      sourceTurnId: null, command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 15 } } });
    const fork = repo.forkCampaignTimeline("local-owner", campaign.id, { checkpointId: cp.value.id,
      expectedRevision: 1, idempotencyKey: "state-fork" });
    expect(repo.getCampaignCharacterByActorId("local-owner", campaign.id, actorId)?.projection.sheet.attributes)
      .toContainEqual({ attributeId: "strength", value: 12 });
    expect(repo.listCampaignEvents("local-owner", campaign.id, campaign.activeTimelineId)).toHaveLength(2);
    expect(repo.listCampaignEvents("local-owner", campaign.id, fork.value.id)).toHaveLength(1);
    expect(() => repo.createCampaignCheckpoint("local-owner", campaign.id, { timelineId: campaign.activeTimelineId,
      timelineRevision: 2, label: "Inactive", expectedRevision: 2, idempotencyKey: "inactive-checkpoint" }))
      .toThrow(/checkpoint revision is not current/);
    const provenanceDb = new DatabaseDriver(dbPath());
    const parentSecondEvent = (provenanceDb.prepare(`SELECT event_id FROM campaign_timeline_events
      WHERE campaign_id=? AND timeline_id=? AND revision=2`).get(campaign.id, campaign.activeTimelineId) as { event_id: string }).event_id;
    expect(() => provenanceDb.prepare(`INSERT INTO campaign_timeline_events
      (campaign_id,timeline_id,revision,event_id,inherited) VALUES (?,?,?,?,0)`)
      .run(campaign.id, fork.value.id, 2, parentSecondEvent)).toThrow(/provenance is invalid/);
    expect(() => provenanceDb.prepare(`INSERT INTO campaign_timeline_events
      (campaign_id,timeline_id,revision,event_id,inherited) VALUES (?,?,?,?,1)`)
      .run(campaign.id, fork.value.id, 2, parentSecondEvent)).toThrow(/provenance is invalid/);
    provenanceDb.close();
    repo.executeSetActorAttribute("local-owner", { campaignId: campaign.id, timelineId: fork.value.id,
      actorId, commandId: "strength-child", idempotencyKey: "strength-child-key", expectedRevision: 1,
      sourceTurnId: null, command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 13 } } });
    expect(repo.listCampaignEvents("local-owner", campaign.id, fork.value.id).map((event) => event.revision)).toEqual([1, 2]);
    expect(repo.listPublicCampaignEvents("local-owner", campaign.id, fork.value.id, 0, 1)).toEqual({
      events: [expect.objectContaining({ timelineId: fork.value.id, revision: 1 })], nextAfterRevision: 1,
    });
    expect(repo.listPublicCampaignEvents("local-owner", campaign.id, fork.value.id, 1, 1)).toEqual({
      events: [expect.objectContaining({ timelineId: fork.value.id, revision: 2 })], nextAfterRevision: null,
    });
    expect(repo.listPublicCampaignEvents("local-owner", campaign.id, fork.value.id, 2, 1)).toEqual({
      events: [], nextAfterRevision: null,
    });
    expect(() => repo.listPublicCampaignEvents("local-owner", campaign.id, fork.value.id, 0, 101)).toThrow(RangeError);
    addPrincipal("event-member");
    const membershipDb = new DatabaseDriver(dbPath());
    membershipDb.prepare("INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,?,?)")
      .run(campaign.id, "event-member", "player", at);
    membershipDb.close();
    expect(repo.listPublicCampaignEvents("event-member", campaign.id, fork.value.id, 0, 2).events)
      .toHaveLength(2);
    expect(repo.listPublicCampaignEvents("outsider", campaign.id, fork.value.id, 0, 2)).toEqual({
      events: [], nextAfterRevision: null,
    });
    repo.close();
  });

  it("rejects cross-campaign/type/revision audit mismatches and all replacement forms", () => {
    const repo = repository(); const campaign = repo.createCampaign("local-owner", { name: "Audit SQL" });
    const changed = repo.updateCampaignAdministration("local-owner", campaign.id, { expectedRevision: 0,
      idempotencyKey: "audit-sql", status: "published" });
    repo.createCampaignExport("local-owner", campaign.id, { expectedRevision: 1, idempotencyKey: "audit-export" });
    repo.close();
    const db = new DatabaseDriver(dbPath());
    expect(() => db.prepare(`INSERT INTO campaign_administration_events
      (event_id,campaign_id,command_id,revision_before,revision,type,public_data,private_data,occurred_at)
      VALUES ('bad-event',?,?,0,1,'membership_added','{}','{}',?)`)
      .run(campaign.id, changed.receipt.commandId, at)).toThrow();
    expect(() => db.prepare("INSERT OR REPLACE INTO campaign_administration_receipts SELECT * FROM campaign_administration_receipts WHERE command_id=?")
      .run(changed.receipt.commandId)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE campaign_export_manifests SET record_count=record_count").run()).toThrow(/immutable/);
    expect(db.pragma("foreign_key_check")).toEqual([]); db.close();
  });
});

// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  MAX_CAMPAIGN_IMPORT_BYTES, MAX_CAMPAIGN_IMPORT_RECORDS, applyCampaignImportInputSchema,
  campaignAdministrationEventSchema, campaignAdministrationReceiptSchema,
  campaignAdministrationSchema, campaignImportDryRunSchema, campaignImportReportSchema,
  campaignTransferHttpApplyRequestSchema, campaignTransferPackageSchema,
  resourceIdSchema, utcIsoTimestampSchema, type ApplyCampaignImportInput, type CampaignAdministration,
  type CampaignAdministrationReceipt, type CampaignImportDryRun, type CampaignTransferHttpApplyRequest,
  type CampaignTransferPackage,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "../campaign/campaignTypes.js";
import type { AdministrationAuthority } from "./administrationAccessRepo.js";
import { canonicalizeJson, forbidden, serializeForImport } from "./administrationImportHelpers.js";

/** Dependencies retained by campaign import operations as they are extracted. */
export interface AdministrationImportRepoDependencies {
  db: DatabaseDriver.Database;
  deps: RepositoryDependencies;
  validateRoom: (sessionId: string) => "running" | "stopped" | null;
  /** Campaign authority lookup shared with the administration facade. */
  getAuthority: (actor: string, campaignId: string) => AdministrationAuthority | null;
  /** Produces the facade's public authorization error. */
  forbidden: () => Error;
  /** Enforces the repository-wide mutation guard before an import is applied. */
  assertCanMutate: () => void;
  /** Produces the facade's public conflict error. */
  conflict: (message: string) => Error;
  /** Reads the completed import through the administration access projection. */
  getCampaignAdministration: (actor: string, campaignId: string) => CampaignAdministration | null;
  /**
   * Invokes the authoritative dry-run operation while applying an import.
   *
   * This is injected instead of calling the administration facade, which keeps
   * the import factory independent of the facade that wires it.
   */
  dryRunCampaignImport: (actor: string, input: unknown) => CampaignImportDryRun;
}

/**
 * Creates campaign-transfer import operations.
 *
 * The dependencies include the shared authority lookup and mutation dependencies so
 * apply/import operations can remain colocated without rebuilding facade state.
 */
export function createAdministrationImportRepo({ db, deps, validateRoom, forbidden: forbiddenError, assertCanMutate,
  conflict, getCampaignAdministration, dryRunCampaignImport: runDryRun }: AdministrationImportRepoDependencies) {
  /** Validates a portable campaign package without making any database changes. */
  const dryRunCampaignImport = (actorRaw: string, raw: unknown): CampaignImportDryRun => {
    const actor = resourceIdSchema.parse(actorRaw);
    const owner = db.prepare("SELECT principal_id FROM application_owner WHERE singleton=1").get() as any;
    if (!owner || owner.principal_id !== actor) throw forbiddenError();
    const conflicts: string[] = [], missingReferences: string[] = [], warnings: string[] = [];
    const add = (target: string[], issue: string) => { if (target.length < 100 && !target.includes(issue)) target.push(issue); };
    let pkg: CampaignTransferPackage | null = null;
    const serialized = serializeForImport(raw);
    if (serialized.json === null) add(conflicts, "package is not serializable");
    const exceedsSize = serialized.json !== null && Buffer.byteLength(serialized.json, "utf8") > MAX_CAMPAIGN_IMPORT_BYTES;
    if (exceedsSize) add(conflicts, "package exceeds size limit");
    try { if (forbidden(raw)) add(conflicts, "package contains excluded secret, path, usage, price, or credential fields"); }
    catch { add(conflicts, "package cannot be safely inspected"); }
    try {
      if (exceedsSize) throw new Error("size limit reached before schema traversal");
      const parsed = campaignTransferPackageSchema.safeParse(raw);
      if (parsed.success) pkg = parsed.data;
      else add(conflicts, "package schema, Unicode, nesting, or format version is invalid");
    } catch { if (!exceedsSize) add(conflicts, "package schema inspection failed safely"); }
    if (pkg) {
      const ids = new Set<string>(), byId = new Map(pkg.timelines.map((timeline) => [timeline.sourceId, timeline]));
      const sourceEvents = new Map<string, string>(), sourceCommands = new Map<string, string>();
      for (const timeline of pkg.timelines) {
        if (ids.has(timeline.sourceId)) add(conflicts, `duplicate timeline ${timeline.sourceId}`);
        ids.add(timeline.sourceId);
        if (timeline.parentSourceId === timeline.sourceId) add(conflicts, `timeline ${timeline.sourceId} cannot parent itself`);
        if ((timeline.parentSourceId === null) !== (timeline.forkedFromRevision === null)) add(conflicts, `timeline ${timeline.sourceId} has inconsistent root/fork metadata`);
        if (timeline.events.length !== timeline.revision || timeline.events.some((event, index) => event.revision !== index + 1)) add(conflicts, `timeline ${timeline.sourceId} event history is incomplete`);
        for (const event of timeline.events) {
          const canonicalEvent = serializeForImport(event).json!;
          const priorEvent = sourceEvents.get(event.sourceEventId);
          if (priorEvent !== undefined && priorEvent !== canonicalEvent) add(conflicts, `conflicting duplicate source event ${event.sourceEventId}`);
          sourceEvents.set(event.sourceEventId, canonicalEvent);
          const priorCommand = sourceCommands.get(event.sourceCommandId);
          if (priorCommand !== undefined && priorCommand !== canonicalEvent) add(conflicts, `conflicting duplicate source command ${event.sourceCommandId}`);
          sourceCommands.set(event.sourceCommandId, canonicalEvent);
        }
      }
      const actorIds = new Set<string>(), characterIds = new Set<string>(), sheetIds = new Set<string>();
      for (const portableActor of pkg.records.actors) {
        if (actorIds.has(portableActor.sourceActorId)) add(conflicts, `duplicate actor ${portableActor.sourceActorId}`);
        if (characterIds.has(portableActor.sourceCampaignCharacterId)) add(conflicts, `duplicate campaign character ${portableActor.sourceCampaignCharacterId}`);
        if (sheetIds.has(portableActor.sourceSheetId)) add(conflicts, `duplicate sheet ${portableActor.sourceSheetId}`);
        actorIds.add(portableActor.sourceActorId); characterIds.add(portableActor.sourceCampaignCharacterId); sheetIds.add(portableActor.sourceSheetId);
        if (portableActor.race.kind !== "race") add(conflicts, `actor ${portableActor.sourceActorId} race reference has wrong kind`);
        if (portableActor.background.kind !== "background") add(conflicts, `actor ${portableActor.sourceActorId} background reference has wrong kind`);
        const attributes = new Set<string>(), resources = new Set<string>(), classes = new Set<string>();
        for (const attribute of portableActor.attributes) { if (attributes.has(attribute.attributeId)) add(conflicts, `duplicate actor attribute ${portableActor.sourceActorId}/${attribute.attributeId}`); attributes.add(attribute.attributeId); }
        for (const resource of portableActor.resources) { if (resources.has(resource.name)) add(conflicts, `duplicate actor resource ${portableActor.sourceActorId}/${resource.name}`); if (resource.current > resource.max) add(conflicts, `actor resource ${portableActor.sourceActorId}/${resource.name} exceeds max`); resources.add(resource.name); }
        for (const entry of portableActor.classes) { if (entry.class.kind !== "class") add(conflicts, `actor ${portableActor.sourceActorId} class reference has wrong kind`); const key = `${entry.class.packId}@${entry.class.packVersion}:${entry.class.kind}:${entry.class.definitionId}`; if (classes.has(key)) add(conflicts, `duplicate actor class ${portableActor.sourceActorId}/${key}`); classes.add(key); }
      }
      for (const timeline of pkg.timelines) for (const event of timeline.events) if (!actorIds.has(event.actorId)) add(missingReferences, `timeline event actor ${event.actorId}`);
      const roots = pkg.timelines.filter((timeline) => timeline.parentSourceId === null);
      if (roots.length !== 1) add(conflicts, "timeline graph must contain exactly one root");
      for (const timeline of pkg.timelines) {
        if (timeline.parentSourceId !== null && !ids.has(timeline.parentSourceId)) add(missingReferences, `timeline parent ${timeline.parentSourceId}`);
        const parent = timeline.parentSourceId === null ? undefined : byId.get(timeline.parentSourceId);
        if (parent && timeline.forkedFromRevision! > parent.revision) add(conflicts, `timeline ${timeline.sourceId} fork revision exceeds parent`);
        if (parent && timeline.forkedFromRevision !== null) for (let revision = 1; revision <= timeline.forkedFromRevision; revision++) {
          const childEvent = timeline.events[revision - 1], parentEvent = parent.events[revision - 1];
          if (!childEvent || !parentEvent || serializeForImport(childEvent).json !== serializeForImport(parentEvent).json) { add(conflicts, `timeline ${timeline.sourceId} does not match parent prefix at revision ${revision}`); break; }
        }
        if (timeline.forkedFromRevision !== null && timeline.revision < timeline.forkedFromRevision) add(conflicts, `timeline ${timeline.sourceId} revision precedes its fork`);
        const visited = new Set<string>(); let cursor: typeof timeline | undefined = timeline;
        while (cursor && cursor.parentSourceId !== null) { if (visited.has(cursor.sourceId)) { add(conflicts, `timeline cycle includes ${cursor.sourceId}`); break; } visited.add(cursor.sourceId); cursor = byId.get(cursor.parentSourceId); }
      }
      const existingSourceCount = (db.prepare(`SELECT COUNT(*) AS count FROM campaign_timelines WHERE id IN (${pkg.timelines.map(() => "?").join(",")})`).get(...pkg.timelines.map((timeline) => timeline.sourceId)) as { count: number }).count;
      if (existingSourceCount > 0) add(warnings, `${existingSourceCount} source timeline collision(s) will be safely remapped`);
      if (!ids.has(pkg.activeTimelineSourceId)) add(missingReferences, `active timeline ${pkg.activeTimelineSourceId}`);
      const checkpointIds = new Set<string>();
      for (const checkpoint of pkg.records.checkpoints) {
        if (checkpointIds.has(checkpoint.sourceId)) add(conflicts, `duplicate checkpoint ${checkpoint.sourceId}`); checkpointIds.add(checkpoint.sourceId);
        const target = byId.get(checkpoint.timelineSourceId); if (!target) add(missingReferences, `checkpoint timeline ${checkpoint.timelineSourceId}`); else if (checkpoint.timelineRevision > target.revision) add(conflicts, `checkpoint ${checkpoint.sourceId} exceeds timeline revision`);
        const attributeKeys = new Set<string>(), resourceKeys = new Set<string>();
        for (const state of checkpoint.state.attributes) { const key = `${state.actorId}:${state.attributeId}`; if (!actorIds.has(state.actorId)) add(missingReferences, `checkpoint actor ${state.actorId}`); if (attributeKeys.has(key)) add(conflicts, `duplicate checkpoint attribute ${checkpoint.sourceId}/${key}`); attributeKeys.add(key); }
        for (const state of checkpoint.state.resources) { const key = `${state.actorId}:${state.name}`; if (!actorIds.has(state.actorId)) add(missingReferences, `checkpoint actor ${state.actorId}`); if (state.current > state.max) add(conflicts, `checkpoint resource ${checkpoint.sourceId}/${key} exceeds max`); if (resourceKeys.has(key)) add(conflicts, `duplicate checkpoint resource ${checkpoint.sourceId}/${key}`); resourceKeys.add(key); }
      }
      const recapIds = new Set<string>();
      for (const recap of pkg.records.recaps) { if (recapIds.has(recap.sourceId)) add(conflicts, `duplicate recap ${recap.sourceId}`); recapIds.add(recap.sourceId); const target = byId.get(recap.timelineSourceId); if (!target) add(missingReferences, `recap timeline ${recap.timelineSourceId}`); else if (recap.throughRevision > target.revision) add(conflicts, `recap ${recap.sourceId} exceeds timeline revision`); }
      const membershipIds = new Set<string>();
      for (const membership of pkg.records.memberships) { if (membershipIds.has(membership.principalId)) add(conflicts, `duplicate membership ${membership.principalId}`); membershipIds.add(membership.principalId); if (!db.prepare("SELECT 1 FROM principals WHERE id=?").get(membership.principalId)) add(warnings, `membership principal ${membership.principalId} is unavailable and will be skipped`); }
      const roomIds = new Set<string>(), attachableRoomIds = new Set<string>();
      for (const room of pkg.records.roomAttachments) { if (roomIds.has(room.sessionId)) add(conflicts, `duplicate room attachment ${room.sessionId}`); roomIds.add(room.sessionId); const attached = db.prepare("SELECT campaign_id FROM campaign_sessions WHERE session_id=?").get(room.sessionId) as any; let lifecycle: "running" | "stopped" | null = null; try { lifecycle = validateRoom(room.sessionId); } catch { /* malformed sessions are unattachable */ } if (lifecycle === null) add(missingReferences, `room ${room.sessionId} is not attachable`); else if (lifecycle === "stopped") add(conflicts, `room ${room.sessionId} is stopped`); else if (attached) add(conflicts, `room ${room.sessionId} is already attached`); else attachableRoomIds.add(room.sessionId); }
      for (const recap of pkg.records.recaps) for (const sessionId of recap.selectedSessionIds) if (!attachableRoomIds.has(sessionId)) add(missingReferences, `recap session ${sessionId}`);
      if (pkg.content.status === "configured") {
        if (!db.prepare("SELECT 1 FROM rpg_rules_profiles WHERE rules_profile_id=?").get(pkg.content.rulesProfileId)) add(missingReferences, `rules profile ${pkg.content.rulesProfileId}`);
        const pinIds = new Set<string>(), exactPins = new Set<string>();
        for (const pin of pkg.content.contentPacks) { if (pinIds.has(pin.packId)) add(conflicts, `duplicate content pin ${pin.packId}`); pinIds.add(pin.packId); exactPins.add(`${pin.packId}@${pin.packVersion}`); if (!db.prepare("SELECT 1 FROM rpg_content_packs WHERE pack_id=? AND pack_version=? AND rules_profile_id=? AND sealed=1").get(pin.packId, pin.packVersion, pkg.content.rulesProfileId)) add(missingReferences, `sealed content pack ${pin.packId}@${pin.packVersion}`); }
        const references = pkg.records.actors.flatMap((actor) => [actor.race, actor.background, ...actor.classes.map((entry) => entry.class)]);
        for (const reference of references) { if (!exactPins.has(`${reference.packId}@${reference.packVersion}`)) add(missingReferences, `actor definition pin ${reference.packId}@${reference.packVersion}`); if (!db.prepare("SELECT 1 FROM rpg_definitions WHERE pack_id=? AND pack_version=? AND kind=? AND definition_id=?").get(reference.packId, reference.packVersion, reference.kind, reference.definitionId)) add(missingReferences, `actor definition ${reference.kind}:${reference.definitionId}`); }
      } else if (pkg.records.actors.length > 0) add(conflicts, "portable actors require configured content");
      const adminEvents = new Map(pkg.records.administration.events.map((event) => [event.commandId, event]));
      if (adminEvents.size !== pkg.records.administration.events.length) add(conflicts, "duplicate administration command identity");
      if (new Set(pkg.records.administration.events.map((event) => event.eventId)).size !== pkg.records.administration.events.length) add(conflicts, "duplicate administration event identity");
      if (new Set(pkg.records.administration.receipts.map((receipt) => receipt.commandId)).size !== pkg.records.administration.receipts.length) add(conflicts, "duplicate administration receipt identity");
      const orderedAdminEvents = [...pkg.records.administration.events].sort((left, right) => left.revision - right.revision);
      if (orderedAdminEvents.length !== pkg.campaign.administrationRevision || orderedAdminEvents.some((event, index) => event.revision !== index + 1)) add(conflicts, "administration event history is incomplete");
      if (pkg.records.administration.receipts.length !== pkg.campaign.administrationRevision) add(conflicts, "administration receipt history is incomplete");
      for (const receipt of pkg.records.administration.receipts) { const event = adminEvents.get(receipt.commandId); if (!event || event.type !== receipt.type || event.revision !== receipt.revisionAfter || event.occurredAt !== receipt.occurredAt || receipt.revisionAfter !== receipt.revisionBefore + 1) add(conflicts, `administration receipt ${receipt.commandId} is inconsistent`); }
      const recordCount = pkg.timelines.length + pkg.timelines.reduce((sum, timeline) => sum + timeline.events.length, 0) + pkg.records.actors.reduce((sum, actor) => sum + 6 + actor.classes.length + actor.attributes.length + actor.resources.length, 0) + pkg.records.checkpoints.length + pkg.records.recaps.length + pkg.records.memberships.length + pkg.records.checkpoints.reduce((sum, checkpoint) => sum + checkpoint.state.attributes.length + checkpoint.state.resources.length, 0) + pkg.records.roomAttachments.length + pkg.records.administration.events.length + pkg.records.administration.receipts.length;
      if (recordCount + (pkg.content.status === "configured" ? 1 + pkg.content.contentPacks.length : 0) > MAX_CAMPAIGN_IMPORT_RECORDS) add(conflicts, "package exceeds record limit");
      if (db.prepare("SELECT 1 FROM campaign_imports WHERE package_hash=?").get(serialized.hash)) add(conflicts, "package was already imported");
    }
    const dryRun = campaignImportDryRunSchema.parse({ importId: `import-${serialized.hash.slice(0, 32)}`, packageHash: serialized.hash, report: { valid: conflicts.length === 0 && missingReferences.length === 0, conflicts, missingReferences, warnings, counts: { timelines: pkg?.timelines.length ?? 0, events: pkg?.timelines.reduce((sum, timeline) => sum + timeline.events.length, 0) ?? 0, actors: pkg?.records.actors.length ?? 0, checkpoints: pkg?.records.checkpoints.length ?? 0, recaps: pkg?.records.recaps.length ?? 0, memberships: pkg?.records.memberships.length ?? 0, roomAttachments: pkg?.records.roomAttachments.length ?? 0 } } });
    // Staging is deliberately outside campaign state. The deterministic key and
    // INSERT OR IGNORE make identical retries safe while immutable triggers keep
    // the report used for a later apply auditable.
    if (pkg && serialized.json !== null) {
      const existing = db.prepare(`SELECT 1 FROM campaign_import_dry_runs_v30
        WHERE principal_id=? AND import_id=? AND package_hash=?`).get(actor, dryRun.importId, serialized.hash);
      if (!existing) {
        try {
          db.prepare(`INSERT INTO campaign_import_dry_runs_v30
            (principal_id,import_id,package_json,package_hash,report_json,created_at) VALUES (?,?,?,?,?,?)`)
            .run(actor, dryRun.importId, serialized.json, serialized.hash, JSON.stringify(dryRun.report),
              utcIsoTimestampSchema.parse(deps.clock.now().toISOString()));
        } catch (error) {
          // A concurrent identical dry-run may win between the read and insert.
          // Accept only the exact canonical identity; propagate every other failure.
          const raced = db.prepare(`SELECT package_json,package_hash FROM campaign_import_dry_runs_v30
            WHERE principal_id=? AND import_id=?`).get(actor, dryRun.importId) as
            { package_json: string; package_hash: string } | undefined;
          if (!raced || raced.package_json !== serialized.json || raced.package_hash !== serialized.hash) throw error;
        }
      }
    }
    return dryRun;
  };
  const stagedApplyInput = (actor: string, importId: string, idempotencyKey: string): ApplyCampaignImportInput => {
    const row = db.prepare(`SELECT package_json,package_hash,report_json,created_at FROM campaign_import_dry_runs_v30
      WHERE principal_id=? AND import_id=?`).get(actor, importId) as
      { package_json: string; package_hash: string; report_json: string; created_at: string } | undefined;
    if (!row) throw forbiddenError();
    let pkg: CampaignTransferPackage;
    let report: CampaignImportDryRun["report"];
    try {
      pkg = campaignTransferPackageSchema.parse(JSON.parse(row.package_json));
      report = campaignImportReportSchema.parse(JSON.parse(row.report_json));
      utcIsoTimestampSchema.parse(row.created_at);
    } catch { throw conflict("import dry run is stale or invalid"); }
    const canonical = serializeForImport(pkg);
    if (canonical.json !== row.package_json || canonical.hash !== row.package_hash
      || importId !== `import-${row.package_hash.slice(0, 32)}`) {
      throw conflict("import dry run is stale or invalid");
    }
    return { dryRun: { importId, packageHash: row.package_hash, report }, package: pkg, idempotencyKey };
  };
  /** Applies a validated transfer package atomically and records its receipt. */
  const applyCampaignImport = (actorRaw: string, raw: ApplyCampaignImportInput, stagedImportId?: string): { value: CampaignAdministration;
    receipt: CampaignAdministrationReceipt } => {
    assertCanMutate();
    const actor = resourceIdSchema.parse(actorRaw);
    return db.transaction(() => {
      // The route-compatible path reloads its immutable stage after BEGIN
      // IMMEDIATE so package selection and authoritative revalidation share the
      // same atomic apply boundary.
      const input = applyCampaignImportInputSchema.parse(stagedImportId
        ? stagedApplyInput(actor, stagedImportId, raw.idempotencyKey) : raw);
      const canonicalSubmission = serializeForImport(input.package);
      if (canonicalSubmission.json === null) throw conflict("import package is not serializable");
      const prior = db.prepare(`SELECT submission.package_hash,submission.campaign_id,submission.command_id,
          command.created_at,receipt.type,receipt.revision_before,receipt.revision_after,receipt.result_data,
          event.event_id,event.public_data,event.occurred_at FROM campaign_import_submissions submission
          JOIN campaign_administration_commands command ON command.command_id=submission.command_id
          JOIN campaign_administration_receipts receipt ON receipt.command_id=command.command_id
          JOIN campaign_administration_events event ON event.event_id=receipt.event_id
          WHERE submission.principal_id=? AND submission.idempotency_key=?`).get(actor, input.idempotencyKey) as any;
      if (prior) {
        if (prior.package_hash !== canonicalSubmission.hash) throw conflict("idempotency identity collision");
        const event = campaignAdministrationEventSchema.parse({ eventId: prior.event_id, commandId: prior.command_id,
          campaignId: prior.campaign_id, type: prior.type, revision: prior.revision_after,
          occurredAt: prior.occurred_at, data: JSON.parse(prior.public_data) });
        return { value: campaignAdministrationSchema.parse(JSON.parse(prior.result_data)),
          receipt: campaignAdministrationReceiptSchema.parse({ commandId: prior.command_id, campaignId: prior.campaign_id,
            type: prior.type, revisionBefore: prior.revision_before, revisionAfter: prior.revision_after,
            occurredAt: prior.created_at, events: [event] }) };
      }
      const dry = runDryRun(actor, input.package);
      if (!dry.report.valid || dry.packageHash !== canonicalSubmission.hash || JSON.stringify(dry) !== JSON.stringify(input.dryRun))
        throw conflict("import dry run is stale or invalid");
      const campaignId = resourceIdSchema.parse(deps.ids.nextId()), timelineIds = new Map<string, string>();
      for (const timeline of input.package.timelines) timelineIds.set(timeline.sourceId, resourceIdSchema.parse(deps.ids.nextId()));
      const actorIds = new Map(input.package.records.actors.map((portableActor) => [portableActor.sourceActorId, {
        actorId: resourceIdSchema.parse(deps.ids.nextId()), campaignCharacterId: resourceIdSchema.parse(deps.ids.nextId()),
        sheetId: resourceIdSchema.parse(deps.ids.nextId()), characterId: resourceIdSchema.parse(deps.ids.nextId()),
      }]));
      const activeId = timelineIds.get(input.package.activeTimelineSourceId)!;
      const at = utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
      const sourceRevision = input.package.campaign.administrationRevision;
      db.prepare(`INSERT INTO campaigns (id,name,active_timeline_id,owner_principal_id,created_at,updated_at,lifecycle_status,settings,administration_revision)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(campaignId, input.package.campaign.name, activeId, actor, at, at,
          input.package.campaign.status, JSON.stringify(input.package.campaign.settings), sourceRevision);
      db.prepare("INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,'owner',?)").run(campaignId, actor, at);
      for (const timeline of input.package.timelines) {
        const id = timelineIds.get(timeline.sourceId)!;
        db.prepare("INSERT INTO campaign_timelines (id,campaign_id,revision,created_at) VALUES (?,?,?,?)").run(id, campaignId, timeline.revision, timeline.createdAt);
        db.prepare(`INSERT INTO campaign_timeline_history (campaign_id,timeline_id,source_timeline_id,parent_timeline_id,created_by_command_id,forked_from_revision)
          VALUES (?,?,?,?,NULL,?)`).run(campaignId, id, timeline.sourceId,
          timeline.parentSourceId === null ? null : timelineIds.get(timeline.parentSourceId), timeline.forkedFromRevision);
      }
      if (input.package.content.status === "configured") {
        db.prepare("INSERT INTO campaign_rules_profiles (campaign_id,rules_profile_id) VALUES (?,?)").run(campaignId, input.package.content.rulesProfileId);
        for (const pin of input.package.content.contentPacks) db.prepare(`INSERT INTO campaign_content_packs
          (campaign_id,pack_id,pack_version,rules_profile_id) VALUES (?,?,?,?)`).run(campaignId, pin.packId, pin.packVersion, input.package.content.rulesProfileId);
      }
      for (const portableActor of input.package.records.actors) {
        const mapped = actorIds.get(portableActor.sourceActorId)!;
        db.prepare(`INSERT INTO characters (id,name,age,archetype,boundaries,fictional_confirmed,is_real_person,created_at)
          VALUES (?,?,18,'Imported campaign actor','',1,0,?)`).run(mapped.characterId, portableActor.name, at);
        db.prepare(`INSERT INTO campaign_characters (id,campaign_id,character_id,created_at,updated_at) VALUES (?,?,?,?,?)`).run(mapped.campaignCharacterId, campaignId, mapped.characterId, at, at);
        db.prepare(`INSERT INTO rpg_campaign_sheets (id,campaign_id,campaign_character_id,race_pack_id,race_pack_version,race_kind,race_definition_id,
          background_pack_id,background_pack_version,background_kind,background_definition_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(mapped.sheetId, campaignId, mapped.campaignCharacterId, portableActor.race.packId, portableActor.race.packVersion, portableActor.race.kind, portableActor.race.definitionId,
            portableActor.background.packId, portableActor.background.packVersion, portableActor.background.kind, portableActor.background.definitionId, at, at);
        portableActor.classes.forEach((entry, position) => db.prepare(`INSERT INTO rpg_character_classes
          (campaign_id,sheet_id,position,pack_id,pack_version,kind,definition_id,level) VALUES (?,?,?,?,?,?,?,?)`).run(campaignId, mapped.sheetId, position, entry.class.packId, entry.class.packVersion, entry.class.kind, entry.class.definitionId, entry.level));
        portableActor.attributes.forEach((attribute, position) => db.prepare(`INSERT INTO rpg_character_attributes
          (campaign_id,sheet_id,position,attribute_id,value) VALUES (?,?,?,?,?)`).run(campaignId, mapped.sheetId, position, attribute.attributeId, attribute.value));
        db.prepare(`INSERT INTO campaign_actors (id,campaign_id,campaign_character_id,sheet_id,kind,control,created_at,updated_at)
          VALUES (?,?,?,?,'player-character','principal',?,?)`).run(mapped.actorId, campaignId, mapped.campaignCharacterId, mapped.sheetId, at, at);
        db.prepare(`INSERT INTO campaign_actor_private_state (actor_id,campaign_id,controller_principal_id,private_notes) VALUES (?,?,?,NULL)`).run(mapped.actorId, campaignId, actor);
        for (const resource of portableActor.resources) db.prepare(`INSERT INTO rpg_actor_resources
          (campaign_id,actor_id,name,current,max) VALUES (?,?,?,?,?)`).run(campaignId, mapped.actorId, resource.name, resource.current, resource.max);
      }
      for (const timeline of input.package.timelines) for (const portableEvent of timeline.events) {
        const mappedActor = actorIds.get(portableEvent.actorId)!;
        db.prepare(`INSERT INTO campaign_imported_timeline_events (campaign_id,timeline_id,revision,source_event_id,source_command_id,actor_id,source_turn_id,type,occurred_at,public_data)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(campaignId, timelineIds.get(timeline.sourceId), portableEvent.revision, portableEvent.sourceEventId,
            portableEvent.sourceCommandId, mappedActor.actorId, portableEvent.sourceTurnId, portableEvent.type, portableEvent.occurredAt, JSON.stringify(portableEvent.data));
      }
      const commandId = resourceIdSchema.parse(deps.ids.nextId()), eventId = resourceIdSchema.parse(deps.ids.nextId());
      const payload = JSON.stringify({ importId: dry.importId, packageHash: dry.packageHash });
      db.prepare(`INSERT INTO campaign_administration_commands (command_id,campaign_id,idempotency_key,actor_principal_id,expected_revision,type,payload,created_at)
        VALUES (?,?,?,?,?,'import_applied',?,?)`).run(commandId, campaignId, input.idempotencyKey, actor, sourceRevision, payload, at);
      for (const checkpoint of input.package.records.checkpoints) {
        const id = resourceIdSchema.parse(deps.ids.nextId());
        db.prepare(`INSERT INTO campaign_checkpoints (id,source_checkpoint_id,campaign_id,timeline_id,timeline_revision,label,created_at,command_id)
          VALUES (?,?,?,?,?,?,?,?)`).run(id, checkpoint.sourceId, campaignId, timelineIds.get(checkpoint.timelineSourceId), checkpoint.timelineRevision, checkpoint.label, checkpoint.createdAt, commandId);
        for (const state of checkpoint.state.attributes) db.prepare("INSERT INTO campaign_checkpoint_attribute_snapshots (checkpoint_id,actor_id,attribute_id,value) VALUES (?,?,?,?)").run(id, actorIds.get(state.actorId)!.actorId, state.attributeId, state.value);
        for (const state of checkpoint.state.resources) db.prepare("INSERT INTO campaign_checkpoint_resource_snapshots (checkpoint_id,actor_id,name,current,max) VALUES (?,?,?,?,?)").run(id, actorIds.get(state.actorId)!.actorId, state.name, state.current, state.max);
      }
      for (const recap of input.package.records.recaps) db.prepare(`INSERT INTO campaign_recaps (id,source_recap_id,campaign_id,timeline_id,through_revision,selected_session_ids,visibility,text,created_at,command_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(resourceIdSchema.parse(deps.ids.nextId()), recap.sourceId, campaignId, timelineIds.get(recap.timelineSourceId), recap.throughRevision, JSON.stringify(recap.selectedSessionIds), recap.visibility, recap.text, recap.createdAt, commandId);
      for (const membership of input.package.records.memberships) if (membership.principalId !== actor && db.prepare("SELECT 1 FROM principals WHERE id=?").get(membership.principalId))
        db.prepare("INSERT OR IGNORE INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,?,?)").run(campaignId, membership.principalId, membership.role, membership.createdAt);
      for (const room of input.package.records.roomAttachments) {
        let lifecycle: "running" | "stopped" | null = null;
        try { lifecycle = validateRoom(room.sessionId); } catch { /* normalized below */ }
        if (lifecycle !== "running") throw conflict("room is not attachable");
        if (db.prepare("SELECT 1 FROM campaign_sessions WHERE session_id=?").get(room.sessionId)) throw conflict("room attachment already exists");
        db.prepare("INSERT INTO campaign_sessions (campaign_id,session_id,attached_at) VALUES (?,?,?)").run(campaignId, room.sessionId, room.attachedAt);
      }
      for (const event of input.package.records.administration.events) db.prepare(`INSERT INTO campaign_imported_administration_events
        (campaign_id,revision,source_event_id,source_command_id,type,occurred_at,public_data) VALUES (?,?,?,?,?,?,?)`).run(campaignId, event.revision, event.eventId, event.commandId, event.type, event.occurredAt, JSON.stringify(event.data));
      for (const receipt of input.package.records.administration.receipts) db.prepare(`INSERT INTO campaign_imported_administration_receipts
        (campaign_id,source_command_id,type,revision_before,revision_after,occurred_at) VALUES (?,?,?,?,?,?)`).run(campaignId, receipt.commandId, receipt.type, receipt.revisionBefore, receipt.revisionAfter, receipt.occurredAt);
      const importedCatalogEvent = [...input.package.records.administration.events].filter((event) => event.type === "catalog_configured").sort((left, right) => right.revision - left.revision)[0];
      if (importedCatalogEvent && input.package.content.status === "configured") {
        const identifiers = [...input.package.content.contentPacks].sort((left, right) => left.packId < right.packId ? -1 : left.packId > right.packId ? 1 : 0);
        const selectionDigest = createHash("sha256").update(JSON.stringify(canonicalizeJson({ rulesProfileId: input.package.content.rulesProfileId, contentPacks: identifiers }))).digest("hex");
        db.prepare("INSERT INTO campaign_catalog_current_selections VALUES (?,?,?,?,?,?)").run(campaignId, input.package.content.rulesProfileId, selectionDigest, actor, importedCatalogEvent.occurredAt, importedCatalogEvent.commandId);
        const insertImportedPin = db.prepare("INSERT INTO campaign_catalog_current_pins VALUES (?,?,?,?,?)");
        identifiers.forEach((pin, position) => insertImportedPin.run(campaignId, pin.packId, pin.packVersion, position, importedCatalogEvent.commandId));
      }
      const after = sourceRevision + 1;
      db.prepare("UPDATE campaigns SET administration_revision=? WHERE id=?").run(after, campaignId);
      db.prepare(`INSERT INTO campaign_administration_events (event_id,campaign_id,command_id,revision_before,revision,type,public_data,private_data,occurred_at)
        VALUES (?,?,?,?,?,'import_applied',?,? ,?)`).run(eventId, campaignId, commandId, sourceRevision, after, payload, payload, at);
      const imported = getCampaignAdministration(actor, campaignId)!;
      db.prepare(`INSERT INTO campaign_administration_receipts (command_id,campaign_id,event_id,type,revision_before,revision_after,result_data)
        VALUES (?,?,?,'import_applied',?,?,?)`).run(commandId, campaignId, eventId, sourceRevision, after, JSON.stringify(imported));
      db.prepare("INSERT INTO campaign_imports VALUES (?,?,?,1,?,?)").run(dry.importId, campaignId, dry.packageHash, at, commandId);
      db.prepare(`INSERT INTO campaign_import_submissions (principal_id,idempotency_key,package_hash,campaign_id,command_id,created_at) VALUES (?,?,?,?,?,?)`).run(actor, input.idempotencyKey, dry.packageHash, campaignId, commandId, at);
      const event = campaignAdministrationEventSchema.parse({ eventId, commandId, campaignId, type: "import_applied", revision: after, occurredAt: at, data: JSON.parse(payload) });
      return { value: imported, receipt: campaignAdministrationReceiptSchema.parse({ commandId, campaignId, type: "import_applied", revisionBefore: sourceRevision, revisionAfter: after, occurredAt: at, events: [event] }) };
    }).immediate();
  };
  /** Applies only the immutable package associated with the caller's staged dry-run. */
  const applyCampaignImportById = (actorRaw: string, importIdRaw: string, raw: CampaignTransferHttpApplyRequest) => {
    const actor = resourceIdSchema.parse(actorRaw);
    const importId = resourceIdSchema.parse(importIdRaw);
    const input = campaignTransferHttpApplyRequestSchema.parse(raw);
    const owner = db.prepare("SELECT principal_id FROM application_owner WHERE singleton=1").get() as any;
    if (!owner || owner.principal_id !== actor) throw forbiddenError();
    const staged = stagedApplyInput(actor, importId, input.idempotencyKey);
    return applyCampaignImport(actor, staged, importId);
  };
  return { dryRunCampaignImport, applyCampaignImport, applyCampaignImportById };
}

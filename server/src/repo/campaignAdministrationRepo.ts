import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  CAMPAIGN_TRANSFER_FORMAT_VERSION, MAX_CAMPAIGN_IMPORT_BYTES, MAX_CAMPAIGN_IMPORT_RECORDS,
  applyCampaignImportInputSchema, campaignAdministrationEventSchema,
  campaignAdministrationReceiptSchema,
  campaignAdministrationSchema, campaignCheckpointSchema, campaignExportManifestSchema,
  campaignImportDryRunSchema, campaignMembershipReadSchema, campaignRecapSchema,
  campaignSessionAttachmentSchema, campaignTimelineHistorySchema, campaignTransferPackageSchema,
  createCampaignExportInputSchema,
  resourceIdSchema, utcIsoTimestampSchema,
  type ApplyCampaignImportInput, type CampaignAdministration, type CampaignAdministrationEvent,
  type CampaignAdministrationPatch,
  type CampaignAdministrationReceipt, type CampaignCheckpoint, type CampaignExportManifest,
  type CampaignImportDryRun, type CampaignMembershipMutation, type CampaignMembershipRead,
  type CampaignMembership,
  type CampaignMembershipRoleMutation, type CampaignRecap, type CampaignRevisionMutation,
  type CampaignRoomMutation, type CampaignSessionAttachment,
  type CampaignTimelineHistory, type CampaignTransferPackage, type CreateCampaignCheckpointInput,
  type CreateCampaignExportInput, type CreateCampaignRecapInput, type ForkCampaignTimelineInput,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaign/campaignTypes.js";
import { createAdministrationCommandRepo } from "./campaignAdmin/administrationCommandRepo.js";
import { createAdministrationEventRepo } from "./campaignAdmin/administrationEventRepo.js";
import { createAdministrationReceiptRepo } from "./campaignAdmin/administrationReceiptRepo.js";
import { createCampaignTimelineRepo } from "./campaignAdmin/campaignTimelineRepo.js";
import { createAdministrationAccessRepo } from "./campaignAdmin/administrationAccessRepo.js";
import { createAdministrationImportRepo } from "./campaignAdmin/administrationImportRepo.js";
import { canonicalizeJson, forbidden, serializeForImport, timelineTransferEvents } from "./campaignAdmin/administrationImportHelpers.js";

export class CampaignAdministrationForbiddenError extends Error {
  readonly code = "CAMPAIGN_ADMINISTRATION_FORBIDDEN";
  constructor() { super("campaign administration is unavailable"); this.name = "CampaignAdministrationForbiddenError"; }
}
export class CampaignAdministrationStaleError extends Error {
  readonly code = "CAMPAIGN_ADMINISTRATION_STALE";
  constructor() { super("campaign administration revision is stale"); this.name = "CampaignAdministrationStaleError"; }
}
export class CampaignAdministrationConflictError extends Error {
  readonly code = "CAMPAIGN_ADMINISTRATION_CONFLICT";
  constructor(message: string) { super(message); this.name = "CampaignAdministrationConflictError"; }
}

type MutationResult<T> = { value: T; receipt: CampaignAdministrationReceipt };
export interface ConfirmedCampaignArchiveInput {
  confirmationName: string;
  expectedRevision: number;
  idempotencyKey: string;
}
export interface CampaignAdministrationRepository {
  getCampaignAdministration(actor: string, campaignId: string): CampaignAdministration | null;
  renameCampaignCompatibility(actor: string, campaignId: string, name: string, expectedUpdatedAt?: string): CampaignAdministrationReceipt;
  updateCampaignAdministration(actor: string, campaignId: string, input: CampaignAdministrationPatch): MutationResult<CampaignAdministration>;
  archiveCampaignWithConfirmation(actor: string, campaignId: string, input: ConfirmedCampaignArchiveInput):
    MutationResult<CampaignAdministration>;
  addAuditedCampaignMembership(actor: string, campaignId: string, input: CampaignMembershipMutation): MutationResult<CampaignMembership>;
  changeAuditedCampaignMembershipRole(actor: string, campaignId: string, principalId: string, input: CampaignMembershipRoleMutation): MutationResult<CampaignMembershipRead>;
  removeAuditedCampaignMembership(actor: string, campaignId: string, principalId: string, input: CampaignRevisionMutation): MutationResult<CampaignMembershipRead>;
  attachAuditedCampaignRoom(actor: string, campaignId: string, input: CampaignRoomMutation): MutationResult<CampaignSessionAttachment>;
  detachAuditedCampaignRoom(actor: string, campaignId: string, input: CampaignRoomMutation): MutationResult<CampaignSessionAttachment>;
  listCampaignTimelineHistory(actor: string, campaignId: string): CampaignTimelineHistory[];
  createCampaignCheckpoint(actor: string, campaignId: string, input: CreateCampaignCheckpointInput): MutationResult<CampaignCheckpoint>;
  listCampaignCheckpoints(actor: string, campaignId: string): CampaignCheckpoint[];
  forkCampaignTimeline(actor: string, campaignId: string, input: ForkCampaignTimelineInput): MutationResult<CampaignTimelineHistory>;
  createCampaignRecap(actor: string, campaignId: string, input: CreateCampaignRecapInput): MutationResult<CampaignRecap>;
  listCampaignRecaps(actor: string, campaignId: string): CampaignRecap[];
  dryRunCampaignImport(actor: string, input: unknown): CampaignImportDryRun;
  applyCampaignImport(actor: string, input: ApplyCampaignImportInput): MutationResult<CampaignAdministration>;
  createCampaignExport(actor: string, campaignId: string, input: CreateCampaignExportInput):
    MutationResult<{ manifest: CampaignExportManifest; package: CampaignTransferPackage }>;
  listCampaignAdministrationEvents(actor: string, campaignId: string): CampaignAdministrationEvent[];
  getCampaignAdministrationReceipt(actor: string, campaignId: string, commandId: string): CampaignAdministrationReceipt | null;
}

export function createCampaignAdministrationRepository(db: DatabaseDriver.Database,
  deps: RepositoryDependencies, assertCanMutate: () => void = () => undefined,
  validateRoom: (sessionId: string) => "running" | "stopped" | null = () => null): CampaignAdministrationRepository {
  const access = createAdministrationAccessRepo(db);
  let runDryRunCampaignImport: (actor: string, input: unknown) => CampaignImportDryRun;
  const imports = createAdministrationImportRepo({ db, deps, validateRoom, getAuthority: access.getAuthority,
    forbidden: () => new CampaignAdministrationForbiddenError(), assertCanMutate,
    conflict: (message) => new CampaignAdministrationConflictError(message),
    getCampaignAdministration: access.getCampaignAdministration,
    dryRunCampaignImport: (actor, input) => runDryRunCampaignImport(actor, input) });
  runDryRunCampaignImport = imports.dryRunCampaignImport;
  const member = (row: any) => campaignMembershipReadSchema.parse({ campaignId: row.campaign_id,
    principalId: row.principal_id, role: row.role, createdAt: row.created_at });
  const attachment = (row: any) => campaignSessionAttachmentSchema.parse({ campaignId: row.campaign_id,
    sessionId: row.session_id, attachedAt: row.attached_at });
  const checkpoint = (row: any) => campaignCheckpointSchema.parse({ id: row.id, campaignId: row.campaign_id,
    timelineId: row.timeline_id, timelineRevision: row.timeline_revision, label: row.label, createdAt: row.created_at });
  const recap = (row: any) => campaignRecapSchema.parse({ id: row.id, campaignId: row.campaign_id,
    timelineId: row.timeline_id, throughRevision: row.through_revision,
    selectedSessionIds: JSON.parse(row.selected_session_ids), visibility: row.visibility, text: row.text, createdAt: row.created_at });
  const timeline = (row: any, activeId: string) => campaignTimelineHistorySchema.parse({ id: row.id,
    campaignId: row.campaign_id, parentTimelineId: row.parent_timeline_id, forkedFromRevision: row.forked_from_revision,
    revision: row.revision, createdAt: row.created_at, active: row.id === activeId });
  const commands = createAdministrationCommandRepo({ db, nextId: () => deps.ids.nextId(), now: () => deps.clock.now(),
    getAuthority: access.getAuthority, assertCanMutate,
    errors: { forbidden: () => new CampaignAdministrationForbiddenError(), stale: () => new CampaignAdministrationStaleError(),
      conflict: (message) => new CampaignAdministrationConflictError(message) },
    validateRoom, member, attachment, checkpoint, recap, timeline });
  const events = createAdministrationEventRepo({ db, getAuthority: access.getAuthority });
  const receipts = createAdministrationReceiptRepo({ db, event: campaignAdministrationEventSchema.parse,
    getAuthority: access.getAuthority, receipt: campaignAdministrationReceiptSchema.parse });
  const timelines = createCampaignTimelineRepo({ db, getAuthority: access.getAuthority, timeline });
  const api: CampaignAdministrationRepository = {
    getCampaignAdministration: access.getCampaignAdministration,
    renameCampaignCompatibility: commands.renameCampaignCompatibility,
    updateCampaignAdministration: commands.updateCampaignAdministration,
    archiveCampaignWithConfirmation: commands.archiveCampaignWithConfirmation,
    addAuditedCampaignMembership: commands.addAuditedCampaignMembership,
    changeAuditedCampaignMembershipRole: commands.changeAuditedCampaignMembershipRole,
    removeAuditedCampaignMembership: commands.removeAuditedCampaignMembership,
    attachAuditedCampaignRoom: commands.attachAuditedCampaignRoom,
    detachAuditedCampaignRoom: commands.detachAuditedCampaignRoom,
    createCampaignCheckpoint: commands.createCampaignCheckpoint,
    listCampaignCheckpoints: commands.listCampaignCheckpoints,
    forkCampaignTimeline: commands.forkCampaignTimeline,
    createCampaignRecap: commands.createCampaignRecap,
    listCampaignRecaps: commands.listCampaignRecaps,
    listCampaignTimelineHistory: timelines.listCampaignTimelineHistory,
    dryRunCampaignImport: (actorRaw, raw) => {
      return imports.dryRunCampaignImport(actorRaw, raw);
      /* Relocated to administrationImportRepo.ts.
      const actor = resourceIdSchema.parse(actorRaw), owner = db.prepare("SELECT principal_id FROM application_owner WHERE singleton=1").get() as any;
      if (!owner || owner.principal_id !== actor) throw new CampaignAdministrationForbiddenError();
      const conflicts: string[] = [], missingReferences: string[] = [], warnings: string[] = [];
      const add = (target: string[], issue: string) => { if (target.length < 100 && !target.includes(issue)) target.push(issue); };
      let pkg: CampaignTransferPackage | null = null;
      const serialized = serializeForImport(raw);
      if (serialized.json === null) add(conflicts, "package is not serializable");
      const exceedsSize = serialized.json !== null && Buffer.byteLength(serialized.json, "utf8") > MAX_CAMPAIGN_IMPORT_BYTES;
      if (exceedsSize) add(conflicts, "package exceeds size limit");
      try {
        if (forbidden(raw)) add(conflicts, "package contains excluded secret, path, usage, price, or credential fields");
      } catch {
        add(conflicts, "package cannot be safely inspected");
      }
      try {
        if (exceedsSize) throw new Error("size limit reached before schema traversal");
        const parsed = campaignTransferPackageSchema.safeParse(raw);
        if (parsed.success) pkg = parsed.data;
        else add(conflicts, "package schema, Unicode, nesting, or format version is invalid");
      } catch {
        if (!exceedsSize) add(conflicts, "package schema inspection failed safely");
      }
      if (pkg) {
        const ids = new Set<string>(), byId = new Map(pkg.timelines.map((timeline) => [timeline.sourceId, timeline]));
        const sourceEvents = new Map<string, string>(), sourceCommands = new Map<string, string>();
        for (const timeline of pkg.timelines) {
          if (ids.has(timeline.sourceId)) add(conflicts, `duplicate timeline ${timeline.sourceId}`);
          ids.add(timeline.sourceId);
          if (timeline.parentSourceId === timeline.sourceId) add(conflicts, `timeline ${timeline.sourceId} cannot parent itself`);
          if ((timeline.parentSourceId === null) !== (timeline.forkedFromRevision === null))
            add(conflicts, `timeline ${timeline.sourceId} has inconsistent root/fork metadata`);
          if (timeline.events.length !== timeline.revision || timeline.events.some((event, index) => event.revision !== index + 1))
            add(conflicts, `timeline ${timeline.sourceId} event history is incomplete`);
          for (const event of timeline.events) {
            const canonicalEvent = serializeForImport(event).json!;
            const priorEvent = sourceEvents.get(event.sourceEventId);
            if (priorEvent !== undefined && priorEvent !== canonicalEvent)
              add(conflicts, `conflicting duplicate source event ${event.sourceEventId}`);
            sourceEvents.set(event.sourceEventId, canonicalEvent);
            const priorCommand = sourceCommands.get(event.sourceCommandId);
            if (priorCommand !== undefined && priorCommand !== canonicalEvent)
              add(conflicts, `conflicting duplicate source command ${event.sourceCommandId}`);
            // Exact inherited prefixes intentionally repeat both identities.
            sourceCommands.set(event.sourceCommandId, canonicalEvent);
          }
        }
        const actorIds = new Set<string>(), characterIds = new Set<string>(), sheetIds = new Set<string>();
        for (const portableActor of pkg.records.actors) {
          if (actorIds.has(portableActor.sourceActorId)) add(conflicts, `duplicate actor ${portableActor.sourceActorId}`);
          if (characterIds.has(portableActor.sourceCampaignCharacterId)) add(conflicts, `duplicate campaign character ${portableActor.sourceCampaignCharacterId}`);
          if (sheetIds.has(portableActor.sourceSheetId)) add(conflicts, `duplicate sheet ${portableActor.sourceSheetId}`);
          actorIds.add(portableActor.sourceActorId); characterIds.add(portableActor.sourceCampaignCharacterId);
          sheetIds.add(portableActor.sourceSheetId);
          if (portableActor.race.kind !== "race") add(conflicts, `actor ${portableActor.sourceActorId} race reference has wrong kind`);
          if (portableActor.background.kind !== "background") add(conflicts, `actor ${portableActor.sourceActorId} background reference has wrong kind`);
          const attributes = new Set<string>(), resources = new Set<string>(), classes = new Set<string>();
          for (const attribute of portableActor.attributes) {
            if (attributes.has(attribute.attributeId)) add(conflicts, `duplicate actor attribute ${portableActor.sourceActorId}/${attribute.attributeId}`);
            attributes.add(attribute.attributeId);
          }
          for (const resource of portableActor.resources) {
            if (resources.has(resource.name)) add(conflicts, `duplicate actor resource ${portableActor.sourceActorId}/${resource.name}`);
            if (resource.current > resource.max) add(conflicts, `actor resource ${portableActor.sourceActorId}/${resource.name} exceeds max`);
            resources.add(resource.name);
          }
          for (const entry of portableActor.classes) {
            if (entry.class.kind !== "class") add(conflicts, `actor ${portableActor.sourceActorId} class reference has wrong kind`);
            const key = `${entry.class.packId}@${entry.class.packVersion}:${entry.class.kind}:${entry.class.definitionId}`;
            if (classes.has(key)) add(conflicts, `duplicate actor class ${portableActor.sourceActorId}/${key}`);
            classes.add(key);
          }
        }
        for (const timeline of pkg.timelines) for (const event of timeline.events)
          if (!actorIds.has(event.actorId)) add(missingReferences, `timeline event actor ${event.actorId}`);
        const roots = pkg.timelines.filter((timeline) => timeline.parentSourceId === null);
        if (roots.length !== 1) add(conflicts, "timeline graph must contain exactly one root");
        for (const timeline of pkg.timelines) {
          if (timeline.parentSourceId !== null && !ids.has(timeline.parentSourceId))
            add(missingReferences, `timeline parent ${timeline.parentSourceId}`);
          const parent = timeline.parentSourceId === null ? undefined : byId.get(timeline.parentSourceId);
          if (parent && timeline.forkedFromRevision! > parent.revision)
            add(conflicts, `timeline ${timeline.sourceId} fork revision exceeds parent`);
          if (parent && timeline.forkedFromRevision !== null) {
            for (let revision = 1; revision <= timeline.forkedFromRevision; revision++) {
              const childEvent = timeline.events[revision - 1], parentEvent = parent.events[revision - 1];
              if (!childEvent || !parentEvent
                || serializeForImport(childEvent).json !== serializeForImport(parentEvent).json) {
                add(conflicts, `timeline ${timeline.sourceId} does not match parent prefix at revision ${revision}`);
                break;
              }
            }
          }
          if (timeline.forkedFromRevision !== null && timeline.revision < timeline.forkedFromRevision)
            add(conflicts, `timeline ${timeline.sourceId} revision precedes its fork`);
          const visited = new Set<string>(); let cursor: typeof timeline | undefined = timeline;
          while (cursor && cursor.parentSourceId !== null) {
            if (visited.has(cursor.sourceId)) { add(conflicts, `timeline cycle includes ${cursor.sourceId}`); break; }
            visited.add(cursor.sourceId); cursor = byId.get(cursor.parentSourceId);
          }
        }
        const existingSourceCount = (db.prepare(`SELECT COUNT(*) AS count FROM campaign_timelines
          WHERE id IN (${pkg.timelines.map(() => "?").join(",")})`).get(...pkg.timelines.map((t) => t.sourceId)) as { count: number }).count;
        if (existingSourceCount > 0) add(warnings, `${existingSourceCount} source timeline collision(s) will be safely remapped`);
        if (!ids.has(pkg.activeTimelineSourceId)) add(missingReferences, `active timeline ${pkg.activeTimelineSourceId}`);
        const checkpointIds = new Set<string>();
        for (const checkpoint of pkg.records.checkpoints) {
          if (checkpointIds.has(checkpoint.sourceId)) add(conflicts, `duplicate checkpoint ${checkpoint.sourceId}`);
          checkpointIds.add(checkpoint.sourceId);
          const target = byId.get(checkpoint.timelineSourceId);
          if (!target) add(missingReferences, `checkpoint timeline ${checkpoint.timelineSourceId}`);
          else if (checkpoint.timelineRevision > target.revision) add(conflicts, `checkpoint ${checkpoint.sourceId} exceeds timeline revision`);
          const attributeKeys = new Set<string>(), resourceKeys = new Set<string>();
          for (const state of checkpoint.state.attributes) {
            const key = `${state.actorId}:${state.attributeId}`;
            if (!actorIds.has(state.actorId)) add(missingReferences, `checkpoint actor ${state.actorId}`);
            if (attributeKeys.has(key)) add(conflicts, `duplicate checkpoint attribute ${checkpoint.sourceId}/${key}`);
            attributeKeys.add(key);
          }
          for (const state of checkpoint.state.resources) {
            const key = `${state.actorId}:${state.name}`;
            if (!actorIds.has(state.actorId)) add(missingReferences, `checkpoint actor ${state.actorId}`);
            if (state.current > state.max) add(conflicts, `checkpoint resource ${checkpoint.sourceId}/${key} exceeds max`);
            if (resourceKeys.has(key)) add(conflicts, `duplicate checkpoint resource ${checkpoint.sourceId}/${key}`);
            resourceKeys.add(key);
          }
        }
        const recapIds = new Set<string>();
        for (const recap of pkg.records.recaps) {
          if (recapIds.has(recap.sourceId)) add(conflicts, `duplicate recap ${recap.sourceId}`);
          recapIds.add(recap.sourceId);
          const target = byId.get(recap.timelineSourceId);
          if (!target) add(missingReferences, `recap timeline ${recap.timelineSourceId}`);
          else if (recap.throughRevision > target.revision) add(conflicts, `recap ${recap.sourceId} exceeds timeline revision`);
        }
        const membershipIds = new Set<string>();
        for (const membership of pkg.records.memberships) {
          if (membershipIds.has(membership.principalId)) add(conflicts, `duplicate membership ${membership.principalId}`);
          membershipIds.add(membership.principalId);
          if (!db.prepare("SELECT 1 FROM principals WHERE id=?").get(membership.principalId))
            add(warnings, `membership principal ${membership.principalId} is unavailable and will be skipped`);
        }
        const roomIds = new Set<string>(), attachableRoomIds = new Set<string>();
        for (const room of pkg.records.roomAttachments) {
          if (roomIds.has(room.sessionId)) add(conflicts, `duplicate room attachment ${room.sessionId}`);
          roomIds.add(room.sessionId);
          const attached = db.prepare("SELECT campaign_id FROM campaign_sessions WHERE session_id=?").get(room.sessionId) as any;
          let lifecycle: "running" | "stopped" | null = null;
          try { lifecycle = validateRoom(room.sessionId); } catch { malformed sessions are deliberately unattachable }
          if (lifecycle === null) add(missingReferences, `room ${room.sessionId} is not attachable`);
          else if (lifecycle === "stopped") add(conflicts, `room ${room.sessionId} is stopped`);
          else if (attached) add(conflicts, `room ${room.sessionId} is already attached`);
          else attachableRoomIds.add(room.sessionId);
        }
        for (const recap of pkg.records.recaps) for (const sessionId of recap.selectedSessionIds)
          if (!attachableRoomIds.has(sessionId)) add(missingReferences, `recap session ${sessionId}`);
        if (pkg.content.status === "configured") {
          if (!db.prepare("SELECT 1 FROM rpg_rules_profiles WHERE rules_profile_id=?").get(pkg.content.rulesProfileId))
            add(missingReferences, `rules profile ${pkg.content.rulesProfileId}`);
          const pinIds = new Set<string>(), exactPins = new Set<string>();
          for (const pin of pkg.content.contentPacks) {
            if (pinIds.has(pin.packId)) add(conflicts, `duplicate content pin ${pin.packId}`);
            pinIds.add(pin.packId);
            exactPins.add(`${pin.packId}@${pin.packVersion}`);
            if (!db.prepare(`SELECT 1 FROM rpg_content_packs WHERE pack_id=? AND pack_version=?
                AND rules_profile_id=? AND sealed=1`).get(pin.packId, pin.packVersion, pkg.content.rulesProfileId))
              add(missingReferences, `sealed content pack ${pin.packId}@${pin.packVersion}`);
          }
          const references = pkg.records.actors.flatMap((actor) => [actor.race, actor.background, ...actor.classes.map((entry) => entry.class)]);
          for (const reference of references) {
            if (!exactPins.has(`${reference.packId}@${reference.packVersion}`))
              add(missingReferences, `actor definition pin ${reference.packId}@${reference.packVersion}`);
            if (!db.prepare(`SELECT 1 FROM rpg_definitions WHERE pack_id=? AND pack_version=? AND kind=? AND definition_id=?`)
              .get(reference.packId, reference.packVersion, reference.kind, reference.definitionId))
              add(missingReferences, `actor definition ${reference.kind}:${reference.definitionId}`);
          }
        } else if (pkg.records.actors.length > 0) {
          add(conflicts, "portable actors require configured content");
        }
        const adminEvents = new Map(pkg.records.administration.events.map((event) => [event.commandId, event]));
        if (adminEvents.size !== pkg.records.administration.events.length) add(conflicts, "duplicate administration command identity");
        const adminEventIds = new Set(pkg.records.administration.events.map((event) => event.eventId));
        if (adminEventIds.size !== pkg.records.administration.events.length) add(conflicts, "duplicate administration event identity");
        if (new Set(pkg.records.administration.receipts.map((receipt) => receipt.commandId)).size
          !== pkg.records.administration.receipts.length) add(conflicts, "duplicate administration receipt identity");
        const orderedAdminEvents = [...pkg.records.administration.events].sort((left, right) => left.revision - right.revision);
        if (orderedAdminEvents.length !== pkg.campaign.administrationRevision
          || orderedAdminEvents.some((event, index) => event.revision !== index + 1))
          add(conflicts, "administration event history is incomplete");
        if (pkg.records.administration.receipts.length !== pkg.campaign.administrationRevision)
          add(conflicts, "administration receipt history is incomplete");
        for (const receipt of pkg.records.administration.receipts) {
          const event = adminEvents.get(receipt.commandId);
          if (!event || event.type !== receipt.type || event.revision !== receipt.revisionAfter
            || event.occurredAt !== receipt.occurredAt
            || receipt.revisionAfter !== receipt.revisionBefore + 1) add(conflicts, `administration receipt ${receipt.commandId} is inconsistent`);
        }
        const recordCount = pkg.timelines.length + pkg.timelines.reduce((sum, timeline) => sum + timeline.events.length, 0)
          + pkg.records.actors.reduce((sum, actor) => sum + 6 + actor.classes.length + actor.attributes.length + actor.resources.length, 0)
          + pkg.records.checkpoints.length + pkg.records.recaps.length + pkg.records.memberships.length
          + pkg.records.checkpoints.reduce((sum, checkpoint) => sum + checkpoint.state.attributes.length
            + checkpoint.state.resources.length, 0)
          + pkg.records.roomAttachments.length + pkg.records.administration.events.length + pkg.records.administration.receipts.length;
        if (pkg.content.status === "configured") {
          // One campaign-profile row plus every exact pack pin is persisted.
          if (recordCount + 1 + pkg.content.contentPacks.length > MAX_CAMPAIGN_IMPORT_RECORDS)
            add(conflicts, "package exceeds record limit");
        }
        if (recordCount > MAX_CAMPAIGN_IMPORT_RECORDS) add(conflicts, "package exceeds record limit");
        if (db.prepare("SELECT 1 FROM campaign_imports WHERE package_hash=?").get(serialized.hash))
          add(conflicts, "package was already imported");
      }
      return campaignImportDryRunSchema.parse({ importId: `import-${serialized.hash.slice(0, 32)}`, packageHash: serialized.hash,
        report: { valid: conflicts.length === 0 && missingReferences.length === 0, conflicts, missingReferences, warnings,
          counts: { timelines: pkg?.timelines.length ?? 0,
            events: pkg?.timelines.reduce((sum, timeline) => sum + timeline.events.length, 0) ?? 0,
            actors: pkg?.records.actors.length ?? 0,
            checkpoints: pkg?.records.checkpoints.length ?? 0, recaps: pkg?.records.recaps.length ?? 0,
            memberships: pkg?.records.memberships.length ?? 0, roomAttachments: pkg?.records.roomAttachments.length ?? 0 } } });
      */
      },
    applyCampaignImport: (actorRaw, raw) => {
      return imports.applyCampaignImport(actorRaw, raw);
      // Retained temporarily to keep this extraction mechanically reviewable.
      if (false) {
      assertCanMutate();
      const actor = resourceIdSchema.parse(actorRaw);
      return db.transaction(() => {
        const input = applyCampaignImportInputSchema.parse(raw);
        const canonicalSubmission = serializeForImport(input.package);
        if (canonicalSubmission.json === null) throw new CampaignAdministrationConflictError("import package is not serializable");
        const prior = db.prepare(`SELECT submission.package_hash,submission.campaign_id,submission.command_id,
            command.created_at,receipt.type,receipt.revision_before,receipt.revision_after,receipt.result_data,
            event.event_id,event.public_data,event.occurred_at
          FROM campaign_import_submissions submission
          JOIN campaign_administration_commands command ON command.command_id=submission.command_id
          JOIN campaign_administration_receipts receipt ON receipt.command_id=command.command_id
          JOIN campaign_administration_events event ON event.event_id=receipt.event_id
          WHERE submission.principal_id=? AND submission.idempotency_key=?`).get(actor, input.idempotencyKey) as any;
        if (prior) {
          if (prior.package_hash !== canonicalSubmission.hash) throw new CampaignAdministrationConflictError("idempotency identity collision");
          const event = campaignAdministrationEventSchema.parse({ eventId: prior.event_id, commandId: prior.command_id,
            campaignId: prior.campaign_id, type: prior.type, revision: prior.revision_after,
            occurredAt: prior.occurred_at, data: JSON.parse(prior.public_data) });
          return { value: campaignAdministrationSchema.parse(JSON.parse(prior.result_data)),
            receipt: campaignAdministrationReceiptSchema.parse({ commandId: prior.command_id, campaignId: prior.campaign_id,
              type: prior.type, revisionBefore: prior.revision_before, revisionAfter: prior.revision_after,
              occurredAt: prior.created_at, events: [event] }) };
        }
        const dry = api.dryRunCampaignImport(actor, input.package);
        if (!dry.report.valid || dry.packageHash !== canonicalSubmission.hash
          || JSON.stringify(dry) !== JSON.stringify(input.dryRun))
          throw new CampaignAdministrationConflictError("import dry run is stale or invalid");
        const campaignId = resourceIdSchema.parse(deps.ids.nextId()), timelineIds = new Map<string, string>();
        for (const t of input.package.timelines) timelineIds.set(t.sourceId, resourceIdSchema.parse(deps.ids.nextId()));
        const actorIds = new Map(input.package.records.actors.map((portableActor) => [portableActor.sourceActorId, {
          actorId: resourceIdSchema.parse(deps.ids.nextId()), campaignCharacterId: resourceIdSchema.parse(deps.ids.nextId()),
          sheetId: resourceIdSchema.parse(deps.ids.nextId()), characterId: resourceIdSchema.parse(deps.ids.nextId()),
        }]));
        const activeId = timelineIds.get(input.package.activeTimelineSourceId)!, at = utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
        const sourceRevision = input.package.campaign.administrationRevision;
        db.prepare(`INSERT INTO campaigns (id,name,active_timeline_id,owner_principal_id,created_at,updated_at,lifecycle_status,settings,administration_revision)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(campaignId, input.package.campaign.name, activeId, actor, at, at,
            input.package.campaign.status, JSON.stringify(input.package.campaign.settings), sourceRevision);
        db.prepare("INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,'owner',?)").run(campaignId, actor, at);
        for (const t of input.package.timelines) {
          const id = timelineIds.get(t.sourceId)!;
          db.prepare("INSERT INTO campaign_timelines (id,campaign_id,revision,created_at) VALUES (?,?,?,?)").run(id, campaignId, t.revision, t.createdAt);
          db.prepare(`INSERT INTO campaign_timeline_history
            (campaign_id,timeline_id,source_timeline_id,parent_timeline_id,created_by_command_id,forked_from_revision) VALUES (?,?,?,?,NULL,?)`)
            .run(campaignId, id, t.sourceId, t.parentSourceId === null ? null : timelineIds.get(t.parentSourceId), t.forkedFromRevision);
        }
        if (input.package.content.status === "configured") {
          db.prepare("INSERT INTO campaign_rules_profiles (campaign_id,rules_profile_id) VALUES (?,?)")
            .run(campaignId, input.package.content.rulesProfileId);
          for (const pin of input.package.content.contentPacks) db.prepare(`INSERT INTO campaign_content_packs
            (campaign_id,pack_id,pack_version,rules_profile_id) VALUES (?,?,?,?)`)
            .run(campaignId, pin.packId, pin.packVersion, input.package.content.rulesProfileId);
        }
        for (const portableActor of input.package.records.actors) {
          const mapped = actorIds.get(portableActor.sourceActorId)!;
          db.prepare(`INSERT INTO characters (id,name,age,archetype,boundaries,fictional_confirmed,is_real_person,created_at)
            VALUES (?,?,18,'Imported campaign actor','',1,0,?)`).run(mapped.characterId, portableActor.name, at);
          db.prepare(`INSERT INTO campaign_characters (id,campaign_id,character_id,created_at,updated_at)
            VALUES (?,?,?,?,?)`).run(mapped.campaignCharacterId, campaignId, mapped.characterId, at, at);
          db.prepare(`INSERT INTO rpg_campaign_sheets
            (id,campaign_id,campaign_character_id,race_pack_id,race_pack_version,race_kind,race_definition_id,
              background_pack_id,background_pack_version,background_kind,background_definition_id,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(mapped.sheetId, campaignId, mapped.campaignCharacterId,
              portableActor.race.packId, portableActor.race.packVersion, portableActor.race.kind, portableActor.race.definitionId,
              portableActor.background.packId, portableActor.background.packVersion, portableActor.background.kind,
              portableActor.background.definitionId, at, at);
          portableActor.classes.forEach((entry, position) => db.prepare(`INSERT INTO rpg_character_classes
            (campaign_id,sheet_id,position,pack_id,pack_version,kind,definition_id,level) VALUES (?,?,?,?,?,?,?,?)`)
            .run(campaignId, mapped.sheetId, position, entry.class.packId, entry.class.packVersion,
              entry.class.kind, entry.class.definitionId, entry.level));
          portableActor.attributes.forEach((attribute, position) => db.prepare(`INSERT INTO rpg_character_attributes
            (campaign_id,sheet_id,position,attribute_id,value) VALUES (?,?,?,?,?)`)
            .run(campaignId, mapped.sheetId, position, attribute.attributeId, attribute.value));
          db.prepare(`INSERT INTO campaign_actors
            (id,campaign_id,campaign_character_id,sheet_id,kind,control,created_at,updated_at)
            VALUES (?,?,?,?,'player-character','principal',?,?)`)
            .run(mapped.actorId, campaignId, mapped.campaignCharacterId, mapped.sheetId, at, at);
          db.prepare(`INSERT INTO campaign_actor_private_state
            (actor_id,campaign_id,controller_principal_id,private_notes) VALUES (?,?,?,NULL)`)
            .run(mapped.actorId, campaignId, actor);
          for (const resource of portableActor.resources) db.prepare(`INSERT INTO rpg_actor_resources
            (campaign_id,actor_id,name,current,max) VALUES (?,?,?,?,?)`)
            .run(campaignId, mapped.actorId, resource.name, resource.current, resource.max);
        }
        for (const t of input.package.timelines) for (const portableEvent of t.events) {
          const id = timelineIds.get(t.sourceId)!, mappedActor = actorIds.get(portableEvent.actorId)!;
          db.prepare(`INSERT INTO campaign_imported_timeline_events
            (campaign_id,timeline_id,revision,source_event_id,source_command_id,actor_id,source_turn_id,type,occurred_at,public_data)
            VALUES (?,?,?,?,?,?,?,?,?,?)`).run(campaignId, id, portableEvent.revision, portableEvent.sourceEventId,
              portableEvent.sourceCommandId, mappedActor.actorId, portableEvent.sourceTurnId,
              portableEvent.type, portableEvent.occurredAt, JSON.stringify(portableEvent.data));
        }
        const commandId = resourceIdSchema.parse(deps.ids.nextId()), eventId = resourceIdSchema.parse(deps.ids.nextId());
        const payload = JSON.stringify({ importId: dry.importId, packageHash: dry.packageHash });
        db.prepare(`INSERT INTO campaign_administration_commands
          (command_id,campaign_id,idempotency_key,actor_principal_id,expected_revision,type,payload,created_at)
          VALUES (?,?,?,?,?,'import_applied',?,?)`).run(commandId, campaignId, input.idempotencyKey, actor, sourceRevision, payload, at);
        for (const checkpoint of input.package.records.checkpoints) {
          const id = resourceIdSchema.parse(deps.ids.nextId());
          db.prepare(`INSERT INTO campaign_checkpoints (id,source_checkpoint_id,campaign_id,timeline_id,timeline_revision,label,created_at,command_id)
            VALUES (?,?,?,?,?,?,?,?)`).run(id, checkpoint.sourceId, campaignId, timelineIds.get(checkpoint.timelineSourceId), checkpoint.timelineRevision,
              checkpoint.label, checkpoint.createdAt, commandId);
          for (const state of checkpoint.state.attributes) db.prepare(`INSERT INTO campaign_checkpoint_attribute_snapshots
            (checkpoint_id,actor_id,attribute_id,value) VALUES (?,?,?,?)`)
            .run(id, actorIds.get(state.actorId)!.actorId, state.attributeId, state.value);
          for (const state of checkpoint.state.resources) db.prepare(`INSERT INTO campaign_checkpoint_resource_snapshots
            (checkpoint_id,actor_id,name,current,max) VALUES (?,?,?,?,?)`)
            .run(id, actorIds.get(state.actorId)!.actorId, state.name, state.current, state.max);
        }
        for (const r of input.package.records.recaps) db.prepare(`INSERT INTO campaign_recaps
          (id,source_recap_id,campaign_id,timeline_id,through_revision,selected_session_ids,visibility,text,created_at,command_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(resourceIdSchema.parse(deps.ids.nextId()), r.sourceId, campaignId, timelineIds.get(r.timelineSourceId),
            r.throughRevision, JSON.stringify(r.selectedSessionIds), r.visibility, r.text, r.createdAt, commandId);
        for (const membership of input.package.records.memberships) {
          if (membership.principalId !== actor && db.prepare("SELECT 1 FROM principals WHERE id=?").get(membership.principalId))
            db.prepare("INSERT OR IGNORE INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,?,?)")
              .run(campaignId, membership.principalId, membership.role, membership.createdAt);
        }
        for (const room of input.package.records.roomAttachments) {
          let lifecycle: "running" | "stopped" | null = null;
          try { lifecycle = validateRoom(room.sessionId); } catch { /* normalized below */ }
          if (lifecycle !== "running") throw new CampaignAdministrationConflictError("room is not attachable");
          if (db.prepare("SELECT 1 FROM campaign_sessions WHERE session_id=?").get(room.sessionId))
            throw new CampaignAdministrationConflictError("room attachment already exists");
          db.prepare("INSERT INTO campaign_sessions (campaign_id,session_id,attached_at) VALUES (?,?,?)")
            .run(campaignId, room.sessionId, room.attachedAt);
        }
        for (const event of input.package.records.administration.events) db.prepare(`INSERT INTO campaign_imported_administration_events
          (campaign_id,revision,source_event_id,source_command_id,type,occurred_at,public_data) VALUES (?,?,?,?,?,?,?)`)
          .run(campaignId, event.revision, event.eventId, event.commandId, event.type, event.occurredAt, JSON.stringify(event.data));
        for (const receipt of input.package.records.administration.receipts) db.prepare(`INSERT INTO campaign_imported_administration_receipts
          (campaign_id,source_command_id,type,revision_before,revision_after,occurred_at) VALUES (?,?,?,?,?,?)`)
          .run(campaignId, receipt.commandId, receipt.type, receipt.revisionBefore, receipt.revisionAfter, receipt.occurredAt);
        const importedCatalogEvent=[...input.package.records.administration.events]
          .filter((event)=>event.type==="catalog_configured").sort((left,right)=>right.revision-left.revision)[0];
        if(importedCatalogEvent && input.package.content.status==="configured"){
          const identifiers=[...input.package.content.contentPacks].sort((left,right)=>left.packId<right.packId?-1:left.packId>right.packId?1:0);
          const selectionDigest=createHash("sha256").update(JSON.stringify(canonicalizeJson({
            rulesProfileId:input.package.content.rulesProfileId,contentPacks:identifiers,
          }))).digest("hex");
          db.prepare(`INSERT INTO campaign_catalog_current_selections VALUES (?,?,?,?,?,?)`).run(campaignId,
            input.package.content.rulesProfileId,selectionDigest,actor,importedCatalogEvent.occurredAt,importedCatalogEvent.commandId);
          const insertImportedPin=db.prepare(`INSERT INTO campaign_catalog_current_pins VALUES (?,?,?,?,?)`);
          identifiers.forEach((pin,position)=>insertImportedPin.run(campaignId,pin.packId,pin.packVersion,position,importedCatalogEvent.commandId));
        }
        const after = sourceRevision + 1;
        db.prepare("UPDATE campaigns SET administration_revision=? WHERE id=?").run(after, campaignId);
        db.prepare(`INSERT INTO campaign_administration_events
          (event_id,campaign_id,command_id,revision_before,revision,type,public_data,private_data,occurred_at)
          VALUES (?,?,?,?,?,'import_applied',?,? ,?)`)
          .run(eventId, campaignId, commandId, sourceRevision, after, payload, payload, at);
        const imported = access.getCampaignAdministration(actor, campaignId)!;
        db.prepare(`INSERT INTO campaign_administration_receipts
          (command_id,campaign_id,event_id,type,revision_before,revision_after,result_data)
          VALUES (?,?,?,'import_applied',?,?,?)`)
          .run(commandId, campaignId, eventId, sourceRevision, after, JSON.stringify(imported));
        db.prepare("INSERT INTO campaign_imports VALUES (?,?,?,1,?,?)").run(dry.importId, campaignId, dry.packageHash, at, commandId);
        db.prepare(`INSERT INTO campaign_import_submissions
          (principal_id,idempotency_key,package_hash,campaign_id,command_id,created_at) VALUES (?,?,?,?,?,?)`)
          .run(actor, input.idempotencyKey, dry.packageHash, campaignId, commandId, at);
        const event = campaignAdministrationEventSchema.parse({ eventId, commandId, campaignId, type: "import_applied",
          revision: after, occurredAt: at, data: JSON.parse(payload) });
        return { value: imported, receipt: campaignAdministrationReceiptSchema.parse({ commandId, campaignId,
          type: "import_applied", revisionBefore: sourceRevision, revisionAfter: after, occurredAt: at, events: [event] }) };
      }).immediate();
      }
    },
    createCampaignExport: (actor, campaignId, raw) => {
      const input = createCampaignExportInputSchema.parse(raw);
      return commands.runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "export_created", {},
        ({ commandId, at, auth }) => {
          const c = db.prepare("SELECT name FROM campaigns WHERE id=?").get(campaignId) as any;
          const timelines = db.prepare(`SELECT t.id,COALESCE(h.source_timeline_id,t.id) source_id,t.revision,t.created_at,
              COALESCE(parent_history.source_timeline_id,h.parent_timeline_id) parent_source_id,h.forked_from_revision
            FROM campaign_timelines t JOIN campaign_timeline_history h ON h.campaign_id=t.campaign_id AND h.timeline_id=t.id
            LEFT JOIN campaign_timeline_history parent_history ON parent_history.campaign_id=h.campaign_id
              AND parent_history.timeline_id=h.parent_timeline_id
            WHERE t.campaign_id=? ORDER BY t.created_at,t.id`)
            .all(campaignId) as any[];
          const checkpoints = db.prepare("SELECT * FROM campaign_checkpoints WHERE campaign_id=? ORDER BY created_at,id").all(campaignId) as any[];
          const recaps = db.prepare("SELECT * FROM campaign_recaps WHERE campaign_id=? ORDER BY created_at,id").all(campaignId) as any[];
          const actors = db.prepare(`SELECT actor.id,actor.campaign_character_id,actor.sheet_id,character.name,
              sheet.race_pack_id,sheet.race_pack_version,sheet.race_kind,sheet.race_definition_id,
              sheet.background_pack_id,sheet.background_pack_version,sheet.background_kind,sheet.background_definition_id
            FROM campaign_actors actor JOIN campaign_characters cc ON cc.campaign_id=actor.campaign_id
              AND cc.id=actor.campaign_character_id JOIN characters character ON character.id=cc.character_id
            JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=actor.campaign_id AND sheet.id=actor.sheet_id
            WHERE actor.campaign_id=? ORDER BY actor.created_at,actor.id`).all(campaignId) as any[];
          const memberships = db.prepare(`SELECT principal_id,role,created_at FROM campaign_memberships
            WHERE campaign_id=? AND role<>'owner' ORDER BY created_at,principal_id`).all(campaignId) as any[];
          const rooms = db.prepare("SELECT session_id,attached_at FROM campaign_sessions WHERE campaign_id=? ORDER BY attached_at,session_id")
            .all(campaignId) as any[];
          const profile = db.prepare("SELECT rules_profile_id FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId) as any;
          const pins = profile ? db.prepare(`SELECT pack_id,pack_version FROM campaign_content_packs
            WHERE campaign_id=? ORDER BY pack_id`).all(campaignId) as any[] : [];
          const currentAdminEvents = (db.prepare(`SELECT event_id,command_id,type,revision,occurred_at,public_data
            FROM campaign_administration_events WHERE campaign_id=? AND revision<=? ORDER BY revision`)
            .all(campaignId, auth.revision) as any[]).map((event) => ({ eventId: event.event_id, commandId: event.command_id,
              type: event.type, revision: event.revision, occurredAt: event.occurred_at, data: JSON.parse(event.public_data) }));
          const importedAdminEvents = (db.prepare(`SELECT * FROM campaign_imported_administration_events
            WHERE campaign_id=? ORDER BY revision`).all(campaignId) as any[]).map((event) => ({ eventId: event.source_event_id,
              commandId: event.source_command_id, type: event.type, revision: event.revision,
              occurredAt: event.occurred_at, data: JSON.parse(event.public_data) }));
          const currentReceipts = (db.prepare(`SELECT command_id,type,revision_before,revision_after,
              (SELECT created_at FROM campaign_administration_commands command WHERE command.command_id=receipt.command_id) occurred_at
            FROM campaign_administration_receipts receipt WHERE campaign_id=? AND revision_after<=? ORDER BY revision_after`)
            .all(campaignId, auth.revision) as any[]).map((receipt) => ({ commandId: receipt.command_id, type: receipt.type,
              revisionBefore: receipt.revision_before, revisionAfter: receipt.revision_after, occurredAt: receipt.occurred_at }));
          const importedReceipts = (db.prepare(`SELECT source_command_id,type,revision_before,revision_after,occurred_at
            FROM campaign_imported_administration_receipts WHERE campaign_id=? ORDER BY revision_after`).all(campaignId) as any[])
            .map((receipt) => ({ commandId: receipt.source_command_id, type: receipt.type,
              revisionBefore: receipt.revision_before, revisionAfter: receipt.revision_after, occurredAt: receipt.occurred_at }));
          const catalogEvents = events.catalogAdministrationEvents(campaignId).map(({ campaignId: _campaignId,...event })=>event);
          const catalogReceipts = receipts.catalogAdministrationReceipts(campaignId);
          const allAdministrationEvents=[...importedAdminEvents,...currentAdminEvents,...catalogEvents]
            .sort((a,b)=>a.revision-b.revision);
          const allAdministrationReceipts=[...importedReceipts,...currentReceipts,...catalogReceipts]
            .sort((a,b)=>a.revisionAfter-b.revisionAfter);
          events.assertContiguousAdministrationHistory(allAdministrationEvents,auth.revision);
          const pkg = campaignTransferPackageSchema.parse({ formatVersion: CAMPAIGN_TRANSFER_FORMAT_VERSION, exportedAt: at,
            campaign: { name: c.name, status: auth.status, settings: auth.settings, administrationRevision: auth.revision },
            activeTimelineSourceId: timelines.find((timeline) => timeline.id === auth.activeTimelineId)!.source_id,
            timelines: timelines.map((t) => ({ sourceId: t.source_id, parentSourceId: t.parent_source_id,
              forkedFromRevision: t.forked_from_revision, revision: t.revision, createdAt: t.created_at,
              events: timelineTransferEvents(db, campaignId, t.id) })),
            content: profile ? { status: "configured", rulesProfileId: profile.rules_profile_id,
              contentPacks: pins.map((pin) => ({ packId: pin.pack_id, packVersion: pin.pack_version })) }
              : { status: "unconfigured" },
            records: { actors: actors.map((actor) => ({ sourceActorId: actor.id,
                sourceCampaignCharacterId: actor.campaign_character_id, sourceSheetId: actor.sheet_id, name: actor.name,
                race: { packId: actor.race_pack_id, packVersion: actor.race_pack_version,
                  kind: actor.race_kind, definitionId: actor.race_definition_id },
                background: { packId: actor.background_pack_id, packVersion: actor.background_pack_version,
                  kind: actor.background_kind, definitionId: actor.background_definition_id },
                classes: (db.prepare(`SELECT pack_id,pack_version,kind,definition_id,level FROM rpg_character_classes
                  WHERE campaign_id=? AND sheet_id=? ORDER BY position`).all(campaignId, actor.sheet_id) as any[]).map((row) => ({
                    class: { packId: row.pack_id, packVersion: row.pack_version, kind: row.kind, definitionId: row.definition_id }, level: row.level })),
                attributes: (db.prepare(`SELECT attribute_id,value FROM rpg_character_attributes
                  WHERE campaign_id=? AND sheet_id=? ORDER BY position`).all(campaignId, actor.sheet_id) as any[]).map((row) => ({
                    attributeId: row.attribute_id, value: row.value })),
                resources: (db.prepare(`SELECT name,current,max FROM rpg_actor_resources
                  WHERE campaign_id=? AND actor_id=? ORDER BY name`).all(campaignId, actor.id) as any[]),
              })), checkpoints: checkpoints.map((checkpointRow) => ({ sourceId: checkpointRow.source_checkpoint_id ?? checkpointRow.id,
                timelineSourceId: timelines.find((timeline) => timeline.id === checkpointRow.timeline_id)!.source_id,
                timelineRevision: checkpointRow.timeline_revision,
                label: checkpointRow.label, createdAt: checkpointRow.created_at,
                state: { attributes: (db.prepare(`SELECT actor_id,attribute_id,value FROM campaign_checkpoint_attribute_snapshots
                    WHERE checkpoint_id=? ORDER BY actor_id,attribute_id`).all(checkpointRow.id) as any[]).map((row) => ({
                      actorId: row.actor_id, attributeId: row.attribute_id, value: row.value })),
                  resources: (db.prepare(`SELECT actor_id,name,current,max FROM campaign_checkpoint_resource_snapshots
                    WHERE checkpoint_id=? ORDER BY actor_id,name`).all(checkpointRow.id) as any[]).map((row) => ({
                      actorId: row.actor_id, name: row.name, current: row.current, max: row.max })) } })),
              recaps: recaps.map((r) => ({ sourceId: r.source_recap_id ?? r.id,
                timelineSourceId: timelines.find((timeline) => timeline.id === r.timeline_id)!.source_id,
                throughRevision: r.through_revision,
                selectedSessionIds: JSON.parse(r.selected_session_ids), visibility: r.visibility, text: r.text, createdAt: r.created_at })),
              memberships: memberships.map((membership) => ({ principalId: membership.principal_id, role: membership.role,
                createdAt: membership.created_at })),
              roomAttachments: rooms.map((room) => ({ sessionId: room.session_id, attachedAt: room.attached_at })),
              administration: { events: allAdministrationEvents, receipts: allAdministrationReceipts } },
            excluded: ["credentials", "localPaths", "usageHistory", "privateActorState"] });
          const id = resourceIdSchema.parse(deps.ids.nextId());
          const count = pkg.timelines.length + pkg.timelines.reduce((sum, t) => sum + t.events.length, 0)
            + pkg.records.actors.reduce((sum, actor) => sum + 6 + actor.classes.length + actor.attributes.length + actor.resources.length, 0)
            + pkg.records.checkpoints.length + pkg.records.recaps.length + pkg.records.memberships.length
            + pkg.records.checkpoints.reduce((sum, checkpoint) => sum + checkpoint.state.attributes.length
              + checkpoint.state.resources.length, 0)
            + pkg.records.roomAttachments.length + pkg.records.administration.events.length
            + pkg.records.administration.receipts.length
            + (pkg.content.status === "configured" ? 1 + pkg.content.contentPacks.length : 0);
          db.prepare(`INSERT INTO campaign_export_manifests
            (id,campaign_id,format_version,record_count,excluded,package_json,created_at,command_id) VALUES (?,?,1,?,?,?,?,?)`)
            .run(id, campaignId, count, JSON.stringify(pkg.excluded), JSON.stringify(pkg), at, commandId);
          return { manifest: campaignExportManifestSchema.parse({ id, campaignId, formatVersion: 1, recordCount: count,
            excluded: pkg.excluded, createdAt: at }), package: pkg };
        }, (_commandId, stored) => {
          const value = stored as { manifest?: unknown; package?: unknown };
          return { manifest: campaignExportManifestSchema.parse(value.manifest), package: campaignTransferPackageSchema.parse(value.package) };
        });
    },
    listCampaignAdministrationEvents: events.listCampaignAdministrationEvents,
    getCampaignAdministrationReceipt: receipts.getCampaignAdministrationReceipt,
  };
  return api;
}

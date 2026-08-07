// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  MAX_CAMPAIGN_IMPORT_BYTES, MAX_CAMPAIGN_IMPORT_RECORDS,
  campaignImportDryRunSchema, campaignTransferPackageSchema, resourceIdSchema,
  type CampaignImportDryRun, type CampaignTransferPackage,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "../campaign/campaignTypes.js";
import type { AdministrationAuthority } from "./administrationAccessRepo.js";
import { forbidden, serializeForImport } from "./administrationImportHelpers.js";

/** Dependencies retained by campaign import operations as they are extracted. */
export interface AdministrationImportRepoDependencies {
  db: DatabaseDriver.Database;
  deps: RepositoryDependencies;
  validateRoom: (sessionId: string) => "running" | "stopped" | null;
  /** Campaign authority lookup shared with the administration facade. */
  getAuthority: (actor: string, campaignId: string) => AdministrationAuthority | null;
  /** Produces the facade's public authorization error. */
  forbidden: () => Error;
}

/**
 * Creates campaign-transfer import operations.
 *
 * The dependencies include the shared authority lookup and mutation dependencies so
 * apply/import operations can remain colocated without rebuilding facade state.
 */
export function createAdministrationImportRepo({ db, validateRoom, forbidden: forbiddenError }: AdministrationImportRepoDependencies) {
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
    return campaignImportDryRunSchema.parse({ importId: `import-${serialized.hash.slice(0, 32)}`, packageHash: serialized.hash, report: { valid: conflicts.length === 0 && missingReferences.length === 0, conflicts, missingReferences, warnings, counts: { timelines: pkg?.timelines.length ?? 0, events: pkg?.timelines.reduce((sum, timeline) => sum + timeline.events.length, 0) ?? 0, actors: pkg?.records.actors.length ?? 0, checkpoints: pkg?.records.checkpoints.length ?? 0, recaps: pkg?.records.recaps.length ?? 0, memberships: pkg?.records.memberships.length ?? 0, roomAttachments: pkg?.records.roomAttachments.length ?? 0 } } });
  };
  return { dryRunCampaignImport };
}

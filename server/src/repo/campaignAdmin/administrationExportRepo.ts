import type DatabaseDriver from "better-sqlite3";
import {
  CAMPAIGN_TRANSFER_FORMAT_VERSION, campaignExportManifestSchema, campaignTransferHttpExportDocumentSchema,
  campaignTransferPackageSchema, MAX_CAMPAIGN_IMPORT_BYTES, MAX_CAMPAIGN_IMPORT_RECORDS,
  createCampaignExportInputSchema, resourceIdSchema, utcIsoTimestampSchema,
  type CampaignAdministrationReceipt, type CampaignExportManifest, type CampaignTransferPackage,
  type CampaignTransferHttpExportDocument, type CreateCampaignExportInput,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "../campaign/campaignTypes.js";
import type { AdministrationAuthority } from "./administrationAccessRepo.js";
import type { createAdministrationEventRepo } from "./administrationEventRepo.js";
import type { createAdministrationReceiptRepo } from "./administrationReceiptRepo.js";
import { timelineTransferEvents } from "./administrationImportHelpers.js";

type MutationResult<T> = { value: T; receipt: CampaignAdministrationReceipt };

interface MutationContext {
  commandId: string;
  at: string;
  auth: AdministrationAuthority;
}

type HistoryReaders = AdministrationExportRepoDependencies["events"];
type ReceiptReaders = AdministrationExportRepoDependencies["receipts"];

/** Counts the same importable records used by the persisted export manifest. */
export function countCampaignTransferPackageRecords(pkg: CampaignTransferPackage): number {
  return pkg.timelines.length + pkg.timelines.reduce((sum, timeline) => sum + timeline.events.length, 0)
    + pkg.records.actors.reduce((sum, actor) => sum + 6 + actor.classes.length + actor.attributes.length + actor.resources.length, 0)
    + pkg.records.checkpoints.length + pkg.records.recaps.length + pkg.records.memberships.length
    + pkg.records.checkpoints.reduce((sum, checkpoint) => sum + checkpoint.state.attributes.length + checkpoint.state.resources.length, 0)
    + pkg.records.roomAttachments.length + pkg.records.administration.events.length + pkg.records.administration.receipts.length
    + (pkg.content.status === "configured" ? 1 + pkg.content.contentPacks.length : 0);
}

/** Builds the portable v1 package from the caller's current SQLite snapshot. */
export function buildCampaignTransferPackage(db: DatabaseDriver.Database, campaignId: string, exportedAt: string,
  auth: AdministrationAuthority, events: HistoryReaders, receipts: ReceiptReaders): CampaignTransferPackage {
  const c = db.prepare("SELECT name FROM campaigns WHERE id=?").get(campaignId) as any;
  const timelines = db.prepare(`SELECT t.id,COALESCE(h.source_timeline_id,t.id) source_id,t.revision,t.created_at,
      COALESCE(parent_history.source_timeline_id,h.parent_timeline_id) parent_source_id,h.forked_from_revision
    FROM campaign_timelines t JOIN campaign_timeline_history h ON h.campaign_id=t.campaign_id AND h.timeline_id=t.id
    LEFT JOIN campaign_timeline_history parent_history ON parent_history.campaign_id=h.campaign_id
      AND parent_history.timeline_id=h.parent_timeline_id
    WHERE t.campaign_id=? ORDER BY t.created_at,t.id`).all(campaignId) as any[];
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
  const rooms = db.prepare("SELECT session_id,attached_at FROM campaign_sessions WHERE campaign_id=? ORDER BY attached_at,session_id").all(campaignId) as any[];
  const profile = db.prepare("SELECT rules_profile_id FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId) as any;
  const pins = profile ? db.prepare(`SELECT pack_id,pack_version FROM campaign_content_packs
    WHERE campaign_id=? ORDER BY pack_id`).all(campaignId) as any[] : [];
  const currentAdminEvents = (db.prepare(`SELECT event_id,command_id,type,revision,occurred_at,public_data
    FROM campaign_administration_events WHERE campaign_id=? AND revision<=? ORDER BY revision`).all(campaignId, auth.revision) as any[])
    .map((event) => ({ eventId: event.event_id, commandId: event.command_id, type: event.type, revision: event.revision,
      occurredAt: event.occurred_at, data: JSON.parse(event.public_data) }));
  const importedAdminEvents = (db.prepare(`SELECT source_event_id,source_command_id,type,revision,occurred_at,public_data
    FROM campaign_imported_administration_events WHERE campaign_id=? ORDER BY revision`).all(campaignId) as any[])
    .map((event) => ({ eventId: event.source_event_id, commandId: event.source_command_id, type: event.type,
      revision: event.revision, occurredAt: event.occurred_at, data: JSON.parse(event.public_data) }));
  const currentReceipts = (db.prepare(`SELECT command_id,type,revision_before,revision_after,
      (SELECT created_at FROM campaign_administration_commands command WHERE command.command_id=receipt.command_id) occurred_at
    FROM campaign_administration_receipts receipt WHERE campaign_id=? AND revision_after<=? ORDER BY revision_after`)
    .all(campaignId, auth.revision) as any[]).map((receipt) => ({ commandId: receipt.command_id, type: receipt.type,
      revisionBefore: receipt.revision_before, revisionAfter: receipt.revision_after, occurredAt: receipt.occurred_at }));
  const importedReceipts = (db.prepare(`SELECT source_command_id,type,revision_before,revision_after,occurred_at
    FROM campaign_imported_administration_receipts WHERE campaign_id=? ORDER BY revision_after`).all(campaignId) as any[])
    .map((receipt) => ({ commandId: receipt.source_command_id, type: receipt.type, revisionBefore: receipt.revision_before,
      revisionAfter: receipt.revision_after, occurredAt: receipt.occurred_at }));
  const catalogEvents = events.catalogAdministrationEvents(campaignId).map(({ campaignId: _campaignId, ...event }) => event);
  const catalogReceipts = receipts.catalogAdministrationReceipts(campaignId);
  const allAdministrationEvents = [...importedAdminEvents, ...currentAdminEvents, ...catalogEvents].sort((a, b) => a.revision - b.revision);
  const allAdministrationReceipts = [...importedReceipts, ...currentReceipts, ...catalogReceipts].sort((a, b) => a.revisionAfter - b.revisionAfter);
  events.assertContiguousAdministrationHistory(allAdministrationEvents, auth.revision);
  return campaignTransferPackageSchema.parse({ formatVersion: CAMPAIGN_TRANSFER_FORMAT_VERSION, exportedAt,
    campaign: { name: c.name, status: auth.status, settings: auth.settings, administrationRevision: auth.revision },
    activeTimelineSourceId: timelines.find((timeline) => timeline.id === auth.activeTimelineId)!.source_id,
    timelines: timelines.map((timeline) => ({ sourceId: timeline.source_id, parentSourceId: timeline.parent_source_id,
      forkedFromRevision: timeline.forked_from_revision, revision: timeline.revision, createdAt: timeline.created_at,
      events: timelineTransferEvents(db, campaignId, timeline.id) })),
    content: profile ? { status: "configured", rulesProfileId: profile.rules_profile_id,
      contentPacks: pins.map((pin) => ({ packId: pin.pack_id, packVersion: pin.pack_version })) } : { status: "unconfigured" },
    records: { actors: actors.map((actor) => ({ sourceActorId: actor.id, sourceCampaignCharacterId: actor.campaign_character_id,
      sourceSheetId: actor.sheet_id, name: actor.name,
      race: { packId: actor.race_pack_id, packVersion: actor.race_pack_version, kind: actor.race_kind, definitionId: actor.race_definition_id },
      background: { packId: actor.background_pack_id, packVersion: actor.background_pack_version, kind: actor.background_kind, definitionId: actor.background_definition_id },
      classes: (db.prepare(`SELECT pack_id,pack_version,kind,definition_id,level FROM rpg_character_classes WHERE campaign_id=? AND sheet_id=? ORDER BY position`).all(campaignId, actor.sheet_id) as any[]).map((row) => ({ class: { packId: row.pack_id, packVersion: row.pack_version, kind: row.kind, definitionId: row.definition_id }, level: row.level })),
      attributes: (db.prepare(`SELECT attribute_id,value FROM rpg_character_attributes WHERE campaign_id=? AND sheet_id=? ORDER BY position`).all(campaignId, actor.sheet_id) as any[]).map((row) => ({ attributeId: row.attribute_id, value: row.value })),
      resources: db.prepare(`SELECT name,current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? ORDER BY name`).all(campaignId, actor.id) as any[],
    })), checkpoints: checkpoints.map((checkpoint) => ({ sourceId: checkpoint.source_checkpoint_id ?? checkpoint.id,
      timelineSourceId: timelines.find((timeline) => timeline.id === checkpoint.timeline_id)!.source_id,
      timelineRevision: checkpoint.timeline_revision, label: checkpoint.label, createdAt: checkpoint.created_at,
      state: { attributes: (db.prepare(`SELECT actor_id,attribute_id,value FROM campaign_checkpoint_attribute_snapshots WHERE checkpoint_id=? ORDER BY actor_id,attribute_id`).all(checkpoint.id) as any[]).map((row) => ({ actorId: row.actor_id, attributeId: row.attribute_id, value: row.value })), resources: (db.prepare(`SELECT actor_id,name,current,max FROM campaign_checkpoint_resource_snapshots WHERE checkpoint_id=? ORDER BY actor_id,name`).all(checkpoint.id) as any[]).map((row) => ({ actorId: row.actor_id, name: row.name, current: row.current, max: row.max })) } })),
      recaps: recaps.map((recap) => ({ sourceId: recap.source_recap_id ?? recap.id,
        timelineSourceId: timelines.find((timeline) => timeline.id === recap.timeline_id)!.source_id,
        throughRevision: recap.through_revision, selectedSessionIds: JSON.parse(recap.selected_session_ids),
        visibility: recap.visibility, text: recap.text, createdAt: recap.created_at })),
      memberships: memberships.map((membership) => ({ principalId: membership.principal_id, role: membership.role,
        createdAt: membership.created_at })), roomAttachments: rooms.map((room) => ({ sessionId: room.session_id,
        attachedAt: room.attached_at })), administration: { events: allAdministrationEvents, receipts: allAdministrationReceipts } },
    excluded: ["credentials", "localPaths", "usageHistory", "privateActorState"] });
}

/** Dependencies used to construct campaign-transfer export operations. */
export interface AdministrationExportRepoDependencies {
  db: DatabaseDriver.Database;
  deps: RepositoryDependencies;
  /** Runs the export as the administration command that creates its manifest. */
  runMutation: <T>(actor: string, campaignId: string, expectedRevision: number, key: string,
    type: CampaignAdministrationReceipt["type"], payload: object,
    apply: (context: MutationContext) => T,
    retry: (commandId: string, stored: unknown) => T) => MutationResult<T>;
  events: Pick<ReturnType<typeof createAdministrationEventRepo>,
    "catalogAdministrationEvents" | "assertContiguousAdministrationHistory">;
  receipts: Pick<ReturnType<typeof createAdministrationReceiptRepo>, "catalogAdministrationReceipts">;
  getAuthority: (actor: string, campaignId: string) => AdministrationAuthority | null;
  forbidden: () => Error;
}

export class CampaignExportLimitError extends Error {
  readonly code = "CAMPAIGN_EXPORT_LIMIT_EXCEEDED";
  constructor() { super("campaign export exceeds a transfer limit"); this.name = "CampaignExportLimitError"; }
}

export interface CampaignExportReadResult {
  document: CampaignTransferHttpExportDocument;
  campaignId: string;
  administrationRevision: number;
  recordCount: number;
  byteLength: number;
}

/**
 * Creates owner-authorized campaign transfer exports.
 *
 * The package is built inside the export command so its manifest, package, event,
 * receipt, and revision are committed atomically.
 */
export function createAdministrationExportRepo({ db, deps, runMutation, events,
  receipts, getAuthority, forbidden }: AdministrationExportRepoDependencies) {
  const createCampaignExport = (actor: string, campaignId: string, raw: CreateCampaignExportInput): MutationResult<{
    manifest: CampaignExportManifest; package: CampaignTransferPackage;
  }> => {
    const input = createCampaignExportInputSchema.parse(raw);
    return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "export_created", {},
      ({ commandId, at, auth }) => {
        const pkg = buildCampaignTransferPackage(db, campaignId, at, auth, events, receipts);
        const id = resourceIdSchema.parse(deps.ids.nextId());
        const count = countCampaignTransferPackageRecords(pkg);
        db.prepare(`INSERT INTO campaign_export_manifests (id,campaign_id,format_version,record_count,excluded,package_json,created_at,command_id) VALUES (?,?,1,?,?,?,?,?)`).run(id, campaignId, count, JSON.stringify(pkg.excluded), JSON.stringify(pkg), at, commandId);
        return { manifest: campaignExportManifestSchema.parse({ id, campaignId, formatVersion: 1, recordCount: count, excluded: pkg.excluded, createdAt: at }), package: pkg };
      }, (_commandId, stored) => {
        const value = stored as { manifest?: unknown; package?: unknown };
        return { manifest: campaignExportManifestSchema.parse(value.manifest), package: campaignTransferPackageSchema.parse(value.package) };
      });
  };
  const readCampaignExport = (actorRaw: string, campaignRaw: string,
    rawOptions: { includeMessages: boolean }): CampaignExportReadResult => {
    const actor = resourceIdSchema.parse(actorRaw);
    const campaignId = resourceIdSchema.parse(campaignRaw);
    if (rawOptions === null || typeof rawOptions !== "object"
      || Object.keys(rawOptions).length !== 1 || typeof rawOptions.includeMessages !== "boolean") {
      throw new TypeError("invalid campaign export options");
    }
    const options = rawOptions;
    return db.transaction(() => {
      const auth = getAuthority(actor, campaignId);
      if (!auth || auth.role !== "owner" || auth.ownerId !== actor) throw forbidden();
      const exportedAt = utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
      const pkg = buildCampaignTransferPackage(db, campaignId, exportedAt, auth, events, receipts);
      const archiveRooms = options.includeMessages ? (db.prepare(`SELECT cs.session_id,s.active_leaf_id,
          m.id,m.role,m.speaker_character_id,m.content,m.parent_id,m.swipe_group_id,m.swipe_index,m.seq,m.status,m.created_at
        FROM campaign_sessions cs JOIN sessions s ON s.id=cs.session_id
        LEFT JOIN messages m ON m.session_id=s.id
        WHERE cs.campaign_id=?
        ORDER BY cs.attached_at,cs.session_id,m.seq,m.created_at,m.rowid`).all(campaignId) as any[]) : [];
      const rooms: Array<{ sessionId: string; activeLeafId: string | null; messages: any[] }> = [];
      for (const row of archiveRooms) {
        let room = rooms.at(-1);
        if (!room || room.sessionId !== row.session_id) {
          room = { sessionId: row.session_id, activeLeafId: row.active_leaf_id, messages: [] };
          rooms.push(room);
        }
        if (row.id !== null) room.messages.push({ id: row.id, role: row.role,
          speakerCharacterId: row.speaker_character_id, content: row.content, parentId: row.parent_id,
          swipeGroupId: row.swipe_group_id, swipeIndex: row.swipe_index, sequence: row.seq,
          status: row.status, createdAt: row.created_at });
      }
      const rawDocument = { package: pkg,
        messages: options.includeMessages ? { included: true as const, rooms } : { included: false as const } };
      // Check evidence before structural parsing so an oversized persisted archive
      // always receives the typed limit failure rather than an incidental schema error.
      const recordCount = countCampaignTransferPackageRecords(pkg)
        + (options.includeMessages ? rooms.reduce((count, room) => count + 1 + room.messages.length, 0) : 0);
      const byteLength = Buffer.byteLength(JSON.stringify(rawDocument), "utf8");
      if (recordCount > MAX_CAMPAIGN_IMPORT_RECORDS || byteLength > MAX_CAMPAIGN_IMPORT_BYTES) {
        throw new CampaignExportLimitError();
      }
      const document = campaignTransferHttpExportDocumentSchema.parse(rawDocument);
      return { document, campaignId, administrationRevision: auth.revision, recordCount, byteLength };
    }).deferred();
  };
  return { createCampaignExport, readCampaignExport };
}

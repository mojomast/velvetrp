import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  CAMPAIGN_TRANSFER_FORMAT_VERSION, MAX_CAMPAIGN_IMPORT_BYTES, MAX_CAMPAIGN_IMPORT_RECORDS,
  applyCampaignImportInputSchema, campaignAdministrationEventSchema, campaignAdministrationPatchSchema,
  campaignAdministrationReceiptSchema,
  campaignAdministrationSchema, campaignCheckpointSchema, campaignExportManifestSchema, campaignNameSchema,
  campaignImportDryRunSchema, campaignMembershipMutationSchema, campaignMembershipReadSchema, campaignMembershipSchema,
  campaignMembershipRoleMutationSchema, campaignRecapSchema, campaignRevisionMutationSchema,
  campaignRoomMutationSchema, campaignSessionAttachmentSchema, campaignSettingsSchema,
  campaignTimelineHistorySchema, campaignTransferPackageSchema, createCampaignCheckpointInputSchema,
  createCampaignExportInputSchema, createCampaignRecapInputSchema, forkCampaignTimelineInputSchema,
  resourceIdSchema, utcIsoTimestampSchema,
  type ApplyCampaignImportInput, type CampaignAdministration, type CampaignAdministrationEvent,
  type CampaignAdministrationPatch,
  type CampaignAdministrationReceipt, type CampaignCheckpoint, type CampaignExportManifest,
  type CampaignImportDryRun, type CampaignMembershipMutation, type CampaignMembershipRead,
  type CampaignMembership,
  type CampaignMembershipRoleMutation, type CampaignRecap, type CampaignRevisionMutation,
  type CampaignRoomMutation, type CampaignSessionAttachment, type CampaignSettings,
  type CampaignTimelineHistory, type CampaignTransferPackage, type CreateCampaignCheckpointInput,
  type CreateCampaignExportInput, type CreateCampaignRecapInput, type ForkCampaignTimelineInput,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaignRepo.js";

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

type Role = "owner" | "gm" | "player" | "observer";
interface Authority { role: Role; ownerId: string; revision: number; status: string; settings: CampaignSettings;
  activeTimelineId: string; updatedAt: string; }
function getAuthority(db: DatabaseDriver.Database, actor: string, campaignId: string): Authority | null {
  const row = db.prepare(`SELECT m.role,c.owner_principal_id,c.administration_revision,c.lifecycle_status,
      c.settings,c.active_timeline_id,c.updated_at FROM campaigns c JOIN campaign_memberships m ON m.campaign_id=c.id
      JOIN principals p ON p.id=m.principal_id WHERE c.id=? AND m.principal_id=?`).get(campaignId, actor) as any;
  if (!row || !["owner", "gm", "player", "observer"].includes(row.role)) return null;
  if (row.role === "owner" && row.owner_principal_id !== actor) return null;
  return { role: row.role, ownerId: resourceIdSchema.parse(row.owner_principal_id), revision: row.administration_revision,
    status: row.lifecycle_status, settings: campaignSettingsSchema.parse(JSON.parse(row.settings)),
    activeTimelineId: resourceIdSchema.parse(row.active_timeline_id), updatedAt: utcIsoTimestampSchema.parse(row.updated_at) };
}
function project(campaignId: string, auth: Authority): CampaignAdministration {
  const settings = auth.role === "owner" || auth.role === "gm" ? auth.settings : {
    maxPlayers: auth.settings.maxPlayers, allowPlayerDice: auth.settings.allowPlayerDice,
    safetyMode: auth.settings.safetyMode, recapVisibility: auth.settings.recapVisibility,
  };
  return campaignAdministrationSchema.parse({ id: campaignId, status: auth.status, settings,
    activeTimelineId: auth.activeTimelineId, revision: auth.revision, updatedAt: auth.updatedAt, actorRole: auth.role });
}
const transitions: Record<string, readonly string[]> = { draft: ["published", "archived"],
  published: ["paused", "completed", "archived"], paused: ["published", "completed", "archived"],
  completed: ["archived"], archived: [] };
interface NewContext { commandId: string; eventId: string; at: string; auth: Authority }

function mutation<T>(db: DatabaseDriver.Database, deps: RepositoryDependencies, actorRaw: string, campaignRaw: string,
  expectedRevision: number, keyRaw: string, type: CampaignAdministrationReceipt["type"], payload: object,
  apply: (context: NewContext) => T, retry: (commandId: string, stored: unknown) => T): MutationResult<T> {
  const actor = resourceIdSchema.parse(actorRaw), campaignId = resourceIdSchema.parse(campaignRaw);
  const key = resourceIdSchema.parse(keyRaw), payloadJson = JSON.stringify(payload);
  const normalizedPayload = JSON.parse(payloadJson) as object;
  return db.transaction(() => {
    const auth = getAuthority(db, actor, campaignId);
    if (!auth || auth.role !== "owner" || auth.ownerId !== actor) throw new CampaignAdministrationForbiddenError();
    const old = db.prepare(`SELECT c.command_id,c.type,c.expected_revision,c.payload,c.created_at,
      r.revision_before,r.revision_after,r.result_data FROM campaign_administration_commands c
      LEFT JOIN campaign_administration_receipts r ON r.command_id=c.command_id
      WHERE c.campaign_id=? AND c.idempotency_key=?`).get(campaignId, key) as any;
    if (old) {
      if (old.type !== type || old.expected_revision !== expectedRevision || old.payload !== payloadJson
        || old.revision_before === null) throw new CampaignAdministrationConflictError("idempotency identity collision");
      const eventRow = db.prepare("SELECT event_id,public_data,occurred_at FROM campaign_administration_events WHERE command_id=?")
        .get(old.command_id) as any;
      const event = campaignAdministrationEventSchema.parse({ eventId: eventRow.event_id, commandId: old.command_id,
        campaignId, type, revision: old.revision_after, occurredAt: eventRow.occurred_at,
        data: JSON.parse(eventRow.public_data) });
      return { value: retry(old.command_id, JSON.parse(old.result_data)), receipt: campaignAdministrationReceiptSchema.parse({
        commandId: old.command_id, campaignId, type, revisionBefore: old.revision_before,
        revisionAfter: old.revision_after, occurredAt: old.created_at, events: [event] }) };
    }
    if (db.prepare(`SELECT 1 FROM campaign_catalog_commands WHERE campaign_id=? AND idempotency_key=?`).get(campaignId,key)) {
      throw new CampaignAdministrationConflictError("idempotency identity collision");
    }
    if (auth.revision !== expectedRevision) throw new CampaignAdministrationStaleError();
    const commandId = resourceIdSchema.parse(deps.ids.nextId()), eventId = resourceIdSchema.parse(deps.ids.nextId());
    const clockAt = utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
    const at = utcIsoTimestampSchema.parse(new Date(Math.max(Date.parse(clockAt), Date.parse(auth.updatedAt) + 1)).toISOString());
    db.prepare(`INSERT INTO campaign_administration_commands
      (command_id,campaign_id,idempotency_key,actor_principal_id,expected_revision,type,payload,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(commandId, campaignId, key, actor, expectedRevision, type, payloadJson, at);
    const value = apply({ commandId, eventId, at, auth });
    const next = expectedRevision + 1;
    const changed = db.prepare("UPDATE campaigns SET administration_revision=?,updated_at=? WHERE id=? AND administration_revision=?")
      .run(next, at, campaignId, expectedRevision);
    if (changed.changes !== 1) throw new CampaignAdministrationStaleError();
    db.prepare(`INSERT INTO campaign_administration_events
      (event_id,campaign_id,command_id,revision_before,revision,type,public_data,private_data,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(eventId, campaignId, commandId, expectedRevision, next, type,
        JSON.stringify(publicAdministrationPayload(type, normalizedPayload)), payloadJson, at);
    db.prepare(`INSERT INTO campaign_administration_receipts
      (command_id,campaign_id,event_id,type,revision_before,revision_after,result_data) VALUES (?,?,?,?,?,?,?)`)
      .run(commandId, campaignId, eventId, type, expectedRevision, next, JSON.stringify(value));
    const event = campaignAdministrationEventSchema.parse({ eventId, commandId, campaignId, type, revision: next,
      occurredAt: at, data: publicAdministrationPayload(type, normalizedPayload) });
    return { value, receipt: campaignAdministrationReceiptSchema.parse({ commandId, campaignId,
      type, revisionBefore: expectedRevision, revisionAfter: next, occurredAt: at, events: [event] }) };
  }).immediate();
}
const packageHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function forbidden(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some((entry) => forbidden(entry, depth + 1));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /api.?key|credential|password|access.?token|local.?path|usage|price/i.test(key)
    || forbidden(child, depth + 1));
}
function publicAdministrationPayload(type: CampaignAdministrationReceipt["type"], payload: object): object {
  const value = payload as Record<string, unknown>;
  if (type === "administration_updated" && value.settings && typeof value.settings === "object") {
    const { gmNotes: _privateNotes, ...publicSettings } = value.settings as Record<string, unknown>;
    return { ...value, settings: publicSettings };
  }
  if (type === "recap_created") {
    const { text: _privateText, ...metadata } = value;
    return metadata;
  }
  return payload;
}

function canonicalizeJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint" || typeof value === "undefined" || typeof value === "function" || typeof value === "symbol")
      throw new TypeError("unsupported JSON value");
    return value;
  }
  if (seen.has(value)) throw new TypeError("cyclic JSON value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry, seen));
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalizeJson((value as Record<string, unknown>)[key], seen);
    return output;
  } finally { seen.delete(value); }
}

function serializeForImport(value: unknown): { json: string | null; hash: string } {
  try {
    const json = JSON.stringify(canonicalizeJson(value));
    if (json === undefined) return { json: null, hash: createHash("sha256").update("invalid:undefined").digest("hex") };
    return { json, hash: createHash("sha256").update(json).digest("hex") };
  } catch {
    return { json: null, hash: createHash("sha256").update("invalid:unserializable").digest("hex") };
  }
}

function transferEventData(db: DatabaseDriver.Database, event: any): Record<string, unknown> {
  if (event.type === "actor_attribute_set") return { attributeId: event.attribute_id,
    valueBefore: event.value_before, valueAfter: event.value_after };
  if (event.type === "actor_resource_initialized") return { name: event.resource_name,
    current: event.resource_current, max: event.resource_max };
  const roll = db.prepare("SELECT * FROM rpg_dice_rolls WHERE event_id=?").get(event.event_id) as any;
  const terms = db.prepare("SELECT value,kept FROM rpg_dice_terms WHERE event_id=? ORDER BY position").all(event.event_id) as any[];
  if (!roll) throw new Error("dice event has no normalized roll");
  const selection = roll.selection_type === "keep_highest" || roll.selection_type === "keep_lowest"
    ? { type: roll.selection_type, count: roll.selection_count } : { type: roll.selection_type };
  return { expression: roll.expression, normalized: { count: roll.dice_count, sides: roll.dice_sides,
    selection, modifier: roll.modifier }, terms: terms.map((term) => ({ value: term.value, kept: term.kept === 1 })),
    modifier: roll.modifier, total: roll.total };
}

function timelineTransferEvents(db: DatabaseDriver.Database, campaignId: string, timelineId: string): any[] {
  const native = (db.prepare(`SELECT link.revision,event.* FROM campaign_timeline_events link
    JOIN campaign_events event ON event.event_id=link.event_id WHERE link.campaign_id=? AND link.timeline_id=?
    ORDER BY link.revision`).all(campaignId, timelineId) as any[]).map((event) => ({ sourceEventId: event.event_id,
      sourceCommandId: event.command_id, actorId: event.actor_id, sourceTurnId: event.source_turn_id,
      revision: event.revision, type: event.type, occurredAt: event.occurred_at, data: transferEventData(db, event) }));
  const imported = (db.prepare(`SELECT * FROM campaign_imported_timeline_events WHERE campaign_id=? AND timeline_id=?
    ORDER BY revision`).all(campaignId, timelineId) as any[]).map((event) => ({ sourceEventId: event.source_event_id,
      sourceCommandId: event.source_command_id, actorId: event.actor_id, sourceTurnId: event.source_turn_id,
      revision: event.revision, type: event.type, occurredAt: event.occurred_at, data: JSON.parse(event.public_data) }));
  return [...native, ...imported].sort((left, right) => left.revision - right.revision);
}

function catalogAdministrationEvents(db: DatabaseDriver.Database, campaignId: string): CampaignAdministrationEvent[] {
  return (db.prepare(`SELECT event_id,command_id,revision,occurred_at,public_data FROM campaign_catalog_events
    WHERE campaign_id=? ORDER BY revision`).all(campaignId) as any[]).map((row) => campaignAdministrationEventSchema.parse({
      eventId: row.event_id, commandId: row.command_id, campaignId, type: "catalog_configured",
      revision: row.revision, occurredAt: row.occurred_at, data: JSON.parse(row.public_data),
    }));
}

function catalogAdministrationReceipts(db: DatabaseDriver.Database, campaignId: string): Array<{
  commandId: string; type: "catalog_configured"; revisionBefore: number; revisionAfter: number; occurredAt: string;
}> {
  return (db.prepare(`SELECT receipt.command_id,receipt.revision_before,receipt.revision_after,event.occurred_at
    FROM campaign_catalog_receipts receipt JOIN campaign_catalog_events event ON event.campaign_id=receipt.campaign_id
      AND event.command_id=receipt.command_id AND event.event_id=receipt.event_id
    WHERE receipt.campaign_id=? ORDER BY receipt.revision_after`).all(campaignId) as any[]).map((row) => ({
      commandId: row.command_id, type: "catalog_configured" as const, revisionBefore: row.revision_before,
      revisionAfter: row.revision_after, occurredAt: row.occurred_at,
    }));
}

function assertContiguousAdministrationHistory(events: Array<{ revision: number }>, revision: number): void {
  if (events.length !== revision || events.some((event, index) => event.revision !== index + 1)) {
    throw new Error("campaign administration history is incomplete");
  }
}

export function createCampaignAdministrationRepository(db: DatabaseDriver.Database,
  deps: RepositoryDependencies, assertCanMutate: () => void = () => undefined,
  validateRoom: (sessionId: string) => "running" | "stopped" | null = () => null): CampaignAdministrationRepository {
  const runMutation = <T>(actor: string, campaignId: string, expectedRevision: number, key: string,
    type: CampaignAdministrationReceipt["type"], payload: object, apply: (context: NewContext) => T,
    retry: (commandId: string, stored: unknown) => T): MutationResult<T> => {
    assertCanMutate();
    return mutation(db, deps, actor, campaignId, expectedRevision, key, type, payload, apply, retry);
  };
  const get = (actorRaw: string, campaignRaw: string) => {
    const actor = resourceIdSchema.parse(actorRaw), campaignId = resourceIdSchema.parse(campaignRaw);
    const auth = getAuthority(db, actor, campaignId); return auth ? project(campaignId, auth) : null;
  };
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
  const api: CampaignAdministrationRepository = {
    getCampaignAdministration: get,
    renameCampaignCompatibility: (actor, campaignId, name, expectedUpdatedAt) => {
      const normalizedName = campaignNameSchema.parse(name);
      const auth = getAuthority(db, resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId));
      if (!auth) throw new CampaignAdministrationForbiddenError();
      if (expectedUpdatedAt !== undefined && auth.updatedAt !== utcIsoTimestampSchema.parse(expectedUpdatedAt))
        throw new CampaignAdministrationStaleError();
      const digest = createHash("sha256").update(`${campaignId}:${auth.revision}:${normalizedName}:${expectedUpdatedAt ?? "legacy"}`).digest("hex").slice(0, 32);
      return runMutation(actor, campaignId, auth.revision, `compat-rename-${digest}`, "campaign_renamed", { name: normalizedName },
        ({ at }) => {
          db.prepare("UPDATE campaigns SET name=?,updated_at=? WHERE id=?").run(normalizedName, at, campaignId);
          return { name: normalizedName, updatedAt: at };
        }, (_commandId, stored) => stored).receipt;
    },
    updateCampaignAdministration: (actor, campaignId, raw) => {
      const input = campaignAdministrationPatchSchema.parse(raw);
      const result = runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey,
        "administration_updated", { status: input.status, settings: input.settings }, ({ auth, at }) => {
          if (input.status !== undefined && input.status !== auth.status && !transitions[auth.status]!.includes(input.status))
            throw new CampaignAdministrationConflictError("illegal lifecycle transition");
          const settings = campaignSettingsSchema.parse({ ...auth.settings, ...input.settings });
          db.prepare("UPDATE campaigns SET lifecycle_status=?,settings=? WHERE id=?")
            .run(input.status ?? auth.status, JSON.stringify(settings), campaignId);
          return campaignAdministrationSchema.parse({ id: campaignId, status: input.status ?? auth.status,
            settings, activeTimelineId: auth.activeTimelineId, revision: input.expectedRevision + 1,
            updatedAt: at, actorRole: auth.role });
        }, (_commandId, stored) => campaignAdministrationSchema.parse(stored));
      return result;
    },
    archiveCampaignWithConfirmation: (actor, campaignId, raw) => {
      const confirmationName = campaignNameSchema.parse(raw.confirmationName);
      const input = campaignRevisionMutationSchema.parse({
        expectedRevision: raw.expectedRevision,
        idempotencyKey: raw.idempotencyKey,
      });
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey,
        "administration_updated", { status: "archived", confirmationName }, ({ auth, at }) => {
          const current = db.prepare("SELECT name FROM campaigns WHERE id=?").get(campaignId) as { name: string } | undefined;
          if (!current || current.name !== confirmationName)
            throw new CampaignAdministrationConflictError("campaign name confirmation does not match");
          if (auth.status !== "archived" && !transitions[auth.status]!.includes("archived"))
            throw new CampaignAdministrationConflictError("illegal lifecycle transition");
          db.prepare("UPDATE campaigns SET lifecycle_status=? WHERE id=?").run("archived", campaignId);
          return campaignAdministrationSchema.parse({ id: campaignId, status: "archived", settings: auth.settings,
            activeTimelineId: auth.activeTimelineId, revision: input.expectedRevision + 1, updatedAt: at, actorRole: auth.role });
        }, (_commandId, stored) => campaignAdministrationSchema.parse(stored));
    },
    addAuditedCampaignMembership: (actor, campaignId, raw) => {
      const input = campaignMembershipMutationSchema.parse(raw), payload = { principalId: input.principalId, role: input.role };
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "membership_added", payload,
        ({ at }) => {
          if (!db.prepare("SELECT 1 FROM principals WHERE id=?").get(input.principalId)) throw new CampaignAdministrationConflictError("principal not found");
          if (db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, input.principalId))
            throw new CampaignAdministrationConflictError("membership already exists");
          db.prepare("INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,?,?)")
            .run(campaignId, input.principalId, input.role, at);
          return campaignMembershipSchema.parse({ campaignId, principalId: input.principalId, role: input.role, createdAt: at });
        }, (_commandId, stored) => campaignMembershipSchema.parse(stored));
    },
    changeAuditedCampaignMembershipRole: (actor, campaignId, principalRaw, raw) => {
      const principalId = resourceIdSchema.parse(principalRaw), input = campaignMembershipRoleMutationSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "membership_role_changed",
        { principalId, role: input.role }, () => {
          const row = db.prepare("SELECT * FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principalId) as any;
          if (!row) throw new CampaignAdministrationConflictError("membership not found");
          if (row.role === "owner") throw new CampaignAdministrationConflictError("sole owner cannot be demoted");
          db.prepare("UPDATE campaign_memberships SET role=? WHERE campaign_id=? AND principal_id=?").run(input.role, campaignId, principalId);
          return member({ ...row, role: input.role });
        }, (_commandId, stored) => campaignMembershipReadSchema.parse(stored));
    },
    removeAuditedCampaignMembership: (actor, campaignId, principalRaw, raw) => {
      const principalId = resourceIdSchema.parse(principalRaw), input = campaignRevisionMutationSchema.parse(raw);
      let removed: CampaignMembershipRead;
      const result = runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "membership_removed",
        { principalId }, () => {
          const row = db.prepare("SELECT * FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principalId) as any;
          if (!row) throw new CampaignAdministrationConflictError("membership not found");
          if (row.role === "owner") throw new CampaignAdministrationConflictError("sole owner cannot be removed");
          removed = member(row); db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").run(campaignId, principalId);
          return removed;
        }, (_commandId, stored) => campaignMembershipReadSchema.parse(stored));
      return result;
    },
    attachAuditedCampaignRoom: (actor, campaignId, raw) => {
      const input = campaignRoomMutationSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "room_attached", { sessionId: input.sessionId },
        ({ at }) => {
          const old = db.prepare("SELECT * FROM campaign_sessions WHERE session_id=?").get(input.sessionId) as any;
          if (old) { if (old.campaign_id !== campaignId) throw new CampaignAdministrationConflictError("room belongs to another campaign");
            throw new CampaignAdministrationConflictError("room attachment already exists"); }
          const lifecycle = validateRoom(input.sessionId);
          if (lifecycle === null) throw new CampaignAdministrationConflictError("room is not attachable");
          if (lifecycle === "stopped") throw new CampaignAdministrationConflictError("stopped room cannot be attached");
          db.prepare("INSERT INTO campaign_sessions (campaign_id,session_id,attached_at) VALUES (?,?,?)").run(campaignId, input.sessionId, at);
          return attachment({ campaign_id: campaignId, session_id: input.sessionId, attached_at: at });
        }, (_commandId, stored) => campaignSessionAttachmentSchema.parse(stored));
    },
    detachAuditedCampaignRoom: (actor, campaignId, raw) => {
      const input = campaignRoomMutationSchema.parse(raw); let detached: CampaignSessionAttachment;
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "room_detached", { sessionId: input.sessionId },
        ({ commandId }) => {
          const row = db.prepare("SELECT * FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, input.sessionId) as any;
          if (!row) throw new CampaignAdministrationConflictError("room attachment not found");
          detached = attachment(row); db.prepare("DELETE FROM campaign_sessions WHERE campaign_id=? AND session_id=?").run(campaignId, input.sessionId);
          return detached;
        }, (_commandId, stored) => campaignSessionAttachmentSchema.parse(stored));
    },
    listCampaignTimelineHistory: (actor, campaignId) => {
      const auth = getAuthority(db, resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId)); if (!auth) return [];
      return (db.prepare(`SELECT t.*,h.parent_timeline_id,h.forked_from_revision FROM campaign_timelines t
        JOIN campaign_timeline_history h ON h.campaign_id=t.campaign_id AND h.timeline_id=t.id
        WHERE t.campaign_id=? ORDER BY t.created_at,t.id`).all(campaignId) as any[]).map((row) => timeline(row, auth.activeTimelineId));
    },
    createCampaignCheckpoint: (actor, campaignId, raw) => {
      const input = createCampaignCheckpointInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "checkpoint_created",
        { timelineId: input.timelineId, timelineRevision: input.timelineRevision, label: input.label }, ({ commandId, at }) => {
          const t = db.prepare(`SELECT timeline.revision FROM campaigns campaign JOIN campaign_timelines timeline
            ON timeline.campaign_id=campaign.id AND timeline.id=campaign.active_timeline_id
            WHERE campaign.id=? AND timeline.id=?`).get(campaignId, input.timelineId) as any;
          if (!t || t.revision !== input.timelineRevision) throw new CampaignAdministrationConflictError("checkpoint revision is not current");
          const id = resourceIdSchema.parse(deps.ids.nextId());
          db.prepare(`INSERT INTO campaign_checkpoints (id,campaign_id,timeline_id,timeline_revision,label,created_at,command_id)
            VALUES (?,?,?,?,?,?,?)`).run(id, campaignId, input.timelineId, input.timelineRevision, input.label, at, commandId);
          db.prepare(`INSERT INTO campaign_checkpoint_attribute_snapshots (checkpoint_id,actor_id,attribute_id,value)
            SELECT ?,actor.id,attribute.attribute_id,attribute.value FROM campaign_actors actor
            JOIN rpg_character_attributes attribute ON attribute.campaign_id=actor.campaign_id AND attribute.sheet_id=actor.sheet_id
            WHERE actor.campaign_id=? ORDER BY actor.id,attribute.attribute_id`).run(id, campaignId);
          db.prepare(`INSERT INTO campaign_checkpoint_resource_snapshots (checkpoint_id,actor_id,name,current,max)
            SELECT ?,actor_id,name,current,max FROM rpg_actor_resources WHERE campaign_id=? ORDER BY actor_id,name`).run(id, campaignId);
          return checkpoint({ id, campaign_id: campaignId, timeline_id: input.timelineId,
            timeline_revision: input.timelineRevision, label: input.label, created_at: at });
        }, (_commandId, stored) => campaignCheckpointSchema.parse(stored));
    },
    listCampaignCheckpoints: (actor, campaignId) => getAuthority(db, resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId))
      ? (db.prepare("SELECT * FROM campaign_checkpoints WHERE campaign_id=? ORDER BY created_at,id").all(campaignId) as any[]).map(checkpoint) : [],
    forkCampaignTimeline: (actor, campaignId, raw) => {
      const input = forkCampaignTimelineInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "timeline_forked", { checkpointId: input.checkpointId },
        ({ commandId, at, auth }) => {
          const cp = db.prepare("SELECT * FROM campaign_checkpoints WHERE campaign_id=? AND id=?").get(campaignId, input.checkpointId) as any;
          if (!cp) throw new CampaignAdministrationConflictError("checkpoint not found");
          const id = resourceIdSchema.parse(deps.ids.nextId());
          db.prepare("INSERT INTO campaign_timelines (id,campaign_id,revision,created_at) VALUES (?,?,?,?)")
            .run(id, campaignId, cp.timeline_revision, at);
          db.prepare(`INSERT INTO campaign_timeline_history
            (campaign_id,timeline_id,source_timeline_id,parent_timeline_id,created_by_command_id,forked_from_revision) VALUES (?,?,NULL,?,?,?)`)
            .run(campaignId, id, cp.timeline_id, commandId, cp.timeline_revision);
          db.prepare(`INSERT INTO campaign_timeline_events (campaign_id,timeline_id,revision,event_id,inherited)
            SELECT campaign_id,?,revision,event_id,1 FROM campaign_timeline_events
            WHERE campaign_id=? AND timeline_id=? AND revision<=? ORDER BY revision`)
            .run(id, campaignId, cp.timeline_id, cp.timeline_revision);
          db.prepare(`INSERT INTO campaign_imported_timeline_events
            (campaign_id,timeline_id,revision,source_event_id,source_command_id,actor_id,source_turn_id,type,occurred_at,public_data)
            SELECT campaign_id,?,revision,source_event_id,source_command_id,actor_id,source_turn_id,type,occurred_at,public_data
            FROM campaign_imported_timeline_events WHERE campaign_id=? AND timeline_id=? AND revision<=? ORDER BY revision`)
            .run(id, campaignId, cp.timeline_id, cp.timeline_revision);
          db.prepare(`UPDATE rpg_character_attributes SET value=(SELECT snapshot.value
              FROM campaign_checkpoint_attribute_snapshots snapshot JOIN campaign_actors actor
                ON actor.id=snapshot.actor_id AND actor.sheet_id=rpg_character_attributes.sheet_id
              WHERE snapshot.checkpoint_id=? AND snapshot.attribute_id=rpg_character_attributes.attribute_id)
            WHERE campaign_id=? AND EXISTS (SELECT 1 FROM campaign_checkpoint_attribute_snapshots snapshot
              JOIN campaign_actors actor ON actor.id=snapshot.actor_id AND actor.sheet_id=rpg_character_attributes.sheet_id
              WHERE snapshot.checkpoint_id=? AND snapshot.attribute_id=rpg_character_attributes.attribute_id)`)
            .run(cp.id, campaignId, cp.id);
          db.prepare("DELETE FROM rpg_actor_resources WHERE campaign_id=?").run(campaignId);
          db.prepare(`INSERT INTO rpg_actor_resources (campaign_id,actor_id,name,current,max)
            SELECT ?,actor_id,name,current,max FROM campaign_checkpoint_resource_snapshots WHERE checkpoint_id=?`)
            .run(campaignId, cp.id);
          db.prepare("UPDATE campaigns SET active_timeline_id=? WHERE id=? AND active_timeline_id=?").run(id, campaignId, auth.activeTimelineId);
          return timeline({ id, campaign_id: campaignId, revision: cp.timeline_revision, created_at: at,
            parent_timeline_id: cp.timeline_id, forked_from_revision: cp.timeline_revision }, id);
        }, (_commandId, stored) => campaignTimelineHistorySchema.parse(stored));
    },
    createCampaignRecap: (actor, campaignId, raw) => {
      const input = createCampaignRecapInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "recap_created",
        { timelineId: input.timelineId, throughRevision: input.throughRevision, selectedSessionIds: input.selectedSessionIds,
          visibility: input.visibility, text: input.text }, ({ commandId, at }) => {
          const t = db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(campaignId, input.timelineId) as any;
          if (!t || input.throughRevision > t.revision) throw new CampaignAdministrationConflictError("recap revision is unavailable");
          for (const id of input.selectedSessionIds) if (!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, id))
            throw new CampaignAdministrationConflictError("recap session is not attached");
          const id = resourceIdSchema.parse(deps.ids.nextId());
          db.prepare(`INSERT INTO campaign_recaps (id,campaign_id,timeline_id,through_revision,selected_session_ids,visibility,text,created_at,command_id)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(id, campaignId, input.timelineId, input.throughRevision,
              JSON.stringify(input.selectedSessionIds), input.visibility, input.text, at, commandId);
          return recap({ id, campaign_id: campaignId, timeline_id: input.timelineId, through_revision: input.throughRevision,
            selected_session_ids: JSON.stringify(input.selectedSessionIds), visibility: input.visibility, text: input.text, created_at: at });
        }, (_commandId, stored) => campaignRecapSchema.parse(stored));
    },
    listCampaignRecaps: (actor, campaignId) => {
      const auth = getAuthority(db, resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId)); if (!auth) return [];
      const roleFilter = auth.role === "player" || auth.role === "observer" ? " AND visibility='members'" : "";
      return (db.prepare(`SELECT * FROM campaign_recaps WHERE campaign_id=?${roleFilter} ORDER BY created_at,id`).all(campaignId) as any[]).map(recap);
    },
    dryRunCampaignImport: (actorRaw, raw) => {
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
          try { lifecycle = validateRoom(room.sessionId); } catch { /* malformed sessions are deliberately unattachable */ }
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
    },
    applyCampaignImport: (actorRaw, raw) => {
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
        const imported = get(actor, campaignId)!;
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
    },
    createCampaignExport: (actor, campaignId, raw) => {
      const input = createCampaignExportInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "export_created", {},
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
          const catalogEvents = catalogAdministrationEvents(db,campaignId).map(({ campaignId: _campaignId,...event })=>event);
          const catalogReceipts = catalogAdministrationReceipts(db,campaignId);
          const allAdministrationEvents=[...importedAdminEvents,...currentAdminEvents,...catalogEvents]
            .sort((a,b)=>a.revision-b.revision);
          const allAdministrationReceipts=[...importedReceipts,...currentReceipts,...catalogReceipts]
            .sort((a,b)=>a.revisionAfter-b.revisionAfter);
          assertContiguousAdministrationHistory(allAdministrationEvents,auth.revision);
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
    listCampaignAdministrationEvents: (actor, campaignId) => {
      const auth = getAuthority(db, resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId)); if (!auth) return [];
      const imported = (db.prepare("SELECT * FROM campaign_imported_administration_events WHERE campaign_id=? ORDER BY revision")
        .all(campaignId) as any[]).map((row) => campaignAdministrationEventSchema.parse({ eventId: row.source_event_id,
          commandId: row.source_command_id, campaignId, revision: row.revision, type: row.type,
          data: JSON.parse(row.public_data), occurredAt: row.occurred_at }));
      const current = (db.prepare(`SELECT event.* FROM campaign_administration_events event
        JOIN campaign_administration_commands command ON command.campaign_id=event.campaign_id
          AND command.command_id=event.command_id AND command.type=event.type
          AND command.expected_revision=event.revision_before
        JOIN campaign_administration_receipts receipt ON receipt.campaign_id=event.campaign_id
          AND receipt.command_id=event.command_id AND receipt.event_id=event.event_id
          AND receipt.type=event.type AND receipt.revision_before=event.revision_before
          AND receipt.revision_after=event.revision
        WHERE event.campaign_id=? ORDER BY event.revision`).all(campaignId) as any[]).map((row) =>
          campaignAdministrationEventSchema.parse({ eventId: row.event_id, commandId: row.command_id,
            campaignId, revision: row.revision, type: row.type,
            // GM receives exactly the public event projection; only the owner may inspect bounded private event details.
            data: JSON.parse(auth.role === "owner" ? row.private_data : row.public_data), occurredAt: row.occurred_at }));
      const catalog=catalogAdministrationEvents(db,campaignId);
      const merged=[...imported,...current,...catalog].sort((left,right)=>left.revision-right.revision);
      assertContiguousAdministrationHistory(merged,auth.revision);
      return merged;
    },
    getCampaignAdministrationReceipt: (actor, campaignIdRaw, commandIdRaw) => {
      const campaignId = resourceIdSchema.parse(campaignIdRaw), commandId = resourceIdSchema.parse(commandIdRaw);
      const auth = getAuthority(db, resourceIdSchema.parse(actor), campaignId); if (!auth) return null;
      const row = db.prepare(`SELECT receipt.*,command.created_at,event.occurred_at,event.public_data,event.private_data
        FROM campaign_administration_receipts receipt
        JOIN campaign_administration_commands command ON command.campaign_id=receipt.campaign_id
          AND command.command_id=receipt.command_id AND command.type=receipt.type
          AND command.expected_revision=receipt.revision_before
        JOIN campaign_administration_events event ON event.campaign_id=receipt.campaign_id
          AND event.command_id=receipt.command_id AND event.event_id=receipt.event_id
          AND event.type=receipt.type AND event.revision_before=receipt.revision_before
          AND event.revision=receipt.revision_after
        WHERE receipt.campaign_id=? AND receipt.command_id=?`).get(campaignId, commandId) as any;
      if (row) {
        const event = campaignAdministrationEventSchema.parse({ eventId: row.event_id, commandId, campaignId,
          type: row.type, revision: row.revision_after, occurredAt: row.occurred_at,
          data: JSON.parse(auth.role === "owner" ? row.private_data : row.public_data) });
        return campaignAdministrationReceiptSchema.parse({ commandId, campaignId, type: row.type,
          revisionBefore: row.revision_before, revisionAfter: row.revision_after,
          occurredAt: row.created_at, events: [event] });
      }
      const catalogReceipt=db.prepare(`SELECT receipt.*,event.occurred_at,event.public_data FROM campaign_catalog_receipts receipt
        JOIN campaign_catalog_events event ON event.campaign_id=receipt.campaign_id AND event.command_id=receipt.command_id
          AND event.event_id=receipt.event_id AND event.revision=receipt.revision_after
        WHERE receipt.campaign_id=? AND receipt.command_id=?`).get(campaignId,commandId) as any;
      if(catalogReceipt){
        const event=campaignAdministrationEventSchema.parse({eventId:catalogReceipt.event_id,commandId,campaignId,
          type:"catalog_configured",revision:catalogReceipt.revision_after,occurredAt:catalogReceipt.occurred_at,
          data:JSON.parse(catalogReceipt.public_data)});
        return campaignAdministrationReceiptSchema.parse({commandId,campaignId,type:"catalog_configured",
          revisionBefore:catalogReceipt.revision_before,revisionAfter:catalogReceipt.revision_after,
          occurredAt:catalogReceipt.occurred_at,events:[event]});
      }
      const imported = db.prepare(`SELECT receipt.*,event.source_event_id,event.public_data,event.occurred_at
        FROM campaign_imported_administration_receipts receipt
        JOIN campaign_imported_administration_events event ON event.campaign_id=receipt.campaign_id
          AND event.source_command_id=receipt.source_command_id AND event.type=receipt.type
          AND event.revision=receipt.revision_after
        WHERE receipt.campaign_id=? AND receipt.source_command_id=?`).get(campaignId, commandId) as any;
      if (!imported) return null;
      const event = campaignAdministrationEventSchema.parse({ eventId: imported.source_event_id, commandId,
        campaignId, type: imported.type, revision: imported.revision_after,
        occurredAt: imported.occurred_at, data: JSON.parse(imported.public_data) });
      return campaignAdministrationReceiptSchema.parse({ commandId, campaignId, type: imported.type,
        revisionBefore: imported.revision_before, revisionAfter: imported.revision_after,
        occurredAt: imported.occurred_at, events: [event] });
    },
  };
  return api;
}

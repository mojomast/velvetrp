// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  campaignAdministrationEventSchema, campaignAdministrationPatchSchema, campaignAdministrationReceiptSchema,
  campaignAdministrationSchema, campaignMembershipMutationSchema,
  campaignMembershipReadSchema, campaignMembershipRoleMutationSchema, campaignMembershipSchema, campaignNameSchema,
  campaignRevisionMutationSchema, campaignRoomMutationSchema, campaignSessionAttachmentSchema,
  campaignSettingsSchema, resourceIdSchema, utcIsoTimestampSchema,
  type CampaignAdministration, type CampaignAdministrationReceipt, type CampaignMembership,
  type CampaignMembershipRead, type CampaignSessionAttachment,
} from "@velvet/contracts";
import { publicAdministrationPayload } from "./administrationEventRepo.js";
import type { AdministrationAuthority } from "./administrationAccessRepo.js";
import { createCampaignCheckpointRepo } from "./campaignCheckpointRepo.js";
import { createCampaignRecapRepo } from "./campaignRecapRepo.js";

type MutationResult<T> = { value: T; receipt: CampaignAdministrationReceipt };
interface NewContext { commandId: string; eventId: string; at: string; auth: AdministrationAuthority }

/** Error constructors supplied by the public administration repository boundary. */
export interface AdministrationCommandErrors {
  forbidden: () => Error;
  stale: () => Error;
  conflict: (message: string) => Error;
}

interface AdministrationMutationDependencies {
  db: DatabaseDriver.Database;
  nextId: () => string;
  now: () => Date;
  getAuthority: (actor: string, campaignId: string) => AdministrationAuthority | null;
  errors: AdministrationCommandErrors;
}

export interface AdministrationCommandDependencies {
  db: DatabaseDriver.Database;
  nextId: () => string;
  now: () => Date;
  getAuthority: (actor: string, campaignId: string) => AdministrationAuthority | null;
  assertCanMutate: () => void;
  errors: AdministrationCommandErrors;
  validateRoom: (sessionId: string) => "running" | "stopped" | null;
  member: (row: any) => CampaignMembershipRead;
  attachment: (row: any) => CampaignSessionAttachment;
  checkpoint: (row: any) => import("@velvet/contracts").CampaignCheckpoint;
  recap: (row: any) => import("@velvet/contracts").CampaignRecap;
  timeline: (row: any, activeId: string) => import("@velvet/contracts").CampaignTimelineHistory;
}

/**
 * Runs one owner-authorized administration command in an immediate SQLite transaction.
 *
 * The transaction atomically reserves the idempotency key, applies the command, advances
 * the administration revision, and records its event and receipt. Error constructors are
 * injected from the public repository so this internal command module never imports its
 * public facade at runtime.
 */
function mutation<T>(deps: AdministrationMutationDependencies, actorRaw: string, campaignRaw: string,
  expectedRevision: number, keyRaw: string, type: CampaignAdministrationReceipt["type"], payload: object,
  apply: (context: NewContext) => T, retry: (commandId: string, stored: unknown) => T): MutationResult<T> {
  const { db, nextId, now, getAuthority, errors } = deps;
  const actor = resourceIdSchema.parse(actorRaw), campaignId = resourceIdSchema.parse(campaignRaw);
  const key = resourceIdSchema.parse(keyRaw), payloadJson = JSON.stringify(payload);
  const normalizedPayload = JSON.parse(payloadJson) as object;
  return db.transaction(() => {
    const auth = getAuthority(actor, campaignId);
    if (!auth || auth.role !== "owner" || auth.ownerId !== actor) throw errors.forbidden();
    const old = db.prepare(`SELECT c.command_id,c.type,c.expected_revision,c.payload,c.created_at,
      r.revision_before,r.revision_after,r.result_data FROM campaign_administration_commands c
      LEFT JOIN campaign_administration_receipts r ON r.command_id=c.command_id
      WHERE c.campaign_id=? AND c.idempotency_key=?`).get(campaignId, key) as any;
    if (old) {
      if (old.type !== type || old.expected_revision !== expectedRevision || old.payload !== payloadJson
        || old.revision_before === null) throw errors.conflict("idempotency identity collision");
      const eventRow = db.prepare("SELECT event_id,public_data,occurred_at FROM campaign_administration_events WHERE command_id=?")
        .get(old.command_id) as any;
      const event = campaignAdministrationEventSchema.parse({ eventId: eventRow.event_id, commandId: old.command_id,
        campaignId, type, revision: old.revision_after, occurredAt: eventRow.occurred_at,
        data: JSON.parse(eventRow.public_data) });
      return { value: retry(old.command_id, JSON.parse(old.result_data)), receipt: campaignAdministrationReceiptSchema.parse({
        commandId: old.command_id, campaignId, type, revisionBefore: old.revision_before,
        revisionAfter: old.revision_after, occurredAt: old.created_at, events: [event] }) };
    }
    if (db.prepare(`SELECT 1 FROM campaign_catalog_commands WHERE campaign_id=? AND idempotency_key=?`).get(campaignId, key))
      throw errors.conflict("idempotency identity collision");
    if (auth.revision !== expectedRevision) throw errors.stale();
    const commandId = resourceIdSchema.parse(nextId()), eventId = resourceIdSchema.parse(nextId());
    const clockAt = utcIsoTimestampSchema.parse(now().toISOString());
    const at = utcIsoTimestampSchema.parse(new Date(Math.max(Date.parse(clockAt), Date.parse(auth.updatedAt) + 1)).toISOString());
    db.prepare(`INSERT INTO campaign_administration_commands
      (command_id,campaign_id,idempotency_key,actor_principal_id,expected_revision,type,payload,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(commandId, campaignId, key, actor, expectedRevision, type, payloadJson, at);
    const value = apply({ commandId, eventId, at, auth });
    const next = expectedRevision + 1;
    const changed = db.prepare("UPDATE campaigns SET administration_revision=?,updated_at=? WHERE id=? AND administration_revision=?")
      .run(next, at, campaignId, expectedRevision);
    if (changed.changes !== 1) throw errors.stale();
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

export function createAdministrationCommandRepo(deps: AdministrationCommandDependencies) {
  const { db, nextId, now, getAuthority, assertCanMutate, errors, validateRoom, member, attachment, checkpoint, recap, timeline } = deps;
  const { forbidden, stale, conflict } = errors;
  const runMutation = <T>(actor: string, campaignId: string, expectedRevision: number, key: string,
    type: CampaignAdministrationReceipt["type"], payload: object, apply: (context: NewContext) => T,
    retry: (commandId: string, stored: unknown) => T): MutationResult<T> => {
    assertCanMutate();
    return mutation({ db, nextId, now, getAuthority, errors }, actor, campaignId, expectedRevision, key, type, payload, apply, retry);
  };
  const transitions: Record<string, readonly string[]> = { draft: ["published", "archived"],
    published: ["paused", "completed", "archived"], paused: ["published", "completed", "archived"],
    completed: ["archived"], archived: [] };
  return {
    // Import/export commands live in the facade, but use this same transaction boundary.
    runMutation,
    renameCampaignCompatibility: (actor: string, campaignId: string, name: string, expectedUpdatedAt?: string) => {
      const normalizedName = campaignNameSchema.parse(name);
      const auth = getAuthority(resourceIdSchema.parse(actor), resourceIdSchema.parse(campaignId));
      if (!auth) throw forbidden();
      if (expectedUpdatedAt !== undefined && auth.updatedAt !== utcIsoTimestampSchema.parse(expectedUpdatedAt)) throw stale();
      const digest = createHash("sha256").update(`${campaignId}:${auth.revision}:${normalizedName}:${expectedUpdatedAt ?? "legacy"}`).digest("hex").slice(0, 32);
      return runMutation(actor, campaignId, auth.revision, `compat-rename-${digest}`, "campaign_renamed", { name: normalizedName },
        ({ at }) => {
          db.prepare("UPDATE campaigns SET name=?,updated_at=? WHERE id=?").run(normalizedName, at, campaignId);
          return { name: normalizedName, updatedAt: at };
        }, (_commandId, stored) => stored).receipt;
    },
    updateCampaignAdministration: (actor: string, campaignId: string, raw: unknown) => {
      const input = campaignAdministrationPatchSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey,
        "administration_updated", { status: input.status, settings: input.settings }, ({ auth, at }) => {
          if (input.status !== undefined && input.status !== auth.status && !transitions[auth.status]!.includes(input.status))
            throw conflict("illegal lifecycle transition");
          const settings = campaignSettingsSchema.parse({ ...auth.settings, ...input.settings });
          db.prepare("UPDATE campaigns SET lifecycle_status=?,settings=? WHERE id=?").run(input.status ?? auth.status, JSON.stringify(settings), campaignId);
          return campaignAdministrationSchema.parse({ id: campaignId, status: input.status ?? auth.status, settings,
            activeTimelineId: auth.activeTimelineId, revision: input.expectedRevision + 1, updatedAt: at, actorRole: auth.role });
        }, (_commandId, stored) => campaignAdministrationSchema.parse(stored));
    },
    archiveCampaignWithConfirmation: (actor: string, campaignId: string, raw: { confirmationName: string; expectedRevision: number; idempotencyKey: string }) => {
      const confirmationName = campaignNameSchema.parse(raw.confirmationName);
      const input = campaignRevisionMutationSchema.parse({ expectedRevision: raw.expectedRevision, idempotencyKey: raw.idempotencyKey });
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey,
        "administration_updated", { status: "archived", confirmationName }, ({ auth, at }) => {
          const current = db.prepare("SELECT name FROM campaigns WHERE id=?").get(campaignId) as { name: string } | undefined;
          if (!current || current.name !== confirmationName) throw conflict("campaign name confirmation does not match");
          if (auth.status !== "archived" && !transitions[auth.status]!.includes("archived")) throw conflict("illegal lifecycle transition");
          db.prepare("UPDATE campaigns SET lifecycle_status=? WHERE id=?").run("archived", campaignId);
          return campaignAdministrationSchema.parse({ id: campaignId, status: "archived", settings: auth.settings,
            activeTimelineId: auth.activeTimelineId, revision: input.expectedRevision + 1, updatedAt: at, actorRole: auth.role });
        }, (_commandId, stored) => campaignAdministrationSchema.parse(stored));
    },
    addAuditedCampaignMembership: (actor: string, campaignId: string, raw: unknown) => {
      const input = campaignMembershipMutationSchema.parse(raw), payload = { principalId: input.principalId, role: input.role };
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "membership_added", payload, ({ at }) => {
        if (!db.prepare("SELECT 1 FROM principals WHERE id=?").get(input.principalId)) throw conflict("principal not found");
        if (db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, input.principalId))
          throw conflict("membership already exists");
        db.prepare("INSERT INTO campaign_memberships (campaign_id,principal_id,role,created_at) VALUES (?,?,?,?)")
          .run(campaignId, input.principalId, input.role, at);
        return campaignMembershipSchema.parse({ campaignId, principalId: input.principalId, role: input.role, createdAt: at });
      }, (_commandId, stored) => campaignMembershipSchema.parse(stored));
    },
    changeAuditedCampaignMembershipRole: (actor: string, campaignId: string, principalRaw: string, raw: unknown) => {
      const principalId = resourceIdSchema.parse(principalRaw), input = campaignMembershipRoleMutationSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "membership_role_changed", { principalId, role: input.role }, () => {
        const row = db.prepare("SELECT * FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principalId) as any;
        if (!row) throw conflict("membership not found");
        if (row.role === "owner") throw conflict("sole owner cannot be demoted");
        db.prepare("UPDATE campaign_memberships SET role=? WHERE campaign_id=? AND principal_id=?").run(input.role, campaignId, principalId);
        return member({ ...row, role: input.role });
      }, (_commandId, stored) => campaignMembershipReadSchema.parse(stored));
    },
    removeAuditedCampaignMembership: (actor: string, campaignId: string, principalRaw: string, raw: unknown) => {
      const principalId = resourceIdSchema.parse(principalRaw), input = campaignRevisionMutationSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "membership_removed", { principalId }, () => {
        const row = db.prepare("SELECT * FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principalId) as any;
        if (!row) throw conflict("membership not found");
        if (row.role === "owner") throw conflict("sole owner cannot be removed");
        const removed = member(row); db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").run(campaignId, principalId);
        return removed;
      }, (_commandId, stored) => campaignMembershipReadSchema.parse(stored));
    },
    attachAuditedCampaignRoom: (actor: string, campaignId: string, raw: unknown) => {
      const input = campaignRoomMutationSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "room_attached", { sessionId: input.sessionId }, ({ at }) => {
        const old = db.prepare("SELECT * FROM campaign_sessions WHERE session_id=?").get(input.sessionId) as any;
        if (old) { if (old.campaign_id !== campaignId) throw conflict("room belongs to another campaign"); throw conflict("room attachment already exists"); }
        const lifecycle = validateRoom(input.sessionId);
        if (lifecycle === null) throw conflict("room is not attachable");
        if (lifecycle === "stopped") throw conflict("stopped room cannot be attached");
        db.prepare("INSERT INTO campaign_sessions (campaign_id,session_id,attached_at) VALUES (?,?,?)").run(campaignId, input.sessionId, at);
        return attachment({ campaign_id: campaignId, session_id: input.sessionId, attached_at: at });
      }, (_commandId, stored) => campaignSessionAttachmentSchema.parse(stored));
    },
    detachAuditedCampaignRoom: (actor: string, campaignId: string, raw: unknown) => {
      const input = campaignRoomMutationSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "room_detached", { sessionId: input.sessionId }, () => {
        const row = db.prepare("SELECT * FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, input.sessionId) as any;
        if (!row) throw conflict("room attachment not found");
        const detached = attachment(row); db.prepare("DELETE FROM campaign_sessions WHERE campaign_id=? AND session_id=?").run(campaignId, input.sessionId);
        return detached;
      }, (_commandId, stored) => campaignSessionAttachmentSchema.parse(stored));
    },
    ...createCampaignCheckpointRepo({ db, nextId, runMutation, conflict, checkpoint, timeline, getAuthority }),
    ...createCampaignRecapRepo({ db, nextId, runMutation, conflict, recap, getAuthority }),
  };
}

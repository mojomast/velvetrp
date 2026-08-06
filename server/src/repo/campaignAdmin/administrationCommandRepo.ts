// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  campaignAdministrationPatchSchema, campaignAdministrationSchema, campaignMembershipMutationSchema,
  campaignMembershipReadSchema, campaignMembershipRoleMutationSchema, campaignMembershipSchema, campaignNameSchema,
  campaignRevisionMutationSchema, campaignRoomMutationSchema, campaignSessionAttachmentSchema,
  campaignSettingsSchema, resourceIdSchema, utcIsoTimestampSchema,
  type CampaignAdministration, type CampaignAdministrationReceipt, type CampaignMembership,
  type CampaignMembershipRead, type CampaignSessionAttachment,
} from "@velvet/contracts";
import { createCampaignCheckpointRepo } from "./campaignCheckpointRepo.js";
import { createCampaignRecapRepo } from "./campaignRecapRepo.js";

type MutationResult<T> = { value: T; receipt: CampaignAdministrationReceipt };
type Role = "owner" | "gm" | "player" | "observer";
interface Authority {
  role: Role;
  ownerId: string;
  revision: number;
  status: string;
  settings: ReturnType<typeof campaignSettingsSchema.parse>;
  activeTimelineId: string;
  updatedAt: string;
}
interface NewContext { commandId: string; eventId: string; at: string; auth: Authority }

export interface AdministrationCommandDependencies {
  db: DatabaseDriver.Database;
  nextId: () => string;
  getAuthority: (actor: string, campaignId: string) => Authority | null;
  runMutation: <T>(actor: string, campaignId: string, expectedRevision: number, key: string,
    type: CampaignAdministrationReceipt["type"], payload: object, apply: (context: NewContext) => T,
    retry: (commandId: string, stored: unknown) => T) => MutationResult<T>;
  forbidden: () => Error;
  stale: () => Error;
  conflict: (message: string) => Error;
  validateRoom: (sessionId: string) => "running" | "stopped" | null;
  member: (row: any) => CampaignMembershipRead;
  attachment: (row: any) => CampaignSessionAttachment;
  checkpoint: (row: any) => import("@velvet/contracts").CampaignCheckpoint;
  recap: (row: any) => import("@velvet/contracts").CampaignRecap;
  timeline: (row: any, activeId: string) => import("@velvet/contracts").CampaignTimelineHistory;
}

export function createAdministrationCommandRepo(deps: AdministrationCommandDependencies) {
  const { db, nextId, getAuthority, runMutation, forbidden, stale, conflict, validateRoom, member, attachment, checkpoint, recap, timeline } = deps;
  const transitions: Record<string, readonly string[]> = { draft: ["published", "archived"],
    published: ["paused", "completed", "archived"], paused: ["published", "completed", "archived"],
    completed: ["archived"], archived: [] };
  return {
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

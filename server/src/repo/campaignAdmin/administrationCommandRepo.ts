// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  campaignAdministrationPatchSchema, campaignAdministrationSchema, campaignCheckpointSchema, campaignMembershipMutationSchema,
  campaignMembershipReadSchema, campaignMembershipRoleMutationSchema, campaignMembershipSchema, campaignNameSchema,
  campaignRecapSchema, campaignRevisionMutationSchema, campaignRoomMutationSchema, campaignSessionAttachmentSchema,
  campaignSettingsSchema, campaignTimelineHistorySchema, createCampaignCheckpointInputSchema, createCampaignRecapInputSchema,
  forkCampaignTimelineInputSchema, resourceIdSchema, utcIsoTimestampSchema,
  type CampaignAdministration, type CampaignAdministrationReceipt, type CampaignCheckpoint, type CampaignMembership,
  type CampaignMembershipRead, type CampaignRecap, type CampaignSessionAttachment, type CampaignTimelineHistory,
} from "@velvet/contracts";

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
  checkpoint: (row: any) => CampaignCheckpoint;
  recap: (row: any) => CampaignRecap;
  timeline: (row: any, activeId: string) => CampaignTimelineHistory;
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
    createCampaignCheckpoint: (actor: string, campaignId: string, raw: unknown) => {
      const input = createCampaignCheckpointInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "checkpoint_created",
        { timelineId: input.timelineId, timelineRevision: input.timelineRevision, label: input.label }, ({ commandId, at }) => {
          const t = db.prepare(`SELECT timeline.revision FROM campaigns campaign JOIN campaign_timelines timeline
            ON timeline.campaign_id=campaign.id AND timeline.id=campaign.active_timeline_id WHERE campaign.id=? AND timeline.id=?`).get(campaignId, input.timelineId) as any;
          if (!t || t.revision !== input.timelineRevision) throw conflict("checkpoint revision is not current");
          const id = resourceIdSchema.parse(nextId());
          db.prepare(`INSERT INTO campaign_checkpoints (id,campaign_id,timeline_id,timeline_revision,label,created_at,command_id)
            VALUES (?,?,?,?,?,?,?)`).run(id, campaignId, input.timelineId, input.timelineRevision, input.label, at, commandId);
          db.prepare(`INSERT INTO campaign_checkpoint_attribute_snapshots (checkpoint_id,actor_id,attribute_id,value)
            SELECT ?,actor.id,attribute.attribute_id,attribute.value FROM campaign_actors actor
            JOIN rpg_character_attributes attribute ON attribute.campaign_id=actor.campaign_id AND attribute.sheet_id=actor.sheet_id
            WHERE actor.campaign_id=? ORDER BY actor.id,attribute.attribute_id`).run(id, campaignId);
          db.prepare(`INSERT INTO campaign_checkpoint_resource_snapshots (checkpoint_id,actor_id,name,current,max)
            SELECT ?,actor_id,name,current,max FROM rpg_actor_resources WHERE campaign_id=? ORDER BY actor_id,name`).run(id, campaignId);
          return checkpoint({ id, campaign_id: campaignId, timeline_id: input.timelineId, timeline_revision: input.timelineRevision, label: input.label, created_at: at });
        }, (_commandId, stored) => campaignCheckpointSchema.parse(stored));
    },
    forkCampaignTimeline: (actor: string, campaignId: string, raw: unknown) => {
      const input = forkCampaignTimelineInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "timeline_forked", { checkpointId: input.checkpointId }, ({ commandId, at, auth }) => {
        const cp = db.prepare("SELECT * FROM campaign_checkpoints WHERE campaign_id=? AND id=?").get(campaignId, input.checkpointId) as any;
        if (!cp) throw conflict("checkpoint not found");
        const id = resourceIdSchema.parse(nextId());
        db.prepare("INSERT INTO campaign_timelines (id,campaign_id,revision,created_at) VALUES (?,?,?,?)").run(id, campaignId, cp.timeline_revision, at);
        db.prepare(`INSERT INTO campaign_timeline_history
          (campaign_id,timeline_id,source_timeline_id,parent_timeline_id,created_by_command_id,forked_from_revision) VALUES (?,?,NULL,?,?,?)`).run(campaignId, id, cp.timeline_id, commandId, cp.timeline_revision);
        db.prepare(`INSERT INTO campaign_timeline_events (campaign_id,timeline_id,revision,event_id,inherited)
          SELECT campaign_id,?,revision,event_id,1 FROM campaign_timeline_events WHERE campaign_id=? AND timeline_id=? AND revision<=? ORDER BY revision`).run(id, campaignId, cp.timeline_id, cp.timeline_revision);
        db.prepare(`INSERT INTO campaign_imported_timeline_events
          (campaign_id,timeline_id,revision,source_event_id,source_command_id,actor_id,source_turn_id,type,occurred_at,public_data)
          SELECT campaign_id,?,revision,source_event_id,source_command_id,actor_id,source_turn_id,type,occurred_at,public_data
          FROM campaign_imported_timeline_events WHERE campaign_id=? AND timeline_id=? AND revision<=? ORDER BY revision`).run(id, campaignId, cp.timeline_id, cp.timeline_revision);
        db.prepare(`UPDATE rpg_character_attributes SET value=(SELECT snapshot.value FROM campaign_checkpoint_attribute_snapshots snapshot JOIN campaign_actors actor
            ON actor.id=snapshot.actor_id AND actor.sheet_id=rpg_character_attributes.sheet_id WHERE snapshot.checkpoint_id=? AND snapshot.attribute_id=rpg_character_attributes.attribute_id)
          WHERE campaign_id=? AND EXISTS (SELECT 1 FROM campaign_checkpoint_attribute_snapshots snapshot JOIN campaign_actors actor
            ON actor.id=snapshot.actor_id AND actor.sheet_id=rpg_character_attributes.sheet_id WHERE snapshot.checkpoint_id=? AND snapshot.attribute_id=rpg_character_attributes.attribute_id)`).run(cp.id, campaignId, cp.id);
        db.prepare("DELETE FROM rpg_actor_resources WHERE campaign_id=?").run(campaignId);
        db.prepare(`INSERT INTO rpg_actor_resources (campaign_id,actor_id,name,current,max)
          SELECT ?,actor_id,name,current,max FROM campaign_checkpoint_resource_snapshots WHERE checkpoint_id=?`).run(campaignId, cp.id);
        db.prepare("UPDATE campaigns SET active_timeline_id=? WHERE id=? AND active_timeline_id=?").run(id, campaignId, auth.activeTimelineId);
        return timeline({ id, campaign_id: campaignId, revision: cp.timeline_revision, created_at: at,
          parent_timeline_id: cp.timeline_id, forked_from_revision: cp.timeline_revision }, id);
      }, (_commandId, stored) => campaignTimelineHistorySchema.parse(stored));
    },
    createCampaignRecap: (actor: string, campaignId: string, raw: unknown) => {
      const input = createCampaignRecapInputSchema.parse(raw);
      return runMutation(actor, campaignId, input.expectedRevision, input.idempotencyKey, "recap_created",
        { timelineId: input.timelineId, throughRevision: input.throughRevision, selectedSessionIds: input.selectedSessionIds, visibility: input.visibility, text: input.text }, ({ commandId, at }) => {
          const t = db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(campaignId, input.timelineId) as any;
          if (!t || input.throughRevision > t.revision) throw conflict("recap revision is unavailable");
          for (const id of input.selectedSessionIds) if (!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, id)) throw conflict("recap session is not attached");
          const id = resourceIdSchema.parse(nextId());
          db.prepare(`INSERT INTO campaign_recaps (id,campaign_id,timeline_id,through_revision,selected_session_ids,visibility,text,created_at,command_id)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(id, campaignId, input.timelineId, input.throughRevision, JSON.stringify(input.selectedSessionIds), input.visibility, input.text, at, commandId);
          return recap({ id, campaign_id: campaignId, timeline_id: input.timelineId, through_revision: input.throughRevision,
            selected_session_ids: JSON.stringify(input.selectedSessionIds), visibility: input.visibility, text: input.text, created_at: at });
        }, (_commandId, stored) => campaignRecapSchema.parse(stored));
    },
  };
}

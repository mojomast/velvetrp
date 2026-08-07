// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  addCampaignMembershipInputSchema,
  attachCampaignSessionInputSchema,
  detachCampaignSessionInputSchema,
  campaignMembershipReadSchema,
  campaignMembershipSchema,
  campaignRenameRequestSchema,
  campaignSchema,
  campaignSessionAttachmentSchema,
  createCampaignInputSchema,
  renameCampaignInputSchema,
  resourceIdSchema,
  revisionSchema,
  utcIsoTimestampSchema,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";
import type {
  AddCampaignMembershipInput,
  AttachCampaignSessionInput,
  Campaign,
  CampaignMembership,
  CampaignRenameRequest,
  CampaignSessionAttachment,
  CreateCampaignInput,
  DetachCampaignSessionInput,
  RenameCampaignInput,
} from "../../types.js";
import type { RepositoryDependencies } from "./campaignTypes.js";
import {
  CampaignCreationAuthorizationError,
  CampaignCreationIdCollisionError,
  CampaignRenameStaleError,
  CampaignRenameUnavailableError,
  CampaignSessionAttachmentConflictError,
  CampaignSessionAttachmentSessionMissingError,
  CampaignSessionAttachmentUnavailableError,
} from "./campaignErrors.js";
import { createCampaignRoomSessionLifecycleRepository } from "./campaignRoomSessionLifecycleRepo.js";

interface CampaignRow {
  id: string;
  name: string;
  active_timeline_id: string;
  owner_principal_id: string;
  created_at: string;
  updated_at: string;
}

interface CampaignOwnerIntegrityRow {
  campaign_id: unknown;
  principal_id: unknown;
  role: unknown;
  created_at: unknown;
  principal_parent_id: unknown;
}

interface CampaignMembershipRow {
  campaign_id: string;
  principal_id: string;
  role: string;
  created_at: string;
}

interface CampaignSessionAttachmentRow {
  campaign_id: string;
  session_id: string;
  attached_at: string;
}

function toCampaign(row: CampaignRow): Campaign {
  return campaignSchema.parse({ id: row.id, name: row.name, activeTimelineId: row.active_timeline_id,
    ownerPrincipalId: row.owner_principal_id, createdAt: row.created_at, updatedAt: row.updated_at });
}

function toCampaignMembership(row: CampaignMembershipRow): CampaignMembership {
  return campaignMembershipSchema.parse({ campaignId: row.campaign_id, principalId: row.principal_id,
    role: row.role, createdAt: row.created_at });
}

function toCampaignSessionAttachment(row: CampaignSessionAttachmentRow): CampaignSessionAttachment {
  return campaignSessionAttachmentSchema.parse({ campaignId: row.campaign_id, sessionId: row.session_id,
    attachedAt: row.attached_at });
}

export function createCampaignSync(
  db: DatabaseDriver.Database, dependencies: RepositoryDependencies, actorPrincipalId: string, input: CreateCampaignInput,
): Campaign {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = createCampaignInputSchema.parse(input);
  return db.transaction(() => {
    const owner = db.prepare(`SELECT application_owner.principal_id, principals.id AS principal_parent_id
      FROM application_owner LEFT JOIN principals ON principals.id = application_owner.principal_id
      WHERE application_owner.singleton = 1`).get() as { principal_id: unknown; principal_parent_id: unknown } | undefined;
    if (!owner) throw new Error("application owner invariant is missing");
    const parsedOwnerId = resourceIdSchema.safeParse(owner.principal_id);
    if (!parsedOwnerId.success || owner.principal_parent_id !== parsedOwnerId.data) {
      throw new Error("application owner invariant is malformed");
    }
    if (parsedOwnerId.data !== actorId) throw new CampaignCreationAuthorizationError();
    const campaignId = resourceIdSchema.parse(dependencies.ids.nextId());
    const timelineId = resourceIdSchema.parse(dependencies.ids.nextId());
    const createdAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
    const campaign = campaignSchema.parse({ id: campaignId, name: normalized.name, activeTimelineId: timelineId,
      ownerPrincipalId: parsedOwnerId.data, createdAt, updatedAt: createdAt });
    const campaignIdExists = db.prepare("SELECT 1 FROM campaigns WHERE id = ?").get(campaign.id);
    const timelineIdExists = db.prepare("SELECT 1 FROM campaign_timelines WHERE id = ?").get(campaign.activeTimelineId);
    if (campaignIdExists || timelineIdExists) throw new CampaignCreationIdCollisionError();
    db.prepare(`INSERT INTO campaigns (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(campaign.id, campaign.name, campaign.activeTimelineId, campaign.ownerPrincipalId, campaign.createdAt, campaign.updatedAt);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)")
      .run(campaign.activeTimelineId, campaign.id, campaign.createdAt);
    db.prepare(`INSERT INTO campaign_timeline_history
      (campaign_id, timeline_id, source_timeline_id, parent_timeline_id, created_by_command_id, forked_from_revision) VALUES (?, ?, NULL, NULL, NULL, NULL)`)
      .run(campaign.id, campaign.activeTimelineId);
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES (?, ?, 'owner', ?)`).run(campaign.id, campaign.ownerPrincipalId, campaign.createdAt);
    return campaign;
  }).immediate();
}

export function recordCompatibilityAdministrationAudit(
  db: DatabaseDriver.Database, campaignId: string, actorPrincipalId: string,
  type: "campaign_renamed" | "membership_added" | "room_attached" | "room_detached",
  payload: object, result: object, occurredAt: string,
): void {
  const row = db.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(campaignId) as { administration_revision: number };
  const before = revisionSchema.parse(row.administration_revision), after = before + 1;
  const identity = createHash("sha256").update(`${campaignId}:${type}:${before}:${JSON.stringify(payload)}`).digest("hex");
  const commandId = `compat-command-${identity.slice(0, 32)}`, eventId = `compat-event-${identity.slice(32)}`;
  const key = `compat-${identity.slice(0, 40)}`, data = JSON.stringify(payload);
  db.prepare(`INSERT INTO campaign_administration_commands
    (command_id,campaign_id,idempotency_key,actor_principal_id,expected_revision,type,payload,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(commandId, campaignId, key, actorPrincipalId, before, type, data, occurredAt);
  db.prepare("UPDATE campaigns SET administration_revision=? WHERE id=? AND administration_revision=?").run(after, campaignId, before);
  db.prepare(`INSERT INTO campaign_administration_events
    (event_id,campaign_id,command_id,revision_before,revision,type,public_data,private_data,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(eventId, campaignId, commandId, before, after, type, data, data, occurredAt);
  db.prepare(`INSERT INTO campaign_administration_receipts
    (command_id,campaign_id,event_id,type,revision_before,revision_after,result_data) VALUES (?,?,?,?,?,?,?)`)
    .run(commandId, campaignId, eventId, type, before, after, JSON.stringify(result));
}

export function renameCampaignSync(
  db: DatabaseDriver.Database, clock: Clock, actorPrincipalId: string, campaignId: string, input: RenameCampaignInput,
): Campaign {
  const actorId = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(campaignId);
  const normalized = renameCampaignInputSchema.parse(input);
  return db.transaction(() => {
    const campaign = db.prepare(`SELECT id, name, active_timeline_id, owner_principal_id, created_at, updated_at
      FROM campaigns WHERE id = ?`).get(id) as CampaignRow | undefined;
    if (!campaign) throw new Error("campaign not found");
    if (campaign.owner_principal_id !== actorId) throw new Error("campaign rename requires the campaign owner");
    const updatedAt = utcIsoTimestampSchema.parse(clock.now().toISOString());
    if (updatedAt < campaign.updated_at) throw new Error("campaign rename timestamp cannot precede campaign updated_at");
    const updated = db.prepare(`UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?
      RETURNING id, name, active_timeline_id, owner_principal_id, created_at, updated_at`)
      .get(normalized.name, updatedAt, id) as CampaignRow;
    return toCampaign(updated);
  }).immediate();
}

export function renameCampaignIfUnchangedSync(
  db: DatabaseDriver.Database, clock: Clock, actorPrincipalId: string, campaignId: string, input: CampaignRenameRequest,
): Campaign {
  return db.transaction(() => {
    const actorId = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(campaignId);
    const normalized = campaignRenameRequestSchema.parse(input);
    const row = db.prepare(`SELECT id, name, active_timeline_id, owner_principal_id, created_at, updated_at
      FROM campaigns WHERE id = ?`).get(id) as CampaignRow | undefined;
    if (!row) throw new CampaignRenameUnavailableError();
    if (row.owner_principal_id !== actorId) throw new CampaignRenameUnavailableError();
    let campaign: Campaign;
    try { campaign = toCampaign(row); if (campaign.updatedAt < campaign.createdAt) throw new Error(); }
    catch { throw new Error("campaign rename campaign invariant is malformed"); }
    const ownerRows = db.prepare(`SELECT membership.campaign_id, membership.principal_id, membership.role,
        membership.created_at, principal.id AS principal_parent_id FROM campaign_memberships membership
      LEFT JOIN principals principal ON principal.id = membership.principal_id
      WHERE membership.campaign_id = ? AND membership.role = 'owner' ORDER BY membership.principal_id COLLATE BINARY`)
      .all(id) as CampaignOwnerIntegrityRow[];
    try {
      if (ownerRows.length !== 1) throw new Error();
      const ownerRow = ownerRows[0]!;
      const owner = campaignMembershipReadSchema.parse({ campaignId: ownerRow.campaign_id, principalId: ownerRow.principal_id,
        role: ownerRow.role, createdAt: ownerRow.created_at });
      if (owner.role !== "owner" || owner.campaignId !== campaign.id || owner.principalId !== campaign.ownerPrincipalId
        || ownerRow.principal_parent_id !== owner.principalId) throw new Error();
    } catch { throw new Error("campaign rename owner invariant is malformed"); }
    if (campaign.updatedAt !== normalized.expectedUpdatedAt) throw new CampaignRenameStaleError();
    const clockAt = utcIsoTimestampSchema.parse(clock.now().toISOString());
    const nextMillis = Date.parse(campaign.updatedAt) + 1;
    if (!Number.isSafeInteger(nextMillis)) throw new Error("campaign rename timestamp cannot advance");
    const updatedAt = utcIsoTimestampSchema.parse(new Date(Math.max(Date.parse(clockAt), nextMillis)).toISOString());
    const result = db.prepare("UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ? AND updated_at = ?")
      .run(normalized.name, updatedAt, id, campaign.updatedAt);
    if (result.changes !== 1) throw new CampaignRenameStaleError();
    const updated = db.prepare(`SELECT id, name, active_timeline_id, owner_principal_id, created_at, updated_at
      FROM campaigns WHERE id = ?`).get(id) as CampaignRow | undefined;
    if (!updated) throw new Error("campaign rename output is missing");
    const output = toCampaign(updated);
    if (output.id !== campaign.id || output.name !== normalized.name || output.activeTimelineId !== campaign.activeTimelineId
      || output.ownerPrincipalId !== campaign.ownerPrincipalId || output.createdAt !== campaign.createdAt || output.updatedAt !== updatedAt) {
      throw new Error("campaign rename output is malformed");
    }
    return output;
  }).immediate();
}

export function addCampaignMembershipSync(
  db: DatabaseDriver.Database, clock: Clock, actorPrincipalId: string, campaignId: string, input: AddCampaignMembershipInput,
): CampaignMembership {
  const actorId = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(campaignId);
  const normalized = addCampaignMembershipInputSchema.parse(input);
  return db.transaction(() => {
    const campaign = db.prepare("SELECT owner_principal_id, updated_at FROM campaigns WHERE id = ?").get(id) as { owner_principal_id: string; updated_at: string } | undefined;
    if (!campaign) throw new Error("campaign not found");
    if (campaign.owner_principal_id !== actorId) throw new Error("campaign membership addition requires the campaign owner");
    if (!db.prepare("SELECT 1 FROM principals WHERE id = ?").get(normalized.principalId)) throw new Error("target principal not found");
    const existing = db.prepare(`SELECT campaign_id, principal_id, role, created_at FROM campaign_memberships
      WHERE campaign_id = ? AND principal_id = ?`).get(id, normalized.principalId) as CampaignMembershipRow | undefined;
    if (existing) {
      if (existing.role === normalized.role) return toCampaignMembership(existing);
      if (existing.role === "owner") throw new Error("campaign owner cannot receive a member role");
      throw new Error("campaign principal already has a different membership role");
    }
    if (normalized.principalId === campaign.owner_principal_id) throw new Error("campaign owner cannot receive a member role");
    const createdAt = utcIsoTimestampSchema.parse(clock.now().toISOString());
    if (createdAt < campaign.updated_at) throw new Error("campaign membership timestamp cannot precede campaign updated_at");
    const membership = campaignMembershipSchema.parse({ campaignId: id, principalId: normalized.principalId,
      role: normalized.role, createdAt });
    db.prepare("INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)")
      .run(id, membership.principalId, membership.role, membership.createdAt);
    db.prepare("UPDATE campaigns SET updated_at = ? WHERE id = ?").run(membership.createdAt, id);
    return membership;
  }).immediate();
}

export function attachCampaignSessionSync(
  db: DatabaseDriver.Database, clock: Clock, actorPrincipalId: string, input: AttachCampaignSessionInput,
): CampaignSessionAttachment {
  const actorId = resourceIdSchema.parse(actorPrincipalId), normalized = attachCampaignSessionInputSchema.parse(input);
  return db.transaction(() => {
    const campaign = db.prepare(`SELECT campaign.owner_principal_id, campaign.owner_role,
        actor_membership.campaign_id AS actor_campaign_id, actor_membership.principal_id AS actor_principal_id,
        actor_membership.role AS actor_role, actor_membership.created_at AS actor_created_at, actor_principal.id AS actor_parent_id,
        owner_membership.campaign_id AS owner_campaign_id, owner_membership.principal_id AS owner_principal_parent_id,
        owner_membership.role AS owner_membership_role, owner_membership.created_at AS owner_created_at, owner_principal.id AS owner_parent_id,
        (SELECT COUNT(*) FROM campaign_memberships sole_owner WHERE sole_owner.campaign_id = campaign.id AND sole_owner.role = 'owner') AS owner_count
      FROM campaigns campaign LEFT JOIN campaign_memberships actor_membership
        ON actor_membership.campaign_id = campaign.id AND actor_membership.principal_id = ?
      LEFT JOIN principals actor_principal ON actor_principal.id = actor_membership.principal_id
      LEFT JOIN campaign_memberships owner_membership ON owner_membership.campaign_id = campaign.id
        AND owner_membership.principal_id = campaign.owner_principal_id AND owner_membership.role = 'owner'
      LEFT JOIN principals owner_principal ON owner_principal.id = owner_membership.principal_id WHERE campaign.id = ?`)
      .get(actorId, normalized.campaignId) as { owner_principal_id: string; owner_role: string; actor_campaign_id: string | null;
        actor_principal_id: string | null; actor_role: string | null; actor_created_at: string | null; actor_parent_id: string | null;
        owner_campaign_id: string | null; owner_principal_parent_id: string | null; owner_membership_role: string | null;
        owner_created_at: string | null; owner_parent_id: string | null; owner_count: unknown } | undefined;
    if (!campaign) throw new CampaignSessionAttachmentUnavailableError("campaign not found");
    if (campaign.owner_principal_id !== actorId || campaign.actor_campaign_id !== normalized.campaignId
      || campaign.actor_principal_id !== actorId || campaign.actor_role !== "owner" || campaign.actor_parent_id !== actorId) {
      throw new CampaignSessionAttachmentUnavailableError();
    }
    try { campaignMembershipReadSchema.parse({ campaignId: normalized.campaignId, principalId: actorId, role: campaign.actor_role, createdAt: campaign.actor_created_at }); }
    catch { throw new Error("campaign owner authority is malformed"); }
    if (campaign.owner_role !== "owner" || campaign.owner_count !== 1 || campaign.owner_campaign_id !== normalized.campaignId
      || campaign.owner_principal_parent_id !== campaign.owner_principal_id || campaign.owner_membership_role !== "owner"
      || campaign.owner_parent_id !== campaign.owner_principal_id) throw new Error("campaign owner authority is malformed");
    try { campaignMembershipReadSchema.parse({ campaignId: normalized.campaignId, principalId: campaign.owner_principal_id, role: campaign.owner_membership_role, createdAt: campaign.owner_created_at }); }
    catch { throw new Error("campaign owner authority is malformed"); }
    const existing = db.prepare(`SELECT attachment.campaign_id, attachment.session_id, attachment.attached_at
      FROM campaign_sessions attachment WHERE attachment.session_id = ?`).get(normalized.sessionId) as CampaignSessionAttachmentRow | undefined;
    if (existing && existing.campaign_id !== normalized.campaignId) throw new CampaignSessionAttachmentConflictError("session is already attached to a different campaign");
    let existingAttachment: CampaignSessionAttachment | null = null;
    if (existing) { try { existingAttachment = toCampaignSessionAttachment(existing); } catch { throw new Error("campaign session attachment is malformed"); } }
    const lifecycle = createCampaignRoomSessionLifecycleRepository(db).getCampaignRoomSessionLifecycle(normalized.sessionId);
    if (lifecycle === null) { if (existing) throw new Error("campaign session attachment has no session parent"); throw new CampaignSessionAttachmentSessionMissingError(); }
    if (existingAttachment) return existingAttachment;
    if (lifecycle === "stopped") throw new CampaignSessionAttachmentConflictError("stopped sessions cannot be attached to campaigns");
    const attachedAt = utcIsoTimestampSchema.parse(clock.now().toISOString());
    db.prepare("INSERT INTO campaign_sessions (campaign_id, session_id, attached_at) VALUES (?, ?, ?)").run(normalized.campaignId, normalized.sessionId, attachedAt);
    return campaignSessionAttachmentSchema.parse({ campaignId: normalized.campaignId, sessionId: normalized.sessionId, attachedAt });
  }).immediate();
}

export function detachCampaignSessionSync(
  db: DatabaseDriver.Database, actorPrincipalId: string, input: DetachCampaignSessionInput,
): CampaignSessionAttachment | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId), normalized = detachCampaignSessionInputSchema.parse(input);
  return db.transaction(() => {
    const campaign = db.prepare("SELECT owner_principal_id FROM campaigns WHERE id = ?").get(normalized.campaignId) as { owner_principal_id: string } | undefined;
    if (!campaign) throw new Error("campaign not found");
    if (campaign.owner_principal_id !== actorId) throw new Error("campaign session detachment requires the campaign owner");
    const detached = db.prepare(`DELETE FROM campaign_sessions WHERE campaign_id = ? AND session_id = ?
      RETURNING campaign_id, session_id, attached_at`).get(normalized.campaignId, normalized.sessionId) as CampaignSessionAttachmentRow | undefined;
    return detached ? toCampaignSessionAttachment(detached) : null;
  }).immediate();
}

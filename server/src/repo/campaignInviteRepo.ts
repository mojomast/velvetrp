import { createHash, randomBytes } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import {
  campaignMemberRoleSchema,
  resourceIdSchema,
  type CampaignInviteCreateRequest,
  type CampaignInviteCreateResponse,
  type CampaignInviteRedeemResponse,
} from "@velvet/contracts";
import { getRepositoryDatabase } from "./repoContext.js";

const INVITE_LIFETIME_MS = 60 * 60 * 24 * 7;

export class CampaignInviteForbiddenError extends Error {
  readonly code = "CAMPAIGN_INVITE_FORBIDDEN";
}

export class CampaignInviteNotFoundError extends Error {
  readonly code = "CAMPAIGN_INVITE_NOT_FOUND";
}

export class CampaignInviteStaleError extends Error {
  readonly code = "CAMPAIGN_INVITE_STALE";
}

export class CampaignInviteConflictError extends Error {
  readonly code = "CAMPAIGN_INVITE_CONFLICT";
}

export class CampaignInviteInvalidError extends Error {
  readonly code = "CAMPAIGN_INVITE_INVALID";
}

export interface CampaignInviteRepository {
  createCampaignInvite(
    principalId: string,
    campaignId: string,
    input: CampaignInviteCreateRequest,
  ): CampaignInviteCreateResponse;
  redeemCampaignInvite(token: string): CampaignInviteRedeemResponse;
  listCampaignMemberships(principalId: string, campaignId: string): unknown[];
}

interface CampaignInviteRow {
  invite_id: string;
  campaign_id: string;
  role: string;
  expires_at: string;
  redeemed_at: string | null;
}

interface MembershipRow {
  role: string;
}

interface CampaignRow {
  administration_revision: unknown;
}

interface IdempotencyRow {
  invite_id: string;
}

/** Creates the campaign invite repository over a caller-owned SQLite connection. */
export function createCampaignInviteRepository(db: DatabaseDriver.Database): CampaignInviteRepository {
  return {
    createCampaignInvite(principalId, campaignId, input) {
      const actor = resourceIdSchema.parse(principalId);
      const id = resourceIdSchema.parse(campaignId);
      const role = campaignMemberRoleSchema.parse(input.role);

      const membership = db
        .prepare("SELECT role FROM campaign_memberships WHERE campaign_id = ? AND principal_id = ?")
        .get(id, actor) as MembershipRow | undefined;
      if (membership === undefined || (membership.role !== "owner" && membership.role !== "gm")) {
        throw new CampaignInviteForbiddenError();
      }

      const campaign = db.prepare("SELECT administration_revision FROM campaigns WHERE id = ?").get(id) as
        CampaignRow | undefined;
      if (campaign === undefined) throw new CampaignInviteNotFoundError();
      if (Number(campaign.administration_revision) !== input.expectedRevision) throw new CampaignInviteStaleError();

      const duplicate = db
        .prepare("SELECT invite_id FROM campaign_invites_v1 WHERE campaign_id = ? AND idempotency_key = ?")
        .get(id, input.idempotencyKey) as IdempotencyRow | undefined;
      if (duplicate !== undefined) throw new CampaignInviteConflictError();

      const token = randomBytes(32).toString("base64url");
      const tokenDigest = createHash("sha256").update(token).digest("hex");
      const inviteId = `invite-${randomBytes(12).toString("hex")}`;
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + INVITE_LIFETIME_MS).toISOString();

      db.prepare(
        `INSERT INTO campaign_invites_v1 (
          invite_id, campaign_id, role, token_digest, created_by_principal_id, idempotency_key, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(inviteId, id, role, tokenDigest, actor, input.idempotencyKey, createdAt.toISOString(), expiresAt);

      return { inviteId, role, expiresAt, token };
    },

    redeemCampaignInvite(token) {
      const tokenDigest = createHash("sha256").update(token).digest("hex");
      const invite = db
        .prepare(
          `SELECT invite_id, campaign_id, role, expires_at, redeemed_at
            FROM campaign_invites_v1 WHERE token_digest = ?`,
        )
        .get(tokenDigest) as CampaignInviteRow | undefined;
      if (invite === undefined || invite.redeemed_at !== null) throw new CampaignInviteInvalidError();
      if (Date.parse(invite.expires_at) <= Date.now()) throw new CampaignInviteInvalidError();

      const role = campaignMemberRoleSchema.parse(invite.role);
      const principalId = `${role}-${randomBytes(12).toString("hex")}`;
      const redeemedAt = new Date().toISOString();

      db.transaction(() => {
        db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(
          principalId,
          `Invited ${role}`,
        );
        db.prepare(
          "INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
        ).run(invite.campaign_id, principalId, role, redeemedAt);
        const updated = db
          .prepare(
            `UPDATE campaign_invites_v1 SET redeemed_at = ?, redeemed_principal_id = ?
              WHERE invite_id = ? AND redeemed_at IS NULL`,
          )
          .run(redeemedAt, principalId, invite.invite_id);
        if (updated.changes !== 1) throw new CampaignInviteInvalidError();
      })();

      return { principalId, role };
    },

    listCampaignMemberships(principalId, campaignId) {
      const actor = resourceIdSchema.parse(principalId);
      const id = resourceIdSchema.parse(campaignId);
      return db
        .prepare(
          `SELECT campaign_id AS campaignId, principal_id AS principalId, role
            FROM campaign_memberships WHERE campaign_id = ? AND principal_id = ?`,
        )
        .all(id, actor) as unknown[];
    },
  };
}

let sharedRepository: CampaignInviteRepository | null = null;

/** Lazily binds the invite repository to the process repository database. */
export function getCampaignInviteRepository(): CampaignInviteRepository {
  sharedRepository ??= createCampaignInviteRepository(getRepositoryDatabase());
  return sharedRepository;
}

import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  COMPANION_GRANT_EXERCISE_UNAVAILABLE,
  canonicalAgentJson,
  companionAdministrationReceiptSchema,
  companionManagementProjectionSchema,
  companionPublicProjectionSchema,
  createCompanionGrantInputSchema,
  createCompanionInputSchema,
  resourceIdSchema,
  revokeCompanionGrantInputSchema,
  utcIsoTimestampSchema,
  type CompanionAdministrationReceipt,
  type CompanionCommandFamily,
  type CompanionManagementProjection,
  type CompanionPublicProjection,
  type CreateCompanionGrantInput,
  type CreateCompanionInput,
  type RevokeCompanionGrantInput,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../runtime.js";
import { createCampaignRoomSessionLifecycleRepository } from "./campaign/campaignRoomSessionLifecycleRepo.js";
import { createNpcPresenceReadRepository } from "./world/npcPresenceReadRepo.js";

export class CompanionAuthorizationError extends Error { readonly code = "COMPANION_FORBIDDEN"; }
export class CompanionConflictError extends Error { readonly code = "COMPANION_CONFLICT"; }
export class CompanionStaleError extends Error { readonly code = "COMPANION_STALE"; }
export class CompanionUnavailableError extends Error { readonly code = "COMPANION_UNAVAILABLE"; }

export interface CompanionReadRepository {
  getCompanionManagement(principalId: string, campaignId: string, npcId: string): CompanionManagementProjection | null;
  getCompanionPublic(principalId: string, campaignId: string, npcId: string): CompanionPublicProjection | null;
}

export interface CompanionRepository extends CompanionReadRepository {
  createCompanion(principalId: string, campaignId: string, input: CreateCompanionInput): CompanionAdministrationReceipt;
  createCompanionGrant(principalId: string, campaignId: string, input: CreateCompanionGrantInput): CompanionAdministrationReceipt;
  revokeCompanionGrant(principalId: string, campaignId: string, input: RevokeCompanionGrantInput): CompanionAdministrationReceipt;
}

type Role = "owner" | "gm" | "player" | "observer";
type CompanionRow = {
  campaign_id: string; npc_id: string; initial_session_id: string; state: "active" | "dismissed"; revision: number;
  created_at: string; updated_at: string; create_command_id: string; create_receipt_id: string;
  create_revision: number; create_command_kind: string; create_payload_digest: string;
  last_command_id: string; last_receipt_id: string; last_command_kind: string; last_payload_digest: string;
};
type GrantRow = {
  grant_id: string; campaign_id: string; npc_id: string; granted_by_principal_id: string;
  grantee_principal_id: string; actor_id: string; resource_scope_kind: "none" | "actor-resources" | "wallet" | "inventory" | "powers";
  confirmation_policy: "always" | "domain-policy"; primary_command_family: CompanionCommandFamily;
  max_spend: number | null; max_uses: number | null; starts_at: string; expires_at: string;
  created_command_id: string; created_receipt_id: string; created_revision: number; created_command_kind: string;
  created_payload_digest: string; created_at: string; revoked_at: string | null; revocation_reason: string | null;
  revoked_by_principal_id: string | null; revoked_command_id: string | null; revoked_receipt_id: string | null;
  revoked_revision: number | null; revoked_command_kind: string | null; revoked_payload_digest: string | null;
};

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const malformed = (): never => { throw new Error("companion scoped graph integrity is inconsistent"); };

/** Repository-only administration and role-safe reads over the immutable v45 sidecars. */
export function createCompanionRepository(
  db: DatabaseDriver.Database,
  dependencies: { clock: Clock; ids: IdGenerator },
  guard: (operation: "read" | "write") => void,
): CompanionRepository {
  const presence = createNpcPresenceReadRepository(db, { guard: () => undefined });
  const lifecycle = createCampaignRoomSessionLifecycleRepository(db);
  const membership = (principalId: string, campaignId: string): Role | null => {
    const row = db.prepare(`SELECT membership.role FROM campaign_memberships membership
      JOIN principals principal ON principal.id=membership.principal_id
      JOIN campaigns campaign ON campaign.id=membership.campaign_id
      WHERE membership.campaign_id=? AND membership.principal_id=?`)
      .get(campaignId, principalId) as { role: Role } | undefined;
    return row?.role ?? null;
  };
  const requireManager = (principalId: string, campaignId: string): void => {
    if (!(["owner", "gm"] as Role[]).includes(membership(principalId, campaignId) as Role)) {
      throw new CompanionAuthorizationError("owner or GM authority is required");
    }
  };
  const companion = (campaignId: string, npcId: string): CompanionRow | undefined => db.prepare(`SELECT campaign_id,npc_id,
      initial_session_id,state,revision,created_at,updated_at,create_command_id,create_receipt_id,create_revision,
      create_command_kind,create_payload_digest,last_command_id,last_receipt_id,last_command_kind,last_payload_digest
    FROM campaign_companions_v45 WHERE campaign_id=? AND npc_id=?`).get(campaignId, npcId) as CompanionRow | undefined;

  const hasActorAncestry = (campaignId: string, actorId: string): boolean => {
    const row = db.prepare(`SELECT 1 FROM campaign_actors actor
      JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
      JOIN characters persona ON persona.id=character.character_id
      JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=actor.campaign_id AND sheet.id=actor.sheet_id
        AND sheet.campaign_character_id=actor.campaign_character_id
      JOIN campaign_actor_private_state private ON private.campaign_id=actor.campaign_id AND private.actor_id=actor.id
      JOIN campaign_memberships controller ON controller.campaign_id=private.campaign_id
        AND controller.principal_id=private.controller_principal_id
      JOIN principals controller_parent ON controller_parent.id=private.controller_principal_id
      WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId, actorId);
    return Boolean(row);
  };

  const grantRows = (campaignId: string, npcId: string): GrantRow[] => db.prepare(`SELECT grant.grant_id,grant.campaign_id,
      grant.npc_id,grant.granted_by_principal_id,grant.grantee_principal_id,grant.actor_id,grant.resource_scope_kind,
      grant.confirmation_policy,grant.primary_command_family,grant.max_spend,grant.max_uses,grant.starts_at,grant.expires_at,
      grant.created_command_id,grant.created_receipt_id,grant.created_revision,grant.created_command_kind,
      grant.created_payload_digest,grant.created_at,revocation.revoked_at,revocation.revocation_reason,
      revocation.revoked_by_principal_id,revocation.revoked_command_id,revocation.revoked_receipt_id,
      revocation.revoked_revision,revocation.revoked_command_kind,revocation.revoked_payload_digest
    FROM companion_grants_v45 grant LEFT JOIN companion_grant_revocations_v45 revocation ON revocation.grant_id=grant.grant_id
      AND revocation.campaign_id=grant.campaign_id AND revocation.npc_id=grant.npc_id
    WHERE grant.campaign_id=? AND grant.npc_id=? ORDER BY grant.created_revision,grant.grant_id COLLATE BINARY`)
    .all(campaignId, npcId) as GrantRow[];

  type HistoryRow = {
    command_id: string; idempotency_key: string; principal_id: string;
    command_kind: "companion-create" | "grant-create" | "grant-revoke";
    expected_revision: number; resulting_revision: number; payload_json: string; payload_digest: string; created_at: string;
    receipt_id: string | null; receipt_key: string | null; receipt_kind: string | null; receipt_revision: number | null;
    command_payload_digest: string | null; outcome_json: string | null; outcome_digest: string | null;
    occurred_at: string | null; audit_id: string | null; event_kind: string | null; audit_command_id: string | null;
    audit_revision: number | null; audit_receipt_id: string | null; audit_kind: string | null;
    audit_command_digest: string | null; audit_payload_json: string | null; audit_payload_digest: string | null;
    audit_occurred_at: string | null; principal_exists: number;
  };

  const parseCanonical = (json: string | null, digest: string | null): Record<string, unknown> => {
    if (json === null || digest === null || hash(json) !== digest) malformed();
    let value: unknown;
    try { value = JSON.parse(json!); } catch { malformed(); }
    if (json !== canonicalAgentJson(value as never) || value === null || typeof value !== "object" || Array.isArray(value)) malformed();
    return value as Record<string, unknown>;
  };

  const assertScopedIntegrity = (campaignId: string, npcId: string, root?: CompanionRow): Map<string, CompanionCommandFamily[]> => {
    const current = root ?? companion(campaignId, npcId);
    const counts = db.prepare(`SELECT
      (SELECT count(*) FROM companion_commands_v45 WHERE campaign_id=? AND npc_id=?) commands,
      (SELECT count(*) FROM companion_receipts_v45 WHERE campaign_id=? AND npc_id=?) receipts,
      (SELECT count(*) FROM companion_audit_events_v45 WHERE campaign_id=? AND npc_id=?) audits`)
      .get(campaignId, npcId, campaignId, npcId, campaignId, npcId) as { commands: number; receipts: number; audits: number };
    if (!current) {
      if (counts.commands || counts.receipts || counts.audits) malformed();
      return new Map();
    }
    if (counts.commands !== current.revision || counts.receipts !== current.revision || counts.audits !== current.revision) malformed();
    const commands = db.prepare(`SELECT command.command_id,command.idempotency_key,command.principal_id,command.command_kind,
        command.expected_revision,command.resulting_revision,command.payload_json,command.payload_digest,command.created_at,
        receipt.receipt_id,receipt.idempotency_key receipt_key,receipt.command_kind receipt_kind,
        receipt.resulting_revision receipt_revision,receipt.command_payload_digest,receipt.outcome_json,receipt.outcome_digest,
        receipt.occurred_at,audit.audit_id,audit.event_kind,audit.command_id audit_command_id,
        audit.resulting_revision audit_revision,audit.receipt_id audit_receipt_id,audit.command_kind audit_kind,
        audit.command_payload_digest audit_command_digest,audit.payload_json audit_payload_json,
        audit.payload_digest audit_payload_digest,audit.occurred_at audit_occurred_at,
        EXISTS(SELECT 1 FROM principals principal WHERE principal.id=command.principal_id) principal_exists
      FROM companion_commands_v45 command
      LEFT JOIN companion_receipts_v45 receipt ON receipt.campaign_id=command.campaign_id AND receipt.npc_id=command.npc_id
        AND receipt.command_id=command.command_id
      LEFT JOIN companion_audit_events_v45 audit ON audit.campaign_id=command.campaign_id AND audit.npc_id=command.npc_id
        AND audit.command_id=command.command_id
      WHERE command.campaign_id=? AND command.npc_id=? ORDER BY command.resulting_revision`)
      .all(campaignId, npcId) as HistoryRow[];
    let previousAt: string | undefined;
    const payloads = new Map<number, Record<string, unknown>>();
    const outcomes = new Map<number, Record<string, unknown>>();
    for (let index = 0; index < commands.length; index += 1) {
      const row = commands[index]!, revision = index + 1;
      const payload = parseCanonical(row.payload_json, row.payload_digest);
      const outcome = parseCanonical(row.outcome_json, row.outcome_digest);
      const auditPayload = parseCanonical(row.audit_payload_json, row.audit_payload_digest);
      const eventKind = row.command_kind === "companion-create" ? "companion-created"
        : row.command_kind === "grant-create" ? "grant-created" : "grant-revoked";
      if (row.expected_revision !== revision - 1 || row.resulting_revision !== revision || !row.principal_exists
        || row.receipt_id === null || row.receipt_key !== row.idempotency_key || row.receipt_kind !== row.command_kind
        || row.receipt_revision !== revision || row.command_payload_digest !== row.payload_digest
        || row.occurred_at !== row.created_at || row.audit_id === null || row.event_kind !== eventKind
        || row.audit_command_id !== row.command_id || row.audit_revision !== revision || row.audit_receipt_id !== row.receipt_id
        || row.audit_kind !== row.command_kind || row.audit_command_digest !== row.payload_digest
        || canonicalAgentJson(auditPayload as never) !== canonicalAgentJson(outcome as never)
        || row.audit_occurred_at !== row.created_at
        || (previousAt !== undefined && row.created_at < previousAt)) malformed();
      payloads.set(revision, payload); outcomes.set(revision, outcome);
      previousAt = row.created_at;
    }
    const first = commands[0]!, last = commands.at(-1)!;
    if (current.create_revision !== 1 || current.create_command_kind !== "companion-create"
      || current.create_command_id !== first.command_id || current.create_receipt_id !== first.receipt_id
      || current.create_payload_digest !== first.payload_digest || current.last_command_id !== last.command_id
      || current.last_receipt_id !== last.receipt_id || current.last_command_kind !== last.command_kind
      || current.last_payload_digest !== last.payload_digest || current.created_at !== first.created_at
      || current.updated_at !== last.created_at) malformed();
    const link = db.prepare(`SELECT create_command_id,create_receipt_id,create_revision,create_command_kind,
      create_payload_digest,linked_at FROM companion_presence_links_v45 WHERE campaign_id=? AND session_id=? AND npc_id=?`)
      .get(campaignId, current.initial_session_id, npcId) as any;
    if (!link || link.create_command_id !== current.create_command_id || link.create_receipt_id !== current.create_receipt_id
      || link.create_revision !== 1 || link.create_command_kind !== "companion-create"
      || link.create_payload_digest !== current.create_payload_digest || link.linked_at !== current.created_at) malformed();

    const createPayload = createCompanionInputSchema.safeParse({ ...payloads.get(1), expectedRevision: 0,
      idempotencyKey: commands[0]!.idempotency_key });
    const expectedCreateOutcome = { npcId, sessionId: current.initial_session_id, state: "active", revision: 1 };
    if (!createPayload.success || createPayload.data.npcId !== npcId
      || createPayload.data.sessionId !== current.initial_session_id
      || canonicalAgentJson(outcomes.get(1) as never) !== canonicalAgentJson(expectedCreateOutcome)) malformed();

    const reconstructedFamilies = new Map<string, CompanionCommandFamily[]>();
    const seenGrantRevisions = new Set<number>();
    const seenRevocationRevisions = new Set<number>();
    for (const grant of grantRows(campaignId, npcId)) {
      const command = commands[grant.created_revision - 1];
      if (!command || command.command_kind !== "grant-create" || command.command_id !== grant.created_command_id
        || command.receipt_id !== grant.created_receipt_id || command.payload_digest !== grant.created_payload_digest
        || command.principal_id !== grant.granted_by_principal_id || grant.created_at !== command.created_at) malformed();
      const grantCommand = command!;
      if ((db.prepare("SELECT count(*) count FROM principals WHERE id IN (?,?)")
        .get(grant.granted_by_principal_id, grant.grantee_principal_id) as { count: number }).count !== 2) malformed();
      const payload = createCompanionGrantInputSchema.safeParse({ ...payloads.get(grant.created_revision),
        expectedRevision: grantCommand.expected_revision, idempotencyKey: grantCommand.idempotency_key });
      if (!payload.success || payload.data.npcId !== npcId || payload.data.granteePrincipalId !== grant.grantee_principal_id
        || payload.data.actorScope.actorId !== grant.actor_id || payload.data.resourceScope.kind !== grant.resource_scope_kind
        || payload.data.confirmationPolicy !== grant.confirmation_policy || payload.data.maxSpend !== grant.max_spend
        || payload.data.maxUses !== grant.max_uses || payload.data.startsAt !== grant.starts_at
        || payload.data.expiresAt !== grant.expires_at || grant.primary_command_family !== payload.data.allowedCommandFamilies[0]) malformed();
      const grantPayload = payload.data!;
      const childFamilies = (db.prepare(`SELECT command_family FROM companion_grant_command_families_v45
        WHERE grant_id=? ORDER BY command_family COLLATE BINARY`).all(grant.grant_id) as Array<{ command_family: CompanionCommandFamily }>)
        .map((row) => row.command_family);
      if (canonicalAgentJson(childFamilies as never)
        !== canonicalAgentJson([...grantPayload.allowedCommandFamilies].sort() as never)) malformed();
      reconstructedFamilies.set(grant.grant_id, grantPayload.allowedCommandFamilies);
      if (canonicalAgentJson(outcomes.get(grant.created_revision) as never)
        !== canonicalAgentJson({ grantId: grant.grant_id, npcId, revision: grant.created_revision })) malformed();
      seenGrantRevisions.add(grant.created_revision);
      if (grant.revoked_at !== null) {
        const revoked = commands[(grant.revoked_revision ?? 0) - 1];
        if (!revoked || revoked.command_kind !== "grant-revoke" || revoked.command_id !== grant.revoked_command_id
          || revoked.receipt_id !== grant.revoked_receipt_id || revoked.payload_digest !== grant.revoked_payload_digest
          || revoked.principal_id !== grant.revoked_by_principal_id || revoked.created_at !== grant.revoked_at) malformed();
        const revokeCommand = revoked!;
        if (!db.prepare("SELECT 1 FROM principals WHERE id=?").get(grant.revoked_by_principal_id)) malformed();
        const payload = revokeCompanionGrantInputSchema.safeParse({ ...payloads.get(grant.revoked_revision!),
          expectedRevision: revokeCommand.expected_revision, idempotencyKey: revokeCommand.idempotency_key });
        if (!payload.success || payload.data.npcId !== npcId || payload.data.grantId !== grant.grant_id
          || payload.data.reason !== grant.revocation_reason
          || canonicalAgentJson(outcomes.get(grant.revoked_revision!) as never) !== canonicalAgentJson({
            grantId: grant.grant_id, npcId, revision: grant.revoked_revision, revokedAt: grant.revoked_at,
          })) malformed();
        seenRevocationRevisions.add(grant.revoked_revision!);
      } else if ([grant.revocation_reason, grant.revoked_by_principal_id, grant.revoked_command_id,
        grant.revoked_receipt_id, grant.revoked_revision, grant.revoked_command_kind, grant.revoked_payload_digest]
        .some((value) => value !== null)) malformed();
    }
    for (const command of commands) {
      if (command.command_kind === "grant-create" && !seenGrantRevisions.has(command.resulting_revision)) malformed();
      if (command.command_kind === "grant-revoke" && !seenRevocationRevisions.has(command.resulting_revision)) malformed();
    }
    return reconstructedFamilies;
  };

  const persistedReceipt = (campaignId: string, npcId: string, key: string): CompanionAdministrationReceipt | null => {
    const row = db.prepare(`SELECT receipt.receipt_id,receipt.command_id,receipt.campaign_id,receipt.npc_id,
      receipt.idempotency_key,receipt.command_kind,receipt.resulting_revision,receipt.command_payload_digest,
      receipt.outcome_json,receipt.outcome_digest,receipt.occurred_at FROM companion_receipts_v45 receipt
      WHERE receipt.campaign_id=? AND receipt.npc_id=? AND receipt.idempotency_key=?`).get(campaignId, npcId, key) as any;
    return row ? companionAdministrationReceiptSchema.parse({ receiptId: row.receipt_id, commandId: row.command_id,
      campaignId: row.campaign_id, npcId: row.npc_id, idempotencyKey: row.idempotency_key, kind: row.command_kind,
      resultingRevision: row.resulting_revision, commandPayloadDigest: row.command_payload_digest,
      outcome: JSON.parse(row.outcome_json), outcomeDigest: row.outcome_digest, occurredAt: row.occurred_at }) : null;
  };

  const execute = (principalId: string, campaignId: string, npcId: string, kind: "companion-create" | "grant-create" | "grant-revoke",
    expectedRevision: number, idempotencyKey: string, payload: Record<string, unknown>,
    prepare: (context: { commandId: string; receiptId: string; auditId: string; at: string; revision: number; payloadDigest: string }) => Record<string, unknown>,
    persist: (context: { commandId: string; receiptId: string; auditId: string; at: string; revision: number; payloadDigest: string }, outcome: Record<string, unknown>) => void,
  ): CompanionAdministrationReceipt => {
    const principal = resourceIdSchema.parse(principalId), campaign = resourceIdSchema.parse(campaignId);
    const payloadJson = canonicalAgentJson(payload as never), payloadDigest = hash(payloadJson);
    return db.transaction(() => {
      const replay = db.prepare(`SELECT command_kind,principal_id,expected_revision,payload_digest FROM companion_commands_v45
        WHERE campaign_id=? AND npc_id=? AND idempotency_key=?`).get(campaign, npcId, idempotencyKey) as any;
      if (replay) {
        const exact = replay.command_kind === kind && replay.principal_id === principal
          && replay.expected_revision === expectedRevision && replay.payload_digest === payloadDigest;
        if (exact) {
          assertScopedIntegrity(campaign, npcId);
          const receipt = persistedReceipt(campaign, npcId, idempotencyKey);
          if (!receipt) malformed();
          return receipt!;
        }
        requireManager(principal, campaign);
        throw new CompanionConflictError("idempotency key was reused");
      }
      requireManager(principal, campaign);
      const current = companion(campaign, npcId);
      assertScopedIntegrity(campaign, npcId, current);
      const before = current?.revision ?? 0;
      if (before !== expectedRevision) throw new CompanionStaleError("companion revision is stale");
      const commandId = resourceIdSchema.parse(dependencies.ids.nextId());
      const receiptId = resourceIdSchema.parse(dependencies.ids.nextId());
      const auditId = resourceIdSchema.parse(dependencies.ids.nextId());
      const clockAt = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
      const at = utcIsoTimestampSchema.parse(new Date(Math.max(Date.parse(clockAt), Date.parse(current?.updated_at ?? clockAt))).toISOString());
      const revision = before + 1;
      db.prepare(`INSERT INTO companion_commands_v45 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(campaign, npcId, commandId,
        idempotencyKey, principal, kind, before, revision, payloadJson, payloadDigest, at);
      const context = { commandId, receiptId, auditId, at, revision, payloadDigest };
      const outcome = prepare(context);
      const outcomeJson = canonicalAgentJson(outcome as never), outcomeDigest = hash(outcomeJson);
      db.prepare(`INSERT INTO companion_receipts_v45 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(receiptId, campaign, npcId,
        commandId, idempotencyKey, kind, revision, payloadDigest, outcomeJson, outcomeDigest, at);
      persist(context, outcome);
      const eventKind = kind === "companion-create" ? "companion-created" : kind === "grant-create" ? "grant-created" : "grant-revoked";
      db.prepare(`INSERT INTO companion_audit_events_v45 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(auditId, campaign, npcId,
        eventKind, commandId, revision, receiptId, kind, payloadDigest, outcomeJson, outcomeDigest, at);
      return companionAdministrationReceiptSchema.parse({ receiptId, commandId, campaignId: campaign, npcId,
        idempotencyKey, kind, resultingRevision: revision, commandPayloadDigest: payloadDigest,
        outcome, outcomeDigest, occurredAt: at });
    }).immediate();
  };

  const management = (campaignId: string, npcId: string, root: CompanionRow,
    familyOrder: Map<string, CompanionCommandFamily[]>): CompanionManagementProjection => {
    const grants = grantRows(campaignId, npcId).map((grant) => ({ grantId: grant.grant_id, campaignId, npcId,
      grantedByPrincipalId: grant.granted_by_principal_id, granteePrincipalId: grant.grantee_principal_id,
      allowedCommandFamilies: familyOrder.get(grant.grant_id) ?? malformed(),
      actorScope: { kind: "campaign-actor" as const, actorId: grant.actor_id },
      resourceScope: { kind: grant.resource_scope_kind }, maxSpend: grant.max_spend, maxUses: grant.max_uses,
      startsAt: grant.starts_at, expiresAt: grant.expires_at, confirmationPolicy: grant.confirmation_policy,
      revokedAt: grant.revoked_at, revocationReason: grant.revocation_reason, createdAt: grant.created_at,
      exercise: COMPANION_GRANT_EXERCISE_UNAVAILABLE }));
    return companionManagementProjectionSchema.parse({ campaignId, sessionId: root.initial_session_id, npcId,
      state: root.state, revision: root.revision, createdAt: root.created_at, updatedAt: root.updated_at, grants });
  };

  return {
    getCompanionManagement(principalId, campaignId, npcId) {
      guard("read");
      return db.transaction(() => {
        const role = membership(principalId, campaignId);
        if (role !== "owner" && role !== "gm") return null;
        const root = companion(campaignId, npcId), familyOrder = assertScopedIntegrity(campaignId, npcId, root);
        return root ? management(campaignId, npcId, root, familyOrder) : null;
      })();
    },
    getCompanionPublic(principalId, campaignId, npcId) {
      guard("read");
      return db.transaction(() => {
        if (!membership(principalId, campaignId)) return null;
        const root = companion(campaignId, npcId), familyOrder = assertScopedIntegrity(campaignId, npcId, root);
        if (!root) return null;
        const grants = (db.prepare(`SELECT grant.grant_id,grant.primary_command_family,grant.starts_at,grant.expires_at,
            revocation.revoked_at FROM companion_grants_v45 grant
          LEFT JOIN companion_grant_revocations_v45 revocation ON revocation.grant_id=grant.grant_id
          WHERE grant.campaign_id=? AND grant.npc_id=? ORDER BY grant.created_revision,grant.grant_id COLLATE BINARY`)
          .all(campaignId, npcId) as Array<{ grant_id: string; primary_command_family: CompanionCommandFamily;
            starts_at: string; expires_at: string; revoked_at: string | null }>).map((grant) => ({
              commandFamilies: familyOrder.get(grant.grant_id) ?? malformed(), startsAt: grant.starts_at,
              expiresAt: grant.expires_at, revokedAt: grant.revoked_at, exercise: COMPANION_GRANT_EXERCISE_UNAVAILABLE,
            }));
        return companionPublicProjectionSchema.parse({ npcId, state: root.state, grants });
      })();
    },
    createCompanion(principalId, campaignId, raw) {
      guard("write");
      const input = createCompanionInputSchema.parse(raw);
      return execute(principalId, campaignId, input.npcId, "companion-create", input.expectedRevision, input.idempotencyKey,
        { npcId: input.npcId, sessionId: input.sessionId }, ({ commandId, receiptId, at, revision, payloadDigest }) => {
          if (revision !== 1) throw new CompanionConflictError("companion already exists");
          if (!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?")
            .get(campaignId, input.sessionId)) throw new CompanionUnavailableError("session is not attached to the campaign");
          presence.assertScopedIntegrity(campaignId, input.sessionId);
          if (lifecycle.getCampaignRoomSessionLifecycle(input.sessionId) !== "running") {
            throw new CompanionUnavailableError("session is not running");
          }
          if (!db.prepare(`SELECT 1 FROM campaign_npc_presence_v43 WHERE campaign_id=? AND session_id=?
            AND npc_id=? AND state='present'`).get(campaignId, input.sessionId, input.npcId)) {
            throw new CompanionUnavailableError("NPC is not present in the attached session");
          }
          return { npcId: input.npcId, sessionId: input.sessionId, state: "active", revision };
        }, ({ commandId, receiptId, at, payloadDigest }) => {
          db.prepare(`INSERT INTO campaign_companions_v45 VALUES(?,?,?,'active',1,?,?,?,?,?,?,?,?,?,?,?)`).run(campaignId,
            input.npcId, input.sessionId, at, at, commandId, receiptId, 1, "companion-create", payloadDigest,
            commandId, receiptId, "companion-create", payloadDigest);
          db.prepare(`INSERT INTO companion_presence_links_v45 VALUES(?,?,?,?,?,?,?,?,?)`).run(campaignId, input.sessionId,
            input.npcId, commandId, receiptId, 1, "companion-create", payloadDigest, at);
        });
    },
    createCompanionGrant(principalId, campaignId, raw) {
      guard("write");
      const input = createCompanionGrantInputSchema.parse(raw);
      const payload = { actorScope: input.actorScope, allowedCommandFamilies: input.allowedCommandFamilies,
        confirmationPolicy: input.confirmationPolicy, expiresAt: input.expiresAt, granteePrincipalId: input.granteePrincipalId,
        maxSpend: input.maxSpend, maxUses: input.maxUses, npcId: input.npcId, resourceScope: input.resourceScope,
        startsAt: input.startsAt };
      return execute(principalId, campaignId, input.npcId, "grant-create", input.expectedRevision, input.idempotencyKey,
        payload, ({ commandId, receiptId, at, revision, payloadDigest }) => {
          const root = companion(campaignId, input.npcId);
          if (!root || root.state !== "active") throw new CompanionUnavailableError("active companion is unavailable");
          if (input.granteePrincipalId === principalId) throw new CompanionConflictError("companion grants cannot be self-grants");
          if (!db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
            .get(campaignId, input.granteePrincipalId)) throw new CompanionUnavailableError("grantee is not a campaign member");
          if (!hasActorAncestry(campaignId, input.actorScope.actorId)) {
            throw new CompanionUnavailableError("actor ancestry is unavailable");
          }
          if (input.expiresAt <= at) throw new CompanionConflictError("grant expiry must be in the future");
          const grantId = resourceIdSchema.parse(dependencies.ids.nextId());
          return { grantId, npcId: input.npcId, revision };
        }, ({ commandId, receiptId, at, revision, payloadDigest }, outcome) => {
          const grantId = resourceIdSchema.parse(outcome.grantId);
          for (const family of input.allowedCommandFamilies) db.prepare(`INSERT INTO companion_grant_command_families_v45
            VALUES(?,?,?,?)`).run(grantId, campaignId, input.npcId, family);
          db.prepare(`INSERT INTO companion_grants_v45 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(grantId,
            campaignId, input.npcId, principalId, input.granteePrincipalId, input.actorScope.actorId, input.resourceScope.kind,
            input.confirmationPolicy, input.allowedCommandFamilies[0], input.maxSpend, input.maxUses, input.startsAt,
            input.expiresAt, commandId, receiptId, revision, "grant-create", payloadDigest, at);
          db.prepare(`UPDATE campaign_companions_v45 SET revision=?,updated_at=?,last_command_id=?,last_receipt_id=?,
            last_command_kind='grant-create',last_payload_digest=? WHERE campaign_id=? AND npc_id=? AND revision=?`)
            .run(revision, at, commandId, receiptId, payloadDigest, campaignId, input.npcId, revision - 1);
        });
    },
    revokeCompanionGrant(principalId, campaignId, raw) {
      guard("write");
      const input = revokeCompanionGrantInputSchema.parse(raw);
      return execute(principalId, campaignId, input.npcId, "grant-revoke", input.expectedRevision, input.idempotencyKey,
        { grantId: input.grantId, npcId: input.npcId, reason: input.reason },
        ({ commandId, receiptId, at, revision, payloadDigest }) => {
          const grant = db.prepare(`SELECT 1 FROM companion_grants_v45 WHERE grant_id=? AND campaign_id=? AND npc_id=?`)
            .get(input.grantId, campaignId, input.npcId);
          if (!grant) throw new CompanionUnavailableError("grant is unavailable");
          if (db.prepare("SELECT 1 FROM companion_grant_revocations_v45 WHERE grant_id=?").get(input.grantId)) {
            throw new CompanionConflictError("grant is already revoked");
          }
          return { grantId: input.grantId, npcId: input.npcId, revision, revokedAt: at };
        }, ({ commandId, receiptId, at, revision, payloadDigest }) => {
          db.prepare(`INSERT INTO companion_grant_revocations_v45 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.grantId,
            campaignId, input.npcId, at, input.reason, principalId, commandId, receiptId, revision, "grant-revoke", payloadDigest);
          db.prepare(`UPDATE campaign_companions_v45 SET revision=?,updated_at=?,last_command_id=?,last_receipt_id=?,
            last_command_kind='grant-revoke',last_payload_digest=? WHERE campaign_id=? AND npc_id=? AND revision=?`)
            .run(revision, at, commandId, receiptId, payloadDigest, campaignId, input.npcId, revision - 1);
        });
    },
  };
}

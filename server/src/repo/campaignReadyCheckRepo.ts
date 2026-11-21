import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  campaignReadyCheckCommandResponseSchema,
  campaignReadyCheckCommandSchema,
  campaignReadyCheckStateSchema,
  resourceIdSchema,
  type CampaignReadyCheckActiveCheck,
  type CampaignReadyCheckCommand,
  type CampaignReadyCheckCommandResponse,
  type CampaignReadyCheckState,
} from "@velvet/contracts";

export class CampaignReadyCheckUnavailableError extends Error {}
export class CampaignReadyCheckConflictError extends Error {}

export interface CampaignReadyCheckRepository {
  getReadyCheck(principalId: string, campaignId: string, sessionId: string): CampaignReadyCheckState;
  commandReadyCheck(
    principalId: string,
    campaignId: string,
    sessionId: string,
    command: CampaignReadyCheckCommand,
  ): CampaignReadyCheckCommandResponse;
}

interface ReadyCheckParticipant {
  id: string;
  name: string;
}

interface ReadyCheckSession {
  participants: readonly ReadyCheckParticipant[];
}

/** Session participants come from the existing session read; state is stored in campaign_ready_check_state. */
export interface CampaignReadyCheckStore {
  getSession(id: string): ReadyCheckSession | null;
  database: DatabaseDriver.Database;
}

interface StoredReadyCheck {
  enabled: boolean;
  check: CampaignReadyCheckActiveCheck | null;
  revision: number;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function isActiveCheck(value: unknown): value is CampaignReadyCheckActiveCheck {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CampaignReadyCheckActiveCheck>;
  return (
    typeof candidate.startedAt === "string" &&
    Array.isArray(candidate.readyActorIds) &&
    candidate.readyActorIds.every((id) => typeof id === "string") &&
    Array.isArray(candidate.waiting) &&
    candidate.waiting.every(
      (actor) =>
        typeof actor === "object" &&
        actor !== null &&
        typeof (actor as { actorId?: unknown }).actorId === "string" &&
        typeof (actor as { name?: unknown }).name === "string",
    )
  );
}

function parseCheck(raw: string | null): CampaignReadyCheckActiveCheck | null {
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!isActiveCheck(parsed)) throw new CampaignReadyCheckUnavailableError("ready-check state is malformed");
  return parsed;
}

function latestState(db: DatabaseDriver.Database, campaignId: string, sessionId: string): StoredReadyCheck {
  const row = db
    .prepare(
      "SELECT enabled, revision, check_json FROM campaign_ready_check_state WHERE campaign_id=? AND session_id=?",
    )
    .get(campaignId, sessionId) as { enabled: number; revision: number; check_json: string | null } | undefined;
  if (!row) return { enabled: false, check: null, revision: 0 };
  return { enabled: row.enabled === 1, check: parseCheck(row.check_json), revision: row.revision };
}

function waitingFor(session: ReadyCheckSession, readyActorIds: readonly string[]) {
  const ready = new Set(readyActorIds);
  return session.participants
    .filter((participant) => !ready.has(participant.id))
    .map((participant) => ({ actorId: participant.id, name: participant.name }));
}

export function createCampaignReadyCheckRepository(
  store: CampaignReadyCheckStore,
  now: () => string = () => new Date().toISOString(),
): CampaignReadyCheckRepository {
  const db = store.database;

  function sessionFor(campaignId: string, sessionId: string): ReadyCheckSession {
    resourceIdSchema.parse(campaignId);
    resourceIdSchema.parse(sessionId);
    const session = store.getSession(sessionId);
    if (!session) throw new CampaignReadyCheckUnavailableError();
    return session;
  }

  function command(
    principalId: string,
    campaignId: string,
    sessionId: string,
    raw: CampaignReadyCheckCommand,
  ): CampaignReadyCheckCommandResponse {
    const input = campaignReadyCheckCommandSchema.parse(raw);
    const session = sessionFor(campaignId, sessionId);
    const requestDigest = hash([
      principalId,
      campaignId,
      sessionId,
      input.action,
      input.actorId ?? null,
      input.expectedRevision,
    ]);

    const existing = db
      .prepare(
        "SELECT request_digest, occurred_at, enabled, revision, check_json FROM campaign_ready_check_receipts WHERE campaign_id=? AND session_id=? AND idempotency_key=?",
      )
      .get(campaignId, sessionId, input.idempotencyKey) as
      | {
          request_digest: string;
          occurred_at: string;
          enabled: number;
          revision: number;
          check_json: string | null;
        }
      | undefined;
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new CampaignReadyCheckConflictError("idempotency key reuse");
      return campaignReadyCheckCommandResponseSchema.parse({
        campaignId,
        sessionId,
        enabled: existing.enabled === 1,
        expectedRevision: existing.revision,
        check: parseCheck(existing.check_json),
        receipt: { idempotencyKey: input.idempotencyKey, occurredAt: existing.occurred_at },
      });
    }

    const current = latestState(db, campaignId, sessionId);
    if (input.expectedRevision !== current.revision)
      throw new CampaignReadyCheckConflictError("ready-check revision is stale");

    const next: StoredReadyCheck = {
      enabled: current.enabled,
      check: current.check,
      revision: current.revision + 1,
    };

    switch (input.action) {
      case "enable":
        next.enabled = true;
        break;
      case "disable":
        next.enabled = false;
        next.check = null;
        break;
      case "start": {
        if (!current.enabled) throw new CampaignReadyCheckConflictError("ready checks are disabled");
        if (current.check) throw new CampaignReadyCheckConflictError("a ready check is already active");
        next.check = {
          startedAt: now(),
          readyActorIds: [],
          waiting: waitingFor(session, []),
        };
        break;
      }
      case "ready": {
        if (!current.enabled || !current.check) throw new CampaignReadyCheckConflictError("no ready check is active");
        if (input.actorId === undefined) break;
        if (!session.participants.some((participant) => participant.id === input.actorId))
          throw new CampaignReadyCheckConflictError("actor is not a room participant");
        const readyActorIds = current.check.readyActorIds.includes(input.actorId)
          ? [...current.check.readyActorIds]
          : [...current.check.readyActorIds, input.actorId];
        next.check = {
          startedAt: current.check.startedAt,
          readyActorIds,
          waiting: waitingFor(session, readyActorIds),
        };
        break;
      }
      case "dismiss":
        next.check = null;
        break;
    }

    const occurredAt = now();
    const checkJson = next.check ? JSON.stringify(next.check) : null;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO campaign_ready_check_state(campaign_id, session_id, enabled, revision, check_json, updated_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(campaign_id, session_id) DO UPDATE SET
          enabled=excluded.enabled, revision=excluded.revision, check_json=excluded.check_json, updated_at=excluded.updated_at`,
      ).run(campaignId, sessionId, next.enabled ? 1 : 0, next.revision, checkJson, occurredAt);
      db.prepare(
        `INSERT INTO campaign_ready_check_receipts(
          campaign_id, session_id, idempotency_key, request_digest, occurred_at, enabled, revision, check_json
        ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        campaignId,
        sessionId,
        input.idempotencyKey,
        requestDigest,
        occurredAt,
        next.enabled ? 1 : 0,
        next.revision,
        checkJson,
      );
    })();

    return campaignReadyCheckCommandResponseSchema.parse({
      campaignId,
      sessionId,
      enabled: next.enabled,
      expectedRevision: next.revision,
      check: next.check,
      receipt: { idempotencyKey: input.idempotencyKey, occurredAt },
    });
  }

  return {
    getReadyCheck(principalId, campaignId, sessionId) {
      void principalId;
      sessionFor(campaignId, sessionId);
      const state = latestState(db, campaignId, sessionId);
      return campaignReadyCheckStateSchema.parse({
        campaignId,
        sessionId,
        enabled: state.enabled,
        expectedRevision: state.revision,
        check: state.check,
      });
    },
    commandReadyCheck(principalId, campaignId, sessionId, input) {
      return command(principalId, campaignId, sessionId, input);
    },
  };
}

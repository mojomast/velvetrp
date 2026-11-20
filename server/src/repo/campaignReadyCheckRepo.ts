import { createHash } from "node:crypto";
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

interface ReadyCheckConsentEvent {
  at: string;
  scope: string;
  note: string;
}

interface ReadyCheckSession {
  participants: readonly ReadyCheckParticipant[];
  consentLog: readonly ReadyCheckConsentEvent[];
}

/** The narrow repository slice this lane needs; production supplies the same session/consent methods. */
export interface CampaignReadyCheckStore {
  getSession(id: string): ReadyCheckSession | null;
  addConsentEvent(sessionId: string, scope: string, granted: boolean, note: string): { at: string } | null;
}

interface StoredReadyCheck {
  enabled: boolean;
  check: CampaignReadyCheckActiveCheck | null;
  revision: number;
}

interface StoredEvent {
  idempotencyKey: string;
  requestDigest: string;
  state: StoredReadyCheck;
}

const scope = "campaign-ready-check:v1";
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

function parseStoredEvent(note: string): StoredEvent | null {
  try {
    const parsed = JSON.parse(note) as Partial<StoredEvent>;
    if (typeof parsed.idempotencyKey !== "string" || typeof parsed.requestDigest !== "string") return null;
    const state = parsed.state as Partial<StoredReadyCheck> | undefined;
    if (
      !state ||
      typeof state.enabled !== "boolean" ||
      typeof state.revision !== "number" ||
      (state.check !== null && !isActiveCheck(state.check))
    )
      return null;
    return {
      idempotencyKey: parsed.idempotencyKey,
      requestDigest: parsed.requestDigest,
      state: { enabled: state.enabled, check: state.check ?? null, revision: state.revision },
    };
  } catch {
    return null;
  }
}

function latestState(session: ReadyCheckSession): StoredReadyCheck {
  for (let index = session.consentLog.length - 1; index >= 0; index -= 1) {
    const event = session.consentLog[index];
    if (!event || event.scope !== scope) continue;
    const stored = parseStoredEvent(event.note);
    if (stored) return stored.state;
  }
  // Freeform play is the default; nothing is enabled until an owner explicitly opts in.
  return { enabled: false, check: null, revision: 0 };
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

    for (let index = session.consentLog.length - 1; index >= 0; index -= 1) {
      const event = session.consentLog[index];
      if (!event || event.scope !== scope) continue;
      const stored = parseStoredEvent(event.note);
      if (!stored || stored.idempotencyKey !== input.idempotencyKey) continue;
      if (stored.requestDigest !== requestDigest) throw new CampaignReadyCheckConflictError("idempotency key reuse");
      return campaignReadyCheckCommandResponseSchema.parse({
        campaignId,
        sessionId,
        enabled: stored.state.enabled,
        expectedRevision: stored.state.revision,
        check: stored.state.check,
        receipt: { idempotencyKey: input.idempotencyKey, occurredAt: event.at },
      });
    }

    const current = latestState(session);
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

    const event = store.addConsentEvent(
      sessionId,
      scope,
      true,
      JSON.stringify({ idempotencyKey: input.idempotencyKey, requestDigest, state: next } satisfies StoredEvent),
    );
    if (!event) throw new CampaignReadyCheckUnavailableError();

    return campaignReadyCheckCommandResponseSchema.parse({
      campaignId,
      sessionId,
      enabled: next.enabled,
      expectedRevision: next.revision,
      check: next.check,
      receipt: { idempotencyKey: input.idempotencyKey, occurredAt: event.at },
    });
  }

  return {
    getReadyCheck(principalId, campaignId, sessionId) {
      void principalId;
      const session = sessionFor(campaignId, sessionId);
      const state = latestState(session);
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

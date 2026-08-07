import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  changeReputationCommandSchema,
  discoverLocationCommandSchema,
  resourceIdSchema,
  setActorLocationCommandSchema,
  travelCommandSchema,
  utcIsoTimestampSchema,
  worldCommandSchema,
  type TravelCommand,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";

/** Raised when a principal lacks the authority required for a world operation. */
export class WorldAuthorizationError extends Error { readonly code = "WORLD_FORBIDDEN"; }
/** Raised when a command's expected world revision is no longer current. */
export class WorldStaleError extends Error { readonly code = "WORLD_STALE"; }
/** Raised when an idempotency key is reused for a different command. */
export class WorldConflictError extends Error { readonly code = "WORLD_CONFLICT"; }
/** Raised when a requested world resource or operation is unavailable. */
export class WorldUnavailableError extends Error { readonly code = "WORLD_UNAVAILABLE"; }

/** Dependencies shared by world read and write repository composition. */
export interface WorldDependencies { clock: Clock; ids: IdGenerator; }

/** Receipt returned after a successful travel command. */
export type WorldReceipt = {
  travelId: string;
  destinationLocationId: string;
  receipt: { commandId: string; idempotencyKey: string; revisionBefore: number; revisionAfter: number; occurredAt: string };
};

/** Receipt returned after a successful non-travel world mutation. */
export type MutationReceipt = {
  receipt: { commandId: string; idempotencyKey: string; revisionBefore: number; revisionAfter: number; occurredAt: string };
};

/** Lifecycle and runtime services required by world command handlers. */
export interface WorldWriteContext extends WorldDependencies {
  /** Rejects mutations when their enclosing repository is unavailable. */
  guard: () => void;
}

/** State-changing world commands and authoritative world creation operations. */
export interface WorldWriteRepository {
  /** Validates and dispatches a command from the shared world command union. */
  executeWorldCommand(principalId: string, sessionId: string, command: unknown): WorldReceipt | MutationReceipt;
  /** Moves a controlled party across an available connection. */
  travel(principalId: string, sessionId: string, command: TravelCommand): WorldReceipt;
  /** Sets an actor's session location with GM authority. */
  setActorLocation(principalId: string, sessionId: string, command: unknown): MutationReceipt;
  /** Creates a campaign location with GM authority. */
  createLocation(principalId: string, input: unknown): { locationId: string; campaignId: string };
  /** Creates a directed campaign location connection with GM authority. */
  createLocationConnection(principalId: string, input: unknown): { locationConnectionId: string; campaignId: string };
  /** Creates a manually controlled NPC from a confirmed fictional persona. */
  createNpc(principalId: string, input: unknown): { npcId: string; campaignId: string };
  /** Changes an actor's faction reputation. */
  changeReputation(principalId: string, sessionId: string, input: unknown): MutationReceipt;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

/**
 * Creates world mutation handlers.
 *
 * Every command runs in an IMMEDIATE transaction and shares one protocol for
 * authorization, idempotency replay, revision advancement, events, and
 * receipts. Creation handlers intentionally retain their existing immediate
 * insert semantics because they do not participate in a session command stream.
 */
export function createWorldWriteRepository(
  db: DatabaseDriver.Database,
  context: WorldWriteContext,
): WorldWriteRepository {
  const now = (): string => utcIsoTimestampSchema.parse(context.clock.now().toISOString());
  const id = (): string => resourceIdSchema.parse(context.ids.nextId());
  const member = (principalId: string, campaignId: string): boolean => Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principalId));
  const gm = (principalId: string, campaignId: string): boolean => Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')").get(campaignId, principalId));
  const controls = (principalId: string, campaignId: string, actorId: string): boolean => Boolean(db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?").get(campaignId, actorId, principalId));
  const requireGm = (principalId: string, campaignId: string): void => { if (!gm(principalId, campaignId)) throw new WorldAuthorizationError("GM authority is required"); };
  const requireSession = (campaignId: string, sessionId: string): void => { if (!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, sessionId)) throw new WorldUnavailableError("session does not belong to campaign"); };

  function begin(principalId: string, sessionId: string, raw: unknown, type: string, authorize: () => void): { command: any; at: string; commandId: string; before: number; after: number; replay: any } {
    const command = worldCommandSchema.parse(raw);
    if (command.type !== type) throw new WorldUnavailableError("wrong world command");
    if (!member(principalId, command.campaignId)) throw new WorldAuthorizationError("campaign membership is required");
    requireSession(command.campaignId, sessionId);
    authorize();
    const request = canonical(command);
    const replay = db.prepare("SELECT c.canonical_request_json,r.canonical_result_json FROM world_commands_v28 c JOIN world_receipts_v28 r USING(campaign_id,session_id,command_id) WHERE c.campaign_id=? AND c.session_id=? AND c.idempotency_key=?").get(command.campaignId, sessionId, command.idempotencyKey) as any;
    if (replay) {
      if (replay.canonical_request_json !== request) throw new WorldConflictError("idempotency key was reused");
      return { command, at: "", commandId: "", before: 0, after: 0, replay };
    }
    const root = db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?").get(command.campaignId, sessionId) as any;
    const before = root?.revision ?? 0;
    if (before !== command.expectedRevision) throw new WorldStaleError("world revision is stale");
    return { command, at: now(), commandId: id(), before, after: before + 1, replay: null };
  }

  function record(command: any, sessionId: string, type: string, actorId: string, mutation: any, result: any, eventType: string, event: any): void {
    if (!db.prepare("SELECT 1 FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?").get(command.campaignId, sessionId)) db.prepare("INSERT INTO world_mutation_revisions_v28 VALUES(?,?,?,?)").run(command.campaignId, sessionId, 0, mutation.at);
    db.prepare("INSERT INTO world_commands_v28 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(command.campaignId, sessionId, mutation.commandId, actorId, type, command.idempotencyKey, canonical(command), digest(command), mutation.before, mutation.after, mutation.at);
    db.prepare("INSERT INTO world_receipts_v28 VALUES(?,?,?,?,?,?,?)").run(command.campaignId, sessionId, mutation.commandId, mutation.after, canonical(result), digest(result), mutation.at);
    db.prepare("INSERT INTO world_events_v28 VALUES(?,?,?,?,?,?,?,?)").run(id(), command.campaignId, sessionId, mutation.commandId, mutation.after, eventType, canonical(event), mutation.at);
    db.prepare("UPDATE world_mutation_revisions_v28 SET revision=?,updated_at=? WHERE campaign_id=? AND session_id=?").run(mutation.after, mutation.at, command.campaignId, sessionId);
  }
  const receipt = (mutation: any, idempotencyKey: string): MutationReceipt => ({ receipt: { commandId: mutation.commandId, idempotencyKey, revisionBefore: mutation.before, revisionAfter: mutation.after, occurredAt: mutation.at } });

  function setActorLocation(principalId: string, sessionId: string, raw: unknown): MutationReceipt {
    context.guard(); return db.transaction(() => { const mutation = begin(principalId, sessionId, setActorLocationCommandSchema.parse(raw), "set_actor_location", () => requireGm(principalId, (raw as any).campaignId)); if (mutation.replay) return JSON.parse(mutation.replay.canonical_result_json); const command = mutation.command;
      if (!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(command.campaignId, command.actorId) || !db.prepare("SELECT 1 FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?").get(command.campaignId, command.locationId)) throw new WorldUnavailableError("actor or location is unavailable"); const result = receipt(mutation, command.idempotencyKey); record(command, sessionId, "set_actor_location", command.actorId, mutation, result, "actor_location_set", { actorId: command.actorId, locationId: command.locationId });
      const existing = db.prepare("SELECT 1 FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=? AND session_id=?").get(command.campaignId, command.actorId, sessionId); if (existing) db.prepare("UPDATE campaign_actor_locations_v28 SET location_id=?,state_revision=state_revision+1,updated_at=? WHERE campaign_id=? AND actor_id=? AND session_id=?").run(command.locationId, mutation.at, command.campaignId, command.actorId, sessionId); else db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(command.campaignId, command.actorId, command.locationId, sessionId, mutation.at); return result;
    }).immediate();
  }
  function discoverLocation(principalId: string, sessionId: string, raw: unknown): MutationReceipt {
    context.guard(); return db.transaction(() => { const mutation = begin(principalId, sessionId, discoverLocationCommandSchema.parse(raw), "discover_location", () => requireGm(principalId, (raw as any).campaignId)); if (mutation.replay) return JSON.parse(mutation.replay.canonical_result_json); const command = mutation.command;
      if (!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(command.campaignId, command.actorId) || !db.prepare("SELECT 1 FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?").get(command.campaignId, command.locationId)) throw new WorldUnavailableError("actor or location is unavailable"); const result = receipt(mutation, command.idempotencyKey); record(command, sessionId, "discover_location", command.actorId, mutation, result, "location_discovered", { actorId: command.actorId, locationId: command.locationId }); db.prepare("INSERT OR IGNORE INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(command.campaignId, command.actorId, command.locationId, mutation.at); return result;
    }).immediate();
  }
  function travel(principalId: string, sessionId: string, raw: TravelCommand): WorldReceipt {
    context.guard(); return db.transaction(() => { const mutation = begin(principalId, sessionId, travelCommandSchema.parse(raw), "travel", () => { const command = raw as any; if (!gm(principalId, command.campaignId) && command.selectedPartyActorIds.some((actorId: string) => !controls(principalId, command.campaignId, actorId))) throw new WorldAuthorizationError("party control is required"); }); if (mutation.replay) return JSON.parse(mutation.replay.canonical_result_json); const command = mutation.command;
      const route = db.prepare("SELECT * FROM campaign_location_connections_v28 WHERE campaign_id=? AND connection_id=?").get(command.campaignId, command.locationConnectionId) as any; if (!route || route.route_state !== "open" || route.visibility === "gm") throw new WorldUnavailableError("route is unavailable");
      for (const actorId of command.selectedPartyActorIds) { const position = db.prepare("SELECT location_id FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=? AND session_id=?").get(command.campaignId, actorId, sessionId) as any; if (!position || position.location_id !== route.from_location_id) throw new WorldUnavailableError("party is not adjacent to route"); if ((route.visibility === "discovered" || route.requirement_kind === "discovery") && !db.prepare("SELECT 1 FROM campaign_location_discoveries_v28 WHERE campaign_id=? AND actor_id=? AND location_id=?").get(command.campaignId, actorId, route.to_location_id)) throw new WorldUnavailableError("route destination is undiscovered"); }
      const result: WorldReceipt = { travelId: command.travelId, destinationLocationId: route.to_location_id, receipt: { commandId: mutation.commandId, idempotencyKey: command.idempotencyKey, revisionBefore: mutation.before, revisionAfter: mutation.after, occurredAt: mutation.at } }; record(command, sessionId, "travel", command.selectedPartyActorIds[0], mutation, result, "travelled", { travelId: command.travelId, destinationLocationId: route.to_location_id }); for (const actorId of command.selectedPartyActorIds) { db.prepare("INSERT INTO world_travel_party_members_v28 VALUES(?,?,?,?)").run(command.campaignId, sessionId, mutation.commandId, actorId); db.prepare("UPDATE campaign_actor_locations_v28 SET location_id=?,state_revision=state_revision+1,updated_at=? WHERE campaign_id=? AND actor_id=? AND session_id=?").run(route.to_location_id, mutation.at, command.campaignId, actorId, sessionId); } db.prepare("INSERT INTO world_travel_destinations_v28 VALUES(?,?,?,?,?)").run(command.campaignId, sessionId, mutation.commandId, route.connection_id, route.to_location_id); return result;
    }).immediate();
  }
  function changeReputation(principalId: string, sessionId: string, raw: unknown): MutationReceipt {
    context.guard(); return db.transaction(() => { const mutation = begin(principalId, sessionId, changeReputationCommandSchema.parse(raw), "change_reputation", () => requireGm(principalId, (raw as any).campaignId)); if (mutation.replay) return JSON.parse(mutation.replay.canonical_result_json); const command = mutation.command;
      if (!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(command.campaignId, command.actorId) || !db.prepare("SELECT 1 FROM campaign_factions_v28 WHERE campaign_id=? AND faction_id=?").get(command.campaignId, command.factionId)) throw new WorldUnavailableError("reputation subject is unavailable"); const reputationLedgerEntryId = command.reputationLedgerEntryId ?? id(); const result = { reputationLedgerEntryId, ...receipt(mutation, command.idempotencyKey) }; record(command, sessionId, "change_reputation", command.actorId, mutation, result, "reputation_changed", { actorId: command.actorId, factionId: command.factionId, delta: command.delta }); db.prepare("INSERT INTO campaign_reputation_ledger_v28 VALUES(?,?,?,?,?,?,?,?,?)").run(reputationLedgerEntryId, command.campaignId, sessionId, command.actorId, command.factionId, command.delta, command.reason, mutation.commandId, mutation.at); return result;
    }).immediate();
  }
  function createLocation(principalId: string, input: any) { context.guard(); const campaignId = String(input.campaignId); requireGm(principalId, campaignId); const locationId = input.locationId ?? id(); db.prepare("INSERT INTO campaign_locations_v28(location_id,campaign_id,parent_location_id,public_name,public_description,visibility,created_at) VALUES(?,?,?,?,?,?,?)").run(locationId, campaignId, input.parentLocationId ?? null, String(input.name).trim(), String(input.description ?? ""), input.visibility === "hidden" ? "gm" : "public", now()); return { locationId, campaignId }; }
  function createLocationConnection(principalId: string, input: any) { context.guard(); const campaignId = String(input.campaignId); requireGm(principalId, campaignId); const locationConnectionId = input.locationConnectionId ?? id(); db.prepare("INSERT INTO campaign_location_connections_v28(connection_id,campaign_id,from_location_id,to_location_id,visibility,route_state,requirement_kind,required_faction_id,minimum_reputation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(locationConnectionId, campaignId, input.fromLocationId, input.toLocationId, input.visibility === "hidden" ? "gm" : "public", input.routeState ?? "open", input.requirementKind ?? "none", input.requiredFactionId ?? null, input.minimumReputation ?? null, now()); return { locationConnectionId, campaignId }; }
  function createNpc(principalId: string, input: any) { context.guard(); const campaignId = String(input.campaignId); requireGm(principalId, campaignId); if (input.speechControl !== undefined && input.speechControl !== "manual") throw new WorldUnavailableError("NPC AI speech is unavailable"); const persona = db.prepare("SELECT fictional_confirmed,is_real_person FROM characters WHERE id=?").get(input.personaId) as any; if (!persona || persona.fictional_confirmed !== 1 || persona.is_real_person !== 0) throw new WorldUnavailableError("NPC persona must be fictional and confirmed"); if (db.prepare("SELECT 1 FROM campaign_actors a JOIN campaign_characters cc ON cc.id=a.campaign_character_id AND cc.campaign_id=a.campaign_id WHERE a.campaign_id=? AND cc.character_id=?").get(campaignId, input.personaId)) throw new WorldConflictError("a campaign character cannot be NPC-controlled"); const npcId = input.npcId ?? id(); db.prepare("INSERT INTO campaign_npcs_v28 VALUES(?,?,?,?,?,?)").run(npcId, campaignId, input.personaId, "manual", String(input.name).trim(), now()); return { npcId, campaignId }; }
  function executeWorldCommand(principalId: string, sessionId: string, input: unknown): WorldReceipt | MutationReceipt { const command = worldCommandSchema.parse(input); switch (command.type) { case "travel": return travel(principalId, sessionId, command); case "set_actor_location": return setActorLocation(principalId, sessionId, command); case "discover_location": return discoverLocation(principalId, sessionId, command); case "change_reputation": return changeReputation(principalId, sessionId, command); } }

  return { executeWorldCommand, travel, setActorLocation, createLocation, createLocationConnection, createNpc, changeReputation };
}

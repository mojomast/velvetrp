import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import { systemRuntime, type RandomNumberGenerator } from "../../runtime.js";
import { resolveActorJourneyPath } from "./actorJourneyPath.js";
import { resolveActorTravelAuthority } from "./actorTravelPolicy.js";
import { executeActorTravelInTransaction } from "./actorTravelTransaction.js";
import { eligibleTravelEvents, selectTravelInterruption, type TravelEventRouteProfile, type TravelInterruption } from "./travelEventPolicy.js";
import type { WorldDependencies } from "./worldWriteRepo.js";
import { WorldAuthorizationError, WorldConflictError } from "./worldErrors.js";

export interface ActorJourneyResult {
  commandId: string; journeyId: string; status: "completed" | "interrupted";
  originLocationId: string; requestedDestinationLocationId: string; currentLocationId: string;
  origin: string; destination: string; currentLocation: string;
  path: { connectionId: string; fromLocationId: string; toLocationId: string; commandId: string }[];
  elapsedMinutes: number; interruption: TravelInterruption | null;
  eventChecks: { connectionId: string; route: TravelEventRouteProfile; elapsedMinutes: number; partyInjured: boolean;
    triggerRoll: number; eventRoll: number | null; eventId: string | null }[];
  revisionBefore: number; revisionAfter: number; occurredAt: string;
}
export interface ActorJourneyRepository {
  /** Executes only a single, explicit named travel declaration or continuation. */
  executeDeclaredActorJourney(principalId: string, turnId: string): ActorJourneyResult | null;
  getActorJourneyPublicReceipt(principalId: string, campaignId: string, commandId: string): ActorJourneyResult | null;
  getActorJourneyNarrationReceipt(principalId: string, turnId: string, commandId: string): ActorJourneyResult | null;
}
type Turn = { id: string; campaign_id: string; session_id: string; actor_id: string; principal_id: string;
  timeline_id: string; mode: string; declaration: string; campaign_revision: number };
type Execution = { command_id: string; journey_id: string; campaign_id: string; session_id: string; actor_id: string;
  turn_id: string; principal_id: string; request_json: string; request_digest: string; result_json: string; result_digest: string };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const nameKey = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Deliberately narrow: dialogue, negations, questions and compound actions remain in planning. */
export function parseJourneyDeclaration(text: string): { destination: string | null; resume: boolean } | null {
  const clean = text.trim().replace(/[.!]+$/, "").trim();
  const resume = /^(?:(?:i|we)\s+)?(?:continue|resume)\s+(?:(?:my|our|the)\s+)?(?:journey|travel|trip)$/i.test(clean);
  if (resume) return { destination: null, resume: true };
  const match = /^(?:(?:i|we)\s+)?(?:move|go|walk|travel|head|journey|ride|return)\s+(?:to|towards?)\s+(.+)$/i.exec(clean);
  if (!match || /\b(?:then|and|but|after|before|if|unless)\b|[?;\n]/i.test(match[1]!)) return null;
  return { destination: match[1]!.trim(), resume: false };
}

/** Append-only journey tranches compose the existing atomic per-edge command, never v1 candidates. */
export function createActorJourneyRepository(db: DatabaseDriver.Database,
  deps: WorldDependencies & { rng?: RandomNumberGenerator }, guard: () => void): ActorJourneyRepository {
  const authorize = (principalId: string, turn: Turn, running: boolean) => {
    const authority = resolveActorTravelAuthority(db, { campaignId: turn.campaign_id, sessionId: turn.session_id,
      actorId: turn.actor_id, principalId, partyActorIds: [turn.actor_id], requireRunningSession: running, audienceMode: "player" });
    if (!authority.allowed) throw new WorldAuthorizationError("journey authority is required");
  };
  const verify = (row: Execution): ActorJourneyResult => {
    if (sha(row.request_json) !== row.request_digest || sha(row.result_json) !== row.result_digest) throw new WorldConflictError("journey evidence is invalid");
    const result = JSON.parse(row.result_json) as ActorJourneyResult;
    const request = JSON.parse(row.request_json);
    if (result.commandId !== row.command_id || result.journeyId !== row.journey_id || request.turnId !== row.turn_id
      || request.destinationLocationId !== result.requestedDestinationLocationId || !Array.isArray(result.path)
      || result.path.length > 32 || !["completed", "interrupted"].includes(result.status)
      || (result.status === "completed" && (result.currentLocationId !== result.requestedDestinationLocationId || result.interruption !== null))
      || (result.status === "interrupted" && result.interruption === null)) throw new WorldConflictError("journey evidence is invalid");
    let at = result.originLocationId;
    for (const [index, step] of result.path.entries()) {
      const leg = db.prepare(`SELECT command.canonical_request_json,command.request_digest,receipt.canonical_result_json,receipt.result_digest,
        destination.connection_id,destination.destination_location_id
        FROM world_commands_v28 command JOIN world_receipts_v28 receipt USING(campaign_id,session_id,command_id)
        JOIN world_travel_destinations_v28 destination USING(campaign_id,session_id,command_id)
        WHERE command.campaign_id=? AND command.session_id=? AND command.command_id=?`).get(row.campaign_id, row.session_id, step.commandId) as any;
      const intent = leg && JSON.parse(leg.canonical_request_json), settled = leg && JSON.parse(leg.canonical_result_json);
      if (!leg || sha(leg.canonical_request_json) !== leg.request_digest || sha(leg.canonical_result_json) !== leg.result_digest
        || request.path[index] !== step.connectionId || step.fromLocationId !== at || leg.connection_id !== step.connectionId || leg.destination_location_id !== step.toLocationId
        || intent.selectedPartyActorIds.length !== 1 || intent.selectedPartyActorIds[0] !== row.actor_id
        || intent.expectedRevision !== result.revisionBefore + index || settled.locations[0]?.locationId !== step.toLocationId
        || settled.receipt.commandId !== step.commandId || settled.receipt.revisionAfter !== result.revisionBefore + index + 1
        || (db.prepare("SELECT count(*) count FROM world_travel_party_members_v28 WHERE campaign_id=? AND session_id=? AND command_id=? AND actor_id=?")
          .get(row.campaign_id, row.session_id, step.commandId, row.actor_id) as { count: number }).count !== 1)
        throw new WorldConflictError("journey leg evidence is invalid");
      at = step.toLocationId;
    }
    if (at !== result.currentLocationId || result.revisionAfter !== result.revisionBefore + result.path.length
      || result.elapsedMinutes !== result.path.length * 60) throw new WorldConflictError("journey progress is invalid");
    return result;
  };
  return {
    executeDeclaredActorJourney(principalInput, turnInput) {
      guard(); const principalId = resourceIdSchema.parse(principalInput), turnId = resourceIdSchema.parse(turnInput);
      return db.transaction(() => {
        const turn = db.prepare("SELECT * FROM adventure_turns WHERE id=?").get(turnId) as Turn | undefined;
        if (!turn || turn.mode !== "original") return null;
        authorize(principalId, turn, false);
        const prior = db.prepare("SELECT * FROM world_actor_journey_executions_v1 WHERE turn_id=?").get(turnId) as Execution | undefined;
        if (prior) return verify(prior);
        const declaration = parseJourneyDeclaration(turn.declaration); if (!declaration) return null;
        authorize(principalId, turn, true);
        const campaign = db.prepare("SELECT active_timeline_id,administration_revision,lifecycle_status FROM campaigns WHERE id=?").get(turn.campaign_id) as any;
        const state = db.prepare(`SELECT resulting_state FROM adventure_coordination_events_v36 WHERE aggregate_kind='turn'
          AND aggregate_id=? ORDER BY resulting_revision DESC LIMIT 1`).get(turn.id) as any;
        if (!campaign || campaign.active_timeline_id !== turn.timeline_id || campaign.administration_revision !== turn.campaign_revision
          || !["draft", "published"].includes(campaign.lifecycle_status) || !["declared", "proposed"].includes(state?.resulting_state)
          || db.prepare("SELECT 1 FROM tool_proposals WHERE turn_id=?").get(turn.id)
          || db.prepare("SELECT 1 FROM encounter WHERE campaign_id=? AND session_id=? AND status='active'").get(turn.campaign_id, turn.session_id)) return null;
        if (!db.prepare(`SELECT 1 FROM campaign_actors actor JOIN campaign_characters character
          ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
          JOIN session_characters participant ON participant.character_id=character.character_id
          WHERE actor.campaign_id=? AND actor.id=? AND participant.session_id=?`).get(turn.campaign_id, turn.actor_id, turn.session_id)) return null;
        const latest = db.prepare(`SELECT * FROM world_actor_journey_executions_v1 WHERE campaign_id=? AND session_id=? AND actor_id=?
          ORDER BY rowid DESC LIMIT 1`).get(turn.campaign_id, turn.session_id, turn.actor_id) as Execution | undefined;
        const previous = latest ? verify(latest) : null;
        let destinationLocationId: string;
        if (declaration.resume) {
          if (!previous || previous.status !== "interrupted") return null;
          destinationLocationId = previous.requestedDestinationLocationId;
        } else {
          const visible = db.prepare(`SELECT location_id,public_name FROM campaign_locations_v28 location WHERE campaign_id=?
            AND (visibility='public' OR (visibility='discovered' AND EXISTS(SELECT 1 FROM campaign_location_discoveries_v28 discovery
              WHERE discovery.campaign_id=location.campaign_id AND discovery.location_id=location.location_id AND discovery.actor_id=?)))`)
            .all(turn.campaign_id, turn.actor_id) as { location_id: string; public_name: string }[];
          // A middle-dot suffix is display context, e.g. "Place La Salle · horloge ...".
          // Match either the complete label or its primary name, never an arbitrary substring.
          const requestedName = nameKey(declaration.destination!);
          const matches = visible.filter(location => nameKey(location.public_name) === requestedName
            || nameKey(location.public_name.split("·")[0]!.trim()) === requestedName);
          if (matches.length !== 1) return null;
          destinationLocationId = matches[0]!.location_id;
        }
        const path = resolveActorJourneyPath(db, { campaignId: turn.campaign_id, sessionId: turn.session_id, actorId: turn.actor_id,
          principalId, partyActorIds: [turn.actor_id], targetLocationId: destinationLocationId, audienceMode: "player" });
        if (!path) return null;
        // Repeating the destination is also a continuation; changing destination starts a new journey.
        const continuing = previous?.status === "interrupted" && previous.requestedDestinationLocationId === destinationLocationId
          && previous.currentLocationId === path.originLocationId;
        if (declaration.resume && !continuing) return null;
        const commandId = `journey-command:${sha(turn.id).slice(0, 40)}`;
        const journeyId = continuing ? previous!.journeyId : `journey:${sha(turn.id).slice(0, 40)}`;
        const request = { turnId: turn.id, declaration: turn.declaration, destinationLocationId,
          previousCommandId: continuing ? previous!.commandId : null, path: path.steps.map(step => step.connectionId) };
        const requestJson = JSON.stringify(request);
        const revisionBefore = (db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?")
          .get(turn.campaign_id, turn.session_id) as { revision: number } | undefined)?.revision ?? 0;
        const elapsedBefore = (db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id=?")
          .get(turn.campaign_id, turn.session_id) as { elapsed_minutes: number } | undefined)?.elapsed_minutes ?? 0;
        const partyInjured = Boolean(db.prepare("SELECT 1 FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health' AND current<max")
          .get(turn.campaign_id, turn.actor_id));
        let interruption: TravelInterruption | null = null, checkedWatched = false;
        const legs: ActorJourneyResult["path"] = [];
        const eventChecks: ActorJourneyResult["eventChecks"] = [];
        for (const step of path.steps) {
          const profileRow = db.prepare("SELECT environment,risk,chance_percent FROM world_route_event_profiles_v1 WHERE campaign_id=? AND connection_id=?")
            .get(turn.campaign_id, step.connectionId) as { environment: TravelEventRouteProfile["environment"]; risk: TravelEventRouteProfile["risk"]; chance_percent: number } | undefined;
          const route: TravelEventRouteProfile = profileRow ? { environment: profileRow.environment, risk: profileRow.risk, chancePercent: profileRow.chance_percent } : { environment: "urban", risk: "safe", chancePercent: 0 };
          const situation = { elapsedMinutes: elapsedBefore + legs.length * 60, partyInjured, activeEncounter: false, journeyInterruptionCount: continuing ? 1 : 0 };
          const eligible = eligibleTravelEvents(route, situation).filter(event => !event.encounterId);
          if (!continuing && route.risk !== "safe" && route.chancePercent > 0 && eligible.length > 0 && (route.risk !== "watched" || !checkedWatched)) {
            if (route.risk === "watched") checkedWatched = true;
            const rng = deps.rng ?? systemRuntime.rng;
            const triggerRoll = rng.integer(1, 101);
            if (!Number.isInteger(triggerRoll) || triggerRoll < 1 || triggerRoll > 100) throw new WorldConflictError("journey RNG is invalid");
            const eventRoll = triggerRoll <= route.chancePercent && eligible.length > 1 ? rng.integer(1, 101) : undefined;
            interruption = selectTravelInterruption({ route, situation, pool: eligible, triggerRoll, ...(eventRoll === undefined ? {} : { eventRoll }) });
            eventChecks.push({ connectionId: step.connectionId, route, elapsedMinutes: situation.elapsedMinutes, partyInjured,
              triggerRoll, eventRoll: eventRoll ?? null, eventId: interruption?.event.id ?? null });
            if (interruption) break;
          }
          const leg = executeActorTravelInTransaction(db, deps, principalId, turn.session_id, turn.actor_id, {
            connectionId: step.connectionId, partyActorIds: [turn.actor_id], expectedRevision: revisionBefore + legs.length,
            idempotencyKey: `journey-leg:${sha(`${turn.id}:${legs.length}`).slice(0, 40)}` });
          legs.push({ connectionId: step.connectionId, fromLocationId: step.fromLocationId, toLocationId: step.toLocationId, commandId: leg.receipt.commandId });
        }
        const currentLocationId = legs.at(-1)?.toLocationId ?? path.originLocationId;
        const label = (id: string) => (db.prepare("SELECT public_name FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?")
          .get(turn.campaign_id, id) as { public_name: string }).public_name;
        const occurredAt = deps.clock.now().toISOString();
        const result: ActorJourneyResult = { commandId, journeyId, status: interruption ? "interrupted" : "completed",
          originLocationId: path.originLocationId, requestedDestinationLocationId: destinationLocationId, currentLocationId,
          origin: label(path.originLocationId), destination: label(destinationLocationId), currentLocation: label(currentLocationId),
          path: legs, elapsedMinutes: legs.length * 60, interruption, eventChecks, revisionBefore, revisionAfter: revisionBefore + legs.length, occurredAt };
        const resultJson = JSON.stringify(result);
        db.prepare(`INSERT INTO world_actor_journey_executions_v1(command_id,campaign_id,session_id,actor_id,turn_id,journey_id,principal_id,
          request_json,request_digest,result_json,result_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(commandId, turn.campaign_id, turn.session_id, turn.actor_id, turn.id, journeyId, principalId, requestJson, sha(requestJson), resultJson, sha(resultJson), occurredAt);
        return result;
      }).immediate();
    },
    getActorJourneyPublicReceipt(principalInput, campaignInput, commandInput) {
      guard();
      const principalId = resourceIdSchema.parse(principalInput), campaignId = resourceIdSchema.parse(campaignInput), commandId = resourceIdSchema.parse(commandInput);
      const member = db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principalId);
      if (!member) return null;
      const row = db.prepare("SELECT * FROM world_actor_journey_executions_v1 WHERE campaign_id=? AND command_id=?").get(campaignId, commandId) as Execution | undefined;
      return row ? verify(row) : null;
    },
    getActorJourneyNarrationReceipt(principalInput, turnInput, commandInput) {
      guard();
      const principalId = resourceIdSchema.parse(principalInput), commandId = resourceIdSchema.parse(commandInput);
      let turnId = resourceIdSchema.parse(turnInput);
      for (let depth = 0; depth < 32; depth++) {
        const turn = db.prepare("SELECT * FROM adventure_turns WHERE id=?").get(turnId) as (Turn & { prior_turn_id: string | null }) | undefined;
        if (!turn) return null;
        authorize(principalId, turn, false);
        if (turn.mode === "original") {
          const row = db.prepare("SELECT * FROM world_actor_journey_executions_v1 WHERE turn_id=? AND command_id=?").get(turnId, commandId) as Execution | undefined;
          return row ? verify(row) : null;
        }
        if (!turn.prior_turn_id) return null;
        turnId = turn.prior_turn_id;
      }
      return null;
    },
  };
}

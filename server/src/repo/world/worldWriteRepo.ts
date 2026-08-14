import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  changeReputationCommandSchema,
  actorTravelCommandRequestSchema,
  campaignNpcHttpSchema,
  createCampaignNpcHttpRequestSchema,
  npcRelationshipCommandHttpRequestSchema,
  npcRelationshipHttpSchema,
  campaignFactionHttpSchema,createCampaignFactionHttpRequestSchema,factionReputationCommandHttpRequestSchema,factionStandingHttpSchema,
  discoverLocationCommandSchema,
  resourceIdSchema,
  setActorLocationCommandSchema,
  travelCommandSchema,
  utcIsoTimestampSchema,
  worldCommandSchema,
  type TravelCommand,
  type ActorTravelCommandRequest,
  type ActorTravelCommandResponse,
  type ActorPlacementCommandRequest,
  type CampaignNpcHttp,
  type CreateCampaignNpcHttpRequest,
  type NpcRelationshipCommandHttpRequest,
  type NpcRelationshipHttp,
  type CampaignFactionHttp,type CreateCampaignFactionHttpRequest,type FactionReputationCommandHttpRequest,type FactionStandingHttp,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";
import { executeActorTravelInTransaction, executeLegacyTravelInTransaction } from "./actorTravelTransaction.js";
export {
  WorldAuthorizationError,
  WorldConflictError,
  WorldStaleError,
  WorldUnavailableError,
} from "./worldErrors.js";
import {
  WorldAuthorizationError,
  WorldConflictError,
  WorldStaleError,
  WorldUnavailableError,
} from "./worldErrors.js";

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
export type ActorTravelResult=Omit<ActorTravelCommandResponse,"receipt">&{campaignId:string;sessionId:string;
  receipt:{commandId:string;idempotencyKey:string;revisionBefore:number;revisionAfter:number;occurredAt:string}};
export type NpcMutationReceipt={commandId:string;idempotencyKey:string;revisionBefore:number;revisionAfter:number;occurredAt:string};
export type CreateNpcResult={campaignId:string;npc:CampaignNpcHttp;receipt:NpcMutationReceipt};
export type NpcRelationshipResult={campaignId:string;npcId:string;relationship:NpcRelationshipHttp;receipt:NpcMutationReceipt};
export type CreateFactionResult={campaignId:string;faction:CampaignFactionHttp;receipt:NpcMutationReceipt};
export type FactionReputationResult={campaignId:string;factionId:string;standing:FactionStandingHttp;receipt:NpcMutationReceipt};

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
  travelActor(principalId:string,actorId:string,input:ActorTravelCommandRequest):ActorTravelResult;
  /** Sets an actor's session location with GM authority. */
  setActorLocation(principalId: string, sessionId: string, command: unknown): MutationReceipt;
  placeActor(principalId:string,actorId:string,input:ActorPlacementCommandRequest):MutationReceipt&{campaignId:string;sessionId:string;location:{actorId:string;locationId:string;revision:number;updatedAt:string}};
  /** Creates a campaign location with GM authority. */
  createLocation(principalId: string, input: unknown): { locationId: string; campaignId: string };
  /** Creates a directed campaign location connection with GM authority. */
  createLocationConnection(principalId: string, input: unknown): { locationConnectionId: string; campaignId: string };
  /** Creates a manually controlled NPC from a confirmed fictional persona. */
  createNpc(principalId: string, input: unknown): { npcId: string; campaignId: string };
  /** Changes an actor's faction reputation. */
  changeReputation(principalId: string, sessionId: string, input: unknown): MutationReceipt;
  createCampaignNpc(principalId:string,campaignId:string,input:CreateCampaignNpcHttpRequest):CreateNpcResult;
  changeNpcRelationship(principalId:string,npcId:string,input:NpcRelationshipCommandHttpRequest):NpcRelationshipResult;
  createCampaignFaction(principalId:string,campaignId:string,input:CreateCampaignFactionHttpRequest):CreateFactionResult;
  changeFactionReputation(principalId:string,factionId:string,input:FactionReputationCommandHttpRequest):FactionReputationResult;
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
  function narrativeBegin(principalId:string,campaignId:string,type:string,requestValue:object,expectedRevision:number,idempotencyKey:string){
    if(!gm(principalId,campaignId))throw new WorldAuthorizationError("GM authority is required");
    const request=canonical(requestValue),replay=db.prepare(`SELECT command.command_type,command.canonical_request_json,
      receipt.canonical_result_json FROM world_narrative_commands_v32 command JOIN world_narrative_receipts_v32 receipt
      USING(campaign_id,command_id) WHERE command.campaign_id=? AND command.idempotency_key=?`)
      .get(campaignId,idempotencyKey) as any;
    if(replay){if(replay.command_type!==type||replay.canonical_request_json!==request)
      throw new WorldConflictError("idempotency key was reused");return {replay:JSON.parse(replay.canonical_result_json)};}
    const before=(db.prepare("SELECT revision FROM world_narrative_revisions_v32 WHERE campaign_id=?").get(campaignId) as any)?.revision??0;
    if(before!==expectedRevision)throw new WorldStaleError("world narrative revision is stale");
    return {replay:null,request,before,after:before+1,at:now(),commandId:id()};
  }
  function narrativeRecord(campaignId:string,resourceId:string,type:string,idempotencyKey:string,mutation:any,result:any,eventType:string,event:any){
    if(!db.prepare("SELECT 1 FROM world_narrative_revisions_v32 WHERE campaign_id=?").get(campaignId))
      db.prepare("INSERT INTO world_narrative_revisions_v32 VALUES(?,0,?)").run(campaignId,mutation.at);
    db.prepare("INSERT INTO world_narrative_commands_v32 VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(campaignId,mutation.commandId,resourceId,type,idempotencyKey,mutation.request,digest(JSON.parse(mutation.request)),mutation.before,mutation.after,mutation.at);
    db.prepare("INSERT INTO world_narrative_receipts_v32 VALUES(?,?,?,?,?,?)")
      .run(campaignId,mutation.commandId,mutation.after,canonical(result),digest(result),mutation.at);
    db.prepare("INSERT INTO world_narrative_events_v32 VALUES(?,?,?,?,?,?,?)")
      .run(id(),campaignId,mutation.commandId,mutation.after,eventType,canonical(event),mutation.at);
    db.prepare("UPDATE world_narrative_revisions_v32 SET revision=?,updated_at=? WHERE campaign_id=?")
      .run(mutation.after,mutation.at,campaignId);
  }

  function setActorLocation(principalId: string, sessionId: string, raw: unknown): MutationReceipt {
    context.guard(); return db.transaction(() => { const mutation = begin(principalId, sessionId, setActorLocationCommandSchema.parse(raw), "set_actor_location", () => requireGm(principalId, (raw as any).campaignId)); if (mutation.replay) return JSON.parse(mutation.replay.canonical_result_json); const command = mutation.command;
      if (!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(command.campaignId, command.actorId) || !db.prepare("SELECT 1 FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?").get(command.campaignId, command.locationId)) throw new WorldUnavailableError("actor or location is unavailable"); const result = receipt(mutation, command.idempotencyKey); record(command, sessionId, "set_actor_location", command.actorId, mutation, result, "actor_location_set", { actorId: command.actorId, locationId: command.locationId });
      const existing = db.prepare("SELECT 1 FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=? AND session_id=?").get(command.campaignId, command.actorId, sessionId); if (existing) db.prepare("UPDATE campaign_actor_locations_v28 SET location_id=?,state_revision=state_revision+1,updated_at=? WHERE campaign_id=? AND actor_id=? AND session_id=?").run(command.locationId, mutation.at, command.campaignId, command.actorId, sessionId); else db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)").run(command.campaignId, command.actorId, command.locationId, sessionId, mutation.at); return result;
    }).immediate();
  }
  function placeActor(principalId:string,actorIdInput:string,input:ActorPlacementCommandRequest){
    context.guard();const actorId=resourceIdSchema.parse(actorIdInput),intent=input;
    return db.transaction(()=>{requireGm(principalId,intent.campaignId);
      if(db.prepare("SELECT 1 FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=?").get(intent.campaignId,actorId))throw new WorldConflictError("actor is already placed");
      const sessions=db.prepare(`SELECT attached.session_id FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
        WHERE attached.campaign_id=? AND session.state='active' AND session.stopped_at IS NULL`).all(intent.campaignId) as Array<{session_id:string}>;
      if(sessions.length!==1)throw new WorldConflictError("campaign world session is ambiguous");
      const result=setActorLocation(principalId,sessions[0]!.session_id,{type:"set_actor_location",campaignId:intent.campaignId,actorId,
        locationId:intent.locationId,expectedRevision:intent.expectedRevision,idempotencyKey:intent.idempotencyKey});
      db.prepare("INSERT OR IGNORE INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(intent.campaignId,actorId,intent.locationId,result.receipt.occurredAt);
      return {campaignId:intent.campaignId,sessionId:sessions[0]!.session_id,location:{actorId,locationId:intent.locationId,revision:0,
        updatedAt:result.receipt.occurredAt},...result};
    }).immediate();
  }
  function discoverLocation(principalId: string, sessionId: string, raw: unknown): MutationReceipt {
    context.guard(); return db.transaction(() => { const mutation = begin(principalId, sessionId, discoverLocationCommandSchema.parse(raw), "discover_location", () => requireGm(principalId, (raw as any).campaignId)); if (mutation.replay) return JSON.parse(mutation.replay.canonical_result_json); const command = mutation.command;
      if (!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(command.campaignId, command.actorId) || !db.prepare("SELECT 1 FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=?").get(command.campaignId, command.locationId)) throw new WorldUnavailableError("actor or location is unavailable"); const result = receipt(mutation, command.idempotencyKey); record(command, sessionId, "discover_location", command.actorId, mutation, result, "location_discovered", { actorId: command.actorId, locationId: command.locationId }); db.prepare("INSERT OR IGNORE INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(command.campaignId, command.actorId, command.locationId, mutation.at); return result;
    }).immediate();
  }
  function travel(principalId: string, sessionId: string, raw: TravelCommand): WorldReceipt {
    context.guard();const command=travelCommandSchema.parse(raw);
    return db.transaction(()=>executeLegacyTravelInTransaction(db,context,principalId,sessionId,command)).immediate();
  }
  function travelActor(principalId:string,actorIdInput:string,input:ActorTravelCommandRequest):ActorTravelResult{
    context.guard();const actorId=resourceIdSchema.parse(actorIdInput),intent=actorTravelCommandRequestSchema.parse(input);
    return db.transaction(() => {
      const actor=db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(actorId) as {campaign_id:string}|undefined;
      if(!actor)throw new WorldUnavailableError("actor world state is unavailable");
      if(!intent.partyActorIds.includes(actorId))throw new WorldConflictError("route actor must belong to the travel party");
      const persisted=db.prepare(`SELECT command.session_id,command.canonical_request_json FROM world_commands_v28 command
        JOIN campaign_sessions attached ON attached.campaign_id=command.campaign_id AND attached.session_id=command.session_id
        WHERE command.campaign_id=? AND command.actor_id=? AND command.idempotency_key=? AND command.command_type='travel'
        ORDER BY command.session_id`).all(actor.campaign_id,actorId,intent.idempotencyKey) as Array<{session_id:string;canonical_request_json:string}>;
      if(persisted.length>1)throw new WorldConflictError("travel replay is ambiguous");
      if(persisted.length===1){
        return executeActorTravelInTransaction(db,context,principalId,persisted[0]!.session_id,actorId,intent);
      }
      const sessions=db.prepare(`SELECT attached.session_id FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
        WHERE attached.campaign_id=? AND session.state='active' AND session.stopped_at IS NULL ORDER BY attached.attached_at,attached.session_id`)
        .all(actor.campaign_id) as Array<{session_id:string}>;
      if(sessions.length===0)throw new WorldUnavailableError("campaign world session is unavailable");
      if(sessions.length!==1)throw new WorldConflictError("campaign world session is ambiguous");
      return executeActorTravelInTransaction(db, context, principalId, sessions[0]!.session_id, actorId, intent);
    }).immediate();
  }
  function changeReputation(principalId: string, sessionId: string, raw: unknown): MutationReceipt {
    context.guard(); return db.transaction(() => { const mutation = begin(principalId, sessionId, changeReputationCommandSchema.parse(raw), "change_reputation", () => requireGm(principalId, (raw as any).campaignId)); if (mutation.replay) return JSON.parse(mutation.replay.canonical_result_json); const command = mutation.command;
      if (!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(command.campaignId, command.actorId) || !db.prepare("SELECT 1 FROM campaign_factions_v28 WHERE campaign_id=? AND faction_id=?").get(command.campaignId, command.factionId)) throw new WorldUnavailableError("reputation subject is unavailable"); const reputationLedgerEntryId = command.reputationLedgerEntryId ?? id(); const result = { reputationLedgerEntryId, ...receipt(mutation, command.idempotencyKey) }; record(command, sessionId, "change_reputation", command.actorId, mutation, result, "reputation_changed", { actorId: command.actorId, factionId: command.factionId, delta: command.delta }); db.prepare("INSERT INTO campaign_reputation_ledger_v28 VALUES(?,?,?,?,?,?,?,?,?)").run(reputationLedgerEntryId, command.campaignId, sessionId, command.actorId, command.factionId, command.delta, command.reason, mutation.commandId, mutation.at); return result;
    }).immediate();
  }
  function createCampaignNpc(principalId:string,campaignIdInput:string,input:CreateCampaignNpcHttpRequest):CreateNpcResult{
    context.guard();const campaignId=resourceIdSchema.parse(campaignIdInput),intent=createCampaignNpcHttpRequestSchema.parse(input);
    return db.transaction(()=>{
      const requestValue={type:"create_npc",campaignId,...intent};
      const mutation=narrativeBegin(principalId,campaignId,"create_npc",requestValue,intent.expectedRevision,intent.idempotencyKey);
      if(mutation.replay)return mutation.replay;
      const persona=db.prepare("SELECT fictional_confirmed,is_real_person FROM characters WHERE id=?").get(intent.personaId) as any;
      if(!persona||persona.fictional_confirmed!==1||persona.is_real_person!==0)
        throw new WorldUnavailableError("NPC persona must be fictional and confirmed");
      if(db.prepare(`SELECT 1 FROM campaign_actors actor JOIN campaign_characters character
        ON character.id=actor.campaign_character_id AND character.campaign_id=actor.campaign_id
        WHERE actor.campaign_id=? AND character.character_id=?`).get(campaignId,intent.personaId))
        throw new WorldConflictError("a campaign character cannot be NPC-controlled");
      if(db.prepare("SELECT 1 FROM campaign_npcs_v28 WHERE campaign_id=? AND persona_id=?").get(campaignId,intent.personaId))
        throw new WorldConflictError("persona is already bound to a campaign NPC");
      const npcId=id();
      db.prepare("INSERT INTO campaign_npcs_v28 VALUES(?,?,?,?,?,?)")
        .run(npcId,campaignId,intent.personaId,"manual",intent.publicState.name,mutation.at);
      db.prepare("INSERT INTO campaign_npc_private_state_v28 VALUES(?,?,?,?,?)")
        .run(campaignId,npcId,intent.privateState.goals,intent.privateState.gmNotes,
          intent.privateState.merchantState===null?null:canonical(intent.privateState.merchantState));
      db.prepare("INSERT INTO campaign_npc_metadata_v32 VALUES(?,?,?,?,?,?)")
        .run(npcId,campaignId,canonical(intent.publicState),canonical(intent.privateState),mutation.commandId,mutation.at);
      const npc=campaignNpcHttpSchema.parse({npcId,personaId:intent.personaId,publicState:intent.publicState,
        privateState:intent.privateState,createdAt:mutation.at});
      const result={campaignId,npc,receipt:{commandId:mutation.commandId,idempotencyKey:intent.idempotencyKey,
        revisionBefore:mutation.before,revisionAfter:mutation.after,occurredAt:mutation.at}};
      narrativeRecord(campaignId,npcId,"create_npc",intent.idempotencyKey,mutation,result,"npc_created",{npcId});return result;
    }).immediate();
  }
  function changeNpcRelationship(principalId:string,npcIdInput:string,input:NpcRelationshipCommandHttpRequest):NpcRelationshipResult{
    context.guard();const npcId=resourceIdSchema.parse(npcIdInput),intent=npcRelationshipCommandHttpRequestSchema.parse(input);
    return db.transaction(()=>{
      const npc=db.prepare("SELECT campaign_id FROM campaign_npcs_v28 WHERE npc_id=?").get(npcId) as {campaign_id:string}|undefined;
      if(!npc)throw new WorldUnavailableError("NPC is unavailable");
      const requestValue={type:"change_npc_relationship",npcId,...intent};
      const mutation=narrativeBegin(principalId,npc.campaign_id,"change_npc_relationship",requestValue,
        intent.expectedRevision,intent.idempotencyKey);if(mutation.replay)return mutation.replay;
      if(!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(npc.campaign_id,intent.subjectActorId))
        throw new WorldUnavailableError("relationship actor is unavailable");
      const prior=db.prepare(`SELECT affinity,trust,fear FROM campaign_npc_relationships_v32
        WHERE campaign_id=? AND npc_id=? AND actor_id=?`).get(npc.campaign_id,npcId,intent.subjectActorId) as any;
      const legacy=prior?undefined:db.prepare(`SELECT disposition FROM campaign_npc_relationships_v28
        WHERE campaign_id=? AND npc_id=? AND actor_id=?`).get(npc.campaign_id,npcId,intent.subjectActorId) as any;
      const affinity=(prior?.affinity??legacy?.disposition??0)+intent.affinityDelta,trust=(prior?.trust??0)+intent.trustDelta,
        fear=(prior?.fear??0)+intent.fearDelta;
      if([affinity,trust,fear].some((value)=>value < -1000||value>1000))
        throw new WorldConflictError("relationship bounds would be exceeded");
      db.prepare(`INSERT INTO campaign_npc_relationships_v32(campaign_id,npc_id,actor_id,affinity,trust,fear,last_command_id,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(campaign_id,npc_id,actor_id) DO UPDATE SET affinity=excluded.affinity,
        trust=excluded.trust,fear=excluded.fear,last_command_id=excluded.last_command_id,updated_at=excluded.updated_at`)
        .run(npc.campaign_id,npcId,intent.subjectActorId,affinity,trust,fear,mutation.commandId,mutation.at);
      const relationship=npcRelationshipHttpSchema.parse({npcId,subjectActorId:intent.subjectActorId,affinity,trust,fear,updatedAt:mutation.at});
      const result={campaignId:npc.campaign_id,npcId,relationship,receipt:{commandId:mutation.commandId,
        idempotencyKey:intent.idempotencyKey,revisionBefore:mutation.before,revisionAfter:mutation.after,occurredAt:mutation.at}};
      narrativeRecord(npc.campaign_id,npcId,"change_npc_relationship",intent.idempotencyKey,mutation,result,
        "npc_relationship_changed",{relationship,reason:intent.reason});return result;
    }).immediate();
  }
  function createCampaignFaction(principalId:string,campaignIdInput:string,input:CreateCampaignFactionHttpRequest):CreateFactionResult{
    context.guard();const campaignId=resourceIdSchema.parse(campaignIdInput),intent=createCampaignFactionHttpRequestSchema.parse(input);
    return db.transaction(()=>{const mutation=narrativeBegin(principalId,campaignId,"create_faction",{type:"create_faction",campaignId,...intent},intent.expectedRevision,intent.idempotencyKey);
      if(mutation.replay)return mutation.replay;const factionId=id();
      db.prepare("INSERT INTO campaign_factions_v28 VALUES(?,?,?,?,?)").run(factionId,campaignId,intent.name,intent.privateState.visibility,mutation.at);
      db.prepare("INSERT INTO campaign_faction_private_state_v28 VALUES(?,?,?)").run(campaignId,factionId,intent.privateState.gmNotes);
      db.prepare("INSERT INTO campaign_faction_metadata_v32 VALUES(?,?,?,?,?,?)").run(factionId,campaignId,canonical(intent.publicState),canonical(intent.privateState),mutation.commandId,mutation.at);
      const faction=campaignFactionHttpSchema.parse({factionId,name:intent.name,publicState:intent.publicState,privateState:intent.privateState,createdAt:mutation.at});
      const result={campaignId,faction,receipt:{commandId:mutation.commandId,idempotencyKey:intent.idempotencyKey,revisionBefore:mutation.before,revisionAfter:mutation.after,occurredAt:mutation.at}};
      narrativeRecord(campaignId,factionId,"create_faction",intent.idempotencyKey,mutation,result,"faction_created",{factionId});return result;
    }).immediate();
  }
  function changeFactionReputation(principalId:string,factionIdInput:string,input:FactionReputationCommandHttpRequest):FactionReputationResult{
    context.guard();const factionId=resourceIdSchema.parse(factionIdInput),intent=factionReputationCommandHttpRequestSchema.parse(input);
    return db.transaction(()=>{const faction=db.prepare("SELECT campaign_id FROM campaign_factions_v28 WHERE faction_id=?").get(factionId) as any;
      if(!faction)throw new WorldUnavailableError("faction is unavailable");const campaignId=faction.campaign_id;
      const mutation=narrativeBegin(principalId,campaignId,"change_faction_reputation",{type:"change_faction_reputation",factionId,...intent},intent.expectedRevision,intent.idempotencyKey);
      if(mutation.replay)return mutation.replay;if(!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaignId,intent.subjectActorId))throw new WorldUnavailableError("reputation subject is unavailable");
      const current=(db.prepare(`SELECT coalesce(sum(delta),0) reputation FROM (SELECT delta FROM campaign_reputation_ledger_v28
        WHERE campaign_id=? AND faction_id=? AND actor_id=? UNION ALL SELECT delta FROM campaign_faction_reputation_v32
        WHERE campaign_id=? AND faction_id=? AND actor_id=?)`).get(campaignId,factionId,intent.subjectActorId,campaignId,factionId,intent.subjectActorId) as any).reputation;
      const reputation=current+intent.delta;if(!Number.isSafeInteger(reputation))throw new WorldConflictError("reputation bounds would be exceeded");
      db.prepare("INSERT INTO campaign_faction_reputation_v32 VALUES(?,?,?,?,?,?,?,?)").run(id(),campaignId,factionId,intent.subjectActorId,intent.delta,intent.reason,mutation.commandId,mutation.at);
      const standing=factionStandingHttpSchema.parse({factionId,subjectActorId:intent.subjectActorId,reputation,updatedAt:mutation.at});
      const result={campaignId,factionId,standing,receipt:{commandId:mutation.commandId,idempotencyKey:intent.idempotencyKey,revisionBefore:mutation.before,revisionAfter:mutation.after,occurredAt:mutation.at}};
      narrativeRecord(campaignId,factionId,"change_faction_reputation",intent.idempotencyKey,mutation,result,"faction_reputation_changed",{standing,delta:intent.delta,reason:intent.reason});return result;
    }).immediate();
  }
  function createLocation(principalId: string, input: any) { context.guard(); const campaignId = String(input.campaignId); requireGm(principalId, campaignId); const locationId = input.locationId ?? id(); db.prepare("INSERT INTO campaign_locations_v28(location_id,campaign_id,parent_location_id,public_name,public_description,visibility,created_at) VALUES(?,?,?,?,?,?,?)").run(locationId, campaignId, input.parentLocationId ?? null, String(input.name).trim(), String(input.description ?? ""), input.visibility === "hidden" ? "gm" : "public", now()); return { locationId, campaignId }; }
  function createLocationConnection(principalId: string, input: any) { context.guard(); const campaignId = String(input.campaignId); requireGm(principalId, campaignId); const locationConnectionId = input.locationConnectionId ?? id(); db.prepare("INSERT INTO campaign_location_connections_v28(connection_id,campaign_id,from_location_id,to_location_id,visibility,route_state,requirement_kind,required_faction_id,minimum_reputation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(locationConnectionId, campaignId, input.fromLocationId, input.toLocationId, input.visibility === "hidden" ? "gm" : "public", input.routeState ?? "open", input.requirementKind ?? "none", input.requiredFactionId ?? null, input.minimumReputation ?? null, now()); return { locationConnectionId, campaignId }; }
  function createNpc(principalId: string, input: any) { context.guard(); const campaignId = String(input.campaignId); requireGm(principalId, campaignId); if (input.speechControl !== undefined && input.speechControl !== "manual") throw new WorldUnavailableError("NPC AI speech is unavailable"); const persona = db.prepare("SELECT fictional_confirmed,is_real_person FROM characters WHERE id=?").get(input.personaId) as any; if (!persona || persona.fictional_confirmed !== 1 || persona.is_real_person !== 0) throw new WorldUnavailableError("NPC persona must be fictional and confirmed"); if (db.prepare("SELECT 1 FROM campaign_actors a JOIN campaign_characters cc ON cc.id=a.campaign_character_id AND cc.campaign_id=a.campaign_id WHERE a.campaign_id=? AND cc.character_id=?").get(campaignId, input.personaId)) throw new WorldConflictError("a campaign character cannot be NPC-controlled"); const npcId = input.npcId ?? id(); db.prepare("INSERT INTO campaign_npcs_v28 VALUES(?,?,?,?,?,?)").run(npcId, campaignId, input.personaId, "manual", String(input.name).trim(), now()); return { npcId, campaignId }; }
  function executeWorldCommand(principalId: string, sessionId: string, input: unknown): WorldReceipt | MutationReceipt { const command = worldCommandSchema.parse(input); switch (command.type) { case "travel": return travel(principalId, sessionId, command); case "set_actor_location": return setActorLocation(principalId, sessionId, command); case "discover_location": return discoverLocation(principalId, sessionId, command); case "change_reputation": return changeReputation(principalId, sessionId, command); } }

  return { executeWorldCommand, travel,travelActor, setActorLocation,placeActor, createLocation, createLocationConnection, createNpc,
    changeReputation,createCampaignNpc,changeNpcRelationship,createCampaignFaction,changeFactionReputation };
}

import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, encounterCreateRequestSchema, encounterStartCommandRequestSchema, encounterCancelCommandRequestSchema, type EncounterCreateRequest, type EncounterStartCommandRequest, type EncounterCancelCommandRequest } from "@velvet/contracts";
import { ensureCombatTacticalMap } from "../../combatTacticalMap.js";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterUnavailableError } from "../encounterErrors.js";
import type { EncounterCombatSnapshot, EncounterLifecycleSnapshot } from "../encounterReadRepo.js";
import { beginDndCombatTurn } from "../combatActionPlan.js";
import { advanceRevision, beginProtocol, campaignInitiative, canonical, digest, enemyDefinition, gm, id, now, sealReceipt, type EncounterResult, type EncounterWriteDependencies } from "./shared.js";

export function createCreateLifecycleEncounter(db:DatabaseDriver.Database,deps:EncounterWriteDependencies){
  return (p:string,campaignId:string,input:EncounterCreateRequest):EncounterResult<{campaignId:string;encounter:EncounterLifecycleSnapshot}>=>{
    deps.assertFactoryMutation();
    const parsedCampaignId=resourceIdSchema.parse(campaignId), command=encounterCreateRequestSchema.parse(input), request=canonical(command);
    return db.transaction(()=>{
      if(!gm(db,p,parsedCampaignId))throw new EncounterAuthorizationError("encounter creation requires GM authority");
      const replay=db.prepare(`SELECT metadata.encounter_id,metadata.canonical_create_request_json,receipt.canonical_result_json
        FROM encounter_lifecycle_v31 metadata
        LEFT JOIN combat_commands_v27 command ON command.encounter_id=metadata.encounter_id
          AND command.idempotency_key=metadata.create_idempotency_key
        LEFT JOIN combat_receipts_v27 receipt ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        WHERE metadata.campaign_id=? AND metadata.create_idempotency_key=?`).get(parsedCampaignId,command.idempotencyKey) as any;
      if(replay){
        if(replay.canonical_create_request_json!==request||typeof replay.canonical_result_json!=="string")
          throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      if(!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(parsedCampaignId,command.sessionId))
        throw new EncounterUnavailableError("session does not belong to campaign");
      if(db.prepare("SELECT 1 FROM encounter WHERE session_id=? AND status IN ('preparing','active')").get(command.sessionId))
        throw new EncounterConflictError("session already has an open encounter");
      for(const combatant of command.combatants){
        if(combatant.kind==="actor"){
          if(!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(parsedCampaignId,combatant.actorId))
            throw new EncounterUnavailableError("actor is unavailable");
        }else if(!enemyDefinition(db,parsedCampaignId,combatant.template)){
          throw new EncounterUnavailableError("enemy template is unavailable");
        }
      }

      const encounterId=id(deps),at=now(deps),commandId=id(deps);
      db.prepare(`INSERT INTO encounter(encounter_id,campaign_id,session_id,encounter_kind,status,round_number,
        current_turn_combatant_id,state_revision,created_at,updated_at)
        VALUES(?,?,?,'prepared','preparing',0,NULL,0,?,?)`).run(encounterId,parsedCampaignId,command.sessionId,at,at);
      db.prepare("INSERT INTO combat_mutation_revisions_v27 VALUES(?,?,?)").run(encounterId,0,at);
      for(const combatant of command.combatants){
        const combatantId=id(deps),initiative=campaignInitiative(db,deps,parsedCampaignId,combatant.kind==="actor"?combatant.actorId:null),tie=deps.rng.integer(0,1000001);
        if(combatant.kind==="actor"){
          const health=db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
            .get(parsedCampaignId,combatant.actorId) as any;
          const hp=Math.max(0,health?.current??10),maximum=Math.max(1,health?.max??10);
          db.prepare(`INSERT INTO combatant(combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,
            initiative,initiative_tiebreaker,hit_points,maximum_hit_points,status,state_revision,created_at,updated_at)
            VALUES(?,?,?,?,'actor',?,?,?,?,?,'active',0,?,?)`)
            .run(combatantId,encounterId,parsedCampaignId,combatant.actorId,combatant.team,initiative,tie,hp,maximum,at,at);
        }else{
          const definition=enemyDefinition(db,parsedCampaignId,combatant.template);
          if(!definition)throw new EncounterUnavailableError("enemy template is unavailable");
          db.prepare(`INSERT INTO combatant(combatant_id,encounter_id,campaign_id,actor_id,combatant_kind,team,
            initiative,initiative_tiebreaker,hit_points,maximum_hit_points,status,state_revision,created_at,updated_at)
            VALUES(?,?,?,NULL,'enemy',?,?,?,?,?,'active',0,?,?)`)
            .run(combatantId,encounterId,parsedCampaignId,combatant.team,initiative,tie,definition.maximumHitPoints,definition.maximumHitPoints,at,at);
          db.prepare(`INSERT INTO encounter_enemy_provenance_v31
            (combatant_id,encounter_id,campaign_id,pack_id,pack_version,kind,definition_id)
            VALUES(?,?,?,?,?,'enemy-template',?)`).run(combatantId,encounterId,parsedCampaignId,
              combatant.template.packId,combatant.template.packVersion,combatant.template.definitionId);
        }
      }
      db.prepare(`INSERT INTO encounter_lifecycle_v31(encounter_id,campaign_id,session_id,name,
        create_idempotency_key,canonical_create_request_json,request_digest) VALUES(?,?,?,?,?,?,?)`)
        .run(encounterId,parsedCampaignId,command.sessionId,command.name,command.idempotencyKey,request,digest(JSON.parse(request)));
      const internal={type:"create_encounter",encounterId,idempotencyKey:command.idempotencyKey};
      beginProtocol(db,deps,internal,request,commandId,null,0,1,at,"encounter_state_changed",{kind:"encounter_created"},"encounter_state",0);
      db.prepare("UPDATE encounter SET state_revision=1,updated_at=? WHERE encounter_id=?").run(at,encounterId);
      advanceRevision(db,encounterId,1,at);
      const encounter=deps.reads.listEncounters(p,parsedCampaignId)?.find((value)=>value.encounterId===encounterId);
      if(!encounter)throw new Error("created encounter projection is unavailable");
      const result={campaignId:parsedCampaignId,encounter,receipt:{commandId,idempotencyKey:command.idempotencyKey,revisionBefore:0,revisionAfter:1,occurredAt:at}};
      sealReceipt(db,encounterId,commandId,1,at,result);
      return result;
    }).immediate();
  };
}

export function createCancelPreparingEncounter(db:DatabaseDriver.Database,deps:EncounterWriteDependencies){
  return (p:string,encounterIdInput:string,input:EncounterCancelCommandRequest):EncounterResult<{campaignId:string;encounterId:string;encounter:EncounterLifecycleSnapshot}>=>{
    deps.assertFactoryMutation();
    const encounterId=resourceIdSchema.parse(encounterIdInput),command=encounterCancelCommandRequestSchema.parse(input),request=canonical(command);
    return db.transaction(()=>{
      const encounter=db.prepare("SELECT * FROM encounter WHERE encounter_id=?").get(encounterId) as any;
      if(!encounter)throw new EncounterUnavailableError("encounter unavailable");
      if(!gm(db,p,encounter.campaign_id))throw new EncounterAuthorizationError("encounter cancellation requires GM authority");
      const replay=db.prepare(`SELECT command.canonical_request_json,receipt.canonical_result_json
        FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt
          ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        WHERE command.encounter_id=? AND command.idempotency_key=?`).get(encounterId,command.idempotencyKey) as any;
      if(replay){
        if(replay.canonical_request_json!==request)throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      const root=db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(encounterId) as any;
      if(!root||root.revision!==command.expectedRevision)throw new EncounterStaleError("encounter revision is stale");
      if(encounter.status!=="preparing")throw new EncounterConflictError("only a preparing encounter can be cancelled");
      const before=root.revision,after=before+1,at=now(deps),commandId=id(deps);
      const internal={type:"cancel_encounter",encounterId,idempotencyKey:command.idempotencyKey};
      beginProtocol(db,deps,internal,request,commandId,null,before,after,at,"encounter_state_changed",
        {kind:"encounter_completed"},"encounter_state",0);
      db.prepare(`UPDATE encounter SET status='cancelled',current_turn_combatant_id=NULL,
        state_revision=state_revision+1,updated_at=? WHERE encounter_id=?`).run(at,encounterId);
      advanceRevision(db,encounterId,after,at);
      const encounterProjection=deps.reads.listEncounters(p,encounter.campaign_id)?.find((value)=>value.encounterId===encounterId);
      if(!encounterProjection)throw new Error("cancelled encounter projection is unavailable");
      const receipt={commandId,idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at};
      const result={campaignId:encounterProjection.campaignId,encounterId,encounter:encounterProjection,receipt};
      sealReceipt(db,encounterId,commandId,after,at,result);
      return result;
    }).immediate();
  };
}

export function createStartLifecycleEncounter(db:DatabaseDriver.Database,deps:EncounterWriteDependencies){
  return (p:string,encounterIdInput:string,input:EncounterStartCommandRequest):EncounterResult<{campaignId:string;encounterId:string;combat:EncounterCombatSnapshot}>=>{
    deps.assertFactoryMutation();
    const encounterId=resourceIdSchema.parse(encounterIdInput),command=encounterStartCommandRequestSchema.parse(input),request=canonical(command);
    return db.transaction(()=>{
      const encounter=db.prepare("SELECT * FROM encounter WHERE encounter_id=?").get(encounterId) as any;
      if(!encounter)throw new EncounterUnavailableError("encounter unavailable");
      if(!gm(db,p,encounter.campaign_id))throw new EncounterAuthorizationError("encounter start requires GM authority");
      const replay=db.prepare(`SELECT command.canonical_request_json,receipt.canonical_result_json
        FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt
          ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        WHERE command.encounter_id=? AND command.idempotency_key=?`).get(encounterId,command.idempotencyKey) as any;
      if(replay){
        if(replay.canonical_request_json!==request)throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      const root=db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(encounterId) as any;
      if(!root||root.revision!==command.expectedRevision)throw new EncounterStaleError("encounter revision is stale");
      if(encounter.status!=="preparing")throw new EncounterConflictError("encounter cannot be started");
      const preparedActors=db.prepare(`SELECT combatant.hit_points,combatant.maximum_hit_points,
        health.current health_current,health.max health_max FROM combatant
        LEFT JOIN rpg_actor_resources health ON health.campaign_id=combatant.campaign_id
          AND health.actor_id=combatant.actor_id AND health.name='health'
        WHERE combatant.encounter_id=? AND combatant.actor_id IS NOT NULL`).all(encounterId) as Array<{
          hit_points:number;maximum_hit_points:number;health_current:number|null;health_max:number|null}>;
      if(preparedActors.some(actor=>actor.health_current===null||actor.health_max===null||actor.health_current<=0
          ||actor.hit_points!==actor.health_current||actor.maximum_hit_points!==actor.health_max))
        throw new EncounterConflictError("prepared actor health changed before encounter activation");
      if(db.prepare(`SELECT 1 FROM combatant candidate JOIN combatant active ON active.actor_id=candidate.actor_id
        JOIN encounter other ON other.encounter_id=active.encounter_id AND other.status='active'
        WHERE candidate.encounter_id=? AND candidate.actor_id IS NOT NULL AND active.encounter_id<>? LIMIT 1`)
        .get(encounterId,encounterId))throw new EncounterConflictError("an actor is already in an active encounter");
      if(db.prepare("SELECT 1 FROM encounter WHERE session_id=? AND status='active' AND encounter_id<>?")
        .get(encounter.session_id,encounterId))throw new EncounterConflictError("session already has an active encounter");
      const first=db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=? AND status='active'
        ORDER BY initiative DESC,initiative_tiebreaker,combatant_id LIMIT 1`).get(encounterId) as any;
      if(!first)throw new EncounterConflictError("encounter has no active combatants");
      const before=root.revision,after=before+1,at=now(deps),commandId=id(deps);
      const internal={type:"start_encounter",encounterId,idempotencyKey:command.idempotencyKey};
      beginProtocol(db,deps,internal,request,commandId,null,before,after,at,"encounter_state_changed",
        {kind:"initiative_resolved",combatantId:first.combatant_id},"encounter_state",0);
      db.prepare(`UPDATE encounter SET status='active',round_number=1,current_turn_combatant_id=?,
        state_revision=state_revision+1,updated_at=? WHERE encounter_id=?`).run(first.combatant_id,at,encounterId);
      beginDndCombatTurn(db,encounter.campaign_id,encounterId,first.combatant_id,1,id(deps),at);
      // Every started encounter owns a tactical map. Generation shares this
      // transaction, so the map and the activated encounter commit together and
      // a replayed start returns the stored receipt without generating again.
      ensureCombatTacticalMap(db, deps, { principalId: p, campaignId: encounter.campaign_id,
        sessionId: encounter.session_id, encounterId });
      advanceRevision(db,encounterId,after,at);
      const combat=deps.reads.getCombatState(p,encounterId);
      if(!combat)throw new Error("started combat projection is unavailable");
      const result={campaignId:encounter.campaign_id,encounterId,combat,receipt:{commandId,
        idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at}};
      sealReceipt(db,encounterId,commandId,after,at,result);
      return result;
    }).immediate();
  };
}

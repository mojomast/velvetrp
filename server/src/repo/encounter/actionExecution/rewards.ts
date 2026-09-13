import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, combatEndCommandRequestSchema, currencyCatalogDefinitionSchema, currencyCodeSchema, enemyTemplateCatalogDefinitionSchema, combatEndCommandResponseSchema, type CombatEndCommandRequest } from "@velvet/contracts";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterUnavailableError } from "../encounterErrors.js";
import type { EncounterLifecycleSnapshot } from "../encounterReadRepo.js";
import { endDndCombatTurn, isDndCombat } from "../combatActionPlan.js";
import { advanceRevision, beginProtocol, canonical, gm, id, now, sealReceipt, type EncounterResult, type EncounterRewardGrantSnapshot, type EncounterWriteDependencies } from "./shared.js";

export function ensureRewardCurrency(db:DatabaseDriver.Database,campaignId:string):{code:string;reference:{kind:"currency";packId:string;packVersion:string;definitionId:string}}{
  const boundRows=db.prepare(`SELECT currency.currency_code,definition.pack_id,definition.pack_version,
      definition.definition_id,definition.definition_json
    FROM rpg_currency_references_v25 currency JOIN campaign_catalog_current_pins pin
      ON pin.campaign_id=currency.campaign_id AND pin.pack_id=currency.pack_id AND pin.pack_version=currency.pack_version
    JOIN rpg_catalog_definitions definition ON definition.pack_id=currency.pack_id
      AND definition.pack_version=currency.pack_version AND definition.kind=currency.kind
      AND definition.definition_id=currency.definition_id
    WHERE currency.campaign_id=? AND currency.kind='currency'
    ORDER BY currency.currency_code COLLATE BINARY LIMIT 2`).all(campaignId) as Array<{
      currency_code:string;pack_id:string;pack_version:string;definition_id:string;definition_json:string}>;
  if(boundRows.length>1)throw new EncounterConflictError("combat reward currency is unavailable or ambiguous");
  const rows=boundRows.length===1?boundRows:db.prepare(`SELECT NULL currency_code,definition.pack_id,definition.pack_version,
      definition.definition_id,definition.definition_json
    FROM campaign_catalog_current_pins pin JOIN rpg_catalog_definitions definition
    ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
    WHERE pin.campaign_id=? AND definition.kind='currency'
    ORDER BY pin.position,definition.definition_id COLLATE BINARY LIMIT 2`).all(campaignId) as Array<{
      currency_code:null;pack_id:string;pack_version:string;definition_id:string;definition_json:string}>;
  if(rows.length!==1)throw new EncounterConflictError("combat reward currency is unavailable or ambiguous");
  const row=rows[0]!,definition=currencyCatalogDefinitionSchema.parse(JSON.parse(row.definition_json));
  if(definition.reference.packId!==row.pack_id||definition.reference.packVersion!==row.pack_version
    ||definition.reference.definitionId!==row.definition_id)throw new EncounterConflictError("combat reward currency is malformed");
  const reference={kind:"currency" as const,packId:row.pack_id,packVersion:row.pack_version,definitionId:row.definition_id};
  const code=currencyCodeSchema.parse(definition.mechanics.symbol.toUpperCase());
  if(!db.prepare(`SELECT 1 FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=? AND pack_id=?
      AND pack_version=? AND kind='currency' AND definition_id=?`)
    .get(campaignId,reference.packId,reference.packVersion,reference.definitionId)){
    db.prepare(`INSERT INTO rpg_campaign_catalog_definitions_v25
      (campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'currency',?)`)
      .run(campaignId,reference.packId,reference.packVersion,reference.definitionId);
  }
  if(row.currency_code)return {code:row.currency_code,reference};
  const existing=db.prepare(`SELECT currency_code FROM rpg_currency_references_v25 WHERE campaign_id=?
    AND pack_id=? AND pack_version=? AND kind='currency' AND definition_id=?`)
    .get(campaignId,reference.packId,reference.packVersion,reference.definitionId) as {currency_code:string}|undefined;
  if(existing)return {code:existing.currency_code,reference};
  if(db.prepare("SELECT 1 FROM rpg_currency_references_v25 WHERE campaign_id=? AND currency_code=?").get(campaignId,code))
    throw new EncounterConflictError("combat reward currency code is unavailable");
  db.prepare(`INSERT INTO rpg_currency_references_v25
    (campaign_id,currency_code,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,'currency',?)`)
    .run(campaignId,code,reference.packId,reference.packVersion,reference.definitionId);
  return {code,reference};
}

export function createEndCombat(db:DatabaseDriver.Database,deps:EncounterWriteDependencies){
  return (p:string,combatIdInput:string,input:CombatEndCommandRequest):EncounterResult<{campaignId:string;encounterId:string;encounter:EncounterLifecycleSnapshot;rewards:EncounterRewardGrantSnapshot[]}>=>{
    deps.assertFactoryMutation();
    const combatId=resourceIdSchema.parse(combatIdInput),command=combatEndCommandRequestSchema.parse(input),request=canonical(command);
    return db.transaction(()=>{
      const row=db.prepare("SELECT * FROM encounter WHERE encounter_id=?").get(combatId) as any;
      if(!row)throw new EncounterUnavailableError("combat unavailable");
      if(!gm(db,p,row.campaign_id))throw new EncounterAuthorizationError("combat end requires GM authority");
      const replay=db.prepare(`SELECT command.command_type,command.canonical_request_json,receipt.canonical_result_json
        FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt
          ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        WHERE command.encounter_id=? AND command.idempotency_key=?`).get(combatId,command.idempotencyKey) as any;
      if(replay){
        if(replay.command_type!=="grant_rewards"||replay.canonical_request_json!==request)
          throw new EncounterConflictError("idempotency key was reused");
        return JSON.parse(replay.canonical_result_json);
      }
      const root=db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(combatId) as any;
      if(!root||root.revision!==command.expectedRevision)throw new EncounterStaleError("combat revision is stale");
      const living=isDndCombat(db,row.campaign_id)?"IN ('active','unconscious','stable')":"='active'";
      const teams=(db.prepare(`SELECT count(DISTINCT team) count FROM combatant WHERE encounter_id=? AND status ${living}`)
        .get(combatId) as {count:number}).count;
      if(row.status!=="active"||row.current_turn_combatant_id!==null||teams>=2)
        throw new EncounterConflictError("combat is not terminal");

      const activeTeam=(db.prepare(`SELECT team FROM combatant WHERE encounter_id=? AND status ${living} LIMIT 1`)
        .get(combatId) as {team:string}|undefined)?.team??null;
      const recipients=activeTeam==="allies"?(db.prepare(`SELECT DISTINCT actor_id FROM combatant
         WHERE encounter_id=? AND team='allies' AND actor_id IS NOT NULL AND status IN ('active','unconscious','stable','defeated') ORDER BY actor_id`)
        .all(combatId) as Array<{actor_id:string}>).map((value)=>value.actor_id):[];
      const defeatedEnemies=db.prepare(`SELECT provenance.pack_id,provenance.pack_version,provenance.definition_id,
        definition.definition_json FROM combatant combatant
        JOIN encounter_enemy_provenance_v31 provenance ON provenance.combatant_id=combatant.combatant_id
        JOIN rpg_catalog_definitions definition ON definition.pack_id=provenance.pack_id
          AND definition.pack_version=provenance.pack_version AND definition.kind='enemy-template'
          AND definition.definition_id=provenance.definition_id
        WHERE combatant.encounter_id=? AND combatant.team='enemies' AND combatant.status='defeated'
        ORDER BY combatant.combatant_id`).all(combatId) as any[];
      const defeatedCount=(db.prepare(`SELECT count(*) count FROM combatant WHERE encounter_id=?
        AND combatant_kind='enemy' AND team='enemies' AND status='defeated'`).get(combatId) as {count:number}).count;
      if(activeTeam==="allies"&&defeatedEnemies.length!==defeatedCount)
        throw new EncounterConflictError("defeated enemy provenance is incomplete");
      let rewardAmount=0;
      for(const enemy of defeatedEnemies){
        const definition=enemyTemplateCatalogDefinitionSchema.parse(JSON.parse(enemy.definition_json));
        if(definition.reference.packId!==enemy.pack_id||definition.reference.packVersion!==enemy.pack_version
            ||definition.reference.definitionId!==enemy.definition_id)throw new EncounterConflictError("enemy reward provenance is invalid");
        rewardAmount+=definition.mechanics.tier;
      }
      const rewardCurrency=recipients.length>0&&rewardAmount>0?ensureRewardCurrency(db,row.campaign_id):null;
      const before=root.revision,after=before+1,at=now(deps),commandId=id(deps);
      const bundleIds=rewardCurrency?recipients.map(()=>id(deps)):[];
      const internal={type:"end_combat",encounterId:combatId,idempotencyKey:command.idempotencyKey};
      beginProtocol(db,deps,internal,request,commandId,null,before,after,at,"encounter_state_changed",
        {kind:"encounter_completed"},"encounter_state",0);
      db.prepare(`UPDATE encounter SET status='completed',current_turn_combatant_id=NULL,
        state_revision=state_revision+1,updated_at=? WHERE encounter_id=?`).run(at,combatId);
      endDndCombatTurn(db,combatId,at);
      const rewardEventId=id(deps),rewardEvent={kind:"rewards_granted",rewardBundleIds:bundleIds};
      db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(rewardEventId,combatId,commandId,after,
        "rewards_granted",canonical(rewardEvent),at);
      db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(deps),combatId,null,rewardEventId,1,
        "reward",canonical(rewardEvent),at);
      const rewards:EncounterRewardGrantSnapshot[]=[];
      if(rewardCurrency){
        recipients.forEach((recipientActorId,index)=>{
          const rewardBundleId=bundleIds[index]!;
          db.prepare(`INSERT INTO reward_bundle(reward_bundle_id,campaign_id,encounter_id,source_event_id,
            recipient_actor_id,created_at) VALUES(?,?,?,?,?,?)`).run(rewardBundleId,row.campaign_id,combatId,rewardEventId,recipientActorId,at);
          db.prepare(`INSERT INTO reward_entry_v27(reward_entry_id,campaign_id,reward_bundle_id,entry_ordinal,
            reward_kind,amount_minor,currency_code,currency_pack_id,currency_pack_version,currency_kind,
            currency_definition_id,created_at) VALUES(?,?,?,0,'currency',?,?,?,?, 'currency',?,?)`)
            .run(id(deps),row.campaign_id,rewardBundleId,rewardAmount,rewardCurrency.code,rewardCurrency.reference.packId,
              rewardCurrency.reference.packVersion,rewardCurrency.reference.definitionId,at);
          rewards.push({campaignId:row.campaign_id,encounterId:combatId,rewardBundleId,recipientActorId,createdAt:at,
            rewards:[{kind:"currency",currency:rewardCurrency.reference,amount:rewardAmount}],claim:{state:"unclaimed"}});
        });
      }
      advanceRevision(db,combatId,after,at);
      const encounter=deps.reads.listEncounters(p,row.campaign_id)?.find((value)=>value.encounterId===combatId);
      if(!encounter)throw new Error("completed encounter projection is unavailable");
      const receipt={commandId,idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at};
      combatEndCommandResponseSchema.parse({encounter:{encounterId:encounter.encounterId,sessionId:encounter.sessionId,
        name:encounter.name,status:encounter.status,combatId:encounter.combatId,combatants:encounter.combatants,
        revision:encounter.revision,createdAt:encounter.createdAt,updatedAt:encounter.updatedAt},
        rewards:rewards.map(({campaignId:_campaignId,encounterId:_encounterId,...reward})=>reward),
        receipt:{idempotencyKey:receipt.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at}});
      const result={campaignId:row.campaign_id,encounterId:combatId,encounter,rewards,receipt};
      if(canonical(result).length>32_768)throw new EncounterConflictError("combat end result exceeds receipt bounds");
      sealReceipt(db,combatId,commandId,after,at,result);
      return result;
    }).immediate();
  };
}

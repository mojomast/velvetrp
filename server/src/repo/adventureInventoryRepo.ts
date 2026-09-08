import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { adventureInventoryCandidateSchema, adventureInventoryPublicReceiptSchema, adventureInventorySelectionSchema,
  canonicalAgentJson, resourceIdSchema, utcIsoTimestampSchema, type AdventureInventoryCandidate,
  type AdventureInventoryPublicReceipt } from "@velvet/contracts";
import type { ActorScopedInventoryCommand, InventoryRepository } from "./inventoryRepo.js";
import { getM15ActorRevision, m15Authorized, type M15Dependencies } from "./actorResourceRepo.js";
import { exactPairParameters, stripCandidateLabels } from "../agent/providerCandidateProjection.js";

const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
type PrivatePlan=ActorScopedInventoryCommand extends infer C ? Omit<Extract<C,object>,"expectedRevision"|"idempotencyKey"> : never;
type Turn={campaignId:string;turnId:string;sessionId:string;actorId:string;principalId:string;revision:number};

export interface AdventureInventoryRepository {
  generateAdventureInventoryCandidates(principalId:string,turnId:string):AdventureInventoryCandidate[];
  executeAdventureInventoryProposal(principalId:string,turnId:string,proposalId:string):{commandId:string;receipt:AdventureInventoryPublicReceipt};
  getAdventureInventoryPublicReceipt(principalId:string,campaignId:string,commandId:string):AdventureInventoryPublicReceipt|null;
  getAdventureInventoryNarrationReceipt(principalId:string,turnId:string,commandId:string):AdventureInventoryPublicReceipt|null;
}

function turnScope(db:DatabaseDriver.Database,principalId:string,turnId:string):Turn|null {
  const row=db.prepare(`SELECT turn.campaign_id campaignId,turn.id turnId,turn.session_id sessionId,turn.actor_id actorId,turn.principal_id principalId
    FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id AND campaign.active_timeline_id=turn.timeline_id
    JOIN campaign_sessions attached ON attached.campaign_id=turn.campaign_id AND attached.session_id=turn.session_id
    JOIN sessions session ON session.id=attached.session_id AND session.state='active' AND session.stopped_at IS NULL
    JOIN campaign_memberships member ON member.campaign_id=turn.campaign_id AND member.principal_id=?
    WHERE turn.id=? AND turn.principal_id=? AND turn.mode='original' AND member.role<>'observer'`)
    .get(principalId,turnId,principalId) as Omit<Turn,"revision">|undefined;
  if(!row||!m15Authorized(db,principalId,row.campaignId,row.actorId))return null;
  return{...row,revision:getM15ActorRevision(db,row.campaignId,row.actorId)};
}

function publicItem(db:DatabaseDriver.Database,campaignId:string,row:any):{label:string;category:string;slot:string|null}|null {
  const definition=db.prepare(`SELECT visibility.public_definition_json FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
      AND visibility.kind='item' AND visibility.definition_id=? AND visibility.publicly_reachable=1
    WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?`).get(row.item_definition_id,campaignId,row.item_pack_id,row.item_pack_version) as any;
  if(!definition)return null;const value=JSON.parse(definition.public_definition_json);
  return typeof value.name==="string"&&typeof value.mechanics?.category==="string"
    ?{label:value.name,category:value.mechanics.category,slot:typeof value.mechanics.slot==="string"?value.mechanics.slot:null}:null;
}

function specs(db:DatabaseDriver.Database,scope:Turn):Array<{public:Omit<AdventureInventoryCandidate,"candidateId"|"digest">;plan:PrivatePlan}> {
  const occupied=new Set((db.prepare("SELECT slot_key FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND equipped=1").all(scope.campaignId,scope.actorId) as any[]).map(row=>row.slot_key));
  const recipients=(db.prepare(`SELECT actor.id actor_id,character.name display_name FROM campaign_actors actor JOIN campaign_characters cc ON cc.campaign_id=actor.campaign_id AND cc.id=actor.campaign_character_id
    JOIN characters character ON character.id=cc.character_id JOIN session_characters participant ON participant.character_id=character.id AND participant.session_id=?
    WHERE actor.campaign_id=? AND actor.id<>? AND actor.kind='player-character' ORDER BY character.name,actor.id`)
    .all(scope.sessionId,scope.campaignId,scope.actorId) as any[]);
  const rows=db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? ORDER BY created_at,entry_id").all(scope.campaignId,scope.actorId) as any[];
  const output:Array<{public:Omit<AdventureInventoryCandidate,"candidateId"|"digest">;plan:PrivatePlan}>=[];
  for(const row of rows){const item=publicItem(db,scope.campaignId,row);if(!item)continue;const quantity=1;
    const reference={kind:"item" as const,packId:row.item_pack_id,packVersion:row.item_pack_version,definitionId:row.item_definition_id};
    if(row.equipped){output.push({public:{itemLabel:item.label,action:"unequip",quantity,slot:row.slot_key,recipient:null,confirmationRequired:false,effect:"inventory-only"},plan:{kind:"unequip",slot:row.slot_key}} as any);continue;}
    if(item.slot&&!occupied.has(item.slot))output.push({public:{itemLabel:item.label,action:"equip",quantity,slot:item.slot as any,recipient:null,confirmationRequired:false,effect:"inventory-only"},plan:{kind:"equip",entryId:row.entry_id,slot:item.slot}} as any);
    output.push({public:{itemLabel:item.label,action:"drop",quantity,slot:null,recipient:null,confirmationRequired:true,effect:"inventory-only"},plan:{kind:"drop",entryId:row.entry_id,item:reference,quantity}} as any);
    if(item.category==="consumable")output.push({public:{itemLabel:item.label,action:"consume",quantity,slot:null,recipient:null,confirmationRequired:true,effect:"none"},plan:{kind:"consume",entryId:row.entry_id,item:reference,quantity}} as any);
    for(const recipient of recipients){const same=Boolean(db.prepare(`SELECT 1 FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND entry_mode='stackable'
        AND item_pack_id=? AND item_pack_version=? AND item_definition_id=?`).get(scope.campaignId,recipient.actor_id,row.item_pack_id,row.item_pack_version,row.item_definition_id));
      const count=(db.prepare("SELECT count(*) count FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=?").get(scope.campaignId,recipient.actor_id) as any).count;
      const capacity=(db.prepare("SELECT max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='inventory-capacity'").get(scope.campaignId,recipient.actor_id) as any)?.max??1000;
      if(same||count<capacity)output.push({public:{itemLabel:item.label,action:"gift",quantity,slot:null,recipient:recipient.display_name,confirmationRequired:true,effect:"inventory-only"},plan:{kind:"gift",recipientActorId:recipient.actor_id,entryId:row.entry_id,item:reference,quantity}} as any);}
  }
  return output;
}

function frame(scope:Turn,value:{public:Omit<AdventureInventoryCandidate,"candidateId"|"digest">;plan:PrivatePlan}) {
  return{version:"v1",campaignId:scope.campaignId,turnId:scope.turnId,sessionId:scope.sessionId,actorId:scope.actorId,principalId:scope.principalId,
    inventoryRevision:scope.revision,...value.public,privateCommand:value.plan};
}

export function createAdventureInventoryRepository(db:DatabaseDriver.Database,deps:M15Dependencies,inventory:InventoryRepository,guard:()=>void):AdventureInventoryRepository {
  const verify=(row:any)=>{const receipt=adventureInventoryPublicReceiptSchema.parse(JSON.parse(row.public_result_json));
    const evidence=db.prepare(`SELECT candidate.candidate_digest,candidate.item_label,candidate.action,candidate.quantity,candidate.slot,candidate.recipient_label,
      binding.provider_call_id,binding.provider_tool_call_id,binding.candidate_id binding_candidate_id,binding.candidate_digest binding_candidate_digest,
      command.command_family,command.command_type,command.expected_revision,command.resulting_revision,command.created_at,
      command.request_digest,command.canonical_request_json,source.canonical_result_json source_result_json,source.result_digest source_result_digest,
      provider.response_digest,context.request_digest provider_request_digest
      FROM adventure_inventory_candidates_v55 candidate JOIN adventure_inventory_proposal_bindings_v55 binding ON binding.candidate_id=candidate.candidate_id
      JOIN rpg_m15_commands_v25 command ON command.campaign_id=candidate.campaign_id AND command.actor_id=candidate.actor_id AND command.command_id=?
      JOIN rpg_m15_receipts_v25 source ON source.campaign_id=command.campaign_id AND source.actor_id=command.actor_id AND source.command_id=command.command_id
      JOIN agent_provider_responses_v39 provider ON provider.campaign_id=candidate.campaign_id AND provider.turn_id=candidate.turn_id AND provider.provider_call_id=binding.provider_call_id
      JOIN agent_provider_contexts_v39 context ON context.context_id=provider.context_id
      WHERE candidate.candidate_id=? AND binding.proposal_id=?`).get(row.inventory_command_id,row.candidate_id,row.proposal_id) as any;
    const selection=adventureInventorySelectionSchema.safeParse(JSON.parse(row.selection_json));
    if(!evidence||!selection.success||selection.data.candidateId!==row.candidate_id||selection.data.digest!==evidence.candidate_digest
      ||sha(row.selection_json)!==row.selection_digest||evidence.binding_candidate_id!==row.candidate_id||evidence.binding_candidate_digest!==evidence.candidate_digest
      ||evidence.provider_call_id!==row.provider_call_id||evidence.provider_tool_call_id!==row.provider_tool_call_id
      ||evidence.response_digest!==row.provider_response_digest||evidence.provider_request_digest!==row.provider_request_digest
      ||evidence.command_family!=="inventory"||evidence.command_type!==({equip:"equip_inventory_item",unequip:"unequip_inventory_item",drop:"drop_inventory_item",
        gift:"transfer_inventory_item",consume:"consume_inventory_item"} as Record<string,string>)[receipt.action]
      ||evidence.expected_revision!==row.revision_before||evidence.resulting_revision!==row.revision_after
      ||evidence.created_at!==row.occurred_at||sha(evidence.canonical_request_json)!==evidence.request_digest
      ||sha(evidence.source_result_json)!==evidence.source_result_digest||receipt.itemLabel!==evidence.item_label||receipt.action!==evidence.action
      ||receipt.quantity!==evidence.quantity||receipt.slot!==evidence.slot||receipt.recipient!==evidence.recipient_label
      ||receipt.revisionBefore!==row.revision_before||receipt.revisionAfter!==row.revision_after||receipt.occurredAt!==row.occurred_at
      ||sha(canonicalAgentJson(receipt as never))!==row.result_digest)throw new Error("adventure inventory receipt is malformed");
    return{commandId:row.inventory_command_id,receipt};};
  return{
    generateAdventureInventoryCandidates(principalInput,turnInput){guard();const principal=resourceIdSchema.parse(principalInput),turnId=resourceIdSchema.parse(turnInput);return db.transaction(()=>{
      const old=db.prepare("SELECT * FROM adventure_inventory_candidate_batches_v55 WHERE turn_id=?").get(turnId) as any;
      if(old){const scope=turnScope(db,principal,turnId);if(!scope)return[];const rows=db.prepare("SELECT * FROM adventure_inventory_candidates_v55 WHERE batch_id=? ORDER BY candidate_id").all(old.batch_id) as any[];
        const candidates=rows.map(row=>adventureInventoryCandidateSchema.parse({candidateId:row.candidate_id,digest:row.candidate_digest,itemLabel:row.item_label,
          action:row.action,quantity:row.quantity,slot:row.slot,recipient:row.recipient_label,confirmationRequired:Boolean(row.confirmation_required),effect:row.effect_kind}));
        const projection=canonicalAgentJson({version:"v1",candidates} as never);if(projection!==old.projection_json||sha(projection)!==old.projection_digest)throw new Error("adventure inventory candidate projection is malformed");return candidates;}
      const scope=turnScope(db,principal,turnId);if(!scope)return[];const issuedAt=utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
      const values=specs(db,scope).map(value=>{const exact=frame(scope,value),digest=sha(canonicalAgentJson(exact as never));return{...value,candidateId:`inventory-candidate:${digest.slice(0,48)}`,digest,exact};});
      if(values.length>512)throw new Error("too many adventure inventory candidates");const candidates=values.map(value=>adventureInventoryCandidateSchema.parse({candidateId:value.candidateId,digest:value.digest,...value.public}))
        .sort((left,right)=>left.candidateId.localeCompare(right.candidateId));
      const projection=canonicalAgentJson({version:"v1",candidates} as never),batchId=`inventory-batch:${sha(turnId).slice(0,48)}`;
      db.prepare("INSERT INTO adventure_inventory_candidate_batches_v55 VALUES(?,?,?,?,?,?,?)").run(batchId,scope.campaignId,turnId,projection,sha(projection),candidates.length,issuedAt);
      const insert=db.prepare("INSERT INTO adventure_inventory_candidates_v55 VALUES("+Array.from({length:18},()=>"?").join(",")+")");
      values.forEach(value=>insert.run(value.candidateId,value.digest,batchId,scope.campaignId,turnId,scope.sessionId,scope.actorId,scope.principalId,scope.revision,
        value.public.itemLabel,value.public.action,value.public.quantity,value.public.slot,value.public.recipient,value.public.confirmationRequired?1:0,value.public.effect,
        canonicalAgentJson(value.plan as never),issuedAt));return candidates;
    }).immediate();},
    executeAdventureInventoryProposal(principalInput,turnIdInput,proposalIdInput){guard();const principal=resourceIdSchema.parse(principalInput),turnId=resourceIdSchema.parse(turnIdInput),proposalId=resourceIdSchema.parse(proposalIdInput);
      return db.transaction(()=>{const existing=db.prepare("SELECT * FROM adventure_inventory_executions_v55 WHERE turn_id=?").get(turnId) as any;if(existing){if(existing.proposal_id!==proposalId)throw new Error("adventure inventory replay changed");return verify(existing);}
        const binding=db.prepare(`SELECT binding.*,candidate.*,proposal.requires_confirmation,proposal.arguments_json,decision.decision FROM adventure_inventory_proposal_bindings_v55 binding
          JOIN adventure_inventory_candidates_v55 candidate ON candidate.candidate_id=binding.candidate_id JOIN tool_proposals proposal ON proposal.proposal_id=binding.proposal_id
          LEFT JOIN confirmation_decisions decision ON decision.proposal_id=proposal.proposal_id WHERE binding.turn_id=? AND binding.proposal_id=?`).get(turnId,proposalId) as any;
        const scope=turnScope(db,principal,turnId);if(!binding||!scope||(binding.requires_confirmation&&binding.decision!=="approved")||(!binding.requires_confirmation&&binding.decision))throw new Error("adventure inventory proposal is not executable");
        const response=db.prepare(`SELECT response.response_json,response.response_digest,context.request_json,context.request_digest,batch.projection_json,batch.projection_digest
          FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id
          JOIN adventure_inventory_candidate_batches_v55 batch ON batch.turn_id=response.turn_id
          WHERE response.turn_id=? AND response.provider_call_id=? AND response.status='succeeded'`).get(turnId,binding.provider_call_id) as any;
        const storedArguments=JSON.parse(binding.arguments_json);
        const selection=adventureInventorySelectionSchema.parse({candidateId:storedArguments.candidateId,digest:storedArguments.digest});
        const settled=response&&JSON.parse(response.response_json),call=settled?.calls?.find((value:any)=>value.providerToolCallId===binding.provider_tool_call_id);
        const request=response&&JSON.parse(response.request_json),projection=response&&JSON.parse(response.projection_json),tool=request?.advertisedToolSchemas?.find((value:any)=>value.name==="exact_inventory_action.select");
        const requestProjection=request?.inventoryCandidateProjection,expectedParameters=exactPairParameters(requestProjection?.candidates??[]);
        if(!response||sha(response.request_json)!==response.request_digest||sha(response.response_json)!==response.response_digest||sha(response.projection_json)!==response.projection_digest
          ||canonicalAgentJson(stripCandidateLabels(requestProjection) as never)!==response.projection_json||!request.advertisedTools?.includes("exact_inventory_action.select")
          ||canonicalAgentJson(tool?.parameters as never)!==canonicalAgentJson(expectedParameters as never)||call?.toolName!=="exact_inventory_action.select"
          ||canonicalAgentJson(call.arguments as never)!==canonicalAgentJson(selection as never))throw new Error("adventure inventory provider evidence is invalid");
        const value={public:{itemLabel:binding.item_label,action:binding.action,quantity:binding.quantity,slot:binding.slot,recipient:binding.recipient_label,
          confirmationRequired:Boolean(binding.confirmation_required),effect:binding.effect_kind},plan:JSON.parse(binding.private_command_json)} as any;
        if(binding.candidate_digest!==sha(canonicalAgentJson(frame({...scope,revision:binding.inventory_revision},value) as never))||scope.revision!==binding.inventory_revision
          ||!specs(db,scope).some(current=>canonicalAgentJson(frame(scope,current) as never)===canonicalAgentJson(frame(scope,value) as never)))throw new Error("adventure inventory candidate is stale or tampered");
        const result=inventory.mutateInventoryForActor(principal,scope.campaignId,scope.actorId,{...value.plan,expectedRevision:scope.revision,idempotencyKey:binding.execution_idempotency_key});
        const receipt=adventureInventoryPublicReceiptSchema.parse({itemLabel:binding.item_label,action:binding.action,quantity:binding.quantity,slot:binding.slot,
          recipient:binding.recipient_label,revisionBefore:result.receipt.revisionBefore,revisionAfter:result.receipt.revisionAfter,occurredAt:result.receipt.occurredAt});
        const resultJson=canonicalAgentJson(receipt as never),selectionJson=canonicalAgentJson(selection as never),executionId=`inventory-execution:${sha(`${turnId}\0${proposalId}`).slice(0,48)}`;
        db.prepare("INSERT INTO adventure_inventory_executions_v55 VALUES("+Array.from({length:18},()=>"?").join(",")+")").run(executionId,binding.candidate_id,scope.campaignId,turnId,proposalId,
          binding.provider_call_id,binding.provider_tool_call_id,selectionJson,sha(selectionJson),response.request_digest,response.response_digest,result.receipt.commandId,scope.actorId,
          result.receipt.revisionBefore,result.receipt.revisionAfter,resultJson,sha(resultJson),result.receipt.occurredAt);return{commandId:result.receipt.commandId,receipt};
      }).immediate();},
    getAdventureInventoryPublicReceipt(principalInput,campaignInput,commandInput){const principal=resourceIdSchema.parse(principalInput),campaign=resourceIdSchema.parse(campaignInput),command=resourceIdSchema.parse(commandInput);
      const row=db.prepare(`SELECT execution.* FROM adventure_inventory_executions_v55 execution JOIN campaign_memberships member ON member.campaign_id=execution.campaign_id AND member.principal_id=?
        WHERE execution.campaign_id=? AND execution.inventory_command_id=?`).get(principal,campaign,command) as any;return row?verify(row).receipt:null;},
    getAdventureInventoryNarrationReceipt(principalInput,turnInput,commandInput){const principal=resourceIdSchema.parse(principalInput),turnId=resourceIdSchema.parse(turnInput),command=resourceIdSchema.parse(commandInput);
      const row=db.prepare(`SELECT execution.* FROM adventure_inventory_executions_v55 execution JOIN adventure_turns turn ON turn.id=? AND turn.campaign_id=execution.campaign_id
        JOIN campaign_memberships member ON member.campaign_id=turn.campaign_id AND member.principal_id=? LEFT JOIN campaign_actor_private_state control ON control.campaign_id=turn.campaign_id AND control.actor_id=turn.actor_id
        WHERE execution.turn_id=? AND execution.inventory_command_id=? AND (member.role IN('owner','gm') OR control.controller_principal_id=?)`).get(turnId,principal,turnId,command,principal) as any;return row?verify(row).receipt:null;},
  };
}

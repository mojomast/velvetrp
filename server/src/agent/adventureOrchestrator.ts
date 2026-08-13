import { createHash } from "node:crypto";
import {
  AGENT_TOOL_REGISTRY_VERSION, POST_V38_AGENT_TOOL_REGISTRY_VERSION, agentRequestObjectSchema, canonicalAgentJson, resourceIdSchema,
  projectExactCandidateForProvider,providerSafeExactCandidateListSchema,
  type AgentJsonObject, type PrivateAdventureTurn,
} from "@velvet/contracts";
import { assembleCampaignAgentContext, campaignContextBasketText, type CampaignAgentAudience,
  type CampaignAgentContextSnapshot } from "../context.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../defaults.js";
import { getPromptPreset } from "../presets.js";
import { completeWithProvider, type CompletionMessage, type ProviderCompletionInput,
  type ProviderCompletionResult } from "../provider/index.js";
import type { Repository } from "../repo/index.js";
import { getHarnessSettings, getProviderSettings } from "../repo/index.js";
import type { HarnessSettings, ProviderSettings } from "../types.js";
import { ADVENTURE_TOOL_LIMITATIONS, executeAdventureRead, parseAdventureToolArguments,
  selectAdventureTools, type AdventureToolName, type SelectedAdventureTool } from "./toolRegistry.js";

const OWNER = "local-owner";
const digest = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 48);
const key = (prefix: string, ...parts: string[]) => `${prefix}:${digest(...parts)}`;
const id = (prefix: string, ...parts: string[]) => resourceIdSchema.parse(`${prefix}:${digest(...parts)}`);

export interface AdventureAgentDependencies {
  complete(input: ProviderCompletionInput): Promise<ProviderCompletionResult>;
  getProvider(): Promise<ProviderSettings>;
  getHarness(): Promise<HarnessSettings>;
  now(): Date;
}

const productionDependencies: AdventureAgentDependencies = {
  complete: completeWithProvider,
  getProvider: getProviderSettings,
  getHarness: getHarnessSettings,
  now: () => new Date(),
};

export type AdventureAgentResult = {
  turn: PrivateAdventureTurn;
  outcome: "completed" | "awaiting-confirmation" | "mechanics-committed" | "fallback" | "in-progress";
  limitations: readonly string[];
};

function privateTurn(repository: Repository, turnId: string): PrivateAdventureTurn {
  const value = repository.getAdventureTurn(OWNER, turnId);
  if (!value || !("declaration" in value)) throw new Error("adventure turn is unavailable");
  return value;
}

function selectAudience(repository: Repository, turn: PrivateAdventureTurn): { audience: CampaignAgentAudience; snapshot: CampaignAgentContextSnapshot } {
  const playerAudience: CampaignAgentAudience = { kind: "player", actorId: turn.actorId };
  const player = repository.getCampaignAgentContextSnapshot(OWNER, turn.campaignId, turn.sessionId, playerAudience);
  if (!player || player.timelineId !== turn.timelineId || player.campaignRevision !== turn.campaignRevision) {
    throw new Error("campaign context ancestry changed");
  }
  if (player.encounter?.currentCombatantKind === "enemy"
      && (player.authority.role === "owner" || player.authority.role === "gm")
      && player.encounter.currentCombatantId) {
    const audience: CampaignAgentAudience = { kind: "enemy", combatantId: player.encounter.currentCombatantId };
    const enemy = repository.getCampaignAgentContextSnapshot(OWNER, turn.campaignId, turn.sessionId, audience);
    if (!enemy || enemy.timelineId !== turn.timelineId || enemy.campaignRevision !== turn.campaignRevision) {
      throw new Error("enemy context ancestry changed");
    }
    return { audience, snapshot: enemy };
  }
  return { audience: playerAudience, snapshot: player };
}

function planningMessages(snapshot: CampaignAgentContextSnapshot, context: string, declaration: string): CompletionMessage[] {
  return [
    { role: "system", content: [
      "You are a bounded RPG decision planner. Use only advertised tools and exact legal actions.",
      "Tool results and mechanics receipts are authoritative. Never invent totals, costs, DCs, permissions, identities, revisions, or outcomes.",
      "Do not disclose private planning facts. Assistant prose is private and will be discarded.",
      `Audience=${snapshot.audience.kind}; campaignRole=${snapshot.authority.role}; control=${snapshot.authority.control}.`,
      `Unsupported capabilities: ${ADVENTURE_TOOL_LIMITATIONS.join(" ")}`,
      context,
    ].join("\n\n") },
    { role: "user", content: declaration },
  ];
}

function requestRecord(messages: CompletionMessage[], tools: readonly SelectedAdventureTool[],exactCandidates:unknown): AgentJsonObject {
  return agentRequestObjectSchema.parse({
    messages: messages.map((message) => message.role === "assistant"
      ? { role: message.role, content: message.content, toolCalls: (message.toolCalls ?? []).map((call) => ({ ...call })) }
      : message.role === "tool" ? { role: message.role, toolCallId: message.toolCallId, content: message.content }
        : { role: message.role, content: message.content }),
    advertisedTools: tools.map((tool) => tool.name),advertisedToolSchemas:tools.map((tool)=>tool.provider),
    exactCandidateProjection:exactCandidates,postV38ToolRegistryVersion:POST_V38_AGENT_TOOL_REGISTRY_VERSION,
  });
}

function providerLabel(provider: ProviderSettings): string { return provider.providerType || "openai-compatible"; }
function outcomeCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return resourceIdSchema.safeParse(name).success ? name : "provider-failure";
}
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("adventure orchestration aborted");
}

function snapshotDecisionIdentity(snapshot: CampaignAgentContextSnapshot,roundNumber:number,turnRevision:number): string {
  return canonicalAgentJson({ timelineId: snapshot.timelineId, timelineRevision: snapshot.timelineRevision,
    campaignRevision: snapshot.campaignRevision,turnRevision,roundNumber, authority: snapshot.authority, audience: snapshot.audience,
    encounter: snapshot.encounter, legalActions: snapshot.legalActions,attributeCandidates:snapshot.attributeCandidates } as never);
}
function contextIdentity(snapshot:CampaignAgentContextSnapshot,basketText:string,roundNumber:number,turnRevision:number):AgentJsonObject {
  return agentRequestObjectSchema.parse({ decisionIdentity:JSON.parse(snapshotDecisionIdentity(snapshot,roundNumber,turnRevision)),
    contextDigest:createHash("sha256").update(basketText).digest("hex") });
}

function validateBatch(result: ProviderCompletionResult, selected: readonly SelectedAdventureTool[], priorIds: Set<string>) {
  const byName = new Map(selected.map((tool) => [tool.name, tool]));
  const calls = result.message.toolCalls ?? [];
  if (calls.length === 0) return { result: "complete" as const, calls: [] };
  const parsed = calls.map((call) => {
    const tool = byName.get(call.name as AdventureToolName);
    if (!tool || priorIds.has(call.id) || !resourceIdSchema.safeParse(call.id).success) throw new Error("provider tool call is out of scope");
    const args = parseAdventureToolArguments(tool, call.arguments);
    return { providerToolCallId: call.id, toolName: tool.name, kind: tool.kind, arguments: args, tool, raw: call };
  });
  if (new Set(parsed.map((call) => call.providerToolCallId)).size !== parsed.length) throw new Error("provider tool call IDs are duplicated");
  const mutations = parsed.filter((call) => call.kind === "mutation");
  if (mutations.length > 1 || (mutations.length === 1 && parsed.length !== 1)) {
    throw new Error("mutation decisions must contain exactly one isolated call");
  }
  return { result: "tool-calls" as const, calls: parsed };
}

function appendMutationProposal(repository: Repository, turn: PrivateAdventureTurn,
  call: ReturnType<typeof validateBatch>["calls"][number], timelineRevision: number, now: Date,
  snapshot?:CampaignAgentContextSnapshot,providerCallId?:string): PrivateAdventureTurn {
  if (call.kind !== "mutation") throw new Error("call is not a mutation");
  const argumentsWithServerRevision = { ...call.arguments, expectedTimelineRevision: timelineRevision };
  const requiresConfirmation = call.tool.confirmation === "required";
  if(call.toolName==="actor_attribute.set"){
    const candidate=snapshot?.attributeCandidates.find((item)=>item.candidateId===call.arguments.attributeCandidateId
      &&item.digest===call.arguments.attributeCandidateDigest);
    if(!candidate)
      throw new Error("attribute is not an authoritative source-actor candidate");
    Object.assign(argumentsWithServerRevision,{attributeId:candidate.commandAttributeId});
  }
  if(call.toolName==="combat_action.execute"){
    const legalActionId=call.arguments.legalActionId,legalActionDigest=call.arguments.legalActionDigest;
    const candidate=snapshot?.encounter?.legalActionCandidates.find((item)=>item.legalActionId===legalActionId&&item.digest===legalActionDigest);
    if(!candidate||!providerCallId)throw new Error("combat action is not an exact advertised candidate");
    Object.assign(argumentsWithServerRevision,{providerCallId,providerToolCallId:call.providerToolCallId,encounterId:snapshot!.encounter!.encounterId,
      commandLegalActionId:candidate.commandLegalActionId,
      expectedCombatRevision:snapshot!.encounter!.revision,targetId:candidate.targetId});
  }
  const expiry = requiresConfirmation ? new Date(now.getTime() + 30 * 60_000).toISOString() : undefined;
  return repository.appendToolProposal(OWNER, {
    turnId: turn.turnId,
    toolName: call.toolName === "actor_dice.roll" ? "roll_actor_dice" : call.toolName==="combat_action.execute"?"combat_action":"set_actor_attribute",
    arguments: argumentsWithServerRevision,
    requiresConfirmation,
    ...(expiry ? { confirmationExpiresAt: expiry } : {}),
    expectedTurnRevision: turn.revision,
    expectedCampaignRevision: turn.campaignRevision,
    idempotencyKey: key("agent-proposal", turn.turnId, call.providerToolCallId),
  });
}

/** Advances an enemy by the first deterministic authoritative plan on every provider failure lane. */
export function executeDeterministicEnemyFallback(repository: Repository, snapshot: CampaignAgentContextSnapshot, turnId: string): void {
  if (snapshot.audience.kind !== "enemy" || !snapshot.encounter) return;
  const idempotencyKey=key("agent-enemy-fallback",turnId,snapshot.encounter.encounterId);
  // The key is revision-independent, so recovery is authoritative and
  // unbounded even when many later combat revisions have already committed.
  const recovered=repository.getCombatCommandResult(OWNER,snapshot.campaignId,snapshot.encounter.encounterId,idempotencyKey);
  if(recovered?.operation==="action"){
    repository.linkAgentCombatReceipt(OWNER,{turnId,encounterId:snapshot.encounter.encounterId,idempotencyKey});return;
  }
  for(let attempt=0;attempt<3;attempt+=1){
    const combat=repository.getCombatState(OWNER,snapshot.encounter.encounterId);
    if(!combat||combat.campaignId!==snapshot.campaignId)break;
    if(combat.currentCombatant!==snapshot.audience.combatantId)return;
    const ordered=[combat.legalActions.find((candidate)=>candidate.kind==="attack"),combat.legalActions.find((candidate)=>candidate.kind==="end-turn"),
      combat.legalActions.find((candidate)=>candidate.kind==="flee")].filter((candidate)=>candidate!==undefined);
    const action=ordered[Math.min(attempt,ordered.length-1)];
    if(!action)break;
    try{repository.resolveCombatAction(OWNER,combat.combatId,{legalActionId:action.legalActionId,targetIds:action.targetIds.slice(0,1),choices:[],expectedRevision:combat.revision,idempotencyKey});}
    catch{const committed=repository.getCombatCommandResult(OWNER,snapshot.campaignId,combat.combatId,idempotencyKey);if(committed?.operation!=="action")continue;}
    repository.linkAgentCombatReceipt(OWNER,{turnId,encounterId:combat.combatId,idempotencyKey});return;
  }
  const turn=privateTurn(repository,turnId);if(!["failed","cancelled","completed"].includes(turn.state))repository.updateAdventureTurnNarration(OWNER,{turnId,
    expectedTurnRevision:turn.revision,expectedCampaignRevision:turn.campaignRevision,idempotencyKey:key("agent-enemy-fallback-failed",turnId),narrationStatus:"failed",terminalState:"failed"});
}

function safeEnemyFallback(repository:Repository,snapshot:CampaignAgentContextSnapshot,turnId:string):void {
  executeDeterministicEnemyFallback(repository,snapshot,turnId);
}
function settleMutationFailure(repository:Repository,turnId:string):PrivateAdventureTurn{
  const turn=privateTurn(repository,turnId);if(["cancelled","failed","completed"].includes(turn.state))return turn;
  try{return repository.updateAdventureTurnNarration(OWNER,{turnId,expectedTurnRevision:turn.revision,
    expectedCampaignRevision:turn.campaignRevision,idempotencyKey:key("agent-mutation-failed",turnId),narrationStatus:"none",terminalState:"cancelled"});}
  catch{return privateTurn(repository,turnId);}
}
function settleProviderFailure(repository:Repository,turnId:string,providerCallId:string,outcomeCode:string):boolean{
  if(repository.getAgentProviderRecovery(OWNER,turnId)?.response)return true;
  try{repository.settleAgentProviderResponse(OWNER,{turnId,providerCallId,status:"failed",outcomeCode});}
  catch{try{repository.settleAgentProviderResponse(OWNER,{turnId,providerCallId,status:"failed",outcomeCode,orphanRecovery:true});}catch{return false;}}
  return repository.getAgentProviderRecovery(OWNER,turnId)?.response?.status!==undefined;
}

/** Runs the restart-safe bounded planning loop. Every database mutation is a short repository command. */
export async function orchestrateAdventureTurn(repository: Repository, turnId: string,
  dependencies: AdventureAgentDependencies = productionDependencies, signal?: AbortSignal): Promise<AdventureAgentResult> {
  throwIfAborted(signal);
  let turn = privateTurn(repository, turnId);
  for(const call of turn.toolCalls){
    if(call.proposal.executionBinding.commandType!=="combat_action"||call.status==="committed")continue;
    const binding=call.proposal.executionBinding;
    const committed=repository.getCombatCommandResult(OWNER,turn.campaignId,binding.encounterId,binding.idempotencyKey);
    if(committed?.operation==="action"){
      repository.linkAgentCombatReceipt(OWNER,{turnId:turn.turnId,encounterId:binding.encounterId,idempotencyKey:binding.idempotencyKey,proposalId:call.proposal.proposalId});
      turn=privateTurn(repository,turnId);
    }
  }
  // Recover an existing dispatch before selecting a fresh audience. A live
  // lease belongs to its original worker; an expired lease can only receive a
  // failed orphan settlement, never a late successful response.
  const earlyRecovery=typeof repository.getAgentProviderRecovery==="function"
    ?repository.getAgentProviderRecovery(OWNER,turn.turnId):null;
  if(earlyRecovery&&!earlyRecovery.response){
    if(earlyRecovery.claim&&!earlyRecovery.claim.expired&&!['completed','cancelled','failed'].includes(turn.state))
      return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
    if(!settleProviderFailure(repository,turn.turnId,earlyRecovery.providerCallId,"orphaned-dispatch-deadline"))
      return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
    return{turn:privateTurn(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};
  }
  // A settled exact-travel response may have committed v47 mechanics before
  // the v48 accounting insert. Recover that evidence before deadline, session,
  // world, or context freshness gates. Repository replay still requires the
  // current exact principal authority; loss of that authority remains hidden.
  if(earlyRecovery?.response?.status==="succeeded"){
    const stored=earlyRecovery.response.response as any,call=stored?.calls?.length===1?stored.calls[0]:null;
    if(stored?.result==="tool-calls"&&call?.toolName==="exact_actor_travel.select"){
      const alreadyBound=turn.receiptLinks.length>0;
      try{repository.bindExactCandidateProviderExecution(OWNER,{turnId:turn.turnId,providerCallId:earlyRecovery.providerCallId,
        providerToolCallId:call.providerToolCallId,round:earlyRecovery.round,selection:call.arguments,requireCommittedExecution:true});
        return{turn:privateTurn(repository,turn.turnId),outcome:alreadyBound?"completed":"mechanics-committed",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      catch{/* No committed v47 execution yet, or current authority was lost. Fresh execution follows only through normal gates. */}
    }
  }
  if (((turn.receiptLinks?.length ?? 0) > 0 || turn.toolCalls.every((call)=>call.status==="committed"))
    && ["mechanics-committed","narrating","completed"].includes(turn.state))
    return{turn,outcome:"completed",limitations:ADVENTURE_TOOL_LIMITATIONS};
  // Confirmation resume executes only immutable approved proposals. Rejected
  // and expired proposals are never passed to a command service.
  for(const call of turn.toolCalls.filter((candidate)=>candidate.status==="approved")){
    try{
      const execution=repository.executeApprovedAgentProposalAtomically(OWNER,turnId,call.proposal.proposalId);
      turn=execution.turn;if(execution.status==="replan")return orchestrateAdventureTurn(repository,turnId,dependencies,signal);
    }catch{return{turn:settleMutationFailure(repository,turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
  }
  if (turn.mode !== "original" || ["mechanics-committed", "narrating", "completed", "cancelled", "failed"].includes(turn.state)) {
    return { turn, outcome: "completed", limitations: ADVENTURE_TOOL_LIMITATIONS };
  }
  let selectedContext: ReturnType<typeof selectAudience>;
  try {
    const persistedAudience=(earlyRecovery?.response?.status==="succeeded"?(earlyRecovery.context as any)?.decisionIdentity?.audience:null) as CampaignAgentAudience|null;
    if(persistedAudience){
      const snapshot=repository.getCampaignAgentContextSnapshot(OWNER,turn.campaignId,turn.sessionId,persistedAudience);
      if(!snapshot||snapshot.timelineId!==turn.timelineId||snapshot.campaignRevision!==turn.campaignRevision)throw new Error("persisted audience is stale");
      selectedContext={audience:persistedAudience,snapshot};
    }else selectedContext = selectAudience(repository, turn);
  }
  catch { return { turn, outcome: "fallback", limitations: ADVENTURE_TOOL_LIMITATIONS }; }
  const { snapshot } = selectedContext;
  const basket = assembleCampaignAgentContext({ snapshot, declaration: turn.declaration });
  const basketText=campaignContextBasketText(basket);
  let exactTravel=providerSafeExactCandidateListSchema.parse({version:"v1",candidates:[]});
  if(snapshot.audience.kind==="player"&&snapshot.audience.actorId===turn.actorId&&snapshot.authority.control!=="none"&&!snapshot.encounter){
    try{const batch=repository.generateActorTravelCandidates(OWNER,{turnId:turn.turnId,
      idempotencyKey:`provider-player:${digest(turn.turnId)}`,audienceMode:"player"});
      exactTravel=providerSafeExactCandidateListSchema.parse({version:"v1",candidates:batch.candidates.map((candidate)=>projectExactCandidateForProvider(candidate,batch.issuedAt))});}
    catch{/* Candidate generation is fail-closed; all established tools remain available. */}
  }
  const currentTools=selectAdventureTools(snapshot,exactTravel.candidates);
  const persistedToolNames=earlyRecovery?.response?.status==="succeeded"&&Array.isArray((earlyRecovery.request as any)?.advertisedTools)
    ?new Set((earlyRecovery.request as any).advertisedTools as string[]):null;
  const selected = persistedToolNames?currentTools.filter((tool)=>persistedToolNames.has(tool.name)):currentTools;
  if(persistedToolNames&&(selected.length!==persistedToolNames.size||selected.some((tool)=>!persistedToolNames.has(tool.name))))
    return{turn,outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};
  const messages = planningMessages(snapshot, `${basketText}\n\nExact travel options (provider-safe): ${canonicalAgentJson(exactTravel as never)}`, turn.declaration);
  const priorIds = new Set<string>();
  const existingPlanning = repository.getDurableAgentPlanningState(OWNER, turn.turnId);
  if(existingPlanning?.deadlineExceeded){const orphan=repository.getAgentProviderRecovery(OWNER,turn.turnId);if(orphan&&!orphan.response
      &&!settleProviderFailure(repository,turn.turnId,orphan.providerCallId,"orphaned-dispatch-deadline"))
      return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
    safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:privateTurn(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
  const pendingMutation = existingPlanning?.toolCalls.find((call) => call.kind === "mutation");
  if (pendingMutation) {
    const persistedContext=repository.getAgentDecisionContext(OWNER,turn.turnId,pendingMutation.providerToolCallId);
    const persistedIdentity=(persistedContext?.context as any)?.decisionIdentity;
    if(!persistedContext||canonicalAgentJson(persistedContext.context)!==canonicalAgentJson(contextIdentity(snapshot,basketText,
      persistedIdentity?.roundNumber,persistedIdentity?.turnRevision))){
      safeEnemyFallback(repository,snapshot,turn.turnId);
      return{turn:settleMutationFailure(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};
    }
    const tool = selected.find((candidate) => candidate.name === pendingMutation.toolName);
    if (!tool || tool.kind !== "mutation") {safeEnemyFallback(repository,snapshot,turn.turnId);return { turn, outcome: "fallback", limitations: ADVENTURE_TOOL_LIMITATIONS };}
    const mutationPosition = existingPlanning!.toolCalls.filter((call) => call.kind === "mutation"
      && (call.round < pendingMutation.round || (call.round === pendingMutation.round && call.position <= pendingMutation.position))).length - 1;
    let proposal = turn.toolCalls.find((call) => call.proposal.position === mutationPosition);
    if (!proposal) {
      const recoveredCall = { providerToolCallId: pendingMutation.providerToolCallId, toolName: tool.name, kind: "mutation" as const,
        arguments: pendingMutation.arguments, tool, raw: { id: pendingMutation.providerToolCallId, name: tool.name,
          arguments: canonicalAgentJson(pendingMutation.arguments) } };
      try{turn = appendMutationProposal(repository, turn, recoveredCall, persistedContext.timelineRevision, dependencies.now(),snapshot,persistedContext.providerCallId);}
       catch{safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:settleMutationFailure(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      proposal = turn.toolCalls.find((call) => call.proposal.position === mutationPosition);
    }
    if (!proposal) {safeEnemyFallback(repository,snapshot,turn.turnId);return { turn, outcome: "fallback", limitations: ADVENTURE_TOOL_LIMITATIONS };}
    if (proposal.proposal.confirmation.state === "pending") {
      if (turn.state === "proposed") turn = repository.waitForToolConfirmation(OWNER, { turnId: turn.turnId,
        expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
        idempotencyKey: key("agent-wait", turn.turnId,proposal.proposal.proposalId) });
      return { turn, outcome: "awaiting-confirmation", limitations: ADVENTURE_TOOL_LIMITATIONS };
    }
    if(proposal.status==="rejected"||proposal.status==="expired"||proposal.status==="cancelled")return{turn,outcome:"completed",limitations:ADVENTURE_TOOL_LIMITATIONS};
    try{const execution=repository.executeApprovedAgentProposalAtomically(OWNER,turn.turnId,proposal.proposal.proposalId);
      turn=execution.turn;if(execution.status==="replan")return orchestrateAdventureTurn(repository,turn.turnId,dependencies,signal);}
       catch{safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:settleMutationFailure(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
    return { turn, outcome: "mechanics-committed", limitations: ADVENTURE_TOOL_LIMITATIONS };
  }
  if (turn.state !== "declared") return { turn, outcome: "completed", limitations: ADVENTURE_TOOL_LIMITATIONS };
  // Rebuild the private transcript from durable calls and finish a read that
  // may have been interrupted after its sealed provider batch.
  const durableReads=existingPlanning?.toolCalls.filter((call)=>call.kind==="read")??[];
  for(const round of [...new Set(durableReads.map((call)=>call.round))].sort((a,b)=>a-b)){
    const roundCalls=durableReads.filter((call)=>call.round===round).sort((a,b)=>a.position-b.position);
    messages.push({role:"assistant",content:null,toolCalls:roundCalls.map((call)=>({id:call.providerToolCallId,name:call.toolName,arguments:canonicalAgentJson(call.arguments)}))});
    for(const durable of roundCalls){
      const tool=selected.find((candidate)=>candidate.name===durable.toolName);
      if(!tool||tool.kind!=="read"){safeEnemyFallback(repository,snapshot,turn.turnId);return{turn,outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      let readOutcome=durable.readOutcome;
      if(!readOutcome){let outcome:{status:"succeeded";result:AgentJsonObject}|{status:"failed";errorCode:string};
        try{outcome={status:"succeeded",result:executeAdventureRead(repository,OWNER,snapshot,basket,tool.name)};}catch{outcome={status:"failed",errorCode:"read-unavailable"};}
        const current=repository.getDurableAgentPlanningState(OWNER,turn.turnId)!;
        repository.markAgentReadOutcome(OWNER,{turnId:turn.turnId,providerToolCallId:durable.providerToolCallId,outcome,
          expectedCampaignRevision:turn.campaignRevision,expectedTurnRevision:turn.revision,expectedExecutionRevision:current.executionRevision,
          idempotencyKey:key("agent-read",turn.turnId,durable.providerToolCallId)});
        readOutcome=repository.getDurableAgentPlanningState(OWNER,turn.turnId)!.toolCalls.find((call)=>call.providerToolCallId===durable.providerToolCallId)!.readOutcome;
      }
      if(!readOutcome){safeEnemyFallback(repository,snapshot,turn.turnId);return{turn,outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      messages.push({role:"tool",toolCallId:durable.providerToolCallId,content:canonicalAgentJson(readOutcome.status==="succeeded"?readOutcome.result!:{error:readOutcome.errorCode!})});
      priorIds.add(durable.providerToolCallId);
    }
  }
  const provider = await dependencies.getProvider().catch(() => defaultProviderSettings());
  throwIfAborted(signal);
  const harness = await dependencies.getHarness().catch(() => defaultHarnessSettings());
  throwIfAborted(signal);

  const recovery=repository.getAgentProviderRecovery(OWNER,turn.turnId);
  if(recovery&&!recovery.response){
    if(recovery.claim&&!recovery.claim.expired)
      return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
    if(!settleProviderFailure(repository,turn.turnId,recovery.providerCallId,"orphaned-start"))
      return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
    safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:privateTurn(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};
  }
  if(recovery?.response?.status!==undefined&&recovery.response.status!=="succeeded"){
    safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:privateTurn(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};
  }
  if(recovery?.response?.status==="succeeded"){
    try{
      if(!recovery.context||!recovery.request||canonicalAgentJson(recovery.context)!==canonicalAgentJson(contextIdentity(snapshot,basketText,recovery.round,
        (recovery.context as any).decisionIdentity?.turnRevision)))throw new Error("stale inbox context");
      const stored=recovery.response.response as any;if(!stored||!Array.isArray(stored.calls))throw new Error("malformed inbox");
      const pseudo:ProviderCompletionResult={message:{role:"assistant",content:stored.calls.length?null:"complete",toolCalls:stored.calls.map((call:any)=>({id:call.providerToolCallId,name:call.toolName,arguments:canonicalAgentJson(call.arguments)}))},usage:null,model:{requestedModel:recovery.model,responseModel:null}};
      const batch=validateBatch(pseudo,selected,priorIds);const planning=repository.getDurableAgentPlanningState(OWNER,turn.turnId)!;
      const travel=batch.calls.find((call)=>call.toolName==="exact_actor_travel.select");
      if(travel){repository.bindExactCandidateProviderExecution(OWNER,{turnId:turn.turnId,providerCallId:recovery.providerCallId,
        providerToolCallId:travel.providerToolCallId,round:recovery.round,selection:travel.arguments});
        return{turn:privateTurn(repository,turn.turnId),outcome:"mechanics-committed",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      const combat=batch.calls.find((call)=>call.toolName==="combat_action.execute");
      if(combat){const timeline=repository.getCampaignTimeline(OWNER,turn.campaignId,turn.timelineId);if(!timeline)throw new Error("timeline unavailable");
        turn=appendMutationProposal(repository,turn,combat,timeline.revision,dependencies.now(),snapshot,recovery.providerCallId);const position=turn.toolCalls.length-1;
        if(combat.tool.confirmation==="required"){turn=repository.waitForToolConfirmation(OWNER,{turnId:turn.turnId,expectedTurnRevision:turn.revision,expectedCampaignRevision:turn.campaignRevision,idempotencyKey:key("agent-wait",turn.turnId,turn.toolCalls[position]!.proposal.proposalId)});return{turn,outcome:"awaiting-confirmation",limitations:ADVENTURE_TOOL_LIMITATIONS};}
        const execution=repository.executeApprovedAgentProposalAtomically(OWNER,turn.turnId,turn.toolCalls[position]!.proposal.proposalId);
        turn=execution.turn;if(execution.status==="replan")return orchestrateAdventureTurn(repository,turn.turnId,dependencies,signal);
        return{turn,outcome:"mechanics-committed",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      repository.persistAgentDecisionRound(OWNER,{turnId:turn.turnId,round:recovery.round,providerCallId:recovery.providerCallId,
        toolRegistryVersion:AGENT_TOOL_REGISTRY_VERSION,request:recovery.request,result:batch.result,
         calls:batch.calls.filter((call)=>call.toolName!=="exact_actor_travel.select").map(({providerToolCallId,toolName,kind,arguments:args})=>({providerToolCallId,
           toolName:toolName as Exclude<AdventureToolName,"combat_action.execute"|"exact_actor_travel.select">,kind,arguments:args})),
        expectedCampaignRevision:turn.campaignRevision,expectedTurnRevision:turn.revision,expectedExecutionRevision:planning.executionRevision,
        idempotencyKey:key("agent-decision",turn.turnId,String(recovery.round))});
      return orchestrateAdventureTurn(repository,turn.turnId,dependencies,signal);
    }catch{safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:privateTurn(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
  }

  while (true) {
    throwIfAborted(signal);
    const planning = repository.getDurableAgentPlanningState(OWNER, turn.turnId);
    if (!planning || planning.deadlineExceeded || planning.decisionRounds >= planning.limits.decisionRounds
        || planning.providerStarts >= planning.limits.providerCalls || planning.totalToolCalls >= planning.limits.toolCalls) break;
    const round = planning.decisionRounds + 1;
    const providerCallId = id("agent-provider", turn.turnId, String(round));
    const request=requestRecord(messages,selected,exactTravel);
    let claim:{claimed:boolean;leaseExpiresAt:string;expired:boolean};
    try {
      claim=repository.claimAgentProviderRound(OWNER, { turnId: turn.turnId, providerCallId, provider: providerLabel(provider),
        model: provider.model.trim() || "unconfigured", attempt: round, expectedCampaignRevision: turn.campaignRevision,
        expectedTurnRevision: turn.revision, expectedExecutionRevision: planning.executionRevision,
        idempotencyKey: key("agent-provider-start", turn.turnId, String(round)),round,timelineId:turn.timelineId,
        timelineRevision:snapshot.timelineRevision,context:contextIdentity(snapshot,basketText,round,turn.revision),request });
    } catch {
      break;
    }
    if(!claim.claimed){
      if(!claim.expired)return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
      if(!settleProviderFailure(repository,turn.turnId,providerCallId,"dispatch-lease-expired"))
        return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
      safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:privateTurn(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};
    }

    let result: ProviderCompletionResult;
    let batch: ReturnType<typeof validateBatch>;
    try {
      const remainingMs = Math.max(1, new Date(planning.deadlineAt).getTime() - dependencies.now().getTime());
      result = await dependencies.complete({ provider, harness, preset: getPromptPreset("default"), messages,
        tools: selected.map((tool) => tool.provider), toolChoice: selected.length ? "auto" : "none",
        signal: AbortSignal.any([AbortSignal.timeout(remainingMs), ...(signal ? [signal] : [])]) });
      throwIfAborted(signal);
      batch = validateBatch(result, selected, priorIds);
      if(dependencies.now().toISOString()>=planning.deadlineAt)throw new Error("provider response arrived after execution deadline");
      const addedMutations = batch.calls.filter((call) => call.kind === "mutation").length;
      if (planning.totalToolCalls + batch.calls.length > planning.limits.toolCalls
          || planning.mutationCalls + addedMutations > planning.limits.mutationCalls) {
        throw new Error("provider batch exceeds remaining execution limits");
      }
      const currentSnapshot = repository.getCampaignAgentContextSnapshot(OWNER, turn.campaignId, turn.sessionId, snapshot.audience);
      if (!currentSnapshot || snapshotDecisionIdentity(currentSnapshot,round,turn.revision) !== snapshotDecisionIdentity(snapshot,round,turn.revision)) {
        throw new Error("campaign decision authority or revision changed");
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if(!settleProviderFailure(repository,turn.turnId,providerCallId,outcomeCode(error)))
        return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
      safeEnemyFallback(repository,snapshot,turn.turnId);return { turn: privateTurn(repository, turn.turnId), outcome: "fallback", limitations: ADVENTURE_TOOL_LIMITATIONS };
    }

    const response=agentRequestObjectSchema.parse({result:batch.result,calls:batch.calls.map(({providerToolCallId,toolName,kind,arguments:args})=>({providerToolCallId,toolName,kind,arguments:args}))});
    try{const settlement=repository.settleAgentProviderResponse(OWNER,{turnId:turn.turnId,providerCallId,status:"succeeded",response,outcomeCode:"ok",
      promptTokens:result.usage?.promptTokens??null,completionTokens:result.usage?.completionTokens??null});
      if(settlement.status!=="succeeded")throw new Error("provider success was terminally orphaned");}catch{
      if(!settleProviderFailure(repository,turn.turnId,providerCallId,"rejected-success-settlement"))
        return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};
      safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:privateTurn(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
    const afterOutcome = repository.getDurableAgentPlanningState(OWNER, turn.turnId)!;
    if (afterOutcome.deadlineExceeded) {
      safeEnemyFallback(repository,snapshot,turn.turnId);return { turn, outcome: "fallback", limitations: ADVENTURE_TOOL_LIMITATIONS };
    }
    const travelMutation=batch.calls.find((call)=>call.toolName==="exact_actor_travel.select");
    if(travelMutation){
      try{repository.bindExactCandidateProviderExecution(OWNER,{turnId:turn.turnId,providerCallId,
        providerToolCallId:travelMutation.providerToolCallId,round,selection:travelMutation.arguments});
        return{turn:privateTurn(repository,turn.turnId),outcome:"mechanics-committed",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      catch{return{turn:privateTurn(repository,turn.turnId),outcome:"in-progress",limitations:ADVENTURE_TOOL_LIMITATIONS};}
    }
    const combatMutation=batch.calls.find((call)=>call.toolName==="combat_action.execute");
    if(combatMutation){
      const timeline=repository.getCampaignTimeline(OWNER,turn.campaignId,turn.timelineId);
      if(!timeline){safeEnemyFallback(repository,snapshot,turn.turnId);return{turn,outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      try{turn=appendMutationProposal(repository,turn,combatMutation,timeline.revision,dependencies.now(),snapshot,providerCallId);}
      catch{safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:settleMutationFailure(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      const position=turn.toolCalls.length-1;
      if(combatMutation.tool.confirmation==="required"){
        turn=repository.waitForToolConfirmation(OWNER,{turnId:turn.turnId,expectedTurnRevision:turn.revision,expectedCampaignRevision:turn.campaignRevision,idempotencyKey:key("agent-wait",turn.turnId,turn.toolCalls[position]!.proposal.proposalId)});
        return{turn,outcome:"awaiting-confirmation",limitations:ADVENTURE_TOOL_LIMITATIONS};
      }
       try{const execution=repository.executeApprovedAgentProposalAtomically(OWNER,turn.turnId,turn.toolCalls[position]!.proposal.proposalId);
          turn=execution.turn;if(execution.status==="replan")return orchestrateAdventureTurn(repository,turn.turnId,dependencies,signal);
         return{turn,outcome:"mechanics-committed",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      catch{safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:settleMutationFailure(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
    }
    const persisted = repository.persistAgentDecisionRound(OWNER, { turnId: turn.turnId, round, providerCallId,
      toolRegistryVersion: AGENT_TOOL_REGISTRY_VERSION, request, result: batch.result,
       calls: batch.calls.filter((call)=>call.toolName!=="exact_actor_travel.select").map(({ providerToolCallId, toolName, kind, arguments: args }) => ({ providerToolCallId,
         toolName:toolName as Exclude<AdventureToolName,"combat_action.execute"|"exact_actor_travel.select">, kind, arguments: args })),
      expectedCampaignRevision: turn.campaignRevision, expectedTurnRevision: turn.revision,
      expectedExecutionRevision: afterOutcome.executionRevision,
      idempotencyKey: key("agent-decision", turn.turnId, String(round)) });

    if (batch.result === "complete") {
      safeEnemyFallback(repository, snapshot, turn.turnId);
      return { turn: privateTurn(repository, turn.turnId), outcome: "completed", limitations: ADVENTURE_TOOL_LIMITATIONS };
    }
    const mutation = batch.calls.find((call) => call.kind === "mutation");
    if (mutation) {
      const timeline = repository.getCampaignTimeline(OWNER, turn.campaignId, turn.timelineId);
      if (!timeline) {safeEnemyFallback(repository,snapshot,turn.turnId);return { turn, outcome: "fallback", limitations: ADVENTURE_TOOL_LIMITATIONS };}
      try{turn = appendMutationProposal(repository, turn, mutation, timeline.revision, dependencies.now(),snapshot,providerCallId);}
      catch{safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:settleMutationFailure(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      const proposalPosition = turn.toolCalls.length - 1;
      if (mutation.tool.confirmation === "required") {
        turn = repository.waitForToolConfirmation(OWNER, { turnId: turn.turnId, expectedTurnRevision: turn.revision,
          expectedCampaignRevision: turn.campaignRevision, idempotencyKey: key("agent-wait", turn.turnId,turn.toolCalls[proposalPosition]!.proposal.proposalId) });
        return { turn, outcome: "awaiting-confirmation", limitations: ADVENTURE_TOOL_LIMITATIONS };
      }
       try{const execution=repository.executeApprovedAgentProposalAtomically(OWNER,turn.turnId,turn.toolCalls[proposalPosition]!.proposal.proposalId);
         turn=execution.turn;if(execution.status==="replan")return orchestrateAdventureTurn(repository,turn.turnId,dependencies,signal);}
      catch{safeEnemyFallback(repository,snapshot,turn.turnId);return{turn:settleMutationFailure(repository,turn.turnId),outcome:"fallback",limitations:ADVENTURE_TOOL_LIMITATIONS};}
      return { turn, outcome: "mechanics-committed", limitations: ADVENTURE_TOOL_LIMITATIONS };
    }

    const assistantCalls=batch.calls.map((call)=>call.raw);
    messages.push({role:"assistant",content:null,toolCalls:assistantCalls});
    for (const call of batch.calls) {
      let outcome: { status: "succeeded"; result: AgentJsonObject } | { status: "failed"; errorCode: string };
      try { outcome = { status: "succeeded", result: executeAdventureRead(repository, OWNER, snapshot, basket, call.toolName) }; }
      catch { outcome = { status: "failed", errorCode: "read-unavailable" }; }
      const current = repository.getDurableAgentPlanningState(OWNER, turn.turnId)!;
      repository.markAgentReadOutcome(OWNER, { turnId: turn.turnId, providerToolCallId: call.providerToolCallId, outcome,
        expectedCampaignRevision: turn.campaignRevision, expectedTurnRevision: turn.revision,
        expectedExecutionRevision: current.executionRevision,
        idempotencyKey: key("agent-read", turn.turnId, call.providerToolCallId) });
      priorIds.add(call.providerToolCallId);
      messages.push({ role: "tool", toolCallId: call.providerToolCallId, content: canonicalAgentJson(outcome.status === "succeeded" ? outcome.result : { error: outcome.errorCode }) });
    }
    void persisted;
  }
  safeEnemyFallback(repository, snapshot, turn.turnId);
  return { turn: privateTurn(repository, turn.turnId), outcome: "fallback", limitations: ADVENTURE_TOOL_LIMITATIONS };
}

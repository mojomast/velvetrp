import { diceExpressionSchema, exactCandidateSelectionResponseSchema, providerSafeExactCandidateListSchema, resourceIdSchema,
  adventureInventorySelectionSchema,adventureCommerceSelectionSchema,adventurePowerRestSelectionSchema,type ActorGameplaySheetResponse,type AdventureInventoryCandidate,type AdventureCommerceCandidate,
   type AdventurePowerCandidate,type AdventureRestCandidate,type AdventureCombatConsumableCandidate,type AdventureCombatPowerCandidate,
   type AdventureQuestLifecycleCandidate,type AdventureProgressionCandidate,
  type AgentJsonObject, type ProviderSafeExactCandidate } from "@velvet/contracts";
import { z } from "zod";
import type { CampaignAgentContextBasket, CampaignAgentContextSnapshot } from "../context.js";
import type { CompletionFunctionTool, CompletionJsonValue } from "../provider/index.js";
import type { Repository } from "../repo/index.js";
import type { ProviderSafeAdventureCheckCandidate } from "../repo/adventureCheckRepo.js";
import { exactPairParameters } from "./providerCandidateProjection.js";
import { providerCandidateLabelSchema } from "@velvet/contracts";

export type AdventureToolName =
  | "campaign_context.read" | "actor_sheet.read" | "actor_resources.read" | "actor_inventory.read" | "actor_powers.read"
  | "combat_state.read" | "world_state.read" | "quest_state.read"
  | "actor_attribute.set" | "actor_dice.roll" | "combat_action.execute" | "exact_actor_travel.select" | "exact_quest_objective.select"
    | "exact_srd_check.select" | "exact_inventory_action.select" | "exact_vendor_commerce.select" | "exact_power_use.select" | "exact_rest.select" | "exact_combat_consumable.select" | "exact_combat_power.select"
    | "exact_quest_lifecycle.select" | "exact_progression_apply.select";

type AdventureRegistryToolName = AdventureToolName;

export type ProviderSafeQuestObjectiveCandidate = {
  candidateId: string; digest: string; questTitle: string; objectiveDescription: string; progress: number; targetProgress: number;
};

const emptyArguments = z.object({}).strict();
const attributeArguments = z.object({ attributeCandidateId: resourceIdSchema,
  attributeCandidateDigest:z.string().length(64).regex(/^[0-9a-f]+$/),value: z.number().int().min(-1_000).max(1_000) }).strict();
const diceArguments = z.object({ expression: diceExpressionSchema }).strict();
const combatArguments=z.object({legalActionId:resourceIdSchema,legalActionDigest:z.string().length(64).regex(/^[0-9a-f]+$/)}).strict();
const exactTravelArguments=exactCandidateSelectionResponseSchema;
const exactQuestArguments=z.object({candidateId:resourceIdSchema,digest:z.string().length(64).regex(/^[0-9a-f]+$/)}).strict();
const exactCheckArguments=exactQuestArguments;
const exactInventoryArguments=adventureInventorySelectionSchema;
const exactCommerceArguments=adventureCommerceSelectionSchema;
const exactPowerRestArguments=adventurePowerRestSelectionSchema;

export interface SelectedAdventureTool {
  name: AdventureToolName;
  kind: "read" | "mutation";
  confirmation: "never" | "required";
  argumentsSchema: z.ZodType<AgentJsonObject>;
  provider: CompletionFunctionTool;
}

const objectSchema = (properties: Record<string, CompletionJsonValue> = {}, required: string[] = []) => ({
  type: "object" as const, properties, required, additionalProperties: false,
});

const DEFINITIONS: Record<AdventureRegistryToolName, SelectedAdventureTool> = {
  "campaign_context.read": { name: "campaign_context.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "campaign_context.read", description: "Use to reread bounded authorized turn context; do not use it to infer mutation authority or hidden state.", parameters: objectSchema() } },
  "actor_sheet.read": { name: "actor_sheet.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "actor_sheet.read", description: "Read a bounded source-actor sheet projection to interpret declaration references; this grants no mutation authority.", parameters: objectSchema() } },
  "actor_resources.read": { name: "actor_resources.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "actor_resources.read", description: "Use to inspect labeled current/capacity resources; do not use to initialize, spend, or mutate them.", parameters: objectSchema() } },
  "actor_inventory.read": { name: "actor_inventory.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "actor_inventory.read", description: "Use to inspect labeled source-actor possessions; do not use as authority to equip, consume, gift, or drop items.", parameters: objectSchema() } },
  "actor_powers.read": { name: "actor_powers.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "actor_powers.read", description: "Use to inspect labeled known powers and availability; do not use it to cast or spend a power.", parameters: objectSchema() } },
  "combat_state.read": { name: "combat_state.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "combat_state.read", description: "Use during combat to inspect public state and labeled exact legal actions; do not use outside combat or invent targets.", parameters: objectSchema() } },
  "world_state.read": { name: "world_state.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "world_state.read", description: "Use for audience-visible world and cast facts; do not use for hidden locations, private cast facts, or mutations.", parameters: objectSchema() } },
  "quest_state.read": { name: "quest_state.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "quest_state.read", description: "Use for visible quest facts and status; do not use it to advance, accept, abandon, or claim rewards.", parameters: objectSchema() } },
  "actor_attribute.set": { name: "actor_attribute.set", kind: "mutation", confirmation: "required", argumentsSchema: attributeArguments,
    provider: { name: "actor_attribute.set", description: "Propose setting one existing source-actor attribute; human confirmation is required.",
      parameters: objectSchema({ attributeCandidateId: { type: "string", pattern: "^[A-Za-z0-9._:-]+$", maxLength: 128 },
        attributeCandidateDigest:{type:"string",pattern:"^[0-9a-f]{64}$"},value: { type: "integer", minimum: -1000, maximum: 1000 } }, ["attributeCandidateId","attributeCandidateDigest", "value"]) } },
  "actor_dice.roll": { name: "actor_dice.roll", kind: "mutation", confirmation: "never", argumentsSchema: diceArguments,
    provider: { name: "actor_dice.roll", description: "Roll bounded dice for the source actor; the server computes the total. This raw roll has no DC, skill identity, success, failure, or task-completion outcome.",
      parameters: objectSchema({ expression: { type: "string", minLength: 3, maxLength: 128 } }, ["expression"]) } },
  "combat_action.execute": {name:"combat_action.execute",kind:"mutation",confirmation:"required",argumentsSchema:combatArguments,
     provider:{name:"combat_action.execute",description:"Use for one labeled basic attack, flee, or end-turn candidate; do not use for powers, consumables, movement, or invented targets.",parameters:objectSchema({
       legalActionId:{type:"string",pattern:"^[A-Za-z0-9._:-]+$",maxLength:128},legalActionDigest:{type:"string",pattern:"^[0-9a-f]{64}$"}},["legalActionId","legalActionDigest"]) }},
  "exact_actor_travel.select": {name:"exact_actor_travel.select",kind:"mutation",confirmation:"never",argumentsSchema:exactTravelArguments as never,
    provider:{name:"exact_actor_travel.select",description:"Select exactly one server-issued travel option. Supply no destination, party, revision, or other mechanics arguments.",parameters:objectSchema({
      candidateId:{type:"string",pattern:"^[A-Za-z0-9._:-]+$",maxLength:128},kind:{type:"string",enum:["actor.travel"]},
       version:{type:"string",enum:["v1"]},choices:{type:"array",maxItems:0}},["candidateId","kind","version","choices"]) }},
  "exact_quest_objective.select": {name:"exact_quest_objective.select",kind:"mutation",confirmation:"never",argumentsSchema:exactQuestArguments,
    provider:{name:"exact_quest_objective.select",description:"Advance one exact currently legal public quest objective only when the player's declaration clearly describes completing that objective. Select an advertised candidate; do not infer extra progress.",parameters:objectSchema({
      candidateId:{type:"string",pattern:"^[A-Za-z0-9._:-]+$",maxLength:128},digest:{type:"string",pattern:"^[0-9a-f]{64}$"}},["candidateId","digest"]) }},
  "exact_srd_check.select": {name:"exact_srd_check.select",kind:"mutation",confirmation:"never",argumentsSchema:exactCheckArguments,
    provider:{name:"exact_srd_check.select",description:"Select exactly one advertised SRD 5.1 ability or skill check. Supply only its opaque candidate ID and digest; the server owns actor identity, scores, modifiers, DC, mode, revisions, roll, and outcome.",parameters:objectSchema({
       candidateId:{type:"string",pattern:"^[A-Za-z0-9._:-]+$",maxLength:128},digest:{type:"string",pattern:"^[0-9a-f]{64}$"}},["candidateId","digest"]) }},
  "exact_inventory_action.select": {name:"exact_inventory_action.select",kind:"mutation",confirmation:"never",argumentsSchema:exactInventoryArguments,
    provider:{name:"exact_inventory_action.select",description:"Select one exact advertised inventory action by opaque candidate ID and digest. Supply no item, quantity, slot, recipient, revision, effect, or outcome.",parameters:objectSchema({
       candidateId:{type:"string",pattern:"^[A-Za-z0-9._:-]+$",maxLength:128},digest:{type:"string",pattern:"^[0-9a-f]{64}$"}},["candidateId","digest"]) }},
  "exact_vendor_commerce.select": {name:"exact_vendor_commerce.select",kind:"mutation",confirmation:"required",argumentsSchema:exactCommerceArguments,
    provider:{name:"exact_vendor_commerce.select",description:"Select one exact advertised vendor purchase, sale, or free transfer by opaque candidate ID and digest. Supply no price, quantity, vendor, shop, item, recipient, revision, or outcome.",parameters:objectSchema({candidateId:{type:"string"},digest:{type:"string"}},["candidateId","digest"])}},
  "exact_power_use.select":{name:"exact_power_use.select",kind:"mutation",confirmation:"required",argumentsSchema:exactPowerRestArguments,
    provider:{name:"exact_power_use.select",description:"Use for one labeled advertised out-of-combat power and target set; do not use in combat or invent costs, effects, or targets.",parameters:objectSchema({candidateId:{type:"string"},digest:{type:"string"}},["candidateId","digest"])}},
  "exact_rest.select":{name:"exact_rest.select",kind:"mutation",confirmation:"required",argumentsSchema:exactPowerRestArguments,
    provider:{name:"exact_rest.select",description:"Use for one labeled advertised rest recovery preview; do not use for arbitrary healing, waiting, or when no rest candidate exists.",parameters:objectSchema({candidateId:{type:"string"},digest:{type:"string"}},["candidateId","digest"])}},
  "exact_combat_consumable.select":{name:"exact_combat_consumable.select",kind:"mutation",confirmation:"required",argumentsSchema:exactPowerRestArguments,
    provider:{name:"exact_combat_consumable.select",description:"Select one exact advertised combat consumable use. Supply only its opaque candidate ID and digest; the server owns item identity, target, costs, revisions, rolls, outcomes, and turn advancement.",parameters:objectSchema({candidateId:{type:"string"},digest:{type:"string"}},["candidateId","digest"])}},
  "exact_combat_power.select":{name:"exact_combat_power.select",kind:"mutation",confirmation:"required",argumentsSchema:exactPowerRestArguments,
    provider:{name:"exact_combat_power.select",description:"Select one exact advertised combat power. Supply only its opaque candidate ID and digest; the server owns power, target, cost, dice, damage, effects, revisions, and turn advancement.",parameters:objectSchema({candidateId:{type:"string"},digest:{type:"string"}},["candidateId","digest"])}},
  "exact_quest_lifecycle.select":{name:"exact_quest_lifecycle.select",kind:"mutation",confirmation:"required",argumentsSchema:exactPowerRestArguments,
    provider:{name:"exact_quest_lifecycle.select",description:"Select one exact advertised quest accept, abandon, or reward claim. Supply only opaque candidate ID and digest; the server owns quest, reward, recipient, dependencies, values, and revisions.",parameters:objectSchema({candidateId:{type:"string"},digest:{type:"string"}},["candidateId","digest"])}},
  "exact_progression_apply.select":{name:"exact_progression_apply.select",kind:"mutation",confirmation:"required",argumentsSchema:exactPowerRestArguments,
    provider:{name:"exact_progression_apply.select",description:"Select the exact complete authoritative progression preview. Never choose a class, level, feature, attribute, power, resource, XP value, or unresolved option.",parameters:objectSchema({candidateId:{type:"string"},digest:{type:"string"}},["candidateId","digest"])}},
};

export const ADVENTURE_TOOL_LIMITATIONS = Object.freeze([
  "Resource initialization is unavailable because provider-supplied current/max totals are forbidden.",
  "Sheet references are player intent and grant no mutation authority; unsupported item or power state changes remain uncommitted without exact authoritative candidates.",
  "Combat powers are limited to exact single-target damage, healing, and deterministic self/ally persistent effects; area targets, summons, movement, arbitrary modifiers, and unimplemented mechanics are unavailable.",
  "Vendor commerce exists only through present, visible, associated vendors and exact server-priced candidates; unsupported transfers, combat start, story changes, and GM override remain unavailable.",
  "Companion mutation is unavailable because there is no persisted companion authority model; generated world changes remain unavailable pending M4.6 candidate generation.",
  "Deletion, import, settings, prompts, authentication, policy, memory approval, arbitrary dispatch, SQL, filesystem, and network tools do not exist.",
]);

/** Selects the closed v1 registry from server-derived authority and exact encounter state. */
export function selectAdventureTools(snapshot: CampaignAgentContextSnapshot, exactTravelCandidates:readonly ProviderSafeExactCandidate[]=[],
  questCandidates:readonly ProviderSafeQuestObjectiveCandidate[]=[], checkCandidates:readonly ProviderSafeAdventureCheckCandidate[]=[],
  inventoryCandidates:readonly AdventureInventoryCandidate[]=[],commerceCandidates:readonly AdventureCommerceCandidate[]=[],powerCandidates:readonly AdventurePowerCandidate[]=[],restCandidates:readonly AdventureRestCandidate[]=[],combatConsumables:readonly AdventureCombatConsumableCandidate[]=[],combatPowers:readonly AdventureCombatPowerCandidate[]=[],questLifecycle:readonly AdventureQuestLifecycleCandidate[]=[],progression:readonly AdventureProgressionCandidate[]=[]): readonly SelectedAdventureTool[] {
  providerSafeExactCandidateListSchema.parse({version:"v1",candidates:exactTravelCandidates});
  const safeTravel=exactTravelCandidates.filter((candidate)=>providerCandidateLabelSchema.safeParse(candidate.semanticLabel).success) as Array<ProviderSafeExactCandidate & {semanticLabel:NonNullable<ProviderSafeExactCandidate["semanticLabel"]>}>;
  const safe = <T extends { candidateId:string; digest:string }>(values: readonly T[]) => values.filter((candidate) =>
    providerCandidateLabelSchema.safeParse((candidate as T & {semanticLabel?:unknown}).semanticLabel).success) as Array<T & {semanticLabel:any}>;
  const sets={quest:safe(questCandidates),check:safe(checkCandidates),inventory:safe(inventoryCandidates),commerce:safe(commerceCandidates),
    power:safe(powerCandidates),rest:safe(restCandidates),consumable:safe(combatConsumables),combatPower:safe(combatPowers),
    lifecycle:safe(questLifecycle),progression:safe(progression)};
  const attributes=snapshot.attributeCandidates.filter((candidate)=>typeof candidate.label==="string"&&candidate.label.trim().length>0&&candidate.label.length<=200);
  const legalActions=snapshot.encounter?.legalActionCandidates.filter((candidate)=>typeof candidate.label==="string"&&candidate.label.trim().length>0
    &&candidate.label.length<=200&&(candidate.targetId===null||typeof candidate.targetLabel==="string"&&candidate.targetLabel.trim().length>0))??[];
  const names: AdventureRegistryToolName[] = ["campaign_context.read", "world_state.read", "quest_state.read"];
  if (snapshot.encounter) names.push("combat_state.read");
  const actorAudience = snapshot.audience.kind === "player" && snapshot.audience.actorId === snapshot.encounter?.currentActorId;
  const controlsActor = snapshot.audience.kind === "player" && snapshot.authority.control !== "none";
  if (controlsActor) names.push("actor_sheet.read", "actor_resources.read", "actor_inventory.read", "actor_powers.read");
  // Generic actor mutations are deliberately absent during combat: combat permits
  // only the exact action plans returned by the authoritative planner.
  if (controlsActor && !snapshot.encounter) {if(attributes.length)names.push("actor_attribute.set");names.push("actor_dice.roll");}
  if(controlsActor&&!snapshot.encounter&&safeTravel.length)names.push("exact_actor_travel.select");
  if(controlsActor&&!snapshot.encounter&&sets.quest.length)names.push("exact_quest_objective.select");
  if(controlsActor&&!snapshot.encounter&&sets.check.length)names.push("exact_srd_check.select");
  if(controlsActor&&!snapshot.encounter&&sets.inventory.length)names.push("exact_inventory_action.select");
  if(controlsActor&&!snapshot.encounter&&sets.commerce.length)names.push("exact_vendor_commerce.select");
  if(controlsActor&&!snapshot.encounter&&sets.power.length)names.push("exact_power_use.select");
  if(controlsActor&&!snapshot.encounter&&sets.rest.length)names.push("exact_rest.select");
  if(controlsActor&&!snapshot.encounter&&sets.lifecycle.length)names.push("exact_quest_lifecycle.select");
  if(controlsActor&&!snapshot.encounter&&sets.progression.length)names.push("exact_progression_apply.select");
  if(controlsActor&&snapshot.encounter&&actorAudience&&sets.consumable.length)names.push("exact_combat_consumable.select");
  if(controlsActor&&snapshot.encounter&&actorAudience&&sets.combatPower.length)names.push("exact_combat_power.select");
  const enemyTurn=snapshot.audience.kind==="enemy"&&snapshot.encounter?.currentCombatantId===snapshot.audience.combatantId;
  if(legalActions.length&&((actorAudience&&controlsActor)||enemyTurn))names.push("combat_action.execute");
  return names.map((name) => name==="combat_action.execute"?{...DEFINITIONS[name],confirmation:enemyTurn?"never":"required",provider:{...DEFINITIONS[name].provider,
      parameters:{type:"object",properties:{legalActionId:{type:"string",enum:legalActions.map((candidate)=>candidate.legalActionId)},legalActionDigest:{type:"string",enum:legalActions.map((candidate)=>candidate.digest)}},required:["legalActionId","legalActionDigest"],additionalProperties:false,
        oneOf:legalActions.map((candidate)=>({type:"object",description:"Select this exact server-issued combat action binding.",properties:{legalActionId:{type:"string",const:candidate.legalActionId},legalActionDigest:{type:"string",const:candidate.digest}},required:["legalActionId","legalActionDigest"],additionalProperties:false}))} as CompletionFunctionTool["parameters"]}}
    :name==="exact_actor_travel.select"?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:{type:"object",properties:{
      candidateId:{type:"string",enum:safeTravel.map(candidate=>candidate.candidateId)},kind:{type:"string",enum:["actor.travel"]},
      version:{type:"string",enum:["v1"]},choices:{type:"array",maxItems:0}},required:["candidateId","kind","version","choices"],additionalProperties:false,
      oneOf:safeTravel.map((candidate)=>({
      type:"object",description:"Select this exact server-issued travel binding.",properties:{
        candidateId:{type:"string",const:candidate.candidateId},kind:{type:"string",const:"actor.travel"},version:{type:"string",const:"v1"},
         choices:{type:"array",maxItems:0}},required:["candidateId","kind","version","choices"],additionalProperties:false}))} as CompletionFunctionTool["parameters"]}}
    :name==="exact_quest_objective.select"?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:exactPairParameters(sets.quest)}}
    :name==="exact_srd_check.select"?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:exactPairParameters(sets.check)}}
    :name==="exact_inventory_action.select"?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:exactPairParameters(sets.inventory)}}
    :name==="exact_vendor_commerce.select"?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:exactPairParameters(sets.commerce)}}
    :(name==="exact_power_use.select"||name==="exact_rest.select"||name==="exact_combat_consumable.select"||name==="exact_combat_power.select"||name==="exact_quest_lifecycle.select"||name==="exact_progression_apply.select")?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:exactPairParameters(
      name==="exact_power_use.select"?sets.power:name==="exact_rest.select"?sets.rest:name==="exact_combat_consumable.select"?sets.consumable:name==="exact_combat_power.select"?sets.combatPower:name==="exact_quest_lifecycle.select"?sets.lifecycle:sets.progression)}}
    :name==="actor_attribute.set"?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:{type:"object",properties:{attributeCandidateId:{type:"string",enum:attributes.map((candidate)=>candidate.candidateId)},attributeCandidateDigest:{type:"string",enum:attributes.map((candidate)=>candidate.digest)},value:{type:"integer",minimum:-1000,maximum:1000}},required:["attributeCandidateId","attributeCandidateDigest","value"],additionalProperties:false,
      oneOf:attributes.map((candidate)=>({type:"object",description:"Set this exact server-issued attribute binding to the supplied value.",properties:{attributeCandidateId:{type:"string",const:candidate.candidateId},attributeCandidateDigest:{type:"string",const:candidate.digest},value:{type:"integer",minimum:-1000,maximum:1000}},required:["attributeCandidateId","attributeCandidateDigest","value"],additionalProperties:false}))} as CompletionFunctionTool["parameters"]}}:DEFINITIONS[name]);
}

export function parseAdventureToolArguments(tool: SelectedAdventureTool, raw: string): AgentJsonObject {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("tool arguments are not valid JSON"); }
  return tool.argumentsSchema.parse(value);
}

const bounded = <T>(values: T[], maximum: number): T[] => values.slice(0, maximum);

const semanticLabel = (id: string): string => id.split(/[-_.:]+/u).filter(Boolean)
  .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");

function projectActorSheet(sheet: ActorGameplaySheetResponse): AgentJsonObject {
  return {
    race: { label: sheet.race.label },
    background: { label: sheet.background.label },
    classes: bounded(sheet.classes, 16).map(({ label, level }) => ({ label, level })),
    attributes: bounded(sheet.attributes, 64).map(({ label, value }) => ({ label, value })),
    derived: {
      maxHp: sheet.derived.maxHp,
      defenses: sheet.derived.defenses,
      initiative: sheet.derived.initiative,
      speed: sheet.derived.speed,
      carryingLimit: sheet.derived.carryingLimit,
      spellAttack: sheet.derived.spellAttack,
      saveDc: sheet.derived.saveDc,
    },
    progression: {
      mode: sheet.progression.mode,
      level: sheet.progression.level,
      totalXp: sheet.progression.totalXp,
      milestoneCount: sheet.progression.milestoneCount,
      pendingChoiceCount: sheet.progression.pendingChoiceCount,
    },
    proficiencies: bounded(sheet.proficiencies, 64).map(({ label, category }) => ({ label, category })),
    resources: bounded(sheet.resources, 64).map(({ label, current, capacity }) => ({ label, current, capacity })),
    inventory: {
      capacity: sheet.inventory.capacity,
      items: bounded(sheet.inventory.items, 32).map(({ label, quantity, equippedSlot }) => ({
        label, quantity, equipped: equippedSlot !== null, equippedSlot,
      })),
    },
    knownPowers: bounded(sheet.knownPowers, 32).map(({ label, available, unavailableReasons }) => ({
      label, available, unavailableReasons,
    })),
    activeEffects: bounded(sheet.activeEffects, 32).map((effect) => ({
      sourceLabel: effect.source?.label ?? null,
      modifiers: bounded(effect.modifiers, 16).map((modifier) => ({
        kind: modifier.kind,
        appliesTo: semanticLabel(modifier.appliesToId),
        ...(modifier.kind === "flat" ? { amount: modifier.amount }
          : modifier.kind === "proficiency" ? { bonus: modifier.bonus } : {}),
      })),
      duration: effect.duration.kind === "rounds"
        ? { kind: effect.duration.kind, remaining: effect.duration.remaining }
        : { kind: effect.duration.kind },
      recovery: effect.recovery,
      stacking: effect.stacking,
    })),
    choices: bounded(sheet.choices, 64).map(({ label, selection }) => ({ label, selectionLabel: selection.label })),
  } as AgentJsonObject;
}

/** Executes only reviewed, role-safe reads. The provider supplies no scope identity. */
export function executeAdventureRead(repository: Repository, principalId: string, snapshot: CampaignAgentContextSnapshot,
  basket: CampaignAgentContextBasket, name: AdventureRegistryToolName): AgentJsonObject {
  if (name === "campaign_context.read") return { layers: basket.layers.map(({ precedence, kind, lines }) => ({ precedence, kind, lines })) } as AgentJsonObject;
  if (name === "world_state.read") return { facts: basket.layers.find((layer) => layer.kind === "visible-state-legal-actions")?.lines
    .filter((line) => line.startsWith("World: ") || line.startsWith("Cast: ")) ?? [] };
  if (name === "quest_state.read") return { facts: basket.layers.find((layer) => layer.kind === "visible-state-legal-actions")?.lines
    .filter((line) => line.startsWith("Quest: ")) ?? [] };
  if (name === "combat_state.read") {
    if (!snapshot.encounter) throw new Error("combat is unavailable");
    const combat = repository.getCombatState(principalId, snapshot.encounter.encounterId);
    if (!combat || combat.campaignId !== snapshot.campaignId) throw new Error("combat is unavailable");
    const maySeeActions = snapshot.audience.kind === "enemy"
      ? combat.currentCombatant === snapshot.audience.combatantId
      : snapshot.audience.kind === "player" && snapshot.encounter.currentActorId === snapshot.audience.actorId;
    return { round: combat.round,
      facts: basket.layers.find((layer)=>layer.kind==="committed-mechanics")?.lines ?? [],
      legalActions: maySeeActions ? bounded(snapshot.encounter.legalActionCandidates.flatMap((candidate)=>candidate.label ? [{candidateId:candidate.legalActionId,
        digest:candidate.digest,label:candidate.label,target:candidate.targetLabel??null}] : []),32) : [] } as AgentJsonObject;
  }
  if (snapshot.audience.kind !== "player") throw new Error("actor read is unavailable");
  const actorId = snapshot.audience.actorId;
  if (name === "actor_sheet.read") {
    if (snapshot.authority.control === "none") throw new Error("actor sheet is unavailable");
    const value = (repository as Repository & {
      getActorGameplaySheet(actorPrincipalId: string, targetActorId: string): ActorGameplaySheetResponse | null;
    }).getActorGameplaySheet(principalId, actorId);
    if (!value || value.identity.actorId !== actorId) throw new Error("actor sheet is unavailable");
    return projectActorSheet(value);
  }
  if (name === "actor_resources.read") return { resources: bounded(repository.listActorResources(principalId,snapshot.campaignId,actorId),64)
    .map(({name,current,max})=>({label:semanticLabel(name),current,capacity:max})) } as AgentJsonObject;
  const sheet=(repository as Repository & {getActorGameplaySheet(actorPrincipalId:string,targetActorId:string):ActorGameplaySheetResponse|null})
    .getActorGameplaySheet(principalId,actorId);
  if(!sheet||sheet.identity.actorId!==actorId)throw new Error("actor sheet is unavailable");
  if (name === "actor_inventory.read") {
    return { capacity:sheet.inventory.capacity,items:bounded(sheet.inventory.items,32).map(({label,quantity,equippedSlot})=>({label,quantity,equippedSlot})) } as AgentJsonObject;
  }
  if (name === "actor_powers.read") {
    return { known:bounded(sheet.knownPowers,32).map(({label,available,unavailableReasons})=>({label,available,unavailableReasons})) } as AgentJsonObject;
  }
  throw new Error("tool is not a read");
}

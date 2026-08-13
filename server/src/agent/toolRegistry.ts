import { diceExpressionSchema, exactCandidateSelectionResponseSchema, providerSafeExactCandidateListSchema, resourceIdSchema,
  type AgentJsonObject, type ProviderSafeExactCandidate } from "@velvet/contracts";
import { z } from "zod";
import type { CampaignAgentContextBasket, CampaignAgentContextSnapshot } from "../context.js";
import type { CompletionFunctionTool, CompletionJsonValue } from "../provider/index.js";
import type { Repository } from "../repo/index.js";

export type AdventureToolName =
  | "campaign_context.read" | "actor_resources.read" | "actor_inventory.read" | "actor_powers.read"
  | "combat_state.read" | "world_state.read" | "quest_state.read"
  | "actor_attribute.set" | "actor_dice.roll" | "combat_action.execute" | "exact_actor_travel.select";

const emptyArguments = z.object({}).strict();
const attributeArguments = z.object({ attributeCandidateId: resourceIdSchema,
  attributeCandidateDigest:z.string().length(64).regex(/^[0-9a-f]+$/),value: z.number().int().min(-1_000).max(1_000) }).strict();
const diceArguments = z.object({ expression: diceExpressionSchema }).strict();
const combatArguments=z.object({legalActionId:resourceIdSchema,legalActionDigest:z.string().length(64).regex(/^[0-9a-f]+$/)}).strict();
const exactTravelArguments=exactCandidateSelectionResponseSchema;

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

const DEFINITIONS: Record<AdventureToolName, SelectedAdventureTool> = {
  "campaign_context.read": { name: "campaign_context.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "campaign_context.read", description: "Read the bounded authorized campaign context.", parameters: objectSchema() } },
  "actor_resources.read": { name: "actor_resources.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "actor_resources.read", description: "Read bounded resources for the source actor.", parameters: objectSchema() } },
  "actor_inventory.read": { name: "actor_inventory.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "actor_inventory.read", description: "Read a bounded source-actor inventory projection.", parameters: objectSchema() } },
  "actor_powers.read": { name: "actor_powers.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "actor_powers.read", description: "Read known powers and server-derived availability.", parameters: objectSchema() } },
  "combat_state.read": { name: "combat_state.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "combat_state.read", description: "Read the current combat and exact legal actions.", parameters: objectSchema() } },
  "world_state.read": { name: "world_state.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "world_state.read", description: "Read the bounded audience-visible world state.", parameters: objectSchema() } },
  "quest_state.read": { name: "quest_state.read", kind: "read", confirmation: "never", argumentsSchema: emptyArguments,
    provider: { name: "quest_state.read", description: "Read the bounded audience-visible quest state.", parameters: objectSchema() } },
  "actor_attribute.set": { name: "actor_attribute.set", kind: "mutation", confirmation: "required", argumentsSchema: attributeArguments,
    provider: { name: "actor_attribute.set", description: "Propose setting one existing source-actor attribute; human confirmation is required.",
      parameters: objectSchema({ attributeCandidateId: { type: "string", pattern: "^[A-Za-z0-9._:-]+$", maxLength: 128 },
        attributeCandidateDigest:{type:"string",pattern:"^[0-9a-f]{64}$"},value: { type: "integer", minimum: -1000, maximum: 1000 } }, ["attributeCandidateId","attributeCandidateDigest", "value"]) } },
  "actor_dice.roll": { name: "actor_dice.roll", kind: "mutation", confirmation: "never", argumentsSchema: diceArguments,
    provider: { name: "actor_dice.roll", description: "Roll bounded dice for the source actor; the server computes every result and total.",
      parameters: objectSchema({ expression: { type: "string", minLength: 3, maxLength: 128 } }, ["expression"]) } },
  "combat_action.execute": {name:"combat_action.execute",kind:"mutation",confirmation:"required",argumentsSchema:combatArguments,
    provider:{name:"combat_action.execute",description:"Select one exact currently advertised combat action by ID and digest.",parameters:objectSchema({
       legalActionId:{type:"string",pattern:"^[A-Za-z0-9._:-]+$",maxLength:128},legalActionDigest:{type:"string",pattern:"^[0-9a-f]{64}$"}},["legalActionId","legalActionDigest"]) }},
  "exact_actor_travel.select": {name:"exact_actor_travel.select",kind:"mutation",confirmation:"never",argumentsSchema:exactTravelArguments as never,
    provider:{name:"exact_actor_travel.select",description:"Select exactly one server-issued travel option. Supply no destination, party, revision, or other mechanics arguments.",parameters:objectSchema({
      candidateId:{type:"string",pattern:"^[A-Za-z0-9._:-]+$",maxLength:128},kind:{type:"string",enum:["actor.travel"]},
      version:{type:"string",enum:["v1"]},choices:{type:"array",maxItems:0}},["candidateId","kind","version","choices"]) }},
};

export const ADVENTURE_TOOL_LIMITATIONS = Object.freeze([
  "Resource initialization is unavailable because provider-supplied current/max totals are forbidden.",
  "Power use, important inventory changes, purchases, transfers, rest, combat start, quest/story changes, and GM override remain unavailable until this context supplies exact authoritative opaque candidates and command quotes.",
  "Companion mutation is unavailable because there is no persisted companion authority model; generated world changes remain unavailable pending M4.6 candidate generation.",
  "Deletion, import, settings, prompts, authentication, policy, memory approval, arbitrary dispatch, SQL, filesystem, and network tools do not exist.",
]);

/** Selects the closed v1 registry from server-derived authority and exact encounter state. */
export function selectAdventureTools(snapshot: CampaignAgentContextSnapshot, exactTravelCandidates:readonly ProviderSafeExactCandidate[]=[]): readonly SelectedAdventureTool[] {
  providerSafeExactCandidateListSchema.parse({version:"v1",candidates:exactTravelCandidates});
  const names: AdventureToolName[] = ["campaign_context.read", "world_state.read", "quest_state.read"];
  if (snapshot.encounter) names.push("combat_state.read");
  const actorAudience = snapshot.audience.kind === "player" && snapshot.audience.actorId === snapshot.encounter?.currentActorId;
  const controlsActor = snapshot.audience.kind === "player" && snapshot.authority.control !== "none";
  if (controlsActor) names.push("actor_resources.read", "actor_inventory.read", "actor_powers.read");
  // Generic actor mutations are deliberately absent during combat: combat permits
  // only the exact action plans returned by the authoritative planner.
  if (controlsActor && !snapshot.encounter) {if(snapshot.attributeCandidates.length)names.push("actor_attribute.set");names.push("actor_dice.roll");}
  if(controlsActor&&!snapshot.encounter&&exactTravelCandidates.length)names.push("exact_actor_travel.select");
  const enemyTurn=snapshot.audience.kind==="enemy"&&snapshot.encounter?.currentCombatantId===snapshot.audience.combatantId;
  if(snapshot.encounter?.legalActionCandidates.length&&((actorAudience&&controlsActor)||enemyTurn))names.push("combat_action.execute");
  return names.map((name) => name==="combat_action.execute"?{...DEFINITIONS[name],confirmation:enemyTurn?"never":"required"}
    :name==="exact_actor_travel.select"?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:objectSchema({
      candidateId:{type:"string",enum:exactTravelCandidates.map((candidate)=>candidate.candidateId)},kind:{type:"string",enum:["actor.travel"]},
      version:{type:"string",enum:["v1"]},choices:{type:"array",maxItems:0}},["candidateId","kind","version","choices"])}}
    :name==="actor_attribute.set"?{...DEFINITIONS[name],provider:{...DEFINITIONS[name].provider,parameters:objectSchema({
      attributeCandidateId:{type:"string",enum:snapshot.attributeCandidates.map((candidate)=>candidate.candidateId)},
      attributeCandidateDigest:{type:"string",enum:snapshot.attributeCandidates.map((candidate)=>candidate.digest)},
      value:{type:"integer",minimum:-1000,maximum:1000}},["attributeCandidateId","attributeCandidateDigest","value"])}}:DEFINITIONS[name]);
}

export function parseAdventureToolArguments(tool: SelectedAdventureTool, raw: string): AgentJsonObject {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("tool arguments are not valid JSON"); }
  return tool.argumentsSchema.parse(value);
}

const bounded = <T>(values: T[], maximum: number): T[] => values.slice(0, maximum);

/** Executes only reviewed, role-safe reads. The provider supplies no scope identity. */
export function executeAdventureRead(repository: Repository, principalId: string, snapshot: CampaignAgentContextSnapshot,
  basket: CampaignAgentContextBasket, name: AdventureToolName): AgentJsonObject {
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
    return { round: combat.round, currentCombatant: combat.currentCombatant, combatants: bounded(combat.combatants, 32),
      legalActions: maySeeActions ? bounded(snapshot.encounter.legalActionCandidates.map((candidate)=>({actionId:candidate.legalActionId,
        digest:candidate.digest,kind:candidate.kind,target:candidate.targetId})),32) : [], revision: combat.revision } as AgentJsonObject;
  }
  if (snapshot.audience.kind !== "player") throw new Error("actor read is unavailable");
  const actorId = snapshot.audience.actorId;
  if (name === "actor_resources.read") return { resources: bounded(repository.listActorResources(principalId, snapshot.campaignId, actorId), 64) } as AgentJsonObject;
  if (name === "actor_inventory.read") {
    const value = repository.getActorInventorySnapshot(principalId, snapshot.campaignId, actorId);
    if (!value) throw new Error("inventory is unavailable");
    return { revision: value.revision, capacity: value.inventory.capacity, items: bounded(value.inventory.items, 32), equipment: bounded(value.equipment, 32) } as AgentJsonObject;
  }
  if (name === "actor_powers.read") {
    const value = repository.getActorPowerSnapshot(principalId, actorId);
    if (!value || value.campaignId !== snapshot.campaignId) throw new Error("powers are unavailable");
    return { revision: value.revision, known: bounded(value.known, 32), legalNow: bounded(value.legalNow, 32) } as AgentJsonObject;
  }
  throw new Error("tool is not a read");
}

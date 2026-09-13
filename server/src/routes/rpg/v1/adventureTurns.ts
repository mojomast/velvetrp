import { createHash } from "node:crypto";
import { campaignPublicContext } from "../../../context.js";
import {
  adventureTurnConfirmRequestSchema, adventureTurnConfirmResponseSchema, adventureTurnGetResponseSchema,
  adventureTurnInitialReconcileRequestSchema, adventureTurnInitialReconcileResponseSchema, adventureTurnResumeTokenSchema,
  adventureTurnStreamEventSchema, adventureTurnStreamRequestSchema, adventureTurnTranscriptRequestSchema,
  adventureTurnTranscriptResponseSchema, resourceIdSchema,
  combatActionResolutionSchema,
  type AdventureTurnStreamEvent, type PrivateAdventureTurn, type AdventureTurnHttpProposal,type AdventureCombatConsumablePublicReceipt,type AdventureCombatPowerPublicReceipt,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  AdventureTurnAuthorizationError, AdventureTurnConflictError, AdventureTurnExpiredError, AdventureTurnStaleError,
  AdventureTurnUnavailableError, getHarnessSettings, getProviderSettings, type AdventureTurnRepository,
} from "../../../repo/index.js";
import { openSse, type SseWriter } from "../../roleplay/generationService.js";
import { adventureProviderPromptEstimate, createAdventureTurnBudgetPolicy, effectiveAdventureTurnMaxTokens, initializeAdventureTurnBudget,
  orchestrateAdventureTurn, type AdventureAgentDependencies } from "../../../agent/adventureOrchestrator.js";
import type { Repository } from "../../../repo/index.js";
import { completeWithProvider } from "../../../provider/index.js";
import { getPromptPreset } from "../../../presets.js";
import { adventureNarrationMessages } from "../../../agent/adventurePrompt.js";
import { adventureTurnBudgets } from "../../../agent/turnBudget.js";
import { DIRECT_TOOL_BODY_OVERRIDES } from "../../../agent/directToolReasoning.js";
import type { CompletionFunctionTool, ProviderCompletionInput } from "../../../provider/index.js";

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
type Repo = Pick<AdventureTurnRepository,
  "createAdventureTurn" | "getAdventureTurn" | "getAdventureTurnNarration" | "getAdventureTurnTranscript" | "waitForToolConfirmation"
  | "getAdventureTurnByInitialIdempotencyKey" | "decideToolProposals" | "expireToolProposals" | "reconcileAdventureTurnMechanics" | "updateAdventureTurnNarration"
  | "recordProviderCallStart" | "recordProviderCallOutcome" | "claimNarrationProviderDispatch" | "settleNarrationProviderDispatch"
  | "getNarrationProviderDispatch" | "getAdventureTurnNarrationSource"> & {
  getCampaign(actorPrincipalId: string, campaignId: string): { activeTimelineId: string } | null;
};

/** Narrow durable repository lane required by adventure-turn HTTP routes. */
export interface AdventureTurnsHttpOptions {
  adventureTurnRepositoryAccessor: () => Repo & Repository;
  agentDependencies?: AdventureAgentDependencies;
}

const enabled = () => { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics; };
const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?")
  || Object.keys(request.query as Record<string, unknown>).length > 0;
const key = (prefix: string, ...parts: string[]) => `${prefix}:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 48)}`;
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

 type NarrationReceipt = { kind: "mechanic"; event: { type: string; data: unknown } } | { kind: "combat"; action: "attack"|"flee"|"end-turn"|"dash"|"grapple"|"escape-grapple"|"shove"|"disengage"|"help"|"hide"|"stabilize"|"death-save";
  outcome:{kind:"damage";damageType:"physical"|"bludgeoning"|"piercing"|"slashing";requested:number;applied:number;hitPointsBefore:number;hitPointsAfter:number;statusAfter:"active"|"unconscious"|"stable"|"defeated"|"dead"}
    |{kind:"status";statusAfter:"fled"}|{kind:"none"};roundBefore: number; roundAfter: number }
  | {kind:"travel";destination:string}
  | {kind:"inventory";itemLabel:string;action:"equip"|"unequip"|"drop"|"gift"|"consume";quantity:number;slot:string|null;recipient:string|null}
  | {kind:"commerce";action:"buy"|"sell"|"give";vendorLabel:string;shopLabel:string;itemLabel:string;quantity:number;currencyLabel:string;priceMinorUnits:number;balanceBefore:number;balanceAfter:number}
  | {kind:"quest";questTitle:string;objectiveDescription:string;progressBefore:number;progressAfter:number;targetProgress:number;
    objectiveCompleted:boolean;questCompleted:boolean}
  | {kind:"quest-lifecycle";action:"accept"|"abandon"|"claim-reward";questTitle:string;statusBefore:string;statusAfter:string;reward:{label:string;kind:string;amount:number|null;recipient:string}|null}
  | {kind:"progression";className:string;levelBefore:number;levelAfter:number;features:string[];resources:Array<{label:string;before:number;after:number}>}
  | {kind:"check";checkKind:"ability"|"skill";ability:string;skill:string|null;mode:"normal"|"advantage"|"disadvantage";
    difficulty:string;rolls:Array<{value:number;kept:boolean}>;abilityModifier:number;proficiencyBonus:number;modifier:number;total:number;dc:number;outcome:"success"|"failure"}
  | {kind:"power";powerName:string;targets:string[];costs:Array<{label:string;before:number;after:number}>;stateDeltas:Array<{actor:string;change:string;before:number|null;after:number|null}>;concentration:boolean}
  | ({kind:"combat-consumable"}&AdventureCombatConsumablePublicReceipt)
  | ({kind:"combat-power"}&AdventureCombatPowerPublicReceipt)
  | {kind:"rest";restKind:"short"|"long";restName:"Short rest"|"Long rest";recovery:Array<{label:string;before:number;after:number}>};
type NarrationResult={turn:PrivateAdventureTurn;text:string;source:"provider-assisted"|"deterministic-fallback"};
const NARRATION_TOOL_NAME = "submit_adventure_narration";
const NARRATION_TOOL_PARAMETERS: CompletionFunctionTool["parameters"] = {
  type: "object",
  properties: { narration: { type: "string", minLength: 1, maxLength: 8_000 } },
  required: ["narration"],
  additionalProperties: false,
};
function narrationReceipts(repo: Repo & Repository, turn: PrivateAdventureTurn): NarrationReceipt[] | null {
  const values: NarrationReceipt[] = [];
  for (const link of turn.receiptLinks) {
    const mechanic = repo.getCommandReceipt(OWNER, turn.campaignId, link.commandId);
    if (mechanic) {
      const [event] = mechanic.events;
      if (!event || mechanic.campaignId !== turn.campaignId || mechanic.commandId !== link.commandId) return null;
      const data = event.type === "actor_attribute_set" ? { valueBefore: event.data.valueBefore, valueAfter: event.data.valueAfter }
        : event.type === "actor_resource_initialized" ? { current: event.data.current, max: event.data.max }
          : event.type === "actor_dice_rolled" && typeof event.data.total === "number" && typeof event.data.modifier === "number"
            ? { total: event.data.total, modifier: event.data.modifier } : null;
      if (!data) return null;
      values.push({ kind: "mechanic", event: { type: event.type, data } });
      continue;
    }
    const travel=repo.getExactCandidateTravelNarrationReceipt(OWNER,turn.turnId,link.commandId);
    if(travel){values.push({kind:"travel",destination:travel.destination});continue;}
    const inventory=repo.getAdventureInventoryNarrationReceipt(OWNER,turn.turnId,link.commandId);
    if(inventory){values.push({kind:"inventory",itemLabel:inventory.itemLabel,action:inventory.action,quantity:inventory.quantity,
      slot:inventory.slot,recipient:inventory.recipient});continue;}
    const commerce=repo.getAdventureCommerceNarrationReceipt(OWNER,turn.turnId,link.commandId);
    if(commerce){values.push({kind:"commerce",action:commerce.action,vendorLabel:commerce.vendorLabel,shopLabel:commerce.shopLabel,itemLabel:commerce.itemLabel,quantity:commerce.quantity,currencyLabel:commerce.currencyLabel,priceMinorUnits:commerce.priceMinorUnits,balanceBefore:commerce.balanceBefore,balanceAfter:commerce.balanceAfter});continue;}
    const questProgression=repo.getAdventureQuestProgressionNarrationReceipt(OWNER,turn.turnId,link.commandId);
    if(questProgression){values.push(questProgression);continue;}
    const quest=repo.getAdventureQuestNarrationReceipt(OWNER,turn.turnId,link.commandId);
    if(quest){values.push({kind:"quest",...quest});continue;}
    const check=repo.getAdventureCheckNarrationReceipt(OWNER,turn.turnId,link.commandId);
    if(check){values.push({kind:"check",...check});continue;}
    const action=repo.getAdventurePowerRestNarrationReceipt(OWNER,turn.turnId,link.commandId);
    if(action){values.push(action);continue;}
    const combat = repo.getAgentCombatReceipt(OWNER, turn.campaignId, link.commandId);
    const resolution=combatActionResolutionSchema.safeParse(combat?.resolution);if(!combat||!resolution.success)return null;
    const outcome=resolution.data.outcomes[0];
    values.push({kind:"combat",action:resolution.data.kind,outcome:outcome?.kind==="damage"?{kind:"damage",damageType:outcome.damageType,
      requested:outcome.requested,applied:outcome.applied,hitPointsBefore:outcome.hitPointsBefore,hitPointsAfter:outcome.hitPointsAfter,statusAfter:outcome.statusAfter}
      :outcome?.kind==="status"?{kind:"status",statusAfter:outcome.statusAfter}:{kind:"none"},roundBefore:resolution.data.roundBefore,roundAfter:resolution.data.roundAfter});
  }
  return values;
}
export function narrationFallback(declaration: string, values: readonly NarrationReceipt[]): string {
  void declaration;
  return composeNarration(values);
}

/** Receipt-only prose retained for every provider and settings failure lane. */
function composeNarration(values: readonly NarrationReceipt[]): string {
  if (values.length === 0) return "The scene holds. Your intended action remains pending; no movement or other campaign change is established.";
  const facts = values.map((value) => {
    if (value.kind === "travel") return `You arrive at ${value.destination}.`;
    if(value.kind==="inventory"){
      if(value.action==="equip")return `You equip ${value.quantity} ${value.itemLabel} in the ${value.slot} slot.`;
      if(value.action==="unequip")return `You unequip ${value.quantity} ${value.itemLabel} from the ${value.slot} slot.`;
      if(value.action==="gift")return `You give ${value.quantity} ${value.itemLabel} to ${value.recipient}.`;
      if(value.action==="consume")return `You consume ${value.quantity} ${value.itemLabel}; only its removal from inventory is established, with no item effect.`;
      return `You drop ${value.quantity} ${value.itemLabel}.`;
    }
    if(value.kind==="commerce")return value.action==="buy"?`You buy ${value.quantity} ${value.itemLabel} from ${value.vendorLabel} at ${value.shopLabel} for ${value.priceMinorUnits} ${value.currencyLabel}. Your balance changes from ${value.balanceBefore} to ${value.balanceAfter}.`:value.action==="sell"?`You sell ${value.quantity} ${value.itemLabel} to ${value.vendorLabel} at ${value.shopLabel} for ${value.priceMinorUnits} ${value.currencyLabel}. Your balance changes from ${value.balanceBefore} to ${value.balanceAfter}.`:`You give ${value.quantity} ${value.itemLabel} to ${value.vendorLabel} at ${value.shopLabel} without payment. It is transferred into shop stock, not dropped.`;
    if (value.kind === "quest") return `Quest objective advanced for ${value.questTitle}: ${value.objectiveDescription} (${value.progressAfter} of ${value.targetProgress}).${value.objectiveCompleted ? " The objective is complete." : ""}${value.questCompleted ? " The quest is complete." : ""}`;
    if(value.kind==="quest-lifecycle")return value.action==="accept"?`Quest accepted: ${value.questTitle}.`:value.action==="abandon"?`Quest abandoned: ${value.questTitle}.`:`Quest reward claimed from ${value.questTitle}: ${value.reward?.amount===null?value.reward.label:`${value.reward?.amount} ${value.reward?.kind} (${value.reward?.label})`} for ${value.reward?.recipient}.`;
    if(value.kind==="progression")return `${value.className} advances from level ${value.levelBefore} to level ${value.levelAfter}.${value.features.length?` Features gained: ${value.features.join(", ")}.`:""}${value.resources.length?` ${value.resources.map(resource=>`${resource.label} capacity changes from ${resource.before} to ${resource.after}.`).join(" ")}`:""}`;
    if(value.kind==="check")return `${value.skill??value.ability} check: ${value.rolls.map((roll)=>roll.value).join(" and ")} rolled ${value.mode}; ${value.modifier>=0?"+":""}${value.modifier} modifier gives ${value.total} against ${value.difficulty} DC ${value.dc}: ${value.outcome}.`;
    if(value.kind==="power")return `${value.powerName} affects ${value.targets.join(", ")}.${value.costs.length?` ${value.costs.map(cost=>`${cost.label} changes from ${cost.before} to ${cost.after}`).join(" ")}.`:""}${value.stateDeltas.length?` ${value.stateDeltas.map(delta=>delta.before===null?`${delta.actor}: ${delta.change}.`:`${delta.actor} ${delta.change} changes from ${delta.before} to ${delta.after}.`).join(" ")}`:""}${value.concentration?" Concentration is active.":""}`;
    if(value.kind==="combat-consumable"){const outcomes=value.outcomes.map(outcome=>outcome.kind==="damage"?`${outcome.roll.total} rolled; ${outcome.applied} ${outcome.damageType} damage applied${outcome.adjustment!=="none"?` after ${outcome.adjustment}`:""}; ${value.target} changes from ${outcome.before} to ${outcome.after} HP.`:outcome.kind==="healing"?`${outcome.roll.total} rolled; ${outcome.applied} healing applied; ${value.target} changes from ${outcome.before} to ${outcome.after} HP.`:`${value.target} ${outcome.resource} changes by ${outcome.applied}${outcome.before===null?"":` from ${outcome.before} to ${outcome.after}`}.`).join(" ");return `${value.itemName} is consumed using one ${value.actionCost} on ${value.target}. ${outcomes}${value.roundAfter!==value.roundBefore?` Round ${value.roundAfter} begins.`:""}`;}
    if(value.kind==="combat-power"){const outcomes=value.outcomes.map(outcome=>outcome.kind==="damage"?`${outcome.roll.total} rolled; ${outcome.applied} ${outcome.damageType} damage applied${outcome.adjustment!=="none"?` after ${outcome.adjustment}`:""}; ${value.target} changes from ${outcome.before} to ${outcome.after} HP.`:outcome.kind==="healing"?`${outcome.roll.total} rolled; ${outcome.applied} healing applied; ${value.target} changes from ${outcome.before} to ${outcome.after} HP.`:outcome.kind==="temporary-hit-points"?`${outcome.roll.total} rolled; ${outcome.granted} temporary hit points applied; ${value.target} has ${outcome.after} temporary hit points.`:`${outcome.effect} applied${outcome.replacedConcentration?", replacing concentration":""}.`).join(" ");return `${value.powerName} uses one action on ${value.target}. ${outcomes}${value.costs.map(cost=>` ${cost.label} changes from ${cost.before} to ${cost.after}.`).join("")}${value.roundAfter!==value.roundBefore?` Round ${value.roundAfter} begins.`:""}`;}
    if(value.kind==="rest")return `${value.restName} completed. ${value.recovery.map(delta=>`${delta.label} recovers from ${delta.before} to ${delta.after}.`).join(" ")}`;
    if (value.kind === "combat") {
      if (value.outcome.kind === "damage") return `The ${value.action} deals ${value.outcome.applied} physical damage. The target has ${value.outcome.hitPointsAfter} HP and is ${value.outcome.statusAfter}.${value.roundAfter !== value.roundBefore ? ` Round ${value.roundAfter} begins.` : ""}`;
      if (value.outcome.kind === "status") return `The combatant flees during round ${value.roundBefore}.`;
      if (value.action === "attack") return `The combatant makes the committed attack in round ${value.roundBefore}; no damage is applied.`;
      if (value.action === "flee") return `The combatant attempts the committed flee action in round ${value.roundBefore}; no fled status is established.`;
      return `The combatant ends their turn in round ${value.roundBefore}.${value.roundAfter !== value.roundBefore ? ` Round ${value.roundAfter} begins.` : ""}`;
    }
    if (value.event.type === "actor_dice_rolled") {
      const data = value.event.data as { total: number };
      return `The dice come up ${data.total}. The attempt is made and the moment is still open; no success or failure is recorded yet.`;
    }
    if (value.event.type === "actor_attribute_set") {
      const data = value.event.data as { valueBefore: number; valueAfter: number };
      return `The committed attribute changes from ${data.valueBefore} to ${data.valueAfter}.`;
    }
    const data = value.event.data as { current: number; max: number };
    return `The committed resource is ${data.current} of ${data.max}.`;
  });
  return `The authoritative result is clear. ${facts.join(" ")}`.slice(0, 8_000);
}

const normalizedNarration = (value:string) => value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g," ").trim();
const includesFact = (text:string,value:string|number) => normalizedNarration(text).includes(normalizedNarration(String(value)));
const includesAny = (text:string,values:readonly string[]) => values.some(value=>normalizedNarration(text).includes(value));
const includesNumber = (text:string,value:number) => new RegExp(`(^|\\D)${String(value).replace("-","\\-")}(?=\\D|$)`).test(text);
const regexEscape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");

function acknowledgesCurrentLocation(text:string,currentLocation:string|null):boolean{
  if(!currentLocation)return true;
  const normalized=normalizedNarration(text),location=regexEscape(normalizedNarration(currentLocation));
  return new RegExp(`(?:\\b(?:at|in|inside|within)\\s+(?:the\\s+)?${location}\\b|\\b(?:you are|you stand|you remain|you arrive|you reach|you enter)\\b.{0,80}\\b${location}\\b|\\b${location}\\b.{0,80}\\b(?:around you|surrounds you|is your current location)\\b)`).test(normalized);
}

/** Conservative semantic gate: receipt prose may add atmosphere, but cannot replace or negate committed public facts. */
export function providerNarrationMatchesReceipts(text:string,values:readonly NarrationReceipt[],currentLocation:string|null=null):boolean {
  if(!acknowledgesCurrentLocation(text,currentLocation))return false;
  const normalized=normalizedNarration(text);
  const hasKind=(...kinds:NarrationReceipt["kind"][])=>values.some(value=>kinds.includes(value.kind));
  const damageClaims=[...normalized.matchAll(/\b(\d+)\s+(?:[a-z]+\s+){0,2}damage\b/g)].map(match=>Number(match[1]));
  const healingClaims=[...normalized.matchAll(/\b(?:heal(?:s|ed|ing)?(?:\s+(?:you|them|him|her))?\s+(?:for\s+)?|restore(?:s|d)?\s+)(\d+)\s+(?:hit points?|hp|health)\b/g)].map(match=>Number(match[1]));
  const allowedDamage=values.flatMap(value=>value.kind==="combat"&&value.outcome.kind==="damage"?[value.outcome.applied]
    :value.kind==="combat-consumable"||value.kind==="combat-power"?value.outcomes.flatMap(outcome=>outcome.kind==="damage"?[outcome.applied]:[]):[]);
  const allowedHealing=values.flatMap(value=>value.kind==="combat-consumable"||value.kind==="combat-power"
    ?value.outcomes.flatMap(outcome=>outcome.kind==="healing"?[outcome.applied]:[]):[]);
  if(damageClaims.some(amount=>!allowedDamage.includes(amount))||healingClaims.some(amount=>!allowedHealing.includes(amount)))return false;
  const unsupportedTravel=!hasKind("travel")&&/\b(?:you|the party|the group)\s+(?:arrive|arrives|arrived|reach|reaches|reached|enter|enters|entered|travel|travels|traveled|journey|journeys|journeyed|leave|leaves|left)\b/.test(normalized);
  const unsupportedInventory=!hasKind("inventory","commerce","quest-lifecycle")&&/\b(?:you|they|the party|the group)\s+(?:gain|gains|gained|receive|receives|received|obtain|obtains|obtained|acquire|acquires|acquired|lose|loses|lost|drop|drops|dropped|consume|consumes|consumed|equip|equips|equipped|unequip|unequips|unequipped|buy|buys|bought|sell|sells|sold)\b.{0,80}\b(?:gold|coins?|currency|credits?|potion|weapon|armor|item|inventory|reward|sword|shield|bow|dagger|ring|amulet|scroll)\b/.test(normalized);
  const unsupportedCurrency=!hasKind("commerce","quest-lifecycle")&&/(?:\b(?:gain|gains|gained|receive|receives|received|lose|loses|lost|spend|spends|spent|pay|pays|paid|earn|earns|earned)\b.{0,40}\b(?:gold|coins?|currency|credits?)\b|\b\d+\s+(?:gold|coins?|credits?)\b)/.test(normalized);
  const unsupportedQuest=!hasKind("quest","quest-lifecycle")&&/(?:\bquest\b.{0,50}\b(?:accept|accepted|abandon|abandoned|advance|advanced|progress|complete|completed|reward|claimed)\b|\b(?:accept|accepted|abandon|abandoned|advance|advanced|complete|completed|claim|claimed)\b.{0,50}\bquest\b)/.test(normalized);
  const unsupportedProgression=!hasKind("progression")&&/\b(?:level(?:s|ed)?\s+up|advance(?:s|d)?\s+to\s+level|gain(?:s|ed)?\s+\d+\s+(?:xp|experience)|learn(?:s|ed)?\s+(?:a\s+)?new\s+(?:feature|ability|power))\b/.test(normalized);
  if(unsupportedTravel||unsupportedInventory||unsupportedCurrency||unsupportedQuest||unsupportedProgression)return false;
  if(values.length===0)return true;
  const contradiction=/(movement|arrival|travel|result|outcome|action|change|damage|healing|purchase|sale|quest|progression|rest|check|attack).{0,48}(pending|unresolved|uncertain|unknown|not established|not committed|did not happen|has not happened|awaiting confirmation)/
    .test(normalized)||/(pending|unresolved|uncertain|unknown|not established|not committed|did not happen|has not happened|awaiting confirmation).{0,48}(movement|arrival|travel|result|outcome|action|change|damage|healing|purchase|sale|quest|progression|rest|check|attack)/.test(normalized);
  if(contradiction)return false;
  return values.every(value=>{
    if(value.kind==="travel"){
      const arrivalClaims=[...text.matchAll(/\b(?:arriv(?:e|es|ed|ing)|arrival)\s+(?:at|in)\s+([^.!?;\n]{1,200})/gi)].map(match=>match[1]!);
      return includesFact(text,value.destination)&&arrivalClaims.every(claim=>includesFact(claim,value.destination))
        &&includesAny(text,["arrive","arrives","arrived","reach","reaches","reached","travel","travels","traveled","move","moves","moved","enter","enters","entered"]);
    }
    if(value.kind==="inventory")return includesFact(text,value.itemLabel)&&includesNumber(text,value.quantity)&&includesAny(text,value.action==="equip"?["equip"]:value.action==="unequip"?["unequip"]:value.action==="drop"?["drop","discard"]:value.action==="gift"?["give","gives","gave","gift"]:["consume","consumes","consumed","remove","removes","removed"]);
    if(value.kind==="commerce")return includesFact(text,value.itemLabel)&&includesFact(text,value.vendorLabel)&&includesNumber(text,value.quantity)&&includesNumber(text,value.balanceAfter)&&includesAny(text,value.action==="buy"?["buy","buys","bought","purchase"]:value.action==="sell"?["sell","sells","sold","sale"]:["give","gives","gave","transfer"]);
    if(value.kind==="quest")return includesFact(text,value.questTitle)&&includesNumber(text,value.progressAfter)&&includesAny(text,["advance","advances","advanced","progress","complete","completes","completed"]);
    if(value.kind==="quest-lifecycle")return includesFact(text,value.questTitle)&&includesAny(text,value.action==="accept"?["accept","accepted"]:value.action==="abandon"?["abandon","abandoned"]:["claim","claimed"]);
    if(value.kind==="progression")return includesFact(text,value.className)&&includesNumber(text,value.levelAfter)&&includesAny(text,["advance","advances","advanced","level"]);
    if(value.kind==="check")return includesFact(text,value.skill??value.ability)&&includesNumber(text,value.total)&&includesNumber(text,value.dc)&&includesFact(text,value.outcome);
    if(value.kind==="power")return includesFact(text,value.powerName)&&value.targets.every(target=>includesFact(text,target))&&value.costs.every(cost=>includesNumber(text,cost.after))&&value.stateDeltas.every(delta=>includesFact(text,delta.actor)&&includesFact(text,delta.change));
    if(value.kind==="rest")return includesFact(text,value.restName)&&value.recovery.every(delta=>includesFact(text,delta.label)&&includesNumber(text,delta.after));
    if(value.kind==="combat-consumable"||value.kind==="combat-power")return includesFact(text,value.kind==="combat-consumable"?value.itemName:value.powerName)&&includesFact(text,value.target)&&value.outcomes.every(outcome=>outcome.kind==="effect"?includesFact(text,outcome.effect):outcome.kind==="temporary-hit-points"?includesNumber(text,outcome.granted):includesNumber(text,outcome.applied)&&(outcome.after===null?outcome.kind==="resource"&&includesFact(text,outcome.resource):includesNumber(text,outcome.after)));
    if(value.kind==="combat")return includesFact(text,value.action)&&(value.outcome.kind==="damage"?includesNumber(text,value.outcome.applied)&&includesNumber(text,value.outcome.hitPointsAfter)&&includesFact(text,value.outcome.statusAfter):value.outcome.kind==="status"?includesFact(text,value.outcome.statusAfter):includesAny(text,["no damage","ends","ended","attack","flee"]));
    if(value.event.type==="actor_dice_rolled")return includesNumber(text,(value.event.data as {total:number}).total)
      &&includesAny(text,["roll","rolled","rolls","total","die","dice","shows","comes up","lands","result"]);
    if(value.event.type==="actor_attribute_set"){const data=value.event.data as {valueBefore:number;valueAfter:number};return includesNumber(text,data.valueBefore)&&includesNumber(text,data.valueAfter)&&includesAny(text,["attribute","change","changes","changed"]);}
    const data=value.event.data as {current:number;max:number};return includesNumber(text,data.current)&&includesNumber(text,data.max)&&includesAny(text,["resource","current","maximum"]);
  });
}
async function performNarration(repo: Repo & Repository, turn: PrivateAdventureTurn, dependencies: AdventureAgentDependencies | undefined,
  signal: AbortSignal): Promise<NarrationResult> {
  const safeReceipts = narrationReceipts(repo, turn);
  const fallbackText = composeNarration(safeReceipts ?? []);
  if (!safeReceipts) return { turn, text: fallbackText,source:"deterministic-fallback" };
  const callId = key("narration-provider", turn.turnId);
  const recovered=repo.getNarrationProviderDispatch(OWNER,turn.turnId,callId);
  if(recovered?.state==="settled")return finalizeNarrationDispatch(repo,turn.turnId,callId,recovered);
    let settings;
    try {
      settings = await Promise.all([
        dependencies ? dependencies.getProvider() : getProviderSettings(),
        dependencies ? dependencies.getHarness() : getHarnessSettings(),
      ]);
    } catch { return { turn, text: fallbackText, source: "deterministic-fallback" }; }
    const [provider, harness] = settings;
    let history;
    try { history = repo.getAdventureTurnTranscript(OWNER, turn.campaignId, turn.sessionId, harness.recentTurns, turn.actorId); }
    catch { return { turn, text: fallbackText, source: "deterministic-fallback" }; }
    const publicContext=publicNarrationContext(repo,turn);
    if(!publicContext)return {turn,text:fallbackText,source:"deterministic-fallback"};
    const completionLimit = effectiveAdventureTurnMaxTokens(provider);
    const completionInput: ProviderCompletionInput = { provider: { ...provider, samplers: { ...provider.samplers, maxTokens: completionLimit } },
      harness, preset: getPromptPreset("default"), tools: [{ name: NARRATION_TOOL_NAME,
        description: "Submit bounded DM narration grounded by authoritative public context and verified receipts.",
        parameters: NARRATION_TOOL_PARAMETERS }], toolChoice: { name: NARRATION_TOOL_NAME }, signal,
      bodyOverrides: DIRECT_TOOL_BODY_OVERRIDES,
      parallelToolCalls:false,promptVersion: "adventure-narration-v1", schemaVersion: "adventure-narration-v1",
      messages: adventureNarrationMessages({ declaration: turn.declaration, receipts: safeReceipts,
        currentLocation:publicContext.currentLocation,currentActorName:publicContext.currentActorName,publicContext:publicContext.context,harness, history,
        rulesetDescriptor:publicContext.ruleset.descriptor,
        safetyPolicy: repo.getSessionZeroSafetyPolicy(OWNER, turn.campaignId) }) };
    const providerName=provider.providerType||"openai-compatible",model=provider.model.trim()||"unconfigured";
    let claim=repo.claimNarrationProviderDispatch(OWNER,{turnId:turn.turnId,callId,provider:providerName,model,
      fallbackNarration:fallbackText,leaseMs:90_000,context:publicContext,
      request:{messages:completionInput.messages,tools:completionInput.tools,toolChoice:completionInput.toolChoice}});
    while(claim.state==="in-progress"){
      if(signal.aborted)throw new Error("narration aborted");
      await new Promise<void>(resolve=>setTimeout(resolve,10));
      claim=repo.getNarrationProviderDispatch(OWNER,turn.turnId,callId)
        ??repo.claimNarrationProviderDispatch(OWNER,{turnId:turn.turnId,callId,provider:providerName,model,fallbackNarration:fallbackText,leaseMs:90_000});
    }
    if(claim.state==="settled")return finalizeNarrationDispatch(repo,turn.turnId,callId,claim);
    const claimId=claim.claimId;
    try { turn = repo.recordProviderCallStart(OWNER, { turnId: turn.turnId, callId, provider: providerName,
        model, attempt: 1, expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
        idempotencyKey: key("narration-provider-start", turn.turnId) }); }
    catch {
      claim=repo.settleNarrationProviderDispatch(OWNER,{turnId:turn.turnId,callId,claimId,source:"deterministic-fallback",
        narration:fallbackText,outcomeCode:"provider-start-failed",promptTokens:null,completionTokens:null});
      if(claim.state!=="settled")claim=repo.claimNarrationProviderDispatch(OWNER,{turnId:turn.turnId,callId,provider:providerName,model,fallbackNarration:fallbackText,leaseMs:90_000});
      if(claim.state==="settled")return finalizeNarrationDispatch(repo,turn.turnId,callId,claim);
      return{turn:requirePrivate(repo.getAdventureTurn(OWNER,turn.turnId)),text:fallbackText,source:"deterministic-fallback"};
    }
    const policy = createAdventureTurnBudgetPolicy(provider);
    if (policy) initializeAdventureTurnBudget(turn, policy);
    const budget = policy ? adventureTurnBudgets.reserve(turn.turnId, policy, { id: callId,
      promptText: adventureProviderPromptEstimate(completionInput), maxCompletionTokens: completionLimit }, Date.now()) : null;
    if (!budget?.allowed) {
      const reason = budget ? budget.reason : "pricing-unconfigured";
       claim=repo.settleNarrationProviderDispatch(OWNER,{turnId:turn.turnId,callId,claimId,source:"deterministic-fallback",
         narration:fallbackText,outcomeCode:`budget-${reason}`,promptTokens:null,completionTokens:null});
       if(claim.state==="settled")return finalizeNarrationDispatch(repo,turn.turnId,callId,claim);
       return { turn:requirePrivate(repo.getAdventureTurn(OWNER,turn.turnId)), text: fallbackText, source: "deterministic-fallback" };
    }
    let measuredUsage: { promptTokens: number; completionTokens: number } | null = null;
    let budgetSettled = false;
    let usageEstimated = false;
    try {
      const result = await (dependencies?.complete ?? completeWithProvider)(completionInput);
      const completionText = result.message.toolCalls?.map((call) => call.arguments).join("\n");
      const charged = adventureTurnBudgets.settle(turn.turnId, callId, { usage: result.usage,
        promptText: adventureProviderPromptEstimate(completionInput), ...(completionText === undefined ? {} : { completionText }) });
      budgetSettled = true; measuredUsage = charged; usageEstimated = charged.source === "estimated";
      const calls = result.message.toolCalls;
      if (calls?.length !== 1 || calls[0]?.name !== NARRATION_TOOL_NAME || typeof calls[0].id !== "string" || !calls[0].id.trim()
        || typeof calls[0].arguments !== "string") throw new Error("invalid narration response");
      const parsed = JSON.parse(calls[0].arguments) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1
        || !("narration" in parsed) || typeof parsed.narration !== "string") {
        throw new Error("invalid narration response");
      }
      const providerText = parsed.narration.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
      if (!providerText || providerText.length > 8_000) throw new Error("invalid narration response");
      const currentSnapshot=repo.getCampaignAgentContextSnapshot(OWNER,turn.campaignId,turn.sessionId,{kind:"player",actorId:turn.actorId});
      if (JSON.stringify(publicNarrationContext(repo, turn)) !== JSON.stringify(publicContext)) throw new Error("narration public context is stale");
      if(!currentSnapshot?.ruleset||currentSnapshot.ruleset.id!==publicContext.ruleset.id||currentSnapshot.ruleset.version!==publicContext.ruleset.version
        ||JSON.stringify(currentSnapshot.ruleset.descriptor)!==JSON.stringify(publicContext.ruleset.descriptor))throw new Error("narration ruleset context is stale");
      if(!providerNarrationMatchesReceipts(providerText,safeReceipts,publicContext.currentLocation))throw new Error("narration contradicts or omits verified current facts");
       claim=repo.settleNarrationProviderDispatch(OWNER,{turnId:turn.turnId,callId,claimId,source:"provider-assisted",narration:providerText,
         outcomeCode:usageEstimated?"ok-estimated":"ok",promptTokens:measuredUsage.promptTokens,completionTokens:measuredUsage.completionTokens});
    } catch {
      if (!budgetSettled) { measuredUsage = adventureTurnBudgets.settle(turn.turnId, callId, {}); usageEstimated = true; }
       claim=repo.settleNarrationProviderDispatch(OWNER,{turnId:turn.turnId,callId,claimId,source:"deterministic-fallback",narration:fallbackText,
         outcomeCode:usageEstimated?"narration-failed-estimated":"narration-failed",promptTokens:measuredUsage?.promptTokens??null,
         completionTokens:measuredUsage?.completionTokens??null});
    }
    if(claim.state!=="settled")claim=repo.claimNarrationProviderDispatch(OWNER,{turnId:turn.turnId,callId,provider:providerName,model,
      fallbackNarration:fallbackText,leaseMs:90_000});
    return claim.state==="settled"?finalizeNarrationDispatch(repo,turn.turnId,callId,claim)
      :{turn:requirePrivate(repo.getAdventureTurn(OWNER,turn.turnId)),text:fallbackText,source:"deterministic-fallback"};
}
function finalizeNarrationDispatch(repo:Repo&Repository,turnId:string,callId:string,dispatch:Extract<ReturnType<Repo["getNarrationProviderDispatch"]>,{state:"settled"}>):NarrationResult{
   const currentTurn=requirePrivate(repo.getAdventureTurn(OWNER,turnId));
   const frozen=repo.getNarrationProviderContext(OWNER,turnId,callId);
   if(frozen && JSON.stringify(frozen)!==JSON.stringify(publicNarrationContext(repo,currentTurn))) {
     return {turn:currentTurn,text:composeNarration(narrationReceipts(repo,currentTurn)??[]),source:"deterministic-fallback"};
   }
  let turn=requirePrivate(repo.getAdventureTurn(OWNER,turnId));const started=turn.providerCalls.find(call=>call.callId===callId&&call.phase==="started");
  if(started&&!turn.providerCalls.some(call=>call.callId===callId&&call.phase!=="started"))try{turn=repo.recordProviderCallOutcome(OWNER,{turnId,callId,
    provider:dispatch.provider,model:dispatch.model,attempt:1,outcome:dispatch.source==="provider-assisted"?"succeeded":"failed",outcomeCode:dispatch.outcomeCode,
    promptTokens:dispatch.promptTokens,completionTokens:dispatch.completionTokens,expectedTurnRevision:turn.revision,expectedCampaignRevision:turn.campaignRevision,
    idempotencyKey:key("narration-provider-settled",turnId)});}catch{turn=requirePrivate(repo.getAdventureTurn(OWNER,turnId));}
  return{turn,text:dispatch.narration,source:dispatch.source};
}
function publicNarrationContext(repo:Repo&Repository,turn:PrivateAdventureTurn){
  const snapshot=repo.getCampaignAgentContextSnapshot(OWNER,turn.campaignId,turn.sessionId,{kind:"player",actorId:turn.actorId});
  if(!snapshot?.ruleset)return null;const currentActorName=snapshot.speakerPersona?.displayName??null;
  const historicalRecall = repo.getCampaignRecall(OWNER, { campaignId: turn.campaignId, sessionId: turn.sessionId,
    audience: { kind: "player", actorId: turn.actorId }, purpose: "public-narration", query: turn.declaration,
    excludeRootTurnId: turn.mode === "original" ? turn.turnId : turn.priorTurnId ?? turn.turnId });
  if (!historicalRecall) return null;
  const cast=currentActorName?snapshot.visibleCast.filter(entry=>entry!==`${currentActorName}.`&&!entry.startsWith(`${currentActorName} at `)):snapshot.visibleCast;
  return{ruleset:snapshot.ruleset,currentLocation:snapshot.currentActorLocation,currentActorName,
    context:{...campaignPublicContext({...snapshot,visibleCast:cast}),historicalRecall},
    safety:repo.getSessionZeroSafetyPolicy(OWNER,turn.campaignId)};
}
async function narrate(repo: Repo & Repository, turn: PrivateAdventureTurn, dependencies: AdventureAgentDependencies | undefined,
  signal: AbortSignal): Promise<NarrationResult> {
  return performNarration(repo,turn,dependencies,signal);
}

function projectTurn(turn: PrivateAdventureTurn) {
  return { turnId: turn.turnId, campaignId: turn.campaignId, sessionId: turn.sessionId, actorId: turn.actorId,
    mode: turn.mode === "narration-fallback" ? "narration-retry" as const : turn.mode, priorTurnId: turn.priorTurnId,
    declaration: turn.declaration, state: turn.state, revision: turn.revision, createdAt: turn.createdAt, updatedAt: turn.updatedAt };
}
const proposals = (turn: PrivateAdventureTurn): AdventureTurnHttpProposal[] => turn.toolCalls.map(({ proposal }) => ({
  proposalId: proposal.proposalId, position: proposal.position, toolName: proposal.toolName,
  proposedAt: proposal.proposedAt, policy:{version:proposal.policy.version,category:proposal.policy.category,
    requiresConfirmation:proposal.policy.requiresConfirmation,requiredAuthorizer:proposal.policy.requiredAuthorizer,review:proposal.policy.review}, confirmation: proposal.confirmation.state === "decided"
    ? { state: "decided", decision: proposal.confirmation.decision.decision, decidedAt: proposal.confirmation.decision.decidedAt }
    : proposal.confirmation,
}));
const receipts = (turn: PrivateAdventureTurn) => turn.receiptLinks.map(({ commandId, proposalId, linkedAt }) => {
  return { commandId, proposalId, linkedAt };
});
function confirmation(turn: PrivateAdventureTurn) {
  const pending = turn.toolCalls.filter(({ proposal }) => proposal.confirmation.state === "pending");
  if (pending.length > 0) return { state: "pending" as const, proposalIds: pending.map(({ proposal }) => proposal.proposalId),
    expiresAt: pending.map(({ proposal }) => proposal.confirmation.state === "pending" ? proposal.confirmation.expiresAt : "").sort()[0]! };
  const decided = turn.toolCalls.flatMap(({ proposal }) => proposal.confirmation.state === "decided"
    ? [{ proposalId: proposal.proposalId, decision: proposal.confirmation.decision.decision, decidedAt: proposal.confirmation.decision.decidedAt }] : []);
  return decided.length > 0 ? { state: "decided" as const, decisions: decided } : { state: "none" as const };
}
function requirePrivate(value: ReturnType<Repo["getAdventureTurn"]>): PrivateAdventureTurn {
  if (!value || !("declaration" in value)) throw new AdventureTurnUnavailableError("turn is unavailable");
  return value;
}
function resumableDecisionDigest(turn: PrivateAdventureTurn): string | null {
  const required = turn.toolCalls.filter(({ proposal }) => proposal.confirmation.state !== "not-required");
  if (required.length === 0 || required.some(({ proposal }) => proposal.confirmation.state !== "decided")) return null;
  const decisions = required.map(({ proposal }) => {
    if (proposal.confirmation.state !== "decided" || proposal.confirmation.decision.principalId !== OWNER
      || !proposal.confirmation.decision.idempotencyKey.startsWith("batch:")) return null;
    const decision = proposal.confirmation.decision;
    return [proposal.proposalId, decision.decisionId, decision.decision, decision.expectedTurnRevision,
      decision.idempotencyKey, decision.principalId] as const;
  });
  if (decisions.some((decision) => decision === null)) return null;
  return createHash("sha256").update(JSON.stringify([turn.turnId, OWNER, decisions.sort((left, right) => left![0].localeCompare(right![0]))])).digest("base64url");
}
function resumeToken(turn: PrivateAdventureTurn): string | null {
  if(turn.state==="awaiting-confirmation"){
    const pending=turn.toolCalls.filter(({proposal})=>proposal.confirmation.state==="pending").map(({proposal})=>[proposal.proposalId,
      proposal.confirmation.state==="pending"?proposal.confirmation.expiresAt:"",proposal.policy.proposedCommandDigest]).sort((a,b)=>a[0]!.localeCompare(b[0]!));
    if(pending.length){const digest=createHash("sha256").update(JSON.stringify([turn.turnId,OWNER,pending])).digest("base64url");
      return adventureTurnResumeTokenSchema.parse(`v1.${Buffer.from(turn.turnId).toString("base64url")}.${digest}`);}
  }
  if (["declared","proposed"].includes(turn.state) && !turn.toolCalls.some(({proposal})=>proposal.confirmation.state==="pending")) {
    if (turn.receiptLinks.length > 0) {
      const evidence=turn.receiptLinks.map(link=>[link.linkId,link.commandId,link.proposalId,link.sourceTurnId,link.linkedAt])
        .sort((left,right)=>String(left[0]).localeCompare(String(right[0])));
      const digest=createHash("sha256").update(JSON.stringify([turn.turnId,OWNER,"receipt-recovery",evidence])).digest("base64url");
      return adventureTurnResumeTokenSchema.parse(`v1.${Buffer.from(turn.turnId).toString("base64url")}.${digest}`);
    }
    const digest=createHash("sha256").update(JSON.stringify([turn.turnId,OWNER,turn.createdAt,"automatic-planning"])).digest("base64url");
    return adventureTurnResumeTokenSchema.parse(`v1.${Buffer.from(turn.turnId).toString("base64url")}.${digest}`);
  }
  if (!["confirmed", "mechanics-committed", "narrating", "cancelled"].includes(turn.state)) return null;
  const decisionDigest = resumableDecisionDigest(turn);
  if (decisionDigest) return adventureTurnResumeTokenSchema.parse(`v1.${Buffer.from(turn.turnId).toString("base64url")}.${decisionDigest}`);
  if (turn.receiptLinks.length > 0 && ["confirmed", "mechanics-committed", "narrating"].includes(turn.state)) {
    const evidence=turn.receiptLinks.map(link=>[link.linkId,link.commandId,link.proposalId,link.sourceTurnId,link.linkedAt])
      .sort((left,right)=>String(left[0]).localeCompare(String(right[0])));
    const digest=createHash("sha256").update(JSON.stringify([turn.turnId,OWNER,"receipt-recovery",evidence])).digest("base64url");
    return adventureTurnResumeTokenSchema.parse(`v1.${Buffer.from(turn.turnId).toString("base64url")}.${digest}`);
  }
  return null;
}
function reconcile(repo: Repo, turn: PrivateAdventureTurn) {
  const token = resumeToken(turn);
  const narration=repo.getAdventureTurnNarration(OWNER,turn.turnId);const callId=key("narration-provider",turn.turnId);
  const source=repo.getAdventureTurnNarrationSource(OWNER,turn.turnId);
  return adventureTurnGetResponseSchema.parse({ turn: projectTurn(turn), proposals: proposals(turn), confirmation: confirmation(turn),
    receipts: receipts(turn), narrationStatus: { status: turn.narrationStatus, text:narration,
      source:narration?(source??"deterministic-fallback"):null },
    ...(token ? { resumeToken: token } : {}) });
}

function decodeResumeToken(token: string): { turnId: string; digest: string } {
  const parsed = adventureTurnResumeTokenSchema.parse(token);
  const [, turnPart, digest] = parsed.split(".");
  const turnId = Buffer.from(turnPart!, "base64url").toString("utf8");
  if (!resourceIdSchema.safeParse(turnId).success || !digest) throw new AdventureTurnUnavailableError();
  return { turnId, digest };
}
function turnFromToken(repo: Repo, token: string): PrivateAdventureTurn {
  const { turnId } = decodeResumeToken(token);
  const turn = requirePrivate(repo.getAdventureTurn(OWNER, turnId));
   if (resumeToken(turn) !== token) {
    throw new AdventureTurnUnavailableError("resume token is unavailable");
  }
  return turn;
}

function expireDue(repo:Repo,turn:PrivateAdventureTurn):PrivateAdventureTurn{
  if(!turn.toolCalls.some(({proposal})=>proposal.confirmation.state==="pending"))return turn;
  try{return repo.expireToolProposals(OWNER,{turnId:turn.turnId,expectedTurnRevision:turn.revision,
    expectedCampaignRevision:turn.campaignRevision,idempotencyKey:key("http-expire",turn.turnId,String(turn.revision))});}
  catch(error){if(error instanceof AdventureTurnConflictError)return turn;throw error;}
}

function fail(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof AdventureTurnUnavailableError || error instanceof AdventureTurnAuthorizationError) {
    return sendApiProblem(request, reply, 404, "RPG_ADVENTURE_TURN_NOT_FOUND", "Adventure turn not found");
  }
  if (error instanceof AdventureTurnStaleError) return sendApiProblem(request, reply, 409, "RPG_ADVENTURE_TURN_STALE", "Adventure turn is stale; reconcile before trying again");
  if (error instanceof AdventureTurnConflictError || error instanceof AdventureTurnExpiredError) return sendApiProblem(request, reply, 409, "RPG_ADVENTURE_TURN_CONFLICT", "Adventure turn command conflicts with durable state");
  request.log.error({ operation: "adventure-turn", method: request.method, route: request.routeOptions.url }, "RPG adventure turn operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Adventure turn status is unknown; reconcile with GET before retrying and do not automatically retry");
}

async function stream(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], repo: Repo, initial: PrivateAdventureTurn,
  streamKind: "initial" | "resume" | "variant", agentDependencies?:AdventureAgentDependencies): Promise<void> {
  let writer: SseWriter | null = null; let heartbeat: NodeJS.Timeout | null = null; let sequence = 0; let closed = false; let terminal = false;
  const abort = new AbortController();
  const send = (event: Omit<AdventureTurnStreamEvent, "sequence" | "timestamp">) => {
    if (!writer || closed) return;
    const envelope = adventureTurnStreamEventSchema.parse({ ...event, sequence, timestamp: new Date().toISOString() });
    sequence += 1; writer.send(envelope.type, envelope);
  };
  const finish = (turn: PrivateAdventureTurn, outcome: "done" | "aborted" | "error") => {
    if (terminal || closed) return; terminal = true;
    const view = reconcile(repo, turn);
    send({ type: "terminal", payload: { outcome, turn: view.turn, narrationStatus: view.narrationStatus, receipts: view.receipts } });
  };
  try {
    writer = openSse(reply, "private, no-store, no-transform"); reply.raw.on("close", () => { closed = true; abort.abort(); });
    const configuredHeartbeat = Number(process.env.VELVET_SSE_HEARTBEAT_MS ?? 15_000);
    heartbeat = setInterval(() => writer?.comment("heartbeat"), Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0 ? configuredHeartbeat : 15_000);
    heartbeat.unref();
    let turn = expireDue(repo,initial);
    if (streamKind === "resume" && turn.receiptLinks.some(({ linkId }) => linkId.startsWith("recoverable-"))) {
      turn = repo.reconcileAdventureTurnMechanics(OWNER, { turnId: turn.turnId, expectedTurnRevision: turn.revision,
        expectedCampaignRevision: turn.campaignRevision, idempotencyKey: key("http-reconcile", turn.turnId, String(turn.revision)) });
      await yieldToEventLoop();
    }
    if (closed) return;
    if (streamKind !== "resume") { send({ type: "turn_started", payload: { turn: projectTurn(turn) } }); await yieldToEventLoop(); }
    if (closed) return;
    if(turn.state==="completed"){
      const narration=repo.getAdventureTurnNarration(OWNER,turn.turnId);if(narration){send({type:"narration_delta",payload:{text:narration}});await yieldToEventLoop();}
      finish(turn,"done");return;
    }
    if(["cancelled","failed"].includes(turn.state)){
      const decisions=turn.toolCalls.flatMap(({proposal})=>proposal.confirmation.state==="decided"?[proposal.confirmation.decision.decision]:[]);
      send({type:"agent_status",payload:{status:decisions.includes("expired")?"expired":"decision-rejected"}});await yieldToEventLoop();
      finish(turn,turn.state==="cancelled"?"aborted":"error");return;}
    send({ type: "agent_status", payload: { status: turn.state === "awaiting-confirmation" ? "awaiting-confirmation" : "planning" } });
    await yieldToEventLoop();
    if (closed) return;
    if ((streamKind === "initial" || streamKind === "resume") && (["declared","proposed"].includes(turn.state)
      ||turn.toolCalls.some((call)=>call.status==="approved"))) {
      let agent=await orchestrateAdventureTurn(repo as Repo & Repository,turn.turnId,agentDependencies,abort.signal);turn=agent.turn;
      await yieldToEventLoop();
      if (closed) return;
      // An exclusive dispatch owner may be running in another resume. Wait for
      // its durable response and reconcile it; never emit a false aborted
      // terminal that suggests the already-dispatched request was cancelled.
      while(!closed&&agent.outcome==="in-progress"){
        await new Promise<void>((resolve)=>setTimeout(resolve,10));
        if (closed) return;
        turn=requirePrivate(repo.getAdventureTurn(OWNER,turn.turnId));
        agent=await orchestrateAdventureTurn(repo as Repo & Repository,turn.turnId,agentDependencies,abort.signal);turn=agent.turn;
      }
    }
    if (closed) return;

    const visibleProposals=streamKind==="initial"?proposals(turn):proposals(turn).filter((proposal)=>proposal.confirmation.state==="pending");
    for (const proposal of visibleProposals) { send({ type: "tool_proposed", payload: { proposal } }); await yieldToEventLoop(); }
    const pending = turn.toolCalls.filter(({ proposal }) => proposal.confirmation.state === "pending");
    if (pending.length > 0) {
      if (turn.state === "proposed") turn = repo.waitForToolConfirmation(OWNER, { turnId: turn.turnId,
        expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
        idempotencyKey: key("http-wait", turn.turnId) });
      await yieldToEventLoop();
      const state = confirmation(turn); if (state.state !== "pending") throw new Error("confirmation projection changed unexpectedly");
      send({ type: "confirmation_required", payload: { proposalIds: state.proposalIds, expiresAt: state.expiresAt } });
      await yieldToEventLoop();
      finish(turn, "aborted"); return;
    }
    if(["cancelled","failed"].includes(turn.state)){finish(turn,turn.state==="cancelled"?"aborted":"error");return;}

    if (turn.toolCalls.some((call)=>call.status==="approved") && turn.receiptLinks.length === 0) {
      send({ type: "agent_status", payload: { status: "pending-mechanics" } });
      await yieldToEventLoop();
      finish(turn, "aborted"); return;
    }
    if(turn.toolCalls.length>0&&turn.toolCalls.every((call)=>["rejected","expired","cancelled"].includes(call.status))){finish(turn,"aborted");return;}
    if (turn.receiptLinks.length > 0) { send({ type: "mechanics_committed", payload: { receipts: receipts(turn) } }); await yieldToEventLoop(); }
    let narration = repo.getAdventureTurnNarration(OWNER, turn.turnId);
    if (turn.narrationStatus !== "completed") {
      send({ type: "agent_status", payload: { status: "narrating" } });
      await yieldToEventLoop();
      if (turn.state !== "narrating") turn = repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId,
        expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
        idempotencyKey: key("http-narrating", turn.turnId), narrationStatus: "in-progress" });
      await yieldToEventLoop();
       const narrated = await narrate(repo as Repo & Repository, turn, agentDependencies, abort.signal);
       turn = narrated.turn; narration = narrated.text;
      if(turn.state!=="completed")try{turn = repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId, expectedTurnRevision: turn.revision,
        expectedCampaignRevision: turn.campaignRevision, idempotencyKey: key("http-narrated", turn.turnId),
         narrationStatus: "completed", terminalState: "completed", fallbackNarration: narration,narrationSource:narrated.source });}
      catch(error){if(!(error instanceof AdventureTurnConflictError||error instanceof AdventureTurnStaleError))throw error;
        turn=requirePrivate(repo.getAdventureTurn(OWNER,turn.turnId));if(turn.state!=="completed")throw error;
        narration=repo.getAdventureTurnNarration(OWNER,turn.turnId)??narration;}
      await yieldToEventLoop();
    }
    if (narration) { send({ type: "narration_delta", payload: { text: narration } }); await yieldToEventLoop(); }
    finish(requirePrivate(repo.getAdventureTurn(OWNER, turn.turnId)), "done");
  } catch (error) {
    if (closed || abort.signal.aborted) return;
    request.log.error({ phase: "stream", errorCode: "RPG_ADVENTURE_TURN_STREAM_FAILED" }, "RPG adventure turn stream failed");
    try { finish(requirePrivate(repo.getAdventureTurn(OWNER, initial.turnId)), "error"); } catch { /* connection or durable state is unavailable */ }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (terminal) adventureTurnBudgets.clear(initial.turnId);
    if (!reply.raw.destroyed && !reply.raw.writableEnded) writer?.end();
  }
}

/** Registers strict adventure-turn stream, reconciliation, and confirmation routes. */
export const adventureTurnsHttpRoutes: FastifyPluginAsync<AdventureTurnsHttpOptions> = async (app, options) => {
  app.get<{ Querystring: Record<string, unknown> }>("/adventure-turns/transcript", { exposeHeadRoute: false,
    onRequest: async (request, reply) => { reply.header("cache-control", "private, no-store"); if (!enabled()) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; } },
  }, async (request, reply) => {
    const query = adventureTurnTranscriptRequestSchema.safeParse(request.query);
    if (!query.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure transcript locator is invalid");
    try {
      const turns = options.adventureTurnRepositoryAccessor().getAdventureTurnTranscript(OWNER, query.data.campaignId, query.data.sessionId);
      return reply.send(adventureTurnTranscriptResponseSchema.parse({ ...query.data, turns }));
    } catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>("/adventure-turns/stream", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn streams do not accept query parameters"); return; }
      const type = request.headers["content-type"];
      if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Adventure turn streams require application/json");
    }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn stream request is invalid"),
  }, async (request, reply) => {
    const body = adventureTurnStreamRequestSchema.safeParse(request.body);
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn stream request is invalid");
    try {
      const repo = options.adventureTurnRepositoryAccessor();
      let turn: PrivateAdventureTurn;
       let streamKind: "initial" | "resume" | "variant" = "initial";
       if ("resumeToken" in body.data) { streamKind = "resume"; turn = turnFromToken(repo, body.data.resumeToken); }
       else if ("variant" in body.data) {
         streamKind = "variant";
         const campaign = repo.getCampaign(OWNER, body.data.campaignId); if (!campaign) throw new AdventureTurnUnavailableError();
         const prior = requirePrivate(repo.getAdventureTurn(OWNER, body.data.priorTurnId));
         if (prior.campaignId !== body.data.campaignId || prior.sessionId !== body.data.sessionId || prior.actorId !== body.data.actorId
           || !["completed", "cancelled", "failed"].includes(prior.state)) throw new AdventureTurnConflictError("narration ancestor is out of scope");
         turn = repo.createAdventureTurn(OWNER, { campaignId: body.data.campaignId, timelineId: campaign.activeTimelineId,
           sessionId: body.data.sessionId, actorId: body.data.actorId, declaration: prior.declaration, mode: body.data.variant,
           priorTurnId: prior.turnId, expectedCampaignRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey });
         turn = requirePrivate(repo.getAdventureTurn(OWNER, turn.turnId));
       }
       else {
        const campaign = repo.getCampaign(OWNER, body.data.campaignId);
        if (!campaign) throw new AdventureTurnUnavailableError();
        turn = repo.createAdventureTurn(OWNER, { campaignId: body.data.campaignId, timelineId: campaign.activeTimelineId,
          sessionId: body.data.sessionId, actorId: body.data.actorId, declaration: body.data.declaration,
          expectedCampaignRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey });
        // Creation receipts intentionally replay their historical result; stream the fresh durable aggregate.
        turn = requirePrivate(repo.getAdventureTurn(OWNER, turn.turnId));
      }
       // The durable identity exists before SSE framing for both initial and
      // resume requests, allowing clients to reconcile even if the first body
      // frame is never delivered.
      // openSse hijacks Fastify and writes directly to the Node response, so
      // bind this route-specific header on the raw response before writeHead.
      reply.raw.setHeader("X-Adventure-Turn-Id", turn.turnId);
        await stream(request, reply, repo, turn, streamKind,options.agentDependencies);
    } catch (error) { return fail(request, reply, error); }
  });

  // Register the fixed reconciliation locator before the turn-ID resource so
  // every route and error path retains its reviewed static identity.
  app.get<{ Querystring: Record<string, unknown> }>("/adventure-turns/reconcile-initial", { exposeHeadRoute: false,
    onRequest: async (request, reply) => { reply.header("cache-control", "private, no-store"); if (!enabled()) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; } },
  }, async (request, reply) => {
    const query = adventureTurnInitialReconcileRequestSchema.safeParse(request.query);
    if (!query.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Initial turn reconciliation locator is invalid");
    try {
      const repo = options.adventureTurnRepositoryAccessor();
      const found = repo.getAdventureTurnByInitialIdempotencyKey(OWNER, query.data.campaignId, query.data.sessionId,
        query.data.actorId, query.data.idempotencyKey);
       const result = found ? reconcile(repo, expireDue(repo,requirePrivate(found))) : null;
      return reply.send(adventureTurnInitialReconcileResponseSchema.parse({ result }));
    } catch (error) { return fail(request, reply, error); }
  });

  app.get<{ Params: { turnId: string }; Querystring: Record<string, unknown> }>("/adventure-turns/:turnId", { exposeHeadRoute: false,
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store"); if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn reads do not accept query parameters"); },
  }, async (request, reply) => {
    const turnId = resourceIdSchema.safeParse(request.params.turnId); if (!turnId.success) return sendApiProblem(request, reply, 404, "RPG_ADVENTURE_TURN_NOT_FOUND", "Adventure turn not found");
    try { const repo=options.adventureTurnRepositoryAccessor();return reply.send(reconcile(repo,expireDue(repo,requirePrivate(repo.getAdventureTurn(OWNER, turnId.data))))); }
    catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: { turnId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/adventure-turns/:turnId/confirm", {
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store"); if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn confirmation does not accept query parameters"); return; }
      if (!resourceIdSchema.safeParse(request.params.turnId).success) { await sendApiProblem(request, reply, 404, "RPG_ADVENTURE_TURN_NOT_FOUND", "Adventure turn not found"); return; }
      const type = request.headers["content-type"]; if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Adventure turn confirmation requires application/json");
    }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn confirmation request is invalid"),
  }, async (request, reply) => {
    const turnId = resourceIdSchema.safeParse(request.params.turnId), body = adventureTurnConfirmRequestSchema.safeParse(request.body);
    if (!turnId.success) return sendApiProblem(request, reply, 404, "RPG_ADVENTURE_TURN_NOT_FOUND", "Adventure turn not found");
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn confirmation request is invalid");
    try {
      const repo = options.adventureTurnRepositoryAccessor(); const before = requirePrivate(repo.getAdventureTurn(OWNER, turnId.data));
       let turn = repo.decideToolProposals(OWNER, { turnId: turnId.data, proposalIds: body.data.proposalIds,
         decision: body.data.decision === "approve" ? "approved" : "rejected", expectedTurnRevision: body.data.expectedRevision,
         expectedCampaignRevision: before.campaignRevision, idempotencyKey: body.data.idempotencyKey });
       const planning=(repo as Repo&Repository).getDurableAgentPlanningState(OWNER,turn.turnId);
       const providerSelected=turn.toolCalls.some((call)=>call.status==="approved"&&call.proposal.executionBinding.commandType==="combat_action")
         ||Boolean(planning?.toolCalls.some((call)=>call.kind==="mutation"));
       const noPending=!turn.toolCalls.some(({proposal})=>proposal.confirmation.state==="pending");
       if(noPending&&providerSelected)turn=(await orchestrateAdventureTurn(repo as Repo&Repository,turn.turnId,options.agentDependencies)).turn;
      const token = resumeToken(turn); const response = { turn: projectTurn(turn), ...(token ? { resumeToken: token } : {}) };
      return reply.send(adventureTurnConfirmResponseSchema.parse(response));
    } catch (error) { return fail(request, reply, error); }
  });
};

import { createHash } from "node:crypto";
import { canonicalAgentJson, confirmationPolicyAttestationSchema, CONFIRMATION_POLICY_VERSION,
  type ConfirmationAuthorizer, type ConfirmationPolicyAttestation, type ConfirmationPolicyCategory } from "@velvet/contracts";

type ProposalPolicyInput = {
  toolName:string; arguments:Record<string,unknown>; campaignRevision:number; turnRevision:number;
  timelineRevision:number; combatRevision?:number; autonomousEnemy?:boolean; at:string;
};

const digest=(value:unknown)=>createHash("sha256").update(canonicalAgentJson(value as never)).digest("hex");

/**
 * Confirmation policy v1 — the single server-owned source of truth for whether a proposed adventure
 * mechanic is executed directly or held for one human confirmation. Provider output only supplies
 * arguments; it never influences this table.
 *
 * Rule: an action auto-commits only when it is bounded, reversible, and spends no tracked resource.
 * Anything that spends, is irreversible, or carries a real consequence requires exactly one
 * confirmation (never a silent spend, never a second confirmation for the same declared action).
 *
 * | Category                              | Examples                                          | Confirmation        | Authorizer |
 * |---------------------------------------|---------------------------------------------------|---------------------|------------|
 * | deterministic-roll                    | raw dice with no DC/outcome                       | auto-commit         | controller |
 * | inventory-equip / inventory-unequip   | wear/wield/stow a carried item                    | auto-commit         | controller |
 * | (outside this table) travel / checks / quest objective progress: bounded, reversible reads of state | | auto-commit | controller |
 * | purchase / currency-transfer          | buy, sell, pay, transfer coin                     | single confirmation | controller |
 * | important-item-loss/consume/gift      | drop, destroy, consume, give away an item         | single confirmation | controller |
 * | ambiguous-limited-resource-use        | power, combat consumable/power, finite resource   | single confirmation | controller |
 * | rest-timing                           | short/long rest recovery and time advance         | single confirmation | controller |
 * | quest-accept / quest-abandon / quest-reward-claim | quest lifecycle                        | single confirmation | controller |
 * | character-progression                 | level/feature/resource advancement                | single confirmation | controller |
 * | combat-action-consequential           | a consequential combat action (player turns only)| single confirmation | controller |
 * | combat-start / companion-change       | start an encounter, change a companion            | single confirmation | gm         |
 * | gm-override                           | GM-authoritative attribute write                  | single confirmation | gm         |
 * | generated-* / ambiguous-consequential-change | unreviewed world/story/quest generation, unknown tool | single confirmation | gm |
 *
 * Autonomous enemy combat resolves without confirmation because the server, not the player, owns
 * that turn; the consequential player combat action stays gated.
 */
export const AUTO_COMMIT_CATEGORIES: readonly ConfirmationPolicyCategory[] =
  ["deterministic-roll","inventory-equip","inventory-unequip"];

/** Maps a proposal tool name to its closed policy category; unknown tools fail into the ambiguous bucket. */
export function confirmationCategoryFor(toolName:string):ConfirmationPolicyCategory {
  if(toolName==="inventory_item_equip")return "inventory-equip";
  if(toolName==="inventory_item_unequip")return "inventory-unequip";
  if(toolName==="inventory_item_drop")return "important-item-loss";
  if(toolName==="inventory_item_consume")return "important-item-consume";
  if(toolName==="inventory_item_gift")return "important-item-gift";
  if(toolName==="roll_actor_dice"||toolName==="roll")return "deterministic-roll";
  if(toolName==="combat_action")return "combat-action-consequential";
  if(toolName==="set_actor_attribute")return "gm-override";
  if(toolName==="power_use"||toolName==="combat_consumable_use"||toolName==="combat_power_use")return "ambiguous-limited-resource-use";
  if(toolName==="rest_short"||toolName==="rest_long")return "rest-timing";
  if(toolName==="quest_accept")return "quest-accept";
  if(toolName==="quest_abandon")return "quest-abandon";
  if(toolName==="quest_reward_claim")return "quest-reward-claim";
  if(toolName==="character_progression_apply")return "character-progression";
  if(toolName==="vendor_buy")return "purchase";
  if(toolName==="vendor_sell")return "currency-transfer";
  if(toolName==="vendor_give")return "important-item-gift";
  if(/currency.*transfer/.test(toolName))return "currency-transfer";
  if(/purchase/.test(toolName))return "purchase";
  if(/item.*(?:remove|loss)/.test(toolName))return "important-item-loss";
  if(/item.*consume/.test(toolName))return "important-item-consume";
  if(/item.*gift/.test(toolName))return "important-item-gift";
  if(/resource/.test(toolName))return "ambiguous-limited-resource-use";
  if(/rest/.test(toolName))return "rest-timing";
  if(/companion/.test(toolName))return "companion-change";
  if(/combat.*start/.test(toolName))return "combat-start";
  if(/world/.test(toolName))return "generated-world-change";
  if(/quest/.test(toolName))return "generated-quest-change";
  if(/story/.test(toolName))return "generated-story-change";
  return "ambiguous-consequential-change";
}

/** The confirmation half of the rule table; `autonomousEnemy` only relaxes server-owned combat. */
export function requiresConfirmationFor(category:ConfirmationPolicyCategory,options:{autonomousEnemy?:boolean}={}):boolean {
  if(AUTO_COMMIT_CATEGORIES.includes(category))return false;
  if(category==="combat-action-consequential"&&options.autonomousEnemy===true)return false;
  return true;
}

/** Who must approve a confirmation-required proposal; generated and GM-authoritative changes need a GM. */
export function requiredAuthorizerFor(category:ConfirmationPolicyCategory):ConfirmationAuthorizer {
  return category==="gm-override"||category.startsWith("generated-")||category==="combat-start"||category==="companion-change"?"gm":"controller";
}

/** Convenience for call sites that only need the boolean rule for one tool name. */
export function policyRequiresConfirmation(toolName:string,options:{autonomousEnemy?:boolean}={}):boolean {
  return requiresConfirmationFor(confirmationCategoryFor(toolName),options);
}

/** Closed server policy. Provider output contains arguments only and has no confirmation-policy control. */
export function deriveConfirmationPolicy(input:ProposalPolicyInput):ConfirmationPolicyAttestation {
  const category=confirmationCategoryFor(input.toolName);
  const requiresConfirmation=requiresConfirmationFor(category,input.autonomousEnemy===undefined?{}:{autonomousEnemy:input.autonomousEnemy});
  const requiredAuthorizer=requiredAuthorizerFor(category);
  const itemLabel=typeof input.arguments.itemLabel==="string"?input.arguments.itemLabel:"selected inventory item";
  const quantity=Number.isSafeInteger(input.arguments.itemQuantity)?input.arguments.itemQuantity:1;
  const slot=typeof input.arguments.itemSlot==="string"?input.arguments.itemSlot:"selected";
  const recipient=typeof input.arguments.itemRecipient==="string"?input.arguments.itemRecipient:"the selected campaign actor";
  const vendor=typeof input.arguments.vendorLabel==="string"?input.arguments.vendorLabel:"the selected vendor";
  const shop=typeof input.arguments.shopLabel==="string"?input.arguments.shopLabel:"their shop";
  const currency=typeof input.arguments.currencyLabel==="string"?input.arguments.currencyLabel:"currency";
  const price=Number.isSafeInteger(input.arguments.priceMinorUnits)?input.arguments.priceMinorUnits:0;
  const powerName=typeof input.arguments.powerName==="string"?input.arguments.powerName:"selected power";
  const questTitle=typeof input.arguments.questTitle==="string"?input.arguments.questTitle:"selected quest";
  const rewardLabel=typeof input.arguments.rewardLabel==="string"?input.arguments.rewardLabel:"selected reward";
  const progressionClass=typeof input.arguments.progressionClass==="string"?input.arguments.progressionClass:"character";
  const levelBefore=Number.isSafeInteger(input.arguments.levelBefore)?input.arguments.levelBefore:0;
  const levelAfter=Number.isSafeInteger(input.arguments.levelAfter)?input.arguments.levelAfter:0;
  const targets=Array.isArray(input.arguments.powerTargets)?input.arguments.powerTargets.filter(value=>typeof value==="string").join(", "):"selected target";
  const costs=Array.isArray(input.arguments.powerCosts)&&input.arguments.powerCosts.length?input.arguments.powerCosts.filter(value=>typeof value==="string").join(", "):"no finite cost";
  const combatConsequences=Array.isArray(input.arguments.combatConsumableConsequences)?input.arguments.combatConsumableConsequences.flatMap(value=>value&&typeof value==="object"&&!Array.isArray(value)&&typeof (value as any).label==="string"?[(value as any).label]:[]).join(", "):"";
  const powerConsequences=Array.isArray(input.arguments.combatPowerConsequences)?input.arguments.combatPowerConsequences.flatMap(value=>value&&typeof value==="object"&&!Array.isArray(value)&&typeof (value as any).label==="string"?[(value as any).label]:[]).join(", "):"";
  const recovery=Array.isArray(input.arguments.recovery)?input.arguments.recovery.flatMap(value=>value&&typeof value==="object"&&!Array.isArray(value)
    &&typeof (value as any).label==="string"&&Number.isSafeInteger((value as any).before)&&Number.isSafeInteger((value as any).after)
      ?[`${(value as any).label} ${(value as any).before} to ${(value as any).after}`]:[]).join(", "):"";
  const rawSummary=category==="inventory-equip"?`Equip ${quantity} ${itemLabel} in the ${slot} slot.`
    :category==="inventory-unequip"?`Unequip ${quantity} ${itemLabel} from the ${slot} slot.`
    :category==="important-item-loss"?`Drop ${quantity} ${itemLabel}.`
    :category==="important-item-consume"?`Consume ${quantity} ${itemLabel}; this removes it without applying an item effect.`
    :category==="important-item-gift"?`Gift ${quantity} ${itemLabel} to ${recipient}.`
    :category==="purchase"?`Buy from ${vendor} at ${shop}: ${quantity} ${itemLabel} for ${price} ${currency}. Inventory gains the item and the wallet is debited.`
    :category==="currency-transfer"?`Sell ${quantity} ${itemLabel} to ${vendor} at ${shop} for ${price} ${currency}. Inventory loses the item and the wallet is credited.`
    :category==="ambiguous-limited-resource-use"?`Use ${powerName} on ${targets}. Cost: ${costs}.${input.toolName==="combat_consumable_use"||input.toolName==="combat_power_use"?` Consequence: ${combatConsequences||powerConsequences||"the advertised combat effect"}.`:""}`
    :category==="rest-timing"?`Take ${input.toolName==="rest_short"?"a short rest":"a long rest"}. Recovery: ${recovery||"none"}.`
    :category==="quest-accept"?`Accept the quest ${questTitle}.`
    :category==="quest-abandon"?`Abandon the quest ${questTitle}.`
    :category==="quest-reward-claim"?`Claim ${rewardLabel} from ${questTitle} for the controlled character.`
    :category==="character-progression"?`Apply ${progressionClass} progression from level ${levelBefore} to level ${levelAfter}.`
    :category==="combat-action-consequential"?"Execute the selected consequential combat action."
    :category==="deterministic-roll"?"Roll dice using authoritative mechanics."
    :category==="gm-override"?"Apply a GM-authorized character value change."
    :"Apply a consequential change. Human review is required because its category is ambiguous.";
  const summary=rawSummary.slice(0,500).trim();
  const consequence=category==="combat-action-consequential"?{kind:"combat-impact" as const,text:"Combat state may change"}
    :category==="deterministic-roll"?{kind:"roll-recorded" as const,text:"A roll result will be recorded"}
    :category==="gm-override"?{kind:"attribute-change" as const,text:"A character value will change"}
    :{kind:"campaign-change" as const,text:"Campaign state may change"};
  const observedDomains=[{domain:"campaign",revision:input.campaignRevision},{domain:"turn",revision:input.turnRevision},
    {domain:"timeline",revision:input.timelineRevision},...(input.combatRevision===undefined?[]:[{domain:"combat",revision:input.combatRevision}])];
  return confirmationPolicyAttestationSchema.parse({version:CONFIRMATION_POLICY_VERSION,category,requiresConfirmation,requiredAuthorizer,
    review:{summary,consequences:[consequence]},proposedCommandDigest:digest({toolName:input.toolName,arguments:input.arguments}),
    observedDomains,attestedAt:input.at});
}

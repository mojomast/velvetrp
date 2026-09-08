import { createHash } from "node:crypto";
import { canonicalAgentJson, confirmationPolicyAttestationSchema, CONFIRMATION_POLICY_VERSION,
  type ConfirmationPolicyAttestation, type ConfirmationPolicyCategory } from "@velvet/contracts";

type ProposalPolicyInput = {
  toolName:string; arguments:Record<string,unknown>; campaignRevision:number; turnRevision:number;
  timelineRevision:number; combatRevision?:number; autonomousEnemy?:boolean; at:string;
};

const digest=(value:unknown)=>createHash("sha256").update(canonicalAgentJson(value as never)).digest("hex");

/** Closed server policy. Provider output contains arguments only and has no confirmation-policy control. */
export function deriveConfirmationPolicy(input:ProposalPolicyInput):ConfirmationPolicyAttestation {
  let category:ConfirmationPolicyCategory="ambiguous-consequential-change";
  if(input.toolName==="inventory_item_equip")category="inventory-equip";
  else if(input.toolName==="inventory_item_unequip")category="inventory-unequip";
  else if(input.toolName==="inventory_item_drop")category="important-item-loss";
  else if(input.toolName==="inventory_item_consume")category="important-item-consume";
  else if(input.toolName==="inventory_item_gift")category="important-item-gift";
  else if(input.toolName==="roll_actor_dice"||input.toolName==="roll")category="deterministic-roll";
  else if(input.toolName==="combat_action")category="combat-action-consequential";
  else if(input.toolName==="set_actor_attribute")category="gm-override";
  else if(input.toolName==="power_use"||input.toolName==="combat_consumable_use"||input.toolName==="combat_power_use")category="ambiguous-limited-resource-use";
  else if(input.toolName==="rest_short"||input.toolName==="rest_long")category="rest-timing";
  else if(input.toolName==="quest_accept")category="quest-accept";
  else if(input.toolName==="quest_abandon")category="quest-abandon";
  else if(input.toolName==="quest_reward_claim")category="quest-reward-claim";
  else if(input.toolName==="character_progression_apply")category="character-progression";
  else if(input.toolName==="vendor_buy")category="purchase";
  else if(input.toolName==="vendor_sell")category="currency-transfer";
  else if(input.toolName==="vendor_give")category="important-item-gift";
  else if(/currency.*transfer/.test(input.toolName))category="currency-transfer";
  else if(/purchase/.test(input.toolName))category="purchase";
  else if(/item.*(?:remove|loss)/.test(input.toolName))category="important-item-loss";
  else if(/item.*consume/.test(input.toolName))category="important-item-consume";
  else if(/item.*gift/.test(input.toolName))category="important-item-gift";
  else if(/resource/.test(input.toolName))category="ambiguous-limited-resource-use";
  else if(/rest/.test(input.toolName))category="rest-timing";
  else if(/companion/.test(input.toolName))category="companion-change";
  else if(/combat.*start/.test(input.toolName))category="combat-start";
  else if(/world/.test(input.toolName))category="generated-world-change";
  else if(/quest/.test(input.toolName))category="generated-quest-change";
  else if(/story/.test(input.toolName))category="generated-story-change";
  const requiresConfirmation=!(["deterministic-roll","inventory-equip","inventory-unequip"] as ConfirmationPolicyCategory[]).includes(category)
    &&!(category==="combat-action-consequential"&&input.autonomousEnemy===true);
  const requiredAuthorizer=category==="gm-override"||category.startsWith("generated-")||category==="combat-start"||category==="companion-change"?"gm":"controller";
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

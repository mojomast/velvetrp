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
  if(input.toolName==="roll_actor_dice"||input.toolName==="roll")category="deterministic-roll";
  else if(input.toolName==="combat_action")category="combat-action-consequential";
  else if(input.toolName==="set_actor_attribute")category="gm-override";
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
  const requiresConfirmation=category!=="deterministic-roll"&&!(category==="combat-action-consequential"&&input.autonomousEnemy===true);
  const requiredAuthorizer=category==="gm-override"||category.startsWith("generated-")||category==="combat-start"||category==="companion-change"?"gm":"controller";
  const summary=category==="combat-action-consequential"?"Execute the selected consequential combat action."
    :category==="deterministic-roll"?"Roll dice using authoritative mechanics."
    :category==="gm-override"?"Apply a GM-authorized character value change."
    :"Apply a consequential change. Human review is required because its category is ambiguous.";
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

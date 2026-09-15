import type { RulesetCapability } from "../types.js";
import { DND_5E_ATTACK_CAPABILITIES } from "./attack.js";
import { DND_5E_CONDITION_CAPABILITIES } from "./conditions.js";
import { DND_5E_DAMAGE_CAPABILITIES } from "./damage.js";
import { DND_5E_D20_CAPABILITIES } from "./d20.js";
import { DND_5E_DERIVED_CAPABILITIES } from "./derived.js";
import { DND_5E_ENCOUNTER_BUILDER_CAPABILITIES } from "./encounterBuilder.js";
import { DND_5E_ENCOUNTER_REWARD_CAPABILITIES } from "./encounterRewards.js";
import { DND_5E_NPC_SELECTION_CAPABILITIES } from "./npcSelection.js";
import { DND_5E_MOVEMENT_CAPABILITIES } from "./movement.js";
import { DND_5E_PLAN_CAPABILITIES } from "./plans.js";
import { DND_5E_RESOURCE_CAPABILITIES } from "./resources.js";
import { DND_5E_REST_CAPABILITIES } from "./rests.js";
import { DND_5E_VISION_CAPABILITIES } from "./vision.js";

export const DND_5E_RULESET_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  ...DND_5E_D20_CAPABILITIES,
  ...DND_5E_ATTACK_CAPABILITIES,
  ...DND_5E_DAMAGE_CAPABILITIES,
  ...DND_5E_MOVEMENT_CAPABILITIES,
  ...DND_5E_REST_CAPABILITIES,
  ...DND_5E_CONDITION_CAPABILITIES,
  ...DND_5E_RESOURCE_CAPABILITIES,
  ...DND_5E_DERIVED_CAPABILITIES,
  ...DND_5E_PLAN_CAPABILITIES,
  ...DND_5E_ENCOUNTER_BUILDER_CAPABILITIES,
  ...DND_5E_ENCOUNTER_REWARD_CAPABILITIES,
  ...DND_5E_NPC_SELECTION_CAPABILITIES,
  ...DND_5E_VISION_CAPABILITIES,
]);

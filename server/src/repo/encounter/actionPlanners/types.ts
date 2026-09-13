export type CombatActionPlan = {
  legalActionId: string;
  kind: "attack" | "grapple" | "escape-grapple" | "shove" | "stand-up" | "dash" | "disengage" | "help" | "hide" | "flee" | "end-turn" | "stabilize" | "death-save";
  actingCombatantId: string;
  targetIds: string[];
  cost: "action" | null;
  attackType?: "melee" | "ranged" | "thrown";
  targetEvidence?: RangedTargetEvidence[];
};

export type RangedTargetEvidence = Readonly<{
  targetCombatantId: string;
  lineOfEffect: "clear" | "blocked";
  cover: "none" | "half" | "three-quarters" | "full";
  blockedBy: Array<{ x: number; y: number }>;
  reason?: "full-cover" | "unsupported-geometry";
}>;

export type RangedCombatCandidate = Readonly<{
  attackId: string;
  weaponEntryId: string;
  attackAbility: "strength" | "dexterity";
  normalRangeFeet: number;
  longRangeFeet: number;
  ammunitionResourceId: string | null;
  targetIds: string[];
  rangeFeetByTarget: Record<string, number>;
  targetEvidence: RangedTargetEvidence[];
}>;

export type ThrownCombatCandidate = Readonly<{
  attackId: string;
  weaponEntryId: string;
  throwableItemEntryId: string;
  attackAbility: "strength" | "dexterity";
  normalRangeFeet: number;
  longRangeFeet: number;
  targetIds: string[];
  rangeFeetByTarget: Record<string, number>;
  targetEvidence: RangedTargetEvidence[];
}>;

/** Contract-only seam for a future spell runtime; this module never resolves spells. */
export type CombatSpellRangedCandidate = Readonly<{
  kind: "spell";
  spellId: string;
  attackAbility: "strength" | "dexterity";
  attackModifier: number;
  rangeFeet: number;
  targetIds: string[];
}>;
export interface CombatSpellCandidateProvider {
  getCombatRangedCandidates(campaignId: string, encounterId: string, combatantId: string): readonly CombatSpellRangedCandidate[];
}

export type PersistedCombatTurnEconomy = {
  turnId: string;
  combatantId: string;
  round: number;
  action: { available: boolean; used: boolean };
  bonusAction: { available: boolean; used: boolean };
  reaction: { available: boolean; used: boolean };
  movement: { allowanceFeet: number; usedFeet: number; remainingFeet: number };
};

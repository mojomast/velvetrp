import type { DiceTerm } from "../../../rulesets/types.js";

/**
 * Bounded declarative on-hit rider vocabulary. A rider is attached to one
 * attack, contributes an optional secondary damage term of its own type, an
 * optional target condition, and/or an optional triggered sub-effect. Limits
 * keep a rider from resolving more than once per turn or per attack.
 */
export type AttackRiderDamageDoubling = "critical" | "none";
export type AttackRiderLimit = "once-per-turn" | "once-per-attack";

export type AttackRiderSource = Readonly<{
  kind: string;
  packId: string;
  packVersion: string;
  definitionId: string;
}>;

export type AttackRiderDamage = Readonly<{
  damageType: string;
  dice: readonly DiceTerm[];
  /** "critical" doubles the rider dice on a critical hit; "none" never doubles. */
  doubling?: AttackRiderDamageDoubling;
}>;

export type AttackRiderCondition = Readonly<{
  condition: string;
  durationRounds?: number;
}>;

export type AttackRiderSubEffect = Readonly<{
  kind: string;
  label: string;
}>;

export type AttackRider = Readonly<{
  riderId: string;
  label: string;
  source: AttackRiderSource;
  /** Sneak Attack requires advantage; a plain rider applies on any hit. */
  requiresAdvantage?: boolean;
  limit?: AttackRiderLimit;
  damage?: AttackRiderDamage;
  condition?: AttackRiderCondition;
  effect?: AttackRiderSubEffect;
}>;

export type AttackRiderContext = Readonly<{
  hit: boolean;
  critical: boolean;
  advantage: boolean;
  usedThisTurn: ReadonlySet<string>;
  usedThisAttack: ReadonlySet<string>;
}>;

export type AttackRiderDamageResolution = Readonly<{
  damageType: string;
  dice: readonly DiceTerm[];
  rolls: readonly number[];
  critical: boolean;
  damage: number;
}>;

export type AttackRiderResolution = Readonly<{
  riderId: string;
  label: string;
  source: AttackRiderSource;
  damage?: AttackRiderDamageResolution;
  condition?: AttackRiderCondition;
  effect?: AttackRiderSubEffect;
}>;

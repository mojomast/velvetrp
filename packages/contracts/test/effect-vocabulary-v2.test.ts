import { describe, expect, it } from "vitest";
import {
  EFFECT_VOCABULARY_VERSION,
  starterEffectSchema,
  starterEffectV2Schema,
  starterEffectsV2Schema,
  type StarterEffectV2,
} from "../src/index.js";

const fireDamage = { type: "damage", damageType: "fire", dice: { count: 2, sides: 6, modifier: 0 } } as const;
const slowed = { type: "condition", condition: "slowed", durationRounds: 1 } as const;

const area = { type: "area-targeting", shape: "sphere", sizeFeet: 20, origin: "point", effects: [fireDamage] } as const;
const save = { type: "save-with-rider", ability: "dexterity", dc: 15, onFail: [fireDamage], onSuccess: [slowed] } as const;
const ongoing = { type: "ongoing-effect", effect: fireDamage, durationRounds: 10, timing: "start-of-turn", repeatSave: { ability: "constitution", dc: 13 } } as const;
const forced = { type: "forced-movement", mode: "push", distanceFeet: 10 } as const;
const utility = { type: "utility", effectId: "velvet:utility:dash", label: "Dash" } as const;

const v1Effects = [
  { type: "modifier", statistic: "speed", amount: 10, duration: "round" },
  fireDamage,
  { type: "healing", dice: { count: 1, sides: 8, modifier: 2 } },
  { type: "temporary-hit-points", dice: { count: 1, sides: 6, modifier: 0 } },
  { type: "resource", resource: "health", amount: -5 },
  slowed,
] as const;

describe("SRD 5.1 effect vocabulary v2", () => {
  it("pins the additive version and keeps v1 closed while v2 accepts every new kind", () => {
    expect(EFFECT_VOCABULARY_VERSION).toBe("2.0.0");
    for (const effect of v1Effects) {
      expect(starterEffectSchema.safeParse(effect).success).toBe(true);
      expect(starterEffectV2Schema.parse(effect)).toEqual(effect);
    }
    for (const effect of [area, save, ongoing, forced, utility]) {
      expect(starterEffectSchema.safeParse(effect).success).toBe(false);
      expect(starterEffectV2Schema.parse(effect)).toEqual(effect);
    }
    const narrowed: StarterEffectV2 = utility;
    expect(narrowed.type).toBe("utility");
  });

  it("parses nested area, save, and ongoing effects recursively", () => {
    const nested = {
      type: "area-targeting", shape: "cone", sizeFeet: 30, origin: "self",
      effects: [{
        type: "save-with-rider", ability: "wisdom", dc: 14,
        onFail: [{ type: "ongoing-effect", effect: fireDamage, durationRounds: 3, timing: "end-of-turn" }],
        onSuccess: [forced],
      }],
    } as const;
    expect(starterEffectV2Schema.parse(nested)).toEqual(nested);
    expect(starterEffectsV2Schema.parse([area, nested])).toEqual([area, nested]);
    const deep: StarterEffectV2 = {
      type: "ongoing-effect",
      effect: { type: "save-with-rider", ability: "charisma", dc: 12, onFail: [{ type: "area-targeting", shape: "line", sizeFeet: 60, origin: "point", effects: [utility] }] },
      durationRounds: 5,
      timing: "start-of-turn",
    };
    expect(starterEffectV2Schema.safeParse(deep).success).toBe(true);
  });

  it("rejects missing fields, out-of-bounds values, unknown types, and strict extras", () => {
    expect(starterEffectV2Schema.safeParse({ type: "area-targeting", sizeFeet: 20, origin: "point", effects: [fireDamage] }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ type: "save-with-rider", ability: "dexterity", onFail: [fireDamage] }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ type: "ongoing-effect", effect: fireDamage, durationRounds: 3 }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ type: "forced-movement", mode: "push" }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ type: "utility", effectId: "velvet:utility:dash" }).success).toBe(false);

    expect(starterEffectV2Schema.safeParse({ ...area, sizeFeet: 4 }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...area, sizeFeet: 601 }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...forced, distanceFeet: 601 }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...save, dc: 0 }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...save, dc: 41 }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...ongoing, durationRounds: 101 }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...save, ability: "none" }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...area, effects: [] }).success).toBe(false);

    expect(starterEffectV2Schema.safeParse({ type: "telekinesis" }).success).toBe(false);
    expect(starterEffectsV2Schema.safeParse([{ type: "telekinesis" }]).success).toBe(false);

    expect(starterEffectV2Schema.safeParse({ ...forced, script: "run()" }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...utility, expression: "1+1" }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...area, effects: [{ ...fireDamage, formula: "x" }] }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...ongoing, repeatSave: { ability: "wisdom", dc: 12, roll: "d20" } }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...utility, effectId: "bad id" }).success).toBe(false);
    expect(starterEffectV2Schema.safeParse({ ...utility, label: "  " }).success).toBe(false);
    expect(starterEffectsV2Schema.safeParse(Array.from({ length: 17 }, () => fireDamage)).success).toBe(false);
  });
});

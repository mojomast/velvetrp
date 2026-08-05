import { publishContentCatalogInputSchema, type PublishContentCatalogInput } from "@velvet/contracts";
import { calculateCatalogDigest } from "../repo/contentCatalogRepo.js";

type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly unknown[] ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const MECHANICS_STARTER_PACK_ID = "velvet:mechanics-starter" as const;
export const MECHANICS_STARTER_RULES_PROFILE_ID = "velvet:rules:starter-v1" as const;

const ref = (version: string, kind: string, definitionId: string) => ({
  packId: MECHANICS_STARTER_PACK_ID, packVersion: version, kind, definitionId,
});

function literal(version: string, digest: string, progression = false): PublishContentCatalogInput {
  const currency = ref(version, "currency", "velvet:mechanics:currency:glimmer");
  const strike = ref(version, "ability", "velvet:mechanics:ability:steady-strike");
  const mend = ref(version, "ability", "velvet:mechanics:ability:mending-light");
  const skill = ref(version, "skill", "velvet:mechanics:skill:trailcraft");
  const item = ref(version, "item", "velvet:mechanics:item:waylamp");
  const spell = ref(version, "spell", "velvet:mechanics:spell:sheltering-glow");
  const klass = ref(version, "class", "velvet:mechanics:class:lantern-warden");
  const classLevel = ref(version, "class-level", "velvet:mechanics:class-level:lantern-warden-1");
  const classLevel2 = ref(version, "class-level", "velvet:mechanics:class-level:lantern-warden-2");
  const classLevel3 = ref(version, "class-level", "velvet:mechanics:class-level:lantern-warden-3");
  const beacon = ref(version, "ability", "velvet:mechanics:ability:beacon-step");
  const bulwark = ref(version, "ability", "velvet:mechanics:ability:lamp-bulwark");
  const flare = ref(version, "ability", "velvet:mechanics:ability:signal-flare");
  const guiding = ref(version, "spell", "velvet:mechanics:spell:guiding-ember");
  return publishContentCatalogInputSchema.parse({
    idempotencyKey: progression ? "velvet-mechanics-starter-progression-publication" : "velvet-mechanics-starter-publication",
    manifest: {
      packId: MECHANICS_STARTER_PACK_ID,
      packVersion: version,
      name: "Velvet Mechanics Starter",
      description: "An original compact rules set for deterministic Velvet character, resource, check, and encounter integration.",
      tags: ["velvet:original", "velvet:mechanics", "velvet:starter-v1", ...(progression ? ["velvet:progression-v1"] : [])],
      rulesProfile: {
        name: "Velvet Starter Rules",
        description: "The closed, deterministic velvet-starter-v1 mechanics profile.",
        tags: ["velvet:original", "velvet:starter-v1"],
      },
      compatibility: { rulesEngine: "velvet-starter-v1", rulesProfileId: MECHANICS_STARTER_RULES_PROFILE_ID, catalogFormat: "validated-v1" },
      digest,
      provenance: {
        authorship: "original",
        author: "Velvet clean-room project author",
        authoredAt: "2026-08-05T00:00:00.000Z",
        reviewedBy: "Ralph (openai/gpt-5.6-sol)",
        reviewedAt: "2026-08-05T00:00:00.000Z",
        declaration: "Newly authored from Velvet requirements only; no third-party game data, rules text, catalog, path, URL, script, executable rule, or formula was used.",
        thirdPartyData: false,
      },
    },
    definitions: [
      { reference: ref(version, "race", "velvet:mechanics:race:emberkin"), name: "Emberkin", description: "Patient travelers who read warmth and weather through small changes in the air.", tags: ["velvet:original"], mechanics: { speed: 30, attributeBonuses: { resolve: 1, insight: 1 }, abilityRefs: [mend] } },
      { reference: ref(version, "background", "velvet:mechanics:background:bridge-keeper"), name: "Bridge Keeper", description: "A caretaker trained to provision crossings and guide neighbors through difficult country.", tags: ["velvet:original"], mechanics: { skillRefs: [skill], itemRefs: [item], startingCurrency: { currency, amount: 12 } } },
      { reference: klass, name: "Lantern Warden", description: "A steadfast protector who turns measured light into shelter and decisive action.", tags: ["velvet:original"], mechanics: { hitDie: 10, primaryAttribute: "resolve", savingAttributes: ["resolve", "insight"], levelRefs: progression ? [classLevel, classLevel2, classLevel3] : [classLevel] } },
      { reference: classLevel, name: "Lantern Warden Level 1", description: "The first complete Lantern Warden progression step.", tags: ["velvet:original"], mechanics: { classRef: klass, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [strike], spellRefs: [spell] } },
      ...(progression ? [
        { reference: classLevel2, name: "Lantern Warden Level 2", description: "A practiced step that expands endurance and requires one clear lantern discipline.", tags: ["velvet:original"], mechanics: { classRef: klass, level: 2, proficiencyBonus: 2, hpGain: 6, abilityRefs: [mend], spellRefs: [], progressionChoices: [{ choiceId: "velvet:choice:lantern-discipline", kind: "ability", required: true, count: 1, options: [beacon, bulwark] }], resourceGrants: [{ resourceId: "focus", maxIncrease: 1, currentIncrease: 1 }] } },
        { reference: classLevel3, name: "Lantern Warden Level 3", description: "A seasoned step that strengthens technique and opens a guiding ember.", tags: ["velvet:original"], mechanics: { classRef: klass, level: 3, proficiencyBonus: 3, hpGain: 6, abilityRefs: [flare], spellRefs: [guiding], resourceGrants: [{ resourceId: "focus", maxIncrease: 1, currentIncrease: 1 }] } },
      ] : []),
      { reference: skill, name: "Trailcraft", description: "Reading routes, weather, tracks, and safe places to pause.", tags: ["velvet:original"], mechanics: { attribute: "insight" } },
      { reference: strike, name: "Steady Strike", description: "A deliberate close attack that rewards a guarded stance.", tags: ["velvet:original"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "physical", dice: { count: 1, sides: 8, modifier: 2 } }] } },
      { reference: mend, name: "Mending Light", description: "A small restorative glow shared with a nearby companion.", tags: ["velvet:original"], mechanics: { actionCost: "action", recovery: "long-rest", uses: 1, target: "ally", effects: [{ type: "healing", dice: { count: 1, sides: 6, modifier: 1 } }] } },
      ...(progression ? [
        { reference: beacon, name: "Beacon Step", description: "A measured shift that keeps a nearby ally oriented.", tags: ["velvet:original"], mechanics: { actionCost: "bonus-action", recovery: "short-rest", uses: 1, target: "ally", effects: [{ type: "modifier", statistic: "speed", amount: 5, duration: "turn" }] } },
        { reference: bulwark, name: "Lamp Bulwark", description: "A held lamp marks a brief defensive refuge.", tags: ["velvet:original"], mechanics: { actionCost: "reaction", recovery: "short-rest", uses: 1, target: "ally", effects: [{ type: "modifier", statistic: "defense", amount: 1, duration: "round" }] } },
        { reference: flare, name: "Signal Flare", description: "A bright signal steadies companions through confusion.", tags: ["velvet:original"], mechanics: { actionCost: "bonus-action", recovery: "long-rest", uses: 1, target: "area", effects: [{ type: "condition", condition: "focused", durationRounds: 1 }] } },
      ] : []),
      { reference: spell, name: "Sheltering Glow", description: "A focused light that briefly strengthens an ally's defense.", tags: ["velvet:original"], mechanics: { level: 1, actionCost: "action", range: 30, target: "ally", concentration: true, effects: [{ type: "modifier", statistic: "defense", amount: 2, duration: "round" }] } },
      ...(progression ? [{ reference: guiding, name: "Guiding Ember", description: "A drifting ember indicates a safe immediate route.", tags: ["velvet:original"], mechanics: { level: 1, actionCost: "action", range: 60, target: "single", concentration: false, effects: [{ type: "modifier", statistic: "check", amount: 2, duration: "turn" }] } }] : []),
      { reference: item, name: "Waylamp", description: "A durable hand lamp with a shutter for careful signaling.", tags: ["velvet:original"], mechanics: { category: "gear", stackable: false, slot: "hand", price: { currency, amount: 8 }, effects: [{ type: "modifier", statistic: "check", amount: 1, duration: "encounter" }] } },
      { reference: currency, name: "Glimmer", description: "Stamped local trade pieces counted only in whole minor units.", tags: ["velvet:original"], mechanics: { symbol: "gl", minorPerMajor: 100 } },
      { reference: ref(version, "enemy-template", "velvet:mechanics:enemy-template:gloam-mite"), name: "Gloam Mite", description: "A skittering dusk creature that gathers around unattended lamps.", tags: ["velvet:original"], mechanics: { tier: 1, maxHp: 8, defense: 11, speed: 25, abilityRefs: [strike], resistances: [], vulnerabilities: ["radiant"], immunities: [] }, private: { tactics: "Circle the nearest lit target and use Steady Strike until threatened by radiant damage.", gmNotes: "A deterministic low-tier integration opponent.", hiddenAbilityRefs: [] } },
    ],
  });
}

const priorDraft = literal("1.0.0+000000000000", "0".repeat(64));
const priorDigest = calculateCatalogDigest(priorDraft);
export const MECHANICS_STARTER_PRIOR_PACK_VERSION = `1.0.0+${priorDigest.slice(0, 12)}` as const;
export const MECHANICS_STARTER_PRIOR_CATALOG = deepFreeze(literal(MECHANICS_STARTER_PRIOR_PACK_VERSION, priorDigest));
const draft = literal("1.1.0+000000000000", "0".repeat(64), true);
const digest = calculateCatalogDigest(draft);
export const MECHANICS_STARTER_PACK_VERSION = `1.1.0+${digest.slice(0, 12)}` as const;
export const MECHANICS_STARTER_CATALOG = deepFreeze(literal(MECHANICS_STARTER_PACK_VERSION, digest, true));
export const MECHANICS_STARTER_ID = `${MECHANICS_STARTER_PACK_ID}@${MECHANICS_STARTER_PACK_VERSION}` as const;

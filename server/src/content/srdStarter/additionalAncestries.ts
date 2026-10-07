import type { StarterReferences } from "./references.js";
import { buildRaces } from "./races.js";

// Source: https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf
// Page 4 describes the Hill Dwarf and High Elf options, page 5 the Lightfoot
// Halfling option, and page 6 the Rock Gnome option. SRD 5.1 is CC BY 4.0;
// see NOTICE.md.

/** Folds inherited and subrace attribute increases into one static total. */
function mergeAttributeBonuses(
  inherited: Readonly<Record<string, number | undefined>>,
  increase: Readonly<Record<string, number>>,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const [attribute, amount] of Object.entries(inherited)) {
    if (amount !== undefined) merged[attribute] = amount;
  }
  for (const [attribute, amount] of Object.entries(increase)) {
    merged[attribute] = (merged[attribute] ?? 0) + amount;
  }
  return merged;
}

// These bounded composite ancestry choices restate the base races encoded by
// buildRaces and add only the SRD subrace deltas. Traits that depend on
// per-level growth, a player-chosen cantrip, a chosen language, hiding cover
// rules, or device construction stay descriptive metadata: no ability, item,
// spell, or resource is granted.
export function buildAdditionalAncestries(refs: StarterReferences) {
  const { ref } = refs;
  const baseRaces = buildRaces(refs);
  const baseRace = (name: string) => {
    const race = baseRaces.find((entry) => entry.name === name);
    if (!race) throw new Error(`additionalAncestries: missing base race ${name}`);
    return race;
  };
  const composite = (
    baseName: string,
    id: string,
    name: string,
    description: string,
    tags: string[],
    attributeIncrease: Readonly<Record<string, number>>,
    additions: { proficiencies?: string[]; languages?: string[] } = {},
  ) => {
    const inherited = baseRace(baseName);
    return {
      reference: ref("race", `srd-5.1:race:${id}`),
      name,
      description,
      tags: ["srd-5.1", "metadata-only", "subrace", "composite-ancestry", ...tags],
      mechanics: {
        ...inherited.mechanics,
        attributeBonuses: mergeAttributeBonuses(inherited.mechanics.attributeBonuses, attributeIncrease),
        abilityRefs: [...inherited.mechanics.abilityRefs],
        languages: [...inherited.mechanics.languages, ...(additions.languages ?? [])],
        proficiencies: [...inherited.mechanics.proficiencies, ...(additions.proficiencies ?? [])],
      },
    };
  };
  return [
    composite(
      "Dwarf",
      "hill-dwarf",
      "Hill Dwarf",
      "A bounded composite Hill Dwarf ancestry. It inherits the base Dwarf's Constitution +2, speed 25 feet, poison resistance, 60-foot darkvision, Dwarvish weapon proficiencies, and Resilience/Stonecunning traits, then adds Wisdom +1. Dwarven Toughness raises hit point maximum by 1 and by 1 again every time a level is gained; per-level hit point growth is not automated, so no hit point or resource grant is recorded.",
      ["parent-race:srd-5.1:race:dwarf", "trait:dwarven-toughness", "unsupported-runtime"],
      { wisdom: 1 },
    ),
    composite(
      "Elf",
      "high-elf",
      "High Elf",
      "A bounded composite High Elf ancestry. It inherits the base Elf's Dexterity +2, speed 30 feet, 60-foot darkvision, Perception proficiency, and Keen Senses trait, then adds Intelligence +1. Elf Weapon Training grants longsword, shortsword, shortbow, and longbow proficiency. The Wizard-list cantrip choice (Intelligence-based) and the extra language of choice are described as metadata only; no spell, language slot, or resource is granted.",
      ["parent-race:srd-5.1:race:elf", "trait:elf-weapon-training", "trait:cantrip", "trait:extra-language", "choice:wizard-cantrip", "choice:extra-language", "unsupported-runtime"],
      { intelligence: 1 },
      { proficiencies: ["longsword", "shortsword", "shortbow", "longbow"] },
    ),
    composite(
      "Halfling",
      "lightfoot-halfling",
      "Lightfoot Halfling",
      "A bounded composite Lightfoot Halfling ancestry. It inherits the base Halfling's Dexterity +2, speed 25 feet, Lucky, and Brave traits, then adds Charisma +1. Naturally Stealthy allows an attempt to hide while lightly obscured only by a creature at least one size larger; the hiding choice and its cover rules are metadata only and are not automated.",
      ["parent-race:srd-5.1:race:halfling", "trait:naturally-stealthy", "choice:hide-behind-larger-creature", "unsupported-runtime"],
      { charisma: 1 },
    ),
    composite(
      "Gnome",
      "rock-gnome",
      "Rock Gnome",
      "A bounded composite Rock Gnome ancestry. It inherits the base Gnome's Intelligence +2, speed 25 feet, 60-foot darkvision, and Gnome Cunning trait, then adds Constitution +1. Artificer's Lore doubles the proficiency bonus on Intelligence (History) checks about magic items, alchemical objects, and technological devices. Tinker grants artisan's tools (tinker's tools) proficiency and the option to spend 1 hour and 10 gp of materials to construct one Tiny clockwork device (AC 5, 1 hit point), up to three active; construction, materials, duration, and device effects are metadata only, so no item, currency, or resource is granted.",
      ["parent-race:srd-5.1:race:gnome", "trait:artificers-lore", "trait:tinker", "choice:clockwork-device", "unsupported-runtime"],
      { constitution: 1 },
      { proficiencies: ["artisan's tools (tinker's tools)"] },
    ),
  ];
}

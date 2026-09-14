import type { StarterReferences } from "../references.js";

type ActionCost = "action" | "bonus-action" | "reaction";

/**
 * SRD 5.1 potions (including oils and philters, which share the potion item
 * type) and scrolls. Every entry is a consumable: one use, no attunement, no
 * charges, and no passive modifiers. Potions that reproduce a catalog spell
 * grant that spell as a power; scrolls carry no fixed spell and grant nothing.
 */
export function magicPotionsScrolls(refs: StarterReferences): object[] {
  const { ref, currency } = refs;

  const granted = (key: string, slug: string, actionCost: ActionCost = "action") => ({
    key, power: ref("spell", `srd-5.1:spell:${slug}`), requireAttunement: false, actionCost, cost: 0,
  });

  const consumable = (id: string, name: string, description: string, kind: "potion" | "scroll", amount: number, grantedPowers: object[] = []) => ({
    reference: ref("item", `srd-5.1:item:${id}`), name, description, tags: ["srd-5.1", "magic-item", kind],
    mechanics: { category: "consumable", stackable: true, slot: null, price: { currency, amount }, effects: [], magic: { attunement: null, charges: null, passiveModifiers: [], grantedPowers } },
  });

  return [
    consumable("oil-of-etherealness", "Oil of Etherealness", "A clear gelatinous oil that, when applied to a creature, grants it the effects of the etherealness spell for 1 hour.", "potion", 5000, [granted("oil-etherealness-etherealness", "etherealness")]),
    consumable("oil-of-sharpness", "Oil of Sharpness", "A rare oil that hones a weapon or ammunition, granting a +3 bonus to attack and damage rolls for 1 hour.", "potion", 50000),
    consumable("oil-of-slipperiness", "Oil of Slipperiness", "A slippery oil that grants freedom of movement to the coated creature and can be used to escape grapples.", "potion", 500),
    consumable("philter-of-love", "Philter of Love", "A charming philter that makes the drinker charmed by the next creature it sees for 1 hour.", "potion", 500),
    consumable("potion-of-animal-friendship", "Potion of Animal Friendship", "A potion that replicates the animal friendship spell, allowing the drinker to charm beasts.", "potion", 500, [granted("potion-animal-friendship-animal-friendship", "animal-friendship")]),
    consumable("potion-of-clairvoyance", "Potion of Clairvoyance", "A potion that grants its drinker the effects of the clairvoyance spell for 10 minutes.", "potion", 5000, [granted("potion-clairvoyance-clairvoyance", "clairvoyance")]),
    consumable("potion-of-climbing", "Potion of Climbing", "A potion that grants a climbing speed equal to the drinker's walking speed and advantage on Strength checks made to climb for 1 hour.", "potion", 50),
    consumable("potion-of-diminution", "Potion of Diminution", "A potion that shrinks its drinker as the reduce effect of the enlarge/reduce spell for 1d4 hours.", "potion", 5000, [granted("potion-diminution-enlarge-reduce", "enlarge-reduce")]),
    consumable("potion-of-flying", "Potion of Flying", "A potion that grants a flying speed of 60 feet and the ability to hover for 1 hour.", "potion", 50000, [granted("potion-flying-fly", "fly")]),
    consumable("potion-of-gaseous-form", "Potion of Gaseous Form", "A potion that turns its drinker into a misty cloud as the gaseous form spell for 1 hour.", "potion", 5000, [granted("potion-gaseous-form-gaseous-form", "gaseous-form")]),
    consumable("potion-of-hill-giant-strength", "Potion of Hill Giant Strength", "A potion that raises the drinker's Strength score to 21 for 1 hour.", "potion", 500),
    consumable("potion-of-stone-giant-strength", "Potion of Stone Giant Strength", "A potion that raises the drinker's Strength score to 23 for 1 hour.", "potion", 5000),
    consumable("potion-of-frost-giant-strength", "Potion of Frost Giant Strength", "A potion that raises the drinker's Strength score to 23 for 1 hour.", "potion", 5000),
    consumable("potion-of-fire-giant-strength", "Potion of Fire Giant Strength", "A potion that raises the drinker's Strength score to 25 for 1 hour.", "potion", 5000),
    consumable("potion-of-cloud-giant-strength", "Potion of Cloud Giant Strength", "A potion that raises the drinker's Strength score to 27 for 1 hour.", "potion", 50000),
    consumable("potion-of-storm-giant-strength", "Potion of Storm Giant Strength", "A potion that raises the drinker's Strength score to 29 for 1 hour.", "potion", 500000),
    consumable("potion-of-growth", "Potion of Growth", "A potion that enlarges its drinker as the enlarge effect of the enlarge/reduce spell for 1d4 hours.", "potion", 500, [granted("potion-growth-enlarge-reduce", "enlarge-reduce")]),
    consumable("potion-of-healing", "Potion of Healing", "A common potion that restores 2d4 + 2 hit points to the creature that drinks it.", "potion", 50),
    consumable("potion-of-healing-greater", "Potion of Greater Healing", "An uncommon potion that restores 4d4 + 4 hit points to the creature that drinks it.", "potion", 500),
    consumable("potion-of-healing-superior", "Potion of Superior Healing", "A rare potion that restores 8d4 + 8 hit points to the creature that drinks it.", "potion", 5000),
    consumable("potion-of-healing-supreme", "Potion of Supreme Healing", "A very rare potion that restores 10d4 + 20 hit points to the creature that drinks it.", "potion", 50000),
    consumable("potion-of-heroism", "Potion of Heroism", "A potion that grants 10 temporary hit points and the effects of the heroism spell for 1 hour.", "potion", 5000, [granted("potion-heroism-heroism", "heroism")]),
    consumable("potion-of-invisibility", "Potion of Invisibility", "A potion that turns its drinker and carried gear invisible for 1 hour.", "potion", 50000, [granted("potion-invisibility-invisibility", "invisibility")]),
    consumable("potion-of-mind-reading", "Potion of Mind Reading", "A potion that grants its drinker the effects of the detect thoughts spell for 1 hour.", "potion", 5000, [granted("potion-mind-reading-detect-thoughts", "detect-thoughts")]),
    consumable("potion-of-poison", "Potion of Poison", "A potion that looks and tastes like a potion of healing but deals poison damage and poisons the drinker.", "potion", 500),
    consumable("potion-of-acid-resistance", "Potion of Acid Resistance", "A potion that grants resistance to acid damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-cold-resistance", "Potion of Cold Resistance", "A potion that grants resistance to cold damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-fire-resistance", "Potion of Fire Resistance", "A potion that grants resistance to fire damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-force-resistance", "Potion of Force Resistance", "A potion that grants resistance to force damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-lightning-resistance", "Potion of Lightning Resistance", "A potion that grants resistance to lightning damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-necrotic-resistance", "Potion of Necrotic Resistance", "A potion that grants resistance to necrotic damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-poison-resistance", "Potion of Poison Resistance", "A potion that grants resistance to poison damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-psychic-resistance", "Potion of Psychic Resistance", "A potion that grants resistance to psychic damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-radiant-resistance", "Potion of Radiant Resistance", "A potion that grants resistance to radiant damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-thunder-resistance", "Potion of Thunder Resistance", "A potion that grants resistance to thunder damage for 1 hour after it is drunk.", "potion", 500),
    consumable("potion-of-speed", "Potion of Speed", "A potion that grants the effects of the haste spell for 1 minute, without requiring concentration.", "potion", 50000, [granted("potion-speed-haste", "haste")]),
    consumable("potion-of-water-breathing", "Potion of Water Breathing", "A potion that lets its drinker breathe underwater for 1 hour, as the water breathing spell.", "potion", 500, [granted("potion-water-breathing-water-breathing", "water-breathing")]),
    consumable("spell-scroll-cantrip", "Spell Scroll (Cantrip)", "A scroll bearing a single cantrip that can be cast without providing the spell's components.", "scroll", 50),
    consumable("spell-scroll-1st", "Spell Scroll (1st Level)", "A scroll bearing a single 1st-level spell that can be cast without providing the spell's components.", "scroll", 50),
    consumable("spell-scroll-2nd", "Spell Scroll (2nd Level)", "A scroll bearing a single 2nd-level spell that can be cast without providing the spell's components.", "scroll", 500),
    consumable("spell-scroll-3rd", "Spell Scroll (3rd Level)", "A scroll bearing a single 3rd-level spell that can be cast without providing the spell's components.", "scroll", 500),
    consumable("spell-scroll-4th", "Spell Scroll (4th Level)", "A scroll bearing a single 4th-level spell that can be cast without providing the spell's components.", "scroll", 5000),
    consumable("spell-scroll-5th", "Spell Scroll (5th Level)", "A scroll bearing a single 5th-level spell that can be cast without providing the spell's components.", "scroll", 5000),
    consumable("spell-scroll-6th", "Spell Scroll (6th Level)", "A scroll bearing a single 6th-level spell that can be cast without providing the spell's components.", "scroll", 50000),
    consumable("spell-scroll-7th", "Spell Scroll (7th Level)", "A scroll bearing a single 7th-level spell that can be cast without providing the spell's components.", "scroll", 50000),
    consumable("spell-scroll-8th", "Spell Scroll (8th Level)", "A scroll bearing a single 8th-level spell that can be cast without providing the spell's components.", "scroll", 50000),
    consumable("spell-scroll-9th", "Spell Scroll (9th Level)", "A scroll bearing a single 9th-level spell that can be cast without providing the spell's components.", "scroll", 500000),
  ];
}

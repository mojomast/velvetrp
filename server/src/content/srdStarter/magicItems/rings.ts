import type { MagicItemProperties } from "@velvet/contracts";
import type { StarterReferences } from "../references.js";

type ActionCost = "action" | "bonus-action" | "reaction";
type RingDamageType = "acid" | "cold" | "fire" | "force" | "lightning" | "necrotic" | "poison" | "psychic" | "radiant" | "thunder";

/**
 * SRD 5.1 rings.
 *
 * SRD 5.1 presents "Ring of Resistance" and "Ring of Elemental Command" as
 * single items whose concrete form is chosen by the GM. The pinned catalog
 * cannot express an open choice, so each concrete form acknowledged by the SRD
 * is enumerated as its own definition. Situational or conditional effects that
 * the pinned `magicItemPropertiesSchema` cannot express are left empty rather
 * than invented. SRD 5.1 does not assign a gold value to magic items; the
 * amounts below are the suggested market values for each rarity band.
 */
export function magicRings(refs: StarterReferences): object[] {
  const { ref, currency } = refs;

  const attuned = { prerequisite: "short-rest" as const };
  const dawn = (maximum: number): MagicItemProperties["charges"] => ({ maximum, recharge: { kind: "event", event: "dawn", amount: 1 } });
  const spent = (maximum: number): MagicItemProperties["charges"] => ({ maximum, recharge: { kind: "none" } });

  const flatAc = (amount: number): MagicItemProperties["passiveModifiers"][number] => ({ modifier: { kind: "flat", amount, target: { kind: "armor-class" } }, requireAttunement: true });
  const flatSave = (ability: "strength" | "dexterity" | "constitution" | "intelligence" | "wisdom" | "charisma"): MagicItemProperties["passiveModifiers"][number] => ({ modifier: { kind: "flat", amount: 1, target: { kind: "saving-throw", ability } }, requireAttunement: true });
  const resistance = (damageType: RingDamageType): MagicItemProperties["passiveModifiers"][number] => ({ modifier: { kind: "resistance", damageType }, requireAttunement: true });

  const granted = (key: string, slug: string, cost: number, actionCost: ActionCost = "action", requireAttunement = true): MagicItemProperties["grantedPowers"][number] => ({
    key, power: { ...ref("spell", `srd-5.1:spell:${slug}`), kind: "spell" as const }, requireAttunement, actionCost, cost,
  });

  const ring = (slug: string, name: string, description: string, amount: number, magic: MagicItemProperties) => ({
    reference: ref("item", `srd-5.1:item:${slug}`), name, description, tags: ["srd-5.1", "magic-item", "ring"],
    mechanics: { category: "gear", stackable: false, slot: "accessory", price: { currency, amount }, effects: [], magic },
  });

  return [
    ring("ring-of-animal-influence", "Ring of Animal Influence", "A rare ring with 3 charges that regains 1d3 expended charges daily at dawn; while wearing it you can expend a charge to cast animal friendship, fear, or speak with animals (save DC 13).", 5000, { attunement: null, charges: dawn(3), passiveModifiers: [], grantedPowers: [granted("ring-animal-influence-animal-friendship", "animal-friendship", 1, "action", false), granted("ring-animal-influence-fear", "fear", 1, "action", false), granted("ring-animal-influence-speak-with-animals", "speak-with-animals", 1, "action", false)] }),
    ring("ring-of-djinni-summoning", "Ring of Djinni Summoning", "A legendary ring that can summon a particular djinni to serve its wearer for up to 1 hour, after which it cannot be summoned again for 24 hours.", 500000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-air-elemental-command", "Ring of Air Elemental Command", "A legendary ring tied to the Plane of Air; it holds 5 charges (regaining 1d4 + 1 daily at dawn) and can dominate air elementals, unleash air magic, and grant a flying speed to a wearer who has slain an air elemental.", 500000, { attunement: attuned, charges: dawn(5), passiveModifiers: [], grantedPowers: [granted("ring-air-elemental-command-dominate-monster", "dominate-monster", 2), granted("ring-air-elemental-command-chain-lightning", "chain-lightning", 3), granted("ring-air-elemental-command-gust-of-wind", "gust-of-wind", 2), granted("ring-air-elemental-command-wind-wall", "wind-wall", 1)] }),
    ring("ring-of-earth-elemental-command", "Ring of Earth Elemental Command", "A legendary ring tied to the Plane of Earth; it holds 5 charges (regaining 1d4 + 1 daily at dawn) and can dominate earth elementals, shape stone, and harden flesh like stone.", 500000, { attunement: attuned, charges: dawn(5), passiveModifiers: [], grantedPowers: [granted("ring-earth-elemental-command-dominate-monster", "dominate-monster", 2), granted("ring-earth-elemental-command-stone-shape", "stone-shape", 2), granted("ring-earth-elemental-command-stoneskin", "stoneskin", 3)] }),
    ring("ring-of-fire-elemental-command", "Ring of Fire Elemental Command", "A legendary ring tied to the Plane of Fire; its wearer has resistance to fire damage, and it holds 5 charges (regaining 1d4 + 1 daily at dawn) to dominate fire elementals and cast fire magic.", 500000, { attunement: attuned, charges: dawn(5), passiveModifiers: [resistance("fire")], grantedPowers: [granted("ring-fire-elemental-command-dominate-monster", "dominate-monster", 2), granted("ring-fire-elemental-command-burning-hands", "burning-hands", 1), granted("ring-fire-elemental-command-fireball", "fireball", 2), granted("ring-fire-elemental-command-wall-of-fire", "wall-of-fire", 3)] }),
    ring("ring-of-water-elemental-command", "Ring of Water Elemental Command", "A legendary ring tied to the Plane of Water; it holds 5 charges (regaining 1d4 + 1 daily at dawn) to dominate water elementals, control water, and unleash icy magic.", 500000, { attunement: attuned, charges: dawn(5), passiveModifiers: [], grantedPowers: [granted("ring-water-elemental-command-dominate-monster", "dominate-monster", 2), granted("ring-water-elemental-command-create-or-destroy-water", "create-or-destroy-water", 1), granted("ring-water-elemental-command-control-water", "control-water", 3), granted("ring-water-elemental-command-ice-storm", "ice-storm", 2), granted("ring-water-elemental-command-wall-of-ice", "wall-of-ice", 3)] }),
    ring("ring-of-evasion", "Ring of Evasion", "A rare ring with 3 charges that regains 1d3 expended charges daily at dawn; when you fail a Dexterity saving throw while wearing it, you can use your reaction and expend a charge to succeed instead.", 5000, { attunement: attuned, charges: dawn(3), passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-feather-falling", "Ring of Feather Falling", "A rare ring that causes its wearer to descend 60 feet per round and take no damage from falling.", 5000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-free-action", "Ring of Free Action", "A rare ring that lets difficult terrain cost no extra movement and prevents magic from reducing the wearer's speed or paralyzing or restraining them.", 5000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-invisibility", "Ring of Invisibility", "A legendary ring that turns its wearer, along with worn and carried gear, invisible as an action until the ring is removed, the wearer attacks or casts a spell, or a bonus action makes them visible again.", 500000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-jumping", "Ring of Jumping", "An uncommon ring that lets its wearer cast the jump spell as a bonus action at will, targeting only themselves.", 500, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [granted("ring-jumping-jump", "jump", 0, "bonus-action")] }),
    ring("ring-of-mind-shielding", "Ring of Mind Shielding", "An uncommon ring that shields its wearer from magic that reads thoughts, detects lies or alignment, or determines creature type, and lets the wearer control telepathic contact.", 500, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-protection", "Ring of Protection", "A rare ring that grants a +1 bonus to armor class and saving throws while worn.", 5000, { attunement: attuned, charges: null, passiveModifiers: [flatAc(1), flatSave("strength"), flatSave("dexterity"), flatSave("constitution"), flatSave("intelligence"), flatSave("wisdom"), flatSave("charisma")], grantedPowers: [] }),
    ring("ring-of-regeneration", "Ring of Regeneration", "A very rare ring that restores 1d6 hit points to its wearer every 10 minutes and regrows lost body parts over 1d6 + 1 days.", 50000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-shooting-stars", "Ring of Shooting Stars", "A very rare ring that casts dancing lights and light at will in dim light or darkness, and holds 6 charges (regaining 1d6 daily at dawn) for faerie fire, ball lightning, and shooting stars.", 50000, { attunement: attuned, charges: dawn(6), passiveModifiers: [], grantedPowers: [granted("ring-shooting-stars-dancing-lights", "dancing-lights", 0), granted("ring-shooting-stars-light", "light", 0), granted("ring-shooting-stars-faerie-fire", "faerie-fire", 1)] }),
    ring("ring-of-spell-storing", "Ring of Spell Storing", "A rare ring that stores up to 5 levels worth of spells cast into it and lets its attuned wearer cast any spell stored within.", 5000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-spell-turning", "Ring of Spell Turning", "A legendary ring that grants advantage on saving throws against spells targeting only its wearer and can turn a 20 into a reflection of a spell of 7th level or lower.", 500000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-swimming", "Ring of Swimming", "An uncommon ring that grants its wearer a swimming speed of 40 feet.", 500, { attunement: null, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-telekinesis", "Ring of Telekinesis", "A very rare ring that lets its wearer cast the telekinesis spell at will, targeting only objects that are not being worn or carried.", 50000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-the-ram", "Ring of the Ram", "A rare ring with 3 charges that regains 1d3 expended charges daily at dawn; it makes a +7 spectral ram attack or a +5-per-charge Strength check against an object.", 5000, { attunement: attuned, charges: dawn(3), passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-three-wishes", "Ring of Three Wishes", "A legendary ring with 3 charges; its wearer can expend a charge to cast the wish spell, and the ring becomes nonmagical when the last charge is used.", 500000, { attunement: null, charges: spent(3), passiveModifiers: [], grantedPowers: [granted("ring-three-wishes-wish", "wish", 1, "action", false)] }),
    ring("ring-of-warmth", "Ring of Warmth", "An uncommon ring that grants its wearer resistance to cold damage and protects them and their gear from temperatures as low as -50 degrees Fahrenheit.", 500, { attunement: attuned, charges: null, passiveModifiers: [resistance("cold")], grantedPowers: [] }),
    ring("ring-of-water-walking", "Ring of Water Walking", "An uncommon ring that lets its wearer stand on and move across any liquid surface as if it were solid ground.", 500, { attunement: null, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-x-ray-vision", "Ring of X-ray Vision", "A rare ring that lets its wearer see through solid matter within 30 feet for 1 minute, at the risk of exhaustion on repeated use before a long rest.", 5000, { attunement: attuned, charges: null, passiveModifiers: [], grantedPowers: [] }),
    ring("ring-of-acid-resistance", "Ring of Acid Resistance", "A rare ring that grants its wearer resistance to acid damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("acid")], grantedPowers: [] }),
    ring("ring-of-cold-resistance", "Ring of Cold Resistance", "A rare ring that grants its wearer resistance to cold damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("cold")], grantedPowers: [] }),
    ring("ring-of-fire-resistance", "Ring of Fire Resistance", "A rare ring that grants its wearer resistance to fire damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("fire")], grantedPowers: [] }),
    ring("ring-of-force-resistance", "Ring of Force Resistance", "A rare ring that grants its wearer resistance to force damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("force")], grantedPowers: [] }),
    ring("ring-of-lightning-resistance", "Ring of Lightning Resistance", "A rare ring that grants its wearer resistance to lightning damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("lightning")], grantedPowers: [] }),
    ring("ring-of-necrotic-resistance", "Ring of Necrotic Resistance", "A rare ring that grants its wearer resistance to necrotic damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("necrotic")], grantedPowers: [] }),
    ring("ring-of-poison-resistance", "Ring of Poison Resistance", "A rare ring that grants its wearer resistance to poison damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("poison")], grantedPowers: [] }),
    ring("ring-of-psychic-resistance", "Ring of Psychic Resistance", "A rare ring that grants its wearer resistance to psychic damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("psychic")], grantedPowers: [] }),
    ring("ring-of-radiant-resistance", "Ring of Radiant Resistance", "A rare ring that grants its wearer resistance to radiant damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("radiant")], grantedPowers: [] }),
    ring("ring-of-thunder-resistance", "Ring of Thunder Resistance", "A rare ring that grants its wearer resistance to thunder damage.", 5000, { attunement: attuned, charges: null, passiveModifiers: [resistance("thunder")], grantedPowers: [] }),
  ];
}

import type { StarterReferences } from "./references.js";

// Source: https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf
// Page 69 lists focus and holy-symbol prices/weights; page 70 lists pack prices.
// Focus descriptions adapt pages 66-67. SRD 5.1 is CC BY 4.0; see NOTICE.md.
export function buildAdditionalGear(refs: StarterReferences) {
  const { ref, currency } = refs;
  // The SRD does not list aggregate pack weights. Keep contents bounded rather than unpacking them.
  const pack = (id: string, name: string, price: number) => ({
    reference: ref("item", `srd-5.1:item:${id}`), name, description: "A single bounded starter-gear entry; individual contents are not modeled.", tags: ["srd-5.1", "equipment", "gear", "bounded-aggregate"],
    mechanics: { category: "gear", stackable: false, slot: null, price: { currency, amount: price }, effects: [] },
  });
  const focus = (id: string, name: string, description: string, price: number, weightPounds: number) => ({
    reference: ref("item", `srd-5.1:item:${id}`), name, description: `${description} Spellcasting focus use is descriptive only; component substitution is not automated.`, tags: ["srd-5.1", "equipment", "gear", "focus"],
    mechanics: { category: "gear", stackable: false, slot: null, price: { currency, amount: price }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds, equipmentProfile: null } },
  });
  return [
    pack("burglars-pack", "Burglar's Pack", 16),
    pack("diplomats-pack", "Diplomat's Pack", 39),
    pack("dungeoneers-pack", "Dungeoneer's Pack", 12),
    pack("entertainers-pack", "Entertainer's Pack", 40),
    pack("priests-pack", "Priest's Pack", 19),
    pack("scholars-pack", "Scholar's Pack", 40),
    focus("arcane-focus-crystal", "Arcane Focus, Crystal", "A crystal designed to channel arcane spells.", 10, 1),
    focus("arcane-focus-orb", "Arcane Focus, Orb", "An orb designed to channel arcane spells.", 20, 3),
    focus("arcane-focus-rod", "Arcane Focus, Rod", "A rod designed to channel arcane spells.", 10, 2),
    focus("arcane-focus-staff", "Arcane Focus, Staff", "A specially constructed staff designed to channel arcane spells.", 5, 4),
    focus("arcane-focus-wand", "Arcane Focus, Wand", "A wand-like length of wood designed to channel arcane spells.", 10, 1),
    // A dash in the SRD weight column is represented as 0 pounds, consistent with items.ts.
    focus("druidic-focus-sprig-of-mistletoe", "Druidic Focus, Sprig of Mistletoe", "A sprig of mistletoe used as a druidic focus.", 1, 0),
    focus("druidic-focus-totem", "Druidic Focus, Totem", "A totem incorporating feathers, fur, bones, and teeth from sacred animals.", 1, 0),
    focus("druidic-focus-wooden-staff", "Druidic Focus, Wooden Staff", "A staff drawn whole out of a living tree and used as a druidic focus.", 5, 4),
    focus("druidic-focus-yew-wand", "Druidic Focus, Yew Wand", "A wand made of yew and used as a druidic focus.", 10, 1),
    focus("holy-symbol-emblem", "Holy Symbol, Emblem", "An emblem depicting a deity's sacred symbol, engraved or inlaid on a shield.", 5, 0),
    focus("holy-symbol-reliquary", "Holy Symbol, Reliquary", "A tiny box holding a fragment of a sacred relic.", 5, 2),
    focus("holy-symbol-amulet", "Holy Symbol, Amulet", "An amulet depicting a deity's sacred symbol.", 5, 1),
  ];
}

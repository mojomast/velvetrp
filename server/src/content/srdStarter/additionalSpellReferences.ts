import type { StarterReferences } from "./references.js";

// Source: https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf
// SRD 5.1 CC BY 4.0 (legal information, page 1); see NOTICE.md.
// Printed page numbers and one-based PDF page numbers coincide in this edition.
// Spell lists: Forbiddance is a Cleric spell (page 107); Wall of Thorns is a Druid spell (page 108).
export function buildAdditionalSpellReferences(refs: StarterReferences) {
  return [
    {
      // Forbiddance: page 146. The one-day duration (or until dispelled after
      // 30 daily castings) has no contract duration value; do not approximate it.
      reference: refs.ref("spell", "srd-5.1:spell:forbiddance"),
      name: "Forbiddance",
      description: "A ritual ward blocks teleportation, portals, and planar travel into an area and damages selected creature types. Casting takes 10 minutes, its range is touch, and its duration is 1 day without concentration. Casting it daily for 30 days in the same location makes it last until dispelled and consumes the material components on the final casting. This is an inert spell reference; warding, damage, passwords, repeated casting, and component consumption are not executable in this bounded pack.",
      tags: ["srd-5.1", "level-6", "metadata-only", "unsupported-runtime", "cleric"],
      mechanics: {
        level: 6,
        school: "abjuration",
        castingTime: "10-minutes",
        // The action category does not resolve the ten-minute casting process.
        actionCost: "action",
        // Numeric range 0 represents touch here, not a self-only ward.
        range: 0,
        target: "area",
        attackType: "none",
        saveType: "none",
        concentration: false,
        ritual: true,
        components: {
          verbal: true,
          somatic: true,
          material: true,
          materialDescription: "a sprinkling of holy water, rare incense, and powdered ruby worth at least 1,000 gp",
        },
        effects: [],
      },
    },
    {
      // Wall of Thorns: page 191. The contract concentration marker is supported;
      // retain the exact ten-minute upper limit descriptively, without runtime effects.
      reference: refs.ref("spell", "srd-5.1:spell:wall-of-thorns"),
      name: "Wall of Thorns",
      description: "You create a wall of thorn-covered brush on a solid surface within 120 feet. The wall blocks line of sight, slows movement through it, and deals damage with Dexterity saving throws when it appears and when creatures first enter it on a turn or end their turns there. Its duration is concentration, up to 10 minutes. This is an inert spell reference; wall geometry, movement, damage, saving throws, and higher-level scaling are not executable in this bounded pack.",
      tags: ["srd-5.1", "level-6", "metadata-only", "unsupported-runtime", "druid"],
      mechanics: {
        level: 6,
        school: "conjuration",
        castingTime: "action",
        actionCost: "action",
        range: 120,
        target: "area",
        duration: "concentration",
        attackType: "none",
        saveType: "dexterity",
        concentration: true,
        ritual: false,
        components: {
          verbal: true,
          somatic: true,
          material: true,
          materialDescription: "a handful of thorns",
        },
        effects: [],
      },
    },
  ];
}

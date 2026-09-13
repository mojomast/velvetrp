import type DatabaseDriver from "better-sqlite3";
import { itemCatalogDefinitionSchema, SRD_5_1_STARTER_IDENTITY, srdWeaponProfileSchema } from "@velvet/contracts";

export class SrdEquipmentUnavailableError extends Error {}

/** Explicit bounded level-one Fighter support, not inferred from generic proficiencies. */
export const SRD_STARTER_FIGHTER_WEAPON_PROFICIENCIES = ["simple", "martial"] as const;

type ResolvedWeapon = {
  entryId: string;
  reference: { kind: "item"; packId: string; packVersion: string; definitionId: string };
  damage: ReturnType<typeof srdWeaponProfileSchema.parse>["damage"];
  attackAbility: "strength" | "dexterity";
  proficient: boolean;
  properties: ReturnType<typeof srdWeaponProfileSchema.parse>["properties"];
  grip: "one-handed" | "two-handed";
};

export function resolveSrdEquipment(db: DatabaseDriver.Database, campaignId: string, actorId: string) {
  const fail = (): never => { throw new SrdEquipmentUnavailableError("SRD equipment profile or exact pin is unavailable"); };
  const actor = db.prepare(`SELECT actor.sheet_id,progression.level,progression.class_pack_id,
    progression.class_pack_version,progression.class_definition_id FROM campaign_actors actor
    JOIN character_progression_v23 progression ON progression.campaign_id=actor.campaign_id AND progression.actor_id=actor.id
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId, actorId) as {
      sheet_id: string; level: number; class_pack_id: string; class_pack_version: string; class_definition_id: string;
    } | undefined;
  if (!actor) return fail();
  const dex = db.prepare(`SELECT value FROM rpg_character_attributes
    WHERE campaign_id=? AND sheet_id=? AND attribute_id='dexterity'`).get(campaignId, actor.sheet_id) as { value: number } | undefined;
  if (!dex || !Number.isInteger(dex.value) || dex.value < 1 || dex.value > 30) return fail();
  const dexterityModifier = Math.floor((dex.value - 10) / 2);
  const strength = db.prepare(`SELECT value FROM rpg_character_attributes
    WHERE campaign_id=? AND sheet_id=? AND attribute_id='strength'`).get(campaignId, actor.sheet_id) as { value: number } | undefined;
  if (!strength || !Number.isInteger(strength.value) || strength.value < 1 || strength.value > 30) return fail();
  let armorClass = 10 + dexterityModifier, shieldBonus = 0;
  let stealthDisadvantage = false;
  let carriedWeight = 0;
  let weapon: ResolvedWeapon | null = null;
  const rows = db.prepare(`SELECT entry.*,definition.definition_json FROM rpg_inventory_entries_v25 entry
    LEFT JOIN campaign_catalog_current_pins pin ON pin.campaign_id=entry.campaign_id
      AND pin.pack_id=entry.item_pack_id AND pin.pack_version=entry.item_pack_version
    LEFT JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
      AND definition.kind=entry.item_kind AND definition.definition_id=entry.item_definition_id
    WHERE entry.campaign_id=? AND entry.actor_id=? AND entry.equipped=1 ORDER BY entry.entry_id`).all(campaignId, actorId) as Array<{
      entry_id: string; item_pack_id: string; item_pack_version: string; item_definition_id: string;
       slot_key: string; hand_key?: "main" | "off" | null; grip_key?: "one-handed" | "two-handed" | null;
       definition_json: string | null; quantity: number;
    }>;
  const slots = new Set<string>();
  const hands = new Set<string>();
  let legacyHand = false;
  for (const row of rows) {
    let definition;
    try { definition = itemCatalogDefinitionSchema.parse(JSON.parse(row.definition_json ?? "null")); } catch { return fail(); }
    const ref = definition.reference;
    if (ref.packId !== row.item_pack_id || ref.packVersion !== row.item_pack_version || ref.definitionId !== row.item_definition_id
      || row.quantity !== 1 || (row.slot_key !== "hand" && slots.has(row.slot_key)) || definition.mechanics.slot !== row.slot_key) return fail();
    if (row.slot_key === "hand") {
      if (row.hand_key === null || row.hand_key === undefined) {
        if (legacyHand || hands.size > 0) return fail();
        legacyHand = true;
      } else {
        if (legacyHand || hands.has(row.hand_key)) return fail();
        hands.add(row.hand_key);
      }
    }
    slots.add(row.slot_key);
    const details = definition.mechanics.engineDetails;
    if (details?.rulesEngine !== "dnd-5e" || !details.equipmentProfile) return fail();
    const profile = details.equipmentProfile;
    if (profile.kind === "weapon") {
      if (row.slot_key !== "hand") return fail();
      const twoHanded = profile.properties.some(property => property.property === "two-handed");
      const grip = row.grip_key ?? (twoHanded ? null : "one-handed");
      if (grip === null) return fail();
      if (twoHanded && (grip !== "two-handed" || row.hand_key !== "main")) return fail();
      if (twoHanded && rows.some(other => other !== row && other.slot_key === "hand")) return fail();
      if (!twoHanded && grip === "two-handed" && !profile.properties.some(property => property.property === "versatile")) return fail();
      if (grip === "two-handed" && row.hand_key !== "main") return fail();
      if (grip === "two-handed" && hands.has("off") && !legacyHand) return fail();
      const fighterPinned = Boolean(db.prepare(`SELECT 1 FROM campaign_catalog_current_pins
        WHERE campaign_id=? AND pack_id=? AND pack_version=?`).get(campaignId, actor.class_pack_id, actor.class_pack_version));
      let proficientBySheet = false;
      try {
        proficientBySheet = Boolean(db.prepare(`SELECT 1 FROM rpg_character_proficiencies
          WHERE campaign_id=? AND sheet_id=? AND category='weapon' AND proficiency_id=?`)
          .get(campaignId, actor.sheet_id, profile.proficiency));
      } catch {
        // Minimal resolver fixtures predate the proficiency table.
      }
      const versatile = profile.properties.find(property => property.property === "versatile");
      weapon = { entryId: row.entry_id, reference: ref, damage: { type: profile.damage.type, die: grip === "two-handed" && versatile?.property === "versatile" ? versatile.damageDie : profile.damage.die }, properties: profile.properties, grip,
        attackAbility: profile.attackType === "ranged" || profile.properties.some(property => property.property === "finesse") ? "dexterity" : "strength",
        proficient: proficientBySheet || (fighterPinned && actor.level === 1 && actor.class_pack_id === SRD_5_1_STARTER_IDENTITY.packId
          && actor.class_pack_version === SRD_5_1_STARTER_IDENTITY.packVersion
          && actor.class_definition_id === "srd-5.1:class:fighter"
          && SRD_STARTER_FIGHTER_WEAPON_PROFICIENCIES.some(value => value === profile.proficiency)) };
    } else if (profile.kind === "armor") {
      if (profile.category === "shield") {
        if (row.slot_key !== "hand") return fail();
        if (row.grip_key || (row.hand_key === "main" && hands.size > 1)) return fail();
        if (rows.some(other => other !== row && other.grip_key === "two-handed")) return fail();
        shieldBonus = profile.shieldBonus;
      } else {
        if (row.slot_key !== "body" || profile.baseArmorClass === null) return fail();
        if (profile.strengthRequirement !== null && strength.value < profile.strengthRequirement) return fail();
        stealthDisadvantage ||= profile.stealthDisadvantage;
        armorClass = profile.baseArmorClass + (profile.dexterity.policy === "none" ? 0
          : profile.dexterity.policy === "capped" ? Math.min(dexterityModifier, profile.dexterity.maxBonus) : dexterityModifier);
      }
    } else return fail();
  }
  const carriedRows = db.prepare(`SELECT entry.item_pack_id,entry.item_pack_version,entry.item_definition_id,
      entry.quantity,definition.definition_json
    FROM rpg_inventory_entries_v25 entry
    JOIN campaign_catalog_current_pins pin ON pin.campaign_id=entry.campaign_id
      AND pin.pack_id=entry.item_pack_id AND pin.pack_version=entry.item_pack_version
    JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
      AND definition.kind='item' AND definition.definition_id=entry.item_definition_id
    WHERE entry.campaign_id=? AND entry.actor_id=?`).all(campaignId, actorId) as Array<{
      item_pack_id: string; item_pack_version: string; item_definition_id: string; quantity: number; definition_json: string;
    }>;
  for (const row of carriedRows) {
    let definition;
    try { definition = itemCatalogDefinitionSchema.parse(JSON.parse(row.definition_json)); } catch { return fail(); }
    if (definition.reference.packId !== row.item_pack_id || definition.reference.packVersion !== row.item_pack_version
      || definition.reference.definitionId !== row.item_definition_id) return fail();
    const weight = definition.mechanics.engineDetails?.weightPounds;
    if (weight !== undefined) carriedWeight += weight * row.quantity;
  }
  const revision = (db.prepare(`SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?`)
    .get(campaignId, actorId) as { revision: number } | undefined)?.revision ?? 0;
  const result = { armorClass: armorClass + shieldBonus, weapon, revision };
  // Keep the established resolver shape stable while exposing derived state to
  // newer callers without making it writable client state.
  Object.defineProperties(result, {
    stealthDisadvantage: { value: stealthDisadvantage, enumerable: false },
    carryingLimit: { value: strength.value * 15, enumerable: false },
    carriedWeight: { value: carriedWeight, enumerable: false },
    encumbered: { value: carriedWeight > strength.value * 5, enumerable: false },
    heavilyEncumbered: { value: carriedWeight > strength.value * 10, enumerable: false },
    strengthScore: { value: strength.value, enumerable: false },
  });
  return result;
}

/** Reads the derived carrying state without widening the stable resolver shape. */
export function srdEncumbrance(equipment: ReturnType<typeof resolveSrdEquipment>): {
  carriedWeight: number; carryingLimit: number; strengthScore: number; heavilyEncumbered: boolean;
} {
  const carried = equipment as unknown as {
    carriedWeight: number; carryingLimit: number; strengthScore: number; heavilyEncumbered: boolean;
  };
  return { carriedWeight: carried.carriedWeight, carryingLimit: carried.carryingLimit,
    strengthScore: carried.strengthScore, heavilyEncumbered: carried.heavilyEncumbered };
}

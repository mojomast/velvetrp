import type DatabaseDriver from "better-sqlite3";
import { itemCatalogDefinitionSchema, SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG } from "../content/srdStarterCatalog.js";
import { canonicalCatalogJson } from "./contentCatalog/index.js";

export class SrdEquipmentUnavailableError extends Error {}

/** Explicit bounded level-one Fighter support, not inferred from generic proficiencies. */
export const SRD_STARTER_FIGHTER_WEAPON_PROFICIENCIES = ["simple", "martial"] as const;

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
  let armorClass = 10 + dexterityModifier, shieldBonus = 0;
  let weapon: { entryId: string; reference: { kind: "item"; packId: string; packVersion: string; definitionId: string };
    damage: { type: "slashing"; die: { count: number; sides: number } }; proficient: boolean } | null = null;
  const rows = db.prepare(`SELECT entry.*,definition.definition_json FROM rpg_inventory_entries_v25 entry
    LEFT JOIN campaign_catalog_current_pins pin ON pin.campaign_id=entry.campaign_id
      AND pin.pack_id=entry.item_pack_id AND pin.pack_version=entry.item_pack_version
    LEFT JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
      AND definition.kind=entry.item_kind AND definition.definition_id=entry.item_definition_id
    WHERE entry.campaign_id=? AND entry.actor_id=? AND entry.equipped=1 ORDER BY entry.entry_id`).all(campaignId, actorId) as Array<{
      entry_id: string; item_pack_id: string; item_pack_version: string; item_definition_id: string;
      slot_key: string; definition_json: string | null; quantity: number;
    }>;
  const slots = new Set<string>();
  for (const row of rows) {
    let definition;
    try { definition = itemCatalogDefinitionSchema.parse(JSON.parse(row.definition_json ?? "null")); } catch { return fail(); }
    const ref = definition.reference;
    const published = SRD_5_1_STARTER_CATALOG.definitions.find(entry => entry.reference.kind === "item"
      && entry.reference.definitionId === row.item_definition_id);
    if (ref.packId !== row.item_pack_id || ref.packVersion !== row.item_pack_version || ref.definitionId !== row.item_definition_id
      || ref.packId !== SRD_5_1_STARTER_IDENTITY.packId || ref.packVersion !== SRD_5_1_STARTER_IDENTITY.packVersion
      || !published || canonicalCatalogJson(definition) !== canonicalCatalogJson(itemCatalogDefinitionSchema.parse(published))
      || row.quantity !== 1 || slots.has(row.slot_key) || definition.mechanics.slot !== row.slot_key) return fail();
    slots.add(row.slot_key);
    const details = definition.mechanics.engineDetails;
    if (details?.rulesEngine !== "dnd-5e" || !details.equipmentProfile) return fail();
    const profile = details.equipmentProfile;
    if (profile.kind === "weapon") {
      if (ref.definitionId !== "srd-5.1:item:longsword" || row.slot_key !== "hand" || profile.damage.type !== "slashing") return fail();
      const fighterPinned = Boolean(db.prepare(`SELECT 1 FROM campaign_catalog_current_pins
        WHERE campaign_id=? AND pack_id=? AND pack_version=?`).get(campaignId, actor.class_pack_id, actor.class_pack_version));
      weapon = { entryId: row.entry_id, reference: ref, damage: { type: profile.damage.type, die: profile.damage.die },
        proficient: fighterPinned && actor.level === 1 && actor.class_pack_id === SRD_5_1_STARTER_IDENTITY.packId
          && actor.class_pack_version === SRD_5_1_STARTER_IDENTITY.packVersion
          && actor.class_definition_id === "srd-5.1:class:fighter"
          && SRD_STARTER_FIGHTER_WEAPON_PROFICIENCIES.some(value => value === profile.proficiency) };
    } else if (profile.kind === "armor") {
      if (profile.category === "shield") {
        if (row.slot_key !== "hand") return fail();
        shieldBonus = profile.shieldBonus;
      } else {
        if (row.slot_key !== "body" || profile.baseArmorClass === null) return fail();
        armorClass = profile.baseArmorClass + (profile.dexterity.policy === "none" ? 0
          : profile.dexterity.policy === "capped" ? Math.min(dexterityModifier, profile.dexterity.maxBonus) : dexterityModifier);
      }
    } else return fail();
  }
  const revision = (db.prepare(`SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?`)
    .get(campaignId, actorId) as { revision: number } | undefined)?.revision ?? 0;
  return { armorClass: armorClass + shieldBonus, weapon, revision };
}

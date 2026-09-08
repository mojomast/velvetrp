import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";

/** Grant fixture stock; equip/unequip still run through the production command boundary. */
export function grantSrdEquipment(campaignId: string, actorId: string, item = "longsword", entryId = `${actorId}-${item}`) {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  try {
    db.prepare(`INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id)
      VALUES(?,?,?,'item',?)`).run(campaignId, SRD_5_1_STARTER_IDENTITY.packId,
        SRD_5_1_STARTER_IDENTITY.packVersion, `srd-5.1:item:${item}`);
    db.prepare(`INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,
      item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at)
      VALUES(?,?,?,?,?,'item',?,'instanced',1,?,NULL,0,?)`).run(entryId, campaignId, actorId,
        SRD_5_1_STARTER_IDENTITY.packId, SRD_5_1_STARTER_IDENTITY.packVersion, `srd-5.1:item:${item}`, entryId,
        "2036-01-01T00:00:00.000Z");
  } finally { db.close(); }
  return entryId;
}

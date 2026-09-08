import DatabaseDriver from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";
import { SRD_5_1_STARTER_CATALOG } from "../src/content/srdStarterCatalog.js";
import { resolveSrdEquipment } from "../src/repo/srdEquipmentRuntime.js";

describe("bounded authoritative SRD equipment resolver", () => {
  let db: DatabaseDriver.Database;
  const { packId, packVersion } = SRD_5_1_STARTER_IDENTITY;
  beforeEach(() => {
    db = new DatabaseDriver(":memory:");
    // Minimal mutable storage deliberately permits malformed rows for fail-closed tests.
    db.exec(`CREATE TABLE campaign_actors(id,sheet_id,campaign_id);
      CREATE TABLE character_progression_v23(actor_id,campaign_id,level,class_pack_id,class_pack_version,class_definition_id);
      CREATE TABLE rpg_character_attributes(campaign_id,sheet_id,attribute_id,value);
      CREATE TABLE campaign_catalog_current_pins(campaign_id,pack_id,pack_version);
      CREATE TABLE rpg_catalog_definitions(pack_id,pack_version,kind,definition_id,definition_json);
      CREATE TABLE rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,slot_key,quantity,equipped);
      CREATE TABLE rpg_m15_mutation_revisions_v25(campaign_id,actor_id,revision);
      INSERT INTO campaign_actors VALUES('actor','sheet','campaign');
      INSERT INTO rpg_character_attributes VALUES('campaign','sheet','dexterity',16);
      INSERT INTO rpg_m15_mutation_revisions_v25 VALUES('campaign','actor',7);`);
    db.prepare("INSERT INTO character_progression_v23 VALUES('actor','campaign',1,?,?,'srd-5.1:class:fighter')").run(packId, packVersion);
    db.prepare("INSERT INTO campaign_catalog_current_pins VALUES('campaign',?,?)").run(packId, packVersion);
    for (const definition of SRD_5_1_STARTER_CATALOG.definitions) {
      db.prepare("INSERT INTO rpg_catalog_definitions VALUES(?,?,?,?,?)").run(packId, packVersion,
        definition.reference.kind, definition.reference.definitionId, JSON.stringify(definition));
    }
  });
  afterEach(() => db.close());
  const equip = (item: string, slot = "body") => db.prepare(`INSERT INTO rpg_inventory_entries_v25
    VALUES(?,'campaign','actor',?,?,'item',?,?,1,1)`).run(item, packId, packVersion, `srd-5.1:item:${item}`, slot);
  const resolve = () => resolveSrdEquipment(db, "campaign", "actor");

  it("requires an equipped weapon and uses only the exact one-handed profile", () => {
    expect(resolve()).toEqual({ armorClass: 13, weapon: null, revision: 7 });
    equip("longsword", "hand");
    expect(resolve().weapon).toMatchObject({ entryId: "longsword", proficient: true,
      damage: { type: "slashing", die: { count: 1, sides: 8 } }, reference: { packId, packVersion } });
    db.exec("UPDATE rpg_inventory_entries_v25 SET equipped=0");
    expect(resolve().weapon).toBeNull();
  });

  it.each([
    ["leather-armor", 16, 14], ["leather-armor", 8, 10],
    ["chain-shirt", 16, 15], ["chain-shirt", 8, 12],
    ["chain-mail", 16, 16], ["chain-mail", 8, 16],
    ["shield", 16, 15], ["shield", 8, 11],
  ])("resolves %s with Dexterity %i as AC %i", (item, dexterity, ac) => {
    db.prepare("UPDATE rpg_character_attributes SET value=?").run(dexterity);
    equip(String(item), item === "shield" ? "hand" : "body");
    expect(resolve().armorClass).toBe(ac);
  });

  it("adds shield AC to body armor without inventing another hand", () => {
    equip("chain-mail"); equip("shield", "hand");
    expect(resolve()).toMatchObject({ armorClass: 18, weapon: null });
    equip("longsword", "hand");
    expect(resolve).toThrow(/profile or exact pin/);
  });

  it.each(["class_definition_id", "class_pack_id", "class_pack_version", "level"])("does not infer proficiency from %s", (column) => {
    equip("longsword", "hand");
    db.prepare(`UPDATE character_progression_v23 SET ${column}=?`).run(column === "level" ? 2 : "other");
    expect(resolve().weapon?.proficient).toBe(false);
  });

  it.each([
    "UPDATE campaign_catalog_current_pins SET pack_version='stale'",
    "UPDATE rpg_inventory_entries_v25 SET item_pack_version='stale'",
    "UPDATE rpg_inventory_entries_v25 SET slot_key='body'",
    "UPDATE rpg_inventory_entries_v25 SET quantity=2",
    "UPDATE rpg_catalog_definitions SET definition_json='{}' WHERE kind='item'",
    "UPDATE rpg_catalog_definitions SET definition_json=json_set(definition_json,'$.mechanics.engineDetails.equipmentProfile.damage.die.sides',6) WHERE kind='item'",
    "UPDATE rpg_catalog_definitions SET definition_json=json_remove(definition_json,'$.mechanics.engineDetails') WHERE kind='item'",
    "UPDATE rpg_catalog_definitions SET definition_json=json_set(definition_json,'$.reference.packVersion','stale') WHERE kind='item'",
  ])("fails closed on invalid equipped profile or pin: %s", (sql) => {
    equip("longsword", "hand"); db.exec(sql);
    expect(resolve).toThrow(/profile or exact pin/);
  });
});

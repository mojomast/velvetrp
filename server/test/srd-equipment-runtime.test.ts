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
       CREATE TABLE rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,slot_key,quantity,equipped,hand_key,grip_key);
       CREATE TABLE rpg_m15_mutation_revisions_v25(campaign_id,actor_id,revision);
       INSERT INTO campaign_actors VALUES('actor','sheet','campaign');
       INSERT INTO rpg_character_attributes VALUES('campaign','sheet','strength',16);
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
  const equip = (item: string, slot = "body", hand: string | null = null, grip: string | null = null) => db.prepare(`INSERT INTO rpg_inventory_entries_v25
    VALUES(?,'campaign','actor',?,?,'item',?,?,1,1,?,?)`).run(item, packId, packVersion, `srd-5.1:item:${item}`, slot, hand, grip);
  const addExactProfile = (definitionId: string, profile: any, slot = "hand") => {
    const source: any = SRD_5_1_STARTER_CATALOG.definitions.find(entry => entry.reference.kind === "item" && entry.reference.definitionId === "srd-5.1:item:longsword")!;
    const definition = { ...source, reference: { ...source.reference, packId: "synthetic", packVersion: "1", definitionId },
      mechanics: { ...source.mechanics, category: profile.kind === "armor" ? "armor" : "weapon", slot,
        engineDetails: { ...source.mechanics.engineDetails!, equipmentProfile: profile } } };
    db.prepare("INSERT INTO campaign_catalog_current_pins SELECT 'campaign','synthetic','1' WHERE NOT EXISTS(SELECT 1 FROM campaign_catalog_current_pins WHERE campaign_id='campaign' AND pack_id='synthetic' AND pack_version='1')").run();
    db.prepare("INSERT INTO rpg_catalog_definitions VALUES('synthetic','1','item',?,?)").run(definitionId, JSON.stringify(definition));
     return () => db.prepare(`INSERT INTO rpg_inventory_entries_v25 VALUES(?,'campaign','actor','synthetic','1','item',?,?,1,1,NULL,NULL)`)
       .run(definitionId, definitionId, slot);
  };
  const resolve = () => resolveSrdEquipment(db, "campaign", "actor");

  it("preserves the exact pinned starter longsword outcome", () => {
    expect(resolve()).toEqual({ armorClass: 13, weapon: null, revision: 7 });
    equip("longsword", "hand");
    expect(resolve().weapon).toMatchObject({ entryId: "longsword", proficient: true,
      damage: { type: "slashing", die: { count: 1, sides: 8 } }, reference: { packId, packVersion } });
    db.exec("UPDATE rpg_inventory_entries_v25 SET equipped=0");
    expect(resolve().weapon).toBeNull();
  });

  it("uses exact pinned typed ranged and finesse profiles with their bounded Dexterity attack ability", () => {
    addExactProfile("synthetic:item:shortbow", { kind: "weapon", proficiency: "simple", attackType: "ranged",
      damage: { type: "piercing", die: { count: 1, sides: 6 } }, properties: [] })();
    expect(resolve().weapon).toMatchObject({ reference: { packId: "synthetic", definitionId: "synthetic:item:shortbow" },
      damage: { type: "piercing", die: { count: 1, sides: 6 } }, attackAbility: "dexterity", proficient: true });
    db.exec("UPDATE rpg_inventory_entries_v25 SET equipped=0");
    addExactProfile("synthetic:item:rapier", { kind: "weapon", proficiency: "martial", attackType: "melee",
      damage: { type: "piercing", die: { count: 1, sides: 8 } }, properties: [{ property: "finesse" }] })();
    expect(resolve().weapon).toMatchObject({ attackAbility: "dexterity", proficient: true });
  });

  it("uses exact pinned typed armor profiles", () => {
    addExactProfile("synthetic:item:leather", { kind: "armor", category: "light", baseArmorClass: 11,
      dexterity: { policy: "full" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 }, "body")();
    expect(resolve().armorClass).toBe(14);
  });

  it("derives armor stealth and carrying state from pinned item weight", () => {
    equip("chain-mail");
    const result = resolve() as typeof resolve extends () => infer Value ? Value & {
      carriedWeight: number; carryingLimit: number; encumbered: boolean; stealthDisadvantage: boolean;
    } : never;
    expect(result).toMatchObject({ carriedWeight: 55, carryingLimit: 240, encumbered: false, stealthDisadvantage: true });
  });

  it("fails closed when heavy armor Strength is not met", () => {
    db.prepare("UPDATE rpg_character_attributes SET value=12 WHERE attribute_id='strength'").run();
    equip("chain-mail");
    expect(resolve).toThrow(/profile or exact pin/);
    db.prepare("UPDATE rpg_character_attributes SET value=13 WHERE attribute_id='strength'").run();
    expect(resolve().armorClass).toBe(16);
  });

  it("fails closed when a profile needs an unsupported two-handed grip", () => {
    addExactProfile("synthetic:item:greatsword", { kind: "weapon", proficiency: "martial", attackType: "melee",
      damage: { type: "slashing", die: { count: 2, sides: 6 } }, properties: [{ property: "two-handed" }] })();
    expect(resolve).toThrow(/profile or exact pin/);
  });

  it.each([
    ["leather-armor", 16, 14], ["leather-armor", 8, 10],
    ["chain-shirt", 16, 15], ["chain-shirt", 8, 12],
    ["chain-mail", 16, 16], ["chain-mail", 8, 16],
    ["shield", 16, 15], ["shield", 8, 11],
  ])("resolves %s with Dexterity %i as AC %i", (item, dexterity, ac) => {
    db.prepare("UPDATE rpg_character_attributes SET value=? WHERE attribute_id='dexterity'").run(dexterity);
    equip(String(item), item === "shield" ? "hand" : "body");
    expect(resolve().armorClass).toBe(ac);
  });

  it("adds shield AC to body armor without inventing another hand", () => {
    equip("chain-mail"); equip("shield", "hand");
    expect(resolve()).toMatchObject({ armorClass: 18, weapon: null });
    equip("longsword", "hand");
    expect(resolve).toThrow(/profile or exact pin/);
  });

  it("resolves an explicit main-hand versatile weapon beside an off-hand shield", () => {
    equip("shield", "hand", "off");
    equip("longsword", "hand", "main", "two-handed");
    expect(resolve).toThrow(/profile or exact pin/);
    db.prepare("UPDATE rpg_inventory_entries_v25 SET grip_key='one-handed' WHERE item_definition_id='srd-5.1:item:longsword'").run();
    expect(resolve()).toMatchObject({ armorClass: 15, weapon: { grip: "one-handed", damage: { die: { sides: 8 } } } });
    db.prepare("UPDATE rpg_inventory_entries_v25 SET grip_key='two-handed', hand_key='main' WHERE item_definition_id='srd-5.1:item:longsword'").run();
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
    "UPDATE rpg_catalog_definitions SET definition_json=json_remove(definition_json,'$.mechanics.engineDetails') WHERE kind='item'",
    "UPDATE rpg_catalog_definitions SET definition_json=json_set(definition_json,'$.reference.packVersion','stale') WHERE kind='item'",
  ])("fails closed on invalid equipped profile or pin: %s", (sql) => {
    equip("longsword", "hand"); db.exec(sql);
    expect(resolve).toThrow(/profile or exact pin/);
  });
});

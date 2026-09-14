import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { createAttunementRepository, type AttunementRepository } from "../src/repo/attunementRepo.js";
import type { MagicItemDefinition } from "../src/repo/encounter/magicItem/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const AT = "2035-01-01T00:00:00.000Z";

function magicItem(definitionId: string): MagicItemDefinition {
  return { reference: { packId: "srd-5.1", packVersion: "1.6.0+test", definitionId }, name: definitionId,
    attunement: { prerequisite: "short-rest" }, charges: null, passiveModifiers: [], grantedPowers: [] };
}

function repository(resolve: (definitionId: string) => MagicItemDefinition | null = (definitionId) => magicItem(definitionId)): { repo: AttunementRepository; close: () => void } {
  const first = createRepository({ clock: { now: () => new Date(AT) } });
  const campaign = first.createCampaign("local-owner", { name: "Attunement" });
  first.close();
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(AT);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('dnd-5e','dnd-5e','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1','dnd-5e','Pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','sage','Sage','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,?)").run(campaign.id, "dnd-5e");
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1','dnd-5e')").run(campaign.id);
  db.prepare("INSERT OR IGNORE INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)").run(campaign.id, "local-owner", "owner", AT);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','sage',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, AT, AT);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES('actor',?,'local-owner',NULL)").run(campaign.id);
  const repo = createAttunementRepository(db, { clock: { now: () => new Date(AT) }, resolveMagicItem: (_campaignId, definitionId) => resolve(definitionId) });
  return { repo, close: () => db.close() };
}

const attune = (repo: AttunementRepository, id: string, key: string) => repo.attuneActorItem("local-owner", "actor", { definitionId: id, key, satisfiedRest: "short-rest" });

describe("actor item attunement repository", () => {
  it("attunes, lists in order, and enforces the SRD maximum of three", () => {
    const { repo, close } = repository();
    expect(attune(repo, "srd-5.1:item:ring-of-protection", "ring-1")).toMatchObject({ ok: true });
    expect(attune(repo, "srd-5.1:item:cloak-of-elvenkind", "cloak-1")).toMatchObject({ ok: true });
    expect(attune(repo, "srd-5.1:item:wand-of-magic-missiles", "wand-1")).toMatchObject({ ok: true });
    const list = repo.listActorAttunements("local-owner", "actor")!;
    expect(list.limit).toBe(3);
    expect(list.attunements.map((entry) => entry.key)).toEqual(["cloak-1", "ring-1", "wand-1"]);
    const fourth = attune(repo, "srd-5.1:item:bracers-of-defense", "bracers-1");
    expect(fourth).toMatchObject({ ok: false, code: "capacity-exceeded" });
    expect(repo.listActorAttunements("local-owner", "actor")!.attunements).toHaveLength(3);
    close();
  });

  it("requires a satisfied prerequisite and drops attunements idempotently", () => {
    const { repo, close } = repository();
    const missing = repo.attuneActorItem("local-owner", "actor", { definitionId: "srd-5.1:item:ring", key: "ring-1", satisfiedRest: null });
    expect(missing).toMatchObject({ ok: false, code: "prerequisite-missing" });
    expect(attune(repo, "srd-5.1:item:ring", "ring-1")).toMatchObject({ ok: true });
    const dropped = repo.dropActorAttunement("local-owner", "actor", "ring-1");
    expect(dropped).toMatchObject({ ok: true, snapshot: { attunements: [] } });
    expect(repo.dropActorAttunement("local-owner", "actor", "ring-1")).toMatchObject({ ok: true, snapshot: { attunements: [] } });
    close();
  });

  it("denies unauthenticated principals and rejects items without an engine definition", () => {
    const { repo, close } = repository((definitionId) => definitionId.includes("missing") ? null : magicItem(definitionId));
    expect(repo.listActorAttunements("attacker", "actor")).toBeNull();
    expect(repo.attuneActorItem("attacker", "actor", { definitionId: "srd-5.1:item:ring", key: "ring-1", satisfiedRest: "short-rest" })).toBeNull();
    expect(attune(repo, "srd-5.1:item:missing", "ring-1")).toMatchObject({ ok: false, code: "definition-unavailable", snapshot: { attunements: [] } });
    close();
  });
});

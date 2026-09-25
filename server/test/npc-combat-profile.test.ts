import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SRD_5_1_STARTER_CATALOG, createRepository } from "../src/repo/index.js";
import {
  EXACT_TOKEN_ONLY_KEYWORDS,
  NPC_TIER_KEYWORDS,
  NPC_TIER_MATCH_ORDER,
  NpcCombatProfileError,
  TIER_TEMPLATES,
  deriveNpcTier,
  resolveNpcCombatProfile,
  type NpcCombatTier,
} from "../src/repo/encounter/npcCombatProfile.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
const AT = "2037-04-01T00:00:00.000Z";

interface CatalogEnemy {
  reference: { kind: string; packId: string; packVersion: string; definitionId: string };
  name: string;
  mechanics: {
    challengeRating: number;
    maxHp: number;
    defense: number;
    combatProfile: { attack: { attackBonus: number } };
  };
}

const catalogEnemies = SRD_5_1_STARTER_CATALOG.definitions as unknown as CatalogEnemy[];
const enemyTemplate = (definitionId: string): CatalogEnemy => {
  const found = catalogEnemies.find(
    (entry) => entry.reference.kind === "enemy-template" && entry.reference.definitionId === definitionId,
  );
  if (!found) throw new Error(`missing catalog enemy template ${definitionId}`);
  return found;
};
const templateFor = (tier: NpcCombatTier) => {
  const entry = TIER_TEMPLATES.find((candidate) => candidate.tier === tier);
  if (!entry) throw new Error(`missing tier template ${tier}`);
  return entry;
};

function expectFailure(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(NpcCombatProfileError);
    expect((error as NpcCombatProfileError).code).toBe(code);
    return;
  }
  throw new Error(`expected NpcCombatProfileError ${code}`);
}

describe("deriveNpcTier", () => {
  it.each([
    ["commoner", "Old Mara, the village ferryman"],
    ["commoner", "A merchant of the northern road"],
    ["commoner", "Farmer Hale"],
    ["commoner", "the town factor"],
    ["guard", "Gate watch"],
    ["guard", "A loyal guard"],
    ["guard", "sentry at the east gate"],
    ["scout", "A hunter of the deep woods"],
    ["scout", "ranger of the border"],
    ["scout", "the party's outrider"],
    ["soldier", "A bandit on the road"],
    ["soldier", "thug for hire"],
    ["soldier", "a mercenary spear"],
    ["soldier", "town soldier"],
    ["adventurer", "Knight of the Realm"],
    ["adventurer", "A grizzled veteran"],
    ["adventurer", "champion of the arena"],
    ["mage", "Court wizard"],
    ["mage", "the sorcerer"],
    ["mage", "a hedge witch"],
    ["priest", "Village priest"],
    ["priest", "an acolyte of the dawn"],
    ["priest", "high cleric"],
    ["leader", "Bandit Captain Vex"],
    ["leader", "King Aldric"],
    ["leader", "the chief of the village"],
    ["leader", "a noble lord"],
  ] as const)("derives %s from %s", (tier, text) => {
    expect(deriveNpcTier(text).tier).toBe(tier);
  });

  it.each([
    ["THE WATCHMEN", "guard"],
    ["Two WIZARDS", "mage"],
    ["Priests of the Sun", "priest"],
    ["Three KNIGHTS", "adventurer"],
    ["SCOUTS", "scout"],
    ["Soldiers of fortune", "soldier"],
    ["MERCHANTS", "commoner"],
    ["Ladies of the court", "leader"],
    ["Guarding the caravan", "guard"],
    ["Hunting in the woods", "scout"],
    ["Blacksmiths", "commoner"],
    ["merchant's daughter", "commoner"],
  ] as const)("is case and plural safe: %s -> %s", (text, tier) => {
    expect(deriveNpcTier(text).tier).toBe(tier);
  });

  it("falls back to commoner when no role keyword matches", () => {
    expect(deriveNpcTier("")).toEqual({
      tier: "commoner",
      matchedKeyword: null,
      rationale: "no role keyword matched; defaulted to commoner",
    });
    expect(deriveNpcTier("Mira of the eastern road")).toMatchObject({ tier: "commoner", matchedKeyword: null });
    expect(deriveNpcTier("regardless of station")).toMatchObject({ tier: "commoner", matchedKeyword: null });
    expect(deriveNpcTier("smooth sailing").matchedKeyword).toBeNull();
  });

  it("prefers elite keywords over rank-and-file keywords", () => {
    expect(deriveNpcTier("captain of the guard").tier).toBe("leader");
    expect(deriveNpcTier("guard captain").tier).toBe("leader");
    expect(deriveNpcTier("veteran guard").tier).toBe("adventurer");
    expect(deriveNpcTier("merchant guard").tier).toBe("guard");
    expect(deriveNpcTier("temple acolyte").tier).toBe("priest");
  });

  it("does not promote an NPC from verb forms of ambiguous title keywords", () => {
    expect(deriveNpcTier("Margery Fenn\nA wool factor who counts on her fingers and watches the road.").tier).toBe("commoner");
    expect(deriveNpcTier("She watches the road.").tier).toBe("commoner");
    expect(deriveNpcTier("He counts the takings.").tier).toBe("commoner");
  });

  it("still matches exact title tokens and guard nouns", () => {
    expect(deriveNpcTier("Count Alaric").tier).toBe("leader");
    expect(deriveNpcTier("The town watch").tier).toBe("guard");
  });

  it("is deterministic", () => {
    expect(deriveNpcTier("The Ferryman's Widow")).toEqual(deriveNpcTier("The Ferryman's Widow"));
  });

  it("exports a keyword table with unique, non-empty entries", () => {
    expect(new Set(NPC_TIER_MATCH_ORDER).size).toBe(NPC_TIER_MATCH_ORDER.length);
    const seen = new Set<string>();
    for (const tier of NPC_TIER_MATCH_ORDER) {
      expect(NPC_TIER_KEYWORDS[tier].length).toBeGreaterThan(0);
      for (const keyword of NPC_TIER_KEYWORDS[tier]) {
        expect(seen.has(keyword), `duplicate keyword ${keyword}`).toBe(false);
        seen.add(keyword);
      }
    }
    expect(NPC_TIER_KEYWORDS.commoner).toContain("ferryman");
    expect(NPC_TIER_KEYWORDS.commoner).toContain("factor");
    expect(NPC_TIER_KEYWORDS.guard).toContain("watch");
    expect(NPC_TIER_KEYWORDS.scout).toContain("hunter");
    expect(NPC_TIER_KEYWORDS.mage).toContain("wizard");
    expect(NPC_TIER_KEYWORDS.priest).toContain("acolyte");
    expect(NPC_TIER_KEYWORDS.adventurer).toContain("veteran");
    expect(NPC_TIER_KEYWORDS.leader).toContain("captain");
    for (const keyword of EXACT_TOKEN_ONLY_KEYWORDS) {
      expect(seen.has(keyword), `exact-token keyword ${keyword} must exist in a tier`).toBe(true);
    }
  });
});

describe("TIER_TEMPLATES", () => {
  it("is ordered and verifies every definition id against the published starter pack", () => {
    expect(TIER_TEMPLATES.map((entry) => entry.tier)).toEqual([
      "commoner", "guard", "scout", "soldier", "adventurer", "mage", "priest", "leader",
    ]);
    const ids = new Set<string>();
    for (const entry of TIER_TEMPLATES) {
      expect(ids.has(entry.definitionId), `duplicate template ${entry.definitionId}`).toBe(false);
      ids.add(entry.definitionId);
      const template = enemyTemplate(entry.definitionId);
      expect(template.reference.kind).toBe("enemy-template");
      expect(template.reference.packId).toBe(SRD_5_1_STARTER_CATALOG.manifest.packId);
      expect(template.mechanics.challengeRating).toBeTypeOf("number");
      expect(template.mechanics.maxHp).toBeGreaterThan(0);
      expect(template.mechanics.defense).toBeGreaterThan(0);
      expect(template.mechanics.combatProfile.attack.attackBonus).toBeTypeOf("number");
    }
  });

  it("keeps the martial spine monotonic in challenge rating and hit points", () => {
    const spine: NpcCombatTier[] = ["commoner", "guard", "scout", "soldier", "adventurer", "leader"];
    const stats = spine.map((tier) => enemyTemplate(templateFor(tier).definitionId).mechanics);
    for (let index = 1; index < stats.length; index += 1) {
      const previous = stats[index - 1]!;
      const current = stats[index]!;
      expect(current.challengeRating, `${spine[index]} CR`).toBeGreaterThanOrEqual(previous.challengeRating);
      expect(current.maxHp, `${spine[index]} HP`).toBeGreaterThanOrEqual(previous.maxHp);
    }
  });

  it("keeps commoner <= guard <= adventurer <= leader", () => {
    const chain: NpcCombatTier[] = ["commoner", "guard", "adventurer", "leader"];
    const stats = chain.map((tier) => enemyTemplate(templateFor(tier).definitionId).mechanics);
    for (let index = 1; index < stats.length; index += 1) {
      const previous = stats[index - 1]!;
      const current = stats[index]!;
      expect(current.challengeRating, `${chain[index]} CR`).toBeGreaterThanOrEqual(previous.challengeRating);
      expect(current.maxHp, `${chain[index]} HP`).toBeGreaterThanOrEqual(previous.maxHp);
    }
  });
});

interface CreateNpcOptions {
  description?: string;
  archetype?: string;
  baseline?: { body: number; mind: number; presence: number };
}

function fixture() {
  let sequence = 0;
  const repo = createRepository({
    clock: { now: () => new Date(AT) },
    ids: { nextId: () => `npc-profile-${++sequence}` },
    rng: { integer: (min: number) => min },
  });
  const campaign = repo.createCampaign(OWNER, { name: "NPC combat profiles" });
  repo.installSrdStarterCatalog(OWNER);
  repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "pins" });
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  let revision = 0;
  const createNpc = (name: string, options: CreateNpcOptions = {}): { npcId: string } => {
    const publicState: { name: string; description?: string; archetype?: string } = { name };
    if (options.description !== undefined) publicState.description = options.description;
    if (options.archetype !== undefined) publicState.archetype = options.archetype;
    const persona = repo.createCharacter({
      name, age: 40, archetype: options.archetype ?? "Commoner", boundaries: "", fictionalConfirmed: true,
    });
    const npc = repo.createCampaignNpc(OWNER, campaign.id, {
      personaId: persona.id,
      publicState,
      privateState: { goals: "", gmNotes: "", merchantState: null },
      expectedRevision: revision,
      idempotencyKey: `create-npc-${revision}`,
    }).npc;
    revision += 1;
    if (options.baseline) {
      db.prepare("INSERT INTO campaign_npc_baseline_stats_v41 VALUES(?,?,?,?,?,'generated-deterministic-baseline')")
        .run(campaign.id, npc.npcId, options.baseline.body, options.baseline.mind, options.baseline.presence);
    }
    return npc;
  };
  return { repo, campaign, db, createNpc };
}

type Fixture = ReturnType<typeof fixture>;

describe("resolveNpcCombatProfile", () => {
  it("resolves a commoner to the weakest humanoid template without writing encounter rows", () => {
    const f: Fixture = fixture();
    const npc = f.createNpc("Old Mara", { description: "The village ferryman who tends the crossing." });
    const profile = resolveNpcCombatProfile(f.db, OWNER, f.campaign.id, npc.npcId);
    const cultist = enemyTemplate("srd-5.1:enemy-template:cultist");
    expect(profile).toMatchObject({
      npcId: npc.npcId,
      name: "Old Mara",
      tier: "commoner",
      template: {
        kind: "enemy-template",
        packId: cultist.reference.packId,
        packVersion: cultist.reference.packVersion,
        definitionId: "srd-5.1:enemy-template:cultist",
      },
      stats: {
        challengeRating: cultist.mechanics.challengeRating,
        maxHp: cultist.mechanics.maxHp,
        defense: cultist.mechanics.defense,
        attackBonus: cultist.mechanics.combatProfile.attack.attackBonus,
      },
      baselineStats: null,
    });
    expect(profile.rationale).toContain("ferryman");
    expect(profile.rationale).toContain("commoner");
    expect(f.db.prepare("SELECT COUNT(*) count FROM encounter").get()).toEqual({ count: 0 });
    expect(f.db.prepare("SELECT COUNT(*) count FROM combatant").get()).toEqual({ count: 0 });
    expect(f.db.prepare("SELECT COUNT(*) count FROM encounter_enemy_provenance_v31").get()).toEqual({ count: 0 });
    f.db.close();
  });

  it("combines name, public role text, and baseline stats", () => {
    const f: Fixture = fixture();
    const npc = f.createNpc(
      "Sergeant Bram",
      { description: "A grizzled veteran of the northern campaigns.", baseline: { body: 15, mind: 10, presence: 12 } },
    );
    const profile = resolveNpcCombatProfile(f.db, OWNER, f.campaign.id, npc.npcId);
    expect(profile.tier).toBe("adventurer");
    expect(profile.template.definitionId).toBe("srd-5.1:enemy-template:veteran");
    expect(profile.baselineStats).toEqual({ body: 15, mind: 10, presence: 12, source: "generated-deterministic-baseline" });
    expect(profile.rationale).toContain("veteran");
    f.db.close();
  });

  it("resolves caster and leader roles from public descriptions", () => {
    const f: Fixture = fixture();
    const mage = f.createNpc("Ilyra", { archetype: "Court Wizard" });
    const priest = f.createNpc("Brother Oren", { description: "An acolyte of the dawn." });
    const leader = f.createNpc("Vex", { description: "A bandit captain who leads the outlaws of the pass." });
    expect(resolveNpcCombatProfile(f.db, OWNER, f.campaign.id, mage.npcId).template.definitionId)
      .toBe("srd-5.1:enemy-template:mage");
    expect(resolveNpcCombatProfile(f.db, OWNER, f.campaign.id, priest.npcId).template.definitionId)
      .toBe("srd-5.1:enemy-template:priest");
    const leaderProfile = resolveNpcCombatProfile(f.db, OWNER, f.campaign.id, leader.npcId);
    expect(leaderProfile.tier).toBe("leader");
    expect(leaderProfile.template.definitionId).toBe("srd-5.1:enemy-template:gladiator");
    f.db.close();
  });

  it("rejects an unknown NPC", () => {
    const f: Fixture = fixture();
    expectFailure(() => resolveNpcCombatProfile(f.db, OWNER, f.campaign.id, "npc-profile-missing"), "NPC_PROFILE_NPC_NOT_FOUND");
    f.db.close();
  });

  it("rejects a principal who is not a campaign member", () => {
    const f: Fixture = fixture();
    const npc = f.createNpc("Old Mara", { description: "ferryman" });
    expectFailure(() => resolveNpcCombatProfile(f.db, "stranger", f.campaign.id, npc.npcId), "NPC_PROFILE_FORBIDDEN");
    f.db.close();
  });

  it("rejects a tier template that is not publicly reachable", () => {
    const f: Fixture = fixture();
    const npc = f.createNpc("Old Mara", { description: "ferryman" });
    f.db.exec("DROP TRIGGER rpg_catalog_visibility_immutable_update");
    f.db.prepare("UPDATE rpg_catalog_definition_visibility SET publicly_reachable=0 WHERE kind='enemy-template' AND definition_id=?")
      .run("srd-5.1:enemy-template:cultist");
    expectFailure(() => resolveNpcCombatProfile(f.db, OWNER, f.campaign.id, npc.npcId), "NPC_PROFILE_TEMPLATE_UNAVAILABLE");
    f.db.close();
  });

  it("rejects a campaign whose packs are not pinned", () => {
    const f: Fixture = fixture();
    const unpinned = f.repo.createCampaign(OWNER, { name: "No pinned packs" });
    const persona = f.repo.createCharacter({
      name: "Old Mara", age: 40, archetype: "Ferryman", boundaries: "", fictionalConfirmed: true,
    });
    const npc = f.repo.createCampaignNpc(OWNER, unpinned.id, {
      personaId: persona.id,
      publicState: { name: "Old Mara", description: "The village ferryman." },
      privateState: { goals: "", gmNotes: "", merchantState: null },
      expectedRevision: 0,
      idempotencyKey: "unpinned-npc",
    }).npc;
    expectFailure(() => resolveNpcCombatProfile(f.db, OWNER, unpinned.id, npc.npcId), "NPC_PROFILE_TEMPLATE_UNAVAILABLE");
    f.db.close();
  });
});

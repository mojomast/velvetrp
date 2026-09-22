/**
 * NPC combat-profile resolver.
 *
 * Resolves any campaign NPC to a bounded `srd-5.1:starter` enemy template so a
 * later wave can materialize an encounter when a player attacks them. The
 * mapping is a best-effort balance heuristic: common folk resolve to the
 * weakest humanoid profile in the pack, professionals scale up to guards,
 * soldiers, adventurers, and leaders.
 *
 * This module only reads. It never creates encounters, combatants, provenance
 * rows, or catalog pins, and the same inputs always resolve to the same
 * profile.
 */
import type DatabaseDriver from "better-sqlite3";

/** Combat role tiers used by the resolver. */
export type NpcCombatTier =
  | "commoner"
  | "guard"
  | "scout"
  | "soldier"
  | "adventurer"
  | "mage"
  | "priest"
  | "leader";

/** One row of the ordered tier table. */
export interface NpcTierTemplateEntry {
  readonly tier: NpcCombatTier;
  /** Concrete `srd-5.1:starter` enemy-template definition id. */
  readonly definitionId: string;
  /** Why this template was chosen, including documented fallbacks. */
  readonly note: string;
}

/**
 * Ordered tier table (commoner → leader). Definition ids were verified
 * against the published starter pack; balance is monotonic across the martial
 * spine (see `npc-combat-profile.test.ts`). The caster tiers sit between the
 * adventurer and leader tiers as role branches: the pack has no caster whose
 * durability grows with challenge rating, so they are ordered by role, not HP.
 */
export const TIER_TEMPLATES: readonly NpcTierTemplateEntry[] = Object.freeze([
  Object.freeze({
    tier: "commoner",
    definitionId: "srd-5.1:enemy-template:cultist",
    note: "weakest humanoid in the pack (CR 1/8, 9 HP, lowest HP of the CR 1/8 humanoids); the pack has no neutral civilian template",
  }),
  Object.freeze({
    tier: "guard",
    definitionId: "srd-5.1:enemy-template:guard",
    note: "pinned spear guard; same CR as the commoner with more HP and much higher defense",
  }),
  Object.freeze({
    tier: "scout",
    definitionId: "srd-5.1:enemy-template:scout",
    note: "CR 1/2 skirmisher; the only purpose-built scout in the pack",
  }),
  Object.freeze({
    tier: "soldier",
    definitionId: "srd-5.1:enemy-template:spy",
    note: "only CR 1 mundane humanoid between the scout and the veteran; the pack has no thug/bandit-soldier profile, so spy carries soldier/bandit-style roles",
  }),
  Object.freeze({
    tier: "adventurer",
    definitionId: "srd-5.1:enemy-template:veteran",
    note: "CR 3 veteran; knight (CR 3, 52 HP, AC 18) is the alternate when a shield profile is preferred",
  }),
  Object.freeze({
    tier: "mage",
    definitionId: "srd-5.1:enemy-template:mage",
    note: "only arcane caster below the CR 12 archmage; caster tier, not part of the martial durability spine",
  }),
  Object.freeze({
    tier: "priest",
    definitionId: "srd-5.1:enemy-template:priest",
    note: "divine caster (CR 2); cult-fanatic and druid are the nearby alternates",
  }),
  Object.freeze({
    tier: "leader",
    definitionId: "srd-5.1:enemy-template:gladiator",
    note: "bandit-captain (CR 2) and knight (CR 3) would invert the CR 3 adventurer tier, so the CR 5 gladiator anchors the table as the pack's strongest humanoid martial profile",
  }),
]);

const keywords = (...values: string[]): readonly string[] => Object.freeze(values);

/**
 * Role keywords per tier. Matching walks `NPC_TIER_MATCH_ORDER`, so an elite
 * word ("captain", "mage") beats a rank-and-file word regardless of order in
 * the text. Exported so tests can assert coverage and uniqueness.
 */
export const NPC_TIER_KEYWORDS: Readonly<Record<NpcCombatTier, readonly string[]>> = Object.freeze({
  leader: keywords(
    "king", "queen", "lord", "lady", "baron", "baroness", "duke", "duchess", "count", "countess",
    "earl", "marquess", "emperor", "empress", "prince", "princess", "chief", "chieftain", "captain",
    "commander", "general", "admiral", "colonel", "major", "marshal", "sheriff", "mayor", "elder",
    "matriarch", "patriarch", "warlord", "warchief", "overlord", "sovereign", "regent", "steward",
    "guildmaster", "headmaster", "taskmaster", "harbormaster", "boss", "leader", "noble",
    "nobleman", "noblewoman", "aristocrat",
  ),
  mage: keywords(
    "mage", "wizard", "sorcerer", "sorceress", "warlock", "witch", "enchanter", "enchantress",
    "conjurer", "necromancer", "illusionist", "evoker", "abjurer", "diviner", "transmuter",
    "arcanist", "magus", "spellcaster", "spellweaver", "archmage",
  ),
  priest: keywords(
    "priest", "priestess", "acolyte", "cleric", "bishop", "archbishop", "abbot", "abbess", "monk",
    "friar", "nun", "chaplain", "deacon", "vicar", "curate", "pastor", "reverend", "oracle", "seer",
    "prophet", "prophetess", "missionary", "inquisitor", "druid", "shaman",
  ),
  adventurer: keywords(
    "knight", "veteran", "champion", "gladiator", "paladin", "cavalier", "templar", "crusader",
    "duelist", "swashbuckler", "blademaster", "swordmaster", "hero", "heroine", "adventurer",
    "barbarian", "battlemaster",
  ),
  soldier: keywords(
    "soldier", "warrior", "fighter", "mercenary", "sellsword", "legionary", "legionnaire",
    "infantry", "infantryman", "marine", "sergeant", "corporal", "recruit", "conscript", "militia",
    "bandit", "brigand", "raider", "marauder", "thug", "enforcer", "goon", "ruffian", "outlaw",
    "highwayman", "cutthroat", "footpad", "pillager", "plunderer", "smuggler", "pirate", "corsair",
    "buccaneer", "freebooter", "reaver", "deserter", "archer", "marksman", "bowman", "crossbowman",
    "spearman", "swordsman", "axeman", "assassin",
  ),
  scout: keywords(
    "scout", "ranger", "hunter", "huntress", "huntsman", "hunt", "tracker", "trapper", "outrider",
    "pathfinder", "explorer", "guide", "spy", "sneak", "rogue", "thief", "burglar", "poacher",
    "lookout", "woodsman", "woodswoman", "forester",
  ),
  guard: keywords(
    "guard", "guardian", "bodyguard", "watch", "watchman", "watchwoman", "guardsman", "guardswoman",
    "sentinel", "sentry", "patrol", "gatekeeper", "jailer", "jailor", "warden", "constable",
    "deputy", "bouncer", "turnkey",
  ),
  commoner: keywords(
    "ferryman", "ferrywoman", "boatman", "boatwoman", "waterman", "factor", "merchant",
    "merchantman", "trader", "trade", "shopkeeper", "storekeeper", "shopkeep", "peddler", "hawker",
    "vendor", "dealer", "broker", "banker", "moneylender", "innkeeper", "tavernkeep", "barkeep",
    "barkeeper", "bartender", "publican", "vintner", "brewer", "farmer", "farm", "farmhand",
    "farmwife", "peasant", "villager", "commoner", "townsfolk", "crofter", "tenant", "sharecropper",
    "herder", "herdsman", "shepherd", "shepherdess", "goatherd", "swineherd", "cowherd",
    "stablehand", "stableboy", "ostler", "hostler", "smith", "blacksmith", "goldsmith",
    "silversmith", "coppersmith", "tinsmith", "wright", "cartwright", "wheelwright", "shipwright",
    "cooper", "chandler", "fletcher", "bowyer", "tinker", "weaver", "tailor", "seamstress",
    "cobbler", "tanner", "leatherworker", "potter", "mason", "carpenter", "joiner", "thatcher",
    "roofer", "miller", "baker", "butcher", "cook", "chef", "servant", "maid", "housekeeper",
    "butler", "footman", "valet", "scullion", "laundress", "fisher", "fisherman", "fishwife",
    "sailor", "seaman", "deckhand", "dockhand", "docker", "longshoreman", "stevedore", "porter",
    "carrier", "courier", "messenger", "runner", "crier", "herald", "clerk", "scribe", "bookkeeper",
    "accountant", "notary", "tutor", "teacher", "scholar", "student", "librarian", "archivist",
    "apothecary", "herbalist", "healer", "midwife", "nurse", "alchemist", "beggar", "vagrant",
    "drunkard", "orphan", "urchin", "woodcutter", "lumberjack", "miner", "quarryman", "bard",
    "minstrel", "musician", "actor", "performer", "juggler", "acrobat", "dancer", "singer",
    "storyteller", "tradesman", "craftsman", "workman", "workwoman", "countryman", "countrywoman",
    "fishmonger", "ironmonger", "grocer",
  ),
});

/**
 * Tier precedence for keyword matching. Elite roles are checked before
 * rank-and-file roles, and the commoner default is checked last.
 */
export const NPC_TIER_MATCH_ORDER: readonly NpcCombatTier[] = Object.freeze([
  "leader", "mage", "priest", "adventurer", "soldier", "scout", "guard", "commoner",
]);

/** Result of the pure, text-only tier heuristic. */
export interface NpcTierDerivation {
  readonly tier: NpcCombatTier;
  /** The keyword that selected the tier, or `null` for the commoner default. */
  readonly matchedKeyword: string | null;
  readonly rationale: string;
}

/**
 * Expands a token into the forms that should match a singular keyword:
 * plurals (`guards` → `guard`), sibilant plurals (`watches` → `watch`),
 * `-ies` plurals (`ladies` → `lady`), irregular `-men` plurals
 * (`watchmen` → `watchman`), and gerunds (`guarding` → `guard`).
 */
function tokenForms(token: string): readonly string[] {
  const forms = [token];
  if (token.length > 3 && token.endsWith("ies")) forms.push(`${token.slice(0, -3)}y`);
  if (token.length > 2 && token.endsWith("es")) forms.push(token.slice(0, -2));
  if (token.length > 1 && token.endsWith("s") && !token.endsWith("ss")) forms.push(token.slice(0, -1));
  if (token.length > 3 && token.endsWith("men")) forms.push(`${token.slice(0, -3)}man`);
  if (token.length > 4 && token.endsWith("ing")) {
    const stem = token.slice(0, -3);
    forms.push(stem, `${stem}e`);
  }
  return forms;
}

/**
 * Pure, deterministic keyword/role heuristic over an NPC's public text. Case
 * insensitive and word-boundary safe; text without any role keyword falls back
 * to `commoner`.
 */
export function deriveNpcTier(text: string): NpcTierDerivation {
  const forms = new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap(tokenForms));
  for (const tier of NPC_TIER_MATCH_ORDER) {
    for (const keyword of NPC_TIER_KEYWORDS[tier]) {
      if (forms.has(keyword)) {
        return { tier, matchedKeyword: keyword, rationale: `matched role keyword "${keyword}" for tier ${tier}` };
      }
    }
  }
  return { tier: "commoner", matchedKeyword: null, rationale: "no role keyword matched; defaulted to commoner" };
}

/** Typed failure codes for {@link resolveNpcCombatProfile}. */
export type NpcCombatProfileFailureCode =
  | "NPC_PROFILE_FORBIDDEN"
  | "NPC_PROFILE_NPC_NOT_FOUND"
  | "NPC_PROFILE_TEMPLATE_UNAVAILABLE";

/** Raised when an NPC combat profile cannot be resolved. */
export class NpcCombatProfileError extends Error {
  readonly code: NpcCombatProfileFailureCode;
  constructor(code: NpcCombatProfileFailureCode, message: string) {
    super(message);
    this.name = "NpcCombatProfileError";
    this.code = code;
  }
}

/** Baseline NPC attributes, present for generated deterministic NPCs. */
export interface NpcCombatBaselineStats {
  readonly body: number;
  readonly mind: number;
  readonly presence: number;
  readonly source: string;
}

/** A resolved, publicly visible combat profile for one campaign NPC. */
export interface NpcCombatProfile {
  readonly npcId: string;
  readonly name: string;
  readonly tier: NpcCombatTier;
  readonly rationale: string;
  readonly template: {
    readonly packId: string;
    readonly packVersion: string;
    readonly kind: "enemy-template";
    readonly definitionId: string;
  };
  readonly stats: {
    readonly challengeRating: number;
    readonly maxHp: number;
    readonly defense: number;
    readonly attackBonus: number;
  };
  /** Loaded for the materialization wave; `null` when the NPC has no baseline. */
  readonly baselineStats: NpcCombatBaselineStats | null;
}

const PUBLIC_STATE_TEXT_KEYS = ["description", "archetype", "role", "occupation", "title"] as const;

/** Public, player-visible role text stored on `campaign_npc_metadata_v32`. */
function publicStateTexts(publicStateJson: string | null): string[] {
  if (publicStateJson === null) return [];
  try {
    const value = JSON.parse(publicStateJson) as Record<string, unknown>;
    const texts: string[] = [];
    for (const key of PUBLIC_STATE_TEXT_KEYS) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) texts.push(candidate.trim());
    }
    return texts;
  } catch {
    return [];
  }
}

/** Reads the executable numbers out of a public enemy-template projection. */
function parseCombatStats(publicDefinitionJson: string): NpcCombatProfile["stats"] | null {
  try {
    const value = JSON.parse(publicDefinitionJson) as {
      mechanics?: {
        challengeRating?: unknown;
        maxHp?: unknown;
        defense?: unknown;
        combatProfile?: { attack?: { attackBonus?: unknown } };
      };
    };
    const challengeRating = Number(value.mechanics?.challengeRating);
    const maxHp = Number(value.mechanics?.maxHp);
    const defense = Number(value.mechanics?.defense);
    const attackBonus = Number(value.mechanics?.combatProfile?.attack?.attackBonus);
    if (!Number.isFinite(challengeRating) || challengeRating < 0) return null;
    if (!Number.isInteger(maxHp) || maxHp < 1) return null;
    if (!Number.isInteger(defense) || defense < 1) return null;
    if (!Number.isInteger(attackBonus)) return null;
    return { challengeRating, maxHp, defense, attackBonus };
  } catch {
    return null;
  }
}

interface NpcProfileRow {
  npc_id: string;
  public_name: string;
  public_state_json: string | null;
  persona_archetype: string | null;
  body: number | null;
  mind: number | null;
  presence: number | null;
  source: string | null;
}

interface PinnedEnemyTemplateRow {
  pack_id: string;
  pack_version: string;
  public_definition_json: string;
}

/**
 * Resolves a campaign NPC to a publicly visible enemy template. Reads the NPC
 * public row, its public role text, and baseline stats when present, derives a
 * role tier, and pins the tier's template against the campaign's current
 * content-pack pins.
 *
 * Typed failures: a non-member principal, an unknown NPC, or a tier template
 * that is not publicly reachable in the campaign's pinned packs. No fallback is
 * applied beyond the no-keyword commoner default.
 */
export function resolveNpcCombatProfile(
  db: DatabaseDriver.Database,
  principalId: string,
  campaignId: string,
  npcId: string,
): NpcCombatProfile {
  const membership = db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
    .get(campaignId, principalId);
  if (!membership) {
    throw new NpcCombatProfileError("NPC_PROFILE_FORBIDDEN", "campaign membership is required to resolve an NPC combat profile");
  }

  const row = db.prepare(`SELECT npc.npc_id,npc.public_name,metadata.public_state_json,
      persona.archetype persona_archetype,baseline.body,baseline.mind,baseline.presence,baseline.source
    FROM campaign_npcs_v28 npc
    JOIN characters persona ON persona.id=npc.persona_id
    LEFT JOIN campaign_npc_metadata_v32 metadata
      ON metadata.campaign_id=npc.campaign_id AND metadata.npc_id=npc.npc_id
    LEFT JOIN campaign_npc_baseline_stats_v41 baseline
      ON baseline.campaign_id=npc.campaign_id AND baseline.npc_id=npc.npc_id
    WHERE npc.campaign_id=? AND npc.npc_id=?`).get(campaignId, npcId) as NpcProfileRow | undefined;
  if (!row) {
    throw new NpcCombatProfileError("NPC_PROFILE_NPC_NOT_FOUND", `NPC ${npcId} does not exist in campaign ${campaignId}`);
  }

  const stateTexts = publicStateTexts(row.public_state_json);
  const derivation = deriveNpcTier(
    [row.public_name, ...stateTexts, row.persona_archetype ?? ""]
      .filter((text) => text.trim().length > 0)
      .join("\n"),
  );
  const entry = TIER_TEMPLATES.find((candidate) => candidate.tier === derivation.tier);
  if (!entry) {
    throw new NpcCombatProfileError("NPC_PROFILE_TEMPLATE_UNAVAILABLE", `no enemy template is configured for tier ${derivation.tier}`);
  }

  const pinned = db.prepare(`SELECT pin.pack_id,pin.pack_version,visibility.public_definition_json
    FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definition_visibility visibility
      ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
    WHERE pin.campaign_id=? AND visibility.kind='enemy-template'
      AND visibility.definition_id=? AND visibility.publicly_reachable=1
    ORDER BY pin.pack_id,pin.pack_version LIMIT 1`).get(campaignId, entry.definitionId) as PinnedEnemyTemplateRow | undefined;
  if (!pinned) {
    throw new NpcCombatProfileError(
      "NPC_PROFILE_TEMPLATE_UNAVAILABLE",
      `tier ${derivation.tier} template ${entry.definitionId} is not publicly visible in the campaign's pinned packs`,
    );
  }
  const stats = parseCombatStats(pinned.public_definition_json);
  if (!stats) {
    throw new NpcCombatProfileError(
      "NPC_PROFILE_TEMPLATE_UNAVAILABLE",
      `tier ${derivation.tier} template ${entry.definitionId} has no usable combat profile`,
    );
  }

  const baselineStats = row.body === null || row.mind === null || row.presence === null || row.source === null
    ? null
    : { body: row.body, mind: row.mind, presence: row.presence, source: row.source };
  const scanned = ["public name"];
  if (stateTexts.length > 0) scanned.push("public state");
  if (row.persona_archetype !== null && row.persona_archetype.trim().length > 0) scanned.push("persona archetype");

  return {
    npcId: row.npc_id,
    name: row.public_name,
    tier: derivation.tier,
    rationale: `${derivation.rationale}; ${entry.note}; scanned ${scanned.join(", ")}`,
    template: {
      packId: pinned.pack_id,
      packVersion: pinned.pack_version,
      kind: "enemy-template",
      definitionId: entry.definitionId,
    },
    stats,
    baselineStats,
  };
}

/**
 * Sintermark party seeder.
 *
 * Exports `createSintermarkParty(repository, campaignId)` for the main world
 * hydrator to call against an already-created, SRD-configured `dnd-5e@1.0.0`
 * campaign. The helper is deliberately provider-free, commit-only, and makes
 * no rules claims beyond what the pinned `srd-5.1:rules:starter-v1` catalog and
 * the `dnd-5e@1.0.0` module actually execute.
 *
 * Reality check on this codebase (documented so nobody re-litigates it):
 *  - The owned `mutateInventoryForActor` public method ONLY exposes
 *    equip/unequip/consume/drop/gift. It does NOT expose `add_inventory_item`
 *    even though the private `mutate()` switch handles that command. This file
 *    therefore does not call it with an unsupported `kind` and never hides a
 *    type mismatch behind `as never`.
 *  - Non-stackable item grants go through the owned deterministic fixture seam
 *    `createDeterministicE2ERepository(...).fixtures.materializeInventoryEntry`,
 *    which validates campaign ownership + M1.5 revision, pins the exact public
 *    catalog definition for execution, and inserts an instanced quantity-1 row.
 *  - Stackable grants (potions x10, ammunition, torches, rations) need a real
 *    stackable row and a quantity the fixture seam cannot express. That is the
 *    one scoped SQL authoring seam in this file: `materializeStackableEntry`
 *    opens its own short-lived connection to the same `velvet.sqlite`, verifies
 *    the campaign is owned by `local-owner`, that the exact definition is
 *    publicly pinned, and that `mechanics.stackable === true`, then inserts the
 *    stackable row. The item is pinned for execution through
 *    `fixtures.materializePinnedItemExecution` (the owned helper), so no
 *    production repository code is modified and no catalog content is invented.
 *  - Magic items are catalog metadata/reference only in this build: charges,
 *    granted powers, and passive modifiers are not executed by the persisted
 *    runtime. They are carried as references, never equipped.
 *
 * The SRD starter progression profile caps executable character level at 3
 * (`thresholds = [0, 300, 900]`). The two characters are advanced to level 3
 * through real XP + preview/apply commands, then receive explicit GM attribute
 * and resource overrides (documented "overpowered" overlay), not invented rules.
 */

import path from "node:path";
import Database from "better-sqlite3";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  itemCatalogDefinitionSchema,
  personaProfileSchema,
  type ActorResourceCommand,
  type CatalogDefinition,
  type CharacterBuilderAttributeScores,
  type CommandEnvelope,
  type ProgressionPendingChoice,
  type ProgressionSelection,
  type UpdateCharacterDraftInput,
} from "@velvet/contracts";
import {
  SRD_5_1_STARTER_CATALOG,
  type Repository,
} from "../server/src/repo/index.js";
import { createDeterministicE2ERepository } from "../server/src/repo/testing/deterministicE2EFixtureRepo.js";

const OWNER = "local-owner";
const SEED_PREFIX = "sintermark.v1";
const TARGET_LEVEL = 3;
const TARGET_XP = 900;

export const SINTERMARK_HERO_PROFILES = {
  tessel: personaProfileSchema.parse({
    goal: "Measure the Longfire's true course and publish a survey that every district can check.",
    ideal: "A commons must be able to inspect the figures used to govern it.",
    bond: "Orra brought Tessel out of a settling gallery when the Register called the evacuation premature.",
    flaw: "Treats grief and disagreement like measurement errors; sounds cold when frightened.",
    history: "Raised on the Warm Verge, trained at the Kiln College, then employed as a Register draught adjuster. Tessel helped prepare reassuring charts before discovering their readings did not match the ground. Left with copies and now wants independent measurements, not revenge. Knows how a vent lease can condemn a home as readily as a fire can.",
    personality: "Meticulous, dryly funny, generous with practical teaching. Keeps chalk, a folding level and a sampling prism beside the spellbook. Will admit uncertainty, but hates being asked to round away inconvenient evidence.",
    fears: "Being right too late; a clever intervention that rescues a furnace but wrecks someone's well.",
    relationships: "Neris Rusk taught Tessel to keep raw notes. Pell Marrow regards Tessel as a disloyal employee. Yara knows the family on the Verge. Orra insists that measurements are useful only if someone gets home.",
    appearance: "A soot-grey survey coat with repaired cuffs, cropped silver hair, ink-stained fingertips and brass-framed protective lenses.",
    voice: "Short, exact sentences and understated jokes. Says 'I haven't measured that' instead of guessing. Becomes more formal when angry.",
  }),
  orra: personaProfileSchema.parse({
    goal: "Bring every crew home and secure enforceable heat-share and rescue guarantees.",
    ideal: "Maintenance and mutual aid are sacred duties; nobody is expendable.",
    bond: "The Steps' jack crews trained Orra, and their families trust her with the last descent.",
    flaw: "Cannot abandon a rescue even when the cost to everyone else becomes severe; confuses stubbornness with duty.",
    history: "A hill-dwarf jack-crew captain who became a Life cleric through a local faith of repair and shared fire. Has raised whole terraces a finger's breadth at a time and carried colleagues out of failed galleries. A rescue once saved Tessel, making the pair unlikely partners. She wants written guarantees, usable equipment and paid crews rather than another commemorative plaque.",
    personality: "Plain-spoken, attentive, unhurried beneath a settling ceiling. Remembers names, checks knots herself, and makes room for frightened people without promising that everything is safe.",
    fears: "Leaving someone below; being made the respectable face of a settlement the crews cannot live with.",
    relationships: "Dolph Marrow trusts her underground but argues with her over strike tactics. Cael treats the workers she brings up. Orl Tace's bargaining makes her uneasy. Tessel can tell her where the ground is moving, but she makes Tessel explain who will bear the cost.",
    appearance: "Broad-shouldered, dark braided hair, a plate harness patched with numbered rescue tags, and a warhammer fashioned like a building-jack handle.",
    voice: "Warm low voice, practical verbs, names before titles. Asks 'Who is still below?' before discussing liability.",
  }),
};

/** The SRD starter catalog reference for one exact definition. */
type RaceRef = Extract<CatalogDefinition, { reference: { kind: "race" } }>["reference"];
type BackgroundRef = Extract<CatalogDefinition, { reference: { kind: "background" } }>["reference"];
type ClassRef = Extract<CatalogDefinition, { reference: { kind: "class" } }>["reference"];
type SpellRef = Extract<CatalogDefinition, { reference: { kind: "spell" } }>["reference"];
type ItemRef = Extract<CatalogDefinition, { reference: { kind: "item" } }>["reference"];
type SrdAttributeId = (typeof SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS)[number];

/** A non-stackable grant, optionally equipped when it has a real SRD equipment profile. */
interface InstancedItemPlan {
  definitionId: string;
  equip?: { slot: "hand" | "body"; hand?: "main" | "off"; grip?: "one-handed" | "two-handed" };
}

/** A stackable grant authored through the scoped SQL seam. */
interface StackableItemPlan {
  definitionId: string;
  quantity: number;
}

interface HeroSpec {
  key: "tessel" | "orra";
  name: string;
  age: number;
  archetype: string;
  ancestryDefinitionId: string;
  classDefinitionId: string;
  primaryAttribute: SrdAttributeId;
  preparedSpells: readonly string[];
  targetScores: Readonly<Record<SrdAttributeId, number>>;
  battlePowers: readonly string[];
  componentNotes: string;
  reactionConstraints: string;
  instancedItems: readonly InstancedItemPlan[];
  stackableItems: readonly StackableItemPlan[];
  attunementItems: readonly string[];
}

const HEROES: readonly HeroSpec[] = [
  {
    key: "tessel",
    name: "Tessel Venn",
    age: 29,
    archetype: "High-elven thermal surveyor and whistleblower",
    ancestryDefinitionId: "srd-5.1:race:high-elf",
    classDefinitionId: "srd-5.1:class:wizard",
    primaryAttribute: "intelligence",
    // Exact level-one prepared spells offered by the Wizard class definition.
    preparedSpells: [
      "srd-5.1:spell:magic-missile",
      "srd-5.1:spell:false-life",
      "srd-5.1:spell:shield",
    ],
    targetScores: { intelligence: 20, dexterity: 20, constitution: 20, wisdom: 18, strength: 16, charisma: 18 },
    battlePowers: [
      "srd-5.1:spell:fire-bolt",
      "srd-5.1:spell:ray-of-frost",
      "srd-5.1:spell:magic-missile",
      "srd-5.1:spell:false-life",
      "srd-5.1:spell:shield",
    ],
    componentNotes:
      "Fire Bolt V,S; Ray of Frost V,S; False Life V,S,M (spirits); Shield V,S. The pinned runtime also requires a material component for Magic Missile; the official SRD spell is V,S only. Supply the runtime component flags when using the spell-command lane.",
    reactionConstraints:
      "Shield is a reaction: the out-of-combat actor-power lane rejects reactions, the combat-power lane allows it, and the hit-time Shield path resolves at true hit time. Fire Bolt/Ray of Frost carry attackType 'ranged' and are only executable through the in-combat combat-power lane, not castSpell or the ranged out-of-combat check.",
    instancedItems: [
      { definitionId: "srd-5.1:item:quarterstaff", equip: { slot: "hand", hand: "main", grip: "one-handed" } },
      { definitionId: "srd-5.1:item:studded-leather-armor", equip: { slot: "body" } },
      { definitionId: "srd-5.1:item:dagger" },
      { definitionId: "srd-5.1:item:light-crossbow" },
      { definitionId: "srd-5.1:item:sling" },
      { definitionId: "srd-5.1:item:component-pouch" },
      { definitionId: "srd-5.1:item:spellbook" },
      { definitionId: "srd-5.1:item:artisans-tools-cartographers" },
      { definitionId: "srd-5.1:item:rope-hempen" },
      { definitionId: "srd-5.1:item:crowbar" },
      { definitionId: "srd-5.1:item:lantern-hooded" },
      { definitionId: "srd-5.1:item:bag-of-holding" },
      { definitionId: "srd-5.1:item:wand-of-magic-missiles" },
      { definitionId: "srd-5.1:item:ring-of-protection" },
      { definitionId: "srd-5.1:item:boots-of-speed" },
    ],
    stackableItems: [
      { definitionId: "srd-5.1:item:potion-of-healing-greater", quantity: 10 },
      { definitionId: "srd-5.1:item:potion-of-healing-superior", quantity: 10 },
      { definitionId: "srd-5.1:item:potion-of-healing-supreme", quantity: 10 },
      { definitionId: "srd-5.1:item:crossbow-bolts", quantity: 20 },
      { definitionId: "srd-5.1:item:sling-bullets", quantity: 20 },
      { definitionId: "srd-5.1:item:piton", quantity: 10 },
      { definitionId: "srd-5.1:item:oil-flask", quantity: 5 },
      { definitionId: "srd-5.1:item:torch", quantity: 10 },
      { definitionId: "srd-5.1:item:rations", quantity: 10 },
    ],
    attunementItems: [
      "srd-5.1:item:wand-of-magic-missiles",
      "srd-5.1:item:ring-of-protection",
      "srd-5.1:item:boots-of-speed",
    ],
  },
  {
    key: "orra",
    name: "Orra Staple",
    age: 41,
    archetype: "Hill-dwarf Life-domain cleric and union rescue forewoman",
    ancestryDefinitionId: "srd-5.1:race:hill-dwarf",
    classDefinitionId: "srd-5.1:class:cleric",
    primaryAttribute: "wisdom",
    // Exact level-one prepared spells offered by the Cleric class definition.
    preparedSpells: [
      "srd-5.1:spell:bless",
      "srd-5.1:spell:cure-wounds",
      "srd-5.1:spell:healing-word",
    ],
    targetScores: { strength: 20, wisdom: 20, constitution: 20, dexterity: 18, intelligence: 18, charisma: 18 },
    battlePowers: [
      "srd-5.1:spell:bless",
      "srd-5.1:spell:cure-wounds",
      "srd-5.1:spell:healing-word",
    ],
    componentNotes:
      "bless V,S,M (sprinkling of holy water) and is area-targeted; cure-wounds V,S (touch); healing-word V (60 ft bonus action).",
    reactionConstraints:
      "Bless is area-targeted and therefore excluded from the single-target in-combat combat-power lane; it still executes through the out-of-combat actor-power lane. Cure Wounds / Healing Word execute in both lanes. No Cleric cantrip is wired as a damage power in this catalog.",
    instancedItems: [
      { definitionId: "srd-5.1:item:warhammer", equip: { slot: "hand", hand: "main", grip: "one-handed" } },
      { definitionId: "srd-5.1:item:plate", equip: { slot: "body" } },
      { definitionId: "srd-5.1:item:shield", equip: { slot: "hand", hand: "off" } },
      { definitionId: "srd-5.1:item:maul" },
      { definitionId: "srd-5.1:item:greatsword" },
      { definitionId: "srd-5.1:item:longbow" },
      { definitionId: "srd-5.1:item:javelin" },
      { definitionId: "srd-5.1:item:rope-hempen" },
      { definitionId: "srd-5.1:item:healers-kit" },
      { definitionId: "srd-5.1:item:component-pouch" },
      { definitionId: "srd-5.1:item:holy-symbol" },
      { definitionId: "srd-5.1:item:staff-of-healing" },
      { definitionId: "srd-5.1:item:cloak-of-protection" },
      { definitionId: "srd-5.1:item:ring-of-free-action" },
      { definitionId: "srd-5.1:item:immovable-rod" },
    ],
    stackableItems: [
      { definitionId: "srd-5.1:item:potion-of-healing-greater", quantity: 10 },
      { definitionId: "srd-5.1:item:potion-of-healing-superior", quantity: 10 },
      { definitionId: "srd-5.1:item:potion-of-healing-supreme", quantity: 10 },
      { definitionId: "srd-5.1:item:arrows", quantity: 20 },
      { definitionId: "srd-5.1:item:rations", quantity: 10 },
      { definitionId: "srd-5.1:item:torch", quantity: 10 },
    ],
    attunementItems: [
      "srd-5.1:item:staff-of-healing",
      "srd-5.1:item:cloak-of-protection",
      "srd-5.1:item:ring-of-free-action",
    ],
  },
];

const DEFINITIONS = new Map<string, CatalogDefinition>(
  SRD_5_1_STARTER_CATALOG.definitions.map((definition) => [
    `${definition.reference.kind}\u0000${definition.reference.definitionId}`,
    definition,
  ]),
);

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function definitionOf(kind: CatalogDefinition["reference"]["kind"], definitionId: string): CatalogDefinition {
  const definition = DEFINITIONS.get(`${kind}\u0000${definitionId}`);
  if (!definition) throw new Error(`Sintermark: SRD starter catalog has no ${kind} ${definitionId}`);
  return definition;
}

function itemDefinitionOf(definitionId: string) {
  return definitionOf("item", definitionId) as Extract<CatalogDefinition, { reference: { kind: "item" } }>;
}

function itemRefFor(definitionId: string): ItemRef {
  const definition = itemDefinitionOf(definitionId);
  return definition.reference;
}

function spellRefFor(definitionId: string): SpellRef {
  return definitionOf("spell", definitionId).reference as SpellRef;
}

function referenceOf(kind: "race" | "background" | "class", definitionId: string) {
  return definitionOf(kind, definitionId).reference;
}

/**
 * Assign the exact standard array once, giving the class primary the 15 so the
 * pre-overlay created character is coherent (Cleric Wisdom 15 + Hill Dwarf +1,
 * Wizard Intelligence 15 + High Elf +1). The absolute targets are applied after
 * leveling, so ancestry is never double-counted.
 */
function standardArrayFor(primary: SrdAttributeId): CharacterBuilderAttributeScores {
  const order = [primary, ...SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.filter((id) => id !== primary)];
  const scores = Object.fromEntries(order.map((id, index) => [id, CHARACTER_BUILDER_STANDARD_ARRAY[index]!]));
  return scores as CharacterBuilderAttributeScores;
}

/** Maps one server-offered pending choice to an exact typed progression selection. */
function selectionForChoice(choice: ProgressionPendingChoice): ProgressionSelection {
  const option = choice.options[0];
  if (!option) throw new Error(`Sintermark: pending choice ${choice.choiceId} offered no options`);
  switch (choice.kind) {
    case "ability":
      return { choiceId: choice.choiceId, kind: "ability", ability: option };
    case "feat":
      return { choiceId: choice.choiceId, kind: "feat", ability: option };
    case "subclass":
      return { choiceId: choice.choiceId, kind: "subclass", ability: option };
    case "class":
      return { choiceId: choice.choiceId, kind: "class", ability: option };
    case "ability-score-increase":
      return { choiceId: choice.choiceId, kind: "ability-score-increase", increases: [{ ability: option, amount: Math.min(2, choice.points) }] };
  }
}

/** Finds an existing campaign character by persona display name, if the seed is re-run. */
function findExisting(repository: Repository, campaignId: string, name: string) {
  const roster = repository.getCampaignCharacterRoster(OWNER, campaignId);
  const entry = roster?.characters.find((character) => character.name === name);
  if (!entry) return null;
  const characters = repository.listCampaignCharacters(OWNER, campaignId);
  const found = characters.find((character) => character.projection.campaignCharacter.id === entry.id);
  if (!found) return null;
  return {
    personaId: found.projection.campaignCharacter.characterId,
    actorId: found.projection.actor.id,
    campaignCharacterId: entry.id,
    name,
  };
}

function createPersona(repository: Repository, hero: HeroSpec): string {
  const persona = repository.createCharacter({
    name: hero.name,
    age: hero.age,
    archetype: hero.archetype,
    profile: SINTERMARK_HERO_PROFILES[hero.key],
    boundaries: "Fictional adults. No sexual violence, harm to children, or demeaning portrayals of real communities.",
    fictionalConfirmed: true,
  });
  return persona.id;
}

/** Advances the character to the SRD starter cap (level 3) through real progression commands. */
function advanceToTargetLevel(repository: Repository, campaignCharacterId: string, key: string): void {
  let state = requireValue(repository.getCharacterProgression(OWNER, campaignCharacterId), `Sintermark: ${key} progression is unavailable`);
  if (state.totalXp < TARGET_XP) {
    repository.grantCharacterXp(OWNER, campaignCharacterId, {
      amount: TARGET_XP - state.totalXp,
      reason: "Sintermark seed: advance to the supported SRD starter level cap",
      expectedRevision: state.revision,
      idempotencyKey: `${SEED_PREFIX}.${key}.xp`,
    });
  }
  for (let guard = 0; guard < 8; guard += 1) {
    state = requireValue(repository.getCharacterProgression(OWNER, campaignCharacterId), `Sintermark: ${key} progression is unavailable`);
    if (state.level >= TARGET_LEVEL) return;
    const preview = requireValue(repository.previewCharacterProgression(OWNER, campaignCharacterId), `Sintermark: ${key} progression preview is unavailable`);
    repository.applyCharacterProgression(OWNER, campaignCharacterId, {
      previewRevision: preview.revision,
      previewToken: preview.token,
      selections: preview.pendingChoices.map(selectionForChoice),
      idempotencyKey: `${SEED_PREFIX}.${key}.apply.${guard}`,
    });
  }
  const finalState = requireValue(repository.getCharacterProgression(OWNER, campaignCharacterId), `Sintermark: ${key} progression is unavailable`);
  if (finalState.level !== TARGET_LEVEL) throw new Error(`Sintermark: ${key} reached level ${finalState.level}, expected ${TARGET_LEVEL}`);
}

/** Reads the active campaign timeline revision for the GM command envelope seam. */
function activeTimeline(repository: Repository, campaignId: string): { timelineId: string; revision: number } {
  const administration = requireValue(repository.getCampaignAdministration(OWNER, campaignId), "Sintermark: campaign administration is unavailable");
  const timeline = requireValue(
    repository.getCampaignTimeline(OWNER, campaignId, administration.activeTimelineId),
    "Sintermark: active campaign timeline is unavailable",
  );
  return { timelineId: timeline.id, revision: timeline.revision };
}

/** GM override: set one ability score absolutely, after leveling. */
function setActorAttribute(repository: Repository, campaignId: string, actorId: string, key: string, attributeId: SrdAttributeId, value: number): void {
  const timeline = activeTimeline(repository, campaignId);
  const commandId = `${SEED_PREFIX}.attr.${key}.${attributeId}`;
  const envelope: CommandEnvelope = {
    commandId,
    idempotencyKey: commandId,
    campaignId,
    timelineId: timeline.timelineId,
    actorId,
    expectedRevision: timeline.revision,
    sourceTurnId: null,
    command: { type: "set_actor_attribute", payload: { attributeId, value } },
  };
  repository.executeSetActorAttribute(OWNER, envelope);
}

/** Creates an actor resource row that does not yet exist (GM initialize seam). */
function initializeResource(repository: Repository, campaignId: string, actorId: string, key: string, name: string, amount: number): void {
  const timeline = activeTimeline(repository, campaignId);
  const commandId = `${SEED_PREFIX}.res.${key}.${name}`;
  const envelope: CommandEnvelope = {
    commandId,
    idempotencyKey: commandId,
    campaignId,
    timelineId: timeline.timelineId,
    actorId,
    expectedRevision: timeline.revision,
    sourceTurnId: null,
    command: { type: "initialize_actor_resource", payload: { name, current: amount, max: amount } },
  };
  repository.executeInitializeActorResource(OWNER, envelope);
}

/**
 * Raises an existing resource through the public actor-resource mutator
 * (set capacity, then set current), or initializes it when absent.
 */
function ensureResourceAt(repository: Repository, campaignId: string, actorId: string, key: string, name: string, amount: number): void {
  const resources = repository.getM15ActorResources(OWNER, campaignId, actorId);
  if (!resources.some((resource) => resource.resourceId === name)) {
    initializeResource(repository, campaignId, actorId, key, name, amount);
    return;
  }
  const before = requireValue(repository.getActorResourceSnapshot(OWNER, campaignId, actorId), "Sintermark: actor resource snapshot is unavailable");
  const capacityCommand: ActorResourceCommand = {
    type: "set_actor_resource_capacity",
    campaignId,
    actorId,
    resourceId: name,
    capacity: amount,
    expectedRevision: before.revision,
    idempotencyKey: `${SEED_PREFIX}.res.${key}.${name}.cap`,
  };
  repository.mutateActorResource(OWNER, capacityCommand);
  const afterCapacity = requireValue(repository.getActorResourceSnapshot(OWNER, campaignId, actorId), "Sintermark: actor resource snapshot is unavailable");
  const currentCommand: ActorResourceCommand = {
    type: "set_actor_resource",
    campaignId,
    actorId,
    resourceId: name,
    current: amount,
    expectedRevision: afterCapacity.revision,
    idempotencyKey: `${SEED_PREFIX}.res.${key}.${name}.cur`,
  };
  repository.mutateActorResource(OWNER, currentCommand);
}

/**
 * Scoped SQL authoring seam for stackable rows (potions x10, ammunition, etc).
 *
 * The owned fixture `materializeInventoryEntry` only writes instanced quantity-1
 * rows and the owned `materializeConsumableEntry` is a healing-consumable
 * quantity-1 fixture that also mutates health; neither expresses a quantity.
 * This helper is strictly limited to a campaign owned by `local-owner`, an actor
 * in that campaign, and an exact item definition already publicly pinned in the
 * SRD pack with `mechanics.stackable === true`. It opens its own connection and
 * closes it immediately. It does not invent catalog content and does not touch
 * production repository code.
 */
function materializeStackableEntry(input: {
  dataDir: string;
  campaignId: string;
  actorId: string;
  entryId: string;
  item: ItemRef;
  quantity: number;
}): void {
  const db = new Database(path.join(input.dataDir, "velvet.sqlite"));
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.transaction(() => {
      const owned = db.prepare(`SELECT 1 FROM campaigns campaign
        JOIN campaign_memberships membership ON membership.campaign_id=campaign.id
          AND membership.principal_id=? AND membership.role='owner'
        JOIN campaign_actors actor ON actor.campaign_id=campaign.id AND actor.id=?
        WHERE campaign.id=? AND campaign.owner_principal_id=?`)
        .get(OWNER, input.actorId, input.campaignId, OWNER);
      if (!owned) throw new Error("Sintermark: stackable authoring target is not an owned campaign actor");

      const row = db.prepare(`SELECT definition.definition_json json FROM campaign_catalog_current_pins pin
        JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
        WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=? AND definition.kind='item' AND definition.definition_id=?`)
        .get(input.campaignId, input.item.packId, input.item.packVersion, input.item.definitionId) as { json: string } | undefined;
      if (!row) throw new Error(`Sintermark: item ${input.item.definitionId} is not publicly pinned`);
      const definition = itemCatalogDefinitionSchema.parse(JSON.parse(row.json));
      if (definition.mechanics.stackable !== true) {
        throw new Error(`Sintermark: item ${input.item.definitionId} is not stackable`);
      }

      const executionPin = db.prepare(`SELECT 1 FROM rpg_campaign_catalog_definitions_v25
        WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind='item' AND definition_id=?`)
        .get(input.campaignId, input.item.packId, input.item.packVersion, input.item.definitionId);
      if (!executionPin) throw new Error(`Sintermark: item ${input.item.definitionId} execution pin is unavailable`);

      const existing = db.prepare("SELECT entry_id FROM rpg_inventory_entries_v25 WHERE entry_id=?").get(input.entryId);
      if (existing) return;

      db.prepare(`INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,
        item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at)
        VALUES(?,?,?,?,?,'item',?,'stackable',?,NULL,NULL,0,?)`)
        .run(input.entryId, input.campaignId, input.actorId, input.item.packId, input.item.packVersion,
          input.item.definitionId, input.quantity, new Date().toISOString());
    }).immediate();
  } finally {
    db.close();
  }
}

/** Equips a real-profile item, unequipping any conflicting starter entry first. */
function equipItem(
  repository: Repository,
  campaignId: string,
  actorId: string,
  key: string,
  entryId: string,
  equip: NonNullable<InstancedItemPlan["equip"]>,
): void {
  const snapshot = requireValue(repository.getActorInventorySnapshot(OWNER, campaignId, actorId), "Sintermark: inventory snapshot is unavailable");
  const conflict = snapshot.equipment.find((entry) =>
    entry.slot === equip.slot && (equip.slot !== "hand" || entry.hand === equip.hand) && entry.entryId !== entryId);
  if (conflict) {
    repository.mutateInventoryForActor(OWNER, campaignId, actorId, {
      kind: "unequip",
      slot: conflict.slot,
      expectedRevision: snapshot.revision,
      idempotencyKey: `${SEED_PREFIX}.${key}.unequip.${conflict.entryId}`,
    });
  }
  const current = requireValue(repository.getActorInventorySnapshot(OWNER, campaignId, actorId), "Sintermark: inventory snapshot is unavailable");
  repository.mutateInventoryForActor(OWNER, campaignId, actorId, {
    kind: "equip",
    entryId,
    slot: equip.slot,
    ...(equip.hand ? { hand: equip.hand } : {}),
    ...(equip.grip ? { grip: equip.grip } : {}),
    expectedRevision: current.revision,
    idempotencyKey: `${SEED_PREFIX}.${key}.equip.${entryId}`,
  });
}

/** Faithful, human-readable guide to what this seed actually controls. */
export const SINTERMARK_PARTY_GUIDE = Object.freeze({
  seedVersion: "sintermark.v1",
  identity: {
    rulesProfileId: "srd-5.1:rules:starter-v1",
    packId: "srd-5.1:starter",
    packVersion: "1.7.0+a870b31918ec",
    rulesetId: "dnd-5e",
    rulesetVersion: "1.0.0",
    executableLevelCap: TARGET_LEVEL,
    capNote:
      "The SRD starter progression profile thresholds are [0, 300, 900]; level 3 is the highest level reachable through supported progression commands.",
  },
  controls:
    "Owner principal local-owner runs the hydrator; both actors are owner-controlled player characters. Gear is granted through the owned fixture seam (instanced) and one scoped SQL seam (stackable). No provider, network, or test call is made by this helper.",
  seamNotes: [
    "mutateInventoryForActor supports equip/unequip/consume/drop/gift only; add_inventory_item is not exposed and is not faked here.",
    "Non-stackable grants use createDeterministicE2ERepository(...).fixtures.materializeInventoryEntry.",
    "Stackable grants use materializeStackableEntry: owned campaign + public pin + stackable definition checked before insert.",
    "Magic items are carried reference metadata only; charges, granted powers, and passive modifiers do not execute and magic items are never equipped.",
  ],
  heroes: HEROES.map((hero) => ({
    key: hero.key,
    name: hero.name,
    concept: hero.archetype,
    ancestry: hero.ancestryDefinitionId,
    class: hero.classDefinitionId,
    subclass:
      hero.key === "tessel" ? "srd-5.1:subclass:school-of-evocation" : "srd-5.1:subclass:life-domain",
    preparedSpells: [...hero.preparedSpells],
    knownCantrips: hero.key === "tessel" ? ["srd-5.1:spell:fire-bolt", "srd-5.1:spell:ray-of-frost"] : [],
    supportedBattlePowers: [...hero.battlePowers],
    componentNotes: hero.componentNotes,
    reactionConstraints: hero.reactionConstraints,
    targetScores: { ...hero.targetScores },
    resourceBoosts: { health: "1000/1000", focus: "100/100", slot1: "100/100", slot2: "100/100" },
    equippedItems: hero.instancedItems.filter((item) => item.equip).map((item) => item.definitionId),
     referenceOnlyItems: hero.instancedItems.filter((item) => itemDefinitionOf(item.definitionId).mechanics.magic).map((item) => item.definitionId),
    stackableItems: hero.stackableItems.map((item) => ({ definitionId: item.definitionId, quantity: item.quantity })),
    attunementReference: [...hero.attunementItems],
  })),
});

/**
 * Creates and returns the two Sintermark heroes on an already-configured
 * `dnd-5e@1.0.0` campaign. Idempotent per persona name and deterministic per
 * command key. No file outside this module is modified.
 */
export async function createSintermarkParty(
  repository: Repository,
  campaignId: string,
): Promise<Array<{ personaId: string; actorId: string; campaignCharacterId: string; name: string }>> {
  const dataDir = process.env.VELVET_DATA_DIR;
  if (!dataDir || dataDir.trim() === "") {
    throw new Error("Sintermark: VELVET_DATA_DIR is required for the deterministic fixture seam");
  }

  const party: Array<{ personaId: string; actorId: string; campaignCharacterId: string; name: string }> = [];

  for (const hero of HEROES) {
    const existing = findExisting(repository, campaignId, hero.name);
    if (existing) {
      party.push(existing);
      continue;
    }

    const personaId = createPersona(repository, hero);

    const draft = repository.createCharacterDraft(OWNER, campaignId, {
      personaId,
      controllerPrincipalId: OWNER,
      durability: "durable",
      allocation: { method: "standard-array", scores: standardArrayFor(hero.primaryAttribute) },
      idempotencyKey: `${SEED_PREFIX}.${hero.key}.draft`,
    });
    const selections: UpdateCharacterDraftInput["selections"] = {
      race: referenceOf("race", hero.ancestryDefinitionId) as RaceRef,
      background: referenceOf("background", "srd-5.1:background:acolyte") as BackgroundRef,
      class: referenceOf("class", hero.classDefinitionId) as ClassRef,
      starterGrant: "kit",
      preparedSpells: hero.preparedSpells.map(spellRefFor),
    };
    const selected = repository.updateCharacterDraft(OWNER, draft.draft.id, {
      expectedRevision: draft.draft.revision,
      idempotencyKey: `${SEED_PREFIX}.${hero.key}.select`,
      selections,
    });
    const finalized = repository.finalizeCharacterDraft(OWNER, draft.draft.id, {
      expectedRevision: selected.draft.revision,
      idempotencyKey: `${SEED_PREFIX}.${hero.key}.finalize`,
    });
    const campaignCharacterId = finalized.receipt.campaignCharacterId;
    const actorId = finalized.receipt.actorId;

    advanceToTargetLevel(repository, campaignCharacterId, hero.key);
    party.push({ personaId, actorId, campaignCharacterId, name: hero.name });
  }

  // GM overlay after leveling: absolute targets, so ancestry is never double-applied.
  // Deterministic command keys make this loop idempotent across re-runs.
  for (const hero of HEROES) {
    const entry = party.find((candidate) => candidate.name === hero.name)!;
    for (const attributeId of SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS) {
      setActorAttribute(repository, campaignId, entry.actorId, hero.key, attributeId, hero.targetScores[attributeId]);
    }
    ensureResourceAt(repository, campaignId, entry.actorId, hero.key, "health", 1000);
    ensureResourceAt(repository, campaignId, entry.actorId, hero.key, "focus", 100);
    ensureResourceAt(repository, campaignId, entry.actorId, hero.key, "slot-1", 100);
    ensureResourceAt(repository, campaignId, entry.actorId, hero.key, "slot-2", 100);
  }

  // Inventory authoring through the owned fixture composition. It shares the
  // same velvet.sqlite as the caller's repository and is closed when finished.
  const fixture = createDeterministicE2ERepository({ dataDir });
  try {
    for (const hero of HEROES) {
      const entry = party.find((candidate) => candidate.name === hero.name)!;
      const expectedRevision = repository.getActorResourceSnapshot(OWNER, campaignId, entry.actorId)?.revision ?? 0;

      for (const item of hero.instancedItems) {
        const definition = itemDefinitionOf(item.definitionId);
        const entryId = `${SEED_PREFIX}.${hero.key}.item.${item.definitionId.replace(/^srd-5\.1:item:/, "")}`;
        fixture.fixtures.materializeInventoryEntry({
          principalId: OWNER,
          campaignId,
          actorId: entry.actorId,
          expectedRevision,
          entryId,
          item: definition.reference as ItemRef,
        });
      }

      for (const item of hero.stackableItems) {
        const reference = itemRefFor(item.definitionId);
        const entryId = `${SEED_PREFIX}.${hero.key}.stack.${item.definitionId.replace(/^srd-5\.1:item:/, "")}`;
        // Pin through the owned fixture helper, then author the quantity row.
        fixture.fixtures.materializePinnedItemExecution({ principalId: OWNER, campaignId, item: reference });
        materializeStackableEntry({ dataDir, campaignId, actorId: entry.actorId, entryId, item: reference, quantity: item.quantity });
      }
    }
  } finally {
    fixture.repository.close();
  }

  // Equip only real-profile equipment through the public inventory command.
  for (const hero of HEROES) {
    const entry = party.find((candidate) => candidate.name === hero.name)!;
    for (const item of hero.instancedItems) {
      if (!item.equip) continue;
      const definition = itemDefinitionOf(item.definitionId);
      if (!definition.mechanics.engineDetails?.equipmentProfile) {
        throw new Error(`Sintermark: ${item.definitionId} has no SRD equipment profile and cannot be equipped`);
      }
      const entryId = `${SEED_PREFIX}.${hero.key}.item.${item.definitionId.replace(/^srd-5\.1:item:/, "")}`;
      equipItem(repository, campaignId, entry.actorId, hero.key, entryId, item.equip);
    }
  }

  if (party.length !== HEROES.length) throw new Error("Sintermark: party did not materialize both heroes");
  return party;
}

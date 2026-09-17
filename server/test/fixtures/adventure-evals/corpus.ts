import type { AdventureSelectionCandidate } from "../../../src/agent/systemOneAdventure.js";

/**
 * Frozen projection corpus for the L2 adventure-selection benchmark
 * (`scripts/evaluate-system-one-adventure-lane.ts`).
 *
 * There is no repository fixture for an adventure turn: candidates are issued per turn by the
 * server. This corpus therefore hand-projects realistic server-issued candidate sets (opaque
 * exact ids, per-candidate digests, real `exact_*` tool kinds and server-style labels) next to
 * the declaration a turn would carry, and labels the exact candidate the lane should commit —
 * or `null` when the only defensible call is to defer.
 *
 * `preferred` is the single best call; `acceptable` is every defensible outcome, including
 * deferral (`null`). The benchmark grades membership in `acceptable` (the asserted-subset
 * figure) and reports exact `preferred` agreement alongside it. A case with `holdout: true`
 * is excluded from the Platt fit so the reported calibration is out of sample.
 *
 * Candidate ids and digests are opaque fixtures: only their shape is meaningful here.
 */
export const ADVENTURE_EVAL_CORPUS_VERSION = "adventure-evals-v1" as const;

/** The distinct failure modes the L2 lane must separate. */
export type AdventureEvalCategory =
  | "direct-match"
  | "ambiguous"
  | "multi-family"
  | "unsupported"
  | "unadvertised"
  | "small-talk";

/** One hand-labeled declaration projected against the candidates a turn advertised. */
export interface AdventureEvalCase {
  id: string;
  category: AdventureEvalCategory;
  declaration: string;
  candidates: AdventureSelectionCandidate[];
  expected: {
    /** The single best call, or `null` when the lane should defer and select nothing. */
    preferred: string | null;
    /** Every defensible outcome, including `null` when a deferral is defensible. */
    acceptable: readonly (string | null)[];
  };
  /** Held out of the Platt fit; the held-out rows are the unbiased calibration estimate. */
  holdout: boolean;
}

/** A deterministic 64-hex fixture digest; server digests are opaque, only their shape matters here. */
const digest = (seed: string): string => seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);

const candidate = (
  candidateId: string,
  digestSeed: string,
  kind: string,
  label: string,
): AdventureSelectionCandidate => ({ candidateId, digest: digest(digestSeed), kind, label });

const TRAVEL = "exact_actor_travel.select";
const CHECK = "exact_srd_check.select";
const INVENTORY = "exact_inventory_action.select";
const COMMERCE = "exact_vendor_commerce.select";
const POWER = "exact_power_use.select";
const REST = "exact_rest.select";
const COMBAT_CONSUMABLE = "exact_combat_consumable.select";
const COMBAT_POWER = "exact_combat_power.select";
const QUEST_LIFECYCLE = "exact_quest_lifecycle.select";
const PROGRESSION = "exact_progression_apply.select";

/**
 * 30 declarations across six categories, 9 of them held out. Candidate sets are modeled on the
 * real server-issued shapes: travel, SRD check, inventory, commerce, power, rest, combat
 * consumable, combat power, quest lifecycle, and progression projections all appear, and one
 * case advertises no candidates at all.
 */
export const ADVENTURE_EVAL_CASES: readonly AdventureEvalCase[] = [
  // direct-match: the declaration clearly names one advertised candidate.
  {
    id: "direct-travel-mill",
    category: "direct-match",
    holdout: false,
    declaration: "I walk up the road to the mill.",
    candidates: [
      candidate("travel:mill-01", "d001", TRAVEL, "Travel to the mill"),
      candidate("travel:harbor-02", "d002", TRAVEL, "Travel to the harbor"),
    ],
    expected: { preferred: "travel:mill-01", acceptable: ["travel:mill-01"] },
  },
  {
    id: "direct-travel-harbor",
    category: "direct-match",
    holdout: true,
    declaration: "We head down the switchbacks to the harbor.",
    candidates: [
      candidate("travel:mill-03", "d003", TRAVEL, "Travel to the mill"),
      candidate("travel:harbor-04", "d004", TRAVEL, "Travel to the harbor"),
    ],
    expected: { preferred: "travel:harbor-04", acceptable: ["travel:harbor-04"] },
  },
  {
    id: "direct-check-climb",
    category: "direct-match",
    holdout: false,
    declaration: "I haul myself over the mill wall.",
    candidates: [
      candidate("check:climb-05", "d005", CHECK, "Strength (Athletics), Easy difficulty, normal"),
      candidate("check:stealth-06", "d006", CHECK, "Dexterity (Stealth), Medium difficulty, normal"),
    ],
    expected: { preferred: "check:climb-05", acceptable: ["check:climb-05"] },
  },
  {
    id: "direct-commerce-rope",
    category: "direct-match",
    holdout: false,
    declaration: "I buy a coil of rope from Harbor Supplies and count out the two gold.",
    candidates: [
      candidate("shop:buy-rope-07", "d007", COMMERCE, "Buy rope from Harbor Supplies for 2 gp"),
      candidate("shop:sell-ring-08", "d008", COMMERCE, "Sell the silver ring to Harbor Supplies for 5 gp"),
    ],
    expected: { preferred: "shop:buy-rope-07", acceptable: ["shop:buy-rope-07"] },
  },
  {
    id: "direct-quest-accept",
    category: "direct-match",
    holdout: true,
    declaration: "I sign the harbormaster's ledger and accept the harbor quest.",
    candidates: [
      candidate("quest:accept-harbor-09", "d009", QUEST_LIFECYCLE, "Accept the harbor quest"),
      candidate("quest:claim-harbor-10", "d010", QUEST_LIFECYCLE, "Claim the harbor quest reward"),
    ],
    expected: { preferred: "quest:accept-harbor-09", acceptable: ["quest:accept-harbor-09"] },
  },
  {
    id: "direct-progression-level",
    category: "direct-match",
    holdout: false,
    declaration: "The training is done; I advance to level 3.",
    candidates: [
      candidate("level:advance-11", "d011", PROGRESSION, "Advance to level 3"),
    ],
    expected: { preferred: "level:advance-11", acceptable: ["level:advance-11"] },
  },

  // ambiguous: several same-family candidates, one clearly preferred (or route ambiguity,
  // where either pick and a deferral are all defensible).
  {
    id: "ambig-rest-long-short",
    category: "ambiguous",
    holdout: false,
    declaration: "We make camp for the night and take a long rest by the mill.",
    candidates: [
      candidate("rest:long-12", "d012", REST, "Take a long rest"),
      candidate("rest:short-13", "d013", REST, "Take a short rest"),
    ],
    expected: { preferred: "rest:long-12", acceptable: ["rest:long-12"] },
  },
  {
    id: "ambig-travel-watchtower",
    category: "ambiguous",
    holdout: false,
    declaration: "We take the north road to the old watchtower.",
    candidates: [
      candidate("travel:mill-14", "d014", TRAVEL, "Travel to the mill"),
      candidate("travel:harbor-15", "d015", TRAVEL, "Travel to the harbor"),
      candidate("travel:watchtower-16", "d016", TRAVEL, "Travel to the old watchtower"),
    ],
    expected: { preferred: "travel:watchtower-16", acceptable: ["travel:watchtower-16"] },
  },
  {
    id: "ambig-travel-two-roads",
    category: "ambiguous",
    holdout: false,
    declaration: "I set out for the mill, whichever road looks quicker.",
    candidates: [
      candidate("travel:mill-east-17", "d017", TRAVEL, "Travel to the mill by the east road"),
      candidate("travel:mill-west-18", "d018", TRAVEL, "Travel to the mill by the west road"),
    ],
    // Route ambiguity: deferring is the single best call, but either advertised route is defensible.
    expected: { preferred: null, acceptable: [null, "travel:mill-east-17", "travel:mill-west-18"] },
  },
  {
    id: "ambig-power-target",
    category: "ambiguous",
    holdout: false,
    declaration: "I trace the rune and cast Mending Light on Bryn's cracked shield.",
    candidates: [
      candidate("power:mending-bryn-19", "d019", POWER, "Cast Mending Light on Bryn"),
      candidate("power:mending-wheel-20", "d020", POWER, "Cast Mending Light on the mill wheel"),
    ],
    expected: { preferred: "power:mending-bryn-19", acceptable: ["power:mending-bryn-19"] },
  },
  {
    id: "ambig-combat-power-target",
    category: "ambiguous",
    holdout: true,
    declaration: "I hurl a fire bolt at the bandit on the ridge.",
    candidates: [
      candidate("combat:firebolt-wolf-21", "d021", COMBAT_POWER, "Cast fire bolt on the wolf"),
      candidate("combat:firebolt-bandit-22", "d022", COMBAT_POWER, "Cast fire bolt on the bandit"),
    ],
    expected: { preferred: "combat:firebolt-bandit-22", acceptable: ["combat:firebolt-bandit-22"] },
  },
  {
    id: "ambig-commerce-sell",
    category: "ambiguous",
    holdout: true,
    declaration: "I hand the silver ring across the counter and take the five gold.",
    candidates: [
      candidate("shop:buy-rope-23", "d023", COMMERCE, "Buy rope from Harbor Supplies for 2 gp"),
      candidate("shop:sell-ring-24", "d024", COMMERCE, "Sell the silver ring to Harbor Supplies for 5 gp"),
    ],
    expected: { preferred: "shop:sell-ring-24", acceptable: ["shop:sell-ring-24"] },
  },
  {
    id: "ambig-consumable-target",
    category: "ambiguous",
    holdout: false,
    declaration: "Aster is bleeding badly; I force a healing potion down her throat.",
    candidates: [
      candidate("consumable:heal-aster-25", "d025", COMBAT_CONSUMABLE, "Use one healing potion on Aster"),
      candidate("consumable:heal-bryn-26", "d026", COMBAT_CONSUMABLE, "Use one healing potion on Bryn"),
    ],
    expected: { preferred: "consumable:heal-aster-25", acceptable: ["consumable:heal-aster-25"] },
  },

  // multi-family: candidates span different tool families, including a check candidate that
  // looks like travel and must not win.
  {
    id: "multi-check-vs-travel-trap",
    category: "multi-family",
    holdout: false,
    declaration: "I put my shoulder to the mill gate and force it open.",
    candidates: [
      candidate("travel:mill-27", "d027", TRAVEL, "Travel to the mill"),
      candidate("check:force-gate-28", "d028", CHECK, "Strength (Athletics), Easy difficulty, normal — force the mill gate"),
    ],
    // Travel to the mill is the plausible confident wrong pick; forcing the gate is the check.
    expected: { preferred: "check:force-gate-28", acceptable: ["check:force-gate-28"] },
  },
  {
    id: "multi-row-vs-travel",
    category: "multi-family",
    holdout: false,
    declaration: "I take up the oars and row across the bay.",
    candidates: [
      candidate("travel:harbor-29", "d029", TRAVEL, "Travel to the harbor"),
      candidate("check:row-30", "d030", CHECK, "Strength (Athletics), Medium difficulty, normal — row across the bay"),
    ],
    expected: { preferred: "check:row-30", acceptable: ["check:row-30"] },
  },
  {
    id: "multi-quest-vs-travel",
    category: "multi-family",
    holdout: false,
    declaration: "I sign the harbormaster's ledger and take on the harbor quest.",
    candidates: [
      candidate("quest:accept-harbor-31", "d031", QUEST_LIFECYCLE, "Accept the harbor quest"),
      candidate("travel:harbor-32", "d032", TRAVEL, "Travel to the harbor"),
    ],
    expected: { preferred: "quest:accept-harbor-31", acceptable: ["quest:accept-harbor-31"] },
  },
  {
    id: "multi-commerce-vs-inventory",
    category: "multi-family",
    holdout: false,
    declaration: "I count out two gold and pay Harbor Supplies for the rope.",
    candidates: [
      candidate("shop:buy-rope-33", "d033", COMMERCE, "Buy rope from Harbor Supplies for 2 gp"),
      candidate("item:equip-key-34", "d034", INVENTORY, "Equip the bronze key"),
    ],
    expected: { preferred: "shop:buy-rope-33", acceptable: ["shop:buy-rope-33"] },
  },
  {
    id: "multi-power-vs-rest",
    category: "multi-family",
    holdout: true,
    declaration: "We camp at the mill and I take a long rest.",
    candidates: [
      candidate("rest:long-35", "d035", REST, "Take a long rest"),
      candidate("power:mending-wheel-36", "d036", POWER, "Cast Mending Light on the mill wheel"),
    ],
    expected: { preferred: "rest:long-35", acceptable: ["rest:long-35"] },
  },
  {
    id: "multi-combat-vs-power",
    category: "multi-family",
    holdout: true,
    declaration: "I fling a fire bolt at the wolf.",
    candidates: [
      candidate("combat:firebolt-wolf-37", "d037", COMBAT_POWER, "Cast fire bolt on the wolf"),
      candidate("power:mending-bryn-38", "d038", POWER, "Cast Mending Light on Bryn"),
    ],
    expected: { preferred: "combat:firebolt-wolf-37", acceptable: ["combat:firebolt-wolf-37"] },
  },

  // unsupported: advertised actions the declaration does not support committing (a question,
  // a hypothetical, or two intents at once). The lane must defer.
  {
    id: "unsupported-question",
    category: "unsupported",
    holdout: false,
    declaration: "Which road leads to the mill, and is there time to rest?",
    candidates: [
      candidate("travel:mill-39", "d039", TRAVEL, "Travel to the mill"),
      candidate("rest:long-40", "d040", REST, "Take a long rest"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },
  {
    id: "unsupported-hypothetical",
    category: "unsupported",
    holdout: false,
    declaration: "If the wall were lower, I would climb it.",
    candidates: [
      candidate("check:climb-41", "d041", CHECK, "Strength (Athletics), Easy difficulty, normal"),
      candidate("travel:mill-42", "d042", TRAVEL, "Travel to the mill"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },
  {
    id: "unsupported-two-actions",
    category: "unsupported",
    holdout: false,
    declaration: "I equip the bronze key and buy rope from Harbor Supplies.",
    candidates: [
      candidate("item:equip-key-43", "d043", INVENTORY, "Equip the bronze key"),
      candidate("shop:buy-rope-44", "d044", COMMERCE, "Buy rope from Harbor Supplies for 2 gp"),
    ],
    // Two commits: no single advertised candidate matches exactly one declared action.
    expected: { preferred: null, acceptable: [null] },
  },
  {
    id: "unsupported-choice-question",
    category: "unsupported",
    holdout: true,
    declaration: "Should I mend the wheel now, or rest first?",
    candidates: [
      candidate("rest:short-45", "d045", REST, "Take a short rest"),
      candidate("power:mending-wheel-46", "d046", POWER, "Cast Mending Light on the mill wheel"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },

  // unadvertised: the declaration asks for an action no candidate offers. The lane must
  // defer rather than bend an adjacent advertised candidate onto it.
  {
    id: "unadvertised-fireball",
    category: "unadvertised",
    holdout: false,
    declaration: "I cast fireball at the goblins.",
    candidates: [
      candidate("travel:mill-47", "d047", TRAVEL, "Travel to the mill"),
      candidate("check:climb-48", "d048", CHECK, "Strength (Athletics), Easy difficulty, normal"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },
  {
    id: "unadvertised-destination",
    category: "unadvertised",
    holdout: false,
    declaration: "I ride for Greyhold.",
    candidates: [
      candidate("travel:mill-49", "d049", TRAVEL, "Travel to the mill"),
      candidate("travel:harbor-50", "d050", TRAVEL, "Travel to the harbor"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },
  {
    id: "unadvertised-sword",
    category: "unadvertised",
    holdout: true,
    declaration: "I draw my grandfather's sword.",
    candidates: [
      candidate("item:equip-key-51", "d051", INVENTORY, "Equip the bronze key"),
      candidate("shop:buy-rope-52", "d052", COMMERCE, "Buy rope from Harbor Supplies for 2 gp"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },
  {
    id: "unadvertised-no-candidates",
    category: "unadvertised",
    holdout: false,
    declaration: "I attack the wolf with my sword.",
    candidates: [],
    // With no advertised candidates there is nothing to select; the lane defers by construction.
    expected: { preferred: null, acceptable: [null] },
  },

  // small-talk: no commitment to an action at all.
  {
    id: "smalltalk-weather",
    category: "small-talk",
    holdout: false,
    declaration: "Lovely weather for the harvest, isn't it?",
    candidates: [
      candidate("travel:mill-53", "d053", TRAVEL, "Travel to the mill"),
      candidate("rest:long-54", "d054", REST, "Take a long rest"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },
  {
    id: "smalltalk-innkeeper",
    category: "small-talk",
    holdout: false,
    declaration: "I greet the innkeeper and ask how business has been.",
    candidates: [
      candidate("shop:buy-rope-55", "d055", COMMERCE, "Buy rope from Harbor Supplies for 2 gp"),
      candidate("quest:accept-harbor-56", "d056", QUEST_LIFECYCLE, "Accept the harbor quest"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },
  {
    id: "smalltalk-joke",
    category: "small-talk",
    holdout: true,
    declaration: "I tell Bryn the one about the miller's cat.",
    candidates: [
      candidate("check:climb-57", "d057", CHECK, "Strength (Athletics), Easy difficulty, normal"),
      candidate("travel:mill-58", "d058", TRAVEL, "Travel to the mill"),
    ],
    expected: { preferred: null, acceptable: [null] },
  },
];

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validates the frozen corpus shape: unique ids, non-empty declarations, advertised ids with
 * unique 64-hex digests, and a preferred outcome that is part of a non-empty acceptable set.
 * Mirrors the validation style of `server/test/fixtures/memory-evals/corpus.ts`.
 */
export function validateAdventureEvalCases(cases: readonly AdventureEvalCase[]): void {
  const ids = new Set<string>();
  let holdouts = 0;
  for (const item of cases) {
    if (!item.id.trim() || ids.has(item.id)) throw new Error(`invalid adventure evaluation id: ${item.id}`);
    ids.add(item.id);
    if (!item.declaration.trim()) throw new Error(`empty adventure declaration: ${item.id}`);
    if (!item.expected.acceptable.length) throw new Error(`no acceptable outcome: ${item.id}`);
    const candidateIds = new Set<string>();
    const digests = new Set<string>();
    for (const entry of item.candidates) {
      if (!entry.candidateId.trim() || candidateIds.has(entry.candidateId)) {
        throw new Error(`duplicate or empty candidate id in ${item.id}: ${entry.candidateId}`);
      }
      candidateIds.add(entry.candidateId);
      if (!DIGEST_PATTERN.test(entry.digest) || digests.has(entry.digest)) {
        throw new Error(`invalid candidate digest in ${item.id}: ${entry.candidateId}`);
      }
      digests.add(entry.digest);
      if (!entry.kind.trim() || !entry.label.trim()) {
        throw new Error(`incomplete candidate in ${item.id}: ${entry.candidateId}`);
      }
    }
    if (item.expected.preferred === null) {
      // A deferring preference must list null as acceptable; an empty candidate set can only defer.
      if (!item.expected.acceptable.includes(null)) {
        throw new Error(`deferring preference must list null as acceptable: ${item.id}`);
      }
    } else {
      if (!candidateIds.has(item.expected.preferred)) {
        throw new Error(`preferred candidate is not advertised: ${item.id}`);
      }
      if (!item.expected.acceptable.includes(item.expected.preferred)) {
        throw new Error(`preferred candidate is not acceptable: ${item.id}`);
      }
    }
    for (const acceptable of item.expected.acceptable) {
      if (acceptable !== null && !candidateIds.has(acceptable)) {
        throw new Error(`acceptable candidate is not advertised: ${item.id}`);
      }
    }
    if (item.holdout) holdouts += 1;
  }
  if (holdouts === 0) throw new Error("adventure evaluation corpus needs at least one holdout case");
  if (holdouts === cases.length) throw new Error("adventure evaluation corpus needs development cases");
}

validateAdventureEvalCases(ADVENTURE_EVAL_CASES);

#!/usr/bin/env node
/**
 * Live evaluation of the `freeform-materialization` System One (Jev) lane against a frozen,
 * provider-free holdout corpus.
 *
 * The corpus is provider-free: every case is a hand-authored player attempt plus the closed,
 * server-authored candidate set the deterministic free-form classifier would have produced. The
 * cases carry no provider output. The evaluation itself runs the real System One adapter once per
 * case (like the narration and rerank evaluators), composes through
 * `composeFreeformMaterializationDecision`, grades the composition against the handwritten label,
 * fits a monotonic Platt map on the development split, and evaluates the promotion gate on the
 * calibrated signal.
 *
 * Grading is dispositional, not exact-string:
 *   - an `act` label requires the composed band to be `act` and the selected candidate id and kind
 *     to match the labelled server-authored candidate (a wrong-candidate trap is an acted error);
 *   - a `fallback` label (a hold, an illegal attempt, or a known/duplicate materialization) is
 *     correct only when the composed band is not `act`. Acting there is a false act and an acted
 *     error.
 * Only `act` samples score the gate; a deferral is coverage, never an acted error.
 *
 * A passing gate on a well-behaved model is a promotion candidate, not proof: the corpus is small,
 * provider-free in its ground truth, and the acted subset may carry no observed error. The
 * recorded metrics, calibration map, and (only on a genuine pass) the promotion record name the
 * exact evaluation binding for the real runtime settings.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-freeform-materialization-lane.ts [--repeat 1] [--out docs/system-one-freeform-materialization-benchmark.md]
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCalibration, fitPlattCalibration, type PlattCalibration } from "../server/src/agent/systemOneCalibration.js";
import {
  FREEFORM_MATERIALIZATION_ACTION_FAMILY,
  buildFreeformMaterializationQuestions,
  composeFreeformMaterializationDecision,
  type FreeformMaterializationCandidate,
  type FreeformMaterializationDecision,
  type FreeformMaterializationKind,
} from "../server/src/agent/systemOneFreeformMaterialization.js";
import type { SystemOneBand } from "../server/src/agent/systemOnePolicy.js";
import { systemOneEvaluationBinding } from "../server/src/agent/systemOneBinding.js";
import { wilsonLowerBound } from "../server/src/agent/systemOneGateStatistics.js";
import {
  DEFAULT_SYSTEM_ONE_LANE_GATES,
  evaluatePromotionGate,
  type CalibrationMetrics as PromotionCalibrationMetrics,
  type SystemOnePromotionRecord,
  type SystemOnePromotionResult,
} from "../server/src/agent/systemOnePromotion.js";
import { defaultSystemOneSettings } from "../server/src/defaults.js";
import { completeWithSystemOne, type SystemOneAnswer } from "../server/src/provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds, SystemOneSettings } from "../server/src/types.js";
import { gradeCalibration } from "../server/test/evals/dmGraders.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_OUT = "docs/system-one-freeform-materialization-benchmark.md";
const PROMOTION_LANE = "freeform-materialization" as const;
const EVIDENCE = "docs/system-one-freeform-materialization-benchmark.md";
const CAMPAIGN_ID = "campaign-freeform-corpus";
const SESSION_ID = "session-freeform-corpus";

/** The corpus categories. Positives are one or more per materialization kind; negatives are the hard cases. */
export type FreeformCaseCategory =
  | "materialize-location"
  | "materialize-npc"
  | "hostile-encounter"
  | "shop-stock"
  | "new-clue"
  | "materialize-faction"
  | "materialize-quest"
  | "materialize-rumor"
  | "hold"
  | "illegal"
  | "duplicate";

/** The hand-labelled composition the lane should produce for a case. */
export interface FreeformBenchmarkExpectation {
  band: "act" | "fallback";
  /** The exact server-authored candidate id an `act` label requires; null for a must-hold label. */
  candidateId: string | null;
  kind: FreeformMaterializationKind | null;
}

/** One frozen, provider-free benchmark case: a bounded attempt plus its closed candidate set. */
export interface FreeformMaterializationBenchmarkCase {
  id: string;
  category: FreeformCaseCategory;
  attempt: string;
  candidates: FreeformMaterializationCandidate[];
  expected: FreeformBenchmarkExpectation;
  /** Held out of the Platt fit so the reported calibration is out of sample. */
  holdout: boolean;
}

const c = (
  kind: FreeformMaterializationKind,
  label: string,
  candidateId: string,
): FreeformMaterializationCandidate => ({ candidateId, kind, label });

/**
 * The frozen holdout. Positive cases carry at least one distractor candidate (and several embed a
 * deliberate wrong-candidate trap: two same-kind candidates where the attempt disambiguates one).
 * Negative cases are `hold` (narration is sufficient), `illegal` (adding content now violates canon
 * or readiness), and `duplicate` (the attempt names content the campaign already has, so no new
 * durable materialization is required). A no-error positive corpus is a promotion candidate, not
 * proof, which is why the negatives exist.
 */
export const FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS: readonly FreeformMaterializationBenchmarkCase[] = [
  // ---------------------------- materialize-location (8) ----------------------------
  { id: "loc-1", category: "materialize-location", holdout: false,
    attempt: "I set out for the Glassblower's District, past the old tannery.",
    candidates: [c("materialize-location", "Glassblower's District", "ffc-loc-glassblower"), c("materialize-npc", "The glassblower", "ffn-glassblower")],
    expected: { band: "act", candidateId: "ffc-loc-glassblower", kind: "materialize-location" } },
  { id: "loc-2", category: "materialize-location", holdout: true,
    attempt: "We walk to the Sunken Chapel by the river wall.",
    candidates: [c("materialize-location", "The Sunken Chapel", "ffc-loc-sunken-chapel"), c("new-clue", "The river wall sigil", "ffl-river-sigil")],
    expected: { band: "act", candidateId: "ffc-loc-sunken-chapel", kind: "materialize-location" } },
  { id: "loc-3", category: "materialize-location", holdout: false,
    attempt: "I travel to the Old Watchtower on the ridge.",
    candidates: [c("materialize-location", "The Old Watchtower", "ffc-loc-watchtower"), c("hostile-encounter", "A patrol on the ridge", "ffe-ridge-patrol")],
    expected: { band: "act", candidateId: "ffc-loc-watchtower", kind: "materialize-location" } },
  { id: "loc-4", category: "materialize-location", holdout: false,
    attempt: "Let's head down to the Dockside Market.",
    candidates: [c("materialize-location", "The Dockside Market", "ffc-loc-dockside"), c("shop-stock", "A dockside stall", "ffsc-dockside-stall")],
    expected: { band: "act", candidateId: "ffc-loc-dockside", kind: "materialize-location" } },
  { id: "loc-5", category: "materialize-location", holdout: true,
    attempt: "I make for the Ashen Grove beyond the bridge.",
    candidates: [c("materialize-location", "The Ashen Grove", "ffc-loc-ashen-grove"), c("materialize-npc", "A hermit of the grove", "ffn-ashen-hermit")],
    expected: { band: "act", candidateId: "ffc-loc-ashen-grove", kind: "materialize-location" } },
  { id: "loc-6", category: "materialize-location", holdout: false,
    // Wrong-candidate trap: two locations are offered; the attempt names only the mill.
    attempt: "We ride to the ruined mill at the ford.",
    candidates: [c("materialize-location", "The Ford Crossing", "ffc-loc-ford"), c("materialize-location", "The Ruined Mill", "ffc-loc-mill")],
    expected: { band: "act", candidateId: "ffc-loc-mill", kind: "materialize-location" } },
  { id: "loc-7", category: "materialize-location", holdout: false,
    attempt: "I go north to the Frozen Steps.",
    candidates: [c("materialize-location", "The Frozen Steps", "ffc-loc-frozen-steps"), c("hostile-encounter", "Something on the steps", "ffe-frozen-steps")],
    expected: { band: "act", candidateId: "ffc-loc-frozen-steps", kind: "materialize-location" } },
  { id: "loc-8", category: "materialize-location", holdout: true,
    attempt: "I head for the lighthouse at the point.",
    candidates: [c("materialize-location", "The Point Lighthouse", "ffc-loc-lighthouse"), c("new-clue", "A keeper's log", "ffl-keeper-log")],
    expected: { band: "act", candidateId: "ffc-loc-lighthouse", kind: "materialize-location" } },

  // ---------------------------- materialize-npc (8) ----------------------------
  { id: "npc-1", category: "materialize-npc", holdout: false,
    attempt: "I ask the blacksmith, Marta, about the north gate.",
    candidates: [c("materialize-npc", "Marta the blacksmith", "ffn-marta"), c("materialize-location", "The north gate", "ffc-north-gate")],
    expected: { band: "act", candidateId: "ffn-marta", kind: "materialize-npc" } },
  { id: "npc-2", category: "materialize-npc", holdout: true,
    attempt: "I greet Captain Vale and ask for orders.",
    candidates: [c("materialize-npc", "Captain Vale", "ffn-vale"), c("hostile-encounter", "Vale's guards", "ffe-vale-guards")],
    expected: { band: "act", candidateId: "ffn-vale", kind: "materialize-npc" } },
  { id: "npc-3", category: "materialize-npc", holdout: false,
    attempt: "I speak with the innkeeper, Hob Corr.",
    candidates: [c("materialize-npc", "Hob Corr the innkeeper", "ffn-hob-corr"), c("new-clue", "The inn's ledger", "ffl-inn-ledger")],
    expected: { band: "act", candidateId: "ffn-hob-corr", kind: "materialize-npc" } },
  { id: "npc-4", category: "materialize-npc", holdout: false,
    attempt: "I approach the herbalist named Sela.",
    candidates: [c("materialize-npc", "Sela the herbalist", "ffn-sela"), c("shop-stock", "Sela's remedies", "ffsc-sela-remedies")],
    expected: { band: "act", candidateId: "ffn-sela", kind: "materialize-npc" } },
  { id: "npc-5", category: "materialize-npc", holdout: true,
    attempt: "I call out to the ferryman, Old Doran.",
    candidates: [c("materialize-npc", "Old Doran the ferryman", "ffn-doran"), c("materialize-location", "The ferry landing", "ffc-ferry-landing")],
    expected: { band: "act", candidateId: "ffn-doran", kind: "materialize-npc" } },
  { id: "npc-6", category: "materialize-npc", holdout: false,
    // Wrong-candidate trap: two people are offered; the attempt names the watch captain only.
    attempt: "I introduce myself to the watch captain, Rook.",
    candidates: [c("materialize-npc", "Rook the watch captain", "ffn-rook"), c("materialize-npc", "Rook's scribe", "ffn-rook-scribe")],
    expected: { band: "act", candidateId: "ffn-rook", kind: "materialize-npc" } },
  { id: "npc-7", category: "materialize-npc", holdout: false,
    attempt: "I ask the merchant Fenn about the road ahead.",
    candidates: [c("materialize-npc", "Fenn the merchant", "ffn-fenn"), c("materialize-location", "The east road", "ffc-east-road")],
    expected: { band: "act", candidateId: "ffn-fenn", kind: "materialize-npc" } },
  { id: "npc-8", category: "materialize-npc", holdout: true,
    attempt: "I seek out the priest, Brother Ansel.",
    candidates: [c("materialize-npc", "Brother Ansel", "ffn-ansel"), c("new-clue", "Ansel's scripture", "ffl-ansel-scripture")],
    expected: { band: "act", candidateId: "ffn-ansel", kind: "materialize-npc" } },

  // ---------------------------- hostile-encounter (8) ----------------------------
  { id: "enc-1", category: "hostile-encounter", holdout: false,
    attempt: "I draw my sword and attack the goblins at the camp.",
    candidates: [c("hostile-encounter", "Goblin camp", "ffe-goblin-camp"), c("materialize-location", "The goblin camp", "ffc-goblin-camp")],
    expected: { band: "act", candidateId: "ffe-goblin-camp", kind: "hostile-encounter" } },
  { id: "enc-2", category: "hostile-encounter", holdout: true,
    attempt: "I charge the wolf pack with my spear.",
    candidates: [c("hostile-encounter", "The wolf pack", "ffe-wolf-pack"), c("materialize-npc", "A wounded trapper", "ffn-trappers")],
    expected: { band: "act", candidateId: "ffe-wolf-pack", kind: "hostile-encounter" } },
  { id: "enc-3", category: "hostile-encounter", holdout: false,
    attempt: "We ambush the bandits on the road.",
    candidates: [c("hostile-encounter", "The roadside bandits", "ffe-road-bandits"), c("new-clue", "Signs of the bandits", "ffl-bandit-signs")],
    expected: { band: "act", candidateId: "ffe-road-bandits", kind: "hostile-encounter" } },
  { id: "enc-4", category: "hostile-encounter", holdout: false,
    attempt: "I fire my bow at the approaching troll.",
    candidates: [c("hostile-encounter", "The bridge troll", "ffe-bridge-troll"), c("materialize-location", "The bridge", "ffc-bridge")],
    expected: { band: "act", candidateId: "ffe-bridge-troll", kind: "hostile-encounter" } },
  { id: "enc-5", category: "hostile-encounter", holdout: true,
    attempt: "I swing my axe at the skeleton.",
    candidates: [c("hostile-encounter", "The risen skeleton", "ffe-skeleton"), c("new-clue", "The defiled grave", "ffl-defiled-grave")],
    expected: { band: "act", candidateId: "ffe-skeleton", kind: "hostile-encounter" } },
  { id: "enc-6", category: "hostile-encounter", holdout: false,
    attempt: "I threaten the thugs and raise my blade.",
    candidates: [c("hostile-encounter", "The alley thugs", "ffe-alley-thugs"), c("materialize-npc", "The alley lookout", "ffn-alley-lookout")],
    expected: { band: "act", candidateId: "ffe-alley-thugs", kind: "hostile-encounter" } },
  { id: "enc-7", category: "hostile-encounter", holdout: false,
    attempt: "I lunge at the giant spider.",
    candidates: [c("hostile-encounter", "The giant spider", "ffe-giant-spider"), c("new-clue", "Old webbing", "ffl-old-webbing")],
    expected: { band: "act", candidateId: "ffe-giant-spider", kind: "hostile-encounter" } },
  { id: "enc-8", category: "hostile-encounter", holdout: true,
    attempt: "I open fire on the raiders.",
    candidates: [c("hostile-encounter", "The river raiders", "ffe-river-raiders"), c("materialize-location", "The river ford", "ffc-river-ford")],
    expected: { band: "act", candidateId: "ffe-river-raiders", kind: "hostile-encounter" } },

  // ---------------------------- shop-stock (6) ----------------------------
  { id: "shop-1", category: "shop-stock", holdout: false,
    attempt: "I ask the merchant to show me her wares.",
    candidates: [c("shop-stock", "The merchant's wares", "ffsc-merchant-wares"), c("materialize-npc", "The merchant", "ffn-merchant")],
    expected: { band: "act", candidateId: "ffsc-merchant-wares", kind: "shop-stock" } },
  { id: "shop-2", category: "shop-stock", holdout: true,
    attempt: "I browse the apothecary's stock of potions.",
    candidates: [c("shop-stock", "The apothecary's stock", "ffsc-apothecary-stock"), c("materialize-npc", "The apothecary", "ffn-apothecary")],
    expected: { band: "act", candidateId: "ffsc-apothecary-stock", kind: "shop-stock" } },
  { id: "shop-3", category: "shop-stock", holdout: false,
    attempt: "What does the smith have for sale?",
    candidates: [c("shop-stock", "The smith's stock", "ffsc-smith-stock"), c("new-clue", "The smith's order book", "ffl-smith-order-book")],
    expected: { band: "act", candidateId: "ffsc-smith-stock", kind: "shop-stock" } },
  { id: "shop-4", category: "shop-stock", holdout: false,
    attempt: "I want to see the fletcher's inventory.",
    candidates: [c("shop-stock", "The fletcher's inventory", "ffsc-fletcher-inventory"), c("materialize-npc", "The fletcher", "ffn-fletcher")],
    expected: { band: "act", candidateId: "ffsc-fletcher-inventory", kind: "shop-stock" } },
  { id: "shop-5", category: "shop-stock", holdout: true,
    attempt: "I ask the trader what goods are available.",
    candidates: [c("shop-stock", "The trader's goods", "ffsc-trader-goods"), c("materialize-location", "The trading post", "ffc-trading-post")],
    expected: { band: "act", candidateId: "ffsc-trader-goods", kind: "shop-stock" } },
  { id: "shop-6", category: "shop-stock", holdout: false,
    attempt: "I look over the caravan's stall for anything useful.",
    candidates: [c("shop-stock", "The caravan's stall", "ffsc-caravan-stall"), c("materialize-npc", "The caravan master", "ffn-caravan-master")],
    expected: { band: "act", candidateId: "ffsc-caravan-stall", kind: "shop-stock" } },

  // ---------------------------- new-clue (6) ----------------------------
  { id: "clue-1", category: "new-clue", holdout: false,
    attempt: "I search the room for clues about the drowned courier.",
    candidates: [c("new-clue", "The drowned courier", "ffl-drowned-courier"), c("materialize-npc", "The innkeeper", "ffn-innkeeper")],
    expected: { band: "act", candidateId: "ffl-drowned-courier", kind: "new-clue" } },
  { id: "clue-2", category: "new-clue", holdout: true,
    attempt: "I investigate the strange sigil carved on the door.",
    candidates: [c("new-clue", "The carved sigil", "ffl-carved-sigil"), c("materialize-location", "The sealed door", "ffc-sealed-door")],
    expected: { band: "act", candidateId: "ffl-carved-sigil", kind: "new-clue" } },
  { id: "clue-3", category: "new-clue", holdout: false,
    attempt: "I ask around about the rumor of the missing shipment.",
    candidates: [c("new-clue", "The missing shipment", "ffl-missing-shipment"), c("materialize-npc", "A dockworker", "ffn-dockworker")],
    expected: { band: "act", candidateId: "ffl-missing-shipment", kind: "new-clue" } },
  { id: "clue-4", category: "new-clue", holdout: false,
    attempt: "I examine the ledger for a lead on the smuggling ring.",
    candidates: [c("new-clue", "The smuggling ring", "ffl-smuggling-ring"), c("shop-stock", "A fence's wares", "ffsc-fence-wares")],
    expected: { band: "act", candidateId: "ffl-smuggling-ring", kind: "new-clue" } },
  { id: "clue-5", category: "new-clue", holdout: true,
    attempt: "I look into the old legend of the hollow king.",
    candidates: [c("new-clue", "The hollow king", "ffl-hollow-king"), c("materialize-location", "The barrow", "ffc-barrow")],
    expected: { band: "act", candidateId: "ffl-hollow-king", kind: "new-clue" } },
  { id: "clue-6", category: "new-clue", holdout: false,
    attempt: "I search for evidence of who poisoned the well.",
    candidates: [c("new-clue", "The poisoned well", "ffl-poisoned-well"), c("materialize-npc", "The water carrier", "ffn-water-carrier")],
    expected: { band: "act", candidateId: "ffl-poisoned-well", kind: "new-clue" } },

  // ---------------------------- materialize-faction (4) ----------------------------
  { id: "faction-1", category: "materialize-faction", holdout: false,
    attempt: "I look for the local thieves' guild.",
    candidates: [c("materialize-faction", "The thieves' guild", "fff-thieves-guild"), c("materialize-npc", "The guildmaster", "ffn-guildmaster")],
    expected: { band: "act", candidateId: "fff-thieves-guild", kind: "materialize-faction" } },
  { id: "faction-2", category: "materialize-faction", holdout: true,
    attempt: "I ask around for the mages guild.",
    candidates: [c("materialize-faction", "The mages guild", "fff-mages-guild"), c("materialize-location", "The guildhall", "ffc-guildhall")],
    expected: { band: "act", candidateId: "fff-mages-guild", kind: "materialize-faction" } },
  { id: "faction-3", category: "materialize-faction", holdout: false,
    // Wrong-candidate trap: two factions are offered; the attempt names the smiths guild only.
    attempt: "I want to find the smiths guild.",
    candidates: [c("materialize-faction", "The merchants guild", "fff-merchants-guild"), c("materialize-faction", "The smiths guild", "fff-smiths-guild")],
    expected: { band: "act", candidateId: "fff-smiths-guild", kind: "materialize-faction" } },
  { id: "faction-4", category: "materialize-faction", holdout: true,
    attempt: "I seek out the order of the silver flame.",
    candidates: [c("materialize-faction", "The order of the silver flame", "fff-silver-flame"), c("new-clue", "Tales of the silver flame", "ffl-silver-flame-tales")],
    expected: { band: "act", candidateId: "fff-silver-flame", kind: "materialize-faction" } },

  // ---------------------------- materialize-quest (4) ----------------------------
  { id: "quest-1", category: "materialize-quest", holdout: false,
    attempt: "I want steady work.",
    candidates: [c("materialize-quest", "A bounty on the road bandits", "ffq-road-bandits"), c("materialize-npc", "The quest giver", "ffn-quest-giver")],
    expected: { band: "act", candidateId: "ffq-road-bandits", kind: "materialize-quest" } },
  { id: "quest-2", category: "materialize-quest", holdout: true,
    attempt: "Do you have any jobs for me?",
    candidates: [c("materialize-quest", "Escort the merchant caravan", "ffq-escort-caravan"), c("shop-stock", "The caravan's wares", "ffsc-caravan-wares")],
    expected: { band: "act", candidateId: "ffq-escort-caravan", kind: "materialize-quest" } },
  { id: "quest-3", category: "materialize-quest", holdout: false,
    // Wrong-candidate trap: two quests are offered; the attempt names the bandit hunt only.
    attempt: "I offer to hunt the road bandits.",
    candidates: [c("materialize-quest", "Clear the ruined mill", "ffq-clear-mill"), c("materialize-quest", "Hunt the road bandits", "ffq-hunt-bandits")],
    expected: { band: "act", candidateId: "ffq-hunt-bandits", kind: "materialize-quest" } },
  { id: "quest-4", category: "materialize-quest", holdout: true,
    attempt: "I look for a contract to guard the eastern road.",
    candidates: [c("materialize-quest", "Guard the eastern road", "ffq-guard-road"), c("materialize-location", "The eastern road", "ffc-eastern-road")],
    expected: { band: "act", candidateId: "ffq-guard-road", kind: "materialize-quest" } },

  // ---------------------------- materialize-rumor (4) ----------------------------
  { id: "rumor-1", category: "materialize-rumor", holdout: false,
    attempt: "I listen for gossip about the pale tide.",
    candidates: [c("materialize-rumor", "The pale tide", "ffr-pale-tide"), c("new-clue", "Signs of the pale tide", "ffl-pale-tide-signs")],
    expected: { band: "act", candidateId: "ffr-pale-tide", kind: "materialize-rumor" } },
  { id: "rumor-2", category: "materialize-rumor", holdout: true,
    attempt: "I ask around about rumors of the drowned courier.",
    candidates: [c("materialize-rumor", "The drowned courier", "ffr-drowned-courier"), c("materialize-npc", "A dockworker", "ffn-rumor-dockworker")],
    expected: { band: "act", candidateId: "ffr-drowned-courier", kind: "materialize-rumor" } },
  { id: "rumor-3", category: "materialize-rumor", holdout: false,
    // Wrong-candidate trap: two rumors are offered; the attempt names the hollow king only.
    attempt: "I ask for the rumor about the hollow king.",
    candidates: [c("materialize-rumor", "The pale tide", "ffr-pale-tide-2"), c("materialize-rumor", "The hollow king", "ffr-hollow-king")],
    expected: { band: "act", candidateId: "ffr-hollow-king", kind: "materialize-rumor" } },
  { id: "rumor-4", category: "materialize-rumor", holdout: true,
    attempt: "I want to hear the gossip on the missing shipment.",
    candidates: [c("materialize-rumor", "The missing shipment", "ffr-missing-shipment"), c("shop-stock", "A fence's wares", "ffsc-rumor-fence-wares")],
    expected: { band: "act", candidateId: "ffr-missing-shipment", kind: "materialize-rumor" } },

  // ---------------------------- hold (6): narration is sufficient ----------------------------
  { id: "hold-1", category: "hold", holdout: false,
    attempt: "I describe my character sharpening her sword by the fire while we talk.",
    candidates: [c("materialize-location", "The campsite", "ffc-campsite")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "hold-2", category: "hold", holdout: true,
    attempt: "I look around the room and take in the scene.",
    candidates: [c("materialize-location", "The common room", "ffc-common-room")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "hold-3", category: "hold", holdout: false,
    attempt: "I nod to my companions and say we should rest here a while.",
    candidates: [c("materialize-location", "A resting place", "ffc-resting-place")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "hold-4", category: "hold", holdout: false,
    attempt: "I recount what happened at the gate yesterday.",
    candidates: [c("new-clue", "The gate incident", "ffl-gate-incident")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "hold-5", category: "hold", holdout: false,
    attempt: "I retell the legend of the order of the silver flame to my companions.",
    candidates: [c("materialize-faction", "The order of the silver flame", "fff-hold-silver-flame")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "hold-6", category: "hold", holdout: true,
    attempt: "I mention the jobs I have already done, to pass the time.",
    candidates: [c("materialize-quest", "An old job", "ffq-hold-old-job")],
    expected: { band: "fallback", candidateId: null, kind: null } },

  // ---------------------------- illegal (6): adding content now is not legal ----------------------------
  { id: "illegal-1", category: "illegal", holdout: false,
    attempt: "I declare that the king is secretly my brother and summon his royal guard.",
    candidates: [c("materialize-npc", "The royal guard", "ffn-royal-guard")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "illegal-2", category: "illegal", holdout: true,
    attempt: "I decree that a dragon has always roosted in the town square.",
    candidates: [c("hostile-encounter", "The town-square dragon", "ffe-town-dragon")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "illegal-3", category: "illegal", holdout: false,
    attempt: "I invent a new god and found a temple in the market.",
    candidates: [c("materialize-location", "The new temple", "ffc-new-temple")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "illegal-4", category: "illegal", holdout: false,
    attempt: "I declare the war over and the enemy army gone.",
    candidates: [c("hostile-encounter", "The vanished army", "ffe-vanished-army")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "illegal-5", category: "illegal", holdout: false,
    attempt: "I declare the guild's grandmaster is secretly my father and they owe me fealty.",
    candidates: [c("materialize-faction", "The thieves' guild", "fff-illegal-thieves-guild")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "illegal-6", category: "illegal", holdout: true,
    attempt: "I invent a rumor that the king is dead and spread it as established truth.",
    candidates: [c("materialize-rumor", "The king's death", "ffr-illegal-king-death")],
    expected: { band: "fallback", candidateId: null, kind: null } },

  // ---------------------------- duplicate (7): the content already exists ----------------------------
  { id: "duplicate-1", category: "duplicate", holdout: false,
    attempt: "We already mapped the Glassblower's District; I walk back there.",
    candidates: [c("materialize-location", "Glassblower's District", "ffc-dup-glassblower")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "duplicate-2", category: "duplicate", holdout: true,
    attempt: "I greet Marta the blacksmith, whom we already met.",
    candidates: [c("materialize-npc", "Marta the blacksmith", "ffn-dup-marta")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "duplicate-3", category: "duplicate", holdout: false,
    attempt: "I go back to the Sunken Chapel that we cleared last session.",
    candidates: [c("materialize-location", "The Sunken Chapel", "ffc-dup-sunken-chapel")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "duplicate-4", category: "duplicate", holdout: false,
    attempt: "I speak again with Captain Vale, who already gave us orders.",
    candidates: [c("materialize-npc", "Captain Vale", "ffn-dup-vale")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "duplicate-5", category: "duplicate", holdout: false,
    attempt: "I already found the thieves' guild; I ask about it again.",
    candidates: [c("materialize-faction", "The thieves' guild", "fff-dup-thieves-guild")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "duplicate-6", category: "duplicate", holdout: true,
    attempt: "I ask for the same road bandit bounty we already accepted.",
    candidates: [c("materialize-quest", "The road bandit bounty", "ffq-dup-road-bandits")],
    expected: { band: "fallback", candidateId: null, kind: null } },
  { id: "duplicate-7", category: "duplicate", holdout: false,
    attempt: "I already heard the rumor about the pale tide.",
    candidates: [c("materialize-rumor", "The pale tide", "ffr-dup-pale-tide")],
    expected: { band: "fallback", candidateId: null, kind: null } },
];

/** Recursively sorts object keys so the corpus digest is independent of literal key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Pinned digest of the frozen corpus; a test fails when the corpus drifts from this value. */
export const FREEFORM_MATERIALIZATION_CORPUS_DIGEST = digestOf(FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS);

/** Pinned development-split digest (the only split the threshold and calibration are selected on). */
export const FREEFORM_MATERIALIZATION_DEV_DIGEST = digestOf(
  FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.filter((entry) => !entry.holdout),
);

/** Pinned holdout-split digest (frozen, never used for selection). */
export const FREEFORM_MATERIALIZATION_HOLDOUT_DIGEST = digestOf(
  FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.filter((entry) => entry.holdout),
);

/** The fixed action-threshold grid, low to high. Selection uses the development split only. */
export const FREEFORM_MATERIALIZATION_THRESHOLD_GRID = [
  0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75,
] as const;

/** The shipped review threshold; selection never changes it (freeform composition uses only action). */
export const FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD = 0.5;

/**
 * One graded observation: the composed decision for a case, plus its label comparison.
 *
 * Follow-up: `composeFreeformMaterializationDecision` discards the named candidate whenever the
 * band falls back, so a lower-threshold re-score cannot recover what the model named on a deferred
 * call. A sweep (see the adventure lane) needs the raw answers persisted per call; this slice only
 * scores the shipped threshold, which is what the promotion binding names.
 */
export interface FreeformBenchmarkSample {
  caseId: string;
  category: FreeformCaseCategory;
  holdout: boolean;
  band: SystemOneBand;
  candidateId: string | null;
  kind: FreeformMaterializationKind | null;
  /** The candidate the label names, or null for a must-hold label. */
  expectedCandidateId: string | null;
  /** The composed top signal (raw, pre-calibration), or null when the answers were unusable. */
  topSignal: number | null;
  /** True when the labelled outcome is a materialization. */
  expectedAct: boolean;
  /** The lane selected a candidate. */
  acted: boolean;
  /** The composed decision matches the label: exact candidate on an act, a non-act on a fallback. */
  correct: boolean;
}

export interface FreeformCalibrationMetrics {
  brier: number;
  expectedCalibrationError: number;
}

export interface FreeformBenchmarkEvaluation {
  fitted: PlattCalibration;
  totalSamples: number;
  actedSamples: number;
  devSamples: number;
  holdoutSamples: number;
  /** Exact-candidate accuracy over acted samples. */
  accuracy: number;
  /** Labelled act cases the lane deferred on (coverage miss, not an acted error). */
  deferredPositive: number;
  /** Labelled fallback cases the lane acted on (false act, an acted error). */
  falseActs: number;
  /** Acted samples whose candidate was wrong (a wrong-candidate trap, or a false act). */
  actedErrors: number;
  holdout: { raw: FreeformCalibrationMetrics; calibrated: FreeformCalibrationMetrics };
  all: { raw: FreeformCalibrationMetrics; calibrated: FreeformCalibrationMetrics };
  gate: SystemOnePromotionResult;
}

/** Whether a composed decision matches the labelled disposition. */
export function gradeFreeformDecision(
  decision: Pick<FreeformMaterializationDecision, "band" | "candidateId" | "kind">,
  expected: FreeformBenchmarkExpectation,
): boolean {
  if (expected.band === "act") {
    return decision.band === "act"
      && decision.candidateId === expected.candidateId
      && decision.kind === expected.kind;
  }
  return decision.band !== "act";
}

/** Projects a case and its composed decision into a graded sample. */
export function toFreeformSample(
  benchmarkCase: FreeformMaterializationBenchmarkCase,
  decision: FreeformMaterializationDecision,
): FreeformBenchmarkSample {
  const expectedAct = benchmarkCase.expected.band === "act";
  return {
    caseId: benchmarkCase.id,
    category: benchmarkCase.category,
    holdout: benchmarkCase.holdout,
    band: decision.band,
    candidateId: decision.candidateId,
    kind: decision.kind,
    expectedCandidateId: benchmarkCase.expected.candidateId,
    topSignal: decision.topSignal,
    expectedAct,
    acted: decision.band === "act",
    correct: gradeFreeformDecision(decision, benchmarkCase.expected),
  };
}

function isActedSample(
  sample: FreeformBenchmarkSample,
): sample is FreeformBenchmarkSample & { topSignal: number } {
  return sample.acted && sample.topSignal !== null && Number.isFinite(sample.topSignal);
}

function toPoints(
  samples: readonly (FreeformBenchmarkSample & { topSignal: number })[],
  fitted: PlattCalibration,
  calibrated: boolean,
): Array<{ predictedProbability: number; correct: boolean }> {
  return samples.map((sample) => ({
    predictedProbability: calibrated ? applyCalibration(sample.topSignal, fitted) : sample.topSignal,
    correct: sample.correct,
  }));
}

function metricsFor(
  samples: readonly (FreeformBenchmarkSample & { topSignal: number })[],
  fitted: PlattCalibration,
  calibrated: boolean,
): FreeformCalibrationMetrics {
  const graded = gradeCalibration(toPoints(samples, fitted, calibrated), 10);
  return { brier: graded.brier, expectedCalibrationError: graded.expectedCalibrationError };
}

const rate = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : numerator / denominator);

/**
 * Fits the Platt map on the acted development samples and evaluates the gate on the calibrated
 * signal, mirroring the narration/rerank evaluators: the held-out rows are the unbiased estimate,
 * while the gate scores the calibrated map over every acted sample (the map the lane would ship
 * with). Deferrals never enter the gate.
 */
export function evaluateFreeformBenchmark(
  samples: readonly FreeformBenchmarkSample[],
): FreeformBenchmarkEvaluation {
  const acted = samples.filter(isActedSample);
  const devSamples = acted.filter((sample) => !sample.holdout);
  const holdoutSamples = acted.filter((sample) => sample.holdout);

  const fitted = fitPlattCalibration(toPoints(devSamples, { a: 1, b: 0 }, false));
  const allCalibrated = metricsFor(acted, fitted, true);
  const accuracy = rate(acted.filter((sample) => sample.correct).length, acted.length);
  const gate = evaluatePromotionGate(PROMOTION_LANE, {
    samples: acted.length,
    accuracy,
    brier: allCalibrated.brier,
    expectedCalibrationError: allCalibrated.expectedCalibrationError,
  });

  return {
    fitted,
    totalSamples: samples.length,
    actedSamples: acted.length,
    devSamples: devSamples.length,
    holdoutSamples: holdoutSamples.length,
    accuracy,
    deferredPositive: samples.filter((sample) => sample.expectedAct && !sample.acted).length,
    falseActs: samples.filter((sample) => !sample.expectedAct && sample.acted).length,
    actedErrors: acted.filter((sample) => !sample.correct).length,
    holdout: {
      raw: metricsFor(holdoutSamples, fitted, false),
      calibrated: metricsFor(holdoutSamples, fitted, true),
    },
    all: {
      raw: metricsFor(acted, fitted, false),
      calibrated: allCalibrated,
    },
    gate,
  };
}

/** One retained live call: the raw model answers, keyed back to its corpus case. */
export interface FreeformRawObservation {
  caseId: string;
  repeat: number;
  answers: Record<string, SystemOneAnswer>;
  latencyMs: number;
}

/** Recomposes one retained observation at a candidate threshold. Composition semantics are unchanged. */
export function sampleAtThreshold(
  benchmarkCase: FreeformMaterializationBenchmarkCase,
  answers: Record<string, SystemOneAnswer>,
  threshold: number,
  reviewThreshold = FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD,
): FreeformBenchmarkSample {
  const state = {
    campaignId: CAMPAIGN_ID,
    sessionId: SESSION_ID,
    attempt: benchmarkCase.attempt,
    candidates: benchmarkCase.candidates,
  };
  const thresholds: SystemOneConfidenceThresholds = { actionThreshold: threshold, reviewThreshold };
  return toFreeformSample(benchmarkCase, composeFreeformMaterializationDecision(state, answers, thresholds));
}

export interface FreeformSplitReport {
  /** Repeated acted samples at this threshold. */
  samples: number;
  /** Distinct corpus cases that acted (repeats collapsed). */
  distinctActed: number;
  actedErrors: number;
  accuracy: number;
  accuracyLowerBound: number;
  raw: FreeformCalibrationMetrics;
  calibrated: FreeformCalibrationMetrics;
  gate: SystemOnePromotionResult;
}

export interface FreeformThresholdPoint {
  threshold: number;
  calibration: PlattCalibration;
  dev: FreeformSplitReport;
  holdout: FreeformSplitReport;
}

export interface FreeformDevSelection {
  grid: FreeformThresholdPoint[];
  selected: FreeformThresholdPoint | null;
  selectedBy: "dev-gate" | "dev-best" | "none";
  /** True only when at least one development threshold passed its own gate. */
  devGateQualified: boolean;
  reasons: string[];
}

function splitReport(samples: readonly FreeformBenchmarkSample[], fitted: PlattCalibration): FreeformSplitReport {
  const acted = samples.filter(isActedSample);
  const accuracy = rate(acted.filter((sample) => sample.correct).length, acted.length);
  const calibrated = metricsFor(acted, fitted, true);
  const raw = metricsFor(acted, fitted, false);
  const metrics: PromotionCalibrationMetrics = {
    samples: acted.length,
    accuracy,
    brier: calibrated.brier,
    expectedCalibrationError: calibrated.expectedCalibrationError,
  };
  return {
    samples: acted.length,
    distinctActed: new Set(acted.map((sample) => sample.caseId)).size,
    actedErrors: acted.filter((sample) => !sample.correct).length,
    accuracy,
    accuracyLowerBound: acted.length === 0 ? 0 : wilsonLowerBound(Math.round(accuracy * acted.length), acted.length),
    raw,
    calibrated,
    gate: evaluatePromotionGate(PROMOTION_LANE, metrics),
  };
}

const better = (
  left: FreeformThresholdPoint,
  right: FreeformThresholdPoint,
  keys: ReadonlyArray<(point: FreeformThresholdPoint) => number>,
): FreeformThresholdPoint => {
  for (const key of keys) {
    const difference = key(left) - key(right);
    if (Math.abs(difference) > 1e-12) return difference > 0 ? left : right;
  }
  // Prefer the lower threshold on a tie (more coverage).
  return left.threshold <= right.threshold ? left : right;
};

/**
 * Selects the action threshold and fits the Platt map on the **development split only**. The stored
 * raw answers let every grid point be recomposed at a swept threshold without re-asking the model;
 * `composeFreeformMaterializationDecision` itself is untouched. The holdout columns are recorded
 * for reporting but are never consulted for selection.
 *
 * Selection: among development thresholds whose own gate passes, choose the one with the most
 * distinct acted cases, then the highest calibrated accuracy and Wilson lower bound. If no
 * development threshold passes, select the best descriptive point and mark the selection
 * unqualified (a holdout pass at an unqualified point never promotes).
 */
export function evaluateFreeformDevSelection(
  observations: readonly FreeformRawObservation[],
  grid: readonly number[] = FREEFORM_MATERIALIZATION_THRESHOLD_GRID,
  reviewThreshold = FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD,
): FreeformDevSelection {
  const corpusById = new Map(FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.map((entry) => [entry.id, entry]));
  const gate = DEFAULT_SYSTEM_ONE_LANE_GATES[PROMOTION_LANE];
  const points: FreeformThresholdPoint[] = [];
  for (const threshold of grid) {
    const samples = observations
      .map((observation) => {
        const entry = corpusById.get(observation.caseId);
        return entry ? sampleAtThreshold(entry, observation.answers, threshold, reviewThreshold) : null;
      })
      .filter((sample): sample is FreeformBenchmarkSample => sample !== null);
    const devActed = samples.filter((sample) => !sample.holdout).filter(isActedSample);
    const fitted = fitPlattCalibration(toPoints(devActed, { a: 1, b: 0 }, false));
    points.push({
      threshold,
      calibration: fitted,
      dev: splitReport(samples.filter((sample) => !sample.holdout), fitted),
      holdout: splitReport(samples.filter((sample) => sample.holdout), fitted),
    });
  }

  const gated = points.filter((point) => point.dev.gate.promoted);
  const coverageFloor = points.filter((point) => point.dev.samples >= gate.minSamples);
  const descriptive = coverageFloor.length > 0 ? coverageFloor : points.filter((point) => point.dev.samples > 0);
  const reasons: string[] = [];
  let selected: FreeformThresholdPoint | null = null;
  let selectedBy: FreeformDevSelection["selectedBy"] = "none";
  if (gated.length > 0) {
    selectedBy = "dev-gate";
    selected = gated.reduce((current, point) => better(current, point, [
      (value) => value.dev.distinctActed,
      (value) => value.dev.accuracy,
      (value) => value.dev.accuracyLowerBound,
    ]));
  } else if (descriptive.length > 0) {
    selectedBy = "dev-best";
    selected = descriptive.reduce((current, point) => better(current, point, [
      (value) => value.dev.accuracy,
      (value) => value.dev.accuracyLowerBound,
      (value) => value.dev.distinctActed,
    ]));
    reasons.push(
      "no development threshold passed the development gate; the selected point is descriptive only and cannot promote",
    );
  } else {
    reasons.push("no threshold produced an acted development sample");
  }
  return { grid: points, selected, selectedBy, devGateQualified: gated.length > 0, reasons };
}

const roundedCalibration = (calibration: PlattCalibration): PlattCalibration => ({
  a: round4(calibration.a),
  b: round4(calibration.b),
});

/**
 * The production promotion record a dev-selected run would justify, or null. It requires a
 * development-gate-qualified selection (never a descriptive best point) and a passing holdout gate,
 * plus a real response model for the binding. The binding names the selected action threshold, the
 * shipped review threshold, and the fitted calibration, so it matches the runtime settings the
 * promotion would ship with.
 */
export function proposeSelectionPromotionRecord(
  selection: FreeformDevSelection,
  settings: SystemOneSettings,
  responseModel: string | null | undefined,
  promotedAt: string,
  evidence = EVIDENCE,
): SystemOnePromotionRecord | null {
  if (!selection.devGateQualified || selection.selected === null) return null;
  const point = selection.selected;
  if (!point.holdout.gate.promoted) return null;
  if (!responseModel || responseModel.trim().length === 0) return null;
  const reviewThreshold = Math.min(FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD, point.threshold);
  const calibratedSettings: SystemOneSettings = {
    ...settings,
    confidenceCalibration: {
      ...settings.confidenceCalibration,
      [PROMOTION_LANE]: roundedCalibration(point.calibration),
    },
    confidencePolicy: {
      ...settings.confidencePolicy,
      [PROMOTION_LANE]: { actionThreshold: point.threshold, reviewThreshold },
    },
  };
  return {
    evaluatedBindings: [systemOneEvaluationBinding(
      PROMOTION_LANE,
      calibratedSettings,
      responseModel,
      FREEFORM_MATERIALIZATION_ACTION_FAMILY,
    )],
    metrics: {
      samples: point.holdout.samples,
      accuracy: round4(point.holdout.accuracy),
      brier: round4(point.holdout.calibrated.brier),
      expectedCalibrationError: round4(point.holdout.calibrated.expectedCalibrationError),
    },
    calibration: roundedCalibration(point.calibration),
    promotedAt,
    evidence,
  };
}

const round4 = (value: number): number => Number(value.toFixed(4));

/**
 * The production promotion record this run would justify, or null when the gate did not pass.
 *
 * The record carries the exact evaluation binding the runtime will build for these settings: the
 * action family is fixed, and the calibration is the fitted map the lane would ship with (it is
 * also what `defaultSystemOneConfidenceCalibration` must return for the lane). A null
 * `responseModel` cannot form a valid binding, so no record is proposed.
 */
export function proposePromotionRecord(
  evaluation: FreeformBenchmarkEvaluation,
  settings: SystemOneSettings,
  responseModel: string | null | undefined,
  promotedAt: string,
  evidence = EVIDENCE,
): SystemOnePromotionRecord | null {
  if (!evaluation.gate.promoted) return null;
  if (!responseModel || responseModel.trim().length === 0) return null;
  const calibratedSettings: SystemOneSettings = {
    ...settings,
    confidenceCalibration: {
      ...settings.confidenceCalibration,
      [PROMOTION_LANE]: { a: round4(evaluation.fitted.a), b: round4(evaluation.fitted.b) },
    },
  };
  const metrics: PromotionCalibrationMetrics = {
    samples: evaluation.actedSamples,
    accuracy: round4(evaluation.accuracy),
    brier: round4(evaluation.all.calibrated.brier),
    expectedCalibrationError: round4(evaluation.all.calibrated.expectedCalibrationError),
  };
  return {
    evaluatedBindings: [systemOneEvaluationBinding(
      PROMOTION_LANE,
      calibratedSettings,
      responseModel,
      FREEFORM_MATERIALIZATION_ACTION_FAMILY,
    )],
    metrics,
    calibration: { a: round4(evaluation.fitted.a), b: round4(evaluation.fitted.b) },
    promotedAt,
    evidence,
  };
}

export interface FreeformCaseSummary {
  id: string;
  category: FreeformCaseCategory;
  holdout: boolean;
  calls: number;
  acted: number;
  correct: number;
  deferred: number;
  meanSignal: number;
  bands: Record<SystemOneBand, number>;
}

/** Per-case roll-up over repeats, for the report table. */
export function summarizeFreeformCases(samples: readonly FreeformBenchmarkSample[]): FreeformCaseSummary[] {
  const order = new Map(FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.map((entry, index) => [entry.id, index]));
  const byId = new Map<string, FreeformBenchmarkSample[]>();
  for (const sample of samples) {
    const bucket = byId.get(sample.caseId);
    if (bucket) bucket.push(sample);
    else byId.set(sample.caseId, [sample]);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => (order.get(left) ?? 0) - (order.get(right) ?? 0))
    .map(([id, rows]) => {
      const first = rows[0]!;
      const signals = rows.filter(
        (row): row is FreeformBenchmarkSample & { topSignal: number } =>
          row.topSignal !== null && Number.isFinite(row.topSignal),
      );
      const bands: Record<SystemOneBand, number> = { act: 0, confirm: 0, fallback: 0 };
      for (const row of rows) bands[row.band] += 1;
      return {
        id,
        category: first.category,
        holdout: first.holdout,
        calls: rows.length,
        acted: rows.filter((row) => row.acted).length,
        correct: rows.filter((row) => row.correct).length,
        deferred: rows.filter((row) => !row.acted).length,
        meanSignal: signals.length === 0 ? 0 : signals.reduce((sum, row) => sum + row.topSignal, 0) / signals.length,
        bands,
      };
    });
}

interface RawCall {
  caseId: string;
  category: FreeformCaseCategory;
  repeat: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
  band: SystemOneBand | null;
  candidateId: string | null;
  topSignal: number | null;
  correct: boolean;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function renderFreeformBenchmark(input: {
  generatedAt: string;
  model: string;
  responseModel: string | null;
  baseUrl: string;
  repeats: number;
  thresholds: { actionThreshold: number; reviewThreshold: number };
  samples: readonly FreeformBenchmarkSample[];
  calls: readonly RawCall[];
  evaluation: FreeformBenchmarkEvaluation;
  proposedRecord: SystemOnePromotionRecord | null;
}): string {
  const { generatedAt, model, responseModel, baseUrl, repeats, thresholds, samples, calls, evaluation, proposedRecord } = input;
  const summaries = summarizeFreeformCases(samples);
  const okCalls = calls.filter((call) => call.ok).length;
  const latencies = calls.map((call) => call.latencyMs);
  const meanLatency = latencies.length === 0 ? 0 : latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  const expectedText = (entry: FreeformMaterializationBenchmarkCase): string =>
    entry.expected.band === "act"
      ? `act → ${entry.expected.candidateId}`
      : "fallback (no materialization)";
  const lines: string[] = [];
  lines.push("# System One (Jev) freeform-materialization benchmark");
  lines.push("");
  lines.push(`Generated ${generatedAt} by \`scripts/evaluate-system-one-freeform-materialization-lane.ts\` using the live System One adapter.`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("The `freeform-materialization` lane is advisory and bounded: the server owns a closed candidate set (a location, NPC, encounter, shop, clue, faction, quest, or rumor the deterministic classifier would author), and the lane may only select one authored candidate id/kind or fail closed to no action. It never authors prose, stats, prices, stock, or a state mutation. The battery is two `noul` gates (`needs_content`, `legal`) plus one aggregate `choice` over the exact authored ids and an explicit `none_of_these`; `composeFreeformMaterializationDecision` requires every signal at the action threshold to act.");
  lines.push("");
  lines.push("The corpus is **frozen and provider-free**: the attempts, candidate sets, and labels are hand-authored fixtures, and no case carries provider output. The evaluation runs the real adapter once per case. Positives exercise all eight kinds, including wrong-candidate traps where two same-kind candidates are offered and the attempt names only one. Negatives are hard holds: narration is sufficient, adding content now is illegal under canon/readiness, or the named content already exists (duplicate). A `fallback` label is correct only when the lane does not act; acting there is a false act and an acted error. Only `act` samples score the gate, so a deferral is coverage, not an acted error.");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Requested model | \`${model}\` |`);
  lines.push(`| Response model | \`${responseModel ?? "unknown"}\` |`);
  lines.push(`| Base URL | \`${baseUrl}\` |`);
  lines.push(`| Confidence thresholds (action / review) | ${thresholds.actionThreshold} / ${thresholds.reviewThreshold} |`);
  lines.push(`| Repeats | ${repeats} |`);
  lines.push(`| Corpus digest (sha256) | \`${FREEFORM_MATERIALIZATION_CORPUS_DIGEST}\` |`);
  lines.push(`| Corpus | ${FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.length} cases x ${repeats} repeats = ${samples.length} calls (${okCalls} transport calls succeeded) |`);
  lines.push("");
  lines.push("## Corpus");
  lines.push("");
  lines.push("| Case | Category | Split | Attempt | Expected |");
  lines.push("| --- | --- | :---: | --- | --- |");
  for (const entry of FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS) {
    lines.push(`| ${entry.id} | ${entry.category} | ${entry.holdout ? "holdout" : "dev"} | ${entry.attempt} | ${expectedText(entry)} |`);
  }
  lines.push("");
  lines.push("## Per-case results (all repeats)");
  lines.push("");
  lines.push("| Case | Category | Bands (act/confirm/fallback) | Acted | Correct | Deferred | Mean signal |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: |");
  for (const summary of summaries) {
    lines.push(`| ${summary.id} | ${summary.category} | ${summary.bands.act}/${summary.bands.confirm}/${summary.bands.fallback} | ${summary.acted}/${summary.calls} | ${summary.correct}/${summary.calls} | ${summary.deferred}/${summary.calls} | ${summary.meanSignal.toFixed(3)} |`);
  }
  lines.push("");
  if (samples.length !== summaries.reduce((sum, summary) => sum + summary.calls, 0)) {
    lines.push("Warning: per-case roll-up does not match the sample count.");
  }
  lines.push("## Calibration (fit on development acts, scored on holdout)");
  lines.push("");
  lines.push(`Fitted a monotonic Platt map on ${evaluation.devSamples} acted development sample(s).`);
  lines.push("");
  lines.push("| Split | Signal | Brier | ECE |");
  lines.push("| --- | --- | ---: | ---: |");
  lines.push(`| held-out acted (${evaluation.holdoutSamples}) | raw | ${evaluation.holdout.raw.brier.toFixed(4)} | ${evaluation.holdout.raw.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| held-out acted (${evaluation.holdoutSamples}) | calibrated | ${evaluation.holdout.calibrated.brier.toFixed(4)} | ${evaluation.holdout.calibrated.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| all acted (${evaluation.actedSamples}) | raw | ${evaluation.all.raw.brier.toFixed(4)} | ${evaluation.all.raw.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| all acted (${evaluation.actedSamples}) | calibrated | ${evaluation.all.calibrated.brier.toFixed(4)} | ${evaluation.all.calibrated.expectedCalibrationError.toFixed(4)} |`);
  lines.push("");
  lines.push(`Map: \`sigmoid(a * logit(p) + b)\` with a = ${evaluation.fitted.a.toFixed(4)}, b = ${evaluation.fitted.b.toFixed(4)}.`);
  lines.push("");
  lines.push(`Acted accuracy ${pct(evaluation.accuracy)} over ${evaluation.actedSamples} acted sample(s); ${evaluation.deferredPositive} labelled act(s) deferred, ${evaluation.falseActs} false act(s), ${evaluation.actedErrors} acted error(s). Mean transport latency ${meanLatency.toFixed(0)} ms.`);
  lines.push("");
  lines.push(`## Promotion gate — \`${PROMOTION_LANE}\``);
  lines.push("");
  lines.push(`**${evaluation.gate.promoted ? "PROMOTE" : "NOT READY"}**`);
  lines.push("");
  if (evaluation.gate.reasons.length === 0) lines.push("All gates passed.");
  else for (const reason of evaluation.gate.reasons) lines.push(`- ${reason}`);
  lines.push("");
  lines.push(`Gate: samples ${evaluation.gate.gates.minSamples}+, accuracy ${pct(evaluation.gate.gates.minAccuracy)}+, Wilson lower bound ${evaluation.gate.gates.minAccuracyLowerBound ?? "n/a"}+, Brier <= ${evaluation.gate.gates.maxBrier}, ECE <= ${evaluation.gate.gates.maxExpectedCalibrationError}.`);
  lines.push("");
  if (proposedRecord) {
    lines.push("Proposed promotion record:");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(proposedRecord, null, 2));
    lines.push("```");
  } else {
    lines.push("No promotion record is proposed: the gate did not pass or no real response model was captured, so the lane keeps its record-only shadow behavior.");
  }
  lines.push("");
  lines.push("## Observations");
  lines.push("");
  lines.push(`- **Coverage.** ${evaluation.deferredPositive} of the labelled act cases deferred; a deferral leaves the deterministic classifier/hold in place and is coverage, not an acted error.`);
  lines.push(`- **Safety.** ${evaluation.falseActs} labelled hold/illegal/duplicate case(s) were acted on; each is an acted error that costs accuracy.`);
  lines.push("- **Honesty.** The corpus is small and provider-free in its ground truth; a passing gate with no acted error is a promotion candidate, not proof, and cannot test the calibration error tail. The held-out rows are the unbiased calibration estimate, while the gate scores the calibrated map over every acted sample.");
  lines.push("- **No active path by default.** The lane is only invoked by an opt-in call site that requires `enabled`, an `active` lane mode, and a matching promotion binding; otherwise the deterministic classifier owns materialization.");
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY");
  lines.push("npx tsx scripts/evaluate-system-one-freeform-materialization-lane.ts --repeat 1");
  lines.push("```");
  lines.push("");
  lines.push(`Raw per-call data: \`${EVIDENCE.replace(/\.md$/, ".json")}\`.`);
  lines.push("");
  return lines.join("\n");
}

interface GateRow {
  criterion: string;
  observed: string;
  required: string;
  pass: boolean;
}

/** Every base gate as observed-vs-required, whether it passed or not. */
export function promotionGateRows(metrics: PromotionCalibrationMetrics, result: SystemOnePromotionResult): GateRow[] {
  const gates = result.gates;
  const lowerBound = metrics.samples === 0
    ? 0
    : wilsonLowerBound(Math.round(metrics.accuracy * metrics.samples), metrics.samples);
  const rows: GateRow[] = [
    { criterion: "samples", observed: `${metrics.samples}`, required: `>= ${gates.minSamples}`, pass: metrics.samples >= gates.minSamples },
    { criterion: "accuracy", observed: metrics.accuracy.toFixed(4), required: `>= ${gates.minAccuracy.toFixed(4)}`, pass: metrics.accuracy >= gates.minAccuracy },
  ];
  if (gates.minAccuracyLowerBound !== undefined) {
    rows.push({ criterion: "Wilson lower bound", observed: lowerBound.toFixed(4), required: `>= ${gates.minAccuracyLowerBound.toFixed(4)}`, pass: lowerBound >= gates.minAccuracyLowerBound });
  }
  rows.push({ criterion: "Brier", observed: metrics.brier.toFixed(4), required: `<= ${gates.maxBrier.toFixed(4)}`, pass: metrics.brier <= gates.maxBrier });
  rows.push({ criterion: "ECE", observed: metrics.expectedCalibrationError.toFixed(4), required: `<= ${gates.maxExpectedCalibrationError.toFixed(4)}`, pass: metrics.expectedCalibrationError <= gates.maxExpectedCalibrationError });
  return rows;
}

function gateTable(lines: string[], metrics: PromotionCalibrationMetrics, result: SystemOnePromotionResult): void {
  lines.push("| Criterion | Observed | Required | Result |");
  lines.push("| --- | ---: | ---: | :---: |");
  for (const row of promotionGateRows(metrics, result)) {
    lines.push(`| ${row.criterion} | ${row.observed} | ${row.required} | ${row.pass ? "pass" : "**fail**"} |`);
  }
}

function metricsOfSplit(report: FreeformSplitReport): PromotionCalibrationMetrics {
  return {
    samples: report.samples,
    accuracy: report.accuracy,
    brier: report.calibrated.brier,
    expectedCalibrationError: report.calibrated.expectedCalibrationError,
  };
}

/**
 * Renders the dev-selection benchmark: the development sweep used for selection, the selected
 * threshold and calibration, the frozen-holdout gate, per-case outcomes, and a clearly labelled
 * post-hoc holdout diagnostic scan.
 */
export function renderFreeformSelectionBenchmark(input: {
  generatedAt: string;
  model: string;
  responseModel: string | null;
  baseUrl: string;
  repeats: number;
  shippedThresholds: SystemOneConfidenceThresholds;
  selection: FreeformDevSelection;
  observations: readonly FreeformRawObservation[];
  calls: readonly RawCall[];
  proposedRecord: SystemOnePromotionRecord | null;
}): string {
  const { generatedAt, model, responseModel, baseUrl, repeats, shippedThresholds, selection, observations, calls, proposedRecord } = input;
  const okCalls = calls.filter((call) => call.ok).length;
  const lines: string[] = [];
  const selected = selection.selected;
  const reviewThreshold = selected ? Math.min(FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD, selected.threshold) : FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD;
  lines.push("# System One (Jev) freeform-materialization benchmark — development selection");
  lines.push("");
  lines.push(`Generated ${generatedAt} by \`scripts/evaluate-system-one-freeform-materialization-lane.ts --dev-select\`.`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("The bounded `freeform-materialization` battery is two `noul` gates (`needs_content`, `legal`) plus one aggregate `choice` over the exact server-authored candidate ids and an explicit `none_of_these`. The lane may only select an authored candidate or fail closed; it never authors prose, stats, prices, stock, or a state mutation. The raw answers from one live run are retained, so every threshold on the fixed grid is recomposed with `composeFreeformMaterializationDecision` unchanged — no model is re-asked. The action threshold and the monotonic Platt map are selected on the **development split only**; the frozen **holdout** is scored once at the selected threshold. A holdout pass at a descriptive (non-development-gate-qualified) point never promotes.");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Requested model | \`${model}\` |`);
  lines.push(`| Response model | \`${responseModel ?? "unknown"}\` |`);
  lines.push(`| Base URL | \`${baseUrl}\` |`);
  lines.push(`| Repeats per case | ${repeats} |`);
  lines.push(`| Shipped thresholds (action / review) | ${shippedThresholds.actionThreshold} / ${shippedThresholds.reviewThreshold} |`);
  lines.push(`| Threshold grid | ${FREEFORM_MATERIALIZATION_THRESHOLD_GRID.map((value) => value.toFixed(2)).join(", ")} |`);
  lines.push(`| Corpus digest | \`${FREEFORM_MATERIALIZATION_CORPUS_DIGEST}\` |`);
  lines.push(`| Development-split digest | \`${FREEFORM_MATERIALIZATION_DEV_DIGEST}\` |`);
  lines.push(`| Holdout-split digest | \`${FREEFORM_MATERIALIZATION_HOLDOUT_DIGEST}\` |`);
  lines.push(`| Calls | ${FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.length} cases x ${repeats} = ${calls.length} (${okCalls} succeeded) |`);
  lines.push("");
  lines.push("## Development threshold sweep (selection input)");
  lines.push("");
  lines.push("Calibration and the gate are computed per development threshold; the selected row is marked. Holdout columns are not shown here so selection cannot see them.");
  lines.push("");
  lines.push("| Threshold | Dev acted (repeats) | Dev distinct acted | Dev accuracy | Dev Wilson LB | Dev Brier (cal) | Dev ECE (cal) | Dev gate |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |");
  for (const point of selection.grid) {
    const marker = selected && point.threshold === selected.threshold ? " **←**" : "";
    lines.push(`| ${point.threshold.toFixed(2)}${marker} | ${point.dev.samples} | ${point.dev.distinctActed} | ${pct(point.dev.accuracy)} | ${point.dev.accuracyLowerBound.toFixed(4)} | ${point.dev.calibrated.brier.toFixed(4)} | ${point.dev.calibrated.expectedCalibrationError.toFixed(4)} | ${point.dev.gate.promoted ? "pass" : "fail"} |`);
  }
  lines.push("");
  const gated = selection.grid.filter((point) => point.dev.gate.promoted).map((point) => point.threshold.toFixed(2));
  lines.push(gated.length > 0
    ? `Development thresholds whose own gate passes: ${gated.join(", ")}.`
    : "No development threshold passes its own gate.");
  for (const reason of selection.reasons) lines.push(`- ${reason}`);
  lines.push("");
  lines.push("## Selected threshold");
  lines.push("");
  if (selected) {
    lines.push(`Selected action threshold **${selected.threshold.toFixed(2)}** (review ${reviewThreshold}), by \`${selection.selectedBy}\`, fit on the development split: Platt \`sigmoid(a * logit(p) + b)\` with a = ${selected.calibration.a.toFixed(4)}, b = ${selected.calibration.b.toFixed(4)}. Development-gate qualified: **${selection.devGateQualified ? "yes" : "no"}**.`);
  } else {
    lines.push("No threshold produced an acted development sample; nothing is selectable.");
  }
  lines.push("");
  if (selected) {
    lines.push("## Frozen-holdout gate at the selected threshold");
    lines.push("");
    lines.push(`Holdout acted **${selected.holdout.samples}** repeated samples across **${selected.holdout.distinctActed}** distinct cases (${selected.holdout.actedErrors} acted error(s)); accuracy ${pct(selected.holdout.accuracy)}.`);
    lines.push("");
    lines.push("| Holdout signal | Brier | ECE |");
    lines.push("| --- | ---: | ---: |");
    lines.push(`| raw | ${selected.holdout.raw.brier.toFixed(4)} | ${selected.holdout.raw.expectedCalibrationError.toFixed(4)} |`);
    lines.push(`| calibrated (development map) | ${selected.holdout.calibrated.brier.toFixed(4)} | ${selected.holdout.calibrated.expectedCalibrationError.toFixed(4)} |`);
    lines.push("");
    gateTable(lines, metricsOfSplit(selected.holdout), selected.holdout.gate);
    lines.push("");
    lines.push(`**${selected.holdout.gate.promoted ? "HOLDOUT PROMOTE" : "HOLDOUT NOT READY"}**`);
    lines.push("");
    if (selected.holdout.gate.reasons.length === 0) lines.push("Every holdout gate passed.");
    else for (const reason of selected.holdout.gate.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  lines.push("## Per-case outcomes at the selected threshold");
  lines.push("");
  if (selected) {
    lines.push("| Case | Category | Split | Expected | Acted (repeats) | Distinct | Correct repeats | Band |");
    lines.push("| --- | --- | :---: | --- | ---: | :---: | ---: | --- |");
    const corpusById = new Map(FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.map((entry) => [entry.id, entry]));
    const byCase = new Map<string, FreeformBenchmarkSample[]>();
    for (const observation of observations) {
      const entry = corpusById.get(observation.caseId);
      if (!entry) continue;
      const sample = sampleAtThreshold(entry, observation.answers, selected.threshold, reviewThreshold);
      const bucket = byCase.get(observation.caseId);
      if (bucket) bucket.push(sample);
      else byCase.set(observation.caseId, [sample]);
    }
    for (const entry of FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS) {
      const rows = byCase.get(entry.id) ?? [];
      const acted = rows.filter((row) => row.acted);
      const correct = rows.filter((row) => row.correct);
      const bands = new Set(rows.map((row) => row.band));
      const expectedText = entry.expected.band === "act" ? `act → ${entry.expected.candidateId}` : "fallback";
      lines.push(`| ${entry.id} | ${entry.category} | ${entry.holdout ? "holdout" : "dev"} | ${expectedText} | ${acted.length}/${rows.length} | ${acted.length > 0 ? "yes" : "no"} | ${correct.length}/${rows.length} | ${[...bands].join("/")} |`);
    }
    lines.push("");
  } else {
    lines.push("No selected threshold.");
  }
  lines.push("");
  lines.push("## Post-hoc holdout diagnostic scan (NOT used for selection)");
  lines.push("");
  lines.push("Holdout metrics at every grid threshold, shown only to characterize the frozen split after selection. Selection used the development columns above.");
  lines.push("");
  lines.push("| Threshold | Holdout acted (repeats) | Distinct | Accuracy | Wilson LB | Brier (cal) | ECE (cal) | Holdout gate |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |");
  for (const point of selection.grid) {
    lines.push(`| ${point.threshold.toFixed(2)} | ${point.holdout.samples} | ${point.holdout.distinctActed} | ${pct(point.holdout.accuracy)} | ${point.holdout.accuracyLowerBound.toFixed(4)} | ${point.holdout.calibrated.brier.toFixed(4)} | ${point.holdout.calibrated.expectedCalibrationError.toFixed(4)} | ${point.holdout.gate.promoted ? "pass" : "fail"} |`);
  }
  lines.push("");
  if (proposedRecord) {
    lines.push("## Proposed promotion record");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(proposedRecord, null, 2));
    lines.push("```");
  } else {
    lines.push("## No promotion record");
    lines.push("");
    lines.push("The holdout gate did not pass at a development-gate-qualified threshold, or no real response model was captured, so the lane keeps its record-only shadow behavior and no calibration or threshold is shipped.");
  }
  lines.push("");
  lines.push("## Honesty");
  lines.push("");
  lines.push("- Selection used the development split only; the holdout was scored once at the selected threshold and drives the gate.");
  lines.push("- The gate counts repeated acted samples; the distinct acted-case count is reported alongside because repeats from one case are not independent evidence.");
  lines.push("- A frozen, provider-free corpus with no acted error is a promotion candidate, not proof; it cannot test the calibration's error tail.");
  lines.push("- The lane has no default active path; an opt-in call site requires `enabled`, an `active` lane mode, and a matching promotion binding.");
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY");
  lines.push("npx tsx scripts/evaluate-system-one-freeform-materialization-lane.ts --dev-select --repeat 5");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const key = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!key) {
    console.error("TYPESAFE_API_KEY is required for the live freeform-materialization evaluation.");
    process.exitCode = 1;
    return;
  }
  const devSelect = process.argv.includes("--dev-select");
  const repeatRaw = Number(argumentValue("--repeat") ?? (devSelect ? "5" : "1"));
  const repeats = Math.max(1, Math.min(25, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 1));
  const outPath = path.resolve(ROOT, argumentValue("--out") ?? DEFAULT_OUT);
  const settings: SystemOneSettings = { ...defaultSystemOneSettings(), apiKey: key };
  const thresholds = settings.confidencePolicy[PROMOTION_LANE];
  const promotedAt = new Date().toISOString().slice(0, 10);

  const samples: FreeformBenchmarkSample[] = [];
  const observations: FreeformRawObservation[] = [];
  const calls: RawCall[] = [];
  let model = settings.model;
  let responseModel: string | null = null;

  for (const benchmarkCase of FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS) {
    const state = {
      campaignId: CAMPAIGN_ID,
      sessionId: SESSION_ID,
      attempt: benchmarkCase.attempt,
      candidates: benchmarkCase.candidates,
    };
    const questions = buildFreeformMaterializationQuestions(state);
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const startedAt = performance.now();
      try {
        const result = await completeWithSystemOne({ settings, state, questions });
        model = result.model.responseModel ?? model;
        if (result.model.responseModel) responseModel = result.model.responseModel;
        const composed = composeFreeformMaterializationDecision(state, result.answers, thresholds);
        const sample = toFreeformSample(benchmarkCase, composed);
        samples.push(sample);
        observations.push({
          caseId: benchmarkCase.id,
          repeat,
          answers: result.answers,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        });
        calls.push({
          caseId: benchmarkCase.id, category: benchmarkCase.category, repeat, ok: true,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          band: composed.band, candidateId: composed.candidateId, topSignal: composed.topSignal,
          correct: sample.correct,
        });
      } catch (error) {
        const failure = error instanceof Error ? error.message : "error";
        calls.push({
          caseId: benchmarkCase.id, category: benchmarkCase.category, repeat, ok: false, error: failure,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          band: null, candidateId: null, topSignal: null, correct: false,
        });
        process.stderr.write(`\n${benchmarkCase.id} repeat ${repeat} failed: ${failure}`);
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  if (samples.length === 0) throw new Error("no freeform-materialization calls succeeded; nothing to evaluate");

  if (devSelect) {
    const selection = evaluateFreeformDevSelection(observations, FREEFORM_MATERIALIZATION_THRESHOLD_GRID, FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD);
    const proposedRecord = proposeSelectionPromotionRecord(selection, settings, responseModel, promotedAt);
    const selected = selection.selected;
    const markdown = renderFreeformSelectionBenchmark({
      generatedAt: new Date().toISOString(),
      model,
      responseModel,
      baseUrl: settings.baseUrl,
      repeats,
      shippedThresholds: thresholds,
      selection,
      observations,
      calls,
      proposedRecord,
    });
    await writeFile(outPath, markdown, "utf8");
    await writeFile(
      outPath.replace(/\.md$/, ".json"),
      `${JSON.stringify({
        mode: "dev-select", model, responseModel, repeats, shippedThresholds: thresholds, reviewThreshold: FREEFORM_MATERIALIZATION_REVIEW_THRESHOLD,
        corpusDigest: FREEFORM_MATERIALIZATION_CORPUS_DIGEST,
        devDigest: FREEFORM_MATERIALIZATION_DEV_DIGEST,
        holdoutDigest: FREEFORM_MATERIALIZATION_HOLDOUT_DIGEST,
        grid: FREEFORM_MATERIALIZATION_THRESHOLD_GRID,
        corpus: FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS, observations, calls, selection, proposedRecord,
      }, null, 2)}\n`,
      "utf8",
    );
    console.log(`corpus ${FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.length} cases, repeats ${repeats}, dev digest ${FREEFORM_MATERIALIZATION_DEV_DIGEST}, holdout digest ${FREEFORM_MATERIALIZATION_HOLDOUT_DIGEST}`);
    if (selected) {
      console.log(`selected t=${selected.threshold.toFixed(2)} by ${selection.selectedBy} (dev-gate-qualified=${selection.devGateQualified}); dev acted ${selected.dev.samples}/${selected.dev.distinctActed} distinct acc ${(selected.dev.accuracy * 100).toFixed(1)}%`);
      console.log(`holdout acted ${selected.holdout.samples} repeats / ${selected.holdout.distinctActed} distinct, acc ${(selected.holdout.accuracy * 100).toFixed(1)}%, cal brier=${selected.holdout.calibrated.brier.toFixed(4)} ece=${selected.holdout.calibrated.expectedCalibrationError.toFixed(4)}`);
      console.log(`holdout gate: promoted=${selected.holdout.gate.promoted}${selected.holdout.gate.reasons.length ? ` reasons=${selected.holdout.gate.reasons.join("; ")}` : ""}`);
    } else {
      console.log("no selectable threshold; holdout gate not scored");
    }
    console.log(`proposed record: ${proposedRecord ? "yes" : "none"}`);
    console.log(`wrote ${path.relative(ROOT, outPath)}`);
    return;
  }

  const evaluation = evaluateFreeformBenchmark(samples);
  const proposedRecord = proposePromotionRecord(evaluation, settings, responseModel, promotedAt);
  const markdown = renderFreeformBenchmark({
    generatedAt: new Date().toISOString(),
    model,
    responseModel,
    baseUrl: settings.baseUrl,
    repeats,
    thresholds,
    samples,
    calls,
    evaluation,
    proposedRecord,
  });
  await writeFile(outPath, markdown, "utf8");
  await writeFile(
    outPath.replace(/\.md$/, ".json"),
    `${JSON.stringify({
      model, responseModel, repeats, thresholds, corpusDigest: FREEFORM_MATERIALIZATION_CORPUS_DIGEST,
      corpus: FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS, samples, calls, evaluation, proposedRecord,
    }, null, 2)}\n`,
    "utf8",
  );

  console.log(`corpus ${FREEFORM_MATERIALIZATION_BENCHMARK_CORPUS.length} cases, digest ${FREEFORM_MATERIALIZATION_CORPUS_DIGEST}`);
  console.log(`acted ${evaluation.actedSamples}/${evaluation.totalSamples}, accuracy ${(evaluation.accuracy * 100).toFixed(1)}%, deferred positives ${evaluation.deferredPositive}, false acts ${evaluation.falseActs}`);
  console.log(`calibrated brier=${evaluation.all.calibrated.brier.toFixed(4)} ece=${evaluation.all.calibrated.expectedCalibrationError.toFixed(4)}; map a=${evaluation.fitted.a.toFixed(4)} b=${evaluation.fitted.b.toFixed(4)}`);
  console.log(`gate: promoted=${evaluation.gate.promoted}${evaluation.gate.reasons.length ? ` reasons=${evaluation.gate.reasons.join("; ")}` : ""}`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

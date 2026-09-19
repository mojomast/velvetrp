import { describe, expect, it } from "vitest";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";
import {
  ADVENTURE_BEST_KEY,
  ADVENTURE_NONE,
  ADVENTURE_RELEVANCE_PREFIX,
  ADVENTURE_SUPPORTED_KEY,
  adventureCandidateRelevance,
  buildAdventureSelectionQuestions,
  composeAdventureSelection,
  type AdventureSelectionCandidate,
} from "../src/agent/systemOneAdventure.js";

const thresholds = { actionThreshold: 0.75, reviewThreshold: 0.5 };
const candidates: AdventureSelectionCandidate[] = [
  { candidateId: "travel:mill", digest: "a".repeat(64), kind: "exact_actor_travel.select", label: "Travel to the mill" },
  { candidateId: "check:climb", digest: "b".repeat(64), kind: "exact_srd_check.select", label: "Climb the mill wall" },
];

const noul = (value: number): SystemOneAnswer => ({ type: "noul", noul: value });
const choice = (value: string, top: number): SystemOneAnswer => ({
  type: "choice",
  choice: value,
  confidence: top,
  probabilities: { [value]: top, [ADVENTURE_NONE]: Math.max(0, 1 - top) },
});
const score = (value: number): SystemOneAnswer => ({ type: "score", score: value, confidence: 0.9, legend: {}, probabilities: {} });

describe("buildAdventureSelectionQuestions", () => {
  it("builds one support noul, one relevance score per candidate, and a fail-closed aggregate choice", () => {
    const questions = buildAdventureSelectionQuestions("I head to the mill.", candidates);
    expect(questions[ADVENTURE_SUPPORTED_KEY]?.type).toBe("noul");
    expect(questions[`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]?.type).toBe("score");
    expect(questions[`${ADVENTURE_RELEVANCE_PREFIX}check:climb`]?.type).toBe("score");
    expect(questions[ADVENTURE_BEST_KEY]?.type).toBe("choice");
    const aggregate = questions[ADVENTURE_BEST_KEY];
    if (aggregate?.type !== "choice") throw new Error("aggregate must be a choice");
    expect(Object.keys(aggregate.criteria)).toEqual(["travel:mill", "check:climb", ADVENTURE_NONE]);
    expect(aggregate.criteria[ADVENTURE_NONE]).toBeTruthy();
    expect(aggregate.instructions).toContain("or none");
  });

  it("embeds the declaration and tolerates empty text and zero candidates", () => {
    const embedded = buildAdventureSelectionQuestions("I climb the wall.", [candidates[1]!]);
    const support = embedded[ADVENTURE_SUPPORTED_KEY];
    if (support?.type !== "noul") throw new Error("support must be a noul");
    expect(String(support.instructions)).toContain("I climb the wall.");
    expect(() => buildAdventureSelectionQuestions("   ", [])).not.toThrow();
    const empty = buildAdventureSelectionQuestions("   ", []);
    expect(empty[`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]).toBeUndefined();
    const aggregate = empty[ADVENTURE_BEST_KEY];
    if (aggregate?.type !== "choice") throw new Error("aggregate must be a choice");
    expect(Object.keys(aggregate.criteria)).toEqual([ADVENTURE_NONE]);
  });
});

describe("composeAdventureSelection", () => {
  it("acts on an advertised candidate when both independent claims clear the action threshold", () => {
    const composition = composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.9),
    }, thresholds);
    expect(composition).toEqual({
      band: "act",
      method: "choice",
      selection: { candidateId: "travel:mill", digest: "a".repeat(64) },
      topSignal: 0.9,
    });
  });

  it("confirms, rather than acts, when the weaker claim sits in the review band", () => {
    const composition = composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.6),
      [ADVENTURE_BEST_KEY]: choice("check:climb", 0.9),
    }, thresholds);
    expect(composition.band).toBe("confirm");
    expect(composition.method).toBe("choice");
    expect(composition.selection?.candidateId).toBe("check:climb");
    expect(composition.topSignal).toBe(0.6);
  });

  it("fails closed when either claim is weak, even if the other is confident", () => {
    const unsupported = composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.2),
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.95),
    }, thresholds);
    expect(unsupported).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: 0.2 });
    const hesitant = composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.95),
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.4),
    }, thresholds);
    expect(hesitant.selection).toBeNull();
    expect(hesitant.topSignal).toBe(0.4);
  });

  it("defers on none_of_these, an undeclared id, a missing noul, or no candidates", () => {
    expect(composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice(ADVENTURE_NONE, 0.99),
    }, thresholds).selection).toBeNull();
    expect(composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice("invented:teleport", 0.99),
    }, thresholds).band).toBe("fallback");
    expect(composeAdventureSelection(candidates, {
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.99),
    }, thresholds).band).toBe("fallback");
    expect(composeAdventureSelection([], {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice("travel:mill", 0.99),
    }, thresholds)).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: null });
  });

  it("never throws on malformed or missing probability maps", () => {
    const malformed = { type: "choice", choice: "travel:mill", confidence: 0.9, probabilities: {} } as SystemOneAnswer;
    expect(() => composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [ADVENTURE_BEST_KEY]: malformed,
    }, thresholds)).not.toThrow();
    expect(composeAdventureSelection(candidates, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [ADVENTURE_BEST_KEY]: malformed,
    }, thresholds).band).toBe("fallback");
  });

  it("normalizes the per-candidate relevance score and clamps out-of-range values", () => {
    expect(adventureCandidateRelevance({ [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: {} } }, "travel:mill")).toBe(1);
    expect(adventureCandidateRelevance({ [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: {} } }, "travel:mill")).toBe(0);
    expect(adventureCandidateRelevance({ [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: { type: "score", score: 9, confidence: 0.9, legend: {}, probabilities: {} } }, "travel:mill")).toBe(1);
    expect(adventureCandidateRelevance({}, "travel:mill")).toBeNull();
    expect(adventureCandidateRelevance({ [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: noul(0.9) }, "travel:mill")).toBeNull();
  });
});

describe("interchangeable candidate collapse", () => {
  const potionLabel = "Use combat consumable: Potion of Healing → Aster Vale";
  const potions: AdventureSelectionCandidate[] = [
    { candidateId: "consumable:potion-b", digest: "b".repeat(64), kind: "exact_combat_consumable.select", label: potionLabel },
    { candidateId: "consumable:potion-a", digest: "a".repeat(64), kind: "exact_combat_consumable.select", label: potionLabel },
    { candidateId: "consumable:potion-c", digest: "c".repeat(64), kind: "exact_combat_consumable.select", label: potionLabel },
  ];
  const representative = potions[1]!;

  it("collapses two identical candidates into one relevance question and one criterion", () => {
    const questions = buildAdventureSelectionQuestions("I feed Aster a healing potion.", potions.slice(0, 2));

    expect(Object.keys(questions)).toEqual([
      ADVENTURE_SUPPORTED_KEY,
      `${ADVENTURE_RELEVANCE_PREFIX}${representative.candidateId}`,
      ADVENTURE_BEST_KEY,
    ]);
    expect(questions[`${ADVENTURE_RELEVANCE_PREFIX}consumable:potion-b`]).toBeUndefined();
    const relevance = questions[`${ADVENTURE_RELEVANCE_PREFIX}${representative.candidateId}`];
    if (relevance?.type !== "score") throw new Error("relevance must be a score");
    expect(String(relevance.instructions)).toContain("Potion of Healing");
    expect(String(relevance.instructions)).toContain("exact_combat_consumable.select");
    const aggregate = questions[ADVENTURE_BEST_KEY];
    if (aggregate?.type !== "choice") throw new Error("aggregate must be a choice");
    expect(Object.keys(aggregate.criteria)).toEqual([representative.candidateId, ADVENTURE_NONE]);
    expect(String(aggregate.criteria[representative.candidateId])).toContain("Potion of Healing");
    expect(String(aggregate.criteria[representative.candidateId])).toContain("exact_combat_consumable.select");
  });

  it("collapses three identical candidates and composes the lowest candidate id with its own digest", () => {
    const questions = buildAdventureSelectionQuestions("I feed Aster a healing potion.", potions);

    expect(Object.keys(questions)).toEqual([
      ADVENTURE_SUPPORTED_KEY,
      `${ADVENTURE_RELEVANCE_PREFIX}${representative.candidateId}`,
      ADVENTURE_BEST_KEY,
    ]);
    const aggregate = questions[ADVENTURE_BEST_KEY];
    if (aggregate?.type !== "choice") throw new Error("aggregate must be a choice");
    expect(Object.keys(aggregate.criteria)).toEqual([representative.candidateId, ADVENTURE_NONE]);

    const composition = composeAdventureSelection(potions, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [`${ADVENTURE_RELEVANCE_PREFIX}${representative.candidateId}`]: score(3),
      [ADVENTURE_BEST_KEY]: { type: "choice", choice: representative.candidateId, confidence: 0.95,
        probabilities: { [representative.candidateId]: 0.95, [ADVENTURE_NONE]: 0.05 } },
    }, thresholds);
    expect(composition).toEqual({
      band: "act",
      method: "choice",
      selection: { candidateId: representative.candidateId, digest: representative.digest },
      topSignal: 0.9,
    });
  });

  it("resolves a named interchangeable member to the same representative id and digest", () => {
    // A second, distinct group keeps the aggregate choice authoritative, so this still exercises
    // the multi-group member-to-representative mapping.
    const mixed = [candidates[0]!, ...potions];
    const member = potions[2]!;
    const composition = composeAdventureSelection(mixed, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [ADVENTURE_BEST_KEY]: { type: "choice", choice: member.candidateId, confidence: 0.95,
        probabilities: { [member.candidateId]: 0.95, [ADVENTURE_NONE]: 0.05 } },
    }, thresholds);

    expect(composition).toMatchObject({ band: "act", method: "choice",
      selection: { candidateId: representative.candidateId, digest: representative.digest } });
  });

  it("keeps identical labels under different kinds as separate candidates", () => {
    const crossKind: AdventureSelectionCandidate[] = [
      { candidateId: "consumable:heal-1", digest: "1".repeat(64), kind: "exact_combat_consumable.select", label: "Use a healing item on Aster Vale" },
      { candidateId: "power:heal-1", digest: "2".repeat(64), kind: "exact_power_use.select", label: "Use a healing item on Aster Vale" },
    ];
    const questions = buildAdventureSelectionQuestions("I heal Aster.", crossKind);

    expect(Object.keys(questions)).toEqual([
      ADVENTURE_SUPPORTED_KEY,
      `${ADVENTURE_RELEVANCE_PREFIX}consumable:heal-1`,
      `${ADVENTURE_RELEVANCE_PREFIX}power:heal-1`,
      ADVENTURE_BEST_KEY,
    ]);
    const aggregate = questions[ADVENTURE_BEST_KEY];
    if (aggregate?.type !== "choice") throw new Error("aggregate must be a choice");
    expect(Object.keys(aggregate.criteria)).toEqual(["consumable:heal-1", "power:heal-1", ADVENTURE_NONE]);

    for (const picked of crossKind) {
      const composition = composeAdventureSelection(crossKind, {
        [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
        [ADVENTURE_BEST_KEY]: { type: "choice", choice: picked.candidateId, confidence: 0.9,
          probabilities: { [picked.candidateId]: 0.9, [ADVENTURE_NONE]: 0.1 } },
      }, thresholds);
      expect(composition.selection).toEqual({ candidateId: picked.candidateId, digest: picked.digest });
    }
  });

  it("keeps distinct labels separate and collapses only the exact duplicate group in advertised order", () => {
    const mixed: AdventureSelectionCandidate[] = [
      { candidateId: "travel:mill", digest: "d".repeat(64), kind: "exact_actor_travel.select", label: "Travel to the mill" },
      potions[0]!,
      potions[1]!,
      { candidateId: "check:climb", digest: "e".repeat(64), kind: "exact_srd_check.select", label: "Climb the mill wall" },
    ];
    const questions = buildAdventureSelectionQuestions("I head to the mill.", mixed);
    const aggregate = questions[ADVENTURE_BEST_KEY];
    if (aggregate?.type !== "choice") throw new Error("aggregate must be a choice");

    expect(Object.keys(aggregate.criteria)).toEqual(["travel:mill", representative.candidateId, "check:climb", ADVENTURE_NONE]);
    expect(questions[`${ADVENTURE_RELEVANCE_PREFIX}consumable:potion-b`]).toBeUndefined();
    expect(questions[`${ADVENTURE_RELEVANCE_PREFIX}check:climb`]).toBeDefined();
  });

  it("still defers on none_of_these and undeclared ids when duplicates coexist with other groups", () => {
    // The second distinct group keeps the aggregate choice authoritative; with a sole group the
    // aggregate answer is advisory only (covered under single-group composition).
    const mixed = [...potions, candidates[0]!];
    expect(composeAdventureSelection(mixed, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice(ADVENTURE_NONE, 0.99),
    }, thresholds)).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: null });
    expect(composeAdventureSelection(mixed, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice("invented:teleport", 0.99),
    }, thresholds).band).toBe("fallback");
  });

  it("resolves the shared relevance answer for every member id of a collapsed group", () => {
    const answers: Record<string, SystemOneAnswer> = {
      [`${ADVENTURE_RELEVANCE_PREFIX}${representative.candidateId}`]: { type: "score", score: 3, confidence: 0.9, legend: {}, probabilities: {} },
    };

    expect(adventureCandidateRelevance(answers, representative.candidateId)).toBe(1);
    for (const potion of potions) {
      expect(adventureCandidateRelevance(answers, potion.candidateId, potions)).toBe(1);
    }
    // Without the advertised list a member has no answer of its own; an unadvertised id never resolves.
    expect(adventureCandidateRelevance(answers, "consumable:potion-b")).toBeNull();
    expect(adventureCandidateRelevance(answers, "invented:teleport", potions)).toBeNull();
  });
});

describe("single-group composition ignores the aggregate choice", () => {
  const potionLabel = "Use combat consumable: Potion of Healing → Aster Vale";
  // Two interchangeable copies collapse to one group; the representative is the lowest candidateId.
  const potions: AdventureSelectionCandidate[] = [
    { candidateId: "consumable:potion-b", digest: "b".repeat(64), kind: "exact_combat_consumable.select", label: potionLabel },
    { candidateId: "consumable:potion-a", digest: "a".repeat(64), kind: "exact_combat_consumable.select", label: potionLabel },
  ];
  const representative = potions[1]!;
  const relevanceKey = `${ADVENTURE_RELEVANCE_PREFIX}${representative.candidateId}`;

  it("acts on the sole group even when the aggregate choice answers none_of_these", () => {
    // Mirrors the live battery: supported 0.91, relevance 2.76/3 = 0.92, best_candidate
    // none_of_these. Under these test thresholds (act >= 0.75, confirm >= 0.5) the composed
    // signal min(0.91, 0.92) = 0.91 lands in `act`, so this documents the expected band.
    const composition = composeAdventureSelection(potions, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.91),
      [relevanceKey]: score(2.76),
      [ADVENTURE_BEST_KEY]: choice(ADVENTURE_NONE, 0.59),
    }, thresholds);
    expect(composition).toEqual({
      band: "act",
      method: "choice",
      selection: { candidateId: representative.candidateId, digest: representative.digest },
      topSignal: 0.91,
    });
  });

  it("ignores an undeclared aggregate id as well", () => {
    const composition = composeAdventureSelection(potions, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.91),
      [relevanceKey]: score(2.76),
      [ADVENTURE_BEST_KEY]: choice("invented:teleport", 0.99),
    }, thresholds);
    expect(composition).toMatchObject({
      band: "act",
      method: "choice",
      selection: { candidateId: representative.candidateId, digest: representative.digest },
    });
  });

  it("defers on weak relevance even when supported is high", () => {
    const composition = composeAdventureSelection(potions, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.95),
      [relevanceKey]: score(1), // 1/3 ≈ 0.33, below the review threshold
      [ADVENTURE_BEST_KEY]: choice(representative.candidateId, 0.99),
    }, thresholds);
    expect(composition).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: 1 / 3 });
  });

  it("defers on weak supported even when relevance is high", () => {
    const composition = composeAdventureSelection(potions, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.2),
      [relevanceKey]: score(3),
      [ADVENTURE_BEST_KEY]: choice(representative.candidateId, 0.99),
    }, thresholds);
    expect(composition).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: 0.2 });
  });

  it("selects the deterministic representative for interchangeable duplicates", () => {
    const composition = composeAdventureSelection(potions, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.9),
      [relevanceKey]: score(3),
      [ADVENTURE_BEST_KEY]: choice("consumable:potion-b", 0.99), // a non-representative member
    }, thresholds);
    expect(composition).toEqual({
      band: "act",
      method: "choice",
      selection: { candidateId: representative.candidateId, digest: representative.digest },
      topSignal: 0.9,
    });
  });

  it("fails closed when relevance is missing or malformed, or supported is not a finite noul", () => {
    expect(composeAdventureSelection(potions, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [ADVENTURE_BEST_KEY]: choice(representative.candidateId, 0.99),
    }, thresholds)).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: null });

    expect(composeAdventureSelection(potions, {
      [ADVENTURE_SUPPORTED_KEY]: noul(0.99),
      [relevanceKey]: noul(0.99), // wrong answer type for a score question
      [ADVENTURE_BEST_KEY]: choice(representative.candidateId, 0.99),
    }, thresholds)).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: null });

    for (const supported of [
      { type: "noul", noul: Number.NaN } as SystemOneAnswer,
      { type: "noul", noul: Number.POSITIVE_INFINITY } as SystemOneAnswer,
      { type: "choice", choice: representative.candidateId, confidence: 0.99, probabilities: {} } as SystemOneAnswer,
    ]) {
      expect(composeAdventureSelection(potions, {
        [ADVENTURE_SUPPORTED_KEY]: supported,
        [relevanceKey]: score(3),
        [ADVENTURE_BEST_KEY]: choice(representative.candidateId, 0.99),
      }, thresholds)).toEqual({ band: "fallback", method: "defer", selection: null, topSignal: null });
    }
  });
});

describe("multi-group composition stays choice-driven", () => {
  const mixed: AdventureSelectionCandidate[] = [
    { candidateId: "travel:mill", digest: "a".repeat(64), kind: "exact_actor_travel.select", label: "Travel to the mill" },
    { candidateId: "check:climb", digest: "b".repeat(64), kind: "exact_srd_check.select", label: "Climb the mill wall" },
  ];
  const answers = (best: SystemOneAnswer): Record<string, SystemOneAnswer> => ({
    [ADVENTURE_SUPPORTED_KEY]: noul(0.95),
    // Relevance is deliberately perfect so these tests prove the multi-group signal still comes
    // from the aggregate choice, not from relevance.
    [`${ADVENTURE_RELEVANCE_PREFIX}travel:mill`]: score(3),
    [`${ADVENTURE_RELEVANCE_PREFIX}check:climb`]: score(3),
    [ADVENTURE_BEST_KEY]: best,
  });

  it("still defers on none_of_these and undeclared ids despite perfect relevance", () => {
    expect(composeAdventureSelection(mixed, answers(choice(ADVENTURE_NONE, 0.99)), thresholds))
      .toEqual({ band: "fallback", method: "defer", selection: null, topSignal: null });
    expect(composeAdventureSelection(mixed, answers(choice("invented:teleport", 0.99)), thresholds))
      .toEqual({ band: "fallback", method: "defer", selection: null, topSignal: null });
  });

  it("selects the named group's representative and gates on the option's own probability", () => {
    expect(composeAdventureSelection(mixed, answers(choice("check:climb", 0.9)), thresholds))
      .toEqual({
        band: "act",
        method: "choice",
        selection: { candidateId: "check:climb", digest: "b".repeat(64) },
        topSignal: 0.9,
      });
    // 0.6 choice probability with 0.95 supported lands in confirm, not act, even at relevance 1.
    expect(composeAdventureSelection(mixed, answers(choice("check:climb", 0.6)), thresholds))
      .toEqual({
        band: "confirm",
        method: "choice",
        selection: { candidateId: "check:climb", digest: "b".repeat(64) },
        topSignal: 0.6,
      });
  });
});

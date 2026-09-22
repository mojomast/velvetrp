import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  AUDIT_FLAG_CLASSES,
  CLAIM_FAMILIES,
  CLAIM_LEXICON,
  analyzeClaimReceipts,
  auditTurn,
  classifyCombatOutcomeMismatch,
  classifyLaneActUncommitted,
  classifyNarrationMissing,
  countFlagsByClass,
  detectClaimFamilies,
  familyForExactActionKind,
  familiesForToolName,
  flagsTriggeringFailure,
  hasHealingEvidence,
  jsonHasHealingEvidence,
  parseAuditArgs,
  parseLaneSelection,
  resolveWorldDatabasePath,
} from "../audit-adventure-consistency.js";
import type { ClaimFamily, TurnAuditInput } from "../audit-adventure-consistency.js";

function makeTurn(overrides: Partial<TurnAuditInput> = {}): TurnAuditInput {
  return {
    turnId: "turn-1",
    declaration: "I take a long rest.",
    state: "completed",
    narrationStatus: "completed",
    narration: "I take a long rest.",
    lane: null,
    laneExecution: false,
    laneProposalBinding: false,
    laneBindingEvidence: [],
    confirmationEvidence: null,
    receiptFamilies: [],
    receiptEvidence: [],
    receiptContentFamilies: [],
    proposalFamilies: [],
    proposalEvidence: [],
    combatOutcome: null,
    context: "providerCalls=1; toolCalls=[]",
    ...overrides,
  };
}

const ACT_LANE = {
  decisionId: "decision-1",
  confidenceBand: "act",
  method: "choice",
  candidateId: "candidate-1",
  hasSelection: true,
  shadow: false,
} as const;

const SHADOW_ACT_LANE = {
  ...ACT_LANE,
  decisionId: "decision-shadow",
  shadow: true,
} as const;

test("CLAIM_LEXICON covers every family with patterns and receipt sources", () => {
  for (const family of CLAIM_FAMILIES) {
    assert.ok(CLAIM_LEXICON[family].patterns.length > 0, `${family} needs patterns`);
    assert.ok(CLAIM_LEXICON[family].receiptSources.length > 0, `${family} needs receipt sources`);
  }
});

test("detectClaimFamilies matches the documented lexicon for every family", () => {
  const cases: ReadonlyArray<readonly [string, ClaimFamily]> = [
    ["I drink my potion of healing", "healing"],
    ["We take a long rest by the fire", "rest"],
    ["I search the room for tracks", "check"],
    ["I swing my sword at the goblin", "attack"],
    ["I channel my power and cast a spell", "power"],
    ["We head to the docks and sail north", "movement"],
    ["I hand in the quest for my reward", "quest"],
  ];
  for (const [text, family] of cases) {
    assert.ok(detectClaimFamilies(text).includes(family), `"${text}" should claim ${family}`);
  }
});

test("detectClaimFamilies ignores negated and idiomatic phrases", () => {
  assert.deepEqual(detectClaimFamilies("No movement or other campaign change is established."), []);
  assert.deepEqual(detectClaimFamilies("I did not rest; there was no time to bandage."), []);
  assert.deepEqual(detectClaimFamilies("We split the rest of the coin."), []);
  assert.deepEqual(detectClaimFamilies("The goblin's hit points drop to zero."), []);
  assert.deepEqual(detectClaimFamilies("I didn't search the room."), []);
});

function claimsMovement(text: string): boolean {
  return detectClaimFamilies(text).includes("movement");
}

test("movement claims ignore directive and intent phrasing", () => {
  const directive = "You stand in Bramford's square, and this is what it asks of you:"
    + " walk the hill track above town before the fair fills the square;"
    + " learn what stopped the rider.";
  assert.equal(claimsMovement(directive), false);
  assert.deepEqual(
    auditTurn(makeTurn({ narration: directive }))
      .filter((flag) => flag.class === "claim-without-receipt"),
    [],
  );

  assert.equal(claimsMovement("You might walk the hill track later."), false);
  assert.equal(claimsMovement("You could travel by river; you should head north."), false);
  assert.equal(claimsMovement("If you walk the hill track, you will find the watch."), false);
  assert.equal(claimsMovement("Check the traps before you leave town."), false);
  assert.equal(claimsMovement("You take the old road in order to reach the watch."), false);
  assert.equal(claimsMovement("You will travel the north road tomorrow."), false);
  assert.equal(claimsMovement("Do you walk the hill track before the fair?"), false);
  assert.equal(claimsMovement("Her eyes travel the row of your gear."), false);
});

test("movement claims accept completed forms and present action statements", () => {
  assert.equal(claimsMovement("The party traveled the coast road all morning."), true);
  assert.equal(claimsMovement("We reached the watch by noon."), true);
  assert.equal(claimsMovement("Margery left the stall for the hill pastures."), true);
  assert.equal(claimsMovement("They set out at first light."), true);
  assert.equal(claimsMovement("You walk the hill track above town."), true);
  assert.equal(claimsMovement("The party travels the coast road."), true);
  assert.equal(claimsMovement("You are traveling by night."), true);

  const past = auditTurn(makeTurn({
    declaration: "I follow the hill track.",
    narration: "You traveled the north road all morning.",
  })).filter((flag) => flag.class === "claim-without-receipt");
  assert.equal(past.length, 1);
  assert.match(past[0]!.evidence, /narration claims movement \(matched "traveled"\)/);

  const subject = auditTurn(makeTurn({
    declaration: "I walk the hill track.",
    narration: "You walk the hill track above town.",
  })).filter((flag) => flag.class === "claim-without-receipt");
  assert.equal(subject.length, 1);
  assert.match(subject[0]!.evidence, /narration claims movement \(matched "walk"\)/);

  const modal = auditTurn(makeTurn({ narration: "You might walk the hill track later." }));
  assert.deepEqual(modal.filter((flag) => flag.class === "claim-without-receipt"), []);
});

test("analyzeClaimReceipts separates missing backing from ambient receipts", () => {
  const missing = analyzeClaimReceipts({
    narration: "I take a long rest by the fire.",
    receiptFamilies: ["healing"],
    proposalFamilies: [],
  });
  assert.deepEqual(missing.claimWithoutReceipt.map((claim) => claim.family), ["rest"]);
  assert.deepEqual(missing.receiptWithoutClaim, ["healing"]);

  const proposed = analyzeClaimReceipts({
    narration: "I drink the potion.",
    receiptFamilies: [],
    proposalFamilies: ["healing"],
  });
  assert.deepEqual(proposed.claimWithoutReceipt, []);
  assert.deepEqual(proposed.receiptWithoutClaim, []);
});

test("jsonHasHealingEvidence detects healing outcomes and health gains but not damage", () => {
  assert.equal(jsonHasHealingEvidence(JSON.stringify({
    powerName: "Second Wind",
    outcomes: [{ kind: "healing", applied: 9, before: 3, after: 12 }],
  })), true);
  assert.equal(jsonHasHealingEvidence(JSON.stringify({
    powerName: "Searing Smite",
    outcomes: [{ kind: "damage", applied: 7, before: 12, after: 5 }],
  })), false);
  assert.equal(jsonHasHealingEvidence(JSON.stringify({
    resources: [{ resourceId: "health", before: 3, after: 12 }],
  })), true);
  assert.equal(jsonHasHealingEvidence(JSON.stringify({
    resources: [{ resourceId: "health", current: 9 }],
  })), false, "a direction-less health mirror is not healing");
  assert.equal(jsonHasHealingEvidence("{"), false);
  assert.equal(hasHealingEvidence({ nested: [{ type: "Heal", amount: 4 }] }), true);
});

test("a combat-power execution whose result heals satisfies a healing claim", () => {
  const healingPower = JSON.stringify({
    powerName: "Second Wind",
    outcomes: [{ kind: "healing", applied: 9, before: 3, after: 12 }],
  });
  assert.equal(jsonHasHealingEvidence(healingPower), true);
  const analysis = analyzeClaimReceipts({
    narration: "Second Wind uses one action; 11 rolled; 9 healing applied.",
    receiptFamilies: ["power"],
    proposalFamilies: ["power"],
    contentBackedFamilies: ["healing"],
  });
  assert.deepEqual(analysis.claimWithoutReceipt, []);
});

test("auditTurn treats content-backed healing as receipt backing", () => {
  const flags = auditTurn(makeTurn({
    declaration: "I grit my teeth and use Second Wind to get back in the fight.",
    narration: "Second Wind uses one action on Aster Vale. 11 rolled; 9 healing applied; Aster Vale changes from 3 to 12 HP.",
    receiptFamilies: ["power"],
    receiptEvidence: ["adventure_exact_action_executions_v56:combat-power"],
    receiptContentFamilies: ["healing"],
  }));
  assert.deepEqual(flags, []);
});

test("a combat-power execution without healing still flags a healing claim", () => {
  const attackPower = JSON.stringify({
    powerName: "Searing Smite",
    outcomes: [{ kind: "damage", applied: 7, before: 12, after: 5 }],
  });
  assert.equal(jsonHasHealingEvidence(attackPower), false);
  const flags = auditTurn(makeTurn({
    declaration: "I call on my power.",
    narration: "Second Wind surges through me; 9 healing applied to Aster Vale.",
    receiptFamilies: ["power"],
    receiptEvidence: ["adventure_exact_action_executions_v56:combat-power"],
    receiptContentFamilies: [],
  }));
  assert.deepEqual(flags.map((flag) => flag.class), ["claim-without-receipt"]);
});

test("a family-based healing receipt still satisfies a healing claim without content detection", () => {
  const analysis = analyzeClaimReceipts({
    narration: "I drink the potion of healing.",
    receiptFamilies: ["healing"],
    proposalFamilies: [],
  });
  assert.deepEqual(analysis.claimWithoutReceipt, []);
  assert.deepEqual(analysis.receiptWithoutClaim, []);

  const flags = auditTurn(makeTurn({
    declaration: "I drink my potion.",
    narration: "I drink the potion of healing.",
    receiptFamilies: ["healing"],
    receiptEvidence: ["adventure_exact_action_executions_v56:combat-consumable"],
  }));
  assert.deepEqual(flags, []);
});

test("parseLaneSelection reads candidate picks, shadow mode, and tolerates malformed JSON", () => {
  const parsed = parseLaneSelection({
    decisionId: "decision-1",
    confidenceBand: "act",
    selectionJson: JSON.stringify({ method: "choice", selection: { candidateId: "candidate-1" } }),
    shadow: true,
  });
  assert.equal(parsed.hasSelection, true);
  assert.equal(parsed.candidateId, "candidate-1");
  assert.equal(parsed.method, "choice");
  assert.equal(parsed.shadow, true);

  const deferred = parseLaneSelection({
    decisionId: "decision-2",
    confidenceBand: "fallback",
    selectionJson: JSON.stringify({ method: "defer", selection: null }),
    shadow: false,
  });
  assert.equal(deferred.hasSelection, false);
  assert.equal(deferred.shadow, false);

  const malformed = parseLaneSelection({ decisionId: "decision-3", confidenceBand: "act", selectionJson: "{", shadow: false });
  assert.equal(malformed.hasSelection, false);
  assert.equal(malformed.method, null);
});

test("classifyLaneActUncommitted separates missing commits from confirmation waits and shadow records", () => {
  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "fallback", hasSelection: true, hasExecution: false, hasProposalBinding: false, shadow: false,
  }), null);
  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "act", hasSelection: false, hasExecution: false, hasProposalBinding: false, shadow: false,
  }), null);
  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "act", hasSelection: true, hasExecution: false, hasProposalBinding: false, shadow: false,
  }), "missing");
  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "act", hasSelection: true, hasExecution: false, hasProposalBinding: true, shadow: false,
  }), "awaiting-confirmation");
  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "act", hasSelection: true, hasExecution: true, hasProposalBinding: true, shadow: false,
  }), null);

  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "act", hasSelection: true, hasExecution: false, hasProposalBinding: false, shadow: true,
  }), "shadow-no-commit");
  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "act", hasSelection: true, hasExecution: false, hasProposalBinding: true, shadow: true,
  }), "awaiting-confirmation", "a bound proposal is a wait even for a shadow decision");
  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "act", hasSelection: true, hasExecution: true, hasProposalBinding: false, shadow: true,
  }), null, "an executed shadow decision did commit");
  assert.equal(classifyLaneActUncommitted({
    confidenceBand: "fallback", hasSelection: true, hasExecution: false, hasProposalBinding: false, shadow: true,
  }), null);
});

test("classifyCombatOutcomeMismatch flags damage/miss and damage/hit contradictions", () => {
  const base = { narration: "", damageDealt: 0, receiptStatuses: ["active"], targets: [] };
  const dodged = classifyCombatOutcomeMismatch({ ...base, narration: "The goblin dodges the blow.", damageDealt: 4 });
  assert.deepEqual(dodged.map((verdict) => verdict.kind), ["damage-claimed-miss"]);

  const consistent = classifyCombatOutcomeMismatch({
    ...base, narration: "My blade hits and the goblin staggers.", damageDealt: 4,
  });
  assert.deepEqual(consistent, []);

  const phantomHit = classifyCombatOutcomeMismatch({
    ...base, narration: "I hit the goblin square in the chest.", damageDealt: 0,
  });
  assert.deepEqual(phantomHit.map((verdict) => verdict.kind), ["damage-claimed-without-damage"]);

  const honestMiss = classifyCombatOutcomeMismatch({ ...base, narration: "I swing and miss.", damageDealt: 0 });
  assert.deepEqual(honestMiss, []);
});

test("classifyCombatOutcomeMismatch flags defeat claims over standing targets", () => {
  const standing = {
    narration: "The goblin is dead, slain by my blade.",
    damageDealt: 3,
    receiptStatuses: ["active"],
    targets: [{ name: "Goblin", status: "active", hitPoints: 7 }],
  };
  assert.deepEqual(
    classifyCombatOutcomeMismatch(standing).map((verdict) => verdict.kind),
    ["defeat-claimed-target-active"],
  );

  const down = classifyCombatOutcomeMismatch({
    ...standing,
    targets: [{ name: "Goblin", status: "defeated", hitPoints: 0 }],
  });
  assert.deepEqual(down, []);

  const mixed = classifyCombatOutcomeMismatch({
    ...standing,
    targets: [
      { name: "Goblin", status: "active", hitPoints: 7 },
      { name: "Bandit", status: "dead", hitPoints: 0 },
    ],
  });
  assert.deepEqual(mixed, [], "any downed combatant suppresses the defeat mismatch");
});

test("classifyNarrationMissing only fires for completed turns", () => {
  assert.equal(classifyNarrationMissing({ state: "completed", narrationStatus: "completed", narration: null }), true);
  assert.equal(classifyNarrationMissing({ state: "completed", narrationStatus: "completed", narration: "   " }), true);
  assert.equal(classifyNarrationMissing({ state: "awaiting-confirmation", narrationStatus: "none", narration: null }), false);
  assert.equal(classifyNarrationMissing({ state: "completed", narrationStatus: "completed", narration: "The door opens." }), false);
});

test("auditTurn composes classes with severities and verdicts", () => {
  const claim = auditTurn(makeTurn({
    declaration: "I rest before moving on.",
    narration: "I take a long rest by the fire.",
  }));
  assert.deepEqual(claim.map((flag) => flag.class), ["claim-without-receipt"]);
  assert.equal(claim[0]!.severity, "actionable");
  assert.equal(claim[0]!.confidence, "signal");
  assert.match(claim[0]!.evidence, /narration claims rest/);

  const ambient = auditTurn(makeTurn({
    narration: "The dust settles.",
    receiptFamilies: ["attack"],
    receiptEvidence: ["combat_receipts_v27:attack damage=4"],
  }));
  assert.deepEqual(ambient.map((flag) => `${flag.class}:${flag.severity}`), ["receipt-without-claim:informational"]);

  const waiting = auditTurn(makeTurn({
    lane: ACT_LANE,
    laneProposalBinding: true,
    laneBindingEvidence: ["proposal-1"],
    confirmationEvidence: "proposal-1=pending",
    receiptFamilies: ["rest"],
  }));
  assert.deepEqual(
    waiting.map((flag) => `${flag.class}:${flag.verdict}:${flag.severity}`),
    ["lane-act-uncommitted:awaiting-confirmation:informational"],
  );

  const empty = auditTurn(makeTurn({ narration: null }));
  assert.deepEqual(empty.map((flag) => flag.class), ["narration-missing"]);
});

test("auditTurn keeps cancelled-turn lane misses informational", () => {
  const flags = auditTurn(makeTurn({
    state: "cancelled",
    narrationStatus: "none",
    narration: null,
    declaration: "Wait, no.",
    lane: ACT_LANE,
  }));
  assert.deepEqual(
    flags.map((flag) => `${flag.class}:${flag.verdict}:${flag.severity}`),
    ["lane-act-uncommitted:missing:informational"],
  );
});

test("auditTurn reads shadow decisions as informational no-commits instead of missing commits", () => {
  const shadow = auditTurn(makeTurn({
    declaration: "I wait and watch the water.",
    narration: "The lantern gutters.",
    lane: SHADOW_ACT_LANE,
  }));
  assert.deepEqual(
    shadow.map((flag) => `${flag.class}:${flag.verdict}:${flag.severity}`),
    ["lane-act-uncommitted:shadow-no-commit:informational"],
  );
  assert.match(shadow[0]!.evidence, /the decision is shadow \(advisory\), so it cannot commit by design/);

  const unshadowed = auditTurn(makeTurn({
    declaration: "I wait and watch the water.",
    narration: "The lantern gutters.",
    lane: ACT_LANE,
  }));
  assert.deepEqual(
    unshadowed.map((flag) => `${flag.class}:${flag.verdict}:${flag.severity}`),
    ["lane-act-uncommitted:missing:actionable"],
  );
});

test("auditTurn surfaces a confirmation wait for a rejected pick without firing a commit miss", () => {
  const flags = auditTurn(makeTurn({
    lane: ACT_LANE,
    laneProposalBinding: true,
    laneBindingEvidence: ["proposal-1"],
    confirmationEvidence: "proposal-1=rejected",
    receiptFamilies: ["rest"],
  }));
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.verdict, "awaiting-confirmation");
  assert.match(flags[0]!.evidence, /confirmation: proposal-1=rejected/);
});

test("familyForExactActionKind and familiesForToolName map onto claim families", () => {
  assert.equal(familyForExactActionKind("combat-consumable"), "healing");
  assert.equal(familyForExactActionKind("rest"), "rest");
  assert.equal(familyForExactActionKind("quest-reward"), "quest");
  assert.equal(familyForExactActionKind("progression"), null);
  assert.deepEqual(familiesForToolName("combat_consumable_use"), ["healing"]);
  assert.deepEqual(familiesForToolName("take_rest"), ["rest"]);
  assert.deepEqual(familiesForToolName("quest_reward_claim"), ["quest"]);
});

test("flagsTriggeringFailure skips expected lane states but honors named classes", () => {
  const waiting = auditTurn(makeTurn({
    lane: ACT_LANE,
    laneProposalBinding: true,
    laneBindingEvidence: ["proposal-1"],
    receiptFamilies: ["rest"],
  }));
  assert.deepEqual(flagsTriggeringFailure(waiting, ["lane-act-uncommitted"]), []);

  const shadow = auditTurn(makeTurn({
    lane: SHADOW_ACT_LANE,
    declaration: "I wait and watch the water.",
    narration: "The lantern gutters.",
  }));
  assert.equal(
    flagsTriggeringFailure(shadow, ["lane-act-uncommitted"]).length,
    0,
    "a shadow advisory no-commit is expected and never a failure",
  );

  const missing = auditTurn(makeTurn({ lane: ACT_LANE, declaration: "I go." }));
  assert.equal(flagsTriggeringFailure(missing, ["lane-act-uncommitted"]).length, 1);
  assert.equal(flagsTriggeringFailure(missing, ["receipt-without-claim"]).length, 0);
  assert.equal(flagsTriggeringFailure(missing, []).length, 0);

  const ambient = auditTurn(makeTurn({
    narration: "The dust settles.",
    receiptFamilies: ["attack"],
    receiptEvidence: ["combat_receipts_v27:attack damage=4"],
  }));
  assert.equal(
    flagsTriggeringFailure(ambient, ["receipt-without-claim"]).length,
    1,
    "an explicitly named informational class still fails",
  );
});

test("countFlagsByClass counts every class even when empty", () => {
  const counts = countFlagsByClass([]);
  for (const flagClass of AUDIT_FLAG_CLASSES) assert.equal(counts[flagClass], 0);
  const flags = auditTurn(makeTurn({ narration: null }));
  assert.equal(countFlagsByClass(flags)["narration-missing"], 1);
});

test("parseAuditArgs requires --world and collects repeatable --fail-on", () => {
  assert.throws(() => parseAuditArgs([]), /--world is required/);
  assert.throws(() => parseAuditArgs(["--world", "w", "--fail-on", "nope"]), /unknown flag class/);
  const options = parseAuditArgs([
    "--world=.velvet/synth-srd-3",
    "--json", "audit.json",
    "--md=audit.md",
    "--fail-on", "claim-without-receipt",
    "--fail-on=receipt-without-claim,lane-act-uncommitted",
  ]);
  assert.equal(options.world, ".velvet/synth-srd-3");
  assert.equal(options.json, path.resolve("audit.json"));
  assert.equal(options.md, path.resolve("audit.md"));
  assert.deepEqual(options.failOn, ["claim-without-receipt", "receipt-without-claim", "lane-act-uncommitted"]);
  assert.equal(parseAuditArgs(["--help"]).help, true);
});

test("resolveWorldDatabasePath appends velvet.sqlite and accepts a direct file", () => {
  assert.equal(
    resolveWorldDatabasePath(".velvet/synth-srd-3", "/repo"),
    path.join("/repo", ".velvet", "synth-srd-3", "velvet.sqlite"),
  );
  assert.equal(resolveWorldDatabasePath("relative/world", "/repo"), path.join("/repo", "relative", "world", "velvet.sqlite"));
  assert.equal(resolveWorldDatabasePath("/data/world/velvet.sqlite", "/repo"), "/data/world/velvet.sqlite");
});

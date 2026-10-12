/**
 * Regression evidence for the pre-generation gate audit.
 *
 * The first four tests were run against the unmodified gates and all passed.
 * Frozen v1 probes retain those buggy assertions; the live C/D regression tests
 * below assert the corrected behavior. Family B implementation/mutation coverage
 * belongs to the grounding agent, so these probes do not certify that gate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { sanitizeGeneratedCampaignContent } from "../../server/src/routes/rpg/v1/campaignContentGeneration.js";
import {
  scoreSelection, validateAdvertisedSelection, validateWorldGeneration,
  type ProviderDecision, type ProviderSelection,
} from "../src/worldGeneration.js";

const CANDIDATE = { toolName: "exact_inventory_action.select", candidateId: "candidate-1", digest: "a".repeat(64) };
const CHECK = { kind: "check" as const, skill: "Investigation", total: 22, dc: 15, outcome: "success" };
const NPC = { key: "npc-a", name: "A", archetype: "Guide", description: "A guide.", visibility: "public" as const };
const DEPENDENCIES = new Map([["faction-ok", { key: "faction-ok", kind: "faction", visibility: "public" as const }]]);
const VALID_SELECTION = { ...CANDIDATE, contract: "exact-candidate" as const, transportValid: true, finalOutcome: "mechanics-committed" as const };

// Frozen v1 predicates, retained only as historical reproduction evidence.
function legacyPolarity(text: string, subject: string): "absent" | "affirm" | "negate" {
  let result: "absent" | "affirm" | "negate" = "absent";
  for (const match of text.matchAll(new RegExp(subject, "gi"))) {
    const prefix = text.slice(Math.max(0, match.index - 48), match.index);
    result = /(?:no|not|never|fail(?:s|ed|ure)?|miss(?:es|ed)?|without|unable to|could not|couldn'?t)\b[^.!?]{0,40}$/i.test(prefix) ? "negate" : "affirm";
  }
  return result;
}

function legacyDamageProblems(text: string, applied: number, hpAfter: number): string[] {
  const problems: string[] = [];
  const numberAppears = (value: number) => new RegExp(`(^|[^0-9.])${value}(?![0-9.])`).test(text);
  if (!numberAppears(applied) && !numberAppears(hpAfter)) problems.push("damage-ungrounded");
  if (/\b(?:kill(?:s|ed)?|slain|defeat(?:s|ed)?|dead|dies|died|falls|drop(?:s|ped)?)\b/i.test(text) && hpAfter > 0) problems.push("fabricated-outcome");
  if (/\b(?:surviv(?:es|ed)|wounds?|merely|only)\b/i.test(text) && applied >= hpAfter) problems.push("fabricated-outcome");
  return problems;
}

function legacyDroppedWrittenFields(raw: unknown, result: unknown): string[] {
  const dropped: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !result || typeof result !== "object") return dropped;
  const output = result as Record<string, unknown>;
  for (const [field, value] of Object.entries(raw)) {
    const produced = output[field];
    if (!Array.isArray(value) || !Array.isArray(produced)) continue;
    value.forEach((item: unknown, index: number) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      const counterpart: unknown = produced[index];
      if (!counterpart || typeof counterpart !== "object") { dropped.push(`${field}[${index}] was removed entirely`); return; }
      const target = counterpart as Record<string, unknown>;
      for (const [key, written] of Object.entries(item)) {
        if (written === undefined) continue;
        const retained = target[key];
        if (!(key in target) || (Array.isArray(written) && written.length > 0 && (!Array.isArray(retained) || retained.length === 0))) dropped.push(`${field}[${index}].${key} was dropped`);
      }
    });
  }
  return dropped;
}

test("REPRODUCTION: wrong 64-hex digest was credited as a teacher outcome", () => {
  const selection = { ...CANDIDATE, digest: "b".repeat(64), transportValid: true, finalOutcome: "mechanics-committed" as const };
  const match = [CANDIDATE].find((candidate) => candidate.toolName === selection.toolName && candidate.candidateId === selection.candidateId);
  const verdict = { advertised: Boolean(match), problems: match?.digest !== selection.digest ? ["digest mismatch"] : [] };
  assert.match(verdict.problems.join("; "), /digest mismatch/);
  assert.equal(verdict.advertised, true);
  const legacyTeacherAuthoredOutcome = verdict.advertised && selection.transportValid && selection.finalOutcome === "mechanics-committed";
  assert.equal(legacyTeacherAuthoredOutcome, true);
});

test("REPRODUCTION: a contradictory check outcome and swapped damage values passed", () => {
  const text = "Your Investigation check comes to 22 against DC 15: success. The Investigation check failed.";
  assert.equal(legacyPolarity(text, CHECK.skill), "affirm");
  assert.match(text, /comes to\D{0,24}22\b[\s\S]{0,40}?\bDC\b\D{0,12}15\b/i);
  assert.equal(legacyPolarity(text, CHECK.outcome), "affirm");
  assert.deepEqual(legacyDamageProblems("The attack deals 30; the target has 5 HP remaining.", 5, 30), []);
});

test("REPRODUCTION: damage greater than remaining HP falsely ruled out survival", () => {
  assert.deepEqual(legacyDamageProblems("The target survives at 10 HP.", 20, 10), ["fabricated-outcome"]);
});

test("REPRODUCTION: partially removed faction references received a clean pass", () => {
  const raw = { npcs: [{ ...NPC, factionKeys: ["faction-ok", "faction-nope"] }] };
  const base = generatedCampaignContentProviderSchema.parse(raw);
  const candidate = sanitizeGeneratedCampaignContent(base, new Map([["faction-ok", "public"]]), new Set(), new Map([["faction-ok", "faction"]]));
  assert.equal(base, candidate, "the sanitizer also mutated the comparison baseline");
  assert.deepEqual(candidate.npcs[0]?.factionKeys, ["faction-ok"]);
  const dropped = [...legacyDroppedWrittenFields(raw, base), ...legacyDroppedWrittenFields(candidate, candidate)];
  assert.equal(dropped.length > 0, false, "v1 sanitized:false");
  assert.equal(dropped.length === 0, true, "v1 credited a clean pass");
});

test("FIX: the right id with a wrong digest receives neither advertisement nor teacher credit", () => {
  const selection = { ...VALID_SELECTION, digest: "b".repeat(64) };
  const verdict = validateAdvertisedSelection(selection, [CANDIDATE], [CANDIDATE.toolName]);
  assert.match(verdict.problems.join("; "), /digest mismatch/);
  assert.equal(verdict.advertised, false);
  assert.equal(verdict.digestMatched, false);
  const score = scoreSelection(selection, verdict);
  assert.equal(score.firstAttemptAdvertised, false);
  assert.equal(score.teacherAuthoredOutcome, false);
});

test("a matching candidate cannot compensate for an unadvertised tool", () => {
  const verdict = validateAdvertisedSelection(VALID_SELECTION, [CANDIDATE], []);
  assert.equal(verdict.advertised, true);
  assert.equal(verdict.toolAdvertised, false);
  assert.equal(scoreSelection(VALID_SELECTION, verdict).firstAttemptAdvertised, false);
  assert.equal(scoreSelection(VALID_SELECTION, verdict).teacherAuthoredOutcome, false);
});

test("any validator problem blocks teacher credit, even with a valid pair", () => {
  const verdict = validateAdvertisedSelection(VALID_SELECTION, [CANDIDATE], [CANDIDATE.toolName]);
  assert.equal(scoreSelection(VALID_SELECTION, { ...verdict, problems: ["independent contract violation"] }).teacherAuthoredOutcome, false);
});

test("menu membership never supplies scenario intent correctness", () => {
  const verdict = validateAdvertisedSelection(VALID_SELECTION, [CANDIDATE], [CANDIDATE.toolName]);
  const unknown = scoreSelection(VALID_SELECTION, verdict);
  assert.equal(unknown.firstAttemptAdvertised, true);
  assert.equal(unknown.intentCorrect, null);
  assert.equal(unknown.firstAttemptCorrect, false);
  for (const intentCorrect of [false, true]) {
    const selection = { ...VALID_SELECTION, intentCorrect };
    const checked = validateAdvertisedSelection(selection, [CANDIDATE], [CANDIDATE.toolName]);
    const score = scoreSelection(selection, checked);
    assert.equal(score.intentCorrect, intentCorrect);
    assert.equal(score.firstAttemptCorrect, intentCorrect);
    assert.equal(score.teacherAuthoredOutcome, intentCorrect);
  }
});

for (const [name, mutation] of Object.entries({
  candidate: { candidateId: "candidate-other" }, digest: { digest: "0".repeat(64) },
  transport: { transportValid: false }, recovery: { serverRecovered: true },
  pending: { confirmationStatus: "pending" as const }, rejected: { confirmationStatus: "rejected" as const },
  expired: { confirmationStatus: "expired" as const }, fallback: { finalOutcome: "fallback" as const, confirmationStatus: "approved" as const },
  held: { finalOutcome: "held" as const, confirmationStatus: "approved" as const },
})) {
  test(`selection mutation: ${name} cannot receive teacher-outcome credit`, () => {
    const selection = { ...VALID_SELECTION, intentCorrect: true, ...mutation };
    const verdict = validateAdvertisedSelection(selection, [CANDIDATE], [CANDIDATE.toolName]);
    assert.equal(scoreSelection(selection, verdict).teacherAuthoredOutcome, false);
  });
}

const NON_CANDIDATE_DECISIONS: ProviderDecision[] = [
  { contract: "read-tool", toolName: "actor_inventory.read", arguments: {}, transportValid: true, intentCorrect: true, finalOutcome: "read-completed" },
  { contract: "narration-submit", toolName: "submit_adventure_narration", arguments: { narration: "The rain falls." }, transportValid: true, intentCorrect: true, finalOutcome: "narration-submitted" },
  { contract: "clarify", message: "Which doorway?", transportValid: true, intentCorrect: true, finalOutcome: "clarified" },
  { contract: "no-tool", content: "I wait for your decision.", transportValid: true, intentCorrect: true, finalOutcome: "no-tool" },
];

for (const selection of NON_CANDIDATE_DECISIONS) {
  test(`${selection.contract} has its own valid decision contract without a candidate digest`, () => {
    const tools = selection.toolName ? [selection.toolName] : [];
    const verdict = validateAdvertisedSelection(selection, [], tools);
    assert.deepEqual(verdict.problems, []);
    const score = scoreSelection(selection, verdict);
    assert.equal(score.firstAttemptAdvertised, false, "no pair was selected");
    assert.equal(score.firstAttemptCorrect, true);
    assert.equal(score.teacherAuthoredOutcome, true);
    const wrong = { ...selection, intentCorrect: false };
    const wrongVerdict = validateAdvertisedSelection(wrong, [], tools);
    assert.equal(scoreSelection(wrong, wrongVerdict).teacherAuthoredOutcome, false);
  });
}

test("invalid non-candidate contracts cannot receive teacher credit", () => {
  const selections: ProviderSelection[] = [
    { contract: "narration-submit", toolName: "submit_adventure_narration", arguments: { narration: " " }, transportValid: true, finalOutcome: "narration-submitted" },
    { contract: "narration-submit", toolName: "other.submit", arguments: { narration: "Words." }, transportValid: true, finalOutcome: "narration-submitted" },
    { contract: "clarify", message: " ", transportValid: true, intentCorrect: true, finalOutcome: "clarified" },
    { contract: "no-tool", transportValid: true, finalOutcome: "no-tool" },
  ];
  for (const selection of selections) {
    const verdict = validateAdvertisedSelection(selection, [], selection.toolName ? [selection.toolName] : []);
    assert.ok(verdict.problems.length > 0);
    assert.equal(scoreSelection(selection, verdict).teacherAuthoredOutcome, false);
  }
});

function world(raw: unknown, overrides: Partial<Parameters<typeof validateWorldGeneration>[0]> = {}) {
  return validateWorldGeneration({ raw, sections: ["npcs"], dependencies: DEPENDENCIES, catalogReferences: [], tolerateInvalidReferences: true, ...overrides });
}

test("FIX: partial faction-reference removal is a repair and never a raw first-pass success", () => {
  const raw = { npcs: [{ ...NPC, factionKeys: ["faction-ok", "faction-nope"] }] };
  for (const allowRepair of [false, true]) {
    const verdict = world(raw, { allowRepair });
    assert.equal(verdict.sanitized, true);
    assert.equal(verdict.ok, allowRepair);
    assert.equal(verdict.rawFirstAttemptValid, false);
    assert.deepEqual(verdict.versions.parsed?.npcs[0]?.factionKeys, ["faction-ok", "faction-nope"]);
    assert.deepEqual(verdict.versions.sanitized?.npcs[0]?.factionKeys, ["faction-ok"]);
    assert.deepEqual(verdict.content?.npcs[0]?.factionKeys, ["faction-ok"]);
    const provenance = verdict.repairProvenance;
    assert.ok(provenance);
    assert.deepEqual(provenance.changes, [{ stage: "sanitize", path: "$.npcs[0].factionKeys[1]", kind: "removed", before: "faction-nope" }]);
    assert.notEqual(provenance.parsedDigest, provenance.sanitizedDigest);
    assert.equal(provenance.sanitizedDigest, provenance.validatedDigest);
    assert.deepEqual(provenance.target, verdict.content);
  }
  assert.deepEqual(raw.npcs[0]?.factionKeys, ["faction-ok", "faction-nope"]);
});

test("all four versions and repair provenance survive input and output mutation", () => {
  const raw = { npcs: [{ ...NPC, factionKeys: ["faction-ok", "faction-nope"] }] };
  const verdict = world(raw, { allowRepair: true });
  const savedRaw = structuredClone(verdict.versions.raw);
  raw.npcs[0]!.name = "Changed input";
  verdict.content!.npcs[0]!.name = "Changed output";
  assert.deepEqual(verdict.versions.raw, savedRaw);
  assert.equal(verdict.versions.validated?.npcs[0]?.name, NPC.name);
  assert.equal(verdict.repairProvenance?.target?.npcs[0]?.name, NPC.name);
  for (const version of Object.values(verdict.versions)) assert.equal(Object.isFrozen(version), true);
  assert.equal(Object.isFrozen(verdict.versions.parsed?.npcs[0]?.factionKeys), true);
  assert.equal(Object.isFrozen(verdict.repairProvenance?.changes), true);
  assert.equal(Object.isFrozen(verdict.repairProvenance?.target?.npcs[0]), true);
  assert.notEqual(verdict.versions.parsed, verdict.versions.sanitized);
  assert.notEqual(verdict.versions.sanitized, verdict.versions.validated);
});

test("benign schema defaults are clean passes, including nested defaults", () => {
  const npc = world({ npcs: [NPC] });
  assert.equal(npc.ok, true, npc.problems.join("; "));
  assert.equal(npc.sanitized, false);
  assert.equal(npc.rawFirstAttemptValid, true);
  assert.equal(npc.repairProvenance, null);
  const quest = world({ quests: [{ key: "quest-a", title: "Q", description: "A quest.", visibility: "public",
    objectives: [{ key: "objective-a", description: "Investigate.", visibility: "public" }],
    rewards: [{ key: "reward-a", label: "Thanks", kind: "custom", visibility: "public" }],
  }] }, { sections: ["quests"] });
  assert.equal(quest.ok, true, quest.problems.join("; "));
  assert.equal(quest.sanitized, false);
  assert.equal(quest.content?.quests[0]?.objectives[0]?.targetProgress, 1);
  assert.equal(quest.content?.quests[0]?.rewards[0]?.amount, null);
});

test("nested partial objective-reference removal is detected", () => {
  const verdict = world({ quests: [{ key: "quest-a", title: "Q", description: "A quest.", visibility: "public",
    objectives: [
      { key: "objective-a", description: "First.", visibility: "public" },
      { key: "objective-b", description: "Second.", visibility: "public", dependencyObjectiveKeys: ["objective-a", "objective-missing"] },
    ],
  }] }, { sections: ["quests"], allowRepair: true });
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(verdict.sanitized, true);
  assert.equal(verdict.rawFirstAttemptValid, false);
  assert.deepEqual(verdict.content?.quests[0]?.objectives[1]?.dependencyObjectiveKeys, ["objective-a"]);
  assert.ok(verdict.repairProvenance?.changes.some((change) => change.path === "$.quests[0].objectives[1].dependencyObjectiveKeys[1]"));
});

test("nested mechanics replacement is a repair, including changed and added values", () => {
  const verdict = world({ questItems: [{ key: "item-a", name: "A", description: "A quest item.", visibility: "public",
    mechanics: { state: "catalog-bound", reference: { kind: "item", packId: "pack-test", packVersion: "1.0.0", definitionId: "item-test" } },
  }] }, { sections: ["quest-items"], allowRepair: true });
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(verdict.sanitized, true);
  assert.equal(verdict.content?.questItems[0]?.mechanics.state, "inert");
  assert.ok(verdict.repairProvenance?.changes.some((change) => change.path === "$.questItems[0].mechanics.state" && change.kind === "changed"));
  assert.ok(verdict.repairProvenance?.changes.some((change) => change.path === "$.questItems[0].mechanics.reason" && change.kind === "added"));
});

test("partial top-level artifact removal cannot get first-pass credit", () => {
  const verdict = world({ npcs: [NPC, { ...NPC, name: "Duplicate" }] }, { allowRepair: true });
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(verdict.sanitized, true);
  assert.equal(verdict.content?.npcs.length, 1);
  assert.ok(verdict.repairProvenance?.changes.some((change) => change.path === "$.npcs[1]" && change.kind === "removed"));
});

test("parse-time correction of written values is recorded separately from defaults", () => {
  const verdict = world({ npcs: [{ ...NPC, factionKeys: [" faction-ok "] }] }, { allowRepair: true });
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.equal(verdict.sanitized, true);
  assert.equal(verdict.rawFirstAttemptValid, false);
  assert.deepEqual(verdict.repairProvenance?.changes, [{ stage: "parse", path: "$.npcs[0].factionKeys[0]", kind: "changed", before: " faction-ok ", after: "faction-ok" }]);
});

test("a repair that still fails semantic validation is never admitted", () => {
  const verdict = world({ npcs: [{ ...NPC, locationKey: "location-missing" }] }, { desiredCounts: { npcs: 1 }, allowRepair: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.sanitized, true);
  assert.equal(verdict.rawFirstAttemptValid, false);
  assert.equal(verdict.versions.validated, null);
  assert.equal(verdict.repairProvenance?.target, null);
  assert.equal(verdict.repairProvenance?.validatedDigest, null);
  assert.match(verdict.problems.join("; "), /require locations/);
});

test("without toleration, invalid references fail without fabricating a repair", () => {
  const verdict = world({ npcs: [{ ...NPC, factionKeys: ["faction-ok", "faction-nope"] }] }, { tolerateInvalidReferences: false, allowRepair: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.sanitized, false);
  assert.equal(verdict.rawFirstAttemptValid, false);
  assert.equal(verdict.repairProvenance, null);
});

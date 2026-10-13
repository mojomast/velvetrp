import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGroundedNarration, type PublicSceneGroundingContext } from "../src/grounding.js";
import {
  createPublicContextDiagnosticManifest,
  planRun,
  PUBLIC_CONTEXT_OVERLAY_TEMPLATE_VERSION,
  type PlannedUnit,
} from "../src/generate.js";
import { loadPublicSceneAuthority, publicContextDiagnosticManifestDigest,
  type VerifiedPublicSceneAuthority } from "../src/publicSceneFacts.js";

// Whole-clause grammar, source/context ablation and coverage accounting for the
// opt-in public-scene path. Nothing here claims style or entailment: it claims
// only that a bounded observation grammar fails closed and that an optional
// observation never substitutes for, or excuses, mechanical coverage.

const SEED = "public-context-grammar-test-1";
const manifest = createPublicContextDiagnosticManifest(SEED);
const authority = loadPublicSceneAuthority({ manifest, expectedManifestDigest: manifest.manifestDigest });
const plan = planRun({ seed: SEED, units: 3, realizationsPerScenario: 1, families: ["grounded-narration"],
  publicContextDiagnostic: { manifest, expectedManifestDigest: manifest.manifestDigest } });
const arm = (mode: "none" | "observations"): PlannedUnit =>
  plan.units.find((unit) => unit.publicContext!.publicContext === mode)!;
const sceneOf = (unit: PlannedUnit): PublicSceneGroundingContext => ({
  unitId: unit.unitId,
  scope: unit.publicContext!.scope,
  facts: unit.spec.oracle.publicSceneFacts!,
  authority,
});
const observed = sceneOf(arm("observations"));
const control = sceneOf(arm("none"));
const receipts = arm("observations").spec.oracle.receipts;
interface Beat {
  readonly skill: string;
  readonly total: number;
  readonly dc: number;
  readonly outcome: string;
}
interface DamageBeat {
  readonly target: string;
  readonly outcome: {
    readonly kind: "damage";
    readonly applied: number;
    readonly damageType: string;
    readonly hitPointsBefore: number;
    readonly hitPointsAfter: number;
    readonly statusAfter: string;
  };
}
const check = receipts.find((entry) => entry.kind === "check") as unknown as Beat;
const damage = receipts.find((entry) => entry.kind === "combat") as unknown as DamageBeat;
const NPC = damage.target;

/** A fully bound mechanical account of every requested public receipt. */
function mechanical(): string {
  return `You ${/^success/i.test(check.outcome) ? "succeeded" : "failed"} on the ${check.skill} check against DC ${check.dc}, with a total of ${check.total}.`
    + ` The attacker hits ${NPC} with a ${damage.outcome.damageType} attack for ${damage.outcome.applied} damage.`
    + ` ${NPC}'s hit points go from ${damage.outcome.hitPointsBefore} to ${damage.outcome.hitPointsAfter}; ${NPC} is ${damage.outcome.statusAfter}.`;
}

const evaluate = (text: string, scene: PublicSceneGroundingContext = observed, options: Record<string, unknown> = {}) =>
  evaluateGroundedNarration(text, receipts, { publicScene: scene, ...options });
function verified(text: string, scene: PublicSceneGroundingContext = observed) {
  const result = evaluate(text, scene);
  assert.equal(result.verdict, "verified", JSON.stringify({ text, result }, null, 1));
  return result;
}
function adjudication(text: string, code: string, scene: PublicSceneGroundingContext = observed) {
  const result = evaluate(text, scene);
  assert.equal(result.verdict, "adjudication-required", JSON.stringify({ text, result }));
  assert.ok(result.adjudications.some((issue) => issue.code === code), `${text} -> ${JSON.stringify(result.adjudications)}`);
  return result;
}
function rejection(text: string, code: string, scene: PublicSceneGroundingContext = observed) {
  const result = evaluate(text, scene);
  assert.equal(result.verdict, "rejected", JSON.stringify({ text, result }));
  assert.ok(result.violations.some((issue) => issue.code === code), `${text} -> ${JSON.stringify(result.violations)}`);
  return result;
}

test("each bounded paraphrase and the permitted compositions bind their real fact ids", () => {
  const light = observed.facts[0]!.factId;
  const shutters = observed.facts[1]!.factId;
  assert.ok(light.startsWith("scene-fact-") && shutters.startsWith("scene-fact-"));
  for (const form of ["The lamplight is amber.", "The lamplight has an amber hue.", "The lamplight has the amber hue.",
    "the shutters are closed.", "THE SHUTTERS ARE CLOSED.", "The shutters are shut."]) {
    const result = verified(form);
    assert.equal(result.bindings.length, 1, form);
  }
  verified("The lamplight is amber and the shutters are closed.");
  verified("The lamplight is amber, and the shutters are closed.");
  verified(`${mechanical()}; the lamplight is amber.`);
  verified(`The lamplight is amber; ${mechanical()}`);
  verified(`The lamplight is amber. ${mechanical()} The shutters are closed.`);
  const bound = verified(`${mechanical()} The lamplight is amber and the shutters are closed.`);
  const observation = bound.bindings.filter((binding) => binding.receiptId.startsWith("scene-fact-"));
  assert.deepEqual([...observation.map((binding) => binding.receiptId)].sort(), [light, shutters].sort());
  for (const binding of observation) {
    assert.deepEqual([...binding.roles].sort(), ["scene-predicate", "scene-subject", "scene-value"]);
  }
  const facts = bound.facts.filter((fact) => fact.family === "public-observation");
  assert.equal(facts.length, 2);
  for (const fact of facts) {
    assert.equal(fact.receiptId.startsWith("scene-fact-"), true);
    assert.deepEqual(fact.values, []);
    assert.equal(fact.outcome, null);
    assert.equal(fact.status, null);
  }
  // Nothing is ever synthesized as an engine receipt.
  assert.equal(bound.bindings.some((binding) => binding.receiptId.startsWith("authorized-")), false);
  assert.deepEqual([...bound.sceneProvenance!.usedSceneFactIds].sort(), [light, shutters].sort());
  assert.equal(bound.sceneProvenance!.mechanicalBindingsChecked, 2);
  assert.equal(bound.sceneProvenance!.observationBindingsChecked, 2);
});

test("wrong values reject as contradictions, and unknown words, modifiers and predicates never verify", () => {
  for (const [text, code] of [["The lamplight is white.", "scene-value-contradicted"],
    ["The shutters are open.", "scene-value-contradicted"],
    ["The lamplight is amber and the shutters are open.", "scene-value-contradicted"],
    ["The shutters are closed and the shutters are open.", "scene-observation-contradicted"]] as const) {
    rejection(text, code);
  }
  for (const text of ["The lamplight is golden.", "The lamplight is warm.", "The lamplight is dim.", "The lamplight glows amber.",
    "The lamplight is a deep amber.", "The lamplight has a golden hue.", "The lamplight remains amber.", "The lamplight still is amber.",
    "The lamplight is now amber.", "The lamplight is again amber.", "The lamplight is already amber.", "The lamplight is no longer amber.",
    "The lamplight has closed.", "The shutters are locked.", "The shutters are almost closed.", "Shutters are closed.", "A lamplight is amber.",
    "You see the lamplight is amber.", "You notice the lamplight is amber.", "Your eyes find the lamplight is amber.",
    "You caught the lamplight is amber.", "It is not the case that the lamplight is amber.",
    "\"The lamplight is amber.\"", "Under the amber lamplight, the attacker waits."]) {
    adjudication(text, "unrecognized-clause");
  }
});

test("no connective meaning is lost: causal, contrast and temporal joins, suffixes and unknown siblings all fail closed", () => {
  for (const text of ["The lamplight is amber because the shutter is drawn.",
    "The lamplight is amber, so the shutters are closed.", "The lamplight is amber and the shutters are closed because the wind died.",
    "The lamplight is amber and yet the shutters are closed.", "The lamplight is amber but the shutters are closed.",
    "The lamplight is amber, however, and the shutters are closed.", "The lamplight is amber while the shutters are closed.",
    "The lamplight is amber, whereas the shutters are closed.", "The lamplight is amber, warm and steady.",
    "The lamplight is amber and the shutters are closed and the ledger is open."]) {
    adjudication(text, "unrecognized-clause");
  }
  // One correct mechanical clause plus one observation carrying an unconsumed
  // causal clause: the span is unknown evidence and NO part of it is authorized.
  const causal = evaluate(`${mechanical()} The lamplight is amber because the attacker hesitates.`);
  assert.equal(causal.verdict, "adjudication-required");
  assert.deepEqual(causal.adjudications.map((issue) => issue.excerpt),
    ["The lamplight is amber because the attacker hesitates"]);
  assert.deepEqual(causal.sceneProvenance!.usedSceneFactIds, []);
  assert.deepEqual(causal.sceneProvenance!.missingMechanical, []);
  // A recognised observation beside an unknown SIBLING clause still binds, and
  // the overall verdict still cannot verify.
  const sibling = evaluate(`${mechanical()} The lamplight is amber. Nothing in the hall contradicts that.`);
  assert.equal(sibling.verdict, "adjudication-required");
  assert.deepEqual(sibling.sceneProvenance!.usedSceneFactIds, [observed.facts[0]!.factId]);
  assert.deepEqual(sibling.sceneProvenance!.missingMechanical, []);
  // A comma does not split independent scene clauses: both sides must be atoms.
  assert.equal(evaluate(`${mechanical()} The lamplight is amber, the shutters are closed.`).verdict, "adjudication-required");
});

test("a scene/mechanical semicolon boundary never loses a connective, and a question never asserts", () => {
  const attack = `the attacker hits ${NPC} with a ${damage.outcome.damageType} attack for ${damage.outcome.applied} damage`;
  // The bare semicolon is the valid control: two genuinely independent complete
  // clauses, both fully bound, with nothing left over.
  const control = verified(`${mechanical()} The lamplight is amber; ${attack}.`);
  assert.deepEqual(control.sceneProvenance!.missingMechanical, []);
  assert.deepEqual(control.sceneProvenance!.usedSceneFactIds, [observed.facts[0]!.factId]);
  // The same sentence with a relation-bearing connective is NOT the control. The
  // mechanical sibling keeps its own words, so the fragment behind the
  // connective is never promoted to a standalone assertion.
  for (const [connector, kept] of [["; but ", "but"], ["; while ", "while"], ["; however, ", "however"]] as const) {
    const text = `${mechanical()} The lamplight is amber${connector}${attack}.`;
    const result = evaluate(text);
    assert.equal(result.verdict, "adjudication-required", `${text} -> ${JSON.stringify(result)}`);
    // The exact offending connective survives into the evidence, verbatim.
    const evidence = result.adjudications.map((issue) => issue.excerpt);
    assert.ok(evidence.some((excerpt) => excerpt.includes(kept)), `${text} -> ${JSON.stringify(evidence)}`);
    assert.ok(!evidence.some((excerpt) => excerpt === attack), "the connective-free fragment must not stand alone");
  }
  // A scene question is not an asserted observation; the statement it mirrors is.
  const question = evaluate(`The lamplight is amber? ${NPC} is ${damage.outcome.statusAfter}.`);
  assert.equal(question.verdict, "adjudication-required");
  assert.ok(question.adjudications.some((issue) => issue.excerpt.includes("?")),
    JSON.stringify(question.adjudications));
  assert.deepEqual(question.sceneProvenance!.usedSceneFactIds, []);
  verified(`The lamplight is amber. ${NPC} is ${damage.outcome.statusAfter}.`);
});

test("a repeated scene subject with the same value is repetition, not a contradiction", () => {
  const light = observed.facts[0]!.factId;
  const bound = verified("The lamplight is amber and the lamplight is amber.");
  assert.deepEqual(bound.sceneProvenance!.usedSceneFactIds, [light]);
  // A genuinely different value for the same subject is still a contradiction.
  rejection("The lamplight is amber and the lamplight is white.", "scene-observation-contradicted");
});

test("an observation clears the mechanical continuation and never becomes an attack actor", () => {
  const unscoped = adjudication("The attacker attacks Haug. The lamplight is amber. It hits.", "unscoped-continuation");
  assert.deepEqual(unscoped.sceneProvenance!.usedSceneFactIds, [observed.facts[0]!.factId]);
  adjudication("The shutters are closed. It hits.", "unscoped-continuation");
  adjudication("The lamplight is amber. The shutters are closed. It hits.", "unscoped-continuation");
  // Without the observation in between, the same continuation is scoped.
  verified("The attacker attacks Haug. It hits.");
  // An outgoing predicate never acquires a scene subject as its actor: naming the
  // subject keeps the clause on the scene grammar, and dropping the article
  // leaves a mechanical claim whose actor no receipt establishes.
  adjudication(`The lamplight is amber. The shutters hit ${NPC} with a slashing attack for 5 damage.`, "unrecognized-clause");
  rejection(`The lamplight is amber. Shutters hit ${NPC} with a slashing attack for 5 damage.`, "actor-binding-mismatch");
  rejection(`The shutters are closed. Shutters deal 5 slashing damage to ${NPC}.`, "actor-binding-mismatch");
});

test("optional scene usage is distinct from mandatory mechanical coverage", () => {
  const without = verified(mechanical());
  assert.deepEqual(without.sceneProvenance!.usedSceneFactIds, []);
  assert.equal(without.sceneProvenance!.observationBindingsChecked, 0);
  assert.equal(without.sceneProvenance!.mechanicalBindingsChecked, 2);
  assert.deepEqual([...without.sceneProvenance!.requiredMechanicalIds].sort(), receipts.map((entry) => entry.receiptId!).sort());
  assert.deepEqual([...without.sceneProvenance!.allowedSceneFactIds].sort(), observed.facts.map((fact) => fact.factId).sort());
  assert.deepEqual([...without.sceneProvenance!.knownBindingIds].sort(),
    [...receipts.map((entry) => entry.receiptId!), ...observed.facts.map((fact) => fact.factId)].sort());
  assert.deepEqual(without.sceneProvenance!.unknownBindings, []);
  assert.equal(without.bindingsChecked, 2);

  // Observations alone leave BOTH required receipts missing; they never cover them.
  const only = verified("The lamplight is amber and the shutters are closed.");
  assert.equal(only.sceneProvenance!.missingMechanical.length, 2);
  assert.equal(only.sceneProvenance!.mechanicalBindingsChecked, 0);
  assert.equal(only.sceneProvenance!.observationBindingsChecked, 2);
  assert.equal(only.bindingsChecked, 2);

  // A mechanical contradiction plus a correct observation still fails.
  const contradictory = mechanical().replace(`with a ${damage.outcome.damageType} attack for ${damage.outcome.applied} damage`,
    `with a ${damage.outcome.damageType} attack for ${damage.outcome.applied + 1} damage`);
  rejection(`${contradictory} The lamplight is amber.`, "value-binding-mismatch");
  // An omitted damage receipt is not rescued by two correct observations: the
  // verdict stays clean, but the coverage set names the unbound receipt, which
  // is what the receipt-provenance validator refuses on.
  const checkOnly = mechanical().split(" The attacker hits")[0]!;
  const omitted = evaluate(`${checkOnly} The lamplight is amber and the shutters are closed.`);
  assert.equal(omitted.verdict, "verified", "nothing false was said; the missing receipt is visible in the coverage set");
  assert.equal(omitted.sceneProvenance!.missingMechanical.length, 1);
  assert.equal(omitted.sceneProvenance!.mechanicalBindingsChecked, 1);
  assert.equal(omitted.sceneProvenance!.observationBindingsChecked, 2);
});

test("the control arm has no observation authority, and the two authorities cannot be mixed", () => {
  // Nothing is exposed to the control: the same words cannot be authorized.
  const controlResult = evaluate(mechanical(), control);
  assert.equal(controlResult.verdict, "verified");
  assert.deepEqual(controlResult.sceneProvenance!.mode, "none");
  assert.deepEqual(controlResult.sceneProvenance!.allowedSceneFactIds, []);
  assert.deepEqual(controlResult.sceneProvenance!.usedSceneFactIds, []);
  adjudication(`${mechanical()} The lamplight is amber.`, "unrecognized-clause", control);
  // The legacy string allowlist is not a substitute for the frozen registry.
  const mixed = evaluate(mechanical(), observed, { authorizedConsequences: ["The lamplight is amber."] });
  assert.equal(mixed.verdict, "rejected");
  assert.ok(mixed.violations.some((issue) => issue.code === "mixed-scene-authority"));
  // Without the option the existing grammar and evidence bytes are untouched.
  const ordinary = evaluateGroundedNarration(mechanical(), receipts);
  assert.equal(ordinary.verdict, "verified");
  assert.equal(ordinary.sceneProvenance, undefined);
});

test("the frozen plan carries the diagnostic overlay identity without changing the base spec", () => {
  for (const unit of plan.units) {
    assert.equal(unit.spec.templateVersion, PUBLIC_CONTEXT_OVERLAY_TEMPLATE_VERSION);
    assert.equal(unit.spec.oracle.authorizedConsequences.length, 0);
    assert.equal(unit.preference, undefined);
    assert.equal(unit.twinGroupId, undefined);
    assert.equal(unit.publicContext!.manifestDigest, manifest.manifestDigest);
  }
  assert.equal(observed.facts.length, 2);
  assert.equal(control.facts.length, 0);
  assert.equal(plan.publicContextDiagnostic!.pairs.length, 3);
  assert.equal(plan.publicContextDiagnostic!.schedule.length, 6);
});

test("execution order IS the frozen schedule order, including a noncontiguous one", () => {
  // The schedule is what is reported, so it must also be what executes. An
  // interleaved order is accepted and executed exactly as declared: the planner
  // may not regroup rows by pair and then report the supplied order.
  for (const schedule of [manifest.schedule,
    [...manifest.schedule].sort((left, right) => left.publicContext.localeCompare(right.publicContext))]) {
    const repinned = { ...manifest, manifestDigest: "" };
    const pinned = { ...repinned, manifestDigest: publicContextDiagnosticManifestDigest(repinned) };
    const repinnedPlan = planRun({ seed: SEED, units: 3, realizationsPerScenario: 1, families: ["grounded-narration"],
      publicContextDiagnostic: { manifest: pinned, expectedManifestDigest: pinned.manifestDigest } });
    assert.deepEqual(repinnedPlan.units.map((unit) => unit.unitId), pinned.schedule.map((row) => row.unitId));
    assert.deepEqual(repinnedPlan.publicContextDiagnostic!.schedule.map((row) => row.unitId), pinned.schedule.map((row) => row.unitId));
    // Every arm still carries the projection its own mode schedules.
    assert.equal(repinnedPlan.units.filter((unit) => unit.publicContext!.publicContext === "observations").length, 3);
    assert.equal(repinnedPlan.units.filter((unit) => unit.publicContext!.publicContext === "none").length, 3);
  }
  // The default builder's contiguous order is what the plan already executes.
  assert.deepEqual(plan.units.map((unit) => unit.unitId), manifest.schedule.map((row) => row.unitId));
});
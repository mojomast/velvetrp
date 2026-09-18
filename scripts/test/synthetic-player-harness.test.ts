import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ABBREVIATIONS,
  COVERAGE_CELL_COUNT,
  COVERAGE_TARGET_PER_CELL,
  COVERAGE_TOTAL_TARGET,
  CoverageScheduler,
  DEFAULT_DIRECT_WEIGHT,
  DEFAULT_MENU_WINDOW,
  EFFORTS,
  FAILURE_MODES,
  FAMILY_TOOL_KINDS,
  HARNESS_VERSION,
  KIND_TO_FAMILY,
  MAX_REPEATED_PHRASES,
  MECHANIC_FAMILIES,
  MIN_DIRECT_WEIGHT,
  OFF_MENU_FAILURE_MODES,
  PERSONAS,
  PERSONA_ARCHETYPES,
  PERSONA_LIST,
  PERSONA_VERSION,
  PHRASE_STOPWORDS,
  SURFACE_NOISES,
  SYNTHETIC_TAG_PREFIX,
  SessionDriver,
  SessionTurnError,
  TRAILING_QUESTION_BANK,
  TurnContractError,
  WORD_BUDGET_BY_VERBOSITY,
  applySurfaceNoise,
  buildConfirmRequest,
  buildGenerationRequest,
  buildGeneratorMessages,
  buildPlayBootstrapRequest,
  buildReconcileInitialRequest,
  buildStreamRequest,
  buildTranscriptRequest,
  buildTurnRequest,
  computeHumanLikeness,
  coverageWeight,
  createFakeGenerator,
  createLiveGenerator,
  createRng,
  decideConfirmation,
  declarationWordCount,
  defaultCoverageTargets,
  deriveConfirmationIdempotencyKey,
  deriveIdempotencyKey,
  effortFor,
  formatTurnSeed,
  hashSeed,
  isSyntheticTag,
  manifestDigest,
  materializeTurn,
  noiseAbbreviation,
  noiseLowercase,
  noiseSelfCorrection,
  noiseTrailingQuestionOoc,
  noiseTypo,
  noiseUppercaseFirst,
  normalizeMenuWindow,
  parseAdventureDecisionRow,
  parseHarnessArgs,
  parseSseBlock,
  parseSseText,
  parseTurnContractJson,
  planRun,
  readTurnAdvertisements,
  renderManifestSummary,
  requestInit,
  requiredNoiseFor,
  runHarnessCli,
  runHarnessSession,
  serializeManifest,
  sessionIndexLabel,
  sessionTagFor,
  stableStringify,
  tokenQuadgramSet,
  tokenTrigramSet,
  transcriptSlice,
  trigramJaccard,
  validateTurnContract,
  type CoverageCell,
  type CoverageTargets,
  type FailureMode,
  type GenerationRequest,
  type GeneratorPromptInput,
  type HarnessManifest,
  type HarnessSessionInput,
  type HarnessTurnRecord,
  type HumanLikenessReport,
  type MechanicFamily,
  type SeededRng,
  type TurnAdvertisementSnapshot,
  type TurnContractContext,
} from "../synthetic-player-harness.js";

const NOW = "2026-09-17T00:00:00.000Z";
const DECLARATION_TEXT = "I try to pry open the gate with my crowbar before the fog comes in";

function validContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    sessionId: "synthetic-player.explorer.test.a",
    turnIndex: 0,
    personaId: "explorer.v1",
    seed: "test-0000",
    effort: "high",
    declaration: "I look at the ferry wreck.",
    ooc: "Can I make it back?",
    intended: { family: "travel", failureMode: "ambiguous" },
    noise: ["lowercase"],
    references: ["turn-1"],
    ...overrides,
  };
}

function expectContractError(value: unknown, pattern: RegExp, context: TurnContractContext = {}): TurnContractError {
  try {
    validateTurnContract(value, context);
  } catch (error) {
    assert.ok(error instanceof TurnContractError, `expected TurnContractError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return error;
  }
  throw new Error(`expected the contract to be rejected with ${pattern}`);
}

function promptInput(overrides: Partial<GeneratorPromptInput> = {}): GeneratorPromptInput {
  return {
    persona: PERSONAS.explorer,
    runId: "run-1",
    sessionId: "synthetic-player.explorer.test.a",
    turnIndex: 0,
    seed: "test-0000",
    target: { family: "travel", failureMode: "ambiguous" },
    effort: "high",
    transcript: [],
    sheetSummary: "public sheet labels",
    allowedNoise: SURFACE_NOISES,
    requiredNoise: [],
    referenceBudget: 3,
    ...overrides,
  };
}

function makeDryRunInput(overrides: Partial<HarnessSessionInput> = {}): HarnessSessionInput {
  const base: HarnessSessionInput = {
    runId: "synth-test-a",
    runSeed: "test",
    persona: PERSONAS.explorer,
    sessionIndex: 0,
    sessionId: "11111111-2222-3333-4444-555555555555",
    turns: 3,
    mode: "dry-run",
    generateTurn: createFakeGenerator(),
    submitTurn: null,
    transcript: [],
    sheetSummary: "public sheet labels",
    targets: null,
    startedAt: NOW,
    gitCommit: null,
    generatorIdentity: { provider: "fake", model: "deterministic-fake-generator", baseUrlDigest: null, temperature: null },
    gameProviderModel: "fake",
    campaignId: "camp-1",
    actorId: "actor-1",
    dataDir: null,
    syntheticTag: null,
    notes: [],
    referenceBudget: 3,
    transcriptWindow: 6,
  };
  return { ...base, ...overrides };
}

/** SeededRng stub whose every float draw is a fixed value; used to pin weighted picks. */
function fixedRng(value: number): SeededRng {
  return {
    next: () => value,
    int: () => 0,
    chance: () => false,
    pick: <T>(items: readonly T[]): T => items[0] as T,
  };
}

/** Minimal valid turn record for human-likeness tests. */
function humanLikenessTurn(input: {
  turnIndex: number;
  declaration: string;
  failureMode?: FailureMode;
  ooc?: string | null;
  noiseApplied?: HarnessTurnRecord["noiseApplied"];
}): HarnessTurnRecord {
  const noiseApplied = [...(input.noiseApplied ?? [])];
  return {
    turnIndex: input.turnIndex,
    turnSeed: `human-${input.turnIndex}`,
    personaId: "explorer.v1",
    target: { family: "travel", failureMode: input.failureMode ?? "direct" },
    toolKind: FAMILY_TOOL_KINDS.travel,
    effort: "high",
    declarationGenerated: input.declaration,
    declaration: input.declaration,
    ooc: input.ooc ?? null,
    noiseDeclared: [...noiseApplied],
    noiseDropped: [],
    noiseApplied,
    references: [],
    idempotencyKey: `synth.human.${input.turnIndex}`,
    outcome: "planned",
    turnId: null,
    turnState: null,
    confirmationDecisions: [],
    receipts: [],
    narration: null,
    error: null,
    advertisements: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(text: string, turnId: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", "x-adventure-turn-id": turnId } });
}

function sseFrame(type: string, payload: unknown, sequence: number): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence, timestamp: NOW, payload })}\n\n`;
}

// -------------------------------------------------------------------------------------------------
// Personas
// -------------------------------------------------------------------------------------------------

test("persona matrix is complete and versioned", () => {
  assert.equal(PERSONA_VERSION, "personas-v1");
  assert.equal(PERSONA_LIST.length, 5);
  assert.deepEqual(PERSONA_LIST.map(persona => persona.archetype), [...PERSONA_ARCHETYPES]);
  assert.deepEqual(Object.keys(PERSONAS).sort(), [...PERSONA_ARCHETYPES].sort());
  for (const persona of PERSONA_LIST) {
    assert.equal(persona.personaVersion, PERSONA_VERSION);
    assert.equal(persona.personaId, `${persona.archetype}.v1`);
    assert.ok(persona.title.length > 0);
    assert.ok(persona.goals.length >= 3, `${persona.personaId} needs goals`);
    assert.ok(persona.mechanicsBias.length >= 2, `${persona.personaId} needs mechanics bias`);
    for (const family of persona.mechanicsBias) assert.ok(MECHANIC_FAMILIES.includes(family), `unknown family ${family}`);
    for (const mode of FAILURE_MODES) {
      assert.ok(persona.failureAffinity[mode] > 0, `${persona.personaId} affinity for ${mode}`);
    }
    const policy = persona.confirmationPolicy;
    assert.ok(Math.abs(policy.approve + policy.reject + policy.stall - 1) < 1e-9, `${persona.personaId} policy must sum to 1`);
    for (const rate of [persona.typoRate, persona.abbreviationRate, persona.oocRate]) {
      assert.ok(rate >= 0 && rate <= 1, `${persona.personaId} rate out of range`);
    }
    assert.ok(["high", "medium", "low"].includes(persona.patience));
    assert.ok(["plain", "florid", "terse", "precise"].includes(persona.verbosity));
    assert.ok(persona.notes.length > 0);
  }
});

test("persona profiles match the documented archetype shape", () => {
  assert.equal(PERSONAS.achiever.confirmationPolicy.alwaysApproveProgression, true);
  assert.equal(PERSONAS.impatient.verbosity, "terse");
  assert.equal(PERSONAS.explorer.verbosity, "florid");
  assert.equal(PERSONAS["rules-tinkerer"].verbosity, "precise");
  assert.equal(PERSONAS.achiever.patience, "high");
  assert.equal(PERSONAS.socialiser.patience, "low");
  assert.ok(PERSONAS.impatient.typoRate > PERSONAS.achiever.typoRate, "impatient has the highest typo rate");
  assert.ok(PERSONAS.socialiser.oocRate > PERSONAS.explorer.oocRate, "socialiser has the highest OOC rate");
  assert.ok(PERSONAS.socialiser.abbreviationRate > PERSONAS.explorer.abbreviationRate);
  assert.ok(PERSONAS["rules-tinkerer"].mechanicsBias.includes("inventory"));
  assert.ok(PERSONAS["rules-tinkerer"].mechanicsBias.includes("rest"));
  assert.ok(PERSONAS.explorer.mechanicsBias.includes("travel"));
});

test("family tool kinds are complete and unique", () => {
  const kinds = new Set<string>();
  for (const family of MECHANIC_FAMILIES) {
    const kind = FAMILY_TOOL_KINDS[family];
    assert.match(kind, /^exact_[a-z_]+\.select$/);
    assert.ok(!kinds.has(kind), `duplicate tool kind ${kind}`);
    kinds.add(kind);
  }
  assert.equal(kinds.size, MECHANIC_FAMILIES.length);
  assert.equal(FAMILY_TOOL_KINDS["srd-check"], "exact_srd_check.select");
  assert.equal(FAMILY_TOOL_KINDS["quest-objective"], "exact_quest_objective.select");
});

// -------------------------------------------------------------------------------------------------
// Contract validation
// -------------------------------------------------------------------------------------------------

test("valid contracts pass and normalize cosmetic fields", () => {
  const contract = validateTurnContract(validContract());
  assert.equal(contract.runId, "run-1");
  assert.equal(contract.sessionId, "synthetic-player.explorer.test.a");
  assert.equal(contract.turnIndex, 0);
  assert.equal(contract.personaId, "explorer.v1");
  assert.equal(contract.seed, "test-0000");
  assert.equal(contract.effort, "high");
  assert.equal(contract.declaration, "I look at the ferry wreck.");
  assert.equal(contract.ooc, "Can I make it back?");
  assert.deepEqual(contract.intended, { family: "travel", failureMode: "ambiguous" });
  assert.deepEqual(contract.noise, ["lowercase"]);
  assert.deepEqual(contract.references, ["turn-1"]);

  const blankOoc = validateTurnContract(validContract({ ooc: "   " }));
  assert.equal(blankOoc.ooc, undefined);
  assert.ok(!("ooc" in blankOoc), "blank OOC is normalized away");

  const spaced = validateTurnContract(validContract({ declaration: "  I wait.  ", references: [" turn-9 "] }));
  assert.equal(spaced.declaration, "I wait.");
  assert.deepEqual(spaced.references, ["turn-9"]);

  // The design doc's contract example labels intended.family with the tool kind; both forms normalize.
  const toolKindFamily = validateTurnContract(validContract({ intended: { family: "exact_actor_travel.select", failureMode: "ambiguous" } }));
  assert.deepEqual(toolKindFamily.intended, { family: "travel", failureMode: "ambiguous" });
  assert.deepEqual(
    validateTurnContract(validContract({ intended: { family: "exact_actor_travel.select", failureMode: "ambiguous" } }), {
      target: { family: "travel", failureMode: "ambiguous" },
    }).intended,
    { family: "travel", failureMode: "ambiguous" },
  );
});

test("contract validation reports every bad shape with a clear error", () => {
  const notObject = expectContractError("nope", /contract must be a JSON object/);
  assert.ok(notObject.issues.length > 0);
  expectContractError(validContract({ extra: 1 }), /unknown field "extra"/);
  expectContractError((() => { const { declaration, ...rest } = validContract(); void declaration; return rest; })(), /missing required field "declaration"/);
  expectContractError(validContract({ runId: "" }), /"runId" must be a nonblank string/);
  expectContractError(validContract({ turnIndex: -1 }), /"turnIndex" must be a non-negative integer/);
  expectContractError(validContract({ turnIndex: 1.5 }), /"turnIndex" must be a non-negative integer/);
  expectContractError(validContract({ effort: "medium" }), /"effort" must be "low" or "high"/);
  expectContractError(validContract({ declaration: "   " }), /"declaration" must be a nonblank string/);
  expectContractError(validContract({ declaration: "x".repeat(8001) }), /"declaration" exceeds 8000 characters/);
  expectContractError(validContract({ ooc: 7 }), /"ooc" must be a string when present/);
  expectContractError(validContract({ intended: { family: "teleport", failureMode: "ambiguous" } }), /"intended.family" must be a family id/);
  expectContractError(validContract({ intended: { family: "travel", failureMode: "spicy" } }), /"intended.failureMode" must be one of/);
  expectContractError(validContract({ intended: { family: "travel", failureMode: "ambiguous", extra: 1 } }), /unknown field "intended.extra"/);
  expectContractError(validContract({ intended: null }), /"intended" must be an object/);
  expectContractError(validContract({ noise: ["lowercase", "lowercase"] }), /"noise" repeats "lowercase"/);
  // Unknown perturbation names are advisory: the harness drops and records them instead of failing.
  const droppedNoise = validateTurnContract(validContract({ noise: ["lowercase", "shouting"] }));
  assert.deepEqual(droppedNoise.noise, ["lowercase"]);
  assert.deepEqual(droppedNoise.noiseDropped, ["shouting"]);
  expectContractError(validContract({ noise: "lowercase" }), /"noise" must be an array/);
  expectContractError(validContract({ references: [""] }), /"references\[0\]" must be a nonblank string/);
  expectContractError(validContract({ references: ["a", "a"] }), /"references" repeats "a"/);
  expectContractError(validContract({ references: new Array(33).fill("x").map((_, index) => `t-${index}`) }), /"references" exceeds 32 entries/);
});

test("contract validation enforces harness-owned context and required noise", () => {
  const context: TurnContractContext = {
    runId: "run-1",
    sessionIds: ["synthetic-player.explorer.test.a", "11111111-2222-3333-4444-555555555555"],
    turnIndex: 0,
    personaId: "explorer.v1",
    seed: "test-0000",
    effort: "high",
    target: { family: "travel", failureMode: "ambiguous" },
    requiredNoise: ["typo"],
  };
  expectContractError(validContract(), /required noise "typo" was not declared/, context);
  expectContractError(validContract({ runId: "other" }), /runId mismatch/, context);
  expectContractError(validContract({ sessionId: "elsewhere" }), /sessionId mismatch/, context);
  expectContractError(validContract({ turnIndex: 3 }), /turnIndex mismatch/, context);
  expectContractError(validContract({ personaId: "impatient.v1" }), /personaId mismatch/, context);
  expectContractError(validContract({ seed: "other-0000" }), /seed mismatch/, context);
  expectContractError(validContract({ effort: "low" }), /effort mismatch/, context);
  expectContractError(validContract({ intended: { family: "rest", failureMode: "direct" } }), /intended target mismatch/, context);
  const accepted = validateTurnContract(validContract({ sessionId: "11111111-2222-3333-4444-555555555555", noise: ["typo"] }), context);
  assert.deepEqual(accepted.noise, ["typo"]);
});

test("generator JSON is parsed leniently but validated strictly", () => {
  const raw = JSON.stringify(validContract());
  assert.equal(parseTurnContractJson(raw).declaration, "I look at the ferry wreck.");
  assert.equal(parseTurnContractJson(`\`\`\`json\n${raw}\n\`\`\``).declaration, "I look at the ferry wreck.");
  assert.equal(parseTurnContractJson(`Here is the turn:\n${raw}\nThanks!`).declaration, "I look at the ferry wreck.");
  assert.throws(() => parseTurnContractJson("not json at all"), /unparseable turn contract/);
  assert.throws(() => parseTurnContractJson("{}"), TurnContractError);
  assert.throws(() => parseTurnContractJson(raw, { runId: "other" }), /runId mismatch/);
});

// -------------------------------------------------------------------------------------------------
// Seeded noise
// -------------------------------------------------------------------------------------------------

test("lowercase and uppercase-first are exact byte transforms", () => {
  assert.deepEqual(noiseLowercase("I Go NORTH.", "any"), { text: "i go north." });
  assert.deepEqual(noiseUppercaseFirst("i go north", "any"), { text: "I go north" });
  assert.deepEqual(noiseUppercaseFirst("123 i go", "any"), { text: "123 I go" });
  assert.deepEqual(noiseUppercaseFirst("...!", "any"), { text: "...!" });
  assert.deepEqual(noiseLowercase("", "any"), { text: "" });
});

test("abbreviation replaces exactly one table token from the seed", () => {
  assert.equal(noiseAbbreviation(DECLARATION_TEXT, "alpha").text, "I try to pry open the gate with my crowbar b4 the fog comes in");
  assert.equal(noiseAbbreviation(DECLARATION_TEXT, "gamma").text, "I try to pry open the gate w/ my crowbar before the fog comes in");
  assert.deepEqual(noiseAbbreviation(DECLARATION_TEXT, "alpha"), noiseAbbreviation(DECLARATION_TEXT, "alpha"), "same seed, same bytes");
  assert.notEqual(noiseAbbreviation(DECLARATION_TEXT, "alpha").text, noiseAbbreviation(DECLARATION_TEXT, "gamma").text);
  assert.deepEqual(noiseAbbreviation("no table words here", "alpha"), { text: "no table words here" });
  assert.ok(Object.keys(ABBREVIATIONS).length >= 8);
});

test("typo performs a seeded swap or omit and differs across seeds", () => {
  assert.equal(noiseTypo(DECLARATION_TEXT, "alpha").text, "I try to pry opne the gate with my crowbar before the fog comes in");
  assert.equal(noiseTypo(DECLARATION_TEXT, "beta").text, "I try to pry open the gate with my crowbar before the og comes in");
  assert.equal(noiseTypo(DECLARATION_TEXT, "gamma").text, "I try to pry open the gate with my crowbar befroe the fog comes in");
  assert.equal(noiseTypo(DECLARATION_TEXT, "test").text, "I try to pry open he gate with my crowbar before the fog comes in");
  for (const seed of ["alpha", "beta", "gamma", "test"]) {
    const mutated = noiseTypo(DECLARATION_TEXT, seed).text;
    assert.notEqual(mutated, DECLARATION_TEXT);
    assert.ok(Math.abs(mutated.length - DECLARATION_TEXT.length) <= 1, "typo changes one swap or one omission");
  }
  assert.ok(noiseTypo(DECLARATION_TEXT, "alpha").text.length === DECLARATION_TEXT.length, "swap keeps length");
  assert.ok(noiseTypo(DECLARATION_TEXT, "beta").text.length === DECLARATION_TEXT.length - 1, "omit drops one character");
  assert.notEqual(noiseTypo(DECLARATION_TEXT, "alpha").text, noiseTypo(DECLARATION_TEXT, "gamma").text);
  assert.deepEqual(noiseTypo("ab cd", "seed"), { text: "ab cd" }, "short tokens are untouched");
});

test("trailing-question noise splits exact bytes and falls back deterministically", () => {
  assert.deepEqual(noiseTrailingQuestionOoc("I go north. Can I make it back?", "s"), {
    text: "I go north.",
    ooc: "Can I make it back?",
  });
  assert.deepEqual(noiseTrailingQuestionOoc("I go north! Can I make it back?", "s"), {
    text: "I go north!",
    ooc: "Can I make it back?",
  });
  assert.deepEqual(noiseTrailingQuestionOoc("Can I make it back?", "s"), { text: "Can I make it back?" });
  const fallback = noiseTrailingQuestionOoc("I go north", "s");
  assert.equal(fallback.text, "I go north");
  assert.ok((TRAILING_QUESTION_BANK as readonly string[]).includes(fallback.ooc as string));
  assert.equal(noiseTrailingQuestionOoc("I go north", "s").ooc, fallback.ooc, "same seed, same question");
});

test("self-correction inserts a seeded correction cue before the declaration", () => {
  assert.deepEqual(noiseSelfCorrection("I take the north road", "s"), { text: "Hmm, actually no — I take the north road" });
  assert.deepEqual(noiseSelfCorrection("  I take the north road  ", "s"), { text: "Hmm, actually no — I take the north road" });
  const prefixes = new Set<string>();
  for (let index = 0; index < 24; index += 1) {
    const result = noiseSelfCorrection("I move.", `cue-${index}`).text;
    assert.ok(result.endsWith("I move."));
    prefixes.add(result.slice(0, result.length - "I move.".length));
  }
  assert.ok(prefixes.size >= 2, "different seeds reach different correction cues");
});

test("applySurfaceNoise folds declared noise in order and is reproducible", () => {
  const input = {
    declaration: "I Try To Pry Open The Gate With My Crowbar.",
    noise: ["lowercase", "abbreviation", "typo"] as const,
    seed: "test-0000",
  };
  const first = applySurfaceNoise(input);
  assert.deepEqual(first, {
    declaration: "i try to pry open th gate w/ my crowbar.",
    applied: ["lowercase", "abbreviation", "typo"],
  });
  assert.deepEqual(applySurfaceNoise(input), first, "same seed, same bytes");
  const other = applySurfaceNoise({ ...input, seed: "test-0001" });
  assert.equal(other.declaration, "i tyr to pry open the gate w/ my crowbar.");
  assert.notEqual(other.declaration, first.declaration);
  assert.deepEqual(other.applied, first.applied);

  const merged = applySurfaceNoise({
    declaration: "I go north. Can I make it back?",
    ooc: "OOC one.",
    noise: ["trailing-question-ooc"],
    seed: "s",
  });
  assert.deepEqual(merged, {
    declaration: "I go north.",
    ooc: "OOC one. Can I make it back?",
    applied: ["trailing-question-ooc"],
  });
});

test("seeded RNG is deterministic and never touches Math.random", () => {
  assert.equal(createRng("seed").next(), 0.21031294716522098);
  assert.equal(hashSeed("seed"), 131604589);
  const left = createRng("x");
  const right = createRng("x");
  assert.deepEqual([left.next(), left.next(), left.next()], [right.next(), right.next(), right.next()]);
  assert.notEqual(createRng("x").next(), createRng("y").next());
  const range = createRng("range");
  for (let index = 0; index < 64; index += 1) {
    const value = range.int(5, 10);
    assert.ok(Number.isInteger(value) && value >= 5 && value < 10);
    assert.ok(range.next() >= 0 && range.next() < 1);
  }
  assert.equal(createRng("chance").chance(1), true);
  assert.equal(createRng("chance").chance(0), false);
  assert.throws(() => createRng("empty").pick([]), /empty list/);
  assert.throws(() => createRng("bad").int(2, 2), /invalid integer range/);
});

// -------------------------------------------------------------------------------------------------
// Coverage scheduler
// -------------------------------------------------------------------------------------------------

test("coverage targets are the documented 11 x 7 x 4 matrix", () => {
  assert.equal(MECHANIC_FAMILIES.length, 11);
  assert.equal(FAILURE_MODES.length, 7);
  assert.equal(COVERAGE_CELL_COUNT, 77);
  assert.equal(COVERAGE_TARGET_PER_CELL, 4);
  assert.equal(COVERAGE_TOTAL_TARGET, 308);
  assert.ok(FAILURE_MODES.includes("small-talk-ooc"));
  assert.ok(FAILURE_MODES.includes("literal-edge"));
  const targets = defaultCoverageTargets();
  for (const family of MECHANIC_FAMILIES) {
    for (const mode of FAILURE_MODES) assert.equal(targets[family][mode], 4);
  }
});

test("scheduler plans every cell to target and then exhausts", () => {
  const scheduler = new CoverageScheduler({ persona: PERSONAS.explorer });
  const rng = createRng("exhaust");
  const counts = new Map<string, number>();
  for (let index = 0; index < COVERAGE_TOTAL_TARGET; index += 1) {
    const cell = scheduler.next(rng);
    assert.ok(cell !== null, `planner ran dry at ${index}`);
    const key = `${cell.family}/${cell.failureMode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.equal(scheduler.next(rng), null);
  assert.equal(scheduler.exhausted, true);
  assert.equal(scheduler.hasRemaining(), false);
  assert.equal(counts.size, COVERAGE_CELL_COUNT);
  for (const count of counts.values()) assert.equal(count, COVERAGE_TARGET_PER_CELL);
  const report = scheduler.report();
  assert.equal(report.totals.planned, 308);
  assert.equal(report.totals.remaining, 0);
  assert.equal(report.totals.satisfiedCells, 77);
  assert.equal(report.planned.travel.direct, 4);
  assert.equal(report.byFamily.travel.planned, 28);
  assert.equal(report.byFailureMode.direct.planned, 44);
  scheduler.record({ family: "travel", failureMode: "direct" });
  assert.equal(scheduler.achievedFor({ family: "travel", failureMode: "direct" }), 1);
  assert.equal(scheduler.report().totals.achieved, 1);
});

test("scheduler honors a custom matrix and reports remaining counts", () => {
  const targets = defaultCoverageTargets(1);
  const scheduler = new CoverageScheduler({ targets, persona: PERSONAS.impatient });
  const rng = createRng("custom");
  const cells = [];
  for (let index = 0; index < COVERAGE_CELL_COUNT; index += 1) {
    const cell = scheduler.next(rng);
    assert.ok(cell !== null);
    cells.push(cell);
  }
  assert.equal(scheduler.next(rng), null);
  const report = scheduler.report();
  assert.equal(report.totals.planned, 77);
  assert.equal(report.totals.remaining, 0);
  for (const family of MECHANIC_FAMILIES) {
    for (const mode of FAILURE_MODES) {
      assert.equal(report.planned[family][mode], 1);
      assert.equal(report.remaining[family][mode], 0);
    }
  }
});

test("scheduler weights reflect persona bias", () => {
  assert.ok(coverageWeight(PERSONAS.explorer, { family: "travel", failureMode: "direct" })
    > coverageWeight(PERSONAS.explorer, { family: "progression", failureMode: "direct" }));
  assert.ok(coverageWeight(PERSONAS.impatient, { family: "travel", failureMode: "direct" })
    > coverageWeight(PERSONAS.explorer, { family: "travel", failureMode: "direct" }));
  assert.equal(coverageWeight(null, { family: "progression", failureMode: "direct" }), 1);
});

test("directWeight multiplies direct cells only and never below the floor", () => {
  const direct = { family: "travel", failureMode: "direct" } as const;
  const ambiguous = { family: "travel", failureMode: "ambiguous" } as const;
  assert.equal(DEFAULT_DIRECT_WEIGHT, 1);
  assert.equal(coverageWeight(PERSONAS.explorer, direct, { directWeight: 1 }), coverageWeight(PERSONAS.explorer, direct));
  assert.equal(coverageWeight(PERSONAS.explorer, direct, { directWeight: 2 }), coverageWeight(PERSONAS.explorer, direct) * 2);
  assert.equal(coverageWeight(PERSONAS.explorer, ambiguous, { directWeight: 2 }), coverageWeight(PERSONAS.explorer, ambiguous));
  assert.throws(() => coverageWeight(PERSONAS.explorer, direct, { directWeight: 0 }), /directWeight must be a finite number >= 0.1/);
  assert.throws(() => new CoverageScheduler({ directWeight: Number.NaN }), /directWeight/);
  assert.equal(new CoverageScheduler({ directWeight: MIN_DIRECT_WEIGHT }).totalTarget, COVERAGE_TOTAL_TARGET);
  // Default and explicit-1 plans are byte-identical: the RNG draw sequence is untouched.
  assert.deepEqual(
    planRun({ runSeed: "direct", persona: PERSONAS.explorer, turns: 4 }).turns.map(turn => turn.target),
    planRun({ runSeed: "direct", persona: PERSONAS.explorer, turns: 4, directWeight: DEFAULT_DIRECT_WEIGHT }).turns.map(turn => turn.target),
  );

  // A fixed RNG makes the weighted pick exact. Only travel/direct and travel/ambiguous remain:
  // explorer weights are 3*0.6=1.8 (direct) and 3*1.2=3.6 (ambiguous), total 5.4. A 0.4 roll
  // lands on ambiguous at the default and on direct when directWeight lifts it to 5.4.
  const targets = {} as Record<MechanicFamily, Record<FailureMode, number>>;
  for (const family of MECHANIC_FAMILIES) {
    targets[family] = {} as Record<FailureMode, number>;
    for (const mode of FAILURE_MODES) targets[family][mode] = 0;
  }
  targets.travel.direct = 1;
  targets.travel.ambiguous = 1;
  assert.deepEqual(new CoverageScheduler({ targets, persona: PERSONAS.explorer }).next(fixedRng(0.4)), { family: "travel", failureMode: "ambiguous" });
  assert.deepEqual(new CoverageScheduler({ targets, persona: PERSONAS.explorer, directWeight: 3 }).next(fixedRng(0.4)), { family: "travel", failureMode: "direct" });
});

test("planRun is seed-deterministic, truncates at exhaustion, and pins effort/noise", () => {
  const first = planRun({ runSeed: "test", persona: PERSONAS.explorer, turns: 3 });
  const second = planRun({ runSeed: "test", persona: PERSONAS.explorer, turns: 3 });
  assert.deepEqual(first.turns.map(turn => turn.turnSeed), ["test-0000", "test-0001", "test-0002"]);
  assert.deepEqual(first.turns.map(turn => turn.target), second.turns.map(turn => turn.target));
  assert.deepEqual(first.turns.map(turn => turn.requiredNoise), second.turns.map(turn => turn.requiredNoise));
  assert.deepEqual(first.turns[0]?.target, { family: "combat-consumable", failureMode: "unsupported" });
  assert.equal(first.turns[0]?.toolKind, "exact_combat_consumable.select");
  assert.deepEqual(first.turns[0]?.requiredNoise, ["typo"]);
  assert.deepEqual(first.turns[0]?.allowedNoise, [...SURFACE_NOISES]);
  const other = planRun({ runSeed: "other-seed", persona: PERSONAS.explorer, turns: 3 });
  assert.notDeepEqual(first.turns.map(turn => turn.target), other.turns.map(turn => turn.target));
  const truncated = planRun({ runSeed: "t", persona: PERSONAS.explorer, turns: 500, targets: defaultCoverageTargets(1) });
  assert.equal(truncated.turns.length, COVERAGE_CELL_COUNT);
  assert.equal(truncated.truncated, true);
  assert.equal(planRun({ runSeed: "t", persona: PERSONAS.explorer, turns: 0 }).turns.length, 0);
  assert.equal(effortFor(PERSONAS.explorer, "test-0000"), "high");
  assert.deepEqual(requiredNoiseFor(PERSONAS.explorer, "test-0000"), ["typo"]);
  assert.deepEqual(requiredNoiseFor(PERSONAS.impatient, "test-0000"), ["typo"]);
  assert.ok(EFFORTS.length === 2);
});

test("confirmation decisions are seeded and persona-faithful", () => {
  assert.equal(decideConfirmation(PERSONAS.achiever, "confirm-2"), "reject");
  assert.equal(decideConfirmation(PERSONAS.impatient, "confirm-2"), "stall");
  assert.equal(decideConfirmation(PERSONAS.achiever, "confirm-2"), decideConfirmation(PERSONAS.achiever, "confirm-2"));
  assert.equal(
    decideConfirmation(PERSONAS.achiever, "confirm-2", { proposalToolNames: ["exact_progression_apply.select"] }),
    "approve",
    "achiever always approves progression",
  );
  assert.equal(
    decideConfirmation(PERSONAS.impatient, "confirm-2", { proposalToolNames: ["exact_progression_apply.select"] }),
    "stall",
    "other personas are not forced to approve progression",
  );
  const counts = { approve: 0, reject: 0, stall: 0 };
  for (let index = 0; index < 200; index += 1) counts[decideConfirmation(PERSONAS.socialiser, `dist-${index}`)] += 1;
  assert.ok(counts.approve > 0 && counts.reject > 0 && counts.stall > 0, "all three decisions are reachable");
});

// -------------------------------------------------------------------------------------------------
// Prompt and generator seam
// -------------------------------------------------------------------------------------------------

test("generator prompt carries persona, transcript, sheet, target, noise, and JSON contract", () => {
  const messages = buildGeneratorMessages(promptInput({
    turnIndex: 2,
    seed: "test-0002",
    target: { family: "travel", failureMode: "unadvertised" },
    effort: "low",
    requiredNoise: ["lowercase"],
    transcript: [{ turnId: "turn-1", actorId: "actor-1", declaration: "I eye the ferry.", narration: "Fog rolls in.", completedAt: NOW }],
  }));
  assert.match(messages.system, /You are role-playing one player/);
  assert.match(messages.system, /Explorer \(explorer\.v1\)/);
  assert.match(messages.system, /never mention being a model/);
  assert.match(messages.user, /Transcript \(completed declarations/);
  assert.match(messages.user, /\[turn-1\] I eye the ferry\. => Fog rolls in\./);
  assert.match(messages.user, /Sheet summary \(public labels only\): public sheet labels/);
  assert.match(messages.user, /family=travel \(tool exact_actor_travel\.select\) failureMode=unadvertised; effort=low/);
  assert.match(messages.user, /Allowed surface noise: lowercase, uppercase-first, abbreviation, typo, trailing-question-ooc, self-correction\./);
  assert.match(messages.user, /Required noise declarations this turn \(they must appear in "noise"\): lowercase\./);
  assert.match(messages.user, /one strict JSON object and no markdown fences/);
  assert.match(messages.user, /runId=run-1/);
  assert.match(messages.user, /seed=test-0002/);
  assert.equal(buildGeneratorMessages(promptInput()).user.includes("(no completed turns yet)"), true);
});

test("generator prompt states the persona word budget for every verbosity", () => {
  assert.deepEqual(WORD_BUDGET_BY_VERBOSITY, { terse: "4-12", plain: "8-20", florid: "14-35", precise: "10-24" });
  assert.deepEqual(Object.keys(WORD_BUDGET_BY_VERBOSITY).sort(), ["florid", "plain", "precise", "terse"]);
  for (const persona of PERSONA_LIST) {
    const { system } = buildGeneratorMessages(promptInput({ persona }));
    assert.ok(
      system.includes(
        `Keep the declaration to roughly ${WORD_BUDGET_BY_VERBOSITY[persona.verbosity]} words for this persona; stay in the lower half unless the failure mode or effort calls for a longer turn.`,
      ),
      `${persona.personaId} prompt is missing its word budget`,
    );
  }
  const terse = buildGeneratorMessages(promptInput({ persona: PERSONAS.impatient })).system;
  const florid = buildGeneratorMessages(promptInput({ persona: PERSONAS.explorer })).system;
  assert.notEqual(terse, florid);
  assert.ok(!terse.includes("14-35 words"), "the terse prompt does not carry the florid budget");
});

test("transcriptSlice keeps the newest turns oldest-first", () => {
  const turns = Array.from({ length: 8 }, (_, index) => ({
    turnId: `turn-${index}`,
    actorId: "actor-1",
    declaration: `decl ${index}`,
    narration: null,
    completedAt: NOW,
  }));
  assert.deepEqual(transcriptSlice(turns, 3).map(turn => turn.turnId), ["turn-5", "turn-6", "turn-7"]);
  assert.deepEqual(transcriptSlice(turns, 0), []);
});

test("live generator posts to the OpenAI-compatible endpoint and parses fenced JSON", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const content = `\`\`\`json\n${JSON.stringify(validContract())}\n\`\`\``;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200 });
  }) as typeof fetch;
  const generator = createLiveGenerator({
    provider: "openai-compatible",
    baseUrl: "http://generator.local/v1",
    apiKey: "test-key",
    model: "test-model",
    temperature: 0.9,
    maxTokens: 256,
    timeoutMs: 5_000,
  }, fetchImpl);
  const request = buildGenerationRequest(promptInput());
  const parsed = validateTurnContract(await generator(request));
  assert.equal(parsed.declaration, "I look at the ferry wreck.");
  assert.equal(calls.length, 1, "no blind retries");
  assert.equal(calls[0]?.url, "http://generator.local/v1/chat/completions");
  assert.equal(calls[0]?.body["model"], "test-model");
  const messages = calls[0]?.body["messages"] as { role: string; content: string }[];
  assert.equal(messages.length, 2);
  assert.match(messages[0]?.content ?? "", /role-playing one player/);
  assert.match(messages[1]?.content ?? "", /Target this turn/);

  const failing = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
  const failingGenerator = createLiveGenerator({
    provider: "openai-compatible", baseUrl: "http://generator.local/v1", apiKey: "k", model: "m", temperature: 0.9, maxTokens: 16, timeoutMs: 5_000,
  }, failing);
  await assert.rejects(async () => { await failingGenerator(request); }, /HTTP 401/);
  const empty = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as typeof fetch;
  const emptyGenerator = createLiveGenerator({
    provider: "openai-compatible", baseUrl: "http://generator.local/v1", apiKey: "k", model: "m", temperature: 0.9, maxTokens: 16, timeoutMs: 5_000,
  }, empty);
  await assert.rejects(async () => { await emptyGenerator(request); }, /did not include assistant content/);

  // A reasoning model can return empty content on the first attempt; one bounded retry with a
  // larger budget is allowed, and both-empty errors name the finish reason.
  let retryCalls = 0;
  const retryFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    retryCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (retryCalls === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }] }), { status: 200 });
    }
    assert.ok(Number(body["max_tokens"]) > 16, "the retry raises the token budget");
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(validContract()) }, finish_reason: "stop" }] }), { status: 200 });
  }) as typeof fetch;
  const retryGenerator = createLiveGenerator({
    provider: "openai-compatible", baseUrl: "http://generator.local/v1", apiKey: "k", model: "m", temperature: 0.9, maxTokens: 16, timeoutMs: 5_000,
  }, retryFetch);
  assert.equal(validateTurnContract(await retryGenerator(request)).declaration, "I look at the ferry wreck.");
  assert.equal(retryCalls, 2);

  // A response truncated by the token budget is retried once; a complete but malformed response is not.
  let truncatedCalls = 0;
  const truncatedFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    truncatedCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (truncatedCalls === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{\"runId\":\"r\",\"decl" }, finish_reason: "length" }] }), { status: 200 });
    }
    assert.ok(Number(body["max_tokens"]) > 16, "the retry raises the token budget");
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(validContract()) }, finish_reason: "stop" }] }), { status: 200 });
  }) as typeof fetch;
  const truncatedGenerator = createLiveGenerator({
    provider: "openai-compatible", baseUrl: "http://generator.local/v1", apiKey: "k", model: "m", temperature: 0.9, maxTokens: 16, timeoutMs: 5_000,
  }, truncatedFetch);
  assert.equal(validateTurnContract(await truncatedGenerator(request)).declaration, "I look at the ferry wreck.");
  assert.equal(truncatedCalls, 2);

  // A strict-contract violation (for example an invalid effort) is retried once.
  let contractCalls = 0;
  const contractFetch = (async () => {
    contractCalls += 1;
    const payload = contractCalls === 1
      ? { ...validContract(), declaration: "" }
      : validContract();
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }] }), { status: 200 });
  }) as typeof fetch;
  const contractGenerator = createLiveGenerator({
    provider: "openai-compatible", baseUrl: "http://generator.local/v1", apiKey: "k", model: "m", temperature: 0.9, maxTokens: 16, timeoutMs: 5_000,
  }, contractFetch);
  assert.equal(validateTurnContract(await contractGenerator(request)).declaration, "I look at the ferry wreck.");
  assert.equal(contractCalls, 2);
});

test("fake generator echoes the harness identity and honors required noise", () => {
  const generator = createFakeGenerator();
  const generated = generator(buildGenerationRequest(promptInput({
    target: { family: "rest", failureMode: "direct" },
    requiredNoise: ["lowercase"],
    effort: "low",
  }))) as Record<string, unknown>;
  assert.equal(generated["runId"], "run-1");
  assert.equal(generated["sessionId"], "synthetic-player.explorer.test.a");
  assert.equal(generated["turnIndex"], 0);
  assert.equal(generated["personaId"], "explorer.v1");
  assert.equal(generated["seed"], "test-0000");
  assert.equal(generated["effort"], "low");
  assert.deepEqual(generated["intended"], { family: "rest", failureMode: "direct" });
  assert.deepEqual(generated["noise"], ["lowercase"]);
  assert.equal(typeof generated["declaration"], "string");
  const contract = validateTurnContract(generated, { requiredNoise: ["lowercase"] });
  assert.ok(contract.declaration.length > 0);
});

test("materializeTurn validates, applies noise, and reports exact bytes", () => {
  const plan = planRun({ runSeed: "test", persona: PERSONAS.explorer, turns: 1 }).turns[0];
  assert.ok(plan);
  const generated = createFakeGenerator()(buildGenerationRequest(promptInput({
    target: plan.target,
    requiredNoise: plan.requiredNoise,
    effort: plan.effort,
    turnIndex: plan.turnIndex,
    seed: plan.turnSeed,
  })));
  const materialized = materializeTurn(generated, {
    runId: "run-1",
    sessionId: "11111111-2222-3333-4444-555555555555",
    sessionTag: "synthetic-player.explorer.test.a",
    persona: PERSONAS.explorer,
    turnSeed: plan.turnSeed,
    plan,
  });
  assert.deepEqual(materialized.applied, [...plan.requiredNoise]);
  assert.equal(materialized.contract.turnIndex, plan.turnIndex);
  assert.notEqual(materialized.declaration, materialized.contract.declaration, "required typo changed the bytes");
  assert.equal(materialized.ooc, null);
  assert.throws(() => materializeTurn(validContract({ turnIndex: 9 }), {
    runId: "run-1",
    sessionId: null,
    sessionTag: "synthetic-player.explorer.test.a",
    persona: PERSONAS.explorer,
    turnSeed: plan.turnSeed,
    plan,
  }), /turnIndex mismatch/);
});

// -------------------------------------------------------------------------------------------------
// Session tags, idempotency keys, request builders, SSE
// -------------------------------------------------------------------------------------------------

test("session tags and idempotency keys follow the documented shapes", () => {
  assert.equal(sessionIndexLabel(0), "a");
  assert.equal(sessionIndexLabel(25), "z");
  assert.equal(sessionIndexLabel(26), "aa");
  assert.equal(sessionIndexLabel(27), "ab");
  assert.equal(sessionTagFor("explorer", "7c1f", 0), "synthetic-player.explorer.7c1f.a");
  assert.equal(sessionTagFor("rules-tinkerer", "7c1f", 27), "synthetic-player.rules-tinkerer.7c1f.ab");
  assert.equal(SYNTHETIC_TAG_PREFIX, "synthetic-player");
  assert.ok(isSyntheticTag("synthetic-player.explorer.7c1f.a"));
  assert.ok(!isSyntheticTag("explorer.7c1f.a"));
  assert.ok(!isSyntheticTag("synthetic-player.explorer.7c1f.a.extra"));
  assert.ok(!isSyntheticTag("synthetic-player.bad seed.x.a"));
  assert.throws(() => sessionTagFor("explorer", "bad seed", 0), /tag-safe/);
  assert.equal(deriveIdempotencyKey("run-1", 4), "synth.run-1.4");
  assert.equal(deriveIdempotencyKey("run-1", 4, "extra"), "synth.run-1.4.extra");
  assert.equal(deriveConfirmationIdempotencyKey("run-1", 4, 0), "synth.run-1.4.confirm.0");
  assert.equal(formatTurnSeed("7c1f", 4), "7c1f-0004");
  assert.equal(formatTurnSeed("7c1f", 0), "7c1f-0000");
  assert.throws(() => formatTurnSeed("7c1f", -1), /turnIndex/);
});

test("request builders produce assertable HTTP specs without a network", () => {
  const base = "http://127.0.0.1:8787/";
  const bootstrap = buildPlayBootstrapRequest(base, "camp 1", "room/1");
  assert.equal(bootstrap.method, "GET");
  assert.equal(bootstrap.url, "http://127.0.0.1:8787/api/rpg/v1/campaigns/camp%201/rooms/room%2F1/play-bootstrap");
  assert.equal("body" in bootstrap, false);

  const initial = buildStreamRequest(base, {
    campaignId: "camp-1",
    sessionId: "sess-1",
    actorId: "actor-1",
    declaration: "I wait.",
    expectedRevision: 7,
    idempotencyKey: "synth.run-1.0",
  });
  assert.equal(initial.method, "POST");
  assert.deepEqual(initial.headers, { "content-type": "application/json", accept: "text/event-stream" });
  assert.deepEqual(initial.body, {
    campaignId: "camp-1",
    sessionId: "sess-1",
    actorId: "actor-1",
    declaration: "I wait.",
    expectedRevision: 7,
    idempotencyKey: "synth.run-1.0",
  });
  const resume = buildStreamRequest(base, { resumeToken: "resume-1" });
  assert.deepEqual(resume.body, { resumeToken: "resume-1" });

  const confirm = buildConfirmRequest(base, "turn-1", {
    proposalIds: ["p1"],
    decision: "approve",
    expectedRevision: 3,
    idempotencyKey: "synth.run-1.0.confirm.0",
  });
  assert.equal(confirm.url, "http://127.0.0.1:8787/api/rpg/v1/adventure-turns/turn-1/confirm");
  assert.deepEqual(confirm.body, {
    proposalIds: ["p1"],
    decision: "approve",
    expectedRevision: 3,
    idempotencyKey: "synth.run-1.0.confirm.0",
  });

  assert.equal(buildTurnRequest(base, "turn-1").url, "http://127.0.0.1:8787/api/rpg/v1/adventure-turns/turn-1");
  assert.equal(
    buildTranscriptRequest(base, "camp-1", "sess-1").url,
    "http://127.0.0.1:8787/api/rpg/v1/adventure-turns/transcript?campaignId=camp-1&sessionId=sess-1",
  );
  assert.equal(
    buildReconcileInitialRequest(base, { campaignId: "c", sessionId: "s", actorId: "a", idempotencyKey: "k" }).url,
    "http://127.0.0.1:8787/api/rpg/v1/adventure-turns/reconcile-initial?campaignId=c&sessionId=s&actorId=a&idempotencyKey=k",
  );

  const init = requestInit(initial);
  assert.equal(init.method, "POST");
  assert.equal(init.body, JSON.stringify(initial.body));
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(requestInit(bootstrap).body, undefined);
});

test("SSE frames parse leniently and skip noise", () => {
  const text = [
    ": heartbeat",
    "",
    sseFrame("turn_started", { turn: { turnId: "turn-1" } }, 0),
    "data: not json",
    "",
    sseFrame("confirmation_required", { proposalIds: ["p1"], expiresAt: NOW }, 1),
  ].join("\n");
  const events = parseSseText(text);
  assert.deepEqual(events.map(event => event.type), ["turn_started", "confirmation_required"]);
  assert.deepEqual(events[0]?.payload, { turn: { turnId: "turn-1" } });
  assert.equal(events[1]?.sequence, 1);
  assert.equal(parseSseBlock(": heartbeat"), null);
  assert.equal(parseSseBlock("data: {\"type\":\"terminal\",\"payload\":{\"outcome\":\"done\"}}")?.type, "terminal");
});

// -------------------------------------------------------------------------------------------------
// Session driver (fake fetch, no network)
// -------------------------------------------------------------------------------------------------

test("session driver drives stream, confirmation, resume, and transcript without a network", async () => {
  const requests: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  let detailReads = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    requests.push({ method, url, body });
    if (url.includes("play-bootstrap")) {
      return jsonResponse({ campaignId: "camp-1", sessionId: "sess-1", expectedRevision: 7, playableActors: [{ actorId: "actor-1", name: "Aster" }] });
    }
    if (url.endsWith("/adventure-turns/stream")) {
      if (body && typeof body["resumeToken"] === "string") {
        return sseResponse([
          sseFrame("agent_status", { status: "narrating" }, 0),
          sseFrame("mechanics_committed", { receipts: [{ commandId: "cmd-1", proposalId: "p1" }] }, 1),
          sseFrame("terminal", { outcome: "done", turn: { turnId: "turn-1" }, narrationStatus: { status: "completed", text: "You advance.", source: "provider-assisted" }, receipts: [{ commandId: "cmd-1", proposalId: "p1" }] }, 2),
        ].join(""), "turn-1");
      }
      return sseResponse([
        sseFrame("turn_started", { turn: { turnId: "turn-1", state: "declared" } }, 0),
        sseFrame("tool_proposed", { proposal: { proposalId: "p1", toolName: "exact_progression_apply.select" } }, 1),
        sseFrame("confirmation_required", { proposalIds: ["p1"], expiresAt: NOW }, 2),
        sseFrame("terminal", { outcome: "aborted", turn: { turnId: "turn-1" } }, 3),
      ].join(""), "turn-1");
    }
    if (url.includes("/adventure-turns/turn-1/confirm")) {
      return jsonResponse({ turn: { turnId: "turn-1", state: "mechanics-committed" }, resumeToken: "resume-1" });
    }
    if (url.includes("/adventure-turns/turn-1")) {
      detailReads += 1;
      if (detailReads === 1) {
        return jsonResponse({
          turn: { turnId: "turn-1", state: "awaiting-confirmation", revision: 3 },
          proposals: [{ proposalId: "p1", toolName: "exact_progression_apply.select" }],
          confirmation: { state: "pending", proposalIds: ["p1"], expiresAt: NOW },
          receipts: [],
          narrationStatus: { status: "none", text: null, source: null },
        });
      }
      return jsonResponse({
        turn: { turnId: "turn-1", state: "completed", revision: 4 },
        proposals: [],
        confirmation: { state: "decided", decisions: [{ proposalId: "p1", decision: "approved", decidedAt: NOW }] },
        receipts: [{ commandId: "cmd-1", proposalId: "p1" }],
        narrationStatus: { status: "completed", text: "You advance.", source: "provider-assisted" },
      });
    }
    if (url.includes("/adventure-turns/transcript")) {
      return jsonResponse({
        campaignId: "camp-1",
        sessionId: "sess-1",
        turns: [{ turnId: "turn-1", actorId: "actor-1", declaration: "I level up.", narration: "You advance.", completedAt: NOW }],
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof fetch;

  const driver = new SessionDriver({
    baseUrl: "http://127.0.0.1:8787",
    campaignId: "camp-1",
    sessionId: "sess-1",
    actorId: "actor-1",
    runId: "synth-test-a",
    persona: PERSONAS.achiever,
    sessionTag: "synthetic-player.achiever.test.a",
    fetchImpl,
  });
  const outcome = await driver.submitTurn({ turnIndex: 0, declaration: "I level up.", turnSeed: "confirm-2" });
  assert.equal(outcome.turnId, "turn-1");
  assert.equal(outcome.terminalOutcome, "done");
  assert.equal(outcome.turnState, "completed");
  assert.deepEqual(outcome.confirmationDecisions, ["approve"], "achiever approves progression");
  assert.deepEqual(outcome.confirmationBatches, [["p1"]]);
  assert.deepEqual(outcome.receipts, [{ commandId: "cmd-1", proposalId: "p1" }]);
  assert.equal(outcome.narration?.text, "You advance.");
  assert.equal(outcome.narration?.source, "provider-assisted");
  assert.equal(outcome.transcript?.length, 1);
  assert.equal(outcome.uncertain, false);
  assert.equal(outcome.error, null, "a completed turn carries no failure reason");
  assert.deepEqual(outcome.events, [{ type: "agent_status", code: "status=narrating" }]);

  const paths = requests.map(request => `${request.method} ${request.url.replace("http://127.0.0.1:8787", "")}`);
  assert.deepEqual(paths, [
    "GET /api/rpg/v1/campaigns/camp-1/rooms/sess-1/play-bootstrap",
    "POST /api/rpg/v1/adventure-turns/stream",
    "GET /api/rpg/v1/adventure-turns/turn-1",
    "POST /api/rpg/v1/adventure-turns/turn-1/confirm",
    "POST /api/rpg/v1/adventure-turns/stream",
    "GET /api/rpg/v1/adventure-turns/turn-1",
    "GET /api/rpg/v1/adventure-turns/transcript?campaignId=camp-1&sessionId=sess-1",
  ]);
  const initial = requests[1]?.body;
  assert.equal(initial?.["expectedRevision"], 7);
  assert.equal(initial?.["declaration"], "I level up.");
  assert.equal(initial?.["idempotencyKey"], "synth.synth-test-a.0");
  assert.deepEqual(requests[3]?.body, {
    proposalIds: ["p1"],
    decision: "approve",
    expectedRevision: 3,
    idempotencyKey: "synth.synth-test-a.0.confirm.0",
  });
  assert.deepEqual(requests[4]?.body, { resumeToken: "resume-1" });
});

test("session driver stalls, rejects, and reads the bound session without retries", async () => {
  const makeFetch = (decisionPath: "stall" | "reject") => {
    const requests: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("play-bootstrap")) {
        return jsonResponse({ campaignId: "camp-1", sessionId: "sess-1", expectedRevision: 1, playableActors: [] });
      }
      if (url.endsWith("/adventure-turns/stream")) {
        return sseResponse([
          sseFrame("confirmation_required", { proposalIds: ["p1"], expiresAt: NOW }, 0),
          sseFrame("terminal", { outcome: "aborted" }, 1),
        ].join(""), "turn-1");
      }
      if (url.includes("/adventure-turns/turn-1/confirm")) {
        return jsonResponse({ turn: { turnId: "turn-1", state: "mechanics-committed" }, resumeToken: "resume-1" });
      }
      if (url.includes("/adventure-turns/turn-1")) {
        return jsonResponse({ turn: { turnId: "turn-1", state: "awaiting-confirmation", revision: 2 }, receipts: [], narrationStatus: { status: "none", text: null, source: null } });
      }
      if (url.includes("/adventure-turns/transcript")) return jsonResponse({ turns: [] });
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    return { fetchImpl, requests, decisionPath };
  };

  const stallFixture = makeFetch("stall");
  const stallDriver = new SessionDriver({
    baseUrl: "http://127.0.0.1:8787",
    campaignId: "camp-1",
    sessionId: "sess-1",
    actorId: "actor-1",
    runId: "synth-test-a",
    persona: PERSONAS.impatient,
    sessionTag: "synthetic-player.impatient.test.a",
    fetchImpl: stallFixture.fetchImpl,
  });
  const stalled = await stallDriver.submitTurn({ turnIndex: 1, declaration: "I wait.", turnSeed: "stall-me", confirmationDecision: "stall" });
  assert.deepEqual(stalled.confirmationDecisions, ["stall"]);
  assert.equal(stalled.turnState, "awaiting-confirmation");
  assert.equal(stalled.terminalOutcome, "aborted");
  assert.equal(stalled.error, "turn did not complete (terminal=aborted)");
  assert.deepEqual(stalled.events, []);
  assert.ok(stallFixture.requests.every(url => !url.includes("/confirm")), "a stall must not POST a confirmation");

  const rejectFixture = makeFetch("reject");
  const rejectDriver = new SessionDriver({
    baseUrl: "http://127.0.0.1:8787",
    campaignId: "camp-1",
    sessionId: "sess-1",
    actorId: "actor-1",
    runId: "synth-test-a",
    persona: PERSONAS.socialiser,
    sessionTag: "synthetic-player.socialiser.test.a",
    fetchImpl: rejectFixture.fetchImpl,
  });
  const rejected = await rejectDriver.submitTurn({ turnIndex: 2, declaration: "I ask around.", turnSeed: "reject-me", confirmationDecision: "reject" });
  assert.deepEqual(rejected.confirmationDecisions, ["reject"]);
});

test("session driver fails closed on ambiguous and definitive errors", async () => {
  const driver = (fetchImpl: typeof fetch) => new SessionDriver({
    baseUrl: "http://127.0.0.1:8787",
    campaignId: "camp-1",
    sessionId: "sess-1",
    actorId: "actor-1",
    runId: "synth-test-a",
    persona: PERSONAS.explorer,
    sessionTag: "synthetic-player.explorer.test.a",
    fetchImpl,
  });

  const unreachable = driver((async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
  await assert.rejects(
    () => unreachable.submitTurn({ turnIndex: 0, declaration: "I wait.", turnSeed: "e-0" }),
    (error: unknown) => error instanceof SessionTurnError && error.uncertain === true && /play-bootstrap failed: ECONNREFUSED/.test(error.message),
  );

  const serverError = driver((async () => new Response("boom", { status: 500 })) as typeof fetch);
  await assert.rejects(
    () => serverError.submitTurn({ turnIndex: 0, declaration: "I wait.", turnSeed: "e-0", expectedRevision: 1 }),
    (error: unknown) => error instanceof SessionTurnError && error.uncertain === true && /HTTP 500/.test(error.message),
  );

  const rejected = driver((async () => new Response("bad", { status: 400 })) as typeof fetch);
  await assert.rejects(
    () => rejected.submitTurn({ turnIndex: 0, declaration: "I wait.", turnSeed: "e-0", expectedRevision: 1 }),
    (error: unknown) => error instanceof SessionTurnError && error.uncertain === false && /HTTP 400/.test(error.message),
  );

  const missingRevision = driver((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("play-bootstrap")) return jsonResponse({ campaignId: "camp-1" });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch);
  await assert.rejects(
    () => missingRevision.submitTurn({ turnIndex: 0, declaration: "I wait.", turnSeed: "e-0" }),
    (error: unknown) => error instanceof SessionTurnError && error.uncertain === false && /expectedRevision/.test(error.message),
  );
});

test("session driver diagnoses streams that do not end done", async () => {
  const makeFetch = (frames: string[], state: string) => (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("play-bootstrap")) {
      return jsonResponse({ campaignId: "camp-1", sessionId: "sess-1", expectedRevision: 1, playableActors: [] });
    }
    if (url.endsWith("/adventure-turns/stream")) return sseResponse(frames.join(""), "turn-1");
    if (url.includes("/adventure-turns/turn-1")) {
      return jsonResponse({ turn: { turnId: "turn-1", state, revision: 2 }, receipts: [], narrationStatus: { status: "none", text: null, source: null } });
    }
    if (url.includes("/adventure-turns/transcript")) return jsonResponse({ turns: [] });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const driverFor = (frames: string[], state = "failed") => new SessionDriver({
    baseUrl: "http://127.0.0.1:8787",
    campaignId: "camp-1",
    sessionId: "sess-1",
    actorId: "actor-1",
    runId: "synth-test-a",
    persona: PERSONAS.explorer,
    sessionTag: "synthetic-player.explorer.test.a",
    fetchImpl: makeFetch(frames, state),
  });

  // A failed terminal payload carries no error field; the diagnosis comes from the status events
  // that preceded it, never from null.
  const rejected = await driverFor([
    sseFrame("agent_status", { status: "planning" }, 0),
    sseFrame("agent_status", { status: "decision-rejected" }, 1),
    sseFrame("terminal", { outcome: "error" }, 2),
  ]).submitTurn({ turnIndex: 0, declaration: "I try.", turnSeed: "diag-0" });
  assert.equal(rejected.terminalOutcome, "error");
  assert.equal(rejected.turnState, "failed");
  assert.equal(rejected.error, "turn failed: status=decision-rejected; terminal=error");
  assert.deepEqual(rejected.events, [
    { type: "agent_status", code: "status=planning" },
    { type: "agent_status", code: "status=decision-rejected" },
  ]);

  // A stream that closes without a terminal event is labeled `terminal=fallback`, and a code on
  // any event (here the budget reason observed in the database) wins over the earlier statuses.
  const budget = await driverFor([
    sseFrame("agent_status", { status: "narrating" }, 0),
    sseFrame("agent_status", { status: "failed", errorCode: "budget-prompt-token-budget" }, 1),
  ]).submitTurn({ turnIndex: 1, declaration: "I try.", turnSeed: "diag-1" });
  assert.equal(budget.terminalOutcome, "unknown");
  assert.equal(budget.error, "turn failed: errorCode=budget-prompt-token-budget; terminal=fallback");
  assert.deepEqual(budget.events, [
    { type: "agent_status", code: "status=narrating" },
    { type: "agent_status", code: "status=failed" },
    { type: "agent_status", code: "errorCode=budget-prompt-token-budget" },
  ]);

  // Nothing informative on the stream still yields a non-null, stable reason.
  const silent = await driverFor([
    sseFrame("terminal", { outcome: "error" }, 0),
  ]).submitTurn({ turnIndex: 2, declaration: "I try.", turnSeed: "diag-2" });
  assert.equal(silent.error, "turn did not complete (terminal=error)");
  assert.deepEqual(silent.events, []);
});

// -------------------------------------------------------------------------------------------------
// Dry-run manifest, serialization, CLI
// -------------------------------------------------------------------------------------------------

test("dry run produces a planned manifest with the tag mapping and no store writes", async () => {
  const manifest = await runHarnessSession(makeDryRunInput());
  assert.equal(manifest.harnessVersion, HARNESS_VERSION);
  assert.equal(manifest.personaVersion, PERSONA_VERSION);
  assert.equal(manifest.mode, "dry-run");
  assert.equal(manifest.state, "planned");
  assert.equal(manifest.runId, "synth-test-a");
  assert.equal(manifest.seed, "test");
  assert.equal(manifest.startedAt, NOW);
  assert.equal(manifest.sessions.length, 1);
  const session = manifest.sessions[0];
  assert.ok(session);
  assert.equal(session.sessionTag, "synthetic-player.explorer.test.a");
  assert.equal(session.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(session.personaId, "explorer.v1");
  assert.equal(session.personaVersion, PERSONA_VERSION);
  assert.equal(session.turns, 3);
  assert.match(session.promptDigest, /^[0-9a-f]{64}$/);
  assert.match(session.contractDigest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.turns.length, 3);
  for (const turn of manifest.turns) {
    assert.equal(turn.outcome, "planned");
    assert.equal(turn.turnId, null);
    assert.ok(turn.declaration.length > 0);
    assert.deepEqual(turn.noiseApplied, turn.noiseDeclared);
    assert.equal(turn.error, null);
    assert.equal(turn.events, undefined, "planned turns keep the pre-diagnosis schema");
  }
  assert.equal(manifest.turns[0]?.idempotencyKey, "synth.synth-test-a.0");
  assert.deepEqual(manifest.turns[0]?.target, { family: "combat-consumable", failureMode: "unsupported" });
  assert.ok(manifest.notes.some(note => note.includes("synthetic-player.explorer.test.a") && note.includes("11111111-2222-3333-4444-555555555555")));
  assert.ok(manifest.notes.some(note => note.includes("dry-run")));
  assert.equal(manifest.coverage.totals.planned, 3);
  assert.equal(manifest.coverage.totals.achieved, 0);
  assert.equal(manifest.coverage.totals.target, COVERAGE_TOTAL_TARGET);
  assert.notEqual(manifest.turns[0]?.declaration, manifest.turns[0]?.declarationGenerated, "required typo was applied");
  assert.equal(manifest.world.campaignId, "camp-1");
  assert.equal(manifest.world.actorId, "actor-1");
  assert.equal(manifest.world.dataDir, null);
});

test("dry run is byte-stable and honors a synthetic tag override", async () => {
  const first = await runHarnessSession(makeDryRunInput());
  const second = await runHarnessSession(makeDryRunInput());
  assert.equal(serializeManifest(first), serializeManifest(second));
  assert.equal(manifestDigest(first), manifestDigest(second));
  assert.ok(serializeManifest(first).endsWith("\n"));

  const overridden = await runHarnessSession(makeDryRunInput({ syntheticTag: "synthetic-player.custom.abc.a" }));
  assert.equal(overridden.sessions[0]?.sessionTag, "synthetic-player.custom.abc.a");
  const summary = renderManifestSummary(overridden);
  assert.ok(summary.some(line => line.includes("synthetic-player.custom.abc.a")));
  assert.ok(summary.some(line => line.includes("coverage: planned 3/308")));
});

test("manifest serialization is canonical regardless of key order", async () => {
  assert.equal(
    stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
  );
  const manifest = await runHarnessSession(makeDryRunInput());
  const shuffled = Object.fromEntries(Object.entries(manifest).reverse()) as HarnessManifest;
  assert.equal(serializeManifest(shuffled), serializeManifest(manifest));
  assert.equal(manifestDigest(shuffled), manifestDigest(manifest));
  assert.match(manifestDigest(manifest), /^[0-9a-f]{64}$/);
});

test("live session stops as uncertain on ambiguous failures and failed on definitive ones", async () => {
  const uncertain = await runHarnessSession(makeDryRunInput({
    mode: "live",
    generateTurn: createFakeGenerator(),
    submitTurn: async () => { throw new SessionTurnError("socket died", { uncertain: true }); },
  }));
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uncertain.turns.length, 1);
  assert.equal(uncertain.turns[0]?.outcome, "uncertain");
  assert.match(uncertain.turns[0]?.error ?? "", /socket died/);
  assert.ok(uncertain.notes.some(note => note.includes("without retry")));

  const failed = await runHarnessSession(makeDryRunInput({
    mode: "live",
    submitTurn: async () => { throw new SessionTurnError("stale revision", { uncertain: false }); },
  }));
  assert.equal(failed.state, "failed");
  assert.equal(failed.turns[0]?.outcome, "error");

  const generatorFailure = await runHarnessSession(makeDryRunInput({
    mode: "live",
    generateTurn: () => { throw new Error("provider exploded"); },
    submitTurn: async () => { throw new Error("should not be called"); },
  }));
  assert.equal(generatorFailure.state, "failed");
  assert.match(generatorFailure.turns[0]?.error ?? "", /generator failed: provider exploded/);

  const rejectedContract = await runHarnessSession(makeDryRunInput({
    mode: "live",
    generateTurn: () => validContract({ turnIndex: 99 }),
    submitTurn: async () => { throw new Error("should not be called"); },
  }));
  assert.equal(rejectedContract.state, "failed");
  assert.match(rejectedContract.turns[0]?.error ?? "", /contract rejected/);
});

test("live session records the stream diagnosis instead of a null error", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("play-bootstrap")) {
      return jsonResponse({ campaignId: "camp-1", sessionId: "sess-1", expectedRevision: 1, playableActors: [] });
    }
    if (url.endsWith("/adventure-turns/stream")) {
      return sseResponse([
        sseFrame("turn_started", { turn: { turnId: "turn-1", state: "declared" } }, 0),
        sseFrame("agent_status", { status: "decision-rejected" }, 1),
        sseFrame("terminal", { outcome: "error" }, 2),
      ].join(""), "turn-1");
    }
    if (url.includes("/adventure-turns/turn-1")) {
      return jsonResponse({ turn: { turnId: "turn-1", state: "failed", revision: 2 }, receipts: [], narrationStatus: { status: "none", text: null, source: null } });
    }
    if (url.includes("/adventure-turns/transcript")) return jsonResponse({ turns: [] });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const driver = new SessionDriver({
    baseUrl: "http://127.0.0.1:8787",
    campaignId: "camp-1",
    sessionId: "11111111-2222-3333-4444-555555555555",
    actorId: "actor-1",
    runId: "synth-test-a",
    persona: PERSONAS.explorer,
    sessionTag: "synthetic-player.explorer.test.a",
    fetchImpl,
  });
  const manifest = await runHarnessSession(makeDryRunInput({
    mode: "live",
    submitTurn: request => driver.submitTurn(request),
  }));
  assert.equal(manifest.state, "failed");
  assert.equal(manifest.turns.length, 1);
  const turn = manifest.turns[0];
  assert.ok(turn);
  assert.equal(turn.outcome, "error");
  assert.equal(turn.error, "turn failed: status=decision-rejected; terminal=error");
  assert.deepEqual(turn.events, [{ type: "agent_status", code: "status=decision-rejected" }]);
  assert.equal(turn.turnId, "turn-1");
  assert.equal(turn.turnState, "failed");
  assert.ok(manifest.notes.some(note => note.includes("terminal error")));
});

test("live session records completion and coverage when submitTurn resolves", async () => {
  const manifest = await runHarnessSession(makeDryRunInput({
    mode: "live",
    submitTurn: async input => ({
      turnId: `turn-${input.turnIndex}`,
      terminalOutcome: "done",
      turnState: "completed",
      confirmationDecisions: [],
      confirmationBatches: [],
      receipts: [],
      narration: { status: "completed", text: "ok", source: "deterministic-fallback" },
      transcript: null,
      uncertain: false,
      events: [],
      error: null,
    }),
  }));
  assert.equal(manifest.state, "complete");
  assert.equal(manifest.sessions[0]?.turns, 3);
  assert.equal(manifest.coverage.totals.achieved, 3);
  assert.equal(manifest.coverage.totals.planned, 3);
  assert.ok(manifest.turns.every(turn => turn.outcome === "done" && turn.turnId !== null));
  assert.ok(manifest.turns.every(turn => turn.error === null && turn.events === undefined), "successful turns keep the old schema");
});

test("CLI parsing handles defaults, both flag forms, and validation", () => {
  assert.deepEqual(parseHarnessArgs([], {}), {
    turns: 6,
    personas: [...PERSONA_ARCHETYPES],
    seed: "synth",
    runs: 1,
    campaignId: null,
    sessionIds: [],
    actorId: null,
    out: null,
    dryRun: false,
    syntheticTag: null,
    runId: null,
    sheetSummary: null,
    baseUrl: "http://127.0.0.1:8787",
    maxConfirmationRounds: 5,
    dataDir: null,
    contentProfile: null,
    menuWindow: DEFAULT_MENU_WINDOW,
    directWeight: DEFAULT_DIRECT_WEIGHT,
    focus: null,
    help: false,
  });
  // `--data-dir` overrides the VELVET_DATA_DIR default; without the flag the env value survives.
  assert.equal(parseHarnessArgs(["--data-dir", "/tmp/velvet"], { VELVET_DATA_DIR: "/env/velvet" }).dataDir, "/tmp/velvet");
  assert.equal(parseHarnessArgs([], { VELVET_DATA_DIR: "/env/velvet" }).dataDir, "/env/velvet");
  assert.equal(parseHarnessArgs(["--data-dir", "/tmp/velvet"], {}).dataDir, "/tmp/velvet");
  assert.throws(() => parseHarnessArgs(["--data-dir"], {}), /--data-dir requires a value/);
  // The content profile is caller-supplied only; absent stays null.
  assert.equal(parseHarnessArgs(["--content-profile", "velvet-starter"], {}).contentProfile, "velvet-starter");
  assert.equal(parseHarnessArgs(["--content-profile=srd-5.1"], {}).contentProfile, "srd-5.1");
  assert.equal(parseHarnessArgs([], {}).contentProfile, null);
  assert.throws(() => parseHarnessArgs(["--content-profile"], {}), /--content-profile requires a value/);
  // Recent-menu window and direct-cell weighting.
  assert.equal(parseHarnessArgs(["--menu-window", "5"], {}).menuWindow, 5);
  assert.equal(parseHarnessArgs(["--menu-window=7"], {}).menuWindow, 7);
  assert.throws(() => parseHarnessArgs(["--menu-window", "0"], {}), /--menu-window must be an integer between 1 and 10/);
  assert.throws(() => parseHarnessArgs(["--menu-window", "11"], {}), /--menu-window must be an integer between 1 and 10/);
  assert.throws(() => parseHarnessArgs(["--menu-window"], {}), /--menu-window requires a value/);
  assert.equal(parseHarnessArgs(["--direct-weight", "2.5"], {}).directWeight, 2.5);
  assert.equal(parseHarnessArgs(["--direct-weight=0.1"], {}).directWeight, 0.1);
  assert.throws(() => parseHarnessArgs(["--direct-weight", "0.05"], {}), /--direct-weight must be a number >= 0.1/);
  assert.throws(() => parseHarnessArgs(["--direct-weight", "nope"], {}), /--direct-weight must be a number >= 0.1/);
  assert.throws(() => parseHarnessArgs(["--direct-weight"], {}), /--direct-weight requires a value/);
  // Focused coverage flags: both or neither, each value validated.
  assert.deepEqual(parseHarnessArgs(["--focus-family", "combat-consumable", "--focus-mode", "direct"], {}).focus, { family: "combat-consumable", failureMode: "direct" });
  assert.deepEqual(parseHarnessArgs(["--focus-family=travel", "--focus-mode=unsupported"], {}).focus, { family: "travel", failureMode: "unsupported" });
  assert.equal(parseHarnessArgs([], {}).focus, null);
  assert.throws(() => parseHarnessArgs(["--focus-family", "travel"], {}), /--focus-family and --focus-mode must be used together/);
  assert.throws(() => parseHarnessArgs(["--focus-mode", "direct"], {}), /--focus-family and --focus-mode must be used together/);
  assert.throws(() => parseHarnessArgs(["--focus-family", "wizard", "--focus-mode", "direct"], {}), /--focus-family must be one of/);
  assert.throws(() => parseHarnessArgs(["--focus-family", "travel", "--focus-mode", "sometimes"], {}), /--focus-mode must be one of/);
  assert.throws(() => parseHarnessArgs(["--focus-family"], {}), /--focus-family requires a value/);
  assert.throws(() => parseHarnessArgs(["--focus-mode"], {}), /--focus-mode requires a value/);
  const parsed = parseHarnessArgs([
    "--turns=3",
    "--personas", "explorer.v1,impatient",
    "--runs", "2",
    "--seed=test",
    "--campaign-id", "camp-1",
    "--session-id", "sess-1,sess-2",
    "--actor-id=actor-1",
    "--out", "manifests",
    "--run-id=run-1",
    "--sheet-summary", "Bryn the ranger",
    "--api-base-url", "http://127.0.0.1:9999/",
    "--max-confirmation-rounds=2",
    "--menu-window=4",
    "--direct-weight=2",
    "--dry-run",
  ], {});
  assert.equal(parsed.turns, 3);
  assert.deepEqual(parsed.personas, ["explorer", "impatient"]);
  assert.equal(parsed.runs, 2);
  assert.equal(parsed.seed, "test");
  assert.equal(parsed.campaignId, "camp-1");
  assert.deepEqual(parsed.sessionIds, ["sess-1", "sess-2"]);
  assert.equal(parsed.actorId, "actor-1");
  assert.equal(parsed.out, "manifests");
  assert.equal(parsed.syntheticTag, null);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.baseUrl, "http://127.0.0.1:9999");
  assert.equal(parsed.maxConfirmationRounds, 2);
  assert.equal(parsed.menuWindow, 4);
  assert.equal(parsed.directWeight, 2);
  assert.equal(parseHarnessArgs(["--runs", "1", "--synthetic-tag", "synthetic-player.custom.x.a"], {}).syntheticTag, "synthetic-player.custom.x.a");
  assert.throws(() => parseHarnessArgs(["--turns", "0"], {}), /--turns must be an integer between 1 and 200/);
  assert.throws(() => parseHarnessArgs(["--turns", "nope"], {}), /--turns must be an integer between 1 and 200/);
  assert.throws(() => parseHarnessArgs(["--personas", "wizard"], {}), /unknown persona: wizard/);
  assert.throws(() => parseHarnessArgs(["--seed", "bad seed"], {}), /tag-safe/);
  assert.throws(() => parseHarnessArgs(["--synthetic-tag", "nope"], {}), /synthetic tag must look like/);
  assert.throws(() => parseHarnessArgs(["--dry-run=yes"], {}), /does not take a value/);
  assert.throws(() => parseHarnessArgs(["--turns"], {}), /--turns requires a value/);
  assert.throws(() => parseHarnessArgs(["--what"], {}), /unknown argument: --what/);
  assert.throws(() => parseHarnessArgs(["--synthetic-tag", "synthetic-player.custom.x.a", "--runs", "2"], {}), /requires --runs 1/);
  assert.equal(parseHarnessArgs(["--help"], {}).help, true);
});

test("CLI defaults to dry-run without API config and never touches the network", async () => {
  const lines: string[] = [];
  const result = await runHarnessCli(["--turns", "2", "--personas", "explorer", "--seed", "test"], {}, {
    out: line => lines.push(line),
    err: line => lines.push(`ERR ${line}`),
    fetchImpl: (() => { throw new Error("network disabled"); }) as unknown as typeof fetch,
  });
  assert.equal(result, 0);
  assert.ok(lines.some(line => line.includes("defaulting to --dry-run")));
  assert.ok(lines.some(line => line.includes("synthetic-player.explorer.test.a")));
  assert.ok(lines.some(line => line.includes('"sessionTag": "synthetic-player.explorer.test.a"')));
  assert.ok(!lines.some(line => line.includes("network disabled")));
  assert.ok(!lines.some(line => line.startsWith("ERR ")));
});

test("CLI dry-run forwards the focus flags into the first turn", async () => {
  const lines: string[] = [];
  const result = await runHarnessCli([
    "--turns", "2",
    "--personas", "explorer",
    "--seed", "test",
    "--focus-family", "combat-consumable",
    "--focus-mode", "direct",
  ], {}, {
    out: line => lines.push(line),
    err: line => lines.push(`ERR ${line}`),
    fetchImpl: (() => { throw new Error("network disabled"); }) as unknown as typeof fetch,
  });
  assert.equal(result, 0);
  assert.ok(lines.some(line => line.includes("turn 0 target=combat-consumable/direct")), lines.join("\n"));
  const manifestJson = lines.find(line => line.startsWith("{"));
  assert.ok(manifestJson, "the manifest JSON is printed");
  const manifest = JSON.parse(manifestJson) as HarnessManifest;
  assert.equal(manifest.targetSwaps.length, 1);
  assert.equal(manifest.targetSwaps[0]?.turnIndex, 0);
  assert.deepEqual(manifest.targetSwaps[0]?.to, { family: "combat-consumable", failureMode: "direct" });
  assert.deepEqual(manifest.turns[0]?.plannedTarget, manifest.targetSwaps[0]?.from);
  assert.ok(!lines.some(line => line.startsWith("ERR ")));
});

test("CLI live mode requires campaign, session, and actor ids", async () => {
  const lines: string[] = [];
  const io = {
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
    fetchImpl: (() => { throw new Error("network disabled"); }) as unknown as typeof fetch,
  };
  await assert.rejects(
    () => runHarnessCli(["--turns", "1", "--seed", "test"], { OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "m" }, io),
    /live mode requires --campaign-id, --session-id, --actor-id/,
  );
  assert.ok(lines.every(line => !line.includes("network disabled")));
});

// -------------------------------------------------------------------------------------------------
// Advertisement reader, coverage accounting, and re-targeting
// -------------------------------------------------------------------------------------------------

const TRAVEL_LABEL = "Travel: Market → Harbor";

function travelAdvertisement(): TurnAdvertisementSnapshot {
  return {
    kinds: ["exact_actor_travel.select"],
    families: ["travel"],
    labels: [TRAVEL_LABEL],
    band: "act",
    method: "choice",
    selectedKind: "exact_actor_travel.select",
  };
}

/** Four reachable cells for seed `t204`: the planned order is on-menu / off-menu testable. */
function advertisementTargets(): CoverageTargets {
  const zeros = defaultCoverageTargets(0);
  const matrix = {} as Record<MechanicFamily, Record<FailureMode, number>>;
  for (const family of MECHANIC_FAMILIES) {
    matrix[family] = {} as Record<FailureMode, number>;
    for (const mode of FAILURE_MODES) matrix[family][mode] = zeros[family][mode];
  }
  matrix["combat-consumable"]["unsupported"] = 1;
  matrix["rest"]["direct"] = 1;
  matrix["travel"]["direct"] = 1;
  matrix["travel"]["unadvertised"] = 1;
  return matrix;
}

function advertisementRunInput(overrides: Partial<HarnessSessionInput> = {}): HarnessSessionInput {
  return makeDryRunInput({
    runSeed: "t204",
    turns: 3,
    targets: advertisementTargets(),
    readAdvertisements: () => travelAdvertisement(),
    ...overrides,
  });
}

test("KIND_TO_FAMILY is the exact reverse of FAMILY_TOOL_KINDS", () => {
  for (const family of MECHANIC_FAMILIES) {
    assert.equal(KIND_TO_FAMILY[FAMILY_TOOL_KINDS[family]], family);
  }
  assert.equal(Object.keys(KIND_TO_FAMILY).length, MECHANIC_FAMILIES.length);
  assert.equal(KIND_TO_FAMILY["exact_unknown.select"], undefined);
});

test("parseAdventureDecisionRow dedupes advertised kinds/labels and resolves the selection", () => {
  const requestJson = JSON.stringify({
    state: {
      declaration: "I head to the harbor.",
      candidates: [
        { candidateId: "c1", digest: "d1", kind: "exact_actor_travel.select", label: "Travel: Market → Harbor" },
        { candidateId: "c2", digest: "d2", kind: "exact_rest.select", label: "Rest at the inn" },
        { candidateId: "c3", digest: "d3", kind: "exact_actor_travel.select", label: "Travel: Market → Harbor" },
        { candidateId: "c4", digest: "d4", kind: "exact_unknown.select", label: "Mystery option" },
      ],
    },
    model: "m",
    questions: {},
  });

  const snapshot = parseAdventureDecisionRow({
    requestJson,
    selectionJson: JSON.stringify({ method: "choice", selection: { candidateId: "c2", digest: "d2" } }),
    confidenceBand: "act",
  });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.kinds, ["exact_actor_travel.select", "exact_rest.select", "exact_unknown.select"]);
  assert.deepEqual(snapshot.families, ["travel", "rest"], "unknown kinds contribute no family");
  assert.deepEqual(snapshot.labels, ["Travel: Market → Harbor", "Rest at the inn", "Mystery option"]);
  assert.equal(snapshot.band, "act");
  assert.equal(snapshot.method, "choice");
  assert.equal(snapshot.selectedKind, "exact_rest.select");

  const deferred = parseAdventureDecisionRow({
    requestJson,
    selectionJson: JSON.stringify({ method: "defer", selection: null }),
    confidenceBand: null,
  });
  assert.ok(deferred);
  assert.equal(deferred.method, "defer");
  assert.equal(deferred.selectedKind, null);
  assert.equal(deferred.band, null);

  const unknownPick = parseAdventureDecisionRow({
    requestJson,
    selectionJson: JSON.stringify({ method: "choice", selection: { candidateId: "c9" } }),
    confidenceBand: "fallback",
  });
  assert.ok(unknownPick);
  assert.equal(unknownPick.selectedKind, null);
  assert.equal(unknownPick.band, "fallback");

  assert.equal(parseAdventureDecisionRow({ requestJson: "not json", selectionJson: null, confidenceBand: null }), null);
  assert.equal(parseAdventureDecisionRow({ requestJson: "[1,2]", selectionJson: null, confidenceBand: null }), null);
  assert.equal(parseAdventureDecisionRow({ requestJson: JSON.stringify({ state: {} }), selectionJson: null, confidenceBand: null }), null);
  assert.equal(parseAdventureDecisionRow({ requestJson, selectionJson: "not json", confidenceBand: null }), null);
});

test("readTurnAdvertisements reads the newest adventure-selection row and fails soft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "velvet-advert-"));
  const emptyDir = await mkdtemp(join(tmpdir(), "velvet-advert-empty-"));
  try {
    const database = new DatabaseSync(join(dir, "velvet.sqlite"));
    database.exec(`CREATE TABLE system_one_decisions_v1 (
      decision_id TEXT PRIMARY KEY,
      lane TEXT NOT NULL,
      turn_id TEXT,
      request_json TEXT NOT NULL,
      selection_json TEXT NOT NULL,
      confidence_band TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    const insert = database.prepare(
      "INSERT INTO system_one_decisions_v1 (decision_id, lane, turn_id, request_json, selection_json, confidence_band, created_at) VALUES (?,?,?,?,?,?,?)",
    );
    const rowJson = (candidateId: string, kind: string, label: string): string => JSON.stringify({
      state: { declaration: "I move.", candidates: [{ candidateId, digest: "d", kind, label }] },
      model: "m",
      questions: {},
    });
    insert.run("decision:1", "adventure-selection", "turn-1", rowJson("c1", "exact_rest.select", "Old rest row"), JSON.stringify({ method: "choice", selection: { candidateId: "c1" } }), "act", "2026-01-01T00:00:00.000Z");
    insert.run("decision:2", "adventure-selection", "turn-1", rowJson("c2", "exact_actor_travel.select", "Newer travel row"), JSON.stringify({ method: "defer", selection: null }), "fallback", "2026-01-02T00:00:00.000Z");
    insert.run("decision:3", "adventure-selection", "turn-2", rowJson("c3", "exact_actor_travel.select", "Other turn"), JSON.stringify({ method: "choice", selection: { candidateId: "c3" } }), "act", "2026-01-03T00:00:00.000Z");
    database.close();

    const newest = readTurnAdvertisements(dir, "turn-1");
    assert.ok(newest);
    assert.deepEqual(newest.labels, ["Newer travel row"]);
    assert.deepEqual(newest.families, ["travel"]);
    assert.equal(newest.method, "defer");
    assert.equal(newest.selectedKind, null);
    assert.equal(newest.band, "fallback");

    assert.equal(readTurnAdvertisements(dir, "turn-9"), null, "no row for the turn");
    assert.equal(readTurnAdvertisements(join(dir, "missing"), "turn-1"), null, "missing database file");

    const empty = new DatabaseSync(join(emptyDir, "velvet.sqlite"));
    empty.exec("CREATE TABLE unrelated (x)");
    empty.close();
    assert.equal(readTurnAdvertisements(emptyDir, "turn-1"), null, "missing decisions table");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test("scheduler prefers advertised families, falls back, and release restores capacity", () => {
  const scheduler = new CoverageScheduler({ targets: defaultCoverageTargets(1), persona: PERSONAS.explorer });
  const rng = createRng("advertised");
  for (let index = 0; index < FAILURE_MODES.length; index += 1) {
    const cell = scheduler.next(rng, { advertisedFamilies: ["travel"] });
    assert.ok(cell);
    assert.equal(cell.family, "travel", "prefers a remaining advertised-family cell");
  }
  const fallbackCell = scheduler.next(rng, { advertisedFamilies: ["travel"] });
  assert.ok(fallbackCell);
  assert.notEqual(fallbackCell.family, "travel", "falls back to the global choice when no advertised cell remains");

  const release = new CoverageScheduler({ targets: defaultCoverageTargets(1), persona: PERSONAS.explorer });
  const reserved = release.next(createRng("release"), { advertisedFamilies: ["rest"] });
  assert.ok(reserved);
  assert.equal(release.plannedFor(reserved), 1);
  assert.equal(release.remainingFor(reserved), 0);
  release.release(reserved);
  assert.equal(release.plannedFor(reserved), 0);
  assert.equal(release.remainingFor(reserved), 1, "release restores capacity");
  release.release(reserved);
  assert.equal(release.plannedFor(reserved), 0, "release floors at zero");

  const emptyMenu = new CoverageScheduler({ targets: defaultCoverageTargets(1), persona: PERSONAS.explorer });
  const plain = new CoverageScheduler({ targets: defaultCoverageTargets(1), persona: PERSONAS.explorer });
  assert.deepEqual(
    emptyMenu.next(createRng("deterministic"), { advertisedFamilies: [] }),
    plain.next(createRng("deterministic")),
    "an empty menu keeps the original weighted choice",
  );
});

test("scheduler reserve books a specific cell and release is its floor-zero inverse", () => {
  const scheduler = new CoverageScheduler({ targets: defaultCoverageTargets(1), persona: PERSONAS.explorer });
  const cell: CoverageCell = { family: "combat-consumable", failureMode: "direct" };
  assert.equal(scheduler.plannedFor(cell), 0);
  assert.equal(scheduler.remainingFor(cell), 1);
  scheduler.reserve(cell);
  assert.equal(scheduler.plannedFor(cell), 1);
  assert.equal(scheduler.remainingFor(cell), 0);
  assert.equal(scheduler.hasRemaining(), true, "other cells still have capacity");
  // A forced reservation may exceed the target; release counts back down and floors at zero.
  scheduler.reserve(cell);
  assert.equal(scheduler.plannedFor(cell), 2);
  scheduler.release(cell);
  scheduler.release(cell);
  scheduler.release(cell);
  assert.equal(scheduler.plannedFor(cell), 0, "release floors at zero");
  assert.equal(scheduler.remainingFor(cell), 1, "release restores capacity");

  // While the cell is reserved, weighted planning never books it again.
  scheduler.reserve(cell);
  const rng = createRng("reserve-scan");
  let plannedOthers = 0;
  for (let index = 0; index < COVERAGE_CELL_COUNT; index += 1) {
    const chosen = scheduler.next(rng);
    if (chosen === null) break;
    plannedOthers += 1;
    assert.notDeepEqual(chosen, cell, "a fully reserved cell is never planned again");
  }
  assert.equal(plannedOthers, COVERAGE_CELL_COUNT - 1, "every other cell is planned exactly once");
  assert.equal(scheduler.hasRemaining(), false);
  assert.equal(scheduler.next(rng), null);
});

test("advertised options shape the generator prompt by failure mode", () => {
  const labels = ["Travel: Market → Harbor", "Rest at the inn"];
  const onMenu = buildGeneratorMessages(promptInput({
    target: { family: "travel", failureMode: "ambiguous" },
    advertisedOptions: labels,
  }));
  assert.ok(onMenu.user.includes(
    `The game currently offers these options: ${labels.join(", ")}. Write the declaration in natural player language so it clearly invokes one of them; do not quote this list or mention mechanics.`,
  ));
  assert.ok(!onMenu.user.includes("deliberately off-menu"));

  for (const mode of OFF_MENU_FAILURE_MODES) {
    const offMenu = buildGeneratorMessages(promptInput({
      target: { family: "travel", failureMode: mode },
      advertisedOptions: labels,
    }));
    assert.ok(offMenu.user.includes(`The game currently offers these options: ${labels.join(", ")}.`));
    assert.ok(offMenu.user.includes("This turn is deliberately off-menu: do not clearly invoke any of the listed options."));
    assert.ok(!offMenu.user.includes("clearly invokes one of them"));
  }

  const withoutOptions = buildGeneratorMessages(promptInput());
  assert.ok(!withoutOptions.user.includes("The game currently offers these options:"));
  assert.ok(!withoutOptions.user.includes("deliberately off-menu"));
});

test("advertisement-guided run re-targets toward the menu and counts advertised/acted", async () => {
  const requests: GenerationRequest[] = [];
  const fake = createFakeGenerator();
  const manifest = await runHarnessSession(advertisementRunInput({
    generateTurn: request => {
      requests.push(request);
      return fake(request);
    },
  }));

  assert.equal(manifest.turns.length, 3);
  assert.deepEqual(manifest.turns.map(turn => turn.target), [
    { family: "combat-consumable", failureMode: "unsupported" },
    { family: "travel", failureMode: "direct" },
    { family: "travel", failureMode: "unadvertised" },
  ]);
  assert.equal(manifest.turns[0]?.plannedTarget, undefined, "an on-plan turn carries no pre-swap cell");
  assert.deepEqual(manifest.turns[1]?.plannedTarget, { family: "rest", failureMode: "direct" });
  assert.equal(manifest.turns[1]?.toolKind, FAMILY_TOOL_KINDS.travel);
  assert.deepEqual(manifest.targetSwaps, [{
    turnIndex: 1,
    from: { family: "rest", failureMode: "direct" },
    to: { family: "travel", failureMode: "direct" },
  }]);
  for (const turn of manifest.turns) assert.deepEqual(turn.advertisements, travelAdvertisement());

  assert.equal(manifest.coverage.totals.advertisedTotal, 2);
  assert.equal(manifest.coverage.totals.actedTotal, 2);
  assert.equal(manifest.coverage.advertised.travel.direct, 1);
  assert.equal(manifest.coverage.advertised.travel.unadvertised, 1);
  assert.equal(manifest.coverage.advertised["combat-consumable"].unsupported, 0, "the off-menu probe is not advertised");
  assert.equal(manifest.coverage.acted.travel.direct, 1);
  assert.equal(manifest.coverage.acted.travel.unadvertised, 1);
  assert.equal(manifest.coverage.byFamily.travel.advertised, 2);
  assert.equal(manifest.coverage.byFamily.travel.acted, 2);

  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.target.family, "combat-consumable");
  assert.equal(requests[0]?.advertisedOptions, undefined, "the first turn has no prior menu");
  assert.deepEqual(requests[1]?.advertisedOptions, [TRAVEL_LABEL]);
  assert.ok(requests[1]?.messages.user.includes(
    `The game currently offers these options: ${TRAVEL_LABEL}. Write the declaration in natural player language so it clearly invokes one of them; do not quote this list or mention mechanics.`,
  ));
  assert.deepEqual(requests[2]?.advertisedOptions, [TRAVEL_LABEL]);
  assert.ok(requests[2]?.messages.user.includes("This turn is deliberately off-menu: do not clearly invoke any of the listed options."));
  assert.ok(!(requests[2]?.messages.user.includes("clearly invokes one of them") ?? true));
});

test("advertisement-guided run keeps the planned cell when no advertised cell is reachable", async () => {
  const manifest = await runHarnessSession(advertisementRunInput({
    // `srd-check` has no coverage target in this matrix, so its menu rows are all unreachable.
    readAdvertisements: () => ({
      kinds: ["exact_srd_check.select"],
      families: ["srd-check"],
      labels: ["Investigate the runes"],
      band: "confirm",
      method: "defer",
      selectedKind: null,
    }),
  }));
  assert.deepEqual(manifest.targetSwaps, [], "no reachable advertised cell, so the plan is kept");
  assert.deepEqual(manifest.turns.map(turn => turn.target), [
    { family: "combat-consumable", failureMode: "unsupported" },
    { family: "rest", failureMode: "direct" },
    { family: "travel", failureMode: "unadvertised" },
  ]);
  assert.equal(manifest.turns[1]?.plannedTarget, undefined);
  assert.equal(manifest.coverage.totals.advertisedTotal, 0);
  assert.equal(manifest.coverage.totals.actedTotal, 0, "a defer names no acted family");
});

test("renderManifestSummary includes the advertisement totals", async () => {
  const manifest = await runHarnessSession(advertisementRunInput());
  const summary = renderManifestSummary(manifest);
  assert.ok(summary.some(line => line.includes("advertised: 2/3 (67%)")), summary.join("\n"));
  assert.ok(summary.some(line => line.includes("acted: 2/3 (67%)")), summary.join("\n"));
});

test("menu window defaults to 3 and clamps to the 1..10 range", async () => {
  assert.equal(DEFAULT_MENU_WINDOW, 3);
  assert.equal(normalizeMenuWindow(undefined), 3);
  assert.equal(normalizeMenuWindow(0), 1);
  assert.equal(normalizeMenuWindow(1), 1);
  assert.equal(normalizeMenuWindow(2.9), 2);
  assert.equal(normalizeMenuWindow(99), 10);
  assert.equal(normalizeMenuWindow(Number.NaN), 3);
  assert.equal(normalizeMenuWindow(Number.POSITIVE_INFINITY), 3);

  const defaulted = await runHarnessSession(makeDryRunInput());
  assert.equal(defaulted.menuWindow, 3);
  assert.deepEqual(defaulted.menuUnionFamilies, []);
  const clamped = await runHarnessSession(makeDryRunInput({ menuWindow: 42 }));
  assert.equal(clamped.menuWindow, 10);
});

test("recent-menu union keeps earlier advertised families reachable for re-targeting", async () => {
  // Every family keeps one target per cell except the two unreachable ones used as stale menus.
  const targets = {} as Record<MechanicFamily, Record<FailureMode, number>>;
  for (const family of MECHANIC_FAMILIES) {
    targets[family] = {} as Record<FailureMode, number>;
    for (const mode of FAILURE_MODES) {
      targets[family][mode] = family === "progression" || family === "commerce" ? 0 : 1;
    }
  }
  const runSeed = "menu-union";
  const planned = planRun({ runSeed, persona: PERSONAS.explorer, turns: 3, targets }).turns;
  assert.equal(planned.length, 3);
  const plannedFamilies = new Set(planned.map(turn => turn.target.family));
  // A reachable family outside the plan, advertised on the first turn; the second turn advertises
  // an unreachable family, which alone would strand the third planned cell.
  const advertised = MECHANIC_FAMILIES.find(family =>
    family !== "progression" && family !== "commerce" && !plannedFamilies.has(family));
  if (advertised === undefined) throw new Error("no family outside the plan is available for the recent-menu union");
  const unreachable = planned[2]?.target.family === "progression" ? "commerce" : "progression";
  const menuSnapshot = (family: MechanicFamily): TurnAdvertisementSnapshot => ({
    kinds: [FAMILY_TOOL_KINDS[family]],
    families: [family],
    labels: [`Menu option ${family}`],
    band: "act",
    method: "choice",
    selectedKind: FAMILY_TOOL_KINDS[family],
  });
  const makeReads = () => {
    let reads = 0;
    return () => {
      reads += 1;
      return menuSnapshot(reads === 1 ? advertised : unreachable);
    };
  };

  const requests: GenerationRequest[] = [];
  const fake = createFakeGenerator();
  const wide = await runHarnessSession(makeDryRunInput({
    runSeed,
    turns: 3,
    targets,
    menuWindow: 3,
    readAdvertisements: makeReads(),
    generateTurn: request => {
      requests.push(request);
      return fake(request);
    },
  }));
  const narrow = await runHarnessSession(makeDryRunInput({
    runSeed,
    turns: 3,
    targets,
    menuWindow: 1,
    readAdvertisements: makeReads(),
  }));

  assert.equal(wide.menuWindow, 3);
  assert.deepEqual(wide.menuUnionFamilies, [advertised, unreachable], "oldest advertisement first, deduped");
  assert.deepEqual(narrow.menuUnionFamilies, [unreachable], "window 1 keeps the latest snapshot only");
  assert.equal(narrow.menuWindow, 1);

  // Window 1 sees only the stale unreachable menu on the last turn: the plan is kept.
  assert.deepEqual(narrow.turns[0]?.target, planned[0]?.target);
  assert.equal(narrow.turns[1]?.target.family, advertised, "the first swap still fires");
  assert.deepEqual(narrow.turns[2]?.target, planned[2]?.target);
  assert.equal(narrow.targetSwaps.length, 1);

  // The union reaches back to the advertised family for the third turn as well.
  assert.equal(wide.turns[1]?.target.family, advertised);
  assert.equal(wide.turns[2]?.target.family, advertised);
  assert.notDeepEqual(wide.turns[2]?.target, planned[2]?.target);
  assert.equal(wide.targetSwaps.length, 2);

  // The generator still sees only the latest snapshot's labels, never the stale union.
  assert.deepEqual(requests[2]?.advertisedOptions, [`Menu option ${unreachable}`]);
  const wideSummary = renderManifestSummary(wide);
  assert.ok(wideSummary.some(line => line.includes("menu window: last 3 advertised snapshots")), wideSummary.join("\n"));
  assert.ok(!renderManifestSummary(narrow).some(line => line.includes("menu window:")), "window 1 adds no note");
});

// -------------------------------------------------------------------------------------------------
// Focused coverage
// -------------------------------------------------------------------------------------------------

/** Five target-1 cells whose two-turn plan can miss `combat-consumable/direct`, leaving it room. */
function focusTargets(): CoverageTargets {
  const zeros = defaultCoverageTargets(0);
  const matrix = {} as Record<MechanicFamily, Record<FailureMode, number>>;
  for (const family of MECHANIC_FAMILIES) {
    matrix[family] = {} as Record<FailureMode, number>;
    for (const mode of FAILURE_MODES) matrix[family][mode] = zeros[family][mode];
  }
  matrix["combat-consumable"]["direct"] = 1;
  matrix["rest"]["direct"] = 1;
  matrix["travel"]["direct"] = 1;
  matrix["travel"]["unadvertised"] = 1;
  matrix["inventory"]["ambiguous"] = 1;
  return matrix;
}

test("focus forces the first plan turn onto the requested cell and records the swap", async () => {
  const targets = focusTargets();
  const focusCell: CoverageCell = { family: "combat-consumable", failureMode: "direct" };
  const isFocus = (cell: CoverageCell | undefined): boolean =>
    cell !== undefined && cell.family === focusCell.family && cell.failureMode === focusCell.failureMode;
  let runSeed: string | null = null;
  let original: CoverageCell | null = null;
  let untouchedSecond: CoverageCell | null = null;
  for (let index = 0; index < 64 && runSeed === null; index += 1) {
    const candidate = `focus-${index}`;
    const planned = planRun({ runSeed: candidate, persona: PERSONAS.explorer, turns: 2, targets }).turns;
    const first = planned[0]?.target;
    const second = planned[1]?.target;
    if (first !== undefined && second !== undefined && !isFocus(first) && !isFocus(second)) {
      runSeed = candidate;
      original = { ...first };
      untouchedSecond = { ...second };
    }
  }
  if (runSeed === null || original === null || untouchedSecond === null) {
    throw new Error("no seed found whose two-turn plan misses the focus cell");
  }

  const requests: GenerationRequest[] = [];
  const fake = createFakeGenerator();
  const manifest = await runHarnessSession(makeDryRunInput({
    runSeed,
    turns: 2,
    targets,
    focus: focusCell,
    generateTurn: request => {
      requests.push(request);
      return fake(request);
    },
  }));

  assert.deepEqual(manifest.turns.map(turn => turn.target), [focusCell, untouchedSecond]);
  assert.equal(manifest.turns[0]?.toolKind, FAMILY_TOOL_KINDS["combat-consumable"]);
  assert.deepEqual(manifest.turns[0]?.plannedTarget, original, "the replaced cell is recorded on the turn");
  assert.equal(manifest.turns[1]?.plannedTarget, undefined, "only the first turn is forced");
  assert.deepEqual(manifest.targetSwaps, [{ turnIndex: 0, from: original, to: focusCell }]);
  assert.deepEqual(requests[0]?.target, focusCell, "the generator is asked for the focus cell on turn 0");
  assert.deepEqual(requests[1]?.target, untouchedSecond, "later turns keep the weighted plan");

  // The replaced reservation moves to the focus cell; the plan total is unchanged.
  assert.equal(manifest.coverage.planned[original.family][original.failureMode], 0);
  assert.equal(manifest.coverage.planned[focusCell.family][focusCell.failureMode], 1);
  assert.equal(manifest.coverage.totals.planned, 2);
  assert.ok(!manifest.notes.some(note => note.includes("already fully planned")));
});

test("focus still forces a fully planned cell and notes it", async () => {
  const zeros = defaultCoverageTargets(0);
  const targets = {} as Record<MechanicFamily, Record<FailureMode, number>>;
  for (const family of MECHANIC_FAMILIES) {
    targets[family] = {} as Record<FailureMode, number>;
    for (const mode of FAILURE_MODES) targets[family][mode] = zeros[family][mode];
  }
  targets["combat-consumable"]["direct"] = 1;
  targets["rest"]["direct"] = 1;
  const focusCell: CoverageCell = { family: "combat-consumable", failureMode: "direct" };
  let runSeed: string | null = null;
  for (let index = 0; index < 64 && runSeed === null; index += 1) {
    const candidate = `focus-full-${index}`;
    const first = planRun({ runSeed: candidate, persona: PERSONAS.explorer, turns: 2, targets }).turns[0]?.target;
    if (first !== undefined && first.family !== focusCell.family) runSeed = candidate;
  }
  if (runSeed === null) throw new Error("no seed found whose first turn is not the focus family");

  const manifest = await runHarnessSession(makeDryRunInput({ runSeed, turns: 2, targets, focus: focusCell }));
  assert.deepEqual(manifest.turns[0]?.target, focusCell, "the requested cell wins even when its target is met");
  assert.equal(manifest.targetSwaps.length, 1);
  assert.ok(
    manifest.notes.some(note => note.includes("focus combat-consumable/direct") && note.includes("already fully planned")),
    manifest.notes.join("\n"),
  );
});

test("focus input rejects unknown family and failure-mode values", async () => {
  await assert.rejects(
    () => runHarnessSession(makeDryRunInput({ focus: { family: "wizard" } as unknown as CoverageCell })),
    /focus\.family must be one of/,
  );
  await assert.rejects(
    () => runHarnessSession(makeDryRunInput({ focus: { family: "travel", failureMode: "sometimes" } as unknown as CoverageCell })),
    /focus\.failureMode must be one of/,
  );
});

test("manifest records the content profile when supplied and null when omitted", async () => {
  const omitted = await runHarnessSession(makeDryRunInput());
  assert.equal(omitted.world.contentProfile, null);
  assert.ok(serializeManifest(omitted).includes('"contentProfile": null'));

  const supplied = await runHarnessSession(makeDryRunInput({ contentProfile: "velvet-starter" }));
  assert.equal(supplied.world.contentProfile, "velvet-starter");
  assert.ok(serializeManifest(supplied).includes('"contentProfile": "velvet-starter"'));

  const trimmed = await runHarnessSession(makeDryRunInput({ contentProfile: "  srd-5.1  " }));
  assert.equal(trimmed.world.contentProfile, "srd-5.1");

  const blank = await runHarnessSession(makeDryRunInput({ contentProfile: "   " }));
  assert.equal(blank.world.contentProfile, null, "whitespace-only profile becomes null");
});

// -------------------------------------------------------------------------------------------------
// Human-likeness report
// -------------------------------------------------------------------------------------------------

test("declaration word counts and trigram sets handle empty, identical, and disjoint text", () => {
  assert.equal(declarationWordCount(""), 0);
  assert.equal(declarationWordCount("   "), 0);
  assert.equal(declarationWordCount("  I go   north  "), 3);
  assert.equal(declarationWordCount("One."), 1);

  assert.equal(tokenTrigramSet("").size, 0);
  assert.equal(tokenTrigramSet("Hi there").size, 0, "fewer than three tokens yields no shingles");
  assert.deepEqual([...tokenTrigramSet("Hello, world! Hello")], ["hello world hello"], "lowercase alphanumeric tokens");
  const quick = tokenTrigramSet("the quick brown fox jumps");
  const leaps = tokenTrigramSet("the quick brown fox leaps");
  assert.deepEqual([...quick], ["the quick brown", "quick brown fox", "brown fox jumps"]);
  assert.equal(trigramJaccard(quick, quick), 1, "identical sets are fully similar");
  assert.equal(trigramJaccard(new Set(), new Set()), 0, "two empty sets share nothing");
  assert.equal(trigramJaccard(quick, new Set()), 0);
  assert.equal(trigramJaccard(quick, leaps), 0.5);
  assert.equal(trigramJaccard(quick, tokenTrigramSet("one two three four")), 0, "disjoint sets score zero");
});

test("computeHumanLikeness derives the pre-registered proxies from recorded declarations", () => {
  const long = "I look at the ferry wreck near the old harbor light and I study the broken mast and the torn sail and the empty pier and the cold water before dark";
  const nearLong = "I look at the ferry wreck near the old harbor light and I study the broken mast and the torn sail and the empty pier";
  const report = computeHumanLikeness([
    humanLikenessTurn({ turnIndex: 0, declaration: "I go north", noiseApplied: ["typo"] }),
    humanLikenessTurn({ turnIndex: 1, declaration: "I go north" }),
    humanLikenessTurn({ turnIndex: 2, declaration: "I ask about the boat and then I wait?", failureMode: "multi-family", ooc: "Can I still make it?" }),
    humanLikenessTurn({ turnIndex: 3, declaration: long, failureMode: "unadvertised", noiseApplied: ["lowercase"] }),
    humanLikenessTurn({ turnIndex: 4, declaration: nearLong, failureMode: "literal-edge" }),
  ]);
  assert.equal(report.turns, 5);
  assert.equal(report.medianWords, 9);
  assert.equal(report.p90Words, 28.6);
  assert.equal(report.lowEffortShare, 0.4);
  assert.equal(report.longShare, 0.2);
  assert.equal(report.burstiness, 0.819);
  assert.equal(report.distinct1, 0.408);
  assert.equal(report.distinct2, 0.576);
  assert.equal(report.nearDuplicateShare, 0.4, "the verbatim repeat and the long prefix both count");
  assert.equal(report.verbatimReuses, 1);
  assert.equal(report.oocShare, 0.2);
  assert.equal(report.questionShare, 0.2);
  assert.equal(report.noiseShare, 0.4);
  assert.equal(report.mixedIntentShare, 0.6);
  assert.equal(report.offMenuShare, 0.4);

  assert.deepEqual(computeHumanLikeness([]), {
    turns: 0,
    medianWords: 0,
    p90Words: 0,
    lowEffortShare: 0,
    longShare: 0,
    burstiness: 0,
    distinct1: 0,
    distinct2: 0,
    nearDuplicateShare: 0,
    verbatimReuses: 0,
    topRepeatedPhrases: [],
    repeatedPhraseTurns: 0,
    oocShare: 0,
    questionShare: 0,
    noiseShare: 0,
    mixedIntentShare: 0,
    offMenuShare: 0,
  });
});

test("tokenQuadgramSet extracts lowercase phrases and drops stopword-only shingles", () => {
  assert.equal(tokenQuadgramSet("").size, 0);
  assert.equal(tokenQuadgramSet("one two three").size, 0, "fewer than four tokens yields no shingles");
  assert.deepEqual(
    [...tokenQuadgramSet("Hello, world! Hello there friend")],
    ["hello world hello there", "world hello there friend"],
    "lowercase alphanumeric tokens",
  );
  assert.equal(tokenQuadgramSet("it is in the").size, 0, "a shingle made only of stopwords is dropped");
  const stopwordOnly = [...PHRASE_STOPWORDS].slice(0, 4).join(" ");
  assert.equal(tokenQuadgramSet(stopwordOnly).size, 0, "the built-in stopword set filters its own shingles");
  const mixed = tokenQuadgramSet("the smoke on the water");
  assert.deepEqual([...mixed], ["the smoke on the", "smoke on the water"], "one content word keeps a shingle");
});

test("computeHumanLikeness surfaces repeated 4-gram motifs across turns", () => {
  const report = computeHumanLikeness([
    humanLikenessTurn({ turnIndex: 0, declaration: "I tally my pack and head north at dawn" }),
    humanLikenessTurn({ turnIndex: 1, declaration: "I tally my pack and wait for the fog" }),
    humanLikenessTurn({ turnIndex: 2, declaration: "I tally my pack before the storm rolls in" }),
    humanLikenessTurn({ turnIndex: 3, declaration: "The water is cold and the wind is loud" }),
  ]);
  assert.deepEqual(report.topRepeatedPhrases, [
    { phrase: "i tally my pack", count: 3 },
    { phrase: "tally my pack and", count: 2 },
  ]);
  assert.equal(report.repeatedPhraseTurns, 3, "turns 0-2 carry the motif; turn 3 does not");
  assert.equal(report.verbatimReuses, 0);
});

test("topRepeatedPhrases ranks by turn count, breaks ties alphabetically, and caps at five", () => {
  const chain = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  const report = computeHumanLikeness([
    humanLikenessTurn({ turnIndex: 0, declaration: chain }),
    humanLikenessTurn({ turnIndex: 1, declaration: chain }),
  ]);
  assert.equal(MAX_REPEATED_PHRASES, 5);
  assert.equal(report.topRepeatedPhrases.length, 5, "seven repeated phrases are capped at five");
  assert.deepEqual(report.topRepeatedPhrases, [
    { phrase: "alpha bravo charlie delta", count: 2 },
    { phrase: "bravo charlie delta echo", count: 2 },
    { phrase: "charlie delta echo foxtrot", count: 2 },
    { phrase: "delta echo foxtrot golf", count: 2 },
    { phrase: "echo foxtrot golf hotel", count: 2 },
  ]);
  assert.equal(report.repeatedPhraseTurns, 2);
});

test("stopword-only repeats do not register as motifs", () => {
  const report = computeHumanLikeness([
    humanLikenessTurn({ turnIndex: 0, declaration: "it is in the" }),
    humanLikenessTurn({ turnIndex: 1, declaration: "it is in the" }),
  ]);
  assert.deepEqual(report.topRepeatedPhrases, []);
  assert.equal(report.repeatedPhraseTurns, 0);
  assert.equal(report.verbatimReuses, 1, "the verbatim metric still sees the reuse");
});

test("runs record the human-likeness report and print the near-duplicate share", async () => {
  const manifest = await runHarnessSession(makeDryRunInput());
  assert.equal(manifest.humanLikeness.turns, 3);
  assert.equal(manifest.humanLikeness.turns, manifest.turns.length);
  const summary = renderManifestSummary(manifest);
  const block = summary.filter(line => line.includes("human-likeness:") || line.includes("near-duplicate share"));
  assert.equal(block.length, 2, "the human-likeness block stays within three lines");
  assert.ok(summary.some(line => line.includes("near-duplicate share")), summary.join("\n"));
});

test("renderManifestSummary prints repeated motifs only when present", async () => {
  const manifest = await runHarnessSession(makeDryRunInput());
  const human: HumanLikenessReport = {
    ...manifest.humanLikeness,
    topRepeatedPhrases: [
      { phrase: "smoke on the water", count: 3 },
      { phrase: "waystone sword forms", count: 2 },
    ],
    repeatedPhraseTurns: 2,
  };
  const withMotifs = renderManifestSummary({ ...manifest, humanLikeness: human });
  assert.ok(
    withMotifs.some(line => line.includes('repeated motifs: "smoke on the water" x3, "waystone sword forms" x2')),
    withMotifs.join("\n"),
  );
  const clean = renderManifestSummary({
    ...manifest,
    humanLikeness: { ...human, topRepeatedPhrases: [], repeatedPhraseTurns: 0 },
  });
  assert.ok(!clean.some(line => line.includes("repeated motifs")), "an empty phrase list prints no line");
});

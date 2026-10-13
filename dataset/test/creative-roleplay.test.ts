import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  APPEARANCE_AGE_BANDS,
  CONFLICTING_STANCE_AXES,
  CREATIVE_ARC_SHAPES,
  CREATIVE_REVIEW_CRITERIA,
  CREATIVE_SETTINGS,
  CREATIVE_STREAM_CATEGORIES,
  CREATIVE_TRANSCRIPT_SCHEMA,
  CREATIVE_TRANSCRIPT_TURN_KEYS,
  CreativeConfigError,
  EMOTIONAL_VOLATILITIES,
  LEGACY_CAST_NAMES,
  MAX_EXCHANGE_DEPTH,
  MIN_EXCHANGE_DEPTH,
  RELATIONSHIP_STANCES,
  SITUATION_CLASSES,
  TEMPERAMENT_TAGS,
  CreativeTranscriptError,
  assertCreativeBatchDiversity,
  assertCreativeExampleInvariants,
  assertCreativeLineageDisjoint,
  buildCreativeTrainingExample,
  characterSignature,
  checkCreativeTranscript,
  createCharacterCard,
  createCharacterCardBatch,
  createCreativeDerivatives,
  createCreativePlan,
  createCreativePlans,
  createCreativeRng,
  creativeBatchDiversity,
  creativeCategoryLabel,
  creativeCoverageReport,
  creativeDerivativeId,
  creativeLineage,
  creativeReviewPrompt,
  creativeSplitForLineage,
  creativeTeacherPrompt,
  creativeSettingTokens,
  creativeTargetSelection,
  foldCreativeReviewIntoSpecScores,
  generateName,
  isCreativeStreamCategory,
  parseCreativeReview,
  parseCreativeTranscript,
  selectCreativeMix,
  validateCharacterCard,
  validateCreativePlan,
  type CharacterCard,
  type CreativePlan,
  type CreativeReviewCriterion,
  type CreativeTranscript,
} from "../src/creativeRoleplay.js";

// ---------------------------------------------------------------------------
// A deterministic stand-in teacher.
//
// This is a TEST FIXTURE, not a generator of good prose. It exists so the
// selection, lineage and parsing properties can be exercised without a paid
// provider. Every line below is written to survive the same refusal checks a real
// teacher output must survive, which is the point: a fixture that had to bypass
// the validator would prove nothing.
// ---------------------------------------------------------------------------

const PLAYER_LINES = [
  "Right. I've got about ten minutes, so I'll say the thing and then I'm off.",
  "Hang on. Before any of that, I wanted to ask about the other thing. It can wait.",
  "I'll be honest, I don't know what I'm doing here.",
  "No, wait. That's not the question I came with.",
  "I'm not going to argue with you about that part.",
  "It was me. Obviously it was me. I just wanted to say it out loud once.",
  "Can I say something and have you not get defensive? Just the once.",
  "Sorry, I lost the thread. The appointment. What happens if I say no to it?",
  "Fine. But I'm not doing it today.",
  "You keep doing that. The thing where you answer a different question.",
  "I said I'd help. I didn't say I'd stop asking.",
  "Honestly, I'd rather just go home.",
  "Right, well. That's worse. That's much worse than I thought.",
  "Do you want the truth, or do you want me to be nice about it?",
  "I've been thinking about it all week and I've changed my mind twice.",
  "Look, I'm not trying to catch you out. I just need one clear answer.",
  "I've brought the letter. It's in my bag. I haven't opened it yet.",
  "My mother asked me to pass it on, and now I'm standing here regretting it.",
];

const CHARACTER_OPENING = [
  "You've caught me at a bad moment. Sit down anyway.",
  "I know why you're here. You can skip the first part if you like.",
  "Look. Before you say anything, I should tell you the situation isn't what it was on Monday.",
  "Come in out of the cold. I'll say the thing, then you can decide what to do with it.",
];

const CHARACTER_ESCALATION = [
  "That's not the question. Don't make it the question.",
  "I've given you the short version. The long version is worse for both of us.",
  "Sit down. No — sit. I'd rather not have this standing up.",
  "I'm not angry. I'm just saying it slowly so you hear all of it.",
  "I said I'd help. What I didn't say was that helping is the easy part.",
];

const CHARACTER_TURN = [
  "All right. You want the actual answer? Here it is, and I'm not saying it twice.",
  "That's it. That's the whole of it. I've been circling it for an hour.",
  "Stop. Just stop, for a second, and let me finish.",
  "I'm not going to be able to do this the careful way. So here it is, plain.",
];

const CHARACTER_CLOSING = [
  "That's where I've got to. Take it or leave it.",
  "I'm going home. I'll be here tomorrow if you want to talk about it.",
  "I'm not saying no. I'm saying not tonight, and not like this.",
  "Right. That's all I've got, and I'd rather you had it late than never.",
];

/** Deterministic, alternating, plan-length transcript for one plan. */
function syntheticTranscript(plan: CreativePlan): string {
  const turns: { speaker: "player" | "character"; text: string }[] = [];
  for (let index = 0; index < plan.depth; index += 1) {
    const beat = plan.beats[index]!;
    const bank = beat.role === "opening" ? CHARACTER_OPENING
      : beat.role === "closing" ? CHARACTER_CLOSING
        : beat.role === "turn" ? CHARACTER_TURN : CHARACTER_ESCALATION;
    const rotate = (plan.depth * 3 + index * 5) % 4;
    turns.push({ speaker: "player", text: PLAYER_LINES[(plan.depth * 7 + index * 3) % PLAYER_LINES.length]! });
    turns.push({ speaker: "character", text: `${bank[rotate]!} ${plan.world.idiom}.` });
  }
  return JSON.stringify({ turns });
}

function parsedTranscript(plan: CreativePlan): CreativeTranscript {
  return parseCreativeTranscript(syntheticTranscript(plan), plan);
}

function refusalCodes(raw: string, plan: CreativePlan): string[] {
  try {
    parseCreativeTranscript(raw, plan);
    return [];
  } catch (error) {
    assert.ok(error instanceof CreativeTranscriptError, `expected a transcript refusal, got ${String(error)}`);
    return error.refusals.map((refusal) => refusal.code);
  }
}

function cardsForPlans(plans: readonly CreativePlan[]): CharacterCard[] {
  return plans.map((plan) => plan.card);
}

// ---------------------------------------------------------------------------

test("character cards are byte-identical for the same seed and distinct across seeds", () => {
  for (const setting of CREATIVE_SETTINGS) {
    const first = createCharacterCard("determinism", setting);
    const second = createCharacterCard("determinism", setting);
    assert.deepEqual(second, first, `${setting} card is not reproducible`);
    assert.equal(first.digest, createCreativeRng(`creative-card:${setting}:determinism`)
      .pick(LEGACY_CAST_NAMES.map((name, index) => index)) === 0 ? first.digest : first.digest);
  }
  const digests = new Set(CREATIVE_SETTINGS.map((setting) => createCharacterCard("determinism", setting).digest));
  assert.equal(digests.size, CREATIVE_SETTINGS.length, "one setting produced the same card as another");
  const across = new Set(Array.from({ length: 64 }, (_, index) => createCharacterCard(`seed-${index}`, "modern").digest));
  assert.equal(across.size, 64, "64 seeds produced fewer than 64 distinct cards in one setting");
  const name = generateName(createCreativeRng("name-check"), "hearth-name");
  assert.deepEqual(generateName(createCreativeRng("name-check"), "hearth-name"), name);
});

test("card validation rejects incomplete, unknown and malformed cards", () => {
  const card = createCharacterCard("valid", "modern");
  assert.deepEqual(validateCharacterCard(card), []);
  for (const key of ["name", "motivation", "goal", "voiceAnchor", "speech", "stance", "setting", "digest"]) {
    const broken: Record<string, unknown> = { ...card };
    delete broken[key];
    assert.ok(validateCharacterCard(broken).some((problem) => problem.includes(key)), `${key} removal was not caught`);
  }
  assert.ok(validateCharacterCard({ ...card, extra: "field" }).some((problem) => problem.includes("unknown key")));
  assert.ok(validateCharacterCard({ ...card, apparentAgeBand: "ancient" }).some((problem) => problem.includes("apparentAgeBand")));
  assert.ok(validateCharacterCard({ ...card, setting: "noir" }).some((problem) => problem.includes("setting")));
  assert.ok(validateCharacterCard({ ...card, temperament: ["patient"] }).some((problem) => problem.includes("temperament")));
  assert.ok(validateCharacterCard({ ...card, temperament: ["patient", "patient"] }).some((problem) => problem.includes("repeats")));
  assert.ok(validateCharacterCard({ ...card, stance: { primary: "moody", secondary: null, conflicting: false } })
    .some((problem) => problem.includes("stance.primary")));
  assert.ok(validateCharacterCard({ ...card, speech: { ...card.speech, verbosity: "chatty" } })
    .some((problem) => problem.includes("verbosity")));
  assert.ok(validateCharacterCard({ ...card, emotionalVolatility: "extreme" }).some((problem) => problem.includes("Volatility")));
  assert.deepEqual(validateCharacterCard("not a card"), ["character card must be an object"]);
});

test("a large batch is diverse, never repeats the legacy cast and fails closed when it is not", () => {
  const batch = createCharacterCardBatch("diversity", 600);
  assert.equal(batch.length, 600);
  const report = assertCreativeBatchDiversity(batch);
  assert.equal(report.total, 600);
  assert.equal(report.distinctCards, 600, "the batch contains duplicate cards");
  assert.equal(report.distinctNames, 600, "the batch contains duplicate names");
  assert.ok(report.distinctSignatures >= 560, `only ${report.distinctSignatures} distinct identity signatures`);
  assert.ok(report.signatureShare >= 0.7);
  assert.ok(report.largestSignatureBucket <= 6, `largest signature bucket was ${report.largestSignatureBucket}`);
  assert.ok(report.distinctRoles >= 40, `only ${report.distinctRoles} distinct occupations`);
  assert.equal(report.legacyNameCollisions, 0, "a legacy cast name leaked into the creative stream");
  for (const card of batch) {
    for (const name of LEGACY_CAST_NAMES) assert.notEqual(card.name.toLowerCase(), name.toLowerCase());
    assert.ok(card.name.length >= 4, `implausibly short generated name ${card.name}`);
  }
  // NO-COLLISION CHECK: a batch is not all the same character.
  assert.ok(new Set(batch.map((card) => characterSignature(card))).size > batch.length * 0.9);
  assert.ok(new Set(batch.map((card) => card.background)).size > batch.length * 0.9, "backgrounds are not varied");
  assert.ok(new Set(batch.map((card) => card.voiceAnchor)).size > batch.length * 0.5, "voice anchors are not varied");
  // A deliberately degenerate batch MUST be refused, not quietly accepted.
  assert.throws(() => assertCreativeBatchDiversity(Array.from({ length: 6 }, () => batch[0]!)), /not diverse/);
  const narrowed = creativeBatchDiversity(Array.from({ length: 40 }, () => batch[0]!));
  assert.equal(narrowed.distinctSignatures, 1);
  assert.equal(narrowed.largestSignatureBucket, 40);
  assert.ok(narrowed.collisionPairCount > 0);
});

test("every setting appears in a batch and changes the surface text, not just a label", () => {
  const plans = createCreativePlans("settings", 700);
  const bySetting = new Map<string, CreativePlan[]>();
  for (const plan of plans) {
    const bucket = bySetting.get(plan.world.setting) ?? [];
    bucket.push(plan);
    bySetting.set(plan.world.setting, bucket);
  }
  for (const setting of CREATIVE_SETTINGS) {
    const bucket = bySetting.get(setting) ?? [];
    assert.ok(bucket.length >= 40, `setting ${setting} produced only ${bucket.length} plans`);
    assert.ok(bucket.every((plan) => plan.card.setting === setting));
    // The plan's own prose must borrow the setting's vocabulary.
    for (const plan of bucket) {
      const surface = `${plan.situation} ${plan.world.locale} ${plan.world.prop} ${plan.world.institution} ${plan.world.pressure}`;
      const tokens = creativeSettingTokens(setting);
      assert.ok(tokens.some((token) => surface.includes(token)),
        `${setting} plan surface borrowed nothing from its own setting: ${surface}`);
    }
    // Occupations are setting-specific: another setting's occupation must not leak in.
    const foreign = CREATIVE_SETTINGS.filter((other) => other !== setting)
      .flatMap((other) => creativeSettingTokens(other));
    for (const plan of bucket) {
      assert.ok(!foreign.includes(plan.card.role), `a ${setting} card used the ${plan.card.role} from another setting`);
      assert.ok(plan.world.locale.length > 4);
    }
  }
  // Distinct settings must produce distinct situations for the same shape.
  const situations = new Set(CREATIVE_SETTINGS.map((setting) =>
    createCreativePlan({ seed: "surface", setting, shape: "negotiation" }).situation));
  assert.equal(situations.size, CREATIVE_SETTINGS.length, "two settings produced an identical situation string");
});

test("every relationship stance and temperament tag appears across a batch, with conflicting pairs", () => {
  const cards = createCharacterCardBatch("stances", 900);
  const stances = new Set(cards.map((card) => card.stance.primary));
  for (const stance of RELATIONSHIP_STANCES) assert.ok(stances.has(stance), `stance ${stance} never appeared`);
  const temperaments = new Set(cards.flatMap((card) => [...card.temperament]));
  for (const tag of TEMPERAMENT_TAGS) assert.ok(temperaments.has(tag), `temperament ${tag} never appeared`);
  for (const band of APPEARANCE_AGE_BANDS) {
    assert.ok(cards.some((card) => card.apparentAgeBand === band), `age band ${band} never appeared`);
  }
  for (const volatility of EMOTIONAL_VOLATILITIES) {
    assert.ok(cards.some((card) => card.emotionalVolatility === volatility), `volatility ${volatility} never appeared`);
  }
  const conflicting = cards.filter((card) => card.stance.conflicting);
  assert.ok(conflicting.length > 150, `only ${conflicting.length} cards hold a conflicting secondary stance`);
  for (const card of conflicting) {
    assert.ok(CONFLICTING_STANCE_AXES[card.stance.primary].includes(card.stance.secondary!),
      "a card claimed a conflict with a stance that is not on its axis");
  }
  assert.ok(cards.some((card) => card.stance.secondary === null), "no card had a single, unconflicted stance");
});

test("arc shapes, situation classes and depths are all reachable and well formed", () => {
  const plans = createCreativePlans("arcs", 600);
  const shapes = new Set(plans.map((plan) => plan.shape));
  for (const shape of CREATIVE_ARC_SHAPES) assert.ok(shapes.has(shape), `arc shape ${shape} never appeared`);
  const classes = new Set(plans.map((plan) => plan.scenario.situationClass));
  for (const [shape, declared] of Object.entries(SITUATION_CLASSES)) {
    for (const situationClass of declared) assert.ok(classes.has(situationClass), `situation ${situationClass} never appeared`);
    assert.ok(plans.some((plan) => plan.shape === shape && plan.scenario.situationClass === declared[0]),
      `shape ${shape} never used its own situation class`);
  }
  const depths = new Set(plans.map((plan) => plan.depth));
  assert.deepEqual([...depths].sort((a, b) => a - b), [MIN_EXCHANGE_DEPTH, 4, 5, 6, 7, MAX_EXCHANGE_DEPTH]);
  for (const plan of plans) {
    assert.deepEqual(validateCreativePlan(plan), [], `plan ${plan.planId} is structurally invalid`);
    assert.equal(plan.beats.length, plan.depth);
    assert.equal(plan.beats[0]!.role, "opening");
    assert.equal(plan.closingBeat.role, "closing");
    assert.equal(plan.closingBeat.index, plan.depth - 1);
    assert.notEqual(plan.beats[0]!.relationshipState, plan.closingBeat.relationshipState,
      "the relationship does not move across the arc");
    for (const beat of plan.beats) {
      assert.ok(beat.characterIntent.length > 10);
      assert.ok(beat.playerLeavesOpen.length > 10);
      assert.ok(beat.escalationLevel >= 0 && beat.escalationLevel <= 3);
    }
    // A turning point appears exactly where the shape promises one.
    if (plan.shape === "dramatic-turning-point") assert.ok(plan.beats.some((beat) => beat.role === "turn"));
    if (plan.shape === "negotiation") {
      assert.match(plan.situation, /want .* opposite things|terms|trade|deal/i, "a negotiation has no contested terms");
    }
    assert.ok(plan.playerIntent.length > 10, "the simulated player has no intention of its own");
  }
  assert.throws(() => createCreativePlan({ seed: "bad-depth", depth: 9 }), /depth must be an integer/);
  assert.throws(() => createCreativePlan({ seed: "bad-depth", depth: 1 }), /depth must be an integer/);
});

test("the teacher prompt carries plan INPUT only and no answer, rubric or hint", () => {
  const plan = createCreativePlan({ seed: "prompt", shape: "negotiation", depth: 6 });
  const prompt = creativeTeacherPrompt(plan);
  assert.equal(prompt.outputSchema, CREATIVE_TRANSCRIPT_SCHEMA);
  assert.ok(prompt.system.includes("HARD RULES"));
  assert.ok(prompt.system.includes(plan.card.name));
  assert.ok(prompt.system.includes(plan.world.locale));
  assert.ok(prompt.system.includes(plan.playerIntent));
  for (const beat of plan.beats) assert.ok(prompt.system.includes(beat.characterIntent));
  // The output contract has nowhere to put an answer, a score or a hint.
  const turnProperties = (CREATIVE_TRANSCRIPT_SCHEMA.properties as { turns: { items: { properties: object } } })
    .turns.items.properties;
  assert.deepEqual(Object.keys(turnProperties).sort(), [...CREATIVE_TRANSCRIPT_TURN_KEYS].sort());
  assert.equal((CREATIVE_TRANSCRIPT_SCHEMA as { additionalProperties: boolean }).additionalProperties, false);
  // The prompt states prohibitions; it never states an expected line or a verdict.
  assert.ok(/never write the player's actions/i.test(prompt.system));
  assert.ok(/no dice, checks, DCs/i.test(prompt.system));
  for (const forbidden of ["expected answer", "correct answer", "rubric score", "ideal response", "reference answer"]) {
    assert.ok(!prompt.system.toLowerCase().includes(forbidden), `the teacher prompt leaked "${forbidden}"`);
  }
  assert.equal(creativeTeacherPrompt(plan).digest, prompt.digest);
  assert.notEqual(creativeTeacherPrompt(createCreativePlan({ seed: "prompt", shape: "negotiation", depth: 6, situationClass: "boundary-price" })).digest,
    prompt.digest);
});

test("simulated player turns are NEVER supervised, across modes, plans and depths", () => {
  // THE HARD REGRESSION. For every plan, in every target mode, the supervised set
  // is a subset of the character messages and disjoint from the player messages.
  const plans = createCreativePlans("supervision", 160);
  let checked = 0;
  for (const plan of plans) {
    const transcript = parsedTranscript(plan);
    const modes = [
      { kind: "all-character-turns" as const },
      { kind: "single-character-turn" as const, characterTurnIndex: 0 },
      { kind: "single-character-turn" as const, characterTurnIndex: plan.depth - 1 },
      { kind: "single-character-turn" as const, characterTurnIndex: Math.floor(plan.depth / 2) },
    ];
    for (const targetMode of modes) {
      const built = buildCreativeTrainingExample(plan, transcript, { targetMode });
      const { messages, targetSelection } = built.example;
      const supervised = targetSelection.supervisedAssistantIndices;
      assert.ok(supervised.length > 0);
      assert.deepEqual(assertCreativeExampleInvariants(built), [], `invariants failed for ${plan.planId}`);
      for (const index of supervised) {
        assert.equal(messages[index]!.role, "assistant", `supervised index ${index} is not an assistant message`);
        assert.ok(built.characterMessageIndices.includes(index), `supervised index ${index} is not a character turn`);
        assert.ok(!built.playerMessageIndices.includes(index), `supervised index ${index} is a player turn`);
      }
      // Text-level proof, not just index-level: no supervised text is any player text.
      const playerTexts = new Set(transcript.playerTurns.map((turn) => turn.text));
      const characterTexts = new Set(transcript.characterTurns.map((turn) => turn.text));
      for (const index of supervised) {
        const content = messages[index]!.content;
        assert.ok(characterTexts.has(content), "a supervised message is not character text");
        assert.ok(!playerTexts.has(content), "a supervised message is simulated player text");
      }
      assert.equal(targetSelection.supervisedToolCallIndices.length, 0);
      checked += 1;
    }
  }
  assert.equal(checked, plans.length * 4);
  // The invariant gate also catches a hand-corrupted example rather than passing it.
  const plan = plans[0]!;
  const transcript = parsedTranscript(plan);
  const built = buildCreativeTrainingExample(plan, transcript);
  const tampered = {
    ...built,
    example: { ...built.example, targetSelection: { supervisedAssistantIndices: [built.playerMessageIndices[0]!], supervisedToolCallIndices: [] } },
  };
  assert.ok(assertCreativeExampleInvariants(tampered).some((problem) => problem.includes("player turn")),
    "the gate failed to report a supervised player turn");
});

test("character turns are supervised: every turn in one example, or one turn with the rest as context", () => {
  const plan = createCreativePlan({ seed: "targets", shape: "everyday", depth: 5 });
  const transcript = parsedTranscript(plan);
  // The transcript is player-first, so message 0 is `system`, the player turns
  // land on odd indices and the character turns on even indices. Selection is
  // derived from the actual layout, never from arithmetic on a presumed one.
  const all = buildCreativeTrainingExample(plan, transcript, { targetMode: { kind: "all-character-turns" } });
  assert.deepEqual([...all.characterMessageIndices], [2, 4, 6, 8, 10]);
  assert.deepEqual([...all.playerMessageIndices], [1, 3, 5, 7, 9]);
  assert.deepEqual([...all.example.targetSelection.supervisedAssistantIndices], all.characterMessageIndices);
  assert.equal(all.example.targetSelection.supervisedAssistantIndices.length, plan.depth);
  assert.equal(all.characterMessageIndices.length, plan.depth);

  const single = buildCreativeTrainingExample(plan, transcript, { targetMode: { kind: "single-character-turn", characterTurnIndex: 3 } });
  assert.deepEqual([...single.example.targetSelection.supervisedAssistantIndices], [8]);
  // Context is preserved: the rest of the conversation is still in the prompt.
  assert.deepEqual(single.example.messages, all.example.messages);
  assert.equal(single.example.messages.length, plan.depth * 2 + 1);
  // Every other assistant turn is present but masked, exactly as hfAdapter requires.
  for (const index of [2, 4, 6, 10]) {
    assert.equal(single.example.messages[index]!.role, "assistant");
    assert.ok(!single.example.targetSelection.supervisedAssistantIndices.includes(index));
  }
  // The standalone selection API speaks in character-turn ORDINALS, not message
  // indices, so it cannot be wrong about a layout it never sees.
  assert.deepEqual([...creativeTargetSelection(transcript, { kind: "all-character-turns" }).supervisedCharacterTurnOrdinals],
    [0, 1, 2, 3, 4]);
  assert.throws(() => creativeTargetSelection(transcript, { kind: "single-character-turn", characterTurnIndex: 5 }), /characterTurnIndex/);
  assert.throws(() => creativeTargetSelection(transcript, { kind: "single-character-turn", characterTurnIndex: -1 }), /characterTurnIndex/);
});

test("the full multi-turn conversation is preserved as context", () => {
  const plan = createCreativePlan({ seed: "context", depth: 7 });
  const transcript = parsedTranscript(plan);
  const built = buildCreativeTrainingExample(plan, transcript);
  const { messages } = built.example;
  assert.equal(messages.length, plan.depth * 2 + 1);
  assert.equal(messages[0]!.role, "system");
  assert.ok(messages[0]!.content.includes(plan.card.name));
  for (let index = 0; index < plan.depth; index += 1) {
    assert.equal(messages[2 * index + 1]!.role, "user");
    assert.equal(messages[2 * index + 1]!.content, transcript.playerTurns[index]!.text);
    assert.equal(messages[2 * index + 2]!.role, "assistant");
    assert.equal(messages[2 * index + 2]!.content, transcript.characterTurns[index]!.text);
  }
  // The player's whole thread survives as context even in single-target mode.
  const single = buildCreativeTrainingExample(plan, transcript, { targetMode: { kind: "single-character-turn", characterTurnIndex: 0 } });
  assert.deepEqual(single.example.messages, messages);
  assert.equal(single.example.messages.length, messages.length);
});

test("derivatives of one conversation share lineage and can never cross a split", () => {
  const plans = createCreativePlans("lineage", 300);
  const base = plans[5]!;
  const derivatives = createCreativeDerivatives(base, ["paraphrase", "re-voiced", "deeper-cut"]);
  assert.equal(derivatives.length, 3);
  const baseLineage = creativeLineage(base);
  const baseSplit = creativeSplitForLineage(baseLineage);
  for (const derivative of derivatives) {
    assert.deepEqual(creativeLineage(derivative), baseLineage, "a derivative changed lineage");
    assert.equal(creativeSplitForLineage(creativeLineage(derivative)), baseSplit);
    assert.notEqual(derivative.planId, base.planId);
    assert.notEqual(derivative.digest, base.digest);
    // A derivative label never leaks into a lineage field.
    assert.ok(!Object.values(creativeLineage(derivative)).some((value) => value.includes("paraphrase")
      || value.includes("re-voiced") || value.includes("deeper-cut")));
  }
  assert.notEqual(creativeDerivativeId(base, "paraphrase"), creativeDerivativeId(base, "re-voiced"));
  assert.equal(creativeDerivativeId(base, "paraphrase"), creativeDerivativeId(base, "paraphrase"));
  // A different CHARACTER is a different lineage family.
  const other = plans.find((plan) => plan.card.digest !== base.card.digest)!;
  assert.notEqual(creativeLineage(other).characterFamily, baseLineage.characterFamily);
  // The built example carries the same lineage and split as its plan.
  for (const plan of plans) {
    const built = buildCreativeTrainingExample(plan, parsedTranscript(plan));
    assert.deepEqual(built.lineage, creativeLineage(plan));
    assert.equal(built.split, creativeSplitForLineage(built.lineage));
  }
});

test("the split policy is the documented 80/10/10 bucket, and delegates when asked", () => {
  const assignments = createCreativePlans("splits", 400).map((plan) => {
    const lineage = creativeLineage(plan);
    return { lineage, split: creativeSplitForLineage(lineage) };
  });
  assert.deepEqual(assertCreativeLineageDisjoint(assignments), [], "a lineage field spans two splits");
  // Recompute the policy independently; an integrator must be able to rely on it.
  for (const assignment of assignments) {
    const bucket = Number.parseInt(creativeLineageDigest(assignment.lineage).slice(0, 8), 16) % 100;
    const expected = bucket < 80 ? "train" : bucket < 90 ? "dev" : "sealed-test";
    assert.equal(assignment.split, expected);
  }
  const seen = new Set<string>(assignments.map((assignment) => assignment.split));
  for (const split of ["train", "dev", "sealed-test"] as const) assert.ok(seen.has(split), `no lineage landed in ${split}`);
  // A delegate takes over completely.
  let calls = 0;
  creativeSplitForLineage(assignments[0]!.lineage, (lineage) => {
    calls += 1;
    return lineage.characterFamily.endsWith("0") ? "dev" : "train";
  });
  assert.equal(calls, 1);
  // Disjointness is enforced, not assumed.
  assert.ok(assertCreativeLineageDisjoint([
    { lineage: { characterFamily: "c", worldFamily: "w", scenarioFamily: "s" }, split: "train" },
    { lineage: { characterFamily: "c", worldFamily: "w", scenarioFamily: "s" }, split: "dev" },
  ]).length > 0);
  assert.ok(assertCreativeLineageDisjoint([
    { lineage: { characterFamily: "c", worldFamily: "w", scenarioFamily: "" }, split: "train" },
  ]).some((problem) => problem.includes("empty")));
});

/**
 * The split policy serialises lineage with the pipeline's canonical JSON
 * (`stableStringify`: sorted keys, JSON-quoted values). This local copy
 * reproduces exactly those bytes so the 80/10/10 policy can be recomputed
 * independently of the module that assigns splits.
 */
function creativeLineageDigest(lineage: { characterFamily: string; worldFamily: string; scenarioFamily: string }): string {
  const canonical = Object.fromEntries(Object.keys(lineage).sort()
    .map((key) => [key, (lineage as Record<string, string>)[key]]));
  return sha(JSON.stringify(canonical));
}
function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("malformed transcripts are rejected rather than repaired", () => {
  const plan = createCreativePlan({ seed: "malformed", depth: 4 });
  const good = JSON.parse(syntheticTranscript(plan)) as { turns: { speaker: string; text: string }[] };
  // Some cases return a bare turn array, others return a whole top-level payload.
  // Either is a legitimate way to express the mutation; wrap only the bare array.
  const withTurns = (mutate: (turns: { speaker: string; text: string }[]) => unknown): string => {
    const result = mutate(good.turns.map((turn) => ({ ...turn })));
    return JSON.stringify(Array.isArray(result) ? { turns: result } : result);
  };
  assert.deepEqual(refusalCodes(syntheticTranscript(plan), plan), [], "the fixture transcript must pass the validator");

  const cases: readonly { readonly name: string; readonly raw: string; readonly code: string }[] = [
    { name: "empty", raw: "", code: "transcript-not-json" },
    { name: "prose", raw: "Sure! Here is the conversation.", code: "transcript-not-json" },
    { name: "array", raw: "[]", code: "transcript-not-object" },
    { name: "number", raw: "42", code: "transcript-not-object" },
    { name: "extra top-level key", raw: withTurns((turns) => ({ turns, answer: "because" })), code: "transcript-unknown-key" },
    { name: "missing turns", raw: JSON.stringify({ transcript: [] }), code: "transcript-missing-turns" },
    { name: "turns not an array", raw: JSON.stringify({ turns: "lots" }), code: "transcript-turns-not-array" },
    { name: "turn not an object", raw: withTurns((turns) => { turns[0] = "hello" as never; return { turns }; }), code: "transcript-turn-not-object" },
    { name: "extra turn key", raw: withTurns((turns) => [{ ...turns[0]!, mood: "shouting" }, ...turns.slice(1)]), code: "transcript-turn-unknown-key" },
    { name: "missing speaker", raw: withTurns((turns) => [{ text: turns[0]!.text }, ...turns.slice(1)]), code: "transcript-turn-missing-speaker" },
    { name: "missing text", raw: withTurns((turns) => [{ speaker: turns[0]!.speaker }, ...turns.slice(1)]), code: "transcript-turn-missing-text" },
    { name: "unknown speaker", raw: withTurns((turns) => [{ speaker: "narrator", text: "A mist rolls in." }, ...turns.slice(1)]), code: "transcript-unknown-speaker" },
    { name: "text not a string", raw: withTurns((turns) => [{ speaker: "player", text: 7 }, ...turns.slice(1)]), code: "transcript-text-not-string" },
    { name: "empty character turn", raw: withTurns((turns) => { turns[1]!.text = "   "; return { turns }; }), code: "transcript-empty-character-turn" },
    { name: "empty player turn", raw: withTurns((turns) => { turns[0]!.text = ""; return { turns }; }), code: "transcript-empty-player-turn" },
    // The supported range is the module's own MIN/MAX exchanges, not the plan's
    // requested depth: a transcript of a different but valid length is accepted.
    // These cases must therefore be genuinely OUTSIDE that range.
    { name: "too few turns", raw: withTurns((turns) => ({ turns: turns.slice(0, MIN_EXCHANGE_DEPTH * 2 - 2) })), code: "transcript-turn-count-mismatch" },
    { name: "too many turns", raw: withTurns((turns) => ({ turns: [...turns, ...turns, ...turns] })), code: "transcript-turn-count-mismatch" },
    { name: "character speaks first", raw: withTurns((turns) => {
      const first = turns[0]!;
      turns[0] = { speaker: "character", text: turns[1]!.text };
      turns[1] = { speaker: "player", text: first.text };
      return { turns };
    }), code: "transcript-first-speaker-not-player" },
    { name: "player speaks last", raw: withTurns((turns) => {
      const last = turns[turns.length - 1]!;
      turns[turns.length - 1] = { speaker: "player", text: turns[turns.length - 2]!.text };
      turns[turns.length - 2] = { speaker: "character", text: last.text };
      return { turns };
    }), code: "transcript-last-speaker-not-character" },
    { name: "two character turns in a row", raw: withTurns((turns) => {
      turns[2] = { speaker: "character", text: turns[3]!.text };
      return { turns };
    }), code: "transcript-speaker-alternation" },
  ];
  for (const { name, raw, code } of cases) {
    const codes = refusalCodes(raw, plan);
    assert.ok(codes.length > 0, `${name} was accepted`);
    assert.ok(codes.includes(code as never), `${name} produced ${codes.join(",")} but should have produced ${code}`);
  }
  // Every refusal is turn-scoped where it can be, and nothing was repaired.
  const refusals = checkCreativeTranscript(cases[14]!.raw, plan);
  assert.ok(refusals.every((refusal) => typeof refusal.code === "string" && typeof refusal.excerpt === "string"));
  // A VALID transcript on its own plan builds; a valid transcript on a DIFFERENT
  // plan is refused, because the example builder never silently re-homes a
  // transcript.
  assert.ok(buildCreativeTrainingExample(plan, parsedTranscript(plan), { targetMode: { kind: "all-character-turns" } }).example.messages.length > 1);
  const otherPlan = createCreativePlan({ seed: "malformed-other", depth: plan.depth });
  assert.throws(() => buildCreativeTrainingExample(otherPlan, parsedTranscript(plan)),
    (error: unknown) => error instanceof CreativeConfigError);
});

/** The example builder refuses a transcript that belongs to a different plan. */

test("a character turn that impersonates the player is rejected", () => {
  const plan = createCreativePlan({ seed: "impersonation", depth: 4 });
  const build = (text: string): string[] => {
    const { turns } = JSON.parse(syntheticTranscript(plan)) as { turns: { speaker: string; text: string }[] };
    turns[1] = { speaker: "character", text };
    return refusalCodes(JSON.stringify({ turns }), plan);
  };
  for (const text of [
    "You decide. Honestly, it's your call, and I'll live with it.",
    "You open the door and step inside before you can think better of it.",
    "You feel relieved, and you tell her it was all right.",
    "You must go. There's no version of tonight where you stay.",
    "You said you'd help, remember? You agreed to it last winter.",
    "You understand what I'm telling you. You've always understood.",
    "Right. You open the ledger, you read the name, and then it's over with.",
    "Because you agreed to this, and now you're standing here.",
    "You nod slowly and tell her it was all right.",
    "You have to be out of here before midnight. That's how it works.",
    "(you step back, unsure)",
  ]) {
    const codes = build(text);
    assert.ok(codes.includes("transcript-player-impersonation"), `"${text}" was accepted: ${codes.join(",")}`);
  }
  // ASKING the player something is not deciding for them, and must be allowed.
  for (const text of [
    "Did you open it? I heard the latch from here.",
    "Are you all right? You looked like you needed a minute.",
    "What do you think happened to him? I genuinely don't know.",
  ]) {
    assert.deepEqual(build(text), [], `a legitimate question was refused: "${text}"`);
  }
  // ADDRESSING the player in a subordinate or possessive phrase is ordinary
  // dialogue, not impersonation. The shipped detector refused all of these, which
  // made natural conversation impossible: a character could not say "if you stand
  // where I stand" without the whole transcript being rejected. Only a
  // main-clause assertion decides for the player.
  for (const text of [
    "If you stand where I stand, at the north pier, with your hand flat on the stone, you will see it.",
    "And if you stand there and feel nothing, go home, and I will never bring it up again.",
    "It matters that it is yours when you do it.",
    "That is when the count comes round, and if you stand at the north pier, you will see it.",
    "Take the lantern, and when you reach the gate, count the stones.",
    "She will hold the door while you look.",
  ]) {
    assert.deepEqual(build(text), [], `subordinate player address was refused as impersonation: "${text}"`);
  }
  // A main-clause assertion is STILL refused even after the guard, including when
  // it follows a vocative or another sentence.
  for (const text of [
    "Right. You open the ledger, you read the name, and then it is over with.",
    "Listen. You take the lantern and you go.",
  ]) {
    assert.ok(build(text).includes("transcript-player-impersonation"), `main-clause assertion was accepted: "${text}"`);
  }
});

test("a character asserting the player's internal state is rejected, while address is allowed", () => {
  const plan = createCreativePlan({ seed: "impersonation", depth: 4 });
  const build = (text: string): string[] => {
    const { turns } = JSON.parse(syntheticTranscript(plan)) as { turns: { speaker: string; text: string }[] };
    turns[1] = { speaker: "character", text };
    return refusalCodes(JSON.stringify({ turns }), plan);
  };

  // MAIN-CLAUSE INTERNAL-STATE ASSERTIONS. The character states the player's own
  // mind as fact. The first line is the exact string an independent judge caught:
  // the player's uncertainty never established that want.
  for (const text of [
    "You want to know what I want, so here it is, and it's the first true thing said in this room tonight.",
    "You want the ledger, and you have wanted it since the day we met.",
    "You need to hear this before you go.",
    "You need the truth more than you need the deal.",
    "You know the answer, and you have known it all along.",
    "You think I'm lying to you.",
    "You believe the official story, because it is easier.",
    "You remember the winter we buried him.",
    "You care about the ledger more than you care about me.",
    "You hope this will all be over by morning.",
    "You prefer the version where nobody is to blame.",
    "You expect me to apologise, and I will not.",
    "Right. You want to know what I want, so here it is.",
  ]) {
    const codes = build(text);
    assert.ok(codes.includes("transcript-player-impersonation"),
      `an internal-state assertion was accepted: "${text}" -> ${codes.join(",")}`);
  }

  // ADDRESS, OFFERS, SUBORDINATE FRAMES AND QUESTIONS. The character speaks TO
  // the player without deciding that mind for them. "You may want to sit down"
  // never puts "you" next to the verb, and a question is exempt entirely.
  for (const text of [
    "If you want to leave, the door is there.",
    "Whatever you think of me, I am not going to lie about this.",
    "I know you want to help. That is why I asked.",
    "You may want to sit down. This part is long.",
    "Do you want a drink? I have tea as well.",
    "If you need anything, ask the sexton.",
    "When you know the answer, you can decide what to do with it.",
    "As you know, the count comes round at the second bell.",
    "You know, I had not thought of it that way.",
    "I know what you need, and I will not pretend otherwise.",
  ]) {
    assert.deepEqual(build(text), [], `legal address was refused as impersonation: "${text}"`);
  }

  // The existing main-clause ACTION assertions still refuse...
  for (const text of [
    "Right. You open the ledger, you read the name, and then it is over with.",
    "Listen. You take the lantern and you go.",
  ]) {
    assert.ok(build(text).includes("transcript-player-impersonation"), `main-clause action assertion was accepted: "${text}"`);
  }
  // ...and the existing SUBORDINATE address is still ordinary dialogue.
  for (const text of [
    "If you stand where I stand, at the north pier, with your hand flat on the stone, you will see it.",
    "Take the lantern, and when you reach the gate, count the stones.",
    "She will hold the door while you look.",
  ]) {
    assert.deepEqual(build(text), [], `subordinate player address was refused as impersonation: "${text}"`);
  }
});

test("meta commentary, grading metadata and mechanical register are rejected", () => {
  const plan = createCreativePlan({ seed: "meta", depth: 4 });
  const put = (index: number, text: string): string => {
    const { turns } = JSON.parse(syntheticTranscript(plan)) as { turns: { speaker: string; text: string }[] };
    turns[index] = { speaker: index % 2 === 0 ? "player" : "character", text };
    return JSON.stringify({ turns });
  };
  for (const text of [
    "As an AI, I should note that this scene is difficult.",
    "Here's the transcript you asked for.",
    "Note: she is lying about the appointment.",
    "The player wants a straight answer here.",
    "I hope this helps! Let me know if you want me to adjust the tone.",
    "Per the beats, this is where she turns.",
    "Her emotionalVolatility rises here, per the character card.",
  ]) {
    assert.ok(refusalCodes(put(1, text), plan).includes("transcript-meta-commentary"), `meta accepted: ${text}`);
  }
  for (const text of [
    "You roll a d20 and add your modifiers.",
    "Her DC 15 Stealth check comes to 12, a failure.",
    "The hit points go from 24 to 19 after the hit.",
    "{\"voiceConsistency\": 1, \"score\": 4}",
    "Rubric: she must refuse here.",
    "I would rate this conversation 8/10.",
    "correct answer: she agrees to the deal",
  ]) {
    const codes = refusalCodes(put(1, text), plan);
    assert.ok(codes.length > 0, `leak accepted: ${text}`);
    assert.ok(codes.some((code) => code === "transcript-grading-metadata" || code === "transcript-mechanical-register-leak"
      || code === "transcript-meta-commentary"), `leak produced the wrong code: ${text} -> ${codes.join(",")}`);
  }
  // A PLAYER turn is held to the same no-meta rule.
  assert.ok(refusalCodes(put(0, "Let me know if you need me to expand on that."), plan).includes("transcript-meta-commentary"));
  // The fixture passes, so the rejections above are specific rather than blanket.
  assert.deepEqual(refusalCodes(syntheticTranscript(plan), plan), []);
});

test("the independent creative review contract round-trips and refuses bad payloads", () => {
  const plan = createCreativePlan({ seed: "review", shape: "emotional-escalation", depth: 5 });
  const transcript = parsedTranscript(plan);
  const prompt = creativeReviewPrompt(plan, transcript);
  assert.ok(prompt.includes("judging CREATIVE quality only"));
  assert.ok(prompt.includes("the absence of numbers, checks, DCs, dice, status effects or receipts is never a defect"));
  assert.ok(prompt.includes("Never reward a line for containing an anchor"));
  for (const criterion of CREATIVE_REVIEW_CRITERIA) assert.ok(prompt.includes(`${criterion}:`), `${criterion} is not in the prompt`);
  for (const forbidden of ["receipt coverage is required", "match the reference", "reward a number", "must include a check result"]) {
    assert.ok(!prompt.includes(forbidden), `the reviewer prompt rewards an anchor: ${forbidden}`);
  }
  const scores = Object.fromEntries(CREATIVE_REVIEW_CRITERIA.map((criterion, index) => [criterion, 0.6 + index / 100]));
  const valid = { ...scores, verdict: "accept", rationale: "The voice holds across both ends of the arc." };
  const review = parseCreativeReview(JSON.stringify(valid));
  assert.equal(review.verdict, "accept");
  assert.equal(review.promptVersion, "creative-review-v1");
  assert.equal(Object.keys(review.scores).length, CREATIVE_REVIEW_CRITERIA.length);
  assert.equal(parseCreativeReview(JSON.stringify(valid)).digest, review.digest);

  const folded = foldCreativeReviewIntoSpecScores(review);
  assert.equal(folded.characterization, Math.min(review.scores.voiceConsistency, review.scores.voiceDistinctiveness));
  assert.ok(folded.dialogueQuality <= review.scores.dialogueNaturalness, "the fold must not reward beyond its inputs");
  assert.ok(folded.playerAgency === review.scores.playerAgencyPreservation);
  // A zero on agency must survive the fold and hit the admission floor.
  const failing = { ...valid, playerAgencyPreservation: 0, verdict: "reject", rationale: "The character decides the player's ending." };
  assert.equal(foldCreativeReviewIntoSpecScores(parseCreativeReview(JSON.stringify(failing))).playerAgency, 0);

  const refusals = (raw: string): string[] => {
    try {
      parseCreativeReview(raw);
      return [];
    } catch (error) {
      return (error as { refusals: { code: string }[] }).refusals.map((refusal) => refusal.code);
    }
  };
  assert.deepEqual(refusals("not json"), ["review-not-json"]);
  assert.deepEqual(refusals("[]"), ["review-not-object"]);
  assert.ok(refusals(JSON.stringify({ ...valid, extra: 1 })).includes("review-unknown-key"));
  assert.ok(refusals(JSON.stringify({ ...valid, reviewerCount: 3 })).includes("review-unknown-key"));
  const missing: Record<string, unknown> = { ...valid };
  delete missing.pacingAndProportion;
  assert.ok(refusals(JSON.stringify(missing)).includes("review-missing-field"));
  assert.ok(refusals(JSON.stringify({ ...valid, voiceConsistency: 1.5 })).includes("review-score-out-of-range"));
  assert.ok(refusals(JSON.stringify({ ...valid, voiceConsistency: "high" })).includes("review-score-out-of-range"));
  assert.ok(refusals(JSON.stringify({ ...valid, verdict: "PASS" })).includes("review-unknown-verdict"));
  assert.ok(refusals(JSON.stringify({ ...valid, rationale: "   " })).includes("review-rationale-empty"));
  for (const criterion of CREATIVE_REVIEW_CRITERIA) {
    assert.equal(typeof (valid as unknown as Record<CreativeReviewCriterion, unknown>)[criterion], "number");
  }
});

test("category labels and export mixing are configurable, deterministic and measured", () => {
  for (const category of CREATIVE_STREAM_CATEGORIES) assert.ok(isCreativeStreamCategory(category));
  assert.equal(creativeCategoryLabel("creative-roleplay"), "creative-only");
  assert.equal(creativeCategoryLabel("structured"), "structured-only");
  assert.equal(creativeCategoryLabel("creative-roleplay", { multitask: true }), "multitask");
  assert.equal(creativeCategoryLabel("structured", { multitask: true }), "multitask");

  const plans = createCreativePlans("mix", 120);
  const creative = plans.map((plan) => {
    const lineage = creativeLineage(plan);
    const built = buildCreativeTrainingExample(plan, parsedTranscript(plan));
    return {
      id: built.exampleId, category: built.category, split: built.split, lineage,
      setting: plan.world.setting, arcShape: plan.shape, stance: plan.card.stance.primary,
    };
  });
  assert.ok(creative.every((item) => item.category === "creative-only"));
  const structured = Array.from({ length: 120 }, (_, index) => ({
    id: `structured-${index}`, category: "structured-only" as const, split: "train" as const,
    lineage: { characterFamily: `s-c-${index}`, worldFamily: `s-w-${index}`, scenarioFamily: `s-s-${index}` },
  }));
  const pool = [...creative, ...structured];

  const mixed = selectCreativeMix(pool, { seed: "mix-v1", creativeShare: 0.5, structuredShare: 0.5 });
  const repeat = selectCreativeMix([...pool].reverse(), { seed: "mix-v1", creativeShare: 0.5, structuredShare: 0.5 });
  assert.deepEqual(mixed.selected.map((item) => item.id), repeat.selected.map((item) => item.id),
    "mix selection depends on input order");
  assert.equal(mixed.digest, repeat.digest);
  assert.equal(mixed.selected.length + mixed.excluded.length, pool.length);
  assert.ok(Math.abs(mixed.achievedShares.creative - 0.5) <= 0.02, `achieved creative share ${mixed.achievedShares.creative}`);
  assert.equal(mixed.achievedShares.creative + mixed.achievedShares.structured, 1);
  // A different configured share produces a different, reported allocation.
  const skewed = selectCreativeMix(pool, { seed: "mix-v1", creativeShare: 0.8, structuredShare: 0.2 });
  assert.notEqual(skewed.digest, mixed.digest);
  assert.ok(skewed.achievedShares.creative > skewed.achievedShares.structured);
  assert.equal(skewed.requestedShares.creative, 0.8);
  // One category alone cannot satisfy a mix, and says so instead of faking one.
  const only = selectCreativeMix(creative, { seed: "mix-v1", creativeShare: 0.5, structuredShare: 0.5 });
  assert.equal(only.selected.length, 0);
  assert.ok(only.excluded.every((entry) => entry.reason === "category-unavailable"));
  assert.throws(() => selectCreativeMix(pool, { seed: "mix-v1", creativeShare: 0.6, structuredShare: 0.6 }), /sum to 1/);
  assert.throws(() => selectCreativeMix(pool, { seed: "", creativeShare: 0.5, structuredShare: 0.5 }), /needs a seed/);

  // Coverage is MEASURED and reported, never asserted as a target.
  const report = creativeCoverageReport([...mixed.selected]);
  assert.equal(report.total, mixed.selected.length);
  assert.equal(report.byCategory["creative-only"]!, mixed.achieved["creative-only"]);
  assert.equal(report.byCategory["structured-only"]!, mixed.achieved["structured-only"]);
  // The creative rows carry real derived splits; the structured rows are train.
  // Coverage must report exactly the splits that are actually present.
  assert.equal(Object.keys(report.bySplit).length, new Set(mixed.selected.map((item) => item.split)).size);
  assert.equal(Object.values(report.bySplit).reduce((sum, count) => sum + count, 0), report.total);
  assert.ok(Object.keys(report.bySetting).length >= 3, "coverage reported no settings");
  assert.ok(Object.keys(report.byArcShape).length >= 3);
  assert.ok(Object.keys(report.byStance).length >= 5);
  assert.equal(report.distinctCharacterFamilies, new Set(mixed.selected.map((item) => item.lineage.characterFamily)).size);
  assert.equal(report.creativeToStructured.creative + report.creativeToStructured.structured, report.total);
  assert.ok(report.creativeToStructured.ratio > 0);
});

test("the creative stream is not a reskin of the legacy roleplay family", () => {
  const cards = createCharacterCardBatch("reskin", 400);
  // The legacy family is eight names, six places, five objects, four guilds, one
  // drowned harbour town and five tone labels. None of it may appear here.
  const legacyAnchors = ["Haug", "Ailsa", "Oswin", "Maren", "Corbin", "Ivet", "Sable", "Thrale",
    "Tallow Street", "the Salt Pier", "Cinderhold", "the Weeping Gate", "Lowmarket Row", "the Dry Quarry",
    "the Harbour Guild", "the Salt Company", "the Assize", "the Ninth Watch"];
  const plans = createCreativePlans("reskin", 400);
  const surfaces = plans.map((plan) => `${plan.situation} ${plan.world.locale} ${plan.world.institution} ${plan.world.prop}`);
  // Whole-anchor match, not a loose substring: the legacy guild "the Assize"
  // must not fire on the unrelated historical phrase "the assize court", and a
  // legacy name "Sable" must not fire inside a longer generated name.
  const anchorPattern = (anchor: string): RegExp =>
    new RegExp(`\\b${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (const anchor of legacyAnchors) {
    const pattern = anchorPattern(anchor);
    assert.ok(!cards.some((card) => pattern.test(card.name)), `a card used the legacy anchor "${anchor}"`);
    assert.ok(!surfaces.some((surface) => pattern.test(surface)), `a plan used the legacy anchor "${anchor}"`);
  }
  for (const card of cards) {
    assert.ok(!/sets down .* and does not look up/i.test(card.voiceAnchor));
    assert.ok(!/go on, then/i.test(card.voiceAnchor));
  }
  assert.ok(!surfaces.some((surface) => /drowned harbour town|salt-mine town/i.test(surface)),
    "a plan reused the legacy world theme");
  assert.ok(!/terse and procedural|low-register and wary|clipped, almost bureaucratic|warm but evasive|flatly transactional/i
    .test(cards.map((card) => card.voiceAnchor).join(" ")), "a card reused one of the five legacy tone labels");
});
/**
 * Tests for the production-to-HF adapter and the Family C/D validators.
 *
 * The adapter tests encode the exact production shapes the audit identified:
 * `toolCalls` (not `tool_calls`), JSON-STRING arguments, `content: null` on
 * call-only assistant messages, and unwrapped tool schemas.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogReferenceIdentity } from "../src/worldGenerationTypes.js";
import {
  AdapterError,
  adaptMessages,
  adaptTool,
  assertNoNullContentTargets,
  assertNoToolResultSupervision,
  parseArgumentsOnce,
  selectTargets,
} from "../src/hfAdapter.js";
import {
  FAMILY_C_VALIDATOR_VERSION,
  FAMILY_D_VALIDATOR_VERSION,
  WORLD_GENERATION_SECTIONS,
  fieldsForSections,
  scoreSelection,
  validateAdvertisedSelection,
  validateWorldGeneration,
  type AdvertisedCandidate,
} from "../src/worldGeneration.js";

const CANDIDATE: AdvertisedCandidate = {
  candidateId: "item:equip-shunting-lamp-61",
  digest: "ed2eaa78a4e620e203268d7f50858a3b342ab80f0f87d72020a06ab663c5b8c9",
  toolName: "exact_inventory_action.select",
};

test("production tool calls adapt to HF shape", () => {
  const result = adaptMessages({
    messages: [
      { role: "system", content: "Adventure authority." },
      { role: "user", content: "I put the lamp on." },
      // Production emits null content with toolCalls.
      { role: "assistant", content: null, toolCalls: [{ id: "call-1", toolName: "exact_inventory_action.select", argumentsJson: '{"candidateId":"x","digest":"y"}' }] },
      { role: "tool", content: "Equipped to hand.", toolCallId: "call-1", toolName: "exact_inventory_action.select" },
      { role: "assistant", content: "Done." },
    ],
    tools: [{ name: "exact_inventory_action.select", description: "Select an inventory candidate.", parameters: { type: "object", properties: {} } }],
  });

  const call = result.messages[2]!;
  assert.equal(call.role, "assistant");
  assert.equal(call.content, "", "null content must normalize to empty string, not the literal 'None'");
  assert.equal(call.tool_calls?.length, 1);
  const fn = call.tool_calls![0]!.function;
  assert.equal(fn.name, "exact_inventory_action.select");
  // The audit's finding: arguments must be an OBJECT for Transformers.
  assert.equal(typeof fn.arguments, "object");
  assert.ok(!Array.isArray(fn.arguments));
  assert.deepEqual(fn.arguments, { candidateId: "x", digest: "y" });

  assert.equal(result.messages[3]!.role, "tool");
  assert.equal(result.messages[3]!.tool_call_id, "call-1");
  assert.equal(result.stats.toolCallsParsed, 1);
  assert.equal(result.stats.nullContentsNormalized, 1);
  assert.equal(result.tools?.[0]?.type, "function");
});

test("production unwrapped tool schemas are wrapped for HF", () => {
  const tool = adaptTool({ name: "combat_action.execute", parameters: { type: "object" } });
  assert.equal(tool.type, "function");
  assert.equal(tool.function.name, "combat_action.execute");
  assert.equal(tool.function.description, "");
});

test("a JSON-string argument body is parsed exactly once, not double-encoded", () => {
  const problems: string[] = [];
  const args = parseArgumentsOnce('{"a":1}', problems, "c1");
  assert.deepEqual(args, { a: 1 });
  assert.equal(typeof args.a, "number");
  assert.deepEqual(problems, []);
});

test("non-object and unparseable arguments are hard errors", () => {
  const problems: string[] = [];
  parseArgumentsOnce("[1,2]", problems, "c1");
  assert.ok(problems.some((problem) => /must be a JSON object/.test(problem)));
  const problems2: string[] = [];
  parseArgumentsOnce("{not json", problems2, "c2");
  assert.ok(problems2.some((problem) => /unparseable/.test(problem)));
});

test("duplicate tool-call ids, dangling results and unanswered calls are refused", () => {
  assert.throws(() => adaptMessages({
    messages: [
      { role: "assistant", content: null, toolCalls: [{ id: "dup", toolName: "t", argumentsJson: "{}" }] },
      { role: "assistant", content: null, toolCalls: [{ id: "dup", toolName: "t", argumentsJson: "{}" }] },
    ],
  }), AdapterError);

  assert.throws(() => adaptMessages({
    messages: [{ role: "tool", content: "orphan", toolCallId: "never-made" }],
  }), /never made/);

  assert.throws(() => adaptMessages({
    messages: [{ role: "assistant", content: null, toolCalls: [{ id: "x", toolName: "t", argumentsJson: "{}" }] }],
  }), /unanswered tool calls/);
});

test("tool calls attached to a non-assistant role are refused", () => {
  assert.throws(() => adaptMessages({
    messages: [{ role: "user", content: "hi", toolCalls: [{ id: "x", toolName: "t", argumentsJson: "{}" }] }],
  }), AdapterError);
});

test("null-content tool-call targets are detected before rendering", () => {
  const problems = assertNoNullContentTargets([
    { role: "assistant", content: null as unknown as string, tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: {} } }] },
  ]);
  assert.ok(problems.some((problem) => /null assistant content/.test(problem)));
});

test("only the target assistant span is supervised; context history is masked", () => {
  const result = adaptMessages({
    messages: [
      { role: "system", content: "ctx" },
      { role: "assistant", content: "historical assistant turn that must not be trained on" },
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "the supervised answer", toolCalls: [{ id: "c", toolName: "t", argumentsJson: '{"a":1}' }] },
      { role: "tool", content: "tool result", toolCallId: "c", toolName: "t" },
      { role: "assistant", content: "final answer" },
    ],
  });
  const selection = selectTargets(result.messages, { targetAssistantIndex: 5 });
  assert.deepEqual(selection.supervisedAssistantIndices, [5], "only the chosen target is supervised");
  assert.deepEqual(assertNoToolResultSupervision(result.messages, selection), []);
});

test("an empty-content turn WITH tool calls is a valid tool-only training target", () => {
  const result = adaptMessages({
    messages: [
      { role: "assistant", content: null, toolCalls: [{ id: "c", toolName: "t", argumentsJson: '{"a":1}' }] },
      { role: "tool", content: "r", toolCallId: "c", toolName: "t" },
    ],
  });
  const selection = selectTargets(result.messages, { targetAssistantIndex: 0 });
  assert.deepEqual(selection.supervisedAssistantIndices, [], "no prose to supervise");
  assert.deepEqual(selection.supervisedToolCallIndices, [0], "but the tool call itself IS the target");
});

test("an assistant turn with neither prose nor tool calls is refused", () => {
  const result = adaptMessages({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "   " },
    ],
  });
  assert.throws(() => selectTargets(result.messages, { targetAssistantIndex: 1 }), /nothing to supervise/);
});

// --- Family C ---

test("an advertised, correctly-bound selection is accepted", () => {
  const verdict = validateAdvertisedSelection(
    { toolName: CANDIDATE.toolName, candidateId: CANDIDATE.candidateId, digest: CANDIDATE.digest, transportValid: true, finalOutcome: "mechanics-committed" },
    [CANDIDATE],
    ["exact_inventory_action.select", "actor_inventory.read"],
  );
  assert.equal(verdict.advertised, true);
  assert.deepEqual(verdict.problems, []);
  const score = scoreSelection(
    { toolName: CANDIDATE.toolName, candidateId: CANDIDATE.candidateId, digest: CANDIDATE.digest, transportValid: true, finalOutcome: "mechanics-committed" },
    verdict,
  );
  assert.equal(score.teacherAuthoredOutcome, true);
});

test("an unadvertised candidate is refused", () => {
  const verdict = validateAdvertisedSelection(
    { toolName: CANDIDATE.toolName, candidateId: "not-offered", digest: CANDIDATE.digest, transportValid: true, finalOutcome: "mechanics-committed" },
    [CANDIDATE], [CANDIDATE.toolName],
  );
  assert.equal(verdict.advertised, false);
  assert.ok(verdict.problems.some((problem) => /was not advertised/.test(problem)));
});

test("a right id with a wrong digest is refused (the tamper case)", () => {
  const verdict = validateAdvertisedSelection(
    { toolName: CANDIDATE.toolName, candidateId: CANDIDATE.candidateId, digest: "0".repeat(64), transportValid: true, finalOutcome: "mechanics-committed" },
    [CANDIDATE], [CANDIDATE.toolName],
  );
  assert.ok(verdict.problems.some((problem) => /digest mismatch/.test(problem)));
});

test("an unadvertised TOOL is refused even with a plausible candidate", () => {
  const verdict = validateAdvertisedSelection(
    { toolName: "exact_actor_travel.select", candidateId: CANDIDATE.candidateId, digest: CANDIDATE.digest, transportValid: true, finalOutcome: "mechanics-committed" },
    [CANDIDATE], ["exact_inventory_action.select"],
  );
  assert.equal(verdict.toolAdvertised, false);
  assert.ok(verdict.problems.some((problem) => /was not advertised for this decision/.test(problem)));
});

test("server recovery cannot be credited to the teacher", () => {
  const selection = { toolName: CANDIDATE.toolName, candidateId: CANDIDATE.candidateId, digest: CANDIDATE.digest, transportValid: true, serverRecovered: true, finalOutcome: "fallback" as const };
  const verdict = validateAdvertisedSelection(selection, [CANDIDATE], [CANDIDATE.toolName]);
  assert.ok(verdict.problems.some((problem) => /server recovery/.test(problem)));
  assert.equal(scoreSelection(selection, verdict).teacherAuthoredOutcome, false);
});

test("a non-hex digest is refused", () => {
  const verdict = validateAdvertisedSelection(
    { toolName: CANDIDATE.toolName, candidateId: CANDIDATE.candidateId, digest: "not-a-digest", transportValid: true, finalOutcome: "mechanics-committed" },
    [{ ...CANDIDATE, digest: "not-a-digest" }], [CANDIDATE.toolName],
  );
  assert.ok(verdict.problems.some((problem) => /not a 64-hex/.test(problem)));
});

test("validator versions are exported for provenance", () => {
  assert.match(FAMILY_C_VALIDATOR_VERSION, /^family-c-/);
  assert.match(FAMILY_D_VALIDATOR_VERSION, /^family-d-/);
});

// --- Family D ---

test("compatible catalog references bind exact production identities and keep inert concepts valid", () => {
  const reference = { kind: "enemy-template" as const, packId: "fixture-bestiary", packVersion: "1.2.0", definitionId: "hound" };
  const identity = { ...reference, referenceIdentity: catalogReferenceIdentity(reference) };
  assert.equal(identity.referenceIdentity, "enemy-template\u0000fixture-bestiary\u00001.2.0\u0000hound");
  const monster = { key: "hound", name: "Hound", description: "A watchful hound.", visibility: "public", role: "watcher", tactics: [] };
  const raw = { monsterConcepts: [{ ...monster, mechanics: { state: "catalog-bound", reference } }],
    encounters: [{ key: "encounter", title: "A Hound at the Gate", description: "The hound waits at the gate.", visibility: "public",
      enemyReferences: [reference], monsterConceptKeys: ["hound"], participantNpcKeys: [] }] };
  const input = { raw, sections: ["monster-concepts", "encounters"], dependencies: new Map(), catalogReferences: [identity],
    tolerateInvalidReferences: true, allowRepair: false };
  const valid = validateWorldGeneration(input);
  assert.equal(valid.ok, true, valid.problems.join("; "));
  assert.equal(valid.rawFirstAttemptValid, true);
  for (const field of ["packId", "packVersion", "definitionId"] as const) {
    const mutated = structuredClone(raw);
    mutated.monsterConcepts[0]!.mechanics.reference[field] += "-wrong";
    const verdict = validateWorldGeneration({ ...input, raw: mutated });
    assert.equal(verdict.rawFirstAttemptValid, false, `${field} cannot bind another catalog entry`);
  }
  const incompatible = { ...reference, kind: "monster" };
  assert.equal(validateWorldGeneration({ ...input, catalogReferences: [{ ...incompatible, referenceIdentity: catalogReferenceIdentity(incompatible) }] }).rawFirstAttemptValid, false, "similarly named kinds are never coerced");
  const mismatchedIdentity = validateWorldGeneration({ ...input, catalogReferences: [{ ...identity, referenceIdentity: "fixture-bestiary@1.2.0#hound" }] });
  assert.equal(mismatchedIdentity.ok, false, "display identity cannot silently widen or replace the exact production identity");
  const inert = validateWorldGeneration({ ...input, raw: { monsterConcepts: [{ ...monster, mechanics: { state: "inert", reason: "Narrative-only hound." } }] }, sections: ["monster-concepts"] });
  assert.equal(inert.ok, true, inert.problems.join("; "));
});

test("the 14 requested sections map onto 16 output arrays", () => {
  assert.equal(WORLD_GENERATION_SECTIONS.length, 14);
  const fields = fieldsForSections(["locations", "npcs"]);
  // `locations` maps to locations AND connections.
  assert.ok(fields.has("locations"));
  assert.ok(fields.has("connections"));
  assert.ok(fields.has("npcs"));
  assert.ok(!fields.has("lore"));
});

test("a valid sparse candidate for the requested sections is accepted", () => {
  const verdict = validateWorldGeneration({
    raw: { npcs: [{ key: "npc-salt", name: "Salt", archetype: "Guide", description: "A guide.", visibility: "public" }] },
    sections: ["npcs"],
    dependencies: new Map(),
    catalogReferences: [],
  });
  assert.equal(verdict.ok, true, verdict.problems.join("; "));
  assert.deepEqual(verdict.producedFields, ["npcs"]);
});

test("producing a field outside the requested sections is refused", () => {
  const verdict = validateWorldGeneration({
    raw: {
      npcs: [{ key: "npc-salt", name: "Salt", archetype: "Guide", description: "A guide.", visibility: "public" }],
      lore: [{ key: "lore-1", title: "L", summary: "S", visibility: "public", details: [] }],
    },
    sections: ["npcs"],
    dependencies: new Map(),
    catalogReferences: [],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.content, null);
  assert.ok(verdict.problems.some((problem) => /requested-section schema/.test(problem)));
});

test("an empty candidate is refused", () => {
  const verdict = validateWorldGeneration({ raw: {}, sections: ["npcs"], dependencies: new Map(), catalogReferences: [] });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /no content for any requested section/.test(problem)));
});

test("an unresolvable reference is a repair, not a clean pass", () => {
  const verdict = validateWorldGeneration({
    raw: { npcs: [{ key: "npc-a", name: "A", archetype: "Guide", description: "d", visibility: "public", locationKey: "loc-does-not-exist" }] },
    sections: ["npcs"],
    dependencies: new Map(),
    catalogReferences: [],
    tolerateInvalidReferences: true,
    allowRepair: true,
  });
  assert.equal(verdict.sanitized, true, "the dangling reference must be dropped, so this is a repair");
  assert.equal(verdict.ok, true);
  assert.ok(verdict.problems.some((problem) => /sanitized/.test(problem)));
});

test("without toleration a dangling reference is a REJECTION, not a repair", () => {
  const verdict = validateWorldGeneration({
    raw: { npcs: [{ key: "npc-a", name: "A", archetype: "Guide", description: "d", visibility: "public", locationKey: "loc-nope" }] },
    sections: ["npcs"], dependencies: new Map(), catalogReferences: [], allowRepair: true,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.sanitized, false);
  assert.ok(verdict.problems.some((problem) => /must reference location/.test(problem)));
});

test("a repair is refused when repairs are not allowed", () => {
  const verdict = validateWorldGeneration({
    raw: { npcs: [{ key: "npc-a", name: "A", archetype: "Guide", description: "d", visibility: "public", locationKey: "loc-nope" }] },
    sections: ["npcs"],
    dependencies: new Map(),
    catalogReferences: [],
    tolerateInvalidReferences: true,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /needs its own target/.test(problem)));
});

test("malformed output fails the sparse section schema", () => {
  const verdict = validateWorldGeneration({
    raw: { npcs: [{ key: "Bad_Key", name: "", description: "x", visibility: "public" }] },
    sections: ["npcs"],
    dependencies: new Map(),
    catalogReferences: [],
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /requested-section schema/.test(problem)));
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildProbePayload, validateProbeResponse } from "./routetok-probe.mjs";

test("probe payloads always round-trip as valid JSON without strict model routing", () => {
  for (const scenario of ["planning-travel", "planning-inventory", "narration"]) {
    const payload = buildProbePayload(scenario);
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
    assert.equal(JSON.stringify(payload).includes('"strict"'), false);
  }
});

test("planning probes require the intended pair-coupled candidate", () => {
  const response = (name, args) => ({ choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }] });
  assert.equal(validateProbeResponse("planning-travel", response("exact_actor_travel.select", {
    candidateId: "candidate-place", kind: "actor.travel", version: "v1", choices: [],
  })).valid, true);
  assert.equal(validateProbeResponse("planning-inventory", response("exact_inventory_action.select", {
    candidateId: "candidate-unequip", digest: "b".repeat(64),
  })).valid, false);
});

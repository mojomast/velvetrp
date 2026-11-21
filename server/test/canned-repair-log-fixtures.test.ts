// Approved tests: the one existing narration repair must name the exact failed gate rule,
// and turn-log debug fields must distinguish holds from narrator failures. No extra retries.
import { describe, expect, it } from "vitest";
import type { AdventureHold } from "../src/agent/adventureOrchestrator.js";
import {
  narrationDebugFields,
  narrationGateFailure,
  narrationRepairMessage,
} from "../src/routes/rpg/v1/adventureTurns.js";

const HERE = "Slake-Head";

const perceptionSuccess = {
  kind: "check",
  checkKind: "skill",
  ability: "Wisdom",
  skill: "Perception",
  mode: "normal",
  difficulty: "Medium",
  rolls: [{ value: 13, kept: true }],
  abilityModifier: 2,
  proficiencyBonus: 2,
  modifier: 4,
  total: 17,
  dc: 15,
  outcome: "success" as const,
};

describe("exact failed-rule repair (still a single retry)", () => {
  it("names the invented transaction in the repair message", () => {
    const rejected = "You buy a brass lamp from the stall and stroll on.";
    const rule = narrationGateFailure(rejected, [], HERE);
    expect(rule).toMatch(/unsupported-transaction|unsupported-inventory|unsupported-currency/);
    const message = narrationRepairMessage({
      values: [],
      currentLocation: HERE,
      conversation: true,
      rejected,
      failedRule: rule,
    });
    expect(message.role).toBe("user");
    expect(message.content).toMatch(/do not (?:claim|assert|state|imply) a (?:purchase|transaction|sale)/i);
    expect(message.content).toContain("GROUNDING CORRECTION");
  });

  it("names an invented damage number rather than re-sending a generic fact dump only", () => {
    const rejected = "You take in the moving ground; your Perception work pays off and you deal 12 damage.";
    const rule = narrationGateFailure(rejected, [perceptionSuccess] as never, HERE);
    expect(rule).toMatch(/unsupported-damage/);
    const message = narrationRepairMessage({
      values: [perceptionSuccess] as never,
      currentLocation: HERE,
      conversation: false,
      rejected,
      failedRule: rule,
    });
    expect(message.content).toMatch(/do not state a damage number/i);
  });

  it("still returns a single repair user message, not a retry loop", () => {
    const message = narrationRepairMessage({
      values: [],
      currentLocation: HERE,
      conversation: true,
      rejected: "You buy a brass lamp from the stall and stroll on.",
      failedRule: "unsupported-transaction",
    });
    expect(Array.isArray(message) ? message : [message]).toHaveLength(1);
  });
});

describe("turn-log debug fields split holds from narrator failures", () => {
  const hold: AdventureHold = {
    reason: "location-mismatch",
    message: "You are still at Slake Market, not Slake-Head.",
    suggestedNextStep: "Travel to Slake-Head",
    suggestedCandidateId: "travel:slake-head",
  };

  it("marks a warranted hold as hold-skipped-provider with the hold reason and no repair", () => {
    const fields = narrationDebugFields({
      hold,
      holdWarranted: true,
      source: "deterministic-fallback",
      gateRule: null,
      repairAttempted: false,
    });
    expect(fields.holdReason).toBe("location-mismatch");
    expect(fields.narrationOutcome).toBe("hold-skipped-provider");
    expect(fields.repairAttempted).toBe(false);
    expect(fields.gateRule ?? null).toBeNull();
  });

  it("marks a gate rejection after a skipped repair with the failed rule", () => {
    const fields = narrationDebugFields({
      hold: undefined,
      holdWarranted: false,
      source: "deterministic-fallback",
      gateRule: "unsupported-travel",
      repairAttempted: false,
    });
    expect(fields.holdReason ?? null).toBeNull();
    expect(fields.gateRule).toBe("unsupported-travel");
    expect(fields.narrationOutcome).toBe("repair-skipped");
    expect(fields.repairAttempted).toBe(false);
  });

  it("marks a gate rejection after the one allowed repair as gate-rejected", () => {
    const fields = narrationDebugFields({
      hold: undefined,
      holdWarranted: false,
      source: "deterministic-fallback",
      gateRule: "unsupported-travel",
      repairAttempted: true,
    });
    expect(fields.narrationOutcome).toBe("gate-rejected");
    expect(fields.repairAttempted).toBe(true);
  });
});

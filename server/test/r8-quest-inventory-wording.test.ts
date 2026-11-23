// Approved tests for round-8 change 1c (PLAN.md RC1): quest-accept and inventory receipts accept the
// wording real narrators use ("yours to carry now", "fifty feet of hempen rope") while still
// rejecting prose that contradicts the receipt.
import { describe, expect, it } from "vitest";
import { providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";

const HERE = "Slake-Head";
const questAccept = {
  kind: "quest-lifecycle",
  action: "accept",
  questTitle: "The Throttle",
  statusBefore: "available",
  statusAfter: "active",
  reward: null,
};
const ropeDrop = {
  kind: "inventory",
  itemLabel: "Rope, Hempen (50 feet)",
  action: "drop",
  quantity: 1,
  slot: null,
  recipient: null,
};
const gate = (text: string, receipt: unknown) => providerNarrationMatchesReceipts(text, [receipt] as never, HERE);

describe("quest accept wording", () => {
  it("accepts synonyms for taking the job", () => {
    expect(gate("The Throttle is yours to carry now, and the clerk stamps the slate.", questAccept)).toBe(true);
    expect(gate("You take the job \u2014 The Throttle \u2014 and the foreman nods.", questAccept)).toBe(true);
    expect(gate("You sign on for The Throttle.", questAccept)).toBe(true);
  });

  it("still accepts the literal word", () => {
    expect(gate("You accept The Throttle.", questAccept)).toBe(true);
  });

  it("still rejects turning the quest down, abandoning it, or not naming it", () => {
    expect(gate("You turn down The Throttle and walk away.", questAccept)).toBe(false);
    expect(gate("You decline The Throttle.", questAccept)).toBe(false);
    expect(gate("You abandon The Throttle.", questAccept)).toBe(false);
    expect(gate("The foreman nods and you take the job.", questAccept)).toBe(false);
  });
});

describe("inventory wording", () => {
  it("accepts the core item label, a spelled-out quantity of the unit, and an implicit quantity of one", () => {
    expect(gate("The coil of hempen rope, fifty feet of it, drops to the boards with a slap.", ropeDrop)).toBe(true);
    expect(gate("You drop the hempen rope and it uncoils across the planks.", ropeDrop)).toBe(true);
  });

  it("still rejects a drop of some other item or a different action", () => {
    expect(gate("You drop your torch.", ropeDrop)).toBe(false);
    expect(gate("You pick up the hempen rope.", ropeDrop)).toBe(false);
  });

  it("still requires an explicit number when more than one is committed", () => {
    const two = { ...ropeDrop, itemLabel: "Torch", quantity: 2 };
    expect(gate("You drop the torch.", two)).toBe(false);
    expect(gate("You drop two torches.", two)).toBe(true);
  });
});

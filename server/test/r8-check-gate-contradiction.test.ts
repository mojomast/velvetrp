// Approved tests for round-8 change 1a (PLAN.md RC1): the narration gate for a committed check
// receipt accepts prose unless it states the OPPOSITE outcome, and the server appends the canonical
// mechanic line ("Your <Skill> check comes to N against <Difficulty> DC D: <outcome>.") when the
// prose does not already name the skill and state the outcome. Strings come from replayed r5-r7 drafts.
// Negative tests pin that prose which states the wrong outcome never passes.
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, fakeProvider, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

const HERE = "Slake-Head";
const base = {
  kind: "check",
  checkKind: "skill",
  mode: "normal",
  difficulty: "Medium",
  dc: 15,
} as const;
const medicineFailure = {
  ...base,
  ability: "Wisdom",
  skill: "Medicine",
  rolls: [{ value: 4, kept: true }],
  abilityModifier: 4,
  proficiencyBonus: 0,
  modifier: 4,
  total: 8,
  outcome: "failure" as const,
};
const persuasionFailure = {
  ...base,
  ability: "Charisma",
  skill: "Persuasion",
  rolls: [{ value: 9, kept: true }],
  abilityModifier: 0,
  proficiencyBonus: 0,
  modifier: 0,
  total: 9,
  outcome: "failure" as const,
};
const insightSuccess = {
  ...base,
  ability: "Wisdom",
  skill: "Insight",
  rolls: [{ value: 11, kept: true }],
  abilityModifier: 2,
  proficiencyBonus: 4,
  modifier: 6,
  total: 17,
  outcome: "success" as const,
};
const gate = (text: string, receipt: unknown) => providerNarrationMatchesReceipts(text, [receipt] as never, HERE);

describe("check receipts: prose passes unless it contradicts the committed outcome", () => {
  it("accepts a failed Medicine check narrated without the skill name or an outcome word", () => {
    expect(
      gate(
        "You run your hands over yourself, probing for the damage. Your quick read of the damage tells you little you can trust, and the clerk only shrugs.",
        medicineFailure,
      ),
    ).toBe(true);
  });

  it("accepts a failed Persuasion check where the NPC simply answers back", () => {
    expect(
      gate(
        '"Dead glass? Never heard of it," the seller says, already turning away to straighten her crates. "Ask the wardens."',
        persuasionFailure,
      ),
    ).toBe(true);
  });

  it("accepts a successful Insight check narrated as a paraphrase", () => {
    expect(
      gate("The surveyor's smile slips for a heartbeat, and you know the ground is still settling.", insightSuccess),
    ).toBe(true);
  });

  it("still accepts prose that names the skill and the matching outcome", () => {
    expect(gate("Your Medicine check fails; the wound reads worse than you hoped.", medicineFailure)).toBe(true);
    expect(gate("Your Insight check succeeds and the surveyor's tell is plain.", insightSuccess)).toBe(true);
  });
});

describe("check receipts: prose that states the wrong outcome never passes", () => {
  it("rejects success language on a failure receipt", () => {
    for (const text of [
      "You succeed in convincing him, and he hands over the ledger.",
      "Your Persuasion check succeeds and the seller leans in.",
      "It pays off: the seller tells you everything.",
      "Your attempt succeeded beyond your hopes.",
      "The gamble comes through and the clerk relents.",
      "It does the trick, and the door swings open.",
    ]) {
      expect(gate(text, persuasionFailure), text).toBe(false);
    }
  });

  it("rejects failure language on a success receipt", () => {
    for (const text of [
      "Your attempt fails and the surveyor stonewalls you.",
      "You fail to read him at all.",
      "Your Insight check falls short.",
      "It comes to nothing; the surveyor's face is a blank.",
      "Your read of him fails completely.",
    ]) {
      expect(gate(text, insightSuccess), text).toBe(false);
    }
  });
});

describe("check receipts over HTTP: prose is kept and the mechanic line is appended", () => {
  it("keeps a good draft that omits the skill name and appends the canonical line", async () => {
    enableR8Flags();
    const prose =
      "You run your hands over yourself, probing for the damage. Your quick read tells you little you can trust, and the clerk only shrugs.";
    const fake = fakeProvider({ pickSkill: "Medicine", narrate: () => prose });
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const ids = await startQuickAdventure(app);
      const turn = await playR8Turn(app, ids, "I check myself over for damage.");
      const status = turn.narrationStatus;
      expect(status.status).toBe("completed");
      expect(status.source).toBe("provider-assisted");
      expect(status.narrationOutcome).toBe("provider-accepted");
      const text = status.text ?? "";
      expect(text).toContain("clerk only shrugs");
      expect(text).toMatch(/Medicine/);
      expect(text).toMatch(/\b(?:success|failure)\b/);
      expect(text).toMatch(/comes to \d+ against Medium DC 15: (?:success|failure)\./);
    } finally {
      await app.close();
    }
  });

  it("does not append a second mechanic line when the prose already names the skill and the outcome", async () => {
    enableR8Flags();
    const fake = fakeProvider({
      pickSkill: "Medicine",
      narrate: ({ outcome }) =>
        outcome === "success"
          ? "Your Medicine check succeeds: the wound is shallow and the clerk nods."
          : "Your Medicine check fails: the wound reads worse than you hoped and the clerk winces.",
    });
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const ids = await startQuickAdventure(app);
      const turn = await playR8Turn(app, ids, "I check myself over for damage.");
      const status = turn.narrationStatus;
      expect(status.source).toBe("provider-assisted");
      expect(status.text ?? "").not.toMatch(/comes to \d+ against/);
    } finally {
      await app.close();
    }
  });

  it("falls back when the draft states the opposite of the committed outcome", async () => {
    enableR8Flags();
    const fake = fakeProvider({
      pickSkill: "Medicine",
      narrate: ({ outcome }) =>
        outcome === "success"
          ? "Your attempt fails and the wound stays a mystery to you."
          : "You succeed in reading the wound, and it is nothing at all.",
    });
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const ids = await startQuickAdventure(app);
      const turn = await playR8Turn(app, ids, "I check myself over for damage.");
      const status = turn.narrationStatus;
      expect(status.source).toBe("deterministic-fallback");
      expect(status.text ?? "").not.toMatch(/You succeed in reading|Your attempt fails/);
      expect(status.text ?? "").toMatch(/Medicine/);
    } finally {
      await app.close();
    }
  });
});

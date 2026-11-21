// Approved tests from round-2 canned-narration playtest (44/127 fallback turns).
// Live failures: natural check, travel, quest, and combat prose was discarded because the
// gate required "at/in {Location}" or "you stand/are/arrive…", plus a check's exact DC and the
// words "success"/"failure", and a combat miss's exact HP. Keep every hard mechanical ban.
import { describe, expect, it } from "vitest";
import { defaultHarnessSettings } from "../src/defaults.js";
import { adventureNarrationMessages, conversationNarrationMessages } from "../src/agent/adventurePrompt.js";
import type { ActorStateContext } from "../src/agent/actorStateContext.js";
import { deniesActiveCombatEnemy, providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";

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

const perceptionFailure = {
  ...perceptionSuccess,
  total: 10,
  rolls: [{ value: 6, kept: true }],
  outcome: "failure" as const,
};

const questAccept = {
  kind: "quest-lifecycle",
  action: "accept",
  questTitle: "Cold Glass",
};

const travelHome = { kind: "travel", destination: "Slake-Head" };

const salamanderMiss = {
  kind: "combat",
  action: "attack",
  outcome: {
    kind: "damage",
    damageType: "slashing",
    requested: 0,
    applied: 0,
    hit: false,
    critical: false,
    hitPointsBefore: 90,
    hitPointsAfter: 90,
    statusAfter: "active",
  },
  roundBefore: 1,
  roundAfter: 1,
};

const fightingSalamander: ActorStateContext = {
  health: { current: 20, max: 20 },
  resources: null,
  inventory: null,
  quests: null,
  activeCombat: {
    round: 1,
    enemies: [{ name: "salamander", hp: "90/90" }],
    allies: [],
  },
};

const promptText = (messages: Array<{ content?: string | null }>) =>
  messages.map((message) => message.content ?? "").join("\n");

describe("softer location gate on non-travel turns", () => {
  it("accepts natural prose that never says at/in Slake-Head or you stand there", () => {
    // Round-2 shape: "Rain beads on the grate as you crouch by the crates…" was rejected
    // while the actor was already at Slake-Head and no travel receipt existed.
    expect(
      providerNarrationMatchesReceipts(
        "Rain beads on the grate as you crouch by the crates, watching the moving ground.",
        [],
        HERE,
      ),
    ).toBe(true);
  });

  it("still rejects naming a different known place as the current scene", () => {
    expect(providerNarrationMatchesReceipts("You are in The Long Reflectory, watching the grate.", [], HERE)).toBe(
      false,
    );
  });
});

describe("softer check gate, hard outcome ban kept", () => {
  it("accepts a Perception success that names the skill and the result without a DC or 'at Slake-Head'", () => {
    // Round-2 regress #9: the check succeeded (17 vs DC 15) and the player still got
    // "The authoritative result is clear. Perception check: 13 rolled normal; +4 modifier gives 17 against Medium DC 15: success."
    expect(
      providerNarrationMatchesReceipts(
        "You take in the moving ground and catch the shift in the grate; your Perception work pays off.",
        [perceptionSuccess] as never,
        HERE,
      ),
    ).toBe(true);
  });

  it("rejects calling a failed check a success", () => {
    expect(
      providerNarrationMatchesReceipts(
        "Your Perception check comes to 10: a clear success.",
        [perceptionFailure] as never,
        HERE,
      ),
    ).toBe(false);
  });

  it("still rejects an invented damage number on a check turn", () => {
    expect(
      providerNarrationMatchesReceipts(
        "You take in the moving ground; your Perception work pays off and you deal 12 damage.",
        [perceptionSuccess] as never,
        HERE,
      ),
    ).toBe(false);
  });
});

describe("softer quest and travel restatement, hard arrival ban kept", () => {
  it("accepts accepting a quest without restating the current location", () => {
    // Round-2 mech #3: "Quest accepted: Cold Glass." was shown as a canned authoritative line.
    expect(
      providerNarrationMatchesReceipts(
        "You accept Cold Glass with a nod, tucking the mark away.",
        [questAccept] as never,
        HERE,
      ),
    ).toBe(true);
  });

  it("still rejects a travel receipt that names the wrong arrival", () => {
    expect(providerNarrationMatchesReceipts("You arrive at The Long Reflectory.", [travelHome] as never, HERE)).toBe(
      false,
    );
  });
});

describe("softer combat HP restatement, hard enemy and number bans kept", () => {
  it("accepts a miss that does not restate 90 HP or the current location", () => {
    // Round-2 mech #6: "I attack the salamander" missed, then "The authoritative result is clear.
    // The attack misses; no damage is applied and the target remains at 90 HP."
    expect(
      providerNarrationMatchesReceipts(
        "The blade cuts air; the salamander does not flinch.",
        [salamanderMiss] as never,
        HERE,
      ),
    ).toBe(true);
  });

  it("still rejects invented damage on a miss", () => {
    expect(
      providerNarrationMatchesReceipts(
        "The blade cuts air, then bites for 12 damage; the salamander does not fall.",
        [salamanderMiss] as never,
        HERE,
      ),
    ).toBe(false);
  });

  it("rejects provider prose that denies a listed combat enemy", () => {
    expect(deniesActiveCombatEnemy("You look around. There is no salamander here.", fightingSalamander)).toBe(true);
    expect(deniesActiveCombatEnemy("The blade cuts air; the salamander does not flinch.", fightingSalamander)).toBe(
      false,
    );
  });
});

describe("narration prompts no longer force a location or spreadsheet restatement", () => {
  const receipts = [perceptionSuccess];
  const narration = promptText(
    adventureNarrationMessages({
      declaration: "I stay up top and survey the moving ground.",
      currentLocation: HERE,
      currentActorName: "Wren",
      publicContext: {},
      receipts: receipts as never,
      history: [],
      harness: defaultHarnessSettings(),
    }),
  );
  const conversation = promptText(
    conversationNarrationMessages({
      declaration: "I ask Orra what her work is here.",
      currentLocation: HERE,
      currentActorName: "Wren",
      publicContext: {},
      history: [],
      harness: defaultHarnessSettings(),
    }),
  );

  it("drops the instruction to make current presence explicit every turn", () => {
    for (const text of [narration, conversation]) {
      expect(text).not.toMatch(/make the actor's current presence there explicit/i);
    }
  });

  it("allows omitting the place name and forbids treating another place as current", () => {
    expect(narration).toMatch(
      /omitting the (?:place )?name is allowed|may mention (?:the )?(?:current )?location when/i,
    );
    expect(narration).toMatch(/different (?:known )?place as (?:the )?(?:actor's )?current/i);
    expect(conversation).not.toMatch(/Ground every sentence in the declaration, the exact current actor location/i);
  });

  it("no longer requires a check's DC, the words success or failure, or combat HP in the prose", () => {
    expect(narration).not.toMatch(/literal words success or failure/i);
    expect(narration).not.toMatch(/exact damage dealt and the target's resulting hit points/i);
    expect(narration).toMatch(/faithful|must not invent|do not invent/i);
  });
});

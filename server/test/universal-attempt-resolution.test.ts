import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DECLARATION_CHECK_SKILL_LABELS,
  DECLARATION_CHECK_VERBS,
  declarationCheckCandidateLabel,
  mapDeclarationToCheck,
} from "../src/agent/declarationCheckMap.js";
import { orchestrateAdventureTurn, relevantCheckCandidates, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { listSystemOneDecisionsByLane } from "../src/repo/index.js";
import type { ProviderCompletionResult } from "../src/provider/index.js";
import { narrationFallback } from "../src/routes/rpg/v1/adventureTurns.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const OWNER = "local-owner";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

const STRONG_CASES: Array<[string, string, string]> = [
  ["I look around the room.", "Wisdom", "Perception"],
  ["I search the room for anything useful.", "Intelligence", "Investigation"],
  ["I climb the garden wall.", "Strength", "Athletics"],
  ["I balance on the narrow beam.", "Dexterity", "Acrobatics"],
  ["I sneak past the sleeping guards.", "Dexterity", "Stealth"],
  ["I palm the coin.", "Dexterity", "Sleight of Hand"],
  ["I persuade the ferryman to take us across.", "Charisma", "Persuasion"],
  ["I try to intimidate the ferryman.", "Charisma", "Intimidation"],
  ["I lie to the gate guard.", "Charisma", "Deception"],
  ["I sense motive on the merchant.", "Wisdom", "Insight"],
  ["I track the wounded beast into the woods.", "Wisdom", "Survival"],
  ["I bandage the sailor's wound.", "Wisdom", "Medicine"],
  ["I calm the frightened horse.", "Wisdom", "Animal Handling"],
  ["I sing for the crowded hall.", "Charisma", "Performance"],
  ["I recall what I know about magic runes.", "Intelligence", "Arcana"],
  ["I recall the history of this harbor.", "Intelligence", "History"],
  ["I recall what I know about plants.", "Intelligence", "Nature"],
  ["I recall the teachings of the old gods.", "Intelligence", "Religion"],
];

const NULL_CASES = [
  "I try to pick the lock.",
  "I do not search the room",
  "I look at my friend and say hello",
  "I climb the ladder",
  "If I search the room, what happens?",
  // Pure questions, greetings, and meta/table talk never resolve as checks.
  "Where is the ferryman?",
  "What do you think?",
  "Should we search the room?",
  "Hello there, friend.",
  "Thanks for the warning.",
  "Let's take a break.",
  "I think we should leave.",
  // Movement-only travel is not a check.
  "I go to the market.",
  "I walk to the docks.",
  "I travel to the next town.",
  // Unrelated skills are ambiguous, so null is preferred over a likely-wrong check.
  "I search for tracks.",
  "I look around and search the room.",
  "I recall the legend of the temple.",
];

describe("declaration-to-check mapping", () => {
  it.each(STRONG_CASES)("maps %s to %s %s strongly", (declaration, ability, skill) => {
    expect(mapDeclarationToCheck(declaration)).toMatchObject({ ability, skill, confidence: "strong" });
  });

  it.each(NULL_CASES)("returns null for %s", (declaration) => {
    expect(mapDeclarationToCheck(declaration)).toBeNull();
  });

  it("requires director adjudication for hazardous context", () => {
    expect(mapDeclarationToCheck("I climb the sheer icy cliff")).toMatchObject({ skill: "Athletics", confidence: "weak" });
  });
  it("returns unsupported leanings as weak, never strong", () => {
    expect(mapDeclarationToCheck("I check the door.")).toMatchObject({ ability: "Intelligence", skill: "Investigation", confidence: "weak" });
    expect(mapDeclarationToCheck("I scan the room.")).toMatchObject({ ability: "Wisdom", skill: "Perception", confidence: "weak" });
  });

  it("covers all 18 SRD skill labels with at least one strong entry", () => {
    expect(DECLARATION_CHECK_SKILL_LABELS).toHaveLength(18);
    for (const [ability, skill] of DECLARATION_CHECK_SKILL_LABELS) {
      expect(DECLARATION_CHECK_VERBS.some((value) => value.ability === ability && value.skill === skill && value.confidence === "strong"),
        `${ability} ${skill}`).toBe(true);
      expect(declarationCheckCandidateLabel({ ability, skill })).toBe(`${skill} (${ability}), Medium difficulty, normal`);
    }
  });

  it("prefers the mapped skill's Medium/normal candidate and leaves a null mapping unchanged", () => {
    const candidates = [
      { label: "History (Intelligence), Medium difficulty, normal" },
      { label: "Perception (Wisdom), Medium difficulty, normal" },
      { label: "Strength (Strength), Easy difficulty, normal" },
    ];
    // Word scoring alone selects History ("history" appears in the declaration); the Perception
    // mapping must put its Medium/normal candidate first and still keep the scored candidate.
    const ranked = relevantCheckCandidates(candidates, "I look at the history book.");
    expect(ranked[0]!.label).toBe("Perception (Wisdom), Medium difficulty, normal");
    expect(ranked).toContain(candidates[0]);
    // A greeting maps to null, so the existing word scoring and Medium/normal fallback are unchanged.
    expect(relevantCheckCandidates(candidates, "Hello there.")).toEqual([candidates[0], candidates[1]]);
  });
});

const holdCompletion = (): ProviderCompletionResult => ({ message: { role: "assistant", content: "The room waits; nothing is decided yet." },
  usage: null, model: { requestedModel: "fake-dm", responseModel: "fake-dm" } });

describe("deterministic held-attempt resolution", () => {
  it("commits the mapped Medium check when the provider holds and keeps a greeting held", async () => {
    const f = await dmFixture(true);
    try {
      const declaration = "I search the room for clues.";
      const created = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
        sessionId: f.session.id, actorId: f.actorId, declaration,
        expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: "universal-attempt" });
      let calls = 0;
      const dependencies: AdventureAgentDependencies = {
        complete: async () => { calls += 1; return holdCompletion(); },
        getProvider: async () => ({ ...defaultProviderSettings(), model: "fake-dm" }),
        getHarness: async () => defaultHarnessSettings(),
        now: f.options.clock.now,
      };

      const committed = await orchestrateAdventureTurn(f.repo, created.turnId, dependencies);
      expect(committed.outcome).toBe("mechanics-committed");
      expect(calls).toBe(1);
      expect(committed.turn.receiptLinks).toHaveLength(1);
      const receipt = f.repo.getAdventureCheckNarrationReceipt(OWNER, created.turnId, committed.turn.receiptLinks[0]!.commandId);
      expect(receipt).toMatchObject({ checkKind: "skill", ability: "Intelligence", skill: "Investigation",
        mode: "normal", difficulty: "Medium", dc: 15 });

      // The deterministic commit records an advisory-first decision row with explicit server-fallback
      // provenance, then the lane-origin execution row linked by its decision id is the evidence.
      const decisions = listSystemOneDecisionsByLane("adventure-selection", 10);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ lane: "adventure-selection", provider: "server-fallback", model: "declaration-check-map-v1",
        shadow: true, fallbackUsed: true, confidenceBand: "act", turnId: created.turnId, campaignId: f.campaign.id, sessionId: f.session.id });
      expect(decisions[0]!.selection as Record<string, unknown>).toMatchObject({ method: "server-fallback", rationale: expect.stringContaining("Investigation") });
      const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
      const execution = db.prepare("SELECT * FROM adventure_check_executions_v54 WHERE turn_id=?").get(created.turnId) as Record<string, unknown> | undefined;
      db.close();
      expect(execution).toMatchObject({ origin: "lane", system_one_decision_id: decisions[0]!.decisionId,
        provider_call_id: null, provider_tool_call_id: null, round_number: null });

      // The deterministic receipt, not the empty hold line, grounds the turn's narration.
      expect(narrationFallback(declaration, [])).toContain("The scene holds");
      expect(narrationFallback(declaration, [{ kind: "check", checkKind: receipt!.checkKind, ability: receipt!.ability, skill: receipt!.skill,
        mode: receipt!.mode, difficulty: receipt!.difficulty, rolls: receipt!.rolls, abilityModifier: receipt!.abilityModifier,
        proficiencyBonus: receipt!.proficiencyBonus, modifier: receipt!.modifier, total: receipt!.total, dc: receipt!.dc,
        outcome: receipt!.outcome }])).toContain("Investigation check");

      const greeting = f.repo.createAdventureTurn(OWNER, { campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId,
        sessionId: f.session.id, actorId: f.actorId, declaration: "Hello there, friend.",
        expectedCampaignRevision: f.repo.getCampaignAdministration(OWNER, f.campaign.id)!.revision, idempotencyKey: "universal-greeting" });
      const held = await orchestrateAdventureTurn(f.repo, greeting.turnId, dependencies);
      expect(held.outcome).toBe("completed");
      expect(held.turn.receiptLinks).toEqual([]);
      expect(listSystemOneDecisionsByLane("adventure-selection", 10)).toHaveLength(1);
    } finally { f.repo.close(); }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { adventureTurnStreamEventSchema, type ConfirmationPolicyCategory } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import {
  AUTO_COMMIT_CATEGORIES, confirmationCategoryFor, deriveConfirmationPolicy,
  policyRequiresConfirmation, requiredAuthorizerFor, requiresConfirmationFor,
} from "../src/agent/confirmationPolicy.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { cleanupTmpDataDirs, makeTmpDataDir } from "./helpers.js";
import { createReviewedAdventure } from "./fixtures/reviewedAdventure.js";

const at = "2036-01-01T00:00:00.000Z";
const policy = (toolName: string, autonomousEnemy?: boolean) => deriveConfirmationPolicy({
  toolName, arguments: {}, campaignRevision: 0, turnRevision: 0, timelineRevision: 0, at,
  ...(autonomousEnemy === undefined ? {} : { autonomousEnemy }),
});

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; delete process.env.FEATURE_RPG_COMBAT;
  cleanupTmpDataDirs();
});

describe("confirmation policy v1 rule table", () => {
  it("auto-commits only bounded, reversible, spend-free actions", () => {
    for (const toolName of ["roll", "roll_actor_dice", "inventory_item_equip", "inventory_item_unequip"]) {
      expect(policy(toolName).requiresConfirmation, toolName).toBe(false);
      expect(policyRequiresConfirmation(toolName), toolName).toBe(false);
    }
    expect(AUTO_COMMIT_CATEGORIES).toEqual(["deterministic-roll", "inventory-equip", "inventory-unequip"]);
  });

  it.each([
    ["vendor_buy", "purchase"], ["vendor_sell", "currency-transfer"], ["vendor_give", "important-item-gift"],
    ["inventory_item_drop", "important-item-loss"], ["inventory_item_consume", "important-item-consume"], ["inventory_item_gift", "important-item-gift"],
    ["power_use", "ambiguous-limited-resource-use"], ["combat_consumable_use", "ambiguous-limited-resource-use"], ["combat_power_use", "ambiguous-limited-resource-use"],
    ["rest_short", "rest-timing"], ["rest_long", "rest-timing"],
    ["quest_accept", "quest-accept"], ["quest_abandon", "quest-abandon"], ["quest_reward_claim", "quest-reward-claim"],
    ["character_progression_apply", "character-progression"], ["combat_action", "combat-action-consequential"],
    ["set_actor_attribute", "gm-override"],
  ] as const)("requires exactly one confirmation for %s (%s)", (toolName, category) => {
    const value = policy(toolName);
    expect(value.category).toBe(category);
    expect(value.requiresConfirmation).toBe(true);
    expect(policyRequiresConfirmation(toolName)).toBe(true);
  });

  it("keeps consequential player combat gated but lets the server-owned enemy turn resolve", () => {
    expect(policy("combat_action").requiresConfirmation).toBe(true);
    expect(policy("combat_action", false).requiresConfirmation).toBe(true);
    expect(policy("combat_action", true).requiresConfirmation).toBe(false);
    expect(requiresConfirmationFor("combat-action-consequential", { autonomousEnemy: true })).toBe(false);
  });

  const authorizerCases: Array<[ConfirmationPolicyCategory, "controller" | "gm"]> = [
    ["purchase", "controller"], ["currency-transfer", "controller"], ["important-item-loss", "controller"],
    ["important-item-consume", "controller"], ["important-item-gift", "controller"], ["ambiguous-limited-resource-use", "controller"],
    ["rest-timing", "controller"], ["quest-accept", "controller"], ["quest-abandon", "controller"], ["quest-reward-claim", "controller"],
    ["character-progression", "controller"], ["combat-action-consequential", "controller"],
    ["gm-override", "gm"], ["combat-start", "gm"], ["companion-change", "gm"],
    ["generated-world-change", "gm"], ["generated-quest-change", "gm"], ["generated-story-change", "gm"],
    ["ambiguous-consequential-change", "controller"],
  ];
  it.each(authorizerCases)("maps %s to the %s authorizer", (category, authorizer) => {
    expect(requiredAuthorizerFor(category)).toBe(authorizer);
  });

  it("maps unknown or ambiguous tools into the review bucket while generated changes stay GM-only", () => {
    for (const toolName of ["world_change", "story_change"]) {
      expect(confirmationCategoryFor(toolName)).toMatch(/^generated-/);
      expect(policy(toolName).requiresConfirmation).toBe(true);
      expect(policy(toolName).requiredAuthorizer).toBe("gm");
    }
    expect(confirmationCategoryFor("unknown_mutation")).toBe("ambiguous-consequential-change");
    expect(policy("unknown_mutation")).toMatchObject({ requiresConfirmation: true, requiredAuthorizer: "controller" });
    expect(confirmationCategoryFor("brand_new_tool")).toBe("ambiguous-consequential-change");
  });

  it("keeps the derived attestation policy consistent with the exported rule helper for every category", () => {
    const toolNames = ["roll", "roll_actor_dice", "inventory_item_equip", "inventory_item_unequip", "vendor_buy", "vendor_sell",
      "vendor_give", "inventory_item_drop", "inventory_item_consume", "inventory_item_gift", "power_use", "combat_consumable_use",
      "combat_power_use", "rest_short", "rest_long", "quest_accept", "quest_abandon", "quest_reward_claim",
      "character_progression_apply", "combat_action", "set_actor_attribute", "world_change", "unknown_mutation"];
    for (const toolName of toolNames) {
      const value = policy(toolName);
      expect(value.requiresConfirmation, toolName).toBe(policyRequiresConfirmation(toolName));
      expect(value.requiredAuthorizer, toolName).toBe(requiredAuthorizerFor(value.category));
    }
  });
});

const headers = { "content-type": "application/json" };
function streamEvents(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error("SSE frame has no data");
    return adventureTurnStreamEventSchema.parse(JSON.parse(data.slice(6)));
  });
}
function result(toolName: string, argumentsValue: unknown): ProviderCompletionResult {
  return { message: { role: "assistant", content: null, toolCalls: [{ id: `policy:${toolName}`, name: toolName, arguments: JSON.stringify(argumentsValue) }] },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, model: { requestedModel: "policy", responseModel: "policy" } };
}
function candidateOptions(input: ProviderCompletionInput): any[] {
  const message = input.messages.find((entry) => typeof entry.content === "string" && entry.content.startsWith("UNTRUSTED CURRENT EXACT CANDIDATE TABLE"));
  if (!message || typeof message.content !== "string") throw new Error("candidate table is unavailable");
  return JSON.parse(message.content.slice(message.content.indexOf("{"))).candidateOptions;
}

describe("single clean confirmation for a declared consequential action", () => {
  it("executes the approved quest accept on the one confirmation and never double-confirms", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; process.env.FEATURE_RPG_COMBAT = "true";
    const f = await createReviewedAdventure(makeTmpDataDir(), { prepareOptionalEncounter: false });
    const dependencies: AdventureAgentDependencies = {
      complete: async (input) => {
        if (input.promptVersion === "adventure-narration-v1") return result("submit_adventure_narration", { narration: "The keeper nods. Noted." });
        const options = candidateOptions(input);
        const accept = options.find((candidate) => candidate.toolName === "exact_quest_lifecycle.select" && candidate.label.action === "accept")!;
        return result("exact_quest_lifecycle.select", accept.arguments);
      },
      getProvider: async () => ({ ...defaultProviderSettings(), model: "policy" }), getHarness: async () => defaultHarnessSettings(),
      now: () => new Date(at),
    };
    const app = buildApp({ campaignRepositoryFactory: () => f.repo, adventureAgentDependencies: dependencies });
    const base = `/api/rpg/v1/campaigns/${f.campaignId}`;
    const administration = await app.inject({ method: "GET", url: `${base}/administration` });
    const acceptance = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
      campaignId: f.campaignId, sessionId: f.sessionId, actorId: f.actorId,
      declaration: "I accept Restore the Harbor Light.", expectedRevision: administration.json().campaign.revision, idempotencyKey: "policy-accept" } });
    const events = streamEvents(acceptance.body);
    expect(events.filter((event) => event.type === "tool_proposed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "confirmation_required")).toHaveLength(1);
    const proposal = events.find((event) => event.type === "tool_proposed");
    const terminal = events.at(-1);
    if (!proposal || proposal.type !== "tool_proposed" || !terminal || terminal.type !== "terminal") throw new Error("acceptance flow incomplete");
    expect(terminal.payload.turn.state).toBe("awaiting-confirmation");

    const confirmed = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}/confirm`, headers, payload: {
      proposalIds: [proposal.payload.proposal.proposalId], decision: "approve", expectedRevision: terminal.payload.turn.revision, idempotencyKey: "policy-accept-confirm" } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // One approval executes the declared mechanics: the turn is committed before any resume request.
    expect(confirmed.json().turn.state).toBe("mechanics-committed");

    const read = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}` });
    expect(read.json().confirmation.state).toBe("decided");
    expect(read.json().proposals).toHaveLength(1);
    expect(read.json().receipts).toHaveLength(1);
    expect(read.json().receipts[0].proposalId).toBe(proposal.payload.proposal.proposalId);

    const resumed = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: { resumeToken: confirmed.json().resumeToken } });
    expect(resumed.statusCode, resumed.body).toBe(200);
    const resumedEvents = streamEvents(resumed.body);
    expect(resumedEvents.filter((event) => event.type === "confirmation_required")).toHaveLength(0);
    expect(resumedEvents.at(-1)).toMatchObject({ type: "terminal", payload: { outcome: "done", receipts: [expect.any(Object)] } });
    expect((await app.inject({ method: "GET", url: `${base}/quests` })).json().quests)
      .toContainEqual(expect.objectContaining({ title: "Restore the Harbor Light", status: "active" }));
    await app.close();
  }, 120_000);
});

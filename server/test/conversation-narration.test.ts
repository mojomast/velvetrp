import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalAgentJson, adventureTurnStreamEventSchema } from "@velvet/contracts";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { createRepository } from "../src/repo/index.js";
import { createAgentObservationRepository } from "../src/repo/observations/agentObservationRepo.js";
import {
  conversationNarrationEligible, conversationNarrationMatches, declarationAllowsConversationNarration,
  holdNarrationIsWarranted, narrationFallback, CONVERSATION_NARRATION_PROMPT_VERSION,
} from "../src/routes/rpg/v1/adventureTurns.js";
import { VELVET_LEGACY_RULESET_DESCRIPTOR } from "../src/rulesets/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; };

/** Minimal campaign fixture mirroring the adventure route tests: one actor at a discovered public location. */
function seed() {
  const initial = createRepository();
  const campaign = initial.createCampaign("local-owner", { name: "Conversation narration" });
  initial.close();
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('profile','Profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('pack','1','profile','Pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('pack','1','race','human','Human','Race','[]'),('pack','1','background','hero','Hero','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'profile')").run(campaign.id);
  db.prepare("INSERT INTO rpg_rules_profile_bindings_v60 VALUES ('profile',?,?)")
    .run(VELVET_LEGACY_RULESET_DESCRIPTOR.id, VELVET_LEGACY_RULESET_DESCRIPTOR.version);
  db.prepare("INSERT INTO campaign_ruleset_bindings_v60(campaign_id,rules_profile_id,ruleset_id,ruleset_version,bound_at) VALUES(?,'profile',?,?,?)")
    .run(campaign.id, VELVET_LEGACY_RULESET_DESCRIPTOR.id, VELVET_LEGACY_RULESET_DESCRIPTOR.version, at);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'pack','1','profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','pack','1','race','human','pack','1','background','hero',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'local-owner',NULL)").run(campaign.id);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('quay',?,NULL,'Lantern Quay','A fog-damp landing where a bronze bell waits.','public',?)").run(campaign.id, at);
  db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'quay','session',0,?)").run(campaign.id, "actor", at);
  db.prepare("INSERT INTO campaign_location_discoveries_v28 VALUES(?,?,'quay',?)").run(campaign.id, "actor", at);
  db.close();
  return campaign;
}

const narrationResult = (narration: string): ProviderCompletionResult => ({
  message: { role: "assistant", content: null, toolCalls: [{ id: "conversation-narration", name: "submit_adventure_narration",
    arguments: JSON.stringify({ narration }) }] },
  usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 }, model: { requestedModel: "test", responseModel: "test" },
});

function dependencies(complete: AdventureAgentDependencies["complete"]): AdventureAgentDependencies {
  return { complete, getProvider: async () => ({ ...defaultProviderSettings(), model: "test" }),
    getHarness: async () => defaultHarnessSettings(), now: () => new Date(at) };
}

function events(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    return adventureTurnStreamEventSchema.parse(JSON.parse(data));
  });
}

const create = (campaignId: string, timelineId: string, declaration: string, idempotencyKey: string, priorTurnId?: string, mode?: "narration-retry" | "narration-swipe") => ({
  campaignId, timelineId, sessionId: "session", actorId: "actor", declaration, expectedCampaignRevision: 0, idempotencyKey,
  ...(priorTurnId ? { priorTurnId } : {}), ...(mode ? { mode } : {}),
});

/** Settles an original turn as a deterministic hold: completed narration with zero receipts and no proposals. */
function held(repo: ReturnType<typeof createRepository>, campaign: { id: string; activeTimelineId: string }, declaration: string, idempotencyKey: string) {
  let turn = repo.createAdventureTurn("local-owner", create(campaign.id, campaign.activeTimelineId, declaration, idempotencyKey));
  turn = repo.updateAdventureTurnNarration("local-owner", { turnId: turn.turnId, expectedTurnRevision: turn.revision, expectedCampaignRevision: 0,
    idempotencyKey: `${idempotencyKey}-progress`, narrationStatus: "in-progress" });
  return repo.updateAdventureTurnNarration("local-owner", { turnId: turn.turnId, expectedTurnRevision: turn.revision, expectedCampaignRevision: 0,
    idempotencyKey: `${idempotencyKey}-done`, narrationStatus: "completed", terminalState: "completed", fallbackNarration: narrationFallback(declaration, []) });
}

/** Settles an original turn with one committed dice roll receipt and completed narration. */
function mechanicsRoot(repo: ReturnType<typeof createRepository>, campaign: { id: string; activeTimelineId: string }, declaration: string, idempotencyKey: string) {
  const created = repo.createAdventureTurn("local-owner", create(campaign.id, campaign.activeTimelineId, declaration, idempotencyKey));
  const proposed = repo.appendToolProposal("local-owner", { turnId: created.turnId, toolName: "roll", arguments: {}, requiresConfirmation: false,
    expectedTurnRevision: created.revision, expectedCampaignRevision: 0, idempotencyKey: `${idempotencyKey}-proposal` });
  const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
  const command = repo.executeRollActorDice("local-owner", { commandId: `${idempotencyKey}-command`,
    idempotencyKey: proposed.toolCalls[0]!.proposal.executionBinding.idempotencyKey, campaignId: campaign.id, timelineId: campaign.activeTimelineId,
    actorId: "actor", expectedRevision: 0, sourceTurnId: created.turnId, command: { type: "roll_actor_dice", payload: { expression: "1d20+8" } } });
  let turn = repo.linkFinalMechanicsReceipt("local-owner", { turnId: created.turnId, proposalId, commandId: command.commandId,
    expectedTurnRevision: proposed.revision, expectedCampaignRevision: 0, idempotencyKey: `${idempotencyKey}-link` });
  turn = repo.updateAdventureTurnNarration("local-owner", { turnId: turn.turnId, expectedTurnRevision: turn.revision, expectedCampaignRevision: 0,
    idempotencyKey: `${idempotencyKey}-progress`, narrationStatus: "in-progress" });
  return repo.updateAdventureTurnNarration("local-owner", { turnId: turn.turnId, expectedTurnRevision: turn.revision, expectedCampaignRevision: 0,
    idempotencyKey: `${idempotencyKey}-done`, narrationStatus: "completed", terminalState: "completed", fallbackNarration: "The dice are committed." });
}

const variant = (app: ReturnType<typeof buildApp>, campaignId: string, priorTurnId: string, idempotencyKey: string,
  mode: "narration-retry" | "narration-swipe" = "narration-swipe") =>
  app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" },
    payload: { variant: mode, campaignId, sessionId: "session", actorId: "actor", priorTurnId, expectedRevision: 0, idempotencyKey } });

describe("conversation narration for held turns", () => {
  it("narrates original social and observation holds with present NPC knowledge and no invented mechanics", async () => {
    enable();
    const campaign = seed(), repo = createRepository({ clock: { now: () => new Date(at) } });
    const persona = repo.createCharacter({ name: "Maren", age: 40, archetype: "Keeper", boundaries: "", fictionalConfirmed: true });
    repo.createNpc("local-owner", { campaignId: campaign.id, npcId: "maren", personaId: persona.id, name: "Maren", speechControl: "manual" });
    repo.mutateNpcPresence("local-owner", { campaignId: campaign.id, sessionId: "session", npcId: "maren",
      expectedRevision: 0, idempotencyKey: "maren-present", mutation: { kind: "place", locationId: "quay" } });
    repo.createLocation("local-owner", { campaignId: campaign.id, locationId: "remote", name: "Remote Camp", description: "Far away." });
    for (const npcId of ["remote-witness", "absent-witness"]) {
      const witness = repo.createCharacter({ name: npcId, age: 30, archetype: "Witness", boundaries: "", fictionalConfirmed: true });
      repo.createNpc("local-owner", { campaignId: campaign.id, npcId, personaId: witness.id, name: npcId, speechControl: "manual" });
    }
    repo.mutateNpcPresence("local-owner", { campaignId: campaign.id, sessionId: "session", npcId: "remote-witness",
      expectedRevision: 1, idempotencyKey: "witness-remote", mutation: { kind: "place", locationId: "remote" } });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    let sequence = 0;
    const ledger = createAgentObservationRepository(db, { clock: { now: () => new Date(at) }, ids: { nextId: () => `social-knowledge-${++sequence}` } });
    for (const [authority, text] of [["verified", "The road's old bridge is closed."], ["rumor", "ROAD-PRIVATE-RUMOR"]] as const) {
      ledger.record({ campaignId: campaign.id, timelineId: campaign.activeTimelineId, agentKind: "npc", agentId: "maren",
        sourceCommandId: `social-observation-${authority}`, observedRevision: 0, channel: "witnessed", hopCount: 0, text, authority });
    }
    for (const agentId of ["remote-witness", "absent-witness"]) ledger.record({ campaignId: campaign.id,
      timelineId: campaign.activeTimelineId, agentKind: "npc", agentId, sourceCommandId: `observation-${agentId}`,
      observedRevision: 0, channel: "witnessed", hopCount: 0, text: `The road has OFFSCENE-KNOWLEDGE-${agentId}.`, authority: "verified" });
    db.close();
    const calls: ProviderCompletionInput[] = [];
    const prose = 'Maren answers, "The old bridge is closed. What part of the road concerns you?"';
    const replies = [prose, 'Maren asks, "What kind of work are you looking for?"',
      'Maren asks, "What brings you here?"', "A bronze bell waits at the fog-damp landing."];
    let narrationCount = 0;
    const app = buildApp({ campaignRepositoryFactory: () => repo, adventureAgentDependencies: dependencies(async input => {
      calls.push(input);
      return input.tools?.some(tool => tool.name === "submit_adventure_narration") ? narrationResult(replies[narrationCount++]!)
        : { message: { role: "assistant", content: "No mechanical action is needed." }, usage: null,
          model: { requestedModel: "test", responseModel: "test" } };
    }) });
    try {
      for (const [index, declaration] of ["I walk over to Maren and ask her what she knows about trouble on the road.",
        "I ask Maren whether anyone has work for a traveler.", "I find Maren and ask what she makes of strangers.",
        "I look around the quay."].entries()) {
        const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
          payload: { campaignId: campaign.id, sessionId: "session", actorId: "actor", declaration,
            expectedRevision: 0, idempotencyKey: `original-social-${index}` } });
        expect(response.statusCode, response.body).toBe(200);
        expect(calls.at(-1)?.promptVersion, JSON.stringify(calls.map(call => ({ promptVersion: call.promptVersion, tools: call.tools?.map(tool => tool.name) }))))
          .toBe(CONVERSATION_NARRATION_PROMPT_VERSION);
        expect(events(response.body).at(-1), declaration).toMatchObject({ type: "terminal", payload: {
          outcome: "done", receipts: [], narrationStatus: { text: replies[index], source: "provider-assisted" },
        } });
        expect(events(response.body).some(event => event.type === "tool_proposed")).toBe(false);
        const narration = calls.at(-1)!;
        expect(narration.promptVersion).toBe(CONVERSATION_NARRATION_PROMPT_VERSION);
        if (index === 0) expect(JSON.stringify(narration.messages)).toContain("The road's old bridge is closed.");
        expect(JSON.stringify(narration.messages)).not.toContain("ROAD-PRIVATE-RUMOR");
        expect(JSON.stringify(narration.messages)).not.toContain("OFFSCENE-KNOWLEDGE");
        const context = JSON.parse(String(narration.messages[1]!.content).split("\n\n").at(-1)!).publicCampaignContext;
        expect(context.presentNpcNames).toEqual(["Maren"]);
        expect(narration.messages[0]!.content).toContain("Only NPCs listed in presentNpcNames");
      }
      expect(calls.filter(call => call.promptVersion === CONVERSATION_NARRATION_PROMPT_VERSION)).toHaveLength(4);
    } finally { await app.close(); }
  });

  it("rejects unreceipted mechanical gains from the original conversation narrator", async () => {
    enable();
    const campaign = seed(), repo = createRepository({ clock: { now: () => new Date(at) } });
    const app = buildApp({ campaignRepositoryFactory: () => repo, adventureAgentDependencies: dependencies(async input =>
      input.tools?.some(tool => tool.name === "submit_adventure_narration") ? narrationResult("You gain a sword.")
        : { message: { role: "assistant", content: "No mechanics." }, usage: null,
          model: { requestedModel: "test", responseModel: "test" } }) });
    try {
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
        payload: { campaignId: campaign.id, sessionId: "session", actorId: "actor", declaration: "I ask about work.",
          expectedRevision: 0, idempotencyKey: "original-social-no-gain" } });
      expect(events(response.body).at(-1)).toMatchObject({ type: "terminal", payload: { receipts: [],
        narrationStatus: { source: "deterministic-fallback", text: narrationFallback("I ask about work.", []) } } });
    } finally { await app.close(); }
  });

  it("distinguishes conversation topics and local approaches from unresolved mechanical actions", () => {
    for (const declaration of ["I ask the dockhands about the road.", "I ask Maren whether anyone has work.",
      "I walk over to Maren and ask about the road.", "I find Maren and ask about strangers.", "I look around the quay."]) {
      expect(declarationAllowsConversationNarration(declaration, ["Maren"]), declaration).toBe(true);
      expect(holdNarrationIsWarranted({ reason: "no-advertised-match", message: "No exact match.",
        suggestedNextStep: "Travel to Docks", suggestedCandidateId: "docks" }, declaration, ["Maren"])).toBe(false);
    }
    for (const declaration of ["I walk over to Docks and ask about the road.", "I attack Maren and ask about work.",
      "I ask Maren and then buy a sword.", "I travel to the Sunken Cathedral.", "I search for hidden doors.", "I take a short rest."]) {
      expect(declarationAllowsConversationNarration(declaration, ["Maren"]), declaration).toBe(false);
    }
  });

  it.each([
    "I take a slow look around the market square and take stock of who and what is here.",
    "I take a look around the market square.",
    "I have a quick look around the market square.",
    "I take a careful look around the market square.",
    "I take stock of who and what is here.",
    "I take stock of what is here.",
  ])("allows routine observation phrasing: %s", declaration => {
    expect(declarationAllowsConversationNarration(declaration)).toBe(true);
    expect(holdNarrationIsWarranted({ reason: "no-advertised-match", message: "No exact match.",
      suggestedNextStep: "Travel to Docks", suggestedCandidateId: "docks" }, declaration)).toBe(false);
  });

  it.each([
    "I take a careful look around for hidden doors.",
    "I take a slow look around, searching for traps.",
    "I take a slow look around and take a sword.",
    "I take stock of who and what is here and attack the guard.",
    "I have a quick look around and then travel to the Docks.",
    "I look around with a Perception check.",
    "I look around and climb the wall.",
  ])("keeps uncertain or compound mechanical observation out of conversation: %s", declaration => {
    expect(declarationAllowsConversationNarration(declaration)).toBe(false);
  });

  it("persists provider conversation prose for a held turn's narration derivative without receipts or state changes", async () => {
    enable();
    const campaign = seed(), repo = createRepository();
    const original = held(repo, campaign, "I greet the keeper at the quay and ask about the fog", "conversation-hold");
    const calls: ProviderCompletionInput[] = [];
    const prose = "At Lantern Quay, the keeper looks up from the bell rope and answers in a low voice. \"The fog came in with the evening tide,\" she says, and waits.";
    const app = buildApp({ campaignRepositoryFactory: () => repo,
      adventureAgentDependencies: dependencies(async (input) => { calls.push(input); return narrationResult(prose); }) });
    const response = await variant(app, campaign.id, original.turnId, "conversation-swipe");
    expect(response.statusCode, response.body).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.promptVersion).toBe(CONVERSATION_NARRATION_PROMPT_VERSION);
    expect(calls[0]!.toolChoice).toEqual({ name: "submit_adventure_narration" });
    expect(calls[0]!.tools?.map((tool) => tool.name)).toEqual(["submit_adventure_narration"]);
    const system = calls[0]!.messages[0]!.content!;
    expect(system).toContain("IMMUTABLE CONVERSATION NARRATION AUTHORITY");
    expect(system).not.toContain("IMMUTABLE ADVENTURE NARRATION AUTHORITY");
    expect(system).toContain(canonicalAgentJson(VELVET_LEGACY_RULESET_DESCRIPTOR as never));
    const serialized = JSON.stringify(calls[0]!.messages);
    expect(serialized).toContain("I greet the keeper at the quay and ask about the fog");
    expect(serialized).toContain("Lantern Quay");
    expect(serialized).toContain("heldTurnWithoutMechanics");
    expect(serialized).not.toContain("verifiedReceiptFacts");
    const terminal = events(response.body).at(-1);
    expect(terminal).toMatchObject({ type: "terminal", payload: { outcome: "done", receipts: [],
      narrationStatus: { status: "completed", text: prose, source: "provider-assisted" } } });
    if (terminal?.type !== "terminal") throw new Error("terminal missing");
    const read = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${terminal.payload.turn.turnId}` });
    expect(read.json()).toMatchObject({ turn: { state: "completed", mode: "narration-swipe" }, receipts: [],
      narrationStatus: { status: "completed", text: prose, source: "provider-assisted" } });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(db.prepare("SELECT count(*) count FROM turn_mechanics_links_v36 WHERE root_turn_id=?").get(original.turnId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM campaign_commands WHERE source_turn_id=?").get(original.turnId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id='actor'").get(campaign.id)).toEqual({ count: 1 });
    db.close();
    await app.close();
  });

  it("keeps the receipt-bound path for a mechanics turn even when the provider returns conversation prose", async () => {
    enable();
    const campaign = seed(), repo = createRepository();
    const original = mechanicsRoot(repo, campaign, "I read the entrails of the bell rope", "conversation-mechanics");
    const calls: ProviderCompletionInput[] = [];
    const app = buildApp({ campaignRepositoryFactory: () => repo,
      adventureAgentDependencies: dependencies(async (input) => { calls.push(input); return narrationResult("At Lantern Quay, the keeper answers quietly."); }) });
    const response = await variant(app, campaign.id, original.turnId, "conversation-mechanics-retry", "narration-retry");
    expect(calls[0]!.promptVersion).toBe("adventure-narration-v1");
    const system = calls[0]!.messages[0]!.content!;
    expect(system).toContain("IMMUTABLE ADVENTURE NARRATION AUTHORITY");
    expect(system).not.toContain("IMMUTABLE CONVERSATION NARRATION AUTHORITY");
    const terminal = events(response.body).at(-1);
    expect(terminal).toMatchObject({ type: "terminal", payload: { outcome: "done", receipts: [expect.any(Object)],
      narrationStatus: { source: "deterministic-fallback" } } });
    if (terminal?.type !== "terminal") throw new Error("terminal missing");
    expect(terminal.payload.narrationStatus.text).toContain("The authoritative result is clear. The dice come up");
    await app.close();
  });

  it("keeps the deterministic hold line when the conversation provider fails", async () => {
    enable();
    const campaign = seed(), repo = createRepository();
    const declaration = "I listen to the bell and wait for an answer";
    const original = held(repo, campaign, declaration, "conversation-failure");
    const app = buildApp({ campaignRepositoryFactory: () => repo,
      adventureAgentDependencies: dependencies(async () => { throw new Error("provider unavailable"); }) });
    const response = await variant(app, campaign.id, original.turnId, "conversation-failure-swipe");
    expect(events(response.body).at(-1)).toMatchObject({ type: "terminal", payload: { outcome: "done", receipts: [],
      narrationStatus: { status: "completed", source: "deterministic-fallback", text: narrationFallback(declaration, []) } } });
    await app.close();
  });

  it("does not use conversation narration for a derivative of a derivative", async () => {
    enable();
    const campaign = seed(), repo = createRepository();
    const original = held(repo, campaign, "I listen for gulls beyond the fog", "conversation-chain-root");
    let first = repo.createAdventureTurn("local-owner", create(campaign.id, campaign.activeTimelineId, original.declaration, "conversation-chain-first",
      original.turnId, "narration-retry"));
    first = repo.updateAdventureTurnNarration("local-owner", { turnId: first.turnId, expectedTurnRevision: first.revision, expectedCampaignRevision: 0,
      idempotencyKey: "conversation-chain-first-progress", narrationStatus: "in-progress" });
    repo.updateAdventureTurnNarration("local-owner", { turnId: first.turnId, expectedTurnRevision: first.revision, expectedCampaignRevision: 0,
      idempotencyKey: "conversation-chain-first-done", narrationStatus: "completed", terminalState: "completed", fallbackNarration: "The first answer." });
    const calls: ProviderCompletionInput[] = [];
    const prose = "At Lantern Quay, the gulls wheel overhead and the bell stays still.";
    const app = buildApp({ campaignRepositoryFactory: () => repo,
      adventureAgentDependencies: dependencies(async (input) => { calls.push(input); return narrationResult(prose); }) });
    const response = await variant(app, campaign.id, first.turnId, "conversation-chain-swipe");
    expect(calls[0]!.promptVersion).toBe("adventure-narration-v1");
    expect(calls[0]!.messages[0]!.content).toContain("IMMUTABLE ADVENTURE NARRATION AUTHORITY");
    expect(events(response.body).at(-1)).toMatchObject({ type: "terminal", payload: { receipts: [],
      narrationStatus: { text: prose, source: "provider-assisted" } } });
    await app.close();
  });

  it("validates conversation output as bounded and free of mechanical claims", () => {
    expect(conversationNarrationMatches("At Lantern Quay, the keeper answers quietly and waits.", "Lantern Quay")).toBe(true);
    expect(conversationNarrationMatches("The keeper answers quietly and waits.", "Lantern Quay")).toBe(true);
    expect(conversationNarrationMatches("", null)).toBe(false);
    expect(conversationNarrationMatches("x".repeat(2_001), null)).toBe(false);
    expect(conversationNarrationMatches(Array.from({ length: 121 }, () => "word").join(" "), null)).toBe(false);
    for (const claim of ["You take 7 damage.", "You gain a sword.", "You lose 2 gold.", "You arrive at Black Berth.", "The quest is completed.", "You level up."]) {
      expect(conversationNarrationMatches(claim, null), claim).toBe(false);
    }
  });

  it("rejects guards that would permit a receipt-free derivative of anything but a settled original hold", () => {
    const derivative = { mode: "narration-swipe", priorTurnId: "prior-turn", receiptLinks: [] as unknown[] };
    const hold = { mode: "original", state: "completed", receiptLinks: [] as unknown[],
      toolCalls: [] as Array<{ status: string; proposal: { confirmation: { state: string } } }> };
    expect(conversationNarrationEligible(derivative, hold)).toBe(true);
    expect(conversationNarrationEligible(derivative, null)).toBe(false);
    expect(conversationNarrationEligible({ ...derivative, mode: "original", priorTurnId: null }, hold)).toBe(false);
    expect(conversationNarrationEligible({ ...derivative, receiptLinks: [{}] }, hold)).toBe(false);
    expect(conversationNarrationEligible(derivative, { ...hold, mode: "narration-retry", receiptLinks: [{}] })).toBe(false);
    expect(conversationNarrationEligible(derivative, { ...hold, receiptLinks: [{}] })).toBe(false);
    expect(conversationNarrationEligible(derivative, { ...hold, state: "cancelled" })).toBe(false);
    expect(conversationNarrationEligible(derivative, { ...hold, state: "failed" })).toBe(false);
    expect(conversationNarrationEligible(derivative, { ...hold, toolCalls: [
      { status: "waiting-confirmation", proposal: { confirmation: { state: "pending" } } }] })).toBe(false);
    expect(conversationNarrationEligible(derivative, { ...hold, toolCalls: [
      { status: "approved", proposal: { confirmation: { state: "not-required" } } }] })).toBe(false);
  });
});

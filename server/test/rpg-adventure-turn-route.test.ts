import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adventureTurnStreamEventSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { createRepository } from "../src/repo/index.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const expires = "2099-01-01T00:00:00.000Z";
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; delete process.env.VELVET_SSE_HEARTBEAT_MS; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; };

function seed() {
  const initial = createRepository();
  const campaign = initial.createCampaign("local-owner", { name: "HTTP turns" });
  initial.close();
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('turn-profile','Turn profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('turn-pack','1','turn-profile','Turn pack','Pack','[]',0)").run();
  db.prepare("INSERT INTO rpg_definitions VALUES ('turn-pack','1','race','human','Human','Race','[]'),('turn-pack','1','background','hero','Hero','Background','[]')").run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='turn-pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'turn-pack','1','turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','turn-pack','1','race','human','turn-pack','1','background','hero',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
  db.close();
  return campaign;
}

function events(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    return adventureTurnStreamEventSchema.parse(JSON.parse(data));
  });
}

describe("M2.11 adventure turn routes", () => {
  it("persists fallback narration, replays duplicate initial requests, and reconciles after restart", async () => {
    enable(); process.env.VELVET_SSE_HEARTBEAT_MS = "1"; const campaign = seed();
    const payload = { campaignId: campaign.id, sessionId: "session", actorId: "actor", declaration: "I study the quiet door",
      expectedRevision: 0, idempotencyKey: "initial" };
    let app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const first = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload });
    expect(first.statusCode).toBe(200); expect(first.headers["content-type"]).toContain("text/event-stream");
    expect(first.headers["cache-control"]).toBe("private, no-store, no-transform");
    expect(first.body).toContain(": heartbeat\n\n");
    const firstEvents = events(first.body); expect(firstEvents.map(({ type }) => type)).toEqual([
      "turn_started", "agent_status", "agent_status", "narration_delta", "terminal",
    ]);
    expect(firstEvents.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);
    const started = firstEvents.find((event) => event.type === "turn_started");
    if (!started || started.type !== "turn_started") throw new Error("turn_started missing");
    const turnId = started.payload.turn.turnId;
    const duplicate = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload });
    expect(events(duplicate.body).at(-1)).toMatchObject({ type: "terminal", payload: { outcome: "done", turn: { turnId } } });
    await app.close();

    app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const read = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turnId}` });
    expect(read.statusCode).toBe(200); expect(read.json()).toMatchObject({ turn: { turnId, state: "completed" }, proposals: [], receipts: [],
      narrationStatus: { status: "completed", text: expect.stringContaining("without changing campaign state") } });
    expect(read.body).not.toMatch(/providerCalls|argumentsJson|principalId/);
    await app.close();
  });

  it("seals duplicate confirmation and validates a restart-safe resume token", async () => {
    enable(); const campaign = seed(); const repo = createRepository();
    const turn = repo.createAdventureTurn("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "I open it", expectedCampaignRevision: 0, idempotencyKey: "confirm-turn" });
    const proposed = repo.appendToolProposal("local-owner", { turnId: turn.turnId, toolName: "roll", arguments: {}, requiresConfirmation: true,
      confirmationExpiresAt: expires, expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "proposal" });
    repo.waitForToolConfirmation("local-owner", { turnId: turn.turnId, expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "wait" });
    const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const payload = { proposalIds: [proposalId], decision: "approve", expectedRevision: 2, idempotencyKey: "confirm" };
    const first = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${turn.turnId}/confirm`, headers: { "content-type": "application/json" }, payload });
    const second = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${turn.turnId}/confirm`, headers: { "content-type": "application/json" }, payload });
    expect(first.statusCode).toBe(200); expect(second.json()).toEqual(first.json()); expect(first.json().resumeToken).toMatch(/^v1\./);
    await app.close();
    const restarted = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const resumed = await restarted.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload: { resumeToken: first.json().resumeToken } });
    expect(events(resumed.body).map(({ type }) => type)).toEqual(["agent_status", "agent_status", "terminal"]);
    expect(resumed.body).not.toContain("turn_started"); expect(resumed.body).not.toContain("mechanics_committed");
    await restarted.close();
  });

  it("streams durable proposal, atomic confirmation, crash receipt recovery, and resumed narration without rerunning mechanics", async () => {
    enable(); const campaign = seed(); let repo = createRepository();
    const create = { campaignId: campaign.id, timelineId: campaign.activeTimelineId, sessionId: "session", actorId: "actor",
      declaration: "I test the ancient lock", expectedCampaignRevision: 0, idempotencyKey: "full-turn" };
    const turn = repo.createAdventureTurn("local-owner", create);
    const proposed = repo.appendToolProposal("local-owner", { turnId: turn.turnId, toolName: "roll", arguments: {}, requiresConfirmation: true,
      confirmationExpiresAt: expires, expectedTurnRevision: 0, expectedCampaignRevision: 0, idempotencyKey: "full-proposal" });
    repo.waitForToolConfirmation("local-owner", { turnId: turn.turnId, expectedTurnRevision: 1, expectedCampaignRevision: 0, idempotencyKey: "full-wait" });
    let app = buildApp({ campaignRepositoryFactory: () => repo });
    const waiting = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload: {
      campaignId: campaign.id, sessionId: "session", actorId: "actor", declaration: create.declaration, expectedRevision: 0, idempotencyKey: create.idempotencyKey,
    } });
    expect(events(waiting.body).map(({ type }) => type)).toEqual([
      "turn_started", "agent_status", "tool_proposed", "confirmation_required", "terminal",
    ]);
    expect(waiting.body).not.toMatch(/executionBinding|mechanics:[a-f0-9]+/);
    const proposalId = proposed.toolCalls[0]!.proposal.proposalId;
    const confirmed = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${turn.turnId}/confirm`, headers: { "content-type": "application/json" },
      payload: { proposalIds: [proposalId], decision: "approve", expectedRevision: 2, idempotencyKey: "full-confirm" } });
    expect(confirmed.statusCode).toBe(200); const token = confirmed.json().resumeToken as string;
    await app.close();

    repo = createRepository();
    repo.executeRollActorDice("local-owner", { commandId: "full-command", idempotencyKey: proposed.toolCalls[0]!.proposal.executionBinding.idempotencyKey, campaignId: campaign.id,
      timelineId: campaign.activeTimelineId, actorId: "actor", expectedRevision: 0, sourceTurnId: turn.turnId,
      command: { type: "roll_actor_dice", payload: { expression: "1d20" } } });
    repo.close();
    app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const recovered = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${turn.turnId}` });
    expect(recovered.json()).toMatchObject({ turn: { state: "mechanics-committed" }, receipts: [{ commandId: "full-command", proposalId }] });
    const before = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(before.prepare("SELECT count(*) count FROM turn_mechanics_links_v36 WHERE turn_id=?").get(turn.turnId)).toEqual({ count: 0 }); before.close();
    const resumed = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload: { resumeToken: token } });
    expect(events(resumed.body).map(({ type }) => type)).toEqual([
      "agent_status", "mechanics_committed", "agent_status", "narration_delta", "terminal",
    ]);
    const after = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect(after.prepare("SELECT count(*) count FROM turn_mechanics_links_v36 WHERE turn_id=?").get(turn.turnId)).toEqual({ count: 1 });
    expect(after.prepare("SELECT count(*) count FROM campaign_commands WHERE source_turn_id=?").get(turn.turnId)).toEqual({ count: 1 }); after.close();
    await app.close();
  });

  it("finishes deterministic durable orchestration after delivery disconnect", async () => {
    enable(); const campaign = seed(); const app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/rpg/v1/adventure-turns/stream`, { method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ campaignId: campaign.id, sessionId: "session", actorId: "actor",
        declaration: "I wait beside the arch", expectedRevision: 0, idempotencyKey: "disconnect-turn" }) });
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let received = "";
    while (!received.includes("event: turn_started")) received += decoder.decode((await reader.read()).value, { stream: true });
    const match = received.match(/data: (\{[^\n]+\})/); if (!match) throw new Error("turn_started data missing");
    const started = adventureTurnStreamEventSchema.parse(JSON.parse(match[1]!));
    if (started.type !== "turn_started") throw new Error("unexpected first event");
    controller.abort(); await new Promise((resolve) => setTimeout(resolve, 50));
    const reconciled = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${started.payload.turn.turnId}` });
    expect(reconciled.json()).toMatchObject({ turn: { state: "completed" }, narrationStatus: { status: "completed" } });
    await app.close();
  });

  it("gates before access and returns heartbeat-safe redacted framing and problems", async () => {
    let accesses = 0;
    const app = buildApp({ campaignRepositoryFactory: () => { accesses += 1; return { close() {}, listCampaigns: () => [] } as unknown as CampaignListRepository; } });
    const gated = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream?private=1", headers: { "content-type": "application/json" }, payload: {} });
    expect(gated.statusCode).toBe(404); expect(accesses).toBe(0); expect(gated.body).not.toContain("private=1");
    enable();
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream?private=1", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/adventure-turns/private-turn/confirm" })).json()).toMatchObject({
      code: "RPG_ROUTE_NOT_FOUND", instance: "/api/rpg/v1/adventure-turns/:turnId/confirm",
    });
    await app.close();
  });
});

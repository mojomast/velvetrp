import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adventureTurnStreamEventSchema } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import type { ProviderCompletionInput, ProviderCompletionResult } from "../src/provider/index.js";
import { cleanupTmpDataDirs, makeTmpDataDir } from "./helpers.js";
import { createReviewedAdventure } from "./fixtures/reviewedAdventure.js";

const OWNER = "local-owner";
const headers = { "content-type": "application/json" };
const at = "2036-01-01T00:00:00.000Z";

/** A mutable journey RNG: deterministic `minimum` by default, forced to 1 for the interruption. */
let forcedRng: number | null = null;
const journeyRng = { integer: (minimum: number, _maximum: number) => forcedRng ?? minimum };

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  forcedRng = null;
  cleanupTmpDataDirs();
});

type Fixture = Awaited<ReturnType<typeof createReviewedAdventure>>;

function streamEvents(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error("SSE frame has no data");
    return adventureTurnStreamEventSchema.parse(JSON.parse(data.slice(6)));
  });
}

const narrationResult = (narration: string): ProviderCompletionResult => ({
  message: { role: "assistant", content: null,
    toolCalls: [{ id: "journey-narration", name: "submit_adventure_narration", arguments: JSON.stringify({ narration }) }] },
  usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
  model: { requestedModel: "journey", responseModel: "journey" },
});

/**
 * Narration-only provider. The orchestrator's deterministic journey branch must return
 * before planning, so any call that is not the single narration tool is a hard failure.
 */
function journeyDependencies(completions: ProviderCompletionInput[]): AdventureAgentDependencies {
  return {
    complete: async (input) => {
      completions.push(input);
      if (!input.tools?.some((tool) => tool.name === "submit_adventure_narration")) {
        throw new Error("planning provider call is not allowed for a deterministic journey");
      }
      return narrationResult("The moment holds.");
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "journey-narration" }),
    getHarness: async () => defaultHarnessSettings(),
    now: () => new Date(at),
  };
}

/** Public A(quay) -> B -> C route; A is the reviewed starting location. */
function seedRoute(fixture: Fixture) {
  const a = fixture.resourceIds["lantern-quay"];
  if (!a) throw new Error("reviewed starting location is missing");
  fixture.repo.createLocation(OWNER, { campaignId: fixture.campaignId, locationId: "journey-millers",
    name: "Miller's Crossing", description: "A waystation where the road bends." });
  fixture.repo.createLocation(OWNER, { campaignId: fixture.campaignId, locationId: "journey-lasalle",
    name: "Place La Salle", description: "A public square at the end of the road." });
  const aToB = fixture.repo.createLocationConnection(OWNER, { campaignId: fixture.campaignId,
    fromLocationId: a, toLocationId: "journey-millers" }).locationConnectionId;
  const bToC = fixture.repo.createLocationConnection(OWNER, { campaignId: fixture.campaignId,
    fromLocationId: "journey-millers", toLocationId: "journey-lasalle" }).locationConnectionId;
  return { a, b: "journey-millers", c: "journey-lasalle", aToB, bToC };
}

function setRouteProfile(directory: string, campaignId: string, connectionId: string): void {
  const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"));
  try {
    db.prepare("INSERT INTO world_route_event_profiles_v1(campaign_id,connection_id,environment,risk,chance_percent) VALUES(?,?,?,?,?)")
      .run(campaignId, connectionId, "road", "dangerous", 100);
  } finally { db.close(); }
}

function readOnly<T>(directory: string, query: (db: DatabaseDriver.Database) => T): T {
  const db = new DatabaseDriver(path.join(directory, "velvet.sqlite"), { readonly: true });
  try { return query(db); } finally { db.close(); }
}
const travelCommandCount = (directory: string, campaignId: string, sessionId: string): number =>
  readOnly(directory, (db) => (db.prepare("SELECT count(*) n FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND command_type='travel'")
    .get(campaignId, sessionId) as { n: number }).n);
const actorLocation = (directory: string, campaignId: string, sessionId: string, actorId: string): string | undefined =>
  readOnly(directory, (db) => (db.prepare("SELECT location_id FROM campaign_actor_locations_v28 WHERE campaign_id=? AND session_id=? AND actor_id=?")
    .get(campaignId, sessionId, actorId) as { location_id: string } | undefined)?.location_id);

function enableFlags() {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
}

describe("actor journey HTTP integration", () => {
  it("resolves an explicit 'i move to place lasalle' declaration without planning and commits both legs", async () => {
    enableFlags();
    const directory = makeTmpDataDir();
    const fixture = await createReviewedAdventure(directory, { prepareOptionalEncounter: false, rng: journeyRng });
    const { repo, campaignId, sessionId, actorId } = fixture;
    const route = seedRoute(fixture);
    expect(actorLocation(directory, campaignId, sessionId, actorId)).toBe(route.a);
    const completions: ProviderCompletionInput[] = [];
    const app = buildApp({ campaignRepositoryFactory: () => repo, adventureAgentDependencies: journeyDependencies(completions) });
    try {
      const expectedRevision = repo.getCampaignAdministration(OWNER, campaignId)!.revision;
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        campaignId, sessionId, actorId, declaration: "i move to place lasalle", expectedRevision, idempotencyKey: "journey-completed",
      } });
      expect(response.statusCode, response.body).toBe(200);
      const events = streamEvents(response.body);
      const committed = events.find((event) => event.type === "mechanics_committed");
      expect(committed).toMatchObject({ type: "mechanics_committed", payload: { receipts: [expect.objectContaining({ proposalId: null })] } });
      const terminal = events.at(-1);
      if (!terminal || terminal.type !== "terminal") throw new Error("terminal event is missing");
      expect(terminal.payload).toMatchObject({ outcome: "done", receipts: [expect.objectContaining({ proposalId: null })] });
      // The deterministic branch never reaches provider planning.
      expect(completions.length).toBeGreaterThan(0);
      expect(completions.every((call) => call.tools?.every((tool) => tool.name === "submit_adventure_narration"))).toBe(true);
      // Provider prose fails the journey gate, so the authoritative fallback names the committed arrival.
      const narration = terminal.payload.narrationStatus.text ?? "";
      expect(narration).toContain("Place La Salle");
      expect(narration.toLowerCase()).toContain("arrive");
      const commandId = terminal.payload.receipts[0]!.commandId;
      const receipt = repo.getActorJourneyNarrationReceipt(OWNER, terminal.payload.turn.turnId, commandId);
      expect(receipt).toMatchObject({ status: "completed", requestedDestinationLocationId: route.c, currentLocationId: route.c });
      expect(receipt!.path).toHaveLength(2);
      expect(travelCommandCount(directory, campaignId, sessionId)).toBe(2);
      expect(actorLocation(directory, campaignId, sessionId, actorId)).toBe(route.c);
      expect(receipt!.commandId).toBe(commandId);
    } finally { await app.close(); repo.close(); }
  });

  it("interrupts a forced B->C event, retains the requested destination, then completes on 'continue journey'", async () => {
    enableFlags();
    const directory = makeTmpDataDir();
    const fixture = await createReviewedAdventure(directory, { prepareOptionalEncounter: false, rng: journeyRng });
    const { repo, campaignId, sessionId, actorId } = fixture;
    const route = seedRoute(fixture);
    expect(actorLocation(directory, campaignId, sessionId, actorId)).toBe(route.a);
    setRouteProfile(directory, campaignId, route.bToC);
    forcedRng = 1;
    const completions: ProviderCompletionInput[] = [];
    const app = buildApp({ campaignRepositoryFactory: () => repo, adventureAgentDependencies: journeyDependencies(completions) });
    try {
      const expectedRevision = repo.getCampaignAdministration(OWNER, campaignId)!.revision;
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        campaignId, sessionId, actorId, declaration: "i move to place lasalle", expectedRevision, idempotencyKey: "journey-interrupted",
      } });
      expect(response.statusCode, response.body).toBe(200);
      const terminal = streamEvents(response.body).at(-1);
      if (!terminal || terminal.type !== "terminal") throw new Error("interrupted terminal is missing");
      expect(terminal.payload).toMatchObject({ outcome: "done", receipts: [expect.objectContaining({ proposalId: null })] });
      const interruptedTurnId = terminal.payload.turn.turnId;
      const interruptedCommandId = terminal.payload.receipts[0]!.commandId;
      const interrupted = repo.getActorJourneyNarrationReceipt(OWNER, interruptedTurnId, interruptedCommandId)!;
      expect(interrupted).toMatchObject({ status: "interrupted", requestedDestinationLocationId: route.c, currentLocationId: route.b });
      expect(interrupted.path).toHaveLength(1);
      const narration = terminal.payload.narrationStatus.text ?? "";
      expect(narration).toContain("Miller's Crossing");
      expect(narration).toContain("Place La Salle");
      expect(narration.toLowerCase()).toContain("pending");
      expect(narration.toLowerCase()).toContain("continue");
      expect(narration.toLowerCase()).not.toContain("arrive at place la salle");
      expect(travelCommandCount(directory, campaignId, sessionId)).toBe(1);
      expect(actorLocation(directory, campaignId, sessionId, actorId)).toBe(route.b);
      // A fresh declaration continues the same journey and completes it at C.
      const continued = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        campaignId, sessionId, actorId, declaration: "continue journey", expectedRevision, idempotencyKey: "journey-continued",
      } });
      expect(continued.statusCode, continued.body).toBe(200);
      const continuedTerminal = streamEvents(continued.body).at(-1);
      if (!continuedTerminal || continuedTerminal.type !== "terminal") throw new Error("continuation terminal is missing");
      const completed = repo.getActorJourneyNarrationReceipt(OWNER, continuedTerminal.payload.turn.turnId,
        continuedTerminal.payload.receipts[0]!.commandId)!;
      expect(completed).toMatchObject({ status: "completed", journeyId: interrupted.journeyId,
        requestedDestinationLocationId: route.c, currentLocationId: route.c });
      expect(completed.path).toHaveLength(1);
      expect(travelCommandCount(directory, campaignId, sessionId)).toBe(2);
      expect(actorLocation(directory, campaignId, sessionId, actorId)).toBe(route.c);
      expect(completions.every((call) => call.tools?.every((tool) => tool.name === "submit_adventure_narration"))).toBe(true);
    } finally { await app.close(); repo.close(); forcedRng = null; }
  });

  it("reuses the root journey receipt for a narration derivative without moving or re-executing it", async () => {
    enableFlags();
    const directory = makeTmpDataDir();
    const fixture = await createReviewedAdventure(directory, { prepareOptionalEncounter: false, rng: journeyRng });
    const { repo, campaignId, sessionId, actorId } = fixture;
    const route = seedRoute(fixture);
    expect(actorLocation(directory, campaignId, sessionId, actorId)).toBe(route.a);
    const completions: ProviderCompletionInput[] = [];
    const app = buildApp({ campaignRepositoryFactory: () => repo, adventureAgentDependencies: journeyDependencies(completions) });
    try {
      const expectedRevision = repo.getCampaignAdministration(OWNER, campaignId)!.revision;
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        campaignId, sessionId, actorId, declaration: "i move to place lasalle", expectedRevision, idempotencyKey: "journey-derivative-root",
      } });
      const terminal = streamEvents(response.body).at(-1);
      if (!terminal || terminal.type !== "terminal") throw new Error("root terminal is missing");
      const rootTurnId = terminal.payload.turn.turnId;
      const commandId = terminal.payload.receipts[0]!.commandId;
      expect(travelCommandCount(directory, campaignId, sessionId)).toBe(2);
      const variant = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream", headers, payload: {
        variant: "narration-retry", campaignId, sessionId, actorId, priorTurnId: rootTurnId, expectedRevision,
        idempotencyKey: "journey-derivative-retry",
      } });
      expect(variant.statusCode, variant.body).toBe(200);
      const variantTerminal = streamEvents(variant.body).at(-1);
      if (!variantTerminal || variantTerminal.type !== "terminal") throw new Error("derivative terminal is missing");
      expect(variantTerminal.payload.receipts.map((receipt) => receipt.commandId)).toEqual([commandId]);
      expect(travelCommandCount(directory, campaignId, sessionId)).toBe(2);
      expect(actorLocation(directory, campaignId, sessionId, actorId)).toBe(route.c);
      expect(readOnly(directory, (db) => (db.prepare("SELECT count(*) n FROM world_actor_journey_executions_v1 WHERE campaign_id=?").get(campaignId) as { n: number }).n)).toBe(1);
      expect(repo.getActorJourneyNarrationReceipt(OWNER, variantTerminal.payload.turn.turnId, commandId))
        .toMatchObject({ status: "completed", currentLocationId: route.c });
    } finally { await app.close(); repo.close(); }
  });
});

// Approved test: an automatic narration retry must not accept prose that the original turn's
// grounding policy refused. A compound declaration ("look around ... and ask") is not plain
// conversation, so its generic draft falls back; the derivative retry must apply the same
// eligibility rule, so the room transcript (which collapses derivatives onto the root turn)
// never shows a draft the original lane rejected.
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adventureTurnStreamEventSchema, canonicalAgentJson } from "@velvet/contracts";
import { advertisedAffordances, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import type { ProviderCompletionResult, ProviderCompletionUsage } from "../src/provider/index.js";
import { ProviderHttpError } from "../src/provider/index.js";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { createRepository } from "../src/repo/index.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";
import { narrationFallback, providerNarrationMatchesReceipts } from "../src/routes/rpg/v1/adventureTurns.js";
import { useTmpDataDir } from "./helpers.js";
import { DND_5E_RULESET_DESCRIPTOR, VELVET_LEGACY_RULESET_DESCRIPTOR } from "../src/rulesets/index.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const expires = "2099-01-01T00:00:00.000Z";
afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  delete process.env.VELVET_SSE_HEARTBEAT_MS;
});
const enable = () => {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
};
const narrationResult = (
  narration: string,
  usage: ProviderCompletionUsage | null = null,
): ProviderCompletionResult => ({
  message: {
    role: "assistant",
    content: null,
    toolCalls: [
      { id: "qwen-narration-call", name: "submit_adventure_narration", arguments: JSON.stringify({ narration }) },
    ],
  },
  usage,
  model: { requestedModel: "test", responseModel: "test" },
});

function seed(ruleset: "velvet" | "dnd" = "velvet") {
  const initial = createRepository();
  const campaign = initial.createCampaign("local-owner", { name: "HTTP turns" });
  initial.close();
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
  db.prepare("INSERT INTO rpg_rules_profiles VALUES ('turn-profile','Turn profile','Rules','[]')").run();
  db.prepare("INSERT INTO rpg_content_packs VALUES ('turn-pack','1','turn-profile','Turn pack','Pack','[]',0)").run();
  db.prepare(
    "INSERT INTO rpg_definitions VALUES ('turn-pack','1','race','human','Human','Race','[]'),('turn-pack','1','background','hero','Hero','Background','[]')",
  ).run();
  db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='turn-pack'").run();
  db.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'turn-profile')").run(campaign.id);
  const rulesetId = ruleset === "dnd" ? DND_5E_RULESET_DESCRIPTOR.id : VELVET_LEGACY_RULESET_DESCRIPTOR.id;
  const rulesetVersion =
    ruleset === "dnd" ? DND_5E_RULESET_DESCRIPTOR.version : VELVET_LEGACY_RULESET_DESCRIPTOR.version;
  db.prepare("INSERT INTO rpg_rules_profile_bindings_v60 VALUES ('turn-profile',?,?)").run(rulesetId, rulesetVersion);
  db.prepare(
    "INSERT INTO campaign_ruleset_bindings_v60(campaign_id,rules_profile_id,ruleset_id,ruleset_version,bound_at) VALUES(?,'turn-profile',?,?,?)",
  ).run(campaign.id, rulesetId, rulesetVersion, at);
  db.prepare("INSERT INTO campaign_content_packs VALUES (?,'turn-pack','1','turn-profile')").run(campaign.id);
  db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
  db.prepare(
    "INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc','turn-pack','1','race','human','turn-pack','1','background','hero',?,?)",
  ).run(campaign.id, at, at);
  db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(
    campaign.id,
    at,
    at,
  );
  db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'local-owner',NULL)").run(campaign.id);
  db.prepare(
    "INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)",
  ).run(at);
  db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
  db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
  db.close();
  return campaign;
}

/** Places the seeded actor at a discovered public location so narration has a current-location anchor. */
function locateActor(campaignId: string, locationName: string) {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.prepare("INSERT INTO campaign_locations_v28 VALUES('quay',?,NULL,?,'A fog-damp landing.','public',?)").run(
    campaignId,
    locationName,
    at,
  );
  db.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,'quay','session',0,?)").run(campaignId, "actor", at);
  db.prepare("INSERT INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(campaignId, "actor", "quay", at);
  db.close();
}

function events(body: string) {
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("event: "))
    .map((frame) => {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6);
      return adventureTurnStreamEventSchema.parse(JSON.parse(data));
    });
}

const GENERIC = "A concise deterministic reply from the selected character.";

function harness() {
  let narrationCalls = 0;
  const dependencies: AdventureAgentDependencies = {
    complete: async (input) => {
      if (!input.tools?.some((tool) => tool.name === "submit_adventure_narration"))
        return {
          message: { role: "assistant", content: "complete", toolCalls: [] },
          usage: null,
          model: { requestedModel: "test", responseModel: "test" },
        };
      narrationCalls += 1;
      return narrationResult(GENERIC);
    },
    getProvider: async () => ({ ...defaultProviderSettings(), model: "test" }),
    getHarness: async () => defaultHarnessSettings(),
    now: () => new Date(),
  };
  const app = buildApp({
    campaignRepositoryFactory: () => createRepository(),
    adventureAgentDependencies: dependencies,
  });
  return { app, calls: () => narrationCalls };
}

async function playThenRetry(declaration: string, key: string) {
  enable();
  const campaign = seed();
  locateActor(campaign.id, "Lantern Quay");
  const { app, calls } = harness();
  const stream = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json" },
      payload,
    });
  const initial = events(
    (
      await stream({
        campaignId: campaign.id,
        sessionId: "session",
        actorId: "actor",
        declaration,
        expectedRevision: 0,
        idempotencyKey: `${key}-initial`,
      })
    ).body,
  ).at(-1)!;
  if (initial.type !== "terminal") throw new Error("initial stream did not terminate");
  const rootTurnId = initial.payload.turn.turnId;
  const retry = events(
    (
      await stream({
        variant: "narration-retry",
        campaignId: campaign.id,
        sessionId: "session",
        actorId: "actor",
        priorTurnId: rootTurnId,
        expectedRevision: 0,
        idempotencyKey: `${key}-retry`,
      })
    ).body,
  ).at(-1)!;
  if (retry.type !== "terminal") throw new Error("retry stream did not terminate");
  const root = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${rootTurnId}` });
  const transcript = await app.inject({
    method: "GET",
    url: `/api/rpg/v1/adventure-turns/transcript?campaignId=${campaign.id}&sessionId=session`,
  });
  const entry = (transcript.json() as { turns: Array<{ turnId: string; narration: string }> }).turns.find(
    (turn) => turn.turnId === rootTurnId,
  );
  await app.close();
  return {
    initial: initial.payload.narrationStatus,
    retry: retry.payload.narrationStatus,
    root: root.json().narrationStatus,
    transcript: entry?.narration,
    calls: calls(),
  };
}

describe("automatic narration retry grounding", () => {
  it("applies the original turn's conversation eligibility, so a rejected generic draft never reaches the transcript", async () => {
    const result = await playThenRetry("I look around the quay and ask who keeps the lantern.", "compound");
    // The original lane refuses to narrate this compound declaration as plain conversation.
    expect(result.initial).toMatchObject({ status: "completed", source: "deterministic-fallback" });
    expect(result.initial.text).not.toBe(GENERIC);
    // The retry asks the provider again but judges the draft by the same rule.
    expect(result.calls).toBe(2);
    expect(result.retry).toMatchObject({ status: "completed", source: "deterministic-fallback" });
    expect(result.retry.text).not.toBe(GENERIC);
    expect(result.root.text).toBe(result.initial.text);
    expect(result.transcript).toBe(result.initial.text);
  });

  it("still lets a retry narrate a plain conversation the original lane accepts", async () => {
    const result = await playThenRetry("I ask who keeps the lantern.", "plain");
    expect(result.initial).toMatchObject({ status: "completed", source: "provider-assisted", text: GENERIC });
    expect(result.retry).toMatchObject({ status: "completed", source: "provider-assisted", text: GENERIC });
    expect(result.transcript).toBe(GENERIC);
  });
});

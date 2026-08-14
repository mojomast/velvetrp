import DatabaseDriver from "better-sqlite3";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  adventureTurnStreamEventSchema,
  type CharacterBuilderAttributeScores,
} from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { completeWithProvider } from "../src/provider/index.js";
import {
  MECHANICS_STARTER_CATALOG,
  createRepository,
  type Repository,
} from "../src/repo/index.js";
import type { AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const AT = "2035-01-01T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"]
  .map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;
const dbFile = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const servers: Server[] = [];

afterEach(async () => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function enable(): void {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
}

function streamEvents(body: string) {
  return body.split("\n\n").filter((frame) => frame.startsWith("event: ")).map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new Error("SSE data frame missing");
    return adventureTurnStreamEventSchema.parse(JSON.parse(data.slice(6)));
  });
}

async function seedCampaign(options: { enemies?: number; clock?: Date } = {}) {
  const clock = { now: () => options.clock ?? new Date(AT) };
  const repo = createRepository({ clock });
  const campaign = repo.createCampaign(OWNER, { name: "Agent acceptance" });
  repo.installMechanicsStarterCatalog(OWNER);
  repo.configureMechanicsStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "starter-pins" });
  const persona = repo.createCharacter({ name: "Aster", age: 31, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER,
    durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "draft" });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const selected = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "select", selections: {
    race: definitions.find((definition) => definition.reference.kind === "race")!.reference,
    background: definitions.find((definition) => definition.reference.kind === "background")!.reference,
    class: definitions.find((definition) => definition.reference.kind === "class")!.reference,
    starterGrant: "kit",
  }} as never);
  const finalized = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "finalize" });
  const actorId = finalized.receipt.actorId;
  const sessionId = "agent-acceptance-session";
  const db = new DatabaseDriver(dbFile());
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,?,'active','default',?)")
    .run(sessionId, persona.id, "Agent room", AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run(sessionId, persona.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId, campaign.id, AT);
  db.close();
  let combat: ReturnType<Repository["getCombatState"]> = null;
  if (options.enemies) {
    const template = { kind: "enemy-template" as const, packId: MECHANICS_STARTER_CATALOG.manifest.packId,
      packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion, definitionId: "velvet:mechanics:enemy-template:gloam-mite" };
    const prepared = repo.createEncounter(OWNER, campaign.id, { sessionId, name: "Target-rich combat", combatants: [
      { kind: "actor", actorId, team: "allies" },
      ...Array.from({ length: options.enemies }, () => ({ kind: "enemy" as const, template, team: "enemies" as const })),
    ], idempotencyKey: "prepare-combat" });
    combat = repo.startEncounter(OWNER, prepared.encounter.encounterId, { expectedRevision: 1, idempotencyKey: "start-combat" }).combat;
    const actorHasTurn = () => {
      const current = combat?.combatants.find((item) => item.combatantId === combat!.currentCombatant);
      return current?.kind === "actor" && current.actorId === actorId;
    };
    for (let index = 0; combat.currentCombatant !== null
      && !actorHasTurn() && index < 10; index += 1) {
      combat = repo.resolveCombatAction(OWNER, combat.combatId, { legalActionId: "end-turn", targetIds: [], choices: [],
        expectedRevision: combat.revision, idempotencyKey: `advance-to-actor-${index}` }).combat;
    }
    if (combat.currentCombatant === null || !actorHasTurn()) {
      throw new Error("actor did not receive a combat turn");
    }
  }
  repo.close();
  return { campaign, actorId, sessionId, combat };
}

type ProviderSelector = (request: any) => { name: string; arguments: Record<string, unknown> };
async function fakeToolProvider(select: ProviderSelector) {
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const parsed = JSON.parse(body); requests.push(parsed);
      if (!parsed.tools) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ model: "acceptance-fake", choices: [{ message: { role: "assistant", content: "The committed result changes the scene." } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
        return;
      }
      const call = select(parsed);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "acceptance-fake", choices: [{ message: { role: "assistant", content: null,
        tool_calls: [{ id: `provider-call-${requests.length}`, type: "function", function: {
          name: call.name, arguments: JSON.stringify(call.arguments),
        }}] } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { requests, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

function dependencies(baseUrl: string, now = () => new Date(AT)): AdventureAgentDependencies {
  return { complete: completeWithProvider, getProvider: async () => ({ ...defaultProviderSettings(), baseUrl,
    model: "acceptance-fake", requestTimeoutSeconds: 2 }), getHarness: async () => defaultHarnessSettings(), now };
}

function attributeSelector(value: number): ProviderSelector {
  return (request) => {
    const tool = request.tools.find((candidate: any) => candidate.function.name === "actor_attribute.set").function;
    return { name: "actor_attribute.set", arguments: {
      attributeCandidateId: tool.parameters.properties.attributeCandidateId.enum[0],
      attributeCandidateDigest: tool.parameters.properties.attributeCandidateDigest.enum[0], value,
    }};
  };
}

async function proposeAttribute(value: number, idempotencyKey: string, clock = new Date(AT)) {
  enable();
  const seeded = await seedCampaign({ clock });
  const provider = await fakeToolProvider(attributeSelector(value));
  const app = buildApp({ campaignRepositoryFactory: () => createRepository({ clock: { now: () => clock } }),
    adventureAgentDependencies: dependencies(provider.baseUrl, () => clock) });
  const initial = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
    headers: { "content-type": "application/json" }, payload: { campaignId: seeded.campaign.id, sessionId: seeded.sessionId,
      actorId: seeded.actorId, declaration: "Set my might precisely", expectedRevision: 1, idempotencyKey } });
  const events = streamEvents(initial.body);
  const started = events.find((event) => event.type === "turn_started");
  const proposed = events.find((event) => event.type === "tool_proposed");
  if (!started || started.type !== "turn_started" || !proposed || proposed.type !== "tool_proposed") throw new Error("proposal stream incomplete");
  return { ...seeded, provider, app, turnId: started.payload.turn.turnId, proposal: proposed.payload.proposal };
}

describe("M4.2/M4.3 socket-to-restart acceptance", () => {
  it("persists a safe provider attribute proposal, approves over HTTP, and resumes one attributed command after restart", async () => {
    const fixture = await proposeAttribute(16, "attribute-restart");
    expect(fixture.provider.requests).toHaveLength(1);
    expect(fixture.proposal).toMatchObject({ toolName: "set_actor_attribute", policy: { version: "v1", category: "gm-override",
      requiresConfirmation: true, requiredAuthorizer: "gm", review: { summary: expect.any(String), consequences: expect.any(Array) } } });
    expect(JSON.stringify(fixture.proposal)).not.toMatch(/arguments|attributeCandidate|execution|strength|might/i);
    const approval = await fixture.app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${fixture.turnId}/confirm`,
      headers: { "content-type": "application/json" }, payload: { proposalIds: [fixture.proposal.proposalId], decision: "approve",
        expectedRevision: 2, idempotencyKey: "approve-attribute" } });
    expect(approval.statusCode).toBe(200);
    await fixture.app.close();

    const restarted = buildApp({ campaignRepositoryFactory: () => createRepository({ clock: { now: () => new Date(AT) } }),
      adventureAgentDependencies: dependencies(fixture.provider.baseUrl) });
    const read = await restarted.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${fixture.turnId}` });
    expect(read.json().resumeToken).toMatch(/^v1\./);
    const resumed = await restarted.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json" }, payload: { resumeToken: read.json().resumeToken } });
    expect(streamEvents(resumed.body).at(-1)).toMatchObject({ type: "terminal", payload: { outcome: "done",
      turn: { turnId: fixture.turnId, state: "completed" }, receipts: [{ proposalId: fixture.proposal.proposalId }] } });
    expect(fixture.provider.requests).toHaveLength(2);
    expect(fixture.provider.requests[1]).toMatchObject({ tool_choice: "none" });
    expect(fixture.provider.requests[1].tools).toBeUndefined();
    expect(JSON.parse(fixture.provider.requests[1].messages[1].content)).toEqual({ declaration: "Set my might precisely",
      publicContext: { summary: [], recap: [], cast: ["Aster."], world: [], quests: [], canon: [] },
      receipts: [{ kind: "mechanic", event: { type: "actor_attribute_set", data: { valueBefore: expect.any(Number), valueAfter: 16 } } }] });
    await restarted.close();

    const db = new DatabaseDriver(dbFile(), { readonly: true });
    const command = db.prepare(`SELECT command_id,actor_id,source_turn_id,type,attribute_id,value FROM campaign_commands
      WHERE source_turn_id=?`).get(fixture.turnId) as any;
    expect(command).toEqual({ command_id: expect.stringMatching(/^agent-command:/), actor_id: fixture.actorId,
      source_turn_id: fixture.turnId, type: "set_actor_attribute", attribute_id: "might", value: 16 });
    expect(db.prepare("SELECT count(*) count FROM campaign_commands WHERE source_turn_id=?").get(fixture.turnId)).toEqual({ count: 1 });
    expect(db.prepare(`SELECT count(*) count FROM command_receipts receipt JOIN campaign_events event
      ON event.campaign_id=receipt.campaign_id AND event.command_id=receipt.command_id WHERE receipt.command_id=?
      AND event.actor_id=? AND event.source_turn_id=? AND event.type='actor_attribute_set'`).get(command.command_id, fixture.actorId, fixture.turnId))
      .toEqual({ count: 1 });
    db.close();
  });

  it("executes one exact provider-selected targeted combat action and resolves its safe campaign receipt after restart", async () => {
    enable();
    const seeded = await seedCampaign({ enemies: 2 });
    const snapshotRepo = createRepository({ clock: { now: () => new Date(AT) } });
    const snapshot = snapshotRepo.getCampaignAgentContextSnapshot(OWNER, seeded.campaign.id, seeded.sessionId,
      { kind: "player", actorId: seeded.actorId })!;
    const attacks = snapshot.encounter!.legalActionCandidates.filter((candidate) => candidate.kind === "attack");
    expect(attacks).toHaveLength(2);
    const selected = attacks[1]!;
    snapshotRepo.close();
    const provider = await fakeToolProvider(() => ({ name: "combat_action.execute", arguments: {
      legalActionId: selected.legalActionId, legalActionDigest: selected.digest,
    }}));
    let app = buildApp({ campaignRepositoryFactory: () => createRepository({ clock: { now: () => new Date(AT) } }),
      adventureAgentDependencies: dependencies(provider.baseUrl) });
    const initial = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json" }, payload: { campaignId: seeded.campaign.id, sessionId: seeded.sessionId,
        actorId: seeded.actorId, declaration: "Strike the second target", expectedRevision: 1, idempotencyKey: "combat-target" } });
    const initialEvents = streamEvents(initial.body);
    const started = initialEvents.find((event) => event.type === "turn_started");
    const proposal = initialEvents.find((event) => event.type === "tool_proposed");
    if (!started || started.type !== "turn_started" || !proposal || proposal.type !== "tool_proposed") throw new Error("combat proposal missing");
    expect(proposal.payload.proposal).toMatchObject({ toolName: "combat_action", policy: { category: "combat-action-consequential",
      requiredAuthorizer: "controller" } });
    const approve = await app.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${started.payload.turn.turnId}/confirm`,
      headers: { "content-type": "application/json" }, payload: { proposalIds: [proposal.payload.proposal.proposalId], decision: "approve",
        expectedRevision: 2, idempotencyKey: "approve-combat" } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().resumeToken).toMatch(/^v1\./);
    await app.close();
    app = buildApp({ campaignRepositoryFactory: () => createRepository({ clock: { now: () => new Date(AT) } }),
      adventureAgentDependencies: dependencies(provider.baseUrl) });
    const reconciled = await app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${started.payload.turn.turnId}` });
    expect(reconciled.statusCode, reconciled.body).toBe(200);
    expect(reconciled.json().resumeToken).toBe(approve.json().resumeToken);
    const resumed = await app.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json" }, payload: { resumeToken: approve.json().resumeToken } });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(streamEvents(resumed.body).at(-1)).toMatchObject({ type: "terminal", payload: { outcome: "done" } });

    const db = new DatabaseDriver(dbFile(), { readonly: true });
    const binding = db.prepare(`SELECT binding.*,proposal.arguments_json FROM agent_combat_proposal_bindings_v39 binding
      JOIN tool_proposals proposal USING(proposal_id) WHERE binding.turn_id=?`).get(started.payload.turn.turnId) as any;
    expect(binding).toMatchObject({ legal_action_id: selected.legalActionId, command_legal_action_id: selected.commandLegalActionId,
      legal_action_digest: selected.digest, expected_combat_revision: seeded.combat!.revision });
    expect(JSON.parse(binding.arguments_json)).toMatchObject({ targetId: selected.targetId, legalActionId: selected.legalActionId,
      legalActionDigest: selected.digest });
    const receipt = db.prepare("SELECT * FROM agent_generalized_receipts_v39 WHERE turn_id=?").get(started.payload.turn.turnId) as any;
    expect(receipt).toMatchObject({ proposal_id: proposal.payload.proposal.proposalId, encounter_id: seeded.combat!.combatId,
      revision_before: seeded.combat!.revision, revision_after: seeded.combat!.revision + 1 });
    expect(db.prepare("SELECT count(*) count FROM combat_commands_v27 WHERE encounter_id=? AND command_type='resolve_action' AND idempotency_key=?")
      .get(seeded.combat!.combatId, binding.execution_idempotency_key)).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM agent_generalized_receipts_v39 WHERE turn_id=?").get(started.payload.turn.turnId)).toEqual({ count: 1 });
    db.close();
    const publicReceipt = await app.inject({ method: "GET",
      url: `/api/rpg/v1/campaigns/${seeded.campaign.id}/commands/${receipt.command_id}/receipt` });
    expect(publicReceipt.statusCode).toBe(200);
    expect(publicReceipt.json()).toMatchObject({ receipt: { kind: "combat", revisionBefore: seeded.combat!.revision,
      revisionAfter: seeded.combat!.revision + 1, roundBefore: expect.any(Number), roundAfter: expect.any(Number) } });
    expect(publicReceipt.body).not.toMatch(/provider|arguments|principal|idempotency/i);
    expect(provider.requests).toHaveLength(2);
    await app.close();
  });

  it("converges concurrent duplicate confirmation and resume workers to identical results and one command receipt", async () => {
    const fixture = await proposeAttribute(17, "concurrent-turn");
    await fixture.app.close();
    const makeApp = () => buildApp({ campaignRepositoryFactory: () => createRepository({ clock: { now: () => new Date(AT) } }),
      adventureAgentDependencies: dependencies(fixture.provider.baseUrl) });
    const first = makeApp(), second = makeApp();
    const payload = { proposalIds: [fixture.proposal.proposalId], decision: "approve", expectedRevision: 2,
      idempotencyKey: "same-confirmation" };
    const [left, right] = await Promise.all([first.inject({ method: "POST", url: `/api/rpg/v1/adventure-turns/${fixture.turnId}/confirm`,
      headers: { "content-type": "application/json" }, payload }), second.inject({ method: "POST",
      url: `/api/rpg/v1/adventure-turns/${fixture.turnId}/confirm`, headers: { "content-type": "application/json" }, payload })]);
    expect(left.statusCode).toBe(200); expect(right.statusCode).toBe(200); expect(right.json()).toEqual(left.json());
    const token = left.json().resumeToken;
    const [resumeLeft, resumeRight] = await Promise.all([first.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json" }, payload: { resumeToken: token } }), second.inject({ method: "POST",
      url: "/api/rpg/v1/adventure-turns/stream", headers: { "content-type": "application/json" }, payload: { resumeToken: token } })]);
    const stable = (body: string) => streamEvents(body).map(({ timestamp: _timestamp, ...event }) => event);
    expect(stable(resumeRight.body)).toEqual(stable(resumeLeft.body));
    expect(stable(resumeLeft.body).at(-1)).toMatchObject({ type: "terminal", payload: { outcome: "done",
      turn: { turnId: fixture.turnId, state: "completed" }, receipts: [{ proposalId: fixture.proposal.proposalId }] } });
    const db = new DatabaseDriver(dbFile(), { readonly: true });
    expect(db.prepare("SELECT count(*) count FROM confirmation_decisions WHERE turn_id=?").get(fixture.turnId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM campaign_commands WHERE source_turn_id=?").get(fixture.turnId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM turn_mechanics_links_v36 WHERE turn_id=?").get(fixture.turnId)).toEqual({ count: 1 });
    db.close();
    expect(fixture.provider.requests).toHaveLength(2);
    await first.close(); await second.close();
  });

  it("durably expires a resumed provider proposal without mechanics or provider redispatch and streams truthful cancellation", async () => {
    const initialClock = new Date(AT);
    const fixture = await proposeAttribute(18, "expiring-turn", initialClock);
    const initialRead = await fixture.app.inject({ method: "GET", url: `/api/rpg/v1/adventure-turns/${fixture.turnId}` });
    const token = initialRead.json().resumeToken;
    await fixture.app.close();
    const future = new Date(initialClock.getTime() + 31 * 60_000);
    const restarted = buildApp({ campaignRepositoryFactory: () => createRepository({ clock: { now: () => future } }),
      adventureAgentDependencies: dependencies(fixture.provider.baseUrl, () => future) });
    const resumed = await restarted.inject({ method: "POST", url: "/api/rpg/v1/adventure-turns/stream",
      headers: { "content-type": "application/json" }, payload: { resumeToken: token } });
    const events = streamEvents(resumed.body);
    expect(events.map((event) => event.type)).toEqual(["agent_status", "terminal"]);
    expect(events[0]).toMatchObject({ type: "agent_status", payload: { status: "expired" } });
    expect(events[1]).toMatchObject({ type: "terminal", payload: { outcome: "aborted",
      turn: { turnId: fixture.turnId, state: "cancelled" }, receipts: [] } });
    const db = new DatabaseDriver(dbFile(), { readonly: true });
    expect(db.prepare("SELECT decision FROM confirmation_decisions WHERE turn_id=?").get(fixture.turnId)).toEqual({ decision: "expired" });
    expect(db.prepare("SELECT count(*) count FROM confirmation_expiration_operations_v40 WHERE turn_id=?").get(fixture.turnId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) count FROM campaign_commands WHERE source_turn_id=?").get(fixture.turnId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM final_receipt_links WHERE turn_id=?").get(fixture.turnId)).toEqual({ count: 0 });
    db.close();
    expect(fixture.provider.requests).toHaveLength(1);
    await restarted.close();
  });
});

import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { createAgentObservationRepository } from "../../src/repo/observations/agentObservationRepo.js";
import { dmFixture } from "./dmCampaign.js";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

/** Closed set of actions the live/deterministic playtest graders accept as a committed director beat. */
export const PLAYTEST_KNOWN_ACTIONS = new Set(["encounter-start", "encounter-materialize", "enemy-turn", "encounter-complete",
  "reveal-node", "resolve-node", "reveal-clue", "advance-time", "ambient-beat"]);
/** Transition (world-pacing) actions. A beat whose receipts are all pacing is presentation-only. */
export const PLAYTEST_PACING_ACTIONS = new Set(["advance-time", "ambient-beat"]);
export const PLAYTEST_LEAK_MARKERS = ["SECRET_", "gmNotes", "privateGoals", "candidateId", "proposal", "provider", "dispatch", "tool_call"];

/** Provider-free verdict for one committed beat: completion, narration, exact actions, no private leakage. */
export function gradeDmRun(run: { state: string; receipts: Array<{ action: string }>; narration: string | null }): string[] {
  const failures: string[] = [];
  if (run.state !== "completed") failures.push(`state:${run.state}`);
  if (run.narration === null || run.narration.length === 0) failures.push("missing-narration");
  for (const marker of PLAYTEST_LEAK_MARKERS) if ((run.narration ?? "").includes(marker)) failures.push(`leak:${marker}`);
  const actions = run.receipts.map(receipt => receipt.action);
  for (const action of actions) if (!PLAYTEST_KNOWN_ACTIONS.has(action)) failures.push(`unknown-action:${action}`);
  if (new Set(actions).size !== actions.length) failures.push("duplicate-receipt-action");
  return failures;
}

/** Deterministic, provider-free world: locations, present NPCs with ledger knowledge, a story chain, and a quest. */
export function seedLivingWorld(f: Fixture, seed: number): void {
  const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
  db.pragma("foreign_keys=ON");
  const tag = `s${seed}`;
  const createLocation = (locationId: string, name: string, description: string) =>
    (f.repo as unknown as { createLocation: (owner: string, input: Record<string, unknown>) => unknown })
      .createLocation("local-owner", { campaignId: f.campaign.id, locationId, name, description, visibility: "public" });
  createLocation(`${tag}-market`, `${tag} Market`, "A lantern-lit market square.");
  createLocation(`${tag}-docks`, `${tag} Docks`, "Weathered docks under salt mist.");
  createLocation(`${tag}-chapel`, `${tag} Chapel`, "A quiet chapel of grey stone.");
  const ledger = createAgentObservationRepository(db, { clock: f.options.clock, ids: { nextId: (() => { let n = 0; return () => `${tag}-obs-${++n}`; })() } });
  const freshRead = <T>(source: string, ...params: unknown[]): T | undefined => {
    const connection = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    try { return connection.prepare(source).get(...params) as T | undefined; } finally { connection.close(); }
  };
  const narrativeRevision = () => freshRead<{ revision: number }>("SELECT revision FROM world_narrative_revisions_v32 WHERE campaign_id=?", f.campaign.id)?.revision ?? 0;
  const presenceRevision = () => freshRead<{ revision: number }>("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?", f.campaign.id, f.session.id)?.revision ?? 0;
  [`${tag} Maren`, `${tag} Joss`, `${tag} Quill`].forEach((name, index) => {
    const persona = f.repo.createCharacter({ name, age: 30 + index, archetype: "Guide", boundaries: "", fictionalConfirmed: true });
    const npc = f.repo.createCampaignNpc("local-owner", f.campaign.id, {
      personaId: persona.id, publicState: { name, description: `The ${name.split(" ")[1]} of the ${tag} quarter.` },
      privateState: { goals: "SECRET_GOAL", gmNotes: "SECRET_GM_NOTE", merchantState: null },
      expectedRevision: narrativeRevision(), idempotencyKey: `${tag}-npc-${index}`,
    }).npc;
    f.repo.mutateNpcPresence("local-owner", { campaignId: f.campaign.id, sessionId: f.session.id, npcId: npc.npcId, expectedRevision: presenceRevision(),
      idempotencyKey: `${tag}-place-${index}`, mutation: { kind: "place", locationId: `${tag}-market` } });
    ledger.record({ campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, agentKind: "npc", agentId: npc.npcId,
      sourceCommandId: `${tag}-witness-${index}`, observedRevision: 1, channel: "witnessed", hopCount: 0,
      text: `${name} saw the party arrive at the ${tag} market.`, authority: "verified" });
  });
  const nodes = [0, 1, 2, 3].map(index => ({ nodeId: `${tag}-n${index}`, title: `Scene ${index}`, description: `Public scene ${index} of the ${tag} road.`,
    gmNotes: `SECRET_NODE_${index}`, revealThreshold: index === 0 ? 0 : 1 }));
  const edges = [1, 2, 3].map(index => ({ edgeId: `${tag}-e${index}`, kind: "requires" as const, fromNodeId: `${tag}-n${index - 1}`, toNodeId: `${tag}-n${index}` }));
  f.repo.createCampaignStorylineGraph("local-owner", f.campaign.id, { expectedRevision: f.repo.getCampaignStory("local-owner", f.campaign.id)!.revision,
    idempotencyKey: `${tag}-story`, storyline: { storylineId: "story", title: `${tag} Journey`, summary: "A public road", nodes, edges, plotPoints: [],
      clues: [{ clueId: `${tag}-clue`, title: `${tag} Key`, content: "A brass key lies on the stones.", truth: "SECRET_TRUTH", gmNotes: "SECRET_CLUE",
        revealThreshold: 1, sources: [{ sourceId: `${tag}-clue-src`, kind: "node", targetId: `${tag}-n0` }] }] } });
  f.repo.createCampaignQuest("local-owner", f.campaign.id, { quest: {
    questId: `${tag}-quest-a`, storylineId: "story", title: `Guard the ${tag} market`, description: "A public task.",
    visibility: "public", journalText: "Offered",
    objectives: [{ objectiveId: `${tag}-obj-a`, description: "Keep watch at the market", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" }], rewards: [] },
    expectedRevision: f.repo.listCampaignQuests("local-owner", f.campaign.id)!.revision, idempotencyKey: `${tag}-quest-a-create` });
  db.close();
}

/**
 * Gives the seeded world a placed player actor and public routes, so a simulated human declaration
 * produces real travel/check/quest candidates instead of only narration.
 */
export function enableHumanPlayerTravel(f: Fixture, seed: number): void {
  const tag = `s${seed}`;
  const worldRevision = () => f.repo.getCampaignWorld("local-owner", f.campaign.id)!.revision;
  f.repo.placeActor("local-owner", f.actorId, { campaignId: f.campaign.id, locationId: `${tag}-market`,
    expectedRevision: worldRevision(), idempotencyKey: `${tag}-place-actor` });
  const connect = (locationConnectionId: string, fromLocationId: string, toLocationId: string) =>
    (f.repo as unknown as { createLocationConnection: (owner: string, input: Record<string, unknown>) => unknown })
      .createLocationConnection("local-owner", { campaignId: f.campaign.id, locationConnectionId, fromLocationId, toLocationId, visibility: "public" });
  connect(`${tag}-c1`, `${tag}-market`, `${tag}-docks`);
  connect(`${tag}-c2`, `${tag}-market`, `${tag}-chapel`);
}

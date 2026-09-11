import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import {
  TOWN_GOSSIP_AGENT_ID,
  gossipSampleIncluded,
  propagateFactionWitnessObservations,
  propagateGossipToPresentNpcs,
  propagateToldOnArrival,
  propagateTownGossipObservations,
  propagateWitnessObservations,
  createRepository,
  createSession,
} from "../../../src/repo/index.js";
import type { PropagationDependencies } from "../../../src/repo/index.js";

const OWNER = "local-owner";
const AT = "2037-04-05T06:07:08.000Z";

export type KnowledgeEvalFixture = Awaited<ReturnType<typeof createKnowledgeEvalFixture>>;

export async function createKnowledgeEvalFixture(dataDir: string) {
  let sequence = 0;
  const repo = createRepository({
    dataDir,
    clock: { now: () => new Date(AT) },
    ids: { nextId: () => `kv-${String(++sequence).padStart(4, "0")}` },
    rng: { integer: (minimum: number) => minimum },
  });
  const campaign = repo.createCampaign(OWNER, { name: "Knowledge evaluation corpus" });
  let npcRevision = 0;
  const addNpc = (name: string) => repo.createCampaignNpc(OWNER, campaign.id, {
    personaId: repo.createCharacter({ name, age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true }).id,
    publicState: { name }, privateState: { goals: "Observe", gmNotes: "Corpus NPC", merchantState: null },
    expectedRevision: npcRevision++, idempotencyKey: `knowledge-eval:${name}`,
  }).npc.npcId;
  const knower = addNpc("Knower");
  const arriving = addNpc("Arriving");
  const authority = addNpc("Authority");
  const absent = addNpc("Absent");
  const bystander = addNpc("Bystander");
  const herald = addNpc("Herald");
  const sessionPersona = repo.createCharacter({ name: "Host", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const session = await createSession({ characterId: sessionPersona.id, title: "Knowledge evaluation room" });
  await repo.transitionSession(session.id, "active", "start");
  repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id } as any);

  const dbPath = path.join(dataDir, "velvet.sqlite");
  const db = new DatabaseDriver(dbPath);
  db.pragma("foreign_keys=ON");
  const dependencies: PropagationDependencies = {
    clock: { now: () => new Date(AT) }, ids: { nextId: () => `knowledge-eval:${++sequence}` },
  };
  const timelineId = campaign.activeTimelineId;
  const rootRevision = () => (db.prepare("SELECT revision FROM npc_presence_session_revisions_v43 WHERE campaign_id=? AND session_id=?")
    .get(campaign.id, session.id) as { revision: number } | undefined)?.revision ?? 0;
  const place = (npcId: string) => repo.mutateNpcPresence(OWNER, {
    campaignId: campaign.id, sessionId: session.id, npcId, expectedRevision: rootRevision(),
    idempotencyKey: `knowledge-eval:place:${npcId}:${rootRevision()}`, mutation: { kind: "place", locationId: null },
  });
  const factionId = "faction-sharing", enemyFactionId = "faction-enemy";
  db.prepare("INSERT INTO campaign_factions_v28 VALUES(?,?,?,?,?)").run(factionId, campaign.id, "Sharing Faction", "public", AT);
  db.prepare("INSERT INTO campaign_factions_v28 VALUES(?,?,?,?,?)").run(enemyFactionId, campaign.id, "Enemy Faction", "public", AT);
  db.prepare("INSERT INTO campaign_npc_faction_memberships_v28 VALUES(?,?,?,?,?)").run(campaign.id, factionId, knower, "member", AT);
  db.prepare("INSERT INTO campaign_npc_faction_memberships_v28 VALUES(?,?,?,?,?)").run(campaign.id, enemyFactionId, knower, "enemy", AT);

  place(knower);

  const sources: Record<string, string> = {};
  const witness = (key: string, summary: string, authority: "verified" | "rumor" = "verified") => {
    const sourceCommandId = `knowledge-eval:source:${key}`;
    sources[key] = sourceCommandId;
    propagateWitnessObservations(db, dependencies, {
      campaignId: campaign.id, timelineId, sessionId: session.id, sourceCommandId, observedRevision: Object.keys(sources).length, summary, authority,
    });
    propagateFactionWitnessObservations(db, dependencies, {
      campaignId: campaign.id, timelineId, sessionId: session.id, sourceCommandId, observedRevision: Object.keys(sources).length, summary, authority,
    });
  };
  witness("witnessed", "A harbor skirmish ended in failure.");
  witness("negation", "Keeper Maren did not promise passage to the island.");
  sources.unwitnessed = "knowledge-eval:source:unwitnessed";
  propagateToldOnArrival(db, dependencies, {
    campaignId: campaign.id, timelineId, sessionId: session.id, arrivingNpcId: arriving, observedRevision: 1,
  });
  place(authority);
  witness("authority", "A harbor skirmish resumed at the docks.");
  propagateToldOnArrival(db, dependencies, {
    campaignId: campaign.id, timelineId, sessionId: session.id, arrivingNpcId: authority, observedRevision: 2,
  });
  sources.told = sources.witnessed!;
  place(arriving);
  place(bystander);
  place(herald);

  const gossipSource = "knowledge-eval:source:gossip";
  sources.gossip = gossipSource;
  const present = [knower, arriving, bystander, herald];
  while (!present.some((npcId) => gossipSampleIncluded(npcId, gossipSource))
    || present.every((npcId) => gossipSampleIncluded(npcId, gossipSource))) {
    if (present.length >= 16) throw new Error("knowledge evaluation gossip sampling is degenerate");
    const extra = addNpc(`Pool ${present.length}`);
    place(extra);
    present.push(extra);
  }
  propagateTownGossipObservations(db, dependencies, {
    campaignId: campaign.id, timelineId, sessionId: session.id, sourceCommandId: gossipSource, observedRevision: 9,
    summary: "A brawl broke out in the square.",
  });
  propagateGossipToPresentNpcs(db, dependencies, { campaignId: campaign.id, timelineId, sessionId: session.id });
  const gossipRecipient = present.find((npcId) => gossipSampleIncluded(npcId, gossipSource)) ?? null;
  const gossipNonRecipient = present.find((npcId) => !gossipSampleIncluded(npcId, gossipSource)) ?? null;
  if (!gossipRecipient || !gossipNonRecipient) throw new Error("knowledge evaluation gossip sampling is degenerate");
  db.close();

  return { repo, campaign, session, timelineId, agents: { knower, arriving, authority, absent, bystander, herald, gossipRecipient, gossipNonRecipient },
    factions: { sharing: factionId, enemy: enemyFactionId }, sources, townAgentId: TOWN_GOSSIP_AGENT_ID, listenerActorId: "listener-unknown" };
}

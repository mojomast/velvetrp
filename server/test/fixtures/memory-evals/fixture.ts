import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { createSession, createRepository, MECHANICS_STARTER_CATALOG } from "../../../src/repo/index.js";
import type { CreateRepositoryOptions } from "../../../src/repo/index.js";
import { PLAYABILITY_OBSERVATIONS } from "../playability-observations.js";

export type MemoryEvalFixture = Awaited<ReturnType<typeof createMemoryEvalFixture>>;

const OWNER = "local-owner";

function deterministicOptions(dataDir: string): CreateRepositoryOptions {
  let sequence = 0;
  return {
    dataDir,
    clock: { now: () => new Date("2037-04-05T06:07:08.000Z") },
    ids: { nextId: () => `memory-eval:${String(++sequence).padStart(4, "0")}` },
    rng: { integer: (minimum: number) => minimum },
  };
}

export async function createMemoryEvalFixture(dataDir: string) {
  const options = deterministicOptions(dataDir);
  const repo = createRepository(options);
  const campaign = repo.createCampaign(OWNER, { name: "Memory evaluation corpus" });
  repo.installMechanicsStarterCatalog(OWNER);
  repo.configureMechanicsStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "memory-eval:catalog" });
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const createActor = (name: string, key: string) => {
    const persona = repo.createCharacter({ name, age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable",
      allocation: { method: "standard-array", scores: Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"].map((attribute, index) => [attribute, CHARACTER_BUILDER_STANDARD_ARRAY[index]!])) } as any, idempotencyKey: `memory-eval:${key}:draft` });
    const selected = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: `memory-eval:${key}:select`, selections: {
      race: definitions.find(definition => definition.reference.kind === "race")!.reference,
      background: definitions.find(definition => definition.reference.kind === "background")!.reference,
      class: definitions.find(definition => definition.reference.kind === "class")!.reference,
      starterGrant: "kit",
    } } as any);
    return { persona, actorId: repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: `memory-eval:${key}:final` }).receipt.actorId };
  };
  const aster = createActor("Aster", "aster");
  const bryn = createActor("Bryn", "bryn");
  const session = await createSession({ characterIds: [aster.persona.id, bryn.persona.id], title: "Memory evaluation room" });
  repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id });
  repo.transitionSession(session.id, "active", "Deterministic corpus setup");
  const sourceIds: Record<string, string> = {};
  const sourceStorage: Record<string, "declaration" | "presentation" | "recap" | "mechanic-receipt" | "director-receipt"> = {};
  const activeTimelineId = () => repo.getCampaign(OWNER, campaign.id)!.activeTimelineId;
  const declare = (sourceKey: string, actorId: string, declaration: string) => {
    const turn = repo.createAdventureTurn(OWNER, { campaignId: campaign.id, sessionId: session.id, timelineId: activeTimelineId(), actorId, declaration,
      expectedCampaignRevision: repo.getCampaignAdministration(OWNER, campaign.id)!.revision, idempotencyKey: `memory-eval:${sourceKey}` });
    sourceIds[sourceKey] = turn.turnId;
    sourceStorage[sourceKey] = "declaration";
    return turn;
  };
  const recap = (sourceKey: string, text: string) => {
    const value = repo.createCampaignRecap(OWNER, campaign.id, { timelineId: activeTimelineId(),
      throughRevision: repo.getCampaignTimeline(OWNER, campaign.id, activeTimelineId())!.revision, selectedSessionIds: [session.id], visibility: "members", text,
      expectedRevision: repo.getCampaignAdministration(OWNER, campaign.id)!.revision, idempotencyKey: `memory-eval:${sourceKey}` }).value;
    sourceIds[sourceKey] = value.id;
    sourceStorage[sourceKey] = "recap";
  };
  const completeNarration = (turn: ReturnType<typeof declare>, idempotencyKey: string, text: string) => {
    const started = repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId, expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision, idempotencyKey: `${idempotencyKey}:start`, narrationStatus: "in-progress" });
    return repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId, expectedTurnRevision: started.revision, expectedCampaignRevision: started.campaignRevision, idempotencyKey: `${idempotencyKey}:finish`, narrationStatus: "completed", terminalState: "completed", fallbackNarration: text });
  };
  declare("timeline:alternate", aster.actorId, "Old timeline cobalt bell: this source must disappear after the fork.");
  const checkpoint = repo.createCampaignCheckpoint(OWNER, campaign.id, { timelineId: activeTimelineId(),
    timelineRevision: repo.getCampaignTimeline(OWNER, campaign.id, activeTimelineId())!.revision, label: "Memory corpus alternate timeline",
    expectedRevision: repo.getCampaignAdministration(OWNER, campaign.id)!.revision, idempotencyKey: "memory-eval:timeline:checkpoint" }).value;
  repo.forkCampaignTimeline(OWNER, campaign.id, { checkpointId: checkpoint.id,
    expectedRevision: repo.getCampaignAdministration(OWNER, campaign.id)!.revision, idempotencyKey: "memory-eval:timeline:fork" });
  repo.createCampaignStorylineGraph(OWNER, campaign.id, { expectedRevision: repo.getCampaignStory(OWNER, campaign.id)!.revision, idempotencyKey: "memory-eval:dm-story", storyline: {
    storylineId: "memory-eval-story", title: "Keeper statement", summary: "Public corpus story", nodes: [{ nodeId: "keeper-statement", title: "Keeper statement", description: "keeper statement published", gmNotes: "", revealThreshold: 0 }], edges: [], plotPoints: [], clues: [],
  } });
  repo.setDmControl(OWNER, campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "memory-eval:dm-control" });
  for (const observation of PLAYABILITY_OBSERVATIONS) {
    const sourceKey = `p2:${observation.id}`;
    if (observation.sourceKind === "turn-receipt") {
      const turn = declare(sourceKey, aster.actorId, `I ask Keeper Maren about ${observation.step.replace(/-/g, " ")}.`);
      const commandId = `memory-eval:p2:${observation.step}`;
      repo.executeInitializeActorResource(OWNER, { commandId, idempotencyKey: commandId, campaignId: campaign.id, timelineId: activeTimelineId(), actorId: aster.actorId,
        expectedRevision: repo.getCampaignTimeline(OWNER, campaign.id, activeTimelineId())!.revision, sourceTurnId: turn.turnId,
        command: { type: "initialize_actor_resource", payload: { name: `p2-${observation.step}`, current: 1, max: 1 } } });
      sourceIds[sourceKey] = commandId;
      sourceStorage[sourceKey] = "mechanic-receipt";
    } else if (observation.sourceKind === "dm-receipt") {
      const run = repo.openDmBeat(OWNER, campaign.id, session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: `memory-eval:${sourceKey}:open` });
      const work = repo.claimDmPlanning(OWNER, run.runId, "memory-eval", "memory-eval")!;
      const candidate = work.candidates.find(item => item.action === "reveal-node");
      if (!candidate) throw new Error(`memory evaluation DM receipt candidate missing: ${observation.id}`);
      repo.settleDmPlanning(OWNER, run.runId, work.claimId, { candidateId: candidate.candidateId, digest: candidate.digest }, null);
      repo.executeDmBeat(OWNER, run.runId);
      sourceIds[sourceKey] = run.runId;
      sourceStorage[sourceKey] = "director-receipt";
    } else if (observation.authority === "player") {
      declare(sourceKey, aster.actorId, `${observation.step.replace(/-/g, " ")}. ${observation.supportedFact}`);
    } else {
      recap(sourceKey, `${observation.step.replace(/-/g, " ")}. ${observation.supportedFact}`);
    }
  }
  const promise = declare("promise:lantern", aster.actorId, "I promise Keeper Maren that I will relight the harbor lantern.");
  completeNarration(promise, "memory-eval:lantern", "The lantern remained dark; no restoration was committed.");
  const outcome = repo.getCampaignRecall(OWNER, { campaignId: campaign.id, sessionId: session.id, audience: { kind: "player", actorId: aster.actorId }, query: "lantern", purpose: "public-narration" })!.hits.find(hit => hit.sourceKind === "presentation");
  if (!outcome) throw new Error("memory evaluation outcome source missing");
  sourceIds["outcome:lantern"] = outcome.sourceId;
  sourceStorage["outcome:lantern"] = "presentation";
  recap("past:beacon", "Earlier public state: the harbor beacon was dim.");
  recap("current:beacon", "Current public state: the harbor beacon is relit.");
  declare("private:bryn", bryn.actorId, "Bryn privately carries the cedarlight password and ash compass.");
  declare("unicode:cafe", aster.actorId, "The cafe 漢字 ledger records a whole UTF-8 entry.");
  const retry = declare("retry:compass", aster.actorId, "I inspect the violet compass before retrying the narration.");
  const cancelled = repo.updateAdventureTurnNarration(OWNER, { turnId: retry.turnId, expectedTurnRevision: retry.revision, expectedCampaignRevision: retry.campaignRevision, idempotencyKey: "memory-eval:retry:cancel", narrationStatus: "pending", terminalState: "cancelled" });
  const retried = repo.createAdventureTurn(OWNER, { campaignId: campaign.id, sessionId: session.id, timelineId: activeTimelineId(), actorId: aster.actorId,
    declaration: retry.declaration, mode: "narration-retry", priorTurnId: retry.turnId, expectedCampaignRevision: cancelled.campaignRevision, idempotencyKey: "memory-eval:retry:retry" });
  completeNarration(retried, "memory-eval:retry", "The violet compass remains an unresolved presentation, attached to the original intent.");
  declare("oversize:meteor", aster.actorId, `oversized meteor ${"x".repeat(2_100)}`);
  for (let index = 0; index < 12; index++) declare(`packing:${String(index).padStart(2, "0")}`, aster.actorId, `harbor ledger ${index} ${"entry ".repeat(45)}`);
  declare("holdout:passage", aster.actorId, "Keeper Maren did not promise passage to the island.");
  recap("holdout:tide-past", "Earlier public state: the tide signal was red.");
  recap("holdout:tide-current", "Current public state: the tide signal is green, replacing the earlier red signal.");
  declare("holdout:bryn-private", bryn.actorId, "Bryn alone knows the nightjar cipher.");
  return { repo, options, campaign, session, actors: { aster: aster.actorId, bryn: bryn.actorId }, sourceIds, sourceStorage };
}

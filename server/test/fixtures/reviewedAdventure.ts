import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import DatabaseDriver from "better-sqlite3";
import { CHARACTER_BUILDER_STANDARD_ARRAY, SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS } from "@velvet/contracts";
import { buildApp } from "../../src/app.js";
import { closeRepo, createRepository, SRD_5_1_STARTER_CATALOG } from "../../src/repo/index.js";
import { createSession } from "../../src/repo/sessionRepo.js";

export const REVIEWED_ADVENTURE_MANIFEST_VERSION = "1.0.0";
export const REVIEWED_ADVENTURE_NAME = "The Last Harbor Light";
export const REVIEWED_ADVENTURE_PRIVATE_SENTINEL = "HARBOR-SENTINEL-PRIVATE-7";
const OWNER = "local-owner";

type BranchStep = {
  id: string;
  prerequisites: readonly string[];
  action: string;
  candidateFamily: string;
  allowedMutations: readonly string[];
  requiredReceipts: readonly string[];
  forbiddenAssertions: readonly string[];
  stopCondition: string;
};

export const REVIEWED_ADVENTURE_MANIFEST = {
  version: REVIEWED_ADVENTURE_MANIFEST_VERSION,
  name: REVIEWED_ADVENTURE_NAME,
  catalog: {
    rulesProfileId: "srd-5.1:rules:starter-v1",
    packId: SRD_5_1_STARTER_CATALOG.manifest.packId,
    packVersion: SRD_5_1_STARTER_CATALOG.manifest.packVersion,
    raceDefinitionId: "srd-5.1:race:human",
    backgroundDefinitionId: "srd-5.1:background:acolyte",
    classDefinitionId: "srd-5.1:class:fighter",
    enemyDefinitionId: "srd-5.1:enemy-template:goblin",
  },
  keys: {
    outline: "harbor-opening",
    arc: "harbor-arc",
    locations: ["lantern-quay", "keeper-house", "breakwater-cave"],
    npc: "keeper-maren",
    quest: "restore-harbor-light",
    objectives: ["hear-keeper", "secure-lens", "relight-beacon"],
    reward: "harbor-acknowledgment",
    encounter: "goblin-ambush",
    storyNodes: ["keeper-request", "lens-recovered", "harbor-finale"],
    clue: "saltglass-trail",
    privateSentinel: "sentinel-preparation",
  },
  bindings: [
    { node: "lens-recovered", evidenceKind: "quest-objective", targetObjective: "secure-lens" },
    { node: "harbor-finale", evidenceKind: "quest-objective", targetObjective: "relight-beacon" },
  ],
  expectedReadinessWarnings: ["private-artifact", "awaiting-play-evidence"],
  documentedBranchReadinessExpectation: "optional-disconnected-content",
  branches: [
    { id: "withdraw-before-activation", prerequisites: ["fresh prepared campaign"], action: "Player withdraws before room activation.", candidateFamily: "none", allowedMutations: [], requiredReceipts: [], forbiddenAssertions: ["active-combat retreat", "travel", "quest acceptance"], stopCondition: "No room activation or progress exists." },
    { id: "open-conversation", prerequisites: ["activated room", "player at Lantern Quay"], action: "Player opens play and speaks with Keeper Maren; DM publishes only the reviewed opening.", candidateFamily: "DM reveal-node or hold", allowedMutations: ["opening node reveal", "durable player exchange"], requiredReceipts: ["DM receipt if a reviewed node is revealed"], forbiddenAssertions: ["task accepted", "check made", "travel", "durable social agreement"], stopCondition: "The keeper's request is visible and the player still chooses whether to help." },
    { id: "negotiation-success", prerequisites: ["keeper conversation"], action: "Player explicitly asks for an insight check; DM selects the exact offered check candidate and records a successful roll.", candidateFamily: "exact check", allowedMutations: ["one check turn", "one roll receipt"], requiredReceipts: ["exact check receipt classified success"], forbiddenAssertions: ["NPC promise", "quest acceptance", "scene resolution"], stopCondition: "Success is recorded without inferring a negotiated agreement." },
    { id: "negotiation-failure", prerequisites: ["keeper conversation"], action: "Player explicitly asks for the same reviewed check; deterministic roll fails.", candidateFamily: "exact check", allowedMutations: ["one check turn", "one roll receipt"], requiredReceipts: ["exact check receipt classified failure"], forbiddenAssertions: ["success-based reveal", "NPC agreement", "automatic retry"], stopCondition: "Failure remains durable and no success outcome is promoted." },
    { id: "failed-alternate", prerequisites: ["negotiation failure"], action: "Player chooses the public saltglass inspection rather than retrying the failed check.", candidateFamily: "story clue or player-authored no-op", allowedMutations: ["eligible clue discovery"], requiredReceipts: ["clue receipt when revealed"], forbiddenAssertions: ["rerolled success", "forced acceptance", "inventory item claim"], stopCondition: "A supported alternate continues the investigation." },
    { id: "task-and-clue", prerequisites: ["keeper request visible"], action: "Player explicitly accepts Restore the Harbor Light and inspects the public saltglass clue.", candidateFamily: "exact quest lifecycle; DM reveal-clue", allowedMutations: ["quest offered to active", "clue discovery"], requiredReceipts: ["quest acceptance receipt", "clue receipt"], forbiddenAssertions: ["objective complete", "reward claimed", "clue as inventory"], stopCondition: "The active objective and separately discovered clue are visible." },
    { id: "bound-scene-evidence", prerequisites: ["active quest", "secure-lens objective completed through a player turn"], action: "DM uses the pre-authored exact objective binding with fresh committed evidence to resolve Lens Recovered.", candidateFamily: "DM resolve-node", allowedMutations: ["one objective completion", "one bound scene resolution", "one consumed evidence link"], requiredReceipts: ["objective receipt", "bound scene receipt"], forbiddenAssertions: ["evidence reuse", "finale resolution", "beacon restored"], stopCondition: "The bound middle scene resolves exactly once." },
    { id: "safe-route", prerequisites: ["task accepted"], action: "Player authorizes the directed Keeper House route.", candidateFamily: "exact actor travel", allowedMutations: ["one travel receipt", "location discovery"], requiredReceipts: ["exact route receipt"], forbiddenAssertions: ["encounter activation", "combat reward entitlement", "automatic clue"], stopCondition: "Player arrives by the safe reviewed route." },
    { id: "risky-route", prerequisites: ["task accepted"], action: "Player authorizes the directed Breakwater Cave route and elects the optional exact-catalog encounter.", candidateFamily: "exact actor travel; exact encounter materialization", allowedMutations: ["one travel receipt", "one encounter activation"], requiredReceipts: ["exact route receipt", "exact roster encounter receipt"], forbiddenAssertions: ["active-combat retreat", "unreviewed roster", "automatic combat victory"], stopCondition: "Combat begins only after the player elects the risky branch." },
    { id: "combat-and-claim", prerequisites: ["active optional encounter", "player legal combat turn"], action: "Player selects legal actions and end turns; DM resolves only eligible enemy turns; player explicitly claims the available recipient reward.", candidateFamily: "combat action; exact quest lifecycle", allowedMutations: ["legal combat receipts", "terminal encounter", "explicit reward claim"], requiredReceipts: ["combat completion receipt", "claim receipt", "actual supported balance change when a combat reward exists"], forbiddenAssertions: ["retreat", "arbitrary wallet or inventory settlement", "custom reward economic effect"], stopCondition: "Combat is terminal and only supported rewards are claimed." },
    { id: "finale", prerequisites: ["final objective complete", "finale binding has fresh qualifying evidence"], action: "DM resolves the bound Harbor Finale; player explicitly claims the custom acknowledgment reward.", candidateFamily: "DM resolve-node; exact quest lifecycle", allowedMutations: ["final objective completion", "quest completion", "finale resolution", "custom reward claim"], requiredReceipts: ["objective receipt", "finale receipt", "custom claim receipt"], forbiddenAssertions: ["currency", "item", "standing change", "beacon restored before receipts"], stopCondition: "Closure is represented by distinct supported receipts." },
    { id: "owner-complete-reload", prerequisites: ["finale receipts"], action: "Owner explicitly completes the campaign, then reloads read-only state.", candidateFamily: "owner administration", allowedMutations: ["one campaign completion receipt"], requiredReceipts: ["owner completion receipt", "persisted reread"], forbiddenAssertions: ["provider dispatch on reread", "new narration", "inferred completion from prose"], stopCondition: "Owner completion persists and reload causes zero dispatch." },
  ] satisfies readonly BranchStep[],
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

export const REVIEWED_ADVENTURE_MANIFEST_DIGEST = createHash("sha256").update(canonical(REVIEWED_ADVENTURE_MANIFEST)).digest("hex");

const reviewedContent = {
  outlines: [{ key: "harbor-opening", opening: "The Last Harbor Light has gone dark above a restless tide.", premise: "Help Keeper Maren restore the harbor beacon.", startLocationKey: "lantern-quay", visibility: "public" as const }],
  arcs: [{ key: "harbor-arc", title: "The Last Harbor Light", summary: "Trace the missing lens, choose a route, and restore the harbor light.", visibility: "public" as const }],
  locations: [
    { key: "lantern-quay", name: "Lantern Quay", description: "Cold spray reaches the empty beacon stairs.", visibility: "public" as const, discoveries: [], hazards: [], hooks: ["Keeper Maren waits by the quay."], factionKeys: [] },
    { key: "keeper-house", name: "Keeper House", description: "A sheltered house holds charts and dry lamps.", visibility: "public" as const, discoveries: [], hazards: [], hooks: ["A safe path to the lens."], factionKeys: [] },
    { key: "breakwater-cave", name: "Breakwater Cave", description: "A tidal cave opens beyond the broken breakwater.", visibility: "public" as const, discoveries: [], hazards: [], hooks: ["A risky route may hold the lens."], factionKeys: [] },
  ],
  connections: [
    { key: "quay-to-house", fromLocationKey: "lantern-quay", toLocationKey: "keeper-house", description: "A dry lane follows the keeper's wall.", visibility: "public" as const },
    { key: "quay-to-cave", fromLocationKey: "lantern-quay", toLocationKey: "breakwater-cave", description: "Wet stones lead toward the tidal cave.", visibility: "public" as const },
  ],
  factions: [],
  npcs: [{ key: "keeper-maren", name: "Keeper Maren", archetype: "Harbor keeper", description: "Maren speaks plainly, keeping one hand on an unlit lantern.", visibility: "public" as const, locationKey: "lantern-quay", factionKeys: [], privateGoals: REVIEWED_ADVENTURE_PRIVATE_SENTINEL }],
  quests: [{ key: "restore-harbor-light", title: "Restore the Harbor Light", description: "Find the lens and return the harbor beacon to service.", visibility: "public" as const, arcKey: "harbor-arc", locationKeys: ["keeper-house", "breakwater-cave"], journalText: "Keeper Maren asks for help finding the lens.", objectives: [
    { key: "hear-keeper", description: "Hear Keeper Maren's request.", targetProgress: 1, dependencyObjectiveKeys: [], visibility: "public" as const },
    { key: "secure-lens", description: "Secure the harbor lens.", targetProgress: 1, dependencyObjectiveKeys: ["hear-keeper"], visibility: "public" as const },
    { key: "relight-beacon", description: "Relight the harbor beacon.", targetProgress: 1, dependencyObjectiveKeys: ["secure-lens"], visibility: "public" as const },
  ], rewards: [{ key: "harbor-acknowledgment", label: "Keeper's acknowledgment", kind: "custom" as const, amount: null, visibility: "public" as const }] }],
  encounters: [{ key: "goblin-ambush", title: "Goblin Ambush", description: "An optional Goblin ambush waits among the wet stones.", visibility: "public" as const, locationKey: "breakwater-cave", participantNpcKeys: [], objectives: ["Protect the route."], terrain: ["Wet stone."], escalation: [], resolution: "A completed encounter clears the cave route.", enemyReferences: [{ kind: "enemy-template" as const, packId: SRD_5_1_STARTER_CATALOG.manifest.packId, packVersion: SRD_5_1_STARTER_CATALOG.manifest.packVersion, definitionId: "srd-5.1:enemy-template:goblin" }], monsterConceptKeys: [] }],
  clues: [{ key: "saltglass-trail", title: "Saltglass Trail", description: "Saltglass fragments point toward the lens route.", visibility: "public" as const, locationKey: "lantern-quay", revealsStoryNodeKey: "keeper-request" }],
  storyNodes: [
    { key: "keeper-request", title: "Keeper's Request", description: "Maren asks what help you are willing to offer.", visibility: "public" as const },
    { key: "lens-recovered", title: "Lens Recovered", description: "The recovered lens catches the quay's pale light.", visibility: "public" as const },
    { key: "harbor-finale", title: "Harbor Finale", description: "The harbor waits for the final act of restoration.", visibility: "public" as const },
  ],
  storyRelationships: [
    { key: "request-to-lens", fromStoryNodeKey: "keeper-request", toStoryNodeKey: "lens-recovered", description: "The request leads to the lens.", visibility: "public" as const },
    { key: "lens-to-finale", fromStoryNodeKey: "lens-recovered", toStoryNodeKey: "harbor-finale", description: "The lens leads to the finale.", visibility: "public" as const },
  ],
  lore: [], questItems: [], monsterConcepts: [], handouts: [],
  scenePrompts: [{ key: "sentinel-preparation", title: "Sentinel preparation", prompt: REVIEWED_ADVENTURE_PRIVATE_SENTINEL, visibility: "gm" as const, locationKey: "breakwater-cave", npcKeys: [] }],
};

export async function createReviewedAdventure(targetDirectory = process.env.VELVET_DATA_DIR, options: { activateRoom?: boolean; prepareOptionalEncounter?: boolean; rng?: { integer(minimum: number, maximum: number): number }; clock?: { now(): Date } } = {}): Promise<{
  repo: ReturnType<typeof createRepository>;
  campaignId: string;
  sessionId: string;
  actorId: string;
  resourceIds: Record<string, string>;
  optionalEncounterInstanceId: string | null;
  longswordEntryId: string;
  inventoryReceipt: { commandId: string; idempotencyKey: string; revisionBefore: number; revisionAfter: number; occurredAt: string; changedKeys: string[] };
  providerDispatches: number;
}> {
  if (!targetDirectory) throw new Error("reviewed adventure requires an explicit target directory");
  if (!statSync(targetDirectory).isDirectory() || readdirSync(targetDirectory).length !== 0) throw new Error("reviewed adventure target directory must be empty");
  const priorDataDirectory = process.env.VELVET_DATA_DIR;
  process.env.VELVET_DATA_DIR = targetDirectory;
  closeRepo();
  try {
  let providerDispatches = 0;
  const repo = createRepository({ dataDir: targetDirectory, clock: options.clock ?? { now: () => new Date("2036-01-01T00:00:00.000Z") }, ...(options.rng ? { rng: options.rng } : {}) });
  const campaign = repo.createCampaign(OWNER, { name: REVIEWED_ADVENTURE_NAME });
   repo.installSrdStarterCatalog(OWNER);
   repo.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "harbor-catalog" });
  const persona = repo.createCharacter({ name: "Aster Vale", age: 30, archetype: "Lantern Warden", boundaries: "", fictionalConfirmed: true });
   const scores = Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]));
  const draft = repo.createCharacterDraft(OWNER, campaign.id, { personaId: persona.id, controllerPrincipalId: OWNER, durability: "durable", allocation: { method: "standard-array", scores } as any, idempotencyKey: "harbor-character" });
   const definitions = SRD_5_1_STARTER_CATALOG.definitions;
   const selected = repo.updateCharacterDraft(OWNER, draft.draft.id, { expectedRevision: 0, idempotencyKey: "harbor-character-select", selections: { race: definitions.find(item => item.reference.definitionId === REVIEWED_ADVENTURE_MANIFEST.catalog.raceDefinitionId)!.reference, background: definitions.find(item => item.reference.definitionId === REVIEWED_ADVENTURE_MANIFEST.catalog.backgroundDefinitionId)!.reference, class: definitions.find(item => item.reference.definitionId === REVIEWED_ADVENTURE_MANIFEST.catalog.classDefinitionId)!.reference, starterGrant: "kit" } } as any);
  const actorId = repo.finalizeCharacterDraft(OWNER, draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "harbor-character-finalize" }).receipt.actorId;
  const session = await createSession({ characterId: persona.id, title: "Last Harbor Light" });
  repo.attachCampaignSession(OWNER, { campaignId: campaign.id, sessionId: session.id } as any);
  const app = buildApp({ campaignRepositoryFactory: () => repo, campaignContentGeneration: async () => { providerDispatches += 1; throw new Error("provider dispatch is forbidden"); } });
  const generated = await app.inject({ method: "POST", url: "/api/rpg/v1/campaign-content-drafts", headers: { "content-type": "application/json" }, payload: { campaignId: campaign.id, brief: "Reviewed provider-free harbor adventure.", tone: "Hopeful harbor mystery", exclusions: [], sections: ["outline", "arcs", "locations", "npcs", "quests", "encounters", "clues", "story", "scene-prompts"], expandArtifactKeys: [], revisionFeedback: null, idempotencyKey: "harbor-reviewed-stage", reviewedContent } });
  if (generated.statusCode !== 201) throw new Error(`reviewed staging failed: ${generated.body}`);
  const draftId = generated.json().draft.draftId as string;
  const selectedKeys = [
    REVIEWED_ADVENTURE_MANIFEST.keys.outline, REVIEWED_ADVENTURE_MANIFEST.keys.arc,
    ...REVIEWED_ADVENTURE_MANIFEST.keys.locations, REVIEWED_ADVENTURE_MANIFEST.keys.npc,
    REVIEWED_ADVENTURE_MANIFEST.keys.quest, REVIEWED_ADVENTURE_MANIFEST.keys.encounter,
    ...REVIEWED_ADVENTURE_MANIFEST.keys.storyNodes, REVIEWED_ADVENTURE_MANIFEST.keys.clue,
    REVIEWED_ADVENTURE_MANIFEST.keys.privateSentinel,
    "quay-to-house", "quay-to-cave", "request-to-lens", "lens-to-finale",
  ];
  const applied = await app.inject({ method: "POST", url: `/api/rpg/v1/campaign-content-drafts/${draftId}/apply`, headers: { "content-type": "application/json" }, payload: { expectedRevision: 0, idempotencyKey: "harbor-reviewed-apply", selectedArtifactKeys: selectedKeys } });
  if (applied.statusCode !== 200) throw new Error(`reviewed application failed: ${applied.body}`);
  const administration = repo.getCampaignAdministration(OWNER, campaign.id)!;
  repo.updateCampaignAdministration(OWNER, campaign.id, { status: "published", expectedRevision: administration.revision, idempotencyKey: "harbor-publish" });
   const activationInspection = repo.getCampaignRoomActivationReadiness(OWNER, campaign.id, session.id);
   if (!activationInspection.ready) throw new Error(`reviewed room is not activation-ready: ${activationInspection.blockers.join(",")}`);
   if (options.activateRoom !== false) {
    const activation = repo.activateCampaignRoom(OWNER, campaign.id, session.id, { expectedRevision: activationInspection.expectedRevision, idempotencyKey: "harbor-activate" });
    if (!activation.readiness.ready) throw new Error("reviewed room did not activate");
   }
   const inventory = repo.getActorInventorySnapshot(OWNER, campaign.id, actorId);
   if (!inventory) throw new Error("reviewed actor inventory is unavailable");
   const longswords = inventory.inventory.items.filter(item => item.kind === "instanced" && item.item.definitionId === "srd-5.1:item:longsword");
   if (longswords.length !== 1) throw new Error("reviewed Fighter starter longsword is not uniquely materialized");
   const longswordEntryId = longswords[0]!.entryId;
   const equipped = repo.mutateInventoryForActor(OWNER, campaign.id, actorId, {
     kind: "equip", entryId: longswordEntryId, slot: "hand", hand: "main", grip: "one-handed",
     expectedRevision: inventory.revision, idempotencyKey: "harbor-equip-longsword",
   });
   const db = new DatabaseDriver(path.join(targetDirectory, "velvet.sqlite"), { readonly: true });
  try {
    const rows = db.prepare("SELECT artifact_key,server_resource_id FROM campaign_generation_accepted_artifacts_v52 WHERE campaign_id=? AND server_resource_id IS NOT NULL").all(campaign.id) as Array<{ artifact_key: string; server_resource_id: string }>;
    const resourceIds = Object.fromEntries(rows.map(row => [row.artifact_key, row.server_resource_id]));
    const objectiveRows = db.prepare("SELECT objective.objective_id, accepted.artifact_key || ':' || objective.description key FROM quest_objectives_v33 objective JOIN quests quest ON quest.id=objective.quest_id JOIN campaign_generation_accepted_artifacts_v52 accepted ON accepted.campaign_id=quest.campaign_id AND accepted.server_resource_id=quest.id WHERE quest.campaign_id=?").all(campaign.id) as Array<{ objective_id: string; key: string }>;
    for (const objective of objectiveRows) if (objective.key.includes("Hear Keeper")) resourceIds["hear-keeper"] = objective.objective_id; else if (objective.key.includes("Secure the harbor")) resourceIds["secure-lens"] = objective.objective_id; else if (objective.key.includes("Relight")) resourceIds["relight-beacon"] = objective.objective_id;
    const enemy = definitions.find(item => item.reference.definitionId === REVIEWED_ADVENTURE_MANIFEST.catalog.enemyDefinitionId)!.reference as any;
    const optionalEncounterInstanceId = options.prepareOptionalEncounter !== false
       ? repo.createEncounter(OWNER, campaign.id, { sessionId: session.id, name: "Goblin Ambush", combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: enemy, team: "enemies" }], idempotencyKey: "harbor-optional-encounter" }).encounter.encounterId
      : null;
    if (optionalEncounterInstanceId) resourceIds["optional-encounter-instance"] = optionalEncounterInstanceId;
    let storyRevision = repo.getCampaignStory(OWNER, campaign.id)!.revision;
    const lensRecovered = resourceIds["lens-recovered"], secureLens = resourceIds["secure-lens"], harborFinale = resourceIds["harbor-finale"], relightBeacon = resourceIds["relight-beacon"];
    if (!lensRecovered || !secureLens || !harborFinale || !relightBeacon) throw new Error("reviewed resource mapping is incomplete");
    repo.bindDmSceneEvidence(OWNER, campaign.id, { nodeId: lensRecovered, evidence: { kind: "quest-objective", targetId: secureLens }, expectedStoryRevision: storyRevision, idempotencyKey: "harbor-bind-lens" });
    storyRevision = repo.getCampaignStory(OWNER, campaign.id)!.revision;
    repo.bindDmSceneEvidence(OWNER, campaign.id, { nodeId: harborFinale, evidence: { kind: "quest-objective", targetId: relightBeacon }, expectedStoryRevision: storyRevision, idempotencyKey: "harbor-bind-finale" });
     return { repo, campaignId: campaign.id, sessionId: session.id, actorId, resourceIds, optionalEncounterInstanceId, longswordEntryId, inventoryReceipt: equipped.receipt, providerDispatches };
  } finally { db.close(); }
  } finally {
    closeRepo();
    if (priorDataDirectory === undefined) delete process.env.VELVET_DATA_DIR;
    else process.env.VELVET_DATA_DIR = priorDataDirectory;
  }
}

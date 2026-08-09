import { useEffect, useMemo, useState } from "react";
import type { ActorResourcesHttpGetResponse, CampaignWorldHttpResponse, EncounterPublic } from "@velvet/contracts";

type Audience = "gm" | "player";
type Load<T> = { state: "loading"; stale?: T } | { state: "ready"; value: T } | { state: "error"; stale?: T };
type NamedNpc = { id: string; name: string };
type Objective = { id: string; description: string; progress: number; target: number };
type EncounterView = { encounters: EncounterPublic[]; activeCombat: { round: number; currentCombatant: string | null } | null };

/** Narrow, role-filtered read API consumed by the campaign context drawer. */
export interface CampaignContextDrawerApi {
  getCampaignWorld: (campaignId: string) => Promise<{ data: CampaignWorldHttpResponse; revision: number }>;
  listCampaignNpcs: (campaignId: string, audience: Audience) => Promise<{ data: { npcs: Array<{ npcId: string; publicState: { name: string } }> }; revision: number }>;
  listCampaignQuests: (campaignId: string, audience: Audience) => Promise<{ data: { quests: Array<{ questId: string; status: string }>; objectives: Array<{ objectiveId: string; questId: string; description: string; progress: number; targetProgress: number; completedAt: string | null }> }; revision: number }>;
  getActorResources: (campaignId: string, actorId: string) => Promise<ActorResourcesHttpGetResponse>;
  listCampaignEncounters: (campaignId: string) => Promise<{ encounters: EncounterPublic[] }>;
  getCombatState: (combatId: string) => Promise<{ round: number; currentCombatant: string | null }>;
}

/** Props for the independently loading role-safe campaign context drawer. */
export interface CampaignContextDrawerProps {
  campaignId: string;
  selectedActorId: string | null;
  playableActorIds: readonly string[];
  audience: Audience;
  authorizationGeneration: number;
  api: CampaignContextDrawerApi;
}

function status<T>(load: Load<T>, empty: boolean, label: string) {
  if (load.state === "loading" && !load.stale) return <p role="status">Loading {label}…</p>;
  if (load.state === "error" && !load.stale) return <p role="alert">{label} could not be loaded.</p>;
  if (empty) return <p>No {label} available.</p>;
  return null;
}

/** Loads and renders only server projections; it performs no authoritative calculations. */
export function CampaignContextDrawer({ campaignId, selectedActorId, playableActorIds, audience, authorizationGeneration, api }: CampaignContextDrawerProps) {
  const [world, setWorld] = useState<Load<CampaignWorldHttpResponse>>({ state: "loading" });
  const [npcs, setNpcs] = useState<Load<NamedNpc[]>>({ state: "loading" });
  const [objectives, setObjectives] = useState<Load<Objective[]>>({ state: "loading" });
  const [resources, setResources] = useState<Load<ActorResourcesHttpGetResponse | null>>({ state: "loading" });
  const [encounters, setEncounters] = useState<Load<EncounterView>>({ state: "loading" });
  const actorEligible = selectedActorId !== null && playableActorIds.includes(selectedActorId);

  useEffect(() => {
    let current = true;
    // Replace prior role data immediately. GM response objects are never retained;
    // only public names are projected into state.
    setWorld((old) => ({ state: "loading", ...(old.state === "ready" ? { stale: old.value } : {}) }));
    setNpcs({ state: "loading" }); setObjectives({ state: "loading" });
    setResources({ state: "loading" }); setEncounters((old) => ({ state: "loading", ...(old.state === "ready" ? { stale: old.value } : {}) }));
    void api.getCampaignWorld(campaignId).then((value) => { if (current) setWorld({ state: "ready", value: value.data }); }).catch(() => { if (current) setWorld((old) => { const stale = old.state === "ready" ? old.value : old.stale; return { state: "error", ...(stale ? { stale } : {}) }; }); });
    void api.listCampaignNpcs(campaignId, audience).then((value) => { if (current) setNpcs({ state: "ready", value: value.data.npcs.map((npc) => ({ id: npc.npcId, name: npc.publicState.name })) }); }).catch(() => { if (current) setNpcs({ state: "error" }); });
    void api.listCampaignQuests(campaignId, audience).then((value) => { if (!current) return; const active = new Set(value.data.quests.filter((quest) => quest.status === "active").map((quest) => quest.questId));
      setObjectives({ state: "ready", value: value.data.objectives.filter((objective) => active.has(objective.questId) && objective.completedAt === null).map((objective) => ({ id: objective.objectiveId, description: objective.description, progress: objective.progress, target: objective.targetProgress })) });
    }).catch(() => { if (current) setObjectives({ state: "error" }); });
    if (actorEligible && selectedActorId) void api.getActorResources(campaignId, selectedActorId).then((value) => { if (current) setResources({ state: "ready", value }); }).catch(() => { if (current) setResources({ state: "error" }); });
    else setResources({ state: "ready", value: null });
    void api.listCampaignEncounters(campaignId).then(async ({ encounters: rows }) => {
      const active = rows.find((entry) => entry.status === "active" && entry.combatId !== null);
      let activeCombat: EncounterView["activeCombat"] = null;
      if (active?.combatId) try { const combat = await api.getCombatState(active.combatId); activeCombat = { round: combat.round, currentCombatant: combat.currentCombatant }; } catch { /* encounter status remains independently useful */ }
      if (current) setEncounters({ state: "ready", value: { encounters: rows, activeCombat } });
    }).catch(() => { if (current) setEncounters((old) => { const stale = old.state === "ready" ? old.value : old.stale; return { state: "error", ...(stale ? { stale } : {}) }; }); });
    return () => { current = false; };
  }, [api, campaignId, selectedActorId, actorEligible, audience, authorizationGeneration]);

  const worldValue = world.state === "ready" ? world.value : world.stale;
  const actorLocation = actorEligible ? worldValue?.currentLocations.find((entry) => entry.actorId === selectedActorId) : undefined;
  const location = worldValue?.visibleLocations.find((entry) => entry.locationId === actorLocation?.locationId);
  const exits = useMemo(() => actorLocation ? (worldValue?.visibleConnections.filter((entry) => entry.fromLocationId === actorLocation.locationId) ?? []) : [], [actorLocation, worldValue]);
  const npcValue = npcs.state === "ready" ? npcs.value : npcs.stale;
  const objectiveValue = objectives.state === "ready" ? objectives.value : objectives.stale;
  const resourceValue = resources.state === "ready" ? resources.value : resources.stale;
  const encounterValue = encounters.state === "ready" ? encounters.value : encounters.stale;

  return <aside className="campaign-context-drawer" aria-label="Campaign context"><details open><summary>Campaign context</summary>
    <section><h2>Current location</h2>{status(world, !location, "visible location")}{location && <><p><strong>{location.name}</strong></p><p>{location.description}</p><h3>Visible exits from this location</h3>{exits.length ? <ul>{exits.map((exit) => <li key={exit.connectionId}>{worldValue?.visibleLocations.find((entry) => entry.locationId === exit.toLocationId)?.name ?? "Visible destination"}</li>)}</ul> : <p>No server-visible exits from this origin.</p>}</>}</section>
    <section><h2>Visible NPC roster</h2><p className="context-honesty">NPC location or presence is not tracked by the backend; this is a campaign-visible roster, not “NPCs here.”</p>{status(npcs, !npcValue?.length, "visible NPCs")}{npcValue?.length ? <ul>{npcValue.map((npc) => <li key={npc.id}>{npc.name}</li>)}</ul> : null}</section>
    <section><h2>Active objectives</h2>{status(objectives, !objectiveValue?.length, "active objectives")}{objectiveValue?.length ? <ul>{objectiveValue.map((objective) => <li key={objective.id}>{objective.description} <span>{objective.progress} / {objective.target}</span></li>)}</ul> : null}</section>
    <section><h2>Party resources</h2>{status(resources, !resourceValue?.resources.length, "party resources")}{resourceValue?.resources.length ? <ul>{resourceValue.resources.map((resource) => <li key={resource.name}>{resource.name}: {resource.current} / {resource.max}</li>)}</ul> : null}</section>
    <section><h2>Encounter status</h2>{status(encounters, !encounterValue?.encounters.length, "encounters")}{encounterValue?.encounters.length ? <ul>{encounterValue.encounters.map((entry) => <li key={entry.encounterId}>{entry.name}: {entry.status}</li>)}</ul> : null}{encounterValue?.activeCombat && <p>Active combat: round {encounterValue.activeCombat.round}; current combatant {encounterValue.activeCombat.currentCombatant ?? "not assigned"}.</p>}</section>
  </details></aside>;
}

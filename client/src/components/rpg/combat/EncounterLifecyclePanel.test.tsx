import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEncounterGenerationDraft, createEncounterGenerationDraft } from "../../../api";
import { EncounterLifecyclePanel, type EncounterLifecycleApi } from "./EncounterLifecyclePanel";

vi.mock("../../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../api")>(),
  createEncounterGenerationDraft: vi.fn(),
  applyEncounterGenerationDraft: vi.fn(),
}));

const at = "2030-01-01T00:00:00.000Z";
const preparing = { encounterId: "encounter", sessionId: "session", name: "Bridge ambush", status: "preparing" as const, combatId: null, combatants: [], revision: 4, createdAt: at, updatedAt: at };
const active = { ...preparing, status: "active" as const, combatId: "encounter", revision: 5 };
const completed = { ...active, status: "completed" as const, revision: 6 };
const candidates = { sessions: [{ sessionId: "session" }], actors: [{ actorId: "actor", label: "Aria" }], enemies: [{ template: { kind: "enemy-template" as const, packId: "pack", packVersion: "1", definitionId: "wolf" }, label: "Wolf" }], teams: { actor: "allies" as const, enemy: "enemies" as const } };
function api(overrides: Partial<EncounterLifecycleApi> = {}): EncounterLifecycleApi {
  return { listEncounters: vi.fn().mockResolvedValue({ encounters: [preparing] }), getSetupCandidates: vi.fn().mockResolvedValue(candidates), createEncounter: vi.fn().mockResolvedValue({ ...preparing, name: "New encounter", combatants: [{ combatantId: "actor-combatant", kind: "actor" as const, actorId: "actor", team: "allies" as const }, { combatantId: "enemy-combatant", kind: "enemy" as const, template: candidates.enemies[0].template, team: "enemies" as const }] }), getCombat: vi.fn().mockResolvedValue({ combatId: "encounter", round: 1, currentCombatant: null, combatants: [{ combatantId: "actor", kind: "actor", actorId: "actor", team: "allies", hitPoints: 1, maximumHitPoints: 1, status: "active" }], legalActions: [], revision: 8 }), startEncounter: vi.fn().mockResolvedValue({ combat: { combatId: "encounter", round: 1, currentCombatant: null, combatants: [{ combatantId: "actor", kind: "actor", actorId: "actor", team: "allies", hitPoints: 1, maximumHitPoints: 1, status: "active" }], legalActions: [], revision: 5 }, receipt: { idempotencyKey: "key", revisionBefore: 4, revisionAfter: 5, occurredAt: at } }), endCombat: vi.fn().mockResolvedValue({ encounter: completed, rewards: [], receipt: { idempotencyKey: "key", revisionBefore: 8, revisionAfter: 9, occurredAt: at } }), ...overrides };
}

describe("EncounterLifecyclePanel", () => {
  afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
  it("creates a preparing encounter from authorized candidates with fixed teams", async () => {
    const service = api(); render(<EncounterLifecyclePanel campaignId="campaign" api={service} onCombatReady={vi.fn()} onRewards={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Aria"));
    fireEvent.click(screen.getByRole("button", { name: "Create preparing encounter" }));
    await waitFor(() => expect(service.createEncounter).toHaveBeenCalledWith("campaign", expect.objectContaining({ sessionId: "session", combatants: [{ kind: "actor", actorId: "actor", team: "allies" }, { kind: "enemy", template: candidates.enemies[0].template, team: "enemies" }] })));
  });
  it("starts an existing preparing encounter with its exact listed revision", async () => {
    const service = api(), ready = vi.fn(); render(<EncounterLifecyclePanel campaignId="campaign" api={service} onCombatReady={ready} onRewards={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start encounter" }));
    await waitFor(() => expect(service.startEncounter).toHaveBeenCalledWith("encounter", expect.objectContaining({ expectedRevision: 4 })));
    await waitFor(() => expect(ready).toHaveBeenCalledWith("encounter"));
  });
  it("reads the live combat revision before completing and exposes returned rewards", async () => {
    const service = api({ listEncounters: vi.fn().mockResolvedValue({ encounters: [active] }) }), rewards = vi.fn(); render(<EncounterLifecyclePanel campaignId="campaign" api={service} onCombatReady={vi.fn()} onRewards={rewards} />);
    fireEvent.click(await screen.findByRole("button", { name: "Complete encounter" }));
    await waitFor(() => expect(service.endCombat).toHaveBeenCalledWith("encounter", expect.objectContaining({ expectedRevision: 8 })));
    await waitFor(() => expect(rewards).toHaveBeenCalled());
  });
  it("does not replay a reload-restored lifecycle command and reconciles from the list", async () => {
    localStorage.setItem("velvet.encounter-lifecycle.v1:campaign", JSON.stringify({ campaignId: "campaign", encounterId: "encounter", combatId: null, operation: "start", startedAt: at }));
    const service = api({ listEncounters: vi.fn().mockResolvedValue({ encounters: [active] }) }); render(<EncounterLifecyclePanel campaignId="campaign" api={service} onCombatReady={vi.fn()} onRewards={vi.fn()} />);
    await screen.findByText(/Start confirmed by authoritative encounter state/);
    expect(service.startEncounter).not.toHaveBeenCalled();
    expect(localStorage.getItem("velvet.encounter-lifecycle.v1:campaign")).toBeNull();
  });
  it("handles an empty candidate projection without raw identifier inputs", async () => {
    render(<EncounterLifecyclePanel campaignId="campaign" api={api({ getSetupCandidates: vi.fn().mockResolvedValue({ sessions: [], actors: [], enemies: [], teams: candidates.teams }) })} onCombatReady={vi.fn()} onRewards={vi.fn()} />);
    await screen.findByText(/No safe encounter setup candidates/);
    expect(screen.queryByRole("textbox", { name: /actor|session|enemy/i })).toBeNull();
  });
  it("does not replay an ambiguous create after reload and clears only a matching encounter", async () => {
    const request = { sessionId: "session", name: "New encounter", combatants: [{ kind: "actor" as const, actorId: "actor", team: "allies" as const }, { kind: "enemy" as const, template: candidates.enemies[0].template, team: "enemies" as const }], idempotencyKey: "create-key" };
    localStorage.setItem("velvet.encounter-lifecycle.v1:campaign", JSON.stringify({ campaignId: "campaign", operation: "create", request, startedAt: at }));
    const service = api({ listEncounters: vi.fn().mockResolvedValue({ encounters: [preparing] }) }); render(<EncounterLifecyclePanel campaignId="campaign" api={service} onCombatReady={vi.fn()} onRewards={vi.fn()} />);
    await screen.findByText(/Creation was issued once/);
    expect(service.createEncounter).not.toHaveBeenCalled();
    expect(localStorage.getItem("velvet.encounter-lifecycle.v1:campaign")).not.toBeNull();
  });
  it("generates a reviewed draft and applies only the exact reviewed revision", async () => {
    const projection = { draftId: "draft-1", campaignId: "campaign", kind: "encounter" as const, state: "staged" as const, revision: 2, createdAt: at, updatedAt: at };
    vi.mocked(createEncounterGenerationDraft).mockResolvedValue({ draft: projection, encounter: { name: "Bridge ambush", enemyCount: 2, terrain: "Fog", motives: "Hold the line", rewardNarrative: "Spoils" }, validationIssues: [] });
    vi.mocked(applyEncounterGenerationDraft).mockResolvedValue({ draft: { ...projection, state: "applied" }, application: { scope: "encounter", campaignDomainMutated: true, encounterId: "encounter-new" }, receipts: [{ receiptId: "receipt", reviewDecisionId: "decision", scope: "encounter", encounterId: "encounter-new", appliedAt: at }] });
    const service = api(); render(<EncounterLifecyclePanel campaignId="campaign" api={service} onCombatReady={vi.fn()} onRewards={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Aria"));
    fireEvent.click(screen.getByLabelText("Wolf"));
    fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Guard the bridge" } });
    fireEvent.change(screen.getByLabelText("Visible location"), { target: { value: "Bridge" } });
    fireEvent.change(screen.getByLabelText("Tone"), { target: { value: "tense" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate reviewed draft" }));
    await screen.findByText(/Review draft draft-1/);
    expect(createEncounterGenerationDraft).toHaveBeenCalledWith(expect.objectContaining({ campaignId: "campaign", sessionId: "session", partyActorIds: ["actor"], pinnedEnemyTemplates: [candidates.enemies[0].template], difficulty: "standard" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply exact draft" }));
    await waitFor(() => expect(applyEncounterGenerationDraft).toHaveBeenCalledWith("draft-1", expect.objectContaining({ expectedRevision: 2 })));
  });

  it("rejects a selection removed by the authoritative candidate refresh", async () => {
    const service = api({ getSetupCandidates: vi.fn().mockResolvedValueOnce(candidates).mockResolvedValue({ ...candidates, actors: [] }) }); render(<EncounterLifecyclePanel campaignId="campaign" api={service} onCombatReady={vi.fn()} onRewards={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText("Aria"));
    fireEvent.click(screen.getByRole("button", { name: "Create preparing encounter" }));
    await screen.findByText(/Selected setup candidates are stale/);
    expect(service.createEncounter).not.toHaveBeenCalled();
  });
});

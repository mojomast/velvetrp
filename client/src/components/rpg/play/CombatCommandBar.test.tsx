import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CombatCommandBar, type CombatCommandApi } from "./CombatCommandBar";

const encounters = { encounters: [{ encounterId: "enc", sessionId: "session", name: "Dockside", status: "active", combatId: "combat" }] };
const livingActor = { combatantId: "c-lead", kind: "actor", team: "allies", actorId: "lead", displayName: "Lead", hitPoints: 12, maximumHitPoints: 12, status: "active" };
const defeatedEnemy = { combatantId: "c-bandit", kind: "enemy", team: "enemies", displayName: "Bandit", hitPoints: 0, maximumHitPoints: 11, status: "defeated" };

function api(overrides: Record<string, unknown> = {}): CombatCommandApi {
  return {
    listEncounters: vi.fn().mockResolvedValue(encounters),
    getCombat: vi.fn().mockResolvedValue({ round: 3, currentCombatant: null, revision: 7, combatants: [livingActor, defeatedEnemy], legalActions: [], ...overrides }),
    endCombat: vi.fn().mockResolvedValue({ rewards: [{ rewardBundleId: "reward-one" }] }),
    resolveEnemyTurn: vi.fn().mockResolvedValue({}),
  } as unknown as CombatCommandApi;
}
const baseProps = { campaignId: "campaign", sessionId: "session", canManage: true, onOpenCombat: vi.fn(), onInsertDeclaration: vi.fn(), onChanged: vi.fn() };

describe("CombatCommandBar", () => {
  afterEach(cleanup);

  it("completes a terminal encounter from the play surface", async () => {
    const commandApi = api();
    const changed = vi.fn();
    render(<CombatCommandBar {...baseProps} onChanged={changed} controlledActorId="lead" api={commandApi} />);
    expect(await screen.findByText(/ALL ENEMIES DEFEATED/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Complete encounter" }));
    await waitFor(() => expect(vi.mocked(commandApi.endCombat)).toHaveBeenCalledWith("combat", { expectedRevision: 7, idempotencyKey: expect.any(String) }));
    await screen.findByText(/Encounter completed/);
    expect(changed).toHaveBeenCalled();
  });

  it("keeps owner/GM controls hidden from players", async () => {
    render(<CombatCommandBar {...baseProps} canManage={false} controlledActorId="lead" api={api()} />);
    expect(await screen.findByText(/ALL ENEMIES DEFEATED/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Complete encounter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run enemy turn" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open combat" })).toBeTruthy();
  });

  it("runs the enemy turn for an owner/GM when an enemy has the turn", async () => {
    const commandApi = api({ currentCombatant: "c-bandit", combatants: [livingActor, { ...defeatedEnemy, hitPoints: 11, status: "active" }] });
    render(<CombatCommandBar {...baseProps} api={commandApi} />);
    fireEvent.click(await screen.findByRole("button", { name: "Run enemy turn" }));
    await waitFor(() => expect(vi.mocked(commandApi.resolveEnemyTurn!)).toHaveBeenCalledWith("combat", { expectedRevision: 7, idempotencyKey: expect.any(String) }));
    await screen.findByText(/Enemy turn resolved/);
  });

  it("offers End turn insertion on the controlled actor's turn", async () => {
    const insert = vi.fn();
    render(<CombatCommandBar {...baseProps} controlledActorId="lead" onInsertDeclaration={insert} api={api({ currentCombatant: "c-lead", combatants: [livingActor, { ...defeatedEnemy, hitPoints: 11, status: "active" }] })} />);
    expect(await screen.findByText(/YOUR TURN/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End turn" }));
    expect(insert).toHaveBeenCalledWith("I end my turn.");
  });
});

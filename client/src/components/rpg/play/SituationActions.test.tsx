import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SituationActions, type SituationActionsApi } from "./SituationActions";

const encounters = { encounters: [{ encounterId: "enc", sessionId: "session", name: "Dockside", status: "active", combatId: "combat" }] };
const baseCombat = {
  round: 2, currentCombatant: "c-lead", revision: 5,
  combatants: [
    { combatantId: "c-lead", kind: "actor", team: "allies", actorId: "lead", displayName: "Lead", hitPoints: 12, maximumHitPoints: 12, status: "active" },
    { combatantId: "c-partner", kind: "actor", team: "allies", actorId: "partner", displayName: "Partner", hitPoints: 12, maximumHitPoints: 12, status: "active" },
    { combatantId: "c-bandit", kind: "enemy", team: "enemies", displayName: "Bandit", hitPoints: 11, maximumHitPoints: 11, status: "active" },
  ],
  legalActions: [
    { legalActionId: "attack", kind: "attack", targetIds: ["c-bandit"], cost: "action" },
    { legalActionId: "dash", kind: "dash", targetIds: [], cost: "action" },
    { legalActionId: "end-turn", kind: "end-turn", targetIds: [], cost: null },
  ],
};

function api(currentCombatant = "c-lead"): SituationActionsApi {
  return {
    listEncounters: vi.fn().mockResolvedValue(encounters),
    getCombat: vi.fn().mockResolvedValue({ ...baseCombat, currentCombatant }),
  } as unknown as SituationActionsApi;
}

describe("SituationActions", () => {
  afterEach(cleanup);

  it("offers the controlled actor's legal actions as exact declaration buttons", async () => {
    const insert = vi.fn();
    render(<SituationActions campaignId="campaign" sessionId="session" controlledActorId="lead" api={api()} onInsert={insert} />);
    expect(await screen.findByRole("button", { name: "Attack: Bandit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "End turn" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dash" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Attack: Bandit" }));
    expect(insert).toHaveBeenCalledWith("I attack Bandit with my weapon.");
    fireEvent.click(screen.getByRole("button", { name: "End turn" }));
    expect(insert).toHaveBeenCalledWith("I end my turn.");
  });

  it("offers the death save when it is the only legal action", async () => {
    const saveApi = { listEncounters: vi.fn().mockResolvedValue(encounters),
      getCombat: vi.fn().mockResolvedValue({ ...baseCombat, legalActions: [{ legalActionId: "death-save", kind: "death-save", targetIds: [], cost: null }] }) } as unknown as SituationActionsApi;
    render(<SituationActions campaignId="campaign" sessionId="session" controlledActorId="lead" api={saveApi} onInsert={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Make death save" })).toBeTruthy();
  });

  it("waits when it is another combatant's turn", async () => {
    render(<SituationActions campaignId="campaign" sessionId="session" controlledActorId="lead" api={api("c-bandit")} onInsert={vi.fn()} />);
    expect(await screen.findByText(/Another combatant's turn|not this character's turn/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "End turn" })).toBeNull();
  });
});

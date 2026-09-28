import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { GmCampaignFactionsHttpResponse } from "@velvet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FactionStandingPanel } from "./FactionStandingPanel";

const at = "2030-01-01T00:00:00.000Z";
const data: GmCampaignFactionsHttpResponse = {
  factions: [
    { factionId: "guild", name: "Guild", publicState: { description: "Traders" }, privateState: { gmNotes: "Secret", visibility: "public" }, createdAt: at },
    { factionId: "rivals", name: "Rivals", publicState: { description: "Raiders" }, privateState: { gmNotes: "Secret", visibility: "public" }, createdAt: at },
  ],
  standings: [], memberships: [
    { campaignId: "campaign", factionId: "guild", actorId: "actor", role: "associate", joinedAt: at },
    { campaignId: "campaign", factionId: "guild", npcId: "npc", role: "leader", joinedAt: at },
  ], relations: [{ fromFactionId: "guild", toFactionId: "rivals", disposition: "hostile", updatedAt: at }],
};
const noop = async () => undefined;

afterEach(cleanup);

describe("FactionStandingPanel faction commands", () => {
  it("shows standings, memberships, and relations without a new bare duplicate control", () => {
    render(<FactionStandingPanel data={data} revision={4} isGm locked={false} onCreate={noop} onReputation={noop} onPreview={() => undefined}
      actors={[{ id: "actor", name: "Tala" }]} npcs={[{ id: "npc", name: "Mira" }]} />);
    expect(screen.getByText(/Tala: associate/)).toBeTruthy();
    expect(screen.getByText(/Mira: leader/)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Faction relations" })).getByText("hostile")).toBeTruthy();
  });

  it("issues an explicit relation command only on submit", () => {
    const onRelation = vi.fn().mockResolvedValue(undefined);
    render(<FactionStandingPanel data={data} revision={4} isGm locked={false} onCreate={noop} onReputation={noop} onRelation={onRelation}
      onActorMembership={vi.fn().mockResolvedValue(undefined)} onNpcMembership={vi.fn().mockResolvedValue(undefined)} onReaction={vi.fn().mockResolvedValue(undefined)}
      onPreview={() => undefined} actors={[{ id: "actor", name: "Tala" }]} npcs={[{ id: "npc", name: "Mira" }]} />);
    expect(onRelation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Set a faction relation"));
    fireEvent.change(screen.getByLabelText("Source faction"), { target: { value: "guild" } });
    fireEvent.change(screen.getByLabelText("Target faction"), { target: { value: "rivals" } });
    fireEvent.change(screen.getByLabelText("Disposition"), { target: { value: "allied" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply exact relation command" }));
    expect(onRelation).toHaveBeenCalledTimes(1);
    expect(onRelation.mock.calls[0]![0]).toBe("guild");
    expect(onRelation.mock.calls[0]![1]).toMatchObject({ toFactionId: "rivals", disposition: "allied", expectedRevision: 4 });
  });

  it("issues actor and character membership commands with the exact role vocabulary", () => {
    const onActorMembership = vi.fn().mockResolvedValue(undefined), onNpcMembership = vi.fn().mockResolvedValue(undefined);
    render(<FactionStandingPanel data={data} revision={7} isGm locked={false} onCreate={noop} onReputation={noop}
      onActorMembership={onActorMembership} onNpcMembership={onNpcMembership} onPreview={() => undefined}
      actors={[{ id: "actor", name: "Tala" }]} npcs={[{ id: "npc", name: "Mira" }]} />);
    fireEvent.click(screen.getByText("Set an actor membership"));
    fireEvent.change(screen.getByLabelText("Membership faction"), { target: { value: "guild" } });
    fireEvent.change(screen.getByLabelText("Campaign actor"), { target: { value: "actor" } });
    fireEvent.change(screen.getByLabelText("Actor role"), { target: { value: "enemy" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply exact actor membership command" }));
    expect(onActorMembership.mock.calls[0]![1]).toMatchObject({ actorId: "actor", role: "enemy", expectedRevision: 7 });
    fireEvent.click(screen.getByText("Set a character membership"));
    fireEvent.change(screen.getByLabelText("Character faction"), { target: { value: "guild" } });
    fireEvent.change(screen.getByLabelText("Campaign character"), { target: { value: "npc" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply exact character membership command" }));
    expect(onNpcMembership.mock.calls[0]![1]).toMatchObject({ npcId: "npc", role: "member", expectedRevision: 7 });
  });
});

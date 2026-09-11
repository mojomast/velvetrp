import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionManagementProjection } from "@velvet/contracts";
import { ApiError } from "../../../api";
import { CompanionAdministrationPanel, type CompanionAdministrationApi } from "./CompanionAdministrationPanel";

afterEach(cleanup);
const at = "2030-01-01T00:00:00.000Z", future = "2036-01-01T00:00:00.000Z";
const rooms = { attached: [{ sessionId: "room-1", title: "Quay", participantNames: ["Aria"], createdAt: at, attachedAt: at, stopped: false }], eligible: [] };
const memberships = { memberships: [{ principalId: "member-1", role: "player" as const, createdAt: at }, { principalId: "local-owner", role: "owner" as const, createdAt: at }] };
const projection: CompanionManagementProjection = {
  campaignId: "campaign", sessionId: "room-1", npcId: "npc-1", state: "active", revision: 2, createdAt: at, updatedAt: at,
  grants: [{
    grantId: "grant-1", campaignId: "campaign", npcId: "npc-1", grantedByPrincipalId: "local-owner", granteePrincipalId: "member-1",
    allowedCommandFamilies: ["rest"], actorScope: { kind: "campaign-actor", actorId: "actor-1" }, resourceScope: { kind: "actor-resources" },
    maxSpend: 3, maxUses: 2, startsAt: at, expiresAt: future, confirmationPolicy: "always", revokedAt: null, revocationReason: null, createdAt: at,
    exercise: { available: false, reason: "requires-authenticated-principal-boundary-l5" },
  }],
};
function api(overrides: Partial<CompanionAdministrationApi> = {}): CompanionAdministrationApi {
  return { get: vi.fn().mockResolvedValue({ companion: projection }), command: vi.fn().mockResolvedValue({ receipt: { kind: "grant-revoke", revisionBefore: 2, revisionAfter: 3, occurredAt: at } }), listMemberships: vi.fn().mockResolvedValue(memberships), listRooms: vi.fn().mockResolvedValue(rooms), ...overrides };
}
const actors = [{ actorId: "actor-1", name: "Aria" }];

describe("CompanionAdministrationPanel", () => {
  it("offers companion creation at revision zero when the NPC is not yet a companion", async () => {
    const command = vi.fn().mockResolvedValue({ receipt: { kind: "companion-create", revisionBefore: 0, revisionAfter: 1, occurredAt: at } });
    const get = vi.fn().mockRejectedValue(new ApiError(404, "not found"));
    render(<CompanionAdministrationPanel campaignId="campaign" npcId="npc-1" npcName="Guide" canAdminister actors={actors} api={api({ get, command })} />);
    await screen.findByText("This NPC is not a companion yet.");
    fireEvent.change(screen.getByLabelText("Attached room"), { target: { value: "room-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create companion" }));
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith("campaign", "npc-1", expect.objectContaining({ kind: "companion-create", sessionId: "room-1", expectedRevision: 0 }));
  });

  it("revokes a grant against the authoritative companion revision", async () => {
    const command = vi.fn().mockResolvedValue({ receipt: { kind: "grant-revoke", revisionBefore: 2, revisionAfter: 3, occurredAt: at } });
    render(<CompanionAdministrationPanel campaignId="campaign" npcId="npc-1" npcName="Guide" canAdminister actors={actors} api={api({ command })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant" }));
    expect(command).toHaveBeenCalledWith("campaign", "npc-1", expect.objectContaining({ kind: "grant-revoke", grantId: "grant-1", expectedRevision: 2 }));
  });

  it("renders no companion controls to non-administrators", () => {
    render(<CompanionAdministrationPanel campaignId="campaign" npcId="npc-1" npcName="Guide" canAdminister={false} actors={actors} api={api()} />);
    expect(screen.queryByRole("heading", { name: /Companion administration for/ })).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiInputError, commandCompanionAdministration, getCompanionAdministration } from "./api";

const at = "2035-01-01T00:00:00.000Z";
const later = "2035-01-02T00:00:00.000Z";
const managementGrant = { grantId: "grant-private", campaignId: "campaign:one", npcId: "npc:one",
  grantedByPrincipalId: "owner-private", granteePrincipalId: "player-private", allowedCommandFamilies: ["rest"],
  actorScope: { kind: "campaign-actor", actorId: "actor-private" }, resourceScope: { kind: "actor-resources" },
  maxSpend: null, maxUses: 2, startsAt: at, expiresAt: later, revokedAt: null, revocationReason: null,
  confirmationPolicy: "always", createdAt: at,
  exercise: { available: false, reason: "requires-authenticated-principal-boundary-l5" } } as const;
const companion = { campaignId: "campaign:one", sessionId: "session", npcId: "npc:one", state: "active" as const,
  revision: 1, createdAt: at, updatedAt: at, grants: [managementGrant] };

afterEach(() => vi.unstubAllGlobals());

describe("M5.2 companion administration client transport", () => {
  it("encodes path identities once, uses no-store, and binds the strict management projection", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ companion }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ companion }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ companion: { ...companion, npcId: "foreign" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ companion: { ...companion, internalId: "secret" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCompanionAdministration("campaign:one", "npc:one")).resolves.toEqual({ companion });
    expect((await getCompanionAdministration("campaign:one", "npc:one")).companion.grants[0]).toEqual(managementGrant);
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      "/api/rpg/v1/campaigns/campaign%3Aone/npcs/npc%3Aone/companion-administration",
      expect.objectContaining({ cache: "no-store" }));
    await expect(getCompanionAdministration("campaign:one", "npc:one")).rejects.toThrow(/did not match/);
    await expect(getCompanionAdministration("campaign:one", "npc:one")).rejects.toThrow();
  });

  it("posts exactly once with strict input and binds only the safe receipt", async () => {
    const command = { kind: "grant-revoke" as const, grantId: "grant", reason: "No longer needed.",
      expectedRevision: 1, idempotencyKey: "revoke" };
    const response = { receipt: { kind: "grant-revoke", revisionBefore: 1, revisionAfter: 2, occurredAt: at } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(commandCompanionAdministration("campaign:one", "npc:one", command)).resolves.toEqual(response);
    expect(response.receipt).not.toHaveProperty("grantId");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rpg/v1/campaigns/campaign%3Aone/npcs/npc%3Aone/companion-administration/commands",
      expect.objectContaining({ method: "POST", cache: "no-store", body: JSON.stringify(command) }));
  });

  it("rejects hostile identity input before fetch and output identity/privacy drift after one POST", async () => {
    const command = { kind: "companion-create" as const, sessionId: "session", expectedRevision: 0, idempotencyKey: "create" };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ receipt: {
      kind: "grant-create", revisionBefore: 0, revisionAfter: 1, occurredAt: at,
    } }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ receipt: {
      kind: "companion-create", revisionBefore: 0, revisionAfter: 1, occurredAt: at,
      commandId: "secret", grantId: "grant-private",
    } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(commandCompanionAdministration("campaign", "npc", {
      ...command, callerPrincipalId: "attacker",
    } as typeof command)).rejects.toBeInstanceOf(ApiInputError);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(commandCompanionAdministration("campaign", "npc", command)).rejects.toThrow(/did not match/);
    await expect(commandCompanionAdministration("campaign", "npc", command)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

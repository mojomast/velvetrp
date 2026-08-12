import { describe, expect, expectTypeOf, it } from "vitest";
import {
  companionAdministrationHttpCommandResponseSchema,
  companionAdministrationHttpCommandSchema,
  companionAdministrationHttpGetResponseSchema,
  companionAdministrationHttpReceiptSchema,
  companionAdministrationRepositoryPayload,
  type CompanionAdministrationHttpCommandResponse,
} from "../src/companion-http.js";

const at = "2035-01-01T00:00:00.000Z";
const later = "2035-01-02T00:00:00.000Z";
const control = { expectedRevision: 1, idempotencyKey: "companion-command" };
const grant = {
  kind: "grant-create" as const, granteePrincipalId: "player", allowedCommandFamilies: ["rest" as const],
  actorScope: { kind: "campaign-actor" as const, actorId: "actor" }, resourceScope: { kind: "actor-resources" as const },
  maxSpend: null, maxUses: 2, startsAt: at, expiresAt: later, confirmationPolicy: "always" as const, ...control,
};

describe("M5.2 companion administration HTTP contracts", () => {
  it("accepts only the three strict path-owned commands", () => {
    const commands = [
      { kind: "companion-create", sessionId: "session", expectedRevision: 0, idempotencyKey: "create" },
      grant,
      { kind: "grant-revoke", grantId: "grant", reason: "No longer needed.", ...control },
    ] as const;
    for (const command of commands) expect(companionAdministrationHttpCommandSchema.parse(command)).toEqual(command);
    for (const command of commands) for (const hostile of [
      { campaignId: "foreign" }, { npcId: "foreign" }, { principalId: "attacker" },
      { callerPrincipalId: "attacker" }, { impersonatePrincipalId: "owner" }, { authorization: "attacker" },
    ]) expect(companionAdministrationHttpCommandSchema.safeParse({ ...command, ...hostile }).success).toBe(false);
    expect(companionAdministrationHttpCommandSchema.safeParse({ ...grant, grantId: "caller-selected" }).success).toBe(false);
    expect(companionAdministrationHttpCommandSchema.safeParse({ ...grant, kind: "grant-revoke" }).success).toBe(false);
  });

  it("publishes exact receipt-only keys and rejects every sensitive full-receipt field", () => {
    const receipt = { kind: "grant-create", revisionBefore: 1, revisionAfter: 2, occurredAt: later } as const;
    expect(Object.keys(companionAdministrationHttpReceiptSchema.parse(receipt))).toEqual([
      "kind", "revisionBefore", "revisionAfter", "occurredAt",
    ]);
    for (const field of ["grantId", "commandId", "receiptId", "idempotencyKey", "commandPayloadDigest",
      "outcome", "outcomeDigest", "key", "principalId", "campaignId", "npcId"]) {
      expect(companionAdministrationHttpReceiptSchema.safeParse({ ...receipt, [field]: "secret" }).success).toBe(false);
    }
    expect(companionAdministrationHttpReceiptSchema.safeParse({ ...receipt, revisionAfter: 3 }).success).toBe(false);
    const response = companionAdministrationHttpCommandResponseSchema.parse({ receipt });
    expect(Object.keys(response)).toEqual(["receipt"]);
    expectTypeOf<CompanionAdministrationHttpCommandResponse>().toEqualTypeOf<{
      receipt: { kind: "companion-create" | "grant-create" | "grant-revoke"; revisionBefore: number; revisionAfter: number; occurredAt: string };
    }>();
  });

  it("reconstructs each exact path-bound repository payload without command controls", () => {
    expect(companionAdministrationRepositoryPayload("npc", {
      kind: "companion-create", sessionId: "session", expectedRevision: 0, idempotencyKey: "create",
    })).toEqual({ npcId: "npc", sessionId: "session" });
    expect(companionAdministrationRepositoryPayload("npc", grant)).toEqual({
      actorScope: grant.actorScope, allowedCommandFamilies: grant.allowedCommandFamilies,
      confirmationPolicy: grant.confirmationPolicy, expiresAt: grant.expiresAt,
      granteePrincipalId: grant.granteePrincipalId, maxSpend: grant.maxSpend, maxUses: grant.maxUses,
      npcId: "npc", resourceScope: grant.resourceScope, startsAt: grant.startsAt,
    });
    expect(companionAdministrationRepositoryPayload("npc", {
      kind: "grant-revoke", grantId: "grant", reason: "No longer needed.", ...control,
    })).toEqual({ grantId: "grant", npcId: "npc", reason: "No longer needed." });
  });

  it("strictly preserves the owner/GM management projection", () => {
    const managementGrant = { grantId: "grant", campaignId: "campaign", npcId: "npc",
      grantedByPrincipalId: "owner", granteePrincipalId: "player", allowedCommandFamilies: ["rest"],
      actorScope: { kind: "campaign-actor", actorId: "actor" }, resourceScope: { kind: "actor-resources" },
      maxSpend: null, maxUses: 2, startsAt: at, expiresAt: later, revokedAt: null, revocationReason: null,
      confirmationPolicy: "always", createdAt: at,
      exercise: { available: false, reason: "requires-authenticated-principal-boundary-l5" },
    } as const;
    const companion = { campaignId: "campaign", sessionId: "session", npcId: "npc", state: "active", revision: 1,
      createdAt: at, updatedAt: at, grants: [managementGrant] } as const;
    expect(companionAdministrationHttpGetResponseSchema.parse({ companion })).toEqual({ companion });
    expect(companionAdministrationHttpGetResponseSchema.parse({ companion }).companion.grants[0]).toEqual(managementGrant);
    expect(companionAdministrationHttpGetResponseSchema.safeParse({ companion, public: true }).success).toBe(false);
    expect(companionAdministrationHttpGetResponseSchema.safeParse({ companion: { ...companion, internalId: "secret" } }).success).toBe(false);
  });
});

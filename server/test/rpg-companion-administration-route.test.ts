import { createHash } from "node:crypto";
import { canonicalAgentJson, companionAdministrationRepositoryPayload,
  type CompanionAdministrationHttpCommand } from "@velvet/contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { companionAdministrationHttpRoutes } from "../src/routes/rpg/v1/companionAdministration.js";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";
import {
  CompanionAuthorizationError, CompanionConflictError, CompanionStaleError, CompanionUnavailableError,
} from "../src/repo/companionRepo.js";

const at = "2035-01-01T00:00:00.000Z";
const later = "2035-01-02T00:00:00.000Z";
const createCommand: CompanionAdministrationHttpCommand = {
  kind: "companion-create", sessionId: "session", expectedRevision: 0, idempotencyKey: "create",
};
const grantCommand: CompanionAdministrationHttpCommand = {
  kind: "grant-create", granteePrincipalId: "player", allowedCommandFamilies: ["rest"],
  actorScope: { kind: "campaign-actor", actorId: "actor" }, resourceScope: { kind: "actor-resources" },
  maxSpend: null, maxUses: 2, startsAt: at, expiresAt: later, confirmationPolicy: "always",
  expectedRevision: 1, idempotencyKey: "grant",
};
const revokeCommand: CompanionAdministrationHttpCommand = {
  kind: "grant-revoke", grantId: "grant", reason: "No longer needed.",
  expectedRevision: 1, idempotencyKey: "revoke",
};
const payloadDigest = (command: CompanionAdministrationHttpCommand) => createHash("sha256")
  .update(canonicalAgentJson(companionAdministrationRepositoryPayload("npc", command) as never)).digest("hex");
const managementGrant = { grantId: "grant-private", campaignId: "campaign", npcId: "npc",
  grantedByPrincipalId: "owner-private", granteePrincipalId: "player-private", allowedCommandFamilies: ["rest" as const],
  actorScope: { kind: "campaign-actor" as const, actorId: "actor-private" }, resourceScope: { kind: "actor-resources" as const },
  maxSpend: null, maxUses: 2, startsAt: at, expiresAt: later, revokedAt: null, revocationReason: null,
  confirmationPolicy: "always" as const, createdAt: at,
  exercise: { available: false as const, reason: "requires-authenticated-principal-boundary-l5" as const } };
const companion = { campaignId: "campaign", sessionId: "session", npcId: "npc", state: "active" as const,
  revision: 1, createdAt: at, updatedAt: at, grants: [managementGrant] };
const receipt = { receiptId: "receipt-secret", commandId: "command-secret", campaignId: "campaign", npcId: "npc",
  idempotencyKey: "create", kind: "companion-create" as const, resultingRevision: 1,
  commandPayloadDigest: payloadDigest(createCommand), outcome: { grantId: "grant-secret" },
  outcomeDigest: "a".repeat(64), occurredAt: at };

function setup(overrides: Record<string, unknown> = {}) {
  const repo = { getCompanionManagement: vi.fn(() => companion), createCompanion: vi.fn(() => receipt),
    createCompanionGrant: vi.fn(() => ({ ...receipt, idempotencyKey: "grant", kind: "grant-create", resultingRevision: 2,
      commandPayloadDigest: payloadDigest(grantCommand) })),
    revokeCompanionGrant: vi.fn(() => ({ ...receipt, idempotencyKey: "revoke", kind: "grant-revoke", resultingRevision: 2,
      commandPayloadDigest: payloadDigest(revokeCommand) })),
    ...overrides };
  const accessor = vi.fn(() => repo);
  const app = Fastify();
  app.register(companionAdministrationHttpRoutes, { prefix: "/api/rpg/v1", companionRepositoryAccessor: accessor as never });
  return { app, repo, accessor };
}

afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });
function enable(): void { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; }

describe("M5.2 companion administration HTTP routes", () => {
  it("is composed into the app with the narrow repository capability and no HEAD route", async () => {
    enable();
    const repository = {
      close: vi.fn(), listCampaigns: () => [], getCompanionManagement: vi.fn(() => companion),
      createCompanion: vi.fn(() => receipt), createCompanionGrant: vi.fn(), revokeCompanionGrant: vi.fn(),
    } as unknown as CampaignListRepository;
    const app = buildApp({ campaignRepositoryFactory: () => repository });
    const base = "/api/rpg/v1/campaigns/campaign/npcs/npc/companion-administration";

    const response = await app.inject({ method: "GET", url: base });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ companion });
    const head = await app.inject({ method: "HEAD", url: base });
    expect(head.statusCode).toBe(404);
    expect(head.headers["content-type"]).toContain("application/problem+json");
    const unsupported = await app.inject({ method: "PUT", url: base });
    expect(unsupported.statusCode).toBe(404);
    expect(unsupported.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND",
      instance: "/api/rpg/v1/campaigns/:campaignId/npcs/:npcId/companion-administration" });
    for (const url of [base.replace("/campaigns/campaign/", "/campaigns/%zz/"),
      base.replace("/campaigns/campaign/", `/campaigns/${"x".repeat(129)}/`)]) {
      const invalid = await app.inject({ method: "GET", url });
      expect(invalid.statusCode).toBe(404);
      expect(invalid.json()).toMatchObject({ code: "RPG_COMPANION_ADMINISTRATION_NOT_FOUND",
        instance: "/api/rpg/v1/campaigns/:campaignId/npcs/:npcId/companion-administration" });
    }
    const lookalike = await app.inject({ method: "GET", url: base.replace("companion-administration", "companion-administrations")
      .replace("/campaigns/campaign/", "/campaigns/%zz/") });
    expect(lookalike.statusCode).toBe(400);
    expect(lookalike.json()).toMatchObject({ code: "FST_ERR_BAD_URL" });
    expect(repository.getCompanionManagement).toHaveBeenCalledOnce();
    await app.close();
  });

  it("applies both gates before validation or repository access", async () => {
    const { app, accessor } = setup();
    for (const flags of [[], ["campaign"], ["mechanics"]]) {
      if (flags.includes("campaign")) process.env.FEATURE_RPG_CAMPAIGN = "true"; else delete process.env.FEATURE_RPG_CAMPAIGN;
      if (flags.includes("mechanics")) process.env.FEATURE_RPG_MECHANICS = "true"; else delete process.env.FEATURE_RPG_MECHANICS;
      const response = await app.inject({ method: "POST",
        url: "/api/rpg/v1/campaigns/%20/npcs/%20/companion-administration/commands?secret=1",
        headers: { "content-type": "text/plain" }, payload: "hostile" });
      expect(response.statusCode).toBe(404); expect(response.body).not.toMatch(/secret|hostile/);
    }
    expect(accessor).not.toHaveBeenCalled(); await app.close();
  });

  it("reads owner/GM management with fixed local ownership, exact binding, and no-store", async () => {
    enable(); const { app, repo } = setup();
    const response = await app.inject({ method: "GET",
      url: "/api/rpg/v1/campaigns/campaign/npcs/npc/companion-administration",
      headers: { authorization: "Bearer attacker", "x-principal-id": "attacker" } });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ companion });
    expect(response.json().companion.grants[0]).toEqual(managementGrant);
    expect(repo.getCompanionManagement).toHaveBeenCalledWith("local-owner", "campaign", "npc");
    await app.close();
  });

  it("dispatches all strict commands with path-owned IDs and returns only safe receipt fields", async () => {
    enable(); const { app, repo } = setup();
    const commands = [createCommand, grantCommand, revokeCommand];
    for (const command of commands) {
      const response = await app.inject({ method: "POST",
        url: "/api/rpg/v1/campaigns/campaign/npcs/npc/companion-administration/commands",
        headers: { "content-type": "application/json; charset=utf-8", authorization: "attacker" }, payload: command });
      expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
      expect(Object.keys(response.json().receipt)).toEqual(["kind", "revisionBefore", "revisionAfter", "occurredAt"]);
      expect(response.body).not.toMatch(/secret|commandId|receiptId|grantId|digest|outcome|idempotencyKey/);
    }
    expect(repo.createCompanion).toHaveBeenCalledWith("local-owner", "campaign", {
      sessionId: "session", npcId: "npc", expectedRevision: 0, idempotencyKey: "create",
    });
    expect(repo.createCompanionGrant).toHaveBeenCalledWith("local-owner", "campaign", expect.objectContaining({ npcId: "npc" }));
    expect(repo.revokeCompanionGrant).toHaveBeenCalledWith("local-owner", "campaign", expect.objectContaining({ npcId: "npc", grantId: "grant" }));
    await app.close();
  });

  it("rejects query, GET bodies, invalid paths, media, hostile identity, and implicit HEAD", async () => {
    enable(); const { app, accessor } = setup();
    const base = "/api/rpg/v1/campaigns/campaign/npcs/npc/companion-administration";
    expect((await app.inject({ method: "GET", url: `${base}?x=1` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: base, headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: base.replace("campaign", "%20") })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `${base}/commands`, headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    for (const extra of [{ campaignId: "foreign" }, { npcId: "foreign" }, { principalId: "attacker" }, { callerPrincipalId: "attacker" }]) {
      const response = await app.inject({ method: "POST", url: `${base}/commands`, headers: { "content-type": "application/json" },
        payload: { kind: "companion-create", sessionId: "session", expectedRevision: 0, idempotencyKey: "create", ...extra } });
      expect(response.statusCode).toBe(400);
    }
    expect((await app.inject({ method: "HEAD", url: base })).statusCode).toBe(404);
    expect(accessor).not.toHaveBeenCalled(); await app.close();
  });

  it("maps unavailable/auth to non-disclosing 404 and stale/conflict to redacted 409", async () => {
    enable();
    for (const [error, status, code] of [
      [new CompanionAuthorizationError("private"), 404, "RPG_COMPANION_ADMINISTRATION_NOT_FOUND"],
      [new CompanionUnavailableError("private"), 404, "RPG_COMPANION_ADMINISTRATION_NOT_FOUND"],
      [new CompanionStaleError("private"), 409, "RPG_COMPANION_ADMINISTRATION_STALE"],
      [new CompanionConflictError("private"), 409, "RPG_COMPANION_ADMINISTRATION_CONFLICT"],
    ] as const) {
      const { app } = setup({ createCompanion: () => { throw error; } });
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/npcs/npc/companion-administration/commands",
        headers: { "content-type": "application/json" },
        payload: { kind: "companion-create", sessionId: "session", expectedRevision: 0, idempotencyKey: "create" } });
      expect(response.statusCode).toBe(status); expect(response.json()).toMatchObject({ code });
      expect(response.body).not.toContain("private"); await app.close();
    }
  });

  it("fails closed on management output mismatch while allowing authoritative GET retry", async () => {
    enable();
    const reads = [null, { ...companion, campaignId: "foreign-secret" }, { ...companion, internalId: "internal-secret" }];
    for (const result of reads) {
      const { app } = setup({ getCompanionManagement: () => result });
      const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/npcs/npc/companion-administration" });
      expect(response.statusCode).toBe(result === null || "campaignId" in result && result.campaignId !== "campaign" ? 404 : 500);
      if (response.statusCode === 500) {
        expect(response.body).toContain("retry the authoritative administration GET");
        expect(response.body).not.toContain("do not automatically retry");
      }
      expect(response.body).not.toMatch(/foreign-secret|internal-secret/); await app.close();
    }
  });

  it("rejects full receipt and canonical payload digest mismatches as ambiguous non-retryable writes", async () => {
    enable();
    for (const corrupt of [{ ...receipt, campaignId: "foreign-secret" }, { ...receipt, resultingRevision: 2 },
      { ...receipt, idempotencyKey: "foreign-secret" },
      { ...receipt, commandPayloadDigest: "b".repeat(64) },
      { ...receipt, internalId: "internal-secret" }]) {
      const { app } = setup({ createCompanion: () => corrupt });
      const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/npcs/npc/companion-administration/commands",
        headers: { "content-type": "application/json" },
        payload: createCommand });
      expect(response.statusCode).toBe(500); expect(response.body).toContain("authoritative administration GET");
      expect(response.body).toContain("do not automatically retry");
      expect(response.body).not.toMatch(/foreign-secret|internal-secret|command-secret|receipt-secret|grant-secret/);
      await app.close();
    }
  });
});

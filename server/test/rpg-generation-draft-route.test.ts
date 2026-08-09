import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository } from "../src/repo/index.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; };

describe("M2.11 generation draft routes", () => {
  it("creates deterministic fallback content, survives restart, and applies an exact selection idempotently", async () => {
    enable(); const seed = createRepository(); const campaign = seed.createCampaign("local-owner", { name: "Draft HTTP" }); seed.close();
    const create = { campaignId: campaign.id, kind: "npc", brief: "A careful guide", constraints: ["No secret magic"], idempotencyKey: "draft-create" };
    let app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const created = await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: {
      "content-type": "application/json", authorization: "outsider", "x-principal-id": "outsider",
    }, payload: create });
    expect(created.statusCode, created.body).toBe(201); expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.json()).toMatchObject({ provenance: { source: "user-brief", method: "deterministic-fallback" },
      changes: [{ changeId: "brief", content: { brief: create.brief, constraints: create.constraints } }], validationIssues: [] });
    expect(created.body).not.toMatch(/provider|model|prompt|generatedBy/);
    const duplicate = await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: create });
    expect(duplicate.json()).toEqual(created.json());
    const draftId = created.json().draft.draftId; await app.close();

    app = buildApp({ campaignRepositoryFactory: () => createRepository() });
    const read = await app.inject({ method: "GET", url: `/api/rpg/v1/generation-drafts/${draftId}` });
    expect(read.json()).toEqual(created.json());
    const apply = { selectedChanges: ["brief"], expectedRevision: 0, idempotencyKey: "draft-apply" };
    const applied = await app.inject({ method: "POST", url: `/api/rpg/v1/generation-drafts/${draftId}/apply`, headers: { "content-type": "application/json" }, payload: apply });
    expect(applied.statusCode, applied.body).toBe(200); expect(applied.json()).toMatchObject({ draft: { draftId, state: "applied", revision: 2 },
      receipts: [{ selectedChanges: ["brief"] }] });
    expect(applied.body).not.toContain("commandId");
    const repeated = await app.inject({ method: "POST", url: `/api/rpg/v1/generation-drafts/${draftId}/apply`, headers: { "content-type": "application/json" }, payload: apply });
    expect(repeated.json()).toEqual(applied.json());
    await app.close();
  });

  it("rejects changed create identity, stale apply, and unknown selected changes", async () => {
    enable(); const repo = createRepository(); const campaign = repo.createCampaign("local-owner", { name: "Draft conflicts" });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const base = { campaignId: campaign.id, kind: "quest", brief: "Find a bell", constraints: [], idempotencyKey: "same" };
    const created = await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: base });
    const draftId = created.json().draft.draftId;
    const changed = await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: { ...base, brief: "Changed" } });
    expect(changed.statusCode).toBe(409);
    const unknown = await app.inject({ method: "POST", url: `/api/rpg/v1/generation-drafts/${draftId}/apply`, headers: { "content-type": "application/json" },
      payload: { selectedChanges: ["unknown"], expectedRevision: 0, idempotencyKey: "unknown" } });
    expect(unknown.statusCode).toBe(409);
    const stale = await app.inject({ method: "POST", url: `/api/rpg/v1/generation-drafts/${draftId}/apply`, headers: { "content-type": "application/json" },
      payload: { selectedChanges: ["brief"], expectedRevision: 7, idempotencyKey: "stale" } });
    expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("RPG_GENERATION_DRAFT_STALE");
    await app.close();
  });

  it("gates before repository access and strictly normalizes media, query, body, path, and method failures", async () => {
    let accesses = 0; const app = buildApp({ campaignRepositoryFactory: () => { accesses += 1; return { close() {}, listCampaigns: () => [] } as unknown as CampaignListRepository; } });
    const gated = await app.inject({ method: "GET", url: "/api/rpg/v1/generation-drafts/private?secret=1" });
    expect(gated.statusCode).toBe(404); expect(accesses).toBe(0); expect(gated.body).not.toMatch(/private|secret=1/);
    enable();
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts?x=1", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/generation-drafts", headers: { "content-type": "application/json" }, payload: {
      campaignId: "campaign", kind: "npc", brief: "Brief", constraints: [], idempotencyKey: "strict", extra: true,
    } })).statusCode).toBe(400);
    const method = await app.inject({ method: "DELETE", url: "/api/rpg/v1/generation-drafts/private" });
    expect(method.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", instance: "/api/rpg/v1/generation-drafts/:draftId" });
    await app.close();
  });
});

import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createSettledDmDispatches, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("campaign context inspection routes", () => {
  afterEach(() => {
    delete process.env.FEATURE_RPG_CAMPAIGN;
    delete process.env.FEATURE_RPG_MECHANICS;
    vi.restoreAllMocks();
  });

  it("serves exact private inspection and source references without writes or provider dispatch", async () => {
    const fixture = await dmFixture();
    const run = await createSettledDmDispatches(fixture);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const dispatches = db.prepare(`SELECT planning.claim_id planning_id,narration.claim_id narration_id
      FROM dm_dispatches planning JOIN dm_narration_dispatches narration USING(run_id) WHERE planning.run_id=?`)
      .get(run.runId) as { planning_id: string; narration_id: string };
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const provider = vi.fn(() => { throw new Error("provider must not run"); });
    vi.stubGlobal("fetch", provider);
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo });
    const base = `/api/rpg/v1/campaigns/${fixture.campaign.id}/rooms/${fixture.session.id}/context-inspection`;
    const inspectionPath = `${base}/director-planning/${dispatches.planning_id}`;
    const referencesPath = `${base}/references/director-run/${run.runId}`;
    try {
      const before = db.pragma("data_version", { simple: true });
      const inspection = await app.inject({ method: "GET", url: inspectionPath });
      expect(inspection.statusCode, inspection.body).toBe(200);
      expect(inspection.headers["cache-control"]).toBe("private, no-store");
      expect(inspection.json().identity).toEqual({ campaignId: fixture.campaign.id, sessionId: fixture.session.id, lane: "director-planning", dispatchId: dispatches.planning_id });
      const references = await app.inject({ method: "GET", url: referencesPath });
      expect(references.statusCode, references.body).toBe(200);
      expect(references.headers["cache-control"]).toBe("private, no-store");
      expect(references.json()).toEqual({ version: "1.0", identity: { campaignId: fixture.campaign.id, sessionId: fixture.session.id,
        source: { kind: "director-run", sourceId: run.runId } }, references: [
        { lane: "director-planning", dispatchId: dispatches.planning_id },
        { lane: "director-narration", dispatchId: dispatches.narration_id },
      ] });
      expect(db.pragma("data_version", { simple: true })).toBe(before);
      expect(provider).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });

  it("enforces flags, strict GET input, authorization, and response identity", async () => {
    const fixture = await dmFixture();
    const app = buildApp({ campaignRepositoryFactory: () => fixture.repo });
    const base = `/api/rpg/v1/campaigns/${fixture.campaign.id}/rooms/${fixture.session.id}/context-inspection`;
    const path = `${base}/adventure-planning/missing-dispatch`;
    const referencesPath = `${base}/references/adventure-turn/missing-turn`;
    try {
      const disabled = await app.inject({ method: "GET", url: path });
      expect(disabled.statusCode).toBe(404);
      expect(disabled.headers["cache-control"]).toBe("private, no-store");
      process.env.FEATURE_RPG_CAMPAIGN = "true";
      process.env.FEATURE_RPG_MECHANICS = "true";
      expect((await app.inject({ method: "GET", url: `${path}?latest=true` })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: path, headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
      const head = await app.inject({ method: "HEAD", url: path });
      expect(head.statusCode).toBe(404);
      expect(head.headers["cache-control"]).toBe("private, no-store");
      expect((await app.inject({ method: "GET", url: `${base}/not-a-lane/missing` })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `${base}/references/not-a-source/missing` })).statusCode).toBe(404);

      vi.spyOn(fixture.repo, "inspectCampaignContext").mockReturnValue({ version: "1.0", identity: {
        campaignId: fixture.campaign.id, sessionId: "other-room", lane: "adventure-planning", dispatchId: "missing-dispatch",
      }, availability: "unavailable", reason: "dispatch-not-found" });
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
      vi.mocked(fixture.repo.inspectCampaignContext).mockReturnValue({ version: "1.0", identity: {
        campaignId: fixture.campaign.id, sessionId: fixture.session.id, lane: "adventure-planning", dispatchId: "missing-dispatch",
      }, availability: "unavailable", reason: "access-revoked" });
      expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(404);
      vi.spyOn(fixture.repo, "resolveCampaignContextInspectionDispatchReferences").mockReturnValue({ version: "1.0", identity: {
        campaignId: fixture.campaign.id, sessionId: fixture.session.id,
        source: { kind: "adventure-turn", sourceId: "other-turn" },
      }, references: [] });
      expect((await app.inject({ method: "GET", url: referencesPath })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

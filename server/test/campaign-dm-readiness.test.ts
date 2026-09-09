import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignDmReadinessResponseSchema } from "@velvet/contracts";
import { createCampaignDmReadinessRepository, CampaignDmReadinessUnavailableError } from "../src/repo/campaignDmReadinessRepo.js";
import { dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

describe("campaign DM readiness repository", () => {
  afterEach(() => vi.restoreAllMocks());

  it("authorizes before the activation reader and returns a strict read-only snapshot", async () => {
    const fixture = await dmFixture();
    const connection = database();
    try {
      const before = connection.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(fixture.campaign.id);
      const reader = vi.fn(() => fixture.repo.getCampaignRoomActivationReadiness("local-owner", fixture.campaign.id, fixture.session.id));
      const readiness = createCampaignDmReadinessRepository(connection, reader, () => undefined);

      const report = readiness.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      expect(campaignDmReadinessResponseSchema.parse(report)).toEqual(report);
      expect(report.identity).toMatchObject({ campaignId: fixture.campaign.id, sessionId: fixture.session.id, timelineId: fixture.campaign.activeTimelineId });
      expect(reader).toHaveBeenCalledTimes(1);
      expect(connection.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(fixture.campaign.id)).toEqual(before);
      expect(JSON.stringify(report)).not.toMatch(/SECRET|digest|canonical_json|privateGoals/);

      expect(() => readiness.getCampaignDmPreparationReadiness("outsider", fixture.campaign.id, fixture.session.id))
        .toThrow(CampaignDmReadinessUnavailableError);
      expect(reader).toHaveBeenCalledTimes(1);
    } finally {
      connection.close();
      fixture.repo.close();
    }
  });

  it("includes authored public story resources without generation artifacts", async () => {
    const fixture = await dmFixture();
    fixture.repo.createCampaignStorylineGraph("local-owner", fixture.campaign.id, {
      storyline: { storylineId: "authored-story", title: "Authored", summary: "Public story", nodes: [
        { nodeId: "authored-node", title: "Public scene", description: "A public scene.", gmNotes: "private note", revealThreshold: 0 },
      ], edges: [], plotPoints: [], clues: [] },
      expectedRevision: fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: "authored-story",
    });
    fixture.repo.executeStorylineCommand("local-owner", "authored-story", {
      kind: "reveal-node", targetId: "authored-node", data: {},
      expectedRevision: fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision,
      idempotencyKey: "reveal-authored-node",
    });
    const connection = database();
    try {
      const readiness = createCampaignDmReadinessRepository(connection,
        () => fixture.repo.getCampaignRoomActivationReadiness("local-owner", fixture.campaign.id, fixture.session.id), () => undefined);
      const report = readiness.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      expect(report.coverage.families.find(family => family.family === "story")?.inspected)
        .toContainEqual({ kind: "story-node", id: "authored-node" });
      expect(report.issues).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "missing-public-rendering", reference: { kind: "story-node", id: "authored-node" } }),
      ]));
    } finally {
      connection.close();
      fixture.repo.close();
    }
  });

  it("is available through the composed repository with activation parity", async () => {
    const fixture = await dmFixture();
    try {
      const report = fixture.repo.getCampaignDmPreparationReadiness("local-owner", fixture.campaign.id, fixture.session.id);
      expect(report.activationReadiness.campaignId).toBe(fixture.campaign.id);
      expect(report.activationReadiness.sessionId).toBe(fixture.session.id);
      expect(report.identity.timelineId).toBe(fixture.campaign.activeTimelineId);
      expect(() => fixture.repo.getCampaignDmPreparationReadiness("outsider", fixture.campaign.id, fixture.session.id))
        .toThrow(CampaignDmReadinessUnavailableError);
    } finally {
      fixture.repo.close();
    }
  });
});

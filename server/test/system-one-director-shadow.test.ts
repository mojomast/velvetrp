import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { orchestrateCampaignDmBeat } from "../src/agent/campaignDmOrchestrator.js";
import { defaultSystemOneSettings } from "../src/defaults.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import type { SystemOneDirectorDependency } from "../src/agent/systemOneDirector.js";
import { dmDependencies, dmFixture } from "./fixtures/dmCampaign.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const database = () => new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));

const director = (caller: SystemOneDirectorDependency["caller"]): SystemOneDirectorDependency => ({
  settings: { ...defaultSystemOneSettings(), enabled: true, shadow: true, apiKey: "test-key" },
  caller,
});

async function openForShadow() {
  const fixture = await dmFixture();
  fixture.repo.setDmControl("local-owner", fixture.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: "shadow-ai" });
  const run = fixture.repo.openDmBeat("local-owner", fixture.campaign.id, fixture.session.id,
    { intent: "open", expectedModeRevision: 1, idempotencyKey: "shadow-open" });
  return { fixture, run };
}

describe("System One Director shadow lane", () => {
  it("records the would-be decision without changing planning", async () => {
    const { fixture, run } = await openForShadow();
    const caller = createFakeSystemOneCaller();
    await orchestrateCampaignDmBeat(fixture.repo, "local-owner", run.runId, {
      ...dmDependencies(), getSystemOneDirector: async () => director(caller),
    });

    expect(caller.calls).toHaveLength(1);
    const db = database();
    const row = db.prepare("SELECT lane,shadow,fallback_used,confidence_band,provider FROM system_one_decisions_v1 ORDER BY created_at DESC LIMIT 1").get();
    db.close();
    expect(row).toMatchObject({ lane: "director-selection", shadow: 1, fallback_used: 1, provider: "typesafe" });
    expect(row).toHaveProperty("confidence_band");

    // The provider path still settled the beat; the shadow lane did not hold or order anything.
    const committed = fixture.repo.getDmRun("local-owner", fixture.campaign.id, fixture.session.id, run.runId);
    expect(committed?.state).not.toBe("planning");
  });

  it("ignores a failing shadow hook and still settles planning", async () => {
    const { fixture, run } = await openForShadow();
    await orchestrateCampaignDmBeat(fixture.repo, "local-owner", run.runId, {
      ...dmDependencies(), getSystemOneDirector: async () => { throw new Error("shadow endpoint down"); },
    });
    const db = database();
    const count = db.prepare("SELECT count(*) count FROM system_one_decisions_v1").get();
    db.close();
    expect(count).toEqual({ count: 0 });
    const committed = fixture.repo.getDmRun("local-owner", fixture.campaign.id, fixture.session.id, run.runId);
    expect(committed?.state).not.toBe("planning");
  });

  it("stays inert when no shadow hook is injected", async () => {
    const { fixture, run } = await openForShadow();
    await orchestrateCampaignDmBeat(fixture.repo, "local-owner", run.runId, dmDependencies());
    const db = database();
    const count = db.prepare("SELECT count(*) count FROM system_one_decisions_v1").get();
    db.close();
    expect(count).toEqual({ count: 0 });
  });
});

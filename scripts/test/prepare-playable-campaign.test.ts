import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeRepo, createRepository } from "../../server/src/repo/index.js";
import { preparePlayableCampaign } from "../prepare-playable-campaign.js";

const OWNER = "local-owner";

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "velvet-prepare-playable-"));
  process.env.VELVET_DATA_DIR = dir;
  closeRepo();
  return dir;
}

test("prepares an SRD 5.1 campaign with two finalized actors and one active room", async () => {
  const dataDir = tempDataDir();
  try {
    const setup = createRepository({ dataDir });
    const campaign = setup.createCampaign(OWNER, { name: "Emberwake Reach" });
    setup.installSrdStarterCatalog(OWNER);
    setup.configureSrdStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "srd-pins" });
    setup.close();

    const result = await preparePlayableCampaign({ dataDir, campaignId: campaign.id, campaignName: "Emberwake Reach", starter: "srd-5.1" });
    assert.equal(result.status, "ready");
    assert.equal(result.actorIds.length, 2);
    assert.equal(result.campaignCharacterIds.length, 2);

    const verification = createRepository({ dataDir });
    assert.equal(verification.listCampaignCharacters(OWNER, campaign.id).length, 2);
    const attachments = verification.listCampaignSessionAttachments(OWNER, campaign.id);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.sessionId, result.sessionId);
    assert.equal(verification.getSession(result.sessionId)?.state, "active");
    assert.equal(verification.getCampaignAdministration(OWNER, campaign.id)?.status, "published");
    verification.close();

    const rerun = await preparePlayableCampaign({ dataDir, campaignId: campaign.id, campaignName: "Emberwake Reach", starter: "srd-5.1" });
    assert.deepEqual([...rerun.actorIds].sort(), [...result.actorIds].sort());
    assert.deepEqual([...rerun.campaignCharacterIds].sort(), [...result.campaignCharacterIds].sort());
    assert.equal(rerun.sessionId, result.sessionId);

    const after = createRepository({ dataDir });
    assert.equal(after.listCampaignCharacters(OWNER, campaign.id).length, 2);
    assert.equal(after.listCampaignSessionAttachments(OWNER, campaign.id).length, 1);
    after.close();
  } finally {
    closeRepo();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

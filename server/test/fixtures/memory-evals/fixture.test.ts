import { describe, expect, it } from "vitest";
import { createRepository } from "../../../src/repo/index.js";
import { makeTmpDataDir } from "../../helpers.js";
import { MEMORY_EVAL_DEVELOPMENT_CASES, MEMORY_EVAL_CORPUS_VERSION, validateMemoryEvalCases } from "./corpus.js";
import { createMemoryEvalFixture } from "./fixture.js";
import { MEMORY_EVAL_HOLDOUTS, MEMORY_EVAL_HOLDOUTS_VERSION } from "./holdouts.js";
import { PLAYABILITY_OBSERVATIONS } from "../playability-observations.js";

describe("memory evaluation corpus fixtures", () => {
  it("validates reviewed labels and persists deterministic production sources across reopen", async () => {
    validateMemoryEvalCases(MEMORY_EVAL_DEVELOPMENT_CASES);
    validateMemoryEvalCases(MEMORY_EVAL_HOLDOUTS);
    expect(MEMORY_EVAL_CORPUS_VERSION).toBe("memory-evals-v1");
    expect(MEMORY_EVAL_HOLDOUTS_VERSION).toBe("memory-evals-holdouts-v1");
    expect(Object.isFrozen(MEMORY_EVAL_HOLDOUTS)).toBe(true);
    expect(MEMORY_EVAL_HOLDOUTS.every(item => Object.isFrozen(item) && Object.isFrozen(item.requiredSourceKeys))).toBe(true);
    const fixture = await createMemoryEvalFixture(makeTmpDataDir());
    const expectedKeys = new Set([...MEMORY_EVAL_DEVELOPMENT_CASES, ...MEMORY_EVAL_HOLDOUTS].flatMap(item => [...item.requiredSourceKeys, ...item.forbiddenSourceKeys]));
    for (const key of expectedKeys) expect(fixture.sourceIds[key]).toBeTruthy();
    expect(fixture.sourceIds["promise:lantern"]).not.toBe(fixture.sourceIds["outcome:lantern"]);
    for (const observation of PLAYABILITY_OBSERVATIONS) {
      const key = `p2:${observation.id}`;
      expect(fixture.sourceStorage[key]).toBe(observation.sourceKind === "turn-receipt" ? "mechanic-receipt" : observation.sourceKind === "dm-receipt" ? "director-receipt" : observation.authority === "player" ? "declaration" : "recap");
    }
    fixture.repo.close();
    const reopened = createRepository(fixture.options);
    const recall = (query: string, actorId = fixture.actors.aster) => reopened.getCampaignRecall("local-owner", { campaignId: fixture.campaign.id, sessionId: fixture.session.id, audience: { kind: "player", actorId }, query, purpose: "public-narration" })!;
    for (const item of MEMORY_EVAL_DEVELOPMENT_CASES.filter(item => item.category === "p2-observation")) {
      const key = item.requiredSourceKeys[0]!;
      const hits = recall(item.query).hits;
      const hit = hits.find(hit => hit.sourceId === fixture.sourceIds[key] && hit.sourceKind === fixture.sourceStorage[key]);
      expect(hit).toBeDefined();
      expect(hit!.authority).toBe(fixture.sourceStorage[key] === "mechanic-receipt" || fixture.sourceStorage[key] === "director-receipt" ? "committed-outcome" : fixture.sourceStorage[key] === "declaration" ? "intent" : "authored-recap");
    }
    const lantern = recall("lantern");
    expect(lantern.hits.some(hit => hit.sourceId === fixture.sourceIds["promise:lantern"])).toBe(true);
    expect(lantern.hits.some(hit => hit.sourceId === fixture.sourceIds["outcome:lantern"] && hit.sourceKind === "presentation")).toBe(true);
    expect(recall("lantern explode").hits.some(hit => hit.sourceId === fixture.sourceIds["outcome:lantern"])).toBe(true);
    expect(recall("beacon status").hits.some(hit => hit.sourceId === fixture.sourceIds["current:beacon"])).toBe(true);
    expect(recall("beacon").hits.map(hit => hit.sourceId)).toEqual(expect.arrayContaining([fixture.sourceIds["past:beacon"], fixture.sourceIds["current:beacon"]]));
    expect(recall("passage island").hits.some(hit => hit.sourceId === fixture.sourceIds["holdout:passage"])).toBe(true);
    expect(recall("tide signal").hits.some(hit => hit.sourceId === fixture.sourceIds["holdout:tide-current"])).toBe(true);
    expect(recall("tide signal").hits.map(hit => hit.sourceId)).toEqual(expect.arrayContaining([fixture.sourceIds["holdout:tide-past"], fixture.sourceIds["holdout:tide-current"]]));
    expect(recall("cafe 漢字").hits.some(hit => hit.sourceId === fixture.sourceIds["unicode:cafe"])).toBe(true);
    expect(recall("cedarlight password").hits).toEqual([]);
    expect(recall("nightjar cipher").hits).toEqual([]);
    expect(recall("old timeline cobalt bell").hits).toEqual([]);
    expect(recall("quartz zeppelin").hits).toEqual([]);
    const retryHits = recall("violet compass").hits;
    expect(retryHits.length).toBeGreaterThan(0);
    expect(retryHits.every(hit => hit.rootTurnId === fixture.sourceIds["retry:compass"])).toBe(true);
    expect(recall("oversized meteor").hits).toEqual([]);
    expect(recall("harbor ledger").hits.length).toBeLessThanOrEqual(8);
    reopened.close();
  });
});

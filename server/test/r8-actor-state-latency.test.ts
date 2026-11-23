// Approved test for round-8 change 2 (PLAN.md RC2). A quick-adventure turn spent ~7s of server CPU
// re-verifying and re-digesting the whole sealed catalog once per inventory item
// (buildActorStateContext -> getCampaignContentPackDefinition -> visibleDefinitions ->
// verifyCatalogVisibilityProjection). The fix memoizes the verification per sealed pack, so a turn
// verifies a pack at most a handful of times (first load), never once per item.
// This test counts calls. It deliberately does NOT measure wall-clock time.
import { afterEach, describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/repo/contentCatalog/catalogVisibility.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/repo/contentCatalog/catalogVisibility.js")>();
  return {
    ...original,
    verifyCatalogVisibilityProjection: (...args: Parameters<typeof original.verifyCatalogVisibilityProjection>) => {
      counter.calls += 1;
      return original.verifyCatalogVisibilityProjection(...args);
    },
  };
});

import { buildApp } from "../src/app.js";
import { closeRepo } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";
import { clearR8Flags, enableR8Flags, fakeProvider, playR8Turn, startQuickAdventure } from "./r8-http-harness.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
afterEach(() => {
  clearR8Flags();
  closeRepo();
});

describe("catalog verification is not repeated per inventory item", () => {
  it("verifies the catalog projection at most 3 times during one quick-adventure turn", async () => {
    enableR8Flags();
    const fake = fakeProvider({ narrate: () => "The bell-post creaks as the carters shuffle past you." });
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const ids = await startQuickAdventure(app);
      counter.calls = 0;
      const turn = await playR8Turn(app, ids, "I watch the carters go by.");
      expect(turn.narrationStatus.status).toBe("completed");
      expect(counter.calls).toBeLessThanOrEqual(3);
    } finally {
      await app.close();
    }
  });

  it("adds at most 1 further verification on a second turn of the same adventure", async () => {
    enableR8Flags();
    const fake = fakeProvider({ narrate: () => "The bell-post creaks as the carters shuffle past you." });
    const app = buildApp({ adventureAgentDependencies: fake.dependencies });
    try {
      const ids = await startQuickAdventure(app);
      await playR8Turn(app, ids, "I watch the carters go by.");
      const afterFirst = counter.calls;
      await playR8Turn(app, ids, "I listen to the bell-post.");
      expect(counter.calls - afterFirst).toBeLessThanOrEqual(1);
    } finally {
      await app.close();
    }
  });
});

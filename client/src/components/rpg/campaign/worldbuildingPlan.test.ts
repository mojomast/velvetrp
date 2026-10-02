import { describe, expect, it } from "vitest";
import { buildDefaultPlan, parseWorldbuildingPlan, resolveExpansionKeys, worldLinkIssues, WORLDBUILDING_SECTIONS } from "./worldbuildingPlan";
import type { CampaignContentDraftView } from "@velvet/contracts";

describe("whole-world planning", () => {
  it("covers every section and budgets real earlier context for opening, quests and scenes", () => {
    const plan = buildDefaultPlan("grounded", []);
    expect(() => parseWorldbuildingPlan(plan)).not.toThrow();
    expect(new Set(plan.stages.flatMap((stage) => stage.sections))).toEqual(new Set(WORLDBUILDING_SECTIONS));
    const accepted: Record<string, Record<string, string[]>> = {};
    const contexts: Record<string, string[]> = {};
    for (const stage of plan.stages) {
      contexts[stage.id] = resolveExpansionKeys(stage, accepted);
      expect(contexts[stage.id]!.length).toBeLessThanOrEqual(16);
      accepted[stage.id] = Object.fromEntries(Object.entries(stage.desiredCounts).map(([field, count]) => [field, Array.from({ length: count }, (_, index) => `${field}-${index}`)]));
    }
    expect(contexts.foundation).toContain("locations-0");
    expect(contexts.quests).toEqual(expect.arrayContaining(["locations-0", "arcs-0", "npcs-0"]));
    expect(contexts.table).toEqual(expect.arrayContaining(["locations-0", "npcs-0"]));
    expect(plan.stages.find((stage) => stage.id === "locations")!.desiredCounts.connections).toBeGreaterThanOrEqual(10);
  });

  it("rejects a directed dead end even when an undirected graph is connected", () => {
    const preview = { outlines: [], npcs: [], quests: [], scenePrompts: [], locations: [{ key: "home", visibility: "public" }, { key: "away", visibility: "public" }], connections: [{ fromLocationKey: "home", toLocationKey: "away", visibility: "public" }] } as unknown as CampaignContentDraftView["preview"];
    expect(worldLinkIssues(preview, {})).toEqual([expect.stringContaining("stranded destination")]);
    preview.connections.push({ key: "return", fromLocationKey: "away", toLocationKey: "home", visibility: "public", description: "Return road" });
    expect(worldLinkIssues(preview, {})).toEqual([]);
  });
});

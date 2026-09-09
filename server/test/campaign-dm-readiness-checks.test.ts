import { describe, expect, it } from "vitest";
import { checkCampaignDmReadiness, checkLocationConnectivity } from "../src/repo/campaignDmReadinessChecks.js";

const issue = (result: ReturnType<typeof checkCampaignDmReadiness>, code: string, id: string) =>
  result.issues.find((entry) => entry.code === code && entry.reference?.id === id);

describe("campaign DM readiness pure checks", () => {
  it("checks rendering, private companions, bindings, and exact encounter support", () => {
    const result = checkCampaignDmReadiness({
      publicRendering: [
        { id: "private-node", kind: "story-node", visibility: "private", rendered: false, privateCompanion: true },
        { id: "public-node", kind: "story-node", visibility: "public", rendered: false },
      ],
      bindings: [{ id: "binding-1", targetKind: "encounter", targetId: "encounter-1", state: "prepared" }],
      encounters: [
        { id: "encounter-1", bound: true, exactPinnedEnemyReferences: [], conceptOnly: true, unsupportedRoster: false },
      ],
    });
    expect(issue(result, "private-artifact", "private-node")).toBeDefined();
    expect(issue(result, "missing-public-rendering", "public-node")).toBeDefined();
    expect(issue(result, "awaiting-play-evidence", "binding-1")).toMatchObject({ severity: "review", scope: "awaiting-play-evidence" });
    expect(issue(result, "unsupported-encounter-roster", "encounter-1")).toBeDefined();
  });

  it("uses threshold semantics and does not treat reverse-only routes as reachable", () => {
    const result = checkCampaignDmReadiness({
      story: { nodes: [
        { id: "predecessor", status: "revealed", revealThreshold: 0 },
        { id: "target", status: "hidden", revealThreshold: 2 },
        { id: "private-predecessor", status: "hidden", revealThreshold: 0, visibility: "private" },
        { id: "private-companion", status: "hidden", revealThreshold: 5, visibility: "private", privateCompanion: true },
      ], edges: [
        { id: "requires-1", kind: "requires", fromId: "predecessor", toId: "target" },
        { id: "requires-2", kind: "requires", fromId: "private-predecessor", toId: "target" },
      ] },
      connectivity: { startLocationId: "start", locations: [
        { id: "start", visibility: "public" }, { id: "reverse-only", visibility: "public" },
        { id: "optional", visibility: "public", optional: true },
      ], connections: [{ id: "reverse", fromId: "reverse-only", toId: "start" }] },
    });
    expect(issue(result, "room-obstacle", "target")).toBeDefined();
    expect(issue(result, "room-obstacle", "private-companion")).toBeUndefined();
    expect(issue(result, "private-artifact", "private-companion")).toBeDefined();
    expect(issue(result, "room-obstacle", "reverse-only")).toBeDefined();
    expect(issue(result, "optional-disconnected-content", "optional")).toBeDefined();
  });

  it("does not count a resolved predecessor without public rendering", () => {
    const result = checkCampaignDmReadiness({
      publicRendering: [{ id: "target", kind: "story-node", visibility: "public", rendered: true }],
      story: { nodes: [
        { id: "predecessor", status: "resolved", revealThreshold: 0 },
        { id: "target", status: "hidden", revealThreshold: 1 },
      ], edges: [{ id: "requires", kind: "requires", fromId: "predecessor", toId: "target" }] },
    });
    expect(issue(result, "room-obstacle", "target")).toBeDefined();
  });

  it("classifies later-location encounter and binding issues without treating them as current-room blockers", () => {
    const result = checkCampaignDmReadiness({
      bindings: [{ id: "later-binding", targetKind: "encounter", targetId: "later-encounter", state: "missing", locationScope: "later-location" }],
      encounters: [{ id: "later-encounter", bound: false, exactPinnedEnemyReferences: [], conceptOnly: true, unsupportedRoster: true, locationScope: "later-location" }],
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-binding", scope: "later-location" }),
      expect.objectContaining({ code: "unbound-encounter", scope: "later-location" }),
      expect.objectContaining({ code: "unsupported-encounter-roster", scope: "later-location" }),
    ]));
    expect(result.issues.some(issue => issue.scope === "current-room")).toBe(false);
  });

  it("returns stable order, deduplicates issues, and includes all manual reminders", () => {
    const input = { bindings: [{ id: "b", targetKind: "encounter" as const, targetId: "e", state: "missing" as const }], encounters: [
      { id: "e", bound: false, exactPinnedEnemyReferences: [], conceptOnly: true, unsupportedRoster: true },
    ] };
    const first = checkCampaignDmReadiness(input); const second = checkCampaignDmReadiness(input);
    expect(first).toEqual(second);
    expect(first.issues).toHaveLength(3);
    expect(first.manualReviewLimitations).toHaveLength(4);
    expect(checkLocationConnectivity(undefined)).toEqual([]);
  });
});

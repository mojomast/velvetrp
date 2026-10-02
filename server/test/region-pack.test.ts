import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import { describe, expect, it } from "vitest";
import { buildRegionPackBrief, regionPackArtifactKeys, regionPackSections, validateRegionPack } from "../src/startup/regionPack.js";

type Content = ReturnType<typeof generatedCampaignContentProviderSchema.parse>;

const location = (key: string, visibility: "public" | "gm" = "public") => ({ key, name: key, description: `${key} place`, visibility });
const connection = (key: string, from: string, to: string, visibility: "public" | "gm" = "public") => ({
  key, fromLocationKey: from, toLocationKey: to, description: `${key} route`, visibility,
});
const outline = (startLocationKey?: string) => ({ key: "opening", opening: "Rain.", premise: "A bell is missing.", visibility: "public" as const, ...(startLocationKey ? { startLocationKey } : {}) });

/** Four public locations and a connected tree; self-anchored unless overridden. */
function connectedPack(overrides: Record<string, unknown> = {}): Content {
  return generatedCampaignContentProviderSchema.parse({
    outlines: [outline("gate")],
    locations: [location("gate"), location("bridge"), location("mill"), location("tower")],
    connections: [
      connection("gate-bridge", "gate", "bridge"),
      connection("bridge-mill", "bridge", "mill"),
      connection("mill-tower", "mill", "tower"),
    ],
    ...overrides,
  });
}

const accepted = (keys: string[]) => new Set(keys);

describe("region pack validator", () => {
  it("accepts a connected self-anchored opening pack", () => {
    const content = connectedPack();
    expect(() => validateRegionPack(content, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) })).not.toThrow();
    expect(regionPackArtifactKeys(content)).toEqual(["opening", "gate", "bridge", "mill", "tower", "gate-bridge", "bridge-mill", "mill-tower"]);
  });

  it("accepts a connected pack anchored to accepted canon without re-anchoring", () => {
    const content = connectedPack({
      outlines: [outline()],
      locations: [location("road"), location("inn"), location("forge"), location("chapel")],
      connections: [
        connection("anchor-road", "river-gate", "road"),
        connection("road-inn", "road", "inn"),
        connection("inn-forge", "inn", "forge"),
        connection("forge-chapel", "forge", "chapel"),
      ],
    });
    expect(() => validateRegionPack(content, { locationCount: 4, anchorLocationKey: "river-gate", anchorRequired: true, acceptedLocationKeys: accepted(["river-gate"]) })).not.toThrow();
  });

  it("rejects undirected-only connectivity from the actual starting location or accepted anchor", () => {
    const reversed = connectedPack();
    reversed.connections[0]!.fromLocationKey = "bridge";
    reversed.connections[0]!.toLocationKey = "gate";
    expect(() => validateRegionPack(reversed, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) })).toThrow(/directed paths/);
    const wrongStart = connectedPack({ outlines: [outline("tower")] });
    expect(() => validateRegionPack(wrongStart, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) })).toThrow(/directed paths/);
    const anchored = connectedPack();
    anchored.connections.push(connection("outbound-only", "tower", "accepted-gate"));
    expect(() => validateRegionPack(anchored, { locationCount: 4, anchorRequired: true, anchorLocationKey: "accepted-gate", acceptedLocationKeys: accepted(["accepted-gate"]) })).toThrow(/directed paths/);
  });

  it("fails closed when anchoring is required but no accepted anchor is supplied", () => {
    const content = connectedPack({ outlines: [outline()] });
    expect(() => validateRegionPack(content, { locationCount: 4, anchorRequired: true, acceptedLocationKeys: accepted(["river-gate"]) }))
      .toThrow(/anchoring to existing canon/);
    expect(() => validateRegionPack(content, { locationCount: 4, anchorLocationKey: "river-gate", anchorRequired: true, acceptedLocationKeys: accepted([]) }))
      .toThrow(/not accepted public canon/);
  });

  it("fails closed when the self-anchor is missing or points outside the pack", () => {
    expect(() => validateRegionPack(connectedPack({ outlines: [outline()] }), { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/self-anchor/);
    expect(() => validateRegionPack(connectedPack({ outlines: [outline("elsewhere")] }), { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted(["elsewhere"]) }))
      .toThrow(/start location must be one of its new locations/);
  });

  it("fails closed on a disconnected location", () => {
    const content = connectedPack({
      locations: [location("gate"), location("bridge"), location("mill"), location("tower"), location("island")],
      connections: [
        connection("gate-bridge", "gate", "bridge"),
        connection("bridge-mill", "bridge", "mill"),
        connection("mill-tower", "mill", "tower"),
        connection("gate-tower", "gate", "tower"),
      ],
    });
    expect(() => validateRegionPack(content, { locationCount: 5, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/must be connected/);
  });

  it("fails closed on a duplicate directed connection and on a self-connection", () => {
    const duplicate = connectedPack({
      connections: [
        connection("first", "gate", "bridge"), connection("second", "gate", "bridge"),
        connection("bridge-mill", "bridge", "mill"), connection("mill-tower", "mill", "tower"),
      ],
    });
    expect(() => validateRegionPack(duplicate, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/duplicate directed/);
    const self = connectedPack({
      connections: [
        connection("loop", "gate", "gate"), connection("bridge-mill", "bridge", "mill"),
        connection("mill-tower", "mill", "tower"),
      ],
    });
    expect(() => validateRegionPack(self, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/itself/);
  });

  it("fails closed when bounds are exceeded or too few connections form a tree", () => {
    const base = connectedPack();
    const tooManyLocations = { ...base, locations: Array.from({ length: 17 }, (_value, index) => location(`place-${index}`)) } as unknown as Content;
    expect(() => validateRegionPack(tooManyLocations, { locationCount: 16, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/location bound/);
    const tooManyConnections = {
      ...base,
      connections: Array.from({ length: 25 }, (_value, index) => connection(`route-${index}`, index % 2 === 0 ? "gate" : "bridge", index % 2 === 0 ? "bridge" : "gate")),
    } as unknown as Content;
    expect(() => validateRegionPack(tooManyConnections, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/connection bound/);
    const underConnected = connectedPack({
      connections: [connection("gate-bridge", "gate", "bridge")],
    });
    expect(() => validateRegionPack(underConnected, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/connected location graph/);
    expect(() => validateRegionPack(connectedPack({ locations: [location("gate"), location("bridge"), location("mill")] }), { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/at least four locations/);
  });

  it("fails closed when opening locations or connections are not public", () => {
    expect(() => validateRegionPack(connectedPack({ locations: [location("gate", "gm"), location("bridge"), location("mill"), location("tower")] }), { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/locations must be public/);
    expect(() => validateRegionPack(connectedPack({ connections: [connection("gate-bridge", "gate", "bridge", "gm"), connection("bridge-mill", "bridge", "mill"), connection("mill-tower", "mill", "tower")] }), { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/connections must be public/);
  });

  it("fails closed when linked NPC, quest, or clue locations do not resolve", () => {
    const linked = connectedPack({
      npcs: [{ key: "mara", name: "Mara", archetype: "Guide", description: "Wary.", visibility: "public", locationKey: "missing", factionKeys: [] }],
      quests: [{ key: "find-bell", title: "Find", description: "Search.", visibility: "public", locationKeys: ["gate", "lost"], objectives: [], rewards: [] }],
      clues: [{ key: "seal", title: "Seal", description: "Cut.", visibility: "public", locationKey: "elsewhere" }],
    });
    expect(() => validateRegionPack(linked, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted([]) }))
      .toThrow(/NPC location/);
    expect(() => validateRegionPack(linked, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted(["missing", "elsewhere"]) }))
      .toThrow(/quest location/);
    expect(() => validateRegionPack(linked, { locationCount: 4, anchorRequired: false, acceptedLocationKeys: accepted(["missing", "lost"]) }))
      .toThrow(/clue location/);
  });

  it("composes the self-anchor or accepted-anchor brief", () => {
    const self = buildRegionPackBrief({ brief: "River district", locationCount: 4, anchorRequired: false });
    expect(self).toMatch(/self-anchoring/);
    expect(self).not.toMatch(/immutable starting location/);
    const anchored = buildRegionPackBrief({ brief: "New quarter", locationCount: 6, anchorRequired: true, anchorLocationKey: "river-gate" });
    expect(anchored).toMatch(/immutable starting location/);
    expect(anchored).toMatch(/river-gate/);
    expect(anchored).toMatch(/6 new public locations/);
  });

  it("only requests encounters when the linkage hint asks for them", () => {
    expect(regionPackSections(undefined)).toEqual(["outline", "locations", "factions", "npcs", "quests", "clues", "story"]);
    expect(regionPackSections({ quests: false })).not.toContain("encounters");
    expect(regionPackSections({ encounters: true })).toContain("encounters");
  });
});

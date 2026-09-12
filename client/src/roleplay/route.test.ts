import { describe, expect, it } from "vitest";
import { navigationFromRoute, routeFromNavigation } from "./route";
import type { StoredNavigation } from "./navigation";

describe("campaign route codec", () => {
  it("routes campaign destinations and round-trips them", () => {
    const destinations: StoredNavigation[] = [
      { view: "campaigns" },
      { view: "campaign-detail", campaignId: "campaign-one" },
      { view: "campaign-overview", campaignId: "campaign-one" },
      { view: "campaign-rooms", campaignId: "campaign-one" },
      { view: "campaign-party", campaignId: "campaign-one" },
      { view: "campaign-create", campaignId: "campaign-one" },
      { view: "campaign-administration", campaignId: "campaign-one" },
      { view: "campaign-world", campaignId: "campaign-one" },
      { view: "campaign-journal", campaignId: "campaign-one" },
      { view: "campaign-combat", campaignId: "campaign-one" },
    ];
    for (const navigation of destinations) {
      const route = routeFromNavigation(navigation);
      expect(route, JSON.stringify(navigation)).not.toBeNull();
      const parsed = navigationFromRoute(route!);
      expect(parsed).toMatchObject({ view: navigation.view, ...(navigation.campaignId ? { campaignId: navigation.campaignId } : {}) });
    }
  });

  it("routes rooms with opaque session ids and preserves the return campaign", () => {
    const play = routeFromNavigation({ view: "campaign-play", campaignId: "campaign-one", sessionId: "sess-1" });
    expect(play).toBe("#/campaign/campaign-one/play/sess-1");
    expect(navigationFromRoute(play!)).toMatchObject({ view: "campaign-play", campaignId: "campaign-one", sessionId: "sess-1" });

    const room = routeFromNavigation({ view: "chat", campaignId: "campaign-one", sessionId: "sess-1" });
    expect(room).toBe("#/campaign/campaign-one/room/sess-1");
    expect(navigationFromRoute(room!)).toMatchObject({ view: "chat", campaignId: "campaign-one", sessionId: "sess-1", chatReturnCampaignId: "campaign-one" });
  });

  it("never exposes character or sheet identifiers in the URL", () => {
    expect(routeFromNavigation({ view: "campaign-character", campaignId: "campaign-one", campaignCharacterId: "secret-actor" })).toBeNull();
    expect(routeFromNavigation({ view: "campaign-character-sheet", campaignId: "campaign-one", campaignCharacterId: "secret-actor" })).toBeNull();
    expect(routeFromNavigation({ view: "campaign-character-builder", campaignId: "campaign-one" })).toBeNull();
  });

  it("rejects unknown or malformed routes without inventing navigation", () => {
    expect(navigationFromRoute("#/campaign/")).toBeNull();
    expect(navigationFromRoute("#/campaign/bad id/overview")).toBeNull();
    expect(navigationFromRoute("#/campaign/campaign-one/unknown")).toBeNull();
    expect(navigationFromRoute("#/totally/elsewhere")).toBeNull();
    expect(navigationFromRoute("")).toEqual({ view: "home" });
  });

  it("falls back to the campaign workspace when a room id is missing", () => {
    expect(navigationFromRoute("#/campaign/campaign-one/play")).toEqual({ view: "campaign-detail", campaignId: "campaign-one" });
    expect(navigationFromRoute("#/campaign/campaign-one/room/")).toEqual({ view: "campaign-detail", campaignId: "campaign-one" });
  });
});

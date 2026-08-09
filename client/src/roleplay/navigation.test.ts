import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_KEY, parseStoredNavigation, readNavigation, writeNavigation, type StoredNavigation, type View } from "./navigation";

describe("navigation persistence", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("exports the exact storage key and accepts every supported view", () => {
    expect(NAV_KEY).toBe("velvet.navigation.v1");
    const views: View[] = ["home", "create", "edit", "memory", "lore", "chat", "campaigns", "campaign-detail", "campaign-play", "campaign-character", "campaign-character-sheet", "campaign-character-builder", "campaign-administration", "campaign-history", "campaign-transfer", "campaign-combat", "campaign-world", "campaign-cast", "campaign-journal", "campaign-story", "content-packs"];
    expect(views.map((view) => parseStoredNavigation({
      view,
      characterId: "character",
      sessionId: "session",
      campaignId: "campaign",
      campaignCharacterId: "entry",
    }).view)).toEqual(views);
  });

  it("returns only home for nonobjects, null, and arrays", () => {
    for (const value of [undefined, null, true, 7, "home", Symbol("view"), [], [{ view: "chat" }]]) {
      expect(parseStoredNavigation(value)).toEqual({ view: "home" });
    }
  });

  it("defaults object inputs to home and an empty selected ID list", () => {
    expect(parseStoredNavigation({})).toEqual({ view: "home", selectedIds: [] });
    expect(parseStoredNavigation({ view: "unknown", selectedIds: "character", sessionId: 7 })).toEqual({ view: "home", selectedIds: [] });
    expect(parseStoredNavigation({ view: 7 })).toEqual({ view: "home", selectedIds: [] });
  });

  it("keeps non-empty strings exactly without trimming and rejects other field values", () => {
    expect(parseStoredNavigation({
      view: "home",
      characterId: "  character  ",
      sessionId: " ",
      primaryId: "primary",
      selectedIds: ["  selected  ", " "],
    })).toEqual({
      view: "home",
      characterId: "  character  ",
      sessionId: " ",
      primaryId: "primary",
      selectedIds: ["  selected  ", " "],
    });
    expect(parseStoredNavigation({
      view: "home",
      characterId: "",
      sessionId: "",
      primaryId: "",
      selectedIds: ["", 1, null, false, {}, []],
    })).toEqual({ view: "home", selectedIds: [] });
    expect(parseStoredNavigation({
      view: "home",
      characterId: false,
      sessionId: 1,
      primaryId: null,
    })).toEqual({ view: "home", selectedIds: [] });
  });

  it("deduplicates valid selected IDs in first-occurrence order", () => {
    expect(parseStoredNavigation({
      view: "home",
      selectedIds: ["second", "first", "second", "third", "first"],
    }).selectedIds).toEqual(["second", "first", "third"]);
  });

  it("enforces character and session prerequisites for guarded views", () => {
    expect(parseStoredNavigation({ view: "chat" })).toEqual({ view: "home", selectedIds: [] });
    expect(parseStoredNavigation({ view: "chat", sessionId: "session" })).toEqual({ view: "chat", sessionId: "session", selectedIds: [] });
    expect(parseStoredNavigation({ view: "edit" })).toEqual({ view: "home", selectedIds: [] });
    expect(parseStoredNavigation({ view: "edit", characterId: "character" })).toEqual({ view: "edit", characterId: "character", selectedIds: [] });
    expect(parseStoredNavigation({ view: "memory" })).toEqual({ view: "home", selectedIds: [] });
    expect(parseStoredNavigation({ view: "memory", characterId: "character" })).toEqual({ view: "memory", characterId: "character", selectedIds: [] });
  });

  it("keeps a validated campaign chat origin only with chat and an exact session", () => {
    expect(parseStoredNavigation({ view: "chat", sessionId: " opaque session ", chatReturnCampaignId: "campaign-one" }))
      .toMatchObject({ view: "chat", sessionId: " opaque session ", chatReturnCampaignId: "campaign-one" });
    for (const value of [" bad", "bad/id", "x".repeat(129)]) {
      expect(parseStoredNavigation({ view: "chat", sessionId: "session", chatReturnCampaignId: value }).chatReturnCampaignId).toBeUndefined();
    }
    expect(parseStoredNavigation({ view: "home", sessionId: "session", chatReturnCampaignId: "campaign-one" }).chatReturnCampaignId).toBeUndefined();
    expect(parseStoredNavigation({ view: "chat", chatReturnCampaignId: "campaign-one" })).toEqual({ view: "home", selectedIds: [] });
  });

  it("accepts unguarded home, create, lore, campaign, and content studio views without IDs", () => {
    expect(parseStoredNavigation({ view: "home" })).toEqual({ view: "home", selectedIds: [] });
    expect(parseStoredNavigation({ view: "create" })).toEqual({ view: "create", selectedIds: [] });
    expect(parseStoredNavigation({ view: "lore" })).toEqual({ view: "lore", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaigns" })).toEqual({ view: "campaigns", selectedIds: [] });
    expect(parseStoredNavigation({ view: "content-packs" })).toEqual({ view: "content-packs", selectedIds: [] });
  });

  it("requires a contract-valid detail campaign ID without normalizing it", () => {
    expect(parseStoredNavigation({ view: "campaign-detail" })).toEqual({ view: "campaigns", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-detail", campaignId: "" })).toEqual({ view: "campaigns", selectedIds: [] });
    for (const campaignId of ["  campaign  ", "bad/id", "x".repeat(129)]) {
      expect(parseStoredNavigation({ view: "campaign-detail", campaignId })).toEqual({ view: "campaigns", selectedIds: [] });
    }
    expect(parseStoredNavigation({ view: "campaign-detail", campaignId: "campaign-one" }))
      .toEqual({ view: "campaign-detail", campaignId: "campaign-one", selectedIds: [] });
  });

  it("guards campaign administration with the same strict campaign identity", () => {
    expect(parseStoredNavigation({ view: "campaign-administration" })).toEqual({ view: "campaigns", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-administration", campaignId: "bad/id" })).toEqual({ view: "campaigns", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-administration", campaignId: "campaign-one" }))
      .toEqual({ view: "campaign-administration", campaignId: "campaign-one", selectedIds: [] });
  });

  it("restores campaign history and transfer only with a strict campaign identity", () => {
    for (const view of ["campaign-history", "campaign-transfer"] as const) {
      expect(parseStoredNavigation({ view })).toEqual({ view: "campaigns", selectedIds: [] });
      expect(parseStoredNavigation({ view, campaignId: "bad/id" })).toEqual({ view: "campaigns", selectedIds: [] });
      expect(parseStoredNavigation({ view, campaignId: "campaign-one" })).toEqual({ view, campaignId: "campaign-one", selectedIds: [] });
    }
  });

  it("restores campaign play with only validated safe locators", () => {
    expect(parseStoredNavigation({ view: "campaign-play", campaignId: "campaign", sessionId: "room", adventureTurnId: "turn", playSelectedActorId: "actor", declaration: "secret", proposals: ["secret"] }))
      .toEqual({ view: "campaign-play", campaignId: "campaign", sessionId: "room", adventureTurnId: "turn", playSelectedActorId: "actor", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-play", campaignId: "campaign" })).toEqual({ view: "campaign-detail", campaignId: "campaign", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-play", campaignId: "bad/id", sessionId: "room", adventureTurnId: "bad/id" })).toEqual({ view: "campaigns", sessionId: "room", selectedIds: [] });
  });

  it("restores combat only inside a campaign and preserves a safe return origin", () => {
    expect(parseStoredNavigation({ view: "campaign-combat" })).toEqual({ view: "campaigns", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-combat", campaignId: "campaign-one", combatReturnView: "campaign-detail" }))
      .toMatchObject({ view: "campaign-combat", campaignId: "campaign-one", combatReturnView: "campaign-detail" });
    expect(parseStoredNavigation({ view: "campaign-combat", campaignId: "campaign-one", combatReturnView: "campaign-character-sheet" }).combatReturnView).toBe("campaign-detail");
    expect(parseStoredNavigation({ view: "campaign-combat", campaignId: "campaign-one", campaignCharacterId: "character-one", combatReturnView: "campaign-character-sheet" }).combatReturnView).toBe("campaign-character-sheet");
  });

  it("requires both strict workspace IDs and falls back to the nearest safe campaign view", () => {
    expect(parseStoredNavigation({ view: "campaign-character" })).toEqual({ view: "campaigns", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character", campaignId: "campaign-one" }))
      .toEqual({ view: "campaign-detail", campaignId: "campaign-one", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character", campaignId: "campaign-one", campaignCharacterId: "bad/id" }))
      .toEqual({ view: "campaign-detail", campaignId: "campaign-one", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character", campaignId: "bad/id", campaignCharacterId: "entry-one" }))
      .toEqual({ view: "campaigns", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character", campaignId: "campaign-one", campaignCharacterId: "entry-one" }))
      .toEqual({ view: "campaign-character", campaignId: "campaign-one", campaignCharacterId: "entry-one", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character-sheet", campaignId: "campaign-one", campaignCharacterId: "entry-one" }))
      .toEqual({ view: "campaign-character-sheet", campaignId: "campaign-one", campaignCharacterId: "entry-one", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character-sheet", campaignId: "campaign-one" }))
      .toEqual({ view: "campaign-detail", campaignId: "campaign-one", selectedIds: [] });
  });

  it("restores a campaign-bound builder draft and drops malformed identities", () => {
    expect(parseStoredNavigation({ view: "campaign-character-builder" })).toEqual({ view: "campaigns", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character-builder", campaignId: "campaign-one", characterDraftIds: { "campaign-one": "draft-one", "campaign-two": "draft-two" } }))
      .toEqual({ view: "campaign-character-builder", campaignId: "campaign-one", characterDraftIds: { "campaign-one": "draft-one", "campaign-two": "draft-two" }, selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character-builder", campaignId: "campaign-one", characterDraftIds: { "bad/id": "draft", "campaign-one": "bad/id" } }))
      .toEqual({ view: "campaign-character-builder", campaignId: "campaign-one", selectedIds: [] });
    expect(parseStoredNavigation({ view: "campaign-character-builder", campaignId: "campaign-one", characterDraftId: "legacy-draft" }))
      .toMatchObject({ characterDraftIds: { "campaign-one": "legacy-draft" } });
  });

  it("ignores unknown fields", () => {
    expect(parseStoredNavigation({ view: "lore", selectedIds: [], extra: "ignored", nested: { view: "chat" } })).toEqual({ view: "lore", selectedIds: [] });
  });

  it("reads missing storage as a parsed empty object", () => {
    expect(readNavigation()).toEqual({ view: "home", selectedIds: [] });
  });

  it("reads and parses stored navigation under the exact key", () => {
    localStorage.setItem(NAV_KEY, JSON.stringify({ view: "chat", sessionId: "session", selectedIds: ["one", "one", "two"] }));
    expect(readNavigation()).toEqual({ view: "chat", sessionId: "session", selectedIds: ["one", "two"] });
  });

  it("falls back when stored JSON is malformed", () => {
    localStorage.setItem(NAV_KEY, "not json");
    expect(readNavigation()).toEqual({ view: "home", selectedIds: [] });
  });

  it("falls back when storage reads fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readNavigation()).toEqual({ view: "home", selectedIds: [] });
  });

  it("serializes the supplied object exactly under the exact key, omitting undefined and retaining other values", () => {
    const navigation = {
      view: "home",
      characterId: undefined,
      sessionId: "",
      selectedIds: [],
      primaryId: "",
    } satisfies StoredNavigation;
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    writeNavigation(navigation);

    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(
      "velvet.navigation.v1",
      '{"view":"home","sessionId":"","selectedIds":[],"primaryId":""}',
    );
    expect(localStorage.getItem(NAV_KEY)).toBe('{"view":"home","sessionId":"","selectedIds":[],"primaryId":""}');
  });

  it("preserves the complete navigation serialization shape and property order", () => {
    writeNavigation({
      view: "chat",
      characterId: "character",
      sessionId: "session",
      selectedIds: ["second", "first"],
      primaryId: "second",
    });

    expect(localStorage.getItem(NAV_KEY)).toBe(
      '{"view":"chat","characterId":"character","sessionId":"session","selectedIds":["second","first"],"primaryId":"second"}',
    );
  });

  it("swallows storage write failures", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => writeNavigation({ view: "create" })).not.toThrow();
  });

  it("swallows serialization failures", () => {
    const navigation: Record<string, unknown> = { view: "home" };
    navigation.circular = navigation;
    expect(() => writeNavigation(navigation as unknown as StoredNavigation)).not.toThrow();
  });
});

import { resourceIdSchema } from "@velvet/contracts";

export type View = "campaign-overview" | "campaign-rooms" | "campaign-party" | "campaign-create" | "home" | "create" | "edit" | "memory" | "lore" | "chat" | "campaigns" | "campaign-detail" | "campaign-play" | "campaign-character" | "campaign-character-sheet" | "campaign-character-builder" | "campaign-administration" | "campaign-history" | "campaign-transfer" | "campaign-combat" | "campaign-world" | "campaign-cast" | "campaign-journal" | "campaign-story" | "content-packs";

export interface StoredNavigation {
  view: View;
  campaignEntry?: "overview";
  characterId?: string;
  sessionId?: string;
  selectedIds?: string[];
  primaryId?: string;
  campaignId?: string;
  campaignCharacterId?: string;
  combatReturnView?: "campaign-detail" | "campaign-character-sheet" | "campaign-play";
  /** Server-reported room role retained only while combat can return to play. */
  combatActorRole?: "owner" | "gm" | "player" | "observer";
  /** Exact actor controlled when combat was opened from a room. */
  combatControlledActorId?: string;
  /** Exact active combat selected by the room, when one was available. */
  combatId?: string;
  /** Room pane and trigger restored after a play-origin combat visit. */
  combatReturnPane?: "scene" | "conversation" | "character" | "context";
  combatReturnFocus?: "navigation" | "open-controls" | "prepare" | "rewards";
  /** Draft identities are campaign-scoped so one campaign can never load another campaign's draft. */
  characterDraftIds?: Record<string, string>;
  chatReturnCampaignId?: string;
  /** Durable adventure turn locator, never declaration or proposal content. */
  adventureTurnId?: string;
  /** Exact actor selected from the latest server play bootstrap. */
  playSelectedActorId?: string;
  /** Alternate room surface: the living atlas instead of the command center. */
  playSurface?: "atlas";
}

export const NAV_KEY = "velvet.navigation.v1";

const VIEWS = new Set<View>(["home", "create", "edit", "memory", "lore", "chat", "campaigns", "campaign-detail", "campaign-play", "campaign-character", "campaign-character-sheet", "campaign-character-builder", "campaign-administration", "campaign-history", "campaign-transfer", "campaign-combat", "campaign-world", "campaign-cast", "campaign-journal", "campaign-story", "content-packs"]);

for (const view of ["campaign-overview", "campaign-rooms", "campaign-party", "campaign-create"] as const) VIEWS.add(view);

export function parseStoredNavigation(value: unknown): StoredNavigation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { view: "home" };
  const candidate = value as Record<string, unknown>;
  const navigation: StoredNavigation = {
    view: typeof candidate.view === "string" && VIEWS.has(candidate.view as View) ? candidate.view as View : "home",
  };
  const stringField = (key: "characterId" | "sessionId" | "primaryId" | "campaignId") => {
    const field = candidate[key];
    if (typeof field === "string" && field.length > 0) navigation[key] = field;
  };
  stringField("characterId"); stringField("sessionId"); stringField("primaryId");
  if (typeof candidate.campaignId === "string" && resourceIdSchema.safeParse(candidate.campaignId).success) {
    navigation.campaignId = candidate.campaignId;
    if (candidate.campaignEntry === "overview") navigation.campaignEntry = "overview";
  }
  if (typeof candidate.campaignCharacterId === "string" && resourceIdSchema.safeParse(candidate.campaignCharacterId).success) {
    navigation.campaignCharacterId = candidate.campaignCharacterId;
  }
  const draftIds: Record<string, string> = {};
  if (typeof candidate.characterDraftIds === "object" && candidate.characterDraftIds !== null && !Array.isArray(candidate.characterDraftIds)) {
    for (const [campaignId, draftId] of Object.entries(candidate.characterDraftIds as Record<string, unknown>).slice(0, 100)) {
      if (resourceIdSchema.safeParse(campaignId).success && typeof draftId === "string" && resourceIdSchema.safeParse(draftId).success) draftIds[campaignId] = draftId;
    }
  }
  // One-way safe migration from the initial unscoped M3.3 navigation shape.
  if (navigation.view === "campaign-character-builder" && navigation.campaignId
    && typeof candidate.characterDraftId === "string" && resourceIdSchema.safeParse(candidate.characterDraftId).success) {
    draftIds[navigation.campaignId] = candidate.characterDraftId;
  }
  if (Object.keys(draftIds).length) navigation.characterDraftIds = draftIds;
  if (navigation.view === "chat" && navigation.sessionId
    && typeof candidate.chatReturnCampaignId === "string"
    && resourceIdSchema.safeParse(candidate.chatReturnCampaignId).success) {
    navigation.chatReturnCampaignId = candidate.chatReturnCampaignId;
  }
  if (navigation.view === "campaign-combat" && (candidate.combatReturnView === "campaign-detail" || candidate.combatReturnView === "campaign-character-sheet" || candidate.combatReturnView === "campaign-play")) {
    navigation.combatReturnView = candidate.combatReturnView;
    if (candidate.combatReturnView === "campaign-play" && navigation.sessionId) {
      if (["owner", "gm", "player", "observer"].includes(String(candidate.combatActorRole))) navigation.combatActorRole = candidate.combatActorRole as NonNullable<StoredNavigation["combatActorRole"]>;
      if (typeof candidate.combatControlledActorId === "string" && resourceIdSchema.safeParse(candidate.combatControlledActorId).success) navigation.combatControlledActorId = candidate.combatControlledActorId;
      if (typeof candidate.combatId === "string" && resourceIdSchema.safeParse(candidate.combatId).success) navigation.combatId = candidate.combatId;
      if (["scene", "conversation", "character", "context"].includes(String(candidate.combatReturnPane))) navigation.combatReturnPane = candidate.combatReturnPane as NonNullable<StoredNavigation["combatReturnPane"]>;
      if (["navigation", "open-controls", "prepare", "rewards"].includes(String(candidate.combatReturnFocus))) navigation.combatReturnFocus = candidate.combatReturnFocus as NonNullable<StoredNavigation["combatReturnFocus"]>;
    }
  }
  if (navigation.view === "campaign-play") {
    if (typeof candidate.adventureTurnId === "string" && resourceIdSchema.safeParse(candidate.adventureTurnId).success) navigation.adventureTurnId = candidate.adventureTurnId;
    if (typeof candidate.playSelectedActorId === "string" && resourceIdSchema.safeParse(candidate.playSelectedActorId).success) navigation.playSelectedActorId = candidate.playSelectedActorId;
    if (candidate.playSurface === "atlas") navigation.playSurface = "atlas";
  }
  navigation.selectedIds = Array.isArray(candidate.selectedIds)
    ? [...new Set(candidate.selectedIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  if (navigation.view === "chat" && !navigation.sessionId) navigation.view = "home";
  if (["campaign-overview", "campaign-rooms", "campaign-party", "campaign-create"].includes(navigation.view) && !navigation.campaignId) navigation.view = "campaigns";
  if ((navigation.view === "edit" || navigation.view === "memory") && !navigation.characterId) navigation.view = "home";
  if ((navigation.view === "campaign-detail" || navigation.view === "campaign-administration" || navigation.view === "campaign-history" || navigation.view === "campaign-transfer" || navigation.view === "campaign-combat" || navigation.view === "campaign-world" || navigation.view === "campaign-cast" || navigation.view === "campaign-journal" || navigation.view === "campaign-story") && !navigation.campaignId) navigation.view = "campaigns";
  if (navigation.view === "campaign-play" && (!navigation.campaignId || !navigation.sessionId)) {
    navigation.view = navigation.campaignId ? "campaign-detail" : "campaigns";
    delete navigation.adventureTurnId; delete navigation.playSelectedActorId; delete navigation.playSurface;
  }
  if (navigation.view === "campaign-character-builder" && !navigation.campaignId) navigation.view = "campaigns";
  if (navigation.view === "campaign-character" || navigation.view === "campaign-character-sheet") {
    if (!navigation.campaignId) {
      navigation.view = "campaigns";
      delete navigation.campaignCharacterId;
    } else if (!navigation.campaignCharacterId) {
      navigation.view = "campaign-detail";
    }
  }
  if (navigation.view === "campaign-combat" && navigation.combatReturnView === "campaign-character-sheet" && !navigation.campaignCharacterId) navigation.combatReturnView = "campaign-detail";
  if (navigation.view === "campaign-combat" && navigation.combatReturnView === "campaign-play" && !navigation.sessionId) {
    navigation.combatReturnView = "campaign-detail";
    delete navigation.combatActorRole; delete navigation.combatControlledActorId; delete navigation.combatId; delete navigation.combatReturnPane; delete navigation.combatReturnFocus;
  }
  return navigation;
}

export function readNavigation(): StoredNavigation {
  try { return parseStoredNavigation(JSON.parse(localStorage.getItem(NAV_KEY) ?? "{}") as unknown); }
  catch { return { view: "home", selectedIds: [] }; }
}

export function writeNavigation(navigation: StoredNavigation): void {
  try { localStorage.setItem(NAV_KEY, JSON.stringify(navigation)); }
  catch {
    // Navigation persistence is a convenience; private-storage failures must not block the app.
  }
}

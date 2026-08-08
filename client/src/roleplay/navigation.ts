import { resourceIdSchema } from "@velvet/contracts";

export type View = "home" | "create" | "edit" | "memory" | "lore" | "chat" | "campaigns" | "campaign-detail" | "campaign-character" | "campaign-administration" | "content-packs";

export interface StoredNavigation {
  view: View;
  characterId?: string;
  sessionId?: string;
  selectedIds?: string[];
  primaryId?: string;
  campaignId?: string;
  campaignCharacterId?: string;
  chatReturnCampaignId?: string;
}

export const NAV_KEY = "velvet.navigation.v1";

const VIEWS = new Set<View>(["home", "create", "edit", "memory", "lore", "chat", "campaigns", "campaign-detail", "campaign-character", "campaign-administration", "content-packs"]);

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
  }
  if (typeof candidate.campaignCharacterId === "string" && resourceIdSchema.safeParse(candidate.campaignCharacterId).success) {
    navigation.campaignCharacterId = candidate.campaignCharacterId;
  }
  if (navigation.view === "chat" && navigation.sessionId
    && typeof candidate.chatReturnCampaignId === "string"
    && resourceIdSchema.safeParse(candidate.chatReturnCampaignId).success) {
    navigation.chatReturnCampaignId = candidate.chatReturnCampaignId;
  }
  navigation.selectedIds = Array.isArray(candidate.selectedIds)
    ? [...new Set(candidate.selectedIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  if (navigation.view === "chat" && !navigation.sessionId) navigation.view = "home";
  if ((navigation.view === "edit" || navigation.view === "memory") && !navigation.characterId) navigation.view = "home";
  if ((navigation.view === "campaign-detail" || navigation.view === "campaign-administration") && !navigation.campaignId) navigation.view = "campaigns";
  if (navigation.view === "campaign-character") {
    if (!navigation.campaignId) {
      navigation.view = "campaigns";
      delete navigation.campaignCharacterId;
    } else if (!navigation.campaignCharacterId) {
      navigation.view = "campaign-detail";
    }
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

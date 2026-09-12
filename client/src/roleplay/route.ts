import { resourceIdSchema } from "@velvet/contracts";
import type { StoredNavigation, View } from "./navigation";

/**
 * URL hash routes for stable campaign and room destinations. Character and
 * sheet IDs are intentionally excluded so private actor identifiers never
 * appear in the browser URL or history; those views return null and leave the
 * current route untouched.
 */
const segmentByView: Partial<Record<View, string>> = {
  "campaign-detail": "",
  "campaign-overview": "overview",
  "campaign-rooms": "rooms",
  "campaign-party": "party",
  "campaign-create": "create",
  "campaign-administration": "manage",
  "campaign-world": "world",
  "campaign-cast": "cast",
  "campaign-journal": "journal",
  "campaign-story": "story",
  "campaign-history": "history",
  "campaign-transfer": "transfer",
  "campaign-combat": "combat",
};

const viewBySegment: Record<string, View> = Object.fromEntries(
  Object.entries(segmentByView).filter(([, segment]) => segment).map(([view, segment]) => [segment, view as View]),
) as Record<string, View>;

const encode = (value: string) => encodeURIComponent(value);
const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

/**
 * Returns a hash route for campaign and room destinations, `""` for the home
 * surface, or `null` when the current view should leave the URL unchanged.
 */
export function routeFromNavigation(navigation: StoredNavigation): string | null {
  if (navigation.view === "home") return "";
  if (navigation.view === "campaigns") return "#/campaigns";
  if (navigation.view === "campaign-play") {
    if (!navigation.campaignId || !navigation.sessionId) return navigation.campaignId ? `#/campaign/${encode(navigation.campaignId)}` : "";
    return `#/campaign/${encode(navigation.campaignId)}/play/${encode(navigation.sessionId)}`;
  }
  if (navigation.view === "chat") {
    // Only campaign-originated rooms are routable; library chat keeps its local navigation.
    if (!navigation.campaignId || !navigation.sessionId) return null;
    return `#/campaign/${encode(navigation.campaignId)}/room/${encode(navigation.sessionId)}`;
  }
  const segment = segmentByView[navigation.view];
  if (segment === undefined) return null;
  if (!navigation.campaignId) return "";
  return segment ? `#/campaign/${encode(navigation.campaignId)}/${segment}` : `#/campaign/${encode(navigation.campaignId)}`;
}

/** Parses a hash route back into safe stored navigation, or null when it is not an app route. */
export function navigationFromRoute(hash: string): StoredNavigation | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const parts = raw.split("/").filter(Boolean).map(decode);
  if (parts.length === 0) return { view: "home" };
  if (parts[0] === "campaigns") return { view: "campaigns" };
  if (parts[0] !== "campaign") return null;
  const campaignId = parts[1];
  if (!campaignId || !resourceIdSchema.safeParse(campaignId).success) return null;
  if (parts.length === 2) return { view: "campaign-detail", campaignId };
  const segment = parts[2]!;
  if (segment === "play" || segment === "room") {
    const sessionId = parts[3];
    if (!sessionId || !resourceIdSchema.safeParse(sessionId).success) return { view: "campaign-detail", campaignId };
    if (segment === "room") return { view: "chat", campaignId, sessionId, chatReturnCampaignId: campaignId };
    return { view: "campaign-play", campaignId, sessionId };
  }
  const view = viewBySegment[segment];
  return view ? { view, campaignId } : null;
}

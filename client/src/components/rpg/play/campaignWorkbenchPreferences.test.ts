import { afterEach, describe, expect, it } from "vitest";
import { applyCampaignWorkbenchPreferences, CAMPAIGN_WORKBENCH_PREFERENCES_KEY, readCampaignWorkbenchPreferences } from "./campaignWorkbenchPreferences";

describe("campaign workbench preferences", () => {
  afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; delete document.documentElement.dataset.density; });

  it("validates persisted values and applies theme and density", () => {
    localStorage.setItem(CAMPAIGN_WORKBENCH_PREFERENCES_KEY, JSON.stringify({ theme: "contrast", density: "compact", contextWidth: 9999, quickToolsWidth: 100, widgets: ["resources", "resources", "invalid"] }));
    const value = readCampaignWorkbenchPreferences();
    expect(value).toMatchObject({ theme: "contrast", density: "compact", contextWidth: 520, quickToolsWidth: 220, widgets: ["resources"] });
    applyCampaignWorkbenchPreferences(value);
    expect(document.documentElement.dataset).toMatchObject({ theme: "contrast", density: "compact" });
  });

  it("defaults automatic mechanics narration on and migrates stored payloads", () => {
    expect(readCampaignWorkbenchPreferences()).toMatchObject({ autoNarrateMechanics: true });
    // Older v1 payloads predate the key; migration must keep provider prose enabled.
    localStorage.setItem(CAMPAIGN_WORKBENCH_PREFERENCES_KEY, JSON.stringify({ theme: "dark", density: "compact" }));
    expect(readCampaignWorkbenchPreferences()).toMatchObject({ theme: "dark", autoNarrateMechanics: true });
    localStorage.setItem(CAMPAIGN_WORKBENCH_PREFERENCES_KEY, JSON.stringify({ autoNarrateMechanics: false }));
    expect(readCampaignWorkbenchPreferences()).toMatchObject({ autoNarrateMechanics: false });
    localStorage.setItem(CAMPAIGN_WORKBENCH_PREFERENCES_KEY, JSON.stringify({ autoNarrateMechanics: "no" }));
    expect(readCampaignWorkbenchPreferences()).toMatchObject({ autoNarrateMechanics: true });
  });
});

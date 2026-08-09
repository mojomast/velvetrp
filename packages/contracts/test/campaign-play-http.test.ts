import { describe, expect, it } from "vitest";
import { campaignPlayBootstrapSchema } from "../src/campaign-play-http.js";

const at = "2030-01-01T00:00:00.000Z";
const bootstrap = {
  campaignId: "campaign", sessionId: "session", expectedRevision: 7,
  session: { attached: true as const, attachedAt: at, active: true, adventureEligible: true },
  principal: { role: "player" as const, control: "controlled" as const },
  playableActors: [{ actorId: "actor", name: "Aria" }],
};

describe("campaign play HTTP contract", () => {
  it("accepts the exact minimal role-safe bootstrap", () => {
    expect(campaignPlayBootstrapSchema.parse(bootstrap)).toEqual(bootstrap);
    expect(Object.keys(campaignPlayBootstrapSchema.parse(bootstrap))).toEqual([
      "campaignId", "sessionId", "expectedRevision", "session", "principal", "playableActors",
    ]);
  });

  it.each(["principalId", "controllerPrincipalId", "timelineId", "campaignCharacterId", "sheetId", "personaId", "privateNotes"])(
    "rejects forbidden %s projection data", (field) => {
      expect(campaignPlayBootstrapSchema.safeParse({ ...bootstrap, [field]: "private" }).success).toBe(false);
    },
  );

  it("binds role to control and observer visibility", () => {
    expect(campaignPlayBootstrapSchema.safeParse({ ...bootstrap, principal: { role: "player", control: "all" } }).success).toBe(false);
    expect(campaignPlayBootstrapSchema.safeParse({ ...bootstrap, principal: { role: "observer", control: "none" } }).success).toBe(false);
    expect(campaignPlayBootstrapSchema.safeParse({ ...bootstrap, principal: { role: "observer", control: "none" }, playableActors: [] }).success).toBe(true);
  });

  it("preserves opaque room IDs but permits adventure eligibility only for strict stream IDs", () => {
    const opaque = { ...bootstrap, sessionId: " room/opaque ", session: { ...bootstrap.session, adventureEligible: false } };
    expect(campaignPlayBootstrapSchema.parse(opaque).sessionId).toBe(" room/opaque ");
    expect(campaignPlayBootstrapSchema.safeParse({ ...opaque, session: { ...opaque.session, adventureEligible: true } }).success).toBe(false);
  });

  it("requires active state for adventure eligibility and bounds actors", () => {
    expect(campaignPlayBootstrapSchema.safeParse({ ...bootstrap, session: { ...bootstrap.session, active: false } }).success).toBe(false);
    expect(campaignPlayBootstrapSchema.safeParse({ ...bootstrap,
      playableActors: Array.from({ length: 13 }, (_, index) => ({ actorId: `actor-${index}`, name: "Actor" })) }).success).toBe(false);
  });
});

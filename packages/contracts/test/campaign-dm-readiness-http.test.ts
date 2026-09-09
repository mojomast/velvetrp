import { describe, expect, it } from "vitest";
import {
  campaignDmReadinessCoverageCaps, campaignDmReadinessIssueCatalog,
  campaignDmReadinessResponseSchema,
} from "../src/campaign-dm-readiness-http.js";

const ref = (kind: string, id = "resource") => ({ kind, id });
const families = Object.entries(campaignDmReadinessCoverageCaps).map(([family]) => ({
  family, state: "complete", inspected: [ref("artifact")], omitted: [],
}));
const base = {
  version: "1.0", identity: { campaignId: "campaign", sessionId: "room", timelineId: "timeline", campaignRevision: 2, timelineRevision: 3 },
  activationReadiness: { campaignId: "campaign", sessionId: "room", expectedRevision: 2, active: true, ready: true, blockers: [], actorIds: ["actor"] },
  mode: "human", issues: [], coverage: { state: "complete", families }, manualReviewLimitations: [],
};

describe("campaign DM readiness contract", () => {
  it("accepts the complete provider-free report shape", () => {
    expect(campaignDmReadinessResponseSchema.parse(base)).toEqual(base);
  });

  it("accepts the finite diagnostic examples without executable digests", () => {
    const exampleDefinitions: [string, string, string, string, string][] = [
      ["room-obstacle", "blocker", "current-room", "room", "activation"],
      ["private-artifact", "warning", "campaign-level", "artifact", "content"],
      ["missing-binding", "blocker", "current-room", "encounter", "binding"],
      ["awaiting-play-evidence", "review", "awaiting-play-evidence", "evidence", "play"],
      ["optional-disconnected-content", "warning", "later-location", "artifact", "content"],
    ];
     const examples = exampleDefinitions.map(([code, severity, scope, kind]) => ({
       code, severity, scope, reference: ref(kind), ...campaignDmReadinessIssueCatalog[code as keyof typeof campaignDmReadinessIssueCatalog],
     }));
     expect(campaignDmReadinessResponseSchema.parse({ ...base, issues: examples })).toBeTruthy();
     expect(campaignDmReadinessResponseSchema.parse({ ...base, coverage: { state: "partial", families: families.map(f => ({ ...f, state: "partial", omitted: [ref("location")] })) }, manualReviewLimitations: ["Private or optional preparation was omitted from this report."] })).toBeTruthy();
  });

  it("rejects unknown fields, bad enums/references, malformed activation, and oversized values", () => {
    expect(campaignDmReadinessResponseSchema.safeParse({ ...base, extra: true }).success).toBe(false);
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, version: "2.0" }).success).toBe(false);
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, issues: [{ code: "room-obstacle", severity: "blocker", scope: "everywhere", reference: ref("candidate"), label: "x", explanation: "x", remediation: "activation" }] }).success).toBe(false);
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, issues: [{ code: "room-obstacle", severity: "blocker", scope: "current-room", reference: ref("room", "a".repeat(64)), ...campaignDmReadinessIssueCatalog["room-obstacle"] }] }).success).toBe(false);
    expect(campaignDmReadinessResponseSchema.safeParse({ ...base, activationReadiness: { ...base.activationReadiness, ready: true, blockers: ["room-not-startable"] } }).success).toBe(false);
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, issues: Array.from({ length: 129 }, () => ({ code: "room-obstacle", severity: "blocker", scope: "current-room", reference: ref("room"), label: "x", explanation: "x", remediation: "activation" })) }).success).toBe(false);
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, manualReviewLimitations: ["Uncontrolled private text"] }).success).toBe(false);
  });

  it("rejects oversized issue text, coverage arrays, and clean incomplete coverage", () => {
    const issue = { code: "room-obstacle", severity: "blocker", scope: "current-room", reference: ref("room"), label: "x".repeat(201), explanation: "x", remediation: "activation" };
    expect(campaignDmReadinessResponseSchema.safeParse({ ...base, issues: [issue] }).success).toBe(false);
    const tooMany = Array.from({ length: 65 }, () => ref("location"));
    expect(campaignDmReadinessResponseSchema.safeParse({ ...base, coverage: { state: "partial", families: families.map(f => f.family === "locations" ? { ...f, state: "partial", inspected: tooMany, omitted: [] } : f) } }).success).toBe(false);
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, coverage: { state: "complete", families: families.map(f => ({ ...f, state: "partial", omitted: [ref("artifact")] })) } }).success).toBe(false);
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, coverage: { state: "complete", families: families.map(f => f.family === "evidence" ? { ...f, family: "locations" } : f) } }).success).toBe(false);
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, activationReadiness: { ...base.activationReadiness, sessionId: "other-room" } }).success).toBe(false);
     const reversedIssues = [
       { code: "private-artifact", severity: "warning", scope: "campaign-level", reference: ref("artifact"), ...campaignDmReadinessIssueCatalog["private-artifact"] },
       { code: "room-obstacle", severity: "blocker", scope: "current-room", reference: ref("room"), ...campaignDmReadinessIssueCatalog["room-obstacle"] },
     ];
     expect(campaignDmReadinessResponseSchema.safeParse({ ...base, issues: reversedIssues }).success).toBe(false);
  });
});

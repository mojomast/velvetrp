import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";
import { revisionSchema } from "./rpg-commands.js";
import { campaignRoomActivationReadinessSchema } from "./campaign-room-activation-http.js";

/** The only supported wire version. A new version requires a new contract decision. */
export const campaignDmReadinessVersionSchema = z.literal("1.0");
export const campaignDmReadinessModeSchema = z.enum(["human", "ai"]);
export const campaignDmReadinessIssueSeveritySchema = z.enum(["blocker", "warning", "review"]);
export const campaignDmReadinessIssueScopeSchema = z.enum([
  "current-room", "later-location", "awaiting-play-evidence", "campaign-level",
]);

export const campaignDmReadinessReferenceKindSchema = z.enum([
  "campaign", "room", "timeline", "location", "artifact", "encounter", "story-node",
  "clue", "binding", "evidence", "quest-objective", "npc", "catalog-enemy",
]);
const campaignDmReadinessReferenceIdSchema = resourceIdSchema.refine(
  id => !/^[0-9a-f]{64}$/.test(id),
  "candidate digests are not valid readiness references",
);
export const campaignDmReadinessReferenceSchema = z.object({
  kind: campaignDmReadinessReferenceKindSchema,
  id: campaignDmReadinessReferenceIdSchema,
}).strict();

export const campaignDmReadinessRemediationSchema = z.enum([
  "activation", "content", "story", "binding", "play", "coverage", "manual-review",
]);

export const campaignDmReadinessIssueCodeSchema = z.enum([
  "room-obstacle", "private-artifact", "missing-binding", "awaiting-play-evidence",
  "optional-disconnected-content", "missing-public-rendering", "unbound-encounter",
  "unsupported-encounter-roster", "coverage-truncated", "manual-review-required",
]);

export type CampaignDmReadinessIssueCode = z.infer<typeof campaignDmReadinessIssueCodeSchema>;
export type CampaignDmReadinessRemediation = z.infer<typeof campaignDmReadinessRemediationSchema>;

/** Stable code, destination, and fixed safe wording for every diagnostic. */
export const campaignDmReadinessIssueCatalog = {
  "room-obstacle": {
    remediation: "activation", label: "Room obstacle",
    explanation: "The existing activation readiness checks report an obstacle in the inspected room.",
  },
  "private-artifact": {
    remediation: "content", label: "Private artifact",
    explanation: "This preparation artifact is not public player-facing content.",
  },
  "missing-binding": {
    remediation: "binding", label: "Missing scene binding",
    explanation: "The prepared scene has no explicit binding for qualifying committed evidence.",
  },
  "awaiting-play-evidence": {
    remediation: "play", label: "Awaiting play evidence",
    explanation: "The prepared binding is waiting for qualifying committed play evidence.",
  },
  "optional-disconnected-content": {
    remediation: "content", label: "Optional disconnected content",
    explanation: "This optional resource is not reachable from the inspected room and does not block the current path.",
  },
  "missing-public-rendering": {
    remediation: "story", label: "Missing public rendering",
    explanation: "The source content does not have reviewed public-safe rendering for this audience.",
  },
  "unbound-encounter": {
    remediation: "binding", label: "Unbound encounter",
    explanation: "The encounter has no explicit scene binding for authoritative resolution.",
  },
  "unsupported-encounter-roster": {
    remediation: "content", label: "Unsupported encounter roster",
    explanation: "The encounter concept is not backed by an exact supported executable roster.",
  },
  "coverage-truncated": {
    remediation: "coverage", label: "Coverage truncated",
    explanation: "Inspection bounds omitted preparation resources from this report.",
  },
  "manual-review-required": {
    remediation: "manual-review", label: "Manual review required",
    explanation: "This preparation property cannot be established by deterministic inspection alone.",
  },
} as const satisfies Record<CampaignDmReadinessIssueCode, {
  remediation: CampaignDmReadinessRemediation;
  label: string;
  explanation: string;
}>;

const issueSchemas = (Object.entries(campaignDmReadinessIssueCatalog) as [
  CampaignDmReadinessIssueCode,
  (typeof campaignDmReadinessIssueCatalog)[CampaignDmReadinessIssueCode],
][]).map(([code, definition]) => z.object({
  code: z.literal(code),
  severity: campaignDmReadinessIssueSeveritySchema,
  scope: campaignDmReadinessIssueScopeSchema,
  reference: campaignDmReadinessReferenceSchema.nullable(),
  label: z.literal(definition.label),
  explanation: z.literal(definition.explanation),
  remediation: z.literal(definition.remediation),
}).strict());

export const campaignDmReadinessIssueSchema = z.discriminatedUnion(
  "code",
  issueSchemas as [typeof issueSchemas[number], typeof issueSchemas[number], ...typeof issueSchemas],
);

export const campaignDmReadinessManualReviewLimitationSchema = z.enum([
  "Clue alternatives and fail-forward routes require human review.",
  "Finale and aftermath completeness require human review.",
  "Player-choice coverage cannot be established by deterministic inspection.",
  "Private or optional preparation was omitted from this report.",
  "Inspection coverage reached a family bound.",
  "Required paths and endings are not inferred from titles or prose.",
]);

export const campaignDmReadinessCoverageFamilySchema = z.enum([
  "locations", "connections", "actors", "quests", "encounters", "story", "clues",
  "artifacts", "bindings", "evidence",
]);
export const campaignDmReadinessCoverageStateSchema = z.enum(["complete", "partial", "omitted"]);

export const campaignDmReadinessCoverageCaps = {
  locations: 64, connections: 96, actors: 64, quests: 64, encounters: 64,
  story: 96, clues: 96, artifacts: 96, bindings: 64, evidence: 64,
} as const satisfies Record<CampaignDmReadinessCoverageFamily, number>;
export type CampaignDmReadinessCoverageFamily = z.infer<typeof campaignDmReadinessCoverageFamilySchema>;

const coverageReference = campaignDmReadinessReferenceSchema;
const coverageFamilySchemas = (Object.entries(campaignDmReadinessCoverageCaps) as [CampaignDmReadinessCoverageFamily, number][])
  .map(([family, cap]) => z.object({
    family: z.literal(family), state: campaignDmReadinessCoverageStateSchema,
    inspected: z.array(coverageReference).max(cap), omitted: z.array(coverageReference).max(cap),
  }).strict());
export const campaignDmReadinessCoverageFamilyEntrySchema = z.discriminatedUnion("family", coverageFamilySchemas as [typeof coverageFamilySchemas[number], typeof coverageFamilySchemas[number], ...typeof coverageFamilySchemas]);
export const campaignDmReadinessCoverageSchema = z.object({
  state: campaignDmReadinessCoverageStateSchema,
  families: z.array(campaignDmReadinessCoverageFamilyEntrySchema).length(Object.keys(campaignDmReadinessCoverageCaps).length),
}).strict().superRefine((coverage, context) => {
  const families = coverage.families.map(family => family.family);
  const expectedFamilies = Object.keys(campaignDmReadinessCoverageCaps);
  if (new Set(families).size !== families.length || expectedFamilies.some(family => !families.includes(family as typeof families[number]))) {
    context.addIssue({ code: "custom", path: ["families"], message: "coverage must contain each family exactly once" });
  }
  const incomplete = coverage.families.some(family => family.state !== "complete" || family.omitted.length > 0);
  if ((coverage.state === "complete") !== !incomplete) {
    context.addIssue({ code: "custom", path: ["state"], message: "coverage state must explicitly represent omissions" });
  }
});

export const campaignDmReadinessIdentitySchema = z.object({
  campaignId: resourceIdSchema, sessionId: resourceIdSchema, timelineId: resourceIdSchema,
  campaignRevision: revisionSchema, timelineRevision: revisionSchema,
}).strict();

export const campaignDmReadinessResponseSchema = z.object({
  version: campaignDmReadinessVersionSchema,
  identity: campaignDmReadinessIdentitySchema,
  activationReadiness: campaignRoomActivationReadinessSchema,
  mode: campaignDmReadinessModeSchema,
  issues: z.array(campaignDmReadinessIssueSchema).max(128),
  coverage: campaignDmReadinessCoverageSchema,
  manualReviewLimitations: z.array(campaignDmReadinessManualReviewLimitationSchema).max(16),
}).strict().superRefine((report, context) => {
  if (report.identity.campaignId !== report.activationReadiness.campaignId) {
    context.addIssue({ code: "custom", path: ["activationReadiness", "campaignId"], message: "activation campaign must match report identity" });
  }
  if (report.identity.sessionId !== report.activationReadiness.sessionId) {
    context.addIssue({ code: "custom", path: ["activationReadiness", "sessionId"], message: "activation room must match report identity" });
  }
  const issueOrder = Object.keys(campaignDmReadinessIssueCatalog);
  let previousOrder = -1;
  const seenIssues = new Set<string>();
  for (const issue of report.issues) {
    const currentOrder = issueOrder.indexOf(issue.code);
    if (currentOrder < previousOrder) {
      context.addIssue({ code: "custom", path: ["issues"], message: "issues must use deterministic taxonomy order" });
      break;
    }
    previousOrder = currentOrder;
    const issueKey = JSON.stringify(issue);
    if (seenIssues.has(issueKey)) {
      context.addIssue({ code: "custom", path: ["issues"], message: "duplicate diagnostic issue" });
      break;
    }
    seenIssues.add(issueKey);
  }
  const hasIncompleteCoverage = report.coverage.state !== "complete";
  if (!hasIncompleteCoverage && report.issues.some(issue => issue.code === "coverage-truncated")) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "truncated coverage cannot be reported as complete" });
  }
});

export type CampaignDmReadinessResponse = z.infer<typeof campaignDmReadinessResponseSchema>;
export type CampaignDmReadinessIssue = z.infer<typeof campaignDmReadinessIssueSchema>;
export type CampaignDmReadinessCoverage = z.infer<typeof campaignDmReadinessCoverageSchema>;
export type CampaignDmReadinessIdentity = z.infer<typeof campaignDmReadinessIdentitySchema>;

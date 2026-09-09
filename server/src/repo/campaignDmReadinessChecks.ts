import {
  campaignDmReadinessIssueCatalog,
  campaignDmReadinessManualReviewLimitationSchema,
  type CampaignDmReadinessIssue,
  type CampaignDmReadinessIssueCode,
} from "@velvet/contracts";
import type { z } from "zod";

type ReferenceKind = NonNullable<CampaignDmReadinessIssue["reference"]>["kind"];
export type ReadinessReference = { kind: ReferenceKind; id: string };
export type ReadinessVisibility = "public" | "private";
export type ReadinessLocationScope = "current-room" | "later-location";

export interface PublicRenderingFact {
  id: string;
  kind: ReferenceKind;
  visibility: ReadinessVisibility;
  rendered: boolean;
  locationScope?: ReadinessLocationScope;
  optional?: boolean;
  privateCompanion?: boolean;
}

export interface StoryNodeFact {
  id: string;
  status: "hidden" | "revealed" | "resolved";
  revealThreshold: number;
  visibility?: ReadinessVisibility;
  locationScope?: ReadinessLocationScope;
  privateCompanion?: boolean;
  optional?: boolean;
}
export interface StoryEdgeFact { id: string; kind: "sequence" | "requires"; fromId: string; toId: string }
export interface StoryClueFact {
  id: string;
  revealThreshold: number;
  availableSourceCount: number;
  visibility?: ReadinessVisibility;
  locationScope?: ReadinessLocationScope;
  optional?: boolean;
}
export interface StoryReadinessFacts {
  nodes?: readonly StoryNodeFact[];
  edges?: readonly StoryEdgeFact[];
  clues?: readonly StoryClueFact[];
}

export interface BindingFact {
  id: string;
  targetKind: "encounter" | "story-node" | "clue" | "quest-objective" | "evidence";
  targetId: string;
  state: "missing" | "prepared" | "awaiting-evidence" | "evidence-committed";
  locationScope?: ReadinessLocationScope;
  optional?: boolean;
}

export interface EncounterRosterFact {
  id: string;
  bound: boolean;
  exactPinnedEnemyReferences: readonly string[];
  conceptOnly: boolean;
  unsupportedRoster: boolean;
  optional?: boolean;
  locationId?: string;
  locationScope?: ReadinessLocationScope;
}

export interface LocationFact { id: string; visibility: ReadinessVisibility; optional?: boolean; privateCompanion?: boolean }
export interface LocationConnectionFact {
  id: string;
  fromId: string;
  toId: string;
  visibility?: ReadinessVisibility;
  optional?: boolean;
}
export interface LocationConnectivityFacts {
  startLocationId: string;
  locations: readonly LocationFact[];
  connections: readonly LocationConnectionFact[];
}

export interface CampaignDmReadinessCheckFacts {
  publicRendering?: readonly PublicRenderingFact[];
  story?: StoryReadinessFacts;
  bindings?: readonly BindingFact[];
  encounters?: readonly EncounterRosterFact[];
  connectivity?: LocationConnectivityFacts;
}

export interface CampaignDmReadinessCheckResult {
  issues: CampaignDmReadinessIssue[];
  manualReviewLimitations: Array<z.infer<typeof campaignDmReadinessManualReviewLimitationSchema>>;
}

const issueOrder: readonly CampaignDmReadinessIssueCode[] = [
  "room-obstacle", "private-artifact", "missing-binding", "awaiting-play-evidence",
  "optional-disconnected-content", "missing-public-rendering", "unbound-encounter",
  "unsupported-encounter-roster", "coverage-truncated", "manual-review-required",
];
const ref = (kind: ReferenceKind, id: string): ReadinessReference => ({ kind, id });
const scope = (optional: boolean | undefined, locationScope: ReadinessLocationScope = "current-room"): CampaignDmReadinessIssue["scope"] =>
  optional ? "campaign-level" : locationScope;
const stableCompare = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;

function makeIssue(code: CampaignDmReadinessIssueCode, severity: CampaignDmReadinessIssue["severity"],
  issueScope: CampaignDmReadinessIssue["scope"], reference: ReadinessReference | null): CampaignDmReadinessIssue {
  const definition = campaignDmReadinessIssueCatalog[code];
  return { code, severity, scope: issueScope, reference, label: definition.label,
    explanation: definition.explanation, remediation: definition.remediation } as CampaignDmReadinessIssue;
}

const key = (issue: CampaignDmReadinessIssue) => JSON.stringify(issue);
function finish(issues: CampaignDmReadinessIssue[]): CampaignDmReadinessIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => { const value = key(issue); if (seen.has(value)) return false; seen.add(value); return true; })
    .sort((a, b) => issueOrder.indexOf(a.code) - issueOrder.indexOf(b.code)
      || stableCompare(a.reference?.kind ?? "", b.reference?.kind ?? "")
      || stableCompare(a.reference?.id ?? "", b.reference?.id ?? "")
      || stableCompare(key(a), key(b)));
}

export function checkPublicRendering(facts: readonly PublicRenderingFact[] = []): CampaignDmReadinessIssue[] {
  return finish(facts.flatMap((fact) => {
    if (fact.visibility === "private") return [makeIssue("private-artifact", fact.optional || fact.privateCompanion ? "warning" : "review", scope(fact.optional, fact.locationScope), ref(fact.kind, fact.id))];
    return fact.rendered ? [] : [makeIssue("missing-public-rendering", "blocker", scope(fact.optional, fact.locationScope), ref(fact.kind, fact.id))];
  }));
}

export function checkStoryObstructions(facts: StoryReadinessFacts = {}, publicRendering: readonly PublicRenderingFact[] = []): CampaignDmReadinessIssue[] {
  const nodes = new Map((facts.nodes ?? []).map((node) => [node.id, node]));
  const publiclyRendered = new Set(publicRendering.filter((fact) => fact.kind === "story-node" && fact.visibility === "public" && fact.rendered).map((fact) => fact.id));
  const incoming = new Map<string, StoryEdgeFact[]>();
  for (const edge of facts.edges ?? []) incoming.set(edge.toId, [...(incoming.get(edge.toId) ?? []), edge]);
  const issues: CampaignDmReadinessIssue[] = [];
  for (const node of facts.nodes ?? []) {
    const allPredecessors = incoming.get(node.id) ?? [];
    const predecessors = allPredecessors.filter((edge) => edge.kind === "requires");
    const unresolvedRequired = predecessors.some((edge) => {
      const predecessor = nodes.get(edge.fromId);
      return !predecessor || predecessor.visibility === "private" || predecessor.privateCompanion
        || predecessor.status !== "resolved" || !publiclyRendered.has(predecessor.id);
    });
    const resolved = allPredecessors.filter((edge) => {
      const predecessor = nodes.get(edge.fromId);
      return predecessor?.visibility !== "private" && !predecessor?.privateCompanion
        && predecessor?.status === "resolved" && publiclyRendered.has(predecessor.id);
    }).length;
    const privateNode = node.visibility === "private" || node.privateCompanion;
    if (privateNode) {
      issues.push(makeIssue("private-artifact", "warning", scope(node.optional, node.locationScope), ref("story-node", node.id)));
      continue;
    }
    if ((unresolvedRequired || (node.status === "hidden" && resolved < node.revealThreshold)) && !node.optional)
      issues.push(makeIssue("room-obstacle", "blocker", scope(false, node.locationScope), ref("story-node", node.id)));
  }
  for (const clue of facts.clues ?? []) if (clue.availableSourceCount < clue.revealThreshold && !clue.optional)
    issues.push(makeIssue("room-obstacle", "blocker", scope(false, clue.locationScope), ref("clue", clue.id)));
  return finish(issues);
}

export function checkBindings(facts: readonly BindingFact[] = []): CampaignDmReadinessIssue[] {
  return finish(facts.flatMap((fact) => {
    const reference = ref(fact.targetKind, fact.targetId);
    if (fact.state === "missing") return [makeIssue("missing-binding", fact.optional ? "warning" : "blocker", scope(fact.optional, fact.locationScope), reference)];
    if (fact.state === "prepared" || fact.state === "awaiting-evidence")
      return [makeIssue("awaiting-play-evidence", "review", "awaiting-play-evidence", ref("binding", fact.id))];
    return [];
  }));
}

export function checkEncounterRosters(facts: readonly EncounterRosterFact[] = []): CampaignDmReadinessIssue[] {
  return finish(facts.flatMap((fact) => [
    ...(!fact.bound ? [makeIssue("unbound-encounter", fact.optional ? "warning" : "blocker", scope(fact.optional, fact.locationScope), ref("encounter", fact.id))] : []),
    ...((fact.conceptOnly || fact.unsupportedRoster || fact.exactPinnedEnemyReferences.length === 0)
       ? [makeIssue("unsupported-encounter-roster", fact.optional ? "warning" : "blocker", scope(fact.optional, fact.locationScope), ref("encounter", fact.id))] : []),
  ]));
}

export function checkLocationConnectivity(facts?: LocationConnectivityFacts): CampaignDmReadinessIssue[] {
  if (!facts) return [];
  const allowed = new Set(facts.locations.filter((location) => location.visibility === "public").map((location) => location.id));
  const reachable = new Set<string>(allowed.has(facts.startLocationId) ? [facts.startLocationId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of facts.connections) if (edge.visibility !== "private" && reachable.has(edge.fromId) && allowed.has(edge.toId) && !reachable.has(edge.toId)) { reachable.add(edge.toId); changed = true; }
  }
  return finish(facts.locations.filter((location) => location.id !== facts.startLocationId && !reachable.has(location.id)).map((location) =>
    location.visibility === "private" || location.privateCompanion
      ? makeIssue("private-artifact", "warning", "later-location", ref("location", location.id))
      : location.optional
        ? makeIssue("optional-disconnected-content", "warning", "campaign-level", ref("location", location.id))
        : makeIssue("room-obstacle", "blocker", "later-location", ref("location", location.id))));
}

export function checkCampaignDmReadiness(facts: CampaignDmReadinessCheckFacts): CampaignDmReadinessCheckResult {
  const issues = finish([
    ...checkPublicRendering(facts.publicRendering), ...checkStoryObstructions(facts.story, facts.publicRendering),
    ...checkBindings(facts.bindings), ...checkEncounterRosters(facts.encounters), ...checkLocationConnectivity(facts.connectivity),
  ]);
  return { issues, manualReviewLimitations: [
    "Clue alternatives and fail-forward routes require human review.",
    "Finale and aftermath completeness require human review.",
    "Player-choice coverage cannot be established by deterministic inspection.",
    "Required paths and endings are not inferred from titles or prose.",
  ] };
}

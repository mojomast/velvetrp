export type PlayabilityObservation = {
  id: string;
  scenario: string;
  step: string;
  mode: "human" | "ai" | "shared";
  branch: "main" | "failed" | "alternate" | "negative";
  sourceKind: "turn-receipt" | "dm-receipt" | "quest-projection" | "world-projection" | "reward-projection" | "callback";
  authority: "server" | "owner" | "player";
  audience: "public" | "owner";
  timeline: "past" | "current" | "post-finale";
  supportedFact: string;
  forbiddenInference: string;
  failureCategory: "none" | "negotiation" | "timing" | "claim" | "location" | "callback";
};

/** Stable Plan 3 recall probes; each fact is tied to a supported projection or receipt. */
export const PLAYABILITY_OBSERVATIONS: readonly PlayabilityObservation[] = [
  { id: "p3-harbor-task-offered-v1", scenario: "harbor-main", step: "task-offered", mode: "shared", branch: "main", sourceKind: "quest-projection", authority: "server", audience: "public", timeline: "current", supportedFact: "Restore the Harbor Light is offered before acceptance.", forbiddenInference: "The task was accepted automatically.", failureCategory: "none" },
  { id: "p3-harbor-task-accepted-v1", scenario: "harbor-main", step: "task-accepted", mode: "human", branch: "main", sourceKind: "turn-receipt", authority: "player", audience: "public", timeline: "past", supportedFact: "The player explicitly accepted Restore the Harbor Light.", forbiddenInference: "A later objective proves consent to accept.", failureCategory: "none" },
  { id: "p3-harbor-keeper-statement-v1", scenario: "harbor-main", step: "keeper-statement", mode: "shared", branch: "main", sourceKind: "dm-receipt", authority: "server", audience: "public", timeline: "past", supportedFact: "Keeper Maren's reviewed request is published.", forbiddenInference: "Private preparation text was published.", failureCategory: "none" },
  { id: "p3-harbor-negotiation-failed-v1", scenario: "harbor-failure", step: "negotiation-failed", mode: "human", branch: "failed", sourceKind: "turn-receipt", authority: "server", audience: "public", timeline: "past", supportedFact: "The attempted negotiation failed.", forbiddenInference: "The same check later succeeded or was rerolled.", failureCategory: "negotiation" },
  { id: "p3-harbor-saltglass-alternate-v1", scenario: "harbor-failure", step: "saltglass-alternate", mode: "human", branch: "alternate", sourceKind: "quest-projection", authority: "player", audience: "public", timeline: "current", supportedFact: "The public Saltglass alternate remains available after failure.", forbiddenInference: "The clue is an inventory reward or forced task acceptance.", failureCategory: "negotiation" },
  { id: "p3-harbor-clue-timing-v1", scenario: "harbor-main", step: "clue-timing", mode: "shared", branch: "main", sourceKind: "turn-receipt", authority: "server", audience: "public", timeline: "past", supportedFact: "Saltglass Trail is discovered only after its eligible action.", forbiddenInference: "Travel or task acceptance automatically revealed the clue.", failureCategory: "timing" },
  { id: "p3-harbor-reward-unclaimed-v1", scenario: "harbor-main", step: "reward-unclaimed", mode: "shared", branch: "main", sourceKind: "reward-projection", authority: "server", audience: "public", timeline: "current", supportedFact: "Keeper's acknowledgment is unclaimed before the explicit claim.", forbiddenInference: "Quest completion automatically settled the reward.", failureCategory: "claim" },
  { id: "p3-harbor-reward-claimed-v1", scenario: "harbor-main", step: "reward-claimed", mode: "human", branch: "main", sourceKind: "turn-receipt", authority: "player", audience: "public", timeline: "past", supportedFact: "The custom acknowledgment was explicitly claimed.", forbiddenInference: "The custom acknowledgment changed currency, inventory, or faction standing.", failureCategory: "claim" },
  { id: "p3-harbor-location-past-v1", scenario: "harbor-main", step: "location-past", mode: "shared", branch: "main", sourceKind: "world-projection", authority: "server", audience: "public", timeline: "past", supportedFact: "The actor departed Lantern Quay by the reviewed route.", forbiddenInference: "A local tactical move changed world location.", failureCategory: "location" },
  { id: "p3-harbor-location-current-v1", scenario: "harbor-main", step: "location-current", mode: "shared", branch: "main", sourceKind: "world-projection", authority: "server", audience: "public", timeline: "current", supportedFact: "The actor is currently at Keeper House after confirmed travel.", forbiddenInference: "Breakwater Cave or an encounter was automatically entered.", failureCategory: "location" },
  { id: "p3-harbor-finale-callback-v1", scenario: "harbor-main", step: "finale-callback", mode: "ai", branch: "main", sourceKind: "callback", authority: "owner", audience: "public", timeline: "post-finale", supportedFact: "Harbor Finale resolved only after relight evidence and owner completion remains separate.", forbiddenInference: "Narration alone completed the campaign or reveals private sentinel material.", failureCategory: "callback" },
  { id: "p3-harbor-unsupported-retreat-v1", scenario: "harbor-negative", step: "unsupported-retreat", mode: "shared", branch: "negative", sourceKind: "turn-receipt", authority: "server", audience: "owner", timeline: "current", supportedFact: "No supported active-combat retreat receipt exists.", forbiddenInference: "A player may infer retreat support from an optional encounter.", failureCategory: "none" },
];

export function validatePlayabilityObservations(observations = PLAYABILITY_OBSERVATIONS): void {
  const keys = new Set<string>();
  for (const item of observations) {
    const key = item.id;
    if (keys.has(key)) throw new Error(`duplicate playability observation: ${key}`);
    keys.add(key);
    for (const value of [item.id, item.scenario, item.step, item.supportedFact, item.forbiddenInference]) if (!value.trim()) throw new Error("playability observations require non-empty stable fields");
  }
}

validatePlayabilityObservations();

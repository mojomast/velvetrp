/** Shared staging/apply reference typing. Prose never supplies an executable reference. */
export const campaignGenerationArtifactKinds = {
  outlines: "outline", arcs: "arc", locations: "location", connections: "connection",
  factions: "faction", npcs: "npc", quests: "quest", encounters: "encounter", clues: "clue",
  storyNodes: "story-node", storyRelationships: "story-relationship", lore: "lore",
  questItems: "quest-item", monsterConcepts: "monster-concept", handouts: "handout", scenePrompts: "scene-prompt",
} as const;

export const campaignGenerationReferenceKinds: Readonly<Record<string, string>> = {
  startLocationKey: "location", locationKey: "location", locationKeys: "location",
  fromLocationKey: "location", toLocationKey: "location", factionKeys: "faction",
  arcKey: "arc", participantNpcKeys: "npc", npcKeys: "npc", monsterConceptKeys: "monster-concept",
  revealsStoryNodeKey: "story-node", fromStoryNodeKey: "story-node", toStoryNodeKey: "story-node",
  storyNodeKeys: "story-node", questKeys: "quest",
};

export function validateCampaignGenerationReferenceKinds(value: Record<string, unknown>, kinds: ReadonlyMap<string, string>): void {
  for (const [field, kind] of Object.entries(campaignGenerationReferenceKinds)) {
    const reference = value[field];
    if (reference === undefined) continue;
    for (const key of Array.isArray(reference) ? reference : [reference]) {
      if (typeof key !== "string" || kinds.get(key) !== kind) throw new Error(`generated ${field} must reference ${kind}`);
    }
  }
}

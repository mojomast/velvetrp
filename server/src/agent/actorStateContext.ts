import { canonicalAgentJson } from "@velvet/contracts";

const MAX_ACTOR_STATE_BYTES = 1_800;
const MAX_OTHER_RESOURCES = 4;
const MAX_INVENTORY_ENTRIES = 12;
const MAX_QUESTS = 6;

export interface ActorStateCombatant {
  name: string;
  hp: string;
}

export interface ActorStateContext {
  health: { current: number; max: number } | null;
  resources: Array<{ name: string; current: number; max: number }> | null;
  inventory: string[] | null;
  quests: Array<{ title: string; status: string }> | null;
  activeCombat: {
    round: number;
    enemies: ActorStateCombatant[];
    allies: ActorStateCombatant[];
  } | null;
}

type ItemReference = { kind: "item"; packId: string; packVersion: string; definitionId: string };
type InventoryItem =
  | { kind: "stackable"; entryId: string; item: ItemReference; quantity: number }
  | { kind: "instanced"; entryId: string; item: ItemReference };

/** Minimal read surface; the repository satisfies it without exposing internals. */
export interface ActorStateContextRepository {
  getCampaignAgentContextSnapshot(
    principal: string,
    campaignId: string,
    sessionId: string,
    audience: { kind: "player"; actorId: string },
  ): { encounter: { encounterId: string } | null } | null;
  getM15ActorResources(
    principal: string,
    campaignId: string,
    actorId: string,
  ): ReadonlyArray<{ resourceId: string; current: number; capacity: number }>;
  getActorInventorySnapshot(
    principal: string,
    campaignId: string,
    actorId: string,
  ): {
    inventory: { items: ReadonlyArray<InventoryItem> };
    equipment: ReadonlyArray<{ entryId: string }>;
  } | null;
  getCampaignContentPackDefinition(
    principal: string,
    campaignId: string,
    reference: ItemReference,
  ): { name: string } | null;
  listCampaignQuests(
    principal: string,
    campaignId: string,
  ): { quests: ReadonlyArray<{ title: string; status: string }> } | null;
  getCombatState(
    principal: string,
    combatId: string,
  ): {
    round: number;
    combatants: ReadonlyArray<{
      team: string;
      displayName?: string | undefined;
      hitPoints: number;
      maximumHitPoints: number;
      status?: string | undefined;
    }>;
  } | null;
}

const attempt = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

const combatantName = (combatant: { displayName?: string | undefined }): string | null => {
  const name = combatant.displayName?.trim();
  return name ? name : null;
};

const combatantsFor = (
  combat: NonNullable<ReturnType<ActorStateContextRepository["getCombatState"]>>,
  team: string,
): ActorStateCombatant[] =>
  combat.combatants.flatMap((combatant) => {
    const name = combatantName(combatant);
    if (combatant.team !== team || !name || combatant.status === "removed") return [];
    return [{ name, hp: `${combatant.hitPoints}/${combatant.maximumHitPoints}` }];
  });

const compact = (value: ActorStateContext): ActorStateContext => {
  const candidate = value;
  const bytes = () => Buffer.byteLength(canonicalAgentJson(candidate as never), "utf8");
  while (bytes() > MAX_ACTOR_STATE_BYTES) {
    if (candidate.inventory?.length) candidate.inventory = candidate.inventory.slice(0, -1);
    else if (candidate.quests?.length) candidate.quests = candidate.quests.slice(0, -1);
    else if (candidate.activeCombat?.enemies.length)
      candidate.activeCombat.enemies = candidate.activeCombat.enemies.slice(0, -1);
    else if (candidate.activeCombat?.allies.length)
      candidate.activeCombat.allies = candidate.activeCombat.allies.slice(0, -1);
    else if (candidate.resources?.length) candidate.resources = candidate.resources.slice(0, -1);
    else break;
  }
  return candidate;
};

/**
 * Builds the compact, id-free authoritative state the narrator may restate. Each
 * read fails closed to null so a broken projection can never fabricate state or
 * throw during narration.
 */
export function buildActorStateContext(input: {
  repo: ActorStateContextRepository;
  principal: string;
  campaignId: string;
  sessionId: string;
  actorId: string;
}): ActorStateContext {
  const { repo, principal, campaignId, sessionId, actorId } = input;
  const resources = attempt(() => repo.getM15ActorResources(principal, campaignId, actorId));
  const healthResource = resources?.find((resource) => resource.resourceId === "health");
  const health = healthResource ? { current: healthResource.current, max: healthResource.capacity } : null;
  const otherResources = resources
    ? resources
        .filter((resource) => resource.resourceId !== "health")
        .slice(0, MAX_OTHER_RESOURCES)
        .map((resource) => ({ name: resource.resourceId, current: resource.current, max: resource.capacity }))
    : null;

  const inventorySnapshot = attempt(() => repo.getActorInventorySnapshot(principal, campaignId, actorId));
  const equipped = new Set((inventorySnapshot?.equipment ?? []).map((entry) => entry.entryId));
  // Repeated inventory entries commonly share one definition; resolve each
  // distinct definition once per snapshot without changing the output.
  const definitions = new Map<string, { name: string }>();
  const inventoryEntries = inventorySnapshot
    ? inventorySnapshot.inventory.items.flatMap((item) => {
        const reference = item.item;
        const key = `${reference.packId}\0${reference.packVersion}\0${reference.kind}\0${reference.definitionId}`;
        let definition = definitions.get(key);
        if (!definition) {
          const resolved = attempt(() => repo.getCampaignContentPackDefinition(principal, campaignId, reference));
          if (!resolved) return [];
          definition = resolved;
          definitions.set(key, resolved);
        }
        if (!definition.name) return [];
        return [
          {
            text: definition.name,
            quantity: item.kind === "stackable" ? item.quantity : 1,
            equipped: equipped.has(item.entryId),
            stackable: item.kind === "stackable",
          },
        ];
      })
    : null;
  // Equipped and stackable possessions carry the most current state, so they
  // survive the 12-entry cap when a long starter kit would otherwise crowd
  // out tracked quantities such as healing potions.
  const inventory =
    inventoryEntries === null
      ? null
      : inventoryEntries
          .sort(
            (left, right) =>
              Number(right.equipped) - Number(left.equipped) || Number(right.stackable) - Number(left.stackable),
          )
          .slice(0, MAX_INVENTORY_ENTRIES)
          .map(
            (entry) =>
              `${entry.text}${entry.quantity > 1 ? ` x${entry.quantity}` : ""}${entry.equipped ? " (equipped)" : ""}`,
          );

  const questSnapshot = attempt(() => repo.listCampaignQuests(principal, campaignId));
  const quests = questSnapshot
    ? questSnapshot.quests
        .filter((quest) => quest.status === "active" || quest.status === "offered")
        .slice()
        .sort((left, right) => Number(right.status === "active") - Number(left.status === "active"))
        .slice(0, MAX_QUESTS)
        .map((quest) => ({ title: quest.title, status: quest.status }))
    : null;

  const snapshot = attempt(() =>
    repo.getCampaignAgentContextSnapshot(principal, campaignId, sessionId, { kind: "player", actorId }),
  );
  const encounterId = snapshot?.encounter?.encounterId ?? null;
  const combat = encounterId ? attempt(() => repo.getCombatState(principal, encounterId)) : null;
  const activeCombat = combat
    ? {
        round: combat.round,
        enemies: combatantsFor(combat, "enemies"),
        allies: combatantsFor(combat, "allies"),
      }
    : null;

  return compact({ health, resources: otherResources, inventory, quests, activeCombat });
}

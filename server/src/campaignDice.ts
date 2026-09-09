import {
  campaignDiceHistoryResponseSchema,
  campaignDiceRollRequestSchema,
  campaignDiceRollResponseSchema,
  commandEnvelopeSchema,
  commandReceiptSchema,
  type CampaignDiceHistoryResponse,
  type CampaignDiceRollRequest,
  type CampaignDiceRollResponse,
  type CampaignDiceVisibleCharacter,
  type CommandEnvelope,
} from "@velvet/contracts";
import type { IdGenerator } from "./runtime.js";
import {
  CampaignDiceCharacterConflict,
  type CampaignDiceVisibleCharacterBinding,
  type CampaignDiceEvent,
  type Repository,
  type RepositoryUnitOfWork,
} from "./repo/index.js";
/* Keep the route-facing name stable while using the repository's narrow type. */
export { CampaignDiceCharacterConflict as CampaignDiceVisibleBindingConflictError } from "./repo/index.js";

/** Safe, non-disclosing classification for absent or unauthorized campaigns. */
export class CampaignDiceUnavailableError extends Error {
  readonly code = "CAMPAIGN_DICE_UNAVAILABLE";
  constructor() {
    super("campaign dice is unavailable");
    this.name = "CampaignDiceUnavailableError";
  }
}

export interface CampaignDiceRepository extends Pick<Repository, "executeRollActorDiceForVisibleCharacter"> {
  transaction<T>(callback: (unit: Pick<RepositoryUnitOfWork,
    "getCampaign" | "getCampaignAdministration" | "getCampaignTimeline" | "getCampaignCharacterRoster"
    | "listCampaignCharacters" | "listRecentCampaignDiceEvents">) => T): T;
}

interface InternalVisibleCharacter {
  public: CampaignDiceVisibleCharacter;
  campaignCharacterId: string;
  actorId: string;
  controlledByCaller: boolean;
}

interface DiceSnapshot {
  timelineId: string;
  revision: number;
  actorRole: "owner" | "gm" | "player";
  characters: InternalVisibleCharacter[];
}

function requireAuthorityAndRoster(
  unit: Pick<RepositoryUnitOfWork,
    "getCampaign" | "getCampaignAdministration" | "getCampaignTimeline"
    | "getCampaignCharacterRoster" | "listCampaignCharacters">,
  actorPrincipalId: string,
  campaignId: string,
  allowPlayer: boolean,
): DiceSnapshot {
  const campaign = unit.getCampaign(actorPrincipalId, campaignId);
  if (campaign === null || (campaign.actorRole !== "owner" && campaign.actorRole !== "gm"
      && (!allowPlayer || campaign.actorRole !== "player"))) {
    throw new CampaignDiceUnavailableError();
  }
  if (campaign.actorRole === "player") {
    const administration = unit.getCampaignAdministration(actorPrincipalId, campaignId);
    if (administration === null || administration.id !== campaignId
        || administration.activeTimelineId !== campaign.activeTimelineId
        || administration.actorRole !== "player") {
      throw new Error("campaign dice authorization is inconsistent");
    }
    if (!administration.settings.allowPlayerDice) throw new CampaignDiceUnavailableError();
  }
  const timeline = unit.getCampaignTimeline(actorPrincipalId, campaignId, campaign.activeTimelineId);
  const roster = unit.getCampaignCharacterRoster(actorPrincipalId, campaignId);
  if (timeline === null || roster === null || roster.campaignId !== campaignId
      || timeline.campaignId !== campaignId || timeline.id !== campaign.activeTimelineId) {
    throw new Error("campaign dice snapshot is inconsistent");
  }

  const aggregate = unit.listCampaignCharacters(actorPrincipalId, campaignId);
  const actorByCharacter = new Map<string, string>();
  const controlledCharacters = new Set<string>();
  for (const entry of aggregate) {
    const characterId = entry.projection.campaignCharacter.id;
    const actorId = entry.projection.actor.id;
    if (actorByCharacter.has(characterId)) throw new Error("campaign dice roster is ambiguous");
    actorByCharacter.set(characterId, actorId);
    if (entry.access === "privileged"
        && entry.projection.actor.controllerPrincipalId === actorPrincipalId) {
      controlledCharacters.add(characterId);
    }
  }
  if (aggregate.length !== roster.characters.length) throw new Error("campaign dice roster is inconsistent");
  const characters = roster.characters.map((character, index) => {
    const actorId = actorByCharacter.get(character.id);
    if (actorId === undefined) throw new Error("campaign dice roster is inconsistent");
    return {
      public: { position: index + 1, name: character.name },
      campaignCharacterId: character.id,
      actorId,
      controlledByCaller: campaign.actorRole !== "player" || controlledCharacters.has(character.id),
    };
  });
  return { timelineId: timeline.id, revision: timeline.revision, actorRole: campaign.actorRole, characters };
}

function safeRoll(
  event: CampaignDiceEvent,
  characterByActor: ReadonlyMap<string, CampaignDiceVisibleCharacter>,
) {
  const character = characterByActor.get(event.actorId);
  if (character === undefined) throw new Error("campaign dice history actor is no longer visible");
  return { character, occurredAt: event.occurredAt, result: event.data };
}

export function createCampaignDiceService(repository: CampaignDiceRepository, commandIds: IdGenerator) {
  return {
    read(actorPrincipalId: string, campaignId: string): CampaignDiceHistoryResponse {
      const raw = repository.transaction((unit) => {
        const snapshot = requireAuthorityAndRoster(unit, actorPrincipalId, campaignId, true);
        const events = unit.listRecentCampaignDiceEvents(actorPrincipalId, campaignId, snapshot.timelineId);
        const visibleCharacters = snapshot.actorRole === "player"
          ? snapshot.characters.filter((character) => character.controlledByCaller)
          : snapshot.characters;
        const characterByActor = new Map(visibleCharacters.map((character) => [
          character.actorId, character.public,
        ]));
        return {
          characters: visibleCharacters.map((character) => character.public),
          rolls: events.filter((event) => characterByActor.has(event.actorId))
            .map((event) => safeRoll(event, characterByActor)),
        };
      });
      return campaignDiceHistoryResponseSchema.parse(raw);
    },

    roll(actorPrincipalId: string, campaignId: string, input: CampaignDiceRollRequest): CampaignDiceRollResponse {
      const request = campaignDiceRollRequestSchema.parse(input);
      // This transaction is preflight only. It is closed before ID generation,
      // RNG, command execution, or any dependency capable of writing.
      const selected = repository.transaction((unit) => {
        const snapshot = requireAuthorityAndRoster(unit, actorPrincipalId, campaignId, true);
        const character = snapshot.characters[request.character.position - 1];
        if (character === undefined || character.public.name !== request.character.name) {
          throw new CampaignDiceCharacterConflict();
        }
        if (!character.controlledByCaller) throw new CampaignDiceUnavailableError();
        return { ...snapshot, character };
      });

      // One separately injected value owns both internal deduplication fields;
      // neither value is accepted from HTTP headers or payloads.
      const commandId = commandIds.nextId();
      const envelope: CommandEnvelope = commandEnvelopeSchema.parse({
        commandId,
        idempotencyKey: commandId,
        campaignId,
        timelineId: selected.timelineId,
        actorId: selected.character.actorId,
        expectedRevision: selected.revision,
        sourceTurnId: null,
        command: { type: "roll_actor_dice", payload: { expression: request.expression } },
      });
      // Exactly one attempt. Any executor exception is intentionally ambiguous:
      // the write may have committed and must be reconciled through history.
      const binding: CampaignDiceVisibleCharacterBinding = {
        ...selected.character.public,
        campaignCharacterId: selected.character.campaignCharacterId,
      };
      const receipt = commandReceiptSchema.parse(repository.executeRollActorDiceForVisibleCharacter(
        actorPrincipalId, envelope, binding,
      ));
      const event = receipt.events[0];
      if (receipt.commandId !== envelope.commandId || receipt.campaignId !== campaignId
          || receipt.revisionBefore !== selected.revision || receipt.revisionAfter !== selected.revision + 1
          || event.type !== "actor_dice_rolled" || event.commandId !== envelope.commandId
          || event.campaignId !== campaignId || event.timelineId !== selected.timelineId
          || event.actorId !== selected.character.actorId || event.sourceTurnId !== null
          || event.data.expression !== request.expression) {
        throw new Error("campaign dice command output is inconsistent");
      }
      return campaignDiceRollResponseSchema.parse({
        roll: safeRoll(event, new Map([[selected.character.actorId, selected.character.public]])),
      });
    },
  };
}

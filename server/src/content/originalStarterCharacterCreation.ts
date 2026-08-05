import {
  campaignCharacterCreateRequestSchema,
  campaignCharacterCreateResponseSchema,
  campaignCharacterCreationOptionsResponseSchema,
  createCampaignCharacterInputSchema,
  privilegedCampaignCharacterProjectionSchema,
  resourceIdSchema,
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
  type CampaignCharacterCreateRequest,
  type CampaignCharacterCreateResponse,
  type PrivilegedCampaignCharacterProjection,
} from "@velvet/contracts";
import {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
  type Repository,
} from "../repo.js";

const LOCAL_OWNER = "local-owner";

export class OriginalStarterCharacterCreationUnavailableError extends Error {
  readonly code = "ORIGINAL_STARTER_CHARACTER_CREATION_UNAVAILABLE";
  constructor() {
    super("original starter character creation is unavailable");
    this.name = "OriginalStarterCharacterCreationUnavailableError";
  }
}

export class OriginalStarterCharacterPersonaUnavailableError extends Error {
  readonly code = "ORIGINAL_STARTER_CHARACTER_PERSONA_UNAVAILABLE";
  constructor() {
    super("original starter character persona is missing or ineligible");
    this.name = "OriginalStarterCharacterPersonaUnavailableError";
  }
}

export class OriginalStarterCharacterCreationConflictError extends Error {
  readonly code = "ORIGINAL_STARTER_CHARACTER_CREATION_CONFLICT";
  constructor() {
    super("original starter character already exists for this persona");
    this.name = "OriginalStarterCharacterCreationConflictError";
  }
}

export interface OriginalStarterCharacterCreationRepository {
  getCampaignCharacterCreationOptions: Repository["getCampaignCharacterCreationOptions"];
  createOriginalStarterCampaignCharacter: Repository["createOriginalStarterCampaignCharacter"];
}

export interface OriginalStarterCharacterCreationService {
  create(campaignId: string, request: CampaignCharacterCreateRequest): CampaignCharacterCreateResponse;
}

/**
 * Factory-only specialization. Identity, controller, content, sheet arrays and
 * private state are server-owned; the browser-shaped request selects only a
 * reviewed eligible Velvet persona.
 */
export function createOriginalStarterCharacterCreationService(
  repository: OriginalStarterCharacterCreationRepository,
): OriginalStarterCharacterCreationService {
  return {
    create(campaignId, request) {
      const id = resourceIdSchema.parse(campaignId);
      const reduced = campaignCharacterCreateRequestSchema.parse(request);

      const rawOptions = repository.getCampaignCharacterCreationOptions(LOCAL_OWNER, id);
      if (rawOptions === null) throw new OriginalStarterCharacterCreationUnavailableError();
      const options = campaignCharacterCreationOptionsResponseSchema.parse(rawOptions);
      if (options.campaignId !== id
        || options.starter.rulesProfile.rulesProfileId !== ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId
        || options.starter.pack.packId !== ORIGINAL_STARTER_PACK.packId
        || options.starter.pack.packVersion !== ORIGINAL_STARTER_PACK.packVersion) {
        throw new Error("original starter character creation preflight is malformed");
      }
      const personas = options.personas.filter((persona) => persona.characterId === reduced.characterId);
      if (personas.length !== 1) throw new OriginalStarterCharacterPersonaUnavailableError();
      if (personas[0]!.alreadyUsed) throw new OriginalStarterCharacterCreationConflictError();
      const input = createCampaignCharacterInputSchema.parse({
        campaignId: id,
        characterId: reduced.characterId,
        controllerPrincipalId: LOCAL_OWNER,
        race: ORIGINAL_STARTER_RACE.reference,
        background: ORIGINAL_STARTER_BACKGROUND.reference,
        classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
        attributes: [],
        proficiencies: [],
        choices: [],
      });

      let rawProjection: PrivilegedCampaignCharacterProjection;
      let lockedPersonaName: string;
      try {
        const lockedResult = repository.createOriginalStarterCampaignCharacter(LOCAL_OWNER, input);
        rawProjection = lockedResult.projection;
        lockedPersonaName = lockedResult.personaDisplayName;
      } catch (error) {
        if (error instanceof CampaignCharacterCreationUnavailableError) {
          throw new OriginalStarterCharacterCreationUnavailableError();
        }
        if (error instanceof CampaignCharacterPersonaUnavailableError) {
          throw new OriginalStarterCharacterPersonaUnavailableError();
        }
        if (error instanceof CampaignCharacterCreationConflictError) {
          throw new OriginalStarterCharacterCreationConflictError();
        }
        throw error;
      }

      const projection = privilegedCampaignCharacterProjectionSchema.parse(rawProjection);
      const { campaignCharacter, sheet, actor } = projection;
      if (campaignCharacter.campaignId !== id || campaignCharacter.characterId !== reduced.characterId
        || sheet.campaignId !== id || actor.campaignId !== id
        || actor.controllerPrincipalId !== LOCAL_OWNER || actor.privateNotes !== null
        || JSON.stringify(sheet.race) !== JSON.stringify(input.race)
        || JSON.stringify(sheet.background) !== JSON.stringify(input.background)
        || JSON.stringify(sheet.classes) !== JSON.stringify(input.classes)
        || sheet.attributes.length !== 0 || sheet.proficiencies.length !== 0 || sheet.choices.length !== 0
        || campaignCharacter.createdAt !== campaignCharacter.updatedAt
        || sheet.createdAt !== campaignCharacter.createdAt || sheet.updatedAt !== campaignCharacter.createdAt
        || actor.createdAt !== campaignCharacter.createdAt || actor.updatedAt !== campaignCharacter.createdAt) {
        throw new Error("original starter character creation output is malformed");
      }
      return campaignCharacterCreateResponseSchema.parse({
        character: {
          id: campaignCharacter.id,
          characterId: campaignCharacter.characterId,
          name: lockedPersonaName,
        },
      });
    },
  };
}

/** Deliberately narrow failures that HTTP adapters may safely classify. */
export class CampaignCreationAuthorizationError extends Error {
  readonly code = "CAMPAIGN_CREATION_FORBIDDEN";

  constructor() {
    super("campaign creation requires the application owner");
    this.name = "CampaignCreationAuthorizationError";
  }
}

export class CampaignCreationIdCollisionError extends Error {
  readonly code = "CAMPAIGN_CREATION_ID_COLLISION";

  constructor() {
    super("a generated campaign resource ID already exists");
    this.name = "CampaignCreationIdCollisionError";
  }
}

export class CampaignRenameUnavailableError extends Error {
  readonly code = "CAMPAIGN_RENAME_UNAVAILABLE";

  constructor() {
    super("campaign is unavailable for rename");
    this.name = "CampaignRenameUnavailableError";
  }
}

export class CampaignRenameStaleError extends Error {
  readonly code = "CAMPAIGN_RENAME_STALE";

  constructor() {
    super("campaign rename precondition is stale");
    this.name = "CampaignRenameStaleError";
  }
}

/** Safe HTTP classifications for the campaign-room linking write only. */
export class CampaignSessionAttachmentUnavailableError extends Error {
  readonly code = "CAMPAIGN_SESSION_ATTACHMENT_UNAVAILABLE";
  constructor(message = "campaign session attachment requires the campaign owner") {
    super(message);
    this.name = "CampaignSessionAttachmentUnavailableError";
  }
}

export class CampaignSessionAttachmentSessionMissingError extends Error {
  readonly code = "CAMPAIGN_SESSION_ATTACHMENT_SESSION_MISSING";
  constructor() {
    super("session not found");
    this.name = "CampaignSessionAttachmentSessionMissingError";
  }
}

export class CampaignSessionAttachmentConflictError extends Error {
  readonly code = "CAMPAIGN_SESSION_ATTACHMENT_CONFLICT";
  constructor(message: "session is already attached to a different campaign"
    | "stopped sessions cannot be attached to campaigns"
    | "running sessions with present NPCs cannot be detached") {
    super(message);
    this.name = "CampaignSessionAttachmentConflictError";
  }
}

export class ContentPackInstallationAuthorizationError extends Error {
  readonly code = "CONTENT_PACK_INSTALLATION_FORBIDDEN";
  constructor() {
    super("content pack installation requires the application owner");
    this.name = "ContentPackInstallationAuthorizationError";
  }
}

export class ContentPackInstallationConflictError extends Error {
  readonly code = "CONTENT_PACK_INSTALLATION_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ContentPackInstallationConflictError";
  }
}

export class CampaignContentConfigurationAuthorizationError extends Error {
  readonly code = "CAMPAIGN_CONTENT_CONFIGURATION_UNAVAILABLE";
  constructor(message = "campaign content configuration is unavailable") {
    super(message);
    this.name = "CampaignContentConfigurationAuthorizationError";
  }
}

export class CampaignContentConfigurationConflictError extends Error {
  readonly code = "CAMPAIGN_CONTENT_CONFIGURATION_CONFLICT";
  constructor(message = "campaign content configuration conflicts with existing configuration") {
    super(message);
    this.name = "CampaignContentConfigurationConflictError";
  }
}

/** Narrow classifications for the atomic generic campaign-character write. */
export class CampaignCharacterCreationUnavailableError extends Error {
  readonly code = "CAMPAIGN_CHARACTER_CREATION_UNAVAILABLE";
  constructor() {
    super("campaign character creation unavailable");
    this.name = "CampaignCharacterCreationUnavailableError";
  }
}

export class CampaignCharacterPersonaUnavailableError extends Error {
  readonly code = "CAMPAIGN_CHARACTER_PERSONA_UNAVAILABLE";
  constructor() {
    super("campaign character persona is missing or ineligible");
    this.name = "CampaignCharacterPersonaUnavailableError";
  }
}

export class CampaignCharacterCreationConflictError extends Error {
  readonly code = "CAMPAIGN_CHARACTER_CREATION_CONFLICT";
  constructor() {
    super("campaign character already exists for this persona");
    this.name = "CampaignCharacterCreationConflictError";
  }
}

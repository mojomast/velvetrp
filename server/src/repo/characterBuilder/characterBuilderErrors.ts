/** Raised when an actor cannot perform a character-draft operation. */
export class CharacterBuilderAuthorizationError extends Error {
  readonly code = "CHARACTER_BUILDER_FORBIDDEN";
  constructor() { super("character draft operation is unavailable"); this.name = "CharacterBuilderAuthorizationError"; }
}

/** Raised when a character-draft command conflicts with authoritative state. */
export class CharacterBuilderConflictError extends Error {
  readonly code = "CHARACTER_BUILDER_CONFLICT";
  constructor(message = "character draft command conflicts with authoritative state") { super(message); this.name = "CharacterBuilderConflictError"; }
}

/** Raised when a command's expected draft revision is no longer current. */
export class CharacterBuilderStaleError extends Error {
  readonly code = "CHARACTER_BUILDER_STALE";
  constructor() { super("character draft revision is stale"); this.name = "CharacterBuilderStaleError"; }
}

/** Raised when an expiring draft is no longer effective. */
export class CharacterBuilderExpiredError extends Error {
  readonly code = "CHARACTER_BUILDER_EXPIRED";
  constructor() { super("character draft has expired"); this.name = "CharacterBuilderExpiredError"; }
}

/** Raised when finalization lacks the required character-builder choices. */
export class CharacterBuilderIncompleteError extends Error {
  readonly code = "CHARACTER_BUILDER_INCOMPLETE";
  constructor() { super("character draft is incomplete"); this.name = "CharacterBuilderIncompleteError"; }
}

/** Raised when an authoritative builder dependency is unavailable or malformed. */
export class CharacterBuilderUnavailableError extends Error {
  readonly code = "CHARACTER_BUILDER_UNAVAILABLE";
  constructor(message = "character draft dependency is unavailable") { super(message); this.name = "CharacterBuilderUnavailableError"; }
}

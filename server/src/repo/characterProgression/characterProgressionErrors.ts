/** Raised when a principal cannot access or change a character's progression. */
export class CharacterProgressionAuthorizationError extends Error { readonly code="CHARACTER_PROGRESSION_FORBIDDEN"; constructor(){super("character progression is unavailable");} }
/** Raised when required progression rules or content cannot be resolved. */
export class CharacterProgressionUnavailableError extends Error { readonly code="CHARACTER_PROGRESSION_UNAVAILABLE"; constructor(message="character progression is unavailable"){super(message);} }
/** Raised when a valid command conflicts with authoritative progression state. */
export class CharacterProgressionConflictError extends Error { readonly code="CHARACTER_PROGRESSION_CONFLICT"; constructor(message="character progression command conflicts with authoritative state"){super(message);} }
/** Raised when a command's expected progression revision is no longer current. */
export class CharacterProgressionStaleError extends Error { readonly code="CHARACTER_PROGRESSION_STALE"; constructor(){super("character progression revision is stale");} }

/** Raised when a principal lacks authority for an encounter command. */
export class EncounterAuthorizationError extends Error { readonly code="ENCOUNTER_FORBIDDEN"; }
/** Raised when a command's expected combat revision is no longer current. */
export class EncounterStaleError extends Error { readonly code="ENCOUNTER_STALE"; }
/** Raised when an encounter command conflicts with authoritative state. */
export class EncounterConflictError extends Error { readonly code="ENCOUNTER_CONFLICT"; }
/** Raised when an encounter or required combat resource is unavailable. */
export class EncounterUnavailableError extends Error { readonly code="ENCOUNTER_UNAVAILABLE"; }
/** Raised when a command does not apply to the current combatant's turn. */
export class EncounterTurnError extends Error { readonly code="ENCOUNTER_NOT_CURRENT_TURN"; }

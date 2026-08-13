/** Raised when a principal lacks the authority required for a world operation. */
export class WorldAuthorizationError extends Error { readonly code = "WORLD_FORBIDDEN"; }
/** Raised when a command's expected world revision is no longer current. */
export class WorldStaleError extends Error { readonly code = "WORLD_STALE"; }
/** Raised when an idempotency key is reused for a different command. */
export class WorldConflictError extends Error { readonly code = "WORLD_CONFLICT"; }
/** Raised when a requested world resource or operation is unavailable. */
export class WorldUnavailableError extends Error { readonly code = "WORLD_UNAVAILABLE"; }

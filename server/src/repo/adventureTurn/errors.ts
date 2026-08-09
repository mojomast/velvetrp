/** The principal lacks current campaign or actor authority. */
export class AdventureTurnAuthorizationError extends Error { readonly code = "ADVENTURE_TURN_AUTHORIZATION"; }
/** A requested turn, proposal, draft, or receipt is unavailable in scope. */
export class AdventureTurnUnavailableError extends Error { readonly code = "ADVENTURE_TURN_UNAVAILABLE"; }
/** An optimistic turn, draft, campaign, or timeline revision is stale. */
export class AdventureTurnStaleError extends Error { readonly code = "ADVENTURE_TURN_STALE"; }
/** An idempotency identity or lifecycle transition conflicts with durable state. */
export class AdventureTurnConflictError extends Error { readonly code = "ADVENTURE_TURN_CONFLICT"; }
/** A confirmation or review decision arrived after its durable expiry. */
export class AdventureTurnExpiredError extends Error { readonly code = "ADVENTURE_TURN_EXPIRED"; }

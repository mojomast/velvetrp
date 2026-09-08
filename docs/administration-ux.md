# Administration UX integration contracts

The client panels in `client/src/components/rpg/administration/` are integrated boundaries hosted by `CampaignAdministrationPage`. They import neither `api.ts` nor server contracts. The host loads `GET /api/rpg/v1/campaigns/:campaignId/administration-integrations`, supplies role-filtered authoritative projections, and implements explicit command callbacks. A callback runs only after review and confirmation; the panels never automatically retry, migrate, associate, configure, or persist.

The consolidated aggregate GET and five command POST routes documented in `docs/api.md` are implemented. The older route sketches below describe domain intent, not additional implemented endpoints.

## Shared command behavior

Every write route must authenticate campaign membership, enforce the role listed below on the server, accept an `expectedRevision` and idempotency key, and return a campaign-bound receipt with the idempotency key, revision before/after, and occurrence time. A reused key with a different payload must conflict. Reads used for reconciliation must be side-effect free. The integrating container owns idempotency-key creation and maps request lifecycle to `AdministrationMutationState`; the panels intentionally do not manufacture transport commands.

An unavailable response or a transport interruption is ambiguous, not proof of failure. The container must set the relevant mutation state to `uncertain`, lock duplicate writes, and wire the panel's reconcile callback to an authoritative GET. Reconciliation must never replay the write.

No endpoint or client cache may expose or persist provider prompts, credentials, hidden NPC goals, private safety submissions beyond the authorized projection, or other campaign secrets. In particular, generation recovery must not use `localStorage`, `sessionStorage`, IndexedDB, URL state, or service-worker caches.

## Vendor and shop administration

Projection: `GET /api/rpg/v1/campaigns/:campaignId/vendor-administration`

The owner/GM projection needs campaign revision, existing NPCs (`npcId`, display name), existing shops (`shopId`, display name), their stock (`stockId`, safe label), current NPC-shop associations with revision, and current stock buy policies with integer `payoutUnitMinor` and revision. Player responses must be omitted or safely read-only. Private NPC fields and hidden stock data are not required by the panel.

Commands:

- `PUT /api/rpg/v1/campaigns/:campaignId/vendors/:npcId/shop` with `shopId`, `expectedRevision`, and `idempotencyKey`; owner or GM only.
- `PUT /api/rpg/v1/campaigns/:campaignId/shops/:shopId/stock/:stockId/buy-policy` with non-negative safe-integer `payoutUnitMinor`, `expectedRevision`, and `idempotencyKey`; owner or GM only.

Both commands must verify same-campaign identity. Association must reject conflicting reassociation rather than guessing. Policy setup must verify that the exact stock belongs to the exact shop. Zero means gifts are accepted; a positive value is the payout per unit. Commerce execution still revalidates location, presence, inventory, equipment, wallet, stock, and policy atomically.

Integration props: `VendorShopAdministrationPanelProps`, including `associateVendor`, `configureBuyPolicy`, `reconcileAssociation`, and `reconcileBuyPolicy`.

## Ruleset identity and migration

Projection: `GET /api/rpg/v1/campaigns/:campaignId/rulesets`

The response needs the exact current and selectable identities: `rulesetId`, semantic/display version, immutable digest, safe name, capability IDs with support status and detail, and an authoritative migration classification of `none`, `compatible`, `destructive`, or `unknown`. Migration summaries must describe impact without exposing hidden records.

Command: `PUT /api/rpg/v1/campaigns/:campaignId/ruleset` with exact `rulesetId`, `version`, `digest`, `expectedRevision`, and `idempotencyKey`; owner only.

The server must bind identity to digest, recompute compatibility against campaign content and existing mechanics, and reject stale or unsupported selections. `unknown` is a warning state, not permission for the server to guess a migration. If migration is a separate operation, selection must return a reviewable plan and require a second explicit command; it must never migrate as a side effect of the projection GET.

Integration props: `RulesetAdministrationPanelProps`, including `selectRuleset` and `reconcileSelection`.

## Durable generation recovery

Projection: `GET /api/rpg/v1/campaigns/:campaignId/generation-recovery`

The owner/GM projection needs durable jobs (`jobId`, state, attempt, request digest, update time, optional resulting `draftId`) and durable drafts (`draftId`, `jobId`, state, revision, creation time, artifact count). Recovery metadata must omit the prompt, campaign brief, exclusions, provider payload, credentials, hidden candidate content, and private goals. Full candidate content should be obtained only through the existing authorized exact-draft read when the user chooses **Open durable draft**.

Actions:

- Reconcile uses a side-effect-free exact job GET, such as `GET /api/rpg/v1/campaigns/:campaignId/generation-jobs/:jobId`.
- Opening a draft uses the existing authorized draft GET by `draftId`.
- Retrying a terminal failure uses the existing generation command with durable logical job identity, exact `requestDigest`, and `retryFailedAttempt.failedAttempt`. The server must reject a stale attempt acknowledgement or digest mismatch.

Running and uncertain jobs are reconciled, never retried. Reload merely fetches and renders this projection; it does not initiate provider work. Paid retry is intentionally excluded from the recovery panel because redacted metadata cannot safely reconstruct the exact private generation request; users can open an exact durable draft or start a separately reviewed request.

Integration props: `GenerationRecoveryPanelProps`, including `openDraft`, `reconcileJob`, and `retryFailedJob`.

## Session-zero safety

Projection: `GET /api/rpg/v1/campaigns/:campaignId/safety-settings`

The authorized projection needs revision, up to 32 hard limits and 32 veils of at most 200 characters each, plus PvP, romance, and lethality policies. Owners and GMs may edit. Players need the agreed policy projection unless campaign privacy rules provide a redacted equivalent. Safety content must not be written to browser storage, analytics, logs, URLs, or provider prompts by the integrating client.

The consolidated safety command accepts complete settings, `expectedRevision`, and `idempotencyKey`; owner or GM only. It conservatively merges one revision-bound agreement and returns a receipt. Hard limits and veils are retained as a union, and policy enums can only become more restrictive.

Low-friction controls must be available to every campaign member and remain separate from administration authorization:

- `POST /api/rpg/v1/campaigns/:campaignId/safety-actions/pause`
- `POST /api/rpg/v1/campaigns/:campaignId/safety-actions/skip`
- `POST /api/rpg/v1/campaigns/:campaignId/safety-actions/rewind`

These commands require no reason or private text. They should return a minimal acknowledgement, notify the active session through the existing event/stream mechanism, and avoid revealing which member invoked the action unless an explicitly agreed policy requires attribution. Pause/skip/rewind remain visible even when settings are read-only; only an independently supplied transport/session-disabled state disables them.

Integration props: `SessionZeroSafetyPanelProps`, including `updateSettings`, `reconcileSettings`, `pause`, `skip`, and `rewind`.

## Container integration

The eventual administration container should fetch each projection, translate the authenticated campaign role to `AdministrationRole`, and pass stable callback objects where practical. After a confirmed receipt it should refresh the matching authoritative projection. After an ambiguous response it should preserve the pending command outside these panels, set `phase: "uncertain"`, and await explicit reconciliation. It must not infer success from optimistic local state.

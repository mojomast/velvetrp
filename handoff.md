# Handoff

## Session 4 — Orchestration Analysis

### Scope
- Analyzed `server/src/repo/campaignRepositoryOrchestration.ts` as the repository composition root. No source code was changed and no commit was created.

### Composition Surface
- `createRepository(options: CreateRepositoryOptions = {}): Repository` is the public factory. It resolves `dataDir`, opens and owns the SQLite connection, supplies omitted `clock`/`ids`/`rng` from `systemRuntime`, enforces synchronous unit-of-work callbacks, tracks transaction depth, guards use after `close()`, and returns the composed repository.
- The root directly imports/calls 34 campaign factories and operations. They group into campaign core/access; command, event, dice, and actor-resource; character write/read/roster/workspace/sheet/creation options; membership/session/room snapshots and lifecycle; content write/configuration/selection/definition/global reads; original-starter inspection; and legacy-core compatibility writes.
- `createCampaignActorOperations` is a local sub-composition for character creation options, roster, workspace, and sheet snapshots. `runTransaction` separately composes the transaction-scoped unit of work.
- It composes the campaign-administration factory (`createCampaignAdministrationRepository`) and domain factories for content catalog, character builder, character progression, actor resources, inventory, economy, rest, checks, powers, effects, encounters, world, and quests. Mutating domain facades receive open/transaction guards; administration, catalog, builder, progression, selected M1.5 repositories, and quests are additionally proxy-wrapped to guard all method calls.

### Contract Boundary
- `@velvet/contracts` runtime schemas used here: `addCampaignMembershipInputSchema`, `actorResourceNameSchema`, `actorResourceSchema`, `attachCampaignSessionInputSchema`, `campaignCharacterAttributeSchema`, `campaignCharacterClassSchema`, `campaignCharacterProficiencySchema`, `publicCampaignCharacterSummarySchema`, `publicCampaignActorSchema`, `campaignContentConfigurationSchema`, `campaignMembershipSchema`, `campaignRenameRequestSchema`, `campaignSessionAttachmentSchema`, `commandEnvelopeSchema`, `contentPackIdentifierSchema`, `contentPackSchema`, `configureCampaignContentInputSchema`, `createCampaignInputSchema`, `definitionReferenceSchema`, `detachCampaignSessionInputSchema`, `installContentPackInputSchema`, `renameCampaignInputSchema`, `resourceIdSchema`, `resolvedCharacterChoiceSchema`, `setActorAttributePayloadSchema`, and `utcIsoTimestampSchema`.
- Contract limits imported here: `MAX_CAMPAIGN_CHARACTER_PERSONAS`, `MAX_CAMPAIGN_CHARACTER_ROSTER`, `MAX_CAMPAIGN_CHARACTER_WORKSPACE_RESOURCES`, `MAX_CHARACTER_ATTRIBUTES`, `MAX_CHARACTER_CHOICES`, `MAX_CHARACTER_CLASSES`, and `MAX_CHARACTER_PROFICIENCIES`.
- Contract types imported here: `PublicCampaignCharacterSummary`, `CampaignCharacterWorkspaceResponse`, `CampaignRoomLinkingResponse`, and `ProgressionState`. Repository API types come from `campaign/campaignTypes.ts` and are re-exported through `campaign/index.ts`.

### Legacy Work Remaining
- Four inline legacy SQL helpers remain in the orchestration module: `installContentPackSync`, `configureCampaignContentSync`, `listCampaignContentPackDefinitionsSync`, and `getCampaignContentPackDefinitionSync`.
- These helpers carry validation, authorization, visibility-projection verification, and immediate-transaction behavior. They are used by the content-write and transaction composition paths, so extraction requires preserving their shared mapping/projection dependencies and snapshot semantics.

### Public Exports
- `server/src/repo/index.ts` publicly exports `createRepository` and `CreateRepositoryOptions` from `campaignRepositoryOrchestration.ts`.
- Campaign repository types, snapshots, original-starter inspection types, errors, and dice types are re-exported through the campaign/orchestration facade. Domain repository types, errors, and selected helpers remain re-exported from their domain facades.

### Recommendation
- Do not split Task 8 further now. The composition root has moderate circular-composition risk: campaign adapters depend on peer adapters, transaction-scoped construction mirrors root construction, and the root’s public facade preserves lifecycle and guard invariants. Further extraction should wait for a concrete boundary that can avoid reverse imports and duplicate wiring.

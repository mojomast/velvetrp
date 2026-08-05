import type { CampaignAdministration, CampaignDetail, CampaignCatalogResolutionReport } from "@velvet/contracts";
import {
  MECHANICS_STARTER_IDENTITY,
} from "@velvet/contracts";
import {
  ContentCatalogAuthorizationError,
  ContentCatalogConflictError,
  ContentCatalogStaleError,
  MECHANICS_STARTER_CATALOG,
  type Repository,
} from "../repo/index.js";

export const MECHANICS_STARTER_SETUP_IDEMPOTENCY_KEY = "mechanics-starter-setup-v1" as const;
const LOCAL_OWNER = "local-owner";

export class MechanicsStarterSetupUnavailableError extends Error {
  readonly code = "MECHANICS_STARTER_SETUP_UNAVAILABLE";
  constructor() {
    super("campaign mechanics starter setup is unavailable");
    this.name = "MechanicsStarterSetupUnavailableError";
  }
}

export class MechanicsStarterSetupConflictError extends Error {
  readonly code = "MECHANICS_STARTER_SETUP_CONFLICT";
  constructor() {
    super("campaign mechanics starter setup conflicts with current state");
    this.name = "MechanicsStarterSetupConflictError";
  }
}

export interface MechanicsStarterSetupRepository {
  transaction<T>(callback: (snapshot: MechanicsStarterSetupSnapshotRepository) => T): T;
  installMechanicsStarterCatalog: Repository["installMechanicsStarterCatalog"];
  configureMechanicsStarterCatalog: Repository["configureMechanicsStarterCatalog"];
}

export interface MechanicsStarterSetupSnapshotRepository {
  getCampaignDetail(actorPrincipalId: string, campaignId: string): CampaignDetail | null;
  getCampaignAdministration(actorPrincipalId: string, campaignId: string): CampaignAdministration | null;
  resolveCampaignCatalog(actorPrincipalId: string, campaignId: string): CampaignCatalogResolutionReport | null;
}

type SetupState =
  | { status: "unavailable" }
  | { status: "conflict" }
  | { status: "exact"; campaign: CampaignDetail }
  | { status: "unconfigured"; campaign: CampaignDetail; administrationRevision: number };

function hasExactDetailIdentity(campaign: CampaignDetail): boolean {
  return campaign.content.status === "configured"
    && campaign.content.rulesProfileId === MECHANICS_STARTER_IDENTITY.rulesProfileId
    && campaign.content.contentPacks.length === 1
    && campaign.content.contentPacks[0]?.packId === MECHANICS_STARTER_IDENTITY.packId
    && campaign.content.contentPacks[0]?.packVersion === MECHANICS_STARTER_IDENTITY.packVersion;
}

/**
 * Classifies only authoritative repository reads. A legacy lookalike is not an
 * active mechanics catalog: the validated catalog resolution and digest must
 * also bind exactly to the campaign and fixed publication.
 */
function inspectSnapshot(repository: MechanicsStarterSetupSnapshotRepository, campaignId: string): SetupState {
  const campaign = repository.getCampaignDetail(LOCAL_OWNER, campaignId);
  if (!campaign || campaign.actorRole !== "owner") return { status: "unavailable" };
  if (campaign.content.status === "configured") {
    if (!hasExactDetailIdentity(campaign)) return { status: "conflict" };
    const resolved = repository.resolveCampaignCatalog(LOCAL_OWNER, campaignId);
    if (!resolved
      || resolved.campaignId !== campaignId
      || !resolved.compatible
      || resolved.issues.length !== 0
      || resolved.rulesProfileId !== MECHANICS_STARTER_IDENTITY.rulesProfileId
      || resolved.contentPacks.length !== 1
      || resolved.contentPacks[0]?.packId !== MECHANICS_STARTER_IDENTITY.packId
      || resolved.contentPacks[0]?.packVersion !== MECHANICS_STARTER_IDENTITY.packVersion
      || resolved.contentPacks[0]?.digest !== MECHANICS_STARTER_CATALOG.manifest.digest) {
      return { status: "conflict" };
    }
    return { status: "exact", campaign };
  }

  // An unconfigured detail must not hide a modern selection sidecar.
  if (repository.resolveCampaignCatalog(LOCAL_OWNER, campaignId) !== null) return { status: "conflict" };
  const administration = repository.getCampaignAdministration(LOCAL_OWNER, campaignId);
  if (!administration || administration.id !== campaignId || administration.actorRole !== "owner") {
    return { status: "unavailable" };
  }
  return { status: "unconfigured", campaign, administrationRevision: administration.revision };
}

function inspect(repository: MechanicsStarterSetupRepository, campaignId: string): SetupState {
  // Each classification is one short read transaction. It ends before either
  // publication/configuration transaction and a fresh one proves final state.
  return repository.transaction((snapshot) => inspectSnapshot(snapshot, campaignId));
}

function finish(state: SetupState): CampaignDetail {
  if (state.status === "exact") return state.campaign;
  if (state.status === "unavailable") throw new MechanicsStarterSetupUnavailableError();
  throw new MechanicsStarterSetupConflictError();
}

export interface MechanicsStarterSetupService {
  setup(campaignId: string): CampaignDetail;
}

/**
 * The catalog publication and campaign configuration deliberately remain two
 * repository transactions. The service owns the observed revision and fixed
 * idempotency key, performs no retry, and always verifies final state after an
 * issued write sequence (including typed repository failures).
 */
export function createMechanicsStarterSetupService(
  repository: MechanicsStarterSetupRepository,
): MechanicsStarterSetupService {
  return {
    setup(campaignId) {
      const before = inspect(repository, campaignId);
      if (before.status !== "unconfigured") return finish(before);

      let failure: unknown;
      try {
        repository.installMechanicsStarterCatalog(LOCAL_OWNER);
        repository.configureMechanicsStarterCatalog(LOCAL_OWNER, campaignId, {
          expectedRevision: before.administrationRevision,
          idempotencyKey: MECHANICS_STARTER_SETUP_IDEMPOTENCY_KEY,
        });
      } catch (error) {
        failure = error;
      }

      const after = inspect(repository, campaignId);
      if (after.status === "exact") return after.campaign;
      if (after.status === "unavailable") throw new MechanicsStarterSetupUnavailableError();
      if (after.status === "conflict") throw new MechanicsStarterSetupConflictError();
      if (failure instanceof ContentCatalogAuthorizationError) {
        throw new MechanicsStarterSetupUnavailableError();
      }
      if (failure instanceof ContentCatalogConflictError || failure instanceof ContentCatalogStaleError) {
        throw new MechanicsStarterSetupConflictError();
      }
      if (failure !== undefined) throw failure;
      throw new MechanicsStarterSetupConflictError();
    },
  };
}

import type { CampaignDetail } from "@velvet/contracts";
import type {
  OriginalStarterSetupInspection,
  Repository,
} from "../repo/index.js";
import {
  CampaignContentConfigurationAuthorizationError,
  CampaignContentConfigurationConflictError,
  ContentPackInstallationAuthorizationError,
  ContentPackInstallationConflictError,
} from "../repo/index.js";

export class OriginalStarterSetupUnavailableError extends Error {
  readonly code = "ORIGINAL_STARTER_SETUP_UNAVAILABLE";
  constructor() {
    super("campaign starter setup is unavailable");
    this.name = "OriginalStarterSetupUnavailableError";
  }
}

export class OriginalStarterSetupConflictError extends Error {
  readonly code = "ORIGINAL_STARTER_SETUP_CONFLICT";
  constructor() {
    super("campaign starter setup conflicts with current state");
    this.name = "OriginalStarterSetupConflictError";
  }
}

export interface OriginalStarterSetupRepository {
  inspectOriginalStarterSetup(actorPrincipalId: string, campaignId: string): OriginalStarterSetupInspection;
  installOriginalStarterContent: Repository["installOriginalStarterContent"];
  configureOriginalStarterContent: Repository["configureOriginalStarterContent"];
}

export interface OriginalStarterSetupService {
  setup(campaignId: string): CampaignDetail;
}

const LOCAL_OWNER = "local-owner";

function classifyInspection(inspection: OriginalStarterSetupInspection): CampaignDetail | null {
  if (inspection.status === "unavailable") throw new OriginalStarterSetupUnavailableError();
  if (inspection.status === "conflict") throw new OriginalStarterSetupConflictError();
  if (inspection.status === "exact") return inspection.campaign;
  return null;
}

/**
 * Factory-only operation: callers cannot supply identity, manifest, profile or
 * pack. Installation and configuration intentionally remain two convergent
 * repository transactions rather than pretending to be atomic.
 */
export function createOriginalStarterSetupService(
  repository: OriginalStarterSetupRepository,
): OriginalStarterSetupService {
  return {
    setup(campaignId) {
      const existing = classifyInspection(repository.inspectOriginalStarterSetup(LOCAL_OWNER, campaignId));
      if (existing) return existing;

      try {
        repository.installOriginalStarterContent(LOCAL_OWNER, campaignId);
        repository.configureOriginalStarterContent(LOCAL_OWNER, campaignId);
      } catch (error) {
        if (error instanceof ContentPackInstallationAuthorizationError
          || error instanceof CampaignContentConfigurationAuthorizationError) {
          throw new OriginalStarterSetupUnavailableError();
        }
        if (error instanceof ContentPackInstallationConflictError
          || error instanceof CampaignContentConfigurationConflictError) {
          throw new OriginalStarterSetupConflictError();
        }
        throw error;
      }

      // Authoritative post-write proof also catches ownership/configuration or
      // reserved-identity races. There is deliberately no hidden retry.
      const completed = classifyInspection(repository.inspectOriginalStarterSetup(LOCAL_OWNER, campaignId));
      if (!completed) throw new OriginalStarterSetupConflictError();
      return completed;
    },
  };
}

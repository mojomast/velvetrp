import type DatabaseDriver from "better-sqlite3";
import type {
  CampaignCatalogConfigurationResult,
  CampaignCatalogReceipt,
  CampaignCatalogResolutionReport,
  CatalogValidationReport,
  ConfigureCampaignCatalogInput,
  GmCatalogProjection,
  ObserverCatalogProjection,
  OwnerCatalogProjection,
  PlayerCatalogProjection,
  PublicationSummary,
} from "@velvet/contracts";
import type { Clock } from "../runtime.js";
import {
  canonicalCatalogJson,
  dependencies,
  validateContentCatalog,
} from "./contentCatalog/catalogValidation.js";
import {
  createCatalogReadRepository,
  type ContentCatalogPublicationPage,
  type ContentCatalogPublicationPageInput,
} from "./contentCatalog/catalogReadRepo.js";
import {
  ContentCatalogAuthorizationError,
  ContentCatalogConflictError,
  ContentCatalogStaleError,
  ContentCatalogValidationError,
  createCatalogWriteRepository,
} from "./contentCatalog/catalogWriteRepo.js";
import {
  deriveCatalogVisibility,
  verifyCatalogVisibilityProjection,
} from "./contentCatalog/catalogVisibility.js";

export {
  ContentCatalogAuthorizationError,
  ContentCatalogConflictError,
  ContentCatalogStaleError,
  ContentCatalogValidationError,
} from "./contentCatalog/catalogWriteRepo.js";
export type {
  ContentCatalogPublicationPage,
  ContentCatalogPublicationPageInput,
} from "./contentCatalog/catalogReadRepo.js";

/** The public content-catalog repository operations composed from read/write factories. */
export interface ContentCatalogRepository {
  validateContentCatalog(input: unknown): CatalogValidationReport;
  publishContentCatalog(actorPrincipalId: string, input: unknown): OwnerCatalogProjection;
  listContentCatalogPublications(actorPrincipalId: string): PublicationSummary[];
  listContentCatalogPublicationPage(actorPrincipalId: string, input: ContentCatalogPublicationPageInput): ContentCatalogPublicationPage;
  getContentCatalogForOwner(actorPrincipalId: string, packId: string, packVersion: string): OwnerCatalogProjection | null;
  getCampaignContentCatalog(actorPrincipalId: string, campaignId: string, packId: string, packVersion: string): GmCatalogProjection | PlayerCatalogProjection | ObserverCatalogProjection | null;
  configureCampaignCatalog(actorPrincipalId: string, campaignId: string, input: ConfigureCampaignCatalogInput): CampaignCatalogConfigurationResult;
  resolveCampaignCatalog(actorPrincipalId: string, campaignId: string): CampaignCatalogResolutionReport | null;
  getCampaignCatalogReceipt(actorPrincipalId: string, campaignId: string, commandId: string): CampaignCatalogReceipt | null;
}

/** Builds the guarded public facade over catalog read and write repositories. */
export function createContentCatalogRepository(
  db: DatabaseDriver.Database,
  clock: Clock,
  mutationGuard: () => void,
): ContentCatalogRepository {
  const reads = createCatalogReadRepository(db, {
    canonicalCatalogJson,
    validateContentCatalog,
    verifyCatalogVisibilityProjection,
  });
  const writes = createCatalogWriteRepository(db, {
    clock,
    canonicalCatalogJson,
    validateContentCatalog,
    verifyCatalogVisibilityProjection,
    deriveCatalogVisibility,
    dependencies,
  });
  return {
    validateContentCatalog,
    publishContentCatalog: (actor, input) => { mutationGuard(); return writes.publishContentCatalog(actor, input); },
    listContentCatalogPublications: reads.listContentCatalogPublications,
    listContentCatalogPublicationPage: reads.listContentCatalogPublicationPage,
    getContentCatalogForOwner: reads.getContentCatalogForOwner,
    getCampaignContentCatalog: reads.getCampaignContentCatalog,
    configureCampaignCatalog: (actor, campaignId, input) => { mutationGuard(); return writes.configureCampaignCatalog(actor, campaignId, input); },
    resolveCampaignCatalog: reads.resolveCampaignCatalog,
    getCampaignCatalogReceipt: reads.getCampaignCatalogReceipt,
  };
}

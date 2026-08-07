/** Internal content-catalog repository modules. */
export {
  calculateCatalogDigest,
  canonicalCatalogJson,
  dependencies,
  validateContentCatalog,
} from "./catalogValidation.js";
export {
  deriveCatalogVisibility,
  verifyCatalogVisibilityProjection,
  type PersistedCatalogVisibilityRow,
} from "./catalogVisibility.js";
export {
  createCatalogReadRepository,
  type ContentCatalogPublicationPage,
  type ContentCatalogPublicationPageInput,
} from "./catalogReadRepo.js";
export {
  ContentCatalogAuthorizationError,
  ContentCatalogConflictError,
  ContentCatalogStaleError,
  ContentCatalogValidationError,
  createCatalogWriteRepository,
  type CatalogWriteDependencies,
} from "./catalogWriteRepo.js";
// The facade owns this public interface; re-export it so catalog consumers use
// this package boundary for its errors, helpers, and repository type.
export type { ContentCatalogRepository } from "../contentCatalogRepo.js";

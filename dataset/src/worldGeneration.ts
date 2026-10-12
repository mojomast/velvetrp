/**
 * Family C and Family D validation adapters.
 *
 * FAMILY C (tool selection)
 * -------------------------
 * `parseAdventureToolArguments` only proves a call matches the STATIC argument
 * schema. It does not prove the candidate id/digest pair was advertised FOR THIS
 * DECISION. Harvesting only final receipts therefore miscredits server-side
 * recovery — a deterministic journey, a hold-and-fallback, or a resubmitted
 * proposal — to the teacher.
 *
 * This module separates four distinct facts that production reports independently:
 *   1. transport validity   (schema parsed)
 *   2. advertised binding   (the pair was in this decision's menu)
 *   3. confirmation outcome (proposed / approved / rejected / committed)
 *   4. final turn outcome   (what actually settled)
 *
 * FAMILY D (world generation)
 * ---------------------------
 * The global provider schema checks object shape only. Production's real chain is
 * section-specific and sparse:
 *   requestedCampaignContentProviderSchema(sections, desiredCounts)
 *   -> normalizeGeneratedCampaignContentProvider
 *   -> validateContent(content, sections, dependencies, catalogReferences, desiredCounts, dependencyKinds)
 *
 * "16 sections" is 14 enum values mapped onto 16 output arrays. Training all 16
 * arrays for every request would misrepresent the contract.
 */

import { generatedCampaignContentProviderSchema, campaignGenerationSectionFields, campaignGenerationSectionSchema } from "@velvet/contracts";
import type { GeneratedCampaignContentProvider } from "@velvet/contracts";
import {
  validateContent,
  requestedCampaignContentProviderSchema,
  sanitizeGeneratedCampaignContent,
} from "../../server/src/routes/rpg/v1/campaignContentGeneration.js";
import type { CanonicalDependency, CatalogIdentity } from "./worldGenerationTypes.js";

export const FAMILY_C_VALIDATOR_VERSION = "family-c-advertised-binding-v1";
export const FAMILY_D_VALIDATOR_VERSION = "family-d-section-chain-v1";

export class FamilyValidationError extends Error {
  readonly problems: readonly string[];
  readonly repaired: boolean;
  constructor(problems: readonly string[], repaired = false) {
    super(`${repaired ? "sanitized" : "invalid"} world generation: ${problems.join("; ")}`);
    this.name = "FamilyValidationError";
    this.problems = problems;
    this.repaired = repaired;
  }
}

// ---------------------------------------------------------------------------
// Family C: advertised-candidate binding
// ---------------------------------------------------------------------------

/** One candidate the server actually offered for this decision. */
export interface AdvertisedCandidate {
  candidateId: string;
  digest: string;
  toolName: string;
  /** The server-issued human label. Never authored by a teacher. */
  label?: string | undefined;
}

/** What production recorded for the provider's selection. */
export interface ProviderSelection {
  toolName: string;
  candidateId: string;
  digest: string;
  /** Transport validity: the arguments parsed against the static schema. */
  transportValid: boolean;
  /** The confirmation lifecycle for a mutation proposal. */
  confirmationStatus?: "not-required" | "pending" | "approved" | "rejected" | "expired" | undefined;
  /** True when the server, not the teacher, produced the final settlement. */
  serverRecovered?: boolean | undefined;
  /** The final turn outcome as distinct from the teacher's choice. */
  finalOutcome: "mechanics-committed" | "awaiting-confirmation" | "fallback" | "held" | "unknown";
}

export interface SelectionVerdict {
  /** The candidate pair was in the menu the provider was shown. */
  advertised: boolean;
  /** The tool was among the tools the provider was shown. */
  toolAdvertised: boolean;
  problems: string[];
}

const hex64 = /^[0-9a-f]{64}$/;

/** Order-insensitive for object keys, order-SENSITIVE for arrays (order is meaningful). */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) return false;
    return keysA.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Validates a teacher selection against the menu the provider ACTUALLY saw.
 *
 * Refuses an unadvertised pair, a digest that is not a 64-hex, and a selection
 * whose final settlement came from server recovery rather than the teacher.
 */
export function validateAdvertisedSelection(
  selection: ProviderSelection,
  advertisedCandidates: readonly AdvertisedCandidate[],
  advertisedToolNames: readonly string[],
): SelectionVerdict {
  const problems: string[] = [];
  const toolAdvertised = advertisedToolNames.includes(selection.toolName);
  if (!toolAdvertised) problems.push(`tool "${selection.toolName}" was not advertised for this decision`);

  const match = advertisedCandidates.find(
    (candidate) => candidate.toolName === selection.toolName && candidate.candidateId === selection.candidateId,
  );
  const advertised = Boolean(match);
  if (!match) {
    problems.push(`candidate "${selection.candidateId}" for tool "${selection.toolName}" was not advertised`);
  } else if (match.digest !== selection.digest) {
    // A right id with a wrong digest is exactly the tamper case production rejects.
    problems.push(`digest mismatch for candidate "${selection.candidateId}": advertised ${match.digest.slice(0, 12)}…, selected ${selection.digest.slice(0, 12)}…`);
  }
  if (!hex64.test(selection.digest)) problems.push(`digest "${selection.digest}" is not a 64-hex sha256`);

  if (!selection.transportValid) problems.push("tool arguments did not parse against the advertised schema");
  if (selection.serverRecovered === true) {
    problems.push(`final settlement came from server recovery, not the teacher (${selection.finalOutcome}); it cannot be credited as a teacher success`);
  }

  return { advertised, toolAdvertised, problems };
}

/** First-attempt selection is scored separately from the final turn outcome. */
export interface FamilyCScorecard {
  firstAttemptAdvertised: boolean;
  firstAttemptTransportValid: boolean;
  confirmationRequired: boolean;
  confirmationApproved: boolean;
  serverRecovered: boolean;
  finalOutcome: ProviderSelection["finalOutcome"];
  /** True when the teacher's own selection produced the settlement. */
  teacherAuthoredOutcome: boolean;
}

export function scoreSelection(selection: ProviderSelection, verdict: SelectionVerdict): FamilyCScorecard {
  const teacherAuthoredOutcome =
    verdict.advertised && selection.transportValid && selection.serverRecovered !== true
    && (selection.finalOutcome === "mechanics-committed"
      || (selection.confirmationStatus === "approved" && selection.finalOutcome !== "unknown"));
  return {
    firstAttemptAdvertised: verdict.advertised,
    firstAttemptTransportValid: selection.transportValid,
    confirmationRequired: selection.confirmationStatus === "pending" || selection.confirmationStatus === "approved",
    confirmationApproved: selection.confirmationStatus === "approved",
    serverRecovered: selection.serverRecovered === true,
    finalOutcome: selection.finalOutcome,
    teacherAuthoredOutcome,
  };
}

// ---------------------------------------------------------------------------
// Family D: section-specific world generation
// ---------------------------------------------------------------------------

export const WORLD_GENERATION_SECTIONS = campaignGenerationSectionSchema.options;
export const WORLD_GENERATION_FIELDS = Object.keys(generatedCampaignContentProviderSchema.shape).filter(
  (field) => field !== "kind",
) as Array<keyof GeneratedCampaignContentProvider>;

/** Fields produced by the union of the requested sections. */
export function fieldsForSections(sections: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const section of sections) {
    const fields = campaignGenerationSectionFields[section as keyof typeof campaignGenerationSectionFields];
    if (!fields) throw new FamilyValidationError([`unknown generation section "${section}"`]);
    for (const field of fields) out.add(field);
  }
  return out;
}

/**
 * Detects whether any field the teacher WROTE was dropped.
 *
 * Naive diffing is wrong in both directions. Schema defaulting ADDS fields the
 * teacher never wrote (`factionKeys: []`), which is benign and always happens.
 * What matters for training honesty is LOSS: a dangling reference the model
 * emitted being silently stripped, so the admitted example differs from what the
 * teacher actually produced.
 */
function droppedWrittenFields(raw: unknown, result: GeneratedCampaignContentProvider): string[] {
  const dropped: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return dropped;
  const rawRecord = raw as Record<string, unknown>;
  for (const [field, value] of Object.entries(rawRecord)) {
    if (!Array.isArray(value) || !(field in result)) continue;
    const produced = (result as unknown as Record<string, unknown>)[field];
    if (!Array.isArray(produced)) continue;
    value.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      const counterpart = produced[index];
      if (!counterpart || typeof counterpart !== "object") {
        dropped.push(`${field}[${index}] was removed entirely`);
        return;
      }
      const source = item as Record<string, unknown>;
      const target = counterpart as Record<string, unknown>;
      for (const [key, written] of Object.entries(source)) {
        if (written === undefined) continue;
        if (!(key in target) || (Array.isArray(written) && written.length > 0 && (!Array.isArray(target[key]) || (target[key] as unknown[]).length === 0))) {
          dropped.push(`${field}[${index}].${key} was dropped`);
        }
      }
    });
  }
  return dropped;
}

/**
 * The real production validation chain.
 *
 * `requestedCampaignContentProviderSchema` enforces section-specific sparsity:
 * arrays outside the requested sections must be EMPTY. `validateContent` then
 * enforces typed reference closure, catalog pinning, dependency visibility and
 * directed reachability.
 *
 * A repair (sanitization) is recorded as a repair with its own target, never
 * reported as if the raw output had been valid.
 */
export interface WorldGenerationVerdict {
  ok: boolean;
  /** True when sanitization changed the output, so the example is a repair. */
  sanitized: boolean;
  content: GeneratedCampaignContentProvider | null;
  problems: string[];
  requestedSections: string[];
  producedFields: string[];
}

export function validateWorldGeneration(input: {
  raw: unknown;
  sections: readonly string[];
  dependencies: Map<string, CanonicalDependency>;
  catalogReferences: readonly CatalogIdentity[];
  desiredCounts?: Record<string, number> | undefined;
  /** Mirrors production's `tolerateInvalidReferences`: sanitize before validate. */
  tolerateInvalidReferences?: boolean | undefined;
  /** When false, a repair is a failure rather than an admitted example. */
  allowRepair?: boolean | undefined;
}): WorldGenerationVerdict {
  const problems: string[] = [];
  let parsedRaw: unknown;
  try {
    // Enforces the sparse, section-specific shape before any semantic work.
    const sparse = requestedCampaignContentProviderSchema([...input.sections], input.desiredCounts ?? {});
    parsedRaw = (sparse as { parse: (value: unknown) => unknown }).parse(input.raw);
  } catch (error) {
    return {
      ok: false, sanitized: false, content: null,
      problems: [`output does not match the requested-section schema: ${error instanceof Error ? error.message : String(error)}`],
      requestedSections: [...input.sections], producedFields: [],
    };
  }

  const allowedFields = fieldsForSections(input.sections);
  const producedFields = WORLD_GENERATION_FIELDS.filter(
    (field) => Array.isArray((parsedRaw as Record<string, unknown>)[field])
      && ((parsedRaw as Record<string, unknown>)[field] as unknown[]).length > 0,
  );
  for (const field of producedFields) {
    if (!allowedFields.has(field)) {
      problems.push(`field "${field}" is not part of the requested sections [${input.sections.join(", ")}]`);
    }
  }
  if (producedFields.length === 0) problems.push("the candidate produced no content for any requested section");

  let content: GeneratedCampaignContentProvider | null = null;
  let sanitized = false;
  let droppedFields: string[] = [];
  try {
    const base = generatedCampaignContentProviderSchema.parse(parsedRaw);
    const dependencyKinds = new Map<string, string>();
    for (const [key, value] of input.dependencies) dependencyKinds.set(key, value.kind);
    const visibility = new Map([...input.dependencies].map(([key, value]) => [key, value.visibility] as const));
    const catalogReferences = new Set(input.catalogReferences.map((identity) => identity.referenceIdentity));

    // Production sanitizes ONLY when the caller opts into tolerating invalid
    // references, and it happens BEFORE validation. Mirroring that order matters:
    // without sanitization a dangling reference makes `validateContent` throw,
    // which is a REJECTION, not a repair.
    const candidate = input.tolerateInvalidReferences
      ? sanitizeGeneratedCampaignContent(base, visibility, catalogReferences, dependencyKinds)
      : base;
    // A "repair" means a field the teacher WROTE was dropped. Schema defaulting
    // (adding `factionKeys: []`) is benign and must not count.
    droppedFields = [...droppedWrittenFields(input.raw, base), ...droppedWrittenFields(candidate, candidate)];
    sanitized = droppedFields.length > 0;

    const validated = validateContent(
      candidate,
      [...input.sections],
      visibility,
      catalogReferences,
      input.desiredCounts ?? {},
      dependencyKinds,
    );
    content = validated;
    if (sanitized) {
      // A sanitized candidate is a REPAIR and needs its own training target;
      // the raw model output was not valid.
      if (input.allowRepair !== true) {
        problems.push("sanitization changed the output; this is a repair and needs its own target");
      } else {
        problems.push("sanitized: unresolvable or unauthorized references were dropped");
      }
    }
  } catch (error) {
    problems.push(`semantic validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    // A repair is admissible only when repairs are explicitly allowed; the
    // admission gate still requires the repair to carry its own target.
    ok: problems.length === 0 || (sanitized && input.allowRepair === true && problems.every((problem) => /^sanitized/.test(problem))),
    sanitized,
    content: content ?? null,
    problems,
    requestedSections: [...input.sections],
    producedFields,
  };
}
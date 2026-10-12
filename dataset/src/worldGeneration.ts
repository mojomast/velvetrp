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

import { createHash } from "node:crypto";
import { generatedCampaignContentProviderSchema, campaignGenerationSectionFields, campaignGenerationSectionSchema } from "@velvet/contracts";
import type { GeneratedCampaignContentProvider } from "@velvet/contracts";
import {
  validateContent,
  requestedCampaignContentProviderSchema,
  sanitizeGeneratedCampaignContent,
} from "../../server/src/routes/rpg/v1/campaignContentGeneration.js";
import type { CanonicalDependency, CatalogIdentity } from "./worldGenerationTypes.js";

export const FAMILY_C_VALIDATOR_VERSION = "family-c-advertised-binding-v2";
export const FAMILY_D_VALIDATOR_VERSION = "family-d-section-chain-v2";

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

interface SelectionMetadata {
  /** Transport validity: the arguments parsed against the static schema. */
  transportValid: boolean;
  /** Scenario-oracle judgment, when available. Membership never supplies it. */
  intentCorrect?: boolean;
  /** The confirmation lifecycle for a mutation proposal. */
  confirmationStatus?: "not-required" | "pending" | "approved" | "rejected" | "expired" | undefined;
  /** True when the server, not the teacher, produced the final settlement. */
  serverRecovered?: boolean | undefined;
  /** The final turn outcome as distinct from the teacher's choice. */
  finalOutcome: "mechanics-committed" | "awaiting-confirmation" | "fallback" | "held" | "unknown"
    | "narration-submitted" | "read-completed" | "clarified" | "no-tool";
}

/** The provider's actual decision contract, including legitimate non-mutations. */
export type ProviderDecision = SelectionMetadata & (
  | { contract: "exact-candidate"; toolName: string; candidateId: string; digest: string }
  | { contract: "narration-submit"; toolName: string; arguments: { narration: string } }
  | { contract: "read-tool"; toolName: string; arguments: Readonly<Record<string, unknown>> }
  | { contract: "clarify"; message: string; toolName?: never }
  | { contract: "no-tool"; content?: string; toolName?: never }
);

/** Existing callers without a discriminator retain the exact-candidate contract. */
export type ProviderSelection = ProviderDecision | (SelectionMetadata & {
  contract?: never;
  toolName: string;
  candidateId: string;
  digest: string;
});

export interface SelectionVerdict {
  /** The candidate pair was in the menu the provider was shown. */
  advertised: boolean;
  /** The tool was among the tools the provider was shown. */
  toolAdvertised: boolean;
  /** True only for a valid 64-hex digest matching this candidate and tool. */
  digestMatched: boolean;
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
  const callsTool = selection.contract !== "clarify" && selection.contract !== "no-tool";
  const toolAdvertised = callsTool && advertisedToolNames.includes(selection.toolName);
  if (callsTool && !toolAdvertised) problems.push(`tool "${selection.toolName}" was not advertised for this decision`);
  let advertised = false;
  let digestMatched = false;

  if (selection.contract === undefined || selection.contract === "exact-candidate") {
    const match = advertisedCandidates.find(
      (candidate) => candidate.toolName === selection.toolName && candidate.candidateId === selection.candidateId,
    );
    digestMatched = Boolean(match && match.digest === selection.digest && hex64.test(selection.digest));
    advertised = digestMatched;
    if (!match) {
      problems.push(`candidate "${selection.candidateId}" for tool "${selection.toolName}" was not advertised`);
    } else if (match.digest !== selection.digest) {
      problems.push(`digest mismatch for candidate "${selection.candidateId}": advertised ${match.digest.slice(0, 12)}…, selected ${selection.digest.slice(0, 12)}…`);
    }
    if (!hex64.test(selection.digest)) problems.push(`digest "${selection.digest}" is not a 64-hex sha256`);
  } else if (selection.contract === "narration-submit") {
    if (selection.toolName !== "submit_adventure_narration") problems.push("narration-submit requires the narration submission tool");
    if (!selection.arguments || typeof selection.arguments.narration !== "string"
      || !selection.arguments.narration.trim() || selection.arguments.narration.length > 8_000
      || Object.keys(selection.arguments).length !== 1) {
      problems.push("narration-submit requires exactly one non-empty narration argument within the production bound");
    }
  } else if (selection.contract === "read-tool") {
    if (!selection.arguments || typeof selection.arguments !== "object" || Array.isArray(selection.arguments)) {
      problems.push("read-tool arguments must be an object (an empty object is valid)");
    }
  } else {
    if (selection.toolName !== undefined) problems.push("a non-call decision cannot name a tool");
    if (selection.contract === "clarify" && !selection.message.trim()) problems.push("clarification must contain a question or message");
    if (selection.intentCorrect === undefined) problems.push("a non-call decision requires an explicit scenario-oracle judgment");
  }

  if (selection.intentCorrect === false) problems.push("the scenario oracle judged the decision intent incorrect");
  if (!selection.transportValid) problems.push("tool arguments did not parse against the advertised schema");
  if (selection.serverRecovered === true) {
    problems.push(`final settlement came from server recovery, not the teacher (${selection.finalOutcome}); it cannot be credited as a teacher success`);
  }

  return { advertised, toolAdvertised, digestMatched, problems };
}

/** First-attempt selection is scored separately from the final turn outcome. */
export interface FamilyCScorecard {
  firstAttemptAdvertised: boolean;
  firstAttemptTransportValid: boolean;
  /** Null means no oracle judgment was supplied, not that membership proves intent. */
  intentCorrect: boolean | null;
  firstAttemptCorrect: boolean;
  confirmationRequired: boolean;
  confirmationApproved: boolean;
  serverRecovered: boolean;
  finalOutcome: ProviderSelection["finalOutcome"];
  /** Attribution only; scenario correctness is reported separately above. */
  teacherAuthoredOutcome: boolean;
}

export function scoreSelection(selection: ProviderSelection, verdict: SelectionVerdict): FamilyCScorecard {
  const firstAttemptAdvertised = verdict.advertised && verdict.digestMatched && verdict.toolAdvertised;
  const contract = selection.contract ?? "exact-candidate";
  const bindingValid = contract === "exact-candidate" ? firstAttemptAdvertised
    : contract === "clarify" || contract === "no-tool" ? selection.intentCorrect === true : verdict.toolAdvertised;
  const valid = bindingValid && verdict.problems.length === 0 && selection.transportValid && selection.intentCorrect !== false;
  const expectedOutcome = {
    "exact-candidate": "mechanics-committed", "narration-submit": "narration-submitted",
    "read-tool": "read-completed", clarify: "clarified", "no-tool": "no-tool",
  } as const;
  const teacherAuthoredOutcome =
    valid && selection.serverRecovered !== true && selection.finalOutcome === expectedOutcome[contract]
    && selection.confirmationStatus !== "pending" && selection.confirmationStatus !== "rejected" && selection.confirmationStatus !== "expired";
  return {
    firstAttemptAdvertised,
    firstAttemptTransportValid: selection.transportValid,
    intentCorrect: selection.intentCorrect ?? null,
    firstAttemptCorrect: valid && selection.intentCorrect === true,
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

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

export interface WorldGenerationChange {
  stage: "parse" | "sanitize" | "validate";
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export interface WorldGenerationVersions {
  readonly raw: unknown;
  readonly parsed: DeepReadonly<GeneratedCampaignContentProvider> | null;
  readonly sanitized: DeepReadonly<GeneratedCampaignContentProvider> | null;
  readonly validated: DeepReadonly<GeneratedCampaignContentProvider> | null;
}

export interface WorldGenerationRepair {
  readonly validatorVersion: string;
  readonly rawDigest: string;
  readonly parsedDigest: string;
  readonly sanitizedDigest: string;
  readonly validatedDigest: string | null;
  readonly changes: readonly DeepReadonly<WorldGenerationChange>[];
  /** A distinct validated training target; null when semantic validation failed. */
  readonly target: DeepReadonly<GeneratedCampaignContentProvider> | null;
}

/** Production's sanitizer mutates its argument. Never give it an evidence snapshot. */
function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const seen = new WeakSet<object>();
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

function structuralChanges(before: unknown, after: unknown, stage: WorldGenerationChange["stage"], path = "$"): WorldGenerationChange[] {
  if (deepEqual(before, after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    return Array.from({ length: Math.max(before.length, after.length) }, (_, index) => {
      const childPath = `${path}[${index}]`;
      if (index >= before.length) return [{ stage, path: childPath, kind: "added" as const, after: after[index] }];
      if (index >= after.length) return [{ stage, path: childPath, kind: "removed" as const, before: before[index] }];
      return structuralChanges(before[index], after[index], stage, childPath);
    }).flat();
  }
  if (before && after && typeof before === "object" && typeof after === "object"
    && !Array.isArray(before) && !Array.isArray(after)) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((key) => {
      const childPath = `${path}.${key}`;
      if (!Object.hasOwn(left, key)) return [{ stage, path: childPath, kind: "added" as const, after: right[key] }];
      if (!Object.hasOwn(right, key)) return [{ stage, path: childPath, kind: "removed" as const, before: left[key] }];
      return structuralChanges(left[key], right[key], stage, childPath);
    });
  }
  return [{ stage, path, kind: "changed", before, after }];
}

// Only known defaults introduced by the provider schema BEFORE sanitization are
// benign. This allowlist never exempts a changed/removed teacher-written value,
// nor any addition by the sanitizer, even if it resembles a schema default.
const BENIGN_EMPTY_ARRAY_DEFAULTS = new Set([
  ...WORLD_GENERATION_FIELDS.map((field) => `$.${field}`),
  ...["discoveries", "hazards", "hooks", "factionKeys"].map((field) => `$.locations[].${field}`),
  "$.npcs[].factionKeys", "$.quests[].locationKeys", "$.quests[].objectives", "$.quests[].rewards",
  "$.quests[].objectives[].dependencyObjectiveKeys",
  ...["participantNpcKeys", "objectives", "terrain", "escalation", "enemyReferences", "monsterConceptKeys"].map((field) => `$.encounters[].${field}`),
  ...["details", "locationKeys", "factionKeys", "storyNodeKeys"].map((field) => `$.lore[].${field}`),
  "$.questItems[].questKeys", "$.questItems[].locationKeys", "$.monsterConcepts[].tactics", "$.scenePrompts[].npcKeys",
]);

function benignParseDefault(change: WorldGenerationChange): boolean {
  if (change.stage !== "parse" || change.kind !== "added") return false;
  const path = change.path.replace(/\[\d+\]/g, "[]");
  return (BENIGN_EMPTY_ARRAY_DEFAULTS.has(path) && Array.isArray(change.after) && change.after.length === 0)
    || (path === "$.quests[].objectives[].targetProgress" && change.after === 1)
    || (path === "$.quests[].rewards[].amount" && change.after === null);
}

function generationDigest(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash("sha256").update(json ?? "undefined").digest("hex");
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
  /** Remains false for repaired targets, even when allowRepair admits the target. */
  rawFirstAttemptValid: boolean;
  versions: WorldGenerationVersions;
  repairProvenance: WorldGenerationRepair | null;
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
  let raw: unknown = null;
  try {
    raw = immutableSnapshot(input.raw);
    // Enforces the sparse, section-specific shape before any semantic work.
    const sparse = requestedCampaignContentProviderSchema([...input.sections], input.desiredCounts ?? {});
    parsedRaw = (sparse as { parse: (value: unknown) => unknown }).parse(raw);
  } catch (error) {
    return {
      ok: false, sanitized: false, content: null,
      rawFirstAttemptValid: false,
      versions: Object.freeze({ raw, parsed: null, sanitized: null, validated: null }),
      repairProvenance: null,
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
  let parsed: GeneratedCampaignContentProvider | null = null;
  let sanitizedContent: GeneratedCampaignContentProvider | null = null;
  let validatedContent: GeneratedCampaignContentProvider | null = null;
  const changes: WorldGenerationChange[] = [];
  try {
    parsed = immutableSnapshot(generatedCampaignContentProviderSchema.parse(parsedRaw));
    changes.push(...structuralChanges(raw, parsed, "parse").filter((change) => !benignParseDefault(change)));
    const dependencyKinds = new Map<string, string>();
    for (const [key, value] of input.dependencies) dependencyKinds.set(key, value.kind);
    const visibility = new Map([...input.dependencies].map(([key, value]) => [key, value.visibility] as const));
    const catalogReferences = new Set(input.catalogReferences.map((identity) => identity.referenceIdentity));

    // Production sanitizes ONLY when the caller opts into tolerating invalid
    // references, and it happens BEFORE validation. Mirroring that order matters:
    // without sanitization a dangling reference makes `validateContent` throw,
    // which is a REJECTION, not a repair.
    const candidate = structuredClone(parsed);
    sanitizedContent = immutableSnapshot(input.tolerateInvalidReferences
      ? sanitizeGeneratedCampaignContent(candidate, visibility, catalogReferences, dependencyKinds)
      : candidate);
    changes.push(...structuralChanges(parsed, sanitizedContent, "sanitize"));

    validatedContent = immutableSnapshot(validateContent(
      structuredClone(sanitizedContent),
      [...input.sections],
      visibility,
      catalogReferences,
      input.desiredCounts ?? {},
      dependencyKinds,
    ));
    changes.push(...structuralChanges(sanitizedContent, validatedContent, "validate"));
    content = structuredClone(validatedContent);
    if (changes.length > 0) {
      // A sanitized candidate is a REPAIR and needs its own training target;
      // the raw model output was not valid.
      if (input.allowRepair !== true) {
        problems.push("sanitization changed the output; this is a repair and needs its own target");
      } else {
        problems.push("sanitized: semantic changes require the distinct repair target and provenance");
      }
    }
  } catch (error) {
    problems.push(`semantic validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const sanitized = changes.length > 0;
  const ok = content !== null && (problems.length === 0 || (sanitized && input.allowRepair === true && problems.every((problem) => /^sanitized:/.test(problem))));
  const repairProvenance = sanitized && parsed && sanitizedContent ? immutableSnapshot({
    validatorVersion: FAMILY_D_VALIDATOR_VERSION,
    rawDigest: generationDigest(raw), parsedDigest: generationDigest(parsed),
    sanitizedDigest: generationDigest(sanitizedContent),
    validatedDigest: validatedContent ? generationDigest(validatedContent) : null,
    changes, target: validatedContent,
  }) : null;
  return {
    // A repair is admissible only when repairs are explicitly allowed; the
    // admission gate still requires the repair to carry its own target.
    ok,
    sanitized,
    rawFirstAttemptValid: ok && !sanitized,
    versions: Object.freeze({ raw, parsed, sanitized: sanitizedContent, validated: validatedContent }),
    repairProvenance,
    content: content ?? null,
    problems,
    requestedSections: [...input.sections],
    producedFields,
  };
}

/**
 * Canonical record contract for the VelvetRP Synthetic Training Data Foundry.
 *
 * This module is the single source of truth for dataset record shapes. The
 * evaluation corpus, the generation pipeline, the quality gates, the split
 * logic and the exporters all validate against the types declared here, so a
 * schema change is a one-file change.
 *
 * Two invariants are enforced by construction rather than by convention:
 *
 *  1. Metadata never enters the conversational text. Every synthetic detail
 *     lives in the sidecar provenance manifest, because training a model on
 *     provenance inside the prompt teaches it to invent provenance.
 *  2. A record is only `admitted` when it carries evidence naming the exact
 *     production validator that admitted it. Prose quality is never sufficient.
 */

/**
 * Persisted admission contract. The constructor owns its canonical definition;
 * expose the same type here rather than maintaining a second certificate shape.
 */
export type { AdmissionCertificate } from "./admission.js";

/** Foundry-wide version. Bump when any record shape changes. */
export const FOUNDRY_VERSION = "foundry-v1";

/** Record schema version, separate from the foundry version. */
export const RECORD_SCHEMA_VERSION = "training-record-v1";

/**
 * The five dataset families.
 *
 * - `roleplay-conversation`: multi-turn character conversations conditioned on
 *   a character card, scene and history.
 * - `grounded-narration`: narration of *committed* mechanical outcomes. The
 *   receipt is the ground truth and the narration must not contradict it.
 * - `tool-selection`: tool-call and no-tool-call decisions against the real
 *   advertised candidate menus.
 * - `world-generation`: VelvetRP's strict JSON Schema generation contracts.
 * - `boundary-recovery`: agency preservation, hidden-knowledge boundaries,
 *   unsupported actions, invalid requests and legitimate abstention.
 */
export const TRAINING_FAMILIES = [
  "roleplay-conversation",
  "grounded-narration",
  "tool-selection",
  "world-generation",
  "boundary-recovery",
] as const;
export type TrainingFamily = (typeof TRAINING_FAMILIES)[number];

export function isTrainingFamily(value: unknown): value is TrainingFamily {
  return typeof value === "string" && (TRAINING_FAMILIES as readonly string[]).includes(value);
}

/** Splits are assigned by lineage group, never by individual example. */
export const DATASET_SPLITS = ["train", "dev", "sealed-test"] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];

export function isDatasetSplit(value: unknown): value is DatasetSplit {
  return typeof value === "string" && (DATASET_SPLITS as readonly string[]).includes(value);
}

/**
 * Hugging Face conversational message roles actually emitted by this foundry.
 *
 * `tool_calls` is preserved structurally rather than flattened into prose,
 * because the two target chat templates render tool calls with different
 * surface syntaxes and a pre-rendered string cannot satisfy both.
 */
export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** OpenAI-shaped tool call as stored. `arguments` is an OBJECT, not a JSON string. */
export interface StoredToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: Record<string, unknown> };
}

export interface StoredMessage {
  role: MessageRole;
  content: string;
  /** Present only on assistant messages that call tools. */
  tool_calls?: StoredToolCall[];
  /** Present only on `tool` messages; required by the HF tool-calling schema. */
  name?: string;
  /** Present only on `tool` messages; links the result to its originating call. */
  tool_call_id?: string;
}

/**
 * A JSON-Schema function declaration, exactly as the target chat template
 * expects it in the top-level `tools` column.
 */
export interface StoredTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * The lineage group. Two examples sharing a lineage group must never be split
 * across `train` and `dev`/`sealed-test`, and near-duplicate detection is
 * computed within the group so revisions and paraphrases stay together.
 */
export interface LineageGroup {
  /** Character identity family. Distinct per held-out family. */
  characterFamily: string;
  /** World or campaign seed family. Distinct per held-out family. */
  worldFamily: string;
  /** Scenario template family. Distinct per held-out family. */
  scenarioFamily: string;
}

export interface Provenance {
  datasetVersion: string;
  recordSchemaVersion: string;
  /** Repository commit the example was produced against. */
  gitCommit: string | null;
  /** Seed that deterministically reproduces the scenario specification. */
  scenarioSeed: string;
  /** Scenario template version or id. */
  scenarioTemplate: string;
  /** Campaign / world / fixture identifier the example derives from. */
  sourceFixture: string | null;
  /** Names of production validators that admitted this record. */
  validators: string[];
  /** Versions of those validators, so a schema bump invalidates old records. */
  validatorVersions: Record<string, string>;
  /** Generator identity. `baseUrlDigest` is a digest, never the URL. */
  generator: {
    provider: string;
    model: string;
    baseUrlDigest: string | null;
    temperature: number;
  };
  /** Reviewer identity when an independent review ran. */
  reviewer: { provider: string; model: string; promptVersion: string } | null;
  /** Digests of the exact source bytes this record was derived from. */
  sourceDigests: Record<string, string>;
  /** Token count under the declared tokenizer, when one was measured. */
  tokenCount: { tokenizer: string; tokens: number } | null;
  /** Always true. Present so a downstream loader can filter on it explicitly. */
  syntheticOrigin: true;
  /** Usage rights status of the teacher output. */
  license: {
    /** e.g. provider terms permitting or forbidding training use. */
    status: "verified-permitted" | "unverified" | "restricted";
    note: string;
  };
  createdAt: string;
}

/** Deterministic admission evidence. */
export interface Admission {
  status: "admitted" | "rejected" | "pending-review";
  /** Machine-readable rejection reasons; empty when admitted. */
  reasons: string[];
  /** Free-form findings from the deterministic validators. */
  findings: Record<string, unknown>;
  /** Independent review scores, absent when no review ran. */
  review: ReviewScores | null;
  admittedAt: string | null;
}

/** Independent quality review. Sourced from a separate reviewer, never the generator. */
export interface ReviewScores {
  /** 0..1 each. Deliberately coarse: automated graders reject, they do not prove quality. */
  characterization: number;
  dialogueQuality: number;
  coherence: number;
  narrativeInitiative: number;
  playerAgency: number;
  /** 0..1 where 1 means no repetition. */
  nonRepetitive: number;
  /** Reviewer's overall verdict. */
  verdict: "accept" | "accept-with-notes" | "revise" | "reject";
  /** Reviewer's reasoning, retained for audit and repair. */
  rationale: string;
  /** Number of independent reviews; disagreements are surfaced, never averaged away. */
  reviewerCount: number;
}

/** A record that passed every gate and may be exported. */
export interface AdmittedRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  recordId: string;
  family: TrainingFamily;
  split: DatasetSplit;
  lineage: LineageGroup;
  /**
   * HF conversational SFT record. `tools` is top-level and omitted when the
   * example advertises no tools.
   */
  messages: StoredMessage[];
  tools?: StoredTool[];
  /** Present only for DPO export; never present on an SFT record. */
  preference?: PreferencePair;
  /** Digest of the exact message bytes, used for dedup and export checksums. */
  contentDigest: string;
  provenance: Provenance;
  admission: Admission;
}

/** DPO / ORPO candidate. Kept separate so it never contaminates the SFT export. */
export interface PreferencePair {
  /** Short machine reason, e.g. `fabricated-outcome`. */
  axis: string;
  prompt: StoredMessage[];
  chosen: StoredMessage[];
  rejected: StoredMessage[];
  /**
   * Why the pair is legitimate. Pairs that differ only on length or style are
   * rejected before they reach this record.
   */
  rationale: string;
  /**
   * Guards against the documented DPO length bias: chosen and rejected must be
   * within this ratio, or the pair is discarded.
   */
  lengthRatio: number;
}

/**
 * Export projection. Only messages/tools and preference branches are training
 * columns. The identity and certificate digest belong in the sidecar manifest,
 * never in messages or other trainer-visible conversational fields.
 */
export interface ExportedTrainingRecord {
  messages: readonly StoredMessage[];
  tools?: readonly StoredTool[];
  preference?: Pick<PreferencePair, "prompt" | "chosen" | "rejected">;
  certificateDigest: string;
  recordId: string;
  unitId: string;
  lineage: LineageGroup;
  split: DatasetSplit;
}

/** A candidate record mid-pipeline, before admission is decided. */
export interface CandidateRecord {
  schemaVersion: typeof RECORD_SCHEMA_VERSION;
  recordId: string;
  family: TrainingFamily;
  lineage: LineageGroup;
  scenarioSeed: string;
  messages: StoredMessage[];
  tools?: StoredTool[];
  preference?: PreferencePair;
  contentDigest: string;
  provenance: Omit<Provenance, "createdAt">;
  admission: Omit<Admission, "admittedAt"> & { admittedAt: null };
}

/** Stable JSON serialization with recursively sorted keys, for digests. */
export function stableStringify(value: unknown, indent = 0): string {
  const sorted = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sorted);
    if (input instanceof Map) {
      const entries = [...input.entries()].map(([key, entry]) => [sorted(key), sorted(entry)]);
      entries.sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
      return { $map: entries };
    }
    if (input && typeof input === "object") {
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
        throw new TypeError("canonical JSON rejects unsupported non-JSON objects");
      }
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, sorted(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(sorted(value), null, indent);
}

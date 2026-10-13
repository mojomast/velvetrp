/** Measured Qwen3 tokenizer bridge. All runtime assets are local and immutable. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovedAdmissionRegistry } from "./admission.js";
import type { SupervisedExample, TokenizerPort } from "./generate.js";
import { stableStringify } from "./spec.js";
import {
  QWEN3_8B_TEMPLATE_PROFILE, assertTemplateReadyForExport,
  type TemplateProfile, type TemplateMeasurementBinding, type PrefixPreservationEvidence,
  type ToolCallSupervisionSegments,
} from "./templateProfiles.js";

const ROOT = fileURLToPath(new URL("../tokenizer/", import.meta.url));
export const DEFAULT_TOKENIZER_EVIDENCE_DIR = join(ROOT, "evidence");
const RUNTIME = join(ROOT, "runtime.py");
const HASH = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const VERSIONS = { transformers: "5.19.0", trl: "1.15.0", tokenizers: "0.23.3", torch: "2.14.1+cpu", Jinja2: "3.1.6" };

export class TokenizerBridgeError extends Error {
  constructor(message: string) { super(message); this.name = "TokenizerBridgeError"; }
}

function refuse(message: string): never { throw new TokenizerBridgeError(message); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value); }

export interface TokenizerMeasurement {
  binding: TemplateMeasurementBinding;
  renderedText: string;
  inputIds: number[];
  labels: number[];
  assistantMask: number[];
  tokens: { start: number; end: number; tokenId: number; label: number }[];
  assistantRanges: { messageIndex: number; start: number; end: number; selected: boolean; targetStart: number; targetEnd: number }[];
  toolCallProbes: ToolCallSupervisionSegments[];
  supervisedTokens: number;
  totalTokens: number;
  maxSequenceLength: number;
}

/** Validate the actual final labels against both HF eligibility and selected turns. */
export function assertTokenizerMeasurement(value: unknown, example: SupervisedExample): asserts value is TokenizerMeasurement {
  if (!object(value) || typeof value.renderedText !== "string"
    || !Array.isArray(value.inputIds) || !Array.isArray(value.labels) || !Array.isArray(value.assistantMask)
    || !Array.isArray(value.tokens) || !Array.isArray(value.assistantRanges) || !Array.isArray(value.toolCallProbes)) {
    refuse("invalid tokenizer measurement shape");
  }
  const selected = new Set([...example.targetSelection.supervisedAssistantIndices, ...example.targetSelection.supervisedToolCallIndices]);
  for (const index of selected) {
    if (!integer(index) || index < 0 || example.messages[index]?.role !== "assistant") refuse("invalid selected assistant target");
  }
  const renderedText = value.renderedText;
  const regions: unknown[] = value.assistantRanges;
  const expectedAssistantIndices = example.messages.flatMap((message, index) => message.role === "assistant" ? [index] : []);
  if (regions.length !== expectedAssistantIndices.length) refuse("missing measured assistant ranges");
  regions.forEach((region: unknown, ordinal: number) => {
    if (!object(region) || region.messageIndex !== expectedAssistantIndices[ordinal]
      || !integer(region.start) || !integer(region.end) || !integer(region.targetStart) || !integer(region.targetEnd)
      || region.start < 0 || region.end > renderedText.length || region.start > region.targetStart
      || region.targetStart > region.targetEnd || region.targetEnd > region.end
      || region.selected !== selected.has(region.messageIndex as number)) refuse("assistant range does not bind target selection");
  });
  const checkedRegions = regions as TokenizerMeasurement["assistantRanges"];
  const ids: unknown[] = value.inputIds;
  const labels: unknown[] = value.labels;
  const masks: unknown[] = value.assistantMask;
  if (!ids.length || labels.length !== ids.length || masks.length !== ids.length || value.tokens.length !== ids.length
    || value.totalTokens !== ids.length || !integer(value.maxSequenceLength) || value.maxSequenceLength < ids.length) {
    refuse("token arrays or sequence limit disagree");
  }
  let count = 0;
  value.tokens.forEach((token: unknown, index: number) => {
    if (!object(token) || !integer(token.start) || !integer(token.end) || !integer(token.tokenId) || !integer(token.label)
      || token.start < 0 || token.end < token.start || token.end > renderedText.length || token.tokenId < 0
      || ids[index] !== token.tokenId || labels[index] !== token.label || ![0, 1].includes(masks[index] as number)) {
      refuse("invalid measured token/label/offset");
    }
    const start = token.start;
    const end = token.end;
    const contained = checkedRegions.some((region) => region.selected && start >= region.targetStart && end <= region.targetEnd);
    const overlaps = checkedRegions.some((region) => region.selected && start < region.targetEnd && end > region.targetStart);
    if (overlaps && !contained) refuse("token crosses selected-target boundary");
    const expected = contained && token.end > token.start ? token.tokenId : -100;
    if (token.label !== expected || (token.label !== -100 && masks[index] !== 1)) {
      refuse("loss labels supervise masked context/history or omit a selected target");
    }
    if (token.label !== -100) count += 1;
  });
  if (value.supervisedTokens !== count) refuse("supervised count differs from final TRL labels");
}

interface EvidenceBundle {
  version: string;
  modelId: string;
  tokenizerRevision: string;
  templateDigest: string;
  templateSource: string;
  runtimeVersions: typeof VERSIONS;
  runtimeScriptDigest: string;
  prepareScriptDigest: string;
  measurementScriptDigest: string;
  packing: boolean;
  maxSequenceLength: number;
  profileEvidence: { binding: TemplateMeasurementBinding; prefixPreservation: PrefixPreservationEvidence; toolCallSupervisionProbes: ToolCallSupervisionSegments[] };
  probes: { id: string; example: SupervisedExample; measurement: TokenizerMeasurement }[];
}

export interface MeasuredTokenizerEvidence {
  profile: TemplateProfile;
  artifacts: ReadonlyMap<string, string | Uint8Array>;
  bundleDigest: string;
  runtimeScriptDigest: string;
  runtimeVersions: typeof VERSIONS;
  maxSequenceLength: number;
  probes: readonly { id: string; example: SupervisedExample; measurement: TokenizerMeasurement }[];
}

export function loadMeasuredTokenizerEvidence(directory = DEFAULT_TOKENIZER_EVIDENCE_DIR): MeasuredTokenizerEvidence {
  const manifest = JSON.parse(readFileSync(join(directory, "checksums.json"), "utf8")) as { version: string; files: Record<string, string> };
  const artifacts = new Map<string, string | Uint8Array>();
  for (const name of ["qwen3-8b.json", "qwen3_training.jinja"]) {
    const bytes = readFileSync(join(directory, name));
    if (HASH(bytes) !== manifest.files[name]) refuse("tokenizer evidence file checksum mismatch");
    artifacts.set(HASH(bytes), bytes);
  }
  const bytes = readFileSync(join(directory, "qwen3-8b.json"));
  const bundle = JSON.parse(bytes.toString("utf8")) as EvidenceBundle;
  const source = QWEN3_8B_TEMPLATE_PROFILE;
  if (manifest.version !== "qwen3-tokenizer-evidence-v1" || bundle.version !== manifest.version
    || bundle.modelId !== source.modelId || bundle.tokenizerRevision !== source.tokenizerRevision
    || bundle.templateDigest !== source.templateDigest || bundle.templateSource !== source.templateArtifact?.source
    || stableStringify(bundle.runtimeVersions) !== stableStringify(VERSIONS)
    || bundle.packing !== false || !integer(bundle.maxSequenceLength) || bundle.maxSequenceLength < 1) {
    refuse("evidence does not bind the pinned model/template/runtime policy");
  }
  for (const [name, digest] of [["runtime.py", bundle.runtimeScriptDigest], ["prepare.py", bundle.prepareScriptDigest], ["measure.py", bundle.measurementScriptDigest]]) {
    if (!name || HASH(readFileSync(join(ROOT, name))) !== digest) refuse("measured tokenizer script changed; rerun measurements");
  }
  if (!Array.isArray(bundle.probes) || !bundle.probes.length) refuse("measured tokenizer probes are absent");
  for (const probe of bundle.probes) {
    assertTokenizerMeasurement(probe.measurement, probe.example);
    if (stableStringify(probe.measurement.binding) !== stableStringify(bundle.profileEvidence.binding)) refuse("probe runtime binding mismatch");
  }
  const probes = bundle.probes.flatMap((probe) => probe.measurement.toolCallProbes);
  if (stableStringify(probes) !== stableStringify(bundle.profileEvidence.toolCallSupervisionProbes)) refuse("tool probes differ from measured labels");
  const profile: TemplateProfile = {
    ...source,
    templateArtifact: { ...source.templateArtifact!, templateText: readFileSync(join(directory, "qwen3_training.jinja"), "utf8"),
      trlVersion: bundle.runtimeVersions.trl, transformersVersion: bundle.runtimeVersions.transformers },
    prefixPreservation: bundle.profileEvidence.prefixPreservation,
    toolCallSupervisionProbes: probes,
  };
  assertTemplateReadyForExport(profile, artifacts);
  return { profile, artifacts, bundleDigest: HASH(bytes), runtimeScriptDigest: bundle.runtimeScriptDigest,
    runtimeVersions: bundle.runtimeVersions, maxSequenceLength: bundle.maxSequenceLength, probes: bundle.probes };
}

/** Adds only template evidence; it does not approve any record, validator or reviewer. */
export function withMeasuredQwen3Template(registry: ApprovedAdmissionRegistry, evidence = loadMeasuredTokenizerEvidence()): ApprovedAdmissionRegistry {
  return { ...registry,
    artifacts: new Map([...registry.artifacts, ...evidence.artifacts]),
    templateProfiles: [...registry.templateProfiles.filter((profile) => profile.modelId !== evidence.profile.modelId), evidence.profile],
  };
}

export interface TokenizerBridge extends TokenizerPort {
  readonly evidence: MeasuredTokenizerEvidence;
  readonly policy: { readonly evidenceDigest: string; readonly maxSequenceLength: number;
    readonly truncation: false; readonly packing: false; readonly thinking: false; readonly selectionVersion: "selective-v1" };
  readonly policyDigest: string;
  measure(example: SupervisedExample): TokenizerMeasurement;
}

/** Synchronous port matches the foundry contract. Identical inputs are cached; no counts are estimated. */
export function createTokenizerBridge(options: { python: string; assetsDir: string; evidenceDir?: string; maxSequenceLength?: number }): TokenizerBridge {
  const evidence = loadMeasuredTokenizerEvidence(options.evidenceDir);
  const maximum = options.maxSequenceLength ?? evidence.maxSequenceLength;
  if (!integer(maximum) || maximum < 1) refuse("invalid tokenizer sequence limit");
  const cache = new Map<string, TokenizerMeasurement>();
  const measure = (example: SupervisedExample): TokenizerMeasurement => {
    const request = stableStringify({ example, maxSequenceLength: maximum });
    const requestDigest = HASH(request);
    const cached = cache.get(requestDigest);
    if (cached) return structuredClone(cached);
    const result = spawnSync(options.python, [RUNTIME, "--assets", resolve(options.assetsDir)], {
      input: request, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HF_HUB_OFFLINE: "1", TOKENIZERS_PARALLELISM: "false", TRANSFORMERS_VERBOSITY: "error",
        PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    if (result.error) refuse("tokenizer Python runtime could not start or timed out");
    let output: unknown;
    try { output = JSON.parse(result.stdout); } catch { refuse("tokenizer runtime returned no valid measurement; verify the pinned Python environment"); }
    if (result.status !== 0) {
      // Do not echo arbitrary interpreter stderr or input-dependent exceptions.
      const overlength = object(output) && typeof output.error === "string" && /^sequence has \d+ tokens, exceeding \d+;/.test(output.error);
      refuse(overlength ? "tokenizer refused overlength context/target; truncation is disabled" : "tokenizer runtime refused input or local assets; check runtime pins and target selection");
    }
    assertTokenizerMeasurement(output, example);
    if (output.maxSequenceLength !== maximum || !object(output) || output.requestDigest !== requestDigest
      || output.runtimeScriptDigest !== evidence.runtimeScriptDigest
      || stableStringify(output.runtimeVersions) !== stableStringify(evidence.runtimeVersions)
      || stableStringify(output.binding) !== stableStringify(evidence.probes[0]!.measurement.binding)) {
      refuse("tokenizer response does not bind the request and measured runtime");
    }
    cache.set(requestDigest, structuredClone(output));
    return output;
  };
  // Verify a real trace eagerly, before returning a callable production port.
  const probe = evidence.probes[0]!;
  const actual = measure(probe.example);
  if (stableStringify(actual.inputIds) !== stableStringify(probe.measurement.inputIds)
    || stableStringify(actual.labels) !== stableStringify(probe.measurement.labels)) refuse("installed runtime does not reproduce measured token IDs and labels");
  const policy = { evidenceDigest: evidence.bundleDigest, maxSequenceLength: maximum,
    truncation: false as const, packing: false as const, thinking: false as const, selectionVersion: "selective-v1" as const };
  const policyDigest = HASH(stableStringify(policy));
  return { name: `Qwen3-8B@${evidence.profile.tokenizerRevision}:trl-${VERSIONS.trl}:transformers-${VERSIONS.transformers}:selective-v1:${policyDigest}`,
    policy, policyDigest, evidence, measure, countSupervisedTokens: (example) => measure(example).supervisedTokens };
}

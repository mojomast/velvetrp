/** Checked export→reload→token materialization. No weights, optimizer or model training. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertExportable, type AdmittedRecordV1, type ApprovedAdmissionRegistry } from "./admission.js";
import { stableStringify, type StoredMessage, type StoredTool } from "./spec.js";
import type { TokenizerBridge, TokenizerMeasurement } from "./tokenizer.js";
import type { ExportChecksumManifest } from "./export.js";
import type { TargetSelection } from "./hfAdapter.js";

const hash = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");
function requireThat(condition: unknown, message: string): void { if (!condition) throw new Error(`training export preprocessing refused: ${message}`); }

export interface MaterializedSftRow {
  readonly recordId: string;
  readonly unitId: string;
  readonly policyDigest: string;
  readonly inputIds: readonly number[];
  readonly labels: readonly number[];
  readonly materializationDigest: string;
}
export interface MaterializedPreferenceRow {
  readonly recordId: string;
  readonly unitId: string;
  readonly policyDigest: string;
  readonly chosen: MaterializedSftRow;
  readonly rejected: MaterializedSftRow;
  /** Explicit selected-token mask, NOT blanket completion/assistant-only loss. */
  readonly chosenLogProbabilityMask: readonly boolean[];
  readonly rejectedLogProbabilityMask: readonly boolean[];
}
export interface MaterializedTrainingExport {
  readonly checksumDigest: string;
  readonly policyDigest: string;
  readonly sft: readonly MaterializedSftRow[];
  readonly preference: readonly MaterializedPreferenceRow[];
  /** A future DPO consumer must honor these masks; stock DPOTrainer is not asserted compatible. */
  readonly preferenceConsumer: "explicit-selected-token-mask-required";
}

function materialized(record: AdmittedRecordV1, measurement: TokenizerMeasurement, policyDigest: string): MaterializedSftRow {
  const body = { recordId: record.recordId, unitId: record.unitId, policyDigest, inputIds: measurement.inputIds, labels: measurement.labels };
  return { ...body, materializationDigest: hash(stableStringify(body)) };
}

/** The checksum pin and approval registry come from independent inspection. */
export function preprocessTrainingExport(options: { outputDir: string; checksumDigest: string;
  approvedRegistry: ApprovedAdmissionRegistry; tokenizer: TokenizerBridge }): MaterializedTrainingExport {
  const checksumBytes = readFileSync(join(options.outputDir, "checksums.json"), "utf8");
  requireThat(hash(checksumBytes) === options.checksumDigest, "bundle differs from independently pinned checksum bytes");
  const manifest = JSON.parse(checksumBytes) as ExportChecksumManifest;
  requireThat(manifest.version === "training-export-v1" && manifest.algorithm === "sha256"
    && stableStringify(manifest.files.map((file) => file.path).sort()) === '["provenance.json","training.jsonl"]'
    && hash(stableStringify(manifest.files)) === manifest.corpusDigest, "checksum manifest is invalid");
  const bytes = new Map(manifest.files.map((file) => {
    const contents = readFileSync(join(options.outputDir, file.path), "utf8");
    requireThat(hash(contents) === file.sha256, `changed ${file.path}`);
    return [file.path, contents];
  }));
  const training = bytes.get("training.jsonl")!;
  requireThat(training.endsWith("\n"), "training JSONL is not complete");
  const rows = training.slice(0, -1).split("\n").map((line) => JSON.parse(line) as { messages: StoredMessage[]; tools?: StoredTool[];
    prompt?: StoredMessage[]; chosen?: StoredMessage[]; rejected?: StoredMessage[] });
  const sidecar = JSON.parse(bytes.get("provenance.json")!) as { version: string; records: (Omit<AdmittedRecordV1, "messages" | "tools" | "preference"> & {
    line: number; preference?: { axis: string; rationale: string; lengthRatio: number } })[] };
  requireThat(sidecar.version === "training-export-v1" && manifest.recordCount === rows.length && sidecar.records.length === rows.length, "bundle/sidecar row counts differ");
  const tokenizer = options.tokenizer;
  const sft: MaterializedSftRow[] = [];
  const preference: MaterializedPreferenceRow[] = [];
  const identities = new Set<string>();
  rows.forEach((row, index) => {
    const { line, preference: metadata, ...source } = sidecar.records[index]!;
    requireThat(line === index + 1 && !identities.has(source.recordId), "sidecar row identity/order is invalid");
    identities.add(source.recordId);
    requireThat(source.provenance.sourceDigests.tokenizerPolicy === tokenizer.policyDigest
      && source.provenance.tokenCount?.tokenizer === tokenizer.name, "record preprocessing policy does not match the bound measured tokenizer");
    requireThat(metadata ? row.prompt && row.chosen && row.rejected && stableStringify(row.messages) === stableStringify(row.prompt)
      : !row.prompt && !row.chosen && !row.rejected, "SFT/preference row routing is inconsistent");
    const record = { ...source, messages: row.messages,
      ...(row.tools ? { tools: row.tools } : {}), ...(metadata ? { preference: { ...metadata, prompt: row.prompt!, chosen: row.chosen!, rejected: row.rejected! } } : {}) } as AdmittedRecordV1;
    assertExportable(record, options.approvedRegistry);
    if (!record.preference) {
      const trace = tokenizer.measure({ family: record.family, messages: row.messages, tools: row.tools, targetSelection: record.targetSelection });
      requireThat(trace.supervisedTokens === record.provenance.tokenCount!.tokens, "SFT record token count changed after export/reload");
      sft.push(materialized(record, trace, tokenizer.policyDigest));
      return;
    }
    const branches = ["chosen", "rejected"].map((arm) => {
      const key = arm as "chosen" | "rejected";
      const branch = record.preference![key];
      const targets: TargetSelection = record.preferenceTargets![key];
      const offset = record.preference!.prompt.length;
      const trace = tokenizer.measure({ family: record.family, messages: [...record.preference!.prompt, ...branch], tools: row.tools,
        targetSelection: { supervisedAssistantIndices: targets.supervisedAssistantIndices.map((target) => target + offset),
          supervisedToolCallIndices: targets.supervisedToolCallIndices.map((target) => target + offset) } });
      return { trace, row: materialized(record, trace, tokenizer.policyDigest) };
    });
    const [chosen, rejected] = branches;
    requireThat(chosen!.trace.supervisedTokens + rejected!.trace.supervisedTokens === record.provenance.tokenCount!.tokens, "preference token counts changed after export/reload");
    preference.push({ recordId: record.recordId, unitId: record.unitId, policyDigest: tokenizer.policyDigest,
      chosen: chosen!.row, rejected: rejected!.row, chosenLogProbabilityMask: chosen!.row.labels.map((label) => label !== -100),
      rejectedLogProbabilityMask: rejected!.row.labels.map((label) => label !== -100) });
  });
  return { checksumDigest: options.checksumDigest, policyDigest: tokenizer.policyDigest, sft, preference,
    preferenceConsumer: "explicit-selected-token-mask-required" };
}

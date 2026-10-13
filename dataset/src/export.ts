/** Fail-closed, provider-free HF export with separate provenance and checksums. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AdmissionError, assertExportable, type AdmittedRecordV1, type ApprovedAdmissionRegistry } from "./admission.js";
import { MESSAGE_ROLES, stableStringify, type ExportedTrainingRecord, type StoredMessage, type StoredTool } from "./spec.js";

export interface ExportTrainingOptions {
  /** A new or empty directory. The complete bundle is published by one rename. */
  readonly outputDir: string;
  readonly approvedRegistry: ApprovedAdmissionRegistry;
  /** Resume may reuse only a byte-identical, fully revalidated published bundle. */
  readonly resume?: boolean;
}

export interface ExportChecksumManifest {
  readonly version: "training-export-v1";
  readonly algorithm: "sha256";
  readonly recordCount: number;
  /** Relative names and hashes of every data/sidecar file (excluding this manifest). */
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  /** SHA-256 of stableStringify(files), binding both names and exact file bytes. */
  readonly corpusDigest: string;
}

export interface ExportTrainingResult {
  readonly outputDir: string;
  readonly trainingPath: string;
  readonly provenancePath: string;
  readonly checksumPath: string;
  readonly checksums: ExportChecksumManifest;
}

const digest = (bytes: string): string => createHash("sha256").update(bytes, "utf8").digest("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function refuse(message: string): never {
  throw new AdmissionError([message]);
}

/** Whitelist HF fields and refuse unbound normalization or nested metadata. */
function trainingMessages(messages: readonly StoredMessage[]): StoredMessage[] {
  const projected = messages.map((message): StoredMessage => {
    if (!MESSAGE_ROLES.includes(message.role) || typeof message.content !== "string") {
      refuse("export messages require a supported role and string content");
    }
    if (message.tool_calls !== undefined && (message.role !== "assistant" || !Array.isArray(message.tool_calls))) {
      refuse("only assistant messages may carry a tool_calls array");
    }
    if ((message.name !== undefined && typeof message.name !== "string")
      || (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string")) {
      refuse("tool names and call IDs must be strings");
    }
    return {
      role: message.role,
      content: message.content,
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls !== undefined ? { tool_calls: message.tool_calls.map((call) => {
        if (call.type !== "function" || typeof call.id !== "string" || !call.id
          || typeof call.function.name !== "string" || !call.function.name.trim()
          || !isObject(call.function.arguments)) {
          refuse("export tool calls require function names, IDs and OBJECT arguments (never JSON strings)");
        }
        return { id: call.id, type: call.type, function: { name: call.function.name, arguments: call.function.arguments } };
      }) } : {}),
    };
  });
  if (stableStringify(projected) !== stableStringify(messages)) refuse("unexpected metadata in conversational messages");
  return projected;
}

function trainingTools(tools: readonly StoredTool[]): StoredTool[] {
  const projected = tools.map((tool): StoredTool => {
    if (tool.type !== "function" || typeof tool.function.name !== "string" || !tool.function.name.trim()
      || typeof tool.function.description !== "string" || !isObject(tool.function.parameters)) {
      refuse("export tools require HF function declarations with object parameters");
    }
    return { type: tool.type, function: {
      name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters,
    } };
  });
  if (stableStringify(projected) !== stableStringify(tools)) refuse("unexpected metadata in tool declarations");
  return projected;
}

/**
 * Verify the entire corpus before touching the filesystem. Checksums and sidecar
 * bytes have no export-time timestamps or absolute paths, so identical inputs
 * produce identical bundles. Existing nonempty bundles are never overwritten.
 *
 * Preference rows additionally expose HF's prompt/chosen/rejected columns; their
 * axis/rationale/measurements stay in the sidecar. For those rows `messages` is
 * the certified prompt, since the preference certificate binds those branches,
 * not the candidate's auxiliary SFT messages.
 */
export function exportTrainingJsonl(
  records: readonly AdmittedRecordV1[],
  options: ExportTrainingOptions,
): ExportTrainingResult {
  if (!options.approvedRegistry) refuse("an approved artifact registry is required for export");
  // Snapshot the exact JSON bytes we verify and later publish. Caller mutations,
  // getters or toJSON methods cannot change the output after verification.
  const snapshots = JSON.parse(stableStringify(records)) as AdmittedRecordV1[];
  const projected: ExportedTrainingRecord[] = [];
  const seen = new Set<string>();
  for (const record of snapshots) {
    assertExportable(record, options.approvedRegistry);
    if (seen.has(record.recordId)) refuse(`duplicate export record identity ${record.recordId}`);
    seen.add(record.recordId);
    projected.push({
      messages: trainingMessages(record.preference?.prompt ?? record.messages),
      ...(record.tools !== undefined ? { tools: trainingTools(record.tools) } : {}),
      ...(record.preference ? { preference: {
        prompt: trainingMessages(record.preference.prompt),
        chosen: trainingMessages(record.preference.chosen),
        rejected: trainingMessages(record.preference.rejected),
      } } : {}),
      certificateDigest: record.admissionCertificate.certificateDigest,
      recordId: record.recordId, unitId: record.unitId, lineage: record.lineage, split: record.split,
    });
  }

  const training = projected.map((record) => stableStringify({
    messages: record.messages,
    ...(record.tools !== undefined ? { tools: record.tools } : {}),
    ...(record.preference ? {
      prompt: record.preference.prompt, chosen: record.preference.chosen, rejected: record.preference.rejected,
    } : {}),
  }) + "\n").join("");
  const provenance = stableStringify({
    version: "training-export-v1",
    records: snapshots.map((record, index) => ({
      line: index + 1,
      recordId: record.recordId, unitId: record.unitId, family: record.family,
      lineage: record.lineage, split: record.split, splitAssignmentDigest: record.splitAssignmentDigest,
      schemaVersion: record.schemaVersion, admissionVersion: record.admissionVersion,
      contentDigest: record.contentDigest, payloadDigest: record.payloadDigest,
      certificateDigest: record.admissionCertificate.certificateDigest,
      admissionCertificate: record.admissionCertificate, provenance: record.provenance, admission: record.admission,
      targetSelection: record.targetSelection,
      ...(record.preferenceTargets ? { preferenceTargets: record.preferenceTargets } : {}),
      ...(record.preference ? { preference: {
        axis: record.preference.axis, rationale: record.preference.rationale, lengthRatio: record.preference.lengthRatio,
      } } : {}),
      behaviourTags: record.behaviourTags, visibilityRequirements: record.visibilityRequirements,
      authorityRequirements: record.authorityRequirements,
    })),
  }, 2) + "\n";
  const contents = [
    { path: "provenance.json", bytes: provenance },
    { path: "training.jsonl", bytes: training },
  ];
  const files = contents.map((file) => ({ path: file.path, sha256: digest(file.bytes) }));
  const checksums: ExportChecksumManifest = {
    version: "training-export-v1", algorithm: "sha256", recordCount: records.length,
    files, corpusDigest: digest(stableStringify(files)),
  };
  const checksumBytes = stableStringify(checksums, 2) + "\n";

  // Nothing above this line writes even a temporary file or creates a directory.
  const outputDir = resolve(options.outputDir);
  if (existsSync(outputDir) && (!lstatSync(outputDir).isDirectory() || readdirSync(outputDir).length > 0)) {
    if (options.resume && lstatSync(outputDir).isDirectory()
      && stableStringify(readdirSync(outputDir).sort()) === stableStringify([...contents.map((file) => file.path), "checksums.json"].sort())
      && contents.every((file) => readFileSync(join(outputDir, file.path), "utf8") === file.bytes)
      && readFileSync(join(outputDir, "checksums.json"), "utf8") === checksumBytes) {
      return { outputDir, trainingPath: join(outputDir, "training.jsonl"), provenancePath: join(outputDir, "provenance.json"),
        checksumPath: join(outputDir, "checksums.json"), checksums };
    }
    throw new Error(`export destination must be a new or empty directory: ${outputDir}`);
  }
  const syncPath = (path: string): void => { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
  const durableParent = (path: string): void => {
    if (existsSync(path)) return;
    durableParent(dirname(path));
    try { mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    syncPath(dirname(path));
  };
  durableParent(dirname(outputDir));
  const staging = mkdtempSync(join(dirname(outputDir), `.${basename(outputDir)}-export-`));
  try {
    for (const file of contents) { const path = join(staging, file.path); writeFileSync(path, file.bytes, { encoding: "utf8", flag: "wx" }); syncPath(path); }
    writeFileSync(join(staging, "checksums.json"), checksumBytes, { encoding: "utf8", flag: "wx" });
    syncPath(join(staging, "checksums.json"));
    syncPath(staging);
    renameSync(staging, outputDir);
    syncPath(dirname(outputDir));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return {
    outputDir, trainingPath: join(outputDir, "training.jsonl"), provenancePath: join(outputDir, "provenance.json"),
    checksumPath: join(outputDir, "checksums.json"), checksums,
  };
}

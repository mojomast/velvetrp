/**
 * Export an independently approved corpus into a training bundle.
 *
 * This is the ONLY script that publishes a training bundle. It refuses to run
 * without an externally supplied, digest-pinned approval file: the approval is
 * what authorizes export, and this script never manufactures one.
 *
 * Approval schema (corpus-approval-v1):
 * {
 *   "approvalVersion": "corpus-approval-v1",
 *   "decision": "approved-export-only",
 *   "trainingAuthorized": false,
 *   "inspectedGitCommit": "<40-hex>",
 *   "measuredTemplateEvidenceDigest": "<tokenizer evidence bundleDigest>",
 *   "validators": { "<validator>": { "version": "...", "implementationDigest": "..." } },
 *   "implementationArtifacts": { "<digest>": { "kind": "git-blob", "commit": "...", "path": "..." } },
 *   "runs": [ { "runId", "journalDirectory", "reportCheckpointKey", "reportDigest",
 *               "sourceArtifactDigests": [...], "gateEvidenceArtifactDigests": [...],
 *               "reviewPromptArtifacts": { "<digest>": { "checkpointKey", "responseCheckpointKey",
 *                                                          "rawAcceptedReviewSha256" } } } ],
 *   "records": [ { "unitId", "runId", "family", "split", "certificateDigest",
 *                  "payloadDigest", "labels" } ]
 * }
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/exportApprovedBundle.ts <approval.json> <approval.sha256> <outputDir> [--reload]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExportable, type ApprovedAdmissionRegistry } from "../src/admission.js";
import { exportTrainingJsonl } from "../src/export.js";
import { preprocessTrainingExport } from "../src/preprocessExport.js";
import { createTokenizerBridge, withMeasuredQwen3Template } from "../src/tokenizer.js";
import { stableStringify } from "../src/spec.js";

const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface RunSection {
  runId: string;
  journalDirectory: string;
  reportCheckpointKey: string;
  reportDigest: string;
  sourceArtifactDigests: string[];
  gateEvidenceArtifactDigests: string[];
  reviewPromptArtifacts: Record<string, { checkpointKey: string; responseCheckpointKey: string; rawAcceptedReviewSha256: string }>;
}
interface RecordEntry {
  unitId: string; runId: string; family: string; split: string;
  certificateDigest: string; payloadDigest: string; labels: number;
}
interface Approval {
  approvalVersion: string;
  decision: string;
  trainingAuthorized: boolean;
  inspectedGitCommit: string;
  measuredTemplateEvidenceDigest: string;
  implementationSourceDigest: string;
  implementationSourceManifest: { tree: string; fileCount: number };
  validators: Record<string, { version: string; implementationDigest: string; implementationPaths: string[] }>;
  implementationArtifacts: Record<string, { kind: string; commit: string; path: string }>;
  runs: RunSection[];
  records: RecordEntry[];
}

function main(argv: readonly string[]): void {
  const [approvalPath, expectedApprovalDigest, outputDir, ...rest] = argv;
  const reload = rest.includes("--reload");
  if (!approvalPath || !expectedApprovalDigest || !outputDir) {
    throw new Error("usage: exportApprovedBundle.ts <approval.json> <approval.sha256> <outputDir> [--reload]");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedApprovalDigest)) throw new Error("expected approval digest required");

  const approvalBytes = readFileSync(approvalPath);
  if (hash(approvalBytes) !== expectedApprovalDigest) throw new Error("independent approval pin differs");
  const approval = JSON.parse(approvalBytes.toString("utf8")) as Approval;
  if (approval.approvalVersion !== "corpus-approval-v1") throw new Error(`unexpected approval version ${approval.approvalVersion}`);
  if (approval.decision !== "approved-export-only") throw new Error(`approval decision is "${approval.decision}", not approved-export-only`);
  if (approval.trainingAuthorized !== false) throw new Error("unexpected approval scope: training must not be authorized by an export approval");

  // Resolve every run's journal, verifying each envelope digest.
  const artifacts = new Map<string, string | Uint8Array>();
  const retain = (digest: string, bytes: string | Uint8Array): void => {
    if (hash(bytes) !== digest) throw new Error(`artifact pin differs: ${digest}`);
    artifacts.set(digest, bytes);
  };

  const records: Array<RecordEntry & { record: unknown }> = [];
  for (const run of approval.runs) {
    const journal = join(repositoryRoot, run.journalDirectory);
    const checkpoint = (key: string): unknown => {
      const wrapper = JSON.parse(readFileSync(join(journal, `${hash(key)}.json`), "utf8")) as { key: string; digest: string; value: unknown };
      if (wrapper.key !== key || wrapper.digest !== hash(stableStringify(wrapper.value))) throw new Error(`journal envelope differs for ${key}`);
      return wrapper.value;
    };
    const report = checkpoint(run.reportCheckpointKey);
    if (hash(stableStringify(report)) !== run.reportDigest) throw new Error(`report digest differs for ${run.runId}`);

    for (const digest of [...run.sourceArtifactDigests, ...run.gateEvidenceArtifactDigests]) {
      retain(digest, checkpoint(`artifact:${digest}`) as string);
    }
    for (const [digest, source] of Object.entries(run.reviewPromptArtifacts)) {
      const dispatch = checkpoint(source.checkpointKey) as { request: { system?: string } };
      retain(digest, dispatch.request.system ?? "");
      const response = checkpoint(source.responseCheckpointKey) as { content: string };
      if (hash(response.content) !== source.rawAcceptedReviewSha256) throw new Error(`accepted raw review changed for ${source.responseCheckpointKey}`);
    }

    const units = (report as { unitOutcomes: Array<{ unitId: string; admittedRecord?: unknown }> }).unitOutcomes;
    for (const entry of approval.records.filter((record) => record.runId === run.runId)) {
      const admitted = units.find((unit) => unit.unitId === entry.unitId)?.admittedRecord as
        | { split: string; payloadDigest: string; family: string; admissionCertificate: { certificateDigest: string } }
        | undefined;
      if (!admitted) throw new Error(`approved record ${entry.unitId} is not admitted in ${run.runId}`);
      if (admitted.split !== "train") throw new Error(`approved record ${entry.unitId} is split ${admitted.split}, not train`);
      if (admitted.payloadDigest !== entry.payloadDigest) throw new Error(`payload digest differs for ${entry.unitId}`);
      if (admitted.family !== entry.family) throw new Error(`family differs for ${entry.unitId}`);
      if (admitted.admissionCertificate.certificateDigest !== entry.certificateDigest) throw new Error(`certificate digest differs for ${entry.unitId}`);
      records.push({ ...entry, record: admitted });
    }
  }

  // Implementation evidence is the git TREE OBJECT of the inspected commit: a
  // Merkle root over every path, mode and blob, so it is complete by construction.
  // Verify it resolves, then REGISTER its bytes, because admission.ts resolves each
  // validator's implementationDigest through the artifact registry.
  const sourceTree = approval.implementationSourceManifest as unknown as { tree: string; fileCount: number };
  if (!sourceTree || typeof sourceTree.tree !== "string" || !/^[0-9a-f]{40}$/.test(sourceTree.tree)) {
    throw new Error("approval has no implementation source tree");
  }
  const actualTree = execFileSync("git", ["rev-parse", `${approval.inspectedGitCommit}^{tree}`], { cwd: repositoryRoot }).toString("utf8").trim();
  if (actualTree !== sourceTree.tree) throw new Error("implementation source tree does not match the inspected commit");
  const manifestBytes = `git-tree:${sourceTree.tree}`;
  const manifestDigest = hash(manifestBytes);
  if (manifestDigest !== approval.implementationSourceDigest) throw new Error("implementation source digest does not reproduce from its tree");
  retain(manifestDigest, manifestBytes);
  for (const [name, validator] of Object.entries(approval.validators)) {
    if (validator.implementationDigest !== manifestDigest) {
      throw new Error(`validator "${name}" does not pin the approved implementation source`);
    }
  }

  for (const [digest, source] of Object.entries(approval.implementationArtifacts)) {
    if (source.kind !== "git-blob" || source.commit !== approval.inspectedGitCommit) throw new Error("unexpected implementation resolution");
    retain(digest, execFileSync("git", ["show", `${source.commit}:${source.path}`], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 }));
  }

  const python = process.env.FOUNDRY_TOKENIZER_PYTHON;
  if (!python) throw new Error("FOUNDRY_TOKENIZER_PYTHON is required for measured labels");
  const tokenizer = createTokenizerBridge({ python,
    assetsDir: process.env.FOUNDRY_TOKENIZER_ASSETS ?? join(repositoryRoot, ".dataset", "tokenizer", "qwen3-8b") });
  if (tokenizer.evidence.bundleDigest !== approval.measuredTemplateEvidenceDigest) throw new Error("approved tokenizer evidence differs");

  const registry: ApprovedAdmissionRegistry = withMeasuredQwen3Template({
    certificates: new Map(records.map((entry) => [entry.unitId, entry.certificateDigest])),
    validators: approval.validators, artifacts, templateProfiles: [],
  }, tokenizer.evidence);
  const admitted = records.map((entry) => entry.record as never);
  for (const record of admitted) assertExportable(record, registry);

  const result = exportTrainingJsonl(admitted, { outputDir, approvedRegistry: registry, resume: reload });
  const checksumDigest = hash(readFileSync(result.checksumPath));
  process.stdout.write(stableStringify({
    outputDir: result.outputDir, trainingPath: result.trainingPath, provenancePath: result.provenancePath,
    checksumPath: result.checksumPath, checksumDigest, recordCount: result.checksums.recordCount,
    corpusDigest: result.checksums.corpusDigest, files: result.checksums.files,
  }, 2) + "\n");

  if (reload) {
    const materialized = preprocessTrainingExport({ outputDir: result.outputDir, checksumDigest, approvedRegistry: registry, tokenizer });

    // Persist the exact token-level supervision. The handoff prefers materialized
    // labels over rebuilding masks by hand, because a hand-rolled masking pass can
    // silently supervise the simulated player's turns.
    //
    // Written to a SEPARATE subdirectory with its OWN checksum manifest. It must
    // never join the pinned bundle's checksums.json: that manifest's digest is
    // itself pinned by the independent approval, so adding files to it would
    // invalidate the pin. The bundle's three files stay byte-identical.
    const materializedDir = join(result.outputDir, "materialized");
    mkdirSync(materializedDir, { recursive: true });
    const sftLines = materialized.sft.map((row) => stableStringify(row)).join("\n") + (materialized.sft.length ? "\n" : "");
    writeFileSync(join(materializedDir, "sft.jsonl"), sftLines);
    const materializedFiles = [{ path: "sft.jsonl", sha256: hash(sftLines) }];
    writeFileSync(join(materializedDir, "checksums.json"), stableStringify({
      algorithm: "sha256", version: "training-export-v1-materialized",
      recordCount: materialized.sft.length, policyDigest: materialized.policyDigest,
      sourceChecksumDigest: checksumDigest,
      preferenceConsumer: materialized.preferenceConsumer,
      files: materializedFiles,
    }, 2) + "\n");

    process.stdout.write(stableStringify({
      materializedRows: materialized.sft.length + materialized.preference.length,
      supervisedTokens: materialized.sft.reduce((sum, row) => sum + row.labels.filter((label) => label !== -100).length, 0),
      policyDigest: materialized.policyDigest,
      materializedDir, materializedSft: join(materializedDir, "sft.jsonl"), materializedSftSha256: hash(sftLines),
      materializedChecksumDigest: hash(readFileSync(join(materializedDir, "checksums.json"))),
    }, 2) + "\n");
  }
}

main(process.argv.slice(2));

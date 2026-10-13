/**
 * Export an independently approved admission registry into a training bundle.
 *
 * This is the ONLY script that publishes a training bundle. It refuses to run
 * without an externally supplied, digest-pinned approval file: the approval is
 * what authorizes export, and the script does not manufacture one.
 *
 * Approval file schema (JSON):
 * {
 *   "decision": "approved-export-only",
 *   "trainingAuthorized": false,
 *   "inspectedGitCommit": "<40-hex>",
 *   "runId": "<run id owning the journal>",
 *   "sourceReportDigest": "<sha256 of stableStringify(report checkpoint value)>",
 *   "measuredTemplateEvidenceDigest": "<tokenizer evidence bundleDigest>",
 *   "certificates": { "<unitId>": "<certificateDigest>", ... },
 *   "payloadDigests": { "<unitId>": "<payloadDigest>", ... },
 *   "validators": { "<validator>": "<version>", ... },
 *   "sourceArtifactDigests": ["<digest>", ...],
 *   "gateEvidenceArtifactDigests": ["<digest>", ...],
 *   "implementationArtifacts": { "<digest>": { "kind": "git-blob", "commit": "<40-hex>", "path": "<repo path>" } },
 *   "reviewPromptArtifacts": { "<digest>": { "checkpointKey": "...", "responseCheckpointKey": "...", "rawAcceptedReviewSha256": "<sha256>" } }
 * }
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/exportApprovedBundle.ts <approval.json> <approval.sha256> <outputDir> [--reload]
 *
 * `--reload` additionally re-verifies an already-published byte-identical bundle
 * instead of refusing on a non-empty destination, and materialises exact
 * Qwen3-8B input ids and loss labels through the pinned CPU tokenizer.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertExportable, type ApprovedAdmissionRegistry } from "../src/admission.js";
import { exportTrainingJsonl } from "../src/export.js";
import { preprocessTrainingExport } from "../src/preprocessExport.js";
import { createTokenizerBridge, withMeasuredQwen3Template } from "../src/tokenizer.js";
import { stableStringify } from "../src/spec.js";

const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ApprovalSource { checkpointKey: string; responseCheckpointKey: string; rawAcceptedReviewSha256: string }
interface Approval {
  decision: string;
  trainingAuthorized: boolean;
  inspectedGitCommit: string;
  runId: string;
  sourceReportDigest: string;
  measuredTemplateEvidenceDigest: string;
  certificates: Record<string, string>;
  payloadDigests: Record<string, string>;
  validators: Record<string, { version: string; implementationDigest: string }>;
  sourceArtifactDigests: string[];
  gateEvidenceArtifactDigests: string[];
  implementationArtifacts: Record<string, { kind: string; commit: string; path: string }>;
  reviewPromptArtifacts: Record<string, ApprovalSource>;
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
  if (approval.decision !== "approved-export-only" || approval.trainingAuthorized !== false) {
    throw new Error("unexpected approval scope; export-only, training not authorized");
  }

  const journal = (approval as unknown as { artifactResolution?: { journalDirectory?: string } })
    .artifactResolution?.journalDirectory
    ? join(repositoryRoot, (approval as unknown as { artifactResolution: { journalDirectory: string } }).artifactResolution.journalDirectory)
    : join(repositoryRoot, ".dataset", "runs", approval.runId, "pipeline");
  const checkpoint = (key: string): unknown => {
    const wrapper = JSON.parse(readFileSync(join(journal, `${hash(key)}.json`), "utf8")) as { key: string; digest: string; value: unknown };
    if (wrapper.key !== key || wrapper.digest !== hash(stableStringify(wrapper.value))) throw new Error("journal envelope differs");
    return wrapper.value;
  };

  const artifacts = new Map<string, string | Uint8Array>();
  const retain = (digest: string, bytes: string | Uint8Array): void => {
    if (hash(bytes) !== digest) throw new Error(`artifact pin differs: ${digest}`);
    artifacts.set(digest, bytes);
  };
  for (const digest of [...approval.sourceArtifactDigests, ...approval.gateEvidenceArtifactDigests]) {
    retain(digest, checkpoint(`artifact:${digest}`) as string);
  }
  for (const [digest, source] of Object.entries(approval.reviewPromptArtifacts)) {
    const dispatch = checkpoint(source.checkpointKey) as { request: { system?: string } };
    retain(digest, dispatch.request.system ?? "");
    const response = checkpoint(source.responseCheckpointKey) as { content: string };
    if (hash(response.content) !== source.rawAcceptedReviewSha256) throw new Error("accepted raw review changed");
  }
  for (const [digest, source] of Object.entries(approval.implementationArtifacts)) {
    if (source.kind !== "git-blob" || source.commit !== approval.inspectedGitCommit) throw new Error("unexpected implementation resolution");
    retain(digest, execFileSync("git", ["show", `${source.commit}:${source.path}`], { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 }));
  }

  const reportFiles = readdirSync(journal).filter((name) => {
    const wrapper = JSON.parse(readFileSync(join(journal, name), "utf8")) as { key: string };
    return wrapper.key.startsWith("report:");
  });
  if (reportFiles.length !== 1) throw new Error(`expected one report checkpoint, found ${reportFiles.length}`);
  const reportValue = (JSON.parse(readFileSync(join(journal, reportFiles[0]!), "utf8")) as { value: unknown }).value;
  if (hash(stableStringify(reportValue)) !== approval.sourceReportDigest) throw new Error("actual report differs from independent inspection");

  const units = (reportValue as { unitOutcomes: Array<{ unitId: string; admittedRecord?: { split: string; payloadDigest: string } }> }).unitOutcomes;
  const records = Object.keys(approval.certificates).map((unitId) => {
    const record = units.find((unit) => unit.unitId === unitId)?.admittedRecord;
    if (!record || record.split !== "train" || record.payloadDigest !== approval.payloadDigests[unitId]) {
      throw new Error(`approved train payload differs for ${unitId}`);
    }
    return record;
  });

  const python = process.env.FOUNDRY_TOKENIZER_PYTHON;
  if (!python) throw new Error("FOUNDRY_TOKENIZER_PYTHON is required for measured labels");
  const tokenizer = createTokenizerBridge({ python,
    assetsDir: process.env.FOUNDRY_TOKENIZER_ASSETS ?? join(repositoryRoot, ".dataset", "tokenizer", "qwen3-8b") });
  if (tokenizer.evidence.bundleDigest !== approval.measuredTemplateEvidenceDigest) throw new Error("approved tokenizer evidence differs");

  const registry: ApprovedAdmissionRegistry = withMeasuredQwen3Template({
    certificates: new Map(Object.entries(approval.certificates)),
    validators: approval.validators, artifacts, templateProfiles: [],
  }, tokenizer.evidence);
  for (const record of records) assertExportable(record as never, registry);

  const result = exportTrainingJsonl(records as never, { outputDir, approvedRegistry: registry, resume: reload });
  const checksumDigest = hash(readFileSync(result.checksumPath));
  process.stdout.write(stableStringify({
    outputDir: result.outputDir, trainingPath: result.trainingPath,
    provenancePath: result.provenancePath, checksumPath: result.checksumPath,
    checksumDigest, recordCount: result.checksums.recordCount,
    corpusDigest: result.checksums.corpusDigest,
  }, 2) + "\n");

  if (reload) {
    const materialized = preprocessTrainingExport({
      outputDir: result.outputDir, checksumDigest, approvedRegistry: registry, tokenizer,
    });
    process.stdout.write(stableStringify({
      materializedRows: materialized.sft.length + materialized.preference.length,
      supervisedTokens: materialized.sft.reduce((sum, row) => sum + row.labels.filter((label) => label !== -100).length, 0),
      policyDigest: materialized.policyDigest,
    }, 2) + "\n");
  }
}

main(process.argv.slice(2));

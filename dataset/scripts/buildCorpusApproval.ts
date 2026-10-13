/**
 * Generate a CANDIDATE approval artifact for the corpus, mechanically from the
 * durable run stores.
 *
 * This does NOT authorize anything. It resolves every digest an independent
 * reviewer needs, so the reviewer can inspect exact bytes instead of
 * reconstructing them. The export entry point refuses a candidate whose
 * independently supplied pin does not match, and refuses a file that is not
 * marked export-only.
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/buildCorpusApproval.ts <out.json> <runId> [<runId> ...]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMeasuredTokenizerEvidence } from "../src/tokenizer.js";
import { stableStringify } from "../src/spec.js";

const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const outPath = process.argv[2];
const runIds = process.argv.slice(3);
if (!outPath || runIds.length === 0) throw new Error("usage: buildCorpusApproval.ts <out.json> <runId> [<runId> ...]");

const inspectedGitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }).toString().trim();

interface RunSection {
  runId: string;
  journalDirectory: string;
  reportCheckpointKey: string;
  reportDigest: string;
  sourceArtifactDigests: string[];
  gateEvidenceArtifactDigests: string[];
  reviewPromptArtifacts: Record<string, { checkpointKey: string; responseCheckpointKey: string; rawAcceptedReviewSha256: string }>;
}
interface RecordEntry { unitId: string; runId: string; family: string; split: string; certificateDigest: string; payloadDigest: string; labels: number }

const validators: Record<string, { version: string; implementationDigest: string }> = {};
const implementationArtifacts: Record<string, { kind: string; commit: string; path: string }> = {};
const runs: RunSection[] = [];
const records: RecordEntry[] = [];

for (const runId of runIds) {
  const journalDirectory = `.dataset/runs/${runId}/pipeline`;
  const journal = join(repositoryRoot, journalDirectory);
  const entries = new Map<string, unknown>();
  for (const file of readdirSync(journal).filter((name) => name.endsWith(".json"))) {
    const wrapper = JSON.parse(readFileSync(join(journal, file), "utf8")) as { key: string; digest: string; value: unknown };
    if (file !== `${hash(wrapper.key)}.json` || wrapper.digest !== hash(stableStringify(wrapper.value))) {
      throw new Error(`journal checksum mismatch in ${runId}: ${file}`);
    }
    entries.set(wrapper.key, wrapper.value);
  }
  const reportKeys = [...entries.keys()].filter((key) => key.startsWith("report:"));
  if (reportKeys.length !== 1) throw new Error(`expected one report checkpoint in ${runId}`);
  const reportKey = reportKeys[0]!;
  const report = entries.get(reportKey) as {
    unitOutcomes: Array<{ unitId: string; admittedRecord?: {
      split: string; family: string; payloadDigest: string; recordId: string;
      admissionCertificate: { certificateDigest: string; evidence: Array<{ validator: string; version: string; evidenceDigest: string; payloadDigest: string }> };
      provenance: { tokenCount: { tokens: number }; sourceDigests: Record<string, string> };
    } }>;
  };

  const sourceArtifactDigests = new Set<string>();
  const gateEvidenceArtifactDigests = new Set<string>();
  const reviewPromptArtifacts: RunSection["reviewPromptArtifacts"] = {};

  for (const unit of report.unitOutcomes) {
    const record = unit.admittedRecord;
    if (!record || record.split !== "train") continue;
    for (const [name, digest] of Object.entries(record.provenance.sourceDigests)) {
      if (name === "reviewerPrompt") continue;
      sourceArtifactDigests.add(digest);
    }
    for (const item of record.admissionCertificate.evidence) {
      validators[item.validator] ??= { version: item.version, implementationDigest: item.evidenceDigest };
      gateEvidenceArtifactDigests.add(item.evidenceDigest);
    }
    records.push({ unitId: unit.unitId, runId, family: record.family, split: record.split,
      certificateDigest: record.admissionCertificate.certificateDigest,
      payloadDigest: record.payloadDigest, labels: record.provenance.tokenCount.tokens });
  }

  // Reviewer prompt bytes resolve through dispatch checkpoints, not artifact entries.
  for (const [key, value] of entries) {
    if (!key.startsWith("review-contract:")) continue;
    const contract = value as { attempts: string[]; usable: boolean; reviewerPromptDigest: string };
    if (!contract.usable) continue;
    const attemptId = key.slice("review-contract:".length);
    const lastAttempt = contract.attempts.at(-1) ?? `${attemptId}-review`;
    const dispatchKey = `dispatch:${lastAttempt}`;
    const responseKey = `response:${lastAttempt}`;
    if (!entries.has(dispatchKey) || !entries.has(responseKey)) continue;
    const response = entries.get(responseKey) as { content: string };
    reviewPromptArtifacts[contract.reviewerPromptDigest] = {
      checkpointKey: dispatchKey, responseCheckpointKey: responseKey, rawAcceptedReviewSha256: hash(response.content),
    };
  }

  runs.push({ runId, journalDirectory, reportCheckpointKey: reportKey,
    reportDigest: hash(stableStringify(entries.get(reportKey))),
    sourceArtifactDigests: [...sourceArtifactDigests].sort(),
    gateEvidenceArtifactDigests: [...gateEvidenceArtifactDigests].sort(),
    reviewPromptArtifacts });
}

const evidence = loadMeasuredTokenizerEvidence();
const approval = {
  approvalVersion: "corpus-approval-v1",
  decision: "candidate-for-independent-inspection",
  trainingAuthorized: false,
  inspectedGitCommit,
  measuredTemplateEvidenceDigest: evidence.bundleDigest,
  validators,
  implementationArtifacts,
  runs,
  records,
};
writeFileSync(outPath, stableStringify(approval, 2) + "\n", { flag: "w" });
process.stdout.write(stableStringify({
  outPath, fileDigest: hash(readFileSync(outPath)), inspectedGitCommit,
  runs: runs.length, records: records.length,
  trainLabels: records.reduce((sum, record) => sum + record.labels, 0),
  validators: Object.keys(validators).length,
  sourceArtifactDigests: runs.reduce((sum, run) => sum + run.sourceArtifactDigests.length, 0),
  reviewPromptArtifacts: runs.reduce((sum, run) => sum + Object.keys(run.reviewPromptArtifacts).length, 0),
}, 2) + "\n");
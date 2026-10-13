/**
 * Freeze a prose-measurement ledger from recorded blinded judgments and derive
 * the measured report under an independently supplied ledger digest.
 *
 * The manifest maps each frozen packet's opaque sampleId to the raw judgment file
 * and the exact fresh grader session that produced it. A complete, one-session-
 * per-sample census is required: this refuses partial or reused-context judging.
 *
 * Never dispatches a provider request. Writes the ledger and report exactly once.
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/freezeProseLedger.ts <runId> <manifest.json>
 *
 * manifest.json:
 *   [ { "sampleId": "...", "rawPath": "/abs/path/judgment.json", "sessionId": "ses_..." }, ... ]
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../src/spec.js";
import {
  loadMeasuredProseEvidence, proseArtifactDigest,
  type ProseInventory, type ProseMeasurementLedger,
} from "../src/proseMeasurement.js";

interface ContextEntry { sampleId: string; rawPath: string; sessionId: string }

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runId = process.argv[2];
const manifestPath = process.argv[3];
if (!runId || !manifestPath) throw new Error("usage: freezeProseLedger.ts <runId> <manifest.json>");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ContextEntry[];
const root = join(repositoryRoot, ".dataset", "measurements", runId);
const inventory = JSON.parse(readFileSync(join(root, "prose-inventory.json"), "utf8")) as ProseInventory;

if (manifest.length !== inventory.packets.length
  || new Set(manifest.map((entry) => entry.sessionId)).size !== manifest.length) {
  throw new Error("complete fresh-context judging census required");
}

const judgments = inventory.packets.map((packet) => {
  const entry = manifest.find((candidate) => candidate.sampleId === packet.sampleId);
  if (!entry) throw new Error("missing packet context binding");
  const rawResponse = readFileSync(entry.rawPath, "utf8");
  if ((JSON.parse(rawResponse) as { sampleId: string }).sampleId !== packet.sampleId) {
    throw new Error("raw judgment sample mismatch");
  }
  return {
    packetDigest: proseArtifactDigest(packet), rawResponse,
    grader: {
      provider: "openai", model: "gpt-6-astra", revision: "not-exposed",
      sessionId: entry.sessionId, judgedAt: statSync(entry.rawPath).mtime.toISOString(),
    },
  };
});

const ledger: ProseMeasurementLedger = { inventory, judgments, parity: [] };
const ledgerDigest = proseArtifactDigest(ledger);
const { report } = loadMeasuredProseEvidence(ledger, ledgerDigest);
writeFileSync(join(root, "prose-ledger.json"), stableStringify(ledger, 2) + "\n", { flag: "wx" });
writeFileSync(join(root, "prose-report.json"), stableStringify(report, 2) + "\n", { flag: "wx" });
console.log(stableStringify({ ledgerDigest, report, ledgerPath: join(root, "prose-ledger.json") }, 2));
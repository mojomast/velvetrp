/**
 * Render the admitted creative conversations from a run as readable transcripts
 * for independent creative review.
 *
 * The raw training surface is JSON, which a style judge cannot assess. This
 * renders the same turns as plain dialogue with the character card and setting
 * for context, and keeps the mechanical record separate.
 *
 * Usage: npx tsx dataset/scripts/renderCreativeSample.ts <runId> [outDir]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../src/spec.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runId = process.argv[2];
if (!runId) throw new Error("usage: renderCreativeSample.ts <runId> [outDir]");
const outDir = process.argv[3] ?? join(repositoryRoot, ".dataset", "measurements", runId, "creative-sample");
mkdirSync(outDir, { recursive: true });

const journal = join(repositoryRoot, ".dataset", "runs", runId, "pipeline");
const reportFile = readdirSync(journal).find((name) => {
  const wrapper = JSON.parse(readFileSync(join(journal, name), "utf8")) as { key: string };
  return wrapper.key.startsWith("report:");
});
if (!reportFile) throw new Error("no report checkpoint");
const report = JSON.parse(readFileSync(join(journal, reportFile), "utf8")).value as {
  unitOutcomes: Array<{ unitId: string; admittedRecord?: {
    recordId: string; split: string; messages: Array<{ role: string; content: string }>;
    targetSelection: { supervisedAssistantIndices: number[] };
  } }>;
};

const rendered = [];
for (const unit of report.unitOutcomes) {
  const record = unit.admittedRecord;
  if (!record) continue;
  const supervised = new Set(record.targetSelection.supervisedAssistantIndices);
  const lines = record.messages.map((message, index) => {
    const who = message.role === "assistant" ? "CHARACTER" : message.role === "user" ? "PLAYER" : "SETUP";
    const mark = supervised.has(index) ? " [trained target]" : "";
    return `${who}${mark}: ${message.content}`;
  });
  const text = lines.join("\n\n");
  rendered.push({ recordId: record.recordId, unitId: unit.unitId, split: record.split, text });
  writeFileSync(join(outDir, `${record.recordId}.txt`), `${text}\n`, { flag: "w" });
}
writeFileSync(join(outDir, "index.json"), stableStringify(rendered.map(({ recordId, unitId, split }) => ({ recordId, unitId, split })), 2) + "\n", { flag: "w" });
process.stdout.write(stableStringify({ runId, rendered: rendered.length, outDir,
  totalChars: rendered.reduce((sum, item) => sum + item.text.length, 0) }, 2) + "\n");
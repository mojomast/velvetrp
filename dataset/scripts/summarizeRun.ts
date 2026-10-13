/**
 * Summarize one completed calibration run from its durable journal.
 *
 * Verifies every checkpoint envelope digest, then reports planning, attempts,
 * admissions, independent review, bounded repairs, measured supervised labels,
 * and refusal reasons taken from the immutable event log (not from failed
 * validator rows, which can undercount stage refusals that never run a validator).
 *
 * Never dispatches a provider request. Writes exactly once.
 *
 * Usage (from the repository root):
 *   npx tsx dataset/scripts/summarizeRun.ts <runId> [outputName.json]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../src/spec.js";
import { isReviewScores, parseReviewScores } from "../src/generate.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const runId = process.argv[2] ?? "calibration-2026-10-13-v1";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const root = join(repositoryRoot, ".dataset", "runs", runId, "pipeline");

interface ReportUnitOutcome {
  unitId: string;
  family: string;
  refusedAt?: string | null;
  admittedAttemptId?: string;
  admittedRecord?: { provenance: { tokenCount: { tokens: number } } };
}
interface RunReport {
  generatorModel: string; reviewerModel: string; planDigest: string; units: number;
  attempts: number; admitted: number; selected: number; complete: boolean;
  budget: { supervisedTokens: number; byTarget: Record<string, number>; tokenizer: string; cap: number };
  unitOutcomes: ReportUnitOutcome[];
  unmeasuredAttemptIds: string[];
  diversity: unknown;
}

const entries = new Map<string, unknown>();
for (const file of readdirSync(root).filter((name) => name.endsWith(".json"))) {
  const wrapper = JSON.parse(readFileSync(join(root, file), "utf8")) as { key: string; digest: string; value: unknown };
  if (file !== `${hash(wrapper.key)}.json` || wrapper.digest !== hash(stableStringify(wrapper.value))) {
    throw new Error("journal checksum mismatch");
  }
  entries.set(wrapper.key, wrapper.value);
}

const binding = entries.get("binding") as { gitCommit: string };
const reports = [...entries].filter(([key]) => key.startsWith("report:")).map(([, value]) => value as RunReport);
if (reports.length !== 1) throw new Error(`expected one calibration report, found ${reports.length}`);
const report = reports[0]!;

interface FamilyCohort {
  planned: number; attempts: number; parsed: number; reachedIndependentReview: number;
  reviewAccepted: number; initialAdmitted: number; admitted: number; selected: number;
}
const emptyCohort = (): FamilyCohort => ({
  planned: 0, attempts: 0, parsed: 0, reachedIndependentReview: 0,
  reviewAccepted: 0, initialAdmitted: 0, admitted: 0, selected: 0,
});
const counts = new Map<string, FamilyCohort>();
const cohortFor = (family: string): FamilyCohort => {
  const existing = counts.get(family);
  if (existing) return existing;
  const created = emptyCohort();
  counts.set(family, created);
  return created;
};
const problems: Record<string, number> = {};
let dispatched = 0; let physicalPosts = 0; let capturedResponses = 0;
let repairs = 0; let initialParsed = 0; let parsed = 0; let validated = 0; let reviewAccepted = 0;

for (const [key, value] of entries) {
  if (key.startsWith("dispatch:")) dispatched += 1;
  if (key.startsWith("physical:")) physicalPosts += 1;
  if (key.startsWith("response:")) capturedResponses += 1;
  if (key.startsWith("validation:")) {
    const validation = value as { scenarioSpec: { family: string }; stages: { parsed: boolean }; runs: Array<{ validator: string; passed: boolean }> };
    const family = validation.scenarioSpec.family;
    const cohort = cohortFor(family);
    cohort.attempts += 1;
    const initial = key.endsWith("-a0");
    if (!initial) repairs += 1;
    if (validation.stages.parsed) { parsed += 1; cohort.parsed += 1; if (initial) initialParsed += 1; }
    if (entries.has(`dispatch:${key.slice("validation:".length)}-review`)) { validated += 1; cohort.reachedIndependentReview += 1; }
    for (const run of validation.runs) if (!run.passed) problems[run.validator] = (problems[run.validator] ?? 0) + 1;
    const id = key.slice("validation:".length);
    // Count reviews through the PRODUCTION contract and parser, not by a naive
    // JSON.parse. A contract records the retry attempts and whether the final one
    // was usable; a fenced or otherwise contract-repaired review is valid, and an
    // unusable one must never be reported as accepted.
    const contract = entries.get(`review-contract:${id}`) as { attempts?: string[]; usable?: boolean } | undefined;
    if (contract && contract.usable !== true) {
      problems["review-contract-unusable"] = (problems["review-contract-unusable"] ?? 0) + 1;
    } else {
      const lastAttemptId = contract?.attempts?.at(-1) ?? `${id}-review`;
      const review = entries.get(`response:${lastAttemptId}`) as { content?: string } | undefined;
      if (review) {
        const decoded = parseReviewScores(review.content ?? "");
        if (isReviewScores(decoded)) {
          if (decoded.verdict === "accept" || decoded.verdict === "accept-with-notes") {
            reviewAccepted += 1;
            cohort.reviewAccepted += 1;
          }
        } else {
          problems["review-json-unusable"] = (problems["review-json-unusable"] ?? 0) + 1;
        }
      }
    }
  }
}
for (const unit of report.unitOutcomes) {
  const cohort = cohortFor(unit.family);
  cohort.planned += 1;
  if (unit.admittedRecord) { cohort.admitted += 1; if ((unit.admittedAttemptId ?? "").endsWith("-a0")) cohort.initialAdmitted += 1; }
  if (unit.refusedAt) problems[`terminal:${unit.refusedAt}`] = (problems[`terminal:${unit.refusedAt}`] ?? 0) + 1;
}
for (const id of ((entries.get("selection") as { selectedUnitIds?: string[] } | undefined)?.selectedUnitIds ?? [])) {
  const unit = report.unitOutcomes.find((candidate) => candidate.unitId === id);
  if (unit) cohortFor(unit.family).selected += 1;
}

// Stage failures need not have a failed validator row (for example a mixed
// narration-transport refusal). Count actual immutable attempt reasons from the
// durable event log instead, keeping validator-row diagnostics separate.
const attemptFailures: Record<string, number> = {};
const seenReasons = new Set<string>();
const events = readFileSync(join(root, "..", "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { events?: Array<{ type: string; attemptId: string; reasons?: string[] }> });
for (const transaction of events) for (const event of transaction.events ?? []) {
  if (event.type !== "attempt.registered") continue;
  for (const reason of event.reasons ?? []) {
    const identity = `${event.attemptId}:${reason}`;
    if (seenReasons.has(identity)) continue;
    seenReasons.add(identity);
    attemptFailures[reason] = (attemptFailures[reason] ?? 0) + 1;
  }
}

const admittedLabelTokens = report.unitOutcomes.reduce((sum, unit) => sum + (unit.admittedRecord?.provenance.tokenCount.tokens ?? 0), 0);
const summary = {
  runId, generator: report.generatorModel, reviewer: report.reviewerModel, gitCommit: binding.gitCommit,
  planDigest: report.planDigest, bindingDigest: hash(stableStringify(binding)), reportDigest: hash(stableStringify(report)),
  planned: report.units, attempts: report.attempts, admitted: report.admitted, selected: report.selected,
  complete: report.complete, byFamily: Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))),
  dispatches: dispatched, physicalPosts,
  capturedLogicalResponses: capturedResponses, repairs,
  parsing: { initialParsed, parsed, denominatorInitial: report.units, denominatorAttempts: report.attempts },
  reachedIndependentReview: validated, reviewAccepted,
  refusalReasons: attemptFailures, validatorFailureCounts: problems,
  budget: report.budget,
  labelAccounting: {
    allAttemptSpend: report.budget.supervisedTokens, admitted: admittedLabelTokens,
    refused: report.budget.supervisedTokens - admittedLabelTokens,
  },
  unmeasuredAttemptIds: report.unmeasuredAttemptIds, diversity: report.diversity,
  selectionDigest: (entries.get("selection") as { digest?: string } | undefined)?.digest ?? null,
  notes: [
    "Actual teacher/reviewer outputs, not fixture scores.",
    "Parser and deterministic yields do not imply independent semantic correctness or prose quality.",
    "Generated-data quality does not measure student retention.",
  ],
};
const output = join(repositoryRoot, ".dataset", "measurements", runId, process.argv[3] ?? "summary.json");
mkdirSync(join(output, ".."), { recursive: true });
writeFileSync(output, stableStringify(summary, 2) + "\n", { flag: "wx" });
console.log(stableStringify(summary, 2));
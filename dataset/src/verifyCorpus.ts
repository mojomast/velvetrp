/**
 * Corpus verifier — the committed entry point for content integrity.
 *
 * Replaces the ad-hoc `devCaseIdListDigest`, which existed only inside two
 * documents with no implementation and could not be independently reproduced.
 *
 * What it checks:
 *  1. Every dev case file matches the SHA-256 recorded in CORPUS_FINGERPRINT.json.
 *  2. The recorded dev case count matches the cases actually present.
 *  3. The recorded case-ID list digest recomputes from the cases on disk.
 *  4. The frozen corpus identity recomputes and matches `freeze.json`.
 *  5. Lineage stays disjoint per field across splits.
 *
 * Exits non-zero on any drift. No network, no provider.
 *
 *   npm exec -- tsx dataset/src/verifyCorpus.ts
 *   npm exec -- tsx dataset/src/verifyCorpus.ts --sealed-source /path/to/sealed-cases
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLineageDisjoint, verifyFreeze } from "./freeze.js";

const CORPUS_ROOT = resolve(process.cwd(), "dataset/eval/corpus");
const FINGERPRINT_PATH = join(CORPUS_ROOT, "..", "CORPUS_FINGERPRINT.json");
const DEV_DIR = join(CORPUS_ROOT, "dev-cases");

interface Fingerprint {
  corpusVersion: string;
  devFileSha256: Record<string, string>;
  devCaseIdListDigest: string;
  devCaseCount: number;
  foundryCorpusDigest: string;
}

export interface VerificationProblem {
  check: string;
  detail: string;
}

export interface VerificationReport {
  ok: boolean;
  corpusVersion: string;
  devCaseCount: number;
  devCaseIdListDigest: string;
  foundryCorpusDigest: string;
  problems: VerificationProblem[];
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/**
 * Digest over the sorted dev case ids.
 *
 * Algorithm-independent by construction: it is a plain SHA-256 over newline-joined
 * sorted ids, so any implementation reproduces it. Sorting makes it insensitive
 * to file iteration order.
 */
export function computeDevCaseIdListDigest(devDir: string): { digest: string; count: number; ids: string[] } {
  const ids: string[] = [];
  for (const file of readdirSync(devDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const doc = JSON.parse(readFileSync(join(devDir, file), "utf8")) as { cases?: Array<{ id?: string }> };
    for (const item of doc.cases ?? []) if (typeof item.id === "string") ids.push(item.id);
  }
  ids.sort();
  return { digest: sha256(ids.join("\n")), count: ids.length, ids };
}

export function verifyCorpus(options: { sealedSource?: string | undefined } = {}): VerificationReport {
  const problems: VerificationProblem[] = [];

  if (!existsSync(FINGERPRINT_PATH)) {
    return {
      ok: false, corpusVersion: "unknown", devCaseCount: 0, devCaseIdListDigest: "",
      foundryCorpusDigest: "", problems: [{ check: "fingerprint", detail: `missing ${FINGERPRINT_PATH}` }],
    };
  }
  const fingerprint = JSON.parse(readFileSync(FINGERPRINT_PATH, "utf8")) as Fingerprint;

  // 1. Per-file checksums.
  for (const [path, expected] of Object.entries(fingerprint.devFileSha256)) {
    const full = join(CORPUS_ROOT, path);
    if (!existsSync(full)) {
      problems.push({ check: "file-checksum", detail: `missing dev case file: ${path}` });
      continue;
    }
    const actual = sha256(readFileSync(full));
    if (actual !== expected) problems.push({ check: "file-checksum", detail: `checksum mismatch: ${path}` });
  }

  // 2/3. Case count and reproducible case-id digest.
  const recomputed = computeDevCaseIdListDigest(DEV_DIR);
  if (recomputed.count !== fingerprint.devCaseCount) {
    problems.push({ check: "case-count", detail: `expected ${fingerprint.devCaseCount} dev cases, found ${recomputed.count}` });
  }
  if (recomputed.digest !== fingerprint.devCaseIdListDigest) {
    problems.push({
      check: "case-id-digest",
      detail: `case-id digest ${recomputed.digest} != recorded ${fingerprint.devCaseIdListDigest}`,
    });
  }

  // 4. Frozen corpus identity, recomputed rather than trusted.
  const freeze = verifyFreeze(CORPUS_ROOT, {
    expectedDigest: fingerprint.foundryCorpusDigest,
    ...(options.sealedSource ? { sealedSource: options.sealedSource } : {}),
  });
  for (const problem of freeze.problems) problems.push({ check: "freeze", detail: problem });

  // 5. Lineage disjointness, recomputed from the freeze.
  if (existsSync(join(CORPUS_ROOT, "freeze.json"))) {
    const freezeDoc = JSON.parse(readFileSync(join(CORPUS_ROOT, "freeze.json"), "utf8")) as Parameters<typeof assertLineageDisjoint>[0];
    const disjoint = assertLineageDisjoint(freezeDoc);
    for (const violation of disjoint.violations) problems.push({ check: "lineage", detail: violation });
  }

  return {
    ok: problems.length === 0,
    corpusVersion: fingerprint.corpusVersion,
    devCaseCount: recomputed.count,
    devCaseIdListDigest: recomputed.digest,
    foundryCorpusDigest: freeze.corpusDigest,
    problems,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sealedIndex = process.argv.indexOf("--sealed-source");
  const sealedSource = sealedIndex >= 0 ? process.argv[sealedIndex + 1] : undefined;
  const report = verifyCorpus({ ...(sealedSource ? { sealedSource } : {}) });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

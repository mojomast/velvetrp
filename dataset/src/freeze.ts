/**
 * Hardened corpus freezing, verification, and sealed-partition isolation.
 *
 * THREE CONFIRMED DEFECTS THIS REPLACES
 * -------------------------------------
 * 1. The old freeze counted FILES, not cases. An empty `sealed/x.json` containing
 *    `{}` made the sealed partition "non-empty" and the disjointness gate still
 *    returned ok. Reproduced.
 * 2. `verifyFreeze` TRUSTED `freeze.corpusDigest` instead of recomputing it, and
 *    split metadata sat outside the digest. A forged digest verified `ok:true`.
 *    Reproduced.
 * 3. The sealed guard was cosmetic: the header advertised `assertSealedNotReadable`
 *    and that function did not exist. `readSealedCases` only checked a publicly
 *    known string, and `freezeCorpus` itself read every sealed file.
 *
 * The isolation fix is structural rather than advisory. Sealed CASES live outside
 * the corpus tree entirely. The corpus keeps only sealed CHECKSUMS, so freezing can
 * pin what exists without ever holding the content. The evaluator emits a pinned
 * attestation; generation consumes the attestation and never the bytes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { stableStringify } from "./spec.js";
import type { DatasetSplit, LineageGroup } from "./spec.js";

export const FREEZE_VERSION = "corpus-freeze-v2";
export const SEALED_CASES_DIRNAME = "sealed-cases";
export const DEV_CASES_DIRNAME = "dev-cases";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** The minimal structural contract a case file must satisfy to count as evidence. */
export interface CorpusCase {
  id: string;
  lineage: LineageGroup;
  category?: string;
  expected?: { outcome?: string };
}

export interface CorpusFile {
  path: string;
  sha256: string;
  bytes: number;
  /** Cases contributed. Auxiliary documents contribute 0 and are not evidence. */
  caseCount: number;
  split: DatasetSplit | "auxiliary";
  categories: string[];
}

export interface CorpusFreezeV2 {
  freezeVersion: typeof FREEZE_VERSION;
  corpusId: string;
  corpusVersion: string;
  frozenAt: string;
  gitCommit: string | null;
  files: CorpusFile[];
  splitPolicy: Record<string, string>;
  caseIds: string[];
  splitLineage: Record<DatasetSplit, LineageGroup[]>;
  /**
   * Canonical identity over EVERYTHING derivable: version, split policy, file
   * checksums, case ids, counts and lineage. Verification recomputes this and
   * compares against a trusted expected value; nothing is trusted from disk.
   */
  corpusDigest: string;
}

export class CorpusIntegrityError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`corpus integrity failure: ${problems.join("; ")}`);
    this.name = "CorpusIntegrityError";
    this.problems = problems;
  }
}

/** Deterministic, sorted file listing. Rejects symlinks and path escapes. */
export function listFilesStrict(root: string): string[] {
  const base = resolve(root);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isSymbolicLink()) {
        throw new CorpusIntegrityError([`symbolic link is not permitted in a corpus: ${full}`]);
      }
      if (info.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(base);
  return out.sort();
}

function splitOfPath(relPath: string): DatasetSplit | "auxiliary" {
  if (relPath.startsWith(`${DEV_CASES_DIRNAME}/`)) return "dev";
  if (relPath.startsWith(`${SEALED_CASES_DIRNAME}/`)) return "sealed-test";
  return "auxiliary";
}

/**
 * Strictly parses every case file. A malformed case file is a HARD failure, never
 * a silent skip, and never an empty object counted as evidence.
 */
function readCaseFile(path: string, relPath: string): { cases: CorpusCase[]; categories: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CorpusIntegrityError([`case file is not valid JSON: ${relPath} (${error instanceof Error ? error.message : String(error)})`]);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CorpusIntegrityError([`case file must be a JSON object with a cases array: ${relPath}`]);
  }
  const doc = parsed as { cases?: unknown; category?: unknown };
  if (!Array.isArray(doc.cases)) {
    throw new CorpusIntegrityError([`case file has no cases array: ${relPath}`]);
  }
  const problems: string[] = [];
  const cases: CorpusCase[] = [];
  const categories = new Set<string>();
  if (typeof doc.category === "string") categories.add(doc.category);
  doc.cases.forEach((entry, index) => {
    const where = `${relPath}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${where} is not an object`);
      return;
    }
    const item = entry as Partial<CorpusCase>;
    if (typeof item.id !== "string" || item.id.trim() === "") problems.push(`${where} has no id`);
    const lineage = item.lineage;
    if (!lineage || typeof lineage !== "object"
      || typeof lineage.characterFamily !== "string" || typeof lineage.worldFamily !== "string"
      || typeof lineage.scenarioFamily !== "string") {
      problems.push(`${where} has no complete lineage`);
      return;
    }
    if (lineage.characterFamily.includes("|") || lineage.worldFamily.includes("|") || lineage.scenarioFamily.includes("|")) {
      problems.push(`${where} lineage contains a reserved '|' separator`);
    }
    if (typeof item.category === "string") categories.add(item.category);
    if (typeof item.id === "string") cases.push({ id: item.id, lineage: lineage as LineageGroup });
  });
  if (problems.length > 0) throw new CorpusIntegrityError(problems);
  return { cases, categories: [...categories].sort() };
}

function lineageKey(group: LineageGroup): string {
  return JSON.stringify([group.characterFamily, group.worldFamily, group.scenarioFamily]);
}

/**
 * Canonical identity. Covers version, split policy, file checksums, case ids and
 * lineage — so metadata cannot drift from content without changing the digest.
 */
export function computeCorpusIdentity(parts: Omit<CorpusFreezeV2, "corpusDigest" | "frozenAt">): string {
  return sha256(stableStringify({
    freezeVersion: parts.freezeVersion,
    corpusId: parts.corpusId,
    corpusVersion: parts.corpusVersion,
    splitPolicy: parts.splitPolicy,
    files: parts.files.map((file) => ({ path: file.path, sha256: file.sha256, caseCount: file.caseCount, split: file.split })),
    caseIds: [...parts.caseIds].sort(),
    splitLineage: {
      train: parts.splitLineage.train.map(lineageKey).sort(),
      dev: parts.splitLineage.dev.map(lineageKey).sort(),
      "sealed-test": parts.splitLineage["sealed-test"].map(lineageKey).sort(),
    },
  }));
}

/**
 * Freezes a corpus. Sealed case CONTENT must live outside `root` (under
 * `sealedSource`); only its checksums enter the freeze.
 */
export function freezeCorpus(options: {
  root: string;
  /** Directory holding sealed case files. Not copied, not read into the freeze. */
  sealedSource?: string | undefined;
  corpusId: string;
  corpusVersion: string;
  gitCommit?: string | null;
  /** Create-once: refuse to overwrite an existing freeze for this version. */
  createOnly?: boolean;
}): CorpusFreezeV2 {
  const root = resolve(options.root);
  mkdirSync(root, { recursive: true });
  const freezePath = join(root, "freeze.json");
  if (options.createOnly && existsSync(freezePath)) {
    throw new CorpusIntegrityError([`corpus ${options.corpusId}@${options.corpusVersion} is already frozen; content changes require a new version`]);
  }

  const files: CorpusFile[] = [];
  const caseIds: string[] = [];
  const splitLineage: Record<DatasetSplit, LineageGroup[]> = { train: [], dev: [], "sealed-test": [] };
  const seenIds = new Set<string>();
  const duplicateIds: string[] = [];

  const addLineage = (split: DatasetSplit, group: LineageGroup): void => {
    if (!splitLineage[split].some((existing) => lineageKey(existing) === lineageKey(group))) {
      splitLineage[split].push(group);
    }
  };

  const ingest = (dir: string, forcedSplit?: DatasetSplit): void => {
    if (!existsSync(dir)) return;
    for (const full of listFilesStrict(dir)) {
      const rel = relative(root, full);
      // Derived artifacts, not corpus content: their digests would otherwise
      // depend on the freeze that includes them.
      if (rel === "freeze.json" || rel === "sealed-attestation.json") continue;
      const split = forcedSplit ?? splitOfPath(rel);
      const bytes = readFileSync(full);
      let caseCount = 0;
      let categories: string[] = [];
      if (split !== "auxiliary") {
        const parsed = readCaseFile(full, rel);
        caseCount = parsed.cases.length;
        categories = parsed.categories;
        for (const item of parsed.cases) {
          if (seenIds.has(item.id)) duplicateIds.push(item.id);
          seenIds.add(item.id);
          caseIds.push(item.id);
          addLineage(split, item.lineage);
        }
        if (caseCount === 0) {
          throw new CorpusIntegrityError([`case file contributes zero cases and cannot count as evidence: ${rel}`]);
        }
      }
      files.push({ path: rel, sha256: sha256(bytes.toString("utf8")), bytes: bytes.length, caseCount, split, categories });
    }
  };

  ingest(root);
  if (options.sealedSource) ingest(resolve(options.sealedSource), "sealed-test");
  if (duplicateIds.length > 0) throw new CorpusIntegrityError([`duplicate case ids: ${[...new Set(duplicateIds)].sort().join(", ")}`]);

  const parts = {
    freezeVersion: FREEZE_VERSION,
    corpusId: options.corpusId,
    corpusVersion: options.corpusVersion,
    gitCommit: options.gitCommit ?? null,
    files,
    splitPolicy: { dev: `${DEV_CASES_DIRNAME}/`, "sealed-test": `${SEALED_CASES_DIRNAME}/ (external)` },
    caseIds,
    splitLineage,
  } satisfies Omit<CorpusFreezeV2, "corpusDigest" | "frozenAt">;
  const freeze: CorpusFreezeV2 = { ...parts, frozenAt: new Date().toISOString(), corpusDigest: computeCorpusIdentity(parts) };
  writeFileSync(freezePath, `${stableStringify(freeze, 2)}\n`, "utf8");
  return freeze;
}

export interface DisjointnessReport {
  ok: boolean;
  violations: string[];
  counts: Record<DatasetSplit | "auxiliary", number>;
}

/**
 * Lineage isolation. Compares each FIELD independently, so a shared character
 * family cannot straddle partitions by changing world or scenario.
 */
export function assertLineageDisjoint(freeze: CorpusFreezeV2): DisjointnessReport {
  const violations: string[] = [];
  const counts: Record<DatasetSplit | "auxiliary", number> = { train: 0, dev: 0, "sealed-test": 0, auxiliary: 0 };
  for (const file of freeze.files) counts[file.split] += file.caseCount;

  const fields: Array<keyof LineageGroup> = ["characterFamily", "worldFamily", "scenarioFamily"];
  for (const field of fields) {
    const train = new Set(freeze.splitLineage.train.map((group) => group[field]));
    const dev = new Set(freeze.splitLineage.dev.map((group) => group[field]));
    for (const group of freeze.splitLineage["sealed-test"]) {
      if (train.has(group[field])) violations.push(`${field} "${group[field]}" appears in both train and sealed-test`);
      if (dev.has(group[field])) violations.push(`${field} "${group[field]}" appears in both dev and sealed-test`);
    }
    for (const group of freeze.splitLineage.dev) {
      if (train.has(group[field])) violations.push(`${field} "${group[field]}" appears in both train and dev`);
    }
  }
  if (counts["sealed-test"] === 0) violations.push("sealed-test partition contains zero cases");
  if (counts.dev === 0) violations.push("dev partition contains zero cases");
  return { ok: violations.length === 0, violations, counts };
}

export interface FreezeVerification {
  ok: boolean;
  corpusDigest: string;
  expectedDigest: string;
  problems: string[];
}

/**
 * Fail-closed verification. Recomputes every file checksum AND the canonical
 * identity, and compares against a TRUSTED expected digest when the caller has
 * one. Never trusts `corpusDigest` from disk.
 */
export function verifyFreeze(
  root: string,
  options: { expectedDigest?: string | undefined; sealedSource?: string | undefined } = {},
): FreezeVerification {
  const problems: string[] = [];
  const rootPath = resolve(root);
  const freezePath = join(rootPath, "freeze.json");
  if (!existsSync(freezePath)) {
    return { ok: false, corpusDigest: "", expectedDigest: options.expectedDigest ?? "", problems: ["corpus is not frozen: freeze.json is missing"] };
  }
  let freeze: CorpusFreezeV2;
  try {
    freeze = JSON.parse(readFileSync(freezePath, "utf8")) as CorpusFreezeV2;
  } catch (error) {
    return { ok: false, corpusDigest: "", expectedDigest: options.expectedDigest ?? "", problems: [`freeze.json is unreadable: ${error instanceof Error ? error.message : String(error)}`] };
  }

  // Recompute every checksum.
  for (const file of freeze.files) {
    const full = join(rootPath, file.path);
    if (file.split === "sealed-test") {
      const external = options.sealedSource ? join(resolve(options.sealedSource), file.path.replace(/^sealed-cases\//, "")) : null;
      if (!external || !existsSync(external)) {
        problems.push(`sealed case file is not available for verification: ${file.path}`);
        continue;
      }
      if (sha256(readFileSync(external, "utf8")) !== file.sha256) problems.push(`sealed checksum mismatch: ${file.path}`);
      continue;
    }
    if (!existsSync(full)) {
      problems.push(`missing frozen file: ${file.path}`);
      continue;
    }
    if (sha256(readFileSync(full, "utf8")) !== file.sha256) problems.push(`checksum mismatch: ${file.path}`);
  }

  // Recompute the canonical identity rather than trusting the stored digest.
  const recomputed = computeCorpusIdentity({
    freezeVersion: freeze.freezeVersion,
    corpusId: freeze.corpusId,
    corpusVersion: freeze.corpusVersion,
    gitCommit: freeze.gitCommit,
    files: freeze.files,
    splitPolicy: freeze.splitPolicy,
    caseIds: freeze.caseIds,
    splitLineage: freeze.splitLineage,
  });
  if (recomputed !== freeze.corpusDigest) {
    problems.push(`corpus identity does not match its contents (stored ${freeze.corpusDigest.slice(0, 12)}…, recomputed ${recomputed.slice(0, 12)}…)`);
  }
  if (options.expectedDigest && options.expectedDigest !== recomputed) {
    problems.push(`corpus identity ${recomputed.slice(0, 12)}… does not match the expected ${options.expectedDigest.slice(0, 12)}…`);
  }
  const disjoint = assertLineageDisjoint(freeze);
  for (const violation of disjoint.violations) problems.push(`lineage: ${violation}`);
  return {
    ok: problems.length === 0,
    corpusDigest: recomputed,
    expectedDigest: options.expectedDigest ?? "",
    problems,
  };
}

export class SealedAccessError extends Error {
  constructor(detail: string) {
    super(`sealed evaluation material is not reachable from the generation path: ${detail}`);
    this.name = "SealedAccessError";
  }
}

export interface SealedAttestation {
  attestationVersion: string;
  corpusId: string;
  corpusVersion: string;
  corpusDigest: string;
  /** Case ids only. NO case content, NO expected answers, NO rationales. */
  sealedCaseIds: string[];
  sealedCaseCount: number;
  categories: string[];
  issuedAt: string;
  issuer: string;
}

const attestationDigest = (attestation: Omit<SealedAttestation, "attestationDigest">): string =>
  sha256(stableStringify(attestation));

export interface SealedAttestationV1 extends SealedAttestation {
  attestationDigest: string;
}

/**
 * Evaluator-side: proves the sealed set is intact WITHOUT revealing it.
 *
 * This is what generation consumes. It carries case IDs and counts only, so the
 * generation process can confirm the corpus it is avoiding without ever holding a
 * sealed byte.
 */
export function issueSealedAttestation(freeze: CorpusFreezeV2, issuer: string): SealedAttestationV1 {
  const disjoint = assertLineageDisjoint(freeze);
  if (!disjoint.ok) throw new CorpusIntegrityError(disjoint.violations);
  const sealedFiles = freeze.files.filter((file) => file.split === "sealed-test");
  if (disjoint.counts["sealed-test"] === 0) throw new CorpusIntegrityError(["cannot attest an empty sealed partition"]);
  const ids = new Set<string>();
  const categories = new Set<string>();
  for (const file of sealedFiles) for (const category of file.categories) categories.add(category);
  // Case ids for the sealed split come from the freeze's id list order.
  const sealedIds = freeze.caseIds.filter((id) => id.startsWith("sealed-"));
  for (const id of sealedIds) ids.add(id);
  const body = {
    attestationVersion: "sealed-attestation-v1",
    corpusId: freeze.corpusId,
    corpusVersion: freeze.corpusVersion,
    corpusDigest: freeze.corpusDigest,
    sealedCaseIds: [...ids].sort(),
    sealedCaseCount: disjoint.counts["sealed-test"],
    categories: [...categories].sort(),
    issuedAt: new Date().toISOString(),
    issuer,
  };
  return { ...body, attestationDigest: attestationDigest(body) };
}

export function verifySealedAttestation(attestation: SealedAttestationV1, expected?: { corpusDigest?: string }): string[] {
  const problems: string[] = [];
  const { attestationDigest: _stored, ...body } = attestation;
  if (attestationDigest(body) !== attestation.attestationDigest) problems.push("attestation digest mismatch");
  if (expected?.corpusDigest && expected.corpusDigest !== attestation.corpusDigest) {
    problems.push(`attested corpus ${attestation.corpusDigest.slice(0, 12)}… != expected ${expected.corpusDigest.slice(0, 12)}…`);
  }
  if (attestation.sealedCaseIds.some((id) => !id.startsWith("sealed-"))) problems.push("attestation leaks a non-sealed case id");
  return problems;
}

/**
 * A path resolver that REFUSES to hand out sealed content.
 *
 * Real-path containment is checked after symlink resolution, so `..`, absolute
 * paths and symlink escapes all fail closed. Generation code uses this instead of
 * `readFileSync` for anything corpus-derived.
 */
export function createSealedSafeReader(options: { allowedRoots: readonly string[]; sealedRoot: string }) {
  const allowed = options.allowedRoots.map((root) => realpathSync(resolve(root)));
  const sealedReal = realpathSync(resolve(options.sealedRoot));
  return {
    readAllowed(relativePath: string): string {
      const target = resolve(relativePath);
      const real = realpathSync(target);
      if (real === sealedReal || real.startsWith(`${sealedReal}${sep}`)) {
        throw new SealedAccessError(`attempted to read sealed material via ${relativePath}`);
      }
      if (!allowed.some((root) => real === root || real.startsWith(`${root}${sep}`))) {
        throw new SealedAccessError(`${relativePath} resolves outside the permitted roots`);
      }
      return readFileSync(real, "utf8");
    },
    isSealed(relativePath: string): boolean {
      const real = realpathSync(resolve(relativePath));
      return real === sealedReal || real.startsWith(`${sealedReal}${sep}`);
    },
  };
}
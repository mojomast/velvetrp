/**
 * Corpus freezing entry point and CLI.
 *
 * Sealed case content lives OUTSIDE the repository (default
 * `/tmp/opencode/sintermark-sealed-cases/sealed-cases`) because the generation
 * workflow must never be able to read it. The committed corpus holds the dev
 * cases plus the sealed CHECKSUMS, which is enough to pin identity and to prove
 * lineage disjointness without holding a sealed byte.
 *
 * Usage:
 *   npm exec -- tsx dataset/src/corpus.ts freeze [--sealed-source DIR] [--create-only]
 *   npm exec -- tsx dataset/src/corpus.ts verify [--sealed-source DIR] [--expect DIGEST]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { assertLineageDisjoint, freezeCorpus, verifyFreeze, issueSealedAttestation, verifySealedAttestation } from "./freeze.js";
import type { CorpusFreezeV2 } from "./freeze.js";

export const CORPUS_ROOT = resolve(process.cwd(), "dataset/eval/corpus");
export const SEALED_SOURCE = process.env.FOUNDRY_SEALED_SOURCE ?? "/tmp/opencode/sintermark-sealed-cases/sealed-cases";
const ATTESTATION_PATH = join(CORPUS_ROOT, "sealed-attestation.json");

function readGitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function freeze(): CorpusFreezeV2 {
  const result = freezeCorpus({
    root: CORPUS_ROOT,
    sealedSource: existsSync(SEALED_SOURCE) ? SEALED_SOURCE : undefined,
    corpusId: "velvet-baseline",
    corpusVersion: "velvet-baseline-v1",
    gitCommit: readGitCommit(),
    createOnly: process.argv.includes("--create-only"),
  });
  const disjoint = assertLineageDisjoint(result);
  const sealedSource = existsSync(SEALED_SOURCE) ? SEALED_SOURCE : null;
  const verification = verifyFreeze(CORPUS_ROOT, { sealedSource: sealedSource ?? undefined });
  console.log(JSON.stringify({
    action: "freeze",
    corpusDigest: result.corpusDigest,
    files: result.files.length,
    caseCounts: disjoint.counts,
    lineageDisjoint: disjoint.ok,
    lineageViolations: disjoint.violations,
    verifyOk: verification.ok,
    verifyProblems: verification.problems,
    sealedSource,
  }, null, 2));
  if (!disjoint.ok || !verification.ok) process.exitCode = 1;
  if (sealedSource) {
    const attestation = issueSealedAttestation(result, "velvet-evaluator");
    writeFileSync(ATTESTATION_PATH, `${JSON.stringify(attestation, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      action: "attestation",
      path: ATTESTATION_PATH,
      sealedCaseCount: attestation.sealedCaseCount,
      attestationDigest: attestation.attestationDigest,
      containsContent: false,
    }, null, 2));
  }
  return result;
}

function verify(): void {
  const expectedIndex = process.argv.indexOf("--expect");
  const expected = expectedIndex >= 0 ? process.argv[expectedIndex + 1] : undefined;
  const sealedSource = existsSync(SEALED_SOURCE) ? SEALED_SOURCE : undefined;
  const result = verifyFreeze(CORPUS_ROOT, {
    ...(expected ? { expectedDigest: expected } : {}),
    ...(sealedSource ? { sealedSource } : {}),
  });
  const attestationProblems: string[] = [];
  if (existsSync(ATTESTATION_PATH)) {
    const attestation = JSON.parse(readFileSync(ATTESTATION_PATH, "utf8")) as Parameters<typeof verifySealedAttestation>[0];
    attestationProblems.push(...verifySealedAttestation(attestation, { corpusDigest: result.corpusDigest }));
  }
  console.log(JSON.stringify({
    action: "verify",
    ok: result.ok && attestationProblems.length === 0,
    corpusDigest: result.corpusDigest,
    problems: [...result.problems, ...attestationProblems],
  }, null, 2));
  if (!result.ok || attestationProblems.length > 0) process.exitCode = 1;
}

const command = process.argv[2];
if (command === "freeze") freeze();
else if (command === "verify") verify();
else {
  console.error("usage: corpus.ts freeze|verify [--sealed-source DIR] [--expect DIGEST] [--create-only]");
  process.exitCode = 2;
}
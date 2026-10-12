/**
 * Tests for corpus freezing, verification, and sealed isolation.
 *
 * Every test here corresponds to a defect the audit reproduced against the
 * previous implementation. If one of these starts passing unexpectedly, that is a
 * regression, not progress.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CorpusIntegrityError,
  SealedAccessError,
  assertLineageDisjoint,
  createSealedSafeReader,
  freezeCorpus,
  issueSealedAttestation,
  verifyFreeze,
  verifySealedAttestation,
} from "../src/freeze.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "foundry-freeze-"));
}

function writeCaseFile(dir: string, name: string, prefix: string, count: number): void {
  mkdirSync(dir, { recursive: true });
  const cases = Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-case-${index}`,
    category: "tool-selection",
    lineage: {
      characterFamily: `${prefix}-char-${index % 2}`,
      worldFamily: `${prefix}-world-${index % 2}`,
      scenarioFamily: `${prefix}-scenario-${index % 2}`,
    },
    expected: { outcome: "tool-call" },
  }));
  writeFileSync(join(dir, name), JSON.stringify({ category: "tool-selection", cases }, null, 2));
}

test("freezing records real case counts, not file counts", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 4);
    writeCaseFile(join(sealed, "sealed-cases"), "b.json", "sealed", 3);
    const freeze = freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" });
    const report = assertLineageDisjoint(freeze);
    assert.equal(report.counts.dev, 4);
    assert.equal(report.counts["sealed-test"], 3);
    assert.equal(report.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("M7: an empty case file cannot count as evidence", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    mkdirSync(sealed, { recursive: true });
    writeFileSync(join(sealed, "empty.json"), "{}");
    assert.throws(() => freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" }), CorpusIntegrityError);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("M7: a case file with a zero-case array is refused", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    mkdirSync(join(sealed, "sealed-cases"), { recursive: true });
    writeFileSync(join(sealed, "sealed-cases", "none.json"), JSON.stringify({ category: "x", cases: [] }));
    assert.throws(() => freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" }), /zero cases/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("M7: duplicate case ids across partitions are refused", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 2);
    mkdirSync(join(sealed, "sealed-cases"), { recursive: true });
    // Deliberately reuse a dev id.
    writeFileSync(join(sealed, "sealed-cases", "dup.json"), JSON.stringify({
      category: "x",
      cases: [{ id: "dev-case-0", lineage: { characterFamily: "z", worldFamily: "z", scenarioFamily: "z" } }],
    }));
    assert.throws(() => freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" }), /duplicate case ids/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("M7: a case missing lineage is refused rather than skipped", () => {
  const root = tmp();
  try {
    mkdirSync(join(root, "dev-cases"), { recursive: true });
    writeFileSync(join(root, "dev-cases", "bad.json"), JSON.stringify({ cases: [{ id: "x" }] }));
    assert.throws(() => freezeCorpus({ root, corpusId: "c", corpusVersion: "v1" }), /lineage/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("M8: verify recomputes identity and rejects a forged digest", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 3);
    writeCaseFile(join(sealed, "sealed-cases"), "b.json", "sealed", 3);
    const freeze = freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" });
    assert.equal(verifyFreeze(root, { sealedSource: sealed }).ok, true);

    const freezePath = join(root, "freeze.json");
    const tampered = JSON.parse(readFileSync(freezePath, "utf8")) as Record<string, unknown>;
    tampered["corpusDigest"] = "forged-digest";
    writeFileSync(freezePath, JSON.stringify(tampered));
    const result = verifyFreeze(root, { sealedSource: sealed });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /identity does not match/.test(problem)));
    assert.equal(result.corpusDigest, freeze.corpusDigest, "recomputed identity must match the genuine one");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("M8: verify refuses a corpus whose content changed after freezing", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 3);
    writeCaseFile(join(sealed, "sealed-cases"), "b.json", "sealed", 3);
    freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" });
    writeFileSync(join(root, "dev-cases", "a.json"), JSON.stringify({ category: "x", cases: [{ id: "injected", lineage: { characterFamily: "n", worldFamily: "n", scenarioFamily: "n" } }] }));
    const result = verifyFreeze(root, { sealedSource: sealed });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /checksum mismatch/.test(problem)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("M8: expected digest mismatch fails verification", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 2);
    writeCaseFile(join(sealed, "sealed-cases"), "b.json", "sealed", 2);
    freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" });
    const result = verifyFreeze(root, { sealedSource: sealed, expectedDigest: "0".repeat(64) });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((problem) => /does not match the expected/.test(problem)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("M8: create-only refuses to overwrite a frozen corpus version", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 2);
    writeCaseFile(join(sealed, "sealed-cases"), "b.json", "sealed", 2);
    freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1", createOnly: true });
    assert.throws(() => freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1", createOnly: true }), /already frozen/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("M6: a shared character family across splits is caught per field, not per triple", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 2);
    // Same character family as dev, different world/scenario: the old triple
    // comparison passed this; per-field comparison must not.
    mkdirSync(join(sealed, "sealed-cases"), { recursive: true });
    writeFileSync(join(sealed, "sealed-cases", "leak.json"), JSON.stringify({
      category: "x",
      cases: [{
        id: "sealed-leak",
        lineage: { characterFamily: "dev-char-0", worldFamily: "totally-different-world", scenarioFamily: "totally-different-scenario" },
      }],
    }));
    const freeze = freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" });
    const report = assertLineageDisjoint(freeze);
    assert.equal(report.ok, false);
    assert.ok(report.violations.some((violation) => /characterFamily "dev-char-0"/.test(violation)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("B4: sealed attestation carries ids and counts but no content", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 2);
    writeCaseFile(join(sealed, "sealed-cases"), "b.json", "sealed", 5);
    const freeze = freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" });
    const attestation = issueSealedAttestation(freeze, "evaluator");
    assert.equal(attestation.sealedCaseCount, 5);
    assert.equal(attestation.sealedCaseIds.length, 5);
    const serialized = JSON.stringify(attestation);
    assert.ok(!/expected|outcome|input|setup|rationale/.test(serialized), "attestation must not carry case content");
    assert.deepEqual(verifySealedAttestation(attestation, { corpusDigest: freeze.corpusDigest }), []);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("B4: a tampered attestation fails verification", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 2);
    writeCaseFile(join(sealed, "sealed-cases"), "b.json", "sealed", 3);
    const freeze = freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" });
    const attestation = issueSealedAttestation(freeze, "evaluator");
    const tampered = { ...attestation, sealedCaseCount: 0 };
    assert.ok(verifySealedAttestation(tampered).length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});

test("B4: the safe reader refuses direct, traversal and symlink access to sealed content", () => {
  const base = tmp();
  const allowed = join(base, "generation");
  const sealed = join(base, "sealed-cases");
  try {
    mkdirSync(allowed, { recursive: true });
    mkdirSync(sealed, { recursive: true });
    writeFileSync(join(allowed, "dev.json"), "{}");
    writeFileSync(join(sealed, "secret.json"), '{"expected":"the answer"}');
    symlinkSync(join(sealed, "secret.json"), join(allowed, "innocent-looking.json"));
    const reader = createSealedSafeReader({ allowedRoots: [allowed], sealedRoot: sealed });

    assert.doesNotThrow(() => reader.readAllowed(join(allowed, "dev.json")));
    // Direct absolute path.
    assert.throws(() => reader.readAllowed(join(sealed, "secret.json")), SealedAccessError);
    // Traversal from an allowed root.
    assert.throws(() => reader.readAllowed(join(allowed, "..", "sealed-cases", "secret.json")), SealedAccessError);
    // Symlink that resolves into the sealed root.
    assert.throws(() => reader.readAllowed(join(allowed, "innocent-looking.json")), SealedAccessError);
    assert.equal(reader.isSealed(join(sealed, "secret.json")), true);
    assert.equal(reader.isSealed(join(allowed, "dev.json")), false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("sealed content is never written inside the corpus tree", () => {
  const root = tmp();
  const sealed = tmp();
  try {
    writeCaseFile(join(root, "dev-cases"), "a.json", "dev", 2);
    writeCaseFile(join(sealed, "sealed-cases"), "b.json", "sealed", 3);
    freezeCorpus({ root, sealedSource: sealed, corpusId: "c", corpusVersion: "v1" });
    const sealedBytes = readFileSync(join(sealed, "sealed-cases", "b.json"), "utf8");
    const committed = readFileSync(join(root, "freeze.json"), "utf8");
    assert.ok(!committed.includes("expected"), "the freeze must not inline sealed case content");
    assert.ok(sealedBytes.includes("expected"), "sanity: the real sealed file does contain content");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(sealed, { recursive: true, force: true }); }
});
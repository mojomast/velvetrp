#!/usr/bin/env node
/**
 * Fetch the foundry dev corpus byte-exactly from a git ref, and verify it.
 *
 * WHY THIS EXISTS
 * ---------------
 * PowerShell's `git show ... | Out-File -Encoding utf8` is NOT byte-exact:
 * it prepends a BOM and rewrites LF to CRLF. Hashing the result therefore
 * mismatches every recorded SHA-256 for a reason that has nothing to do with
 * the corpus. This script reads the raw git blob and writes raw bytes.
 *
 * Verification order (decisive first):
 *   1. per-file SHA-256 against CORPUS_FINGERPRINT.devFileSha256  <- byte identity
 *   2. devCaseCount and the sorted case-id list                     <- shape
 *   3. devCaseIdListDigest                                          <- reported, see note
 *
 * NOTE on devCaseIdListDigest: `git grep` across the whole ref finds that value
 * only inside two documents (CORPUS_FINGERPRINT.json and the eval prompt). No code
 * in dataset/src computes it, so it has no reference implementation and cannot be
 * reproduced by construction. We recompute it over plausible canonicalisations and
 * report every result; a miss is reported as "unverifiable", never as "mismatch".
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

const REPO = "C:/Users/kyle/projects/velvetrp";
const REF = "origin/feat/training-data-foundry";
const EVAL = `${REPO}/data/velvet-bench/eval`;

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Raw bytes of a git blob. Never route this through PowerShell redirection. */
const blob = (path) =>
  execFileSync("git", ["show", `${REF}:${path}`], { cwd: REPO, maxBuffer: 1 << 28 });

const listTree = (dir) =>
  execFileSync("git", ["ls-tree", "--name-only", REF, "--", dir], { cwd: REPO })
    .toString("utf8")
    .split("\n")
    .filter(Boolean);

// ---------------------------------------------------------------- extract
const casePaths = listTree("dataset/eval/corpus/dev-cases/").sort();
mkdirSync(`${EVAL}/dev-cases`, { recursive: true });

const blobs = new Map();
for (const p of casePaths) {
  const buf = blob(p);
  blobs.set(p, buf);
  writeFileSync(`${EVAL}/${p.replace("dataset/eval/corpus/", "")}`, buf);
}
for (const [remote, local] of [
  ["dataset/eval/CORPUS_FINGERPRINT.json", "CORPUS_FINGERPRINT.json"],
  ["dataset/eval/GRADING.md", "GRADING.md"],
  ["dataset/EVAL_PROMPT_GROUNDING_BOUNDARY.md", "EVAL_PROMPT.md"],
  ["dataset/eval/corpus/freeze.json", "freeze.json"],
  ["dataset/eval/corpus/sealed-attestation.json", "sealed-attestation.json"],
  ["dataset/eval/CORPUS_HANDOFF.md", "CORPUS_HANDOFF.md"],
]) {
  writeFileSync(`${EVAL}/${local}`, blob(remote));
}

// ---------------------------------------------------------------- verify
const fp = JSON.parse(readFileSync(`${EVAL}/CORPUS_FINGERPRINT.json`, "utf8"));

console.log("=== 1. per-file SHA-256 vs CORPUS_FINGERPRINT.json ===");
let matched = 0;
const mismatches = [];
for (const [rel, want] of Object.entries(fp.devFileSha256 ?? {})) {
  const remote = `dataset/eval/corpus/${rel}`;
  const buf = blobs.get(remote);
  if (!buf) { mismatches.push([rel, "NOT IN REF"]); console.log(`  MISSING   ${rel}`); continue; }
  const got = sha(buf);
  if (got === want) { matched++; console.log(`  MATCH     ${rel}`); }
  else { mismatches.push([rel, `${got} != ${want}`]); console.log(`  MISMATCH  ${rel}\n             got  ${got}\n             want ${want}`); }
}
console.log(`\n  files matched ${matched}/${Object.keys(fp.devFileSha256 ?? {}).length}`);

console.log("\n=== 2. shape ===");
let ids = [];
const perCat = {};
for (const [p, buf] of blobs) {
  const j = JSON.parse(buf.toString("utf8"));
  const cases = Array.isArray(j) ? j : j.cases ?? j.items ?? [];
  perCat[p.split("/").pop().replace(".json", "")] = cases.length;
  for (const c of cases) ids.push(c.id);
}
for (const [k, v] of Object.entries(perCat).sort()) console.log(`  ${k.padEnd(30)}${v}`);
console.log(`  ${"TOTAL".padEnd(30)}${ids.length}   unique ${new Set(ids).length}   categories ${Object.keys(perCat).length}`);
console.log(`  devCaseCount declared ${fp.devCaseCount}  -> ${ids.length === fp.devCaseCount ? "MATCH" : "MISMATCH"}`);

console.log("\n=== 3. devCaseIdListDigest ===");
const want = fp.devCaseIdListDigest;
console.log(`  target ${want}`);
console.log("  no implementation exists in dataset/src; recomputing over canonicalisations:");
const sorted = [...ids].sort();
for (const [name, s] of Object.entries({
  "LF join": sorted.join("\n"),
  "LF join + trailing": sorted.join("\n") + "\n",
  "comma join": sorted.join(","),
  "comma join + trailing": sorted.join(",") + ",",
  "JSON array": JSON.stringify(sorted),
  "concat": sorted.join(""),
})) {
  const h = sha(s);
  console.log(`    ${h === want ? "MATCH " : "      "}${name.padEnd(22)}${h}`);
}
console.log(`  status: ${Object.values({
  "LF join": sha(sorted.join("\n")), "LF join + trailing": sha(sorted.join("\n") + "\n"),
  "comma join": sha(sorted.join(",")), "comma join + trailing": sha(sorted.join(",") + ","),
  "JSON array": sha(JSON.stringify(sorted)), "concat": sha(sorted.join("")),
}).includes(want) ? "REPRODUCED" : "UNVERIFIABLE (no reference impl)"}`);

console.log("\n=== sealed (attestation only, NOT executed) ===");
try {
  const sa = JSON.parse(readFileSync(`${EVAL}/sealed-attestation.json`, "utf8"));
  console.log(`  sealedCaseCount ${sa.sealedCaseCount}   categories ${(sa.categories ?? []).length}`);
  console.log(`  corpusDigest     ${sa.corpusDigest}`);
} catch (e) { console.log("  (attestation unreadable: " + e.message + ")"); }

if (mismatches.length) { console.log("\nMISMATCHES PRESENT"); process.exitCode = 1; }
else console.log("\nALL PER-FILE HASHES MATCH");
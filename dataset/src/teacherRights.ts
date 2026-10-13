/** Pinned public upstream terms and operator-confirmed RouteTok relay rights. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeneratorIdentity } from "./runstore.js";
import type { Provenance } from "./spec.js";

const ROOT = fileURLToPath(new URL("../rights/", import.meta.url));
export const TEACHER_RIGHTS_RECEIPT_SHA256 = "63202d19b617ce972007ccdea557cb6bb86bc587156243fb4273b0eefcbd3316";
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface Receipt {
  version: "teacher-training-rights-v1";
  status: "verified-permitted";
  teacher: Pick<GeneratorIdentity, "provider" | "model" | "baseUrlDigest">;
  sources: { file: string; url: string; sha256: string; section: string }[];
}

export interface VerifiedTeacherRights {
  readonly receiptDigest: string;
  readonly teacher: Receipt["teacher"];
  readonly license: Provenance["license"];
  readonly sourceDigests: Readonly<Record<string, string>>;
  readonly artifacts: ReadonlyMap<string, string | Uint8Array>;
}

/** Loads inspected bytes only; no networking, credential access or model calls. */
export function loadTeacherRights(directory = ROOT): VerifiedTeacherRights {
  const bytes = readFileSync(join(directory, "routetok-deepseek-flash.json"));
  if (sha(bytes) !== TEACHER_RIGHTS_RECEIPT_SHA256) throw new Error("teacher training-rights receipt differs from the inspected pin");
  const receipt = JSON.parse(bytes.toString("utf8")) as Receipt;
  const artifacts = new Map<string, string | Uint8Array>([[TEACHER_RIGHTS_RECEIPT_SHA256, bytes]]);
  const sourceDigests: Record<string, string> = { teacherTrainingRights: TEACHER_RIGHTS_RECEIPT_SHA256 };
  receipt.sources.forEach((source, index) => {
    const snapshot = readFileSync(join(directory, source.file));
    if (sha(snapshot) !== source.sha256) throw new Error("teacher terms snapshot differs from the inspected pin");
    artifacts.set(source.sha256, snapshot);
    sourceDigests[`teacherTerms${index + 1}`] = source.sha256;
  });
  return { receiptDigest: TEACHER_RIGHTS_RECEIPT_SHA256, teacher: receipt.teacher, sourceDigests, artifacts,
    license: { status: "verified-permitted", note: "DeepSeek Open Platform Terms §4.2(3) permit training other models; RouteTok is operator-controlled and confirmed for this workflow. Evidence reviewed 2026-10-13." } };
}

/** Prevent a grant for one provider/model/relay from silently blessing another. */
export function assertTeacherRightsFor(rights: VerifiedTeacherRights,
  teacher: Pick<GeneratorIdentity, "provider" | "model" | "baseUrlDigest">): void {
  const receiptBytes = rights.artifacts.get(TEACHER_RIGHTS_RECEIPT_SHA256);
  if (!receiptBytes || sha(receiptBytes) !== TEACHER_RIGHTS_RECEIPT_SHA256 || rights.receiptDigest !== TEACHER_RIGHTS_RECEIPT_SHA256
    || rights.license.status !== "verified-permitted") throw new Error("unverified teacher training-rights artifact");
  const receipt = JSON.parse(Buffer.from(receiptBytes).toString("utf8")) as Receipt;
  for (const key of ["provider", "model", "baseUrlDigest"] as const) {
    if (rights.teacher[key] !== receipt.teacher[key] || teacher[key] !== receipt.teacher[key]) throw new Error("teacher training-rights evidence belongs to another model or relay");
  }
  const expected: Record<string, string> = { teacherTrainingRights: TEACHER_RIGHTS_RECEIPT_SHA256 };
  receipt.sources.forEach((source, index) => {
    const bytes = rights.artifacts.get(source.sha256);
    if (!bytes || sha(bytes) !== source.sha256) throw new Error("teacher training-use source evidence is absent or changed");
    expected[`teacherTerms${index + 1}`] = source.sha256;
  });
  if (JSON.stringify(Object.entries(rights.sourceDigests).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error("teacher rights source bindings changed");
}

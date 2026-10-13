/** Generation reads frozen metadata and an ids/counts-only attestation, never sealed cases. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCorpusIdentity, assertLineageDisjoint, verifySealedAttestation, type CorpusFreezeV2, type SealedAttestationV1 } from "./freeze.js";
import { stableStringify, type DatasetSplit, type LineageGroup } from "./spec.js";
import { sha256Hex } from "./teacher.js";

export const FROZEN_CORPUS_DIGEST = "22eb78976caa9ca91102f75576ea19eeb8cef8d594435275630542b7ddef8e58";
const ROOT = fileURLToPath(new URL("../eval/corpus/", import.meta.url));
const FIELDS = ["characterFamily", "worldFamily", "scenarioFamily"] as const;

export interface GenerationPolicy {
  readonly corpusDigest: string;
  readonly attestationDigest: string;
  readonly digest: string;
  readonly reservedCaseIds: readonly string[];
  readonly reservedLineages: readonly LineageGroup[];
  readonly sealedAttestation: SealedAttestationV1;
}

export function loadGenerationPolicy(root = ROOT, expectedDigest = FROZEN_CORPUS_DIGEST): GenerationPolicy {
  const freeze = JSON.parse(readFileSync(join(root, "freeze.json"), "utf8")) as CorpusFreezeV2;
  const attestation = JSON.parse(readFileSync(join(root, "sealed-attestation.json"), "utf8")) as SealedAttestationV1;
  const allowed = ["attestationVersion", "corpusId", "corpusVersion", "corpusDigest", "sealedCaseIds", "sealedCaseCount", "categories", "issuedAt", "issuer", "attestationDigest"];
  if (Object.keys(attestation).some((key) => !allowed.includes(key)) || allowed.some((key) => !(key in attestation))) {
    throw new Error("sealed attestation must contain ids/counts metadata only");
  }
  if (computeCorpusIdentity(freeze) !== expectedDigest || freeze.corpusDigest !== expectedDigest) throw new Error("frozen generation metadata identity mismatch");
  const disjoint = assertLineageDisjoint(freeze);
  const sealedIds = freeze.caseIds.filter((id) => id.startsWith("sealed-")).sort();
  if (!disjoint.ok || attestation.attestationVersion !== "sealed-attestation-v1"
    || attestation.corpusId !== freeze.corpusId || attestation.corpusVersion !== freeze.corpusVersion
    || !Array.isArray(attestation.sealedCaseIds) || new Set(attestation.sealedCaseIds).size !== attestation.sealedCaseIds.length
    || attestation.sealedCaseCount !== disjoint.counts["sealed-test"] || attestation.sealedCaseCount !== sealedIds.length
    || stableStringify([...attestation.sealedCaseIds].sort()) !== stableStringify(sealedIds)
    || verifySealedAttestation(attestation, { corpusDigest: expectedDigest }).length) {
    throw new Error("sealed attestation does not verify against frozen generation metadata");
  }
  const body = { corpusDigest: expectedDigest, attestationDigest: attestation.attestationDigest,
    sealedAttestation: attestation,
    reservedCaseIds: [...freeze.caseIds].sort(),
    reservedLineages: [...freeze.splitLineage.train, ...freeze.splitLineage.dev, ...freeze.splitLineage["sealed-test"]] };
  return { ...body, digest: sha256Hex(stableStringify(body)) };
}

/** Per-field isolation catches shared characters/worlds even when a scenario id changes. */
export function assertGeneratedSplits(
  units: readonly { unitId: string; spec: { specId: string; split: DatasetSplit; lineage: LineageGroup } }[],
  policy: GenerationPolicy,
): void {
  const { digest, ...body } = policy;
  if (sha256Hex(stableStringify(body)) !== digest) throw new Error("generation policy metadata changed after verification");
  const ids = new Set<string>();
  const reservedIds = new Set(policy.reservedCaseIds);
  const assignments = new Map<string, DatasetSplit>();
  const reserved = new Set(policy.reservedLineages.flatMap((lineage) => FIELDS.map((field) => `${field}:${lineage[field]}`)));
  for (const unit of units) {
    if (ids.has(unit.unitId) || reservedIds.has(unit.unitId) || reservedIds.has(unit.spec.specId)) throw new Error("generated case identity overlaps or duplicates frozen evaluation identity");
    ids.add(unit.unitId);
    if (!["train", "dev", "sealed-test"].includes(unit.spec.split)) throw new Error("invalid generated split");
    for (const field of FIELDS) {
      const value = unit.spec.lineage[field];
      if (typeof value !== "string" || !value.trim()) throw new Error("generated lineage is incomplete");
      const key = `${field}:${value}`;
      if (reserved.has(key)) throw new Error(`generated ${field} overlaps frozen evaluation lineage`);
      if (assignments.has(key) && assignments.get(key) !== unit.spec.split) throw new Error(`generated ${field} crosses splits`);
      assignments.set(key, unit.spec.split);
    }
  }
}

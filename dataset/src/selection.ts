/** Deterministic quality-ranked, cluster-capped selection; twins are indivisible groups. */
import type { AdmittedRecordV1 } from "./admission.js";
import { verifyAdmissionCertificate } from "./admission.js";
import type { PlannedUnit, RunPlan } from "./generate.js";
import { assertGeneratedSplits, type GenerationPolicy } from "./generationPolicy.js";
import { stableStringify } from "./spec.js";
import { sha256Hex } from "./teacher.js";

export interface SelectionPolicy { readonly maxRecordsPerCluster: number; readonly maxRecords?: number }
export const DEFAULT_SELECTION_POLICY: SelectionPolicy = { maxRecordsPerCluster: 8 };
export interface SelectionResult {
  readonly selected: readonly AdmittedRecordV1[];
  readonly excluded: readonly { unitId: string; reason: "incomplete-twin" | "cluster-cap" | "record-cap" | "duplicate-payload" }[];
  readonly clusterCounts: Readonly<Record<string, number>>;
  readonly digest: string;
}

export function selectAdmittedRecords(plan: RunPlan, records: readonly AdmittedRecordV1[], policy: GenerationPolicy,
  limits: SelectionPolicy = DEFAULT_SELECTION_POLICY): SelectionResult {
  const { digest: planDigest, ...planBody } = plan;
  if (sha256Hex(stableStringify(planBody)) !== planDigest) throw new Error("generated plan changed after its digest was bound");
  if (!Number.isSafeInteger(limits.maxRecordsPerCluster) || limits.maxRecordsPerCluster < 1
    || (limits.maxRecords !== undefined && (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1))) throw new Error("selection caps must be positive safe integers");
  assertGeneratedSplits(plan.units, policy);
  const byId = new Map(plan.units.map((unit) => [unit.unitId, unit]));
  const groups = new Map<string, { unit: PlannedUnit; record: AdmittedRecordV1 }[]>();
  const seen = new Set<string>();
  for (const record of records) {
    verifyAdmissionCertificate(record);
    const unit = byId.get(record.unitId);
    if (!unit || seen.has(record.unitId) || record.recordId !== unit.unitId || record.family !== unit.spec.family
      || record.split !== unit.spec.split || stableStringify(record.lineage) !== stableStringify(unit.spec.lineage)
      || record.splitAssignmentDigest !== plan.splitAssignmentDigest) throw new Error("admitted record does not bind the generated plan/split assignment");
    if (stableStringify(record.tools ?? []) !== stableStringify(unit.spec.advertisedTools)
      || (unit.preference ? stableStringify(record.preference) !== stableStringify(unit.preference)
        || stableStringify(record.messages) !== stableStringify(unit.preference.prompt)
        : record.preference !== undefined || record.messages.length !== unit.realization.context.length + 1
          || stableStringify(record.messages.slice(0, -1)) !== stableStringify(unit.realization.context))) {
      throw new Error("admitted payload does not preserve the scheduled prompt, tools or twin branches");
    }
    seen.add(record.unitId);
    const key = unit.twinGroupId ?? unit.unitId;
    const group = groups.get(key) ?? [];
    group.push({ unit, record });
    groups.set(key, group);
  }
  for (const group of groups.values()) group.sort((left, right) => left.unit.unitId.localeCompare(right.unit.unitId));
  const quality = (group: { record: AdmittedRecordV1 }[]): number => Math.min(...group.map(({ record }) => {
    const scores = record.admission.review!;
    return (scores.characterization + scores.dialogueQuality + scores.coherence + scores.narrativeInitiative + scores.playerAgency + scores.nonRepetitive) / 6;
  }));
  const ordered = [...groups.entries()].sort(([leftKey, left], [rightKey, right]) => quality(right) - quality(left)
    || sha256Hex(`${plan.seed}|selection|${leftKey}`).localeCompare(sha256Hex(`${plan.seed}|selection|${rightKey}`)));
  const selected: AdmittedRecordV1[] = [];
  const excluded: { unitId: string; reason: SelectionResult["excluded"][number]["reason"] }[] = [];
  const counts = new Map<string, number>();
  const payloads = new Set<string>();
  for (const [, group] of ordered) {
    const first = group[0]!;
    let reason: SelectionResult["excluded"][number]["reason"] | null = null;
    if (first.unit.twinGroupId && group.length !== 2) reason = "incomplete-twin";
    const cluster = first.unit.realization.clusterId;
    if (group.some(({ unit }) => unit.realization.clusterId !== cluster || unit.spec.split !== first.unit.spec.split
      || stableStringify(unit.spec.lineage) !== stableStringify(first.unit.spec.lineage))) throw new Error("selection group crosses cluster, lineage or split");
    if (!reason && (counts.get(cluster) ?? 0) + group.length > limits.maxRecordsPerCluster) reason = "cluster-cap";
    if (!reason && selected.length + group.length > (limits.maxRecords ?? Infinity)) reason = "record-cap";
    if (!reason && group.some(({ record }) => payloads.has(record.payloadDigest))) reason = "duplicate-payload";
    if (reason) { for (const { unit } of group) excluded.push({ unitId: unit.unitId, reason }); continue; }
    for (const { record } of group) { selected.push(record); payloads.add(record.payloadDigest); }
    counts.set(cluster, (counts.get(cluster) ?? 0) + group.length);
  }
  const clusterCounts = Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
  const digest = sha256Hex(stableStringify({ planDigest: plan.digest, limits,
    selected: selected.map((record) => ({ unitId: record.unitId, certificate: record.admissionCertificate.certificateDigest })), excluded, clusterCounts }));
  return { selected, excluded, clusterCounts, digest };
}

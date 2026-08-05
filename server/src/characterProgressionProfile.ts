import { createHash } from "node:crypto";

export const STARTER_PROGRESSION_RULES_PROFILE_ID = "velvet:rules:starter-v1" as const;
export const STARTER_PROGRESSION_THRESHOLDS = [{ level: 1, xp: 0 }, { level: 2, xp: 300 }, { level: 3, xp: 900 }] as const;
export const starterProgressionProfileId = (mode: "xp" | "milestone") => `velvet:progression:starter-v1:${mode}` as const;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
  return value;
}
export const canonicalProgressionJson = (value: unknown): string => JSON.stringify(stable(value));
export function canonicalStarterProgressionProfile(mode: "xp" | "milestone") {
  return { profileId: starterProgressionProfileId(mode), rulesProfileId: STARTER_PROGRESSION_RULES_PROFILE_ID,
    mode, maxLevel: STARTER_PROGRESSION_THRESHOLDS.length, thresholds: STARTER_PROGRESSION_THRESHOLDS } as const;
}
export function progressionProfileDigest(mode: "xp" | "milestone"): string {
  return createHash("sha256").update(canonicalProgressionJson(canonicalStarterProgressionProfile(mode))).digest("hex");
}
export function assertCanonicalProgressionProfile(row: { profile_id: string; rules_profile_id: string; mode: string; max_level: number;
  thresholds_json: string; profile_digest: string }): "xp" | "milestone" {
  if (row.mode !== "xp" && row.mode !== "milestone") throw new Error("progression profile is not supported");
  const expected = canonicalStarterProgressionProfile(row.mode);
  if (row.profile_id !== expected.profileId || row.rules_profile_id !== expected.rulesProfileId || row.max_level !== expected.maxLevel
    || row.thresholds_json !== canonicalProgressionJson(expected.thresholds) || row.profile_digest !== progressionProfileDigest(row.mode)) {
    throw new Error("progression profile canonical provenance is inconsistent");
  }
  return row.mode;
}

import { createHash } from "node:crypto";
import {
  classCatalogDefinitionSchema,
  classLevelCatalogDefinitionSchema,
  raceCatalogDefinitionSchema,
  type CatalogDefinition,
  type CatalogDefinitionReference,
} from "@velvet/contracts";
import { canonicalCatalogJson } from "./repo/contentCatalog/index.js";

/** A fully versioned catalog reference; free-form kinds are deliberately excluded. */
export type ExactReference = CatalogDefinitionReference;
export const progressionReferenceKey = (reference: ExactReference): string =>
  `${reference.packId}\0${reference.packVersion}\0${reference.kind}\0${reference.definitionId}`;

export interface ResolvedInitialPower {
  reference: Extract<ExactReference, { kind: "ability" | "spell" }>;
  source: "race" | "class-level";
  sourceReference: Extract<ExactReference, { kind: "race" | "class-level" }>;
}

/** Pure exact-reference resolver shared by runtime bootstrap and migrations. */
export function resolveSelectedClassProgression(input: {
  selectedClass: unknown;
  availableDefinitions: readonly unknown[];
  profileMaximum: number;
}) {
  const selectedClass = classCatalogDefinitionSchema.parse(input.selectedClass);
  const exact = new Map<string, unknown>();
  for (const candidate of input.availableDefinitions) {
    const parsed = classLevelCatalogDefinitionSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const key = progressionReferenceKey(parsed.data.reference);
    if (exact.has(key)) throw new Error("selected class progression contains a duplicate exact definition");
    exact.set(key, parsed.data);
  }
  const levels = selectedClass.mechanics.levelRefs.map((reference) => {
    const parsed = classLevelCatalogDefinitionSchema.safeParse(exact.get(progressionReferenceKey(reference)));
    if (!parsed.success) throw new Error("selected class progression reference is unavailable");
    if (progressionReferenceKey(parsed.data.mechanics.classRef) !== progressionReferenceKey(selectedClass.reference)) {
      throw new Error("selected class progression level has a mismatched class owner");
    }
    return parsed.data;
  });
  const byLevel = new Map<number, (typeof levels)[number]>();
  const choiceIds = new Set<string>();
  for (const level of levels) {
    if (byLevel.has(level.mechanics.level)) throw new Error("selected class progression contains a duplicate level");
    byLevel.set(level.mechanics.level, level);
    for (const choice of level.mechanics.progressionChoices ?? []) {
      if (choiceIds.has(choice.choiceId)) throw new Error("selected class progression reuses a choice ID");
      choiceIds.add(choice.choiceId);
      const options = new Set(choice.options.map(progressionReferenceKey));
      if (options.size !== choice.options.length) throw new Error("selected class progression choice reuses an option");
    }
  }
  const supported = Array.from({ length: input.profileMaximum }, (_, index) => byLevel.get(index + 1));
  if (supported.some((level) => level === undefined)) throw new Error("selected class progression is incomplete for the profile maximum");
  return supported as Array<(typeof levels)[number]>;
}

export function resolveInitialKnownPowers(input: { selectedRace: unknown; levels: readonly unknown[] }): ResolvedInitialPower[] {
  const race = raceCatalogDefinitionSchema.parse(input.selectedRace);
  const levelOne = input.levels.map((level) => classLevelCatalogDefinitionSchema.parse(level))
    .filter((level) => level.mechanics.level === 1);
  if (levelOne.length !== 1) throw new Error("selected class requires one exact level-one definition");
  const sources: ResolvedInitialPower[] = [
    ...race.mechanics.abilityRefs.map((reference) => ({ reference, source: "race" as const, sourceReference: race.reference })),
    ...levelOne[0]!.mechanics.abilityRefs.map((reference) => ({ reference, source: "class-level" as const, sourceReference: levelOne[0]!.reference })),
    ...levelOne[0]!.mechanics.spellRefs.map((reference) => ({ reference, source: "class-level" as const, sourceReference: levelOne[0]!.reference })),
  ];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = progressionReferenceKey(source.reference);
    if (seen.has(key)) throw new Error("initial known power has ambiguous duplicate source provenance");
    seen.add(key);
  }
  return sources;
}

export function progressionCatalogDigest(value: unknown): string {
  return createHash("sha256").update(canonicalCatalogJson(value)).digest("hex");
}

export function catalogDefinitionsOfKind(definitions: readonly CatalogDefinition[], kind: "class-level") {
  return definitions.filter((definition) => definition.reference.kind === kind);
}

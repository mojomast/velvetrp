import { createHash } from "node:crypto";
import {
  catalogDefinitionKindSchema,
  catalogValidationReportSchema,
  publishContentCatalogInputSchema,
  type CatalogDefinition,
  type CatalogDefinitionKind,
  type CatalogDefinitionReference,
  type CatalogValidationIssue,
  type CatalogValidationReport,
  type PublishContentCatalogInput,
} from "@velvet/contracts";

const KINDS = catalogDefinitionKindSchema.options;

export function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => binaryCompare(left, right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function canonicalCatalogJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function definitionKey(reference: CatalogDefinitionReference): string {
  return `${reference.kind}\0${reference.definitionId}`;
}

export type CatalogByKind<Kind extends CatalogDefinitionKind> = Extract<CatalogDefinition, { reference: { kind: Kind } }>;
export const asKind = <Kind extends CatalogDefinitionKind>(definition: CatalogDefinition, _kind: Kind) =>
  definition as CatalogByKind<Kind>;

export function sortedDefinitions(definitions: readonly CatalogDefinition[]): CatalogDefinition[] {
  return [...definitions].sort((left, right) =>
    binaryCompare(left.reference.kind, right.reference.kind)
    || binaryCompare(left.reference.definitionId, right.reference.definitionId));
}

export function dependencies(definition: CatalogDefinition): CatalogDefinitionReference[] {
  switch (definition.reference.kind) {
    case "race": return [...asKind(definition, "race").mechanics.abilityRefs];
    case "background": { const value = asKind(definition, "background"); return [...value.mechanics.skillRefs, ...value.mechanics.itemRefs, value.mechanics.startingCurrency.currency]; }
    case "class": return [...asKind(definition, "class").mechanics.levelRefs];
    case "class-level": { const value = asKind(definition, "class-level"); return [value.mechanics.classRef, ...value.mechanics.abilityRefs, ...value.mechanics.spellRefs,
      ...(value.mechanics.progressionChoices ?? []).flatMap((choice) => choice.options)]; }
    case "item": return [asKind(definition, "item").mechanics.price.currency];
    case "enemy-template": { const value = asKind(definition, "enemy-template"); return [...value.mechanics.abilityRefs, ...value.private.hiddenAbilityRefs, ...(value.private.hiddenRefs ?? [])]; }
    case "skill": case "ability": case "spell": case "currency": return [];
  }
}

export function publicDependencies(definition: CatalogDefinition): CatalogDefinitionReference[] {
  if (definition.reference.kind !== "enemy-template") return dependencies(definition);
  return [...asKind(definition, "enemy-template").mechanics.abilityRefs];
}

export function privateDependencies(definition: CatalogDefinition): CatalogDefinitionReference[] {
  return definition.reference.kind === "enemy-template"
    ? [...asKind(definition, "enemy-template").private.hiddenAbilityRefs,
      ...(asKind(definition, "enemy-template").private.hiddenRefs ?? [])]
    : [];
}

export function publiclyReachableKeys(definitions: readonly CatalogDefinition[]): Set<string> {
  const keys = new Set(definitions.map((definition) => definitionKey(definition.reference)));
  const publicEdges = new Map<string,string[]>(), allEdges = new Map<string,string[]>(), incoming = new Map<string,number>();
  const directPrivate = new Set<string>();
  for (const definition of definitions) {
    const key=definitionKey(definition.reference);
    const pub=publicDependencies(definition).map(definitionKey).filter((child)=>keys.has(child));
    const priv=privateDependencies(definition).map(definitionKey).filter((child)=>keys.has(child));
    publicEdges.set(key,pub); allEdges.set(key,[...pub,...priv]);
    for (const child of pub) incoming.set(child,(incoming.get(child) ?? 0)+1);
    for (const child of priv) directPrivate.add(child);
  }
  const privateClosure=new Set<string>(), pendingPrivate=[...directPrivate];
  while(pendingPrivate.length){const key=pendingPrivate.shift()!;if(privateClosure.has(key))continue;privateClosure.add(key);pendingPrivate.push(...(allEdges.get(key)??[]));}
  const roots=definitions.filter((definition)=>{const key=definitionKey(definition.reference);return !privateClosure.has(key)
    && (["race","background","class","enemy-template"].includes(definition.reference.kind)||(incoming.get(key)??0)===0);})
    .map((definition)=>definitionKey(definition.reference));
  const reachable=new Set<string>();
  while(roots.length){const key=roots.shift()!;if(reachable.has(key))continue;reachable.add(key);roots.push(...(publicEdges.get(key)??[]));}
  return reachable;
}

function digestInput(input: PublishContentCatalogInput): string {
  const stripIdentity = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripIdentity);
    if (value !== null && typeof value === "object") return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "digest" && key !== "packVersion" && key !== "idempotencyKey")
        .map(([key, child]) => [key, stripIdentity(child)]),
    );
    return value;
  };
  return canonicalCatalogJson(stripIdentity({ manifest: input.manifest, definitions: sortedDefinitions(input.definitions) }));
}

export function calculateCatalogDigest(input: PublishContentCatalogInput): string {
  return createHash("sha256").update(digestInput(input), "utf8").digest("hex");
}

function issueSort(left: CatalogValidationIssue, right: CatalogValidationIssue): number {
  return binaryCompare(left.path, right.path)
    || binaryCompare(left.code, right.code)
    || binaryCompare(left.message, right.message)
    || binaryCompare(left.reference ? definitionKey(left.reference) : "", right.reference ? definitionKey(right.reference) : "");
}

/** Pure, deterministic validation: no database, clock, IDs, files, or network. */
export function validateContentCatalog(input: unknown): CatalogValidationReport {
  const parsed = publishContentCatalogInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues: CatalogValidationIssue[] = parsed.error.issues.map((entry) => ({
      code: "invalid-input" as const,
      path: entry.path.length ? entry.path.join(".") : "$",
      message: entry.message,
    })).sort(issueSort);
    return catalogValidationReportSchema.parse({
      valid: false,
      issues,
      normalizedSummary: { totalDefinitions: 0, counts: KINDS.map((kind) => ({ kind, count: 0 })), digest: null },
    });
  }

  const normalized = parsed.data;
  const issues: CatalogValidationIssue[] = [];
  const counts = new Map<CatalogDefinitionKind, number>(KINDS.map((kind) => [kind, 0]));
  const identities = new Map<string, CatalogDefinition>();
  normalized.definitions.forEach((definition, index) => {
    const reference = definition.reference;
    counts.set(reference.kind, (counts.get(reference.kind) ?? 0) + 1);
    if (reference.packId !== normalized.manifest.packId || reference.packVersion !== normalized.manifest.packVersion) {
      issues.push({ code: "identity-mismatch", path: `definitions.${index}.reference`, message: "definition reference must use the manifest's exact pack ID and version", reference });
    }
    const key = definitionKey(reference);
    if (identities.has(key)) issues.push({ code: "duplicate-definition", path: `definitions.${index}.reference`, message: `duplicate definition ${reference.kind}:${reference.definitionId}`, reference });
    else identities.set(key, definition);
  });

  for (const kind of KINDS) {
    if ((counts.get(kind) ?? 0) === 0) issues.push({ code: "incomplete-starter", path: `definitions.${kind}`, message: `validated-v1 requires at least one ${kind} definition` });
  }

  normalized.definitions.forEach((definition) => {
    for (const reference of dependencies(definition)) {
      const path = `definitions.${definition.reference.kind}:${definition.reference.definitionId}.references.${reference.kind}:${reference.definitionId}`;
      if (reference.packId !== normalized.manifest.packId || reference.packVersion !== normalized.manifest.packVersion) {
        issues.push({ code: "identity-mismatch", path, message: "dependencies must resolve within this exact immutable publication", reference });
      } else if (!identities.has(definitionKey(reference))) {
        issues.push({ code: "missing-reference", path, message: `missing exact reference ${reference.kind}:${reference.definitionId}`, reference });
      }
    }
  });

  // Class-level identity, ownership, and complete monotonic progression are
  // cross-record invariants. Every level belongs to exactly one class.
  const levelReferenceCounts = new Map<string, number>();
  for (const definition of normalized.definitions) {
    if (definition.reference.kind !== "class") continue;
    const classDefinition = asKind(definition, "class");
    const levels = classDefinition.mechanics.levelRefs.map((reference) => identities.get(definitionKey(reference)))
      .filter((entry): entry is CatalogByKind<"class-level"> => entry?.reference.kind === "class-level")
      .map((entry) => asKind(entry, "class-level"));
    const seenLevels = new Set<number>();
    const progressionChoiceIds = new Set<string>();
    for (const level of levels) {
      if (definitionKey(level.mechanics.classRef) !== definitionKey(classDefinition.reference)) {
        issues.push({ code: "wrong-reference-kind", path: `definitions.class:${definition.reference.definitionId}.levels.${level.reference.definitionId}`, message: "class level must refer back to its owning class", reference: level.reference });
      }
      const levelKey = definitionKey(level.reference);
      levelReferenceCounts.set(levelKey, (levelReferenceCounts.get(levelKey) ?? 0) + 1);
      if (seenLevels.has(level.mechanics.level)) issues.push({ code: "duplicate-definition", path: `definitions.class:${definition.reference.definitionId}.level.${level.mechanics.level}`, message: "class progression levels must be unique", reference: level.reference });
      seenLevels.add(level.mechanics.level);
      for (const choice of level.mechanics.progressionChoices ?? []) {
        if (progressionChoiceIds.has(choice.choiceId)) issues.push({ code: "duplicate-definition",
          path: `definitions.class:${definition.reference.definitionId}.choice.${choice.choiceId}`,
          message: "progression choice IDs must be unique across the selected class progression", reference: level.reference });
        progressionChoiceIds.add(choice.choiceId);
        const optionKeys = choice.options.map(definitionKey);
        if (new Set(optionKeys).size !== optionKeys.length) issues.push({ code: "duplicate-definition",
          path: `definitions.class-level:${level.reference.definitionId}.choice.${choice.choiceId}.options`,
          message: "progression choice options must be unique", reference: level.reference });
      }
    }
    if (!seenLevels.has(1)) issues.push({ code: "incomplete-starter", path: `definitions.class:${definition.reference.definitionId}.level.1`, message: "each class requires an exact level 1 definition", reference: definition.reference });
    const orderedLevels = [...seenLevels].sort((left, right) => left - right);
    orderedLevels.forEach((level, index) => {
      if (level !== index + 1) issues.push({ code: "incomplete-starter", path: `definitions.class:${definition.reference.definitionId}.level.${index + 1}`, message: "class progression levels must be contiguous from level 1", reference: definition.reference });
    });
  }
  for (const definition of normalized.definitions) {
    if (definition.reference.kind !== "class-level") continue;
    const level = asKind(definition, "class-level");
    const count = levelReferenceCounts.get(definitionKey(level.reference)) ?? 0;
    const owner = identities.get(definitionKey(level.mechanics.classRef));
    if (owner?.reference.kind !== "class") {
      issues.push({ code: "wrong-reference-kind", path: `definitions.class-level:${level.reference.definitionId}.classRef`, message: "class level must have an existing class owner", reference: level.mechanics.classRef });
    }
    if (count !== 1) issues.push({ code: count === 0 ? "missing-reference" : "duplicate-definition", path: `definitions.class-level:${level.reference.definitionId}.owner`, message: "class level must be referenced exactly once by its owning class", reference: level.reference });
  }

  // Detect dependency cycles. A valid class-level -> owning-class edge is the
  // sole structural back-reference and is not an execution dependency.
  const graph = new Map<string, string[]>();
  for (const definition of normalized.definitions) {
    const refs = dependencies(definition).filter((reference) => {
      if (definition.reference.kind !== "class-level" || reference.kind !== "class") return true;
      const owner = identities.get(definitionKey(reference));
      return owner?.reference.kind !== "class"
        || !asKind(owner, "class").mechanics.levelRefs.some((levelRef) => definitionKey(levelRef) === definitionKey(definition.reference));
    });
    graph.set(definitionKey(definition.reference), refs.map(definitionKey).filter((key) => identities.has(key)).sort(binaryCompare));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reportedCycles = new Set<string>();
  const visit = (key: string, stack: string[]): void => {
    if (visiting.has(key)) {
      const start = stack.indexOf(key);
      const cycle = [...stack.slice(start), key].join(" -> ");
      if (!reportedCycles.has(cycle)) {
        reportedCycles.add(cycle);
        issues.push({ code: "dependency-cycle", path: `definitions.${key.replace("\0", ":")}.dependencies`, message: `catalog dependency cycle: ${cycle.replaceAll("\0", ":")}` });
      }
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const child of graph.get(key) ?? []) visit(child, [...stack, key]);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of [...graph.keys()].sort(binaryCompare)) visit(key, []);

  const digest = calculateCatalogDigest(normalized);
  if (normalized.manifest.digest !== digest) issues.push({ code: "digest-mismatch", path: "manifest.digest", message: `manifest digest must equal canonical SHA-256 ${digest}` });
  if (!normalized.manifest.packVersion.endsWith(`+${digest.slice(0, 12)}`)) {
    issues.push({ code: "digest-mismatch", path: "manifest.packVersion", message: "pack version must end with the first 12 canonical digest characters" });
  }

  issues.sort(issueSort);
  return catalogValidationReportSchema.parse({
    valid: issues.length === 0,
    issues,
    normalizedSummary: { totalDefinitions: normalized.definitions.length, counts: KINDS.map((kind) => ({ kind, count: counts.get(kind) ?? 0 })), digest },
  });
}

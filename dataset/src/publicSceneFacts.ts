/**
 * Source-bound public scene observations for the opt-in public-context diagnostic.
 *
 * This module is deliberately independent of the generator, the run store and the
 * provider clients. It owns ONE toy source recipe, the typed projection of a
 * validated source into facts, and the runtime authority boundary that decides
 * whether a supplied fact may be authorized at all.
 *
 * Two invariants are enforced here rather than by convention:
 *
 *  1. A HASH IS IDENTITY, NOT AUTHORITY. `canonicalDigest` proves that two byte
 *     sequences agree; it never registers a source. Only a source carried by an
 *     independently frozen manifest, loaded against the trusted caller's
 *     pre-dispatch pin, is registered. A completion-supplied source, an ad hoc
 *     source or a mutated source with a freshly recomputed digest fails.
 *  2. TYPES ARE NOT INPUT VALIDATION. Every externally supplied object (source
 *     body, manifest, fact, scope) is parsed with exact key, enum, duplicate and
 *     association checks before any clause may be authorized. A missing
 *     visibility field is a refusal, never a default.
 *
 * The frozen recipe carries exactly two outcome-independent atoms (a visible
 * colour and a fixture state). They supply concrete staging; they establish no
 * action, cause, intent, lock, danger or consequence, and nothing here may be
 * used to authorize one.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "./spec.js";

/** Frozen source recipe version. Bound into every derived identity and the manifest. */
export const PUBLIC_SOURCE_RECIPE_VERSION = "toy-public-observations-v1";
/** The one manifest shape this module can load. */
export const PUBLIC_CONTEXT_MANIFEST_VERSION = "public-context-diagnostic-v1";

export type PublicContextMode = "none" | "observations";

export interface SceneScope {
  readonly sceneId: string;
  /** The exact committed snapshot, never an open-ended interval. */
  readonly turnId: string;
  readonly observerId: "player";
}

export type LightColour = "amber" | "white";
export type ShutterState = "closed" | "open";
export type ScenePredicate = "light-colour" | "shutter-state";
export type SceneValue = LightColour | ShutterState;
export type SceneSubjectKind = "lamplight" | "shutters";
export type SceneAtomKey = "light" | "shutters";
export type SceneDisplayName = "the lamplight" | "the shutters";

export type ObservationValue =
  | { readonly predicate: "light-colour"; readonly value: LightColour }
  | { readonly predicate: "shutter-state"; readonly value: ShutterState };

export interface SceneSubject {
  readonly subjectId: string;
  readonly kind: SceneSubjectKind;
  readonly sceneId: string;
  readonly displayName: SceneDisplayName;
  /** Explicit. A missing visibility is never defaulted to public for this type. */
  readonly visibility: "public";
  readonly observedBy: "player";
}

export type SourceObservation = ObservationValue & {
  readonly atomKey: SceneAtomKey;
  readonly subjectId: string;
};

export interface PublicObservationSourceBody {
  readonly version: typeof PUBLIC_SOURCE_RECIPE_VERSION;
  readonly sourceId: string;
  readonly origin: {
    readonly scenarioSeed: string;
    readonly placeEntityId: string;
    readonly placeDisplayName: string;
  };
  readonly scope: SceneScope;
  readonly visibility: "public";
  readonly observedBy: "player";
  readonly subjects: readonly SceneSubject[];
  readonly observations: readonly SourceObservation[];
}

export interface PublicObservationSource extends PublicObservationSourceBody {
  readonly canonicalDigest: string;
}

export type PublicSceneFact = ObservationValue & SceneScope & {
  readonly factId: string;
  readonly kind: "public-observation";
  readonly visibility: "public";
  readonly subjectId: string;
  readonly source: {
    readonly sourceId: string;
    readonly canonicalDigest: string;
    readonly atomKey: SceneAtomKey;
  };
};

const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** The two frozen atoms. Their surface values are identical in every scene. */
interface AtomRecipe {
  readonly atomKey: SceneAtomKey;
  readonly kind: SceneSubjectKind;
  readonly displayName: SceneDisplayName;
  readonly predicate: ScenePredicate;
  /** The frozen surface value. Every scene in the diagnostic carries these two. */
  readonly frozenValue: SceneValue;
  /** Declared enum members. The others exist to make an opposition explicit. */
  readonly values: readonly SceneValue[];
}
export const PUBLIC_SCENE_ATOMS: readonly AtomRecipe[] = Object.freeze([
  { atomKey: "light", kind: "lamplight", displayName: "the lamplight", predicate: "light-colour",
    frozenValue: "amber", values: ["amber", "white"] },
  { atomKey: "shutters", kind: "shutters", displayName: "the shutters", predicate: "shutter-state",
    frozenValue: "closed", values: ["closed", "open"] },
]);

/** Keeps the predicate/value union discriminated instead of widening to SceneValue. */
function observationRow(atom: AtomRecipe, subjectId: string): SourceObservation {
  return atom.predicate === "light-colour"
    ? { atomKey: atom.atomKey, subjectId, predicate: "light-colour", value: atom.frozenValue as LightColour }
    : { atomKey: atom.atomKey, subjectId, predicate: "shutter-state", value: atom.frozenValue as ShutterState };
}

export function atomRecipeFor(atomKey: SceneAtomKey): AtomRecipe {
  const atom = PUBLIC_SCENE_ATOMS.find((entry) => entry.atomKey === atomKey);
  if (!atom) throw new Error(`unknown public scene atom ${atomKey}`);
  return atom;
}
function recipeForPredicate(predicate: ScenePredicate): AtomRecipe | null {
  return PUBLIC_SCENE_ATOMS.find((entry) => entry.predicate === predicate) ?? null;
}
function recipeForKind(kind: SceneSubjectKind): AtomRecipe | null {
  return PUBLIC_SCENE_ATOMS.find((entry) => entry.kind === kind) ?? null;
}

// ---------------------------------------------------------------------------
// Refusals and strict runtime validation
// ---------------------------------------------------------------------------

export interface PublicSceneRefusal {
  readonly code: string;
  readonly detail: string;
}

export class PublicSceneSourceError extends Error {
  readonly refusals: readonly PublicSceneRefusal[];
  constructor(refusals: readonly PublicSceneRefusal[]) {
    super(`public scene source refused: ${refusals.map((refusal) => `${refusal.code} (${refusal.detail})`).join("; ")}`);
    this.name = "PublicSceneSourceError";
    this.refusals = refusals;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function strictKeys(value: unknown, allowed: readonly string[], label: string, refusals: PublicSceneRefusal[]): boolean {
  if (!isPlainObject(value)) {
    refusals.push({ code: "not-an-object", detail: `${label} is not a JSON object` });
    return false;
  }
  const keys = Object.keys(value).sort();
  const extra = keys.filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (extra.length > 0) refusals.push({ code: "extra-property", detail: `${label} carries unsupported properties ${extra.join(", ")}` });
  if (missing.length > 0) refusals.push({ code: "missing-property", detail: `${label} is missing required properties ${missing.join(", ")}` });
  return extra.length === 0 && missing.length === 0;
}

const identifier = /^[a-z0-9][a-z0-9-]{2,127}$/;
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}

/** Exact-key scope parse. An absent or unrecognised observer is a refusal. */
function parseScope(value: unknown, label: string, refusals: PublicSceneRefusal[]): SceneScope | null {
  if (!strictKeys(value, ["observerId", "sceneId", "turnId"], label, refusals)) return null;
  const scope = value as Record<string, unknown>;
  let ok = true;
  for (const key of ["sceneId", "turnId"] as const) {
    if (!isIdentifier(scope[key])) { refusals.push({ code: "invalid-identity", detail: `${label}.${key} is not a public identity token` }); ok = false; }
  }
  if (scope.observerId !== "player") {
    refusals.push({ code: "observer-mismatch", detail: `${label} observer must be the player; this source type never defaults it` });
    ok = false;
  }
  return ok ? { sceneId: scope.sceneId as string, turnId: scope.turnId as string, observerId: "player" } : null;
}

/** Exact-key source-body parse with the full association and duplicate contract. */
export function parsePublicObservationSourceBody(value: unknown, label: string): PublicObservationSourceBody {
  const refusals: PublicSceneRefusal[] = [];
  if (!strictKeys(value, ["observedBy", "observations", "origin", "scope", "sourceId", "subjects", "version", "visibility"], label, refusals)) {
    throw new PublicSceneSourceError(refusals);
  }
  const body = value as Record<string, unknown>;
  if (body.version !== PUBLIC_SOURCE_RECIPE_VERSION) refusals.push({ code: "invalid-enum", detail: `${label}.version is not ${PUBLIC_SOURCE_RECIPE_VERSION}` });
  if (!isIdentifier(body.sourceId)) refusals.push({ code: "invalid-identity", detail: `${label}.sourceId is not a public identity token` });
  if (body.visibility !== "public") refusals.push({ code: "visibility-not-public", detail: `${label}.visibility must be explicitly public; a missing field is not a default` });
  if (body.observedBy !== "player") refusals.push({ code: "observer-mismatch", detail: `${label}.observedBy must be the player` });
  const origin: { scenarioSeed: string; placeEntityId: string; placeDisplayName: string } = { scenarioSeed: "", placeEntityId: "", placeDisplayName: "" };
  if (strictKeys(body.origin, ["placeDisplayName", "placeEntityId", "scenarioSeed"], `${label}.origin`, refusals)) {
    const supplied = body.origin as Record<string, unknown>;
    if (!isIdentifier(supplied.scenarioSeed) && (typeof supplied.scenarioSeed !== "string" || !supplied.scenarioSeed.trim())) {
      refusals.push({ code: "invalid-identity", detail: `${label}.origin.scenarioSeed is not a seed token` });
    }
    if (!isIdentifier(supplied.placeEntityId)) refusals.push({ code: "invalid-identity", detail: `${label}.origin.placeEntityId is not a public identity token` });
    if (typeof supplied.placeDisplayName !== "string" || !supplied.placeDisplayName.trim()) {
      refusals.push({ code: "invalid-identity", detail: `${label}.origin.placeDisplayName is empty` });
    }
    origin.scenarioSeed = String(supplied.scenarioSeed);
    origin.placeEntityId = String(supplied.placeEntityId);
    origin.placeDisplayName = String(supplied.placeDisplayName);
  }
  const scope = parseScope(body.scope, `${label}.scope`, refusals) ?? { sceneId: "", turnId: "", observerId: "player" as const };

  const subjects: SceneSubject[] = [];
  if (!Array.isArray(body.subjects) || body.subjects.length === 0) {
    refusals.push({ code: "missing-property", detail: `${label}.subjects must be a nonempty array` });
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of body.subjects.entries()) {
      const subjectLabel = `${label}.subjects[${index}]`;
      if (!strictKeys(entry, ["displayName", "kind", "observedBy", "sceneId", "subjectId", "visibility"], subjectLabel, refusals)) continue;
      const subject = entry as Record<string, unknown>;
      const kind = recipeForKind(subject.kind as SceneSubjectKind);
      if (!kind) { refusals.push({ code: "invalid-enum", detail: `${subjectLabel}.kind is not a registered subject kind` }); continue; }
      if (subject.displayName !== kind.displayName) refusals.push({ code: "subject-display-mismatch", detail: `${subjectLabel}.displayName is not the registered label ${kind.displayName}` });
      if (subject.sceneId !== scope.sceneId) refusals.push({ code: "cross-scene-subject", detail: `${subjectLabel}.sceneId is not the source scene` });
      if (subject.visibility !== "public") refusals.push({ code: "visibility-not-public", detail: `${subjectLabel}.visibility must be explicitly public` });
      if (subject.observedBy !== "player") refusals.push({ code: "observer-mismatch", detail: `${subjectLabel}.observedBy must be the player` });
      if (!isIdentifier(subject.subjectId)) { refusals.push({ code: "invalid-identity", detail: `${subjectLabel}.subjectId is not a public identity token` }); continue; }
      if (seen.has(subject.subjectId)) refusals.push({ code: "duplicate-subject-id", detail: `${subjectLabel}.subjectId repeats` });
      seen.add(subject.subjectId);
      subjects.push({ subjectId: subject.subjectId, kind: kind.kind, sceneId: scope.sceneId,
        displayName: kind.displayName, visibility: "public", observedBy: "player" });
    }
  }

  const observations: SourceObservation[] = [];
  if (!Array.isArray(body.observations) || body.observations.length === 0) {
    refusals.push({ code: "missing-property", detail: `${label}.observations must be a nonempty array` });
  } else {
    const seenAtoms = new Set<string>();
    const byId = new Map(subjects.map((subject) => [subject.subjectId, subject]));
    for (const [index, entry] of body.observations.entries()) {
      const observationLabel = `${label}.observations[${index}]`;
      const atom = recipeForPredicate((entry as { predicate?: unknown })?.predicate as ScenePredicate);
      if (!atom) { refusals.push({ code: "predicate-kind-mismatch", detail: `${observationLabel}.predicate is not a registered scene predicate` }); continue; }
      if (!strictKeys(entry, ["atomKey", "predicate", "subjectId", "value"], observationLabel, refusals)) continue;
      const observation = entry as Record<string, unknown>;
      if (observation.atomKey !== atom.atomKey) refusals.push({ code: "predicate-kind-mismatch", detail: `${observationLabel}.atomKey ${String(observation.atomKey)} does not belong to predicate ${atom.predicate}` });
      if (!atom.values.includes(observation.value as SceneValue)) refusals.push({ code: "invalid-enum", detail: `${observationLabel}.value is not a declared ${atom.predicate} value` });
      if (seenAtoms.has(atom.atomKey)) refusals.push({ code: "duplicate-atom-key", detail: `${observationLabel} repeats atom ${atom.atomKey}; a contradictory duplicate is refused, not merged` });
      seenAtoms.add(atom.atomKey);
      const subject = typeof observation.subjectId === "string" ? byId.get(observation.subjectId) : undefined;
      if (!subject) { refusals.push({ code: "subject-unresolved", detail: `${observationLabel}.subjectId does not resolve to a subject of this source` }); continue; }
      if (subject.kind !== atom.kind) refusals.push({ code: "predicate-kind-mismatch", detail: `${observationLabel} predicate ${atom.predicate} does not belong to subject kind ${subject.kind}` });
      observations.push(atom.predicate === "light-colour"
        ? { atomKey: atom.atomKey, subjectId: subject.subjectId, predicate: "light-colour", value: observation.value as LightColour }
        : { atomKey: atom.atomKey, subjectId: subject.subjectId, predicate: "shutter-state", value: observation.value as ShutterState });
    }
  }

  if (refusals.length > 0) throw new PublicSceneSourceError(refusals);
  return Object.freeze({
    version: PUBLIC_SOURCE_RECIPE_VERSION,
    sourceId: body.sourceId as string,
    origin: Object.freeze({ ...origin }),
    scope: Object.freeze({ ...scope }),
    visibility: "public",
    observedBy: "player",
    subjects: Object.freeze(subjects.map((subject) => Object.freeze(subject))),
    observations: Object.freeze(observations.map((observation) => Object.freeze(observation))),
  });
}

// ---------------------------------------------------------------------------
// Deterministic construction, digests and projection
// ---------------------------------------------------------------------------

/** The exact body whose canonical digest is `canonicalDigest`. */
export function publicObservationSourceBody(source: PublicObservationSourceBody): PublicObservationSourceBody {
  return {
    version: source.version,
    sourceId: source.sourceId,
    origin: { scenarioSeed: source.origin.scenarioSeed, placeEntityId: source.origin.placeEntityId, placeDisplayName: source.origin.placeDisplayName },
    scope: { sceneId: source.scope.sceneId, turnId: source.scope.turnId, observerId: source.scope.observerId },
    visibility: source.visibility,
    observedBy: source.observedBy,
    subjects: source.subjects.map((subject) => ({
      subjectId: subject.subjectId, kind: subject.kind, sceneId: subject.sceneId,
      displayName: subject.displayName, visibility: subject.visibility, observedBy: subject.observedBy,
    })),
    observations: source.observations.map((observation) => observation.predicate === "light-colour"
      ? { atomKey: observation.atomKey, subjectId: observation.subjectId, predicate: "light-colour" as const, value: observation.value }
      : { atomKey: observation.atomKey, subjectId: observation.subjectId, predicate: "shutter-state" as const, value: observation.value }),
  };
}

export function publicObservationSourceDigest(source: PublicObservationSourceBody): string {
  return sha256Hex(stableStringify(publicObservationSourceBody(source)));
}

/** Identity is the fact slot; its revision and value are bound by the source digest. */
export function publicSceneFactId(sourceId: string, atomKey: SceneAtomKey): string {
  return `scene-fact-${sha256Hex(stableStringify({ atomKey, sourceId }))}`;
}

/**
 * The toy source. Built AFTER the base spec and realization slots are resolved,
 * from the scenario identity and the resolved public place only. It consumes no
 * generator RNG and no check outcome, damage, tone, prose or rating.
 */
export function createToyPublicObservationSource(input: {
  readonly scenarioSeed: string;
  readonly resolvedPlace: { readonly entityId: string; readonly displayName: string };
}): PublicObservationSource {
  const { scenarioSeed, resolvedPlace } = input;
  const identity = (domain: string): string => sha256Hex(`${PUBLIC_SOURCE_RECIPE_VERSION}|${domain}|${scenarioSeed}`);
  const sceneId = `public-scene-${identity("scene").slice(0, 16)}`;
  const turnId = `committed-turn-${identity("turn").slice(0, 16)}`;
  const sourceId = `public-observation-source-${identity("source").slice(0, 16)}`;
  const placeEntityId = `place-${sha256Hex(`${PUBLIC_SOURCE_RECIPE_VERSION}|place|${sceneId}|${resolvedPlace.entityId}`).slice(0, 12)}`;
  const subjectIdOf = (atom: AtomRecipe): string => `scene-subject-${sha256Hex(`${PUBLIC_SOURCE_RECIPE_VERSION}|${sourceId}|subject|${atom.atomKey}`).slice(0, 12)}`;
  const body = {
    version: PUBLIC_SOURCE_RECIPE_VERSION,
    sourceId,
    origin: { scenarioSeed, placeEntityId, placeDisplayName: resolvedPlace.displayName },
    scope: { sceneId, turnId, observerId: "player" as const },
    visibility: "public" as const,
    observedBy: "player" as const,
    subjects: PUBLIC_SCENE_ATOMS.map((atom) => ({
      subjectId: subjectIdOf(atom),
      kind: atom.kind,
      sceneId,
      displayName: atom.displayName,
      visibility: "public" as const,
      observedBy: "player" as const,
    })),
    observations: PUBLIC_SCENE_ATOMS.map((atom) => observationRow(atom, subjectIdOf(atom))),
  };
  const parsed = parsePublicObservationSourceBody(body, `source(${sourceId})`);
  const canonicalDigest = publicObservationSourceDigest(parsed);
  return Object.freeze({ ...parsed, canonicalDigest });
}

/** Validate a source and its declared digest together. */
export function parsePublicObservationSource(value: unknown, label: string): PublicObservationSource {
  if (!isPlainObject(value) || !("canonicalDigest" in value)) {
    throw new PublicSceneSourceError([{ code: "not-an-object", detail: `${label} is not a public observation source` }]);
  }
  const { canonicalDigest, ...bodyValue } = value as Record<string, unknown>;
  const body = parsePublicObservationSourceBody(bodyValue, label);
  const expected = publicObservationSourceDigest(body);
  if (canonicalDigest !== expected) {
    throw new PublicSceneSourceError([{ code: "source-digest-mismatch",
      detail: `${label}.canonicalDigest does not reproduce its declared body bytes` }]);
  }
  return Object.freeze({ ...body, canonicalDigest: expected });
}

/** Project a validated source into its typed facts. Only the projection adds ids. */
export function projectPublicSceneFacts(source: PublicObservationSource): readonly PublicSceneFact[] {
  return Object.freeze(source.observations.map((observation) => Object.freeze(
    observation.predicate === "light-colour"
      ? {
        factId: publicSceneFactId(source.sourceId, observation.atomKey),
        kind: "public-observation" as const,
        visibility: "public" as const,
        subjectId: observation.subjectId,
        predicate: "light-colour" as const,
        value: observation.value,
        sceneId: source.scope.sceneId,
        turnId: source.scope.turnId,
        observerId: source.scope.observerId,
        source: { sourceId: source.sourceId, canonicalDigest: source.canonicalDigest, atomKey: observation.atomKey },
      }
      : {
        factId: publicSceneFactId(source.sourceId, observation.atomKey),
        kind: "public-observation" as const,
        visibility: "public" as const,
        subjectId: observation.subjectId,
        predicate: "shutter-state" as const,
        value: observation.value,
        sceneId: source.scope.sceneId,
        turnId: source.scope.turnId,
        observerId: source.scope.observerId,
        source: { sourceId: source.sourceId, canonicalDigest: source.canonicalDigest, atomKey: observation.atomKey },
      },
  )));
}

// ---------------------------------------------------------------------------
// Frozen diagnostic manifest
// ---------------------------------------------------------------------------

export interface FrozenBaseChallenge {
  readonly baseIndex: number;
  readonly baseUnitId: string;
  readonly scenarioSeed: string;
  readonly realizationSeed: string;
  readonly slots: Readonly<Record<string, string>>;
  /** The frozen realization slots, including the requested voice and lens. */
  readonly realizationSlots: Readonly<Record<string, string>>;
  readonly receiptsDigest: string;
  readonly split: string;
  readonly lineage: Readonly<Record<string, string>>;
  readonly clusterId: string;
  readonly clusterFamily: string;
  /** Digest over mechanics, slots, split, lineage and cluster, compared on every plan. */
  readonly comparisonDigest: string;
}

export interface PublicContextScheduleRow {
  readonly unitId: string;
  readonly pairId: string;
  readonly baseUnitId: string;
  readonly publicContext: PublicContextMode;
  readonly sourceId: string;
}

export type PublicContextDiagnosticManifestBody = {
  readonly version: typeof PUBLIC_CONTEXT_MANIFEST_VERSION;
  readonly sourceRecipeVersion: typeof PUBLIC_SOURCE_RECIPE_VERSION;
  readonly seed: string;
  readonly overlayTemplateVersion: string;
  readonly bases: readonly FrozenBaseChallenge[];
  readonly sources: readonly PublicObservationSource[];
  readonly schedule: readonly PublicContextScheduleRow[];
};

export type PublicContextDiagnosticManifest = PublicContextDiagnosticManifestBody & {
  readonly manifestDigest: string;
};

/** The exact manifest bytes the pin is taken over. */
export function publicContextDiagnosticManifestBody(manifest: PublicContextDiagnosticManifest): PublicContextDiagnosticManifestBody {
  const { manifestDigest: _manifestDigest, ...body } = manifest;
  return {
    version: manifest.version,
    sourceRecipeVersion: manifest.sourceRecipeVersion,
    seed: manifest.seed,
    overlayTemplateVersion: manifest.overlayTemplateVersion,
    bases: manifest.bases,
    sources: manifest.sources,
    schedule: manifest.schedule,
  };
}

export function publicContextDiagnosticManifestDigest(manifest: PublicContextDiagnosticManifest): string {
  return sha256Hex(stableStringify(publicContextDiagnosticManifestBody(manifest)));
}

const ARMS: readonly PublicContextMode[] = Object.freeze(["none", "observations"]);

export function publicContextUnitId(baseUnitId: string, mode: PublicContextMode): string {
  return `${baseUnitId}-pc-${mode}`;
}

function parseBase(value: unknown, label: string, refusals: PublicSceneRefusal[]): FrozenBaseChallenge | null {
  const allowed = ["baseIndex", "baseUnitId", "clusterFamily", "clusterId", "comparisonDigest", "lineage", "realizationSeed", "realizationSlots", "receiptsDigest", "scenarioSeed", "slots", "split"];
  if (!strictKeys(value, allowed, label, refusals)) return null;
  const base = value as Record<string, unknown>;
  if (!Number.isSafeInteger(base.baseIndex) || (base.baseIndex as number) < 0) refusals.push({ code: "invalid-identity", detail: `${label}.baseIndex is not a frozen plan index` });
  for (const key of ["baseUnitId", "clusterId"] as const) if (!isIdentifier(base[key])) refusals.push({ code: "invalid-identity", detail: `${label}.${key} is not a public identity token` });
  for (const key of ["clusterFamily", "realizationSeed", "scenarioSeed", "split"] as const) {
    if (typeof base[key] !== "string" || !(base[key] as string).trim()) refusals.push({ code: "invalid-identity", detail: `${label}.${key} is empty` });
  }
  for (const key of ["comparisonDigest", "receiptsDigest"] as const) {
    if (typeof base[key] !== "string" || !/^[0-9a-f]{64}$/.test(base[key] as string)) refusals.push({ code: "invalid-digest", detail: `${label}.${key} is not a sha-256 digest` });
  }
  if (!isPlainObject(base.slots) || Object.keys(base.slots).length === 0) refusals.push({ code: "missing-property", detail: `${label}.slots must retain the base slots` });
  if (!isPlainObject(base.realizationSlots) || typeof (base.realizationSlots as Record<string, unknown>).tone !== "string") {
    refusals.push({ code: "missing-property", detail: `${label}.realizationSlots must retain the requested voice` });
  }
  if (!isPlainObject(base.lineage) || !["characterFamily", "worldFamily", "scenarioFamily"].every((field) => typeof (base.lineage as Record<string, unknown>)[field] === "string")) {
    refusals.push({ code: "missing-property", detail: `${label}.lineage must retain the base lineage groups` });
  }
  return {
    baseIndex: base.baseIndex as number,
    baseUnitId: base.baseUnitId as string,
    scenarioSeed: base.scenarioSeed as string,
    realizationSeed: base.realizationSeed as string,
    slots: { ...(base.slots as Record<string, string>) },
    realizationSlots: { ...(base.realizationSlots as Record<string, string>) },
    receiptsDigest: base.receiptsDigest as string,
    split: base.split as string,
    lineage: { ...(base.lineage as Record<string, string>) },
    clusterId: base.clusterId as string,
    clusterFamily: base.clusterFamily as string,
    comparisonDigest: base.comparisonDigest as string,
  };
}

/**
 * Runtime validation of a frozen manifest. The digest pin is checked by the
 * loader; this only establishes that the bytes are a well-formed manifest.
 */
export function parsePublicContextDiagnosticManifest(value: unknown): PublicContextDiagnosticManifest {
  const refusals: PublicSceneRefusal[] = [];
  if (!strictKeys(value, ["bases", "manifestDigest", "overlayTemplateVersion", "schedule", "seed", "sourceRecipeVersion", "sources", "version"], "manifest", refusals)) {
    throw new PublicSceneSourceError(refusals);
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== PUBLIC_CONTEXT_MANIFEST_VERSION) refusals.push({ code: "invalid-enum", detail: `manifest.version is not ${PUBLIC_CONTEXT_MANIFEST_VERSION}` });
  if (manifest.sourceRecipeVersion !== PUBLIC_SOURCE_RECIPE_VERSION) refusals.push({ code: "invalid-enum", detail: `manifest.sourceRecipeVersion is not ${PUBLIC_SOURCE_RECIPE_VERSION}` });
  for (const key of ["seed", "overlayTemplateVersion"] as const) {
    if (typeof manifest[key] !== "string" || !(manifest[key] as string).trim()) refusals.push({ code: "invalid-identity", detail: `manifest.${key} is empty` });
  }
  const bases: FrozenBaseChallenge[] = [];
  if (!Array.isArray(manifest.bases) || manifest.bases.length !== 3) {
    refusals.push({ code: "base-count", detail: `the diagnostic freezes exactly three base challenges, got ${Array.isArray(manifest.bases) ? manifest.bases.length : "none"}` });
  } else {
    for (const [index, entry] of manifest.bases.entries()) {
      const base = parseBase(entry, `manifest.bases[${index}]`, refusals);
      if (base) bases.push(base);
    }
    if (new Set(bases.map((base) => base.baseUnitId)).size !== bases.length) refusals.push({ code: "duplicate-base-identity", detail: "two frozen bases share a base unit id" });
    if (new Set(bases.map((base) => base.scenarioSeed)).size !== bases.length) refusals.push({ code: "duplicate-base-identity", detail: "two frozen bases share a scenario seed" });
    if (new Set(bases.map((base) => base.baseIndex)).size !== bases.length) refusals.push({ code: "duplicate-base-identity", detail: "two frozen bases share a plan index" });
  }
  const sources: PublicObservationSource[] = [];
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== bases.length || manifest.sources.length === 0) {
    refusals.push({ code: "source-count", detail: "the manifest must carry exactly one frozen source per base" });
  } else {
    for (const [index, entry] of manifest.sources.entries()) {
      try { sources.push(parsePublicObservationSource(entry, `manifest.sources[${index}]`)); }
      catch (error) {
        for (const refusal of error instanceof PublicSceneSourceError ? error.refusals : [{ code: "not-an-object", detail: `manifest.sources[${index}] is invalid` }]) {
          refusals.push(refusal);
        }
      }
    }
    if (new Set(sources.map((source) => source.sourceId)).size !== sources.length) refusals.push({ code: "duplicate-source-identity", detail: "two frozen sources share a source id" });
    if (new Set(sources.map((source) => source.scope.sceneId)).size !== sources.length) refusals.push({ code: "duplicate-source-identity", detail: "two frozen sources share a scene" });
  }
  const baseById = new Map(bases.map((base) => [base.baseUnitId, base]));
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  const schedule: PublicContextScheduleRow[] = [];
  if (!Array.isArray(manifest.schedule) || manifest.schedule.length !== bases.length * ARMS.length) {
    refusals.push({ code: "schedule-shape", detail: `the schedule must hold exactly six unit rows, got ${Array.isArray(manifest.schedule) ? manifest.schedule.length : "none"}` });
  } else {
    for (const [index, entry] of manifest.schedule.entries()) {
      if (!strictKeys(entry, ["baseUnitId", "pairId", "publicContext", "sourceId", "unitId"], `manifest.schedule[${index}]`, refusals)) continue;
      const row = entry as Record<string, unknown>;
      if (!ARMS.includes(row.publicContext as PublicContextMode)) { refusals.push({ code: "invalid-enum", detail: `manifest.schedule[${index}].publicContext is not a diagnostic mode` }); continue; }
      if (!isIdentifier(row.pairId) || !isIdentifier(row.unitId)) { refusals.push({ code: "invalid-identity", detail: `manifest.schedule[${index}] has no public pair/unit identity` }); continue; }
      const base = baseById.get(String(row.baseUnitId));
      if (!base) { refusals.push({ code: "base-not-frozen", detail: `manifest.schedule[${index}] names a base challenge that is not frozen` }); continue; }
      const source = sourceById.get(String(row.sourceId));
      if (!source) { refusals.push({ code: "source-not-registered", detail: `manifest.schedule[${index}] names a source that is not frozen` }); continue; }
      if (source.origin.scenarioSeed !== base.scenarioSeed) {
        refusals.push({ code: "origin-mismatch", detail: `manifest.schedule[${index}] binds a source from another scenario seed` });
      }
      if (row.unitId !== publicContextUnitId(base.baseUnitId, row.publicContext as PublicContextMode)) {
        refusals.push({ code: "schedule-identity-mismatch", detail: `manifest.schedule[${index}].unitId does not match its base and mode` });
      }
      schedule.push({ unitId: row.unitId as string, pairId: row.pairId as string, baseUnitId: base.baseUnitId,
        publicContext: row.publicContext as PublicContextMode, sourceId: source.sourceId });
    }
    if (new Set(schedule.map((row) => row.unitId)).size !== schedule.length) refusals.push({ code: "duplicate-unit-identity", detail: "two scheduled rows share a unit id" });
    const pairs = new Map<string, PublicContextScheduleRow[]>();
    for (const row of schedule) pairs.set(row.pairId, [...(pairs.get(row.pairId) ?? []), row]);
    if (pairs.size !== bases.length) refusals.push({ code: "pair-count", detail: `the diagnostic schedules exactly three matched pairs, got ${pairs.size}` });
    for (const [pairId, rows] of pairs) {
      const modes = rows.map((row) => row.publicContext).sort();
      if (rows.length !== ARMS.length || modes.join(",") !== [...ARMS].sort().join(",")) {
        refusals.push({ code: "pair-shape", detail: `pair ${pairId} does not carry exactly one control and one observation row` });
      }
      if (new Set(rows.map((row) => row.baseUnitId)).size !== 1 || new Set(rows.map((row) => row.sourceId)).size !== 1) {
        refusals.push({ code: "pair-mismatch", detail: `pair ${pairId} arms do not share one base challenge and one source` });
      }
    }
  }
  if (typeof manifest.manifestDigest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest)) {
    refusals.push({ code: "invalid-digest", detail: "manifest.manifestDigest is not a sha-256 digest" });
  }
  if (refusals.length > 0) throw new PublicSceneSourceError(refusals);
  const body: PublicContextDiagnosticManifestBody = {
    version: PUBLIC_CONTEXT_MANIFEST_VERSION,
    sourceRecipeVersion: PUBLIC_SOURCE_RECIPE_VERSION,
    seed: manifest.seed as string,
    overlayTemplateVersion: manifest.overlayTemplateVersion as string,
    bases,
    sources,
    schedule,
  };
  return { ...body, manifestDigest: publicContextDiagnosticManifestDigest({ ...body, manifestDigest: "" }) };
}

// ---------------------------------------------------------------------------
// Authority and resolution
// ---------------------------------------------------------------------------

/** Module-local brand: only this module can construct a verified authority. */
const publicSceneAuthorityBrand: unique symbol = Symbol("velvet.public-scene-authority-v1");

export interface PublicSceneAuthorityEntry {
  readonly unitId: string;
  readonly pairId: string;
  readonly baseUnitId: string;
  readonly publicContext: PublicContextMode;
  readonly sourceId: string;
  readonly scope: SceneScope;
  readonly source: PublicObservationSource;
  /** Exactly the facts this arm may expose: zero for the control. */
  readonly permittedFactIds: readonly string[];
}

export interface VerifiedPublicSceneAuthority {
  readonly [publicSceneAuthorityBrand]: true;
  readonly version: typeof PUBLIC_CONTEXT_MANIFEST_VERSION;
  readonly manifestDigest: string;
  readonly manifest: PublicContextDiagnosticManifest;
  readonly entries: ReadonlyMap<string, PublicSceneAuthorityEntry>;
}

/**
 * Issue the runtime authority. A manifest alone is not authority: it must be
 * complete, internally consistent, and equal to the trusted caller's
 * pre-dispatch pin. The result is a frozen, branded registry.
 */
export function loadPublicSceneAuthority(input: {
  readonly manifest: PublicContextDiagnosticManifest;
  readonly expectedManifestDigest: string;
}): VerifiedPublicSceneAuthority {
  const manifest = parsePublicContextDiagnosticManifest(input.manifest);
  const refusals: PublicSceneRefusal[] = [];
  const recomputed = publicContextDiagnosticManifestDigest(manifest);
  if (manifest.manifestDigest !== recomputed) refusals.push({ code: "source-digest-mismatch", detail: "manifest digest does not reproduce the frozen manifest bytes" });
  if (input.expectedManifestDigest !== manifest.manifestDigest) {
    refusals.push({ code: "manifest-pin-mismatch", detail: "the trusted pre-dispatch manifest pin does not match this manifest" });
  }
  if (refusals.length > 0) throw new PublicSceneSourceError(refusals);

  const sources = new Map(manifest.sources.map((source) => [source.sourceId, source]));
  const entries = new Map<string, PublicSceneAuthorityEntry>();
  for (const row of manifest.schedule) {
    const source = sources.get(row.sourceId)!;
    entries.set(row.unitId, Object.freeze({
      unitId: row.unitId,
      pairId: row.pairId,
      baseUnitId: row.baseUnitId,
      publicContext: row.publicContext,
      sourceId: row.sourceId,
      scope: Object.freeze({ ...source.scope }),
      source,
      permittedFactIds: Object.freeze(row.publicContext === "observations"
        ? projectPublicSceneFacts(source).map((fact) => fact.factId)
        : []),
    }));
  }
  return Object.freeze({
    [publicSceneAuthorityBrand]: true as const,
    version: PUBLIC_CONTEXT_MANIFEST_VERSION,
    manifestDigest: manifest.manifestDigest,
    manifest: Object.freeze({ ...manifest, bases: Object.freeze(manifest.bases.map((base) => Object.freeze(base))),
      sources: Object.freeze(manifest.sources), schedule: Object.freeze(manifest.schedule) }),
    entries,
  });
}

/** Brand check: a JSON manifest, a cast or a hand-built object is never authority. */
export function assertVerifiedPublicSceneAuthority(value: unknown): VerifiedPublicSceneAuthority {
  if (!isPlainObject(value) || (value as Record<symbol, unknown>)[publicSceneAuthorityBrand] !== true
    || !isPlainObject(value.entries) || typeof value.manifestDigest !== "string") {
    throw new PublicSceneSourceError([{ code: "authority-not-verified",
      detail: "public scene authority must be issued by loadPublicSceneAuthority against a pinned frozen manifest" }]);
  }
  return value as unknown as VerifiedPublicSceneAuthority;
}

export interface BoundSceneObservation {
  readonly factId: string;
  readonly subjectId: string;
  readonly displayName: SceneDisplayName;
  readonly predicate: ScenePredicate;
  readonly value: SceneValue;
  readonly sourceId: string;
  readonly sourceCanonicalDigest: string;
  readonly sceneId: string;
  readonly turnId: string;
  readonly observerId: "player";
}

export type ResolvedPublicSceneFacts =
  | {
      readonly ok: true;
      readonly unitId: string;
      readonly pairId: string;
      readonly mode: PublicContextMode;
      readonly scope: SceneScope;
      readonly sourceId: string;
      readonly sourceCanonicalDigest: string;
      readonly manifestDigest: string;
      readonly facts: readonly PublicSceneFact[];
      readonly factIds: readonly string[];
      readonly observations: readonly BoundSceneObservation[];
    }
  | { readonly ok: false; readonly refusals: readonly PublicSceneRefusal[] };

const sameScope = (left: SceneScope, right: SceneScope): boolean =>
  left.sceneId === right.sceneId && left.turnId === right.turnId && left.observerId === right.observerId;

/**
 * The only path from a supplied fact to an authorized clause.
 *
 * Checks, in order: the authority is really issued by the loader; the unit is
 * registered in the frozen schedule; the expected scope equals the registered
 * scope; every fact is exactly the registered source row under the registered
 * digest and fact-id recipe; and the supplied set is exactly this arm's
 * permitted projection. Input integrity is checked -- never required mention of
 * an observation in the answer.
 */
export function resolvePublicSceneFacts(input: {
  readonly unitId: string;
  readonly scope: SceneScope;
  readonly facts: readonly PublicSceneFact[];
  readonly authority: VerifiedPublicSceneAuthority;
}): ResolvedPublicSceneFacts {
  const refusals: PublicSceneRefusal[] = [];
  const refuse = (code: string, detail: string): null => { refusals.push({ code, detail }); return null; };
  let authority: VerifiedPublicSceneAuthority;
  try { authority = assertVerifiedPublicSceneAuthority(input.authority); }
  catch (error) {
    return { ok: false, refusals: error instanceof PublicSceneSourceError ? error.refusals
      : [{ code: "authority-not-verified", detail: "public scene authority is not verified" }] };
  }
  const entry = authority.entries.get(input.unitId);
  if (!entry) refuse("unit-not-registered", `unit ${input.unitId} is not a registered scheduled arm of the frozen manifest`);
  const expectedScope: SceneScope | null = strictKeys(input.scope, ["observerId", "sceneId", "turnId"], "publicScene.scope", refusals)
    ? { sceneId: String(input.scope.sceneId), turnId: String(input.scope.turnId), observerId: input.scope.observerId as "player" }
    : refuse("scope-invalid", "the supplied scene scope is not an exact public player scope");
  if (entry && expectedScope && !sameScope(expectedScope, entry.scope)) {
    refuse("scope-mismatch", "the supplied scene scope is not the scope this arm was scheduled with");
  }
  if (expectedScope && expectedScope.observerId !== "player") {
    refuse("observer-mismatch", "the supplied scope names an observer other than the player");
  }
  if (!Array.isArray(input.facts)) refuse("facts-invalid", "supplied scene facts are not an array");
  if (refusals.length > 0) return { ok: false, refusals };

  const known = entry!;
  const rows = new Map(known.source.observations.map((observation) => [observation.atomKey, observation]));
  const subjects = new Map(known.source.subjects.map((subject) => [subject.subjectId, subject]));
  const seenFacts = new Set<string>();
  const seenAtoms = new Set<string>();
  const facts: PublicSceneFact[] = [];
  for (const [index, raw] of (input.facts as readonly unknown[]).entries()) {
    const label = `publicScene.facts[${index}]`;
    if (!strictKeys(raw, ["factId", "kind", "observerId", "predicate", "sceneId", "source", "subjectId", "turnId", "value", "visibility"], label, refusals)) continue;
    const fact = raw as Record<string, unknown>;
    if (fact.kind !== "public-observation") { refuse("fact-kind-mismatch", `${label}.kind is not a public observation`); continue; }
    if (fact.visibility !== "public") { refuse("visibility-not-public", `${label}.visibility must be explicitly public; it is never defaulted`); continue; }
    if (fact.observerId !== known.scope.observerId) { refuse("observer-mismatch", `${label}.observerId is not this scene's observer`); continue; }
    if (fact.sceneId !== known.scope.sceneId || fact.turnId !== known.scope.turnId) { refuse("scope-mismatch", `${label} is not bound to this arm's exact committed snapshot`); continue; }
    if (!strictKeys(fact.source, ["atomKey", "canonicalDigest", "sourceId"], `${label}.source`, refusals)) continue;
    const cited = fact.source as Record<string, unknown>;
    if (cited.sourceId !== known.source.sourceId) { refuse("source-not-registered", `${label}.source is not a source registered for this arm`); continue; }
    if (cited.canonicalDigest !== known.source.canonicalDigest) {
      refuse("source-digest-mismatch", `${label}.source digest is not the frozen source revision for this arm`);
      continue;
    }
    const atom = typeof cited.atomKey === "string" ? recipeForPredicate(fact.predicate as ScenePredicate) : null;
    if (!atom || cited.atomKey !== atom.atomKey) { refuse("predicate-kind-mismatch", `${label} predicate does not belong to its source atom`); continue; }
    const row = rows.get(atom.atomKey)!;
    const subject = typeof fact.subjectId === "string" ? subjects.get(fact.subjectId) : undefined;
    if (!subject) { refuse("subject-unresolved", `${label}.subjectId does not resolve to a subject of this source and scene`); continue; }
    if (subject.kind !== atom.kind || subject.sceneId !== known.scope.sceneId || subject.visibility !== "public" || subject.observedBy !== known.scope.observerId) {
      refuse("subject-unresolved", `${label} subject is not a public player-visible subject of this scene`);
      continue;
    }
    if (fact.predicate !== row.predicate || fact.subjectId !== row.subjectId || fact.value !== row.value) {
      refuse("fact-row-mismatch", `${label} does not equal its frozen source row (${row.predicate}=${row.value})`);
      continue;
    }
    const expectedId = publicSceneFactId(known.source.sourceId, atom.atomKey);
    if (fact.factId !== expectedId) { refuse("fact-id-recipe-mismatch", `${label}.factId is not the identity of this source revision and atom`); continue; }
    if (seenFacts.has(expectedId)) { refuse("duplicate-fact-id", `${label}.factId repeats an earlier supplied fact`); continue; }
    if (seenAtoms.has(atom.atomKey)) { refuse("duplicate-atom-key", `${label} repeats atom ${atom.atomKey}`); continue; }
    seenFacts.add(expectedId);
    seenAtoms.add(atom.atomKey);
    facts.push(Object.freeze({
      factId: expectedId, kind: "public-observation", visibility: "public",
      subjectId: row.subjectId, predicate: row.predicate, value: row.value,
      sceneId: known.scope.sceneId, turnId: known.scope.turnId, observerId: known.scope.observerId,
      source: { sourceId: known.source.sourceId, canonicalDigest: known.source.canonicalDigest, atomKey: atom.atomKey },
    }) as PublicSceneFact);
  }
  const permitted = new Set(known.permittedFactIds);
  if (refusals.length === 0) {
    const supplied = new Set(facts.map((fact) => fact.factId));
    if (supplied.size !== permitted.size || [...permitted].some((factId) => !supplied.has(factId))) {
      refusals.push({ code: "projection-mismatch",
        detail: `this arm is scheduled for exactly ${permitted.size} supplied observation facts and received ${supplied.size}` });
    }
  }
  if (refusals.length > 0) return { ok: false, refusals };
  const subjectsById = new Map(known.source.subjects.map((subject) => [subject.subjectId, subject]));
  return {
    ok: true,
    unitId: known.unitId,
    pairId: known.pairId,
    mode: known.publicContext,
    scope: { ...known.scope },
    sourceId: known.source.sourceId,
    sourceCanonicalDigest: known.source.canonicalDigest,
    manifestDigest: authority.manifestDigest,
    facts: Object.freeze(facts),
    factIds: Object.freeze(facts.map((fact) => fact.factId)),
    observations: Object.freeze(facts.map((fact) => Object.freeze({
      factId: fact.factId,
      subjectId: fact.subjectId,
      displayName: subjectsById.get(fact.subjectId)!.displayName,
      predicate: fact.predicate,
      value: fact.value,
      sourceId: fact.source.sourceId,
      sourceCanonicalDigest: fact.source.canonicalDigest,
      sceneId: fact.sceneId,
      turnId: fact.turnId,
      observerId: fact.observerId,
    }))),
  };
}
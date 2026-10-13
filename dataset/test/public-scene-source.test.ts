import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createToyPublicObservationSource,
  loadPublicSceneAuthority,
  projectPublicSceneFacts,
  publicObservationSourceBody,
  publicObservationSourceDigest,
  publicContextDiagnosticManifestDigest,
  publicSceneFactId,
  parsePublicContextDiagnosticManifest,
  parsePublicObservationSource,
  PublicSceneSourceError,
  resolvePublicSceneFacts,
  type PublicContextDiagnosticManifest,
  type PublicSceneFact,
  type SceneScope,
  type VerifiedPublicSceneAuthority,
} from "../src/publicSceneFacts.js";
import { createPublicContextDiagnosticManifest } from "../src/generate.js";

// The manifest builder is the frozen, provider-free recipe. These tests never
// touch a teacher: they exercise the source identity, the authority boundary and
// the runtime contract that decides whether a supplied fact may be authorized.

const SEED = "public-context-source-test-1";
const manifest = createPublicContextDiagnosticManifest(SEED);
const load = (overrides: Partial<Parameters<typeof loadPublicSceneAuthority>[0]> = {}): VerifiedPublicSceneAuthority =>
  loadPublicSceneAuthority({ manifest, expectedManifestDigest: manifest.manifestDigest, ...overrides });

const row = (mode: "none" | "observations") => manifest.schedule.find((entry) => entry.publicContext === mode)!;
const armFacts = (mode: "none" | "observations", authority = load()): readonly PublicSceneFact[] =>
  projectPublicSceneFacts(authority.entries.get(row(mode).unitId)!.source);

const edit = (base: unknown, changes: Record<string, unknown>): unknown => ({ ...(base as Record<string, unknown>), ...changes });
const drop = (base: unknown, key: string): unknown => {
  const copy = { ...(base as Record<string, unknown>) };
  delete copy[key];
  return copy;
};

function resolve(input: { unitId?: string; scope?: SceneScope; facts: readonly unknown[]; authority?: unknown }) {
  return resolvePublicSceneFacts({
    unitId: input.unitId ?? row("observations").unitId,
    scope: input.scope ?? load().entries.get(row("observations").unitId)!.scope,
    facts: input.facts as readonly PublicSceneFact[],
    authority: (input.authority ?? load()) as VerifiedPublicSceneAuthority,
  });
}
function refusalCode(result: ReturnType<typeof resolve>): string[] {
  assert.equal(result.ok, false, JSON.stringify(result));
  return [...new Set((result as { refusals: readonly { code: string }[] }).refusals.map((refusal) => refusal.code))];
}

test("the toy source is deterministic, post-slot, and identical in content across the three frozen scenes", () => {
  const place = { entityId: "place-fixture", displayName: "Tallow Street" };
  const left = createToyPublicObservationSource({ scenarioSeed: "scenario-a", resolvedPlace: place });
  const right = createToyPublicObservationSource({ scenarioSeed: "scenario-a", resolvedPlace: place });
  assert.equal(left.canonicalDigest, right.canonicalDigest);
  assert.deepEqual(left, right);
  // A different scenario is a different scene, source and subject identity.
  const other = createToyPublicObservationSource({ scenarioSeed: "scenario-b", resolvedPlace: place });
  assert.notEqual(other.sourceId, left.sourceId);
  assert.notEqual(other.scope.sceneId, left.scope.sceneId);
  assert.notEqual(other.scope.turnId, left.scope.turnId);
  assert.notEqual(other.origin.placeEntityId, left.origin.placeEntityId);
  // The same two outcome-independent atoms in every frozen scene.
  assert.deepEqual(
    manifest.sources.map((source) => source.observations.map((observation) => `${observation.predicate}=${observation.value}`)),
    [["light-colour=amber", "shutter-state=closed"], ["light-colour=amber", "shutter-state=closed"], ["light-colour=amber", "shutter-state=closed"]],
  );
  assert.equal(new Set(manifest.sources.map((source) => source.canonicalDigest)).size, 3, "three distinct frozen source revisions");
  const stable = (source: Parameters<typeof publicObservationSourceBody>[0]): string => JSON.stringify(publicObservationSourceBody(source));
  for (const source of manifest.sources) {
    // No cycle: a source observation carries neither a projected fact id nor a digest.
    const body = stable(source);
    for (const fact of projectPublicSceneFacts(source)) assert.ok(!body.includes(fact.factId));
    assert.equal(source.visibility, "public");
    assert.equal(source.observedBy, "player");
    assert.equal(source.scope.observerId, "player");
    for (const subject of source.subjects) {
      assert.equal(subject.sceneId, source.scope.sceneId);
      assert.equal(subject.visibility, "public");
      assert.equal(subject.observedBy, "player");
    }
  }
});

test("a changed source with its own recomputed digest is still not a registered source", () => {
  const authority = load();
  const registered = authority.entries.get(row("observations").unitId)!.source;
  const altered = createToyPublicObservationSource({
    scenarioSeed: registered.origin.scenarioSeed,
    resolvedPlace: { entityId: "place-different", displayName: registered.origin.placeDisplayName },
  });
  assert.notEqual(altered.canonicalDigest, registered.canonicalDigest);
  assert.equal(altered.sourceId, registered.sourceId, "identity is derived from the scenario, so only the revision can differ");
  assert.deepEqual(refusalCode(resolve({ facts: projectPublicSceneFacts(altered) })), ["source-digest-mismatch"]);
  // Even a hand-edited body with a self-consistent digest does not register.
  const frozen = publicObservationSourceBody(registered);
  const tampered = { ...frozen,
    observations: frozen.observations.map((observation) => (observation.predicate === "light-colour" ? { ...observation, value: "white" } : observation)) };
  assert.throws(() => parsePublicObservationSource({ ...tampered, canonicalDigest: registered.canonicalDigest }, "tampered"),
    (error: unknown) => error instanceof PublicSceneSourceError && error.refusals.some((refusal) => refusal.code === "source-digest-mismatch"));
  // Recomputing the digest over the edited bytes proves identity, not authority.
  const whited = parsePublicObservationSource({ ...tampered,
    canonicalDigest: publicObservationSourceDigest(tampered as Parameters<typeof publicObservationSourceDigest>[0]) }, "whited");
  assert.notEqual(whited.canonicalDigest, registered.canonicalDigest);
  assert.deepEqual(refusalCode(resolve({ facts: projectPublicSceneFacts(whited) })), ["source-digest-mismatch"]);
});

test("runtime source validation refuses extra properties, bad enums, duplicates, cross-scene subjects and non-public visibility", () => {
  const source = manifest.sources[0]!;
  const body: Record<string, unknown> = { ...publicObservationSourceBody(source), canonicalDigest: source.canonicalDigest };
  const codes = (value: unknown): string[] => {
    try { parsePublicObservationSource(value, "source"); return []; }
    catch (error) { return [...new Set((error as PublicSceneSourceError).refusals.map((refusal) => refusal.code))]; }
  };
  assert.deepEqual(codes({ ...body }), [], "the frozen body validates");
  assert.ok(codes(drop(body, "canonicalDigest")).includes("not-an-object"));
  assert.ok(codes(edit(body, { authoringNote: "trusted" })).includes("extra-property"));
  assert.ok(codes(edit(body, { version: "toy-public-observations-v2" })).includes("invalid-enum"));
  assert.ok(codes(drop(body, "visibility")).includes("missing-property"));
  assert.ok(codes(edit(body, { visibility: "private" })).includes("visibility-not-public"));
  assert.ok(codes(edit(body, { observedBy: "npc" })).includes("observer-mismatch"));
  const subjects = body.subjects as readonly Record<string, unknown>[];
  const observations = body.observations as readonly Record<string, unknown>[];
  assert.ok(codes(edit(body, { scope: { ...(body.scope as object), turnId: "TURN" } })).includes("invalid-identity"));
  assert.ok(codes(edit(body, { subjects: [{ ...subjects[0]!, sceneId: "public-scene-elsewhere" }, subjects[1]!] }))
    .includes("cross-scene-subject"));
  assert.ok(codes(edit(body, { subjects: [subjects[0]!, { ...subjects[1]!, subjectId: subjects[0]!.subjectId }] }))
    .includes("duplicate-subject-id"));
  assert.ok(codes(edit(body, { observations: [observations[0]!, observations[0]!] })).includes("duplicate-atom-key"));
  assert.ok(codes(edit(body, { observations: [{ ...observations[0]!, subjectId: subjects[1]!.subjectId }] }))
    .includes("predicate-kind-mismatch"));
  assert.ok(codes(edit(body, { observations: [{ ...observations[0]!, predicate: "shutter-state" }] }))
    .includes("predicate-kind-mismatch"));
  assert.ok(codes(edit(body, { observations: [{ ...observations[0]!, value: "golden" }] })).includes("invalid-enum"));
  assert.ok(codes(edit(body, { observations: [{ ...observations[0]!, subjectId: "scene-subject-missing" }] }))
    .includes("subject-unresolved"));
});

test("authority is issued only against the frozen pin, and a manifest is not authority", () => {
  assert.throws(() => loadPublicSceneAuthority({ manifest, expectedManifestDigest: "0".repeat(64) }),
    (error: unknown) => error instanceof PublicSceneSourceError && error.refusals.some((refusal) => refusal.code === "manifest-pin-mismatch"));
  // A re-pinned manifest that mutates a source is not self-justifying either.
  const mutated = { ...manifest, sources: manifest.sources.map((source, index) => (index === 0
    ? { ...source, observations: source.observations.map((observation) => (observation.predicate === "light-colour" ? { ...observation, value: "white" } : observation)) }
    : source)) } as unknown as PublicContextDiagnosticManifest;
  assert.throws(() => parsePublicObservationSource(mutated.sources[0], "mutated"), PublicSceneSourceError);
  // Raw manifest-shaped input grants nothing at resolution time.
  assert.ok(refusalCode(resolve({ facts: armFacts("observations"), authority: manifest })).includes("authority-not-verified"));
  assert.ok(refusalCode(resolve({ facts: armFacts("observations"), authority: JSON.parse(JSON.stringify(manifest)) })).includes("authority-not-verified"));
  assert.ok(refusalCode(resolve({ facts: armFacts("observations"), authority: { manifestDigest: manifest.manifestDigest, entries: new Map() } }))
    .includes("authority-not-verified"));
  // A self-consistent forged manifest still loads against its own pin, so the
  // plan-time reconstruction comparison is the second, independent gate.
  const loaded = load();
  assert.equal(loaded.manifestDigest, manifest.manifestDigest);
  assert.equal(loaded.entries.size, 6);
});

test("a declared manifest digest that does not match the bytes is refused, never repaired", () => {
  for (const wrong of ["0".repeat(64), publicContextDiagnosticManifestDigest({ ...manifest, seed: `${manifest.seed}-other` })]) {
    assert.throws(() => parsePublicContextDiagnosticManifest({ ...manifest, manifestDigest: wrong }),
      (error: unknown) => error instanceof PublicSceneSourceError
        && error.refusals.some((refusal) => refusal.code === "manifest-digest-mismatch"),
      `declared digest ${wrong} was silently replaced`);
    assert.throws(() => loadPublicSceneAuthority({ manifest: { ...manifest, manifestDigest: wrong } as PublicContextDiagnosticManifest,
      expectedManifestDigest: manifest.manifestDigest }),
    (error: unknown) => error instanceof PublicSceneSourceError
      && error.refusals.some((refusal) => refusal.code === "manifest-digest-mismatch"));
  }
  // The genuine identity is unchanged by the comparison.
  assert.equal(parsePublicContextDiagnosticManifest(manifest).manifestDigest, manifest.manifestDigest);
});

test("the issued authority is unforgeable and immutable, and the genuine arms still resolve", () => {
  const authority = load();
  const observedUnit = row("observations").unitId;
  const controlUnit = row("none").unitId;
  const entry = authority.entries.get(observedUnit)!;
  const [light, shutters] = armFacts("observations");
  const facts = [light!, shutters!];
  // The genuine authority resolves BOTH valid arms: full projection, and the
  // control's own empty projection.
  assert.equal(resolve({ facts, authority }).ok, true);
  assert.equal(resolve({ unitId: controlUnit, facts: [], authority }).ok, true);
  // Mutating the exposed inspection copy cannot reach the registry.
  (authority.entries as Map<string, unknown>).set(observedUnit, { ...entry, sourceId: "public-observation-source-elsewhere" });
  assert.equal(resolve({ facts, authority }).ok, true, "entries.set on the exposed copy must not affect resolution");
  assert.equal(authority.entries.get(observedUnit)!.sourceId, entry.sourceId);
  // A self-rehashed source under the ORIGINAL pin still refuses.
  const whited = { ...(publicObservationSourceBody(entry.source) as unknown as Record<string, unknown>),
    observations: (publicObservationSourceBody(entry.source).observations as readonly Record<string, unknown>[])
      .map((observation) => (observation.predicate === "light-colour" ? { ...observation, value: "white" } : observation)) };
  const changed = parsePublicObservationSource({ ...whited, canonicalDigest: publicObservationSourceDigest(whited as never) }, "changed");
  assert.notEqual(changed.canonicalDigest, entry.source.canonicalDigest);
  assert.deepEqual(refusalCode(resolve({ facts: projectPublicSceneFacts(changed), authority })), ["source-digest-mismatch"]);
  // A spread copy, and a copy carrying the reflected brand symbol, are not the
  // issued object, so they are not authority.
  const spread = { ...authority, entries: new Map(authority.entries) };
  const reflected = { manifestDigest: authority.manifestDigest, manifest: authority.manifest, entries: new Map(authority.entries) };
  for (const symbol of Object.getOwnPropertySymbols(authority)) (reflected as Record<symbol, unknown>)[symbol] = true;
  for (const forged of [spread, reflected, JSON.parse(JSON.stringify(authority))]) {
    assert.ok(refusalCode(resolve({ facts, authority: forged })).includes("authority-not-verified"));
  }
  // Copying the brand cannot upgrade the CONTROL arm to observations.
  const elevated = { ...spread, entries: new Map(spread.entries) };
  (elevated.entries as Map<string, unknown>).set(controlUnit, { ...entry, unitId: controlUnit, publicContext: "observations" });
  assert.ok(refusalCode(resolve({ unitId: controlUnit, scope: entry.scope, facts, authority: elevated })).includes("authority-not-verified"));
  // Even under the genuine authority, the control arm exposes nothing.
  assert.deepEqual(refusalCode(resolve({ unitId: controlUnit, scope: entry.scope, facts, authority })), ["projection-mismatch"]);
  assert.equal(authority.entries.get(controlUnit)!.permittedFactIds.length, 0);
});

test("the registered exact facts resolve, and every mutation or wrong projection refuses", () => {
  const authority = load();
  const [light, shutters] = armFacts("observations");
  const resolved = resolve({ facts: [light!, shutters!] });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.mode, "observations");
  assert.equal(resolved.sourceCanonicalDigest, authority.entries.get(row("observations").unitId)!.source.canonicalDigest);
  assert.equal(resolved.facts.length, 2);
  assert.equal(light!.factId, publicSceneFactId(light!.source.sourceId, "light"));
  // One supplied atom is not the arm's permitted projection.
  assert.deepEqual(refusalCode(resolve({ facts: [light!] })), ["projection-mismatch"]);
  // The same fact presented to the control arm is unavailable there.
  assert.deepEqual(refusalCode(resolve({ unitId: row("none").unitId, scope: authority.entries.get(row("none").unitId)!.scope, facts: [light!, shutters!] })),
    ["projection-mismatch"]);
  assert.equal(authority.entries.get(row("none").unitId)!.permittedFactIds.length, 0);
  assert.equal(resolve({ unitId: row("none").unitId, scope: authority.entries.get(row("none").unitId)!.scope, facts: [] }).ok, true);

  const base = light!;
  const cases: readonly [string, unknown][] = [
    ["predicate-kind-mismatch", edit(base, { predicate: "shutter-state" })],
    ["fact-row-mismatch", edit(base, { value: "white" })],
    ["subject-unresolved", edit(base, { subjectId: "scene-subject-not-in-source" })],
    ["fact-id-recipe-mismatch", edit(base, { factId: "scene-fact-0000" })],
    ["scope-mismatch", edit(base, { turnId: "committed-turn-elsewhere0000" })],
    ["visibility-not-public", edit(base, { visibility: "private" })],
    ["observer-mismatch", edit(base, { observerId: "npc" })],
    ["extra-property", edit(base, { trustMe: true })],
    ["missing-property", drop(base, "kind")],
    ["source-digest-mismatch", edit(base, { source: { ...base.source, canonicalDigest: "0".repeat(64) } })],
    ["source-not-registered", edit(base, { source: { ...base.source, sourceId: "public-observation-source-0000" } })],
  ];
  for (const [code, fact] of cases) {
    assert.deepEqual(refusalCode(resolve({ facts: [fact!, shutters!] })), [code], code);
  }
  assert.deepEqual(refusalCode(resolve({ facts: [light!, light!] })), ["duplicate-fact-id"]);
  assert.deepEqual(refusalCode(resolve({ unitId: "unit-not-scheduled", facts: [light!, shutters!] })), ["unit-not-registered"]);
  assert.deepEqual(refusalCode(resolve({
    scope: { ...authority.entries.get(row("observations").unitId)!.scope, sceneId: "public-scene-elsewhere" }, facts: [],
  })), ["scope-mismatch"]);
});
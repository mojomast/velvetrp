/**
 * Counterfactual-twin anchor machinery for typed selective fidelity.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `dataset/BASELINE_SIGNAL.md` measures referential fidelity as the single
 * largest failure mode: 40/106 (37.7%) on Qwen3-8B. The cause is almost always
 * the same -- a value carried from the setup is dropped and the model reaches
 * for a pronoun. Anchor miss rates differ sharply by class:
 *
 *   | class    | anchors | missed | rate   |
 *   | numeric  | 14      | 13     | 92.9%  |
 *   | generic  | 72      | 57     | 79.2%  |
 *   | named    | 38      | 28     | 73.7%  |
 *
 * The naive remedy -- "require these substrings to appear" -- was REJECTED in
 * audit, and the rejection is correct: a substring constraint is satisfied by
 * padding capitalised nouns until the check passes, so the cheapest
 * optimisation becomes name-stuffing rather than fidelity. The target here is
 * TYPED SELECTIVE FIDELITY: carry a value when the facts make it true, and do
 * not carry it when they do not. Counterfactual twins teach that contrast
 * directly, which a positive substring constraint cannot.
 *
 * WHY ANCHORS COME FROM `authoritativeFacts` AND NOWHERE ELSE
 * ----------------------------------------------------------
 * Anchors are projected from Family B's authoritative facts
 * (`grounding.authoritativeFacts`), never scraped out of generated narration.
 * Scraping the narration to decide what the narration must contain is
 * circular: it certifies whatever the generator already did. Every anchor
 * therefore records the `factId` it came from, and `anchorHolds` re-derives its
 * truth from the fact, so a flipped fact invalidates exactly its own anchors
 * and nothing else.
 *
 * INSTRUMENTATION IS NOT A TRAINING OBJECTIVE
 * --------------------------------------------
 * The anchor list is EVALUATION INSTRUMENTATION. It measures whether a pair
 * actually contrasts on the intended fact; it is never a supervision target.
 * Nothing in this module ever places anchor text, an anchor list, or an
 * "include these substrings" instruction into `PreferencePair.prompt`,
 * `.chosen` or `.rejected`. `PreferencePair` carries no anchor surface at all,
 * and `TRAINING_FACING_KEYS_HAVE_NO_ANCHOR_SURFACE` is a compile-time proof of
 * that: add an `anchors` field to `StoredMessage` or `PreferencePair` and this
 * module stops compiling. The twin teaches the behaviour by CONTRAST between two
 * arms that read like ordinary narration.
 *
 * DENSITY, AND WHY 2-3
 * --------------------
 * The corpus sits at 0.69 anchors/case. 3-5 anchors would be a large
 * intensification of a metric that already fails 40 times, and at that density
 * the cheapest available optimisation is stuffing. So: 2-3 anchors, spanning
 * all three classes with the numeric share weighted up, and at least one numeric
 * anchor wherever a receipt supplies a numeric value.
 *
 * THE LATENT REGRESSION
 * ---------------------
 * Substring anchoring catches objective failures only. There is no automatic
 * prose-quality score in this suite, so nothing would catch an anchor programme
 * that traded prose for substring compliance. `MIN_STOCK_PROSE_QUALITY` is the
 * measured stock rate (4/8) and `assertProseQualityGate` fails closed below it.
 * The `ProseQualityScorer` port deliberately ships with NO default
 * implementation: an absent scorer resolves to *unavailable* and throws, never
 * to a pass, following the same fail-closed pattern as `templateProfiles.ts`.
 */

import { createHash } from "node:crypto";
import { validatePreference } from "./admission.js";
import {
  authoritativeFacts,
  evaluateGroundedNarration,
  type AuthoritativeFact,
  type AuthoritativeValue,
  type BindingViolation,
  type GroundingReceipt,
} from "./grounding.js";
import { stableStringify, type PreferencePair, type StoredMessage } from "./spec.js";

export const TWINS_VERSION = "counterfactual-twins-v1";

/** The one axis these pairs may train. Anything else is refused. */
export const REFERENTIAL_FIDELITY_AXIS = "referential-fidelity";

/* -------------------------------------------------------------------------- */
/* Typed anchors                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Anchor classes, typed rather than a flat string list because the three fail
 * at very different rates (numeric 92.9%, generic 79.2%, named 73.7%) and must
 * be weighted differently.
 *
 * - `named` -- a proper-noun or capitalised entity the fact names: the actor,
 *   the target, the check subject. The corpus's "named" class.
 * - `numeric` -- the surface form of an authoritative mechanical value: a check
 *   total, a DC, damage applied, hit points. The corpus's "numeric" class, and
 *   the actual grounding defect: all 14 numeric anchors sit in two receipt
 *   categories.
 * - `concrete` -- the fact's non-name, non-number commitment: its difficulty
 *   label, damage type, status after, commit/verdict word, or a common-noun
 *   referent the fact carries. This is the measured "generic" class -- the
 *   tokens a model silently drops in favour of a pronoun.
 */
export type AnchorKind = "named" | "numeric" | "concrete";
export const ANCHOR_KINDS = ["named", "numeric", "concrete"] as const;

/**
 * Target class mix, in the proportions the design constraints state. Numeric is
 * weighted UP relative to its raw corpus share because it is the defect;
 * `selectAnchors` additionally forces a numeric anchor whenever a receipt
 * supplies a numeric value. Use `anchorKindMix` to measure what a batch
 * actually produced rather than trusting these targets.
 */
export const ANCHOR_KIND_WEIGHTS: Readonly<Record<AnchorKind, number>> = {
  named: 55,
  numeric: 20,
  concrete: 25,
};

/** 2-3 anchors per case. 3-5 would be a large intensification of a failing metric. */
export const MIN_ANCHORS_PER_CASE = 2;
export const MAX_ANCHORS_PER_CASE = 3;

/** The authoritative fields a non-numeric anchor can be projected from. */
export const ANCHOR_FIELDS = ["actor", "target", "subject", "status", "outcome", "damageType", "difficulty"] as const;
export type AnchorField = (typeof ANCHOR_FIELDS)[number];

/**
 * WHERE an anchor came from, inside its source fact. Re-resolving truth from
 * this rather than from the text is what makes a flip invalidate exactly its
 * own anchors.
 */
export type AnchorBinding =
  | { readonly field: "actor" | "target" | "subject" }
  | { readonly field: "value"; readonly role: AuthoritativeValue["role"] }
  | { readonly field: "status" | "outcome" | "damageType" | "difficulty" };

export interface AnchorSpec {
  readonly kind: AnchorKind;
  /** Exact surface value projected from the fact. Never scraped from prose. */
  readonly value: string;
  /** `receiptId` of the `AuthoritativeFact` this anchor was projected from. */
  readonly factId: string;
  readonly binding: AnchorBinding;
}

export function anchorBindingKey(binding: AnchorBinding): string {
  return binding.field === "value" ? `value:${binding.role}` : `field:${binding.field}`;
}

export function anchorKey(anchor: AnchorSpec): string {
  return `${anchor.kind}|${anchor.value}|${anchor.factId}|${anchorBindingKey(anchor.binding)}`;
}

/**
 * COMPILE-TIME PROOF that the training payload has no anchor surface.
 *
 * `Extract<T, \`anchor${string}\`>` is never for `StoredMessage` or
 * `PreferencePair`. If a future revision adds an `anchors` field to either,
 * this type resolves to `false`, the assignment below stops compiling, and the
 * invariant "anchors are instrumentation, never a training target" becomes
 * enforced rather than merely documented. See the module doc comment.
 */
type NoAnchorSurface<T extends string> = Extract<T, `anchor${string}`> extends never ? true : false;
export const TRAINING_FACING_KEYS_HAVE_NO_ANCHOR_SURFACE: NoAnchorSurface<keyof StoredMessage>
  & NoAnchorSurface<keyof PreferencePair> = true;

/* -------------------------------------------------------------------------- */
/* Deterministic randomness                                                     */
/* -------------------------------------------------------------------------- */

export interface SeededRandom {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/** FNV-1a. Stable across processes and platforms; no locale, no Date. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The ONLY source of randomness in this module. `Math.random` is never called:
 * anchor sets and twin pairs must be byte-reproducible from a seed.
 */
export function createSeededRandom(seed: string): SeededRandom {
  let state = (fnv1a(seed) ^ 0x9e3779b9) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number => {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new TwinError([`seeded int bound must be a positive integer, got ${String(maxExclusive)}`]);
    }
    return Math.floor(next() * maxExclusive) % maxExclusive;
  };
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new TwinError(["cannot pick from an empty sequence"]);
      return items[int(items.length)] as T;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Normalisation and classification                                            */
/* -------------------------------------------------------------------------- */

const surface = (text: string): string =>
  text.toLocaleLowerCase("en-US").replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
const stripArticle = (text: string): string => surface(text).replace(/^the\s+/, "");

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Referents that are not carried values: naming them adds nothing. */
const NON_REFERENT = new Set([
  "you", "it", "he", "she", "they", "him", "her", "them", "self", "themself",
  "the target", "the attacker", "the combatant", "target", "combatant", "attacker",
  "this", "that", "one", "someone", "something", "nothing",
]);

function isNameLike(value: string): boolean {
  const text = stripArticle(value);
  if (!text || text.length > 48 || /\d/.test(text) || NON_REFERENT.has(text)) return false;
  // A proper noun or capitalised skill name as the fact recorded it.
  return /^[A-Z]/.test(value.trim());
}

function isConcreteDescriptor(value: string): boolean {
  const text = stripArticle(value);
  if (!text || text.length > 48 || /^\d+(?:\.\d+)?$/.test(text) || NON_REFERENT.has(text)) return false;
  return true;
}

function valueSurface(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return String(value);
}

const NAMED_FIELDS = ["actor", "target", "subject"] as const;
const CONCRETE_FIELDS = ["difficulty", "damageType", "status", "outcome"] as const;

/**
 * Every anchor a fact set can supply, in a canonical deterministic order.
 *
 * A capitalised referent is `named`; a lowercase common-noun referent and every
 * qualitative commitment (difficulty, damage type, status, commit/verdict word)
 * is `concrete`; each authoritative value contributes one `numeric` anchor.
 */
export function anchorCandidates(facts: readonly AuthoritativeFact[]): AnchorSpec[] {
  const anchors: AnchorSpec[] = [];
  for (const fact of facts) {
    for (const field of NAMED_FIELDS) {
      const value = fact[field];
      if (value == null) continue;
      if (isNameLike(value)) anchors.push({ kind: "named", value: value.trim(), factId: fact.receiptId, binding: { field } });
      else if (isConcreteDescriptor(value)) anchors.push({ kind: "concrete", value: value.trim(), factId: fact.receiptId, binding: { field } });
    }
    for (const value of fact.values) {
      const text = valueSurface(value.value);
      if (text !== null) anchors.push({ kind: "numeric", value: text, factId: fact.receiptId, binding: { field: "value", role: value.role } });
    }
    for (const field of CONCRETE_FIELDS) {
      const value = fact[field];
      if (value == null) continue;
      if (isConcreteDescriptor(value)) anchors.push({ kind: "concrete", value: value.trim(), factId: fact.receiptId, binding: { field } });
    }
  }
  return anchors;
}

/* -------------------------------------------------------------------------- */
/* Anchor selection                                                             */
/* -------------------------------------------------------------------------- */

export interface AnchorSelection {
  readonly anchors: readonly AnchorSpec[];
  /** Classes this fact set could supply at all, before selection. */
  readonly kindsAvailable: readonly AnchorKind[];
  /** True when the receipts supplied a numeric value and one was demanded. */
  readonly forcedNumeric: boolean;
  /** How many candidates of each class were available. */
  readonly supply: Readonly<Record<AnchorKind, number>>;
  readonly seed: string;
}

export interface AnchorSelectionOptions {
  /** Override the 2-3 default. Still clamped to the documented bounds. */
  readonly count?: number;
}

function poolsOf(candidates: readonly AnchorSpec[]): Record<AnchorKind, AnchorSpec[]> {
  const pools: Record<AnchorKind, AnchorSpec[]> = { named: [], numeric: [], concrete: [] };
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = anchorKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    pools[candidate.kind].push(candidate);
  }
  return pools;
}

function weightedKind(random: SeededRandom, kinds: readonly AnchorKind[]): AnchorKind {
  const total = kinds.reduce((sum, kind) => sum + ANCHOR_KIND_WEIGHTS[kind], 0);
  let ticket = random.next() * total;
  for (const kind of kinds) {
    ticket -= ANCHOR_KIND_WEIGHTS[kind];
    if (ticket < 0) return kind;
  }
  return kinds[kinds.length - 1] as AnchorKind;
}

/**
 * Pick 2-3 anchors for one case, spanning the three classes.
 *
 * Deterministic given `seed`: same facts and same seed produce a byte-identical
 * anchor set. A numeric anchor is FORCED whenever the receipts supply a
 * numeric value, because numeric is the measured grounding defect (92.9% miss)
 * and every one of the corpus's 14 numeric anchors sits in a receipt case. The
 * remaining slots are filled by the weighted draw, preferring a class not yet
 * represented so a case spans classes rather than tripling `named`.
 */
export function selectAnchors(
  facts: readonly AuthoritativeFact[],
  seed: string,
  options: AnchorSelectionOptions = {},
): AnchorSelection {
  const pools = poolsOf(anchorCandidates(facts));
  const supply: Record<AnchorKind, number> = {
    named: pools.named.length,
    numeric: pools.numeric.length,
    concrete: pools.concrete.length,
  };
  const available = ANCHOR_KINDS.filter((kind) => supply[kind] > 0);
  const distinct = ANCHOR_KINDS.reduce((sum, kind) => sum + supply[kind], 0);
  if (distinct < MIN_ANCHORS_PER_CASE) {
    throw new TwinError([
      `anchor supply exhausted: the facts yield ${distinct} usable anchor(s), ${MIN_ANCHORS_PER_CASE} are required`,
    ]);
  }
  const requested = options.count ?? MAX_ANCHORS_PER_CASE;
  const count = Math.max(MIN_ANCHORS_PER_CASE, Math.min(MAX_ANCHORS_PER_CASE, Math.floor(requested), distinct));

  const random = createSeededRandom(`anchors:${seed}`);
  const remaining: Record<AnchorKind, AnchorSpec[]> = { named: [...pools.named], numeric: [...pools.numeric], concrete: [...pools.concrete] };
  const taken: AnchorSpec[] = [];
  const take = (kind: AnchorKind): void => {
    const pool = remaining[kind];
    const chosen = random.pick(pool);
    pool.splice(pool.indexOf(chosen), 1);
    taken.push(chosen);
  };

  let forcedNumeric = false;
  if (supply.numeric > 0) {
    take("numeric");
    forcedNumeric = true;
  }

  const usedKinds = new Set(taken.map((anchor) => anchor.kind));
  // The weights decide every slot. An unspanned class is offered the draw first
  // for two slots, which normally spans all three classes; after that the raw
  // weighted mix governs, so the aggregate distribution is not distorted into a
  // fixed one-of-each that the corpus proportions do not support.
  let spanOffers = 2;
  while (taken.length < count) {
    const open = ANCHOR_KINDS.filter((kind) => remaining[kind].length > 0);
    if (open.length === 0) break;
    const unspanned = open.filter((kind) => !usedKinds.has(kind));
    const preferUnspanned = unspanned.length > 0 && spanOffers > 0;
    if (preferUnspanned) spanOffers -= 1;
    const kind = weightedKind(random, preferUnspanned ? unspanned : open);
    take(kind);
    usedKinds.add(kind);
  }

  return {
    anchors: taken,
    kindsAvailable: available,
    forcedNumeric,
    supply,
    seed,
  };
}

/** Measured class distribution of a batch, so targets can be checked, not assumed. */
export function anchorKindMix(selections: readonly AnchorSelection[]): Readonly<Record<AnchorKind, number>> {
  const counts: Record<AnchorKind, number> = { named: 0, numeric: 0, concrete: 0 };
  for (const selection of selections) {
    for (const anchor of selection.anchors) counts[anchor.kind] += 1;
  }
  const total = counts.named + counts.numeric + counts.concrete;
  const share = (count: number): number => (total === 0 ? 0 : count / total);
  return { named: share(counts.named), numeric: share(counts.numeric), concrete: share(counts.concrete) };
}

/* -------------------------------------------------------------------------- */
/* Counterfactual flips                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The SINGLE source-fact mutation that makes one anchor false or inapplicable.
 * More than one op per flip is refused, because a twin's contrast must be
 * minimal: every other fact, and the whole prompt surface, is held constant.
 */
export type FactFlip =
  | { readonly op: "remove-fact"; readonly factId: string }
  | { readonly op: "set-value"; readonly factId: string; readonly role: AuthoritativeValue["role"]; readonly value: number }
  | { readonly op: "set-field"; readonly factId: string; readonly field: AnchorField; readonly value: string | null };

export function flipKey(flip: FactFlip): string {
  if (flip.op === "remove-fact") return "fact";
  if (flip.op === "set-value") return `value:${flip.role}`;
  return `field:${flip.field}`;
}

/** Apply the flip. Returns a new fact set; the input is never mutated. */
export function applyFlip(facts: readonly AuthoritativeFact[], flip: FactFlip): AuthoritativeFact[] {
  if (flip.op === "remove-fact") {
    const kept = facts.filter((fact) => fact.receiptId !== flip.factId);
    if (kept.length === facts.length) throw new TwinError([`flip targets unknown fact ${flip.factId}`]);
    if (kept.length === 0) throw new TwinError([`flip would remove every fact; a twin needs a fact set to contrast against`]);
    return kept;
  }
  const index = facts.findIndex((fact) => fact.receiptId === flip.factId);
  const fact = facts[index];
  if (index < 0 || !fact) throw new TwinError([`flip targets unknown fact ${flip.factId}`]);
  const updated: AuthoritativeFact = { ...fact };
  if (flip.op === "set-value") {
    if (!fact.values.some((value) => value.role === flip.role)) {
      throw new TwinError([`fact ${flip.factId} has no ${flip.role} value to flip`]);
    }
    updated.values = fact.values.map((value) => (value.role === flip.role ? { ...value, value: flip.value } : value));
  } else if (flip.op === "set-field") {
    updated[flip.field] = flip.value;
  }
  return [...facts.slice(0, index), updated, ...facts.slice(index + 1)];
}

/** Does this flip touch this anchor? Scoped by `factId` AND binding, never wider. */
export function flipTouches(flip: FactFlip, anchor: AnchorSpec): boolean {
  if (flip.factId !== anchor.factId) return false;
  return flip.op === "remove-fact" || flipKey(flip) === anchorBindingKey(anchor.binding);
}

/**
 * Re-derive an anchor's truth FROM THE FACT. The anchor is true only while the
 * fact still carries that exact surface value; removing the fact makes it
 * inapplicable, which counts as false for carry-over purposes.
 */
export function anchorHolds(anchor: AnchorSpec, facts: readonly AuthoritativeFact[]): boolean {
  const fact = facts.find((candidate) => candidate.receiptId === anchor.factId);
  if (!fact) return false;
  const binding = anchor.binding;
  if (binding.field === "value") {
    const value = fact.values.find((candidate) => candidate.role === binding.role);
    return value !== undefined && valueSurface(value.value) === anchor.value;
  }
  const carried = fact[binding.field];
  return typeof carried === "string" && stripArticle(carried) === stripArticle(anchor.value);
}

/** Anchors whose truth this flip changes. A well-formed flip changes exactly one. */
export function anchorsInvalidatedBy(
  flip: FactFlip,
  faithful: readonly AuthoritativeFact[],
  counterfactual: readonly AuthoritativeFact[],
  anchors: readonly AnchorSpec[],
): AnchorSpec[] {
  return anchors.filter((anchor) => anchorHolds(anchor, faithful) !== anchorHolds(anchor, counterfactual));
}

/** Anchors still true under the flipped facts: the shared demand of both arms. */
export function anchorsStillTrue(anchors: readonly AnchorSpec[], facts: readonly AuthoritativeFact[]): AnchorSpec[] {
  return anchors.filter((anchor) => anchorHolds(anchor, facts));
}

export interface FlipDerivationOptions {
  /** Replacement strings for a field flip, keyed by the field being flipped. */
  readonly alternatives?: Partial<Record<AnchorField, readonly string[]>>;
}

/**
 * Derive a flip that is guaranteed to invalidate `anchor`, deterministically
 * from the seed.
 *
 * A numeric anchor gets a different authoritative value. A named or concrete
 * anchor prefers a caller-supplied alternative, then a sibling fact's value for
 * the same field (the wrong-referent counterfactual, which is exactly the
 * fidelity failure being taught), then removal of the fact. If none is
 * available the module THROWS rather than emitting a pair with no contrast.
 */
export function deriveFlip(
  facts: readonly AuthoritativeFact[],
  anchor: AnchorSpec,
  seed: string,
  options: FlipDerivationOptions = {},
): FactFlip {
  const random = createSeededRandom(`flip:${seed}:${anchorKey(anchor)}`);
  const binding = anchor.binding;
  if (binding.field === "value") {
    const original = Number(anchor.value);
    if (!Number.isFinite(original)) throw new TwinError([`anchor ${anchor.value} is not a numeric value`]);
    const step = 1 + random.int(9);
    const signed = random.next() < 0.5 ? -step : step;
    let next = original + signed;
    // Keep check values plausible; a check total or DC must stay a roll result.
    if (binding.role === "total" || binding.role === "dc") next = Math.max(1, Math.min(40, next));
    if (next === original) next = original + 1;
    return { op: "set-value", factId: anchor.factId, role: binding.role, value: next };
  }

  const alternatives = options.alternatives?.[binding.field] ?? [];
  if (alternatives.length > 0) {
    return { op: "set-field", factId: anchor.factId, field: binding.field, value: random.pick(alternatives).trim() };
  }
  const sibling = facts.find((fact) => fact.receiptId !== anchor.factId && fact[binding.field] != null
    && stripArticle(String(fact[binding.field])) !== stripArticle(anchor.value));
  if (sibling) {
    return { op: "set-field", factId: anchor.factId, field: binding.field, value: String(sibling[binding.field]).trim() };
  }
  if (facts.length > 1) return { op: "remove-fact", factId: anchor.factId };
  throw new TwinError([
    `cannot invalidate anchor ${anchor.value}: a single-fact case needs flipAlternatives.${binding.field} or a sibling fact`,
  ]);
}

/* -------------------------------------------------------------------------- */
/* Twin construction                                                            */
/* -------------------------------------------------------------------------- */

export interface TwinCaseSpec {
  readonly caseId: string;
  /** The prompt surface. Held byte-identical across both arms by construction. */
  readonly prompt: readonly StoredMessage[];
  /** Family B's committed receipts. `authoritativeFacts` is the only source of truth. */
  readonly receipts: readonly GroundingReceipt[];
  /** Draft narration for the arm whose facts make the anchor true. */
  readonly faithfulNarration: string;
  /** Draft narration for the arm whose facts make the anchor inapplicable. */
  readonly counterfactualNarration: string;
  /** Explicit flip. When omitted it is derived from the flip anchor. */
  readonly flip?: FactFlip;
  /** Which anchor the flip must invalidate. When omitted the seed chooses. */
  readonly flipAnchor?: AnchorSpec;
  readonly flipAlternatives?: Partial<Record<AnchorField, readonly string[]>>;
}

/**
 * EVALUATION INSTRUMENTATION ONLY. Never a training target, never inside
 * `StoredMessage.content`. It exists so a grader can report which typed anchor
 * a pair contrasts on and prove the flip touched exactly one fact.
 */
export interface TwinInstrumentation {
  readonly twinsVersion: typeof TWINS_VERSION;
  readonly caseId: string;
  readonly seed: string;
  readonly anchors: readonly AnchorSpec[];
  readonly flip: FactFlip;
  readonly flipAnchor: AnchorSpec;
  readonly facts: readonly AuthoritativeFact[];
  readonly counterfactualFacts: readonly AuthoritativeFact[];
  readonly invalidated: readonly AnchorSpec[];
  readonly carriedInFaithfulArm: readonly AnchorSpec[];
  readonly carriedInCounterfactualArm: readonly AnchorSpec[];
  readonly promptDigest: string;
}

export interface TwinPair {
  /** The only trainer-facing artefact. Contains no anchor metadata whatsoever. */
  readonly pair: PreferencePair;
  readonly instrumentation: TwinInstrumentation;
}

export class TwinError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`counterfactual twin cannot be built: ${problems.join("; ")}`);
    this.name = "TwinError";
    this.problems = problems;
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export function measureLengthRatio(chosen: string, rejected: string): number {
  const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
  const a = words(chosen);
  const b = words(rejected);
  return Math.max(a, b) / Math.max(1, Math.min(a, b));
}

/**
 * Build the minimal-contrast pair.
 *
 * The faithful arm is `chosen` because its facts make the anchor true. The
 * counterfactual arm is `rejected` because exactly one source fact was flipped
 * so the anchor is false or inapplicable, and the correct narration must not
 * carry it. Every other fact, and the whole prompt surface, is shared -- that
 * sharedness is what makes the contrast teach the contrast rather than a style.
 */
export function buildTwinPair(spec: TwinCaseSpec, anchors: readonly AnchorSpec[], seed: string): TwinPair {
  const faithful = authoritativeFacts(spec.receipts);
  if (anchors.length < MIN_ANCHORS_PER_CASE || anchors.length > MAX_ANCHORS_PER_CASE) {
    throw new TwinError([
      `case must carry ${MIN_ANCHORS_PER_CASE}-${MAX_ANCHORS_PER_CASE} anchors, got ${anchors.length}`,
    ]);
  }
  const candidates = anchorCandidates(faithful);
  const candidateKeys = new Set(candidates.map(anchorKey));
  for (const anchor of anchors) {
    if (!candidateKeys.has(anchorKey(anchor))) {
      throw new TwinError([`anchor ${anchor.value} is not derivable from the authoritative facts`]);
    }
  }

  const random = createSeededRandom(`flip-target:${seed}:${spec.caseId}`);
  const flipAnchor = spec.flipAnchor ?? random.pick(anchors);
  const flip = spec.flip ?? deriveFlip(
    faithful,
    flipAnchor,
    `${seed}:${spec.caseId}`,
    spec.flipAlternatives ? { alternatives: spec.flipAlternatives } : {},
  );
  const counterfactual = applyFlip(faithful, flip);
  const invalidated = anchorsInvalidatedBy(flip, faithful, counterfactual, anchors);

  if (invalidated.length === 0) {
    throw new TwinError([
      `the flip did not invalidate anchor ${flipAnchor.value}; both arms would demand the same behaviour`,
    ]);
  }
  if (invalidated.length > 1) {
    throw new TwinError([
      `the flip invalidated ${invalidated.length} anchors (${invalidated.map((anchor) => anchor.value).join(", ")}); a minimal contrast changes exactly one`,
    ]);
  }
  if (!flipTouches(flip, invalidated[0] as AnchorSpec)) {
    throw new TwinError(["the recorded invalidation is not the one the flip produced"]);
  }

  const prompt = spec.prompt.map((message) => ({ ...message }));
  const pair: PreferencePair = {
    axis: REFERENTIAL_FIDELITY_AXIS,
    prompt,
    chosen: [{ role: "assistant", content: spec.faithfulNarration }],
    rejected: [{ role: "assistant", content: spec.counterfactualNarration }],
    rationale:
      `Minimal contrast: one source fact (${flip.factId}, ${flipKey(flip)}) was flipped so the `
      + `${flipAnchor.kind} anchor "${flipAnchor.value}" is no longer established. The chosen arm carries it; `
      + "the rejected arm must not. Every other fact and the whole prompt surface are held constant.",
    lengthRatio: measureLengthRatio(spec.faithfulNarration, spec.counterfactualNarration),
  };

  return {
    pair,
    instrumentation: {
      twinsVersion: TWINS_VERSION,
      caseId: spec.caseId,
      seed,
      anchors: [...anchors],
      flip,
      flipAnchor: invalidated[0] as AnchorSpec,
      facts: faithful,
      counterfactualFacts: counterfactual,
      invalidated,
      carriedInFaithfulArm: anchorsStillTrue(anchors, faithful),
      carriedInCounterfactualArm: anchorsStillTrue(anchors, counterfactual),
      promptDigest: sha256(stableStringify(prompt)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                 */
/* -------------------------------------------------------------------------- */

export const TWIN_REJECTION_CODES = [
  "axis-not-referential-fidelity",
  "preference-contract-violation",
  "length-only-difference",
  "style-only-difference",
  "length-ratio-guard-failed",
  "anchor-not-invalidated",
  "flip-invalidates-multiple-anchors",
  "anchor-set-invalid",
  "anchor-not-fact-derived",
  "faithful-arm-omits-anchor",
  "rejected-arm-carries-invalidated-anchor",
  "shared-anchor-dropped",
  "multi-fact-divergence",
  "prompt-surface-divergence",
  "instrumentation-mismatch",
] as const;
export type TwinRejectionCode = (typeof TWIN_REJECTION_CODES)[number];

export interface TwinRejection {
  readonly code: TwinRejectionCode;
  readonly detail: string;
}

export interface TwinMeasurements {
  readonly chosenWords: number;
  readonly rejectedWords: number;
  readonly declaredLengthRatio: number;
  readonly measuredLengthRatio: number;
  readonly carriedByChosen: readonly AnchorSpec[];
  readonly carriedByRejected: readonly AnchorSpec[];
  readonly invalidated: readonly AnchorSpec[];
  readonly sharedAnchors: readonly AnchorSpec[];
}

export type TwinVerification =
  | { readonly ok: true; readonly reasons: readonly []; readonly measurements: TwinMeasurements }
  | { readonly ok: false; readonly reasons: readonly TwinRejection[]; readonly measurements: TwinMeasurements };

export interface TwinVerificationInput {
  readonly pair: PreferencePair;
  readonly spec: TwinCaseSpec;
  /** The BUILDER'S CLAIM. Re-derived and cross-checked; never trusted. */
  readonly instrumentation: TwinInstrumentation;
}

/** DPO's documented guard. Same bound `validatePreference` enforces. */
export const MAX_PREFERENCE_LENGTH_RATIO = 1.5;
/** A declared ratio this far from the measured one is untrustworthy evidence. */
export const LENGTH_RATIO_TOLERANCE = 0.02;

/** Does this narration carry the anchor's surface? Normalised, boundary-safe. */
export function narrationCarries(text: string, anchor: AnchorSpec): boolean {
  const haystack = surface(text);
  const needle = surface(anchor.value);
  if (!needle) return false;
  if (anchor.kind === "numeric") {
    return new RegExp(`(?<![\\w.])${escapeRe(needle)}(?![\\w.])`, "u").test(haystack);
  }
  return haystack.includes(needle);
}

const textOf = (messages: readonly StoredMessage[]): string => messages.map((message) => message.content).join("\n");

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

function violationMap(text: string, receipts: readonly GroundingReceipt[]): Map<string, BindingViolation> {
  const verdict = evaluateGroundedNarration(text, receipts);
  const map = new Map<string, BindingViolation>();
  if (verdict.verdict === "rejected") {
    for (const violation of verdict.violations) map.set(`${violation.code}|${violation.receiptId ?? ""}`, violation);
  }
  return map;
}

function difference(left: Map<string, BindingViolation>, right: Map<string, BindingViolation>): BindingViolation[] {
  return [...left.entries()].filter(([key]) => !right.has(key)).map(([, violation]) => violation);
}

/**
 * Surface values the flip INTRODUCES. A counterfactual arm necessarily names a
 * referent the faithful fact set does not establish, so the grounding module
 * cannot bind it -- that is the contrast, not a second divergence. These
 * surfaces are what licenses an unbound violation on the rejected arm.
 */
function introducedSurfaces(flip: FactFlip): string[] {
  if (flip.op === "remove-fact") return [];
  const value = flip.op === "set-value" ? String(flip.value) : flip.value;
  return value === null ? [] : [value];
}

/**
 * Verify that a pair really contrasts on exactly one flipped fact.
 *
 * Every rejection carries a machine-readable `code` from
 * `TWIN_REJECTION_CODES`. The checks are:
 *
 *  - reuse `validatePreference` for the length/style contract rather than
 *    inventing a weaker standard, and map its length-bias problem onto
 *    `length-only-difference`;
 *  - refuse a declared `lengthRatio` that is not a measured positive number or
 *    that disagrees with the measured one -- a dishonest length field would
 *    defeat the DPO guard it claims to satisfy;
 *  - refuse a pair whose arms carry an identical anchor set, because then
 *    whatever separates them is register, and that trains style;
 *  - refuse a flip that did not invalidate its anchor, so both arms demand the
 *    same behaviour and the pair teaches nothing;
 *  - refuse any grounding divergence outside the flipped fact, in either
 *    direction, which is what "minimal contrast" actually means. A counterfactual
 *    arm's own referent is unbindable under the faithful facts by construction,
 *    so a rejected-arm violation is licensed only when it is bound to the
 *    flipped fact or quotes the surface the flip introduced.
 */
export function verifyTwinPair(input: TwinVerificationInput): TwinVerification {
  const { pair, spec, instrumentation } = input;
  const reasons: TwinRejection[] = [];
  const reject = (code: TwinRejectionCode, detail: string): void => { reasons.push({ code, detail }); };

  const chosenText = textOf(pair.chosen);
  const rejectedText = textOf(pair.rejected);

  if (pair.axis !== REFERENTIAL_FIDELITY_AXIS) {
    reject("axis-not-referential-fidelity", `axis is "${pair.axis}", not "${REFERENTIAL_FIDELITY_AXIS}"`);
  }

  // The standard is validatePreference's, not a local invention.
  for (const problem of validatePreference(pair)) {
    if (/length-biased/.test(problem)) reject("length-only-difference", problem);
    else reject("preference-contract-violation", problem);
  }

  const measuredLengthRatio = measureLengthRatio(chosenText, rejectedText);
  const declared = pair.lengthRatio;
  if (!Number.isFinite(declared) || declared <= 0) {
    reject("length-ratio-guard-failed", `declared lengthRatio ${String(declared)} is not a measured positive number`);
  } else {
    if (Math.abs(declared - measuredLengthRatio) > LENGTH_RATIO_TOLERANCE) {
      reject("length-ratio-guard-failed",
        `declared lengthRatio ${declared.toFixed(3)} disagrees with the measured ${measuredLengthRatio.toFixed(3)}`);
    }
    if (declared > MAX_PREFERENCE_LENGTH_RATIO || measuredLengthRatio > MAX_PREFERENCE_LENGTH_RATIO) {
      reject("length-ratio-guard-failed",
        `length ratio ${Math.max(declared, measuredLengthRatio).toFixed(3)} exceeds the DPO guard ${MAX_PREFERENCE_LENGTH_RATIO}`);
    }
  }

  // Re-derive authority. The instrumentation is a claim, never a source.
  const faithful = authoritativeFacts(spec.receipts);
  let counterfactual: AuthoritativeFact[] = [];
  let flipApplied = false;
  try {
    counterfactual = applyFlip(faithful, instrumentation.flip);
    flipApplied = counterfactual.length > 0;
  } catch (error) {
    reject("instrumentation-mismatch", error instanceof TwinError ? error.problems.join("; ") : "the flip could not be applied");
  }

  const anchors = instrumentation.anchors;
  if (anchors.length < MIN_ANCHORS_PER_CASE || anchors.length > MAX_ANCHORS_PER_CASE) {
    reject("anchor-set-invalid", `anchor set has ${anchors.length} entries, outside ${MIN_ANCHORS_PER_CASE}-${MAX_ANCHORS_PER_CASE}`);
  }
  if (anchors.some((anchor) => anchor.kind === "numeric") === false
    && faithful.some((fact) => fact.values.length > 0)) {
    reject("anchor-set-invalid", "the receipts supply a numeric value but no numeric anchor was selected");
  }
  const derivable = new Set(anchorCandidates(faithful).map(anchorKey));
  for (const anchor of anchors) {
    if (!derivable.has(anchorKey(anchor))) {
      reject("anchor-not-fact-derived", `anchor ${anchor.value} (${anchor.factId}) is not derivable from an authoritative fact`);
    }
  }

  const invalidated = flipApplied ? anchorsInvalidatedBy(instrumentation.flip, faithful, counterfactual, anchors) : [];
  if (!flipApplied) {
    reject("anchor-not-invalidated", "the recorded flip could not be re-derived, so no contrast is demonstrated");
  } else if (invalidated.length === 0) {
    reject("anchor-not-invalidated",
      `the flip (${instrumentation.flip.factId}, ${flipKey(instrumentation.flip)}) leaves every anchor established; both arms demand the same behaviour`);
  } else if (invalidated.length > 1) {
    reject("flip-invalidates-multiple-anchors",
      `the flip invalidates ${invalidated.length} anchors (${invalidated.map((anchor) => anchor.value).join(", ")}); a minimal contrast changes exactly one`);
  }
  if (!factSetsEqual(instrumentation.counterfactualFacts, counterfactual) || !factSetsEqual(instrumentation.facts, faithful)) {
    reject("instrumentation-mismatch", "recorded fact sets differ from the facts re-derived from the receipts");
  }
  if (invalidated.length === 1 && !anchorKeysEqual([instrumentation.invalidated[0] as AnchorSpec], invalidated)) {
    reject("instrumentation-mismatch", "recorded invalidation differs from the one re-derived from the flip");
  }

  const carriedByChosen = anchors.filter((anchor) => narrationCarries(chosenText, anchor));
  const carriedByRejected = anchors.filter((anchor) => narrationCarries(rejectedText, anchor));
  const shared = flipApplied ? anchorsStillTrue(anchors, counterfactual) : [];
  const dropped = invalidated.length === 1 ? invalidated[0] as AnchorSpec : null;

  for (const anchor of anchors) {
    if (dropped && anchorKey(anchor) === anchorKey(dropped)) continue;
    if (!narrationCarries(chosenText, anchor)) {
      reject("faithful-arm-omits-anchor", `the chosen arm drops the ${anchor.kind} anchor "${anchor.value}" that the facts establish`);
    }
    if (flipApplied && narrationCarries(rejectedText, anchor) === false) {
      reject("shared-anchor-dropped",
        `"${anchor.value}" is true under BOTH fact sets, so both arms must carry it; the minimal contrast holds everything else constant`);
    }
  }
  if (dropped && narrationCarries(rejectedText, dropped)) {
    reject("rejected-arm-carries-invalidated-anchor",
      `the rejected arm carries "${dropped.value}", which the flipped fact no longer establishes`);
  }
  if (chosenText !== rejectedText
    && carriedByChosen.length === carriedByRejected.length
    && carriedByChosen.every((anchor) => narrationCarries(rejectedText, anchor))) {
    reject("style-only-difference",
      "both arms carry an identical anchor set, so the only difference is surface register; that trains style, not fidelity");
  }

  if (flipApplied) {
    const chosenViolations = violationMap(chosenText, spec.receipts);
    const rejectedViolations = violationMap(rejectedText, spec.receipts);
    const introduced = introducedSurfaces(instrumentation.flip);
    for (const violation of difference(rejectedViolations, chosenViolations)) {
      // A violation bound to the flipped fact IS the contrast. An unbound one
      // is the contrast only when it quotes the counterfactual referent the
      // flip introduced; anything else is a second, unrelated divergence.
      const isContrast = violation.receiptId === instrumentation.flip.factId
        || (violation.receiptId === undefined && introduced.some((value) => surface(violation.excerpt).includes(surface(value))));
      if (!isContrast) {
        reject("multi-fact-divergence",
          `the rejected arm diverges from the facts at ${violation.receiptId ?? "no bound receipt"} (${violation.code}), outside the single flipped fact`);
      }
    }
    for (const violation of difference(chosenViolations, rejectedViolations)) {
      reject("multi-fact-divergence",
        `the chosen arm diverges from the facts at ${violation.receiptId ?? "no bound receipt"} (${violation.code}), outside the single flipped fact`);
    }
  }

  const promptDigest = sha256(stableStringify(pair.prompt));
  if (promptDigest !== instrumentation.promptDigest) {
    reject("prompt-surface-divergence", "the pair's prompt is not the prompt surface the instrumentation was built from");
  }

  const measurements: TwinMeasurements = {
    chosenWords: wordCount(chosenText),
    rejectedWords: wordCount(rejectedText),
    declaredLengthRatio: declared,
    measuredLengthRatio,
    carriedByChosen,
    carriedByRejected,
    invalidated,
    sharedAnchors: shared,
  };
  if (reasons.length > 0) return { ok: false, reasons, measurements };
  return { ok: true, reasons: [], measurements };
}

function anchorKeysEqual(left: readonly AnchorSpec[], right: readonly AnchorSpec[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((anchor, index) => {
    const other = right[index];
    return other !== undefined && anchorKey(anchor) === anchorKey(other);
  });
}

function factSetsEqual(left: readonly AuthoritativeFact[], right: readonly AuthoritativeFact[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((fact, index) => {
    const other = right[index];
    return other !== undefined && stableStringify(fact) === stableStringify(other);
  });
}

/* -------------------------------------------------------------------------- */
/* Prose quality: the fail-closed regression gate                              */
/* -------------------------------------------------------------------------- */

/**
 * The measured stock `prose-quality` rate on the frozen baseline corpus.
 *
 * Substring anchoring catches objective failures only, and there is NO
 * automatic prose-quality score in this suite. This constant plus
 * `assertProseQualityGate` is therefore the whole defence against an anchor
 * programme that trades prose for substring compliance -- the suite's single
 * latent regression risk.
 */
export const MIN_STOCK_PROSE_QUALITY = 4 / 8;

export const PROSE_QUALITY_RUBRIC_VERSION = "prose-quality-stock-v1";

export class ProseQualityError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`prose-quality gate: ${problems.join("; ")}`);
    this.name = "ProseQualityError";
    this.problems = problems;
  }
}

function proseGateProblems(rate: number): string[] {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    return [`prose-quality rate ${String(rate)} is not a measured fraction in 0..1`];
  }
  if (rate < MIN_STOCK_PROSE_QUALITY) {
    return [
      `prose-quality ${rate.toFixed(3)} is below the measured stock rate ${MIN_STOCK_PROSE_QUALITY.toFixed(3)} (4/8); `
      + "the anchor work must not trade prose for substring compliance",
    ];
  }
  return [];
}

/** Throws below the stock rate. Exactly 4/8 passes; nothing below it does. */
export function assertProseQualityGate(rate: number): void {
  const problems = proseGateProblems(rate);
  if (problems.length > 0) throw new ProseQualityError(problems);
}

export interface ProseQualityScoringRequest {
  /** Digest of the pair being graded, so a score cannot be reassigned. */
  readonly pairDigest: string;
  /** Digests of the arms, including the rejected arm's length tell. */
  readonly armDigests: readonly string[];
  readonly rubricVersion: string;
}

export interface ProseQualityScore {
  /** Fraction of graded items judged to pass, in 0..1. */
  readonly rate: number;
  /** Number of independently graded items. Zero is NOT a pass. */
  readonly graded: number;
  /** Identity of the grading run, for the audit trail. */
  readonly measuredBy: string;
}

/**
 * PORT, with no shipped implementation.
 *
 * There is no automatic prose-quality scorer in this repository, and inventing
 * one here would launder the very regression this gate exists to catch. A caller
 * must supply a real blinded grader. An absent scorer resolves to
 * *unavailable* and throws; it never resolves to a pass. This mirrors the
 * fail-closed pattern in `templateProfiles.ts`, where a missing pinned artifact
 * is a problem rather than a default.
 */
export interface ProseQualityScorer {
  readonly scorerId: string;
  readonly version: string;
  score(request: ProseQualityScoringRequest): ProseQualityScore;
}

/**
 * Resolve a scored rate through the port and hold it to the stock rate.
 * Fails closed when the scorer is absent, unmeasured or dishonest.
 */
export function assertProseQualityMeasured(
  request: ProseQualityScoringRequest,
  scorer?: ProseQualityScorer | null,
): ProseQualityScore {
  const problems: string[] = [];
  if (!scorer) {
    throw new ProseQualityError([
      "no prose-quality scorer is available; the gate is unavailable, not passed",
    ]);
  }
  if (!scorer.scorerId?.trim() || !scorer.version?.trim()) {
    problems.push("prose-quality scorer supplied no identity or version");
  }
  const score = scorer.score(request);
  if (!Number.isFinite(score.rate) || score.rate < 0 || score.rate > 1) {
    problems.push(`scorer reported an invalid rate ${String(score.rate)}`);
  }
  if (!Number.isSafeInteger(score.graded) || score.graded <= 0) {
    problems.push("scorer graded nothing; an unmeasured rate is not a pass");
  }
  if (!score.measuredBy?.trim()) {
    problems.push("scorer reported no measuring identity");
  }
  problems.push(...proseGateProblems(score.rate));
  if (problems.length > 0) throw new ProseQualityError(problems);
  return score;
}

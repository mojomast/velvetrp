#!/usr/bin/env node
/**
 * Synthetic-player harness for the design in `docs/synthetic-player-simulation.md`.
 *
 * The harness manufactures error-rich adventure declarations for coverage playtesting. It is an
 * evaluation-coverage tool: it never writes fixtures, never retries ambiguous writes, and never
 * claims to model real players. Everything here is deterministic under an explicit seed; the
 * module never calls `Math.random`.
 *
 * Layering:
 *   1. Personas (`PERSONAS`) are versioned archetypes. The model receives one persona layer per
 *      turn, never a hidden id, revision, digest, or provider detail.
 *   2. The generator seam (`GeneratorFn`) returns one strict JSON turn contract. It may be the
 *      OpenAI-compatible live generator or any injected fake. Validation is fail-closed.
 *   3. Surface noise is declared by the generator and applied here, from a seeded RNG, so the
 *      model never asserts what was actually sent.
 *   4. `SessionDriver` posts the declaration to the real adventure-turn routes and handles the
 *      confirmation + resume flow exactly like a client. Every write carries a run-derived
 *      idempotency key; an ambiguous failure stops the run as `uncertain`, with no blind retry.
 *   5. A run manifest records the tag-to-session mapping, per-turn targets and exact bytes,
 *      digests, and the achieved coverage matrix. The manifest is the authoritative record.
 *
 * This module is primarily meant to be imported by tests and driven by the CLI at the bottom.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

// -------------------------------------------------------------------------------------------------
// Versions, taxonomy, and shared vocabulary
// -------------------------------------------------------------------------------------------------

export const HARNESS_VERSION = "synthetic-play-v1";
export const PERSONA_VERSION = "personas-v1";

export const MECHANIC_FAMILIES = [
  "travel",
  "srd-check",
  "inventory",
  "commerce",
  "power",
  "rest",
  "combat-consumable",
  "combat-power",
  "quest-lifecycle",
  "quest-objective",
  "progression",
] as const;
export type MechanicFamily = (typeof MECHANIC_FAMILIES)[number];

/** Tool kinds the design doc maps to each family; recorded on every planned turn. */
export const FAMILY_TOOL_KINDS: Readonly<Record<MechanicFamily, string>> = {
  travel: "exact_actor_travel.select",
  "srd-check": "exact_srd_check.select",
  inventory: "exact_inventory_action.select",
  commerce: "exact_vendor_commerce.select",
  power: "exact_power_use.select",
  rest: "exact_rest.select",
  "combat-consumable": "exact_combat_consumable.select",
  "combat-power": "exact_combat_power.select",
  "quest-lifecycle": "exact_quest_lifecycle.select",
  "quest-objective": "exact_quest_objective.select",
  progression: "exact_progression_apply.select",
};

/** Reverse of `FAMILY_TOOL_KINDS`: tool kind -> family. Unknown kinds are simply absent. */
export const KIND_TO_FAMILY: Readonly<Record<string, MechanicFamily>> = Object.freeze(
  Object.fromEntries(MECHANIC_FAMILIES.map(family => [FAMILY_TOOL_KINDS[family], family])) as Record<string, MechanicFamily>,
);

export const FAILURE_MODES = [
  "direct",
  "ambiguous",
  "multi-family",
  "unsupported",
  "unadvertised",
  "small-talk-ooc",
  "literal-edge",
] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

/** Failure modes that deliberately aim off the advertised menu. */
export const OFF_MENU_FAILURE_MODES = ["unsupported", "unadvertised", "literal-edge"] as const;

export function isOffMenuFailureMode(value: FailureMode): boolean {
  return (OFF_MENU_FAILURE_MODES as readonly FailureMode[]).includes(value);
}

export const EFFORTS = ["low", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export function isMechanicFamily(value: unknown): value is MechanicFamily {
  return typeof value === "string" && (MECHANIC_FAMILIES as readonly string[]).includes(value);
}
export function isFailureMode(value: unknown): value is FailureMode {
  return typeof value === "string" && (FAILURE_MODES as readonly string[]).includes(value);
}
export function isEffort(value: unknown): value is Effort {
  return value === "low" || value === "high";
}

/**
 * Accepts either the short family id (`travel`) or the tool kind (`exact_actor_travel.select`).
 * The design doc's contract example labels `intended.family` with the tool kind, so the harness
 * normalizes both forms to the short family id used by the coverage matrix.
 */
export function resolveMechanicFamily(value: unknown): MechanicFamily | null {
  if (isMechanicFamily(value)) return value;
  if (typeof value === "string") {
    for (const family of MECHANIC_FAMILIES) {
      if (FAMILY_TOOL_KINDS[family] === value) return family;
    }
  }
  return null;
}

// -------------------------------------------------------------------------------------------------
// Seeded RNG (counter-based xmur3 hash). Never `Math.random`.
// -------------------------------------------------------------------------------------------------

export type SeededRng = {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [minInclusive, maxExclusive). Throws on an empty range. */
  int(minInclusive: number, maxExclusive: number): number;
  /** True with the given probability (clamped to [0, 1]). */
  chance(probability: number): boolean;
  /** Uniform element; throws on an empty list. */
  pick<T>(items: readonly T[]): T;
};

/** xmur3-style avalanche hash of one string, 32-bit unsigned. */
function xmur3Value(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 32-bit xmur3 hash for a seed. Exported so tests can pin sampling inputs. */
export function hashSeed(seed: string): number {
  return xmur3Value(seed);
}

/**
 * Deterministic RNG. Every draw hashes `seed#drawIndex`, so the sequence is reproducible,
 * order-dependent by design, and free of the lattice correlation a tiny stateful PRNG can show
 * on its first outputs. Same seed and same call sequence always produce the same bytes.
 */
export function createRng(seed: string): SeededRng {
  let drawIndex = 0;
  const nextFloat = (): number => xmur3Value(`${seed}#${drawIndex++}`) / 4294967296;
  return {
    next: nextFloat,
    int(minInclusive, maxExclusive) {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive) || maxExclusive <= minInclusive) {
        throw new Error(`invalid integer range [${minInclusive}, ${maxExclusive})`);
      }
      return minInclusive + Math.floor(nextFloat() * (maxExclusive - minInclusive));
    },
    chance(probability) {
      if (!Number.isFinite(probability)) throw new Error("chance requires a finite probability");
      const clamped = Math.min(1, Math.max(0, probability));
      return nextFloat() < clamped;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("cannot pick from an empty list");
      const value = items[Math.floor(nextFloat() * items.length)];
      return value as T;
    },
  };
}

/** `${runSeed}-0004` style per-turn seed from the design doc. */
export function formatTurnSeed(runSeed: string, turnIndex: number): string {
  if (!Number.isInteger(turnIndex) || turnIndex < 0) throw new Error("turnIndex must be a non-negative integer");
  return `${runSeed}-${String(turnIndex).padStart(4, "0")}`;
}

// -------------------------------------------------------------------------------------------------
// Personas (versioned archetypes)
// -------------------------------------------------------------------------------------------------

export const PERSONA_ARCHETYPES = ["achiever", "explorer", "socialiser", "rules-tinkerer", "impatient"] as const;
export type PersonaArchetype = (typeof PERSONA_ARCHETYPES)[number];

export type Verbosity = "plain" | "florid" | "terse" | "precise";
export type Patience = "high" | "medium" | "low";
export type ConfirmationDecision = "approve" | "reject" | "stall";

export type ConfirmationPolicy = {
  /** Seeded probability of approving a pending confirmation. */
  readonly approve: number;
  /** Seeded probability of rejecting a pending confirmation. */
  readonly reject: number;
  /** Seeded probability of stalling: no confirm POST, turn left awaiting confirmation. */
  readonly stall: number;
  /** Achiever only: progression proposals are always approved. */
  readonly alwaysApproveProgression: boolean;
};

export type PersonaDefinition = {
  /** Versioned id, e.g. `explorer.v1`. */
  readonly personaId: string;
  readonly archetype: PersonaArchetype;
  readonly personaVersion: string;
  readonly title: string;
  readonly goals: readonly string[];
  readonly mechanicsBias: readonly MechanicFamily[];
  readonly verbosity: Verbosity;
  /** Per-turn probability the planner requires a typo perturbation. */
  readonly typoRate: number;
  /** Per-turn probability the planner requires an abbreviation perturbation. */
  readonly abbreviationRate: number;
  readonly patience: Patience;
  /** Per-turn probability the planner requires a trailing-question OOC split. */
  readonly oocRate: number;
  /** Relative scheduler weight per failure class; `direct` is deliberately a minority. */
  readonly failureAffinity: Readonly<Record<FailureMode, number>>;
  readonly confirmationPolicy: ConfirmationPolicy;
  readonly notes: string;
};

function personaDefinition(input: {
  archetype: PersonaArchetype;
  title: string;
  goals: readonly string[];
  mechanicsBias: readonly MechanicFamily[];
  verbosity: Verbosity;
  typoRate: number;
  abbreviationRate: number;
  patience: Patience;
  oocRate: number;
  failureAffinity: Readonly<Record<FailureMode, number>>;
  confirmationPolicy: ConfirmationPolicy;
  notes: string;
}): PersonaDefinition {
  const policyTotal = input.confirmationPolicy.approve + input.confirmationPolicy.reject + input.confirmationPolicy.stall;
  if (!Number.isFinite(policyTotal) || policyTotal <= 0) throw new Error(`persona ${input.archetype} has an empty confirmation policy`);
  for (const rate of [input.typoRate, input.abbreviationRate, input.oocRate]) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`persona ${input.archetype} has an out-of-range rate`);
  }
  for (const mode of FAILURE_MODES) {
    const weight = input.failureAffinity[mode];
    if (!Number.isFinite(weight) || weight <= 0) throw new Error(`persona ${input.archetype} has an invalid failure affinity for ${mode}`);
  }
  return Object.freeze({
    personaId: `${input.archetype}.v1`,
    archetype: input.archetype,
    personaVersion: PERSONA_VERSION,
    title: input.title,
    goals: [...input.goals],
    mechanicsBias: [...input.mechanicsBias],
    verbosity: input.verbosity,
    typoRate: input.typoRate,
    abbreviationRate: input.abbreviationRate,
    patience: input.patience,
    oocRate: input.oocRate,
    failureAffinity: Object.freeze({ ...input.failureAffinity }),
    confirmationPolicy: Object.freeze({ ...input.confirmationPolicy }),
    notes: input.notes,
  });
}

/**
 * The five versioned archetypes. The matrix mirrors the design doc: goals, mechanics bias,
 * verbosity, typo/abbreviation rate, patience, and OOC profile.
 */
export const PERSONAS: Readonly<Record<PersonaArchetype, PersonaDefinition>> = Object.freeze({
  achiever: personaDefinition({
    archetype: "achiever",
    title: "Achiever",
    goals: ["advance quests", "level up", "acquire gear"],
    mechanicsBias: ["quest-lifecycle", "quest-objective", "progression", "commerce"],
    verbosity: "plain",
    typoRate: 0.03,
    abbreviationRate: 0.05,
    patience: "high",
    oocRate: 0.05,
    failureAffinity: { direct: 0.6, ambiguous: 0.9, "multi-family": 0.8, unsupported: 0.7, unadvertised: 0.7, "small-talk-ooc": 0.35, "literal-edge": 0.7 },
    confirmationPolicy: { approve: 0.92, reject: 0.05, stall: 0.03, alwaysApproveProgression: true },
    notes: "Always confirms progression; keeps declared goals in view.",
  }),
  explorer: personaDefinition({
    archetype: "explorer",
    title: "Explorer",
    goals: ["reach new places", "inspect the world", "discover the unknown"],
    mechanicsBias: ["travel", "srd-check"],
    verbosity: "florid",
    typoRate: 0.04,
    abbreviationRate: 0.06,
    patience: "medium",
    oocRate: 0.08,
    failureAffinity: { direct: 0.6, ambiguous: 1.2, "multi-family": 0.8, unsupported: 0.9, unadvertised: 1.4, "small-talk-ooc": 0.4, "literal-edge": 0.8 },
    confirmationPolicy: { approve: 0.8, reject: 0.08, stall: 0.12, alwaysApproveProgression: false },
    notes: "References earlier places; prefers unadvertised destinations.",
  }),
  socialiser: personaDefinition({
    archetype: "socialiser",
    title: "Socialiser",
    goals: ["talk to people", "build relationships", "ask questions"],
    mechanicsBias: ["commerce", "quest-lifecycle"],
    verbosity: "plain",
    typoRate: 0.07,
    abbreviationRate: 0.12,
    patience: "low",
    oocRate: 0.3,
    failureAffinity: { direct: 0.35, ambiguous: 1, "multi-family": 0.9, unsupported: 0.7, unadvertised: 0.6, "small-talk-ooc": 1.6, "literal-edge": 0.6 },
    confirmationPolicy: { approve: 0.35, reject: 0.25, stall: 0.4, alwaysApproveProgression: false },
    notes: "Ignores advertised mechanics; asks meta questions.",
  }),
  "rules-tinkerer": personaDefinition({
    archetype: "rules-tinkerer",
    title: "Rules-tinkerer",
    goals: ["test boundaries", "learn exact mechanics", "find edge cases"],
    mechanicsBias: ["inventory", "rest", "power", "combat-consumable", "combat-power"],
    verbosity: "precise",
    typoRate: 0.03,
    abbreviationRate: 0.05,
    patience: "high",
    oocRate: 0.12,
    failureAffinity: { direct: 0.5, ambiguous: 1.1, "multi-family": 1.4, unsupported: 1.1, unadvertised: 1, "small-talk-ooc": 0.7, "literal-edge": 1.6 },
    confirmationPolicy: { approve: 0.85, reject: 0.1, stall: 0.05, alwaysApproveProgression: false },
    notes: "Literal readings and two-intent turns; reads rules text aloud.",
  }),
  impatient: personaDefinition({
    archetype: "impatient",
    title: "Impatient",
    goals: ["finish fast", "skip the talk", "get to the next fight"],
    mechanicsBias: ["travel", "rest", "combat-consumable", "combat-power"],
    verbosity: "terse",
    typoRate: 0.14,
    abbreviationRate: 0.18,
    patience: "low",
    oocRate: 0.15,
    failureAffinity: { direct: 1.2, ambiguous: 0.7, "multi-family": 0.5, unsupported: 0.8, unadvertised: 0.6, "small-talk-ooc": 0.8, "literal-edge": 0.9 },
    confirmationPolicy: { approve: 0.55, reject: 0.35, stall: 0.1, alwaysApproveProgression: false },
    notes: "Short turns and self-corrections; hates negotiation.",
  }),
});

/** Canonical persona order used by the CLI and tests. */
export const PERSONA_LIST: readonly PersonaDefinition[] = Object.freeze(PERSONA_ARCHETYPES.map(archetype => PERSONAS[archetype]));

export function isPersonaArchetype(value: unknown): value is PersonaArchetype {
  return typeof value === "string" && (PERSONA_ARCHETYPES as readonly string[]).includes(value);
}

/** Accepts either the versioned id (`explorer.v1`) or the bare archetype (`explorer`). */
export function personaById(id: string): PersonaDefinition {
  const normalized = id.trim();
  const archetype = normalized.endsWith(".v1") ? normalized.slice(0, -3) : normalized;
  if (!isPersonaArchetype(archetype)) throw new Error(`unknown persona: ${id}`);
  return PERSONAS[archetype];
}

export function personaByArchetype(archetype: PersonaArchetype): PersonaDefinition {
  return PERSONAS[archetype];
}

/**
 * Prompt-only declaration word budget per persona voice. The model is asked to stay in the lower
 * half of its range unless the failure mode or effort calls for a longer turn. This is guidance,
 * never validation: long declarations are accepted and never retried. `precise` is not in the
 * design doc's table, so the rules-tinkerer voice gets the plain-to-florid middle.
 */
export const WORD_BUDGET_BY_VERBOSITY: Readonly<Record<Verbosity, string>> = Object.freeze({
  terse: "4-12",
  plain: "8-20",
  florid: "14-35",
  precise: "10-24",
});

// -------------------------------------------------------------------------------------------------
// Surface noise: declared by the generator, applied here from a seed
// -------------------------------------------------------------------------------------------------

export const SURFACE_NOISES = [
  "lowercase",
  "uppercase-first",
  "abbreviation",
  "typo",
  "trailing-question-ooc",
  "self-correction",
] as const;
export type SurfaceNoiseName = (typeof SURFACE_NOISES)[number];

export type NoiseResult = {
  /** Resulting declaration bytes. */
  text: string;
  /** OOC aside produced by the perturbation, when the perturbation splits one off. */
  ooc?: string;
};

export type SurfaceNoiseFn = (text: string, seed: string) => NoiseResult;

/** Token replacement table used by `noiseAbbreviation`. */
export const ABBREVIATIONS: Readonly<Record<string, string>> = {
  with: "w/",
  without: "w/o",
  because: "bc",
  about: "abt",
  before: "b4",
  you: "u",
  your: "ur",
  though: "tho",
  through: "thru",
  probably: "prob",
  something: "smth",
};

/**
 * Lowercases every byte. Exact semantics: `text.toLowerCase()`.
 * (Seeded only to keep the `SurfaceNoiseFn` signature uniform.)
 */
export const noiseLowercase: SurfaceNoiseFn = (text) => ({ text: text.toLowerCase() });

/**
 * Uppercases the first ASCII letter of the declaration and leaves the rest untouched.
 * Exact semantics: prefix + `X.toUpperCase()` on the first `[a-z]`.
 */
export const noiseUppercaseFirst: SurfaceNoiseFn = (text) => {
  const match = /[a-z]/.exec(text);
  if (!match || match.index === undefined) return { text };
  return { text: text.slice(0, match.index) + match[0].toUpperCase() + text.slice(match.index + 1) };
};

/** Replaces exactly one token that has a table entry with its abbreviation. */
export const noiseAbbreviation: SurfaceNoiseFn = (text, seed) => {
  const candidates = wordTokens(text).filter(token => ABBREVIATIONS[token.value.toLowerCase()] !== undefined);
  if (candidates.length === 0) return { text };
  const rng = createRng(`${seed}:abbreviation`);
  const token = rng.pick(candidates);
  const replacement = ABBREVIATIONS[token.value.toLowerCase()] as string;
  return { text: text.slice(0, token.start) + replacement + text.slice(token.end) };
};

/**
 * Typo insertion: picks one alphabetic token of length >= 3, then either swaps two adjacent
 * different characters or omits one character. The operation choice is seeded 50/50 and falls
 * back to omission when no swap position changes bytes.
 */
export const noiseTypo: SurfaceNoiseFn = (text, seed) => {
  const rng = createRng(`${seed}:typo`);
  const tokens = wordTokens(text).filter(token => token.value.length >= 3);
  if (tokens.length === 0) return { text };
  const token = rng.pick(tokens);
  const chars = token.value;
  const wantSwap = rng.chance(0.5);
  let mutated: string | null = null;
  if (wantSwap) {
    const positions: number[] = [];
    for (let index = 0; index < chars.length - 1; index += 1) {
      if (chars[index] !== chars[index + 1]) positions.push(index);
    }
    if (positions.length > 0) {
      const index = rng.pick(positions);
      mutated = chars.slice(0, index) + chars[index + 1] + chars[index] + chars.slice(index + 2);
    }
  }
  if (mutated === null) {
    const index = rng.int(0, chars.length);
    mutated = chars.slice(0, index) + chars.slice(index + 1);
    if (mutated.length === 0) mutated = chars;
  }
  return { text: text.slice(0, token.start) + mutated + text.slice(token.end) };
};

/** Questions appended when `noiseTrailingQuestionOoc` finds no trailing question to split. */
export const TRAILING_QUESTION_BANK = [
  "Can I still make it back before dark?",
  "Wait, do I recognize anyone here?",
  "How much time do I have left?",
  "Did that actually work?",
] as const;

/**
 * Trailing-question OOC split. If the trimmed declaration ends in `?` and has an earlier sentence
 * boundary, the final question becomes the OOC aside and the leading sentences stay as the
 * declaration. A declaration that is only a question is returned unchanged. With no trailing
 * question at all, one seeded question from `TRAILING_QUESTION_BANK` is appended as OOC so the
 * declared small-talk coverage still materializes.
 */
export const noiseTrailingQuestionOoc: SurfaceNoiseFn = (text, seed) => {
  const trimmed = text.trim();
  if (trimmed.endsWith("?")) {
    const body = trimmed.slice(0, -1);
    let boundary = -1;
    for (const mark of [".", "!", "?"]) {
      const index = body.lastIndexOf(mark);
      if (index > boundary) boundary = index;
    }
    if (boundary >= 0) {
      const declaration = body.slice(0, boundary + 1).trim();
      const question = `${body.slice(boundary + 1).trim()}?`;
      if (declaration.length > 0 && question.length > 1) return { text: declaration, ooc: question };
    }
    return { text: trimmed };
  }
  const rng = createRng(`${seed}:trailing-question-ooc`);
  return { text: trimmed, ooc: rng.pick(TRAILING_QUESTION_BANK) };
};

/** Correction prefixes used by `noiseSelfCorrection`. */
export const SELF_CORRECTION_BANK = [
  "Wait, no — ",
  "Hold on, scratch that — ",
  "Hmm, actually no — ",
  "No wait, forget my last idea — ",
] as const;

/**
 * Self-correction insertion. Prepends one seeded correction cue so the inserted clause reads as a
 * corrected restatement and the original declaration remains the last (operative) intent.
 */
export const noiseSelfCorrection: SurfaceNoiseFn = (text, seed) => {
  const rng = createRng(`${seed}:self-correction`);
  return { text: `${rng.pick(SELF_CORRECTION_BANK)}${text.trim()}` };
};

export const SURFACE_NOISE_FUNCTIONS: Readonly<Record<SurfaceNoiseName, SurfaceNoiseFn>> = Object.freeze({
  lowercase: noiseLowercase,
  "uppercase-first": noiseUppercaseFirst,
  abbreviation: noiseAbbreviation,
  typo: noiseTypo,
  "trailing-question-ooc": noiseTrailingQuestionOoc,
  "self-correction": noiseSelfCorrection,
});

export function isSurfaceNoiseName(value: unknown): value is SurfaceNoiseName {
  return typeof value === "string" && (SURFACE_NOISES as readonly string[]).includes(value);
}

export type NoisedTurn = {
  declaration: string;
  ooc?: string;
  /** Perturbations actually applied, in declared order. */
  applied: SurfaceNoiseName[];
};

/**
 * Applies the declared perturbations in order. Each perturbation derives its own sub-seed from
 * the turn seed, so the same declaration + seed + noise list always yields identical bytes.
 * OOC text produced by several perturbations is joined with a single space.
 */
export function applySurfaceNoise(input: {
  declaration: string;
  ooc?: string;
  noise: readonly SurfaceNoiseName[];
  seed: string;
}): NoisedTurn {
  let text = input.declaration;
  let ooc = input.ooc && input.ooc.trim().length > 0 ? input.ooc.trim() : undefined;
  const applied: SurfaceNoiseName[] = [];
  for (const name of input.noise) {
    const fn = SURFACE_NOISE_FUNCTIONS[name];
    const result = fn(text, `${input.seed}:${name}`);
    text = result.text;
    if (result.ooc && result.ooc.trim().length > 0) {
      ooc = ooc ? `${ooc} ${result.ooc.trim()}` : result.ooc.trim();
    }
    applied.push(name);
  }
  const declaration = text.trim();
  if (declaration.length === 0) throw new Error("surface noise erased the declaration");
  return ooc ? { declaration, ooc, applied } : { declaration, applied };
}

type WordToken = { value: string; start: number; end: number };

function wordTokens(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(/[A-Za-z][A-Za-z'-]*/g)) {
    const value = match[0];
    const start = match.index ?? 0;
    tokens.push({ value, start, end: start + value.length });
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------------
// Per-turn generation contract
// -------------------------------------------------------------------------------------------------

export type TurnContract = {
  runId: string;
  sessionId: string;
  turnIndex: number;
  personaId: string;
  seed: string;
  effort: Effort;
  declaration: string;
  ooc?: string;
  intended: { family: MechanicFamily; failureMode: FailureMode };
  noise: SurfaceNoiseName[];
  /** Names the generator declared that this harness does not implement (recorded, never applied). */
  noiseDropped: string[];
  references: string[];
};

export type TurnContractContext = {
  runId?: string;
  /** Acceptable `sessionId` values (the synthetic tag and/or the bound API session id). */
  sessionIds?: readonly string[];
  turnIndex?: number;
  personaId?: string;
  seed?: string;
  target?: { family: MechanicFamily; failureMode: FailureMode };
  effort?: Effort;
  requiredNoise?: readonly SurfaceNoiseName[];
  maxDeclarationChars?: number;
  maxReferences?: number;
};

export class TurnContractError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[], summary = "invalid turn contract") {
    super(issues.length > 0 ? `${summary}: ${issues.join("; ")}` : summary);
    this.name = "TurnContractError";
    this.issues = issues;
  }
}

const CONTRACT_REQUIRED_KEYS = [
  "runId",
  "sessionId",
  "turnIndex",
  "personaId",
  "seed",
  "effort",
  "declaration",
  "intended",
  "noise",
  "references",
] as const;
const CONTRACT_OPTIONAL_KEYS = ["ooc", "noiseDropped"] as const;

/** Strict, fail-closed validation with every problem reported, not just the first. */
export function validateTurnContract(value: unknown, context: TurnContractContext = {}): TurnContract {
  if (!isPlainObject(value)) throw new TurnContractError(["contract must be a JSON object"]);
  const issues: string[] = [];
  const allowed = new Set<string>([...CONTRACT_REQUIRED_KEYS, ...CONTRACT_OPTIONAL_KEYS]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`unknown field "${key}"`);
  }
  for (const key of CONTRACT_REQUIRED_KEYS) {
    if (!(key in value)) issues.push(`missing required field "${key}"`);
  }

  const runId = requireText(value, "runId", issues);
  const sessionId = requireText(value, "sessionId", issues);
  const personaId = requireText(value, "personaId", issues);
  const seed = requireText(value, "seed", issues);

  let turnIndex: number | null = null;
  const rawTurnIndex = value["turnIndex"];
  if (typeof rawTurnIndex !== "number" || !Number.isInteger(rawTurnIndex) || rawTurnIndex < 0) {
    issues.push('"turnIndex" must be a non-negative integer');
  } else {
    turnIndex = rawTurnIndex;
  }

  let effort: Effort | null = null;
  if (!isEffort(value["effort"])) issues.push('"effort" must be "low" or "high"');
  else effort = value["effort"];

  const declaration = requireText(value, "declaration", issues);
  const maxDeclarationChars = context.maxDeclarationChars ?? 8000;
  if (declaration !== null && declaration.length > maxDeclarationChars) {
    issues.push(`"declaration" exceeds ${maxDeclarationChars} characters`);
  }

  let ooc: string | undefined;
  if ("ooc" in value) {
    const rawOoc = value["ooc"];
    if (typeof rawOoc !== "string") issues.push('"ooc" must be a string when present');
    else if (rawOoc.trim().length > 0) ooc = rawOoc.trim();
  }

  let family: MechanicFamily | null = null;
  let failureMode: FailureMode | null = null;
  const intended = value["intended"];
  if (!isPlainObject(intended)) {
    issues.push('"intended" must be an object with "family" and "failureMode"');
  } else {
    for (const key of Object.keys(intended)) {
      if (key !== "family" && key !== "failureMode") issues.push(`unknown field "intended.${key}"`);
    }
    if (!isMechanicFamily(intended["family"]) && resolveMechanicFamily(intended["family"]) === null) {
      issues.push(`"intended.family" must be a family id (${MECHANIC_FAMILIES.join(", ")}) or a tool kind (${Object.values(FAMILY_TOOL_KINDS).join(", ")})`);
    } else {
      family = resolveMechanicFamily(intended["family"]);
    }
    if (!isFailureMode(intended["failureMode"])) issues.push(`"intended.failureMode" must be one of ${FAILURE_MODES.join(", ")}`);
    else failureMode = intended["failureMode"];
  }

  const noise: SurfaceNoiseName[] = [];
  const noiseDropped: string[] = [];
  const rawDropped = value["noiseDropped"];
  if (rawDropped !== undefined) {
    if (!Array.isArray(rawDropped) || rawDropped.some((entry) => typeof entry !== "string")) {
      issues.push('"noiseDropped" must be an array of strings');
    } else {
      noiseDropped.push(...rawDropped);
    }
  }
  const rawNoise = value["noise"];
  if (!Array.isArray(rawNoise)) {
    issues.push('"noise" must be an array of surface-noise names');
  } else {
    for (const [index, entry] of rawNoise.entries()) {
      if (!isSurfaceNoiseName(entry)) {
        const dropped = typeof entry === "string" ? entry : JSON.stringify(entry);
        if (!noiseDropped.includes(dropped)) noiseDropped.push(dropped);
      } else if (noise.includes(entry)) issues.push(`"noise" repeats "${entry}"`);
      else noise.push(entry);
    }
  }

  const references: string[] = [];
  const rawReferences = value["references"];
  const maxReferences = context.maxReferences ?? 32;
  if (!Array.isArray(rawReferences)) {
    issues.push('"references" must be an array of strings');
  } else if (rawReferences.length > maxReferences) {
    issues.push(`"references" exceeds ${maxReferences} entries`);
  } else {
    for (const [index, entry] of rawReferences.entries()) {
      if (typeof entry !== "string" || entry.trim().length === 0) issues.push(`"references[${index}]" must be a nonblank string`);
      else if (references.includes(entry.trim())) issues.push(`"references" repeats "${entry.trim()}"`);
      else references.push(entry.trim());
    }
  }

  if (context.runId !== undefined && runId !== null && runId !== context.runId) {
    issues.push(`runId mismatch: expected "${context.runId}", got "${runId}"`);
  }
  if (context.sessionIds !== undefined && sessionId !== null && !context.sessionIds.includes(sessionId)) {
    issues.push(`sessionId mismatch: expected one of ${context.sessionIds.map(id => `"${id}"`).join(", ")}, got "${sessionId}"`);
  }
  if (context.turnIndex !== undefined && turnIndex !== null && turnIndex !== context.turnIndex) {
    issues.push(`turnIndex mismatch: expected ${context.turnIndex}, got ${turnIndex}`);
  }
  if (context.personaId !== undefined && personaId !== null && personaId !== context.personaId) {
    issues.push(`personaId mismatch: expected "${context.personaId}", got "${personaId}"`);
  }
  if (context.seed !== undefined && seed !== null && seed !== context.seed) {
    issues.push(`seed mismatch: expected "${context.seed}", got "${seed}"`);
  }
  if (context.effort !== undefined && effort !== null && effort !== context.effort) {
    issues.push(`effort mismatch: expected "${context.effort}", got "${effort}"`);
  }
  if (context.target !== undefined && family !== null && failureMode !== null) {
    if (family !== context.target.family || failureMode !== context.target.failureMode) {
      issues.push(`intended target mismatch: expected ${context.target.family}/${context.target.failureMode}, got ${family}/${failureMode}`);
    }
  }
  for (const required of context.requiredNoise ?? []) {
    if (!noise.includes(required)) issues.push(`required noise "${required}" was not declared`);
  }

  if (issues.length > 0) throw new TurnContractError(issues);
  return {
    runId: runId as string,
    sessionId: sessionId as string,
    turnIndex: turnIndex as number,
    personaId: personaId as string,
    seed: seed as string,
    effort: effort as Effort,
    declaration: declaration as string,
    ...(ooc ? { ooc } : {}),
    intended: { family: family as MechanicFamily, failureMode: failureMode as FailureMode },
    noise,
    noiseDropped,
    references,
  };
}

function requireText(record: Record<string, unknown>, key: string, issues: string[]): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`"${key}" must be a nonblank string`);
    return null;
  }
  return value.trim();
}

/** Strips one wrapping markdown code fence (with or without a `json` tag). */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * Leniently parses a generator response: strips code fences, tries the whole text, then the first
 * balanced JSON object. Validation is still strict and fail-closed.
 */
export function parseTurnContractJson(text: string, context: TurnContractContext = {}): TurnContract {
  const candidate = stripCodeFences(text);
  const attempts = [candidate];
  const extracted = extractFirstJsonObject(candidate);
  if (extracted !== null && extracted !== candidate) attempts.push(extracted);
  let lastError: string | null = null;
  for (const attempt of attempts) {
    try {
      return validateTurnContract(JSON.parse(attempt), context);
    } catch (error) {
      if (error instanceof TurnContractError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new TurnContractError([`response is not valid JSON (${lastError ?? "empty response"})`], "generator returned an unparseable turn contract");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -------------------------------------------------------------------------------------------------
// Coverage matrix and weighted scheduler
// -------------------------------------------------------------------------------------------------

export type CoverageCell = { family: MechanicFamily; failureMode: FailureMode };
export type CoverageTargets = Readonly<Record<MechanicFamily, Readonly<Record<FailureMode, number>>>>;
export type CoverageMatrix = Record<MechanicFamily, Record<FailureMode, number>>;

/** Design target: 4 declarations per family x failure-mode cell. */
export const COVERAGE_TARGET_PER_CELL = 4;
export const COVERAGE_CELL_COUNT = MECHANIC_FAMILIES.length * FAILURE_MODES.length;
export const COVERAGE_TOTAL_TARGET = COVERAGE_CELL_COUNT * COVERAGE_TARGET_PER_CELL;

export function defaultCoverageTargets(perCell: number = COVERAGE_TARGET_PER_CELL): CoverageTargets {
  if (!Number.isInteger(perCell) || perCell < 0) throw new Error("coverage target per cell must be a non-negative integer");
  const targets = {} as Record<MechanicFamily, Readonly<Record<FailureMode, number>>>;
  for (const family of MECHANIC_FAMILIES) {
    const row = {} as Record<FailureMode, number>;
    for (const mode of FAILURE_MODES) row[mode] = perCell;
    targets[family] = Object.freeze(row);
  }
  return Object.freeze(targets);
}

export const COVERAGE_TARGETS: CoverageTargets = defaultCoverageTargets();

export function emptyCoverageMatrix(): CoverageMatrix {
  const matrix = {} as CoverageMatrix;
  for (const family of MECHANIC_FAMILIES) {
    matrix[family] = {} as Record<FailureMode, number>;
    for (const mode of FAILURE_MODES) matrix[family][mode] = 0;
  }
  return matrix;
}

export type CoverageReport = {
  targets: CoverageTargets;
  planned: CoverageMatrix;
  achieved: CoverageMatrix;
  advertised: CoverageMatrix;
  acted: CoverageMatrix;
  remaining: CoverageMatrix;
  totals: {
    target: number;
    planned: number;
    achieved: number;
    advertisedTotal: number;
    actedTotal: number;
    remaining: number;
    satisfiedCells: number;
    totalCells: number;
  };
  exhausted: boolean;
  byFamily: Record<MechanicFamily, { target: number; planned: number; achieved: number; advertised: number; acted: number }>;
  byFailureMode: Record<FailureMode, { target: number; planned: number; achieved: number }>;
};

export type CoverageSchedulerOptions = {
  targets?: CoverageTargets;
  persona?: PersonaDefinition;
  /** Weight for families outside `persona.mechanicsBias`. */
  baseFamilyWeight?: number;
  /** Weight for families inside `persona.mechanicsBias`. */
  biasFamilyWeight?: number;
  /** Multiplier for `direct` cells, used to raise harvest volume (default 1, minimum 0.1). */
  directWeight?: number;
};

/** Default scheduler multiplier for direct-failure cells. */
export const DEFAULT_DIRECT_WEIGHT = 1;
/** Floor for `directWeight`; below this a direct cell would be nearly unreachable. */
export const MIN_DIRECT_WEIGHT = 0.1;

function cellKey(family: MechanicFamily, failureMode: FailureMode): string {
  return `${family}/${failureMode}`;
}

/** Scheduler cell weight: persona family bias times the persona's failure-class affinity. */
export function coverageWeight(
  persona: PersonaDefinition | null,
  cell: CoverageCell,
  options: { baseFamilyWeight?: number; biasFamilyWeight?: number; directWeight?: number } = {},
): number {
  const base = options.baseFamilyWeight ?? 1;
  const bias = options.biasFamilyWeight ?? 3;
  const directWeight = options.directWeight ?? DEFAULT_DIRECT_WEIGHT;
  if (!(base > 0) || !(bias > 0)) throw new Error("coverage family weights must be positive");
  if (!Number.isFinite(directWeight) || directWeight < MIN_DIRECT_WEIGHT) {
    throw new Error(`directWeight must be a finite number >= ${MIN_DIRECT_WEIGHT}`);
  }
  const familyWeight = persona && persona.mechanicsBias.includes(cell.family) ? bias : base;
  const failureWeight = persona ? persona.failureAffinity[cell.failureMode] : 1;
  if (!(familyWeight > 0) || !(failureWeight > 0)) throw new Error("coverage weight must be positive");
  return familyWeight * failureWeight * (cell.failureMode === "direct" ? directWeight : 1);
}

function validateCoverageTargets(targets: CoverageTargets): void {
  let total = 0;
  for (const family of MECHANIC_FAMILIES) {
    const row = targets[family];
    if (!row) throw new Error(`coverage targets are missing family "${family}"`);
    for (const mode of FAILURE_MODES) {
      const value = row[mode];
      if (!Number.isInteger(value) || value < 0) throw new Error(`coverage target ${family}/${mode} must be a non-negative integer`);
      total += value;
    }
  }
  if (total <= 0) throw new Error("coverage targets must include at least one declaration");
}

/**
 * Weighted, deterministic slot allocator over the 11 x 7 coverage matrix. `next` reserves the
 * next cell (tracking remaining counts), `reserve` reserves a specific cell for a forced focus
 * turn, `record` marks a cell as actually declared. Selection is weighted by persona bias but
 * never exceeds a cell target.
 */
export class CoverageScheduler {
  readonly targets: CoverageTargets;
  readonly #persona: PersonaDefinition | null;
  readonly #baseFamilyWeight: number;
  readonly #biasFamilyWeight: number;
  readonly #directWeight: number;
  readonly #totalTarget: number;
  readonly #planned = new Map<string, number>();
  readonly #achieved = new Map<string, number>();
  readonly #advertised = new Map<string, number>();
  readonly #acted = new Map<string, number>();

  constructor(options: CoverageSchedulerOptions = {}) {
    this.targets = options.targets ?? COVERAGE_TARGETS;
    this.#persona = options.persona ?? null;
    this.#baseFamilyWeight = options.baseFamilyWeight ?? 1;
    this.#biasFamilyWeight = options.biasFamilyWeight ?? 3;
    this.#directWeight = options.directWeight ?? DEFAULT_DIRECT_WEIGHT;
    validateCoverageTargets(this.targets);
    if (!(this.#baseFamilyWeight > 0) || !(this.#biasFamilyWeight > 0)) throw new Error("coverage family weights must be positive");
    if (!Number.isFinite(this.#directWeight) || this.#directWeight < MIN_DIRECT_WEIGHT) {
      throw new Error(`directWeight must be a finite number >= ${MIN_DIRECT_WEIGHT}`);
    }
    let total = 0;
    for (const family of MECHANIC_FAMILIES) for (const mode of FAILURE_MODES) total += this.targets[family][mode];
    this.#totalTarget = total;
  }

  get totalTarget(): number {
    return this.#totalTarget;
  }

  get totalPlanned(): number {
    let total = 0;
    for (const value of this.#planned.values()) total += value;
    return total;
  }

  get totalAchieved(): number {
    let total = 0;
    for (const value of this.#achieved.values()) total += value;
    return total;
  }

  get totalAdvertised(): number {
    let total = 0;
    for (const value of this.#advertised.values()) total += value;
    return total;
  }

  get totalActed(): number {
    let total = 0;
    for (const value of this.#acted.values()) total += value;
    return total;
  }

  get exhausted(): boolean {
    return this.totalPlanned >= this.#totalTarget;
  }

  remainingFor(cell: CoverageCell): number {
    return Math.max(0, this.targets[cell.family][cell.failureMode] - (this.#planned.get(cellKey(cell.family, cell.failureMode)) ?? 0));
  }

  plannedFor(cell: CoverageCell): number {
    return this.#planned.get(cellKey(cell.family, cell.failureMode)) ?? 0;
  }

  achievedFor(cell: CoverageCell): number {
    return this.#achieved.get(cellKey(cell.family, cell.failureMode)) ?? 0;
  }

  hasRemaining(): boolean {
    for (const family of MECHANIC_FAMILIES) {
      for (const mode of FAILURE_MODES) {
        if (this.remainingFor({ family, failureMode: mode }) > 0) return true;
      }
    }
    return false;
  }

  /**
   * Reserves and returns the next weighted cell, or `null` when every cell target is met. When
   * `advertisedFamilies` is non-empty, remaining cells from those families are preferred; if the
   * menu has no remaining cell the global weighted choice is used so probe turns still draw from
   * the whole matrix.
   */
  next(rng: SeededRng, options: { advertisedFamilies?: readonly MechanicFamily[] } = {}): CoverageCell | null {
    const advertisedFamilies = options.advertisedFamilies;
    const advertised = advertisedFamilies !== undefined && advertisedFamilies.length > 0
      ? new Set(advertisedFamilies)
      : null;
    let candidates = this.#collectCandidates(advertised);
    if (candidates.length === 0) candidates = this.#collectCandidates(null);
    if (candidates.length === 0) return null;
    let total = 0;
    for (const candidate of candidates) total += candidate.weight;
    let roll = rng.next() * total;
    let chosen = candidates[candidates.length - 1] as { cell: CoverageCell; weight: number };
    for (const candidate of candidates) {
      roll -= candidate.weight;
      if (roll < 0) {
        chosen = candidate;
        break;
      }
    }
    const key = cellKey(chosen.cell.family, chosen.cell.failureMode);
    this.#planned.set(key, (this.#planned.get(key) ?? 0) + 1);
    return chosen.cell;
  }

  #collectCandidates(advertised: ReadonlySet<MechanicFamily> | null): { cell: CoverageCell; weight: number }[] {
    const candidates: { cell: CoverageCell; weight: number }[] = [];
    for (const family of MECHANIC_FAMILIES) {
      if (advertised !== null && !advertised.has(family)) continue;
      for (const mode of FAILURE_MODES) {
        const cell: CoverageCell = { family, failureMode: mode };
        if (this.remainingFor(cell) <= 0) continue;
        candidates.push({ cell, weight: coverageWeight(this.#persona, cell, { baseFamilyWeight: this.#baseFamilyWeight, biasFamilyWeight: this.#biasFamilyWeight, directWeight: this.#directWeight }) });
      }
    }
    return candidates;
  }

  /**
   * Reserves one slot for a specific cell without consulting the target, so a forced focus cell is
   * accounted for even when its target is already met. `release` is its inverse (with a floor of 0).
   */
  reserve(cell: CoverageCell): void {
    const key = cellKey(cell.family, cell.failureMode);
    this.#planned.set(key, (this.#planned.get(key) ?? 0) + 1);
  }

  /** Releases one reserved slot so a later `next` can reuse the cell (floor 0). */
  release(cell: CoverageCell): void {
    const key = cellKey(cell.family, cell.failureMode);
    const planned = this.#planned.get(key) ?? 0;
    if (planned > 0) this.#planned.set(key, planned - 1);
  }

  /** Records an executed declaration for the cell. */
  record(cell: CoverageCell): void {
    const key = cellKey(cell.family, cell.failureMode);
    this.#achieved.set(key, (this.#achieved.get(key) ?? 0) + 1);
  }

  /** Records an executed turn whose family the server advertised to the lane. */
  recordAdvertised(cell: CoverageCell): void {
    const key = cellKey(cell.family, cell.failureMode);
    this.#advertised.set(key, (this.#advertised.get(key) ?? 0) + 1);
  }

  /** Records an executed turn whose lane pick names a row of the cell's family. */
  recordActed(cell: CoverageCell): void {
    const key = cellKey(cell.family, cell.failureMode);
    this.#acted.set(key, (this.#acted.get(key) ?? 0) + 1);
  }

  report(): CoverageReport {
    const planned = emptyCoverageMatrix();
    const achieved = emptyCoverageMatrix();
    const advertised = emptyCoverageMatrix();
    const acted = emptyCoverageMatrix();
    const remaining = emptyCoverageMatrix();
    const byFamily = {} as CoverageReport["byFamily"];
    const byFailureMode = {} as CoverageReport["byFailureMode"];
    let plannedTotal = 0;
    let achievedTotal = 0;
    let advertisedTotal = 0;
    let actedTotal = 0;
    let remainingTotal = 0;
    let satisfiedCells = 0;
    for (const family of MECHANIC_FAMILIES) {
      let targetTotal = 0;
      let familyPlanned = 0;
      let familyAchieved = 0;
      let familyAdvertised = 0;
      let familyActed = 0;
      for (const mode of FAILURE_MODES) {
        const target = this.targets[family][mode];
        const cellPlanned = this.#planned.get(cellKey(family, mode)) ?? 0;
        const cellAchieved = this.#achieved.get(cellKey(family, mode)) ?? 0;
        const cellAdvertised = this.#advertised.get(cellKey(family, mode)) ?? 0;
        const cellActed = this.#acted.get(cellKey(family, mode)) ?? 0;
        const cellRemaining = Math.max(0, target - cellPlanned);
        planned[family][mode] = cellPlanned;
        achieved[family][mode] = cellAchieved;
        advertised[family][mode] = cellAdvertised;
        acted[family][mode] = cellActed;
        remaining[family][mode] = cellRemaining;
        targetTotal += target;
        familyPlanned += cellPlanned;
        familyAchieved += cellAchieved;
        familyAdvertised += cellAdvertised;
        familyActed += cellActed;
        plannedTotal += cellPlanned;
        achievedTotal += cellAchieved;
        advertisedTotal += cellAdvertised;
        actedTotal += cellActed;
        remainingTotal += cellRemaining;
        if (cellPlanned >= target) satisfiedCells += 1;
      }
      byFamily[family] = { target: targetTotal, planned: familyPlanned, achieved: familyAchieved, advertised: familyAdvertised, acted: familyActed };
    }
    for (const mode of FAILURE_MODES) {
      let targetTotal = 0;
      let modePlanned = 0;
      let modeAchieved = 0;
      for (const family of MECHANIC_FAMILIES) {
        targetTotal += this.targets[family][mode];
        modePlanned += planned[family][mode];
        modeAchieved += achieved[family][mode];
      }
      byFailureMode[mode] = { target: targetTotal, planned: modePlanned, achieved: modeAchieved };
    }
    return {
      targets: this.targets,
      planned,
      achieved,
      advertised,
      acted,
      remaining,
      totals: {
        target: this.#totalTarget,
        planned: plannedTotal,
        achieved: achievedTotal,
        advertisedTotal,
        actedTotal,
        remaining: remainingTotal,
        satisfiedCells,
        totalCells: COVERAGE_CELL_COUNT,
      },
      exhausted: remainingTotal === 0,
      byFamily,
      byFailureMode,
    };
  }
}

// -------------------------------------------------------------------------------------------------
// Advertisement reader: what the server actually offered the lane for one executed turn
// -------------------------------------------------------------------------------------------------

export type TurnAdvertisementSnapshot = {
  /** Deduped selection tool kinds, in advertised order. */
  kinds: string[];
  /** Families derived from `kinds`, deduped, in advertised order. */
  families: MechanicFamily[];
  /** Deduped player-facing labels, in advertised order. */
  labels: string[];
  band: string | null;
  method: string | null;
  selectedKind: string | null;
};

/**
 * Pure parser for one `system_one_decisions_v1` adventure-selection row. The request JSON carries
 * `{ state: { candidates: [{ candidateId, kind, label }] } }`; the selection JSON carries
 * `{ method, selection: { candidateId } | null }`. Kind and label lists are deduped while keeping
 * advertised order, and the selected candidate id resolves to its advertised kind. Malformed JSON
 * (in the request, or in a present selection) yields null so callers can fail soft.
 */
export function parseAdventureDecisionRow(row: {
  requestJson: string;
  selectionJson: string | null;
  confidenceBand: string | null;
}): TurnAdvertisementSnapshot | null {
  let request: unknown;
  try {
    request = JSON.parse(row.requestJson);
  } catch {
    return null;
  }
  if (!isPlainObject(request)) return null;
  const state = request["state"];
  if (!isPlainObject(state)) return null;
  const rawCandidates = state["candidates"];
  if (!Array.isArray(rawCandidates)) return null;

  const candidates: { candidateId: string | null; kind: string }[] = [];
  const kinds: string[] = [];
  const families: MechanicFamily[] = [];
  const labels: string[] = [];
  for (const raw of rawCandidates) {
    if (!isPlainObject(raw)) continue;
    const kind = raw["kind"];
    if (typeof kind !== "string" || kind.length === 0) continue;
    const candidateId = typeof raw["candidateId"] === "string" && raw["candidateId"].length > 0 ? raw["candidateId"] : null;
    const label = typeof raw["label"] === "string" && raw["label"].length > 0 ? raw["label"] : null;
    candidates.push({ candidateId, kind });
    if (!kinds.includes(kind)) kinds.push(kind);
    const family = KIND_TO_FAMILY[kind];
    if (family !== undefined && !families.includes(family)) families.push(family);
    if (label !== null && !labels.includes(label)) labels.push(label);
  }

  let method: string | null = null;
  let selectedKind: string | null = null;
  if (row.selectionJson !== null) {
    let selection: unknown;
    try {
      selection = JSON.parse(row.selectionJson);
    } catch {
      return null;
    }
    if (isPlainObject(selection)) {
      const rawMethod = selection["method"];
      if (typeof rawMethod === "string" && rawMethod.length > 0) method = rawMethod;
      const pick = selection["selection"];
      if (isPlainObject(pick)) {
        const candidateId = pick["candidateId"];
        if (typeof candidateId === "string") {
          const match = candidates.find(candidate => candidate.candidateId === candidateId);
          if (match !== undefined) selectedKind = match.kind;
        }
      }
    }
  }

  return { kinds, families, labels, band: row.confidenceBand, method, selectedKind };
}

/**
 * Read-only advertisement lookup for one executed turn: opens `<dataDir>/velvet.sqlite` with
 * `node:sqlite` in read-only mode, takes the newest adventure-selection row for the turn, and
 * delegates to `parseAdventureDecisionRow`. Every failure (missing file, missing table, no row,
 * unreadable data) returns null and never throws into a run.
 */
export function readTurnAdvertisements(dataDir: string, turnId: string): TurnAdvertisementSnapshot | null {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path.join(dataDir, "velvet.sqlite"), { readOnly: true });
    const row = database
      .prepare("SELECT request_json, selection_json, confidence_band FROM system_one_decisions_v1 WHERE lane = 'adventure-selection' AND turn_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(turnId);
    if (row === undefined) return null;
    return parseAdventureDecisionRow({
      requestJson: typeof row["request_json"] === "string" ? row["request_json"] : "",
      selectionJson: typeof row["selection_json"] === "string" ? row["selection_json"] : null,
      confidenceBand: typeof row["confidence_band"] === "string" ? row["confidence_band"] : null,
    });
  } catch {
    return null;
  } finally {
    if (database !== null) {
      try {
        database.close();
      } catch {
        // The connection is already unusable; the read-only lookup still fails soft.
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Run planning (targets, effort, required noise)
// -------------------------------------------------------------------------------------------------

export type PlannedTurn = {
  turnIndex: number;
  turnSeed: string;
  target: CoverageCell;
  toolKind: string;
  effort: Effort;
  allowedNoise: readonly SurfaceNoiseName[];
  /** Perturbations the generator must declare; the harness then applies exactly those. */
  requiredNoise: readonly SurfaceNoiseName[];
};

export type RunPlan = {
  runSeed: string;
  persona: PersonaDefinition;
  turns: PlannedTurn[];
  /** True when coverage targets ran out before the requested turn count. */
  truncated: boolean;
  scheduler: CoverageScheduler;
};

export type PlanRunInput = {
  runSeed: string;
  persona: PersonaDefinition;
  turns: number;
  targets?: CoverageTargets;
  scheduler?: CoverageScheduler;
  /** Multiplier for `direct` cells (default 1, minimum 0.1). */
  directWeight?: number;
};

const LOW_EFFORT_BY_VERBOSITY: Readonly<Record<Verbosity, number>> = {
  terse: 0.75,
  plain: 0.45,
  precise: 0.3,
  florid: 0.2,
};

/** Seeded effort for a turn, biased by persona verbosity. */
export function effortFor(persona: PersonaDefinition, turnSeed: string): Effort {
  return createRng(`${turnSeed}:effort`).chance(LOW_EFFORT_BY_VERBOSITY[persona.verbosity]) ? "low" : "high";
}

/** Relative noise preference per persona; rates raise typo/abbreviation/OOC weights. */
export function surfaceNoiseWeights(persona: PersonaDefinition): Readonly<Record<SurfaceNoiseName, number>> {
  return {
    lowercase: 0.2,
    "uppercase-first": 0.12,
    abbreviation: 0.08 + persona.abbreviationRate,
    typo: 0.08 + persona.typoRate,
    "trailing-question-ooc": 0.08 + persona.oocRate * 0.5,
    "self-correction": 0.1 + (persona.verbosity === "terse" ? 0.15 : persona.verbosity === "florid" ? 0.05 : 0.1),
  };
}

/**
 * Deterministic noise scheduling for one turn. High-noise personas require one or two
 * perturbations on a larger share of turns; the generator must declare exactly those names.
 */
export function requiredNoiseFor(persona: PersonaDefinition, turnSeed: string): SurfaceNoiseName[] {
  const rng = createRng(`${turnSeed}:required-noise`);
  const trigger = Math.min(0.85, 0.15 + persona.typoRate * 2 + persona.abbreviationRate * 2 + persona.oocRate);
  if (!rng.chance(trigger)) return [];
  const weights = surfaceNoiseWeights(persona);
  const count = rng.chance(0.25) ? 2 : 1;
  const chosen: SurfaceNoiseName[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidates = SURFACE_NOISES.filter(name => !chosen.includes(name));
    let total = 0;
    for (const name of candidates) total += weights[name];
    let roll = rng.next() * total;
    let picked = candidates[candidates.length - 1] as SurfaceNoiseName;
    for (const name of candidates) {
      roll -= weights[name];
      if (roll < 0) {
        picked = name;
        break;
      }
    }
    chosen.push(picked);
  }
  return chosen;
}

/** Plans one session: weighted targets, turn seeds, effort, and required noise. */
export function planRun(input: PlanRunInput): RunPlan {
  if (!Number.isInteger(input.turns) || input.turns < 0) throw new Error("turns must be a non-negative integer");
  const scheduler = input.scheduler ?? new CoverageScheduler({
    ...(input.targets ? { targets: input.targets } : {}),
    persona: input.persona,
    ...(input.directWeight !== undefined ? { directWeight: input.directWeight } : {}),
  });
  const rng = createRng(`${input.runSeed}:schedule`);
  const turns: PlannedTurn[] = [];
  for (let turnIndex = 0; turnIndex < input.turns; turnIndex += 1) {
    const cell = scheduler.next(rng);
    if (cell === null) break;
    const turnSeed = formatTurnSeed(input.runSeed, turnIndex);
    turns.push({
      turnIndex,
      turnSeed,
      target: cell,
      toolKind: FAMILY_TOOL_KINDS[cell.family],
      effort: effortFor(input.persona, turnSeed),
      allowedNoise: SURFACE_NOISES,
      requiredNoise: requiredNoiseFor(input.persona, turnSeed),
    });
  }
  return { runSeed: input.runSeed, persona: input.persona, turns, truncated: turns.length < input.turns, scheduler };
}

// -------------------------------------------------------------------------------------------------
// Generator seam: prompt, live OpenAI-compatible generator, deterministic fake
// -------------------------------------------------------------------------------------------------

export type TranscriptTurn = {
  turnId: string;
  actorId: string;
  declaration: string;
  narration: string | null;
  completedAt: string;
};

export type GeneratorPromptInput = {
  persona: PersonaDefinition;
  runId: string;
  /** The synthetic session tag shown to the generator (the contract echo). */
  sessionId: string;
  turnIndex: number;
  seed: string;
  target: CoverageCell;
  effort: Effort;
  transcript: readonly TranscriptTurn[];
  sheetSummary: string;
  allowedNoise: readonly SurfaceNoiseName[];
  requiredNoise: readonly SurfaceNoiseName[];
  referenceBudget: number;
  /** Player-facing labels the server advertised on the previous turn; ids/digests never appear. */
  advertisedOptions?: readonly string[];
};

export type GenerationRequest = GeneratorPromptInput & {
  messages: { system: string; user: string };
};

/** Injectable generator seam; returns raw contract candidate JSON (validated by the harness). */
export type GeneratorFn = (request: GenerationRequest) => Promise<unknown> | unknown;

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Builds the persona layer + turn layer prompt described in the design doc. Pure and stable. */
export function buildGeneratorMessages(input: GeneratorPromptInput): { system: string; user: string } {
  const persona = input.persona;
  const system = [
    "You are role-playing one player in a solo/duo text RPG. You are not the narrator, the game master, or an assistant.",
    `Persona: ${persona.title} (${persona.personaId}) — goals: ${persona.goals.join(", ")}.`,
    `Mechanics interests: ${persona.mechanicsBias.join(", ")}. Voice: ${persona.verbosity}. Patience: ${persona.patience}.`,
    "You know only what the transcript and your character sheet show. Never name hidden ids, revisions, digests, provider details, or game state, and never mention being a model.",
    "State intentions in plain player language; never explain rules, never propose dice results or mechanics, never resolve outcomes, and never write the narrator's answer.",
    `Keep the declaration to roughly ${WORD_BUDGET_BY_VERBOSITY[persona.verbosity]} words for this persona; stay in the lower half unless the failure mode or effort calls for a longer turn.`,
    "Output exactly one strict JSON turn contract and nothing else.",
  ].join("\n");
  const transcriptLines = input.transcript.length > 0
    ? input.transcript.map((turn, index) => {
      const narration = turn.narration ? ` => ${truncateText(turn.narration, 400)}` : "";
      return `${index + 1}. [${turn.turnId}] ${truncateText(turn.declaration, 400)}${narration}`;
    }).join("\n")
    : "(no completed turns yet)";
  // Advertised options are player-facing labels only. Off-menu cells must avoid invoking them;
  // every other cell must clearly invoke one. The lines never carry ids, digests, revisions,
  // provider details, or harness vocabulary.
  const advertisedOptions = input.advertisedOptions ?? [];
  const advertisedLine = advertisedOptions.length === 0
    ? null
    : isOffMenuFailureMode(input.target.failureMode)
      ? `The game currently offers these options: ${advertisedOptions.join(", ")}. This turn is deliberately off-menu: do not clearly invoke any of the listed options.`
      : `The game currently offers these options: ${advertisedOptions.join(", ")}. Write the declaration in natural player language so it clearly invokes one of them; do not quote this list or mention mechanics.`;
  const user = [
    "Transcript (completed declarations and latest narrations, oldest first):",
    transcriptLines,
    "",
    `Sheet summary (public labels only): ${input.sheetSummary}`,
    `Target this turn: family=${input.target.family} (tool ${FAMILY_TOOL_KINDS[input.target.family]}) failureMode=${input.target.failureMode}; effort=${input.effort}.`,
    ...(advertisedLine !== null ? [advertisedLine] : []),
    `Write the next declaration and an optional OOC aside.${input.referenceBudget > 0 ? ` Reference up to ${input.referenceBudget} transcript anchors when useful.` : ""}`,
    "Do not name hidden ids. Do not resolve outcomes.",
    `Allowed surface noise: ${input.allowedNoise.join(", ")}.`,
    input.requiredNoise.length > 0
      ? `Required noise declarations this turn (they must appear in "noise"): ${input.requiredNoise.join(", ")}.`
      : 'Required noise declarations this turn: none.',
    'Respond with one strict JSON object and no markdown fences: {"runId":string,"sessionId":string,"turnIndex":number,"personaId":string,"seed":string,"effort":"low"|"high","declaration":string,"ooc"?:string,"intended":{"family":string,"failureMode":string},"noise":string[],"references":string[]}.',
    `Echo these exact values: runId=${input.runId}, sessionId=${input.sessionId}, turnIndex=${input.turnIndex}, personaId=${persona.personaId}, seed=${input.seed}, effort=${input.effort}, intended.family=${input.target.family}, intended.failureMode=${input.target.failureMode}.`,
  ].join("\n");
  return { system, user };
}

export function buildGenerationRequest(base: GeneratorPromptInput): GenerationRequest {
  return { ...base, messages: buildGeneratorMessages(base) };
}

/** Last `limit` transcript entries, oldest first. */
export function transcriptSlice(turns: readonly TranscriptTurn[], limit = 6): TranscriptTurn[] {
  if (limit <= 0) return [];
  return turns.slice(Math.max(0, turns.length - limit));
}

export type GeneratorEnvConfig = {
  provider: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
};

/**
 * Reads the generator configuration the same way the other scripts do:
 * `PROXY_API_KEY` then `OPENROUTER_API_KEY`; `OPENROUTER_BASE_URL` and `OPENROUTER_MODEL`
 * fall back to the local agentrouter defaults. Returns null when no key is configured.
 */
export function readGeneratorEnvConfig(env: NodeJS.ProcessEnv = process.env): GeneratorEnvConfig | null {
  const apiKey = (env.PROXY_API_KEY ?? env.OPENROUTER_API_KEY ?? "").trim();
  if (apiKey.length === 0) return null;
  const baseUrl = (env.OPENROUTER_BASE_URL ?? "http://100.72.41.9:8787/v1").trim().replace(/\/+$/, "");
  const model = (env.OPENROUTER_MODEL ?? "deepseek-v4-flash").trim();
  if (baseUrl.length === 0 || model.length === 0) return null;
  return { provider: "openai-compatible", baseUrl, apiKey, model, temperature: 0.9, maxTokens: 2048, timeoutMs: 60_000 };
}

/**
 * OpenAI-compatible chat-completions generator. Parses the assistant content leniently (code
 * fences stripped) and fails closed with a clear error; it never retries a paid call.
 */
export function createLiveGenerator(config: GeneratorEnvConfig, fetchImpl: typeof fetch = fetch): GeneratorFn {
  const call = async (
    request: GenerationRequest,
    maxTokens: number,
  ): Promise<{ content: string | null; finishReason: string | null }> => {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: request.messages.system },
          { role: "user", content: request.messages.user },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`generator request failed with HTTP ${response.status}: ${text.slice(0, 400)}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`generator response was not JSON: ${text.slice(0, 400)}`);
    }
    const content = isPlainObject(body) && Array.isArray(body["choices"])
      ? choicesContent(body["choices"])
      : null;
    const finishReason = isPlainObject(body) && Array.isArray(body["choices"])
      ? choicesFinishReason(body["choices"])
      : null;
    return { content, finishReason };
  };
  return async (request) => {
    let attempt = await call(request, config.maxTokens);
    // A reasoning model can spend the whole budget on reasoning and return empty content with
    // finish_reason "length". Nothing usable was produced, so one bounded retry with a larger
    // budget is safe; HTTP failures are never retried.
    if (attempt.content === null) attempt = await call(request, Math.max(config.maxTokens * 2, 3_072));
    if (attempt.content === null) {
      throw new Error(
        `generator response did not include assistant content (finish_reason=${attempt.finishReason ?? "unknown"})`,
      );
    }
    try {
      return parseTurnContractJson(attempt.content);
    } catch (error) {
      // A response truncated by the token budget or one that violates the strict contract is
      // unusable; retry once with a larger budget. A complete response that fails for any other
      // reason is not retried.
      const retriable = attempt.finishReason === "length" || error instanceof TurnContractError;
      if (!retriable) throw error;
      const retried = await call(request, Math.max(config.maxTokens * 2, 3_072));
      if (retried.content === null) throw error;
      return parseTurnContractJson(retried.content);
    }
  };
}

function choicesContent(choices: readonly unknown[]): string | null {
  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;
    const message = choice["message"];
    if (!isPlainObject(message)) continue;
    const content = message["content"];
    if (typeof content === "string" && content.trim().length > 0) return content;
  }
  return null;
}

function choicesFinishReason(choices: readonly unknown[]): string | null {
  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;
    const finishReason = choice["finish_reason"];
    if (typeof finishReason === "string") return finishReason;
  }
  return null;
}

const FAKE_DECLARATION_TEMPLATES: Readonly<Record<FailureMode, (family: string) => string>> = {
  direct: family => `I move on the ${family} directly and keep it simple.`,
  ambiguous: family => `Maybe something with the ${family}, if you think that works.`,
  "multi-family": family => `I work the ${family} and also ask around about the mill.`,
  unsupported: family => `I try to force the ${family} to go my way.`,
  unadvertised: family => `I look for a ${family} angle nobody mentioned.`,
  "small-talk-ooc": family => `I chat about the ${family} with whoever is nearby.`,
  "literal-edge": family => `I take the ${family} literally and see what happens.`,
};

/**
 * Deterministic provider-free generator for `--dry-run` and tests. It echoes the harness-owned
 * identity fields, writes a template declaration for the scheduled cell, and declares the
 * required noise (or a seeded optional perturbation when none is required).
 */
export function createFakeGenerator(): GeneratorFn {
  return (request) => {
    const familyLabel = request.target.family.replace(/-/g, " ");
    const optionalNoise = request.requiredNoise.length > 0 ? [] : optionalNoiseFor(request);
    const noise = [...request.requiredNoise, ...optionalNoise];
    const lastTurn = request.transcript[request.transcript.length - 1];
    return {
      runId: request.runId,
      sessionId: request.sessionId,
      turnIndex: request.turnIndex,
      personaId: request.persona.personaId,
      seed: request.seed,
      effort: request.effort,
      declaration: FAKE_DECLARATION_TEMPLATES[request.target.failureMode](familyLabel),
      ...(request.target.failureMode === "small-talk-ooc" ? { ooc: "Can I still make it back before dark?" } : {}),
      intended: { family: request.target.family, failureMode: request.target.failureMode },
      noise: noise.filter(isSurfaceNoiseName),
      references: lastTurn ? [lastTurn.turnId] : [],
    };
  };
}

function optionalNoiseFor(request: GenerationRequest): SurfaceNoiseName[] {
  const rng = createRng(`${request.seed}:fake-noise`);
  if (!rng.chance(0.4)) return [];
  return [rng.pick(request.allowedNoise)];
}

// -------------------------------------------------------------------------------------------------
// Manifest types and canonical serialization
// -------------------------------------------------------------------------------------------------

export type GeneratorIdentity = {
  provider: "openai-compatible" | "fake";
  model: string;
  baseUrlDigest: string | null;
  temperature: number | null;
};

export type SyntheticSessionRecord = {
  /** `synthetic-player.<persona>.<seed>.<index>` — the downstream harvest provenance marker. */
  sessionTag: string;
  /** The real API session id (UUID in practice); null when unbound in a dry run. */
  sessionId: string | null;
  personaId: string;
  personaVersion: string;
  runSeed: string;
  turns: number;
  promptDigest: string;
  contractDigest: string;
};

export type HarnessRunState = "planned" | "complete" | "uncertain" | "failed";
export type TurnRecordOutcome = "planned" | "done" | "aborted" | "error" | "uncertain";

export type HarnessTurnRecord = {
  turnIndex: number;
  turnSeed: string;
  personaId: string;
  target: CoverageCell;
  toolKind: string;
  effort: Effort;
  /** Pre-noise declaration returned by the generator. */
  declarationGenerated: string;
  /** Exact declaration bytes sent to the API (after surface noise). */
  declaration: string;
  ooc: string | null;
  noiseDeclared: SurfaceNoiseName[];
  /** Declared perturbation names the harness does not implement (recorded, never applied). */
  noiseDropped: string[];
  noiseApplied: SurfaceNoiseName[];
  references: string[];
  idempotencyKey: string;
  outcome: TurnRecordOutcome;
  turnId: string | null;
  turnState: string | null;
  confirmationDecisions: ConfirmationDecision[];
  receipts: { commandId: string; proposalId: string }[];
  narration: { status: string; text: string | null; source: string | null } | null;
  error: string | null;
  /** What the server actually advertised to the lane for this turn; null when unknown/unreadable. */
  advertisements: TurnAdvertisementSnapshot | null;
  /** The pre-swap planned cell, set only when re-targeting replaced this turn's target. */
  plannedTarget?: CoverageCell;
  /** Status/outcome trail for a turn that did not end `done`; omitted on successful turns. */
  events?: TurnEventCode[];
};

/** One re-targeting record: the planned cell released and the advertised-family cell reserved. */
export type HarnessTargetSwap = {
  turnIndex: number;
  from: CoverageCell;
  to: CoverageCell;
};

// -------------------------------------------------------------------------------------------------
// Human-likeness proxies: offline red flags from the design doc, never a humanness gate
// -------------------------------------------------------------------------------------------------

/** Trigram Jaccard at or above this value counts as a near-duplicate declaration. */
export const NEAR_DUPLICATE_JACCARD = 0.7;

/** Cap on `HumanLikenessReport.topRepeatedPhrases`. */
export const MAX_REPEATED_PHRASES = 5;

/** One repeated 4-gram motif: `count` is the number of distinct turns that contain it. */
export type RepeatedPhrase = {
  phrase: string;
  count: number;
};

/** Pre-registered stylometric checklist computed from the declarations a run actually sent. */
export type HumanLikenessReport = {
  turns: number;
  medianWords: number;
  p90Words: number;
  /** Share of declarations with <= 5 words. */
  lowEffortShare: number;
  /** Share of declarations with >= 30 words. */
  longShare: number;
  /** Coefficient of variation of declaration word counts. */
  burstiness: number;
  /** Unique unigrams over total unigrams across all declarations. */
  distinct1: number;
  /** Unique bigrams over total bigrams across all declarations. */
  distinct2: number;
  /** Share of declarations whose max trigram Jaccard against any earlier turn is >= 0.7. */
  nearDuplicateShare: number;
  /** Declarations exactly reused from an earlier turn (trimmed comparison). */
  verbatimReuses: number;
  /** Most common 4-gram motifs (stopword-only shingles dropped), ranked count desc then phrase asc. */
  topRepeatedPhrases: RepeatedPhrase[];
  /** Turns containing at least one motif that appears in two or more turns. */
  repeatedPhraseTurns: number;
  oocShare: number;
  questionShare: number;
  noiseShare: number;
  mixedIntentShare: number;
  offMenuShare: number;
};

/** Words per declaration: whitespace-separated tokens after trimming. */
export function declarationWordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Lowercase alphanumeric tokens; punctuation is a separator. */
function alphanumericTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * Set of 3-token shingles over lowercase alphanumeric tokens. Declarations with fewer than three
 * tokens (including empty text) yield an empty set.
 */
export function tokenTrigramSet(text: string): Set<string> {
  const tokens = alphanumericTokens(text);
  const shingles = new Set<string>();
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    shingles.add(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`);
  }
  return shingles;
}

/**
 * Small, deliberately incomplete stopword set for phrase extraction. A 4-gram made only of these
 * tokens carries no motif ("it is in the"), so it is not a reportable phrase. One content token is
 * enough to keep a shingle ("smoke on the water").
 */
export const PHRASE_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "did", "do", "does",
  "for", "from", "had", "has", "have", "he", "her", "him", "his", "i", "if", "in", "is",
  "it", "its", "me", "my", "no", "not", "of", "on", "or", "our", "she", "so", "that",
  "the", "their", "them", "then", "there", "they", "this", "to", "up", "us", "was", "we",
  "were", "what", "when", "with", "you", "your",
]);

/**
 * Set of 4-token phrases over lowercase alphanumeric tokens, dropping shingles made up entirely of
 * stopwords. Declarations with fewer than four tokens (including empty text) yield an empty set.
 * Motifs repeat across turns more visibly at this width than the trigram similarity metric allows.
 */
export function tokenQuadgramSet(text: string): Set<string> {
  const tokens = alphanumericTokens(text);
  const shingles = new Set<string>();
  for (let index = 0; index + 3 < tokens.length; index += 1) {
    const window = tokens.slice(index, index + 4);
    if (window.every(token => PHRASE_STOPWORDS.has(token))) continue;
    shingles.add(window.join(" "));
  }
  return shingles;
}

/** Jaccard similarity of two shingle sets; two empty sets share nothing and score 0. */
export function trigramJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const shingle of small) {
    if (large.has(shingle)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

/** Straightforward 3-decimal rounding so manifests stay byte-stable. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Linear-interpolation percentile (R-7) over ascending values. */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] as number;
  const fraction = position - lower;
  return (sorted[lower] as number) * (1 - fraction) + (sorted[upper] as number) * fraction;
}

/** Substrings that mark a declaration as carrying more than one intent. */
const MIXED_INTENT_MARKERS = [" and ", " then ", "; ", " but "] as const;

/**
 * Computes the design doc's measurable human-likeness proxies over the declarations a run actually
 * sent. Shares and ratios are rounded to 3 decimals; this is a review checklist, not a score.
 */
export function computeHumanLikeness(turns: readonly HarnessTurnRecord[]): HumanLikenessReport {
  const count = turns.length;
  const wordCounts = turns.map(turn => declarationWordCount(turn.declaration));
  const sortedCounts = [...wordCounts].sort((a, b) => a - b);
  const mean = count === 0 ? 0 : wordCounts.reduce((sum, value) => sum + value, 0) / count;
  let variance = 0;
  if (count > 0) {
    for (const value of wordCounts) variance += (value - mean) ** 2;
    variance /= count;
  }
  const burstiness = mean > 0 ? Math.sqrt(variance) / mean : 0;

  const unigrams: string[] = [];
  const bigrams: string[] = [];
  const trigrams: Set<string>[] = [];
  const quadgrams: Set<string>[] = [];
  const trimmedDeclarations: string[] = [];
  for (const turn of turns) {
    const tokens = alphanumericTokens(turn.declaration);
    unigrams.push(...tokens);
    for (let index = 0; index + 1 < tokens.length; index += 1) {
      bigrams.push(`${tokens[index]} ${tokens[index + 1]}`);
    }
    trigrams.push(tokenTrigramSet(turn.declaration));
    quadgrams.push(tokenQuadgramSet(turn.declaration));
    trimmedDeclarations.push(turn.declaration.trim());
  }
  const distinct1 = unigrams.length === 0 ? 0 : new Set(unigrams).size / unigrams.length;
  const distinct2 = bigrams.length === 0 ? 0 : new Set(bigrams).size / bigrams.length;

  let nearDuplicates = 0;
  let verbatimReuses = 0;
  let questions = 0;
  let ooc = 0;
  let noise = 0;
  let mixedIntent = 0;
  let offMenu = 0;
  const seenDeclarations = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const turn = turns[index] as HarnessTurnRecord;
    const lower = turn.declaration.toLowerCase();
    if (turn.declaration.includes("?")) questions += 1;
    if (turn.ooc !== null && turn.ooc.trim().length > 0) ooc += 1;
    if (turn.noiseApplied.length > 0) noise += 1;
    if (MIXED_INTENT_MARKERS.some(marker => lower.includes(marker))) mixedIntent += 1;
    if (isOffMenuFailureMode(turn.target.failureMode)) offMenu += 1;

    const trimmed = trimmedDeclarations[index] as string;
    if (seenDeclarations.has(trimmed)) verbatimReuses += 1;
    else seenDeclarations.add(trimmed);
    if (index > 0) {
      const shingles = trigrams[index] as Set<string>;
      let maxSimilarity = 0;
      for (let earlier = 0; earlier < index; earlier += 1) {
        const similarity = trigramJaccard(shingles, trigrams[earlier] as Set<string>);
        if (similarity > maxSimilarity) maxSimilarity = similarity;
        if (maxSimilarity >= NEAR_DUPLICATE_JACCARD) break;
      }
      if (maxSimilarity >= NEAR_DUPLICATE_JACCARD) nearDuplicates += 1;
    }
  }

  // Motif-level repetition: count the turns each 4-gram phrase appears in, keep those in two or
  // more turns, and rank. The per-turn sets already dedupe a phrase repeated inside one turn.
  const phraseTurns = new Map<string, number[]>();
  for (let index = 0; index < count; index += 1) {
    for (const phrase of quadgrams[index] as Set<string>) {
      const turnsWithPhrase = phraseTurns.get(phrase);
      if (turnsWithPhrase === undefined) phraseTurns.set(phrase, [index]);
      else turnsWithPhrase.push(index);
    }
  }
  const repeatedPhrases: RepeatedPhrase[] = [];
  for (const [phrase, turnsWithPhrase] of phraseTurns) {
    if (turnsWithPhrase.length >= 2) repeatedPhrases.push({ phrase, count: turnsWithPhrase.length });
  }
  repeatedPhrases.sort((a, b) => b.count - a.count || (a.phrase < b.phrase ? -1 : a.phrase > b.phrase ? 1 : 0));
  const topRepeatedPhrases = repeatedPhrases.slice(0, MAX_REPEATED_PHRASES);
  const repeatedPhraseTurnIndexes = new Set<number>();
  for (const entry of repeatedPhrases) {
    for (const index of phraseTurns.get(entry.phrase) as number[]) repeatedPhraseTurnIndexes.add(index);
  }

  const share = (numerator: number): number => count === 0 ? 0 : round3(numerator / count);
  return {
    turns: count,
    medianWords: round3(percentile(sortedCounts, 0.5)),
    p90Words: round3(percentile(sortedCounts, 0.9)),
    lowEffortShare: share(wordCounts.filter(value => value <= 5).length),
    longShare: share(wordCounts.filter(value => value >= 30).length),
    burstiness: round3(burstiness),
    distinct1: round3(distinct1),
    distinct2: round3(distinct2),
    nearDuplicateShare: share(nearDuplicates),
    verbatimReuses,
    topRepeatedPhrases,
    repeatedPhraseTurns: repeatedPhraseTurnIndexes.size,
    oocShare: share(ooc),
    questionShare: share(questions),
    noiseShare: share(noise),
    mixedIntentShare: share(mixedIntent),
    offMenuShare: share(offMenu),
  };
}

export type HarnessManifest = {
  harnessVersion: string;
  personaVersion: string;
  runId: string;
  /** User-provided seed. */
  seed: string;
  /** Per-run derived seed; turn seeds are `<runSeed>-0000` style. */
  runSeed: string;
  startedAt: string;
  gitCommit: string | null;
  mode: "dry-run" | "live";
  generator: GeneratorIdentity;
  gameProvider: { model: string };
  world: { campaignId: string | null; sessionId: string | null; actorId: string | null; dataDir: string | null; contentProfile: string | null };
  sessions: SyntheticSessionRecord[];
  turns: HarnessTurnRecord[];
  /** Re-targeting records, in turn order; empty when every planned cell stayed on plan. */
  targetSwaps: HarnessTargetSwap[];
  coverage: CoverageReport;
  /** Recent-menu window used for re-targeting (clamped 1..10). */
  menuWindow: number;
  /** Union of the families advertised across the recent-menu window, oldest advertisement first. */
  menuUnionFamilies: MechanicFamily[];
  /** Offline human-likeness proxies computed from the recorded declarations. */
  humanLikeness: HumanLikenessReport;
  state: HarnessRunState;
  notes: string[];
};

function sortValueForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValueForStableJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortValueForStableJson(record[key]);
    return sorted;
  }
  return value;
}

/** Canonical JSON with recursively sorted object keys; digests and files use this. */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortValueForStableJson(value), null, indent);
}

export function serializeManifest(manifest: HarnessManifest): string {
  return `${stableStringify(manifest)}\n`;
}

export function manifestDigest(manifest: HarnessManifest): string {
  return createHash("sha256").update(serializeManifest(manifest)).digest("hex");
}

// -------------------------------------------------------------------------------------------------
// Synthetic session tags and idempotency keys
// -------------------------------------------------------------------------------------------------

const TAG_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SYNTHETIC_TAG_PREFIX = "synthetic-player";

/** Bijective base-26 session index label: 0 -> a, 25 -> z, 26 -> aa. */
export function sessionIndexLabel(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("session index must be a non-negative integer");
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(97 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

/** `synthetic-player.<persona>.<seed>.<n>` from the design doc. */
export function sessionTagFor(archetype: PersonaArchetype, seed: string, sessionIndex: number): string {
  if (!TAG_SEGMENT_PATTERN.test(seed)) throw new Error("seed must be a tag-safe token (letters, digits, dash, underscore)");
  if (!TAG_SEGMENT_PATTERN.test(archetype)) throw new Error("persona archetype must be a tag-safe token");
  return `${SYNTHETIC_TAG_PREFIX}.${archetype}.${seed}.${sessionIndexLabel(sessionIndex)}`;
}

export function isSyntheticTag(tag: string): boolean {
  const parts = tag.split(".");
  return parts.length === 4
    && parts[0] === SYNTHETIC_TAG_PREFIX
    && parts.slice(1).every(part => TAG_SEGMENT_PATTERN.test(part));
}

export function assertSyntheticTag(tag: string): string {
  if (!isSyntheticTag(tag)) throw new Error(`synthetic tag must look like ${SYNTHETIC_TAG_PREFIX}.<persona>.<seed>.<n>: ${tag}`);
  return tag;
}

/** `synth.<runId>.<turnIndex>` per the design doc. */
export function deriveIdempotencyKey(runId: string, turnIndex: number, kind?: string): string {
  if (runId.trim().length === 0) throw new Error("runId is required for an idempotency key");
  if (!Number.isInteger(turnIndex) || turnIndex < 0) throw new Error("turnIndex must be a non-negative integer");
  const base = `synth.${runId}.${turnIndex}`;
  return kind ? `${base}.${kind}` : base;
}

export function deriveConfirmationIdempotencyKey(runId: string, turnIndex: number, round: number): string {
  if (!Number.isInteger(round) || round < 0) throw new Error("confirmation round must be a non-negative integer");
  return deriveIdempotencyKey(runId, turnIndex, `confirm.${round}`);
}

// -------------------------------------------------------------------------------------------------
// HTTP request builders (assertable without a network)
// -------------------------------------------------------------------------------------------------

export type HttpRequestSpec = {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type StreamInitialBody = {
  campaignId: string;
  sessionId: string;
  actorId: string;
  declaration: string;
  expectedRevision: number;
  idempotencyKey: string;
};

export type StreamResumeBody = { resumeToken: string };

export type ConfirmBody = {
  proposalIds: string[];
  decision: "approve" | "reject";
  expectedRevision: number;
  idempotencyKey: string;
};

export type ReconcileInitialQuery = {
  campaignId: string;
  sessionId: string;
  actorId: string;
  idempotencyKey: string;
};

export function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) throw new Error("base URL is required");
  return `${trimmed}/api/rpg/v1`;
}

export function requestInit(spec: HttpRequestSpec, timeoutMs = 120_000): RequestInit {
  return {
    method: spec.method,
    headers: spec.headers,
    ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  };
}

export function buildPlayBootstrapRequest(baseUrl: string, campaignId: string, sessionId: string): HttpRequestSpec {
  return {
    method: "GET",
    url: `${apiRoot(baseUrl)}/campaigns/${encodeURIComponent(campaignId)}/rooms/${encodeURIComponent(sessionId)}/play-bootstrap`,
    headers: { accept: "application/json" },
  };
}

export function buildStreamRequest(baseUrl: string, body: StreamInitialBody | StreamResumeBody): HttpRequestSpec {
  return {
    method: "POST",
    url: `${apiRoot(baseUrl)}/adventure-turns/stream`,
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body,
  };
}

export function buildTurnRequest(baseUrl: string, turnId: string): HttpRequestSpec {
  return { method: "GET", url: `${apiRoot(baseUrl)}/adventure-turns/${encodeURIComponent(turnId)}`, headers: { accept: "application/json" } };
}

export function buildConfirmRequest(baseUrl: string, turnId: string, body: ConfirmBody): HttpRequestSpec {
  return {
    method: "POST",
    url: `${apiRoot(baseUrl)}/adventure-turns/${encodeURIComponent(turnId)}/confirm`,
    headers: { "content-type": "application/json", accept: "application/json" },
    body,
  };
}

export function buildTranscriptRequest(baseUrl: string, campaignId: string, sessionId: string): HttpRequestSpec {
  const query = `campaignId=${encodeURIComponent(campaignId)}&sessionId=${encodeURIComponent(sessionId)}`;
  return { method: "GET", url: `${apiRoot(baseUrl)}/adventure-turns/transcript?${query}`, headers: { accept: "application/json" } };
}

export function buildReconcileInitialRequest(baseUrl: string, query: ReconcileInitialQuery): HttpRequestSpec {
  const params = [
    `campaignId=${encodeURIComponent(query.campaignId)}`,
    `sessionId=${encodeURIComponent(query.sessionId)}`,
    `actorId=${encodeURIComponent(query.actorId)}`,
    `idempotencyKey=${encodeURIComponent(query.idempotencyKey)}`,
  ].join("&");
  return { method: "GET", url: `${apiRoot(baseUrl)}/adventure-turns/reconcile-initial?${params}`, headers: { accept: "application/json" } };
}

// -------------------------------------------------------------------------------------------------
// SSE parsing
// -------------------------------------------------------------------------------------------------

export type SseEvent = {
  type: string;
  sequence: number;
  timestamp: string;
  payload: unknown;
};

export function parseSseBlock(block: string): SseEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .join("");
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || typeof parsed["type"] !== "string" || parsed["type"].length === 0) return null;
  return {
    type: parsed["type"],
    sequence: typeof parsed["sequence"] === "number" ? parsed["sequence"] : 0,
    timestamp: typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : "",
    payload: parsed["payload"],
  };
}

/** Parses a complete SSE body. Malformed frames are skipped, never fatal. */
export function parseSseText(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const event = parseSseBlock(block);
    if (event) events.push(event);
  }
  return events;
}

// -------------------------------------------------------------------------------------------------
// Session driver: real HTTP routes, confirmation + resume, no blind retries
// -------------------------------------------------------------------------------------------------

export class SessionTurnError extends Error {
  readonly uncertain: boolean;
  readonly turnId: string | null;
  constructor(message: string, options: { uncertain: boolean; turnId?: string | null }) {
    super(message);
    this.name = "SessionTurnError";
    this.uncertain = options.uncertain;
    this.turnId = options.turnId ?? null;
  }
}

export type ConfirmationPolicyInput = { proposalToolNames?: readonly string[] };

/** Seeded confirmation decision, faithful to the persona policy. */
export function decideConfirmation(persona: PersonaDefinition, seed: string, input: ConfirmationPolicyInput = {}): ConfirmationDecision {
  const policy = persona.confirmationPolicy;
  if (input.proposalToolNames && input.proposalToolNames.length > 0
    && policy.alwaysApproveProgression
    && input.proposalToolNames.every(tool => tool === FAMILY_TOOL_KINDS.progression)) {
    return "approve";
  }
  const total = policy.approve + policy.reject + policy.stall;
  if (!(total > 0)) throw new Error(`persona ${persona.personaId} has an empty confirmation policy`);
  const roll = createRng(`${seed}:confirmation`).next() * total;
  if (roll < policy.approve) return "approve";
  if (roll < policy.approve + policy.reject) return "reject";
  return "stall";
}

export type TerminalOutcome = "done" | "aborted" | "error" | "unknown";

export type NarrationStatus = { status: string; text: string | null; source: string | null };

/** One meaningful status/outcome/error code lifted from a stream event payload. */
export type TurnEventCode = {
  /** SSE event type, e.g. `agent_status` or `terminal`. */
  type: string;
  /** Normalized code, e.g. `status=decision-rejected` or `outcomeCode=budget-prompt-token-budget`. */
  code: string;
};

export type TurnOutcome = {
  turnId: string;
  terminalOutcome: TerminalOutcome;
  turnState: string | null;
  confirmationDecisions: ConfirmationDecision[];
  confirmationBatches: string[][];
  receipts: { commandId: string; proposalId: string }[];
  narration: NarrationStatus | null;
  transcript: TranscriptTurn[] | null;
  uncertain: boolean;
  /** Meaningful status/outcome/error codes observed on the stream, oldest first. */
  events: TurnEventCode[];
  /** Short failure reason when `terminalOutcome` is not `done`; null on success. */
  error: string | null;
};

export type SessionDriverOptions = {
  baseUrl: string;
  campaignId: string;
  sessionId: string;
  actorId: string;
  runId: string;
  persona: PersonaDefinition;
  sessionTag: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxConfirmationRounds?: number;
};

export type SubmitTurnRequest = {
  turnIndex: number;
  declaration: string;
  turnSeed: string;
  idempotencyKey?: string;
  expectedRevision?: number;
  confirmationDecision?: ConfirmationDecision;
};

export class SessionDriver {
  readonly #options: SessionDriverOptions;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxConfirmationRounds: number;

  constructor(options: SessionDriverOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#maxConfirmationRounds = options.maxConfirmationRounds ?? 5;
  }

  get sessionTag(): string {
    return this.#options.sessionTag;
  }

  async #json(spec: HttpRequestSpec): Promise<{ status: number; ok: boolean; body: unknown }> {
    let response: Response;
    try {
      response = await this.#fetch(spec.url, requestInit(spec, this.#timeoutMs));
    } catch (error) {
      throw new SessionTurnError(`${spec.method} ${spec.url} failed: ${errorMessage(error)}`, { uncertain: true });
    }
    const text = await safeResponseText(response);
    let body: unknown = null;
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, ok: response.ok, body };
  }

  async readBootstrap(): Promise<{ expectedRevision: number; sessionId: string | null; playableActors: { actorId: string; name: string }[] }> {
    const response = await this.#json(buildPlayBootstrapRequest(this.#options.baseUrl, this.#options.campaignId, this.#options.sessionId));
    if (!response.ok) throw new SessionTurnError(`play bootstrap failed with HTTP ${response.status}`, { uncertain: false });
    const body = response.body;
    const expectedRevision = isPlainObject(body) ? body["expectedRevision"] : undefined;
    if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision)) {
      throw new SessionTurnError("play bootstrap response is missing an integer expectedRevision", { uncertain: false });
    }
    const actors: { actorId: string; name: string }[] = [];
    if (isPlainObject(body) && Array.isArray(body["playableActors"])) {
      for (const actor of body["playableActors"]) {
        if (isPlainObject(actor) && typeof actor["actorId"] === "string") {
          actors.push({ actorId: actor["actorId"], name: typeof actor["name"] === "string" ? actor["name"] : "" });
        }
      }
    }
    return {
      expectedRevision,
      sessionId: isPlainObject(body) && typeof body["sessionId"] === "string" ? body["sessionId"] : null,
      playableActors: actors,
    };
  }

  async readTranscript(): Promise<TranscriptTurn[]> {
    const response = await this.#json(buildTranscriptRequest(this.#options.baseUrl, this.#options.campaignId, this.#options.sessionId));
    if (!response.ok) throw new SessionTurnError(`transcript read failed with HTTP ${response.status}`, { uncertain: false });
    const turns: TranscriptTurn[] = [];
    if (isPlainObject(response.body) && Array.isArray(response.body["turns"])) {
      for (const entry of response.body["turns"]) {
        if (!isPlainObject(entry)) continue;
        const turnId = entry["turnId"];
        const declaration = entry["declaration"];
        if (typeof turnId !== "string" || typeof declaration !== "string") continue;
        turns.push({
          turnId,
          actorId: typeof entry["actorId"] === "string" ? entry["actorId"] : "",
          declaration,
          narration: typeof entry["narration"] === "string" ? entry["narration"] : null,
          completedAt: typeof entry["completedAt"] === "string" ? entry["completedAt"] : "",
        });
      }
    }
    return turns;
  }

  /** Read-only idempotency locator; a null result is ambiguous and never authorizes a retry. */
  async reconcileInitial(idempotencyKey: string): Promise<unknown> {
    const response = await this.#json(buildReconcileInitialRequest(this.#options.baseUrl, {
      campaignId: this.#options.campaignId,
      sessionId: this.#options.sessionId,
      actorId: this.#options.actorId,
      idempotencyKey,
    }));
    if (!response.ok) throw new SessionTurnError(`reconcile-initial failed with HTTP ${response.status}`, { uncertain: true });
    return isPlainObject(response.body) ? response.body["result"] ?? null : null;
  }

  async #openStream(body: StreamInitialBody | StreamResumeBody): Promise<{ turnId: string | null; events: SseEvent[] }> {
    const spec = buildStreamRequest(this.#options.baseUrl, body);
    let response: Response;
    try {
      response = await this.#fetch(spec.url, requestInit(spec, this.#timeoutMs));
    } catch (error) {
      throw new SessionTurnError(`stream request failed: ${errorMessage(error)}`, { uncertain: true });
    }
    if (!response.ok) {
      const text = await safeResponseText(response);
      throw new SessionTurnError(
        `stream request rejected with HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
        { uncertain: response.status >= 500 || response.status === 429 },
      );
    }
    const turnId = response.headers.get("x-adventure-turn-id");
    let events: SseEvent[];
    try {
      events = await readSseEvents(response);
    } catch (error) {
      throw new SessionTurnError(`stream read failed: ${errorMessage(error)}`, { uncertain: true, turnId });
    }
    return { turnId: turnId && turnId.length > 0 ? turnId : null, events };
  }

  async #getTurnDetail(turnId: string): Promise<{
    state: string | null;
    revision: number | null;
    receipts: { commandId: string; proposalId: string }[];
    narration: NarrationStatus | null;
  }> {
    const response = await this.#json(buildTurnRequest(this.#options.baseUrl, turnId));
    if (!response.ok) throw new SessionTurnError(`turn read failed with HTTP ${response.status}`, { uncertain: true, turnId });
    const body = isPlainObject(response.body) ? response.body : {};
    const turn = isPlainObject(body["turn"]) ? body["turn"] : {};
    const receipts: { commandId: string; proposalId: string }[] = [];
    if (Array.isArray(body["receipts"])) {
      for (const receipt of body["receipts"]) {
        if (!isPlainObject(receipt)) continue;
        const commandId = receipt["commandId"];
        const proposalId = receipt["proposalId"];
        if (typeof commandId === "string" && typeof proposalId === "string") receipts.push({ commandId, proposalId });
      }
    }
    const narrationRaw = isPlainObject(body["narrationStatus"]) ? body["narrationStatus"] : null;
    const narration = narrationRaw === null ? null : {
      status: typeof narrationRaw["status"] === "string" ? narrationRaw["status"] : "none",
      text: typeof narrationRaw["text"] === "string" ? narrationRaw["text"] : null,
      source: typeof narrationRaw["source"] === "string" ? narrationRaw["source"] : null,
    };
    return {
      state: typeof turn["state"] === "string" ? turn["state"] : null,
      revision: typeof turn["revision"] === "number" && Number.isInteger(turn["revision"]) ? turn["revision"] : null,
      receipts,
      narration,
    };
  }

  /**
   * Sends one declaration and follows confirmation/resume to a terminal read.
   * Ambiguous failures throw `SessionTurnError` with `uncertain: true`; callers must stop.
   */
  async submitTurn(input: SubmitTurnRequest): Promise<TurnOutcome> {
    const expectedRevision = input.expectedRevision ?? (await this.readBootstrap()).expectedRevision;
    const body: StreamInitialBody = {
      campaignId: this.#options.campaignId,
      sessionId: this.#options.sessionId,
      actorId: this.#options.actorId,
      declaration: input.declaration,
      expectedRevision,
      idempotencyKey: input.idempotencyKey ?? deriveIdempotencyKey(this.#options.runId, input.turnIndex),
    };
    let stream = await this.#openStream(body);
    let turnId = stream.turnId;
    const events: SseEvent[] = [...stream.events];
    const handled = new Set<string>();
    const decisions: ConfirmationDecision[] = [];
    const batches: string[][] = [];
    let stalled = false;

    for (let round = 0; round < this.#maxConfirmationRounds; round += 1) {
      const batch = confirmationBatches(events).find(ids => !handled.has(ids.join(",")));
      if (!batch) break;
      handled.add(batch.join(","));
      batches.push(batch);
      const decision = input.confirmationDecision ?? decideConfirmation(this.#options.persona, `${input.turnSeed}:confirmation:${round}`, {
        proposalToolNames: proposalToolNames(events, batch),
      });
      decisions.push(decision);
      if (decision === "stall") {
        stalled = true;
        break;
      }
      if (turnId === null) throw new SessionTurnError("confirmation_required arrived without a durable turn id", { uncertain: true });
      const detail = await this.#getTurnDetail(turnId);
      if (detail.revision === null) throw new SessionTurnError("turn detail is missing revision", { uncertain: true, turnId });
      const confirmed = await this.#json(buildConfirmRequest(this.#options.baseUrl, turnId, {
        proposalIds: batch,
        decision,
        expectedRevision: detail.revision,
        idempotencyKey: deriveConfirmationIdempotencyKey(this.#options.runId, input.turnIndex, round),
      }));
      if (!confirmed.ok) {
        throw new SessionTurnError(`confirmation POST failed with HTTP ${confirmed.status}`, { uncertain: confirmed.status >= 500 || confirmed.status === 429, turnId });
      }
      const resumeToken = isPlainObject(confirmed.body) && typeof confirmed.body["resumeToken"] === "string" && confirmed.body["resumeToken"].length > 0
        ? confirmed.body["resumeToken"]
        : null;
      if (resumeToken === null) break;
      stream = await this.#openStream({ resumeToken });
      if (stream.turnId !== null) turnId = stream.turnId;
      events.push(...stream.events);
    }

    if (turnId === null) throw new SessionTurnError("adventure turn stream did not expose a durable turn id", { uncertain: true });
    const detail = await this.#getTurnDetail(turnId);
    const terminal = lastTerminalOutcome(events);
    let transcript: TranscriptTurn[] | null = null;
    try {
      transcript = await this.readTranscript();
    } catch {
      transcript = null;
    }
    const terminalOutcome: TerminalOutcome = terminal
      ?? (stalled ? "aborted" : detail.state === "completed" ? "done" : "unknown");
    const eventCodes = turnEventCodes(events);
    return {
      turnId,
      terminalOutcome,
      turnState: detail.state,
      confirmationDecisions: decisions,
      confirmationBatches: batches,
      receipts: detail.receipts,
      narration: detail.narration,
      transcript,
      uncertain: false,
      events: eventCodes,
      error: terminalOutcome === "done"
        ? null
        : describeTurnFailure({ terminalOutcome, terminalObserved: terminal !== null, codes: eventCodes }),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function readSseEvents(response: Response): Promise<SseEvent[]> {
  if (!response.body) throw new SessionTurnError("stream response has no body", { uncertain: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseSseBlock(block);
      if (event) events.push(event);
    }
  }
  const tail = parseSseBlock(buffer);
  if (tail) events.push(tail);
  return events;
}

function confirmationBatches(events: readonly SseEvent[]): string[][] {
  const batches: string[][] = [];
  for (const event of events) {
    if (event.type !== "confirmation_required" || !isPlainObject(event.payload)) continue;
    const proposalIds = event.payload["proposalIds"];
    if (Array.isArray(proposalIds) && proposalIds.length > 0 && proposalIds.every(id => typeof id === "string" && id.length > 0)) {
      batches.push(proposalIds as string[]);
    }
  }
  return batches;
}

function proposalToolNames(events: readonly SseEvent[], proposalIds: readonly string[]): string[] {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "tool_proposed" || !isPlainObject(event.payload)) continue;
    const proposal = event.payload["proposal"];
    if (!isPlainObject(proposal)) continue;
    const proposalId = proposal["proposalId"];
    const toolName = proposal["toolName"];
    if (typeof proposalId === "string" && typeof toolName === "string") names.set(proposalId, toolName);
  }
  return proposalIds.map(id => names.get(id)).filter((name): name is string => name !== undefined);
}

function lastTerminalOutcome(events: readonly SseEvent[]): TerminalOutcome | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== "terminal" || !isPlainObject(event.payload)) continue;
    const outcome = event.payload["outcome"];
    if (outcome === "done" || outcome === "aborted" || outcome === "error") return outcome;
  }
  return null;
}

/** Payload fields that carry a meaningful status/outcome/error code, in extraction order. */
const TURN_CODE_FIELDS: readonly (readonly [field: string, label: string])[] = [
  ["status", "status"],
  ["outcome", "outcome"],
  ["outcomeCode", "outcomeCode"],
  ["errorCode", "errorCode"],
  ["code", "code"],
  ["reason", "reason"],
  ["error", "error"],
];

/**
 * Collects the status/outcome/error codes carried by a decoded event trail, oldest first. A turn
 * that never reaches `done` can then explain itself: the server reports failures through
 * `agent_status` payloads (`status=decision-rejected`, `status=expired`) and may attach a code to
 * any event (`outcomeCode=budget-prompt-token-budget`, `errorCode=...`). The terminal event's own
 * `outcome` is skipped here because `describeTurnFailure` reports it separately as `terminal=...`.
 */
export function turnEventCodes(events: readonly SseEvent[]): TurnEventCode[] {
  const codes: TurnEventCode[] = [];
  for (const event of events) {
    if (!isPlainObject(event.payload)) continue;
    for (const [field, label] of TURN_CODE_FIELDS) {
      if (event.type === "terminal" && field === "outcome") continue;
      const value = event.payload[field];
      if (typeof value === "string" && value.trim().length > 0) {
        codes.push({ type: event.type, code: `${label}=${value.trim()}` });
      }
    }
  }
  return codes;
}

/**
 * Short, stable reason for a turn that did not end `done`. Names the last status/outcome/error
 * code the stream carried, or falls back to a descriptive string when it carried none. A stream
 * that closed without a terminal event is reported as `terminal=fallback`.
 */
export function describeTurnFailure(input: {
  terminalOutcome: TerminalOutcome;
  terminalObserved: boolean;
  codes: readonly TurnEventCode[];
}): string {
  const terminal = input.terminalObserved ? input.terminalOutcome : "fallback";
  const last = input.codes[input.codes.length - 1];
  return last
    ? `turn failed: ${last.code}; terminal=${terminal}`
    : `turn did not complete (terminal=${terminal})`;
}

// -------------------------------------------------------------------------------------------------
// Turn materialization: validate the contract, then apply declared noise from the turn seed
// -------------------------------------------------------------------------------------------------

export type TurnMaterializationContext = {
  runId: string;
  /** Real API session id; null in an unbound dry run. */
  sessionId: string | null;
  sessionTag: string;
  persona: PersonaDefinition;
  turnSeed: string;
  plan: PlannedTurn;
};

export type MaterializedTurn = {
  contract: TurnContract;
  /** Exact declaration bytes the harness will send. */
  declaration: string;
  ooc: string | null;
  applied: SurfaceNoiseName[];
};

export function materializeTurn(raw: unknown, context: TurnMaterializationContext): MaterializedTurn {
  const contract = validateTurnContract(raw, {
    runId: context.runId,
    sessionIds: context.sessionId === null ? [context.sessionTag] : [context.sessionTag, context.sessionId],
    turnIndex: context.plan.turnIndex,
    personaId: context.persona.personaId,
    seed: context.turnSeed,
    target: context.plan.target,
    effort: context.plan.effort,
    requiredNoise: context.plan.requiredNoise,
  });
  const noised = applySurfaceNoise({
    declaration: contract.declaration,
    ...(contract.ooc ? { ooc: contract.ooc } : {}),
    noise: contract.noise,
    seed: context.turnSeed,
  });
  return {
    contract,
    declaration: noised.declaration,
    ooc: noised.ooc ?? null,
    applied: noised.applied,
  };
}

// -------------------------------------------------------------------------------------------------
// Run orchestration
// -------------------------------------------------------------------------------------------------

export type SubmitTurnFn = (input: { turnIndex: number; declaration: string; turnSeed: string; idempotencyKey: string }) => Promise<TurnOutcome>;

/** Default number of recent advertisement snapshots unioned for re-targeting. */
export const DEFAULT_MENU_WINDOW = 3;
/** Smallest recent-menu window; `1` means latest snapshot only. */
export const MIN_MENU_WINDOW = 1;
/** Largest recent-menu window. */
export const MAX_MENU_WINDOW = 10;

/**
 * Clamps a requested recent-menu window to an integer in [1, 10]. Non-finite input (including
 * `undefined`) falls back to `DEFAULT_MENU_WINDOW`.
 */
export function normalizeMenuWindow(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MENU_WINDOW;
  return Math.min(MAX_MENU_WINDOW, Math.max(MIN_MENU_WINDOW, Math.trunc(value)));
}

export type HarnessSessionInput = {
  runId: string;
  runSeed: string;
  persona: PersonaDefinition;
  sessionIndex: number;
  sessionId: string | null;
  turns: number;
  mode: "dry-run" | "live";
  generateTurn: GeneratorFn;
  submitTurn: SubmitTurnFn | null;
  transcript: readonly TranscriptTurn[];
  sheetSummary: string;
  targets: CoverageTargets | null;
  startedAt: string;
  gitCommit: string | null;
  generatorIdentity: GeneratorIdentity;
  gameProviderModel: string;
  campaignId: string | null;
  actorId: string | null;
  dataDir: string | null;
  syntheticTag: string | null;
  notes: readonly string[];
  referenceBudget: number;
  transcriptWindow: number;
  /**
   * Rolling window of recent advertisement snapshots whose families are unioned for re-targeting.
   * Clamped integer 1..10; default 3. `1` reproduces latest-snapshot-only behavior.
   */
  menuWindow?: number;
  /** Multiplier for `direct` cells in the coverage plan (default 1, minimum 0.1). */
  directWeight?: number;
  /**
   * Optional focused-coverage cell. When set, the first plan turn is forced onto this exact
   * family/failure-mode cell: the originally planned cell is released, the focus cell is reserved
   * for the rest of the plan, and the forced change is recorded as a turn-0 target swap. Null or
   * absent keeps the weighted plan untouched.
   */
  focus?: CoverageCell | null;
  /**
   * Optional read-only advertisement reader. Defaults to `readTurnAdvertisements` when `dataDir`
   * is non-null, and to no reader (null snapshots) otherwise.
   */
  readAdvertisements?: (turnId: string) => TurnAdvertisementSnapshot | null;
  /** Content profile token the run exercised (trimmed; empty/whitespace becomes null). */
  contentProfile?: string | null;
};

function emptyTurnRecord(plan: PlannedTurn, persona: PersonaDefinition, idempotencyKey: string): HarnessTurnRecord {
  return {
    turnIndex: plan.turnIndex,
    turnSeed: plan.turnSeed,
    personaId: persona.personaId,
    target: plan.target,
    toolKind: plan.toolKind,
    effort: plan.effort,
    declarationGenerated: "",
    declaration: "",
    ooc: null,
    noiseDeclared: [],
    noiseDropped: [],
    noiseApplied: [],
    references: [],
    idempotencyKey,
    outcome: "error",
    turnId: null,
    turnState: null,
    confirmationDecisions: [],
    receipts: [],
    narration: null,
    error: null,
    advertisements: null,
  };
}

/**
 * Validates an optional focus cell. Missing/null stays null; an unknown family or failure mode
 * throws instead of silently degrading the forced turn. Exported for callers that build session
 * input programmatically.
 */
export function validateFocusCell(value: unknown): CoverageCell | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new Error("focus must be an object with family and failureMode");
  const family = value["family"];
  const failureMode = value["failureMode"];
  if (!isMechanicFamily(family)) throw new Error(`focus.family must be one of ${MECHANIC_FAMILIES.join(", ")}`);
  if (!isFailureMode(failureMode)) throw new Error(`focus.failureMode must be one of ${FAILURE_MODES.join(", ")}`);
  return { family, failureMode };
}

/**
 * Runs one synthetic session (one manifest per run). Generation always happens here so that
 * contract validation, noise application, and manifest recording stay in one place. In dry-run
 * mode no HTTP is issued and every turn stays `planned`.
 */
export async function runHarnessSession(input: HarnessSessionInput): Promise<HarnessManifest> {
  if (input.mode === "live" && input.submitTurn === null) throw new Error("live mode requires a submitTurn implementation");
  if (input.mode === "live" && input.sessionId === null) throw new Error("live mode requires a bound API session id");
  const focus = validateFocusCell(input.focus);
  const notes: string[] = [...input.notes];
  if (input.mode === "dry-run") notes.push("dry-run: no HTTP requests were issued; every turn remains planned");
  const sessionTag = input.syntheticTag === null
    ? sessionTagFor(input.persona.archetype, input.runSeed, input.sessionIndex)
    : assertSyntheticTag(input.syntheticTag);
  notes.push(`session tag ${sessionTag} maps to API session ${input.sessionId ?? "(unbound dry-run)"}; harvest CLIs can filter on the ${SYNTHETIC_TAG_PREFIX} prefix.`);

  const plan = planRun({
    runSeed: input.runSeed,
    persona: input.persona,
    turns: input.turns,
    ...(input.targets ? { targets: input.targets } : {}),
    ...(input.directWeight !== undefined ? { directWeight: input.directWeight } : {}),
  });
  if (plan.truncated) notes.push(`coverage targets exhausted after ${plan.turns.length} of ${input.turns} requested turns`);
  const menuWindow = normalizeMenuWindow(input.menuWindow);

  const turns: HarnessTurnRecord[] = [];
  let transcript: TranscriptTurn[] = [...input.transcript];
  let state: HarnessRunState = input.mode === "dry-run" ? "planned" : "complete";
  const promptHash = createHash("sha256");
  const contractHash = createHash("sha256");
  const contentProfile = input.contentProfile?.trim() || null;
  const dataDir = input.dataDir;
  const readAdvertisements = input.readAdvertisements
    ?? (dataDir !== null ? (turnId: string) => readTurnAdvertisements(dataDir, turnId) : null);
  const targetSwaps: HarnessTargetSwap[] = [];
  let previousAdvertisements: TurnAdvertisementSnapshot | null = null;
  let pendingPlannedTarget: CoverageCell | undefined;

  // Focused coverage: a caller-requested cell replaces whatever the weighted plan picked for the
  // first turn. The scheduled cells are already planned, so accounting is what keeps the plan
  // honest: the replaced cell is released, the focus cell is reserved (so a retarget cannot
  // double-book it and the forced turn counts against its target), and the force is recorded as a
  // turn-0 target swap. An already fully planned focus cell is still forced, with a manifest note.
  if (focus !== null) {
    const first = plan.turns[0];
    if (first === undefined) {
      notes.push(`focus ${focus.family}/${focus.failureMode} requested but the plan has no turns`);
    } else {
      const original: CoverageCell = { ...first.target };
      const alreadyFullyPlanned = plan.scheduler.remainingFor(focus) <= 0;
      plan.scheduler.release(original);
      plan.scheduler.reserve(focus);
      first.target = { ...focus };
      first.toolKind = FAMILY_TOOL_KINDS[focus.family];
      pendingPlannedTarget = original;
      targetSwaps.push({ turnIndex: first.turnIndex, from: original, to: { ...focus } });
      if (alreadyFullyPlanned) {
        notes.push(`focus ${focus.family}/${focus.failureMode}: coverage target was already fully planned; turn ${first.turnIndex} forced it anyway`);
      }
    }
  }
  const latestAdvertisements = (): TurnAdvertisementSnapshot | null => previousAdvertisements;
  /** Last `menuWindow` readable snapshots' families, oldest first; an unreadable snapshot clears it. */
  const menuHistory: MechanicFamily[][] = [];
  const menuUnion = (): MechanicFamily[] => {
    const seen = new Set<MechanicFamily>();
    const union: MechanicFamily[] = [];
    for (const families of menuHistory) {
      for (const family of families) {
        if (seen.has(family)) continue;
        seen.add(family);
        union.push(family);
      }
    }
    return union;
  };

  /**
   * Reads the finished turn's advertisement snapshot, records it on the turn, pushes its families
   * into the recent-menu window, and feeds the advertised/acted counters. A missing snapshot clears
   * the window: an unreadable menu fails soft instead of reaching back to stale families.
   */
  const processAdvertisements = (record: HarnessTurnRecord, executed: CoverageCell): void => {
    if (readAdvertisements === null) return;
    const snapshot = readAdvertisements(record.turnId ?? "");
    record.advertisements = snapshot;
    previousAdvertisements = snapshot;
    if (snapshot === null) {
      menuHistory.length = 0;
      return;
    }
    menuHistory.push([...snapshot.families]);
    if (menuHistory.length > menuWindow) menuHistory.splice(0, menuHistory.length - menuWindow);
    if (snapshot.families.includes(executed.family)) plan.scheduler.recordAdvertised(executed);
    const selectedFamily = snapshot.selectedKind === null ? null : KIND_TO_FAMILY[snapshot.selectedKind] ?? null;
    if (selectedFamily !== null && selectedFamily === executed.family) plan.scheduler.recordActed(executed);
  };

  /**
   * Advertisement-guided re-targeting: when the upcoming planned cell's family is not in the recent
   * menu union and a remaining cell in a union family exists, release the planned cell and reserve
   * the reachable one. The union (not just the latest snapshot) keeps declaration-driven families
   * reachable across turns whose declarations advertised fewer rows. The swap is keyed off a
   * run-scoped RNG derived from the run seed and the upcoming turn index, so a replay of the same
   * decisions is deterministic. With `menuWindow = 1` the union is the latest snapshot alone,
   * which is the original latest-snapshot-only behavior.
   */
  const retargetNextTurn = (nextIndex: number): void => {
    const union = menuUnion();
    if (union.length === 0) return;
    const upcoming = plan.turns[nextIndex];
    if (upcoming === undefined) return;
    if (union.includes(upcoming.target.family)) return;
    const reachable = union.some(family =>
      FAILURE_MODES.some(mode => plan.scheduler.remainingFor({ family, failureMode: mode }) > 0));
    if (!reachable) return;
    const original: CoverageCell = { ...upcoming.target };
    plan.scheduler.release(original);
    const swapRng = createRng(`${input.runSeed}:retarget:${upcoming.turnIndex}`);
    const replacement = plan.scheduler.next(swapRng, { advertisedFamilies: union });
    if (replacement === null) return;
    upcoming.target = replacement;
    upcoming.toolKind = FAMILY_TOOL_KINDS[replacement.family];
    pendingPlannedTarget = original;
    targetSwaps.push({ turnIndex: upcoming.turnIndex, from: original, to: { ...replacement } });
  };

  for (let planIndex = 0; planIndex < plan.turns.length; planIndex += 1) {
    const planned = plan.turns[planIndex] as PlannedTurn;
    const idempotencyKey = deriveIdempotencyKey(input.runId, planned.turnIndex);
    const record = emptyTurnRecord(planned, input.persona, idempotencyKey);
    if (pendingPlannedTarget !== undefined) {
      record.plannedTarget = pendingPlannedTarget;
      pendingPlannedTarget = undefined;
    }
    const latest = latestAdvertisements();
    const base: GeneratorPromptInput = {
      persona: input.persona,
      runId: input.runId,
      sessionId: sessionTag,
      turnIndex: planned.turnIndex,
      seed: planned.turnSeed,
      target: planned.target,
      effort: planned.effort,
      transcript: transcriptSlice(transcript, input.transcriptWindow),
      sheetSummary: input.sheetSummary,
      allowedNoise: planned.allowedNoise,
      requiredNoise: planned.requiredNoise,
      referenceBudget: input.referenceBudget,
      ...(latest !== null && latest.labels.length > 0
        ? { advertisedOptions: [...latest.labels] }
        : {}),
    };
    const request = buildGenerationRequest(base);
    promptHash.update(stableStringify(request.messages, 0));

    let raw: unknown;
    try {
      raw = await input.generateTurn(request);
    } catch (error) {
      record.error = `generator failed: ${errorMessage(error)}`;
      notes.push(`turn ${planned.turnIndex}: generator failed, run stopped`);
      turns.push(record);
      state = "failed";
      break;
    }

    let materialized: MaterializedTurn;
    try {
      materialized = materializeTurn(raw, {
        runId: input.runId,
        sessionId: input.sessionId,
        sessionTag,
        persona: input.persona,
        turnSeed: planned.turnSeed,
        plan: planned,
      });
    } catch (error) {
      record.error = `contract rejected: ${errorMessage(error)}`;
      notes.push(`turn ${planned.turnIndex}: contract rejected, run stopped`);
      turns.push(record);
      state = "failed";
      break;
    }
    record.declarationGenerated = materialized.contract.declaration;
    record.declaration = materialized.declaration;
    record.ooc = materialized.ooc;
    record.noiseDeclared = [...materialized.contract.noise];
    record.noiseDropped = [...materialized.contract.noiseDropped];
    record.noiseApplied = [...materialized.applied];
    record.references = [...materialized.contract.references];
    contractHash.update(stableStringify({
      declaration: materialized.declaration,
      ooc: materialized.ooc,
      noise: materialized.applied,
      intended: materialized.contract.intended,
      effort: materialized.contract.effort,
      references: materialized.contract.references,
    }, 0));

    if (input.mode === "dry-run") {
      record.outcome = "planned";
      turns.push(record);
      processAdvertisements(record, planned.target);
      retargetNextTurn(planIndex + 1);
      continue;
    }

    try {
      const outcome = await (input.submitTurn as SubmitTurnFn)({
        turnIndex: planned.turnIndex,
        declaration: materialized.declaration,
        turnSeed: planned.turnSeed,
        idempotencyKey,
      });
      record.outcome = outcome.uncertain
        ? "uncertain"
        : outcome.terminalOutcome === "done" || outcome.terminalOutcome === "aborted" || outcome.terminalOutcome === "error"
          ? outcome.terminalOutcome
          : "error";
      record.turnId = outcome.turnId;
      record.turnState = outcome.turnState;
      record.confirmationDecisions = [...outcome.confirmationDecisions];
      record.receipts = [...outcome.receipts];
      record.narration = outcome.narration;
      if (!outcome.uncertain && outcome.turnId.length > 0) plan.scheduler.record(planned.target);
      if (outcome.uncertain) {
        record.error = "ambiguous turn failure: no automatic retry; run marked uncertain";
        notes.push(`turn ${planned.turnIndex}: ambiguous failure; run marked uncertain and stopped without retry`);
        turns.push(record);
        processAdvertisements(record, planned.target);
        state = "uncertain";
        break;
      }
      if (outcome.terminalOutcome !== "done") {
        record.error = outcome.error ?? `turn did not complete (terminal=${outcome.terminalOutcome})`;
        if (outcome.events.length > 0) record.events = outcome.events.map(entry => ({ ...entry }));
      }
      if (outcome.transcript !== null) {
        transcript = [...outcome.transcript];
      } else {
        transcript = [...transcript, {
          turnId: outcome.turnId,
          actorId: input.actorId ?? "",
          declaration: materialized.declaration,
          narration: outcome.narration?.text ?? null,
          completedAt: "",
        }];
      }
      turns.push(record);
      processAdvertisements(record, planned.target);
      if (outcome.terminalOutcome === "error") {
        notes.push(`turn ${planned.turnIndex}: terminal error; run stopped`);
        state = "failed";
        break;
      }
      retargetNextTurn(planIndex + 1);
    } catch (error) {
      const uncertain = error instanceof SessionTurnError ? error.uncertain : true;
      record.error = errorMessage(error);
      record.outcome = uncertain ? "uncertain" : "error";
      record.turnId = error instanceof SessionTurnError ? error.turnId : null;
      turns.push(record);
      if (uncertain) {
        notes.push(`turn ${planned.turnIndex}: ambiguous failure; run marked uncertain and stopped without retry`);
        state = "uncertain";
      } else {
        notes.push(`turn ${planned.turnIndex}: definitive failure; run stopped`);
        state = "failed";
      }
      break;
    }
  }

  const executedTurns = turns.filter(turn => turn.outcome === "done" || turn.outcome === "aborted" || turn.outcome === "uncertain").length;
  return {
    harnessVersion: HARNESS_VERSION,
    personaVersion: PERSONA_VERSION,
    runId: input.runId,
    seed: input.runSeed,
    runSeed: input.runSeed,
    startedAt: input.startedAt,
    gitCommit: input.gitCommit,
    mode: input.mode,
    generator: input.generatorIdentity,
    gameProvider: { model: input.gameProviderModel },
    world: {
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      actorId: input.actorId,
      dataDir: input.dataDir,
      contentProfile,
    },
    sessions: [{
      sessionTag,
      sessionId: input.sessionId,
      personaId: input.persona.personaId,
      personaVersion: input.persona.personaVersion,
      runSeed: input.runSeed,
      turns: input.mode === "dry-run" ? turns.length : executedTurns,
      promptDigest: promptHash.digest("hex"),
      contractDigest: contractHash.digest("hex"),
    }],
    turns,
    targetSwaps,
    coverage: plan.scheduler.report(),
    menuWindow,
    menuUnionFamilies: menuUnion(),
    humanLikeness: computeHumanLikeness(turns),
    state,
    notes,
  };
}

// -------------------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------------------

export type HarnessCliOptions = {
  turns: number;
  personas: readonly PersonaArchetype[];
  seed: string;
  runs: number;
  campaignId: string | null;
  sessionIds: readonly string[];
  actorId: string | null;
  out: string | null;
  dryRun: boolean;
  syntheticTag: string | null;
  runId: string | null;
  sheetSummary: string | null;
  baseUrl: string;
  maxConfirmationRounds: number;
  dataDir: string | null;
  contentProfile: string | null;
  menuWindow: number;
  directWeight: number;
  /** Forced first-turn cell; null when no focus flags were given. */
  focus: CoverageCell | null;
  help: boolean;
};

export const DEFAULT_TURNS = 6;
export const DEFAULT_RUNS = 1;
export const DEFAULT_SEED = "synth";
export const MAX_TURNS = 200;
export const MAX_RUNS = 50;

export function harnessUsage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/synthetic-player-harness.ts [options]",
    "",
    "Options:",
    `  --turns <n>              Turns per run (default ${DEFAULT_TURNS}, max ${MAX_TURNS}).`,
    `  --personas <list>        Comma-separated archetypes (default all: ${PERSONA_ARCHETYPES.join(",")}).`,
    `  --runs <n>               Number of sessions/runs (default ${DEFAULT_RUNS}, max ${MAX_RUNS}); personas rotate.`,
    `  --seed <token>           Run seed (default "${DEFAULT_SEED}"); turn seeds derive as <seed>-0000.`,
    "  --campaign-id <id>       Campaign UUID (required in live mode).",
    "  --session-id <id[,id]>   API session UUID(s); required in live mode.",
    "  --actor-id <id>          Playable actor UUID (required in live mode).",
    "  --out <path>             Manifest file (.json) or directory for one file per run.",
    "  --synthetic-tag <tag>    Override the derived session tag (only with --runs 1).",
    "  --run-id <id>            Run id override (default synth-<seed>[-<index>]).",
    "  --sheet-summary <text>   Public sheet labels for the prompt (default a placeholder).",
    "  --api-base-url <url>     Velvet server URL; defaults to VELVET_API_URL or http://127.0.0.1:8787.",
    "  --max-confirmation-rounds <n>  Confirmation batches handled per turn (default 5).",
    "  --data-dir <path>        SQLite data directory for read-only advertisement reads (default VELVET_DATA_DIR).",
    "  --content-profile <token>  Content profile the run exercised, recorded in the manifest (default null).",
    `  --menu-window <n>        Recent advertisement snapshots unioned for re-targeting (default ${DEFAULT_MENU_WINDOW}, range ${MIN_MENU_WINDOW}..${MAX_MENU_WINDOW}).`,
    `  --direct-weight <n>      Multiplier for direct-failure cells in the plan (default ${DEFAULT_DIRECT_WEIGHT}, minimum ${MIN_DIRECT_WEIGHT}).`,
    "  --focus-family <family>  Force the first turn of every run onto this family's focus cell.",
    "  --focus-mode <mode>      Failure mode of the focus cell; both focus flags are required together.",
    "  --dry-run                Use the deterministic fake generator; never touch the network.",
    "  --help, -h               Print this text.",
    "",
    "Live mode requires PROXY_API_KEY/OPENROUTER_API_KEY plus a reachable server, a published",
    "campaign, and an active session. Without API configuration the CLI defaults to --dry-run.",
  ].join("\n");
}

function takeValue(argv: readonly string[], index: number, inline: string | null, flag: string): { value: string; nextIndex: number } {
  if (inline !== null) {
    if (inline.length === 0) throw new Error(`${flag} requires a value`);
    return { value: inline, nextIndex: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
  return { value: next, nextIndex: index + 1 };
}

function parseIntegerFlag(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseDirectWeightFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_DIRECT_WEIGHT) {
    throw new Error(`${flag} must be a number >= ${MIN_DIRECT_WEIGHT}`);
  }
  return parsed;
}

export function parseHarnessArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): HarnessCliOptions {
  let turns = DEFAULT_TURNS;
  let personas: PersonaArchetype[] = [...PERSONA_ARCHETYPES];
  let seed = (env.SYNTHETIC_PLAYER_SEED ?? DEFAULT_SEED).trim() || DEFAULT_SEED;
  let runs = DEFAULT_RUNS;
  let campaignId: string | null = null;
  let sessionIds: string[] = [];
  let actorId: string | null = null;
  let out: string | null = null;
  let dryRun = false;
  let syntheticTag: string | null = null;
  let runId: string | null = null;
  let sheetSummary: string | null = null;
  let baseUrl = env.VELVET_API_URL?.trim() || "http://127.0.0.1:8787";
  let maxConfirmationRounds = 5;
  let dataDir: string | null = env.VELVET_DATA_DIR?.trim() || null;
  let contentProfile: string | null = null;
  let menuWindow = DEFAULT_MENU_WINDOW;
  let directWeight = DEFAULT_DIRECT_WEIGHT;
  let focusFamily: MechanicFamily | null = null;
  let focusMode: FailureMode | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] as string;
    const equals = raw.indexOf("=");
    const flag = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : null;
    switch (flag) {
      case "--turns": {
        const taken = takeValue(argv, index, inline, flag);
        turns = parseIntegerFlag(taken.value, flag, 1, MAX_TURNS);
        index = taken.nextIndex;
        break;
      }
      case "--personas": {
        const taken = takeValue(argv, index, inline, flag);
        const parsed = taken.value.split(",").map(entry => entry.trim()).filter(entry => entry.length > 0);
        if (parsed.length === 0) throw new Error("--personas requires at least one archetype");
        personas = parsed.map(entry => {
          const archetype = entry.endsWith(".v1") ? entry.slice(0, -3) : entry;
          if (!isPersonaArchetype(archetype)) throw new Error(`unknown persona: ${entry}`);
          return archetype;
        });
        index = taken.nextIndex;
        break;
      }
      case "--runs": {
        const taken = takeValue(argv, index, inline, flag);
        runs = parseIntegerFlag(taken.value, flag, 1, MAX_RUNS);
        index = taken.nextIndex;
        break;
      }
      case "--seed": {
        const taken = takeValue(argv, index, inline, flag);
        if (!/^[A-Za-z0-9_-]+$/.test(taken.value)) throw new Error("--seed must be a tag-safe token (letters, digits, dash, underscore)");
        seed = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--campaign-id": {
        const taken = takeValue(argv, index, inline, flag);
        campaignId = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--session-id": {
        const taken = takeValue(argv, index, inline, flag);
        sessionIds = taken.value.split(",").map(entry => entry.trim()).filter(entry => entry.length > 0);
        if (sessionIds.length === 0) throw new Error("--session-id requires at least one id");
        index = taken.nextIndex;
        break;
      }
      case "--actor-id": {
        const taken = takeValue(argv, index, inline, flag);
        actorId = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--out": {
        const taken = takeValue(argv, index, inline, flag);
        out = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--synthetic-tag": {
        const taken = takeValue(argv, index, inline, flag);
        syntheticTag = assertSyntheticTag(taken.value);
        index = taken.nextIndex;
        break;
      }
      case "--run-id": {
        const taken = takeValue(argv, index, inline, flag);
        runId = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--sheet-summary": {
        const taken = takeValue(argv, index, inline, flag);
        sheetSummary = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--api-base-url": {
        const taken = takeValue(argv, index, inline, flag);
        baseUrl = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--max-confirmation-rounds": {
        const taken = takeValue(argv, index, inline, flag);
        maxConfirmationRounds = parseIntegerFlag(taken.value, flag, 1, 10);
        index = taken.nextIndex;
        break;
      }
      case "--data-dir": {
        const taken = takeValue(argv, index, inline, flag);
        dataDir = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--content-profile": {
        const taken = takeValue(argv, index, inline, flag);
        contentProfile = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--menu-window": {
        const taken = takeValue(argv, index, inline, flag);
        menuWindow = parseIntegerFlag(taken.value, flag, MIN_MENU_WINDOW, MAX_MENU_WINDOW);
        index = taken.nextIndex;
        break;
      }
      case "--direct-weight": {
        const taken = takeValue(argv, index, inline, flag);
        directWeight = parseDirectWeightFlag(taken.value, flag);
        index = taken.nextIndex;
        break;
      }
      case "--focus-family": {
        const taken = takeValue(argv, index, inline, flag);
        if (!isMechanicFamily(taken.value)) throw new Error(`--focus-family must be one of ${MECHANIC_FAMILIES.join(", ")}`);
        focusFamily = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--focus-mode": {
        const taken = takeValue(argv, index, inline, flag);
        if (!isFailureMode(taken.value)) throw new Error(`--focus-mode must be one of ${FAILURE_MODES.join(", ")}`);
        focusMode = taken.value;
        index = taken.nextIndex;
        break;
      }
      case "--dry-run": {
        if (inline !== null) throw new Error("--dry-run does not take a value");
        dryRun = true;
        break;
      }
      case "--help":
      case "-h": {
        help = true;
        break;
      }
      default:
        throw new Error(`unknown argument: ${raw}`);
    }
  }

  if (syntheticTag !== null && runs !== 1) throw new Error("--synthetic-tag requires --runs 1");
  if ((focusFamily === null) !== (focusMode === null)) {
    throw new Error("--focus-family and --focus-mode must be used together");
  }
  const focus: CoverageCell | null = focusFamily !== null && focusMode !== null
    ? { family: focusFamily, failureMode: focusMode }
    : null;
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error("--api-base-url must be a valid URL");
  }
  if (!(["http:", "https:"] as string[]).includes(parsedBase.protocol)) throw new Error("--api-base-url must be an HTTP(S) URL");
  baseUrl = parsedBase.toString().replace(/\/+$/, "");
  return { turns, personas, seed, runs, campaignId, sessionIds, actorId, out, dryRun, syntheticTag, runId, sheetSummary, baseUrl, maxConfirmationRounds, dataDir, contentProfile, menuWindow, directWeight, focus, help };
}

export type HarnessCliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  fetchImpl: typeof fetch;
};

const defaultIo: HarnessCliIo = {
  out: text => process.stdout.write(`${text}\n`),
  err: text => process.stderr.write(`${text}\n`),
  fetchImpl: fetch,
};

function readGitCommit(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Prints a compact, deterministic run summary (never contains credentials or resume tokens). */
export function renderManifestSummary(manifest: HarnessManifest): string[] {
  const lines: string[] = [];
  lines.push(`synthetic-player-harness ${manifest.harnessVersion} — ${manifest.mode} — run ${manifest.runId} — state ${manifest.state}`);
  lines.push(`seed=${manifest.seed} runSeed=${manifest.runSeed} generator=${manifest.generator.provider}:${manifest.generator.model}`);
  for (const session of manifest.sessions) {
    lines.push(`  sessionTag ${session.sessionTag} -> sessionId ${session.sessionId ?? "(unbound; pass --session-id before live play)"}`);
  }
  for (const turn of manifest.turns) {
    lines.push(`  turn ${turn.turnIndex} target=${turn.target.family}/${turn.target.failureMode} effort=${turn.effort} seed=${turn.turnSeed} noise=[${turn.noiseApplied.join(",")}] outcome=${turn.outcome}${turn.turnId ? ` turnId=${turn.turnId}` : ""}`);
    lines.push(`    declaration: ${JSON.stringify(turn.declaration)}`);
  }
  const totals = manifest.coverage.totals;
  lines.push(`coverage: planned ${totals.planned}/${totals.target}, achieved ${totals.achieved}/${totals.target}, remaining ${totals.remaining}, satisfied cells ${totals.satisfiedCells}/${totals.totalCells}`);
  const turnCount = manifest.turns.length;
  const share = (count: number): string => turnCount === 0 ? "n/a" : `${Math.round((count / turnCount) * 100)}%`;
  lines.push(`advertised: ${totals.advertisedTotal}/${turnCount} (${share(totals.advertisedTotal)})`);
  lines.push(`acted: ${totals.actedTotal}/${turnCount} (${share(totals.actedTotal)})`);
  if (manifest.menuWindow > 1) {
    const union = manifest.menuUnionFamilies.length > 0 ? manifest.menuUnionFamilies.join(", ") : "(none)";
    lines.push(`menu window: last ${manifest.menuWindow} advertised snapshots; union families: ${union}`);
  }
  const human = manifest.humanLikeness;
  const humanPct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  lines.push(`human-likeness: ${human.turns} turns, median ${human.medianWords} words, p90 ${human.p90Words}, low-effort ${humanPct(human.lowEffortShare)}, long ${humanPct(human.longShare)}, burstiness ${human.burstiness}, distinct-1 ${human.distinct1}, distinct-2 ${human.distinct2}`);
  lines.push(`  near-duplicate share ${human.nearDuplicateShare} (max trigram Jaccard >= ${NEAR_DUPLICATE_JACCARD}), verbatim reuses ${human.verbatimReuses}, OOC ${humanPct(human.oocShare)}, questions ${humanPct(human.questionShare)}, noise ${humanPct(human.noiseShare)}, mixed intent ${humanPct(human.mixedIntentShare)}, off-menu ${humanPct(human.offMenuShare)}`);
  if (human.topRepeatedPhrases.length > 0) {
    const motifs = human.topRepeatedPhrases.map(entry => `"${entry.phrase}" x${entry.count}`).join(", ");
    lines.push(`  repeated motifs: ${motifs}`);
  }
  return lines;
}

function manifestOutputPath(out: string, runId: string, runs: number): string {
  if (out.endsWith(".json")) {
    if (runs > 1) throw new Error("--out must be a directory when --runs > 1");
    return path.resolve(out);
  }
  return path.resolve(out, `${runId}.json`);
}

export async function runHarnessCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: HarnessCliIo = defaultIo,
): Promise<number> {
  const options = parseHarnessArgs(argv, env);
  if (options.help) {
    io.out(harnessUsage());
    return 0;
  }
  const generatorConfig = readGeneratorEnvConfig(env);
  const dryRun = options.dryRun || generatorConfig === null;
  if (!options.dryRun && generatorConfig === null) {
    io.out("note: no PROXY_API_KEY or OPENROUTER_API_KEY present; defaulting to --dry-run");
  } else if (options.dryRun) {
    io.out("dry-run requested: using the deterministic fake generator; no network calls");
  }
  if (!dryRun) {
    const missing = [
      options.campaignId === null ? "--campaign-id" : null,
      options.sessionIds.length === 0 ? "--session-id" : null,
      options.actorId === null ? "--actor-id" : null,
    ].filter((value): value is string => value !== null);
    if (missing.length > 0) throw new Error(`live mode requires ${missing.join(", ")} (or pass --dry-run)`);
  }

  const personas = options.personas.map(archetype => PERSONAS[archetype]);
  const generatorIdentity: GeneratorIdentity = dryRun
    ? { provider: "fake", model: "deterministic-fake-generator", baseUrlDigest: null, temperature: null }
    : {
      provider: "openai-compatible",
      model: (generatorConfig as GeneratorEnvConfig).model,
      baseUrlDigest: createHash("sha256").update((generatorConfig as GeneratorEnvConfig).baseUrl).digest("hex").slice(0, 16),
      temperature: (generatorConfig as GeneratorEnvConfig).temperature,
    };
  const generateTurn = dryRun ? createFakeGenerator() : createLiveGenerator(generatorConfig as GeneratorEnvConfig, io.fetchImpl);
  const dataDir = options.dataDir;
  const startedAt = new Date().toISOString();
  const gitCommit = readGitCommit(process.cwd());

  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    const label = sessionIndexLabel(runIndex);
    const persona = personas[runIndex % personas.length] as PersonaDefinition;
    const runSeed = options.runs === 1 ? options.seed : `${options.seed}-${label}`;
    const runId = options.runId !== null
      ? (options.runs === 1 ? options.runId : `${options.runId}-${label}`)
      : `synth-${options.seed}${options.runs === 1 ? "" : `-${label}`}`;
    const sessionId = options.sessionIds.length > 0
      ? options.sessionIds[runIndex % options.sessionIds.length] as string
      : null;
    // The tag keeps the user seed and the session index; the per-run seed adds the index label.
    const sessionTag = options.syntheticTag ?? sessionTagFor(persona.archetype, options.seed, runIndex);
    const notes: string[] = dryRun
      ? []
      : [`live run against ${options.baseUrl}; ambiguous failures stop the run as uncertain with no retry`];
    const submitTurn: SubmitTurnFn | null = dryRun
      ? null
      : (() => {
        const driver = new SessionDriver({
          baseUrl: options.baseUrl,
          campaignId: options.campaignId as string,
          sessionId: sessionId as string,
          actorId: options.actorId as string,
          runId,
          persona,
          sessionTag,
          fetchImpl: io.fetchImpl,
          maxConfirmationRounds: options.maxConfirmationRounds,
        });
        return request => driver.submitTurn(request);
      })();

    const manifest = await runHarnessSession({
      runId,
      runSeed,
      persona,
      sessionIndex: runIndex,
      sessionId,
      turns: options.turns,
      mode: dryRun ? "dry-run" : "live",
      generateTurn,
      submitTurn,
      transcript: [],
      sheetSummary: options.sheetSummary ?? "public sheet labels not supplied; rely on the transcript",
      targets: null,
      startedAt,
      gitCommit,
      generatorIdentity,
      gameProviderModel: dryRun ? "fake" : "server-configured",
      campaignId: options.campaignId,
      actorId: options.actorId,
      dataDir,
      contentProfile: options.contentProfile,
      syntheticTag: sessionTag,
      notes,
      referenceBudget: 3,
      transcriptWindow: 6,
      menuWindow: options.menuWindow,
      directWeight: options.directWeight,
      focus: options.focus,
    });

    for (const line of renderManifestSummary(manifest)) io.out(line);
    if (options.out !== null) {
      const file = manifestOutputPath(options.out, runId, options.runs);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, serializeManifest(manifest), "utf8");
      io.out(`manifest written: ${file}`);
    } else {
      io.out(serializeManifest(manifest).trimEnd());
    }
  }
  return 0;
}

async function main(): Promise<void> {
  try {
    const code = await runHarnessCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`synthetic-player-harness: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}

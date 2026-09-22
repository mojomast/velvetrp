/**
 * Pure attack-intent detection for player adventure declarations.
 *
 * The detector answers one narrow question: does this declaration attack one specific visible
 * target? It is deliberately conservative. A match requires both a violent verb and a reference
 * to a candidate's public name; roles, pronouns, descriptions, and fuzzy identity guesses never
 * match. The module reads no persistence and holds no state, so the same declaration and
 * candidate list always produce the same answer.
 */
import type { CombatInitiationCandidate } from "../repo/encounter/encounterReadRepo.js";

/**
 * Violent verbs and phrasal verbs that can declare an attack. Matching adds regular inflections
 * (third person, past, gerund) and a few irregular past forms; the list itself is the vocabulary
 * of intent, not a stemmer.
 */
export const ATTACK_VERBS: readonly string[] = Object.freeze([
  "attack",
  "hit",
  "strike",
  "stab",
  "swing at",
  "slash",
  "shoot",
  "kill",
  "fight",
  "draw on",
  "charge",
  "punch",
  "kick",
  "throw at",
]);

/** Irregular past forms regular inflection cannot derive. */
const ATTACK_VERB_IRREGULAR_FORMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  strike: Object.freeze(["struck"]),
  swing: Object.freeze(["swung"]),
  shoot: Object.freeze(["shot"]),
  fight: Object.freeze(["fought"]),
  draw: Object.freeze(["drew"]),
  throw: Object.freeze(["threw"]),
});

/** Shortest distinctive single-name reference; shorter name words cannot match on their own. */
const MIN_NAME_REFERENCE_LENGTH = 3;

/** Connector words inside public names never establish a single-name reference. */
const NAME_TOKEN_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "of", "at", "on", "in", "to", "a", "an", "for", "with", "from", "by", "or", "as",
]);

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function escapeRegExp(value: string): string {
  return value.replace(ESCAPE_PATTERN, "\\$&");
}

/** Case-insensitive whole-word phrase match: `Hob` matches `Hob's ferry` but never `Hobgoblin`. */
function containsBoundedPhrase(declaration: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "u").test(declaration);
}

/** Regular finite forms of one verb head: attacks/attacked/attacking, stabs/stabbed/stabbing. */
function regularVerbHeadForms(head: string): string[] {
  const forms = new Set<string>([head]);
  if (/(?:s|x|z|ch|sh)$/u.test(head)) forms.add(`${head}es`);
  else forms.add(`${head}s`);
  if (head.endsWith("e")) {
    forms.add(`${head}d`);
    forms.add(`${head.slice(0, -1)}ing`);
  } else {
    forms.add(`${head}ed`);
    forms.add(`${head}ing`);
    const lastThree = head.slice(-3);
    if (/^[^aeiou][aeiou][^aeiouwxy]$/u.test(lastThree)) {
      forms.add(`${head}${head.slice(-1)}ed`);
      forms.add(`${head}${head.slice(-1)}ing`);
    }
  }
  return [...forms];
}

/** Every accepted surface form of one verb, including inflected phrasal verbs (`swung at`). */
function attackVerbForms(verb: string): string[] {
  const [head, ...tail] = verb.split(" ");
  const suffix = tail.length > 0 ? ` ${tail.join(" ")}` : "";
  const heads = new Set<string>([
    ...regularVerbHeadForms(head!),
    ...(ATTACK_VERB_IRREGULAR_FORMS[head!] ?? []),
  ]);
  return [...heads].map((form) => `${form}${suffix}`);
}

const ATTACK_VERB_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${ATTACK_VERBS.flatMap(attackVerbForms)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|")})(?![\\p{L}\\p{N}])`,
  "u",
);

/** 0 = no reference, 1 = one distinctive name word, 2 = the full public name. */
function candidateNameMatch(declaration: string, candidateName: string): 0 | 1 | 2 {
  const name = normalize(candidateName).replace(/\s+/gu, " ").trim();
  if (name.length === 0) return 0;
  if (containsBoundedPhrase(declaration, name)) return 2;
  const tokens = [...new Set(name.match(WORD_PATTERN) ?? [])];
  return tokens.some((token) => token.length >= MIN_NAME_REFERENCE_LENGTH && !NAME_TOKEN_STOPWORDS.has(token)
    && containsBoundedPhrase(declaration, token)) ? 1 : 0;
}

/** Normalized name used for specificity ranking; keeps phrase length comparable. */
function normalizedName(candidateName: string): string {
  return normalize(candidateName).replace(/\s+/gu, " ").trim();
}

/**
 * Returns the single visible candidate a declaration attacks, or null when the declaration has
 * no attack verb, names no candidate, or stays ambiguous between candidates. `candidates` is the
 * already-visibility-filtered target list and excludes the initiating actor.
 */
export function detectAttackTarget(
  declaration: string,
  candidates: readonly CombatInitiationCandidate[],
): CombatInitiationCandidate | null {
  if (typeof declaration !== "string" || declaration.trim().length === 0) return null;
  const normalized = normalize(declaration).replace(/\s+/gu, " ").trim();
  if (!ATTACK_VERB_PATTERN.test(normalized)) return null;

  const unique = new Map<string, CombatInitiationCandidate>();
  for (const candidate of candidates) {
    if (typeof candidate?.id !== "string" || candidate.id.length === 0 || typeof candidate.name !== "string") continue;
    unique.set(`${candidate.kind}:${candidate.id}`, candidate);
  }
  const scored = [...unique.values()]
    .map((candidate) => ({ candidate, strength: candidateNameMatch(normalized, candidate.name) }))
    .filter((match) => match.strength > 0);
  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0]!.candidate;
  // Full public names always beat single-name references. Among full names only the most
  // specific (longest) one wins; an unresolved tie stays ambiguous instead of guessing.
  const fullNameMatches = scored.filter((match) => match.strength === 2);
  if (fullNameMatches.length > 0) {
    const longest = Math.max(...fullNameMatches.map((match) => normalizedName(match.candidate.name).length));
    const best = fullNameMatches.filter((match) => normalizedName(match.candidate.name).length === longest);
    return best.length === 1 ? best[0]!.candidate : null;
  }
  return null;
}

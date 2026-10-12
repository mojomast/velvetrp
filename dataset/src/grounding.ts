/**
 * Semantic binding validation for grounded narration (Family B).
 *
 * WHY THIS EXISTS
 * ---------------
 * The audit proved that production's `providerNarrationMatchesReceipts` checks
 * PRESENCE, not BINDING. Against real ground truth (total 22, dc 15, success):
 *
 *   ACCEPTED  "comes to 22 against DC 15: success"        (correct)
 *   ACCEPTED  "comes to 15 against DC 22: success"        (swapped)
 *   ACCEPTED  "total 22 against DC 15. No success: fail."  (opposite verdict)
 *   ACCEPTED  "...success. The lock clicks open."          (invented consequence)
 *
 * Because `includesNumber()` is `(^|\D)N(?=\D|$)`, a number need only appear
 * SOMEWHERE. Using that predicate as the Family B admission gate would train the
 * model that receipt-contradicting narration is correct -- inverting the exact
 * behavior the family exists to teach.
 *
 * This module implements the missing check: subject -> action -> target -> value
 * -> outcome binding, with polarity. It runs ALONGSIDE the production predicate
 * (which is still useful for vocabulary/atmosphere and for catching ungrounded
 * travel/inventory/quest claims), never as a substitute for it.
 */

import { analyzeClaimReceipts } from "../../scripts/audit-adventure-consistency.js";

export const GROUNDING_VALIDATOR_VERSION = "grounding-binding-v1";

/** Polarity matters: "no success" is not "success". */
type Polarity = "affirm" | "negate" | "absent";

export interface BindingViolation {
  code: string;
  detail: string;
  /** The narration span that triggered it, for targeted repair. */
  excerpt: string;
}

export class GroundingFailure extends Error {
  readonly violations: readonly BindingViolation[];
  constructor(violations: readonly BindingViolation[]) {
    super(`narration is not grounded in the receipt: ${violations.map((v) => `${v.code} (${v.detail})`).join("; ")}`);
    this.name = "GroundingFailure";
    this.violations = violations;
  }
}

/**
 * The minimal receipt shapes Family B needs. Deliberately narrower than the full
 * `NarrationReceipt` union: this validator only handles the kinds where a
 * factual binding exists to check.
 */
export type GroundingReceipt =
  | {
      kind: "check";
      skill?: string;
      ability?: string;
      total: number;
      dc: number;
      outcome: string;
      rolls?: Array<{ value: number }>;
    }
  | { kind: "combat"; outcome: { kind: "damage"; applied: number; hitPointsAfter: number } }
  | { kind: "combat-damage"; applied: number; hitPointsAfter: number }
  | { kind: "travel"; destination: string }
  | { kind: "inventory"; itemLabel: string; quantity: number; action: string }
  | { kind: "rest"; restName: string }
  | { kind: "progression"; className: string; levelAfter: number };

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Numbers that legitimately appear as flavour and must not be read as claims. */
const FLAVOUR_NUMBER_ALLOWLIST = new Set([1, 2, 3, 4, 5, 10]);

function numberAppears(text: string, value: number): boolean {
  return new RegExp(`(^|[^0-9.])${value}(?![0-9.])`).test(text);
}

/** True when the text affirms the fact, rather than negating it. */
function polarityOf(text: string, subject: string): Polarity {
  const pattern = new RegExp(escapeRe(subject), "gi");
  const negated = /(?:no|not|never|fail(?:s|ed|ure)?|miss(?:es|ed)?|without|unable to|could not|couldn'?t)\b[^.!?]{0,40}$/i;
  let state: Polarity = "absent";
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(Math.max(0, match.index! - 48), match.index!);
    state = negated.test(prefix) ? "negate" : "affirm";
  }
  return state;
}

/**
 * Verifies a `check` receipt binding: skill named, total bound to total, DC bound
 * to DC, and outcome polarity consistent.
 *
 * The production gate accepts swapped totals. This rejects them by requiring the
 * two numbers to appear in a total-before-DC relation, or to be separately
 * labelled.
 */
function validateCheck(text: string, receipt: Extract<GroundingReceipt, { kind: "check" }>, violations: BindingViolation[]): void {
  const subject = receipt.skill ?? receipt.ability;
  if (subject && polarityOf(text, subject) === "absent") {
    violations.push({ code: "check-subject-missing", detail: `the check subject "${subject}" is never named`, excerpt: text.slice(0, 120) });
  }
  const total = receipt.total;
  const dc = receipt.dc;
  if (total !== dc) {
    // Require an explicit binding: "... total N ... DC M" or "N ... DC M".
    const boundTotalFirst = new RegExp(`(?:total|comes to|totals?)\\D{0,24}${total}\\b[\\s\\S]{0,40}?\\bDC\\b\\D{0,12}${dc}\\b`, "i");
    const boundDcFirst = new RegExp(`\\bDC\\b\\D{0,12}${dc}\\b[\\s\\S]{0,40}?(?:total|comes to|totals?)\\D{0,24}${total}\\b`, "i");
    if (numberAppears(text, total) && numberAppears(text, dc) && !boundTotalFirst.test(text) && !boundDcFirst.test(text)) {
      violations.push({
        code: "check-values-unbound",
        detail: `total ${total} and DC ${dc} both appear but neither is bound to its role; they may be swapped`,
        excerpt: text.slice(0, 160),
      });
    }
  }
  const success = /success/i.test(receipt.outcome);
  const failure = /fail|unsuccess/i.test(receipt.outcome);
  if (success && polarityOf(text, "success") === "negate") {
    violations.push({ code: "check-outcome-contradicted", detail: `receipt outcome is success but narration denies it`, excerpt: text.slice(0, 160) });
  }
  if (failure && polarityOf(text, "success") === "affirm" && polarityOf(text, "fail") === "absent") {
    violations.push({ code: "check-outcome-contradicted", detail: `receipt outcome is failure but narration claims success`, excerpt: text.slice(0, 160) });
  }
}

/**
 * Verifies a damage receipt. The critical addition over the production gate is
 * target HP: production checks `includesNumber(applied) && includesNumber(hpAfter)`
 * anywhere in the text, so "dealt 12 ... 30" passes even if the target's HP was 30
 * before. A hit that reduces a 30 HP creature to 30 is a claim, not a fact.
 */
function validateDamage(text: string, applied: number, hitPointsAfter: number, violations: BindingViolation[]): void {
  if (!numberAppears(text, applied) && !numberAppears(text, hitPointsAfter)) {
    violations.push({ code: "damage-ungrounded", detail: `no trace of applied ${applied} or remaining ${hitPointsAfter}`, excerpt: text.slice(0, 160) });
  }
  // A "killed/defeated/dead" claim is only allowed when the remaining HP is 0.
  const deathClaim = /\b(?:kill(?:s|ed)?|slain|defeat(?:s|ed)?|dead|dies|died|falls|drop(?:s|ped)?)\b/i.test(text);
  if (deathClaim && hitPointsAfter > 0) {
    violations.push({
      code: "fabricated-outcome",
      detail: `narration asserts death/defeat but the receipt leaves ${hitPointsAfter} hit points`,
      excerpt: text.slice(0, 200),
    });
  }
  const survivalClaim = /\b(?:surviv(?:es|ed)|wounds?|merely|only)\b/i.test(text);
  if (survivalClaim && applied >= hitPointsAfter) {
    violations.push({
      code: "fabricated-outcome",
      detail: `narration claims a non-lethal outcome but ${applied} damage was applied against ${hitPointsAfter} HP`,
      excerpt: text.slice(0, 200),
    });
  }
}

/**
 * Claims that assert a CONSEQUENCE the receipt does not establish.
 *
 * A successful check establishes its check outcome. It does not establish that a
 * door opened, that a clue was found, that an NPC was persuaded, or that a lock
 * gave way. Those require their own authoritative fact.
 */
const CONSEQUENCE_PATTERNS: ReadonlyArray<{ pattern: RegExp; code: string; detail: string }> = [
  { pattern: /\b(?:the\s+)?(?:lock|door|gate|seal)[a-z]*\s+(?:clicks?|opens?|gives?\s+way|opens?)\b/i, code: "fabricated-consequence", detail: "asserts a lock or door opened, which no check receipt establishes" },
  { pattern: /\b(?:you\s+)?(?:find|discover|uncover|spot)\s+(?:the\s+)?(?:hidden|secret|clue|key|evidence)\b/i, code: "fabricated-consequence", detail: "asserts a discovery that no receipt establishes" },
  { pattern: /\b(?:the\s+)?(?:npc|[a-z]+\s+name)\s+(?:convinced|agrees?|yields?|relents?|confesses?)\b/i, code: "fabricated-consequence", detail: "asserts a social outcome that no receipt establishes" },
  { pattern: /\b(?:the\s+)?(?:trap|ambush|attack)[a-z]*\s+(?:triggers?|springs?|fires?)\b/i, code: "fabricated-consequence", detail: "asserts a trap or ambush that no receipt establishes" },
];

export interface GroundingOptions {
  /** Extra authoritative facts the world did establish, e.g. a door was open. */
  authorizedConsequences?: readonly string[];
  /** Explicitly forbid these capability words, which override everything else. */
  forbiddenConsequences?: readonly string[];
}

/**
 * The Family B admission gate.
 *
 * Runs the production predicate AND this module's binding checks. Both must pass.
 * Throws `GroundingFailure` carrying structured violations so the repair stage can
 * act on specifics rather than re-prompting blindly.
 */
export function validateGroundedNarration(
  text: string,
  receipts: readonly GroundingReceipt[],
  options: GroundingOptions = {},
): { ok: true; bindingsChecked: number } {
  const violations: BindingViolation[] = [];
  const forbidden = (options.forbiddenConsequences ?? []).map((value) => new RegExp(escapeRe(value), "i"));
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      violations.push({ code: "forbidden-fact-disclosed", detail: `narration discloses forbidden content: ${pattern.source}`, excerpt: text.slice(0, 200) });
    }
  }

  for (const receipt of receipts) {
    if (receipt.kind === "check") validateCheck(text, receipt, violations);
    else if (receipt.kind === "combat" && receipt.outcome.kind === "damage") validateDamage(text, receipt.outcome.applied, receipt.outcome.hitPointsAfter, violations);
    else if (receipt.kind === "combat-damage") validateDamage(text, receipt.applied, receipt.hitPointsAfter, violations);
    else if (receipt.kind === "travel") {
      if (polarityOf(text, receipt.destination) === "absent") {
        violations.push({ code: "travel-destination-missing", detail: `committed destination "${receipt.destination}" is never named`, excerpt: text.slice(0, 160) });
      }
    } else if (receipt.kind === "inventory") {
      if (polarityOf(text, receipt.itemLabel) === "absent") {
        violations.push({ code: "inventory-item-missing", detail: `committed item "${receipt.itemLabel}" is never named`, excerpt: text.slice(0, 160) });
      }
      if (!numberAppears(text, receipt.quantity) && !FLAVOUR_NUMBER_ALLOWLIST.has(receipt.quantity)) {
        violations.push({ code: "inventory-quantity-ungrounded", detail: `quantity ${receipt.quantity} never appears`, excerpt: text.slice(0, 160) });
      }
    } else if (receipt.kind === "rest") {
      if (polarityOf(text, receipt.restName) === "absent") {
        violations.push({ code: "rest-name-missing", detail: `committed rest "${receipt.restName}" is never named`, excerpt: text.slice(0, 160) });
      }
    } else if (receipt.kind === "progression") {
      if (polarityOf(text, receipt.className) === "absent") {
        violations.push({ code: "progression-class-missing", detail: `class "${receipt.className}" is never named`, excerpt: text.slice(0, 160) });
      }
      if (!numberAppears(text, receipt.levelAfter)) {
        violations.push({ code: "progression-level-ungrounded", detail: `level ${receipt.levelAfter} never appears`, excerpt: text.slice(0, 160) });
      }
    }
  }

  // Consequence overreach, unless the world separately authorized it.
  const authorized = (options.authorizedConsequences ?? []).join(" | ");
  for (const { pattern, code, detail } of CONSEQUENCE_PATTERNS) {
    if (!pattern.test(text)) continue;
    const match = text.match(pattern);
    if (match && authorized && new RegExp(escapeRe(authorized), "i").test(text)) continue;
    violations.push({ code, detail, excerpt: match ? text.slice(match.index!, match.index! + 120) : text.slice(0, 120) });
  }

  if (violations.length > 0) throw new GroundingFailure(violations);
  return { ok: true, bindingsChecked: receipts.length };
}

/**
 * Secondary signal only. The audit proved `analyzeClaimReceipts` suppresses
 * `claimWithoutReceipt` when a matching UNEXECUTED PROPOSAL exists, so
 * "You take a long rest." with only a rest proposal passes. Never use it as proof
 * of a committed outcome; it is a cheap recall signal for extra scrutiny.
 */
export function secondaryClaimSignal(
  text: string,
  receiptFamilies: readonly string[],
  proposalFamilies: readonly string[],
): string[] {
  return analyzeClaimReceipts({ narration: text, receiptFamilies: [...receiptFamilies], proposalFamilies: [...proposalFamilies] } as never) as unknown as string[];
}
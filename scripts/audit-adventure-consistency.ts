#!/usr/bin/env node
/**
 * Per-turn adventure consistency audit.
 *
 * Joins, per turn: the player declaration, the adventure-selection lane pick, agent provider
 * calls, tool proposals/confirmations, receipts (combat, RPG m15/m16, rest, exact actions,
 * world/quest receipts), and the settled narration. It then flags lexical and structural
 * mismatches as review signals, never as verdicts.
 *
 * Read-only: opens `<world>/velvet.sqlite` with `node:sqlite` in read-only mode and only writes
 * the optional `--json` / `--md` reports.
 *
 * Usage:
 *   npx tsx scripts/audit-adventure-consistency.ts --world .velvet/synth-srd-3
 *     [--json /tmp/audit.json] [--md /tmp/audit.md] [--fail-on <class>[,<class>...]]...
 *
 * Exit code is 0 unless `--fail-on <class>` names a class whose flags were emitted. Informational
 * flags (ambient receipt families, expected confirmation flows) only fail when explicitly named,
 * except the expected lane states — a confirmation wait and a shadow (advisory) no-commit — which
 * are never failures.
 *
 * Env: none; the world path is explicit so the audit never guesses a data directory.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// -------------------------------------------------------------------------------------------------
// Flag classes and the shared report header
// -------------------------------------------------------------------------------------------------

export const AUDIT_FLAG_CLASSES = [
  "claim-without-receipt",
  "receipt-without-claim",
  "lane-act-uncommitted",
  "combat-outcome-mismatch",
  "narration-missing",
] as const;
export type AuditFlagClass = (typeof AUDIT_FLAG_CLASSES)[number];

export const AUDIT_HEADER_NOTE =
  "Lexical flags are review signals, not verdicts. A missing receipt can be legitimate ambient"
  + " narration: a turn may describe scenery, intent, or consequences that are not tracked by any"
  + " receipt family. Confirm every flag against the turn declaration, proposals, and receipts"
  + " before treating it as a divergence. `receipt-without-claim` and the confirmation wait and"
  + " shadow (advisory) no-commit states of `lane-act-uncommitted` are informational by design:"
  + " a shadow decision is recorded advisory-only, so it cannot commit until the lane is promoted;"
  + " only a non-shadow act pick with no execution and no proposal binding is a missing commit.";

export type AuditSeverity = "actionable" | "informational";

export interface AuditFlag {
  class: AuditFlagClass;
  turnId: string;
  declaration: string;
  narrationExcerpt: string;
  evidence: string;
  confidence: "signal";
  severity: AuditSeverity;
  /**
   * Only set for `lane-act-uncommitted`: distinguishes a genuinely missing commit from a wait
   * (`awaiting-confirmation`) or a shadow (advisory) pick that cannot commit by design
   * (`shadow-no-commit`).
   */
  verdict?: "missing" | "awaiting-confirmation" | "shadow-no-commit";
}

const SEVERITY_ORDER: Record<AuditSeverity, number> = { actionable: 0, informational: 1 };
export const FLAG_CLASS_ORDER: Record<AuditFlagClass, number> = {
  "claim-without-receipt": 0,
  "receipt-without-claim": 1,
  "lane-act-uncommitted": 2,
  "combat-outcome-mismatch": 3,
  "narration-missing": 4,
};

export function sortAuditFlags(flags: readonly AuditFlag[]): AuditFlag[] {
  return [...flags].sort((left, right) => {
    const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (severity !== 0) return severity;
    const flagClass = FLAG_CLASS_ORDER[left.class] - FLAG_CLASS_ORDER[right.class];
    if (flagClass !== 0) return flagClass;
    return left.turnId.localeCompare(right.turnId);
  });
}

// -------------------------------------------------------------------------------------------------
// Claim lexicon (one exported constant mapping families to regexes and receipt sources)
// -------------------------------------------------------------------------------------------------

export const CLAIM_FAMILIES = ["healing", "rest", "check", "attack", "power", "movement", "quest"] as const;
export type ClaimFamily = (typeof CLAIM_FAMILIES)[number];

export interface ClaimFamilyRule {
  /** Narration patterns that assert this family. Order matters: the first non-guarded match wins. */
  readonly patterns: readonly RegExp[];
  /** Receipt/proposal shapes the audit treats as backing for this family (evidence text only). */
  readonly receiptSources: readonly string[];
}

/**
 * Movement assertion shape. Movement verbs are the same for directives and intent, so a bare
 * lexicon hit ("walk" in "this is what it asks of you: walk the hill track", "travel" in "her
 * eyes travel the page") is not a claim. Two shapes assert movement:
 *  - completed past/perfect forms (`walked`, `travelled`/`traveled`, `arrived`, `reached`,
 *    `entered`, `left`, `headed`, `rode`, `marched`, `sailed`, `journeyed`, `moved`,
 *    `set out`/`set off`, `made for`), which assert movement on their own; and
 *  - present action statements with an actor subject (`you walk`, `the party travels`, `you are
 *    traveling`), which require the subject from `MOVEMENT_ACTION_SUBJECT_RE`.
 * `MOVEMENT_NON_ASSERTION_PREFIXES` plus the question and idiom checks in
 * `isMovementAssertionMatch` cancel a hit of either shape: after "asks of you:", modal verbs,
 * "before you", "if you", "in order to", "the way to", a bare infinitive, or future "will";
 * questions; sight metaphors; adjective "left"; passive "made for"; and "reached for" /
 * "arrived at a decision".
 */
export const MOVEMENT_FRAME_WINDOW = 80;

/** Completed past/perfect movement forms; they assert movement without needing an actor subject. */
export const MOVEMENT_COMPLETED_RE =
  /\b(?:walked|travell?ed|arrived|reached|entered|left|headed|rode|marched|sailed|journeyed|moved|set (?:out|off)|made for)\b/i;

/** Present movement forms; a claim only with an actor subject from `MOVEMENT_ACTION_SUBJECT_RE`. */
export const MOVEMENT_PRESENT_RE =
  /\b(?:walks?|walking|travell?ing|travels?|arrives?|arriving|reaches?|reaching|enters?|entering|leaves?|leaving|heads?|heading|rides?|riding|marches?|marching|sails?|sailing|journeys?|journeying|moves?|moving|sets? (?:out|off)|makes? for)\b/i;

/**
 * Actor subjects that turn a present movement form into an action statement: the player/party
 * pronouns (optionally contracted and across a be-auxiliary: "you're traveling") and party-shaped
 * noun phrases ("the party travels"). Other subjects such as body parts ("her eyes travel") are
 * metaphors, not movement.
 */
export const MOVEMENT_ACTION_SUBJECT_RE =
  /(?:\b(?:i|we|you|they|he|she)(?:['’](?:m|re|s|ve))?\s+(?:(?:am|are|is|was|were|be|been|being)\s+)?(?:\w+ly\s+)*|\b(?:the|our|your|their|his|her|my)\s+(?:party|group|company|caravan|expedition|crew|troupe|band)\s+(?:(?:am|are|is|was|were|be|been|being)\s+)?(?:\w+ly\s+)*)$/i;

/** Prefix frames that make a movement hit a directive, intent, conditional, or future statement. */
export const MOVEMENT_NON_ASSERTION_PREFIXES: readonly RegExp[] = [
  /\basks of you:?\s*$/i,
  /\b(?:could|might|should|would|may|can|must|shall|need to|have to|has to|had to|ought to)\s+(?:(?:have|has|had|be|been|being)\s+)?(?:\w+ly\s+)*$/i,
  /\b(?:before|if)\s+you\s+(?:\w+ly\s+)*$/i,
  /\bin order to\s*$/i,
  /\bthe way to\s*$/i,
  /\bto\s*$/i,
  /\b(?:will|shall)\s+(?:\w+\s+)?$/i,
];

/** Sight/body-part subjects whose "travel" is metaphor ("her eyes travel the page"). */
const MOVEMENT_SIGHT_SUBJECT_RE = /\b(?:eyes?|gaze|glances?|looks?|fingers?|thoughts?|mind)\s+(?:\w+\s+)?$/i;
/** Determiners and prepositions that make "left" a direction or side rather than a departure. */
const LEFT_AS_MODIFIER_RE = /\b(?:the|a|an|on|to|from|at|his|her|its|my|your|our|their|with)\s+$/i;
/** Passive markers that make "made for" a match rather than travel ("they were made for each other"). */
const PASSIVE_AUX_RE = /\b(?:is|are|was|were|be|been|being)\s+$/i;

export const CLAIM_LEXICON: Readonly<Record<ClaimFamily, ClaimFamilyRule>> = {
  healing: {
    patterns: [
      /\bpotion(?:s)?\b/i,
      /\bdrink(?:s|ing)?\b/i,
      /\bdrunk\b/i,
      /\bheals?(?:ed|ing)?\b/i,
      /\buncorks?(?:ed|ing)?\b/i,
      /\bswallows?(?:ed|ing)?\b/i,
      /\bquaffs?(?:ed|ing)?\b/i,
    ],
    receiptSources: [
      "adventure_exact_action_executions_v56:combat-consumable|combat-power",
      "rpg_m15_receipts_v25:consumable|resource:health",
      "combat_receipts_v27:heal outcome",
      "tool_proposals:combat_consumable_use",
    ],
  },
  rest: {
    patterns: [
      /\bshort rest\b/i,
      /\blong rest\b/i,
      /\bhit dice\b/i,
      /\bmake camp\b/i,
      /\bbandages?(?:d|ing)?\b/i,
      /\bcatch (?:my|his|her|their|our) breath\b/i,
      /\brest(?:s|ed|ing)?\b/i,
    ],
    receiptSources: [
      "rpg_rest_receipts_v25",
      "rpg_m15_commands_v25:rest",
      "adventure_exact_action_executions_v56:rest",
      "rpg_rest_elapsed_v60",
      "tool_proposals:*rest*",
    ],
  },
  check: {
    patterns: [
      /\binspects?(?:ed|ing)?\b/i,
      /\bsearch(?:es|ed|ing)?\b/i,
      /\brecalls?(?:ed|ing)?\b/i,
      /\breckons?(?:ed|ing)?\b/i,
      /\bstud(?:y|ies|ied|ying)\b/i,
      /\bchecks?(?:ed|ing)?\b/i,
      /\bexamin(?:e|es|ed|ing)\b/i,
      /\binvestigat(?:e|es|ed|ing)\b/i,
    ],
    receiptSources: [
      "adventure_check_executions_v54",
      "rpg_m16_receipts_v26:check",
      "tool_proposals:*check*|*recall*|*inspect*",
    ],
  },
  attack: {
    patterns: [
      /\bswings?(?:ing)?\b/i,
      /\bstrikes?\b/i,
      /\bstabs?(?:bed|bing)?\b/i,
      /\bslashes?(?:d|ing)?\b/i,
      /\bshoots?(?:ing)?\b/i,
      /\battacks?(?:ed|ing)?\b/i,
      /\bhits?\b/i,
      /\bmisses?(?:d|ing)?\b/i,
      /\bthrow(?:s|ing)?\b/i,
      /\bfires? (?:an? )?(?:arrow|bolt|shot)\b/i,
    ],
    receiptSources: [
      "combat_receipts_v27:attack|damage outcome",
      "agent_combat_proposal_bindings_v39",
      "tool_proposals:combat*|*attack*",
    ],
  },
  power: {
    patterns: [
      /\bsecond wind\b/i,
      /\bchannels?(?:ed|ing)?\b/i,
      /\bsmites?(?:d|ing)?\b/i,
      /\bspells?\b/i,
      /\bcasts?(?:ing)?\b/i,
      /\bpowers?\b/i,
    ],
    receiptSources: [
      "adventure_exact_action_executions_v56:power|combat-power",
      "rpg_m16_receipts_v26:power",
      "rpg_power_uses_v26",
      "tool_proposals:*power*|*spell*",
    ],
  },
  movement: {
    // Movement needs an assertion shape instead of a base-form hit; see MOVEMENT_COMPLETED_RE /
    // MOVEMENT_PRESENT_RE and `isMovementAssertionMatch` for the directive frames and idioms.
    patterns: [MOVEMENT_COMPLETED_RE, MOVEMENT_PRESENT_RE],
    receiptSources: [
      "final_receipt_links -> world_receipts_v28",
      "world_travel_elapsed_v60",
      "campaign_actor_locations_v28",
    ],
  },
  quest: {
    patterns: [
      /\bquests?\b/i,
      /\bobjectives?\b/i,
      /\bhands? in\b/i,
      /\bturns?(?:ed)? in\b/i,
      /\brewards?(?:ed|ing)?\b/i,
      /\bbount(?:y|ies)\b/i,
      /\bmissions?\b/i,
    ],
    receiptSources: [
      "adventure_exact_action_executions_v56:quest-accept|quest-abandon|quest-reward",
      "quest_domain_receipts_v33",
      "quest_reward_claims_v33",
    ],
  },
};

const NEGATION_RE = /(?:\b(?:no|not|never|without|nor|none|nothing)\b|n['’]t\b)/i;
const NEGATION_WINDOW = 24;

/**
 * True when a lexicon hit is negated or idiomatic rather than an assertion. The guard is
 * deliberately narrow: "no movement", "didn't search", and "the rest of the party" do not claim
 * the family, while "I attack" and "we take a long rest" do. Movement additionally needs an
 * assertion shape (`isMovementAssertionMatch`): directives such as "walk the hill track" after
 * "asks of you:" and hypotheticals such as "you might travel" are not claims.
 */
export function isGuardedClaimMatch(
  family: ClaimFamily,
  text: string,
  index: number,
  token: string,
): boolean {
  const before = text.slice(Math.max(0, index - NEGATION_WINDOW), index);
  const after = text.slice(index + token.length, index + token.length + NEGATION_WINDOW);
  if (NEGATION_RE.test(before)) return true;
  if (family === "rest" && /\bthe\s*$/i.test(before) && /^\s+of\b/i.test(after)) return true;
  if (family === "rest" && /^\s+assured\b/i.test(after)) return true;
  if (family === "attack" && /^hits?$/i.test(token) && /^\s*points?\b/i.test(after)) return true;
  if (family === "movement" && !isMovementAssertionMatch(text, index, token)) return true;
  return false;
}

/**
 * True when a movement lexicon hit carries an assertion shape: a completed past/perfect form, or
 * a present form with an actor subject (`MOVEMENT_ACTION_SUBJECT_RE`), in both cases outside the
 * directive/intent/question frames and idioms documented on `MOVEMENT_COMPLETED_RE`.
 */
export function isMovementAssertionMatch(text: string, index: number, token: string): boolean {
  const before = text.slice(Math.max(0, index - MOVEMENT_FRAME_WINDOW), index);
  const after = text.slice(index + token.length);
  if (MOVEMENT_NON_ASSERTION_PREFIXES.some((pattern) => pattern.test(before))) return false;
  // A question is a request or a hypothetical, not a claim that movement happened.
  const terminator = /[.!?]/.exec(after);
  if (terminator !== null && terminator[0] === "?") return false;
  if (MOVEMENT_SIGHT_SUBJECT_RE.test(before)) return false;
  if (/^left$/i.test(token) && LEFT_AS_MODIFIER_RE.test(before)) return false;
  if (/^made for$/i.test(token) && PASSIVE_AUX_RE.test(before)) return false;
  if (/^headed$/i.test(token) && /^\s+by\b/i.test(after)) return false;
  if (/^reached$/i.test(token) && /^\s+for\b/i.test(after)) return false;
  if (/^arrived$/i.test(token)
    && /^\s+at\s+(?:an?|the)\s+(?:decision|conclusion|agreement|compromise|verdict|answer|understanding)\b/i.test(after)) {
    return false;
  }
  if (MOVEMENT_COMPLETED_RE.test(token)) return true;
  return MOVEMENT_ACTION_SUBJECT_RE.test(before);
}

export interface ClaimMatch {
  family: ClaimFamily;
  /** The exact lexicon token that matched. */
  match: string;
}

/**
 * Detects asserted claim families in narration text. Each family yields at most one match; the
 * first non-guarded hit in lexicon order wins so evidence strings are stable.
 */
export function detectClaimMatches(text: string): ClaimMatch[] {
  const matches: ClaimMatch[] = [];
  for (const family of CLAIM_FAMILIES) {
    const rule = CLAIM_LEXICON[family];
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match === null) continue;
      const token = match[0];
      if (isGuardedClaimMatch(family, text, match.index, token)) continue;
      matches.push({ family, match: token });
      break;
    }
  }
  return matches;
}

export function detectClaimFamilies(text: string): ClaimFamily[] {
  return detectClaimMatches(text).map((match) => match.family);
}

/** True when this repository knows a receipt/proposal shape that can back the family. */
export function familyHasReceiptSource(family: ClaimFamily): boolean {
  return CLAIM_LEXICON[family].receiptSources.length > 0;
}

// -------------------------------------------------------------------------------------------------
// Pure classifier 1+2: narration claims versus receipt and proposal families
// -------------------------------------------------------------------------------------------------

export interface ClaimReceiptAnalysis {
  claims: ClaimMatch[];
  /** Claimed families with neither a receipt nor a proposal for the turn. */
  claimWithoutReceipt: ClaimMatch[];
  /** Receipt families the narration never mentions. Informational. */
  receiptWithoutClaim: ClaimFamily[];
}

export function analyzeClaimReceipts(input: {
  narration: string;
  receiptFamilies: readonly ClaimFamily[];
  proposalFamilies: readonly ClaimFamily[];
  /**
   * Families backed by receipt result content without an action-family label (for example a
   * combat-power execution whose outcome kind is `healing`). Only suppresses
   * claim-without-receipt; it is not reported as a receipt family.
   */
  contentBackedFamilies?: readonly ClaimFamily[];
}): ClaimReceiptAnalysis {
  const claims = detectClaimMatches(input.narration);
  const receipts = new Set(input.receiptFamilies);
  const proposals = new Set(input.proposalFamilies);
  const contentBacked = new Set(input.contentBackedFamilies ?? []);
  const claimWithoutReceipt = claims.filter(
    (claim) => !receipts.has(claim.family)
      && !contentBacked.has(claim.family)
      && !proposals.has(claim.family),
  );
  const seenReceipts = new Set<ClaimFamily>();
  const receiptWithoutClaim: ClaimFamily[] = [];
  for (const family of input.receiptFamilies) {
    if (seenReceipts.has(family)) continue;
    seenReceipts.add(family);
    if (!claims.some((claim) => claim.family === family)) receiptWithoutClaim.push(family);
  }
  return { claims, claimWithoutReceipt, receiptWithoutClaim };
}

// -------------------------------------------------------------------------------------------------
// Receipt content evidence: healing detected in result JSON, not only in action-family labels
// -------------------------------------------------------------------------------------------------

const HEALING_KIND_VALUES = new Set(["healing", "heal"]);
const HEALTH_RESOURCE_KEYS = ["resourceId", "resource", "resourceName", "stat", "attribute"] as const;
const HEALTH_NAME_RE = /(?:^|[^a-z])(?:health|hit ?points?|hp)(?:$|[^a-z])/i;
const POSITIVE_DELTA_KEYS = ["applied", "delta", "amount", "change"] as const;
const HEALING_SCAN_MAX_DEPTH = 12;
const HEALING_SCAN_MAX_NODES = 5_000;

function readNumericField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readHealthResourceName(record: Record<string, unknown>): string | null {
  for (const key of HEALTH_RESOURCE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && HEALTH_NAME_RE.test(value)) return value;
  }
  return null;
}

/**
 * Conservative healing evidence scan over one parsed receipt value. Two signals count: an
 * outcome/effect entry labelled `healing`/`heal`, and an unambiguous positive health delta
 * (`before < after`, or a positive `applied`/`delta`/`amount`/`change` beside a health resource
 * name or under a health-shaped key). Damage entries and direction-less health mirrors never
 * qualify.
 */
export function hasHealingEvidence(value: unknown): boolean {
  let visited = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > HEALING_SCAN_MAX_DEPTH || visited > HEALING_SCAN_MAX_NODES) return false;
    visited += 1;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (walk(item, depth + 1)) return true;
      }
      return false;
    }
    if (node === null || typeof node !== "object") return false;
    const record = node as Record<string, unknown>;
    const kindValue = record["kind"] ?? record["type"];
    if (typeof kindValue === "string" && HEALING_KIND_VALUES.has(kindValue.trim().toLowerCase())) {
      return true;
    }
    if (readHealthResourceName(record) !== null) {
      const before = readNumericField(record, "before");
      const after = readNumericField(record, "after");
      if (before !== null && after !== null && after > before) return true;
      for (const key of POSITIVE_DELTA_KEYS) {
        const delta = readNumericField(record, key);
        if (delta !== null && delta > 0) return true;
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (HEALTH_NAME_RE.test(key) && child !== null && typeof child === "object" && !Array.isArray(child)) {
        const nested = child as Record<string, unknown>;
        const before = readNumericField(nested, "before");
        const after = readNumericField(nested, "after");
        if (before !== null && after !== null && after > before) return true;
        for (const deltaKey of POSITIVE_DELTA_KEYS) {
          const delta = readNumericField(nested, deltaKey);
          if (delta !== null && delta > 0) return true;
        }
      }
      if (walk(child, depth + 1)) return true;
    }
    return false;
  };
  return walk(value, 0);
}

/** Tolerant JSON wrapper around `hasHealingEvidence`; malformed documents are not healing. */
export function jsonHasHealingEvidence(resultJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson) as unknown;
  } catch {
    return false;
  }
  return hasHealingEvidence(parsed);
}

// -------------------------------------------------------------------------------------------------
// Pure classifier 3: adventure-selection lane picks without a commit
// -------------------------------------------------------------------------------------------------

export type LaneActVerdict = "missing" | "awaiting-confirmation" | "shadow-no-commit";

/**
 * Classifies an act-band lane pick with no execution. A bound proposal is an expected confirmation
 * wait. Without a binding, a shadow (advisory-only) decision cannot commit by design — it is
 * informational — while a non-shadow decision is a genuinely missing commit.
 */
export function classifyLaneActUncommitted(input: {
  confidenceBand: string | null;
  hasSelection: boolean;
  hasExecution: boolean;
  hasProposalBinding: boolean;
  /** True when the decision is recorded advisory-only (`system_one_decisions_v1.shadow`). */
  shadow: boolean;
}): LaneActVerdict | null {
  if (input.confidenceBand !== "act" || !input.hasSelection) return null;
  if (input.hasExecution) return null;
  if (input.hasProposalBinding) return "awaiting-confirmation";
  return input.shadow ? "shadow-no-commit" : "missing";
}

export interface LaneSelectionSnapshot {
  decisionId: string;
  confidenceBand: string | null;
  method: string | null;
  candidateId: string | null;
  hasSelection: boolean;
  /** Advisory-only decision: it cannot commit until the lane binding promotes it. */
  shadow: boolean;
}

/**
 * Pure parser for one `system_one_decisions_v1` adventure-selection row. Malformed selection JSON
 * is treated as "no selection" instead of throwing: the audit must not fail on legacy rows.
 */
export function parseLaneSelection(row: {
  decisionId: string;
  confidenceBand: string | null;
  selectionJson: string | null;
  shadow: boolean;
}): LaneSelectionSnapshot {
  let method: string | null = null;
  let candidateId: string | null = null;
  if (row.selectionJson !== null) {
    try {
      const parsed = JSON.parse(row.selectionJson) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (typeof record["method"] === "string" && record["method"].length > 0) {
          method = record["method"];
        }
        const selection = record["selection"];
        if (selection !== null && typeof selection === "object" && !Array.isArray(selection)) {
          const pick = selection as Record<string, unknown>;
          if (typeof pick["candidateId"] === "string" && pick["candidateId"].length > 0) {
            candidateId = pick["candidateId"];
          }
        }
      }
    } catch {
      method = null;
      candidateId = null;
    }
  }
  return {
    decisionId: row.decisionId,
    confidenceBand: row.confidenceBand,
    method,
    candidateId,
    hasSelection: candidateId !== null,
    shadow: row.shadow,
  };
}

// -------------------------------------------------------------------------------------------------
// Pure classifier 4: combat outcome versus narration
// -------------------------------------------------------------------------------------------------

export const COMBAT_CLAIM_LEXICON = {
  hit: [
    /\bhits?\b/i,
    /\bstruck\b/i,
    /\bstrikes?\b/i,
    /\bslashes?(?:d|ing)?\b/i,
    /\bstabs?(?:bed|bing)?\b/i,
    /\bwounds?(?:ed|ing)?\b/i,
    /\bblood(?:y|ied)?\b/i,
    /\bdamages?(?:d|ing)?\b/i,
    /\bconnects?(?:ed|ing)?\b/i,
    /\bfinds? its mark\b/i,
  ],
  miss: [
    /\bdodges?(?:d|ing)?\b/i,
    /\bmisses?(?:d|ing)?\b/i,
    /\bevades?(?:d|ing)?\b/i,
    /\bunharmed\b/i,
    /\bunscathed\b/i,
    /\bdeflects?(?:ed|ing)?\b/i,
    /\bparr(?:y|ies|ied|ying)\b/i,
  ],
  defeat: [
    /\bdead\b/i,
    /\bslain\b/i,
    /\bslays?\b/i,
    /\bdefeats?(?:ed|ing)?\b/i,
    /\bkills?(?:ed|ing)?\b/i,
    /\bdies?\b/i,
    /\bdying\b/i,
    /\bfell(?:s|ed|ing)?\b/i,
    /\blifeless\b/i,
  ],
} as const;

export const INCAPACITATED_COMBAT_STATUSES = [
  "unconscious",
  "stable",
  "dead",
  "defeated",
  "fled",
  "removed",
] as const;
export const DEFEATED_COMBAT_STATUSES = ["dead", "defeated", "fled", "removed"] as const;

function matchesAny(patterns: readonly RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }
  return null;
}

export interface CombatTargetStatus {
  name: string;
  status: string;
  hitPoints: number;
}

export interface CombatOutcomeInput {
  narration: string;
  /** Sum of `applied` damage outcomes across the turn's linked combat receipts. */
  damageDealt: number;
  /** Post-state combatant statuses observed inside the turn's linked combat receipts. */
  receiptStatuses: readonly string[];
  /** Current statuses of combatants in the encounters this turn touched. */
  targets: readonly CombatTargetStatus[];
}

export type CombatOutcomeVerdictKind =
  | "damage-claimed-miss"
  | "damage-claimed-without-damage"
  | "defeat-claimed-target-active";

export interface CombatOutcomeVerdict {
  kind: CombatOutcomeVerdictKind;
  detail: string;
}

/**
 * Compares the turn's combat receipts with the narration. Conservative by construction: hit/miss
 * claims only fire when no opposing claim is present, and a defeat claim is suppressed as soon as
 * any combatant in the touched encounters is down or gone.
 */
export function classifyCombatOutcomeMismatch(input: CombatOutcomeInput): CombatOutcomeVerdict[] {
  const verdicts: CombatOutcomeVerdict[] = [];
  // "hit points" is resource vocabulary, not a claim that an attack connected.
  const hitText = input.narration.replace(/\bhit points?\b/gi, "hp");
  const hitClaim = matchesAny(COMBAT_CLAIM_LEXICON.hit, hitText);
  const missClaim = matchesAny(COMBAT_CLAIM_LEXICON.miss, input.narration);
  if (input.damageDealt > 0 && missClaim !== null && hitClaim === null) {
    verdicts.push({
      kind: "damage-claimed-miss",
      detail: `receipts dealt ${input.damageDealt} damage but the narration claims "${missClaim}" and never claims a hit`,
    });
  }
  if (input.damageDealt === 0 && hitClaim !== null && missClaim === null) {
    verdicts.push({
      kind: "damage-claimed-without-damage",
      detail: `the narration claims "${hitClaim}" but the turn's combat receipts dealt no damage`,
    });
  }
  const defeatClaim = matchesAny(COMBAT_CLAIM_LEXICON.defeat, input.narration);
  if (defeatClaim !== null && input.targets.length > 0) {
    const incapacitated = new Set<string>(INCAPACITATED_COMBAT_STATUSES);
    const defeatStatuses = new Set<string>(DEFEATED_COMBAT_STATUSES);
    const stillStanding = input.targets.filter(
      (target) => !incapacitated.has(target.status) && target.hitPoints > 0,
    );
    const alreadyDown = input.targets.some((target) => incapacitated.has(target.status))
      || input.receiptStatuses.some((status) => defeatStatuses.has(status));
    if (stillStanding.length > 0 && !alreadyDown) {
      const names = stillStanding
        .slice(0, 3)
        .map((target) => `${target.name} (${target.status}, ${target.hitPoints} HP)`)
        .join(", ");
      verdicts.push({
        kind: "defeat-claimed-target-active",
        detail: `narration claims "${defeatClaim}" but the touched encounter still shows ${names}`,
      });
    }
  }
  return verdicts;
}

// -------------------------------------------------------------------------------------------------
// Pure classifier 5: completed turns with no narration text
// -------------------------------------------------------------------------------------------------

export function classifyNarrationMissing(input: {
  state: string;
  narrationStatus: string;
  narration: string | null;
}): boolean {
  const completed = input.state === "completed" || input.narrationStatus === "completed";
  return completed && (input.narration === null || input.narration.trim() === "");
}

// -------------------------------------------------------------------------------------------------
// Explicit-action and tool-name family mappings (shared by the DB reader and evidence)
// -------------------------------------------------------------------------------------------------

export function familyForExactActionKind(actionKind: string | null): ClaimFamily | null {
  switch (actionKind) {
    case "power":
    case "combat-power":
      return "power";
    case "rest":
      return "rest";
    case "combat-consumable":
      return "healing";
    case "quest-accept":
    case "quest-abandon":
    case "quest-reward":
      return "quest";
    default:
      return null;
  }
}

export const TOOL_NAME_FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, ClaimFamily]> = [
  [/combat_consumable|consumable|potion/i, "healing"],
  [/rest/i, "rest"],
  [/check|recall|inspect|search|study|reckon/i, "check"],
  [/attack|strike|weapon/i, "attack"],
  [/power|spell|smite|channel|second_wind/i, "power"],
  [/travel|move|journey/i, "movement"],
  [/quest|reward/i, "quest"],
];

export function familiesForToolName(toolName: string): ClaimFamily[] {
  const families: ClaimFamily[] = [];
  for (const [pattern, family] of TOOL_NAME_FAMILY_PATTERNS) {
    if (pattern.test(toolName) && !families.includes(family)) families.push(family);
  }
  return families;
}

// -------------------------------------------------------------------------------------------------
// Pure per-turn audit composition
// -------------------------------------------------------------------------------------------------

export interface TurnAuditInput {
  turnId: string;
  declaration: string;
  state: string;
  narrationStatus: string;
  narration: string | null;
  /** Newest adventure-selection decision for this turn, or null when the lane never ran. */
  lane: LaneSelectionSnapshot | null;
  /** True when an execution row is attached to the lane decision's id. */
  laneExecution: boolean;
  /** True when a proposal binding row is attached to the lane decision's id. */
  laneProposalBinding: boolean;
  laneBindingEvidence: readonly string[];
  confirmationEvidence: string | null;
  /** Families backed by an executed receipt for this turn. */
  receiptFamilies: readonly ClaimFamily[];
  /** Human-readable receipt evidence lines such as `combat_receipts_v27:attack damage=4`. */
  receiptEvidence: readonly string[];
  /**
   * Families backed by receipt result content rather than an action-family label (a combat-power
   * execution with a `healing` outcome satisfies a healing claim, for example).
   */
  receiptContentFamilies: readonly ClaimFamily[];
  /** Families backed by a proposal/binding without an execution. */
  proposalFamilies: readonly ClaimFamily[];
  proposalEvidence: readonly string[];
  /** Combat outcome summary when the turn has linked combat receipts; null otherwise. */
  combatOutcome: CombatOutcomeInput | null;
  /** Free-form turn context (provider calls, tool calls) appended to evidence. */
  context: string;
}

export function narrationExcerpt(narration: string | null, maxLength = 220): string {
  if (narration === null) return "";
  const collapsed = narration.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function appendContext(evidence: string, context: string): string {
  return context.length > 0 ? `${evidence}; ${context}` : evidence;
}

/**
 * Runs every classifier for one turn. Pure: all database joins happen in the reader below, so the
 * classification logic stays testable without a fixture.
 */
export function auditTurn(input: TurnAuditInput): AuditFlag[] {
  const flags: AuditFlag[] = [];
  const base = {
    turnId: input.turnId,
    declaration: input.declaration,
    narrationExcerpt: narrationExcerpt(input.narration),
    confidence: "signal" as const,
  };
  const narration = input.narration ?? "";
  const analysis = analyzeClaimReceipts({
    narration,
    receiptFamilies: input.receiptFamilies,
    proposalFamilies: input.proposalFamilies,
    contentBackedFamilies: input.receiptContentFamilies,
  });

  for (const claim of analysis.claimWithoutReceipt) {
    const receipts = input.receiptEvidence.length > 0 ? input.receiptEvidence.join(", ") : "none";
    const proposals = input.proposalEvidence.length > 0 ? input.proposalEvidence.join(", ") : "none";
    flags.push({
      ...base,
      class: "claim-without-receipt",
      evidence: appendContext(
        `narration claims ${claim.family} (matched "${claim.match}") but the turn has no`
        + ` ${claim.family} receipt or proposal; receipts=[${receipts}]; proposals=[${proposals}]`,
        input.context,
      ),
      severity: familyHasReceiptSource(claim.family) ? "actionable" : "informational",
    });
  }

  for (const family of analysis.receiptWithoutClaim) {
    flags.push({
      ...base,
      class: "receipt-without-claim",
      evidence: appendContext(
        `a ${family} receipt exists but the narration never mentions the ${family} lexicon`
        + ` (informational; the narration may summarize the outcome elsewhere);`
        + ` receipts=[${input.receiptEvidence.join(", ") || "unlisted"}]`,
        input.context,
      ),
      severity: "informational",
    });
  }

  if (input.lane !== null) {
    const verdict = classifyLaneActUncommitted({
      confidenceBand: input.lane.confidenceBand,
      hasSelection: input.lane.hasSelection,
      hasExecution: input.laneExecution,
      hasProposalBinding: input.laneProposalBinding,
      shadow: input.lane.shadow,
    });
    if (verdict !== null) {
      const pick = input.lane.candidateId ?? "an unknown candidate";
      const cancelled = input.state === "cancelled" || input.state === "failed";
      let evidence: string;
      if (verdict === "missing") {
        evidence = `adventure-selection band act picked ${pick}`
          + ` (method ${input.lane.method ?? "unknown"}) for decision ${input.lane.decisionId}`
          + ` but no execution and no proposal binding is attached to that decision`;
      } else if (verdict === "shadow-no-commit") {
        evidence = `adventure-selection band act picked ${pick}`
          + ` (method ${input.lane.method ?? "unknown"}) for decision ${input.lane.decisionId}`
          + ` but no execution and no proposal binding is attached to that decision;`
          + ` the decision is shadow (advisory), so it cannot commit by design`;
      } else {
        evidence = `adventure-selection band act picked ${pick} for decision ${input.lane.decisionId};`
          + ` binding(s)=[${input.laneBindingEvidence.join(", ") || "unlisted"}]`
          + ` exist without an execution`
          + `${input.confirmationEvidence ? `; confirmation: ${input.confirmationEvidence}` : ""}`
          + " (expected confirmation flow)";
      }
      flags.push({
        ...base,
        class: "lane-act-uncommitted",
        evidence: appendContext(evidence, input.context),
        severity: verdict === "missing" && !cancelled ? "actionable" : "informational",
        verdict,
      });
    }
  }

  if (input.combatOutcome !== null) {
    for (const outcome of classifyCombatOutcomeMismatch(input.combatOutcome)) {
      flags.push({
        ...base,
        class: "combat-outcome-mismatch",
        evidence: appendContext(`[${outcome.kind}] ${outcome.detail}`, input.context),
        severity: "actionable",
      });
    }
  }

  if (classifyNarrationMissing({
    state: input.state,
    narrationStatus: input.narrationStatus,
    narration: input.narration,
  })) {
    flags.push({
      ...base,
      class: "narration-missing",
      evidence: appendContext(
        `turn state=${input.state} narration_status=${input.narrationStatus}`
        + " but adventure_narration_dispatches_v60 holds no settled narration text",
        input.context,
      ),
      severity: "actionable",
    });
  }

  return flags;
}

// -------------------------------------------------------------------------------------------------
// CLI argument parsing
// -------------------------------------------------------------------------------------------------

export interface AuditCliOptions {
  world: string | null;
  json: string | null;
  md: string | null;
  failOn: AuditFlagClass[];
  /** Set only when `--help`/`-h` was requested; the pure parser never exits. */
  help?: boolean;
}

export const USAGE =
  "usage: audit-adventure-consistency.ts --world <path> [--json <path>] [--md <path>]"
  + " [--fail-on <class>[,<class>...]]...\n"
  + "\n"
  + "Reads <world>/velvet.sqlite read-only and joins declaration, lane pick, provider calls,\n"
  + "proposals/confirmations, receipts, and narration per turn.\n"
  + `flag classes: ${AUDIT_FLAG_CLASSES.join(", ")}\n`
  + "--json writes the machine-readable report; --md writes a Markdown report\n"
  + "--fail-on may repeat and accepts comma-separated classes; exit code becomes 1 when a\n"
  + "  matching flag is emitted (the expected confirmation wait and the shadow advisory\n"
  + "  no-commit of lane-act-uncommitted never fail)\n";

export function isAuditFlagClass(value: string): value is AuditFlagClass {
  return (AUDIT_FLAG_CLASSES as readonly string[]).includes(value);
}

export function parseAuditArgs(argv: readonly string[]): AuditCliOptions {
  let world: string | null = null;
  let json: string | null = null;
  let md: string | null = null;
  const failOn: AuditFlagClass[] = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--world" || arg.startsWith("--world=")) {
      const value = arg === "--world" ? argv[index += 1] : arg.slice("--world=".length);
      if (value === undefined || value.trim() === "") throw new Error("--world requires a path");
      world = value;
    } else if (arg === "--json" || arg.startsWith("--json=")) {
      const value = arg === "--json" ? argv[index += 1] : arg.slice("--json=".length);
      if (value === undefined || value.trim() === "") throw new Error("--json requires a path");
      json = path.resolve(value);
    } else if (arg === "--md" || arg.startsWith("--md=")) {
      const value = arg === "--md" ? argv[index += 1] : arg.slice("--md=".length);
      if (value === undefined || value.trim() === "") throw new Error("--md requires a path");
      md = path.resolve(value);
    } else if (arg === "--fail-on" || arg.startsWith("--fail-on=")) {
      const value = arg === "--fail-on" ? argv[index += 1] : arg.slice("--fail-on=".length);
      if (value === undefined || value.trim() === "") throw new Error("--fail-on requires a flag class");
      for (const rawClass of value.split(",")) {
        const candidate = rawClass.trim();
        if (candidate === "") continue;
        if (!isAuditFlagClass(candidate)) {
          throw new Error(`unknown flag class: ${candidate} (known: ${AUDIT_FLAG_CLASSES.join(", ")})`);
        }
        if (!failOn.includes(candidate)) failOn.push(candidate);
      }
    } else if (arg === "--help" || arg === "-h") {
      help = true;
      break;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (help) return { world, json, md, failOn, help: true };
  if (world === null) throw new Error("--world is required (for example --world .velvet/synth-srd-3)");
  return { world, json, md, failOn };
}

/** Resolves `--world` to the SQLite file: a directory gets `/velvet.sqlite`, a file is used as-is. */
export function resolveWorldDatabasePath(worldArg: string, cwd: string): string {
  const resolved = path.isAbsolute(worldArg) ? worldArg : path.resolve(cwd, worldArg);
  return resolved.endsWith(".sqlite") ? resolved : path.join(resolved, "velvet.sqlite");
}

// -------------------------------------------------------------------------------------------------
// Read-only SQLite reader
// -------------------------------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(error instanceof Error ? error.message : String(error));
}

/** Reads a table, tolerating an absent one as "empty" so older worlds still audit. */
function readTable(db: DatabaseSync, table: string, sql: string, notices: string[]): SqlRow[] {
  try {
    return db.prepare(sql).all() as unknown as SqlRow[];
  } catch (error) {
    if (isMissingTableError(error)) {
      notices.push(`table ${table} is absent; treating it as empty`);
      return [];
    }
    throw error;
  }
}

export interface CombatReceiptSummary {
  encounterId: string | null;
  resolutionKind: string | null;
  damageDealt: number;
  healApplied: number;
  statuses: string[];
  commandId: string;
  /** True when the receipt result JSON carries an unambiguous healing outcome or health gain. */
  healingEvidence: boolean;
}

/** Tolerant parse of one `combat_receipts_v27.canonical_result_json` document. */
export function parseCombatReceipt(
  commandId: string,
  canonicalResultJson: string,
): CombatReceiptSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalResultJson) as unknown;
  } catch {
    return null;
  }
  const result = asObject(parsed);
  if (result === null) return null;
  const encounterId = asString(result["encounterId"]);
  const combat = asObject(result["combat"]);
  const statuses: string[] = [];
  if (combat !== null && Array.isArray(combat["combatants"])) {
    for (const raw of combat["combatants"]) {
      const combatant = asObject(raw);
      const status = combatant === null ? null : asString(combatant["status"]);
      if (status !== null && !statuses.includes(status)) statuses.push(status);
    }
  }
  const resolution = asObject(result["resolution"]);
  const resolutionKind = resolution === null ? null : asString(resolution["kind"]);
  let damageDealt = 0;
  let healApplied = 0;
  if (resolution !== null && Array.isArray(resolution["outcomes"])) {
    for (const raw of resolution["outcomes"]) {
      const outcome = asObject(raw);
      if (outcome === null) continue;
      const kind = asString(outcome["kind"]);
      const applied = asNumber(outcome["applied"]) ?? asNumber(outcome["requested"]) ?? 0;
      if (kind === "damage" && applied > 0) damageDealt += applied;
      if (kind === "heal" && applied > 0) healApplied += applied;
      const statusAfter = asString(outcome["statusAfter"]);
      if (statusAfter !== null && !statuses.includes(statusAfter)) statuses.push(statusAfter);
    }
  }
  return {
    encounterId,
    resolutionKind,
    damageDealt,
    healApplied,
    statuses,
    commandId,
    healingEvidence: hasHealingEvidence(parsed),
  };
}

export interface AdventureAuditDataset {
  world: string;
  databasePath: string;
  turns: TurnAuditInput[];
  notices: string[];
}

function buildTurnInputs(
  db: DatabaseSync,
  notices: string[],
): TurnAuditInput[] {
  const turnRows = readTable(
    db,
    "adventure_turns",
    "SELECT id, declaration, state, narration_status, created_at FROM adventure_turns"
    + " ORDER BY created_at ASC, id ASC",
    notices,
  );

  // Settled narration: keep the latest settlement per turn (retries and swipes overwrite).
  const narrationByTurn = new Map<string, string>();
  for (const row of readTable(
    db,
    "adventure_narration_dispatches_v60",
    "SELECT turn_id, narration, claimed_at FROM adventure_narration_dispatches_v60"
    + " WHERE status = 'settled' AND narration IS NOT NULL ORDER BY claimed_at ASC, rowid ASC",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const narration = asString(row["narration"]);
    if (turnId !== null && narration !== null) narrationByTurn.set(turnId, narration);
  }

  // Newest adventure-selection decision per turn.
  const laneByTurn = new Map<string, LaneSelectionSnapshot>();
  for (const row of readTable(
    db,
    "system_one_decisions_v1",
    "SELECT decision_id, turn_id, confidence_band, shadow, selection_json FROM system_one_decisions_v1"
    + " WHERE lane = 'adventure-selection' ORDER BY created_at ASC, rowid ASC",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const decisionId = asString(row["decision_id"]);
    if (turnId === null || decisionId === null) continue;
    laneByTurn.set(turnId, parseLaneSelection({
      decisionId,
      confidenceBand: asString(row["confidence_band"]),
      selectionJson: asString(row["selection_json"]),
      // Legacy rows without the flag fall back to non-shadow: fail toward `missing`, not silence.
      shadow: (asNumber(row["shadow"]) ?? 0) === 1,
    }));
  }

  // Exact action executions/bindings (v56) link a lane decision id to its commit or its wait.
  const laneExecutedDecisions = new Set<string>();
  for (const row of readTable(
    db,
    "adventure_exact_action_executions_v56",
    "SELECT turn_id, action_kind, origin, command_id, system_one_decision_id"
    + " FROM adventure_exact_action_executions_v56",
    notices,
  )) {
    const decisionId = asString(row["system_one_decision_id"]);
    if (decisionId !== null) laneExecutedDecisions.add(decisionId);
  }
  for (const row of readTable(
    db,
    "adventure_check_executions_v54",
    "SELECT turn_id, command_id, origin, system_one_decision_id FROM adventure_check_executions_v54",
    notices,
  )) {
    const decisionId = asString(row["system_one_decision_id"]);
    if (decisionId !== null) laneExecutedDecisions.add(decisionId);
  }
  const laneBoundDecisions = new Map<string, string[]>();
  for (const row of readTable(
    db,
    "adventure_exact_action_proposal_bindings_v56",
    "SELECT proposal_id, turn_id, action_kind, origin, system_one_decision_id"
    + " FROM adventure_exact_action_proposal_bindings_v56",
    notices,
  )) {
    const decisionId = asString(row["system_one_decision_id"]);
    const proposalId = asString(row["proposal_id"]);
    if (decisionId === null || proposalId === null) continue;
    const existing = laneBoundDecisions.get(decisionId) ?? [];
    existing.push(proposalId);
    laneBoundDecisions.set(decisionId, existing);
  }

  // Tool proposals (executed or still awaiting a decision).
  const proposalsByTurn = new Map<string, { proposalId: string; toolName: string; requiresConfirmation: boolean }[]>();
  for (const row of readTable(
    db,
    "tool_proposals",
    "SELECT proposal_id, turn_id, tool_name, requires_confirmation FROM tool_proposals",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const proposalId = asString(row["proposal_id"]);
    const toolName = asString(row["tool_name"]);
    if (turnId === null || proposalId === null || toolName === null) continue;
    const list = proposalsByTurn.get(turnId) ?? [];
    list.push({
      proposalId,
      toolName,
      requiresConfirmation: (asNumber(row["requires_confirmation"]) ?? 0) === 1,
    });
    proposalsByTurn.set(turnId, list);
  }
  const confirmationByProposal = new Map<string, string>();
  for (const row of readTable(
    db,
    "confirmation_decisions",
    "SELECT turn_id, proposal_id, decision FROM confirmation_decisions",
    notices,
  )) {
    const proposalId = asString(row["proposal_id"]);
    const decision = asString(row["decision"]);
    if (proposalId !== null && decision !== null) confirmationByProposal.set(proposalId, decision);
  }

  // Turn -> command links. `final_receipt_links` is the canonical per-turn join; the generalized
  // and feature execution tables predate it and still carry direct turn ids.
  const commandLinksByTurn = new Map<string, Set<string>>();
  const addCommandLink = (turnId: string, commandId: string): void => {
    const set = commandLinksByTurn.get(turnId) ?? new Set<string>();
    set.add(commandId);
    commandLinksByTurn.set(turnId, set);
  };
  for (const row of readTable(
    db,
    "final_receipt_links",
    "SELECT turn_id, command_id FROM final_receipt_links WHERE turn_id IS NOT NULL",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const commandId = asString(row["command_id"]);
    if (turnId !== null && commandId !== null) addCommandLink(turnId, commandId);
  }
  for (const row of readTable(
    db,
    "agent_generalized_receipts_v39",
    "SELECT turn_id, command_id FROM agent_generalized_receipts_v39 WHERE receipt_family = 'combat'",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const commandId = asString(row["command_id"]);
    if (turnId !== null && commandId !== null) addCommandLink(turnId, commandId);
  }
  const exactByTurn = new Map<string, { actionKind: string | null; commandId: string | null; publicResultJson: string | null }>();
  for (const row of readTable(
    db,
    "adventure_exact_action_executions_v56",
    "SELECT turn_id, action_kind, command_id, public_result_json FROM adventure_exact_action_executions_v56",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    if (turnId === null) continue;
    exactByTurn.set(turnId, {
      actionKind: asString(row["action_kind"]),
      commandId: asString(row["command_id"]),
      publicResultJson: asString(row["public_result_json"]),
    });
    const commandId = asString(row["command_id"]);
    if (commandId !== null) addCommandLink(turnId, commandId);
  }
  for (const row of readTable(
    db,
    "adventure_check_executions_v54",
    "SELECT turn_id, command_id FROM adventure_check_executions_v54",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const commandId = asString(row["command_id"]);
    if (turnId !== null && commandId !== null) addCommandLink(turnId, commandId);
  }
  for (const row of readTable(
    db,
    "adventure_inventory_executions_v55",
    "SELECT turn_id, inventory_command_id FROM adventure_inventory_executions_v55",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const commandId = asString(row["inventory_command_id"]);
    if (turnId !== null && commandId !== null) addCommandLink(turnId, commandId);
  }
  for (const row of readTable(
    db,
    "adventure_commerce_executions_v57",
    "SELECT turn_id, command_id FROM adventure_commerce_executions_v57",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const commandId = asString(row["command_id"]);
    if (turnId !== null && commandId !== null) addCommandLink(turnId, commandId);
  }

  // Receipt indexes keyed by command id.
  const m15FamilyByCommand = new Map<string, string>();
  for (const row of readTable(
    db,
    "rpg_m15_commands_v25",
    "SELECT command_id, command_family, command_type FROM rpg_m15_commands_v25",
    notices,
  )) {
    const commandId = asString(row["command_id"]);
    if (commandId !== null) m15FamilyByCommand.set(commandId, asString(row["command_family"]) ?? "");
  }
  const m15ResultByCommand = new Map<string, string>();
  for (const row of readTable(
    db,
    "rpg_m15_receipts_v25",
    "SELECT command_id, canonical_result_json, changed_keys_json FROM rpg_m15_receipts_v25",
    notices,
  )) {
    const commandId = asString(row["command_id"]);
    const result = asString(row["canonical_result_json"]);
    if (commandId !== null && result !== null) m15ResultByCommand.set(commandId, result);
  }
  const m16FamilyByCommand = new Map<string, string>();
  for (const row of readTable(
    db,
    "rpg_m16_commands_v26",
    "SELECT command_id, command_family, command_type FROM rpg_m16_commands_v26",
    notices,
  )) {
    const commandId = asString(row["command_id"]);
    if (commandId !== null) m16FamilyByCommand.set(commandId, `${asString(row["command_family"]) ?? ""}:${asString(row["command_type"]) ?? ""}`);
  }
  const m16ResultByCommand = new Map<string, string>();
  for (const row of readTable(
    db,
    "rpg_m16_receipts_v26",
    "SELECT command_id, canonical_result_json FROM rpg_m16_receipts_v26",
    notices,
  )) {
    const commandId = asString(row["command_id"]);
    const result = asString(row["canonical_result_json"]);
    if (commandId !== null && result !== null) m16ResultByCommand.set(commandId, result);
  }
  const restCommands = new Set<string>();
  for (const row of readTable(
    db,
    "rpg_rest_receipts_v25",
    "SELECT command_id FROM rpg_rest_receipts_v25",
    notices,
  )) {
    const commandId = asString(row["command_id"]);
    if (commandId !== null) restCommands.add(commandId);
  }
  const combatByCommand = new Map<string, CombatReceiptSummary>();
  const combatantsByEncounter = new Map<string, CombatTargetStatus[]>();
  for (const row of readTable(
    db,
    "combatant",
    "SELECT encounter_id, combatant_id, actor_id, combatant_kind, hit_points, status FROM combatant",
    notices,
  )) {
    const encounterId = asString(row["encounter_id"]);
    if (encounterId === null) continue;
    const list = combatantsByEncounter.get(encounterId) ?? [];
    list.push({
      name: asString(row["actor_id"]) ?? asString(row["combatant_id"]) ?? "combatant",
      status: asString(row["status"]) ?? "unknown",
      hitPoints: asNumber(row["hit_points"]) ?? 0,
    });
    combatantsByEncounter.set(encounterId, list);
  }
  for (const row of readTable(
    db,
    "combat_receipts_v27",
    "SELECT encounter_id, command_id, canonical_result_json FROM combat_receipts_v27",
    notices,
  )) {
    const commandId = asString(row["command_id"]);
    const canonical = asString(row["canonical_result_json"]);
    if (commandId === null || canonical === null) continue;
    const summary = parseCombatReceipt(commandId, canonical);
    if (summary === null) continue;
    if (summary.encounterId === null) summary.encounterId = asString(row["encounter_id"]);
    combatByCommand.set(commandId, summary);
  }

  // Provider and tool call context per turn.
  const providerCallsByTurn = new Map<string, number>();
  for (const row of readTable(
    db,
    "agent_decision_rounds_v38",
    "SELECT turn_id, COUNT(*) AS calls FROM agent_decision_rounds_v38 GROUP BY turn_id",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const calls = asNumber(row["calls"]);
    if (turnId !== null && calls !== null) providerCallsByTurn.set(turnId, calls);
  }
  const toolCallsByTurn = new Map<string, string[]>();
  for (const row of readTable(
    db,
    "agent_tool_calls_v38",
    "SELECT turn_id, tool_name FROM agent_tool_calls_v38 ORDER BY round_number ASC, position ASC",
    notices,
  )) {
    const turnId = asString(row["turn_id"]);
    const toolName = asString(row["tool_name"]);
    if (turnId === null || toolName === null) continue;
    const list = toolCallsByTurn.get(turnId) ?? [];
    if (!list.includes(toolName)) list.push(toolName);
    toolCallsByTurn.set(turnId, list);
  }

  // World and quest receipts link through command ids; world receipts are travel/movement shaped.
  const commandFamilyHints = new Map<string, ClaimFamily[]>();
  for (const table of ["world_receipts_v28", "quest_domain_receipts_v33"] as const) {
    const family: ClaimFamily = table === "world_receipts_v28" ? "movement" : "quest";
    for (const row of readTable(
      db,
      table,
      `SELECT command_id FROM ${table}`,
      notices,
    )) {
      const commandId = asString(row["command_id"]);
      if (commandId === null) continue;
      const list = commandFamilyHints.get(commandId) ?? [];
      if (!list.includes(family)) list.push(family);
      commandFamilyHints.set(commandId, list);
    }
  }

  const turns: TurnAuditInput[] = [];
  for (const row of turnRows) {
    const turnId = asString(row["id"]);
    if (turnId === null) continue;
    const declaration = asString(row["declaration"]) ?? "";
    const state = asString(row["state"]) ?? "unknown";
    const narrationStatus = asString(row["narration_status"]) ?? "unknown";
    const narration = narrationByTurn.get(turnId) ?? null;
    const lane = laneByTurn.get(turnId) ?? null;

    const commandIds = [...(commandLinksByTurn.get(turnId) ?? [])];
    const receiptFamilies: ClaimFamily[] = [];
    const receiptContentFamilies: ClaimFamily[] = [];
    const receiptEvidence: string[] = [];
    const addReceiptFamily = (family: ClaimFamily | null, evidence: string): void => {
      if (family !== null && !receiptFamilies.includes(family)) receiptFamilies.push(family);
      if (!receiptEvidence.includes(evidence)) receiptEvidence.push(evidence);
    };
    const addReceiptContent = (family: ClaimFamily, evidence: string): void => {
      if (!receiptContentFamilies.includes(family)) receiptContentFamilies.push(family);
      if (!receiptEvidence.includes(evidence)) receiptEvidence.push(evidence);
    };
    const combatCommandIds: string[] = [];
    for (const commandId of commandIds) {
      const exact = exactByTurn.get(turnId);
      const exactKind = exact !== undefined && exact.commandId === commandId ? exact.actionKind : null;
      if (exactKind !== null) {
        addReceiptFamily(
          familyForExactActionKind(exactKind),
          `adventure_exact_action_executions_v56:${exactKind}`,
        );
      }
      // A combat-power (or any other exact action) whose result JSON carries a healing outcome
      // backs a healing claim even though its action family is `power`.
      if (exact !== undefined && exact.commandId === commandId
        && exact.publicResultJson !== null && jsonHasHealingEvidence(exact.publicResultJson)) {
        addReceiptContent(
          "healing",
          `adventure_exact_action_executions_v56:${exactKind ?? "unknown"} healing outcome`
          + ` (${commandId.slice(0, 12)})`,
        );
      }
      const combat = combatByCommand.get(commandId);
      if (combat !== undefined) {
        combatCommandIds.push(commandId);
        const combatFamilies = new Set<ClaimFamily>();
        if (combat.resolutionKind === "attack" || combat.damageDealt > 0) combatFamilies.add("attack");
        if (combat.healApplied > 0 || combat.resolutionKind === "use-consumable") {
          combatFamilies.add("healing");
        }
        for (const family of combatFamilies) {
          addReceiptFamily(
            family,
            `combat_receipts_v27:${combat.resolutionKind ?? "unknown"}`
            + `${combat.damageDealt > 0 ? ` damage=${combat.damageDealt}` : ""}`
            + `${combat.healApplied > 0 ? ` heal=${combat.healApplied}` : ""}`
            + ` (${commandId.slice(0, 12)})`,
          );
        }
        if (combat.healingEvidence) {
          addReceiptContent("healing", `combat_receipts_v27:healing outcome (${commandId.slice(0, 12)})`);
        }
        continue;
      }
      if (restCommands.has(commandId)) {
        addReceiptFamily("rest", `rpg_rest_receipts_v25 (${commandId.slice(0, 12)})`);
        continue;
      }
      const m16Family = m16FamilyByCommand.get(commandId);
      if (m16Family !== undefined) {
        if (m16Family.startsWith("check:")) addReceiptFamily("check", `rpg_m16_commands_v26:${m16Family}`);
        if (m16Family.startsWith("power:")) addReceiptFamily("power", `rpg_m16_commands_v26:${m16Family}`);
        const m16Result = m16ResultByCommand.get(commandId);
        if (m16Result !== undefined && jsonHasHealingEvidence(m16Result)) {
          addReceiptContent("healing", `rpg_m16_receipts_v26:healing outcome (${commandId.slice(0, 12)})`);
        }
        continue;
      }
      const m15Family = m15FamilyByCommand.get(commandId);
      const m15Result = m15ResultByCommand.get(commandId);
      if (m15Family !== undefined || m15Result !== undefined) {
        if (m15Family === "rest") addReceiptFamily("rest", `rpg_m15_commands_v25:rest (${commandId.slice(0, 12)})`);
        const resultText = m15Result ?? "";
        if (/"(?:consumable|potion)"/i.test(resultText) || /"heal(?:ing)?"\s*:/i.test(resultText)) {
          addReceiptFamily("healing", `rpg_m15_receipts_v25:consumable (${commandId.slice(0, 12)})`);
        }
        if (jsonHasHealingEvidence(resultText)) {
          addReceiptContent("healing", `rpg_m15_receipts_v25:healing outcome (${commandId.slice(0, 12)})`);
        }
        continue;
      }
      const hints = commandFamilyHints.get(commandId);
      if (hints !== undefined) {
        for (const family of hints) addReceiptFamily(family, `${family === "movement" ? "world_receipts_v28" : "quest_domain_receipts_v33"} (${commandId.slice(0, 12)})`);
      }
    }

    // Proposals that never produced an execution stay "proposal" evidence and suppress
    // claim-without-receipt just like a receipt would.
    const proposalFamilies: ClaimFamily[] = [];
    const proposalEvidence: string[] = [];
    const proposals = proposalsByTurn.get(turnId) ?? [];
    for (const proposal of proposals) {
      for (const family of familiesForToolName(proposal.toolName)) {
        if (!proposalFamilies.includes(family)) proposalFamilies.push(family);
        proposalEvidence.push(`${proposal.toolName} (${proposal.proposalId.slice(0, 12)})`);
      }
    }
    for (let index = proposalFamilies.length - 1; index >= 0; index -= 1) {
      const family = proposalFamilies[index]!;
      if (receiptFamilies.includes(family)) proposalFamilies.splice(index, 1);
    }

    const confirmationEvidence: string | null = proposals.length === 0
      ? null
      : proposals
        .map((proposal) => {
          const decision = confirmationByProposal.get(proposal.proposalId) ?? "pending";
          return `${proposal.proposalId.slice(0, 12)}=${decision}`;
        })
        .join(", ");

    let combatOutcome: CombatOutcomeInput | null = null;
    if (combatCommandIds.length > 0) {
      let damageDealt = 0;
      const receiptStatuses: string[] = [];
      const encounterIds = new Set<string>();
      for (const commandId of combatCommandIds) {
        const combat = combatByCommand.get(commandId);
        if (combat === undefined) continue;
        damageDealt += combat.damageDealt;
        for (const status of combat.statuses) {
          if (!receiptStatuses.includes(status)) receiptStatuses.push(status);
        }
        if (combat.encounterId !== null) encounterIds.add(combat.encounterId);
      }
      const targets: CombatTargetStatus[] = [];
      for (const encounterId of encounterIds) {
        for (const target of combatantsByEncounter.get(encounterId) ?? []) targets.push(target);
      }
      combatOutcome = { narration: narration ?? "", damageDealt, receiptStatuses, targets };
    }

    const laneExecution = lane !== null && laneExecutedDecisions.has(lane.decisionId);
    const laneProposalBinding = lane !== null && laneBoundDecisions.has(lane.decisionId);
    const laneBindingEvidence = lane === null ? [] : laneBoundDecisions.get(lane.decisionId) ?? [];
    const toolNames = toolCallsByTurn.get(turnId) ?? [];
    const providerCalls = providerCallsByTurn.get(turnId) ?? 0;
    const contextParts = [
      `providerCalls=${providerCalls}`,
      `toolCalls=[${toolNames.join(", ")}]`,
      `laneBand=${lane?.confidenceBand ?? "none"}`,
      `state=${state}`,
    ];

    turns.push({
      turnId,
      declaration,
      state,
      narrationStatus,
      narration,
      lane,
      laneExecution,
      laneProposalBinding,
      laneBindingEvidence,
      confirmationEvidence,
      receiptFamilies,
      receiptEvidence,
      receiptContentFamilies,
      proposalFamilies,
      proposalEvidence,
      combatOutcome,
      context: contextParts.join("; "),
    });
  }
  return turns;
}

export function loadAdventureAuditDataset(databasePath: string, world: string): AdventureAuditDataset {
  const notices: string[] = [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    return { world, databasePath, turns: buildTurnInputs(db, notices), notices };
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // The read is done; a close failure must not mask the report.
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Reports
// -------------------------------------------------------------------------------------------------

export interface AuditReportDocument {
  version: 1;
  generatedAt: string;
  world: string;
  databasePath: string;
  headerNote: string;
  counts: Record<AuditFlagClass, number>;
  informationalCount: number;
  flags: AuditFlag[];
  notices: string[];
}

export function countFlagsByClass(flags: readonly AuditFlag[]): Record<AuditFlagClass, number> {
  const counts = Object.fromEntries(AUDIT_FLAG_CLASSES.map((flagClass) => [flagClass, 0])) as Record<AuditFlagClass, number>;
  for (const flag of flags) counts[flag.class] += 1;
  return counts;
}

export function buildAuditReport(input: {
  world: string;
  databasePath: string;
  turnsRead: number;
  flags: readonly AuditFlag[];
  notices: readonly string[];
  generatedAt: string;
}): AuditReportDocument {
  const sorted = sortAuditFlags(input.flags);
  return {
    version: 1,
    generatedAt: input.generatedAt,
    world: input.world,
    databasePath: input.databasePath,
    headerNote: AUDIT_HEADER_NOTE,
    counts: countFlagsByClass(sorted),
    informationalCount: sorted.filter((flag) => flag.severity === "informational").length,
    flags: sorted,
    notices: [...input.notices],
  };
}

export function serializeAuditReport(document: AuditReportDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface AuditSummaryInput {
  world: string;
  databasePath: string;
  turnsRead: number;
  flags: readonly AuditFlag[];
  notices: readonly string[];
  generatedAt: string;
  /** Max example flags printed after the count table. */
  exampleLimit?: number;
}

export function renderAuditSummary(input: AuditSummaryInput): string {
  const sorted = sortAuditFlags(input.flags);
  const counts = countFlagsByClass(sorted);
  const informational = sorted.filter((flag) => flag.severity === "informational").length;
  const lines: string[] = [];
  lines.push(`Adventure consistency audit — ${input.world}`);
  lines.push(`Database: ${input.databasePath}`);
  lines.push(`Generated ${input.generatedAt} · turns read ${input.turnsRead}`);
  lines.push("");
  lines.push(AUDIT_HEADER_NOTE);
  lines.push("");
  lines.push(`Flags: ${sorted.length} (actionable ${sorted.length - informational}, informational ${informational})`);
  const classWidth = Math.max("Class".length, ...AUDIT_FLAG_CLASSES.map((flagClass) => flagClass.length));
  const countWidth = Math.max("Flags".length, ...AUDIT_FLAG_CLASSES.map((flagClass) => String(counts[flagClass]).length));
  lines.push(`${"Class".padEnd(classWidth)}  ${"Flags".padStart(countWidth)}  Informational`);
  lines.push(`${"-".repeat(classWidth)}  ${"-".repeat(countWidth)}  -------------`);
  for (const flagClass of AUDIT_FLAG_CLASSES) {
    const info = sorted.filter(
      (flag) => flag.class === flagClass && flag.severity === "informational",
    ).length;
    lines.push(`${flagClass.padEnd(classWidth)}  ${String(counts[flagClass]).padStart(countWidth)}  ${info === 0 ? "-" : String(info)}`);
  }
  lines.push("");
  const exampleLimit = input.exampleLimit ?? 5;
  if (sorted.length > 0 && exampleLimit > 0) {
    lines.push(`Example flags (${Math.min(exampleLimit, sorted.length)} of ${sorted.length}):`);
    for (const flag of sorted.slice(0, exampleLimit)) {
      lines.push(`- [${flag.class}/${flag.severity}${flag.verdict ? `:${flag.verdict}` : ""}] turn ${flag.turnId}`);
      lines.push(`  declaration: ${flag.declaration}`);
      lines.push(`  evidence: ${flag.evidence}`);
      if (flag.narrationExcerpt.length > 0) lines.push(`  narration: ${flag.narrationExcerpt}`);
    }
    lines.push("");
  }
  if (input.notices.length > 0) {
    lines.push("Notices:");
    for (const notice of input.notices) lines.push(`- ${notice}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderAuditMarkdown(document: AuditReportDocument): string {
  const lines: string[] = [];
  lines.push(`# Adventure consistency audit — ${document.world}`);
  lines.push("");
  lines.push(`> ${document.headerNote}`);
  lines.push("");
  lines.push(`- Generated: ${document.generatedAt}`);
  lines.push(`- Database: \`${document.databasePath}\``);
  lines.push(`- Flags: ${document.flags.length} (informational ${document.informationalCount})`);
  lines.push("");
  lines.push("## Counts by class");
  lines.push("");
  lines.push("| Class | Flags | Informational |");
  lines.push("| --- | ---: | ---: |");
  for (const flagClass of AUDIT_FLAG_CLASSES) {
    const info = document.flags.filter(
      (flag) => flag.class === flagClass && flag.severity === "informational",
    ).length;
    lines.push(`| ${flagClass} | ${document.counts[flagClass]} | ${info} |`);
  }
  lines.push("");
  lines.push("## Flags");
  lines.push("");
  if (document.flags.length === 0) {
    lines.push("No flags were emitted for this world.");
    lines.push("");
  }
  for (const flagClass of AUDIT_FLAG_CLASSES) {
    const flags = document.flags.filter((flag) => flag.class === flagClass);
    if (flags.length === 0) continue;
    lines.push(`### ${flagClass} (${flags.length})`);
    lines.push("");
    for (const flag of flags) {
      lines.push(`- **turn \`${flag.turnId}\`** [${flag.severity}${flag.verdict ? `:${flag.verdict}` : ""}]`);
      lines.push(`  - declaration: ${flag.declaration}`);
      lines.push(`  - evidence: ${flag.evidence}`);
      if (flag.narrationExcerpt.length > 0) lines.push(`  - narration: ${flag.narrationExcerpt}`);
    }
    lines.push("");
  }
  if (document.notices.length > 0) {
    lines.push("## Notices");
    lines.push("");
    for (const notice of document.notices) lines.push(`- ${notice}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Flags that make `--fail-on` exit non-zero. Naming a class is an explicit request, so
 * informational flags of that class count too; the exceptions are the expected states of
 * `lane-act-uncommitted` — a confirmation wait and a shadow (advisory) pick that cannot commit
 * by design — which are never failures.
 */
export function flagsTriggeringFailure(
  flags: readonly AuditFlag[],
  failOn: readonly AuditFlagClass[],
): AuditFlag[] {
  if (failOn.length === 0) return [];
  return flags.filter((flag) => {
    if (!failOn.includes(flag.class)) return false;
    if (flag.verdict === "awaiting-confirmation" || flag.verdict === "shadow-no-commit") return false;
    return true;
  });
}

// -------------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseAuditArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  const world = options.world!;
  const databasePath = resolveWorldDatabasePath(world, process.cwd());
  if (!existsSync(databasePath)) {
    throw new Error(`no Velvet database found at ${databasePath} (--world ${world})`);
  }
  const dataset = loadAdventureAuditDataset(databasePath, world);
  const flags = sortAuditFlags(dataset.turns.flatMap((turn) => auditTurn(turn)));
  const generatedAt = new Date().toISOString();
  const report = buildAuditReport({
    world: dataset.world,
    databasePath: dataset.databasePath,
    turnsRead: dataset.turns.length,
    flags,
    notices: dataset.notices,
    generatedAt,
  });

  process.stdout.write(renderAuditSummary({
    world: dataset.world,
    databasePath: dataset.databasePath,
    turnsRead: dataset.turns.length,
    flags,
    notices: dataset.notices,
    generatedAt,
  }));

  if (options.json !== null) {
    mkdirSync(path.dirname(options.json), { recursive: true });
    writeFileSync(options.json, serializeAuditReport(report), "utf8");
    process.stdout.write(`wrote ${options.json}\n`);
  }
  if (options.md !== null) {
    mkdirSync(path.dirname(options.md), { recursive: true });
    writeFileSync(options.md, renderAuditMarkdown(report), "utf8");
    process.stdout.write(`wrote ${options.md}\n`);
  }

  const failing = flagsTriggeringFailure(flags, options.failOn);
  if (failing.length > 0) {
    const classes = [...new Set(failing.map((flag) => flag.class))].join(", ");
    process.stderr.write(`fail-on triggered: ${failing.length} actionable flag(s) in ${classes}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

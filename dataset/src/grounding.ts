/**
 * Family B's fail-closed semantic gate. Presence of receipt words/numbers is not
 * proof: each complete clause must bind to one authoritative fact, including the
 * roles of its numbers. The deliberately bounded grammar sends unfamiliar prose
 * to adjudication rather than certifying it by substring matching.
 *
 * Supported check/damage surfaces compose from three forms:
 * - complete actor/skill or actor/target records, with labelled fields separated
 *   by periods/semicolons (commas inside a field keep their value association);
 * - explicit receipt-ID records, or bounded bold mechanical headings, whose
 *   entire body stays on one fact; ordinal headings convey no receipt identity;
 * - anchored mechanical sentences: check success/failure with DC/total, attack
 *   hit/miss with typed damage, possessive HP transitions and explicit status.
 * Named check/attack declarations open natural-sentence scopes. Follow-up
 * totals/results stay on that fact; a pronoun needs an established event focus.
 * Unknown/ambiguous prose clears the natural-sentence scope.
 * Unknown fields, suffixes and sibling prose remain adjudication evidence.
 */
import { analyzeClaimReceipts } from "../../scripts/audit-adventure-consistency.js";
import type { providerNarrationMatchesReceipts } from "../../server/src/routes/rpg/v1/adventureTurns.js";
import {
  resolvePublicSceneFacts,
  type BoundSceneObservation,
  type PublicContextMode,
  type PublicSceneFact,
  type ScenePredicate,
  type SceneScope,
  type SceneValue,
  type VerifiedPublicSceneAuthority,
} from "./publicSceneFacts.js";

export const GROUNDING_VALIDATOR_VERSION = "grounding-binding-v6";
/** The opt-in path adds source-bound public observations: a different grammar. */
export const PUBLIC_SCENE_GROUNDING_VALIDATOR_VERSION = `${GROUNDING_VALIDATOR_VERSION}+public-scene-v1`;

type ProductionReceipt = Parameters<typeof providerNarrationMatchesReceipts>[1][number];
type CombatStatus = "active" | "unconscious" | "stable" | "defeated" | "dead";
interface ReceiptContext {
  receiptId?: string;
  /** Names must come from the authoritative context, never from the narration. */
  actor?: string;
  target?: string;
  visibility?: "public" | "private" | "hidden";
}
interface DamageReceipt {
  applied: number;
  hitPointsAfter: number;
  hitPointsBefore?: number;
  statusAfter?: CombatStatus;
  hit?: boolean;
  damageType?: string;
}

/** Accept production receipts as well as the historical, smaller foundry shapes. */
export type GroundingReceipt = ReceiptContext & (ProductionReceipt
  | { kind: "check"; skill?: string | null; ability?: string; total: number; dc: number; outcome: string; difficulty?: string; rolls?: Array<{ value: number }> }
  | { kind: "combat"; action?: string; outcome: DamageReceipt & { kind: "damage" } }
  | (DamageReceipt & { kind: "combat-damage" })
  | { kind: "inventory"; itemLabel: string; quantity: number; action: string }
  | { kind: "rest"; restName: string }
  | { kind: "progression"; className: string; levelAfter: number });

export interface AuthoritativeValue {
  role: "total" | "dc" | "damage-applied" | "hp-before" | "hp-after";
  value: number;
  unit: "check-points" | "hit-points";
}
export interface AuthoritativeFact {
  receiptId: string;
  family: string;
  actor: string | null;
  target: string | null;
  action: string;
  damageType: string | null;
  difficulty: string | null;
  subject: string | null;
  values: readonly AuthoritativeValue[];
  outcome: string | null;
  /** This is statusAfter, NOT a status deduced from hitPointsAfter. */
  status: string | null;
  visibility: "public" | "private" | "hidden";
  implemented: boolean;
}
export interface BindingViolation {
  code: string;
  detail: string;
  excerpt: string;
  receiptId?: string;
}
export interface GroundingAdjudication extends BindingViolation {
  resolution: string;
}
export interface ClauseBinding {
  clause: string;
  receiptId: string;
  roles: readonly string[];
}
interface VerdictEvidence {
  facts: readonly AuthoritativeFact[];
  bindings: readonly ClauseBinding[];
  bindingsChecked: number;
  /** Present only on the opt-in public-scene path; absent otherwise, byte for byte. */
  sceneProvenance?: PublicSceneGroundingProvenance;
}
/**
 * Three DISTINCT sets, never collapsed into `bindingsChecked`: the receipts this
 * task requires, the scene facts this arm was actually exposed, and their union.
 * An optional observation must never be counted as mechanical coverage, and
 * mechanical coverage must never be excused by an observation.
 */
export interface PublicSceneGroundingProvenance {
  readonly manifestDigest: string;
  readonly mode: PublicContextMode;
  readonly sourceId: string;
  readonly sourceCanonicalDigest: string;
  readonly scope: SceneScope;
  readonly requiredMechanicalIds: readonly string[];
  readonly allowedSceneFactIds: readonly string[];
  readonly knownBindingIds: readonly string[];
  readonly unknownBindings: readonly string[];
  readonly missingMechanical: readonly string[];
  readonly usedSceneFactIds: readonly string[];
  readonly mechanicalBindingsChecked: number;
  readonly observationBindingsChecked: number;
  readonly observations: readonly BoundSceneObservation[];
}
export type GroundingVerdict = VerdictEvidence & (
  | { verdict: "verified"; ok: true }
  | { verdict: "adjudication-required"; ok: false; adjudications: readonly GroundingAdjudication[] }
  | { verdict: "rejected"; ok: false; violations: readonly BindingViolation[]; adjudications: readonly GroundingAdjudication[] }
);

export class GroundingFailure extends Error {
  readonly violations: readonly BindingViolation[];
  constructor(violations: readonly BindingViolation[]) {
    super(`narration is not grounded in the receipt: ${violations.map((v) => `${v.code} (${v.detail})`).join("; ")}`);
    this.name = "GroundingFailure";
    this.violations = violations;
  }
}
/** The legacy throw/no-throw API must never turn adjudication into admission. */
export class GroundingAdjudicationRequired extends GroundingFailure {
  readonly adjudications: readonly GroundingAdjudication[];
  constructor(adjudications: readonly GroundingAdjudication[]) {
    super(adjudications.map((issue) => ({ ...issue, code: "adjudication-required", detail: `${issue.code}: ${issue.detail}. Resolution: ${issue.resolution}` })));
    this.name = "GroundingAdjudicationRequired";
    this.adjudications = adjudications;
  }
}

/**
 * The validated scene context of one scheduled unit. Resolved and re-validated
 * inside the evaluator: carrying these fields on an oracle is not wiring.
 */
export interface PublicSceneGroundingContext {
  readonly unitId: string;
  readonly scope: SceneScope;
  readonly facts: readonly PublicSceneFact[];
  readonly authority: VerifiedPublicSceneAuthority;
}

export interface GroundingOptions {
  /** Exact, atomic public clauses established by the world, not keyword licenses. */
  authorizedConsequences?: readonly string[];
  forbiddenConsequences?: readonly string[];
  /**
   * Opt-in source-bound public observations. Additive: when absent the existing
   * grammar and evidence bytes are exactly what they were.
   */
  publicScene?: PublicSceneGroundingContext;
}

const normalize = (text: string): string => text.toLocaleLowerCase("en-US").replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
const entity = (text: string): string => normalize(text).replace(/^the\s+/, "");
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const numeric = (role: AuthoritativeValue["role"], value: number): AuthoritativeValue => ({
  role, value, unit: role === "total" || role === "dc" ? "check-points" : "hit-points",
});

/** No production family can disappear through a missing branch. */
export function authoritativeFacts(receipts: readonly GroundingReceipt[]): AuthoritativeFact[] {
  return receipts.map((receipt, index) => {
    const base: AuthoritativeFact = {
      receiptId: receipt.receiptId ?? `receipt-${index + 1}`, family: receipt.kind,
      actor: receipt.actor ?? null, target: receipt.target ?? null, action: receipt.kind,
      damageType: null, difficulty: null,
      subject: null, values: [], outcome: null, status: null,
      visibility: receipt.visibility ?? "public", implemented: false,
    };
    if (receipt.kind === "check") return {
      ...base, family: "check", action: "check", actor: receipt.actor ?? "you",
      subject: receipt.skill ?? receipt.ability ?? null,
      // Legacy fixtures omit the label. These are the production D&D DC labels
      // (server/src/rulesets/dnd5e/descriptor.ts), not outcome/HP inferences.
      difficulty: receipt.difficulty ?? new Map([[5, "Very Easy"], [10, "Easy"], [15, "Medium"], [20, "Hard"], [25, "Very Hard"], [30, "Nearly Impossible"]]).get(receipt.dc) ?? null,
      values: [numeric("total", receipt.total), numeric("dc", receipt.dc)],
      outcome: normalize(receipt.outcome), implemented: true,
    };
    const damage = receipt.kind === "combat-damage" ? receipt
      : receipt.kind === "combat" && receipt.outcome.kind === "damage" ? receipt.outcome : null;
    if (damage) return {
      ...base, family: "damage", action: receipt.kind === "combat" ? receipt.action ?? "attack" : "attack",
      values: [numeric("damage-applied", damage.applied), numeric("hp-after", damage.hitPointsAfter),
        ...(damage.hitPointsBefore === undefined ? [] : [numeric("hp-before", damage.hitPointsBefore)])],
      outcome: damage.hit === undefined ? null : damage.hit ? "hit" : "miss",
      status: damage.statusAfter ?? null, implemented: true,
      damageType: damage.damageType ?? null,
    };
    return base;
  });
}

/** Recursive mechanical clause splitter. Shared by both grammar paths. */
function splitClauses(text: string): string[] {
  const clause = text.trim();
  if (!clause) return [];
  if (parseClause(clause)) return [clause];
  for (const boundary of [/[;:]+/u, /,+/u, /\b(?:and|but|yet|however|whereas|while)\b/iu]) {
    const parts = clause.split(boundary);
    if (parts.length > 1) return parts.flatMap(splitClauses);
  }
  return [clause];
}

/** Keep complete mechanical schemas intact before considering clause boundaries. */
function clausesOf(text: string): string[] {
  return text.split(/\n\s*\n/u).flatMap(recordScopes).flatMap((paragraph) => {
    // A field record is one scope even when its fields are period-separated.
    // An unknown field must not be dropped by retrying its known fragments.
    if (recordHeader(paragraph.trim())) return [paragraph.trim()];
    return paragraph.split(/[!?\n]+|\.(?!\d)/u).flatMap(splitClauses);
  });
}

interface OutcomeClaim { value: "success" | "failure"; excerpt: string }
/** Collect EVERY occurrence, including both sides of a self-contradiction. */
function polaritiesOf(text: string): OutcomeClaim[] {
  const result: OutcomeClaim[] = [];
  for (const match of text.matchAll(/\b(?:unsuccessful(?:ly)?|success(?:ful(?:ly)?)?|succeed(?:s|ed)?|failure|fail(?:s|ed)?)\b/gi)) {
    const prefix = text.slice(0, match.index);
    const negated = /\b(?:no|not|never|without|cannot|can't|couldn't)\s+(?:a\s+)?$/i.test(prefix);
    const positive = /^(?:success|succeed)/i.test(match[0]);
    result.push({ value: positive !== negated ? "success" : "failure", excerpt: match[0] });
  }
  return result;
}

interface Claim {
  family: "check" | "damage";
  actor: string | null;
  target: string | null;
  subject: string | null;
  values: AuthoritativeValue[];
  outcomes: readonly OutcomeClaim[];
  status: string | null;
  attackOutcome: "hit" | "miss" | null;
  action: string | null;
  damageType: string | null;
  difficulty: string | null;
  complete: boolean;
  receiptId?: string;
  receiptKind?: string;
  visibility?: string;
  /** Every component of a labelled schema binds to the SAME fact. */
  components?: readonly Claim[];
  /** Structural records never inherit an unrelated preceding receipt. */
  scopedRecord?: boolean;
  unknownFragments?: readonly string[];
  /** Original component text, so unknown sibling metadata cannot imply time. */
  excerpt?: string;
  /** Follow-up predicates need a previously established, same-family scope. */
  continuation?: "fact" | "attack";
  /** Grammatical focus can differ from receipt roles (e.g. takes damage from). */
  focus?: "event" | "target";
}
function claim(family: Claim["family"], fields: Partial<Claim> = {}): Claim {
  return { family, actor: null, target: null, subject: null, values: [], outcomes: [], status: null, attackOutcome: null, action: null, damageType: null, difficulty: null, complete: true, ...fields };
}
function checkIdentity(head: string): Pick<Claim, "actor" | "target" | "subject"> {
  const targeted = /^(.*?)\s+check\s+(?:against|on)\s+(.+)$/i.exec(head);
  let subject = (targeted?.[1] ?? head).replace(/\s+check$/i, "").trim();
  let actor: string | null = null;
  const possessive = /^(.+?)['’]s\s+(.+)$/.exec(subject);
  if (possessive) { actor = possessive[1] ?? null; subject = possessive[2] ?? ""; }
  else if (/^your\s+/i.test(subject)) { actor = "you"; subject = subject.replace(/^your\s+/i, ""); }
  subject = subject.replace(/^the\s+/i, "");
  return { actor, target: targeted?.[2] ?? null, subject: subject || null };
}
function damageActor(head: string): string | null {
  if (/^(?:the\s+)?(?:attack|blade|blow|strike)$/i.test(head)) return null;
  if (/^your\s+(?:attack|blade|blow|strike)$/i.test(head)) return "you";
  return head.replace(/['’]s\s+(?:attack|blade|blow|strike)$/i, "");
}
function damageTarget(head: string): string | null {
  return /^(?:the\s+)?(?:target|combatant)$/i.test(head) ? null : head.replace(/^(?:the\s+)?target\s+/i, "");
}

const NUMBER = "(-?\\d+(?:\\.\\d+)?)";
// The article before the DC label must accept "an" as well as "a": "an Easy DC"
// is the ordinary phrasing, and rejecting it made the whole clause unparseable.
// An unparsed clause falls through to a subject-less outcome claim, which then
// inherits the PREVIOUSLY bound receipt -- so the second check in a narration was
// never bound to its own receipt, a misstated second receipt went undetected, and
// a false violation was charged to the first receipt instead.
const CHECK_NUMBERS = new RegExp(`^(.+?)\\s+(?:check\\s+)?(?:comes to|comes in at a total of|totals?|has a total of)\\s+${NUMBER}\\s+against\\s+(?:an?\\s+)?(?:(very easy|easy|medium|hard|very hard|nearly impossible)\\s+)?DC\\s+(?:of\\s+)?${NUMBER}$`, "i");
const CHECK_TOTAL = new RegExp(`^(?:(.*?)\\s+)?(?:total|totals|comes to)\\s+${NUMBER}$`, "i");
const DC = new RegExp(`^DC\\s+(?:of\\s+)?${NUMBER}$`, "i");
const OUTCOME = "(?:(?:is|was)\\s+)?(?:(?:no|not|never|did not|does not|do not)\\s+)?(?:a\\s+)?(?:success|failure|successful|unsuccessful|succeeds?|succeeded|fails?|failed)";
const CHECK_OUTCOME = new RegExp(`^(.+?\\s+check(?:\\s+(?:against|on)\\s+.+?)?)\\s+(${OUTCOME})$`, "i");
const ONLY_OUTCOME = new RegExp(`^${OUTCOME}$`, "i");
const DEALS = new RegExp(`^(.+?)\\s+(deals?|dealt|applies|applied|lands? for|hits? for)\\s+${NUMBER}(?:\\s+(?:(physical|bludgeoning|piercing|slashing)\\s+)?damage)?(?:\\s+to\\s+(.+))?$`, "i");
const TAKES = new RegExp(`^(.+?)\\s+(?:takes?|took|suffers?|suffered)\\s+${NUMBER}\\s+damage(?:\\s+from\\s+(.+))?$`, "i");
const HP = new RegExp(`^(.+?)\\s+(has|have|had|remains at|is at|survives? at)\\s+${NUMBER}\\s+(?:HP|hit points?)(?:\\s+(remaining|after the attack|before the attack))?$`, "i");

// Roles are names/noun phrases, not unbounded clauses containing punctuation,
// predicates or mechanical labels (notably the noun phrase "hit points").
const NAME = "[\\p{L}][\\p{L}\\p{N}'’ -]*?";
const STATUS = "(active|unconscious|stable|defeated|dead|alive)";
const DAMAGE_TYPE = "(physical|bludgeoning|piercing|slashing)";
const HP_TRANSITION = new RegExp(`^(${NAME})['’]s\\s+(?:hit points|HP)\\s+(?:go|went|fell|fall|falls) from\\s+${NUMBER}(?:\\s+before)?\\s+to\\s+${NUMBER}(?:\\s+after)?$`, "iu");
const HP_PAIR = new RegExp(`^(${NAME})['’]s\\s+hit points\\s*:?\\s*${NUMBER}\\s+before\\s*(?:,|and)\\s*${NUMBER}\\s+after$`, "iu");
const HP_POSSESSIVE = new RegExp(`^(${NAME})['’]s\\s+hit points\\s+(before|after)(?: the (?:attack|damage))?\\s+(?:are|were|is|was)\\s+${NUMBER}$`, "iu");
const STATUS_POSSESSIVE = new RegExp(`^(${NAME})['’]s\\s+status after(?: the (?:attack|damage))?(?:\\s+(?:is|was)\\s+|\\s*:\\s*)${STATUS}$`, "iu");
const PASSIVE_DAMAGE = new RegExp(`^${NUMBER}\\s+${DAMAGE_TYPE}\\s+damage (?:was|is) applied to\\s+(${NAME})(?:\\s+by\\s+(${NAME}))?$`, "iu");
const CHECK_RESOLUTION = new RegExp(`^(${NAME})\\s+(succeeded|succeeds|failed|fails) on (?:an?|the)\\s+(${NAME})\\s+check against DC\\s+${NUMBER}\\s*,?\\s*with a total of\\s+${NUMBER}$`, "iu");
const ATTACK_DAMAGE = new RegExp(`^(${NAME})\\s+(hit|hits|missed|misses)\\s+(${NAME})\\s+with a\\s+${DAMAGE_TYPE}\\s+attack for\\s+${NUMBER}\\s+damage$`, "iu");
const ATTACK_RESOLUTION = new RegExp(`^(${NAME})\\s+(?:attacked|attacks)\\s+(${NAME})\\s+and (hit|hits|missed|misses),?\\s+dealing\\s+${NUMBER}\\s+${DAMAGE_TYPE}\\s+damage$`, "iu");

function rolePhrase(text: string): boolean {
  return new RegExp(`^${NAME}$`, "iu").test(text)
    && !/^(?:the|an?|it|he|she|they|them|this|that)$/i.test(text) && !/^an?\s/i.test(text) && !/['’]s$/i.test(text)
    && !/\b(?:points?|status|before|after|because|with|from|to|on|is|was|are|were|has|have|go|went|and|but|yet|however|whereas|while|deals?|takes?|comes|hits?|misses|total|dc)\b/i.test(text);
}

/** A small typed field vocabulary, with exact full-value parsing. */
function parseField(text: string, family: Claim["family"]): Claim | null {
  const owned = /^the (check|attack|target)['’]s (.+?) is (.+)$/i.exec(text);
  if (owned) {
    const owner = normalize(owned[1]!);
    if ((owner === "check") !== (family === "check")) return null;
    const property = normalize(owned[2]!).replace(/\s/g, "");
    const allowed = owner === "check" ? ["actor", "target", "skill", "check", "dc", "difficulty", "total", "outcome"]
      : owner === "attack" ? ["actor", "target", "action", "hit", "outcome", "damage", "applied", "damageapplied", "damagetype"]
        : ["hitpointsbefore", "hitpointsafter", "statusafter", "status"];
    if (!allowed.includes(property)) return null;
    const parsed = parseField(`${owned[2]}: ${owned[3]}`, family);
    // The attack owner explicitly supplies the action, not an inferred outcome.
    return parsed && owner === "attack" ? { ...parsed, action: parsed.action ?? "attack" } : parsed;
  }
  const labelledTarget = new RegExp(`^(${NAME})\\s+(hit points before|hit points after|status after)\\s*:\\s*(.+)$`, "iu").exec(text);
  if (family === "damage" && labelledTarget && rolePhrase(labelledTarget[1]!)) {
    const parsed = parseField(`${labelledTarget[2]}: ${labelledTarget[3]}`, family);
    return parsed ? { ...parsed, target: damageTarget(labelledTarget[1]!) } : null;
  }
  const match = /^(?:with\s+)?(hitPointsBefore(?: for target .+?)?|hitPointsAfter(?: for target .+?)?|hit points before|hit points after|damage applied|damage type|damageType|target status after|status after|statusAfter|status|check DC|difficulty|attack roll|attack hit|attack|actor|target|kind|skill|check|dc|total|outcome|action|applied|damage|visibility|hit)\s*:?\s+(.+)$/i.exec(text);
  if (!match) return null;
  const key = normalize(match[1] ?? "").replace(/\s/g, "");
  const value = match[2] ?? "";
  if (["actor", "target", "skill", "check"].includes(key)) {
    if (!rolePhrase(value)) return null;
    return claim(family, { [key === "skill" || key === "check" ? "subject" : key]: value });
  }
  if (key === "kind" && /^(?:check|combat|combat-damage)$/i.test(value)) return claim(family, { receiptKind: normalize(value) });
  if (key === "visibility" && /^(?:public|private|hidden)$/i.test(value)) return claim(family, { visibility: normalize(value) });
  if (key === "action" && /^\w+$/u.test(value)) return claim(family, { action: normalize(value) });
  if (key === "outcome") {
    if (family === "check" && ONLY_OUTCOME.test(value)) return claim(family, { outcomes: polaritiesOf(value) });
    if (family === "damage" && /^(?:hit(?: true)?|miss|hit false)$/i.test(value)) return claim(family, { attackOutcome: /^(?:miss|hit false)$/i.test(value) ? "miss" : "hit" });
  }
  if (family === "damage" && ["hit", "attackhit"].includes(key) && /^(?:true|false)$/i.test(value)) return claim(family, { attackOutcome: normalize(value) === "true" ? "hit" : "miss", ...(key === "attackhit" ? { action: "attack" } : {}) });
  if (family === "damage" && ["attack", "attackroll"].includes(key) && /^(?:hit|miss)$/i.test(value)) return claim(family, { action: "attack", attackOutcome: normalize(value) as "hit" | "miss" });
  if (family === "damage" && ["statusafter", "targetstatusafter", "status"].includes(key) && new RegExp(`^${STATUS}$`, "i").test(value)) return claim(family, { status: normalize(value) });
  if (family === "damage" && key === "damagetype" && new RegExp(`^${DAMAGE_TYPE}$`, "i").test(value)) return claim(family, { damageType: normalize(value) });
  const damage = new RegExp(`^${NUMBER}(?:,?\\s+${DAMAGE_TYPE})?(?:\\s+damage)?$`, "i").exec(value);
  if (family === "damage" && ["damage", "damageapplied", "applied"].includes(key) && damage) return claim(family, {
    values: [numeric("damage-applied", Number(damage[1]))], damageType: damage[2] ?? null,
  });
  if (!new RegExp(`^${NUMBER}$`).test(value)) return null;
  const hp = /^(hitPointsBefore|hitPointsAfter|hit points before|hit points after)(?: for target (.+))?$/i.exec(match[1] ?? "");
  if (family === "damage" && hp && (!hp[2] || rolePhrase(hp[2]))) return claim(family, {
    target: hp[2] ?? null, values: [numeric(/before/i.test(hp[1] ?? "") ? "hp-before" : "hp-after", Number(value))],
  });
  if (family === "check" && ["dc", "checkdc", "difficulty", "total"].includes(key)) return claim(family, { values: [numeric(key === "total" ? "total" : "dc", Number(value))] });
  return null;
}

interface RecordHeader {
  body: string;
  family?: Claim["family"];
  receiptId?: string;
  initial?: Claim;
}

/** Structural syntax, independent of the supplied receipt IDs/names/values.
 * Ordinal labels enumerate prose sections; they never select receipt-array slots.
 * Bold is supported only around one recognized mechanical heading.
 */
function recordHeader(text: string): RecordHeader | null {
  const bold = /^\*\*([^*\n]+)\*\*\s*([\s\S]+)$/.exec(text);
  const headingText = bold ? `${bold[1]!.replace(/[.:;]\s*$/, "")}. ${bold[2]}` : text;
  let match = /^(?:receipt\s+([\w-]+)|receiptId:\s*([\w-]+))(?:\s*[—:]\s*(check|combat|combat-damage)\s*[.:;]|\s*[.:—])\s*([\s\S]+)$/i.exec(headingText);
  if (match) {
    const label = match[2] ?? match[1]!;
    const ordinal = !match[2] && /^(?:one|two|three|first|second|third|\d+)$/i.test(label);
    return { body: match[4]!, ...(!ordinal ? { receiptId: label } : {}),
      ...(match[3] ? { family: normalize(match[3]) === "check" ? "check" : "damage", initial: claim(normalize(match[3]) === "check" ? "check" : "damage", { receiptKind: normalize(match[3]) }) } : {}) };
  }
  match = /^the (check|combat) receipt ([\w-]+) records\s+([\s\S]+)$/i.exec(text);
  if (match) return { body: match[3]!, receiptId: match[2]!, family: normalize(match[1]!) === "check" ? "check" : "damage" };
  match = /^(?:first|second|third)[.:]\s*([\s\S]+)$/i.exec(text);
  if (match) return { body: match[1]! };
  match = /^the (check|attack)['’]s actor is\s+/i.exec(text);
  if (match) return { body: text, family: normalize(match[1]!) === "check" ? "check" : "damage" };
  if (/^(?:actor|kind|skill)\s*:/i.test(text)) return { body: text };
  if (!bold) return null;
  const heading = bold[1]!.replace(/[.:;]\s*$/, "");
  match = new RegExp(`^attack\\s+—\\s+(${NAME})\\s*→\\s*(${NAME})$`, "iu").exec(heading);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return { body: bold[2]!, family: "damage", initial: claim("damage", { actor: match[1]!, target: damageTarget(match[2]!), action: "attack" }) };
  if (/^attack\s+—\s+damage$/i.test(heading)) return { body: bold[2]!, family: "damage", initial: claim("damage", { action: "attack" }) };
  match = new RegExp(`^check\\s+—\\s+(${NAME})$`, "iu").exec(heading);
  if (match && rolePhrase(match[1]!)) return { body: bold[2]!, family: "check", initial: claim("check", { subject: match[1]! }) };
  match = new RegExp(`^(${NAME})\\s+—\\s+(${NAME})$`, "iu").exec(heading);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!) && /\b(?:DC|total|outcome)\b/i.test(bold[2]!)) return { body: bold[2]!, family: "check", initial: claim("check", { subject: match[1]!, actor: match[2]! }) };
  return null;
}

/** Explicit receipt headings can begin another record within the same paragraph. */
function recordScopes(paragraph: string): string[] {
  const starts = [0];
  for (const match of paragraph.matchAll(/[.\n]\s+(?=(?:\*\*)?(?:receipt(?:Id)?\b|the (?:check|combat) receipt\b|(?:first|second|third)[.:]|the (?:check|attack)['’]s actor is))/gi)) {
    const start = match.index + match[0].length;
    const header = recordHeader(paragraph.slice(start));
    // A repeated citation with only trailing metadata is part of the current
    // record. A new record must introduce its own actor association.
    if (header && (/^(?:first|second|third)[.:]|^the (?:check|attack)['’]s actor is/i.test(paragraph.slice(start)) || /(?:^|[.;\n])\s*actor\b/i.test(header.body))) starts.push(start);
  }
  return starts.map((start, index) => paragraph.slice(start, starts[index + 1])).flatMap(splitActorRecords);
}

/** A new bare Actor field starts a record only when both sides are complete.
 * Incomplete/duplicate actor fields remain in one scope and are all checked.
 * An explicit receipt citation cannot be escaped with an uncited Actor field.
 */
function splitActorRecords(text: string): string[] {
  if (recordHeader(text.trim())?.receiptId) return [text];
  const boundaries = [...text.matchAll(/[.;\n]\s+(?=actor\s*:)/gi)].map((match) => match.index + match[0].length);
  const starts = [0];
  for (const [index, start] of boundaries.entries()) {
    const before = parseRecord(text.slice(starts.at(-1)!, start).trim());
    const after = parseRecord(text.slice(start, boundaries[index + 1]).trim());
    if (before?.complete && after?.complete) starts.push(start);
  }
  return starts.map((start, index) => text.slice(start, starts[index + 1]));
}

function parseRecord(text: string): Claim | null {
  const header = recordHeader(text);
  if (!header) return null;
  const fields = header.body.split(/[;\n]+|\.(?!\d)/u).map((field) => field.trim()).filter(Boolean);
  const head = fields[0] ? parseAtomicClause(fields[0]) ?? parseCompound(fields[0]) : null;
  const family = header.family ?? head?.family ?? (fields.some((field) => /^(?:skill|check|kind\s*:?\s+check)\b/i.test(field)) ? "check"
    : fields.some((field) => /^(?:target|action|attack|damage|hit)\b/i.test(field)) ? "damage"
      : fields.some((field) => /^(?:dc|difficulty|total|outcome\s*:\s*(?:success|failure))\b/i.test(field)) ? "check" : null);
  if (!family) return null;
  const parsed: Claim[] = header.initial ? [{ ...header.initial, excerpt: "" }] : [];
  const unknown: string[] = [];
  const parse = (field: string): void => {
    const citation = /^(?:receipt\s+|receiptId:\s*)([\w-]+)$/i.exec(field);
    if (citation) { parsed.push(claim(family, { receiptId: citation[1]!, excerpt: field })); return; }
    const atomic = parseAtomicClause(field);
    // An outgoing predicate (notably "applied ... damage") must not lose its
    // scope requirement by being retried as a similarly named record field.
    const component = atomic?.continuation === "attack" ? atomic
      : parseField(field, family) ?? parseRecordAtom(field, family) ?? atomic ?? parseCompound(field);
    if (component && component.family === family) { parsed.push({ ...component, excerpt: field }); return; }
    const parts = field.split(/,(?!\s*-?\d+(?:\.\d+)?\s+after\b)\s*|;\s*|\s+and\s+(?=target\b)/i);
    if (parts.length > 1) { for (const part of parts) if (part.trim()) parse(part.trim()); return; }
    unknown.push(field);
  };
  for (const [index, field] of fields.entries()) {
    // The first slot after **Check — skill.** may be a single actor name.
    // This positional slot does not turn arbitrary later prose into identities.
    if (index === 0 && header.initial?.family === "check" && header.initial.subject && !header.initial.actor
      && /^[\p{L}][\p{L}'’-]*$/u.test(field) && rolePhrase(field) && !/^(?:success|failure|hit|miss)$/i.test(field)) {
      parsed.push(claim("check", { actor: field, excerpt: field }));
    } else parse(field);
  }
  const all = parsed.flatMap(claimComponents);
  let complete = unknown.length === 0;
  // Receipt IDs scope the record, but never replace the required role/value fields.
  const requiredRoles: AuthoritativeValue["role"][] = family === "check" ? ["dc", "total"] : ["damage-applied", "hp-before", "hp-after"];
  if (!all.some((item) => item.actor) || !requiredRoles.every((role) => all.some((item) => item.values.some((value) => value.role === role)))) complete = false;
  if (family === "check" ? !all.some((item) => item.subject) || !all.some((item) => item.outcomes.length)
    : !all.some((item) => item.target) || !all.some((item) => item.action) || !all.some((item) => item.attackOutcome)
      || !all.some((item) => item.damageType) || !all.some((item) => item.status)) complete = false;
  // All identity evidence and every duplicate remain on the same scoped fact.
  // Without a citation, roles must select a unique fact; values never select it.
  const receiptId = header.receiptId ?? all.find((item) => item.receiptId)?.receiptId;
  return claim(family, { ...(receiptId ? { receiptId } : {}),
    actor: all.find((item) => item.actor)?.actor ?? null,
    target: all.find((item) => item.target)?.target ?? null,
    subject: all.find((item) => item.subject)?.subject ?? null,
    components: parsed, complete, scopedRecord: true, unknownFragments: unknown });
}

function parseRecordAtom(text: string, family: Claim["family"]): Claim | null {
  let match = new RegExp(`^(${NAME}),\\s*DC\\s+${NUMBER}$`, "iu").exec(text);
  if (family === "check" && match && rolePhrase(match[1]!)) return claim("check", { subject: match[1]!, values: [numeric("dc", Number(match[2]))] });
  if (family !== "damage") return null;
  match = new RegExp(`^hit points\\s+${NUMBER}\\s+to\\s+${NUMBER}$`, "i").exec(text);
  if (match) return claim("damage", { values: [numeric("hp-before", Number(match[1])), numeric("hp-after", Number(match[2]))] });
  match = new RegExp(`^${NUMBER}\\s+${DAMAGE_TYPE}$`, "i").exec(text);
  if (match) return claim("damage", { values: [numeric("damage-applied", Number(match[1]))], damageType: match[2]! });
  match = new RegExp(`^(?:(${NAME}):\\s*)?${NUMBER}\\s+(?:HP|hit points)\\s*→\\s*${NUMBER}\\s+(?:HP|hit points)$`, "iu").exec(text)
    ?? new RegExp(`^(${NAME}):\\s*${NUMBER}\\s+(?:HP|hit points) before,\\s*${NUMBER}\\s+after$`, "iu").exec(text)
    ?? new RegExp(`^(?:(hit points):\\s*)${NUMBER}\\s+before,\\s*${NUMBER}\\s+after$`, "i").exec(text);
  if (match && (!match[1] || /^hit points$/i.test(match[1]) || rolePhrase(match[1]))) return claim("damage", {
    target: !match[1] || /^hit points$/i.test(match[1]) ? null : damageTarget(match[1]),
    values: [numeric("hp-before", Number(match[2])), numeric("hp-after", Number(match[3]))],
  });
  return null;
}

function parseExplicitHead(text: string): Claim | null {
  let match = new RegExp(`^(${NAME})\\s+(?:(?:make|makes|made|attempt|attempts|attempted) an?|(?:is|are) the actor of an?)\\s+(${NAME})\\s+check(?: against DC\\s+${NUMBER})?$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("check", {
    actor: match[1]!, subject: match[2]!, values: match[3] ? [numeric("dc", Number(match[3]))] : [],
  });
  match = new RegExp(`^(${NAME})\\s+(?:attempt(?:s|ed)?|work(?:s|ed)?)\\s+(?:the\\s+)?(${NAME})$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("check", { actor: match[1]!, subject: match[2]! });
  match = new RegExp(`^(${NAME})\\s+(?:attacks?|attacked|(?:make|makes|made) an attack against|(?:is|are) the actor of an attack against)\\s+(${NAME})$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("damage", { actor: match[1]!, target: damageTarget(match[2]!), action: "attack" });
  match = new RegExp(`^(${NAME})\\s+strikes?\\s+(${NAME})(?: with an attack)?$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("damage", { actor: match[1]!, target: damageTarget(match[2]!), action: "attack" });
  match = new RegExp(`^(${NAME})['’]s attack(?: targets\\s+(${NAME}))?$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && (!match[2] || rolePhrase(match[2]))) return claim("damage", { actor: match[1]!, target: match[2] ? damageTarget(match[2]) : null, action: "attack" });
  return null;
}

/** A compound schema keeps every component on its head's actor/target receipt. */
function parseCompound(text: string): Claim | null {
  let head: Claim | null = null;
  let tail = "";
  const labelled = new RegExp(`^(${NAME})\\s*[:—]\\s*(.+)$`, "iu").exec(text);
  if (labelled && rolePhrase(labelled[1]!)) {
    const body = labelled[2]!;
    const check = /^(.+?)\s+check\s*[,;:]\s*(.+)$/i.exec(body);
    const attack = /^attack against\s+(.+?)\s*[,;]\s*(.+)$/i.exec(body);
    if (check && rolePhrase(check[1]!)) { head = claim("check", { actor: labelled[1]!, subject: check[1]! }); tail = check[2]!; }
    else if (attack && rolePhrase(attack[1]!)) { head = claim("damage", { actor: labelled[1]!, target: damageTarget(attack[1]!), action: "attack" }); tail = attack[2]!; }
    else if (/^hit points before\b/i.test(body)) { head = claim("damage", { target: damageTarget(labelled[1]!) }); tail = body; }
  }
  if (!head) {
    const split = /^(.+?)(?:\s*[:,]\s*|\s+and\s+(?=(?:rolls?|succeeds?|fails?|hits?|miss(?:es|ed)?|deals?|dealt|dealing|applies|apply|applied|applying)\b))(.+)$/i.exec(text);
    if (!split) return null;
    head = parseExplicitHead(split[1]!) ?? parseAtomicClause(split[1]!);
    if (!head) return null;
    tail = split[2]!;
  }
  const wholeTail = parseAtomicClause(tail) ?? parseRecordAtom(tail, head.family) ?? parseField(tail, head.family);
  if (wholeTail && wholeTail.family === head.family) return { ...head, components: [wholeTail] };
  // HP pairs contain their own comma/conjunction and must stay atomic.
  const parts = tail.split(/[,;:](?!\s*-?\d+(?:\.\d+)?\s+after\b)\s*/i);
  const components: Claim[] = [];
  for (const part of parts) {
    const component = parseAtomicClause(part.trim()) ?? parseRecordAtom(part.trim(), head.family) ?? parseField(part.trim(), head.family);
    if (!component || component.family !== head.family) return null;
    components.push(component);
  }
  return { ...head, components };
}

/** Anchored patterns matter: a valid prefix must not license an unknown suffix. */
function parseClause(text: string): Claim | null {
  if (recordHeader(text)) return parseRecord(text);
  return parseAtomicClause(text) ?? parseCompound(text);
}

/** Typed sentence predicates, rather than independent keyword/value fragments.
 * A named check/attack opens a scope. Totals/results and omitted subjects are
 * continuations of that same fact. Every actorless outgoing attack predicate,
 * including bare verbs and "it", additionally needs an attack referent.
 */
function parseMechanicalSentence(text: string): Claim | null {
  let match = new RegExp(`^(.+?)\\s+(?:resolves\\s+)?against\\s+(?:a\\s+)?(?:DC|difficulty)\\s+(?:of\\s+)?${NUMBER}$`, "i").exec(text);
  if (match && validCheckIdentity(match[1]!)) return claim("check", { ...checkIdentity(match[1]!), values: [numeric("dc", Number(match[2]))] });
  match = new RegExp(`^(.+?),\\s*DC\\s+${NUMBER},\\s*total\\s+${NUMBER}$`, "i").exec(text);
  if (match && validCheckIdentity(match[1]!)) return claim("check", { ...checkIdentity(match[1]!), values: [numeric("dc", Number(match[2])), numeric("total", Number(match[3]))] });
  match = new RegExp(`^against\\s+(?:DC|difficulty)\\s+${NUMBER}$`, "i").exec(text);
  if (match) return claim("check", { values: [numeric("dc", Number(match[1]))], continuation: "fact" });
  match = new RegExp(`^(${NAME})\\s+(succeeds?|succeeded|fails?|failed)(?:\\s+with a total of\\s+${NUMBER})?$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && !/\b(?:check|result|outcome|roll|did|does|not|never)\b/i.test(match[1]!)) return claim("check", { actor: match[1]!, outcomes: polaritiesOf(match[2]!), values: match[3] ? [numeric("total", Number(match[3]))] : [], continuation: "fact" });
  match = new RegExp(`^(?:(your|the) total|(${NAME})['’]s total)\\s+(?:is|was)\\s+${NUMBER}$`, "iu").exec(text);
  if (match && (!match[2] || rolePhrase(match[2]))) return claim("check", { actor: match[2] ?? (/^your$/i.test(match[1] ?? "") ? "you" : null), values: [numeric("total", Number(match[3]))], continuation: "fact" });
  match = new RegExp(`^(?:(${NAME})\\s+)?(?:rolls?|rolled) a total of\\s+${NUMBER}$`, "iu").exec(text);
  if (match && (!match[1] || rolePhrase(match[1]))) return claim("check", { actor: match[1] ?? null, values: [numeric("total", Number(match[2]))], continuation: "fact" });
  match = new RegExp(`^(?:the\\s+)?(?:check(?: outcome)?|outcome|result|roll)\\s+(${OUTCOME})$`, "i").exec(text);
  if (match) return claim("check", { outcomes: polaritiesOf(match[1]!), continuation: "fact" });
  match = /^(?:it)\s+(hits?|misses|missed)$/i.exec(text);
  if (match) return claim("damage", { attackOutcome: /^hit/i.test(match[1]!) ? "hit" : "miss", continuation: "attack" });
  match = new RegExp(`^(?:deals?|dealt|dealing|applies|apply|applied|applying)\\s+${NUMBER}\\s+${DAMAGE_TYPE}\\s+damage$`, "i").exec(text);
  if (match) return claim("damage", { values: [numeric("damage-applied", Number(match[1]))], damageType: match[2]!, continuation: "attack" });
  match = new RegExp(`^(?:the\\s+)?damage applied is\\s+${NUMBER}\\s+${DAMAGE_TYPE}\\s+damage$`, "i").exec(text);
  if (match) return claim("damage", { values: [numeric("damage-applied", Number(match[1]))], damageType: match[2]!, continuation: "fact" });
  match = new RegExp(`^(?:the\\s+)?(?:attack|blow|strike) lands,\\s*${DAMAGE_TYPE},\\s*for\\s+${NUMBER}\\s+damage$`, "i").exec(text);
  if (match) return claim("damage", { action: "attack", attackOutcome: "hit", damageType: match[1]!, values: [numeric("damage-applied", Number(match[2]))] });
  match = new RegExp(`^(${NAME})\\s+(?:goes|went) from\\s+${NUMBER}\\s+hit points to\\s+${NUMBER}$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", { target: damageTarget(match[1]!), values: [numeric("hp-before", Number(match[2])), numeric("hp-after", Number(match[3]))] });
  return null;
}

function parseAtomicClause(text: string): Claim | null {
  const explicit = parseExplicitHead(text);
  if (explicit) return explicit;
  const sentence = parseMechanicalSentence(text);
  if (sentence) return sentence;
  let match = CHECK_RESOLUTION.exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[3]!)) return claim("check", { actor: match[1]!, subject: match[3]!, outcomes: polaritiesOf(match[2]!), values: [numeric("dc", Number(match[4])), numeric("total", Number(match[5]))] });
  match = ATTACK_DAMAGE.exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[3]!)) return claim("damage", { actor: match[1]!, target: damageTarget(match[3]!), action: "attack", attackOutcome: /^hit/i.test(match[2]!) ? "hit" : "miss", damageType: match[4]!, values: [numeric("damage-applied", Number(match[5]))] });
  match = ATTACK_RESOLUTION.exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("damage", { actor: match[1]!, target: damageTarget(match[2]!), action: "attack", attackOutcome: /^hit/i.test(match[3]!) ? "hit" : "miss", damageType: match[5]!, values: [numeric("damage-applied", Number(match[4]))] });
  match = HP_TRANSITION.exec(text) ?? HP_PAIR.exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", { target: damageTarget(match[1]!), values: [numeric("hp-before", Number(match[2])), numeric("hp-after", Number(match[3]))] });
  match = HP_POSSESSIVE.exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", { target: damageTarget(match[1]!), values: [numeric(normalize(match[2]!) === "before" ? "hp-before" : "hp-after", Number(match[3]))] });
  match = STATUS_POSSESSIVE.exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", { target: damageTarget(match[1]!), status: normalize(match[2]!) });
  match = PASSIVE_DAMAGE.exec(text);
  if (match && rolePhrase(match[3]!) && (!match[4] || rolePhrase(match[4]))) return claim("damage", { target: damageTarget(match[3]!), actor: match[4] ?? null, damageType: match[2]!, values: [numeric("damage-applied", Number(match[1]))], focus: "target" });
  match = new RegExp(`^(?:the\\s+)?check resolves against DC\\s+${NUMBER}\\s+with a total of\\s+${NUMBER}$`, "i").exec(text);
  if (match) return claim("check", { values: [numeric("dc", Number(match[1])), numeric("total", Number(match[2]))] });
  match = new RegExp(`^(?:(?:the|roll)\\s+)?total(?: was| is)?\\s+${NUMBER}\\s+against DC\\s+${NUMBER}$`, "i").exec(text);
  if (match) return claim("check", { values: [numeric("total", Number(match[1])), numeric("dc", Number(match[2]))] });
  match = /^(?:the\s+)?outcome(?:\s*:\s*|\s+(?:(?:is|was)\s+)?)(success|failure|a hit|a miss)$/i.exec(text);
  if (match) return /^a /i.test(match[1]!) ? claim("damage", { attackOutcome: /miss$/i.test(match[1]!) ? "miss" : "hit" }) : claim("check", { outcomes: polaritiesOf(match[1]!) });
  match = new RegExp(`^${NUMBER}\\s+${DAMAGE_TYPE}\\s+damage(?: applied)?$`, "i").exec(text)
    ?? new RegExp(`^damage\\s*:\\s*${NUMBER}\\s+${DAMAGE_TYPE}$`, "i").exec(text);
  if (match) return claim("damage", { values: [numeric("damage-applied", Number(match[1]))], damageType: match[2]! });
  match = new RegExp(`^damage applied is\\s+${NUMBER}$`, "i").exec(text);
  if (match) return claim("damage", { values: [numeric("damage-applied", Number(match[1]))] });
  if (/^(?:hit(?: true)?|hits|miss(?:es|ed)?|hit false)$/i.test(text)) return claim("damage", { attackOutcome: /^(?:miss(?:es|ed)?|hit false)$/i.test(text) ? "miss" : "hit", continuation: "attack" });
  const field = parseField(text, "damage");
  if (field && (field.status || field.damageType)) return field;
  // The legacy atomic grammar never captures sibling clauses as role names.
  if (/[;:,]|\b(?:and|but|yet|however|whereas|while)\b/i.test(text)) return null;
  match = CHECK_NUMBERS.exec(text);
  if (match && validCheckIdentity(match[1] ?? "")) return claim("check", { ...checkIdentity(match[1] ?? ""), difficulty: match[3] ?? null, values: [numeric("total", Number(match[2])), numeric("dc", Number(match[4]))] });
  match = CHECK_TOTAL.exec(text);
  if (match && validCheckIdentity(match[1] ?? "")) return claim("check", { ...checkIdentity(match[1] ?? ""), values: [numeric("total", Number(match[2]))] });
  match = DC.exec(text);
  if (match) return claim("check", { values: [numeric("dc", Number(match[1]))] });
  match = CHECK_OUTCOME.exec(text);
  if (match && validCheckIdentity(match[1] ?? "")) return claim("check", { ...checkIdentity(match[1] ?? ""), outcomes: polaritiesOf(match[2] ?? "") });
  if (ONLY_OUTCOME.test(text) || /^(?:you\s+)?(?:fail|succeed)(?:\s+(?:the\s+)?check)?$/i.test(text)) {
    return claim("check", { actor: /^you\s+/i.test(text) ? "you" : null, outcomes: polaritiesOf(text) });
  }
  match = /^(.+?\s+check)(?:\s+resolved)?$/i.exec(text);
  if (match && validCheckIdentity(match[1]!)) return claim("check", checkIdentity(match[1]!));
  match = DEALS.exec(text);
  if (match && rolePhrase(match[1]!) && (!match[5] || rolePhrase(match[5]))) return claim("damage", {
    actor: damageActor(match[1] ?? ""), target: match[5] ? damageTarget(match[5]) : null,
    action: /\battack$/i.test(match[1] ?? "") ? "attack" : null,
    attackOutcome: /^hits? for$/i.test(match[2] ?? "") ? "hit" : null,
    damageType: match[4] ?? null, values: [numeric("damage-applied", Number(match[3]))], focus: "event",
  });
  match = TAKES.exec(text);
  if (match && rolePhrase(match[1]!) && (!match[3] || rolePhrase(match[3]))) return claim("damage", { target: damageTarget(match[1] ?? ""), actor: match[3] ?? null, values: [numeric("damage-applied", Number(match[2]))], focus: "target" });
  match = HP.exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", {
    target: damageTarget(match[1] ?? ""),
    values: [numeric(/before/i.test(match[4] ?? "") || (!match[4] && /^had$/i.test(match[2] ?? "")) ? "hp-before" : "hp-after", Number(match[3]))],
    status: /^surviv/i.test(match[2] ?? "") ? "alive" : null,
  });
  match = /^(.+?)\s+(?:is\s+(active|unconscious|stable|defeated|dead|alive)|(?:dies|died|is killed|is slain)|(survives|survived))$/i.exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", { target: damageTarget(match[1] ?? ""), status: match[2] ? normalize(match[2]) : match[3] ? "alive" : "dead" });
  match = /^(.+?)\s+(hits?|misses|missed)(?:\s+(?!points?\b)(.+))?$/i.exec(text);
  if (match && rolePhrase(match[1]!) && (!match[3] || rolePhrase(match[3]))) return claim("damage", { actor: damageActor(match[1] ?? ""), target: match[3] ? damageTarget(match[3]) : null,
    action: /\battack$/i.test(match[1] ?? "") ? "attack" : null, attackOutcome: /^hit/i.test(match[2] ?? "") ? "hit" : "miss" });
  return null;
}

function validCheckIdentity(head: string): boolean {
  return Object.values(checkIdentity(head)).every((value) => value === null || rolePhrase(value));
}

const CONSEQUENCE = /\b(?:(?:lock|door|gate|seal)\w*\s+(?:clicks?|opens?|opened|gives?\s+way)|(?:find|discover|uncover|spot)\s+(?:the\s+)?(?:hidden|secret|clue|key|evidence)|(?:npc|[a-z]+\s+name)\s+(?:convinced|agrees?|yields?|relents?|confesses?)|(?:trap|ambush|attack)\w*\s+(?:triggers?|springs?|fires?))\b/i;
const NONCOMMITTED = /\b(?:will|would|might|may|pending|unresolved|uncommitted|uncertain|unknown|tomorrow|yesterday|previously|earlier|later|used to|not yet|not established|not committed|did not happen|has not happened|awaiting confirmation)\b/i;
function mechanicalFamily(text: string): string | null {
  // Indefinite relative clauses are not mechanical predicates. In particular,
  // "whoever ... sold it to" need not assert a committed commerce transaction.
  if (/^(?:whoever|whatever)\b/i.test(text)) return null;
  if (/\b(?:check|dc|total|success|successful|failure|failed|succeeds?|unsuccessful)\b/i.test(text)) return "check";
  if (/\b(?:damage|hp|hit points?|attack|dies|died|dead|slain|survives?|unconscious|defeated|hits?|misses)\b/i.test(text)) return "damage";
  if (/\b(?:rest|sleep|recover|recovery)\b/i.test(text)) return "rest";
  if (/\b(?:arrive|arrived|arrives|travel|journey|reach|reached|reaches)\b/i.test(text)) return "travel";
  if (/\b(?:equip|unequip|drop|consume|gift|inventory)\b/i.test(text)) return "inventory";
  if (/\b(?:buy|bought|sell|sold|gold|coins?|currency|purchase)\b/i.test(text)) return "commerce";
  if (/\b(?:quest|objective|reward)\b/i.test(text)) return "quest";
  if (/\b(?:level|xp|experience)\b/i.test(text)) return "progression";
  if (/\b(?:spell|power|heal|healing|restore)\b/i.test(text)) return "power";
  return null;
}

function bindFact(assertion: Claim, facts: readonly AuthoritativeFact[], previous: AuthoritativeFact | null,
  excerpt: string, violations: BindingViolation[], adjudications: GroundingAdjudication[], focus: "event" | "target" | null = null): AuthoritativeFact | null {
  if (assertion.continuation) {
    if (!previous || previous.family !== assertion.family || (assertion.continuation === "attack" && focus !== "event")) {
      adjudications.push({ code: "unscoped-continuation", detail: "this follow-up has no unambiguous same-family referent", excerpt,
        resolution: "First identify the check actor/skill or attack actor/target; do not infer an omitted subject or pronoun's referent from the receipt inventory." });
      return null;
    }
    // Keep stated roles for validation: a changed actor cannot redirect a total
    // or outcome to a different otherwise-valid receipt.
    return previous;
  }
  let candidates = facts.filter((fact) => fact.implemented && fact.family === assertion.family);
  if (assertion.receiptId) {
    candidates = candidates.filter((fact) => fact.receiptId === assertion.receiptId);
    if (candidates.length === 0) {
      violations.push({ code: "receipt-binding-mismatch", detail: `receipt ${assertion.receiptId} does not establish this ${assertion.family} record`, excerpt });
      return null;
    }
  }
  if (candidates.length === 0) {
    // Other combat/power families can establish damage, but need their own adapter.
    if (facts.some((fact) => !fact.implemented)) {
      adjudications.push({ code: "unimplemented-binding", detail: "no implemented fact binds this claim", excerpt,
        resolution: "Implement and validate a clause-binding adapter for the authoritative receipt family." });
    } else violations.push({ code: "unbound-mechanical-claim", detail: `no ${assertion.family} receipt establishes this claim`, excerpt });
    return null;
  }
  for (const role of ["subject", "actor", "target"] as const) {
    const stated = assertion[role];
    if (stated === null) continue;
    const matching = candidates.filter((fact) => fact[role] !== null && entity(fact[role]) === entity(stated));
    if (matching.length === 0) {
      violations.push({ code: `${role}-binding-mismatch`, detail: `${role} "${stated}" is not established for this claim`, excerpt });
      if (role === "target" && assertion.status) violations.push({ code: "fabricated-outcome", detail: `no authoritative status establishes ${assertion.status} for target "${stated}"`, excerpt });
      return null;
    }
    candidates = matching;
  }
  // Only a fully elliptical clause may inherit a previously established referent.
  if (candidates.length > 1 && !assertion.scopedRecord && !assertion.subject && !assertion.actor && !assertion.target && previous && candidates.includes(previous)) candidates = [previous];
  if (candidates.length !== 1) {
    adjudications.push({ code: "ambiguous-fact-binding", detail: "several receipts could be the referent; values are not identity evidence", excerpt,
      resolution: "Name the authoritative actor, target and check subject, or supply an unambiguous receipt-scoped narration." });
    return null;
  }
  return candidates[0] ?? null;
}

function validateClaim(assertion: Claim, fact: AuthoritativeFact, excerpt: string,
  violations: BindingViolation[], adjudications: GroundingAdjudication[], inheritedFocus: "event" | "target" | null = null): "event" | "target" | null {
  const before = violations.length + adjudications.length;
  const problem = (code: string, detail: string): void => { violations.push({ code, detail, excerpt, receiptId: fact.receiptId }); };
  const adjudicate = (code: string, detail: string, resolution: string): void => { adjudications.push({ code, detail, excerpt, resolution, receiptId: fact.receiptId }); };
  // A same-receipt component is not necessarily about the receipt's actor.
  // Check before this predicate's own outcome can establish event focus.
  if (assertion.continuation === "attack" && inheritedFocus !== "event") {
    adjudicate("unscoped-continuation", "this outgoing predicate has no established attack actor/event referent", "Name the attack actor/target instead of inheriting a target, HP or status as an attack.");
    return null;
  }
  if (fact.visibility !== "public") problem("forbidden-fact-disclosed", "the bound fact is not public");
  if (assertion.receiptId && assertion.receiptId !== fact.receiptId) problem("receipt-binding-mismatch", `citation ${assertion.receiptId} does not name this record's receipt ${fact.receiptId}`);
  for (const role of ["actor", "target", "subject"] as const) {
    const stated = assertion[role];
    if (stated !== null && (fact[role] === null || entity(stated) !== entity(fact[role]))) problem(`${role}-binding-mismatch`, `${role} "${stated}" is not established for this claim`);
  }
  if (assertion.receiptKind && assertion.receiptKind !== (fact.family === "damage" ? "combat" : fact.family)
    && !(assertion.receiptKind === "combat-damage" && fact.family === "damage")) problem("receipt-kind-mismatch", `receipt does not establish kind ${assertion.receiptKind}`);
  if (assertion.visibility && assertion.visibility !== fact.visibility) problem("visibility-binding-mismatch", `receipt visibility is ${fact.visibility}, not ${assertion.visibility}`);
  if (!assertion.scopedRecord && NONCOMMITTED.test(excerpt)) problem("temporal-state-contradicted", "a committed receipt cannot establish a pending, hypothetical or different-time claim");
  if (assertion.action && assertion.action !== fact.action) problem("action-binding-mismatch", `receipt action is ${fact.action}, not ${assertion.action}`);
  for (const qualifier of ["damageType", "difficulty"] as const) {
    const stated = assertion[qualifier];
    if (!stated) continue;
    const expected = fact[qualifier];
    if (expected === null) adjudicate("missing-qualifier", `${qualifier} is not established by the receipt`, `Preserve the production receipt's ${qualifier} field or omit the unsupported qualifier.`);
    else if (normalize(expected) !== normalize(stated)) problem("qualifier-binding-mismatch", `${qualifier} is ${expected}, not ${stated}`);
  }
  for (const value of assertion.values) {
    const expected = fact.values.find((item) => item.role === value.role);
    if (!expected) problem(value.role === "hp-before" ? "temporal-state-unbound" : "value-unbound", `receipt does not establish ${value.role}`);
    else if (value.value !== expected.value || value.unit !== expected.unit) problem("value-binding-mismatch", `${value.role} is ${expected.value} ${expected.unit}, not ${value.value} ${value.unit}`);
  }
  for (const outcome of assertion.outcomes) {
    if (fact.outcome !== "success" && fact.outcome !== "failure") adjudicate("unknown-check-outcome", `receipt outcome "${fact.outcome}" has no supported semantics`, "Supply the production success/failure outcome or implement its semantics.");
    else if (outcome.value !== fact.outcome) problem("check-outcome-contradicted", `receipt outcome is ${fact.outcome}, but this occurrence asserts ${outcome.value}`);
  }
  if (assertion.attackOutcome) {
    if (fact.outcome === null) adjudicate("missing-hit-outcome", "damage quantity alone does not establish whether the attack hit", "Preserve the production damage receipt's hit field.");
    else if (fact.outcome !== assertion.attackOutcome) problem("combat-outcome-contradicted", `receipt says ${fact.outcome}, not ${assertion.attackOutcome}`);
  }
  if (assertion.status) {
    if (assertion.values.some((value) => value.role === "hp-before")) problem("temporal-state-unbound", "statusAfter cannot establish a status before the attack");
    const hp = fact.values.find((value) => value.role === "hp-after")?.value;
    if (assertion.status === "alive") {
      if (fact.status === "dead") problem("fabricated-outcome", "statusAfter is dead, but narration asserts survival");
      else if (!["active", "unconscious", "stable"].includes(fact.status ?? "") && !(fact.status === null && hp !== undefined && hp > 0)) {
        adjudicate("missing-survival-status", "the receipt does not establish survival", "Preserve statusAfter (active, unconscious or stable) from the production receipt.");
      }
    } else if (fact.status === null) {
      if (assertion.status === "dead" && hp !== undefined && hp > 0) problem("fabricated-outcome", "death is not established by a receipt with positive remaining HP and no death status");
      else adjudicate("missing-status-after", `HP does not establish status "${assertion.status}"`, "Preserve the production receipt's explicit statusAfter; zero HP does not imply death.");
    } else if (assertion.status !== fact.status) problem("fabricated-outcome", `statusAfter is ${fact.status}, not ${assertion.status}`);
  }
  if (!assertion.complete) adjudicate("unrecognized-clause", "the entire clause is not covered by the binding grammar", "Rewrite as an explicit role-labelled clause, or add a reviewed binding rule with contradiction and mutation tests.");
  for (const fragment of assertion.unknownFragments ?? []) adjudications.push({ code: "unrecognized-clause", detail: "the record contains an unrecognized field or clause", excerpt: fragment, receiptId: fact.receiptId,
    resolution: "Bind this entire fragment to an independently established fact or adjudicate it; the recognized fields do not authorize it." });
  let focus = before === violations.length + adjudications.length ? atomicFocus(assertion) ?? inheritedFocus : null;
  for (const component of assertion.components ?? []) {
    focus = validateClaim(component, fact, component.excerpt ?? excerpt, violations, adjudications, focus);
  }
  // Failed/ambiguous components cannot supply scope to a later predicate.
  return before === violations.length + adjudications.length ? focus : null;
}

function claimRoles(assertion: Claim): string[] {
  return [...assertion.values.map((value) => value.role), ...assertion.outcomes.map(() => "outcome"),
    ...(assertion.status ? ["status-after"] : []), ...(assertion.attackOutcome ? ["hit"] : []),
    ...(assertion.receiptId ? ["receipt-id"] : []), ...(assertion.components ?? []).flatMap(claimRoles)];
}

function claimComponents(assertion: Claim): Claim[] {
  return [assertion, ...(assertion.components ?? []).flatMap(claimComponents)];
}

function atomicFocus(assertion: Claim): "event" | "target" | null {
  if (assertion.family === "check") return "event";
  if (assertion.focus) return assertion.focus;
  if (assertion.status || assertion.values.some((value) => value.role === "hp-before" || value.role === "hp-after")) return "target";
  // A labelled Target field supplies event metadata, not a new subject. Natural
  // recipient predicates (takes/passive damage, HP/status) set target focus.
  return assertion.action === "attack" || assertion.attackOutcome ? "event" : null;
}

/**
 * Opt-in public scene observations.
 *
 * The grammar is a whole-clause one: a source-resolved subject label, one
 * declared copula and one DECLARED value, or exactly two such clauses joined by
 * a bare additive `and`. Values are parsed independently of the source so an
 * opposition is a specific value contradiction, while an unknown word, modifier,
 * prefix, negation or connector is not a licence and stays adjudication-required.
 *
 * The legacy splitter cannot be reused here: it discards `and`, `but`, `while`,
 * `however` and `whereas`, so splitting first would silently authorize prose
 * whose connective meaning was thrown away.
 */
interface SceneAtom {
  readonly subjectId: string;
  readonly displayName: string;
  readonly factId: string;
  readonly predicate: ScenePredicate;
  readonly value: SceneValue;
}
interface SceneGrammar {
  readonly atoms: readonly SceneAtom[];
}
/** Case and whitespace only. It never changes a word, adds an article or a quote. */
const sceneLabel = (text: string): string => normalize(text).replace(/[,;]+$/u, "").trim();

function sceneGrammarOf(observations: readonly BoundSceneObservation[]): SceneGrammar {
  return { atoms: observations.map((observation) => ({
    subjectId: observation.subjectId, displayName: observation.displayName, factId: observation.factId,
    predicate: observation.predicate, value: observation.value,
  })) };
}

/** A public observation fact is never a check or damage receipt. */
function sceneAuthoritativeFact(fact: PublicSceneFact): AuthoritativeFact {
  return {
    receiptId: fact.factId, family: "public-observation", actor: null, target: null, action: fact.predicate,
    damageType: null, difficulty: null, subject: fact.subjectId, values: [], outcome: null, status: null,
    visibility: "public", implemented: true,
  };
}

/** Declared surface values only. `shut` is the one accepted synonym, per the guide.
 * A Map, not an object-literal lookup: an inherited key is not a declared value. */
const LIGHT_VALUES: ReadonlyMap<string, SceneValue> = new Map([["amber", "amber"], ["white", "white"]]);
const SHUTTER_VALUES: ReadonlyMap<string, SceneValue> = new Map([["closed", "closed"], ["shut", "closed"], ["open", "open"]]);

interface SceneAtomClaim {
  readonly atom: SceneAtom;
  readonly statedValue: SceneValue;
}

function parseSceneAtom(clause: string, grammar: SceneGrammar): SceneAtomClaim | null {
  const text = sceneLabel(clause);
  for (const atom of grammar.atoms) {
    const label = sceneLabel(atom.displayName);
    if (!text.startsWith(`${label} `)) continue;
    const rest = text.slice(label.length).trim();
    const values = atom.predicate === "light-colour" ? LIGHT_VALUES : SHUTTER_VALUES;
    // `[lamplight] is [colour]` and `[shutters] are [state]` are the declared
    // copulas. A mismatched subject never borrows the other's predicate.
    let match = new RegExp(`^${atom.predicate === "light-colour" ? "is" : "are"}\\s+(\\S+)$`, "u").exec(rest);
    if (!match && atom.predicate === "light-colour") match = /^has\s+(?:an?|the)\s+(\S+)\s+hue$/u.exec(rest);
    if (!match) return null;
    const statedValue = values.get(match[1]!);
    if (statedValue === undefined) return null;
    return { atom, statedValue };
  }
  return null;
}

/** Two complete observation clauses joined by a bare additive `and` (comma allowed). */
function parseSceneClause(clause: string, grammar: SceneGrammar): SceneAtomClaim[] | null {
  const single = parseSceneAtom(clause, grammar);
  if (single) return [single];
  if (grammar.atoms.length === 0) return null;
  const splits: SceneAtomClaim[][] = [];
  for (const match of clause.matchAll(/\band\b/giu)) {
    const index = match.index;
    if (index === undefined) continue;
    // Bare connector only: it must stand alone between whitespace, optionally
    // after a comma. Anything else (`and yet`, `brand`) is not a conjunction.
    if (!/[\s,]/u.test(clause.charAt(index - 1)) || !/\s/u.test(clause.charAt(index + 3))) continue;
    const left = parseSceneAtom(clause.slice(0, index), grammar);
    const right = parseSceneAtom(clause.slice(index + 3), grammar);
    if (left && right) splits.push([left, right]);
  }
  return splits.length === 1 ? splits[0]! : null;
}

function mentionsScene(text: string, grammar: SceneGrammar): boolean {
  if (grammar.atoms.length === 0) return false;
  const haystack = ` ${sceneLabel(text)} `;
  return grammar.atoms.some((atom) => haystack.includes(` ${sceneLabel(atom.displayName)} `));
}

interface NarrationSegment {
  readonly clause: string;
  /** A clause naming a scene subject stays whole and on the scene grammar. */
  readonly sceneBound: boolean;
}

/**
 * A scene-containing span is divided ONLY by semicolons into independently
 * verified clauses. A clause that names a scene subject is never retried through
 * the mechanical splitter, so no modifier, connective or suffix can disappear.
 */
function sceneSegmentsOf(text: string, grammar: SceneGrammar): NarrationSegment[] {
  const segments: NarrationSegment[] = [];
  for (const paragraph of text.split(/\n\s*\n/u).flatMap(recordScopes)) {
    if (recordHeader(paragraph.trim())) {
      segments.push({ clause: paragraph.trim(), sceneBound: mentionsScene(paragraph, grammar) });
      continue;
    }
    for (const sentence of paragraph.split(/[!?\n]+|\.(?!\d)/u)) {
      const span = sentence.trim();
      if (!span) continue;
      if (!mentionsScene(span, grammar)) {
        for (const clause of splitClauses(span)) segments.push({ clause, sceneBound: false });
        continue;
      }
      for (const part of span.split(/;/u)) {
        const piece = part.trim();
        if (!piece) continue;
        if (mentionsScene(piece, grammar)) segments.push({ clause: piece, sceneBound: true });
        else for (const clause of splitClauses(piece)) segments.push({ clause, sceneBound: false });
      }
    }
  }
  return segments;
}

function bindSceneClause(
  clause: string,
  scene: { readonly grammar: SceneGrammar },
  bindings: ClauseBinding[],
  violations: BindingViolation[],
  adjudications: GroundingAdjudication[],
): void {
  const claims = parseSceneClause(clause, scene.grammar);
  if (!claims) {
    adjudications.push({
      code: "unrecognized-clause",
      detail: "this scene clause carries tokens the public-observation grammar does not cover; no part of it is authorized",
      excerpt: clause,
      resolution: "Use a supplied subject with its declared predicate and value, join two supplied observations with a bare 'and' or ';', and keep modifiers, causes, negation and player-attention verbs out of the clause.",
    });
    return;
  }
  if (new Set(claims.map((claim) => claim.atom.subjectId)).size !== claims.length) {
    violations.push({ code: "scene-observation-contradicted", detail: "one public subject is asserted twice with different values in a single clause", excerpt: clause });
    return;
  }
  for (const claim of claims) {
    if (claim.statedValue !== claim.atom.value) {
      violations.push({ code: "scene-value-contradicted",
        detail: `the source records ${claim.atom.predicate}=${claim.atom.value}, not ${claim.statedValue}`, excerpt: clause, receiptId: claim.atom.factId });
      continue;
    }
    bindings.push({ clause, receiptId: claim.atom.factId, roles: ["scene-subject", "scene-predicate", "scene-value"] });
  }
}

/**
 * Rich verdict API. Unknown clauses and unsupported families fail closed. This
 * intentionally does not claim to prove arbitrary natural-language entailment.
 * Production's presence predicate is not called here: it cannot prove bindings,
 * and it requires omitted facts even when all actually asserted facts are true.
 */
export function evaluateGroundedNarration(text: string, receipts: readonly GroundingReceipt[], options: GroundingOptions = {}): GroundingVerdict {
  const facts = authoritativeFacts(receipts);
  const violations: BindingViolation[] = [];
  const adjudications: GroundingAdjudication[] = [];
  const bindings: ClauseBinding[] = [];
  const sceneOption = options.publicScene ?? null;
  // A legacy string allowlist and the frozen source registry are two different
  // authorities. Mixing them in one evaluation is refused, not merged.
  const mixedAuthority = sceneOption !== null && (options.authorizedConsequences ?? []).length > 0;
  if (mixedAuthority) {
    violations.push({ code: "mixed-scene-authority", detail: "legacy authorizedConsequences and the public-scene source registry cannot both authorize a clause", excerpt: "" });
  }
  let scene: {
    readonly grammar: SceneGrammar;
    readonly mode: PublicContextMode;
    readonly manifestDigest: string;
    readonly sourceId: string;
    readonly sourceCanonicalDigest: string;
    readonly scope: SceneScope;
    readonly observations: readonly BoundSceneObservation[];
    readonly factIds: readonly string[];
  } | null = null;
  if (sceneOption && !mixedAuthority) {
    // Resolved and re-validated here: before any clause is authorized and
    // before any observation fact exists.
    const resolved = resolvePublicSceneFacts({
      unitId: sceneOption.unitId, scope: sceneOption.scope, facts: sceneOption.facts, authority: sceneOption.authority,
    });
    if (!resolved.ok) {
      return {
        facts, bindings, bindingsChecked: 0, verdict: "rejected", ok: false, adjudications,
        violations: [...violations, ...resolved.refusals.map((refusal) => ({ code: refusal.code, detail: refusal.detail, excerpt: text.slice(0, 200) }))],
      };
    }
    scene = {
      grammar: sceneGrammarOf(resolved.observations), mode: resolved.mode, manifestDigest: resolved.manifestDigest,
      sourceId: resolved.sourceId, sourceCanonicalDigest: resolved.sourceCanonicalDigest,
      scope: resolved.scope, observations: resolved.observations, factIds: resolved.factIds,
    };
    for (const fact of resolved.facts) facts.push(sceneAuthoritativeFact(fact));
  }
  const clauses = scene
    ? sceneSegmentsOf(text, scene.grammar)
    : clausesOf(text).map((clause) => ({ clause, sceneBound: false as const }));
  if (clauses.length === 0) violations.push({ code: "empty-narration", detail: "there is no narration to verify", excerpt: text });
  const ids = new Set<string>();
  for (const fact of facts) {
    if (ids.has(fact.receiptId)) violations.push({ code: "duplicate-receipt-id", detail: `receipt id ${fact.receiptId} is ambiguous`, excerpt: "" });
    ids.add(fact.receiptId);
    if (fact.values.some((value) => !Number.isFinite(value.value))) violations.push({ code: "invalid-receipt-value", detail: "receipt contains a non-finite mechanical value", receiptId: fact.receiptId, excerpt: "" });
    if (!fact.implemented) adjudications.push({ code: "unsupported-receipt-family", detail: `no binding implementation for ${fact.family}`, receiptId: fact.receiptId, excerpt: "",
      resolution: `Implement a ${fact.family} authoritative-fact adapter and clause grammar with actor/target/value/outcome/temporal mutation coverage.` });
  }
  for (const forbidden of options.forbiddenConsequences ?? []) {
    if (forbidden && new RegExp(escapeRe(forbidden), "i").test(text)) violations.push({ code: "forbidden-fact-disclosed", detail: `narration discloses forbidden content: ${forbidden}`, excerpt: text.slice(0, 200) });
  }
  const authorized = new Map((options.authorizedConsequences ?? []).map((value, index) => [normalize(value.replace(/[.!?]+$/, "")), `authorized-${index + 1}`]));
  for (const [subject, receiptId] of authorized) {
    if (ids.has(receiptId)) violations.push({ code: "duplicate-receipt-id", detail: `receipt id ${receiptId} collides with a consequence fact`, excerpt: subject });
    facts.push({ receiptId, family: "authorized-consequence", actor: null, target: null,
      action: "established-consequence", damageType: null, difficulty: null, subject, values: [], outcome: null, status: null, visibility: "public", implemented: true });
  }
  let previous: AuthoritativeFact | null = null;
  let focus: "event" | "target" | null = null;
  for (const segment of clauses) {
    const clause = segment.clause;
    if (segment.sceneBound && scene) {
      bindSceneClause(clause, scene, bindings, violations, adjudications);
      // An observation is a scene property, not a mechanical continuation: it
      // clears the focus so no later fragment can borrow the attack referent.
      previous = null;
      focus = null;
      continue;
    }
    const citation = /^receipt\s+([\w-]+)$/i.exec(clause);
    if (citation) {
      if (previous && previous.receiptId === citation[1]) bindings.push({ clause, receiptId: previous.receiptId, roles: ["receipt-id"] });
      else if (previous || !facts.some((fact) => fact.receiptId === citation[1])) violations.push({ code: "receipt-binding-mismatch", detail: "the citation does not name the preceding bound receipt", excerpt: clause });
      else adjudications.push({ code: "unscoped-receipt-reference", detail: "a receipt citation alone does not establish a claim", excerpt: clause, resolution: "Associate the citation with its explicit mechanical claim." });
      continue;
    }
    let assertion = parseClause(clause);
    const family = assertion?.family ?? mechanicalFamily(clause);
    const unresolvedPronoun = /^(?:it|he|she|they|them|this|that|its|his|her|their)\b/i.test(clause);
    // An unfamiliar check paraphrase can still contain a provable contradiction.
    // An unresolved pronoun, however, supplies no receipt identity or premise.
    if (!assertion && !unresolvedPronoun && family === "check") assertion = claim("check", { outcomes: polaritiesOf(clause), complete: false });
    if (!assertion && !unresolvedPronoun && family === "damage" && NONCOMMITTED.test(clause)) assertion = claim("damage", { complete: false });
    if (assertion) {
      const before = violations.length + adjudications.length;
      const fact = bindFact(assertion, facts, previous, clause, violations, adjudications, focus);
      if (fact) {
        const nextFocus = validateClaim(assertion, fact, clause, violations, adjudications, !assertion.scopedRecord && previous === fact ? focus : null);
        if (before === violations.length + adjudications.length) {
          focus = nextFocus;
          previous = fact;
          bindings.push({ clause, receiptId: fact.receiptId, roles: claimRoles(assertion) });
        } else { previous = null; focus = null; }
      } else { previous = null; focus = null; }
      continue;
    }
    // A whole authorized clause licenses only itself, never a sibling clause.
    const authorization = authorized.get(normalize(clause));
    if (authorization) { bindings.push({ clause, receiptId: authorization, roles: ["authorized-consequence"] }); previous = null; focus = null; continue; }
    if (CONSEQUENCE.test(clause)) violations.push({ code: "fabricated-consequence", detail: "this consequence has no clause-specific authoritative fact", excerpt: clause });
    else if (family && !facts.some((fact) => fact.family === family || !fact.implemented)) violations.push({ code: "unbound-mechanical-claim", detail: `no authoritative fact establishes this ${family} claim`, excerpt: clause });
    else adjudications.push({ code: "unrecognized-clause", detail: "the clause cannot be automatically bound in full", excerpt: clause,
      resolution: "Rewrite with explicit receipt roles, implement a tested binding rule, or provide this exact atomic clause as an independently established public fact." });
    previous = null;
    focus = null;
  }
  const evidence: VerdictEvidence = { facts, bindings, bindingsChecked: new Set(bindings.map((binding) => binding.receiptId)).size };
  if (scene) {
    const requiredMechanicalIds = facts.filter((fact) => fact.family !== "public-observation").map((fact) => fact.receiptId);
    const allowedSceneFactIds = [...scene.factIds];
    const knownBindingIds = new Set([...requiredMechanicalIds, ...allowedSceneFactIds]);
    evidence.sceneProvenance = {
      manifestDigest: scene.manifestDigest,
      mode: scene.mode,
      sourceId: scene.sourceId,
      sourceCanonicalDigest: scene.sourceCanonicalDigest,
      scope: { ...scene.scope },
      requiredMechanicalIds,
      allowedSceneFactIds,
      knownBindingIds: [...knownBindingIds],
      unknownBindings: bindings.filter((binding) => !knownBindingIds.has(binding.receiptId)).map((binding) => binding.clause),
      missingMechanical: requiredMechanicalIds.filter((receiptId) => !bindings.some((binding) => binding.receiptId === receiptId)),
      usedSceneFactIds: [...new Set(bindings.filter((binding) => allowedSceneFactIds.includes(binding.receiptId)).map((binding) => binding.receiptId))],
      mechanicalBindingsChecked: new Set(bindings.filter((binding) => requiredMechanicalIds.includes(binding.receiptId)).map((binding) => binding.receiptId)).size,
      observationBindingsChecked: new Set(bindings.filter((binding) => allowedSceneFactIds.includes(binding.receiptId)).map((binding) => binding.receiptId)).size,
      observations: scene.observations,
    };
  }
  if (violations.length > 0) return { ...evidence, verdict: "rejected", ok: false, violations, adjudications };
  if (adjudications.length > 0) return { ...evidence, verdict: "adjudication-required", ok: false, adjudications };
  return { ...evidence, verdict: "verified", ok: true };
}

/** Compatible successful shape; both non-admitting verdicts throw distinct errors. */
export function validateGroundedNarration(text: string, receipts: readonly GroundingReceipt[], options: GroundingOptions = {}): { ok: true; bindingsChecked: number } {
  const result = evaluateGroundedNarration(text, receipts, options);
  if (result.verdict === "rejected") throw new GroundingFailure(result.violations);
  if (result.verdict === "adjudication-required") throw new GroundingAdjudicationRequired(result.adjudications);
  return { ok: true, bindingsChecked: result.bindingsChecked };
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

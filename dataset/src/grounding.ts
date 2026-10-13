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
 * Unknown fields, suffixes and sibling prose remain adjudication evidence.
 */
import { analyzeClaimReceipts } from "../../scripts/audit-adventure-consistency.js";
import type { providerNarrationMatchesReceipts } from "../../server/src/routes/rpg/v1/adventureTurns.js";

export const GROUNDING_VALIDATOR_VERSION = "grounding-binding-v4";

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

export interface GroundingOptions {
  /** Exact, atomic public clauses established by the world, not keyword licenses. */
  authorizedConsequences?: readonly string[];
  forbiddenConsequences?: readonly string[];
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

/** Keep complete mechanical schemas intact before considering clause boundaries. */
function clausesOf(text: string): string[] {
  const split = (text: string): string[] => {
    const clause = text.trim();
    if (!clause) return [];
    if (parseClause(clause)) return [clause];
    for (const boundary of [/[;:]+/u, /,+/u, /\b(?:and|but|yet|however|whereas|while)\b/iu]) {
      const parts = clause.split(boundary);
      if (parts.length > 1) return parts.flatMap(split);
    }
    return [clause];
  };
  return text.split(/\n\s*\n/u).flatMap(recordScopes).flatMap((paragraph) => {
    // A field record is one scope even when its fields are period-separated.
    // An unknown field must not be dropped by retrying its known fragments.
    if (recordHeader(paragraph.trim())) return [paragraph.trim()];
    return paragraph.split(/[!?\n]+|\.(?!\d)/u).flatMap(split);
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
const CHECK_NUMBERS = new RegExp(`^(.+?)\\s+(?:check\\s+)?(?:comes to|totals?|has a total of)\\s+${NUMBER}\\s+against\\s+(?:an?\\s+)?(?:(very easy|easy|medium|hard|very hard|nearly impossible)\\s+)?DC\\s+(?:of\\s+)?${NUMBER}$`, "i");
const CHECK_TOTAL = new RegExp(`^(?:(.*?)\\s+)?(?:total|totals|comes to)\\s+${NUMBER}$`, "i");
const DC = new RegExp(`^DC\\s+(?:of\\s+)?${NUMBER}$`, "i");
const OUTCOME = "(?:(?:is|was)\\s+)?(?:(?:no|not|never|did not|does not|do not)\\s+)?(?:a\\s+)?(?:success|failure|successful|unsuccessful|succeeds?|succeeded|fails?|failed)";
const CHECK_OUTCOME = new RegExp(`^(.+?\\s+check(?:\\s+(?:against|on)\\s+.+?)?)\\s+(${OUTCOME})$`, "i");
const ONLY_OUTCOME = new RegExp(`^${OUTCOME}$`, "i");
const DEALS = new RegExp(`^(.+?)\\s+(deals?|dealt|lands? for|hits? for)\\s+${NUMBER}(?:\\s+(?:(physical|bludgeoning|piercing|slashing)\\s+)?damage)?(?:\\s+to\\s+(.+))?$`, "i");
const TAKES = new RegExp(`^(.+?)\\s+(?:takes?|took|suffers?|suffered)\\s+${NUMBER}\\s+damage(?:\\s+from\\s+(.+))?$`, "i");
const HP = new RegExp(`^(.+?)\\s+(has|have|had|remains at|is at|survives? at)\\s+${NUMBER}\\s+(?:HP|hit points?)(?:\\s+(remaining|after the attack|before the attack))?$`, "i");

// Roles are names/noun phrases, not unbounded clauses containing punctuation,
// predicates or mechanical labels (notably the noun phrase "hit points").
const NAME = "[\\p{L}][\\p{L}\\p{N}'’ -]*?";
const STATUS = "(active|unconscious|stable|defeated|dead|alive)";
const DAMAGE_TYPE = "(physical|bludgeoning|piercing|slashing)";
const HP_TRANSITION = new RegExp(`^(${NAME})['’]s\\s+(?:hit points|HP)\\s+(?:go|went|fell|fall|falls) from\\s+${NUMBER}(?:\\s+before)?\\s+to\\s+${NUMBER}(?:\\s+after)?$`, "iu");
const HP_PAIR = new RegExp(`^(${NAME})['’]s\\s+hit points\\s*:?\\s*${NUMBER}\\s+before\\s*(?:,|and)\\s*${NUMBER}\\s+after$`, "iu");
const HP_POSSESSIVE = new RegExp(`^(${NAME})['’]s\\s+hit points\\s+(before|after)(?: the attack)?\\s+(?:are|were|is|was)\\s+${NUMBER}$`, "iu");
const STATUS_POSSESSIVE = new RegExp(`^(${NAME})['’]s\\s+status after(?: the attack)?(?:\\s+(?:is|was)\\s+|\\s*:\\s*)${STATUS}$`, "iu");
const PASSIVE_DAMAGE = new RegExp(`^${NUMBER}\\s+${DAMAGE_TYPE}\\s+damage (?:was|is) applied to\\s+(${NAME})(?:\\s+by\\s+(${NAME}))?$`, "iu");
const CHECK_RESOLUTION = new RegExp(`^(${NAME})\\s+(succeeded|succeeds|failed|fails) on (?:an?|the)\\s+(${NAME})\\s+check against DC\\s+${NUMBER}\\s*,?\\s*with a total of\\s+${NUMBER}$`, "iu");
const ATTACK_DAMAGE = new RegExp(`^(${NAME})\\s+(hit|hits|missed|misses)\\s+(${NAME})\\s+with a\\s+${DAMAGE_TYPE}\\s+attack for\\s+${NUMBER}\\s+damage$`, "iu");
const ATTACK_RESOLUTION = new RegExp(`^(${NAME})\\s+(?:attacked|attacks)\\s+(${NAME})\\s+and (hit|hits|missed|misses),?\\s+dealing\\s+${NUMBER}\\s+${DAMAGE_TYPE}\\s+damage$`, "iu");

function rolePhrase(text: string): boolean {
  return new RegExp(`^${NAME}$`, "iu").test(text)
    && !/^(?:the|an?)$/i.test(text) && !/^an?\s/i.test(text) && !/['’]s$/i.test(text)
    && !/\b(?:points?|status|before|after|because|with|from|to|on|is|was|are|were|has|have|go|went|and|but|yet|however|whereas|while|deals?|takes?|comes|hits?|misses|total|dc)\b/i.test(text);
}

/** A small typed field vocabulary, with exact full-value parsing. */
function parseField(text: string, family: Claim["family"]): Claim | null {
  const match = /^(?:with\s+)?(hitPointsBefore(?: for target .+?)?|hitPointsAfter(?: for target .+?)?|hit points before|hit points after|damage applied|damage type|damageType|target status after|status after|statusAfter|status|check DC|difficulty|attack roll|attack hit|attack|actor|target|kind|skill|dc|total|outcome|action|applied|damage|visibility|hit)\s*:?\s+(.+)$/i.exec(text);
  if (!match) return null;
  const key = normalize(match[1] ?? "").replace(/\s/g, "");
  const value = match[2] ?? "";
  if (["actor", "target", "skill"].includes(key)) {
    if (!rolePhrase(value)) return null;
    return claim(family, { [key === "skill" ? "subject" : key]: value });
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
  for (const match of paragraph.matchAll(/[.\n]\s+(?=(?:\*\*)?(?:receipt(?:Id)?\b|the (?:check|combat) receipt\b))/gi)) {
    const start = match.index + match[0].length;
    const header = recordHeader(paragraph.slice(start));
    // A repeated citation with only trailing metadata is part of the current
    // record. A new record must introduce its own actor association.
    if (header && /(?:^|[.;\n])\s*actor\b/i.test(header.body)) starts.push(start);
  }
  return starts.map((start, index) => paragraph.slice(start, starts[index + 1]));
}

function parseRecord(text: string): Claim | null {
  const header = recordHeader(text);
  if (!header) return null;
  const fields = header.body.split(/[;\n]+|\.(?!\d)/u).map((field) => field.trim()).filter(Boolean);
  const family = header.family ?? (fields.some((field) => /^(?:skill|kind\s*:?\s+check)\b/i.test(field)) ? "check"
    : fields.some((field) => /^(?:target|action|attack|damage|hit)\b/i.test(field)) ? "damage"
      : fields.some((field) => /^(?:dc|difficulty|total|outcome\s*:\s*(?:success|failure))\b/i.test(field)) ? "check" : null);
  if (!family) return null;
  const parsed: Claim[] = header.initial ? [{ ...header.initial, excerpt: "" }] : [];
  const unknown: string[] = [];
  const parse = (field: string): void => {
    const citation = /^(?:receipt\s+|receiptId:\s*)([\w-]+)$/i.exec(field);
    if (citation) { parsed.push(claim(family, { receiptId: citation[1]!, excerpt: field })); return; }
    const component = parseField(field, family) ?? parseRecordAtom(field, family) ?? parseAtomicClause(field) ?? parseCompound(field);
    if (component && component.family === family) { parsed.push({ ...component, excerpt: field }); return; }
    const parts = field.split(/[,;]\s*|\s+and\s+(?=target\b)/i);
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
  let match = new RegExp(`^(${NAME})\\s+(?:made an?|(?:is|are) the actor of an?)\\s+(${NAME})\\s+check(?: against DC\\s+${NUMBER})?$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("check", {
    actor: match[1]!, subject: match[2]!, values: match[3] ? [numeric("dc", Number(match[3]))] : [],
  });
  match = new RegExp(`^(${NAME})\\s+attempt(?:s|ed)?\\s+(?:the\\s+)?(${NAME})$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("check", { actor: match[1]!, subject: match[2]! });
  match = new RegExp(`^(${NAME})\\s+(?:attacks?|attacked|made an attack against|(?:is|are) the actor of an attack against)\\s+(${NAME})$`, "iu").exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("damage", { actor: match[1]!, target: damageTarget(match[2]!), action: "attack" });
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
    const split = /^(.+?)\s*[:,]\s*(.+)$/.exec(text);
    if (!split) return null;
    head = parseExplicitHead(split[1]!) ?? parseAtomicClause(split[1]!);
    if (!head) return null;
    tail = split[2]!;
  }
  // HP pairs contain their own comma/conjunction and must stay atomic.
  const parts = tail.split(/[,;:]\s*(?!-?\d+(?:\.\d+)?\s+after\b)/i);
  const components: Claim[] = [];
  for (const part of parts) {
    const component = parseAtomicClause(part.trim()) ?? parseField(part.trim(), head.family);
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

function parseAtomicClause(text: string): Claim | null {
  let match = CHECK_RESOLUTION.exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[3]!)) return claim("check", { actor: match[1]!, subject: match[3]!, outcomes: polaritiesOf(match[2]!), values: [numeric("dc", Number(match[4])), numeric("total", Number(match[5]))] });
  match = ATTACK_DAMAGE.exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[3]!)) return claim("damage", { actor: match[1]!, target: damageTarget(match[3]!), action: "attack", attackOutcome: /^hit/i.test(match[2]!) ? "hit" : "miss", damageType: match[4]!, values: [numeric("damage-applied", Number(match[5]))] });
  match = ATTACK_RESOLUTION.exec(text);
  if (match && rolePhrase(match[1]!) && rolePhrase(match[2]!)) return claim("damage", { actor: match[1]!, target: damageTarget(match[2]!), action: "attack", attackOutcome: /^hit/i.test(match[3]!) ? "hit" : "miss", damageType: match[5]!, values: [numeric("damage-applied", Number(match[4]))] });
  const explicit = parseExplicitHead(text);
  if (explicit) return explicit;
  match = HP_TRANSITION.exec(text) ?? HP_PAIR.exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", { target: damageTarget(match[1]!), values: [numeric("hp-before", Number(match[2])), numeric("hp-after", Number(match[3]))] });
  match = HP_POSSESSIVE.exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", { target: damageTarget(match[1]!), values: [numeric(normalize(match[2]!) === "before" ? "hp-before" : "hp-after", Number(match[3]))] });
  match = STATUS_POSSESSIVE.exec(text);
  if (match && rolePhrase(match[1]!)) return claim("damage", { target: damageTarget(match[1]!), status: normalize(match[2]!) });
  match = PASSIVE_DAMAGE.exec(text);
  if (match && rolePhrase(match[3]!) && (!match[4] || rolePhrase(match[4]))) return claim("damage", { target: damageTarget(match[3]!), actor: match[4] ?? null, damageType: match[2]!, values: [numeric("damage-applied", Number(match[1]))] });
  match = new RegExp(`^(?:the\\s+)?check resolves against DC\\s+${NUMBER}\\s+with a total of\\s+${NUMBER}$`, "i").exec(text);
  if (match) return claim("check", { values: [numeric("dc", Number(match[1])), numeric("total", Number(match[2]))] });
  match = new RegExp(`^(?:(?:the|roll)\\s+)?total(?: was| is)?\\s+${NUMBER}\\s+against DC\\s+${NUMBER}$`, "i").exec(text);
  if (match) return claim("check", { values: [numeric("total", Number(match[1])), numeric("dc", Number(match[2]))] });
  match = /^(?:the\s+)?outcome(?:\s*:\s*|\s+(?:(?:is|was)\s+)?)(success|failure|a hit|a miss)$/i.exec(text);
  if (match) return /^a /i.test(match[1]!) ? claim("damage", { attackOutcome: /miss$/i.test(match[1]!) ? "miss" : "hit" }) : claim("check", { outcomes: polaritiesOf(match[1]!) });
  match = new RegExp(`^(?:dealing\\s+)?${NUMBER}\\s+${DAMAGE_TYPE}\\s+damage(?: applied)?$`, "i").exec(text)
    ?? new RegExp(`^damage\\s*:\\s*${NUMBER}\\s+${DAMAGE_TYPE}$`, "i").exec(text);
  if (match) return claim("damage", { values: [numeric("damage-applied", Number(match[1]))], damageType: match[2]! });
  match = new RegExp(`^damage applied is\\s+${NUMBER}$`, "i").exec(text);
  if (match) return claim("damage", { values: [numeric("damage-applied", Number(match[1]))] });
  if (/^(?:hit(?: true)?|miss|hit false)$/i.test(text)) return claim("damage", { attackOutcome: /^(?:miss|hit false)$/i.test(text) ? "miss" : "hit" });
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
    damageType: match[4] ?? null, values: [numeric("damage-applied", Number(match[3]))],
  });
  match = TAKES.exec(text);
  if (match && rolePhrase(match[1]!) && (!match[3] || rolePhrase(match[3]))) return claim("damage", { target: damageTarget(match[1] ?? ""), actor: match[3] ?? null, values: [numeric("damage-applied", Number(match[2]))] });
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
  excerpt: string, violations: BindingViolation[], adjudications: GroundingAdjudication[]): AuthoritativeFact | null {
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
  violations: BindingViolation[], adjudications: GroundingAdjudication[]): void {
  const problem = (code: string, detail: string): void => { violations.push({ code, detail, excerpt, receiptId: fact.receiptId }); };
  const adjudicate = (code: string, detail: string, resolution: string): void => { adjudications.push({ code, detail, excerpt, resolution, receiptId: fact.receiptId }); };
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
  for (const component of assertion.components ?? []) validateClaim(component, fact, component.excerpt ?? excerpt, violations, adjudications);
}

function claimRoles(assertion: Claim): string[] {
  return [...assertion.values.map((value) => value.role), ...assertion.outcomes.map(() => "outcome"),
    ...(assertion.status ? ["status-after"] : []), ...(assertion.attackOutcome ? ["hit"] : []),
    ...(assertion.receiptId ? ["receipt-id"] : []), ...(assertion.components ?? []).flatMap(claimRoles)];
}

function claimComponents(assertion: Claim): Claim[] {
  return [assertion, ...(assertion.components ?? []).flatMap(claimComponents)];
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
  const clauses = clausesOf(text);
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
  for (const clause of clauses) {
    const citation = /^receipt\s+([\w-]+)$/i.exec(clause);
    if (citation) {
      if (previous && previous.receiptId === citation[1]) bindings.push({ clause, receiptId: previous.receiptId, roles: ["receipt-id"] });
      else if (previous || !facts.some((fact) => fact.receiptId === citation[1])) violations.push({ code: "receipt-binding-mismatch", detail: "the citation does not name the preceding bound receipt", excerpt: clause });
      else adjudications.push({ code: "unscoped-receipt-reference", detail: "a receipt citation alone does not establish a claim", excerpt: clause, resolution: "Associate the citation with its explicit mechanical claim." });
      continue;
    }
    let assertion = parseClause(clause);
    const family = assertion?.family ?? mechanicalFamily(clause);
    // An unfamiliar check paraphrase can still contain a provable contradiction.
    if (!assertion && family === "check") assertion = claim("check", { outcomes: polaritiesOf(clause), complete: false });
    if (!assertion && family === "damage" && NONCOMMITTED.test(clause)) assertion = claim("damage", { complete: false });
    if (assertion) {
      const before = violations.length + adjudications.length;
      const fact = bindFact(assertion, facts, previous, clause, violations, adjudications);
      if (fact) {
        validateClaim(assertion, fact, clause, violations, adjudications);
        previous = fact;
        if (before === violations.length + adjudications.length) bindings.push({ clause, receiptId: fact.receiptId,
          roles: claimRoles(assertion) });
      } else previous = null;
      continue;
    }
    // A whole authorized clause licenses only itself, never a sibling clause.
    const authorization = authorized.get(normalize(clause));
    if (authorization) { bindings.push({ clause, receiptId: authorization, roles: ["authorized-consequence"] }); previous = null; continue; }
    if (CONSEQUENCE.test(clause)) violations.push({ code: "fabricated-consequence", detail: "this consequence has no clause-specific authoritative fact", excerpt: clause });
    else if (family && !facts.some((fact) => fact.family === family || !fact.implemented)) violations.push({ code: "unbound-mechanical-claim", detail: `no authoritative fact establishes this ${family} claim`, excerpt: clause });
    else adjudications.push({ code: "unrecognized-clause", detail: "the clause cannot be automatically bound in full", excerpt: clause,
      resolution: "Rewrite with explicit receipt roles, implement a tested binding rule, or provide this exact atomic clause as an independently established public fact." });
    previous = null;
  }
  const evidence: VerdictEvidence = { facts, bindings, bindingsChecked: new Set(bindings.map((binding) => binding.receiptId)).size };
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

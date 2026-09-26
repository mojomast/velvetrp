/**
 * Phase 4b free-form rumor: bounded, receipted materialization of public
 * **hearsay** that fills a gap the prepared campaign never defined.
 *
 * When a player listens for gossip or asks what people are saying ("what are
 * people saying about the drowned bell?"), the server — never the model —
 * decides whether that needs new durable content and what the closed candidate
 * set is. This module:
 *
 * 1. Classifies one declaration deterministically (`classifyFreeformRumor`)
 *    against public canon (the actor's current public location and its public
 *    factions, and every accepted public clue/lore title). It returns either no
 *    intent or a bounded candidate list (currently exactly one candidate) whose
 *    identity is a deterministic digest of durable ids. A bare listening
 *    declaration with no named subject derives its subject from public canon.
 * 2. Materializes the exact chosen candidate atomically (`materializeFreeformRumor`):
 *    one public `lore` artifact carrying the **hearsay** — "a claim people repeat,
 *    attributed to a public source" — and a separate GM-only `lore` artifact
 *    carrying the server-authored **truth** — all through the existing
 *    campaign-content generation apply path.
 *
 * Hard invariants:
 * - The candidate set is server-authored and closed; callers may only select a
 *   candidate that the classifier produced. The player's bounded phrase names the
 *   subject; the hearsay text, its public attribution and the GM-only truth come
 *   from a small, deterministic server-authored rumor template set. Public canon
 *   (the current public location and its public factions) supplies the placement
 *   context. No free-form world lore and no model-authored text is accepted.
 * - **Hearsay is not established fact, and the truth is GM-only.** The public
 *   artifact is narrative canon modeled as a `lore` artifact with
 *   `visibility:'public'`; the separate `visibility:'gm'` artifact is what is
 *   actually true. The public artifact never references the GM artifact, never
 *   contains the truth text, and no story node/clue anchor is created, so the
 *   `story-public-rendering-required` trap cannot apply.
 * - **No invented mechanics.** Rumors are narrative canon only: no stats, items,
 *   prices, enemies or catalog references are created, and nothing is extracted
 *   into the `agent_observations` knowledge ledger.
 * - Every write goes through the existing generation command/receipt machinery
 *   (`createGenerationDraft` + `recordCampaignGenerationCandidate` +
 *   `applyCampaignContentGenerationDraftAtomically` -> `campaign_content_*_v42`)
 *   inside one immediate transaction. This module never writes a domain table
 *   directly and needs no migration (the content command/receipt is the durable
 *   receipt).
 * - **Fail closed.** A declaration that is not a listening/gossip declaration, or
 *   whose subject is empty, too long, already known canon, or cannot be grounded
 *   in a generated public location, produces no candidate and no write. Provider
 *   failure is never retried; a failure rolls the whole transaction back.
 * - Idempotency keys are derived from durable identities
 *   (`campaignId:sessionId:actorId:<normalized subject>`), so a replayed attempt
 *   converges on the same draft, command and receipt instead of creating a second
 *   rumor.
 */
import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  generatedArtifactKeySchema,
  generatedCampaignContentProviderSchema,
  idempotencyKeySchema,
  privateGenerationDraftSchema,
  resourceIdSchema,
  stagedCampaignContentGenerationSchema,
  type CreateGenerationDraftInput,
  type DraftMutationInput,
  type GeneratedCampaignContentProvider,
  type PrivateGenerationDraft,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";

/** Maximum length of the player-supplied rumor subject phrase. */
export const MAX_FREEFORM_RUMOR_SUBJECT_LENGTH = 160;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const RUMOR_NOUN = "(?:gossip|rumor|rumour|rumors|rumours|hearsay|news|word|talk|whisper|whispers|scuttlebutt)";
/**
 * A listening declaration either names its subject ("gossip about X", "word on
 * X", "what are people saying about X") or is a bare request to listen, which the
 * classifier grounds in public canon. The declared subject is the bounded capture.
 */
const RUMOR_SUBJECT_PATTERN = new RegExp(
  "\\b(?:(?:listen|listens|listening|ask|asks|asking|inquire|inquires|inquiring|hear|hears|hearing|catch|catches|catching|pick|picks|picking|gossip|gossips|gossiping)"
  + "\\s+(?:around\\s+)?(?:for|about|after|to|of|into|regarding|concerning)\\s+(?:(?:the|any|some)\\s+)?"
  + `${RUMOR_NOUN}\\s+(?:about|of|on|regarding|concerning)\\s+`
  + "|(?:what(?:'s| is| are|s)?\\s+(?:people|folks|they|everyone|the\\s+locals)\\s+(?:saying|say|talking|whispering|gossiping)\\s*(?:about|of|on|regarding|concerning)?\\s*)"
  + `|(?:${RUMOR_NOUN}\\s+(?:about|of|on|regarding|concerning)\\s+)`
  + ")"
  + "(?:(?:the|a|an|my|our|your)\\s+)?([A-Za-z0-9].*)$",
  "i",
);
/** A bare request to listen, with no named subject, that can be grounded in public canon. */
const RUMOR_LISTEN_PATTERN = /\b(?:listen|listens|listening|ask|asks|asking|inquire|inquires|inquiring|hear|hears|hearing|catch|catches|catching|pick|picks|picking|gossip|gossips|gossiping|eavesdrop|eavesdrops|eavesdropping)\b[\s\S]{0,80}?\b(?:gossip|rumor|rumour|rumors|rumours|hearsay|news|word|talk|whisper|whispers|scuttlebutt|saying|says|locals|people)\b/i;
const LEADING_ARTICLE = /^(?:the|a|an|my|our|your)(?:\s+|$)/i;
/** Everything from a clause connective on is a question about the subject, not part of it. */
const CLAUSE_SPLIT = /\s+(?:about|regarding|concerning|that|whether|if|which|who)\b/i;
/** Prefix marking the public hearsay artifact so a rumor is distinguishable from other lore. */
const HEARSAY_TITLE_PREFIX = "Hearsay: ";

/**
 * The closed, server-authored rumor template set. Each template is a fixed
 * hearsay shape: a keyword table that selects it, deterministic public text that
 * repeats a claim and attributes it to a public source, and a GM-only truth. No
 * stats, items, prices, enemies or catalog references appear here. `{subject}`,
 * `{location}`, `{source}` and `{faction}` are filled from bounded input and
 * public canon only.
 */
export interface FreeformRumorTemplate {
  readonly id: string;
  /** Public category label, for diagnostics only. */
  readonly label: string;
  /** Lowercase tokens that select this template from the declared subject. */
  readonly keywords: readonly string[];
  /** Deterministic public hearsay text: a repeated claim with a public attribution. */
  readonly publicText: string;
  /** Server-authored GM-only truth. Never written into a public artifact. */
  readonly gmTruth: string;
}

export const FREEFORM_RUMOR_TEMPLATES: readonly FreeformRumorTemplate[] = Object.freeze([
  Object.freeze({
    id: "market-talk", label: "Market talk",
    keywords: ["market", "merchant", "trade", "price", "coin", "goods", "caravan", "shop", "wares", "debt", "coin", "tax"],
    publicText: "Market talk in {location} repeats that {subject}; the claim is credited to {source}.",
    gmTruth: "The claim about {subject} is a half-truth: {faction} let it spread to cover a shortfall it has not repaid.",
  }),
  Object.freeze({
    id: "watch-report", label: "Watch report",
    keywords: ["watch", "guard", "soldier", "patrol", "law", "crime", "arrest", "smuggl", "smuggler", "theft", "murder", "bandit"],
    publicText: "Among the watch of {location} the line repeated is that {subject}, and they say it came from {source}.",
    gmTruth: "What is actually true of {subject} is an internal matter: {faction} has quietly corrected it and prefers the story to the details.",
  }),
  Object.freeze({
    id: "dockside", label: "Dockside talk",
    keywords: ["ship", "sail", "dock", "harbor", "harbour", "sea", "tide", "captain", "cargo", "wreck", "fisher", "river", "port"],
    publicText: "Down at the water in {location} people repeat that {subject}, a telling they attribute to {source}.",
    gmTruth: "The real account of {subject} is logged: {faction} knows what happened and keeps the rumor as cover.",
  }),
  Object.freeze({
    id: "faction-talk", label: "Faction talk",
    keywords: ["guild", "faction", "council", "noble", "house", "order", "league", "family", "rivalry", "feud", "pact", "oath"],
    publicText: "Word inside {location}'s circles holds that {subject}, and the account is laid at {source}'s door.",
    gmTruth: "The true position on {subject} is settled inside {faction}; the repeated version is the one they want said aloud.",
  }),
  Object.freeze({
    id: "wild-talk", label: "Wild talk",
    keywords: ["monster", "beast", "curse", "ghost", "witch", "dragon", "ruin", "cave", "forest", "shadow", "spirit", "omen", "plague"],
    publicText: "Travellers through {location} warn that {subject}, and they credit the story to {source}.",
    gmTruth: "The danger behind {subject} is real; {faction} holds the only reliable account and keeps it close.",
  }),
  Object.freeze({
    id: "local", label: "Local hearsay",
    keywords: [],
    publicText: "A claim going around {location} holds that {subject}, and people credit {source} for starting it.",
    gmTruth: "The truth of {subject} is known to {faction}, which prefers the version people are repeating.",
  }),
]);

/** Fail-closed reasons a declaration does not produce a materialization candidate. */
export type FreeformRumorNoneReason =
  | "no-rumor-intent"
  | "empty-subject"
  | "subject-too-long"
  | "known-rumor"
  | "no-current-location"
  | "current-location-unmapped";

/** One server-authored materialization candidate. */
export interface FreeformRumorCandidate {
  /** Stable candidate identity derived from durable ids and the normalized subject. */
  candidateId: string;
  /** Draft-local artifact key for the public hearsay artifact. */
  hearsayKey: string;
  /** Draft-local artifact key for the separate GM-only truth artifact. */
  truthKey: string;
  /** Accepted artifact key of the actor's current public location (grounding context). */
  locationKey: string;
  /** Bounded subject phrase the hearsay is about. */
  subject: string;
  /** Public source the claim is attributed to; from public canon only. */
  source: string;
  /** Deterministic hearsay text; never model-authored. */
  publicText: string;
  /** Server-authored GM-only truth; always materialized as a separate GM artifact. */
  gmTruth: string;
  /** Selecting template id, for audit. */
  templateId: string;
  visibility: "public";
}

/** Public location context used by the pure classifier. */
export interface FreeformRumorLocationContext {
  locationId: string;
  name: string;
  visibility: "public" | "discovered" | "gm";
  /** Accepted public location artifact key, when one exists. */
  artifactKey: string | null;
  /** Public names of accepted factions referenced by the location. */
  factionNames?: readonly string[];
}

export type FreeformRumorClassification =
  | { intent: "none"; reason: FreeformRumorNoneReason; title?: string }
  | { intent: "materialize-rumor"; subject: string; candidates: readonly FreeformRumorCandidate[] };

/** A materialized candidate projection returned with the receipts. */
export interface FreeformRumorMaterializedCandidate {
  candidateId: string;
  hearsayKey: string;
  truthKey: string;
  subject: string;
  source: string;
  publicText: string;
  visibility: "public";
}

export type FreeformRumorMaterialization =
  | { status: "declined"; reason: FreeformRumorNoneReason }
  | {
    status: "materialized";
    candidate: FreeformRumorMaterializedCandidate;
    /** Server resource id of the public hearsay artifact. */
    rumorId: string;
    draftId: string;
    /** Durable `campaign_content_receipts_v42` receipt for the rumor materialization. */
    contentReceiptId: string | null;
    /** Accepted artifact key of the separate GM-only truth artifact. */
    gmTruthArtifactKey: string | null;
  };

export class FreeformRumorAuthorizationError extends Error {}
export class FreeformRumorConflictError extends Error {}
export class FreeformRumorUnavailableError extends Error {}

/** Outcome of parsing one declaration before public canon is consulted. */
export type FreeformRumorDeclaration =
  | { kind: "subject"; subject: string; normalized: string }
  | { kind: "listen" }
  | { kind: "none"; reason: Extract<FreeformRumorNoneReason, "no-rumor-intent" | "empty-subject" | "subject-too-long"> };

/** Parses the bounded rumor subject out of a free-form listening declaration. */
export function parseFreeformRumorDeclaration(text: string): FreeformRumorDeclaration {
  const match = RUMOR_SUBJECT_PATTERN.exec(text.trim());
  if (match) {
    const firstSentence = (match[1] ?? "").split(/[.!?;]/, 1)[0] ?? "";
    const clause = firstSentence.split(CLAUSE_SPLIT, 1)[0] ?? "";
    const cleaned = clause.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
    const subject = cleaned.replace(LEADING_ARTICLE, "").replace(/[.,;:!?]+$/g, "").trim();
    if (!subject) return { kind: "none", reason: "empty-subject" };
    if (subject.length > MAX_FREEFORM_RUMOR_SUBJECT_LENGTH) return { kind: "none", reason: "subject-too-long" };
    return { kind: "subject", subject, normalized: normalizeRumorSubject(subject) };
  }
  if (RUMOR_LISTEN_PATTERN.test(text)) return { kind: "listen" };
  return { kind: "none", reason: "no-rumor-intent" };
}

function normalizeRumorSubject(value: string): string {
  return value.toLowerCase()
    .replace(LEADING_ARTICLE, "")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^hearsay\s+/, "")
    .replace(/^gm only truth\s+/, "")
    .trim();
}

/** Selects the first server-authored rumor template whose keyword matches a subject token. */
export function selectFreeformRumorTemplate(subject: string): FreeformRumorTemplate {
  const tokens = new Set(normalizeRumorSubject(subject).split(/[^a-z0-9]+/).filter(Boolean));
  for (const template of FREEFORM_RUMOR_TEMPLATES) {
    if (template.keywords.some((keyword) => tokens.has(keyword) || (keyword.length > 4 && [...tokens].some((token) => token.startsWith(keyword))))) {
      return template;
    }
  }
  return FREEFORM_RUMOR_TEMPLATES[FREEFORM_RUMOR_TEMPLATES.length - 1]!;
}

/**
 * The bounded subject of a bare listening declaration, derived from public canon:
 * the first public faction the location references, else the location itself.
 */
export function deriveFreeformRumorSubject(context: FreeformRumorLocationContext): string {
  const faction = context.factionNames?.find((value) => value.trim().length > 0)?.trim();
  return (faction ?? context.name).slice(0, MAX_FREEFORM_RUMOR_SUBJECT_LENGTH);
}

/** The public source a claim is attributed to; never the subject itself, and public canon only. */
function selectRumorSource(subject: string, context: FreeformRumorLocationContext): string {
  const normalized = normalizeRumorSubject(subject);
  const faction = context.factionNames?.find((value) => value.trim().length > 0 && normalizeRumorSubject(value) !== normalized)?.trim();
  return faction ?? `travellers passing through ${context.name}`;
}

/** The faction named in the GM-only truth; public canon only, with a bounded fallback. */
function selectRumorTruthFaction(context: FreeformRumorLocationContext): string {
  return context.factionNames?.find((value) => value.trim().length > 0)?.trim() ?? "the local powers";
}

function fill(template: string, values: { subject: string; location: string; source: string; faction: string }): string {
  return template.replaceAll("{subject}", values.subject).replaceAll("{location}", values.location)
    .replaceAll("{source}", values.source).replaceAll("{faction}", values.faction);
}

/**
 * Deterministic, server-owned classification. It never invents content: a
 * materialization candidate is only produced when the declaration is a listening
 * declaration naming (or, when bare, grounding in public canon) a subject that is
 * not already accepted public canon and the actor's current location is a
 * generated public location.
 */
export function classifyFreeformRumor(input: {
  identity: string;
  text: string;
  currentLocation: FreeformRumorLocationContext | null;
  knownRumorTitles: ReadonlyArray<string>;
}): FreeformRumorClassification {
  const declaration = parseFreeformRumorDeclaration(input.text);
  if (declaration.kind === "none") return { intent: "none", reason: declaration.reason };
  if (!input.currentLocation) return { intent: "none", reason: "no-current-location" };
  const artifact = input.currentLocation.artifactKey
    ? generatedArtifactKeySchema.safeParse(input.currentLocation.artifactKey)
    : null;
  if (!artifact?.success) return { intent: "none", reason: "current-location-unmapped" };

  const subject = declaration.kind === "listen"
    ? deriveFreeformRumorSubject(input.currentLocation)
    : declaration.subject;
  const normalized = normalizeRumorSubject(subject);
  const duplicate = input.knownRumorTitles.find((known) => normalizeRumorSubject(known) === normalized);
  if (duplicate !== undefined) return { intent: "none", reason: "known-rumor", title: subject };

  const template = selectFreeformRumorTemplate(subject);
  const faction = selectRumorTruthFaction(input.currentLocation);
  const source = selectRumorSource(subject, input.currentLocation);
  const values = { subject, location: input.currentLocation.name, source, faction };
  const digest = sha256(`${input.identity}:${normalized}`);
  const candidate: FreeformRumorCandidate = {
    candidateId: `ffr-${digest.slice(0, 40)}`,
    hearsayKey: generatedArtifactKeySchema.parse(`ff-rumor-hearsay-${digest.slice(0, 40)}`),
    truthKey: generatedArtifactKeySchema.parse(`ff-rumor-truth-${digest.slice(0, 40)}`),
    locationKey: artifact.data,
    subject,
    source,
    publicText: fill(template.publicText, values),
    gmTruth: fill(template.gmTruth, values),
    templateId: template.id,
    visibility: "public",
  };
  return { intent: "materialize-rumor", subject, candidates: [candidate] };
}

/** Narrow ports so the module reuses existing repos without importing their full surface. */
export interface FreeformRumorPorts {
  getDraftByIdempotencyKey(principalId: string, campaignId: string, idempotencyKey: string): unknown;
  createDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  getContentRevision(principalId: string, campaignId: string): number | null;
  recordCandidate(draftId: string, content: GeneratedCampaignContentProvider): void;
  applyDraft(principalId: string, input: DraftMutationInput & { selectedArtifactKeys: string[] }): PrivateGenerationDraft;
}

export interface FreeformRumorRepository {
  /** Classifies one declaration; throws only for unauthorized principals. */
  classifyFreeformRumorIntent(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformRumorClassification;
  /** Applies the exact server-authored candidate atomically. */
  materializeFreeformRumor(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string,
    options?: { candidateId?: string }): FreeformRumorMaterialization;
}

type PlacementRow = { location_id: string; public_name: string; visibility: "public" | "discovered" | "gm" };

export function createFreeformRumorRepository(
  db: DatabaseDriver.Database,
  deps: { clock: Clock },
  ports: FreeformRumorPorts,
  guard: () => void,
): FreeformRumorRepository {
  const now = (): string => deps.clock.now().toISOString();

  function authorize(principalId: string, campaignId: string, actorId: string): void {
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new FreeformRumorAuthorizationError("campaign membership is required");
    if (member.role === "owner" || member.role === "gm") return;
    if (!db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(campaignId, actorId, principalId)) throw new FreeformRumorAuthorizationError("principal cannot act for the actor");
  }

  /** Resolves GM materialization authority exactly as `initiateCombat` does. */
  function gmAuthorityPrincipal(principalId: string, campaignId: string): string | null {
    if (db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')")
      .get(campaignId, principalId)) return principalId;
    const row = db.prepare(`SELECT membership.principal_id principal_id FROM campaign_memberships membership
      JOIN campaigns campaign ON campaign.id=membership.campaign_id
      WHERE membership.campaign_id=? AND membership.role IN ('owner','gm')
      ORDER BY CASE WHEN membership.principal_id=campaign.owner_principal_id THEN 0 ELSE 1 END,membership.principal_id
      LIMIT 1`).get(campaignId) as { principal_id: string } | undefined;
    return row?.principal_id ?? null;
  }

  function readCurrentLocation(campaignId: string, sessionId: string, actorId: string): FreeformRumorLocationContext | null {
    const row = db.prepare(`SELECT placement.location_id,location.public_name,location.visibility
      FROM campaign_actor_locations_v28 placement
      JOIN campaign_locations_v28 location ON location.campaign_id=placement.campaign_id AND location.location_id=placement.location_id
      WHERE placement.campaign_id=? AND placement.actor_id=? AND placement.session_id=?`)
      .get(campaignId, actorId, sessionId) as PlacementRow | undefined;
    if (!row) return null;
    const artifact = db.prepare(`SELECT artifact_key,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND server_resource_id=? AND artifact_kind='location' AND visibility='public' LIMIT 1`)
      .get(campaignId, row.location_id) as { artifact_key: string; canonical_json: string } | undefined;
    if (!artifact) return { locationId: row.location_id, name: row.public_name, visibility: row.visibility, artifactKey: null, factionNames: [] };
    // Only accepted public factions referenced by the location may become rumor context.
    const referenced = (JSON.parse(artifact.canonical_json) as { factionKeys?: unknown }).factionKeys;
    const factionNames = Array.isArray(referenced)
      ? referenced.filter((value): value is string => typeof value === "string").flatMap((key) => {
        const faction = db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='faction' AND visibility='public'`).get(campaignId, key) as { canonical_json: string } | undefined;
        if (!faction) return [];
        const name = (JSON.parse(faction.canonical_json) as { name?: unknown }).name;
        return typeof name === "string" && name.trim().length > 0 ? [name] : [];
      })
      : [];
    return { locationId: row.location_id, name: row.public_name, visibility: row.visibility, artifactKey: artifact.artifact_key, factionNames };
  }

  function readKnownRumorTitles(campaignId: string): string[] {
    return (db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND visibility='public' AND artifact_kind IN ('clue','lore') ORDER BY accepted_at,artifact_key`)
      .all(campaignId) as Array<{ canonical_json: string }>).flatMap((row) => {
      const title = (JSON.parse(row.canonical_json) as { title?: unknown }).title;
      return typeof title === "string" ? [title] : [];
    });
  }

  function classifyWithContext(identity: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformRumorClassification {
    return classifyFreeformRumor({
      identity, text,
      currentLocation: readCurrentLocation(campaignId, sessionId, actorId),
      knownRumorTitles: readKnownRumorTitles(campaignId),
    });
  }

  /**
   * Replays a previously committed materialization. All writes already happened
   * in one transaction, so a stored draft is proof the public hearsay and the
   * separate GM-only truth exist. The receipt is read back from the durable
   * content command rather than re-issued.
   */
  function replayMaterialization(authority: string, campaignId: string, identity: string, normalized: string): FreeformRumorMaterialization {
    const draftKey = idempotencyKeySchema.parse(`ff-rumor-draft-${sha256(`${identity}:${normalized}`).slice(0, 48)}`);
    const existing = ports.getDraftByIdempotencyKey(authority, campaignId, draftKey);
    if (!existing) throw new FreeformRumorConflictError("materialization replay is unavailable");
    const draft = privateGenerationDraftSchema.parse(existing);
    const hearsay = db.prepare(`SELECT artifact_key,server_resource_id,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='public' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string; server_resource_id: string | null; canonical_json: string } | undefined;
    if (!hearsay?.server_resource_id) throw new FreeformRumorConflictError("materialized rumor is unavailable");
    const truth = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
    const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
      .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
    const value = JSON.parse(hearsay.canonical_json) as { title?: string; summary?: string };
    const title = typeof value.title === "string" ? value.title : "";
    return {
      status: "materialized",
      candidate: {
        candidateId: `ffr-${sha256(`${identity}:${normalized}`).slice(0, 40)}`,
        hearsayKey: hearsay.artifact_key,
        truthKey: truth?.artifact_key ?? "",
        subject: title.startsWith(HEARSAY_TITLE_PREFIX) ? title.slice(HEARSAY_TITLE_PREFIX.length) : normalized,
        source: "",
        publicText: typeof value.summary === "string" ? value.summary : "",
        visibility: "public",
      },
      rumorId: hearsay.server_resource_id,
      draftId: draft.draftId,
      contentReceiptId: receipt?.receipt_id ?? null,
      gmTruthArtifactKey: truth?.artifact_key ?? null,
    };
  }

  return {
    classifyFreeformRumorIntent(principalId, campaignId, sessionId, actorId, text) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);
      return classifyWithContext(`${campaignId}:${sessionId}:${actorId}`, campaignId, sessionId, actorId, text);
    },

    materializeFreeformRumor(principalId, campaignId, sessionId, actorId, text, options) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);

      const declaration = parseFreeformRumorDeclaration(text);
      if (declaration.kind === "none") return { status: "declined" as const, reason: declaration.reason };
      // A named subject hashes immediately; a bare listening declaration hashes on
      // the subject the classifier derives from public canon.
      const identity = `${campaignId}:${sessionId}:${actorId}`;
      const derivedContext = declaration.kind === "listen" ? readCurrentLocation(campaignId, sessionId, actorId) : null;
      const subject = declaration.kind === "listen"
        ? (derivedContext ? deriveFreeformRumorSubject(derivedContext) : null)
        : declaration.subject;
      const normalized = subject === null ? null : normalizeRumorSubject(subject);
      const digest = normalized === null ? null : sha256(`${identity}:${normalized}`);
      const candidateId = digest === null ? null : `ffr-${digest.slice(0, 40)}`;
      if (options?.candidateId !== undefined && candidateId !== null && options.candidateId !== candidateId) {
        throw new FreeformRumorConflictError("the chosen candidate is not in the server-authored set");
      }
      const authority = gmAuthorityPrincipal(principalId, campaignId);
      if (!authority) throw new FreeformRumorUnavailableError("campaign has no GM authority to materialize a rumor");

      return db.transaction(() => {
        if (digest !== null && ports.getDraftByIdempotencyKey(authority, campaignId,
          idempotencyKeySchema.parse(`ff-rumor-draft-${digest.slice(0, 48)}`))) {
          return replayMaterialization(authority, campaignId, identity, normalized!);
        }

        // Freshness re-check: only materialize a subject the classifier still authorizes.
        const classification = classifyWithContext(identity, campaignId, sessionId, actorId, text);
        if (classification.intent === "none") return { status: "declined" as const, reason: classification.reason };
        const candidate = candidateId === null
          ? classification.candidates[0]!
          : classification.candidates.find((value) => value.candidateId === candidateId);
        if (!candidate) throw new FreeformRumorConflictError("the chosen candidate is no longer available");
        if (options?.candidateId !== undefined && options.candidateId !== candidate.candidateId) {
          throw new FreeformRumorConflictError("the chosen candidate is not in the server-authored set");
        }

        const freshDigest = sha256(`${identity}:${normalizeRumorSubject(candidate.subject)}`);
        const draftKey = idempotencyKeySchema.parse(`ff-rumor-draft-${freshDigest.slice(0, 48)}`);
        const applyKey = idempotencyKeySchema.parse(`ff-rumor-apply-${freshDigest.slice(0, 48)}`);
        if (ports.getDraftByIdempotencyKey(authority, campaignId, draftKey)) {
          return replayMaterialization(authority, campaignId, identity, normalizeRumorSubject(candidate.subject));
        }

        const campaign = db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?")
          .get(campaignId) as { active_timeline_id: string; administration_revision: number } | undefined;
        if (!campaign) throw new FreeformRumorUnavailableError("campaign is unavailable");

        // Public hearsay (a repeated claim with a public attribution) and a
        // separate GM-only truth. The public artifact never references the GM one.
        const content = generatedCampaignContentProviderSchema.parse({
          lore: [
            {
              key: candidate.hearsayKey, title: `${HEARSAY_TITLE_PREFIX}${candidate.subject}`, summary: candidate.publicText,
              details: [], visibility: "public", locationKeys: [candidate.locationKey], factionKeys: [], storyNodeKeys: [],
            },
            {
              key: candidate.truthKey, title: `GM-only truth: ${candidate.subject}`, summary: candidate.gmTruth,
              details: [], visibility: "gm", locationKeys: [], factionKeys: [], storyNodeKeys: [],
            },
          ],
        });
        const selectedArtifactKeys = [candidate.hearsayKey, candidate.truthKey];
        const requestDigest = sha256(canonical({ kind: "freeform-materialize-rumor", campaignId, sessionId, actorId, candidate }));

        const baseRevision = ports.getContentRevision(authority, campaignId);
        if (baseRevision === null) throw new FreeformRumorUnavailableError("generation context is unavailable");
        const draft = ports.createDraft(authority, {
          campaignId, timelineId: campaign.active_timeline_id, sessionId, kind: "content-pack",
          stagedContent: stagedCampaignContentGenerationSchema.parse({
            kind: "campaign-content", requestDigest, baseContentRevision: baseRevision, dependencyDigests: {}, ...content,
          }),
          validation: { valid: true, issues: [], validatedAt: now() },
          expectedCampaignRevision: campaign.administration_revision,
          idempotencyKey: draftKey,
        });
        if (!db.prepare("SELECT 1 FROM campaign_generation_candidate_artifacts_v52 WHERE draft_id=? LIMIT 1").get(draft.draftId)) {
          ports.recordCandidate(draft.draftId, content);
        }
        const applied = ports.applyDraft(authority, {
          draftId: draft.draftId, expectedDraftRevision: draft.revision, expectedCampaignRevision: draft.campaignRevision,
          idempotencyKey: applyKey, selectedArtifactKeys,
        });

        const hearsay = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='lore'`).get(campaignId, candidate.hearsayKey) as { server_resource_id: string | null } | undefined;
        if (!hearsay?.server_resource_id) throw new FreeformRumorConflictError("materialized rumor is unavailable");
        const truth = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
          .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
        const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
          .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
        return {
          status: "materialized" as const,
          candidate: {
            candidateId: candidate.candidateId, hearsayKey: candidate.hearsayKey, truthKey: candidate.truthKey,
            subject: candidate.subject, source: candidate.source, publicText: candidate.publicText, visibility: "public" as const,
          },
          rumorId: hearsay.server_resource_id,
          draftId: applied.draftId,
          contentReceiptId: receipt?.receipt_id ?? null,
          gmTruthArtifactKey: truth?.artifact_key ?? null,
        };
      }).immediate();
    },
  };
}

/**
 * Phase 4a free-form clue/lore: bounded, receipted materialization of a public
 * clue that fills a gap the prepared campaign never defined.
 *
 * When a player declares a discovered rumor, clue or local lore note ("I recall
 * the legend of the drowned bell"), the server — never the model — decides
 * whether that needs new durable content and what the closed candidate set is.
 * This module:
 *
 * 1. Classifies one declaration deterministically (`classifyFreeformLore`)
 *    against public canon (the actor's current public location, its public
 *    factions, and every accepted public clue/lore title). It returns either no
 *    intent or a bounded candidate list (currently exactly one candidate) whose
 *    identity is a deterministic digest of durable ids.
 * 2. Materializes the exact chosen candidate atomically (`materializeFreeformLore`):
 *    a public `story-node` (the clue's public source), a public `clue` that
 *    reveals it, and a **separate** GM-only `lore` artifact carrying the
 *    server-authored truth — all through the existing campaign-content generation
 *    apply path.
 *
 * Hard invariants:
 * - The candidate set is server-authored and closed; callers may only select a
 *   candidate that the classifier produced. The player's bounded phrase names the
 *   subject; the title, public text and GM-only truth come from a small,
 *   deterministic server-authored template set. Public canon (the current public
 *   location and its public factions) supplies the placement context. No
 *   free-form world lore and no model-authored text is accepted.
 * - **Public rendering trap avoided.** A clue names a `revealsStoryNodeKey` and a
 *   public `story-node` is selected in the same draft, so no synthetic hidden
 *   anchor node is created. Both the clue and its source node are
 *   `visibility:'public'`; the GM-only truth never appears in either public
 *   artifact and the public clue never references the GM artifact.
 * - Every write goes through the existing command/receipt machinery
 *   (`createGenerationDraft` + `recordCampaignGenerationCandidate` +
 *   `applyCampaignContentGenerationDraftAtomically` -> `campaign_content_*_v42`)
 *   inside one immediate transaction. This module never writes a domain table
 *   directly and needs no migration (the content command/receipt is the durable
 *   receipt; see the design note below).
 * - **No fabricated mechanics.** Clues and lore are narrative canon only: no
 *   stats, items, prices, enemies, or catalog references are created.
 * - Idempotency keys are derived from durable identities
 *   (`campaignId:sessionId:actorId:<normalized subject>`), so a replayed attempt
 *   converges on the same draft, command and receipt instead of creating a second
 *   clue.
 *
 * Design note (no migration this pass): `docs/freeform-generation-research.md`
 * §2.0/§5 proposes a free-form sidecar (`freeform_materializations_v61`) for
 * cross-referencing ids. It does not exist, and clues/lore have no built-in
 * command table, so this pass reuses the existing generation-content
 * command/receipt path as the durable receipt and relies on deterministic
 * artifact keys for replay. A sidecar remains the recommended follow-up; it is not
 * required for correctness or idempotency here.
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

/** Maximum length of the player-supplied lore/clue subject phrase. */
export const MAX_FREEFORM_LORE_SUBJECT_LENGTH = 160;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * A lore declaration either asks after a subject (`recall`/`remember`/... about
 * X) or names a lore noun directly (`the legend of X`). The declared subject is
 * the bounded capture.
 */
const LORE_PATTERN = /\b(?:(?:recall|recalls|recalling|remember|remembers|remembering|recollect|recollects|recollecting|learn|learns|learning|research|researches|researching|investigate|investigates|investigating|study|studies|studying|inquire|inquires|inquiring|wonder|wonders|wondering|hear|hears|hearing|heard)\s+(?:about|of|into|regarding|concerning)\s+|(?:legend|legendary|rumor|rumour|rumors|rumours|lore|tale|tales|story|stories|myth|myths|gossip|history|histories|account|accounts)\s+(?:about|of)\s+)(?:(?:the|a|an|my|our|your)\s+)?(.+)$/i;
const LEADING_ARTICLE = /^(?:the|a|an|my|our|your)\s+/i;
/** Everything from a clause connective on is a question about the subject, not part of it. */
const CLAUSE_SPLIT = /\s+(?:about|regarding|concerning|that|whether|if|which|who)\b/i;

/**
 * The closed, server-authored lore template set. Each template is a fixed
 * narrative shape: keyword table that selects it, deterministic public text, and
 * a GM-only truth. No stats, items, prices, enemies or catalog references appear
 * here. `{subject}`, `{location}` and `{faction}` are filled from bounded input
 * and public canon only.
 */
export interface FreeformLoreTemplate {
  readonly id: string;
  /** Public category label, for diagnostics only. */
  readonly label: string;
  /** Lowercase tokens that select this template from the declared subject. */
  readonly keywords: readonly string[];
  /** Deterministic public clue text. */
  readonly publicText: string;
  /** Server-authored GM-only truth. Never written into a public artifact. */
  readonly gmSecret: string;
}

export const FREEFORM_LORE_TEMPLATES: readonly FreeformLoreTemplate[] = Object.freeze([
  Object.freeze({
    id: "local-history", label: "Local history",
    keywords: ["founding", "founder", "founders", "history", "ancient", "ruin", "ruins", "old", "first", "settlement", "wall", "walls", "charter", "treaty"],
    publicText: "A worn local history of {location} holds that {subject} shaped the district long before living memory, though the surviving pages disagree on the dates.",
    gmSecret: "The account is true in outline: {subject} was real, and {faction} still keeps the oldest surviving record of it.",
  }),
  Object.freeze({
    id: "disaster", label: "Disaster",
    keywords: ["fire", "flood", "plague", "storm", "shipwreck", "wreck", "collapsed", "collapse", "famine", "disaster", "quake", "tide", "blight"],
    publicText: "People of {location} still speak carefully of {subject}, and no two accounts agree on who was lost.",
    gmSecret: "The disaster behind {subject} was caused by a decision {faction} has never admitted; evidence survives in a sealed record.",
  }),
  Object.freeze({
    id: "scandal", label: "Scandal",
    keywords: ["murder", "crime", "theft", "scandal", "betrayal", "conspiracy", "smuggl", "smuggler", "bandit", "pirate", "poison", "debt", "missing"],
    publicText: "A guarded local rumor around {location} links {subject} to old money and older grudges.",
    gmSecret: "The rumor about {subject} is deliberately incomplete; a member of {faction} is quietly keeping the missing part buried.",
  }),
  Object.freeze({
    id: "legend", label: "Legend",
    keywords: ["legend", "myth", "curse", "prophecy", "spirit", "ghost", "haunt", "monster", "beast", "witch", "dragon", "omen", "song"],
    publicText: "The legend of {subject} is told in {location} to warn children and comfort travellers, usually in the same breath.",
    gmSecret: "Beneath the legend of {subject} is a verifiable fact that {faction} would rather remain a story.",
  }),
  Object.freeze({
    id: "custom", label: "Local custom",
    keywords: ["guild", "trade", "market", "festival", "custom", "tradition", "oath", "pact", "rivalry", "feud", "bargain", "contract"],
    publicText: "An old custom of {location} surrounds {subject}, kept more out of habit than belief.",
    gmSecret: "The custom tied to {subject} exists because of an unrecorded agreement between {faction} and an outside party.",
  }),
  Object.freeze({
    id: "local", label: "Local rumor",
    keywords: [],
    publicText: "A half-remembered local rumor of {location} concerns {subject}.",
    gmSecret: "The rumor about {subject} is partly true; {faction} holds the rest of the account.",
  }),
]);

/** Fail-closed reasons a declaration does not produce a materialization candidate. */
export type FreeformLoreNoneReason =
  | "no-lore-intent"
  | "empty-subject"
  | "subject-too-long"
  | "known-lore"
  | "no-current-location"
  | "current-location-unmapped";

/** One server-authored materialization candidate. */
export interface FreeformLoreCandidate {
  /** Stable candidate identity derived from durable ids and the normalized subject. */
  candidateId: string;
  /** Draft-local artifact key for the public source story node. */
  sourceNodeKey: string;
  /** Draft-local artifact key for the public clue. */
  clueKey: string;
  /** Draft-local artifact key for the separate GM-only truth artifact. */
  gmSecretKey: string;
  /** Accepted artifact key of the actor's current public location (grounding context). */
  locationKey: string;
  /** Bounded player phrase used as the clue title. */
  title: string;
  /** Deterministic template text; never model-authored lore. */
  publicText: string;
  /** Server-authored GM-only truth; always materialized as a separate GM artifact. */
  gmSecret: string;
  /** Selecting template id, for audit. */
  templateId: string;
  visibility: "public";
}

/** Public location context used by the pure classifier. */
export interface FreeformLoreLocationContext {
  locationId: string;
  name: string;
  visibility: "public" | "discovered" | "gm";
  /** Accepted public location artifact key, when one exists. */
  artifactKey: string | null;
  /** Public names of accepted factions referenced by the location. */
  factionNames?: readonly string[];
}

export type FreeformLoreClassification =
  | { intent: "none"; reason: FreeformLoreNoneReason; title?: string }
  | { intent: "materialize-lore"; subject: string; candidates: readonly FreeformLoreCandidate[] };

/** A materialized candidate projection returned with the receipts. */
export interface FreeformLoreMaterializedCandidate {
  candidateId: string;
  clueKey: string;
  sourceNodeKey: string;
  gmSecretKey: string;
  title: string;
  visibility: "public";
}

export type FreeformLoreMaterialization =
  | { status: "declined"; reason: FreeformLoreNoneReason }
  | {
    status: "materialized";
    candidate: FreeformLoreMaterializedCandidate;
    /** Server resource id of the public clue artifact. */
    clueId: string;
    /** Server resource id of the public source story node. */
    sourceStoryNodeId: string;
    draftId: string;
    /** Durable `campaign_content_receipts_v42` receipt for the clue materialization. */
    contentReceiptId: string | null;
    /** Accepted artifact key of the separate GM-only truth artifact, when written. */
    gmSecretArtifactKey: string | null;
  };

export class FreeformLoreAuthorizationError extends Error {}
export class FreeformLoreConflictError extends Error {}
export class FreeformLoreUnavailableError extends Error {}

/** Parses the bounded lore/clue subject out of a free-form declaration. */
export function parseFreeformLoreSubject(text: string):
  | { ok: true; subject: string; normalized: string }
  | { ok: false; reason: Extract<FreeformLoreNoneReason, "no-lore-intent" | "empty-subject" | "subject-too-long"> } {
  const match = LORE_PATTERN.exec(text.trim());
  if (!match) return { ok: false, reason: "no-lore-intent" };
  const firstSentence = (match[1] ?? "").split(/[.!?;]/, 1)[0] ?? "";
  const clause = firstSentence.split(CLAUSE_SPLIT, 1)[0] ?? "";
  const cleaned = clause.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
  const subject = cleaned.replace(LEADING_ARTICLE, "").replace(/[.,;:!?]+$/g, "").trim();
  if (!subject) return { ok: false, reason: "empty-subject" };
  if (subject.length > MAX_FREEFORM_LORE_SUBJECT_LENGTH) return { ok: false, reason: "subject-too-long" };
  return { ok: true, subject, normalized: normalizeLoreSubject(subject) };
}

function normalizeLoreSubject(value: string): string {
  return value.toLowerCase().replace(LEADING_ARTICLE, "").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Selects the first server-authored template whose keyword matches a subject token. */
export function selectFreeformLoreTemplate(subject: string): FreeformLoreTemplate {
  const tokens = new Set(normalizeLoreSubject(subject).split(/[^a-z0-9]+/).filter(Boolean));
  for (const template of FREEFORM_LORE_TEMPLATES) {
    if (template.keywords.some((keyword) => tokens.has(keyword) || (keyword.length > 4 && [...tokens].some((token) => token.startsWith(keyword))))) {
      return template;
    }
  }
  return FREEFORM_LORE_TEMPLATES[FREEFORM_LORE_TEMPLATES.length - 1]!;
}

function fill(template: string, values: { subject: string; location: string; faction: string }): string {
  return template.replaceAll("{subject}", values.subject).replaceAll("{location}", values.location).replaceAll("{faction}", values.faction);
}

/**
 * Deterministic, server-owned classification. It never invents content: a
 * materialization candidate is only produced when the declaration names a lore
 * subject that is not already accepted canon and the actor's current location is
 * a generated public location that the generation apply can anchor the clue to.
 */
export function classifyFreeformLore(input: {
  identity: string;
  text: string;
  currentLocation: FreeformLoreLocationContext | null;
  knownLoreTitles: ReadonlyArray<string>;
}): FreeformLoreClassification {
  const parsed = parseFreeformLoreSubject(input.text);
  if (!parsed.ok) return { intent: "none", reason: parsed.reason };
  const { subject, normalized } = parsed;

  const duplicate = input.knownLoreTitles.find((known) => normalizeLoreSubject(known) === normalized);
  if (duplicate !== undefined) return { intent: "none", reason: "known-lore", title: duplicate };
  if (!input.currentLocation) return { intent: "none", reason: "no-current-location" };
  const artifact = input.currentLocation.artifactKey
    ? generatedArtifactKeySchema.safeParse(input.currentLocation.artifactKey)
    : null;
  if (!artifact?.success) return { intent: "none", reason: "current-location-unmapped" };

  const template = selectFreeformLoreTemplate(subject);
  const faction = input.currentLocation.factionNames?.find((value) => value.trim().length > 0) ?? "the local powers";
  const digest = sha256(`${input.identity}:${normalized}`);
  const candidate: FreeformLoreCandidate = {
    candidateId: `ffl-${digest.slice(0, 40)}`,
    sourceNodeKey: generatedArtifactKeySchema.parse(`ff-lore-source-${digest.slice(0, 40)}`),
    clueKey: generatedArtifactKeySchema.parse(`ff-lore-clue-${digest.slice(0, 40)}`),
    gmSecretKey: generatedArtifactKeySchema.parse(`ff-lore-truth-${digest.slice(0, 40)}`),
    locationKey: artifact.data,
    title: subject,
    publicText: fill(template.publicText, { subject, location: input.currentLocation.name, faction }),
    gmSecret: fill(template.gmSecret, { subject, location: input.currentLocation.name, faction }),
    templateId: template.id,
    visibility: "public",
  };
  return { intent: "materialize-lore", subject, candidates: [candidate] };
}

/** Narrow ports so the module reuses existing repos without importing their full surface. */
export interface FreeformLorePorts {
  getDraftByIdempotencyKey(principalId: string, campaignId: string, idempotencyKey: string): unknown;
  createDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  getContentRevision(principalId: string, campaignId: string): number | null;
  recordCandidate(draftId: string, content: GeneratedCampaignContentProvider): void;
  applyDraft(principalId: string, input: DraftMutationInput & { selectedArtifactKeys: string[] }): PrivateGenerationDraft;
}

export interface FreeformLoreRepository {
  /** Classifies one declaration; throws only for unauthorized principals. */
  classifyFreeformLoreIntent(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformLoreClassification;
  /** Applies the exact server-authored candidate atomically. */
  materializeFreeformLore(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string,
    options?: { candidateId?: string }): FreeformLoreMaterialization;
}

type PlacementRow = { location_id: string; public_name: string; visibility: "public" | "discovered" | "gm" };

export function createFreeformLoreRepository(
  db: DatabaseDriver.Database,
  deps: { clock: Clock },
  ports: FreeformLorePorts,
  guard: () => void,
): FreeformLoreRepository {
  const now = (): string => deps.clock.now().toISOString();

  function authorize(principalId: string, campaignId: string, actorId: string): void {
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new FreeformLoreAuthorizationError("campaign membership is required");
    if (member.role === "owner" || member.role === "gm") return;
    if (!db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(campaignId, actorId, principalId)) throw new FreeformLoreAuthorizationError("principal cannot act for the actor");
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

  function readCurrentLocation(campaignId: string, sessionId: string, actorId: string): FreeformLoreLocationContext | null {
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
    // Only accepted public factions referenced by the location may become lore context.
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

  function readKnownLoreTitles(campaignId: string): string[] {
    return (db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND visibility='public' AND artifact_kind IN ('clue','lore') ORDER BY accepted_at,artifact_key`)
      .all(campaignId) as Array<{ canonical_json: string }>).flatMap((row) => {
      const title = (JSON.parse(row.canonical_json) as { title?: unknown }).title;
      return typeof title === "string" ? [title] : [];
    });
  }

  function classifyWithContext(identity: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformLoreClassification {
    return classifyFreeformLore({
      identity, text,
      currentLocation: readCurrentLocation(campaignId, sessionId, actorId),
      knownLoreTitles: readKnownLoreTitles(campaignId),
    });
  }

  /**
   * Replays a previously committed materialization. All writes already happened
   * in one transaction, so a stored draft is proof the clue, its public source
   * node and the separate GM-only truth exist. The receipt is read back from the
   * durable content command rather than re-issued.
   */
  function replayMaterialization(authority: string, campaignId: string, identity: string, normalized: string): FreeformLoreMaterialization {
    const draftKey = idempotencyKeySchema.parse(`ff-lore-draft-${sha256(`${identity}:${normalized}`).slice(0, 48)}`);
    const existing = ports.getDraftByIdempotencyKey(authority, campaignId, draftKey);
    if (!existing) throw new FreeformLoreConflictError("materialization replay is unavailable");
    const draft = privateGenerationDraftSchema.parse(existing);
    const clue = db.prepare(`SELECT artifact_key,server_resource_id,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='clue' AND visibility='public' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string; server_resource_id: string | null; canonical_json: string } | undefined;
    const node = db.prepare(`SELECT artifact_key,server_resource_id FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='story-node' AND visibility='public' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string; server_resource_id: string | null } | undefined;
    if (!clue?.server_resource_id || !node?.server_resource_id) throw new FreeformLoreConflictError("materialized clue is unavailable");
    const secret = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
    const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
      .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
    const value = JSON.parse(clue.canonical_json) as { title?: string };
    return {
      status: "materialized",
      candidate: { candidateId: `ffl-${sha256(`${identity}:${normalized}`).slice(0, 40)}`, clueKey: clue.artifact_key,
        sourceNodeKey: node.artifact_key, gmSecretKey: secret?.artifact_key ?? "", title: typeof value.title === "string" ? value.title : normalized, visibility: "public" },
      clueId: clue.server_resource_id,
      sourceStoryNodeId: node.server_resource_id,
      draftId: draft.draftId,
      contentReceiptId: receipt?.receipt_id ?? null,
      gmSecretArtifactKey: secret?.artifact_key ?? null,
    };
  }

  return {
    classifyFreeformLoreIntent(principalId, campaignId, sessionId, actorId, text) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);
      return classifyWithContext(`${campaignId}:${sessionId}:${actorId}`, campaignId, sessionId, actorId, text);
    },

    materializeFreeformLore(principalId, campaignId, sessionId, actorId, text, options) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);

      const parsed = parseFreeformLoreSubject(text);
      if (!parsed.ok) return { status: "declined" as const, reason: parsed.reason };
      const identity = `${campaignId}:${sessionId}:${actorId}`;
      const digest = sha256(`${identity}:${parsed.normalized}`);
      const candidateId = `ffl-${digest.slice(0, 40)}`;
      const draftKey = idempotencyKeySchema.parse(`ff-lore-draft-${digest.slice(0, 48)}`);
      const applyKey = idempotencyKeySchema.parse(`ff-lore-apply-${digest.slice(0, 48)}`);
      if (options?.candidateId !== undefined && options.candidateId !== candidateId) {
        throw new FreeformLoreConflictError("the chosen candidate is not in the server-authored set");
      }
      const authority = gmAuthorityPrincipal(principalId, campaignId);
      if (!authority) throw new FreeformLoreUnavailableError("campaign has no GM authority to materialize lore");

      return db.transaction(() => {
        if (ports.getDraftByIdempotencyKey(authority, campaignId, draftKey)) {
          return replayMaterialization(authority, campaignId, identity, parsed.normalized);
        }

        // Freshness re-check: only materialize a subject the classifier still authorizes.
        const classification = classifyWithContext(identity, campaignId, sessionId, actorId, text);
        if (classification.intent === "none") return { status: "declined" as const, reason: classification.reason };
        const candidate = classification.candidates.find((value) => value.candidateId === candidateId);
        if (!candidate) throw new FreeformLoreConflictError("the chosen candidate is no longer available");

        const campaign = db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?")
          .get(campaignId) as { active_timeline_id: string; administration_revision: number } | undefined;
        if (!campaign) throw new FreeformLoreUnavailableError("campaign is unavailable");

        // Public clue + public source node only. The GM-only truth is a separate
        // `visibility:'gm'` artifact and is never referenced by the public clue.
        const content = generatedCampaignContentProviderSchema.parse({
          storyNodes: [{
            key: candidate.sourceNodeKey, title: `Source: ${candidate.title}`, description: candidate.publicText, visibility: "public",
          }],
          clues: [{
            key: candidate.clueKey, title: candidate.title, description: candidate.publicText, visibility: "public",
            locationKey: candidate.locationKey, revealsStoryNodeKey: candidate.sourceNodeKey,
          }],
          lore: [{
            key: candidate.gmSecretKey, title: `GM-only truth: ${candidate.title}`, summary: candidate.gmSecret,
            details: [], visibility: "gm", locationKeys: [], factionKeys: [], storyNodeKeys: [],
          }],
        });
        const selectedArtifactKeys = [candidate.sourceNodeKey, candidate.clueKey, candidate.gmSecretKey];
        const requestDigest = sha256(canonical({ kind: "freeform-materialize-lore", campaignId, sessionId, actorId, candidate }));

        const baseRevision = ports.getContentRevision(authority, campaignId);
        if (baseRevision === null) throw new FreeformLoreUnavailableError("generation context is unavailable");
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

        const clue = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='clue'`).get(campaignId, candidate.clueKey) as { server_resource_id: string | null } | undefined;
        const node = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='story-node'`).get(campaignId, candidate.sourceNodeKey) as { server_resource_id: string | null } | undefined;
        if (!clue?.server_resource_id || !node?.server_resource_id) throw new FreeformLoreConflictError("materialized clue is unavailable");
        const secret = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
          .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
        const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
          .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
        return {
          status: "materialized" as const,
          candidate: { candidateId, clueKey: candidate.clueKey, sourceNodeKey: candidate.sourceNodeKey,
            gmSecretKey: candidate.gmSecretKey, title: candidate.title, visibility: "public" as const },
          clueId: clue.server_resource_id,
          sourceStoryNodeId: node.server_resource_id,
          draftId: applied.draftId,
          contentReceiptId: receipt?.receipt_id ?? null,
          gmSecretArtifactKey: secret?.artifact_key ?? null,
        };
      }).immediate();
    },
  };
}

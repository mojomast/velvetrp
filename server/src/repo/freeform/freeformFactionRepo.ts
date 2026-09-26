/**
 * Phase 4 free-form factions: bounded, receipted creation of an ad-hoc faction.
 *
 * When a player declaration references or looks for a faction/order/guild the
 * prepared campaign never defined ("I look for the local thieves' guild"), the
 * server — never the model — decides whether that needs new durable content and
 * what the closed candidate set is. This module:
 *
 * 1. Classifies one free-form declaration deterministically (`classifyFreeformFaction`)
 *    against public canon (every known campaign faction name). It returns either
 *    no intent or a bounded candidate list (currently exactly one candidate) whose
 *    identity is a deterministic digest of durable ids.
 * 2. Materializes the exact chosen candidate atomically (`materializeFreeformFaction`):
 *    a public `faction` artifact through the existing campaign-content generation
 *    apply path. The true agenda lives in a **separate** GM-only `lore` artifact in
 *    the same draft, so it never appears in the public faction artifact.
 *
 * Hard invariants:
 * - The candidate set is server-authored and closed; callers may only select a
 *   candidate that the classifier produced. The player's bounded phrase names the
 *   faction; the archetype, public description/agenda and the true agenda come from
 *   a small, deterministic server-authored oracle table. No model-authored lore is
 *   accepted and no mechanics, prices or stock are invented.
 * - Every write goes through the existing command/receipt machinery
 *   (`createGenerationDraft` + `recordCampaignGenerationCandidate` +
 *   `applyCampaignContentGenerationDraftAtomically` -> `campaign_content_*_v42`
 *   and the world narrative command/receipt/event). This module never writes a
 *   domain table directly.
 * - The public faction is `visibility:'public'` and carries no GM-only fields. The
 *   true agenda is a distinct `visibility:'gm'` artifact; a public artifact that
 *   transitively depends on a GM artifact is rejected by the apply path, and the
 *   public faction references nothing.
 * - Idempotency keys are derived from durable identities
 *   (`campaignId:sessionId:actorId:<normalized faction>`), so a replayed attempt
 *   converges on the same draft, command and receipt instead of creating a second
 *   faction.
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

/** Maximum length of the player-supplied faction/order/guild phrase. */
export const MAX_FREEFORM_FACTION_NAME_LENGTH = 200;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * A declaration references/looks for a faction after one of these verbs (some with
 * a fixed preposition). The declared faction is the bounded capture.
 */
const FACTION_REFERENCE_PATTERN = /\b(?:find|finds|finding|look\s+for|looks\s+for|looking\s+for|seek|seeks|seeking|search\s+for|searches\s+for|searching\s+for|join|joins|joining|contact|contacts|contacting|locate|locates|locating|visit|visits|visiting|approach|approaches|approaching|ask\s+about|asks\s+about|asking\s+about|inquire\s+about|inquires\s+about|hear\s+of|hears\s+of|heard\s+of|hear\s+about|hears\s+about|heard\s+about|know\s+of|knows\s+of|talk\s+to|talks\s+to|talking\s+to|meet\s+with|meets\s+with|is\s+there|are\s+there|where\s+is|where\s+are|does\s+there\s+exist)\b\s+(.+)$/i;
const LEADING_ARTICLE = /^(?:the|a|an|my|our|your)\s+/i;
/** Everything from a clause connective on is a request, not part of the faction phrase. */
const CLAUSE_SPLIT = /\s+(?:about|regarding|concerning|for|that|whether|if|on|to)\b/i;
/** Trailing adverbials that are not part of the faction's name. */
const TRAILING_QUALIFIER = /\s+(?:here|there|nearby|around|locally|in\s+town|in\s+the\s+city|in\s+this\s+(?:city|town|place|region)|of\s+this\s+(?:city|town|place|region))\s*$/i;

/**
 * The closed, server-authored faction archetype set. Each template is a fixed
 * public description/agenda plus a GM-only true agenda. No stats, prices, stock or
 * catalog references appear here. The final entry is the keyword-less fallback.
 */
export interface FreeformFactionTemplate {
  readonly id: string;
  /** Public archetype label. */
  readonly label: string;
  /** Lowercase tokens that select this template from the declared faction phrase. */
  readonly keywords: readonly string[];
  /** Deterministic public description/agenda; `{location}` is replaced with a public place name. */
  readonly description: string;
  /** Server-authored GM-only true agenda. Never written into the public faction artifact. */
  readonly gmAgenda: string;
}

export const FREEFORM_FACTION_ARCHETYPES: readonly FreeformFactionTemplate[] = Object.freeze([
  Object.freeze({
    id: "guild", label: "Guild",
    keywords: ["guild", "guilds", "league", "consortium", "union", "cooperative", "collective", "association", "charter"],
    description: "A public trade guild of {location}, pooling the craft and interests of its members under a charter.",
    gmAgenda: "Advance the guild's commercial advantage above the party's convenience; trade access only for reciprocal favors and note rivals' interest in the party.",
  }),
  Object.freeze({
    id: "order", label: "Order",
    keywords: ["order", "orders", "brotherhood", "sisterhood", "society", "lodge", "chapter", "fellowship", "fraternity", "sorority", "covenant", "conclave"],
    description: "A public order of {location}, bound by an old code and known for its members' quiet discipline.",
    gmAgenda: "Test whether the party honors the order's code; withhold the order's inner purpose and recruit only the proven faithful.",
  }),
  Object.freeze({
    id: "cult", label: "Cult",
    keywords: ["cult", "cults", "sect", "cabal", "coven", "mystery"],
    description: "A public society of {location}, outwardly charitable and inwardly guarded about its rites.",
    gmAgenda: "Conceal the cult's true patron; draw the curious closer with small kindnesses and note who can be used.",
  }),
  Object.freeze({
    id: "clan", label: "Clan",
    keywords: ["clan", "clans", "house", "tribe", "kin", "family", "sept", "bloodline", "dynasty"],
    description: "A public kin-clan of {location}, weighing every stranger against old feuds and older debts.",
    gmAgenda: "Protect the clan's name; measure the party's usefulness against its enemies and never reveal the family's hidden obligation.",
  }),
  Object.freeze({
    id: "syndicate", label: "Syndicate",
    keywords: ["syndicate", "cartel", "ring", "network", "smugglers", "mafia", "mob", "gang", "crew"],
    description: "A public syndicate of {location}, trading openly where it can and quietly where it cannot.",
    gmAgenda: "Keep the syndicate's real ledger hidden; buy the party's silence or loyalty only with something they cannot refuse.",
  }),
  Object.freeze({
    id: "militia", label: "Militia",
    keywords: ["militia", "watch", "legion", "brigade", "regiment", "battalion", "guard", "patrol", "garrison", "wardens"],
    description: "A public militia of {location}, keeping order with drill, banners and a wary eye on outsiders.",
    gmAgenda: "Enforce the local peace on the militia's terms; record the party's weapons and loyalties and report to the captain.",
  }),
  Object.freeze({
    id: "academy", label: "Academy",
    keywords: ["academy", "college", "university", "school", "temple", "church", "cathedral", "monastery", "abbey", "sanctuary"],
    description: "A public academy of {location}, collecting knowledge it deems worth keeping.",
    gmAgenda: "Guard the academy's restricted shelves; trade learning only for a discovery and observe which secrets the party seeks.",
  }),
  Object.freeze({
    id: "faction", label: "Faction",
    keywords: ["faction", "factions", "alliance", "coalition", "confederacy", "enclave", "movement", "front", "bloc", "assembly", "council"],
    description: "A public faction of {location}, pursuing a cause its members discuss only in general terms.",
    gmAgenda: "Advance the faction's cause quietly; reveal no inner plan and judge whether the party can be enlisted.",
  }),
  Object.freeze({
    id: "unlisted", label: "Unlisted",
    keywords: [],
    description: "A public association of {location}, keeping its business to itself.",
    gmAgenda: "Observe the party from a distance; share nothing and commit to nothing until the association's interest is clear.",
  }),
]);

const FACTION_KEYWORDS: ReadonlySet<string> = new Set(
  FREEFORM_FACTION_ARCHETYPES.flatMap((template) => template.keywords),
);

/** Fail-closed reasons a declaration does not produce a materialization candidate. */
export type FreeformFactionNoneReason =
  | "no-faction-intent"
  | "empty-name"
  | "name-too-long"
  | "not-a-faction"
  | "known-faction";

/** Reasons the bounded phrase parser can fail closed on. */
export type FreeformFactionParseReason = Extract<FreeformFactionNoneReason, "no-faction-intent" | "empty-name" | "name-too-long" | "not-a-faction">;

/** One server-authored materialization candidate. */
export interface FreeformFactionCandidate {
  /** Stable candidate identity derived from durable ids and the normalized faction phrase. */
  candidateId: string;
  /** Draft-local artifact key for the public faction. */
  factionKey: string;
  /** Draft-local artifact key for the separate GM-only true agenda artifact. */
  gmAgendaKey: string;
  /** Bounded player phrase used as the faction's public name. */
  name: string;
  /** Server-authored archetype label. */
  archetype: string;
  /** Deterministic public description/agenda; never model-authored lore. */
  description: string;
  /** Server-authored GM-only true agenda; always materialized as a separate GM artifact. */
  gmAgenda: string;
  visibility: "public";
}

export type FreeformFactionClassification =
  | { intent: "none"; reason: FreeformFactionNoneReason; factionName?: string }
  | { intent: "materialize-faction"; factionName: string; candidates: readonly FreeformFactionCandidate[] };

/** A materialized candidate projection returned with the receipts. */
export interface FreeformFactionMaterializedCandidate {
  candidateId: string;
  factionKey: string;
  gmAgendaKey: string;
  name: string;
  visibility: "public";
}

export type FreeformFactionMaterialization =
  | { status: "declined"; reason: FreeformFactionNoneReason }
  | {
    status: "materialized";
    candidate: FreeformFactionMaterializedCandidate;
    factionId: string;
    draftId: string;
    /** Durable `campaign_content_receipts_v42` receipt for the faction materialization. */
    contentReceiptId: string | null;
    /** Accepted artifact key of the separate GM-only true agenda artifact, when written. */
    gmAgendaArtifactKey: string | null;
  };

export class FreeformFactionAuthorizationError extends Error {}
export class FreeformFactionConflictError extends Error {}
export class FreeformFactionUnavailableError extends Error {}

/** Parses the bounded faction/order/guild phrase out of a free-form declaration. */
export function parseFreeformFactionReference(text: string):
  | { ok: true; name: string; normalized: string }
  | { ok: false; reason: FreeformFactionParseReason } {
  const match = FACTION_REFERENCE_PATTERN.exec(text.trim());
  if (!match) return { ok: false, reason: "no-faction-intent" };
  const firstSentence = (match[1] ?? "").split(/[.!?;]/, 1)[0] ?? "";
  let clause = firstSentence.split(CLAUSE_SPLIT, 1)[0] ?? "";
  clause = clause.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
  clause = clause.replace(LEADING_ARTICLE, "");
  for (let index = 0; index < 3 && TRAILING_QUALIFIER.test(clause); index += 1) {
    clause = clause.replace(TRAILING_QUALIFIER, "").trim();
  }
  const name = clause.replace(/[.,;:!?]+$/g, "").trim();
  if (!name) return { ok: false, reason: "empty-name" };
  if (name.length > MAX_FREEFORM_FACTION_NAME_LENGTH) return { ok: false, reason: "name-too-long" };
  if (!hasFactionKeyword(name)) return { ok: false, reason: "not-a-faction" };
  return { ok: true, name, normalized: normalizeFactionName(name) };
}

function normalizeFactionName(value: string): string {
  return value.toLowerCase().replace(LEADING_ARTICLE, "").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** True when the phrase names a faction/order/guild from the closed server vocabulary. */
export function hasFactionKeyword(name: string): boolean {
  const tokens = new Set(normalizeFactionName(name).split(/[^a-z0-9]+/).filter(Boolean));
  for (const token of tokens) if (FACTION_KEYWORDS.has(token)) return true;
  return false;
}

/** Selects the first server-authored template whose keyword matches a name token; falls back to `unlisted`. */
export function selectFreeformFactionArchetype(name: string): FreeformFactionTemplate {
  const tokens = new Set(normalizeFactionName(name).split(/[^a-z0-9]+/).filter(Boolean));
  for (const template of FREEFORM_FACTION_ARCHETYPES) {
    if (template.keywords.some((keyword) => tokens.has(keyword))) return template;
  }
  return FREEFORM_FACTION_ARCHETYPES[FREEFORM_FACTION_ARCHETYPES.length - 1]!;
}

/**
 * Deterministic, server-owned classification. It never invents content: a
 * materialization candidate is only produced when the request names a
 * faction/order/guild that is not already known to the campaign.
 */
export function classifyFreeformFaction(input: {
  identity: string;
  text: string;
  knownFactions: ReadonlyArray<string>;
  locationName?: string | null;
}): FreeformFactionClassification {
  const parsed = parseFreeformFactionReference(input.text);
  if (!parsed.ok) return { intent: "none", reason: parsed.reason };
  const { name, normalized } = parsed;

  const duplicate = input.knownFactions.find((known) => normalizeFactionName(known) === normalized);
  if (duplicate !== undefined) return { intent: "none", reason: "known-faction", factionName: duplicate };

  const template = selectFreeformFactionArchetype(name);
  const digest = sha256(`${input.identity}:${normalized}`);
  const location = input.locationName?.trim() ? input.locationName.trim() : "the wider region";
  const candidate: FreeformFactionCandidate = {
    candidateId: `fff-${digest.slice(0, 40)}`,
    factionKey: generatedArtifactKeySchema.parse(`ff-faction-${digest.slice(0, 40)}`),
    gmAgendaKey: generatedArtifactKeySchema.parse(`ff-faction-agenda-${digest.slice(0, 40)}`),
    name,
    archetype: template.label,
    description: template.description.replaceAll("{location}", location),
    gmAgenda: template.gmAgenda,
    visibility: "public",
  };
  return { intent: "materialize-faction", factionName: name, candidates: [candidate] };
}

/** Narrow ports so the module reuses existing repos without importing their full surface. */
export interface FreeformFactionPorts {
  getDraftByIdempotencyKey(principalId: string, campaignId: string, idempotencyKey: string): unknown;
  createDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  getContentRevision(principalId: string, campaignId: string): number | null;
  recordCandidate(draftId: string, content: GeneratedCampaignContentProvider): void;
  applyDraft(principalId: string, input: DraftMutationInput & { selectedArtifactKeys: string[] }): PrivateGenerationDraft;
}

export interface FreeformFactionRepository {
  /** Classifies one declaration; throws only for unauthorized principals. */
  classifyFreeformFactionIntent(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformFactionClassification;
  /** Applies the exact server-authored candidate atomically. */
  materializeFreeformFaction(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string,
    options?: { candidateId?: string }): FreeformFactionMaterialization;
}

type PlacementRow = { location_id: string; public_name: string };

export function createFreeformFactionRepository(
  db: DatabaseDriver.Database,
  deps: { clock: Clock },
  ports: FreeformFactionPorts,
  guard: () => void,
): FreeformFactionRepository {
  const now = (): string => deps.clock.now().toISOString();

  function authorize(principalId: string, campaignId: string, actorId: string): void {
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new FreeformFactionAuthorizationError("campaign membership is required");
    if (member.role === "owner" || member.role === "gm") return;
    if (!db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(campaignId, actorId, principalId)) throw new FreeformFactionAuthorizationError("principal cannot act for the actor");
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

  /**
   * Reads the actor's current place name, but only when it is backed by a public
   * accepted location artifact. A GM-only place never leaks into a public faction.
   */
  function readPublicLocationName(campaignId: string, sessionId: string, actorId: string): string | null {
    const row = db.prepare(`SELECT placement.location_id,location.public_name
      FROM campaign_actor_locations_v28 placement
      JOIN campaign_locations_v28 location ON location.campaign_id=placement.campaign_id AND location.location_id=placement.location_id
      WHERE placement.campaign_id=? AND placement.actor_id=? AND placement.session_id=?`)
      .get(campaignId, actorId, sessionId) as PlacementRow | undefined;
    if (!row) return null;
    const artifact = db.prepare(`SELECT 1 FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND server_resource_id=? AND artifact_kind='location' AND visibility='public' LIMIT 1`)
      .get(campaignId, row.location_id);
    return artifact ? row.public_name : null;
  }

  function readKnownFactionNames(campaignId: string): string[] {
    return (db.prepare("SELECT public_name FROM campaign_factions_v28 WHERE campaign_id=? ORDER BY faction_id")
      .all(campaignId) as Array<{ public_name: string }>).map((row) => row.public_name);
  }

  function classifyWithContext(identity: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformFactionClassification {
    return classifyFreeformFaction({
      identity, text,
      knownFactions: readKnownFactionNames(campaignId),
      locationName: readPublicLocationName(campaignId, sessionId, actorId),
    });
  }

  /**
   * Replays a previously committed materialization. All writes already happened
   * in one transaction, so a stored draft is proof the faction and its GM agenda
   * artifact exist. The receipt is read back from the durable content command
   * rather than re-issued.
   */
  function replayMaterialization(authority: string, campaignId: string, identity: string, normalized: string): FreeformFactionMaterialization {
    const draftKey = idempotencyKeySchema.parse(`ff-faction-draft-${sha256(`${identity}:${normalized}`).slice(0, 48)}`);
    const existing = ports.getDraftByIdempotencyKey(authority, campaignId, draftKey);
    if (!existing) throw new FreeformFactionConflictError("materialization replay is unavailable");
    const draft = privateGenerationDraftSchema.parse(existing);
    const faction = db.prepare(`SELECT artifact_key,server_resource_id,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='faction' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string; server_resource_id: string | null; canonical_json: string } | undefined;
    if (!faction?.server_resource_id) throw new FreeformFactionConflictError("materialized faction is unavailable");
    const agenda = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
    const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
      .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
    const value = JSON.parse(faction.canonical_json) as { name?: string };
    return {
      status: "materialized",
      candidate: { candidateId: `fff-${sha256(`${identity}:${normalized}`).slice(0, 40)}`, factionKey: faction.artifact_key,
        gmAgendaKey: agenda?.artifact_key ?? "", name: typeof value.name === "string" ? value.name : normalized, visibility: "public" },
      factionId: faction.server_resource_id,
      draftId: draft.draftId,
      contentReceiptId: receipt?.receipt_id ?? null,
      gmAgendaArtifactKey: agenda?.artifact_key ?? null,
    };
  }

  return {
    classifyFreeformFactionIntent(principalId, campaignId, sessionId, actorId, text) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);
      return classifyWithContext(`${campaignId}:${sessionId}:${actorId}`, campaignId, sessionId, actorId, text);
    },

    materializeFreeformFaction(principalId, campaignId, sessionId, actorId, text, options) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);

      const parsed = parseFreeformFactionReference(text);
      if (!parsed.ok) return { status: "declined" as const, reason: parsed.reason };
      const identity = `${campaignId}:${sessionId}:${actorId}`;
      const digest = sha256(`${identity}:${parsed.normalized}`);
      const candidateId = `fff-${digest.slice(0, 40)}`;
      const draftKey = idempotencyKeySchema.parse(`ff-faction-draft-${digest.slice(0, 48)}`);
      const applyKey = idempotencyKeySchema.parse(`ff-faction-apply-${digest.slice(0, 48)}`);
      if (options?.candidateId !== undefined && options.candidateId !== candidateId) {
        throw new FreeformFactionConflictError("the chosen candidate is not in the server-authored set");
      }
      const authority = gmAuthorityPrincipal(principalId, campaignId);
      if (!authority) throw new FreeformFactionUnavailableError("campaign has no GM authority to materialize a faction");

      return db.transaction(() => {
        if (ports.getDraftByIdempotencyKey(authority, campaignId, draftKey)) {
          return replayMaterialization(authority, campaignId, identity, parsed.normalized);
        }

        // Freshness re-check: only materialize a faction the classifier still authorizes.
        const classification = classifyWithContext(identity, campaignId, sessionId, actorId, text);
        if (classification.intent === "none") return { status: "declined" as const, reason: classification.reason };
        const candidate = classification.candidates.find((value) => value.candidateId === candidateId);
        if (!candidate) throw new FreeformFactionConflictError("the chosen candidate is no longer available");

        const campaign = db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?")
          .get(campaignId) as { active_timeline_id: string; administration_revision: number } | undefined;
        if (!campaign) throw new FreeformFactionUnavailableError("campaign is unavailable");

        // Public faction/agenda only. The true agenda is a separate `visibility:'gm'`
        // artifact and is never attached to the public faction artifact.
        const content = generatedCampaignContentProviderSchema.parse({
          factions: [{
            key: candidate.factionKey, name: candidate.name,
            description: candidate.description, visibility: "public",
          }],
          lore: [{
            key: candidate.gmAgendaKey, title: `GM-only agenda: ${candidate.name}`, summary: candidate.gmAgenda,
            details: [], visibility: "gm", locationKeys: [], factionKeys: [candidate.factionKey],
          }],
        });
        const selectedArtifactKeys = [candidate.factionKey, candidate.gmAgendaKey];
        const requestDigest = sha256(canonical({ kind: "freeform-materialize-faction", campaignId, sessionId, actorId, candidate }));

        const baseRevision = ports.getContentRevision(authority, campaignId);
        if (baseRevision === null) throw new FreeformFactionUnavailableError("generation context is unavailable");
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

        const faction = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='faction'`).get(campaignId, candidate.factionKey) as { server_resource_id: string | null } | undefined;
        if (!faction?.server_resource_id) throw new FreeformFactionConflictError("materialized faction is unavailable");
        const agenda = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
          .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
        const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
          .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
        return {
          status: "materialized" as const,
          candidate: { candidateId, factionKey: candidate.factionKey, gmAgendaKey: candidate.gmAgendaKey,
            name: candidate.name, visibility: "public" as const },
          factionId: faction.server_resource_id,
          draftId: applied.draftId,
          contentReceiptId: receipt?.receipt_id ?? null,
          gmAgendaArtifactKey: agenda?.artifact_key ?? null,
        };
      }).immediate();
    },
  };
}

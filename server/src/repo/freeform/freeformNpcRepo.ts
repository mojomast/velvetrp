/**
 * Phase 2a free-form NPCs: bounded, receipted creation of an ad-hoc NPC.
 *
 * When a player addresses a person the prepared campaign never defined ("I ask
 * the glassblower about the road"), the server — never the model — decides
 * whether that needs new durable content and what the closed candidate set is.
 * This module:
 *
 * 1. Classifies one free-form declaration deterministically (`classifyFreeformNpc`)
 *    against public canon (the actor's current location and every known campaign
 *    NPC name). It returns either no intent or a bounded candidate list (currently
 *    exactly one candidate) whose identity is a deterministic digest of durable ids.
 * 2. Materializes the exact chosen candidate atomically (`materializeFreeformNpc`):
 *    a public `npc` persona artifact through the existing campaign-content generation
 *    apply path. Any GM-only goals live in a **separate** GM-only `lore` artifact in
 *    the same draft, so they never appear in the public persona artifact.
 *
 * Hard invariants:
 * - The candidate set is server-authored and closed; callers may only select a
 *   candidate that the classifier produced. The player's bounded phrase names the
 *   person; the archetype, description and any GM-only goals come from a small,
 *   deterministic server-authored archetype table. Public canon (the actor's current
 *   public location and its public factions) supplies the placement context. No
 *   free-form world lore and no model-authored persona is accepted.
 * - Every write goes through the existing command/receipt machinery
 *   (`createGenerationDraft` + `recordCampaignGenerationCandidate` +
 *   `applyCampaignContentGenerationDraftAtomically` -> `campaign_content_*_v42`)
 *   inside one immediate transaction. This module never writes a domain table directly.
 * - The public persona is `visibility:'public'` and carries no GM-only fields. GM-only
 *   goals are a distinct `visibility:'gm'` artifact; a public artifact that transitively
 *   depends on a GM artifact is rejected by the apply path.
 * - **No fabricated stats.** This module only creates the persona. It does not invent
 *   ability scores, HP, class levels, or any combat stat, and it never writes
 *   `rpg_character_classes`, `character_progression_v23`, or
 *   `character_progression_pending_snapshots_v24`. The existing apply path records only
 *   the fixed `10,10,10,'generated-deterministic-baseline'` row in
 *   `campaign_npc_baseline_stats_v41`. Combat is resolved later, on demand, by
 *   `resolveNpcCombatProfile` / `initiateCombat` (`server/src/repo/encounter/npcCombatProfile.ts`),
 *   which pins an exact SRD template and never invents stats.
 * - Idempotency keys are derived from durable identities
 *   (`campaignId:sessionId:actorId:<normalized person>`), so a replayed attempt
 *   converges on the same draft, command and receipt instead of creating a second NPC.
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

/** Maximum length of the player-supplied person/role phrase. */
export const MAX_FREEFORM_NPC_NAME_LENGTH = 200;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * A declaration addresses a new person after one of these contact verbs, with an
 * optional preposition. The declared person/role is the bounded capture.
 */
const NPC_CONTACT_PATTERN = /\b(?:ask|asks|asking|tell|tells|telling|talk|talks|talking|speak|speaks|speaking|greet|greets|greeting|address|addresses|addressing|call|calls|calling|question|questions|questioning|approach|approaches|approaching|meet|meets|meeting|hail|hails|hailing|confront|confronts|confronting|find|finds|finding|visit|visits|visiting)\s+(?:(?:to|with|at)\s+)?(.+)$/i;
const LEADING_ARTICLE = /^(?:the|a|an|my|our|your)\s+/i;
/** Clause openers that mean the declaration has no person object ("I ask about the road"). */
const CLAUSE_PREFIX = /^(?:about|for|after|into|whether|if|that|why|how|when|where)\b/i;
/** Everything from a clause connective on is a request, not part of the person phrase. */
const CLAUSE_SPLIT = /\s+(?:about|regarding|concerning|for|that|whether|if|on|to)\b/i;

/**
 * The closed, server-authored archetype set. Each template is a fixed persona
 * shape: a keyword table that selects it, a deterministic description, and
 * GM-only goals. No stats, prices, stock or catalog references appear here.
 */
export interface FreeformNpcArchetypeTemplate {
  readonly id: string;
  /** Public archetype label; it also seeds the later combat-profile tier derivation. */
  readonly label: string;
  /** Lowercase tokens that select this template from the declared person/role. */
  readonly keywords: readonly string[];
  /** Deterministic public description; `{location}` is replaced with the public location name. */
  readonly description: string;
  /** Server-authored GM-only goals. Never written into the public persona artifact. */
  readonly gmGoals: string;
}

export const FREEFORM_NPC_ARCHETYPES: readonly FreeformNpcArchetypeTemplate[] = Object.freeze([
  Object.freeze({
    id: "artisan", label: "Artisan",
    keywords: ["glassblower", "smith", "blacksmith", "goldsmith", "silversmith", "artisan", "craftsman", "craftsperson", "weaver", "potter", "carpenter", "tinker", "baker", "mason", "cooper", "fletcher", "joiner"],
    description: "A public artisan of {location}, known locally for careful hands and a guarded workbench.",
    gmGoals: "Assess whether the party respects the workshop; trade honest craft knowledge only once trust is earned.",
  }),
  Object.freeze({
    id: "merchant", label: "Merchant",
    keywords: ["merchant", "shopkeeper", "trader", "vendor", "peddler", "hawker", "factor", "salesman"],
    description: "A public merchant of {location}, minding a stall and the price of every word.",
    gmGoals: "Protect the stall's margin; offer fair but not generous terms and remember who haggled.",
  }),
  Object.freeze({
    id: "host", label: "Innkeeper",
    keywords: ["innkeeper", "barkeep", "bartender", "tavernkeeper", "host", "publican", "landlord"],
    description: "A public host of {location}, keeping the common room calm and the cups filled.",
    gmGoals: "Notice who pays, who listens, and who asks about the road; report nothing without cause.",
  }),
  Object.freeze({
    id: "guard", label: "Guard",
    keywords: ["guard", "watchman", "sentry", "watch", "soldier", "constable", "patrol", "deputy", "marshal"],
    description: "A public guard of {location}, carrying the local watch's authority and its suspicions.",
    gmGoals: "Enforce the watch's rules; record strangers' names and report anything unusual up the chain.",
  }),
  Object.freeze({
    id: "healer", label: "Healer",
    keywords: ["healer", "apothecary", "physician", "herbalist", "midwife", "medic", "doctor"],
    description: "A public healer of {location}, tending the visibly hurt before the merely worried.",
    gmGoals: "Withhold rare remedies unless the party earns trust; remember who was desperate and why.",
  }),
  Object.freeze({
    id: "scholar", label: "Scholar",
    keywords: ["scholar", "scribe", "sage", "librarian", "teacher", "priest", "cleric", "acolyte", "monk"],
    description: "A public scholar of {location}, weighing what is worth writing down.",
    gmGoals: "Guard local knowledge; share only what the party can be trusted to use well.",
  }),
  Object.freeze({
    id: "laborer", label: "Laborer",
    keywords: ["laborer", "labourer", "porter", "dockhand", "ferryman", "stablehand", "servant", "cook", "fisher", "farmer", "groom", "miner"],
    description: "A public laborer of {location}, getting through the day's work with a wary eye on strangers.",
    gmGoals: "Trade gossip about the immediate district only for a small kindness or an honest answer.",
  }),
  Object.freeze({
    id: "bystander", label: "Bystander",
    keywords: [],
    description: "A public bystander of {location}, caught between curiosity and the wish to stay out of trouble.",
    gmGoals: "Avoid trouble; answer only what is asked and remember who was polite.",
  }),
]);

/** Fail-closed reasons a declaration does not produce a materialization candidate. */
export type FreeformNpcNoneReason =
  | "no-npc-intent"
  | "empty-name"
  | "name-too-long"
  | "known-npc"
  | "no-current-location"
  | "current-location-unmapped";

/** One server-authored materialization candidate. */
export interface FreeformNpcCandidate {
  /** Stable candidate identity derived from durable ids and the normalized person phrase. */
  candidateId: string;
  /** Draft-local artifact key for the public persona. */
  npcKey: string;
  /** Draft-local artifact key for the separate GM-only goals artifact. */
  gmGoalsKey: string;
  /** Accepted artifact key of the actor's current public location (placement context). */
  locationKey: string;
  /** Accepted public faction artifact keys of the current location, if any. */
  factionKeys: readonly string[];
  /** Bounded player phrase used as the NPC's public name. */
  name: string;
  /** Server-authored archetype label. */
  archetype: string;
  /** Deterministic template description; never model-authored lore. */
  description: string;
  /** Server-authored GM-only goals; always materialized as a separate GM artifact. */
  gmGoals: string;
  visibility: "public";
}

/** Public location context used by the pure classifier. */
export interface FreeformNpcLocationContext {
  locationId: string;
  name: string;
  visibility: "public" | "discovered" | "gm";
  /** Accepted public location artifact key, when one exists. */
  artifactKey: string | null;
  /** Accepted public faction artifact keys referenced by the location. */
  factionKeys?: readonly string[];
}

export type FreeformNpcClassification =
  | { intent: "none"; reason: FreeformNpcNoneReason; npcName?: string }
  | { intent: "materialize-npc"; npcName: string; candidates: readonly FreeformNpcCandidate[] };

/** A materialized candidate projection returned with the receipts. */
export interface FreeformNpcMaterializedCandidate {
  candidateId: string;
  npcKey: string;
  gmGoalsKey: string;
  name: string;
  visibility: "public";
}

export type FreeformNpcMaterialization =
  | { status: "declined"; reason: FreeformNpcNoneReason }
  | {
    status: "materialized";
    candidate: FreeformNpcMaterializedCandidate;
    npcId: string;
    draftId: string;
    /** Durable `campaign_content_receipts_v42` receipt for the persona materialization. */
    contentReceiptId: string | null;
    /** Accepted artifact key of the separate GM-only goals artifact, when written. */
    gmGoalsArtifactKey: string | null;
  };

export class FreeformNpcAuthorizationError extends Error {}
export class FreeformNpcConflictError extends Error {}
export class FreeformNpcUnavailableError extends Error {}

/** Parses the bounded person/role phrase out of a free-form declaration. */
export function parseFreeformNpcAddress(text: string):
  | { ok: true; name: string; normalized: string }
  | { ok: false; reason: Extract<FreeformNpcNoneReason, "no-npc-intent" | "empty-name" | "name-too-long"> } {
  const match = NPC_CONTACT_PATTERN.exec(text.trim());
  if (!match) return { ok: false, reason: "no-npc-intent" };
  const firstSentence = (match[1] ?? "").split(/[.!?;]/, 1)[0] ?? "";
  const clause = firstSentence.split(CLAUSE_SPLIT, 1)[0] ?? "";
  const cleaned = clause.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
  if (CLAUSE_PREFIX.test(cleaned)) return { ok: false, reason: "no-npc-intent" };
  const name = cleaned.replace(LEADING_ARTICLE, "").replace(/[.,;:!?]+$/g, "").trim();
  if (!name) return { ok: false, reason: "empty-name" };
  if (name.length > MAX_FREEFORM_NPC_NAME_LENGTH) return { ok: false, reason: "name-too-long" };
  return { ok: true, name, normalized: normalizeNpcName(name) };
}

function normalizeNpcName(value: string): string {
  return value.toLowerCase().replace(LEADING_ARTICLE, "").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Selects the first server-authored archetype whose keyword matches a name token. */
export function selectFreeformNpcArchetype(name: string): FreeformNpcArchetypeTemplate {
  const tokens = new Set(normalizeNpcName(name).split(/[^a-z0-9]+/).filter(Boolean));
  for (const template of FREEFORM_NPC_ARCHETYPES) {
    if (template.keywords.some((keyword) => tokens.has(keyword))) return template;
  }
  return FREEFORM_NPC_ARCHETYPES[FREEFORM_NPC_ARCHETYPES.length - 1]!;
}

/**
 * Deterministic, server-owned classification. It never invents content: a
 * materialization candidate is only produced when the request names a person
 * that is not already known and the actor's current location is a generated
 * public location that the generation apply can place the NPC in.
 */
export function classifyFreeformNpc(input: {
  identity: string;
  text: string;
  currentLocation: FreeformNpcLocationContext | null;
  knownNpcs: ReadonlyArray<string>;
}): FreeformNpcClassification {
  const parsed = parseFreeformNpcAddress(input.text);
  if (!parsed.ok) return { intent: "none", reason: parsed.reason };
  const { name, normalized } = parsed;

  const duplicate = input.knownNpcs.find((known) => normalizeNpcName(known) === normalized);
  if (duplicate !== undefined) return { intent: "none", reason: "known-npc", npcName: duplicate };
  if (!input.currentLocation) return { intent: "none", reason: "no-current-location" };
  const artifact = input.currentLocation.artifactKey
    ? generatedArtifactKeySchema.safeParse(input.currentLocation.artifactKey)
    : null;
  if (!artifact?.success) return { intent: "none", reason: "current-location-unmapped" };

  const template = selectFreeformNpcArchetype(name);
  const digest = sha256(`${input.identity}:${normalized}`);
  const candidate: FreeformNpcCandidate = {
    candidateId: `ffn-${digest.slice(0, 40)}`,
    npcKey: generatedArtifactKeySchema.parse(`ff-npc-${digest.slice(0, 40)}`),
    gmGoalsKey: generatedArtifactKeySchema.parse(`ff-npc-goals-${digest.slice(0, 40)}`),
    locationKey: artifact.data,
    factionKeys: [...(input.currentLocation.factionKeys ?? [])],
    name,
    archetype: template.label,
    description: template.description.replaceAll("{location}", input.currentLocation.name),
    gmGoals: template.gmGoals,
    visibility: "public",
  };
  return { intent: "materialize-npc", npcName: name, candidates: [candidate] };
}

/** Narrow ports so the module reuses existing repos without importing their full surface. */
export interface FreeformNpcPorts {
  getDraftByIdempotencyKey(principalId: string, campaignId: string, idempotencyKey: string): unknown;
  createDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  getContentRevision(principalId: string, campaignId: string): number | null;
  recordCandidate(draftId: string, content: GeneratedCampaignContentProvider): void;
  applyDraft(principalId: string, input: DraftMutationInput & { selectedArtifactKeys: string[] }): PrivateGenerationDraft;
}

export interface FreeformNpcRepository {
  /** Classifies one declaration; throws only for unauthorized principals. */
  classifyFreeformNpcIntent(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformNpcClassification;
  /** Applies the exact server-authored candidate atomically. */
  materializeFreeformNpc(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string,
    options?: { candidateId?: string }): FreeformNpcMaterialization;
}

type PlacementRow = { location_id: string; public_name: string; visibility: "public" | "discovered" | "gm" };

export function createFreeformNpcRepository(
  db: DatabaseDriver.Database,
  deps: { clock: Clock },
  ports: FreeformNpcPorts,
  guard: () => void,
): FreeformNpcRepository {
  const now = (): string => deps.clock.now().toISOString();

  function authorize(principalId: string, campaignId: string, actorId: string): void {
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new FreeformNpcAuthorizationError("campaign membership is required");
    if (member.role === "owner" || member.role === "gm") return;
    if (!db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(campaignId, actorId, principalId)) throw new FreeformNpcAuthorizationError("principal cannot act for the actor");
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

  function readCurrentLocation(campaignId: string, sessionId: string, actorId: string): FreeformNpcLocationContext | null {
    const row = db.prepare(`SELECT placement.location_id,location.public_name,location.visibility
      FROM campaign_actor_locations_v28 placement
      JOIN campaign_locations_v28 location ON location.campaign_id=placement.campaign_id AND location.location_id=placement.location_id
      WHERE placement.campaign_id=? AND placement.actor_id=? AND placement.session_id=?`)
      .get(campaignId, actorId, sessionId) as PlacementRow | undefined;
    if (!row) return null;
    const artifact = db.prepare(`SELECT artifact_key,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND server_resource_id=? AND artifact_kind='location' AND visibility='public' LIMIT 1`)
      .get(campaignId, row.location_id) as { artifact_key: string; canonical_json: string } | undefined;
    if (!artifact) return { locationId: row.location_id, name: row.public_name, visibility: row.visibility, artifactKey: null, factionKeys: [] };
    // Only accepted public factions referenced by the location may become NPC context.
    const referenced = (JSON.parse(artifact.canonical_json) as { factionKeys?: unknown }).factionKeys;
    const factionKeys = Array.isArray(referenced)
      ? referenced.filter((value): value is string => typeof value === "string").filter((key) =>
        Boolean(db.prepare(`SELECT 1 FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='faction' AND visibility='public'`).get(campaignId, key)))
      : [];
    return { locationId: row.location_id, name: row.public_name, visibility: row.visibility, artifactKey: artifact.artifact_key, factionKeys };
  }

  function readKnownNpcNames(campaignId: string): string[] {
    return (db.prepare("SELECT public_name FROM campaign_npcs_v28 WHERE campaign_id=? ORDER BY npc_id")
      .all(campaignId) as Array<{ public_name: string }>).map((row) => row.public_name);
  }

  function classifyWithContext(identity: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformNpcClassification {
    return classifyFreeformNpc({
      identity, text,
      currentLocation: readCurrentLocation(campaignId, sessionId, actorId),
      knownNpcs: readKnownNpcNames(campaignId),
    });
  }

  /**
   * Replays a previously committed materialization. All writes already happened
   * in one transaction, so a stored draft is proof the persona and its GM goals
   * artifact exist. The receipt is read back from the durable content command
   * rather than re-issued.
   */
  function replayMaterialization(authority: string, campaignId: string, identity: string, normalized: string): FreeformNpcMaterialization {
    const draftKey = idempotencyKeySchema.parse(`ff-npc-draft-${sha256(`${identity}:${normalized}`).slice(0, 48)}`);
    const existing = ports.getDraftByIdempotencyKey(authority, campaignId, draftKey);
    if (!existing) throw new FreeformNpcConflictError("materialization replay is unavailable");
    const draft = privateGenerationDraftSchema.parse(existing);
    const npc = db.prepare(`SELECT artifact_key,server_resource_id,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='npc' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string; server_resource_id: string | null; canonical_json: string } | undefined;
    if (!npc?.server_resource_id) throw new FreeformNpcConflictError("materialized persona is unavailable");
    const goals = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
    const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
      .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
    const value = JSON.parse(npc.canonical_json) as { name?: string };
    return {
      status: "materialized",
      candidate: { candidateId: `ffn-${sha256(`${identity}:${normalized}`).slice(0, 40)}`, npcKey: npc.artifact_key,
        gmGoalsKey: goals?.artifact_key ?? "", name: typeof value.name === "string" ? value.name : normalized, visibility: "public" },
      npcId: npc.server_resource_id,
      draftId: draft.draftId,
      contentReceiptId: receipt?.receipt_id ?? null,
      gmGoalsArtifactKey: goals?.artifact_key ?? null,
    };
  }

  return {
    classifyFreeformNpcIntent(principalId, campaignId, sessionId, actorId, text) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);
      return classifyWithContext(`${campaignId}:${sessionId}:${actorId}`, campaignId, sessionId, actorId, text);
    },

    materializeFreeformNpc(principalId, campaignId, sessionId, actorId, text, options) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);

      const parsed = parseFreeformNpcAddress(text);
      if (!parsed.ok) return { status: "declined" as const, reason: parsed.reason };
      const identity = `${campaignId}:${sessionId}:${actorId}`;
      const digest = sha256(`${identity}:${parsed.normalized}`);
      const candidateId = `ffn-${digest.slice(0, 40)}`;
      const draftKey = idempotencyKeySchema.parse(`ff-npc-draft-${digest.slice(0, 48)}`);
      const applyKey = idempotencyKeySchema.parse(`ff-npc-apply-${digest.slice(0, 48)}`);
      if (options?.candidateId !== undefined && options.candidateId !== candidateId) {
        throw new FreeformNpcConflictError("the chosen candidate is not in the server-authored set");
      }
      const authority = gmAuthorityPrincipal(principalId, campaignId);
      if (!authority) throw new FreeformNpcUnavailableError("campaign has no GM authority to materialize an NPC");

      return db.transaction(() => {
        if (ports.getDraftByIdempotencyKey(authority, campaignId, draftKey)) {
          return replayMaterialization(authority, campaignId, identity, parsed.normalized);
        }

        // Freshness re-check: only materialize a person the classifier still authorizes.
        const classification = classifyWithContext(identity, campaignId, sessionId, actorId, text);
        if (classification.intent === "none") return { status: "declined" as const, reason: classification.reason };
        const candidate = classification.candidates.find((value) => value.candidateId === candidateId);
        if (!candidate) throw new FreeformNpcConflictError("the chosen candidate is no longer available");

        const campaign = db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?")
          .get(campaignId) as { active_timeline_id: string; administration_revision: number } | undefined;
        if (!campaign) throw new FreeformNpcUnavailableError("campaign is unavailable");

        // Public persona only. GM-only goals are a separate `visibility:'gm'` artifact and are
        // never attached to the public npc artifact.
        const content = generatedCampaignContentProviderSchema.parse({
          npcs: [{
            key: candidate.npcKey, name: candidate.name, archetype: candidate.archetype,
            description: candidate.description, visibility: "public",
            locationKey: candidate.locationKey, factionKeys: [...candidate.factionKeys],
          }],
          lore: [{
            key: candidate.gmGoalsKey, title: `GM-only goals: ${candidate.name}`, summary: candidate.gmGoals,
            details: [], visibility: "gm", locationKeys: [candidate.locationKey], factionKeys: [],
          }],
        });
        const selectedArtifactKeys = [candidate.npcKey, candidate.gmGoalsKey];
        const requestDigest = sha256(canonical({ kind: "freeform-materialize-npc", campaignId, sessionId, actorId, candidate }));

        const baseRevision = ports.getContentRevision(authority, campaignId);
        if (baseRevision === null) throw new FreeformNpcUnavailableError("generation context is unavailable");
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

        const npc = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='npc'`).get(campaignId, candidate.npcKey) as { server_resource_id: string | null } | undefined;
        if (!npc?.server_resource_id) throw new FreeformNpcConflictError("materialized persona is unavailable");
        const goals = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
          .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
        const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
          .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
        return {
          status: "materialized" as const,
          candidate: { candidateId, npcKey: candidate.npcKey, gmGoalsKey: candidate.gmGoalsKey,
            name: candidate.name, visibility: "public" as const },
          npcId: npc.server_resource_id,
          draftId: applied.draftId,
          contentReceiptId: receipt?.receipt_id ?? null,
          gmGoalsArtifactKey: goals?.artifact_key ?? null,
        };
      }).immediate();
    },
  };
}

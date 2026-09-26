/**
 * Phase 4b free-form quests: bounded, receipted materialization of an ad-hoc
 * public quest when a player asks for work the prepared campaign never defined.
 *
 * When a player asks for work, a job or a lead ("I ask around for work", "any
 * leads?"), the server — never the model — decides whether that needs new durable
 * content and what the closed candidate set is. This module:
 *
 * 1. Classifies one declaration deterministically (`classifyFreeformQuest`)
 *    against public canon (the actor's current public location and every accepted
 *    public quest title). It returns either no intent or a bounded candidate list
 *    (currently exactly one candidate) whose identity is a deterministic digest of
 *    durable ids.
 * 2. Materializes the exact chosen candidate atomically (`materializeFreeformQuest`):
 *    a public `quest` artifact with a small bounded set of **public** objectives
 *    and one inert `custom` reward, plus a **separate** GM-only `lore` artifact
 *    carrying the server-authored twist — all through the existing campaign-content
 *    generation apply path.
 *
 * Hard invariants:
 * - The candidate set is server-authored and closed; callers may only select a
 *   candidate that the classifier produced. The player's bounded phrase selects a
 *   template; the title, description, objective text, reward label and GM-only
 *   twist come from a small, deterministic server-authored template set. Public
 *   canon (the current public location) supplies the placement context. No
 *   free-form world lore and no model-authored text is accepted.
 * - **Public objectives only.** Every objective is `visibility:'public'` and its
 *   dependency chain stays inside the quest, so a public objective can never
 *   depend on a GM-only objective. The GM-only twist is a distinct
 *   `visibility:'gm'` artifact and is never referenced by the public quest.
 * - **No fabricated mechanics.** This module invents no stats, items, enemies or
 *   prices and creates no catalog reference. The only reward is a single
 *   `kind:'custom'`, `amount:null` entry, which carries no executable mechanic.
 * - Every write goes through the existing command/receipt machinery
 *   (`createGenerationDraft` + `recordCampaignGenerationCandidate` +
 *   `applyCampaignContentGenerationDraftAtomically` -> `campaign_content_*_v42`
 *   plus the `quest_domain_*_v33` writers) inside one immediate transaction. This
 *   module never writes a domain table directly.
 * - Idempotency keys are derived from durable identities
 *   (`campaignId:sessionId:actorId:<normalized lead>`), so a replayed attempt
 *   converges on the same draft, command and receipt instead of creating a second
 *   quest.
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

/** Maximum length of the player-supplied work/lead phrase. */
export const MAX_FREEFORM_QUEST_LEAD_LENGTH = 200;
/** Maximum size of the bounded public objective set. */
export const MAX_FREEFORM_QUEST_OBJECTIVES = 3;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * A free-form quest declaration asks for work, a job or a lead after a request
 * verb ("I ask around for work", "any leads?"). The matched request remainder is
 * the bounded capture and must name a recognized work/lead noun.
 */
const QUEST_REQUEST_PATTERN = /\b(?:ask|asks|asking|look|looks|looking|search|searches|searching|seek|seeks|seeking|hunt|hunts|hunting|inquire|inquires|inquiring|need|needs|needing|want|wants|wanting|find|finds|finding|check|checks|checking|hear|hears|hearing|know|knows|knowing|got|have|any)\b(?:\s+(?:around|about|for|after|into|out|up))?\s+(.+)$/i;
const QUEST_NOUN = /\b(?:work|jobs?|employment|hiring|hire|contracts?|bount(?:y|ies)|tasks?|leads?|opportunit(?:y|ies)|errands?|commissions?|gigs?)\b/i;

/**
 * The closed, server-authored quest template set. Each template is a fixed
 * narrative shape: a keyword table that selects it, deterministic public text, a
 * bounded objective chain, one inert reward label and a GM-only twist. No stats,
 * items, prices, enemies or catalog references appear here. `{location}` is
 * replaced with the public location name only.
 */
export interface FreeformQuestTemplate {
  readonly id: string;
  /** Public category label, for diagnostics only. */
  readonly label: string;
  /** Lowercase tokens that select this template from the declared lead. */
  readonly keywords: readonly string[];
  /** Deterministic public quest title. */
  readonly title: string;
  /** Deterministic public quest description. */
  readonly description: string;
  /** Bounded ordered public objective descriptions; each depends on the previous. */
  readonly objectives: readonly string[];
  /** Inert `custom` reward label. */
  readonly rewardLabel: string;
  /** Server-authored GM-only twist. Never written into the public quest artifact. */
  readonly gmTwist: string;
}

export const FREEFORM_QUEST_TEMPLATES: readonly FreeformQuestTemplate[] = Object.freeze([
  Object.freeze({
    id: "labor", label: "Hireling work",
    keywords: ["work", "job", "jobs", "labor", "labour", "hire", "hiring", "employment", "wage", "wages", "porter", "loading", "haul", "hauler", "dockwork"],
    title: "Odd work in {location}",
    description: "A public notice board in {location} lists short paid work that no one has claimed.",
    objectives: [
      "Ask the board and the locals who posts work in {location}.",
      "Take up the task named on the notice and see it through.",
      "Report back to whoever hired you in {location}.",
    ],
    rewardLabel: "A promised day's wage",
    gmTwist: "The notice was posted to draw outsiders into {location}; a local party is watching who answers and what they learn.",
  }),
  Object.freeze({
    id: "escort", label: "Escort work",
    keywords: ["escort", "guard", "guarding", "protect", "protection", "caravan", "bodyguard", "convoy", "watch", "defend", "defense"],
    title: "Escort work out of {location}",
    description: "A guarded request in {location} asks for able bodies to see a traveller safely along the road.",
    objectives: [
      "Find the traveller waiting to leave {location}.",
      "See the traveller safely to the agreed meeting point.",
      "Return to {location} and confirm the escort is done.",
    ],
    rewardLabel: "Escort pay",
    gmTwist: "The traveller carries something they have not declared; the escort is a cover for moving it quietly.",
  }),
  Object.freeze({
    id: "delivery", label: "Courier work",
    keywords: ["deliver", "delivery", "courier", "message", "letter", "package", "parcel", "carry", "errand", "dispatch"],
    title: "A courier errand from {location}",
    description: "A sealed errand in {location} needs a discreet hand to carry word or goods across the district.",
    objectives: [
      "Collect the sealed item or message in {location}.",
      "Deliver it unopened to the named recipient.",
      "Bring back the recipient's token of receipt.",
    ],
    rewardLabel: "Courier's fee",
    gmTwist: "The sealed errand is a test of discretion; the recipient reports back on whether it was opened.",
  }),
  Object.freeze({
    id: "investigation", label: "Investigation work",
    keywords: ["investigate", "investigation", "search", "missing", "find", "discover", "discovery", "mystery", "probe", "case", "lead", "leads", "rumor", "rumour", "information", "news"],
    title: "A lead to follow in {location}",
    description: "Rumour in {location} points to something unresolved, and someone will pay to have it looked into.",
    objectives: [
      "Gather accounts of the matter around {location}.",
      "Find the place or person the accounts point to.",
      "Bring what you learned back to whoever asked.",
    ],
    rewardLabel: "A finder's payment",
    gmTwist: "The lead is real but incomplete; the person who spread it in {location} is steering the search away from themselves.",
  }),
  Object.freeze({
    id: "general", label: "Open request",
    keywords: [],
    title: "A request for help in {location}",
    description: "Word in {location} is that someone needs a capable hand and is willing to say so.",
    objectives: [
      "Ask around {location} for who needs help.",
      "Take on the request you find and carry it through.",
    ],
    rewardLabel: "An agreed reward",
    gmTwist: "The request is a small hook into a larger local problem; whoever asked has more at stake than they admit.",
  }),
]);

/** Fail-closed reasons a declaration does not produce a materialization candidate. */
export type FreeformQuestNoneReason =
  | "no-quest-intent"
  | "empty-lead"
  | "lead-too-long"
  | "known-quest"
  | "no-current-location"
  | "current-location-unmapped";

/** One public objective inside a server-authored quest candidate. */
export interface FreeformQuestObjective {
  key: string;
  description: string;
  targetProgress: number;
  dependencyObjectiveKeys: readonly string[];
  visibility: "public";
}

/** The single inert reward inside a server-authored quest candidate. */
export interface FreeformQuestReward {
  key: string;
  label: string;
  kind: "custom";
  amount: null;
  visibility: "public";
}

/** One server-authored materialization candidate. */
export interface FreeformQuestCandidate {
  /** Stable candidate identity derived from durable ids and the normalized lead. */
  candidateId: string;
  /** Draft-local artifact key for the public quest. */
  questKey: string;
  /** Draft-local artifact key for the separate GM-only twist artifact. */
  gmTwistKey: string;
  /** Accepted artifact key of the actor's current public location (placement context). */
  locationKey: string;
  /** Deterministic server-authored quest title. */
  title: string;
  /** Deterministic server-authored quest description. */
  description: string;
  /** Small bounded set of public objectives, chained by dependency. */
  objectives: readonly FreeformQuestObjective[];
  /** Exactly one inert `custom` reward. */
  reward: FreeformQuestReward;
  /** Server-authored GM-only twist; always materialized as a separate GM artifact. */
  gmTwist: string;
  /** Selecting template id, for audit. */
  templateId: string;
  visibility: "public";
}

/** Public location context used by the pure classifier. */
export interface FreeformQuestLocationContext {
  locationId: string;
  name: string;
  visibility: "public" | "discovered" | "gm";
  /** Accepted public location artifact key, when one exists. */
  artifactKey: string | null;
}

export type FreeformQuestClassification =
  | { intent: "none"; reason: FreeformQuestNoneReason; title?: string }
  | { intent: "materialize-quest"; lead: string; candidates: readonly FreeformQuestCandidate[] };

/** A materialized candidate projection returned with the receipts. */
export interface FreeformQuestMaterializedCandidate {
  candidateId: string;
  questKey: string;
  gmTwistKey: string;
  title: string;
  visibility: "public";
}

export type FreeformQuestMaterialization =
  | { status: "declined"; reason: FreeformQuestNoneReason }
  | {
    status: "materialized";
    candidate: FreeformQuestMaterializedCandidate;
    /** Server resource id of the public quest artifact. */
    questId: string;
    draftId: string;
    /** Durable `campaign_content_receipts_v42` receipt for the quest materialization. */
    contentReceiptId: string | null;
    /** Accepted artifact key of the separate GM-only twist artifact, when written. */
    gmTwistArtifactKey: string | null;
  };

export class FreeformQuestAuthorizationError extends Error {}
export class FreeformQuestConflictError extends Error {}
export class FreeformQuestUnavailableError extends Error {}

/** Parses the bounded work/lead phrase out of a free-form declaration. */
export function parseFreeformQuestLead(text: string):
  | { ok: true; lead: string; normalized: string }
  | { ok: false; reason: Extract<FreeformQuestNoneReason, "no-quest-intent" | "empty-lead" | "lead-too-long"> } {
  const match = QUEST_REQUEST_PATTERN.exec(text.trim());
  if (!match) return { ok: false, reason: "no-quest-intent" };
  const firstSentence = (match[1] ?? "").split(/[.!?;]/, 1)[0] ?? "";
  const cleaned = firstSentence.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: false, reason: "empty-lead" };
  if (!QUEST_NOUN.test(cleaned)) return { ok: false, reason: "no-quest-intent" };
  const lead = cleaned.replace(/[.,;:!?]+$/g, "").trim();
  if (!lead) return { ok: false, reason: "empty-lead" };
  if (lead.length > MAX_FREEFORM_QUEST_LEAD_LENGTH) return { ok: false, reason: "lead-too-long" };
  return { ok: true, lead, normalized: normalizeQuestLead(lead) };
}

function normalizeQuestLead(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeQuestTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Selects the first server-authored template whose keyword matches a lead token. */
export function selectFreeformQuestTemplate(lead: string): FreeformQuestTemplate {
  const tokens = new Set(normalizeQuestLead(lead).split(/[^a-z0-9]+/).filter(Boolean));
  for (const template of FREEFORM_QUEST_TEMPLATES) {
    if (template.keywords.some((keyword) => tokens.has(keyword))) return template;
  }
  return FREEFORM_QUEST_TEMPLATES[FREEFORM_QUEST_TEMPLATES.length - 1]!;
}

function fill(template: string, location: string): string {
  return template.replaceAll("{location}", location);
}

/**
 * Deterministic, server-owned classification. It never invents content: a
 * materialization candidate is only produced when the declaration asks for work
 * that is not already accepted canon and the actor's current location is a
 * generated public location the generation apply can anchor the quest to.
 */
export function classifyFreeformQuest(input: {
  identity: string;
  text: string;
  currentLocation: FreeformQuestLocationContext | null;
  knownQuestTitles: ReadonlyArray<string>;
}): FreeformQuestClassification {
  const parsed = parseFreeformQuestLead(input.text);
  if (!parsed.ok) return { intent: "none", reason: parsed.reason };
  const { lead, normalized } = parsed;
  if (!input.currentLocation) return { intent: "none", reason: "no-current-location" };
  const artifact = input.currentLocation.artifactKey
    ? generatedArtifactKeySchema.safeParse(input.currentLocation.artifactKey)
    : null;
  if (!artifact?.success) return { intent: "none", reason: "current-location-unmapped" };

  const template = selectFreeformQuestTemplate(lead);
  const title = fill(template.title, input.currentLocation.name);
  const duplicate = input.knownQuestTitles.find((known) => normalizeQuestTitle(known) === normalizeQuestTitle(title));
  if (duplicate !== undefined) return { intent: "none", reason: "known-quest", title: duplicate };

  const digest = sha256(`${input.identity}:${normalized}`);
  const objectiveKeys = template.objectives.map((_description, index) =>
    generatedArtifactKeySchema.parse(`ffq-${digest.slice(0, 40)}-obj-${index + 1}`));
  const objectives: FreeformQuestObjective[] = template.objectives.map((description, index) => ({
    key: objectiveKeys[index]!,
    description: fill(description, input.currentLocation!.name),
    targetProgress: 1,
    dependencyObjectiveKeys: index === 0 ? [] : [objectiveKeys[index - 1]!],
    visibility: "public",
  }));
  const candidate: FreeformQuestCandidate = {
    candidateId: `ffq-${digest.slice(0, 40)}`,
    questKey: generatedArtifactKeySchema.parse(`ff-quest-${digest.slice(0, 40)}`),
    gmTwistKey: generatedArtifactKeySchema.parse(`ff-quest-twist-${digest.slice(0, 40)}`),
    locationKey: artifact.data,
    title,
    description: fill(template.description, input.currentLocation.name),
    objectives,
    reward: {
      key: generatedArtifactKeySchema.parse(`ffq-${digest.slice(0, 40)}-reward`),
      label: template.rewardLabel,
      kind: "custom",
      amount: null,
      visibility: "public",
    },
    gmTwist: fill(template.gmTwist, input.currentLocation.name),
    templateId: template.id,
    visibility: "public",
  };
  return { intent: "materialize-quest", lead, candidates: [candidate] };
}

/** Narrow ports so the module reuses existing repos without importing their full surface. */
export interface FreeformQuestPorts {
  getDraftByIdempotencyKey(principalId: string, campaignId: string, idempotencyKey: string): unknown;
  createDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  getContentRevision(principalId: string, campaignId: string): number | null;
  recordCandidate(draftId: string, content: GeneratedCampaignContentProvider): void;
  applyDraft(principalId: string, input: DraftMutationInput & { selectedArtifactKeys: string[] }): PrivateGenerationDraft;
}

export interface FreeformQuestRepository {
  /** Classifies one declaration; throws only for unauthorized principals. */
  classifyFreeformQuestIntent(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformQuestClassification;
  /** Applies the exact server-authored candidate atomically. */
  materializeFreeformQuest(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string,
    options?: { candidateId?: string }): FreeformQuestMaterialization;
}

type PlacementRow = { location_id: string; public_name: string; visibility: "public" | "discovered" | "gm" };

export function createFreeformQuestRepository(
  db: DatabaseDriver.Database,
  deps: { clock: Clock },
  ports: FreeformQuestPorts,
  guard: () => void,
): FreeformQuestRepository {
  const now = (): string => deps.clock.now().toISOString();

  function authorize(principalId: string, campaignId: string, actorId: string): void {
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new FreeformQuestAuthorizationError("campaign membership is required");
    if (member.role === "owner" || member.role === "gm") return;
    if (!db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(campaignId, actorId, principalId)) throw new FreeformQuestAuthorizationError("principal cannot act for the actor");
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

  function readCurrentLocation(campaignId: string, sessionId: string, actorId: string): FreeformQuestLocationContext | null {
    const row = db.prepare(`SELECT placement.location_id,location.public_name,location.visibility
      FROM campaign_actor_locations_v28 placement
      JOIN campaign_locations_v28 location ON location.campaign_id=placement.campaign_id AND location.location_id=placement.location_id
      WHERE placement.campaign_id=? AND placement.actor_id=? AND placement.session_id=?`)
      .get(campaignId, actorId, sessionId) as PlacementRow | undefined;
    if (!row) return null;
    const artifact = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND server_resource_id=? AND artifact_kind='location' AND visibility='public' LIMIT 1`)
      .get(campaignId, row.location_id) as { artifact_key: string } | undefined;
    if (!artifact) return { locationId: row.location_id, name: row.public_name, visibility: row.visibility, artifactKey: null };
    return { locationId: row.location_id, name: row.public_name, visibility: row.visibility, artifactKey: artifact.artifact_key };
  }

  function readKnownQuestTitles(campaignId: string): string[] {
    return (db.prepare(`SELECT canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND visibility='public' AND artifact_kind='quest' ORDER BY accepted_at,artifact_key`)
      .all(campaignId) as Array<{ canonical_json: string }>).flatMap((row) => {
      const title = (JSON.parse(row.canonical_json) as { title?: unknown }).title;
      return typeof title === "string" ? [title] : [];
    });
  }

  function classifyWithContext(identity: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformQuestClassification {
    return classifyFreeformQuest({
      identity, text,
      currentLocation: readCurrentLocation(campaignId, sessionId, actorId),
      knownQuestTitles: readKnownQuestTitles(campaignId),
    });
  }

  /**
   * Replays a previously committed materialization. All writes already happened
   * in one transaction, so a stored draft is proof the quest and the separate
   * GM-only twist exist. The receipt is read back from the durable content
   * command rather than re-issued.
   */
  function replayMaterialization(authority: string, campaignId: string, identity: string, normalized: string): FreeformQuestMaterialization {
    const draftKey = idempotencyKeySchema.parse(`ff-quest-draft-${sha256(`${identity}:${normalized}`).slice(0, 48)}`);
    const existing = ports.getDraftByIdempotencyKey(authority, campaignId, draftKey);
    if (!existing) throw new FreeformQuestConflictError("materialization replay is unavailable");
    const draft = privateGenerationDraftSchema.parse(existing);
    const quest = db.prepare(`SELECT artifact_key,server_resource_id,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='quest' AND visibility='public' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string; server_resource_id: string | null; canonical_json: string } | undefined;
    if (!quest?.server_resource_id) throw new FreeformQuestConflictError("materialized quest is unavailable");
    const twist = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
    const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
      .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
    const value = JSON.parse(quest.canonical_json) as { title?: string };
    return {
      status: "materialized",
      candidate: { candidateId: `ffq-${sha256(`${identity}:${normalized}`).slice(0, 40)}`, questKey: quest.artifact_key,
        gmTwistKey: twist?.artifact_key ?? "", title: typeof value.title === "string" ? value.title : normalized, visibility: "public" },
      questId: quest.server_resource_id,
      draftId: draft.draftId,
      contentReceiptId: receipt?.receipt_id ?? null,
      gmTwistArtifactKey: twist?.artifact_key ?? null,
    };
  }

  return {
    classifyFreeformQuestIntent(principalId, campaignId, sessionId, actorId, text) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);
      return classifyWithContext(`${campaignId}:${sessionId}:${actorId}`, campaignId, sessionId, actorId, text);
    },

    materializeFreeformQuest(principalId, campaignId, sessionId, actorId, text, options) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);

      const parsed = parseFreeformQuestLead(text);
      if (!parsed.ok) return { status: "declined" as const, reason: parsed.reason };
      const identity = `${campaignId}:${sessionId}:${actorId}`;
      const digest = sha256(`${identity}:${parsed.normalized}`);
      const candidateId = `ffq-${digest.slice(0, 40)}`;
      const draftKey = idempotencyKeySchema.parse(`ff-quest-draft-${digest.slice(0, 48)}`);
      const applyKey = idempotencyKeySchema.parse(`ff-quest-apply-${digest.slice(0, 48)}`);
      if (options?.candidateId !== undefined && options.candidateId !== candidateId) {
        throw new FreeformQuestConflictError("the chosen candidate is not in the server-authored set");
      }
      const authority = gmAuthorityPrincipal(principalId, campaignId);
      if (!authority) throw new FreeformQuestUnavailableError("campaign has no GM authority to materialize a quest");

      return db.transaction(() => {
        if (ports.getDraftByIdempotencyKey(authority, campaignId, draftKey)) {
          return replayMaterialization(authority, campaignId, identity, parsed.normalized);
        }

        // Freshness re-check: only materialize a quest the classifier still authorizes.
        const classification = classifyWithContext(identity, campaignId, sessionId, actorId, text);
        if (classification.intent === "none") return { status: "declined" as const, reason: classification.reason };
        const candidate = classification.candidates.find((value) => value.candidateId === candidateId);
        if (!candidate) throw new FreeformQuestConflictError("the chosen candidate is no longer available");

        const campaign = db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?")
          .get(campaignId) as { active_timeline_id: string; administration_revision: number } | undefined;
        if (!campaign) throw new FreeformQuestUnavailableError("campaign is unavailable");

        // Public quest with public objectives only. The GM-only twist is a separate
        // `visibility:'gm'` artifact and is never attached to the public quest.
        const content = generatedCampaignContentProviderSchema.parse({
          quests: [{
            key: candidate.questKey, title: candidate.title, description: candidate.description, visibility: "public",
            locationKeys: [candidate.locationKey], objectives: [...candidate.objectives], rewards: [candidate.reward],
          }],
          lore: [{
            key: candidate.gmTwistKey, title: `GM-only twist: ${candidate.title}`, summary: candidate.gmTwist,
            details: [], visibility: "gm", locationKeys: [], factionKeys: [], storyNodeKeys: [],
          }],
        });
        const selectedArtifactKeys = [candidate.questKey, candidate.gmTwistKey];
        const requestDigest = sha256(canonical({ kind: "freeform-materialize-quest", campaignId, sessionId, actorId, candidate }));

        const baseRevision = ports.getContentRevision(authority, campaignId);
        if (baseRevision === null) throw new FreeformQuestUnavailableError("generation context is unavailable");
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

        const quest = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='quest'`).get(campaignId, candidate.questKey) as { server_resource_id: string | null } | undefined;
        if (!quest?.server_resource_id) throw new FreeformQuestConflictError("materialized quest is unavailable");
        const twist = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='lore' AND visibility='gm' LIMIT 1`)
          .get(campaignId, draft.draftId) as { artifact_key: string } | undefined;
        const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
          .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
        return {
          status: "materialized" as const,
          candidate: { candidateId, questKey: candidate.questKey, gmTwistKey: candidate.gmTwistKey,
            title: candidate.title, visibility: "public" as const },
          questId: quest.server_resource_id,
          draftId: applied.draftId,
          contentReceiptId: receipt?.receipt_id ?? null,
          gmTwistArtifactKey: twist?.artifact_key ?? null,
        };
      }).immediate();
    },
  };
}

/**
 * Phase 1 free-form travel: bounded, server-authored location materialization.
 *
 * When a player declares travel to an unmapped place ("I go to the glassblower's
 * district"), the server — never the model — decides whether that needs new
 * durable content and what the closed candidate set is. This module:
 *
 * 1. Classifies one free-form declaration deterministically (`classifyFreeformTravel`)
 *    against public canon (the actor's current location and every existing location).
 *    It returns either no intent or a bounded candidate list (currently exactly one
 *    candidate) whose identity is a deterministic digest of durable ids.
 * 2. Materializes the exact chosen candidate atomically (`materializeFreeformTravel`):
 *    a public `location` + public `connection` artifact through the existing
 *    campaign-content generation apply path, then a world `travel` command for the
 *    actor, all inside one caller-owned immediate transaction. A failure in either
 *    half rolls back both.
 *
 * Hard invariants:
 * - The candidate set is server-authored and closed; callers may only select a
 *   candidate that the classifier produced. No free-text world lore is written:
 *   the location name is the player's bounded phrase and the description is a
 *   deterministic template derived from the current location's public name.
 * - Every write goes through the existing command/receipt machinery
 *   (`createGenerationDraft` + `recordCampaignGenerationCandidate` +
 *   `applyCampaignContentGenerationDraftAtomically` -> `campaign_content_*_v42`,
 *   and the world travel command -> `world_commands_v28`/`world_receipts_v28`).
 *   This module never writes a domain table directly.
 * - Materialized content is `visibility:'public'`. Secrets belong to separate
 *   GM-only artifacts and are out of scope here.
 * - No stats, enemies, or prices are fabricated.
 * - Idempotency keys are derived from durable identities
 *   (`campaignId:sessionId:actorId:<normalized destination>`), so a replayed
 *   attempt converges on the same draft, command and receipt instead of creating
 *   a second location.
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
  type ActorTravelCommandRequest,
  type CreateGenerationDraftInput,
  type DraftMutationInput,
  type GeneratedCampaignContentProvider,
  type PrivateGenerationDraft,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";
import type { ActorTravelResult } from "../world/worldWriteRepo.js";

/** Maximum length of the player-supplied destination phrase. */
export const MAX_FREEFORM_DESTINATION_LENGTH = 200;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** A travel declaration names a destination after one of these verbs plus a preposition. */
const TRAVEL_PATTERN = /\b(?:go|goes|going|head|heads|heading|walk|walks|walking|travel|travels|travelling|traveling|move|moves|moving|journey|ride|rides|run|runs|venture|ventures)\s+(?:to|towards?|into|for)\s+(.+)$/i;
const LEADING_ARTICLE = /^(?:the|a|an|my|our|your)\s+/i;

/** Fail-closed reasons a declaration does not produce a materialization candidate. */
export type FreeformTravelNoneReason =
  | "no-travel-intent"
  | "empty-destination"
  | "destination-too-long"
  | "known-location"
  | "no-current-location"
  | "current-location-unmapped";

/** One server-authored materialization candidate. */
export interface FreeformTravelCandidate {
  /** Stable candidate identity derived from durable ids and the normalized destination. */
  candidateId: string;
  /** Draft-local artifact key for the new location. */
  locationKey: string;
  /** Draft-local artifact key for the new connection. */
  connectionKey: string;
  /** Accepted artifact key of the actor's current location (required by the generation apply). */
  fromLocationKey: string;
  /** Server resource id of the actor's current location. */
  fromLocationId: string;
  /** Public name of the actor's current location. */
  fromLocationName: string;
  /** Bounded player phrase used as the new location's public name. */
  name: string;
  /** Deterministic template description; never model-authored lore. */
  description: string;
  visibility: "public";
}

/** Public location context used by the pure classifier. */
export interface FreeformTravelLocationContext {
  locationId: string;
  name: string;
  visibility: "public" | "discovered" | "gm";
  /** Accepted public location artifact key, when one exists. */
  artifactKey: string | null;
}

export type FreeformTravelClassification =
  | { intent: "none"; reason: FreeformTravelNoneReason; locationId?: string }
  | { intent: "materialize-location"; destinationName: string; candidates: readonly FreeformTravelCandidate[] };

/** A materialized candidate projection returned with the receipts. */
export interface FreeformTravelMaterializedCandidate {
  candidateId: string;
  locationKey: string;
  connectionKey: string;
  name: string;
  visibility: "public";
}

export type FreeformTravelMaterialization =
  | { status: "declined"; reason: FreeformTravelNoneReason }
  | {
    status: "materialized";
    candidate: FreeformTravelMaterializedCandidate;
    locationId: string;
    connectionId: string;
    draftId: string;
    /** Durable `campaign_content_receipts_v42` receipt for the location materialization. */
    contentReceiptId: string | null;
    /** Durable world receipt for the actor movement. */
    world: { commandId: string; revisionBefore: number; revisionAfter: number; occurredAt: string };
    discoveries: Array<{ actorId: string; locationId: string; discoveredAt: string }>;
  };

export class FreeformTravelAuthorizationError extends Error {}
export class FreeformTravelConflictError extends Error {}
export class FreeformTravelUnavailableError extends Error {}

/** Parses the bounded destination phrase out of a free-form declaration. */
export function parseFreeformTravelDestination(text: string):
  | { ok: true; name: string; normalized: string }
  | { ok: false; reason: Extract<FreeformTravelNoneReason, "no-travel-intent" | "empty-destination" | "destination-too-long"> } {
  const match = TRAVEL_PATTERN.exec(text.trim());
  if (!match) return { ok: false, reason: "no-travel-intent" };
  const firstSentence = (match[1] ?? "").split(/[.!?;]/, 1)[0] ?? "";
  const cleaned = firstSentence.replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
  const name = cleaned.replace(LEADING_ARTICLE, "").replace(/[.,;:!?]+$/g, "").trim();
  if (!name) return { ok: false, reason: "empty-destination" };
  if (name.length > MAX_FREEFORM_DESTINATION_LENGTH) return { ok: false, reason: "destination-too-long" };
  return { ok: true, name, normalized: normalizeLocationName(name) };
}

function normalizeLocationName(value: string): string {
  return value.toLowerCase().replace(LEADING_ARTICLE, "").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Deterministic, server-owned classification. It never invents content: a
 * materialization candidate is only produced when the request names a place that
 * is not already known and the actor's current location is a generated public
 * location that the generation apply can attach a connection to.
 */
export function classifyFreeformTravel(input: {
  identity: string;
  text: string;
  currentLocation: FreeformTravelLocationContext | null;
  locations: ReadonlyArray<FreeformTravelLocationContext>;
}): FreeformTravelClassification {
  const parsed = parseFreeformTravelDestination(input.text);
  if (!parsed.ok) return { intent: "none", reason: parsed.reason };
  const { name, normalized } = parsed;

  const existing = input.locations.find((location) => normalizeLocationName(location.name) === normalized);
  if (existing) {
    return existing.visibility === "gm"
      ? { intent: "none", reason: "known-location" }
      : { intent: "none", reason: "known-location", locationId: existing.locationId };
  }
  if (!input.currentLocation) return { intent: "none", reason: "no-current-location" };
  const artifact = input.currentLocation.artifactKey
    ? generatedArtifactKeySchema.safeParse(input.currentLocation.artifactKey)
    : null;
  if (!artifact?.success) return { intent: "none", reason: "current-location-unmapped" };

  const digest = sha256(`${input.identity}:${normalized}`);
  const candidate: FreeformTravelCandidate = {
    candidateId: `ffc-${digest.slice(0, 40)}`,
    locationKey: generatedArtifactKeySchema.parse(`ff-loc-${digest.slice(0, 40)}`),
    connectionKey: generatedArtifactKeySchema.parse(`ff-conn-${digest.slice(0, 40)}`),
    fromLocationKey: artifact.data,
    fromLocationId: input.currentLocation.locationId,
    fromLocationName: input.currentLocation.name,
    name,
    description: `A place first reached from ${input.currentLocation.name}.`,
    visibility: "public",
  };
  return { intent: "materialize-location", destinationName: name, candidates: [candidate] };
}

/** Narrow ports so the module reuses existing repos without importing their full surface. */
export interface FreeformTravelPorts {
  getDraftByIdempotencyKey(principalId: string, campaignId: string, idempotencyKey: string): unknown;
  createDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  getContentRevision(principalId: string, campaignId: string): number | null;
  recordCandidate(draftId: string, content: GeneratedCampaignContentProvider): void;
  applyDraft(principalId: string, input: DraftMutationInput & { selectedArtifactKeys: string[] }): PrivateGenerationDraft;
  travelActor(principalId: string, actorId: string, input: ActorTravelCommandRequest): ActorTravelResult;
}

export interface FreeformTravelRepository {
  /** Classifies one declaration; throws only for unauthorized principals. */
  classifyFreeformTravelIntent(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformTravelClassification;
  /** Applies the exact server-authored candidate and moves the actor atomically. */
  materializeFreeformTravel(principalId: string, campaignId: string, sessionId: string, actorId: string, text: string,
    options?: { candidateId?: string }): FreeformTravelMaterialization;
}

type PlacementRow = { location_id: string; public_name: string; visibility: "public" | "discovered" | "gm" };
type LocationRow = { location_id: string; public_name: string; visibility: "public" | "discovered" | "gm" };

export function createFreeformTravelRepository(
  db: DatabaseDriver.Database,
  deps: { clock: Clock },
  ports: FreeformTravelPorts,
  guard: () => void,
): FreeformTravelRepository {
  const now = (): string => deps.clock.now().toISOString();

  function authorize(principalId: string, campaignId: string, actorId: string): void {
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new FreeformTravelAuthorizationError("campaign membership is required");
    if (member.role === "owner" || member.role === "gm") return;
    if (!db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(campaignId, actorId, principalId)) throw new FreeformTravelAuthorizationError("principal cannot act for the actor");
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

  function readCurrentLocation(campaignId: string, sessionId: string, actorId: string): FreeformTravelLocationContext | null {
    const row = db.prepare(`SELECT placement.location_id,location.public_name,location.visibility
      FROM campaign_actor_locations_v28 placement
      JOIN campaign_locations_v28 location ON location.campaign_id=placement.campaign_id AND location.location_id=placement.location_id
      WHERE placement.campaign_id=? AND placement.actor_id=? AND placement.session_id=?`)
      .get(campaignId, actorId, sessionId) as PlacementRow | undefined;
    if (!row) return null;
    const artifact = db.prepare(`SELECT artifact_key FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND server_resource_id=? AND artifact_kind='location' AND visibility='public' LIMIT 1`)
      .get(campaignId, row.location_id) as { artifact_key: string } | undefined;
    return { locationId: row.location_id, name: row.public_name, visibility: row.visibility, artifactKey: artifact?.artifact_key ?? null };
  }

  function readLocations(campaignId: string): FreeformTravelLocationContext[] {
    return (db.prepare("SELECT location_id,public_name,visibility FROM campaign_locations_v28 WHERE campaign_id=? ORDER BY location_id")
      .all(campaignId) as LocationRow[]).map((row) => ({
        locationId: row.location_id, name: row.public_name, visibility: row.visibility, artifactKey: null,
      }));
  }

  function classifyWithContext(identity: string, campaignId: string, sessionId: string, actorId: string, text: string): FreeformTravelClassification {
    return classifyFreeformTravel({
      identity, text,
      currentLocation: readCurrentLocation(campaignId, sessionId, actorId),
      locations: readLocations(campaignId),
    });
  }

  function worldRevision(campaignId: string, sessionId: string): number {
    return (db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?")
      .get(campaignId, sessionId) as { revision: number } | undefined)?.revision ?? 0;
  }

  /**
   * Replays a previously committed materialization. All writes already happened
   * in one transaction, so a stored draft is proof the location, connection and
   * travel command exist. The travel receipt is read back from the durable world
   * command rather than re-issued, so replay does not depend on the actor still
   * being adjacent to the source connection.
   */
  function replayMaterialization(principalId: string, campaignId: string, sessionId: string, actorId: string,
    identity: string, normalized: string, travelKey: string): FreeformTravelMaterialization {
    const existing = ports.getDraftByIdempotencyKey(gmAuthorityPrincipal(principalId, campaignId)!, campaignId,
      idempotencyKeySchema.parse(`ff-draft-${sha256(`${identity}:${normalized}`).slice(0, 48)}`));
    if (!existing) throw new FreeformTravelConflictError("materialization replay is unavailable");
    const draft = privateGenerationDraftSchema.parse(existing);
    const location = db.prepare(`SELECT artifact_key,server_resource_id,canonical_json FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='location' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string; server_resource_id: string | null; canonical_json: string } | undefined;
    const connection = db.prepare(`SELECT artifact_key,server_resource_id FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND source_draft_id=? AND artifact_kind='connection' LIMIT 1`)
      .get(campaignId, draft.draftId) as { artifact_key: string; server_resource_id: string | null } | undefined;
    if (!location?.server_resource_id || !connection?.server_resource_id) {
      throw new FreeformTravelConflictError("materialized location or connection is unavailable");
    }
    const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
      .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
    const stored = db.prepare(`SELECT receipt.canonical_result_json FROM world_commands_v28 command
      JOIN world_receipts_v28 receipt USING(campaign_id,session_id,command_id)
      WHERE command.campaign_id=? AND command.session_id=? AND command.actor_id=? AND command.idempotency_key=? AND command.command_type='travel'`)
      .get(campaignId, sessionId, actorId, travelKey) as { canonical_result_json: string } | undefined;
    if (!stored) throw new FreeformTravelConflictError("materialization replay is unavailable");
    const travel = JSON.parse(stored.canonical_result_json) as ActorTravelResult;
    const value = JSON.parse(location.canonical_json) as { name?: string };
    return {
      status: "materialized",
      candidate: { candidateId: `ffc-${sha256(`${identity}:${normalized}`).slice(0, 40)}`, locationKey: location.artifact_key,
        connectionKey: connection.artifact_key, name: typeof value.name === "string" ? value.name : normalized, visibility: "public" },
      locationId: location.server_resource_id,
      connectionId: connection.server_resource_id,
      draftId: draft.draftId,
      contentReceiptId: receipt?.receipt_id ?? null,
      world: { commandId: travel.receipt.commandId, revisionBefore: travel.receipt.revisionBefore,
        revisionAfter: travel.receipt.revisionAfter, occurredAt: travel.receipt.occurredAt },
      discoveries: travel.discoveries.map((discovery) => ({ actorId: discovery.actorId, locationId: discovery.locationId, discoveredAt: discovery.discoveredAt })),
    };
  }

  return {
    classifyFreeformTravelIntent(principalId, campaignId, sessionId, actorId, text) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);
      return classifyWithContext(`${campaignId}:${sessionId}:${actorId}`, campaignId, sessionId, actorId, text);
    },

    materializeFreeformTravel(principalId, campaignId, sessionId, actorId, text, options) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId); resourceIdSchema.parse(actorId);
      authorize(principalId, campaignId, actorId);

      const parsed = parseFreeformTravelDestination(text);
      if (!parsed.ok) return { status: "declined" as const, reason: parsed.reason };
      const identity = `${campaignId}:${sessionId}:${actorId}`;
      const digest = sha256(`${identity}:${parsed.normalized}`);
      const candidateId = `ffc-${digest.slice(0, 40)}`;
      const draftKey = idempotencyKeySchema.parse(`ff-draft-${digest.slice(0, 48)}`);
      const applyKey = idempotencyKeySchema.parse(`ff-apply-${digest.slice(0, 48)}`);
      const travelKey = idempotencyKeySchema.parse(`ff-travel-${digest.slice(0, 48)}`);
      if (options?.candidateId !== undefined && options.candidateId !== candidateId) {
        throw new FreeformTravelConflictError("the chosen candidate is not in the server-authored set");
      }
      const authority = gmAuthorityPrincipal(principalId, campaignId);
      if (!authority) throw new FreeformTravelUnavailableError("campaign has no GM authority to materialize a location");

      return db.transaction(() => {
        if (ports.getDraftByIdempotencyKey(authority, campaignId, draftKey)) {
          return replayMaterialization(principalId, campaignId, sessionId, actorId, identity, parsed.normalized, travelKey);
        }

        // Freshness re-check: only materialize a location the classifier still authorizes.
        const classification = classifyWithContext(identity, campaignId, sessionId, actorId, text);
        if (classification.intent === "none") return { status: "declined" as const, reason: classification.reason };
        const candidate = classification.candidates.find((value) => value.candidateId === candidateId);
        if (!candidate) throw new FreeformTravelConflictError("the chosen candidate is no longer available");

        const campaign = db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?")
          .get(campaignId) as { active_timeline_id: string; administration_revision: number } | undefined;
        if (!campaign) throw new FreeformTravelUnavailableError("campaign is unavailable");

        const content = generatedCampaignContentProviderSchema.parse({
          locations: [{ key: candidate.locationKey, name: candidate.name, description: candidate.description, visibility: "public" }],
          connections: [{ key: candidate.connectionKey, fromLocationKey: candidate.fromLocationKey, toLocationKey: candidate.locationKey,
            description: candidate.description, visibility: "public" }],
        });
        const requestDigest = sha256(canonical({ kind: "freeform-materialize-location", campaignId, sessionId, actorId, candidate }));

        const baseRevision = ports.getContentRevision(authority, campaignId);
        if (baseRevision === null) throw new FreeformTravelUnavailableError("generation context is unavailable");
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
          idempotencyKey: applyKey, selectedArtifactKeys: [candidate.locationKey, candidate.connectionKey],
        });

        const location = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='location'`).get(campaignId, candidate.locationKey) as { server_resource_id: string | null } | undefined;
        const connection = db.prepare(`SELECT server_resource_id FROM campaign_generation_accepted_artifacts_v52
          WHERE campaign_id=? AND artifact_key=? AND artifact_kind='connection'`).get(campaignId, candidate.connectionKey) as { server_resource_id: string | null } | undefined;
        if (!location?.server_resource_id || !connection?.server_resource_id) {
          throw new FreeformTravelConflictError("materialized location or connection is unavailable");
        }
        const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
          .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
        const travel = ports.travelActor(principalId, actorId, {
          connectionId: connection.server_resource_id, partyActorIds: [actorId],
          expectedRevision: worldRevision(campaignId, sessionId), idempotencyKey: travelKey,
        });
        return {
          status: "materialized" as const,
          candidate: { candidateId, locationKey: candidate.locationKey, connectionKey: candidate.connectionKey,
            name: candidate.name, visibility: "public" as const },
          locationId: location.server_resource_id,
          connectionId: connection.server_resource_id,
          draftId: applied.draftId,
          contentReceiptId: receipt?.receipt_id ?? null,
          world: { commandId: travel.receipt.commandId, revisionBefore: travel.receipt.revisionBefore,
            revisionAfter: travel.receipt.revisionAfter, occurredAt: travel.receipt.occurredAt },
          discoveries: travel.discoveries.map((discovery) => ({ actorId: discovery.actorId, locationId: discovery.locationId, discoveredAt: discovery.discoveredAt })),
        };
      }).immediate();
    },
  };
}

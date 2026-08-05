import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema, principalIdSchema } from "./rpg-characters.js";

/** Stable identities for world state; none are catalog definition identities. */
export const locationIdSchema = resourceIdSchema;
export const locationConnectionIdSchema = resourceIdSchema;
export const locationDiscoveryIdSchema = resourceIdSchema;
export const npcIdSchema = resourceIdSchema;
export const npcPersonaLinkIdSchema = resourceIdSchema;
export const relationshipIdSchema = resourceIdSchema;
export const factionIdSchema = resourceIdSchema;
export const factionMembershipIdSchema = resourceIdSchema;
export const factionRelationIdSchema = resourceIdSchema;
export const reputationLedgerEntryIdSchema = resourceIdSchema;
export const travelIdSchema = resourceIdSchema;

export const MAX_WORLD_NAME_LENGTH = 200;
export const MAX_WORLD_TEXT_LENGTH = 4_000;
export const MAX_LOCATION_CONNECTIONS = 128;
export const MAX_TRAVEL_PARTY_SIZE = 16;
export const MAX_REPUTATION_DELTA = 10_000;

const worldNameSchema = z.string().min(1).max(MAX_WORLD_NAME_LENGTH).refine((value) => value.trim().length > 0, "name must not be blank");
const worldTextSchema = z.string().min(1).max(MAX_WORLD_TEXT_LENGTH).refine((value) => value.trim().length > 0, "text must not be blank");
const nonNegativeBoundedIntegerSchema = z.number().int().min(0).max(1_000_000);

export const locationVisibilitySchema = z.enum(["visible", "hidden"]);

/** Authoritative hierarchy. A null parent is the campaign's world root. */
export const locationSchema = z.object({
  campaignId: campaignIdSchema,
  locationId: locationIdSchema,
  parentLocationId: locationIdSchema.nullable(),
  name: worldNameSchema,
  /** SQLite permits an intentionally blank public description. */
  description: z.string().max(MAX_WORLD_TEXT_LENGTH),
  visibility: locationVisibilitySchema,
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict().refine((location) => location.parentLocationId !== location.locationId, {
  message: "a location cannot be its own parent",
  path: ["parentLocationId"],
});

/** A directed world edge. Its visibility is authoritative and never player input. */
export const locationConnectionSchema = z.object({
  campaignId: campaignIdSchema,
  locationConnectionId: locationConnectionIdSchema,
  fromLocationId: locationIdSchema,
  toLocationId: locationIdSchema,
  visibility: locationVisibilitySchema,
  createdAt: utcIsoTimestampSchema,
}).strict().refine((connection) => connection.fromLocationId !== connection.toLocationId, {
  message: "a connection must join two distinct locations",
  path: ["toLocationId"],
});

/** A server-recorded discovery for one principal; it is not a client claim. */
export const locationDiscoverySchema = z.object({
  locationDiscoveryId: locationDiscoveryIdSchema,
  campaignId: campaignIdSchema,
  principalId: principalIdSchema,
  locationId: locationIdSchema,
  discoveredAt: utcIsoTimestampSchema,
}).strict();

/** Current authoritative actor position. Travel commands are the sole mutation intent in this module. */
export const actorLocationSchema = z.object({
  campaignId: campaignIdSchema,
  sessionId: resourceIdSchema,
  actorId: actorIdSchema,
  locationId: locationIdSchema,
  revision: revisionSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

/** A persona actor is the authoritative mechanical identity behind an NPC. */
export const npcPersonaLinkSchema = z.object({
  npcPersonaLinkId: npcPersonaLinkIdSchema,
  campaignId: campaignIdSchema,
  npcId: npcIdSchema,
  actorId: actorIdSchema,
  linkedAt: utcIsoTimestampSchema,
}).strict();

/** GM-only state; player projections intentionally have no field that can carry it. */
export const privateNpcStateSchema = z.object({
  campaignId: campaignIdSchema,
  npcId: npcIdSchema,
  gmNotes: worldTextSchema,
  secrets: z.array(worldTextSchema).max(128),
  motivations: z.array(worldTextSchema).max(64),
  updatedAt: utcIsoTimestampSchema,
}).strict();

export const relationshipSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("actor"), actorId: actorIdSchema }).strict(),
  z.object({ kind: z.literal("npc"), npcId: npcIdSchema }).strict(),
  z.object({ kind: z.literal("faction"), factionId: factionIdSchema }).strict(),
]);
export const relationshipDispositionSchema = z.enum(["hostile", "unfriendly", "neutral", "friendly", "allied"]);
export const relationshipSchema = z.object({
  relationshipId: relationshipIdSchema,
  campaignId: campaignIdSchema,
  from: relationshipSubjectSchema,
  to: relationshipSubjectSchema,
  disposition: relationshipDispositionSchema,
  score: z.number().int().min(-100).max(100),
  updatedAt: utcIsoTimestampSchema,
}).strict().superRefine((relationship, context) => {
  const subjectKey = (subject: z.infer<typeof relationshipSubjectSchema>) => subject.kind === "actor" ? subject.actorId : subject.kind === "npc" ? subject.npcId : subject.factionId;
  if (relationship.from.kind === relationship.to.kind && subjectKey(relationship.from) === subjectKey(relationship.to)) {
    context.addIssue({ code: "custom", message: "a relationship cannot target itself", path: ["to"] });
  }
});

export const factionSchema = z.object({
  campaignId: campaignIdSchema,
  factionId: factionIdSchema,
  name: worldNameSchema,
  description: worldTextSchema,
  createdAt: utcIsoTimestampSchema,
}).strict();
export const factionMembershipRoleSchema = z.enum(["leader", "member", "associate", "enemy"]);
export const factionMembershipSchema = z.object({
  factionMembershipId: factionMembershipIdSchema,
  campaignId: campaignIdSchema,
  factionId: factionIdSchema,
  member: relationshipSubjectSchema,
  role: factionMembershipRoleSchema,
  joinedAt: utcIsoTimestampSchema,
}).strict().refine((membership) => membership.member.kind !== "faction" || membership.member.factionId !== membership.factionId, {
  message: "a faction cannot be a member of itself",
  path: ["member"],
});
export const factionRelationSchema = z.object({
  factionRelationId: factionRelationIdSchema,
  campaignId: campaignIdSchema,
  fromFactionId: factionIdSchema,
  toFactionId: factionIdSchema,
  disposition: relationshipDispositionSchema,
  score: z.number().int().min(-100).max(100),
  updatedAt: utcIsoTimestampSchema,
}).strict().refine((relation) => relation.fromFactionId !== relation.toFactionId, {
  message: "a faction relation cannot target itself",
  path: ["toFactionId"],
});

/** Immutable server ledger; callers cannot supply a resultant reputation total. */
export const reputationLedgerEntrySchema = z.object({
  reputationLedgerEntryId: reputationLedgerEntryIdSchema,
  campaignId: campaignIdSchema,
  factionId: factionIdSchema,
  subject: relationshipSubjectSchema,
  delta: z.number().int().min(-MAX_REPUTATION_DELTA).max(MAX_REPUTATION_DELTA).refine((value) => value !== 0, "reputation delta must not be zero"),
  reason: worldTextSchema,
  recordedAt: utcIsoTimestampSchema,
}).strict();

/**
 * The only world mutation command is a travel intent. The server resolves the
 * route, authorization, discoveries, timing, locations, and any encounter;
 * selected party IDs are requests, never caller-authored outcomes.
 */
export const travelCommandSchema = z.object({
  type: z.literal("travel"),
  campaignId: campaignIdSchema,
  travelId: travelIdSchema,
  locationConnectionId: locationConnectionIdSchema,
  selectedPartyActorIds: z.array(actorIdSchema).min(1).max(MAX_TRAVEL_PARTY_SIZE),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((command, context) => {
  const party = new Set<string>();
  command.selectedPartyActorIds.forEach((actorId, index) => {
    if (party.has(actorId)) context.addIssue({ code: "custom", message: "selected party actor IDs must be unique", path: ["selectedPartyActorIds", index] });
    party.add(actorId);
  });
});
/** GM-only authoritative placement, including the initial session position. */
export const setActorLocationCommandSchema = z.object({
  type: z.literal("set_actor_location"), campaignId: campaignIdSchema,
  actorId: actorIdSchema, locationId: locationIdSchema,
  expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
/** Discovery is a GM decision, never a player assertion. */
export const discoverLocationCommandSchema = z.object({
  type: z.literal("discover_location"), campaignId: campaignIdSchema,
  actorId: actorIdSchema, locationId: locationIdSchema,
  expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export const changeReputationCommandSchema = z.object({
  type: z.literal("change_reputation"), campaignId: campaignIdSchema,
  actorId: actorIdSchema, factionId: factionIdSchema,
  delta: z.number().int().min(-MAX_REPUTATION_DELTA).max(MAX_REPUTATION_DELTA).refine((x) => x !== 0),
  reason: worldTextSchema, reputationLedgerEntryId: reputationLedgerEntryIdSchema.optional(),
  expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export const worldCommandSchema = z.discriminatedUnion("type", [travelCommandSchema, setActorLocationCommandSchema, discoverLocationCommandSchema, changeReputationCommandSchema]);

const playerLocationSchema = z.object({ locationId: locationIdSchema, parentLocationId: locationIdSchema.nullable(), name: worldNameSchema, description: z.string().max(MAX_WORLD_TEXT_LENGTH) }).strict();
const playerConnectionSchema = z.object({ locationConnectionId: locationConnectionIdSchema, fromLocationId: locationIdSchema, toLocationId: locationIdSchema }).strict();
/** NPC positions are not persisted in v28, so public NPC rows have no location. */
const playerNpcSchema = z.object({ npcId: npcIdSchema, name: worldNameSchema }).strict();

/** Explicit public projection: it cannot structurally contain hidden flags, routes, or NPC secrets. */
export const playerWorldProjectionSchema = z.object({
  audience: z.literal("player"),
  campaignId: campaignIdSchema,
  revision: revisionSchema,
  discoveries: z.array(locationDiscoverySchema).max(10_000),
  locations: z.array(playerLocationSchema).max(10_000),
  connections: z.array(playerConnectionSchema).max(MAX_LOCATION_CONNECTIONS),
  npcs: z.array(playerNpcSchema).max(1_000),
  actorLocations: z.array(actorLocationSchema).max(1_000),
  factions: z.array(factionSchema).max(1_000),
  relationships: z.array(relationshipSchema).max(10_000),
}).strict().superRefine((projection, context) => {
  const discovered = new Set(projection.discoveries.map((entry) => entry.locationId));
  projection.locations.forEach((location, index) => {
    if (!discovered.has(location.locationId)) context.addIssue({ code: "custom", message: "player locations must be discovered", path: ["locations", index] });
  });
  projection.connections.forEach((connection, index) => {
    if (!discovered.has(connection.fromLocationId) || !discovered.has(connection.toLocationId)) context.addIssue({ code: "custom", message: "player routes must join discovered locations", path: ["connections", index] });
  });
});

/** GM projection is deliberately a different structural shape and owns private world state. */
export const gmWorldProjectionSchema = z.object({
  audience: z.literal("gm"),
  campaignId: campaignIdSchema,
  revision: revisionSchema,
  locations: z.array(locationSchema).max(10_000),
  connections: z.array(locationConnectionSchema).max(10_000),
  discoveries: z.array(locationDiscoverySchema).max(10_000),
  actorLocations: z.array(actorLocationSchema).max(1_000),
  npcPersonaLinks: z.array(npcPersonaLinkSchema).max(1_000),
  privateNpcStates: z.array(privateNpcStateSchema).max(1_000),
  factions: z.array(factionSchema).max(1_000),
  memberships: z.array(factionMembershipSchema).max(10_000),
  factionRelations: z.array(factionRelationSchema).max(10_000),
  relationships: z.array(relationshipSchema).max(10_000),
  reputationLedger: z.array(reputationLedgerEntrySchema).max(100_000),
}).strict();
export const worldProjectionSchema = z.discriminatedUnion("audience", [playerWorldProjectionSchema, gmWorldProjectionSchema]);

export type Location = z.infer<typeof locationSchema>;
export type LocationConnection = z.infer<typeof locationConnectionSchema>;
export type LocationDiscovery = z.infer<typeof locationDiscoverySchema>;
export type ActorLocation = z.infer<typeof actorLocationSchema>;
export type SetActorLocationCommand = z.infer<typeof setActorLocationCommandSchema>;
export type DiscoverLocationCommand = z.infer<typeof discoverLocationCommandSchema>;
export type ChangeReputationCommand = z.infer<typeof changeReputationCommandSchema>;
export type NpcPersonaLink = z.infer<typeof npcPersonaLinkSchema>;
export type PrivateNpcState = z.infer<typeof privateNpcStateSchema>;
export type Relationship = z.infer<typeof relationshipSchema>;
export type Faction = z.infer<typeof factionSchema>;
export type FactionMembership = z.infer<typeof factionMembershipSchema>;
export type FactionRelation = z.infer<typeof factionRelationSchema>;
export type ReputationLedgerEntry = z.infer<typeof reputationLedgerEntrySchema>;
export type TravelCommand = z.infer<typeof travelCommandSchema>;
export type WorldCommand = z.infer<typeof worldCommandSchema>;
export type PlayerWorldProjection = z.infer<typeof playerWorldProjectionSchema>;
export type GmWorldProjection = z.infer<typeof gmWorldProjectionSchema>;
export type WorldProjection = z.infer<typeof worldProjectionSchema>;

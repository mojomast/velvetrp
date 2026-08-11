import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { npcPresenceMutationSchema } from "./npc-presence.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { principalIdSchema } from "./rpg-characters.js";
import { locationIdSchema, MAX_WORLD_NAME_LENGTH, npcIdSchema } from "./world.js";
import { npcPrivateStateHttpSchema, npcPublicStateHttpSchema } from "./world-http.js";

/** Exact body for a path-owned campaign/session/NPC presence mutation. */
export const npcPresenceMutationHttpRequestSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  mutation: npcPresenceMutationSchema,
}).strict();

/** Safe mutation acknowledgement without command, event, idempotency, or other internal IDs. */
export const npcPresenceMutationReceiptHttpSchema = z.object({
  kind: z.enum(["place", "move", "remove"]),
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1, {
  message: "an NPC presence mutation advances the session revision exactly once",
  path: ["revisionAfter"],
});

const presenceRevisionSchema = revisionSchema.min(1);
const locationLabelSchema = z.string().trim().min(1).max(MAX_WORLD_NAME_LENGTH);

/** Player locations deliberately have no slot in which an authoritative ID can leak. */
export const playerNpcLocationHttpSchema = z.object({ label: locationLabelSchema }).strict();
export const gmNpcLocationHttpSchema = z.object({
  locationId: locationIdSchema,
  label: locationLabelSchema,
}).strict();

const presentNpcBase = {
  npcId: npcIdSchema,
  publicState: npcPublicStateHttpSchema,
  revision: presenceRevisionSchema,
  presentAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
};

const requirePresentTimestampOrder = <T extends { presentAt: string; updatedAt: string }>(
  presence: T,
  context: z.RefinementCtx,
) => {
  if (presence.updatedAt < presence.presentAt) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must not precede presentAt" });
  }
};

const requireHistoricalTimestampOrder = <T extends { presentAt: string; updatedAt: string; leftAt: string | null }>(
  presence: T,
  context: z.RefinementCtx,
) => {
  requirePresentTimestampOrder(presence, context);
  if (presence.leftAt !== null && presence.leftAt < presence.updatedAt) {
    context.addIssue({ code: "custom", path: ["leftAt"], message: "leftAt must not precede updatedAt" });
  }
};

const requireUniquePrincipals = (presence: { principals: string[] }, context: z.RefinementCtx) => {
  if (new Set(presence.principals).size !== presence.principals.length) {
    context.addIssue({ code: "custom", path: ["principals"], message: "presence principals must be unique" });
  }
};

const requireUniqueNpcIds = (cast: readonly { npcId: string }[], path: string, context: z.RefinementCtx) => {
  if (new Set(cast.map(({ npcId }) => npcId)).size !== cast.length) {
    context.addIssue({ code: "custom", path: [path], message: "cast NPC IDs must be unique" });
  }
};

/** GM-only member of the currently present cast. */
export const gmPresentNpcHttpSchema = z.object({
  ...presentNpcBase,
  location: gmNpcLocationHttpSchema.nullable(),
  personaId: resourceIdSchema,
  principals: z.array(principalIdSchema).max(1_000),
  privateState: npcPrivateStateHttpSchema,
}).strict().superRefine((presence, context) => {
  requirePresentTimestampOrder(presence, context);
  requireUniquePrincipals(presence, context);
});

/** Player-safe present NPC. A null location is the mandatory unauthorized representation. */
export const playerPresentNpcHttpSchema = z.object({
  ...presentNpcBase,
  location: playerNpcLocationHttpSchema.nullable(),
}).strict().superRefine(requirePresentTimestampOrder);

const historicalNpcBase = {
  npcId: npcIdSchema,
  publicState: npcPublicStateHttpSchema,
  revision: presenceRevisionSchema,
  presentAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
  leftAt: utcIsoTimestampSchema.nullable(),
};

/** GM-only historical cast member captured when a session stops. */
export const gmHistoricalNpcHttpSchema = z.object({
  ...historicalNpcBase,
  lastLocation: gmNpcLocationHttpSchema.nullable(),
  personaId: resourceIdSchema,
  principals: z.array(principalIdSchema).max(1_000),
  privateState: npcPrivateStateHttpSchema,
}).strict().superRefine((presence, context) => {
  requireHistoricalTimestampOrder(presence, context);
  requireUniquePrincipals(presence, context);
});

/** Player-safe historical cast member, structurally distinct from a running presence. */
export const playerHistoricalNpcHttpSchema = z.object({
  ...historicalNpcBase,
  lastLocation: playerNpcLocationHttpSchema.nullable(),
}).strict().superRefine(requireHistoricalTimestampOrder);

/** Running-session GM projection. Left NPCs cannot be represented in presentCast. */
export const gmRunningNpcCastHttpSchema = z.object({
  audience: z.literal("gm"),
  state: z.literal("running"),
  sessionRevision: revisionSchema,
  presentCast: z.array(gmPresentNpcHttpSchema).max(1_000),
}).strict().superRefine((cast, context) => requireUniqueNpcIds(cast.presentCast, "presentCast", context));

/** Running-session player projection. */
export const playerRunningNpcCastHttpSchema = z.object({
  audience: z.literal("player"),
  state: z.literal("running"),
  sessionRevision: revisionSchema,
  presentCast: z.array(playerPresentNpcHttpSchema).max(1_000),
}).strict().superRefine((cast, context) => requireUniqueNpcIds(cast.presentCast, "presentCast", context));

/** At-stop GM projection retained as history rather than current presence. */
export const gmStoppedNpcCastHttpSchema = z.object({
  audience: z.literal("gm"),
  state: z.literal("stopped"),
  sessionRevision: revisionSchema,
  castHistory: z.array(gmHistoricalNpcHttpSchema).max(1_000),
}).strict().superRefine((cast, context) => requireUniqueNpcIds(cast.castHistory, "castHistory", context));

/** At-stop player projection retained as a privacy-safe historical cast. */
export const playerStoppedNpcCastHttpSchema = z.object({
  audience: z.literal("player"),
  state: z.literal("stopped"),
  sessionRevision: revisionSchema,
  castHistory: z.array(playerHistoricalNpcHttpSchema).max(1_000),
}).strict().superRefine((cast, context) => requireUniqueNpcIds(cast.castHistory, "castHistory", context));

/** Closed role and lifecycle projection vocabulary. */
export const npcCastHttpSchema = z.union([
  gmRunningNpcCastHttpSchema,
  playerRunningNpcCastHttpSchema,
  gmStoppedNpcCastHttpSchema,
  playerStoppedNpcCastHttpSchema,
]);

export const npcPresenceMutationHttpResponseSchema = z.object({
  receipt: npcPresenceMutationReceiptHttpSchema,
  cast: z.union([gmRunningNpcCastHttpSchema, playerRunningNpcCastHttpSchema]),
}).strict().refine((response) => response.cast.sessionRevision === response.receipt.revisionAfter, {
  message: "the resultant cast revision must equal receipt.revisionAfter",
  path: ["cast", "sessionRevision"],
});

export type NpcPresenceMutationHttpRequest = z.infer<typeof npcPresenceMutationHttpRequestSchema>;
export type NpcPresenceMutationReceiptHttp = z.infer<typeof npcPresenceMutationReceiptHttpSchema>;
export type GmPresentNpcHttp = z.infer<typeof gmPresentNpcHttpSchema>;
export type PlayerPresentNpcHttp = z.infer<typeof playerPresentNpcHttpSchema>;
export type GmHistoricalNpcHttp = z.infer<typeof gmHistoricalNpcHttpSchema>;
export type PlayerHistoricalNpcHttp = z.infer<typeof playerHistoricalNpcHttpSchema>;
export type NpcCastHttp = z.infer<typeof npcCastHttpSchema>;
export type NpcPresenceMutationHttpResponse = z.infer<typeof npcPresenceMutationHttpResponseSchema>;

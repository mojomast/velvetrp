import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

export const TACTICAL_GRID_FEET = 5 as const;

export const mapPointSchema = z.object({
  x: z.number().int().min(0).max(9_999),
  y: z.number().int().min(0).max(9_999),
}).strict();

export const mapTerrainSchema = z.enum([
  "unknown", "floor", "wall", "door", "water", "rubble", "sand", "grass", "stone",
]);

export const authoritativeMapTileSchema = z.object({
  position: mapPointSchema,
  terrain: mapTerrainSchema.exclude(["unknown"]),
  movementCost: z.number().int().min(1).max(100),
  blocksMovement: z.boolean(),
  blocksSight: z.boolean(),
  difficult: z.boolean(),
}).strict();

export const mapFootprintSchema = z.object({
  width: z.number().int().min(1).max(20),
  height: z.number().int().min(1).max(20),
}).strict();

export const authoritativeMapTokenSchema = z.object({
  tokenId: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(160),
  position: mapPointSchema,
  footprint: mapFootprintSchema,
  disposition: z.enum(["friendly", "neutral", "hostile"]),
  hidden: z.boolean(),
}).strict();

export const mapGenerationProvenanceSchema = z.object({
  algorithm: z.enum(["dungeon-v1", "cave-v1", "arena-v1"]),
  seed: z.string().min(1).max(256),
  parameters: z.object({
    width: z.number().int().min(5).max(500),
    height: z.number().int().min(5).max(500),
  }).strict(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const authoritativeTacticalMapSchema = z.object({
  mapId: z.string().trim().min(1).max(128),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  grid: z.object({ kind: z.literal("square"), feetPerCell: z.literal(TACTICAL_GRID_FEET) }).strict(),
  tiles: z.array(authoritativeMapTileSchema).max(250_000),
  tokens: z.array(authoritativeMapTokenSchema).max(2_000),
  provenance: mapGenerationProvenanceSchema.nullable(),
}).strict().superRefine((map, context) => {
  const cells = new Set<string>();
  map.tiles.forEach((tile, index) => {
    if (tile.position.x >= map.width || tile.position.y >= map.height) {
      context.addIssue({ code: "custom", path: ["tiles", index, "position"], message: "tile is outside map bounds" });
    }
    const key = `${tile.position.x},${tile.position.y}`;
    if (cells.has(key)) context.addIssue({ code: "custom", path: ["tiles", index, "position"], message: "tile positions must be unique" });
    cells.add(key);
  });
  const tokenIds = new Set<string>();
  map.tokens.forEach((token, index) => {
    if (tokenIds.has(token.tokenId)) context.addIssue({ code: "custom", path: ["tokens", index, "tokenId"], message: "token IDs must be unique" });
    tokenIds.add(token.tokenId);
    if (token.position.x + token.footprint.width > map.width || token.position.y + token.footprint.height > map.height) {
      context.addIssue({ code: "custom", path: ["tokens", index, "position"], message: "token footprint is outside map bounds" });
    }
  });
});

/** A projection tile contains no movement or sight rules that could reveal hidden topology. */
export const projectedMapTileSchema = z.object({
  position: mapPointSchema,
  terrain: mapTerrainSchema,
  visibility: z.enum(["explored", "visible"]),
}).strict();

/** Hidden is intentionally absent: hidden tokens must be omitted by the server. */
export const projectedMapTokenSchema = z.object({
  tokenId: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(160),
  position: mapPointSchema,
  footprint: mapFootprintSchema,
  disposition: z.enum(["friendly", "neutral", "hostile"]),
}).strict();

export const tacticalMapProjectionSchema = z.object({
  mapId: z.string().trim().min(1).max(128),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
  grid: z.object({ kind: z.literal("square"), feetPerCell: z.literal(TACTICAL_GRID_FEET) }).strict(),
  tiles: z.array(projectedMapTileSchema).max(250_000),
  tokens: z.array(projectedMapTokenSchema).max(2_000),
  authoritativePath: z.array(mapPointSchema).max(10_000).nullable(),
  reachable: z.array(mapPointSchema).max(250_000),
}).strict().superRefine((map, context) => {
  const tileKeys = new Set<string>();
  map.tiles.forEach((tile, index) => {
    const key = `${tile.position.x},${tile.position.y}`;
    if (tile.position.x >= map.width || tile.position.y >= map.height) context.addIssue({ code: "custom", path: ["tiles", index, "position"], message: "tile is outside map bounds" });
    if (tileKeys.has(key)) context.addIssue({ code: "custom", path: ["tiles", index, "position"], message: "tile positions must be unique" });
    tileKeys.add(key);
  });
  map.tokens.forEach((token, index) => {
    if (token.position.x + token.footprint.width > map.width || token.position.y + token.footprint.height > map.height) {
      context.addIssue({ code: "custom", path: ["tokens", index, "position"], message: "token footprint is outside map bounds" });
    }
  });
});

export const tacticalMapModeSchema = z.enum(["exploration", "combat"]);

export const tacticalMapGenerationTokenSchema = authoritativeMapTokenSchema.extend({
  tokenId: resourceIdSchema,
  actorId: resourceIdSchema.nullable(),
  combatantId: resourceIdSchema.nullable(),
}).strict();

export const tacticalMapGenerateRequestSchema = z.object({
  mode: tacticalMapModeSchema,
  encounterId: resourceIdSchema.nullable(),
  kind: z.enum(["dungeon", "cave", "arena"]),
  seed: z.string().min(1).max(256),
  width: z.number().int().min(5).max(500),
  height: z.number().int().min(5).max(500),
  tokens: z.array(tacticalMapGenerationTokenSchema).max(2_000),
  idempotencyKey: idempotencyKeySchema,
}).strict().superRefine((input, context) => {
  if ((input.mode === "combat") !== (input.encounterId !== null)) {
    context.addIssue({ code: "custom", path: ["encounterId"], message: "combat maps require an encounter and exploration maps forbid one" });
  }
});

export const tacticalMapMovementSchema = z.object({
  policy: z.enum(["exploration-60-feet", "combat-current-turn-speed"]),
  budgetFeet: z.number().int().min(0).max(10_000),
}).strict();

export const tacticalMapSnapshotSchema = z.object({
  campaignId: resourceIdSchema,
  sessionId: z.string().min(1).max(512),
  encounterId: resourceIdSchema.nullable(),
  mode: tacticalMapModeSchema,
  mapRevision: revisionSchema,
  tokenRevision: revisionSchema,
  controlledTokenId: resourceIdSchema.nullable(),
  movement: tacticalMapMovementSchema.nullable(),
  projection: tacticalMapProjectionSchema,
}).strict();

export const tacticalMapGenerateResponseSchema = tacticalMapSnapshotSchema;

export const tacticalMapPreviewRequestSchema = z.object({
  actorId: resourceIdSchema,
  destination: mapPointSchema,
  expectedMapRevision: expectedRevisionSchema,
  expectedTokenRevision: expectedRevisionSchema,
}).strict();

export const tacticalMapPreviewResponseSchema = tacticalMapSnapshotSchema.extend({
  previewId: resourceIdSchema,
  pathCostFeet: z.number().int().min(0).max(1_000_000),
}).strict();

export const tacticalMapMoveRequestSchema = z.object({
  actorId: resourceIdSchema,
  destination: mapPointSchema,
  previewId: resourceIdSchema,
  expectedMapRevision: expectedRevisionSchema,
  expectedTokenRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const tacticalMapMoveReceiptSchema = z.object({
  mapId: resourceIdSchema,
  tokenId: resourceIdSchema,
  previewId: resourceIdSchema,
  idempotencyKey: idempotencyKeySchema,
  mapRevision: revisionSchema,
  tokenRevisionBefore: revisionSchema,
  tokenRevisionAfter: revisionSchema,
  destination: mapPointSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict();

export const tacticalMapMoveResponseSchema = z.object({
  receipt: tacticalMapMoveReceiptSchema,
  snapshot: tacticalMapSnapshotSchema,
}).strict();

export type MapPoint = z.infer<typeof mapPointSchema>;
export type MapTerrain = z.infer<typeof mapTerrainSchema>;
export type MapFootprint = z.infer<typeof mapFootprintSchema>;
export type AuthoritativeMapTile = z.infer<typeof authoritativeMapTileSchema>;
export type AuthoritativeMapToken = z.infer<typeof authoritativeMapTokenSchema>;
export type MapGenerationProvenance = z.infer<typeof mapGenerationProvenanceSchema>;
export type AuthoritativeTacticalMap = z.infer<typeof authoritativeTacticalMapSchema>;
export type ProjectedMapTile = z.infer<typeof projectedMapTileSchema>;
export type ProjectedMapToken = z.infer<typeof projectedMapTokenSchema>;
export type TacticalMapProjection = z.infer<typeof tacticalMapProjectionSchema>;
export type TacticalMapMode = z.infer<typeof tacticalMapModeSchema>;
export type TacticalMapGenerationToken = z.infer<typeof tacticalMapGenerationTokenSchema>;
export type TacticalMapGenerateRequest = z.infer<typeof tacticalMapGenerateRequestSchema>;
export type TacticalMapMovement = z.infer<typeof tacticalMapMovementSchema>;
export type TacticalMapSnapshot = z.infer<typeof tacticalMapSnapshotSchema>;
export type TacticalMapPreviewRequest = z.infer<typeof tacticalMapPreviewRequestSchema>;
export type TacticalMapPreviewResponse = z.infer<typeof tacticalMapPreviewResponseSchema>;
export type TacticalMapMoveRequest = z.infer<typeof tacticalMapMoveRequestSchema>;
export type TacticalMapMoveReceipt = z.infer<typeof tacticalMapMoveReceiptSchema>;
export type TacticalMapMoveResponse = z.infer<typeof tacticalMapMoveResponseSchema>;

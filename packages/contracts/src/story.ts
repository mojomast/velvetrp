import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { campaignIdSchema } from "./rpg-characters.js";

export const storyVisibilitySchema = z.enum(["hidden", "revealed"]);
export const storyNodeStatusSchema = z.enum(["hidden", "revealed", "resolved"]);
export const storyEdgeKindSchema = z.enum(["sequence", "requires"]);
const title = z.string().trim().min(1).max(200);
const text = z.string().max(4_000);

export const storyStorylineSchema = z.object({
  storylineId: resourceIdSchema, campaignId: campaignIdSchema, title,
  summary: text.nullable(), status: z.enum(["active", "completed", "abandoned"]),
  createdAt: utcIsoTimestampSchema, updatedAt: utcIsoTimestampSchema,
}).strict();

export const storyNodeSchema = z.object({
  nodeId: resourceIdSchema, storylineId: resourceIdSchema, title, description: text.nullable(),
  gmNotes: text.nullable(), status: storyNodeStatusSchema, revealThreshold: z.number().int().min(0).max(1_000),
  createdAt: utcIsoTimestampSchema, updatedAt: utcIsoTimestampSchema,
}).strict();

export const storyEdgeSchema = z.object({
  edgeId: resourceIdSchema, storylineId: resourceIdSchema, kind: storyEdgeKindSchema,
  fromNodeId: resourceIdSchema, toNodeId: resourceIdSchema,
}).strict();

export const storyPlotPointSchema = z.object({
  plotPointId: resourceIdSchema, storylineId: resourceIdSchema, nodeId: resourceIdSchema,
  question: text, answer: text, gmNotes: text.nullable(), answered: z.boolean(),
  playerAnswer: text.nullable(), answeredAt: utcIsoTimestampSchema.nullable(),
}).strict();

export const storyClueSourceSchema = z.object({
  sourceId: resourceIdSchema, kind: z.enum(["node", "plot-point"]), targetId: resourceIdSchema,
}).strict();

export const storyClueSchema = z.object({
  clueId: resourceIdSchema, storylineId: resourceIdSchema, title, content: text,
  truth: text, gmNotes: text.nullable(), revealThreshold: z.number().int().min(1).max(1_000),
  revealed: z.boolean(), revealedAt: utcIsoTimestampSchema.nullable(),
  sources: z.array(storyClueSourceSchema).min(1).max(1_000),
}).strict();

/** Player shapes deliberately have no storyline ancestry, GM notes, answer, truth, edges, or sources. */
export const visibleStoryNodeSchema = z.object({
  nodeId: resourceIdSchema, title, description: text.nullable(),
  status: z.enum(["revealed", "resolved"]), updatedAt: utcIsoTimestampSchema,
}).strict();
export const discoveredStoryClueSchema = z.object({
  clueId: resourceIdSchema, title, content: text, discoveredAt: utcIsoTimestampSchema,
}).strict();

export type StoryStoryline = z.infer<typeof storyStorylineSchema>;
export type StoryNode = z.infer<typeof storyNodeSchema>;
export type StoryEdge = z.infer<typeof storyEdgeSchema>;
export type StoryPlotPoint = z.infer<typeof storyPlotPointSchema>;
export type StoryClue = z.infer<typeof storyClueSchema>;
export type VisibleStoryNode = z.infer<typeof visibleStoryNodeSchema>;
export type DiscoveredStoryClue = z.infer<typeof discoveredStoryClueSchema>;

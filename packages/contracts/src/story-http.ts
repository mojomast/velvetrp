import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import {
  discoveredStoryClueSchema, storyClueSchema, storyEdgeKindSchema, storyEdgeSchema,
  storyNodeSchema, storyPlotPointSchema, storyStorylineSchema, visibleStoryNodeSchema,
} from "./story.js";

const title = z.string().trim().min(1).max(200);
const text = z.string().max(4_000);
const newNode = z.object({ nodeId: resourceIdSchema, title, description: text.nullable(),
  gmNotes: text.nullable(), revealThreshold: z.number().int().min(0).max(1_000) }).strict();
const newEdge = z.object({ edgeId: resourceIdSchema, kind: storyEdgeKindSchema,
  fromNodeId: resourceIdSchema, toNodeId: resourceIdSchema }).strict();
const newPlotPoint = z.object({ plotPointId: resourceIdSchema, nodeId: resourceIdSchema,
  question: text, answer: text, gmNotes: text.nullable() }).strict();
const newSource = z.object({ sourceId: resourceIdSchema, kind: z.enum(["node", "plot-point"]), targetId: resourceIdSchema }).strict();
const newClue = z.object({ clueId: resourceIdSchema, title, content: text, truth: text,
  gmNotes: text.nullable(), revealThreshold: z.number().int().min(1).max(1_000), sources: z.array(newSource).min(1).max(1_000) }).strict();

export const newStorylineGraphSchema = z.object({
  storylineId: resourceIdSchema, title, summary: text.nullable(),
  nodes: z.array(newNode).max(1_000), edges: z.array(newEdge).max(10_000),
  plotPoints: z.array(newPlotPoint).max(10_000), clues: z.array(newClue).max(10_000),
}).strict().superRefine((story, context) => {
  const unique = (items: string[], path: string) => {
    if (new Set(items).size !== items.length) context.addIssue({ code: "custom", message: `${path} IDs must be unique`, path: [path] });
  };
  unique(story.nodes.map((item) => item.nodeId), "nodes"); unique(story.edges.map((item) => item.edgeId), "edges");
  unique(story.plotPoints.map((item) => item.plotPointId), "plotPoints"); unique(story.clues.map((item) => item.clueId), "clues");
  const nodeIds = new Set(story.nodes.map((item) => item.nodeId));
  const plotIds = new Set(story.plotPoints.map((item) => item.plotPointId));
  story.edges.forEach((edge, index) => {
    if (edge.fromNodeId === edge.toNodeId) context.addIssue({ code: "custom", message: "story edges cannot be self edges", path: ["edges", index] });
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) context.addIssue({ code: "custom", message: "story edges must reference nodes in this storyline", path: ["edges", index] });
  });
  const edgeKeys = story.edges.map((edge) => `${edge.kind}\u0000${edge.fromNodeId}\u0000${edge.toNodeId}`);
  if (new Set(edgeKeys).size !== edgeKeys.length) context.addIssue({ code: "custom", message: "duplicate semantic story edges are not allowed", path: ["edges"] });
  story.plotPoints.forEach((point, index) => { if (!nodeIds.has(point.nodeId)) context.addIssue({ code: "custom", message: "plot point node must belong to this storyline", path: ["plotPoints", index, "nodeId"] }); });
  story.clues.forEach((clue, index) => {
    unique(clue.sources.map((source) => source.sourceId), `clues.${index}.sources`);
    if (clue.revealThreshold > clue.sources.length) context.addIssue({ code: "custom", message: "clue reveal threshold cannot exceed source count", path: ["clues", index, "revealThreshold"] });
    const targets = clue.sources.map((source) => `${source.kind}\u0000${source.targetId}`);
    if (new Set(targets).size !== targets.length) context.addIssue({ code: "custom", message: "clue source targets must be unique", path: ["clues", index, "sources"] });
    clue.sources.forEach((source, sourceIndex) => {
      const valid = source.kind === "node" ? nodeIds.has(source.targetId) : plotIds.has(source.targetId);
      if (!valid) context.addIssue({ code: "custom", message: "clue source must belong to this storyline", path: ["clues", index, "sources", sourceIndex] });
    });
  });
  const graph = new Map(story.nodes.map((node) => [node.nodeId, [] as string[]]));
  for (const edge of story.edges) if (nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)) graph.get(edge.fromNodeId)!.push(edge.toNodeId);
  const active = new Set<string>(), complete = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (active.has(nodeId)) return true; if (complete.has(nodeId)) return false;
    active.add(nodeId); for (const target of graph.get(nodeId) ?? []) if (visit(target)) return true;
    active.delete(nodeId); complete.add(nodeId); return false;
  };
  if ([...graph.keys()].some(visit)) context.addIssue({ code: "custom", message: "story graph must be acyclic", path: ["edges"] });
});

export const createCampaignStorylineHttpRequestSchema = z.object({
  storyline: newStorylineGraphSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
}).strict();
export const storyCommandReceiptHttpSchema = z.object({ idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema, revisionAfter: revisionSchema, occurredAt: utcIsoTimestampSchema }).strict()
  .refine((value) => value.revisionAfter === value.revisionBefore + 1, "a story command advances exactly one revision");

const envelope = { targetId: resourceIdSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema };
const emptyData = z.object({}).strict();
export const storylineCommandHttpRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reveal-node"), ...envelope, data: emptyData }).strict(),
  z.object({ kind: z.literal("resolve-node"), ...envelope, data: emptyData }).strict(),
  z.object({ kind: z.literal("reveal-clue"), ...envelope, data: emptyData }).strict(),
  z.object({ kind: z.literal("answer-plot-point"), ...envelope, data: z.object({ answer: text.refine((value) => value.trim().length > 0, "answer must not be blank") }).strict() }).strict(),
]);

export const gmCampaignStoryHttpResponseSchema = z.object({ storylines: z.array(storyStorylineSchema), nodes: z.array(storyNodeSchema),
  edges: z.array(storyEdgeSchema), plotPoints: z.array(storyPlotPointSchema), clues: z.array(storyClueSchema) }).strict();
export const playerCampaignStoryHttpResponseSchema = z.object({ visibleNodes: z.array(visibleStoryNodeSchema), discoveredClues: z.array(discoveredStoryClueSchema) }).strict();
export const campaignStoryHttpResponseSchema = z.union([gmCampaignStoryHttpResponseSchema, playerCampaignStoryHttpResponseSchema]);
export const createCampaignStorylineHttpResponseSchema = z.object({ storyline: storyStorylineSchema, story: gmCampaignStoryHttpResponseSchema, receipt: storyCommandReceiptHttpSchema }).strict();
export const storylineCommandHttpResponseSchema = z.object({ story: campaignStoryHttpResponseSchema, receipt: storyCommandReceiptHttpSchema }).strict();

export type NewStorylineGraph = z.infer<typeof newStorylineGraphSchema>;
export type CreateCampaignStorylineHttpRequest = z.infer<typeof createCampaignStorylineHttpRequestSchema>;
export type StorylineCommandHttpRequest = z.infer<typeof storylineCommandHttpRequestSchema>;
export type StoryCommandReceiptHttp = z.infer<typeof storyCommandReceiptHttpSchema>;
export type CampaignStoryHttpResponse = z.infer<typeof campaignStoryHttpResponseSchema>;

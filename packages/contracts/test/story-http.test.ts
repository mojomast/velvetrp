import { describe, expect, it } from "vitest";
import { createCampaignStorylineHttpRequestSchema, storylineCommandHttpRequestSchema } from "../src/index.js";

const storyline = { storylineId: "story", title: "The Gate", summary: null,
  nodes: [{ nodeId: "door", title: "Door", description: null, gmNotes: "Secret", revealThreshold: 0 }], edges: [],
  plotPoints: [{ plotPointId: "question", nodeId: "door", question: "Why?", answer: "Because", gmNotes: null }],
  clues: [{ clueId: "key", title: "Key", content: "A key", truth: "It is cursed", gmNotes: null, revealThreshold: 1,
    sources: [{ sourceId: "door-source", kind: "node" as const, targetId: "door" }] }] };
const envelope = { expectedRevision: 0, idempotencyKey: "story-key" };

describe("M2.10 story contracts", () => {
  it("accepts an exact coherent graph and rejects cross-graph and self references", () => {
    expect(createCampaignStorylineHttpRequestSchema.parse({ storyline, ...envelope })).toEqual({ storyline, ...envelope });
    expect(createCampaignStorylineHttpRequestSchema.safeParse({ storyline, ...envelope, extra: true }).success).toBe(false);
    expect(createCampaignStorylineHttpRequestSchema.safeParse({ storyline: { ...storyline,
      edges: [{ edgeId: "bad", kind: "requires", fromNodeId: "door", toNodeId: "door" }] }, ...envelope }).success).toBe(false);
    expect(createCampaignStorylineHttpRequestSchema.safeParse({ storyline: { ...storyline,
      clues: [{ ...storyline.clues[0], sources: [{ sourceId: "bad", kind: "node", targetId: "foreign" }] }] }, ...envelope }).success).toBe(false);
    const twoNodes = [...storyline.nodes, { ...storyline.nodes[0], nodeId: "hall", title: "Hall" }];
    expect(createCampaignStorylineHttpRequestSchema.safeParse({ storyline: { ...storyline, nodes: twoNodes, edges: [
      { edgeId: "one", kind: "sequence", fromNodeId: "door", toNodeId: "hall" },
      { edgeId: "two", kind: "sequence", fromNodeId: "hall", toNodeId: "door" },
    ] }, ...envelope }).success).toBe(false);
    expect(createCampaignStorylineHttpRequestSchema.safeParse({ storyline: { ...storyline, nodes: twoNodes, edges: [
      { edgeId: "one", kind: "sequence", fromNodeId: "door", toNodeId: "hall" },
      { edgeId: "two", kind: "requires", fromNodeId: "hall", toNodeId: "door" },
    ] }, ...envelope }).success).toBe(false);
    expect(createCampaignStorylineHttpRequestSchema.safeParse({ storyline: { ...storyline, nodes: twoNodes, edges: [
      { edgeId: "one", kind: "sequence", fromNodeId: "door", toNodeId: "hall" },
      { edgeId: "two", kind: "sequence", fromNodeId: "door", toNodeId: "hall" },
    ] }, ...envelope }).success).toBe(false);
    expect(createCampaignStorylineHttpRequestSchema.safeParse({ storyline: { ...storyline, clues: [{ ...storyline.clues[0],
      sources: [{ sourceId: "one", kind: "node", targetId: "door" }, { sourceId: "two", kind: "node", targetId: "door" }] }] }, ...envelope }).success).toBe(false);
  });
  it("uses strict kind-specific command data", () => {
    expect(storylineCommandHttpRequestSchema.safeParse({ kind: "reveal-node", targetId: "door", data: {}, ...envelope }).success).toBe(true);
    expect(storylineCommandHttpRequestSchema.safeParse({ kind: "reveal-node", targetId: "door", data: { answer: "x" }, ...envelope }).success).toBe(false);
    expect(storylineCommandHttpRequestSchema.safeParse({ kind: "answer-plot-point", targetId: "question", data: {}, ...envelope }).success).toBe(false);
    expect(storylineCommandHttpRequestSchema.safeParse({ kind: "answer-plot-point", targetId: "question", data: { answer: "Guess" }, ...envelope }).success).toBe(true);
  });
});

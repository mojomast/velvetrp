/** Closed, server-authorized read tools for Director planning. No free-form query text crosses this boundary. */
export const DM_RECALL_TOPICS = ["current-scene", "recent-outcomes", "public-locations", "present-cast"] as const;
export type DmReadToolTopic = (typeof DM_RECALL_TOPICS)[number];
export type DmReadToolRequest =
  | { tool: "read_campaign_recall"; topic: DmReadToolTopic }
  | { tool: "read_quest_summary" }
  | { tool: "read_public_world" }
  | { tool: "read_present_npcs" };

const EMPTY_SCHEMA = { type: "object", additionalProperties: false, required: [], properties: {} } as const;

export function dmReadToolSchemas(): Array<{ name: string; description: string; parameters: object }> {
  return [
    { name: "read_campaign_recall", description: "Read the bounded committed history for one closed topic. No free-form query.",
      parameters: { type: "object", additionalProperties: false, required: ["topic"],
        properties: { topic: { type: "string", enum: [...DM_RECALL_TOPICS] } } } },
    { name: "read_quest_summary", description: "Read only public quest titles, objectives and progress for this campaign.", parameters: { ...EMPTY_SCHEMA } },
    { name: "read_public_world", description: "Read only public campaign locations and their public connections.", parameters: { ...EMPTY_SCHEMA } },
    { name: "read_present_npcs", description: "Read the public names and descriptions of present, non-hidden NPCs.", parameters: { ...EMPTY_SCHEMA } },
  ];
}

function plainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("read tool arguments must be an object");
  return value as Record<string, unknown>;
}

function noArguments(value: unknown): void {
  if (Object.keys(plainObject(value)).length) throw new Error("read tool takes no arguments");
}

export function parseDmReadCall(name: string, args: unknown): DmReadToolRequest {
  if (name === "read_campaign_recall") {
    const record = plainObject(args);
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== "topic") throw new Error("read_campaign_recall requires only a topic");
    const topic = record.topic;
    if (typeof topic !== "string" || !(DM_RECALL_TOPICS as readonly string[]).includes(topic)) throw new Error("unknown read topic");
    return { tool: "read_campaign_recall", topic: topic as DmReadToolTopic };
  }
  if (name === "read_quest_summary" || name === "read_public_world" || name === "read_present_npcs") {
    noArguments(args);
    return { tool: name };
  }
  throw new Error("unknown read tool");
}

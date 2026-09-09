import { afterEach, describe, expect, it, vi } from "vitest";
import { commandCampaignDmBeat, commandCampaignDmDecision, commandCampaignDmMode, getCampaignDmControl, getCampaignDmHistory, getCampaignDmProposal, getCampaignDmRun, resumeCampaignDmRun } from "./api";
import { commandCampaignDmSceneBinding } from "./api";

const run = { runId: "run", campaignId: "campaign", sessionId: "room", intent: "open", mode: "ai", modeRevision: 2, revision: 0, state: "completed", narration: "The harbor wakes.", receipts: [], blockers: [], createdAt: "2030-01-01T00:00:00.000Z" };
const control = { campaignId: "campaign", mode: "ai", revision: 2 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
describe("Campaign DM API", () => {
  it("requires an exact scene binding echo and sends only the accepted contract", async () => {
    const binding = { nodeId: "scene", evidence: { kind: "quest-objective" as const, targetId: "objective" }, expectedStoryRevision: 42, idempotencyKey: "binding-key" };
    const fetch = vi.fn().mockResolvedValueOnce(response(binding)).mockResolvedValueOnce(response({ ...binding, expectedStoryRevision: 43 })); vi.stubGlobal("fetch", fetch);
    await expect(commandCampaignDmSceneBinding("campaign", binding)).resolves.toEqual(binding);
    expect(fetch).toHaveBeenCalledWith("/api/rpg/v1/campaigns/campaign/dm/scene-binding-commands", expect.objectContaining({ method: "POST", body: JSON.stringify(binding) }));
    await expect(commandCampaignDmSceneBinding("campaign", binding)).rejects.toThrow(/exact request/);
    await expect(commandCampaignDmSceneBinding("campaign", { ...binding, evidence: { ...binding.evidence, success: true } } as never)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("uses exact public and private GET paths without triggering writes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(control)).mockResolvedValueOnce(response({ control, runs: [run] })).mockResolvedValueOnce(response(run)).mockResolvedValueOnce(response({ run, proposal: null })); vi.stubGlobal("fetch", fetch);
    await getCampaignDmControl("campaign"); await getCampaignDmHistory("campaign", "room"); await getCampaignDmRun("campaign", "room", "run"); await getCampaignDmProposal("campaign", "room", "run");
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/rpg/v1/campaigns/campaign/dm", "/api/rpg/v1/campaigns/campaign/rooms/room/dm", "/api/rpg/v1/campaigns/campaign/rooms/room/dm/runs/run", "/api/rpg/v1/campaigns/campaign/rooms/room/dm/runs/run/proposal"]);
    expect(fetch.mock.calls.every(call => call[1].cache === "no-store" && !call[1].body)).toBe(true);
  });
  it("sends exact closed command bodies with JSON media type", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(control)).mockImplementation(async () => response({ ...run, revision: 1 })); vi.stubGlobal("fetch", fetch);
    const mode = { mode: "ai" as const, expectedRevision: 1, idempotencyKey: "mode-key" };
    const beat = { intent: "open" as const, expectedModeRevision: 2, idempotencyKey: "beat-key" };
    const decision = { decision: "approved" as const, expectedRevision: 0, idempotencyKey: "decision-key" };
    await commandCampaignDmMode("campaign", mode); await commandCampaignDmBeat("campaign", "room", beat);
    await commandCampaignDmDecision("campaign", "room", "run", decision); await resumeCampaignDmRun("campaign", "room", "run");
    expect(fetch.mock.calls.map(call => JSON.parse(call[1].body))).toEqual([mode, beat, decision, {}]);
    expect(fetch.mock.calls.every(call => call[1].method === "POST" && call[1].headers.get("content-type") === "application/json")).toBe(true);
    expect(fetch.mock.calls.map(call => call[0].split("/").at(-1))).toEqual(["mode-commands", "beat-commands", "decision-commands", "resume-commands"]);
  });
  it("rejects unbound and private public responses and non-200 success", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...run, sessionId: "other" })).mockResolvedValueOnce(response({ control, runs: [{ ...run, proposal: {} }] })).mockResolvedValueOnce(response(run, 202)); vi.stubGlobal("fetch", fetch);
    await expect(getCampaignDmRun("campaign", "room", "run")).rejects.toThrow(/match/);
    await expect(getCampaignDmHistory("campaign", "room")).rejects.toThrow();
    await expect(commandCampaignDmBeat("campaign", "room", { intent: "open", expectedModeRevision: 2, idempotencyKey: "key" })).rejects.toThrow(/status/);
  });
  it("rejects invented mechanics before fetch and does not retry a network failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("lost response")); vi.stubGlobal("fetch", fetch);
    await expect(commandCampaignDmBeat("campaign", "room", { intent: "open", expectedModeRevision: 2, idempotencyKey: "key", declaration: "fake" } as never)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(commandCampaignDmBeat("campaign", "room", { intent: "open", expectedModeRevision: 2, idempotencyKey: "key" })).rejects.toThrow("lost response");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

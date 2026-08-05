import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_PACK, ORIGINAL_STARTER_RACE, ORIGINAL_STARTER_RULES_PROFILE } from "@velvet/contracts";

const aria = { id: "char-1", name: "Aria", age: 29, archetype: "Confidant", boundaries: "fictional adults only", fictionalConfirmed: true, isRealPerson: false, createdAt: "2026-01-01T00:00:00.000Z" };
const rowan = { ...aria, id: "char-2", name: "Rowan", archetype: "Mysterious stranger" };
const baseSession = { id: "sess-1", characterId: aria.id, primaryCharacterId: aria.id, participants: [aria, rowan], title: "Night watch", state: "active" as "setup" | "active" | "paused" | "cooldown" | "closed", presetId: "default", consentLog: [], activeLeafId: null, createdAt: "2026-01-01T00:00:00.000Z", stoppedAt: null as string | null, stopReason: null as string | null };
const harness = { id: "harness", systemPrompt: "", personaPreamble: "", styleGuide: "", postHistoryInstructions: "", recentTurns: 12, memoryChars: 1200, summaryChars: 800, loreChars: 800, temperature: null, promptOverrides: {}, updatedAt: "" };
const provider = { id: "provider", providerType: "openai-compatible", baseUrl: "", model: "test-model", hasApiKey: false, streaming: false, httpReferer: "", appTitle: "Velvet", requireParameters: false, allowFallbacks: true, routingSort: "default", dataCollection: "default", zdr: false, requestTimeoutSeconds: 90, samplers: { maxTokens: null, topP: null, topK: null, minP: null, repetitionPenalty: null, frequencyPenalty: null, presencePenalty: null, seed: null, reasoningEffort: null, stopStrings: [], startReplyWith: "" }, updatedAt: "" };
const campaignAccess = { id: "campaign-one", name: "The Long Road", activeTimelineId: "timeline-secret", ownerPrincipalId: "principal-secret", actorRole: "owner", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-02T00:00:00.000Z" };
const campaignDetail = { campaign: { id: campaignAccess.id, name: campaignAccess.name, actorRole: "owner", createdAt: campaignAccess.createdAt, updatedAt: campaignAccess.updatedAt, content: { status: "unconfigured" } } };
const configuredCampaignDetail = { campaign: { ...campaignDetail.campaign, content: { status: "configured", rulesProfileId: ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId, contentPacks: [{ packId: ORIGINAL_STARTER_PACK.packId, packVersion: ORIGINAL_STARTER_PACK.packVersion }] } } };
const appCreationOptions = { campaignId: campaignAccess.id, personas: [{ characterId: "app-persona-secret", name: "App Persona", alreadyUsed: false }], starter: { rulesProfile: ORIGINAL_STARTER_RULES_PROFILE, pack: ORIGINAL_STARTER_PACK, race: ORIGINAL_STARTER_RACE, background: ORIGINAL_STARTER_BACKGROUND, class: { ...ORIGINAL_STARTER_CLASS, level: 1 } } };

function message(id: string, role: "user" | "character", content: string, speakerCharacterId: string | null = null) { return { id, sessionId: baseSession.id, role, speakerCharacterId, content, parentId: null, swipeGroupId: null, swipeIndex: 0, seq: 0, status: "final", createdAt: "2026-01-01T00:00:00.000Z" }; }
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } }); }
function sse(events: Array<{ event: string; data: unknown }>) { return new Response(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } }); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
interface Route { method: string; match: RegExp; handler: (body: unknown) => Response | Promise<Response>; }
let routes: Route[] = [];
function installFetch(characters = [aria, rowan], sessions = [baseSession], campaign = false, mechanics = false) {
  routes = [
    { method: "GET", match: /\/api\/characters$/, handler: () => json({ characters }) },
    { method: "GET", match: /\/api\/sessions$/, handler: () => json({ sessions }) },
    { method: "GET", match: /\/api\/features$/, handler: () => json({ voice: false, images: false }) },
    { method: "GET", match: /\/api\/rpg\/v1\/features$/, handler: () => json({ campaign, mechanics, combat: false, studio: false, remoteAuthentication: false }) },
    { method: "GET", match: /\/api\/provider$/, handler: () => json(provider) },
    { method: "GET", match: /\/api\/harness$/, handler: () => json(harness) },
  ];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase(); const url = String(input); const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    const route = routes.find((entry) => entry.method === method && entry.match.test(url));
    if (!route) throw new Error(`no mock for ${method} ${url}`);
    return route.handler(body);
  }));
}
async function openLibrary() { render(<App />); await screen.findByRole("heading", { name: "Characters" }); }

describe("persistence and multi-character frontend", () => {
  beforeEach(() => { localStorage.clear(); Element.prototype.scrollTo = vi.fn(); HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; }); HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; }); vi.stubGlobal("confirm", vi.fn(() => true)); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("lists durable characters and creates a group session with a primary", async () => {
    installFetch(); let payload: Record<string, unknown> | null = null;
    routes.push(
      { method: "POST", match: /\/api\/sessions$/, handler: (body) => { payload = body as Record<string, unknown>; return json(baseSession, 201); } },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
    );
    await openLibrary();
    expect(screen.getByText("Aria")).toBeTruthy(); expect(screen.getByText("Rowan")).toBeTruthy();
    const checks = screen.getAllByRole("checkbox"); fireEvent.click(checks[0]!); fireEvent.click(checks[1]!);
    const radios = screen.getAllByRole("radio"); fireEvent.click(radios[1]!);
    fireEvent.change(screen.getByLabelText("Session title"), { target: { value: "Shared mystery" } });
    fireEvent.click(screen.getByRole("button", { name: "Start new session" }));
    await screen.findByPlaceholderText("Write a message…");
    expect(payload).toMatchObject({ characterIds: [aria.id, rowan.id], primaryCharacterId: rowan.id, title: "Shared mystery" });
    expect(screen.getByRole("button", { name: "Continue as Aria" })).toBeTruthy();
  });

  it("opens a blank New character form after leaving an edit flow", async () => {
    installFetch();
    await openLibrary();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    await screen.findByRole("heading", { name: "Edit Aria" });
    expect((screen.getByLabelText("Character name") as HTMLInputElement).value).toBe("Aria");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("heading", { name: "Characters" });

    fireEvent.click(screen.getByRole("button", { name: "New character" }));
    await screen.findByRole("heading", { name: "Create a character" });
    expect((screen.getByLabelText("Character name") as HTMLInputElement).value).toBe("");
  });

  it("restores a saved session and renders each message's actual speaker", async () => {
    installFetch(); localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    let savedSource = "They are waiting in the observatory.";
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [message("m1", "character", "Aria speaks", aria.id), message("m2", "character", "Rowan answers", rowan.id)] }) },
      { method: "GET", match: /\/api\/sessions\/sess-1\/context$/, handler: () => json({ context: { sessionId: baseSession.id, state: "active", sourceOfTruth: `MANUAL CANON (highest priority):\n${savedSource}\n\nSYNTHESIZED CURRENT SCENE FACTS:\nLocation & time:\n- Observatory at night`, editableSource: savedSource, sourceUpdatedAt: "2026-01-01T00:00:00.000Z", synthesizedSource: "Location & time:\n- Observatory at night", synthesizedUpdatedAt: "2026-01-01T00:01:00.000Z", participants: [{ id: aria.id, name: aria.name, archetype: aria.archetype }, { id: rowan.id, name: rowan.name, archetype: rowan.archetype }], recentEvents: ["Aria: Aria speaks", "Rowan: Rowan answers"], rememberedFacts: ["Aria: likes stars"], activeLore: ["The harbor closes at midnight"], openThreads: [] } }) },
      { method: "GET", match: /\/api\/usage$/, handler: () => json({ usage: { calls: 4, promptTokens: 1200, completionTokens: 300, totalTokens: 1500, providerMeasuredTokens: 1200, estimatedTokens: 300, estimatedCostUsd: 0.00054, pricing: { promptPerMillion: .2, completionPerMillion: 1 }, byKind: [{ kind: "character_reply", calls: 4, promptTokens: 1200, completionTokens: 300, totalTokens: 1500, estimatedCostUsd: .00054 }], byModel: [{ model: "test-model", calls: 4, promptTokens: 1200, completionTokens: 300, totalTokens: 1500, estimatedCostUsd: .00054 }], bySession: [{ sessionId: baseSession.id, title: baseSession.title, calls: 4, promptTokens: 1200, completionTokens: 300, totalTokens: 1500, estimatedCostUsd: .00054 }] } }) },
      { method: "PUT", match: /\/api\/sessions\/sess-1\/context$/, handler: (body) => { savedSource = (body as { sourceOfTruth: string }).sourceOfTruth; return json({ source: { sourceOfTruth: savedSource, updatedAt: "2026-01-02T00:00:00.000Z" } }); } },
    );
    render(<App />);
    await screen.findByText("Aria speaks"); await screen.findByText("Rowan answers");
    await screen.findByText("Shared context basket");
    await screen.findByText("Overall usage & estimated cost");
    expect(screen.getByText("1,200")).toBeTruthy();
    expect(screen.getByText("Aria: likes stars")).toBeTruthy();
    expect(screen.getAllByText("They are waiting in the observatory.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Edit manual canon" }));
    const sceneInput = screen.getByLabelText("Manual scene canon");
    fireEvent.change(sceneInput, { target: { value: "They have moved to the moonlit roof." } });
    fireEvent.click(screen.getByRole("button", { name: "Save manual canon" }));
    await screen.findByText("They have moved to the moonlit roof.");
    const labels = screen.getAllByText(/^(Aria|Rowan)$/).map((node) => node.textContent);
    expect(labels).toContain("Aria"); expect(labels).toContain("Rowan");
  });

  it("clears stale restored IDs and returns to the library", async () => {
    installFetch([aria], []); localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: "gone", selectedIds: ["gone"] }));
    await openLibrary();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").view).toBe("home"));
  });

  it("handles malformed persisted navigation at runtime", async () => {
    installFetch([aria], []);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "invalid", selectedIds: { bad: true }, primaryId: 12 }));
    await openLibrary();
    expect(screen.getByRole("heading", { name: "Characters" })).toBeTruthy();
  });

  it("opens the legacy library while optional RPG feature discovery remains pending", async () => {
    installFetch([aria], []);
    routes = routes.map((route) => route.match.test("/api/rpg/v1/features")
      ? { ...route, handler: () => new Promise<Response>(() => undefined) }
      : route);
    render(<App />);
    await screen.findByRole("heading", { name: "Characters" });
    expect(screen.getByText("Aria")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Campaigns" })).toBeNull();
  });

  it("restores legacy chat while optional RPG feature discovery remains pending", async () => {
    installFetch([aria], [baseSession]);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    routes = routes.map((route) => route.match.test("/api/rpg/v1/features")
      ? { ...route, handler: () => new Promise<Response>(() => undefined) }
      : route);
    routes.push({ method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [message("m-pending", "character", "Legacy chat ready", aria.id)] }) });
    render(<App />);
    await screen.findByText("Legacy chat ready");
  });

  it("does not let delayed unavailable campaign discovery evict a newer ordinary chat", async () => {
    const discovery = deferred<Response>();
    installFetch([aria, rowan], [baseSession], true);
    routes = routes.map((route) => route.match.test("/api/rpg/v1/features")
      ? { ...route, handler: () => discovery.promise }
      : route);
    routes.push({ method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [message("ordinary-newer", "character", "Newer ordinary chat", aria.id)] }) });
    await openLibrary();
    fireEvent.click(screen.getByText(baseSession.title).closest("button")!);
    await screen.findByText("Newer ordinary chat");
    discovery.resolve(json({ campaign: false, mechanics: false, combat: false, studio: false, remoteAuthentication: false }));
    await discovery.promise;
    await Promise.resolve();
    expect(screen.getByText("Newer ordinary chat")).toBeTruthy();
  });

  it("does not let delayed unavailable campaign discovery evict a newer private chat", async () => {
    const discovery = deferred<Response>();
    const privateSession = { ...baseSession, id: "private-newer", participants: [aria], title: "" };
    installFetch([aria, rowan], [baseSession], true);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    routes = routes.map((route) => route.match.test("/api/rpg/v1/features")
      ? { ...route, handler: () => discovery.promise }
      : route);
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "POST", match: /\/api\/sessions\/solo$/, handler: () => json({ session: privateSession, messages: [{ ...message("private-newer-message", "character", "Newer private chat", aria.id), sessionId: privateSession.id }], created: false }) },
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Private chat with Aria" }));
    await screen.findByText("Newer private chat");
    discovery.resolve(json({ campaign: false, mechanics: false, combat: false, studio: false, remoteAuthentication: false }));
    await discovery.promise;
    await Promise.resolve();
    expect(screen.getByText("Newer private chat")).toBeTruthy();
  });

  it("feature-gates campaign navigation and renders the empty read-only page", async () => {
    installFetch([aria], [], true);
    routes.push({ method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [] }) });
    await openLibrary();
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/rpg/v1/features"))).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Campaigns" }));
    await screen.findByRole("heading", { name: "Campaigns" });
    expect(screen.getByText("No campaigns yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create campaign" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Character library" }));
    await screen.findByRole("heading", { name: "Characters" });
  });

  it("retains mechanics discovery separately and passes it only to authorized campaign detail", async () => {
    installFetch([aria], [], true, true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/dice-rolls$/, handler: () => json({ characters: [], rolls: [] }) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    expect(await screen.findByRole("heading", { name: "Dice" })).toBeTruthy();
    expect(screen.getByText("No rolls yet.")).toBeTruthy();
  });

  it("falls home when persisted campaign navigation is unavailable", async () => {
    installFetch([aria], [], false);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaigns" }));
    await openLibrary();
    expect(screen.queryByRole("button", { name: "Campaigns" })).toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").view).toBe("home"));
  });

  it("opens campaign detail, persists it, and returns to campaigns", async () => {
    installFetch([aria], [], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    await screen.findByRole("heading", { name: campaignAccess.name });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({ view: "campaign-detail", campaignId: campaignAccess.id }));
    expect(document.body.textContent).not.toContain(campaignAccess.ownerPrincipalId);
    expect(document.body.textContent).not.toContain(campaignAccess.activeTimelineId);
    fireEvent.click(screen.getByRole("button", { name: "← Campaigns" }));
    await screen.findByRole("heading", { name: "Campaigns" });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").campaignId).toBeUndefined());
  });

  it("integrates the names-only campaign roster without exposing either opaque identity", async () => {
    const roster = [
      { id: "campaign-character-private-one", characterId: "persona-private-one", name: "Echo" },
      { id: "campaign-character-private-two", characterId: "persona-private-two", name: "Echo" },
    ];
    installFetch([aria], [], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters$/, handler: () => json({ characters: roster }) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    const list = await screen.findByRole("list", { name: "Campaign characters" });
    expect(screen.getAllByText("Echo")).toHaveLength(2);
    expect(list.querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Open character Echo, character 1 of 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open character Echo, character 2 of 2" })).toBeTruthy();
    for (const entry of roster) {
      expect(document.body.outerHTML).not.toContain(entry.id);
      expect(document.body.outerHTML).not.toContain(entry.characterId);
    }
  });

  it("opens an attached campaign room and returns with a fresh authoritative room read", async () => {
    const attached = { sessionId: baseSession.id, title: "Night watch", participantNames: [aria.name, rowan.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false };
    let roomReads = 0;
    installFetch([aria, rowan], [baseSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => { roomReads += 1; return json({ attached: [attached], eligible: [] }); } },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [message("campaign-message", "character", "Campaign room history", aria.id)] }) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open attached room 1 of 1" }));
    await screen.findByText("Campaign room history");
    expect(screen.getByRole("button", { name: "← Back to campaign" })).toBeTruthy();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({ view: "chat", sessionId: baseSession.id, chatReturnCampaignId: campaignAccess.id }));
    fireEvent.click(screen.getByRole("button", { name: "← Back to campaign" }));
    const roomsHeading = await screen.findByRole("heading", { name: "Rooms" });
    await waitFor(() => expect(roomReads).toBe(2));
    await waitFor(() => expect(document.activeElement).toBe(roomsHeading));
    expect(document.body.outerHTML).not.toContain(baseSession.id);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").chatReturnCampaignId).toBeUndefined());
  });

  it("opens an attached opaque room and keeps read and send calls on its exact encoded segment", async () => {
    const opaqueId = " room/%?#雪 ";
    const encodedId = encodeURIComponent(opaqueId);
    const opaqueSession = { ...baseSession, id: opaqueId, title: "Opaque room" };
    const attached = { sessionId: opaqueId, title: opaqueSession.title, participantNames: [aria.name, rowan.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false };
    const context = { sessionId: opaqueId, state: "active", sourceOfTruth: "Exact room context", editableSource: "Exact room context", sourceUpdatedAt: null, synthesizedSource: "", synthesizedUpdatedAt: null, participants: [], recentEvents: [], rememberedFacts: [], activeLore: [], openThreads: [] };
    installFetch([aria, rowan], [opaqueSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => json({ attached: [attached], eligible: [] }) },
      { method: "GET", match: new RegExp(`/api/sessions/${encodedId}$`), handler: () => json({ session: opaqueSession, messages: [] }) },
      { method: "GET", match: new RegExp(`/api/sessions/${encodedId}/context$`), handler: () => json({ context }) },
      { method: "POST", match: new RegExp(`/api/sessions/${encodedId}/messages$`), handler: () => json({ reply: { ...message("opaque-reply", "character", "Encoded send arrived", aria.id), sessionId: opaqueId } }) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open attached room 1 of 1" }));
    await screen.findAllByText("Exact room context");
    fireEvent.change(screen.getByPlaceholderText("Write a message…"), { target: { value: "hello opaque room" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Aria" }));
    await screen.findByText("Encoded send arrived");

    const calls = vi.mocked(fetch).mock.calls.map(([input, init]) => `${(init?.method ?? "GET").toUpperCase()} ${String(input)}`);
    expect(calls).toContain(`GET /api/sessions/${encodedId}`);
    expect(calls).toContain(`GET /api/sessions/${encodedId}/context`);
    expect(calls).toContain(`POST /api/sessions/${encodedId}/messages`);
    expect(calls.some((call) => call.includes(opaqueId))).toBe(false);
  });

  it("cancels a pending room hydration on Back and ignores its late success", async () => {
    const attached = { sessionId: baseSession.id, title: "Delayed room", participantNames: [aria.name, rowan.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false };
    const hydration = deferred<Response>();
    installFetch([aria, rowan], [baseSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => json({ attached: [attached], eligible: [] }) },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => hydration.promise },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open attached room 1 of 1" }));
    expect((screen.getByRole("button", { name: "Open attached room 1 of 1" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "← Campaigns" }));
    await screen.findByRole("heading", { name: "Campaigns" });
    hydration.resolve(json({ session: baseSession, messages: [message("late-room", "character", "Must not open", aria.id)] }));
    await hydration.promise;
    await Promise.resolve();
    expect(screen.queryByText("Must not open")).toBeNull();
    expect(screen.getByRole("heading", { name: "Campaigns" })).toBeTruthy();
  });

  it("retains an unacknowledged return refresh across Campaigns, then consumes it once on reopen", async () => {
    const attached = { sessionId: baseSession.id, title: "Return room", participantNames: [aria.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false };
    const interruptedRefresh = deferred<Response>();
    let roomReads = 0;
    installFetch([aria], [baseSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => { roomReads += 1; return roomReads === 2 ? interruptedRefresh.promise : json({ attached: [attached], eligible: [] }); } },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open attached room 1 of 1" }));
    await screen.findByRole("heading", { name: baseSession.title });
    fireEvent.click(screen.getByRole("button", { name: "← Back to campaign" }));
    await waitFor(() => expect(roomReads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "← Campaigns" }));
    await screen.findByRole("heading", { name: "Campaigns" });
    interruptedRefresh.resolve(json({ attached: [attached], eligible: [] }));
    fireEvent.click(screen.getByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    const consumedFocus = await screen.findByRole("heading", { name: "Rooms" });
    await waitFor(() => expect(document.activeElement).toBe(consumedFocus));
    expect(roomReads).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "← Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    const ordinaryReopenRooms = await screen.findByRole("heading", { name: "Rooms" });
    await waitFor(() => expect(roomReads).toBe(3));
    expect(document.activeElement).not.toBe(ordinaryReopenRooms);
  });

  it("retains an unacknowledged missing-room refresh across Campaigns and consumes it on reopen", async () => {
    const attached = { sessionId: baseSession.id, title: "Missing room", participantNames: [aria.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false };
    const interruptedRefresh = deferred<Response>();
    let roomReads = 0;
    installFetch([aria], [baseSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => { roomReads += 1; return roomReads === 2 ? interruptedRefresh.promise : json({ attached: [attached], eligible: [] }); } },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ error: "missing" }, 404) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open attached room 1 of 1" }));
    await screen.findByText("That room is no longer available. Latest campaign rooms are being refreshed.");
    await waitFor(() => expect(roomReads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "← Campaigns" }));
    await screen.findByRole("heading", { name: "Campaigns" });
    interruptedRefresh.resolve(json({ attached: [attached], eligible: [] }));
    fireEvent.click(screen.getByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    const roomsHeading = await screen.findByRole("heading", { name: "Rooms" });
    await waitFor(() => expect(document.activeElement).toBe(roomsHeading));
    expect(roomReads).toBe(3);
  });

  it("lets the latest same-render room open win and ignores older out-of-order success", async () => {
    const secondSession = { ...baseSession, id: "sess-2", title: "Second room" };
    const firstHydration = deferred<Response>();
    const secondHydration = deferred<Response>();
    const attached = [
      { sessionId: baseSession.id, title: "Duplicate", participantNames: [aria.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false },
      { sessionId: secondSession.id, title: "Duplicate", participantNames: [rowan.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-04T00:00:00.000Z", stopped: false },
    ];
    installFetch([aria, rowan], [baseSession, secondSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => json({ attached, eligible: [] }) },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => firstHydration.promise },
      { method: "GET", match: /\/api\/sessions\/sess-2$/, handler: () => secondHydration.promise },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    const first = await screen.findByRole("button", { name: "Open attached room 1 of 2" });
    const second = screen.getByRole("button", { name: "Open attached room 2 of 2" });
    act(() => {
      first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      second.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    secondHydration.resolve(json({ session: secondSession, messages: [message("second-wins", "character", "Second room wins", rowan.id)] }));
    await screen.findByText("Second room wins");
    firstHydration.resolve(json({ session: baseSession, messages: [message("first-late", "character", "First room is stale", aria.id)] }));
    await firstHydration.promise;
    await Promise.resolve();
    expect(screen.queryByText("First room is stale")).toBeNull();
    expect(screen.getByRole("heading", { name: secondSession.title })).toBeTruthy();
  });

  it.each([
    [500, "Room could not be opened. Please try again."],
    [404, "That room is no longer available. Latest campaign rooms are being refreshed."],
  ] as const)("keeps room hydration %s failures on campaign detail", async (status, expected) => {
    const attached = { sessionId: baseSession.id, title: "Unavailable room", participantNames: [aria.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false };
    let roomReads = 0;
    installFetch([aria], [baseSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => { roomReads += 1; return json({ attached: [attached], eligible: [] }); } },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ error: "private hydration detail" }, status) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open attached room 1 of 1" }));
    const alert = await screen.findByText(expected);
    expect(alert.getAttribute("role")).toBe("alert");
    await waitFor(() => expect(document.activeElement).toBe(status === 404
      ? screen.getByRole("heading", { name: "Rooms" })
      : alert));
    expect(screen.getByRole("heading", { name: campaignAccess.name })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private hydration detail");
    await waitFor(() => expect(roomReads).toBe(status === 404 ? 2 : 1));
  });

  it("rejects a valid but mismatched room hydration without changing campaign origin", async () => {
    const attached = { sessionId: baseSession.id, title: "Requested room", participantNames: [aria.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false };
    const wrongSession = { ...baseSession, id: "different-opaque-room", title: "Wrong room" };
    installFetch([aria], [baseSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => json({ attached: [attached], eligible: [] }) },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: wrongSession, messages: [message("wrong", "character", "Must stay hidden", aria.id)] }) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open attached room 1 of 1" }));
    const failure = await screen.findByText("Room could not be opened. Please try again.");
    await waitFor(() => expect(document.activeElement).toBe(failure));
    expect(screen.getByRole("heading", { name: campaignAccess.name })).toBeTruthy();
    expect(screen.queryByText("Must stay hidden")).toBeNull();
    expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({ view: "campaign-detail", campaignId: campaignAccess.id });
  });

  it("falls a mismatched restored campaign room back to its exact campaign with a generic local failure", async () => {
    const wrongSession = { ...baseSession, id: "restored-mismatch", title: "Wrong restored room" };
    installFetch([aria], [baseSession], true);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id, campaignId: campaignAccess.id, chatReturnCampaignId: campaignAccess.id }));
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: wrongSession, messages: [] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
    );
    render(<App />);
    await screen.findByRole("heading", { name: campaignAccess.name });
    expect(screen.getByText("Room could not be opened. Please try again.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: wrongSession.title })).toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({ view: "campaign-detail", campaignId: campaignAccess.id }));
  });

  it("opens, persists, restores, and backs out of an ID-free character workspace without changing the browser URL", async () => {
    const rosterEntry = { id: "workspace-entry-secret", characterId: "workspace-persona-secret", name: "Workspace Persona" };
    const workspace = { character: {
      name: rosterEntry.name, race: { name: "Avelune", description: "Moonlit people." }, background: { name: "Rainledger", description: "Records journeys." },
      classes: [{ name: "Pathmender", description: "Restores paths.", level: 1 }], attributes: [], proficiencies: [], choices: [], resources: [],
    } };
    installFetch([aria], [], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters$/, handler: () => json({ characters: [rosterEntry] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters\/workspace-entry-secret\/workspace$/, handler: () => json(workspace) },
    );
    window.history.replaceState({}, "", "/unchanged?local=yes");
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open character Workspace Persona, character 1 of 1" }));
    const workspaceHeading = await screen.findByRole("heading", { name: rosterEntry.name });
    await waitFor(() => expect(document.activeElement).toBe(workspaceHeading));
    expect(window.location.pathname + window.location.search).toBe("/unchanged?local=yes");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({
      view: "campaign-character", campaignId: campaignAccess.id, campaignCharacterId: rosterEntry.id,
    }));
    expect(document.body.outerHTML).not.toMatch(/workspace-(?:entry|persona)-secret/);
    fireEvent.click(screen.getByRole("button", { name: "← Back to campaign" }));
    const returnedHeading = await screen.findByRole("heading", { name: campaignAccess.name });
    await waitFor(() => expect(document.activeElement).toBe(returnedHeading));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").campaignCharacterId).toBeUndefined());

    cleanup();
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-character", campaignId: campaignAccess.id, campaignCharacterId: rosterEntry.id }));
    render(<App />);
    await screen.findByRole("heading", { name: rosterEntry.name });
    expect(window.location.pathname + window.location.search).toBe("/unchanged?local=yes");
  });

  it("returns a workspace 404 to campaign detail and focuses only its loaded heading", async () => {
    const rosterEntry = { id: "missing-workspace-entry", characterId: "missing-persona", name: "Missing Workspace" };
    installFetch([aria], [], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters$/, handler: () => json({ characters: [rosterEntry] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters\/missing-workspace-entry\/workspace$/, handler: () => json({ error: "private missing" }, 404) },
    );
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-detail", campaignId: campaignAccess.id }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open character Missing Workspace, character 1 of 1" }));
    const detailHeading = await screen.findByRole("heading", { name: campaignAccess.name });
    await waitFor(() => expect(document.activeElement).toBe(detailHeading));
    expect(document.body.textContent).not.toContain("private missing");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({ view: "campaign-detail", campaignId: campaignAccess.id }));
  });

  it.each(["back", "404"] as const)("consumes the workspace %s campaign-heading focus without replaying it after Campaigns/reopen", async (outcome) => {
    const rosterEntry = { id: `one-shot-${outcome}`, characterId: `one-shot-persona-${outcome}`, name: "One Shot" };
    const workspace = { character: {
      name: rosterEntry.name, race: { name: "Avelune", description: "Moonlit people." }, background: { name: "Rainledger", description: "Records journeys." },
      classes: [], attributes: [], proficiencies: [], choices: [], resources: [],
    } };
    let reopenedDetailResolve!: (response: Response) => void;
    const reopenedDetail = new Promise<Response>((resolve) => { reopenedDetailResolve = resolve; });
    let detailCalls = 0;
    installFetch([aria], [], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => ++detailCalls === 3 ? reopenedDetail : json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters$/, handler: () => json({ characters: [rosterEntry] }) },
      { method: "GET", match: new RegExp(`/api/rpg/v1/campaigns/campaign-one/characters/${rosterEntry.id}/workspace$`), handler: () => outcome === "404" ? json({ error: "private missing" }, 404) : json(workspace) },
    );
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-detail", campaignId: campaignAccess.id }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open character One Shot, character 1 of 1" }));
    if (outcome === "back") {
      await screen.findByRole("heading", { name: rosterEntry.name });
      fireEvent.click(screen.getByRole("button", { name: "← Back to campaign" }));
    }
    const returnedHeading = await screen.findByRole("heading", { name: campaignAccess.name });
    await waitFor(() => expect(document.activeElement).toBe(returnedHeading));

    fireEvent.click(screen.getByRole("button", { name: "← Campaigns" }));
    const reopen = await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` });
    const anchor = document.createElement("button");
    document.body.append(anchor);
    anchor.focus();
    fireEvent.click(reopen);
    reopenedDetailResolve(json(campaignDetail));
    await screen.findByRole("heading", { name: campaignAccess.name });
    await Promise.resolve();
    expect(document.activeElement).toBe(anchor);
    anchor.remove();
  });

  it("restores malformed workspace navigation to detail or campaigns and feature-falls home", async () => {
    installFetch([aria], [], true);
    routes.push({ method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) });
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-character", campaignId: campaignAccess.id, campaignCharacterId: "bad/id" }));
    render(<App />);
    await screen.findByRole("heading", { name: campaignAccess.name });
    cleanup();

    installFetch([aria], [], true);
    routes.push({ method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [] }) });
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-character", campaignId: "bad/id", campaignCharacterId: "entry" }));
    render(<App />);
    await screen.findByRole("heading", { name: "Campaigns" });
    cleanup();

    installFetch([aria], [], false);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-character", campaignId: campaignAccess.id, campaignCharacterId: "entry" }));
    await openLibrary();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").view).toBe("home"));
  });

  it("keeps App campaign detail available when an older server returns roster 404", async () => {
    installFetch([aria], [], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters$/, handler: () => json({ error: "private compatibility detail" }, 404) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    await screen.findByRole("heading", { name: campaignAccess.name });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/campaign-one/characters"))).toBe(true));
    expect(screen.queryByRole("heading", { name: "Characters" })).toBeNull();
    expect(document.body.textContent).not.toContain("private compatibility detail");
    expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({ view: "campaign-detail" });
  });

  it("renames an owned campaign and refetches the later library", async () => {
    installFetch([aria], [], true);
    let currentName = campaignAccess.name;
    let updatedAt = campaignAccess.updatedAt;
    let patchBody: Record<string, unknown> | null = null;
    let listCalls = 0;
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => { listCalls += 1; return json({ campaigns: [{ ...campaignAccess, name: currentName, updatedAt }] }); } },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json({ campaign: { ...campaignDetail.campaign, name: currentName, updatedAt } }) },
      { method: "PATCH", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: (body) => {
        patchBody = body as Record<string, unknown>;
        currentName = (patchBody as { name: string }).name;
        updatedAt = "2030-01-03T00:00:00.000Z";
        return json({ campaign: { id: campaignAccess.id, name: currentName, updatedAt } });
      } },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    const input = await screen.findByRole("textbox", { name: "Campaign name" });
    fireEvent.change(input, { target: { value: "The New Road" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename campaign" }));
    await screen.findByRole("heading", { name: "The New Road" });
    await screen.findByText("Campaign renamed to “The New Road”.");
    expect(patchBody).toEqual({ name: "The New Road", expectedUpdatedAt: campaignAccess.updatedAt });
    fireEvent.click(screen.getByRole("button", { name: "← Campaigns" }));
    await screen.findByRole("button", { name: "Open campaign The New Road" });
    expect(listCalls).toBe(2);
  });

  it("confirms original starter setup through App and renders reconciled read-only identifiers", async () => {
    installFetch([aria], [], true);
    let detail: unknown = campaignDetail;
    let setupBody: unknown = null;
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(detail) },
      { method: "PUT", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/starter-setup$/, handler: (body) => {
        setupBody = body;
        detail = { campaign: { ...campaignDetail.campaign, updatedAt: "2030-01-03T00:00:00.000Z", content: {
          status: "configured", rulesProfileId: "velvet:rules:original-narrative",
          contentPacks: [{ packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818" }],
        } } };
        return json(detail);
      } },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    const setup = await screen.findByRole("button", { name: "Set up original starter" });
    expect((setup as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /metadata-only setup is final/i }));
    fireEvent.click(setup);
    await screen.findByText(/Original starter setup is complete/i);
    expect(setupBody).toEqual({ starterId: "velvet:original-starter@1.0.0+d15042935818" });
    expect(screen.getByText("velvet:rules:original-narrative")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up original starter" })).toBeNull();
    expect(screen.getByText(/There are no reset, change, or add controls/i)).toBeTruthy();
  });

  it("integrates one finalized character create and authoritative reconciliation without exposing persona identity", async () => {
    installFetch([aria], [], true);
    let used = false;
    let postCalls = 0;
    let rosterCalls = 0;
    let optionsCalls = 0;
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(configuredCampaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters$/, handler: () => { rosterCalls += 1; return json({ characters: used ? [{ id: "app-entry-secret", characterId: "app-persona-secret", name: "App Persona" }] : [] }); } },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters\/creation-options$/, handler: () => { optionsCalls += 1; return json({ ...appCreationOptions, personas: appCreationOptions.personas.map((persona) => ({ ...persona, alreadyUsed: used })) }); } },
      { method: "POST", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/characters$/, handler: () => { postCalls += 1; used = true; return json({ character: { id: "app-entry-secret", characterId: "app-persona-secret", name: "App Persona" } }, 201); } },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("radio"));
    fireEvent.click(screen.getByRole("checkbox", { name: /currently has NO derived stats/i }));
    const submit = screen.getByRole("button", { name: "Finalize character record" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await screen.findByText(/created and confirmed by the latest character status/i);
    expect(postCalls).toBe(1);
    expect(rosterCalls).toBe(2);
    expect(optionsCalls).toBe(2);
    expect(document.body.outerHTML).not.toMatch(/app-(?:entry|persona)-secret/);
  });

  it("restores campaign detail while reconciling stale character selections", async () => {
    installFetch([aria], [], true);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-detail", campaignId: campaignAccess.id, selectedIds: [aria.id, "gone"], primaryId: "gone" }));
    routes.push({ method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) });
    render(<App />);
    await screen.findByRole("heading", { name: campaignAccess.name });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({ view: "campaign-detail", campaignId: campaignAccess.id, selectedIds: [aria.id], primaryId: aria.id }));
  });

  it("reconciles missing restored detail to campaigns and clears its ID", async () => {
    installFetch([aria], [], true);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-detail", campaignId: "missing" }));
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/missing$/, handler: () => json({ error: "private missing" }, 404) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [] }) },
    );
    render(<App />);
    await screen.findByRole("heading", { name: "Campaigns" });
    expect(screen.queryByText("private missing")).toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({ view: "campaigns" }));
    expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").campaignId).toBeUndefined();
  });

  it("falls home when persisted campaign detail is feature unavailable", async () => {
    installFetch([aria], [], false);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "campaign-detail", campaignId: campaignAccess.id }));
    await openLibrary();
    expect(screen.queryByText(campaignAccess.name)).toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").view).toBe("home"));
  });

  it("sends and continues as the selected target speaker", async () => {
    installFetch(); localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    const first = message("m1", "character", "Welcome", aria.id); let sendBody: Record<string, unknown> | null = null; let continueBody: Record<string, unknown> | null = null;
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [first] }) },
      { method: "POST", match: /\/api\/sessions\/sess-1\/messages$/, handler: (body) => { sendBody = body as Record<string, unknown>; const reply = message("m2", "character", "Rowan reply", rowan.id); return json({ reply, messages: [first, message("u1", "user", "hello"), reply] }); } },
      { method: "GET", match: /\/api\/sessions\/sess-1\/messages\/m2\/siblings$/, handler: () => json({ siblings: [], activeMessageId: null, activeLeafId: null }) },
      { method: "POST", match: /\/api\/sessions\/sess-1\/continue$/, handler: (body) => { continueBody = body as Record<string, unknown>; const reply = message("m3", "character", "Rowan continues", rowan.id); return json({ reply, messages: [first, reply] }); } },
      { method: "GET", match: /\/api\/sessions\/sess-1\/messages\/m3\/siblings$/, handler: () => json({ siblings: [], activeMessageId: null, activeLeafId: null }) },
    );
    render(<App />); await screen.findByText("Welcome");
    fireEvent.change(screen.getByLabelText("Target speaker"), { target: { value: rowan.id } });
    fireEvent.change(screen.getByPlaceholderText("Write a message…"), { target: { value: "hello" } }); fireEvent.click(screen.getByRole("button", { name: "Send to Rowan" }));
    await screen.findByText("Rowan reply"); expect(sendBody).toMatchObject({ content: "hello", speakerCharacterId: rowan.id });
    fireEvent.click(screen.getByRole("button", { name: "Continue as Rowan" })); await screen.findByText("Rowan continues"); expect(continueBody).toEqual({ speakerCharacterId: rowan.id });
  });

  it("sends one message to the room and renders all selected replies", async () => {
    installFetch(); localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    let roomBody: Record<string, unknown> | null = null; let continuationBody: Record<string, unknown> | null = null; let continuationCalls = 0;
    const user = message("u1", "user", "What does everyone think?");
    const ariaReply = { ...message("m1", "character", "Aria offers a plan", aria.id), parentId: user.id };
    const rowanReply = { ...message("m2", "character", "Rowan challenges it", rowan.id), parentId: ariaReply.id };
    const ariaContinues = { ...message("m3", "character", "Aria answers Rowan", aria.id), parentId: rowanReply.id };
    const rowanContinues = { ...message("m4", "character", "Rowan responds again", rowan.id), parentId: ariaContinues.id };
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "POST", match: /\/api\/sessions\/sess-1\/room-turn$/, handler: (body) => { roomBody = body as Record<string, unknown>; const result = { userMessage: user, replies: [ariaReply, rowanReply], selectedSpeakerIds: [aria.id, rowan.id], routing: "model", messages: [user, ariaReply, rowanReply] }; return sse([{ event: "user_message", data: { message: user } }, { event: "room_reply", data: { reply: ariaReply, index: 0, total: 2 } }, { event: "room_reply", data: { reply: rowanReply, index: 1, total: 2 } }, { event: "room_done", data: result }]); } },
      { method: "POST", match: /\/api\/sessions\/sess-1\/room-continue$/, handler: (body) => { continuationCalls += 1; continuationBody = body as Record<string, unknown>; const result = { replies: [ariaContinues, rowanContinues], selectedSpeakerIds: [aria.id, rowan.id], routing: "model", messages: [user, ariaReply, rowanReply, ariaContinues, rowanContinues] }; return sse([{ event: "room_reply", data: { reply: ariaContinues, index: 0, total: 2 } }, { event: "room_reply", data: { reply: rowanContinues, index: 1, total: 2 } }, { event: "room_done", data: result }]); } },
    );
    render(<App />); await screen.findByText(/scene is ready/i);
    fireEvent.change(screen.getByPlaceholderText("Write a message…"), { target: { value: "What does everyone think?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to room" }));
    await screen.findByText("Aria offers a plan");
    await screen.findByText("Rowan challenges it");
    const ariaBubble = screen.getByText("Aria offers a plan").closest(".message") as HTMLElement;
    const rowanBubble = screen.getByText("Rowan challenges it").closest(".message") as HTMLElement;
    expect(ariaBubble.style.getPropertyValue("--speaker-hue")).not.toBe("");
    expect(ariaBubble.style.getPropertyValue("--speaker-hue")).not.toBe(rowanBubble.style.getPropertyValue("--speaker-hue"));
    expect(roomBody).toEqual({ content: "What does everyone think?", maxSpeakers: 2 });
    expect(continuationCalls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Give room another turn" }));
    await screen.findByText("Aria answers Rowan");
    await screen.findByText("Rowan responds again");
    expect(continuationBody).toEqual({ maxSpeakers: 2 });
    expect(continuationCalls).toBe(2);
  });

  it("opens and reuses a persistent private chat for the selected room agent", async () => {
    installFetch(); localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    const privateSession = { ...baseSession, id: "solo-rowan", characterId: rowan.id, primaryCharacterId: rowan.id, participants: [rowan], title: "" };
    const privateMessage = { ...message("private-1", "character", "Private history", rowan.id), sessionId: privateSession.id };
    let privateBody: unknown = null;
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "POST", match: /\/api\/sessions\/solo$/, handler: (body) => { privateBody = body; return json({ session: privateSession, messages: [privateMessage], created: false }); } },
    );
    render(<App />); await screen.findByText(/scene is ready/i);
    fireEvent.change(screen.getByLabelText("Target speaker"), { target: { value: rowan.id } });
    fireEvent.click(screen.getByRole("button", { name: "Private chat with Rowan" }));
    await screen.findByText("Private history");
    expect(privateBody).toEqual({ characterId: rowan.id });
    expect(screen.queryByRole("button", { name: /Private chat with/ })).toBeNull();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").sessionId).toBe("solo-rowan"));
  });

  it("preserves campaign Back origin on private failure and ignores private completion after Back", async () => {
    const attached = { sessionId: baseSession.id, title: baseSession.title, participantNames: [aria.name, rowan.name], createdAt: baseSession.createdAt, attachedAt: "2030-01-03T00:00:00.000Z", stopped: false };
    const first = deferred<Response>();
    const latePrivate = { ...baseSession, id: "late-private", participants: [aria], title: "Late private" };
    installFetch([aria, rowan], [baseSession], true);
    routes.push(
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns$/, handler: () => json({ campaigns: [campaignAccess] }) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one$/, handler: () => json(campaignDetail) },
      { method: "GET", match: /\/api\/rpg\/v1\/campaigns\/campaign-one\/rooms$/, handler: () => json({ attached: [attached], eligible: [] }) },
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "POST", match: /\/api\/sessions\/solo$/, handler: () => first.promise },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Campaigns" }));
    fireEvent.click(await screen.findByRole("button", { name: `Open campaign ${campaignAccess.name}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Open attached room 1 of 1" }));
    await screen.findByRole("button", { name: "← Back to campaign" });
    fireEvent.click(screen.getByRole("button", { name: "Private chat with Aria" }));
    expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").chatReturnCampaignId).toBe(campaignAccess.id);
    fireEvent.click(screen.getByRole("button", { name: "← Back to campaign" }));
    await screen.findByRole("heading", { name: campaignAccess.name });
    first.resolve(json({ session: latePrivate, messages: [{ ...message("late-private-message", "character", "Must not replace campaign", aria.id), sessionId: latePrivate.id }], created: true }));
    await first.promise;
    await Promise.resolve();
    expect(screen.getByRole("heading", { name: campaignAccess.name })).toBeTruthy();
    expect(screen.queryByText("Must not replace campaign")).toBeNull();
  });

  it("does not clear the current campaign room or Back origin when private open fails", async () => {
    installFetch([aria, rowan], [baseSession], true);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id, campaignId: campaignAccess.id, chatReturnCampaignId: campaignAccess.id }));
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "POST", match: /\/api\/sessions\/solo$/, handler: () => Promise.reject(new TypeError("private network detail")) },
    );
    render(<App />); await screen.findByText(/scene is ready/i);
    fireEvent.click(screen.getByRole("button", { name: "Private chat with Aria" }));
    await screen.findByText("Could not open private chat.");
    expect(screen.getByRole("heading", { name: baseSession.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: "← Back to campaign" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private network detail");
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({
      view: "chat", sessionId: baseSession.id, chatReturnCampaignId: campaignAccess.id,
    }));
  });

  it.each([
    ["empty session id", { ...baseSession, id: "", participants: [aria] }],
    ["extra participant", { ...baseSession, id: "wrong-solo-extra", participants: [aria, rowan] }],
    ["wrong participant", { ...baseSession, id: "wrong-solo-participant", participants: [rowan] }],
    ["wrong primary", { ...baseSession, id: "wrong-solo-primary", participants: [aria], primaryCharacterId: rowan.id }],
    ["wrong compatibility alias", { ...baseSession, id: "wrong-solo-alias", participants: [aria], characterId: rowan.id }],
  ])("rejects private response binding with %s and preserves campaign room origin", async (_label, returnedSession) => {
    installFetch([aria, rowan], [baseSession], true);
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id, campaignId: campaignAccess.id, chatReturnCampaignId: campaignAccess.id }));
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "POST", match: /\/api\/sessions\/solo$/, handler: () => json({ session: returnedSession, messages: [], created: false }) },
    );
    render(<App />); await screen.findByText(/scene is ready/i);
    fireEvent.click(screen.getByRole("button", { name: "Private chat with Aria" }));
    await screen.findByText("Could not open private chat.");
    expect(screen.getByRole("heading", { name: baseSession.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: "← Back to campaign" })).toBeTruthy();
    if (returnedSession.id) expect(document.body.textContent).not.toContain(String(returnedSession.id));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}")).toMatchObject({
      view: "chat", sessionId: baseSession.id, chatReturnCampaignId: campaignAccess.id,
    }));
  });

  it("disables replacement and mutation actions while private hydration is pending", async () => {
    const ariaOpen = deferred<Response>();
    const ariaPrivate = { ...baseSession, id: "private-latest", participants: [aria], title: "" };
    installFetch();
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "POST", match: /\/api\/sessions\/solo$/, handler: () => ariaOpen.promise },
    );
    render(<App />); await screen.findByText(/scene is ready/i);
    fireEvent.click(screen.getByRole("button", { name: "Private chat with Aria" }));
    for (const name of ["Prompt & settings", "End session", "Private chat with Aria", "Continue as Aria"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByLabelText("Target speaker") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText("Write a message…") as HTMLInputElement).disabled).toBe(true);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/api/sessions/solo"))).toHaveLength(1);

    ariaOpen.resolve(json({ session: ariaPrivate, messages: [{ ...message("latest-private-message", "character", "Bound private wins", aria.id), sessionId: ariaPrivate.id }], created: true }));
    await screen.findByText("Bound private wins");
    expect(screen.queryByRole("heading", { name: baseSession.title })).toBeNull();
  });

  it("ignores a late stop from the old room after private chat replacement succeeds", async () => {
    const stop = deferred<Response>();
    const privateSession = { ...baseSession, id: "private-after-stop", characterId: aria.id, primaryCharacterId: aria.id, participants: [aria], title: "Private winner" };
    installFetch();
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "POST", match: /\/api\/sessions\/sess-1\/stop$/, handler: () => stop.promise },
      { method: "POST", match: /\/api\/sessions\/solo$/, handler: () => json({ session: privateSession, messages: [{ ...message("private-wins", "character", "Private state wins", aria.id), sessionId: privateSession.id }], created: true }) },
    );
    render(<App />);
    await screen.findByText(/scene is ready/i);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    fireEvent.click(screen.getByRole("button", { name: "Private chat with Aria" }));
    await screen.findByText("Private state wins");

    stop.resolve(json({ ...baseSession, state: "closed", stoppedAt: "2030-01-01T00:00:00.000Z" }));
    await stop.promise;
    await Promise.resolve();
    expect(screen.getByRole("heading", { name: privateSession.title })).toBeTruthy();
    expect(screen.queryByText(/no longer writable/i)).toBeNull();
    expect(screen.getByText("Private state wins")).toBeTruthy();
  });

  it("keeps a mismatched save-and-start hydration on the safe library with a generic error", async () => {
    const saved = { ...aria, id: "newly-saved" };
    const created = { ...baseSession, id: "created-session", characterId: saved.id, primaryCharacterId: saved.id, participants: [saved] };
    installFetch([], []);
    routes.push(
      { method: "POST", match: /\/api\/characters$/, handler: () => json(saved, 201) },
      { method: "POST", match: /\/api\/sessions$/, handler: () => json(created, 201) },
      { method: "GET", match: /\/api\/sessions\/created-session$/, handler: () => json({ session: { ...created, id: "different-session" }, messages: [] }) },
    );
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "New character" }));
    fireEvent.change(screen.getByLabelText("Character name"), { target: { value: "Saved one" } });
    fireEvent.change(screen.getByLabelText("Age (18+)"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Archetype / vibe"), { target: { value: "Confidant" } });
    fireEvent.change(screen.getByLabelText("Boundaries & hard limits"), { target: { value: "Fiction only" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /entirely fictional/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create character & start session" }));

    await screen.findByRole("heading", { name: "Characters" });
    expect(await screen.findByText("Could not save character.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Night watch" })).toBeNull();
    expect(document.body.textContent).not.toContain("different-session");
  });

  it("opens the resizable prompt studio and saves an underlying layer", async () => {
    installFetch(); localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    let templates = [{ id: "character.final", label: "Final turn", description: "Final instructions", defaultTemplate: "Default {{target.name}}", template: "Default {{target.name}}", placeholders: ["target.name"], overridden: false }];
    let savedTemplate = "";
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [] }) },
      { method: "GET", match: /\/api\/prompt-templates$/, handler: () => json({ templates }) },
      { method: "PUT", match: /\/api\/prompt-templates\/character.final$/, handler: (body) => { savedTemplate = (body as { template: string }).template; templates = [{ ...templates[0]!, template: savedTemplate, overridden: true }]; return json({ templates }); } },
    );
    render(<App />); await screen.findByText(/scene is ready/i);
    fireEvent.click(screen.getByRole("button", { name: "Prompt & settings" }));
    const separator = screen.getByRole("separator", { name: "Resize settings pane" });
    expect(separator).toBeTruthy();
    const editor = await screen.findByLabelText("Prompt template editor");
    fireEvent.change(editor, { target: { value: "Changed {{target.name}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save layer" }));
    await screen.findByText("Prompt template saved.");
    expect(savedTemplate).toBe("Changed {{target.name}}");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    await waitFor(() => expect(Number(localStorage.getItem("velvet.settings.width"))).toBeGreaterThan(440));
  });

  it("only offers regenerate and retry when the latest character reply has a user parent", async () => {
    installFetch(); localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "chat", sessionId: baseSession.id }));
    const user = { ...message("u1", "user", "Tell me more"), parentId: null };
    const reply = { ...message("m1", "character", "Aria replies", aria.id), parentId: user.id };
    const continuation = { ...message("m2", "character", "Rowan adds a thought", rowan.id), parentId: reply.id };
    routes.push(
      { method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: baseSession, messages: [user, reply] }) },
      { method: "POST", match: /\/api\/sessions\/sess-1\/continue$/, handler: () => json({ reply: continuation, messages: [user, reply, continuation] }) },
    );
    render(<App />); await screen.findByText("Aria replies");
    expect(screen.getByRole("button", { name: "Regenerate reply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry last turn" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue as Aria" }));
    await screen.findByText("Rowan adds a thought");
    expect(screen.queryByRole("button", { name: "Regenerate reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry last turn" })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/swipe"))).toBe(false);
  });

  it("shows closed sessions as readable but not writable", async () => {
    const closed = { ...baseSession, state: "closed" as const, stoppedAt: "2026-01-02T00:00:00.000Z", stopReason: "user-stop" };
    installFetch([aria, rowan], [closed]); routes.push({ method: "GET", match: /\/api\/sessions\/sess-1$/, handler: () => json({ session: closed, messages: [message("m1", "character", "Saved ending", aria.id)] }) });
    await openLibrary(); fireEvent.click(screen.getByRole("button", { name: /^Night watch/ }));
    await screen.findByText("Saved ending"); expect(screen.getByText(/no longer writable/)).toBeTruthy(); expect(screen.getByPlaceholderText("Session ended").hasAttribute("disabled")).toBe(true); expect(screen.getByRole("button", { name: /Continue as/ }).hasAttribute("disabled")).toBe(true);
  });

  it("deletes session history from the library after confirmation", async () => {
    const savedSessions = [baseSession]; installFetch([aria, rowan], savedSessions); let deletedId = "";
    routes.push({ method: "DELETE", match: /\/api\/sessions\/sess-1$/, handler: () => { deletedId = baseSession.id; savedSessions.splice(0); return json({ ok: true }); } });
    localStorage.setItem("velvet.navigation.v1", JSON.stringify({ view: "home", sessionId: baseSession.id }));
    await openLibrary();
    fireEvent.click(screen.getByRole("button", { name: "Delete session: Night watch" }));
    await screen.findByText("No sessions yet.");
    expect(deletedId).toBe(baseSession.id);
    expect(vi.mocked(confirm)).toHaveBeenCalledWith(expect.stringContaining("messages and summary"));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("velvet.navigation.v1") ?? "{}").sessionId).toBeUndefined());
  });

  it("manages active, pending, and forgotten memory lifecycle", async () => {
    installFetch([aria], []); let memories = [{ id: "mem-1", characterId: aria.id, kind: "fact", content: "Likes stars", sourceTurnId: "manual", createdAt: "", userApproved: false, forgottenAt: null as string | null }];
    routes.push(
      { method: "GET", match: /\/api\/characters\/char-1\/memories$/, handler: () => json({ memories }) },
      { method: "PATCH", match: /\/api\/memories\/mem-1$/, handler: (body) => { memories = [{ ...memories[0]!, ...(body as object) }]; return json(memories[0]); } },
      { method: "DELETE", match: /\/api\/memories\/mem-1$/, handler: () => { memories[0]!.forgottenAt = "now"; return json({ ok: true, forgottenAt: "now" }); } },
      { method: "POST", match: /\/api\/memories\/mem-1\/restore$/, handler: () => { memories[0]!.forgottenAt = null; return json(memories[0]); } },
    );
    await openLibrary(); fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    await screen.findByRole("tab", { name: /pending 1/ }); fireEvent.click(screen.getByRole("tab", { name: /pending 1/ })); await screen.findByText("Likes stars"); fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const activeTab = await screen.findByRole("tab", { name: /active 1/ }); fireEvent.click(activeTab); await screen.findByText("Likes stars"); fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    const forgottenTab = await screen.findByRole("tab", { name: /forgotten 1/ }); fireEvent.click(forgottenTab); await screen.findByText("Likes stars"); fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /forgotten 0/ })).toBeTruthy());
  });

  it("creates lore scoped to many characters and supports global scope", async () => {
    installFetch(); let lorePayload: Record<string, unknown> | null = null;
    routes.push(
      { method: "GET", match: /\/api\/lore$/, handler: () => json({ lore: [] }) },
      { method: "POST", match: /\/api\/lore$/, handler: (body) => { lorePayload = body as Record<string, unknown>; return json({ id: "l1", createdAt: "", ...(body as object), characterId: aria.id }, 201); } },
    );
    await openLibrary(); fireEvent.click(screen.getByRole("button", { name: "World lore" })); await screen.findByRole("heading", { name: "Lore library" });
    const scopeChecks = screen.getAllByRole("checkbox"); fireEvent.click(scopeChecks[2]!); fireEvent.click(scopeChecks[3]!);
    fireEvent.change(screen.getByPlaceholderText("moon gate, old harbor"), { target: { value: "harbor, moon" } }); fireEvent.change(screen.getByPlaceholderText(/World details/), { target: { value: "The harbor closes at midnight." } }); fireEvent.click(screen.getByRole("button", { name: "Add lore" }));
    await waitFor(() => expect(lorePayload).toMatchObject({ characterIds: [aria.id, rowan.id], keys: ["harbor", "moon"], content: "The harbor closes at midnight." }));
  });
});

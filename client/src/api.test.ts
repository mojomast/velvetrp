import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiInputError, activateMessage, addCampaignAdministrationMembership, applyCharacterProgression, attachCampaignRoom, branchMessage, cancelGeneration, configureCampaignContent, continueRoom, continueSession, createCampaign, createCampaignCheckpoint, createCharacterDraft, createOriginalStarterCampaignCharacter, createSseParser, deleteSession, encodeOpaquePathSegment, errorFromResponse, finalizeCharacterDraft, forkCampaignTimeline, getCampaignCharacterCreationOptions, getCampaignCharacterWorkspace, getCampaignContent, getCampaignContentPack, getCampaignDetail, getCampaignDiceHistory, getCharacterDraft, getCharacterProgression, getCharacterSheet, getContentPackPublication, getFeatures, getMessages, getRpgFeatures, getSession, getSessionContext, getSiblings, grantCharacterXp, listAllContentPackPublications, listCampaignCharacters, listCampaignCheckpoints, listCampaignRooms, listCampaigns, listContentPackPublications, previewCharacterProgression, publishContentPack, renameCampaign, rollCampaignDice, sendMessage, sendRoomMessage, setupMechanicsStarter, setupOriginalStarter, stopSession, streamMessage, streamRoomContinuation, streamRoomMessage, streamSwipe, swipeMessage, updateCampaignAdministrationMembership, updateCharacterDraft, updateSessionContext, validateContentPackDraft } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("M2.6 character API bindings", () => {
  const at = "2030-01-01T00:00:00.000Z";
  const scores = { might: 15, agility: 14, resolve: 13, insight: 12, presence: 10, craft: 8 };
  const reference = <K extends "race" | "background" | "class">(kind: K, definitionId: string) => ({ kind, packId: "pack", packVersion: "1", definitionId });
  const groups = [
    { id: "race", required: true, options: [{ reference: reference("race", "race"), name: "Avelune", description: "Moonlit." }] },
    { id: "background", required: true, options: [{ reference: reference("background", "background"), name: "Guide", description: "A guide." }] },
    { id: "class", required: true, options: [{ reference: reference("class", "class"), name: "Warden", description: "A warden." }] },
    { id: "starter-grant", required: true, options: ["kit", "currency"] },
  ];
  const draft = { id: "draft", campaignId: "campaign", personaId: "persona", status: "active", durability: "durable", expiresAt: null, effectivelyExpired: false,
    revision: 0, rulesProfileId: "rules", pins: [{ packId: "pack", packVersion: "1", publicationDigest: "a".repeat(64) }],
    allocation: { method: "standard-array", scores }, selections: { race: null, background: null, class: null, starterGrant: null }, choiceGroups: groups,
    completion: { complete: false, issues: [{ code: "missing-race", path: "selections.race", message: "Choose race" }] }, derivedPreview: null, startingGrants: [], createdAt: at, updatedAt: at };
  const receipt = { draftId: "draft", idempotencyKey: "create-key", type: "create", revisionBefore: 0, revisionAfter: 0, occurredAt: at };
  const derived = { maxHp: 10, defenses: { guard: 10, evasion: 10, will: 10 }, initiative: 2, speed: 30, carryingLimit: 150, spellAttack: 3, saveDc: 11,
    explanations: ["max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc"].map((statistic) => ({ statistic, formula: "server", inputs: {}, result: 10 })) };

  it("binds draft create, no-store load, and revision autosave without retry", async () => {
    const selected = { ...draft, revision: 1, selections: { ...draft.selections, race: reference("race", "race") }, updatedAt: "2030-01-01T00:00:01.000Z" };
    const updateReceipt = { ...receipt, idempotencyKey: "save-key", type: "update", revisionAfter: 1 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ draft, receipt }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(draft), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ draft: selected, receipt: updateReceipt }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createCharacterDraft("campaign", { personaId: "persona", durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "create-key" })).resolves.toMatchObject({ draft: { id: "draft" } });
    await expect(getCharacterDraft("campaign", "draft")).resolves.toMatchObject({ revision: 0 });
    await expect(updateCharacterDraft("campaign", "draft", { expectedRevision: 0, idempotencyKey: "save-key", selections: { race: reference("race", "race") } })).resolves.toMatchObject({ draft: { revision: 1 } });
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).method ?? "GET", (init as RequestInit).cache])).toEqual([
      ["/api/rpg/v1/campaigns/campaign/character-drafts", "POST", "no-store"],
      ["/api/rpg/v1/campaigns/campaign/character-drafts/draft", "GET", "no-store"],
      ["/api/rpg/v1/campaigns/campaign/character-drafts/draft", "PATCH", "no-store"],
    ]);
    await expect(getCharacterDraft("wrong/id", "draft")).rejects.toBeInstanceOf(ApiInputError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("path/status/binds finalization, sheet, progression preview, apply, and XP routes", async () => {
    const finalReceipt = { idempotencyKey: "final-key", revisionBefore: 1, revisionAfter: 2, occurredAt: at, derived, startingGrants: [] };
    const finalization = { character: { id: "character", createdAt: at, updatedAt: at }, sheet: { id: "sheet", race: reference("race", "race"), background: reference("background", "background"), classes: [{ class: reference("class", "class"), level: 1 }], attributes: [], proficiencies: [], choices: [], createdAt: at, updatedAt: at }, resources: [{ name: "health", current: 10, max: 10 }], receipt: finalReceipt };
    const workspace = { name: "Persona", race: { name: "Avelune", description: "Moonlit." }, background: { name: "Guide", description: "A guide." }, classes: [{ name: "Warden", description: "A warden.", level: 1 }], attributes: [], proficiencies: [], choices: [], resources: [] };
    const sheet = { sheet: workspace, derived, progression: { mode: "xp", level: 1, totalXp: 0, milestoneCount: 0, updatedAt: at } };
    const profile = { profileId: "profile", rulesProfileId: "rules", mode: "xp", maxLevel: 1, thresholds: [{ level: 1, xp: 0 }] };
    const progression = { campaignId: "campaign", campaignCharacterId: "character", profile, classRef: reference("class", "class"), level: 1, totalXp: 0, milestoneCount: 0, revision: 2, pendingChoices: [], knownAbilities: [], knownSpells: [], derived, updatedAt: at };
    const preview = { campaignId: "campaign", campaignCharacterId: "character", previewRevision: 2, previewToken: "b".repeat(64), mode: "xp" as const, currentLevel: 1, eligibleLevel: 1, totalXp: 0, milestoneCount: 0, pendingChoices: [], levels: [] };
    const applyReceipt = { campaignCharacterId: "character", idempotencyKey: "apply-key", type: "apply-levels", revisionBefore: 2, revisionAfter: 3, occurredAt: at, appliedLevels: [] };
    const xpReceipt = { ...applyReceipt, idempotencyKey: "xp-key", type: "grant-xp" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(finalization), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sheet), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ progression }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ preview }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ progression: { ...progression, revision: 3 }, receipt: applyReceipt }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ progression: { ...progression, revision: 3, totalXp: 10 }, receipt: xpReceipt }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(finalizeCharacterDraft("campaign", "draft", { expectedRevision: 1, idempotencyKey: "final-key" })).resolves.toEqual(finalization);
    await expect(getCharacterSheet("campaign", "character")).resolves.toEqual(sheet);
    await expect(getCharacterProgression("campaign", "character")).resolves.toMatchObject({ revision: 2 });
    await expect(previewCharacterProgression("campaign", "character", { selections: [] })).resolves.toEqual(preview);
    await expect(applyCharacterProgression("campaign", "character", { previewRevision: 2, previewToken: "b".repeat(64), selections: [], idempotencyKey: "apply-key" }, preview)).resolves.toMatchObject({ receipt: { revisionAfter: 3 } });
    await expect(grantCharacterXp("campaign", "character", { amount: 10, reason: "Quest", expectedRevision: 2, idempotencyKey: "xp-key" })).resolves.toMatchObject({ progression: { totalXp: 10 } });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).cache).toBe("no-store");
  });

  it("rejects an apply receipt whose calculated changes differ from the displayed preview", async () => {
    const level = { level: 2, hp: { maxBefore: 10, maxAfter: 15, currentBefore: 10, currentAfter: 15, gain: 5 }, proficiency: { before: 2, after: 2 }, resources: [], fixedAbilities: [], selectedAbilities: [], spells: [], derivedBefore: derived, derivedAfter: { ...derived, maxHp: 15 } };
    const preview = { campaignId: "campaign", campaignCharacterId: "character", previewRevision: 2, previewToken: "b".repeat(64), mode: "xp" as const, currentLevel: 1, eligibleLevel: 2, totalXp: 10, milestoneCount: 0, pendingChoices: [], levels: [level] };
    const progression = { campaignId: "campaign", campaignCharacterId: "character", profile: { profileId: "profile", rulesProfileId: "rules", mode: "xp", maxLevel: 2, thresholds: [{ level: 1, xp: 0 }, { level: 2, xp: 10 }] }, classRef: reference("class", "class"), level: 2, totalXp: 10, milestoneCount: 0, revision: 3, pendingChoices: [], knownAbilities: [], knownSpells: [], derived: level.derivedAfter, updatedAt: at };
    const response = { progression, receipt: { campaignCharacterId: "character", idempotencyKey: "apply-key", type: "apply-levels", revisionBefore: 2, revisionAfter: 3, occurredAt: at, appliedLevels: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })));
    await expect(applyCharacterProgression("campaign", "character", { previewRevision: 2, previewToken: "b".repeat(64), selections: [], idempotencyKey: "apply-key" }, preview as any)).rejects.toThrow(/did not match/);
  });
});

describe("createSseParser", () => {
  it("parses a complete event in one chunk", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const push = createSseParser((event, data) => events.push({ event, data }));
    push('event: delta\ndata: {"seq":0,"text":"hi"}\n\n');
    expect(events).toEqual([{ event: "delta", data: { seq: 0, text: "hi" } }]);
  });

  it("reassembles events split across chunks", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const push = createSseParser((event, data) => events.push({ event, data }));
    push("event: del");
    push('ta\nda');
    push('ta: {"seq":1,');
    push('"text":"there"}\n');
    push("\n");
    expect(events).toEqual([{ event: "delta", data: { seq: 1, text: "there" } }]);
  });

  it("handles multiple events in one chunk and ignores heartbeat comments", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const push = createSseParser((event, data) => events.push({ event, data }));
    push(
      ": heartbeat\n\nevent: user_message\ndata: {\"message\":{\"id\":\"m1\"}}\n\n: heartbeat\n\nevent: done\ndata: {\"ok\":true}\n\n",
    );
    expect(events.map((entry) => entry.event)).toEqual(["user_message", "done"]);
    expect(events[0]?.data).toEqual({ message: { id: "m1" } });
    expect(events[1]?.data).toEqual({ ok: true });
  });

  it("joins multi-line data fields", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const push = createSseParser((event, data) => events.push({ event, data }));
    push('event: delta\ndata: {"seq":\ndata: 2,"text":"x"}\n\n');
    expect(events).toEqual([{ event: "delta", data: { seq: 2, text: "x" } }]);
  });

  it("skips malformed json without throwing", () => {
    const onEvent = vi.fn();
    const push = createSseParser(onEvent);
    push("event: delta\ndata: {not json}\n\n");
    push('event: done\ndata: {"ok":true}\n\n');
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("done", { ok: true });
  });

  it("defaults the event name to message", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const push = createSseParser((event, data) => events.push({ event, data }));
    push('data: {"plain":1}\n\n');
    expect(events).toEqual([{ event: "message", data: { plain: 1 } }]);
  });
});

describe("opaque legacy URL path segments", () => {
  it.each([
    ["safe-ID_123", "safe-ID_123"],
    ["has space", "has%20space"],
    ["slash/value", "slash%2Fvalue"],
    ["query?value", "query%3Fvalue"],
    ["hash#value", "hash%23value"],
    ["percent%value", "percent%25value"],
    ["already%20encoded", "already%2520encoded"],
    ["雪🐉", "%E9%9B%AA%F0%9F%90%89"],
    [" leading and trailing ", "%20leading%20and%20trailing%20"],
  ])("encodes raw %j exactly once", (raw, encoded) => {
    expect(encodeOpaquePathSegment(raw)).toBe(encoded);
  });

  it("uses the helper for every session and message path interpolation", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const sessionId = " room/%?#雪 ";
    const messageId = " message/%?#龍 ";
    const session = encodeURIComponent(sessionId);
    const message = encodeURIComponent(messageId);
    const calls: Array<Promise<unknown>> = [
      getSession(sessionId), getSessionContext(sessionId), updateSessionContext(sessionId, "canon"), deleteSession(sessionId),
      sendMessage(sessionId, "hello"), sendRoomMessage(sessionId, "hello"), continueRoom(sessionId), stopSession(sessionId),
      getMessages(sessionId), getSiblings(sessionId, messageId), activateMessage(sessionId, messageId), swipeMessage(sessionId, messageId),
      branchMessage(sessionId, messageId, "branch"), continueSession(sessionId, "speaker"), cancelGeneration(sessionId, "generation"),
      streamRoomMessage(sessionId, "hello", { onReply: vi.fn(), onDone: vi.fn() }),
      streamRoomContinuation(sessionId, { onReply: vi.fn(), onDone: vi.fn() }),
    ];
    const messageStream = streamMessage(sessionId, "hello", undefined, {});
    const swipeStream = streamSwipe(sessionId, messageId, undefined, {});
    calls.push(messageStream.done, swipeStream.done);
    await Promise.all(calls);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `/api/sessions/${session}`,
      `/api/sessions/${session}/context`,
      `/api/sessions/${session}/context`,
      `/api/sessions/${session}`,
      `/api/sessions/${session}/messages`,
      `/api/sessions/${session}/room-turn`,
      `/api/sessions/${session}/room-continue`,
      `/api/sessions/${session}/stop`,
      `/api/sessions/${session}/messages`,
      `/api/sessions/${session}/messages/${message}/siblings`,
      `/api/sessions/${session}/messages/${message}/activate`,
      `/api/sessions/${session}/messages/${message}/swipe`,
      `/api/sessions/${session}/branch`,
      `/api/sessions/${session}/continue`,
      `/api/sessions/${session}/generation/cancel`,
      `/api/sessions/${session}/room-turn`,
      `/api/sessions/${session}/room-continue`,
      `/api/sessions/${session}/stream`,
      `/api/sessions/${session}/messages/${message}/swipe/stream`,
    ]);
  });
});

describe("HTTP runtime contracts", () => {
  const catalogAt = "2030-01-01T00:00:00.000Z";
  const catalogDigest = "a".repeat(64);
  const catalogDefinition = { reference: { packId: "pack:one", packVersion: "1.0.0+build.1", definitionId: "race", kind: "race" as const }, name: "Race", description: "Description", tags: [], mechanics: { speed: 30, attributeBonuses: {}, abilityRefs: [] } };
  const catalogProvenance = { authorship: "original" as const, author: "Author", authoredAt: catalogAt, reviewedBy: "Reviewer", reviewedAt: catalogAt, declaration: "Original", thirdPartyData: false as const };
  const catalogManifest = { packId: "pack:one", packVersion: "1.0.0+build.1", name: "Pack", description: "Description", tags: ["starter"], rulesProfile: { name: "Rules", description: "Rules", tags: [] }, compatibility: { rulesEngine: "velvet-starter-v1" as const, rulesProfileId: "rules", catalogFormat: "validated-v1" as const }, digest: catalogDigest, provenance: catalogProvenance };
  const catalogPublication = { packId: catalogManifest.packId, packVersion: catalogManifest.packVersion, name: catalogManifest.name, description: catalogManifest.description, tags: catalogManifest.tags, compatibility: catalogManifest.compatibility, digest: catalogDigest, validationLevel: "validated-v1" as const, publishedAt: catalogAt };
  const ownerCatalog = { publication: catalogPublication, provenance: catalogProvenance, definitions: [catalogDefinition] };

  it("strictly reads and encodes all sealed content pack projections without caching", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publications: [catalogPublication], nextCursor: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalog: ownerCatalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalog: { publication: catalogPublication, definitions: [catalogDefinition] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listContentPackPublications({ cursor: "next_page", limit: 2 })).resolves.toMatchObject({ publications: [catalogPublication] });
    await expect(getContentPackPublication("pack:one", "1.0.0+build.1")).resolves.toEqual({ catalog: ownerCatalog });
    await expect(getCampaignContentPack("campaign:one", "pack:one", "1.0.0+build.1")).resolves.toMatchObject({ catalog: { publication: catalogPublication } });
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).cache])).toEqual([
      ["/api/rpg/v1/content-packs?cursor=next_page&limit=2", "no-store"],
      ["/api/rpg/v1/content-packs/pack%3Aone/versions/1.0.0%2Bbuild.1", "no-store"],
      ["/api/rpg/v1/campaigns/campaign%3Aone/content-packs/pack%3Aone/versions/1.0.0%2Bbuild.1", "no-store"],
    ]);
    await expect(getContentPackPublication("bad/id", "1.0.0")).rejects.toBeInstanceOf(ApiInputError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("follows every opaque publication cursor and rejects cursor cycles", async () => {
    const second = { ...catalogPublication, packVersion: "2.0.0" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publications: [catalogPublication], nextCursor: "page_two" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ publications: [catalogPublication, second], nextCursor: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listAllContentPackPublications()).resolves.toEqual({ publications: [catalogPublication, second], nextCursor: null });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/rpg/v1/content-packs?limit=100",
      "/api/rpg/v1/content-packs?cursor=page_two&limit=100",
    ]);

    fetchMock.mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publications: [], nextCursor: "cycle" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ publications: [], nextCursor: "cycle" }), { status: 200 }));
    await expect(listAllContentPackPublications()).rejects.toThrow(/repeated a cursor/);
  });

  it("validates in memory then binds one exact immutable publication POST", async () => {
    const counts = ["race", "background", "class", "class-level", "skill", "ability", "spell", "item", "currency", "enemy-template"].map((kind) => ({ kind, count: kind === "race" ? 1 : 0 }));
    const report = { valid: true, issues: [], normalizedSummary: { totalDefinitions: 1, counts, digest: catalogDigest } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ report }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalog: ownerCatalog }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const draft = { manifest: catalogManifest, definitions: [catalogDefinition] };
    await expect(validateContentPackDraft(draft)).resolves.toEqual({ report });
    await expect(publishContentPack({ ...draft, idempotencyKey: "publish-one" })).resolves.toEqual({ catalog: ownerCatalog });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/rpg/v1/content-packs/validate", expect.objectContaining({ method: "POST", body: JSON.stringify(draft) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/rpg/v1/content-packs", expect.objectContaining({ method: "POST" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ catalog: { ...ownerCatalog, publication: { ...catalogPublication, packVersion: "2.0.0" } } }), { status: 201 }));
    await expect(publishContentPack({ ...draft, idempotencyKey: "publish-two" })).rejects.toThrow(/did not match/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ catalog: ownerCatalog }), { status: 200 }));
    await expect(publishContentPack({ ...draft, idempotencyKey: "publish-three" })).rejects.toThrow(/documented status/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("binds canonical definition content independently of response ordering", async () => {
    const skill = { reference: { packId: catalogManifest.packId, packVersion: catalogManifest.packVersion, definitionId: "skill", kind: "skill" as const }, name: "Skill", description: "Description", tags: [], mechanics: { attribute: "insight" as const } };
    const input = { idempotencyKey: "canonical-one", manifest: catalogManifest, definitions: [catalogDefinition, skill] };
    const reordered = { ...ownerCatalog, definitions: [skill, catalogDefinition] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalog: reordered }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ catalog: { ...reordered, definitions: [{ ...skill, name: "Changed" }, catalogDefinition] } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(publishContentPack(input)).resolves.toEqual({ catalog: reordered });
    await expect(publishContentPack({ ...input, idempotencyKey: "canonical-two" })).rejects.toThrow(/did not match/);
  });

  it("reads and binds one revision-safe complete campaign pin PUT", async () => {
    const content = { compatible: true, rulesProfileId: "rules", contentPacks: [{ packId: "pack:one", packVersion: "1.0.0+build.1", digest: catalogDigest }], issues: [] };
    const input = { rulesProfileId: "rules", contentPacks: [{ packId: "pack:one", packVersion: "1.0.0+build.1" }], expectedRevision: 4, idempotencyKey: "configure-one" };
    const receipt = { commandId: "command", idempotencyKey: input.idempotencyKey, revisionBefore: 4, revisionAfter: 5, configuredAt: catalogAt, content };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content, receipt }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCampaignContent("campaign:one")).resolves.toEqual({ content });
    await expect(configureCampaignContent("campaign:one", input)).resolves.toEqual({ content, receipt });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/rpg/v1/campaigns/campaign%3Aone/content", expect.objectContaining({ cache: "no-store" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/rpg/v1/campaigns/campaign%3Aone/content", expect.objectContaining({ method: "PUT", body: JSON.stringify(input) }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ content, receipt: { ...receipt, idempotencyKey: "other" } }), { status: 200 }));
    await expect(configureCampaignContent("campaign:one", input)).rejects.toThrow(/did not match/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("validates the legacy feature response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ voice: false, images: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(getFeatures()).resolves.toEqual({ voice: false, images: true });
  });

  it("rejects malformed feature values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ voice: "true", images: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    await expect(getFeatures()).rejects.toThrow();
  });

  it("runtime-validates RPG flags and the exact campaign list response", async () => {
    const flags = { campaign: true, mechanics: false, combat: false, studio: false, remoteAuthentication: false };
    const campaign = { id: "campaign-one", name: "Road", activeTimelineId: "timeline-one", ownerPrincipalId: "local-owner", actorRole: "owner", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-02T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(flags), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ campaigns: [campaign] }), { status: 200 })));

    await expect(getRpgFeatures()).resolves.toEqual(flags);
    await expect(listCampaigns()).resolves.toEqual({ campaigns: [campaign] });
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([
      "/api/rpg/v1/features",
      "/api/rpg/v1/campaigns",
    ]);
  });

  it("rejects malformed campaign list success bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ campaigns: [], extra: true }), { status: 200 })));
    await expect(listCampaigns()).rejects.toThrow();
  });

  it("strictly reads ID-free campaign dice history without caching", async () => {
    const body = { characters: [{ position: 1, name: "Same" }, { position: 2, name: "Same" }], rolls: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCampaignDiceHistory("campaign:one")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/rpg/v1/campaigns/campaign%3Aone/dice-rolls", expect.objectContaining({ cache: "no-store" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...body, campaignId: "secret" }), { status: 200 }));
    await expect(getCampaignDiceHistory("campaign:one")).rejects.toThrow();
  });

  it("validates and path-binds one campaign dice POST without retry", async () => {
    const input = { character: { position: 2, name: "Same" }, expression: "4d6kh3+2" } as const;
    const roll = { character: input.character, occurredAt: "2030-01-01T00:00:00.000Z", result: {
      expression: input.expression, normalized: { count: 4, sides: 6, selection: { type: "keep_highest", count: 3 }, modifier: 2 },
      terms: [{ value: 6, kept: true }, { value: 4, kept: true }, { value: 3, kept: true }, { value: 1, kept: false }], modifier: 2, total: 15,
    } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ roll }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(rollCampaignDice("campaign-one", input)).resolves.toEqual({ roll });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/rpg/v1/campaigns/campaign-one/dice-rolls", expect.objectContaining({
      method: "POST", body: JSON.stringify(input),
    }));

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ roll: { ...roll, character: { position: 1, name: "Other" } } }), { status: 201 }));
    await expect(rollCampaignDice("campaign-one", input)).rejects.toThrow(/did not match/);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ roll }), { status: 200 }));
    await expect(rollCampaignDice("campaign-one", input)).rejects.toThrow(/committed status/);

    for (const invalid of [
      [" campaign", input],
      ["campaign", { ...input, expression: "d20" }],
      ["campaign", { ...input, character: { position: 0, name: "Same" } }],
    ] as const) await expect(rollCampaignDice(invalid[0], invalid[1] as never)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("strictly validates campaign detail input and its exact response", async () => {
    const detail = { campaign: { id: "campaign-one", name: "Road", actorRole: "owner", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-02T00:00:00.000Z", content: { status: "unconfigured" } } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCampaignDetail("campaign-one")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rpg/v1/campaigns/campaign-one",
      expect.objectContaining({ cache: "no-store" }),
    );

    for (const invalid of ["", " campaign-one", "campaign one", "x".repeat(129)]) {
      await expect(getCampaignDetail(invalid)).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...detail, ownerPrincipalId: "private" }), { status: 200 }));
    await expect(getCampaignDetail("campaign-one")).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ campaign: { ...detail.campaign, id: "campaign-other" } }), { status: 200 }));
    await expect(getCampaignDetail("campaign-one")).rejects.toThrow();
  });

  it("strictly reads rooms and sends one exact opaque session ID PUT with bound response", async () => {
    const rooms = { attached: [], eligible: [{ sessionId: " opaque/session id ", title: null, participantNames: ["ليلى"], createdAt: "2030-01-01T00:00:00.000Z" }] };
    const attachment = { attachment: { sessionId: " opaque/session id ", attachedAt: "2030-01-02T00:00:00.000Z" } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rooms), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(attachment), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listCampaignRooms("campaign:one")).resolves.toEqual(rooms);
    await expect(attachCampaignRoom("campaign:one", { sessionId: " opaque/session id " })).resolves.toEqual(attachment);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/rpg/v1/campaigns/campaign%3Aone/rooms", expect.objectContaining({ cache: "no-store" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/rpg/v1/campaigns/campaign%3Aone/rooms", expect.objectContaining({ method: "PUT", body: '{"sessionId":" opaque/session id "}' }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ attachment: { ...attachment.attachment, sessionId: "other" } }), { status: 200 }));
    await expect(attachCampaignRoom("campaign:one", { sessionId: " opaque/session id " })).rejects.toThrow(/did not match/);
    for (const id of [" campaign", "bad/id", "x".repeat(129)]) await expect(listCampaignRooms(id)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("validates, encodes, and strictly parses the public campaign roster", async () => {
    const body = { characters: [
      { id: "entry-one", characterId: "persona-one", name: "Same name" },
      { id: "entry-two", characterId: "persona-two", name: "Same name" },
    ] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listCampaignCharacters("campaign:one")).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/rpg/v1/campaigns/campaign%3Aone/characters");
  });

  it("rejects invalid roster IDs before fetch and malformed or private success fields", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const id of ["", " campaign-one", "campaign/one", "x".repeat(129)]) {
      await expect(listCampaignCharacters(id)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();

    for (const body of [
      { characters: [{ id: "entry-one", characterId: "persona-one", name: "Aria", controllerPrincipalId: "private" }] },
      { characters: [{ id: "entry-one", characterId: "persona-one", name: "Aria" }], campaignId: "campaign-one" },
      { characters: [{ id: "entry-one", characterId: "persona-one", name: "Aria" }, { id: "entry-one", characterId: "persona-two", name: "Other" }] },
      { characters: [{ id: "entry-one", characterId: "persona-one", name: "\ud800" }] },
    ]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(listCampaignCharacters("campaign-one")).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("validates and encodes both workspace IDs and strictly parses the ID-free response", async () => {
    const body = { character: {
      name: "Aria", race: { name: "Avelune", description: "Moonlit." }, background: { name: "Rainledger", description: "A traveler." },
      classes: [{ name: "Pathmender", description: "Restores paths.", level: 1 }],
      attributes: [{ label: "Attribute 1", value: 12 }],
      proficiencies: [{ category: "skill", label: "Skill proficiency 1" }],
      choices: [{ label: "Choice 1", selection: { kind: "race", name: "Choice name", description: "Choice description." } }],
      resources: [{ label: "Resource 1", current: 2, max: 3 }],
    } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCampaignCharacterWorkspace("campaign:one", "entry:one")).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/rpg/v1/campaigns/campaign%3Aone/characters/entry%3Aone/workspace");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ cache: "no-store" }));

    for (const [campaignId, characterId] of [[" campaign", "entry"], ["campaign", "bad/id"], ["campaign", ""]]) {
      await expect(getCampaignCharacterWorkspace(campaignId!, characterId!)).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...body, campaignId: "private" }), { status: 200 }));
    await expect(getCampaignCharacterWorkspace("campaign", "entry")).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ character: { ...body.character, id: "private" } }), { status: 200 }));
    await expect(getCampaignCharacterWorkspace("campaign", "entry")).rejects.toThrow();
  });

  it("strictly parses and path-binds campaign character creation options", async () => {
    const starter = {
      rulesProfile: { rulesProfileId: "velvet:rules:original-narrative", name: "Velvet Original Narrative", description: "Metadata identity for Velvet's original narrative starter concepts." },
      pack: { packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818", rulesProfileId: "velvet:rules:original-narrative", name: "Velvet Original Starter", description: "A small original fantasy collection for future campaign setup." },
      race: { reference: { packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818", definitionId: "velvet:original-starter:race:avelune", kind: "race" }, name: "Avelune", description: "Avelune communities gather around drifting lights and preserve family stories in woven night banners." },
      background: { reference: { packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818", definitionId: "velvet:original-starter:background:rainledger", kind: "background" }, name: "Rainledger", description: "Rainledgers once recorded seasonal journeys, local customs, and promises exchanged between distant settlements." },
      class: { reference: { packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818", definitionId: "velvet:original-starter:class:pathmender", kind: "class" }, name: "Pathmender", description: "Pathmenders travel between isolated communities, carrying news and helping neighbors restore neglected meeting places.", level: 1 },
    };
    const body = { campaignId: "campaign:one", personas: [{ characterId: "opaque-persona", name: "Aria", alreadyUsed: false }], starter };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCampaignCharacterCreationOptions("campaign:one")).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/rpg/v1/campaigns/campaign%3Aone/characters/creation-options");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...body, campaignId: "other" }), { status: 200 }));
    await expect(getCampaignCharacterCreationOptions("campaign:one")).rejects.toThrow(/did not match/);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...body, privateNotes: "secret" }), { status: 200 }));
    await expect(getCampaignCharacterCreationOptions("campaign:one")).rejects.toThrow();
  });

  it("validates and binds original-starter character create while issuing exactly one POST", async () => {
    const result = { character: { id: "entry-one", characterId: "persona-one", name: "Aria" } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createOriginalStarterCampaignCharacter("campaign-one", { characterId: "persona-one" })).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/rpg/v1/campaigns/campaign-one/characters", expect.objectContaining({
      method: "POST", body: JSON.stringify({ characterId: "persona-one" }),
    }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ character: { ...result.character, characterId: "other" } }), { status: 201 }));
    await expect(createOriginalStarterCampaignCharacter("campaign-one", { characterId: "persona-one" })).rejects.toThrow(/did not match/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid character create input before network I/O", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [campaignId, characterId] of [[" campaign", "persona"], ["campaign", ""]]) {
      await expect(createOriginalStarterCampaignCharacter(campaignId!, { characterId: characterId! })).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes campaign creation and validates its exact response", async () => {
    const campaign = { id: "campaign-one", name: "Road", activeTimelineId: "timeline-one", ownerPrincipalId: "local-owner", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ campaign }), { status: 201 })));
    await expect(createCampaign({ name: "  Road  " })).resolves.toEqual({ campaign });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/rpg/v1/campaigns", expect.objectContaining({
      method: "POST", body: JSON.stringify({ name: "Road" }),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ campaign, extra: true }), { status: 201 })));
    await expect(createCampaign({ name: "Road" })).rejects.toThrow();
  });

  it("rejects invalid campaign creation before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createCampaign({ name: " " })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes and runtime-validates stale-safe campaign rename", async () => {
    const result = { campaign: { id: "campaign-one", name: "New Road", updatedAt: "2030-01-03T00:00:00.000Z" } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(renameCampaign("campaign-one", { name: "  New Road  ", expectedUpdatedAt: "2030-01-02T00:00:00.000Z" })).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/rpg/v1/campaigns/campaign-one", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "New Road", expectedUpdatedAt: "2030-01-02T00:00:00.000Z" }),
    }));
  });

  it("rejects invalid rename input before fetch and rejects malformed or mismatched success", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const valid = { name: "Road", expectedUpdatedAt: "2030-01-02T00:00:00.000Z" };
    for (const [id, input] of [
      [" campaign-one", valid],
      ["campaign-one", { ...valid, name: " " }],
      ["campaign-one", { ...valid, expectedUpdatedAt: "not-a-time" }],
    ] as const) await expect(renameCampaign(id, input)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    for (const body of [
      { campaign: { id: "campaign-one", name: "Road", updatedAt: valid.expectedUpdatedAt }, extra: true },
      { campaign: { id: "other", name: "Road", updatedAt: valid.expectedUpdatedAt } },
      { campaign: { id: "campaign-one", name: "Different", updatedAt: valid.expectedUpdatedAt } },
      { campaign: { id: "campaign-one", name: "Road", updatedAt: "2030-01-01T00:00:00.000Z" } },
    ]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
      await expect(renameCampaign("campaign-one", valid)).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("preserves rename API problem status and code in ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      type: "https://velvet.local/problems/rpg-campaign-rename-stale", title: "Conflict", status: 409,
      detail: "Campaign rename precondition is stale", code: "RPG_CAMPAIGN_RENAME_STALE", requestId: "rename-1",
      error: "Campaign rename precondition is stale",
    }), { status: 409, headers: { "Content-Type": "application/problem+json" } })));
    const error = await renameCampaign("campaign-one", { name: "Road", expectedUpdatedAt: "2030-01-02T00:00:00.000Z" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "RPG_CAMPAIGN_RENAME_STALE", requestId: "rename-1" });
  });

  it("sends the only fixed starter body and validates exact configured detail", async () => {
    const detail = { campaign: {
      id: "campaign-one", name: "Road", actorRole: "owner", createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-02T00:00:00.000Z", content: { status: "configured", rulesProfileId: "velvet:rules:original-narrative",
        contentPacks: [{ packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818" }] },
    } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(setupOriginalStarter("campaign-one")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith("/api/rpg/v1/campaigns/campaign-one/starter-setup", expect.objectContaining({
      method: "PUT", body: JSON.stringify({ starterId: "velvet:original-starter@1.0.0+d15042935818" }),
    }));
  });

  it("rejects invalid starter campaign IDs and malformed or non-exact success", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(setupOriginalStarter(" campaign-one")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();

    const base = { id: "campaign-one", name: "Road", actorRole: "owner", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-02T00:00:00.000Z" };
    for (const campaign of [
      { ...base, id: "other", content: { status: "unconfigured" } },
      { ...base, content: { status: "unconfigured" } },
      { ...base, actorRole: "player", content: { status: "configured", rulesProfileId: "velvet:rules:original-narrative", contentPacks: [{ packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818" }] } },
      { ...base, content: { status: "configured", rulesProfileId: "other", contentPacks: [] } },
      { ...base, content: { status: "configured", rulesProfileId: "velvet:rules:original-narrative", contentPacks: [{ packId: "velvet:original-starter", packVersion: "1.0.0+d15042935818" }] }, extra: true },
    ]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ campaign }), { status: 200 }));
      await expect(setupOriginalStarter("campaign-one")).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("sends one fixed mechanics starter PUT and path-binds strict exact output", async () => {
    const detail = { campaign: {
      id: "campaign-one", name: "Road", actorRole: "owner", createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-02T00:00:00.000Z", content: { status: "configured", rulesProfileId: "velvet:rules:starter-v1",
        contentPacks: [{ packId: "velvet:mechanics-starter", packVersion: "1.1.0+2f9199b5696d" }] },
    } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(setupMechanicsStarter("campaign:one")).rejects.toThrow(/did not match/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rpg/v1/campaigns/campaign%3Aone/mechanics-starter-setup",
      expect.objectContaining({
        method: "PUT", cache: "no-store",
        body: JSON.stringify({ starterId: "velvet:mechanics-starter@1.1.0+2f9199b5696d" }),
      }),
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }));
    await expect(setupMechanicsStarter("campaign-one")).resolves.toEqual(detail);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...detail, commandId: "private" }), { status: 200 }));
    await expect(setupMechanicsStarter("campaign-one")).rejects.toThrow();
    await expect(setupMechanicsStarter(" campaign-one")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([201, 202, 204])("rejects mechanics setup HTTP %s before parsing a success body", async (status) => {
    const body = status === 204 ? null : JSON.stringify({ private: "must-not-be-accepted" });
    const response = new Response(body, { status });
    const jsonSpy = vi.spyOn(response, "json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(setupMechanicsStarter("campaign-one")).rejects.toThrow(/committed status/);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("binds membership role and exact operation receipts and distinguishes invalid local input", async () => {
    const at = "2030-01-02T00:00:00.000Z";
    const receipt = (type: "membership_added" | "membership_role_changed") => ({
      commandId: "command-one", campaignId: "campaign-one", type, revisionBefore: 4, revisionAfter: 5, occurredAt: at,
      events: [{ eventId: "event-one", commandId: "command-one", campaignId: "campaign-one", type, revision: 5, occurredAt: at,
        data: { principalId: "member-one", role: "gm" } }],
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ membership: { principalId: "member-one", role: "player", createdAt: at }, receipt: receipt("membership_added") }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ membership: { principalId: "member-one", role: "gm", createdAt: at }, receipt: receipt("membership_added") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(addCampaignAdministrationMembership("campaign-one", { principalId: "member-one", role: "gm", expectedRevision: 4, idempotencyKey: "add-one" }))
      .rejects.toThrow(/did not match/);
    await expect(updateCampaignAdministrationMembership("campaign-one", "member-one", { role: "gm", expectedRevision: 4, idempotencyKey: "role-one" }))
      .rejects.toThrow(/did not match/);
    await expect(addCampaignAdministrationMembership("campaign-one", { principalId: "bad/id", role: "gm", expectedRevision: 4, idempotencyKey: "bad" }))
      .rejects.toBeInstanceOf(ApiInputError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires a strict checkpoint envelope and binds checkpoint resource and event data", async () => {
    const at = "2030-01-02T00:00:00.000Z";
    const checkpoint = { id: "checkpoint-one", timelineId: "timeline-one", timelineRevision: 7, label: "Before the gate", createdAt: at };
    const receipt = { commandId: "command-one", type: "checkpoint_created", revisionBefore: 4, revisionAfter: 5, occurredAt: at,
      events: [{ eventId: "event-one", commandId: "command-one", type: "checkpoint_created", revision: 5, occurredAt: at,
        data: { timelineId: "timeline-one", timelineRevision: 7, label: "Before the gate" } }] };
    const input = { timelineId: "timeline-one", timelineRevision: 7, label: "Before the gate", expectedRevision: 4, idempotencyKey: "checkpoint-command" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ checkpoints: [], extra: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ checkpoint: { ...checkpoint, createdAt: "2030-01-03T00:00:00.000Z" }, receipt }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ checkpoint, receipt: { ...receipt, events: [{ ...receipt.events[0], data: { ...receipt.events[0].data, label: "Wrong" } }] } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listCampaignCheckpoints("campaign-one")).rejects.toThrow(/malformed/);
    await expect(createCampaignCheckpoint("campaign-one", input)).rejects.toThrow(/did not match/);
    await expect(createCampaignCheckpoint("campaign-one", input)).rejects.toThrow(/did not match/);
  });

  it("binds a fork receipt to the requested checkpoint and exact timeline ancestry", async () => {
    const at = "2030-01-02T00:00:00.000Z";
    const checkpoint = { id: "checkpoint-one", timelineId: "timeline-one", timelineRevision: 7 };
    const input = { checkpointId: checkpoint.id, expectedRevision: 4, idempotencyKey: "fork-command" };
    const receipt = { commandId: "command-one", type: "timeline_forked", revisionBefore: 4, revisionAfter: 5, occurredAt: at,
      events: [{ eventId: "event-one", commandId: "command-one", type: "timeline_forked", revision: 5, occurredAt: at,
        data: { checkpointId: checkpoint.id } }] };
    const timeline = { id: "timeline-two", parentTimelineId: "wrong-parent", forkedFromRevision: 7, revision: 7, createdAt: at, active: true };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ timeline, receipt }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ timeline: { ...timeline, parentTimelineId: checkpoint.timelineId }, receipt: { ...receipt,
        events: [{ ...receipt.events[0], data: { checkpointId: "checkpoint-other" } }] } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(forkCampaignTimeline("campaign-one", input, checkpoint)).rejects.toThrow(/did not match/);
    await expect(forkCampaignTimeline("campaign-one", input, checkpoint)).rejects.toThrow(/did not match/);
    await expect(forkCampaignTimeline("campaign-one", input, { ...checkpoint, id: "checkpoint-other" })).rejects.toBeInstanceOf(ApiInputError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("decodes structured API problems without breaking legacy fields", async () => {
    const response = new Response(JSON.stringify({
      type: "https://velvet.local/problems/rpg-route-not-found",
      title: "Not found",
      status: 404,
      detail: "RPG route not found",
      code: "RPG_ROUTE_NOT_FOUND",
      requestId: "request-42",
      error: "RPG route not found",
    }), {
      status: 404,
      headers: { "Content-Type": "application/problem+json", "X-Request-Id": "request-42" },
    });
    const error = await errorFromResponse(response);
    expect(error.message).toBe("RPG route not found");
    expect(error.code).toBe("RPG_ROUTE_NOT_FOUND");
    expect(error.requestId).toBe("request-42");
  });
});

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hydrateCampaign, type HydrationRecipe } from "../hydrate-campaign.js";

const baseRecipe = (count = 2): HydrationRecipe => ({ version: 1, name: "Test world", tone: "measured", stages: [{ id: "world", jobs: [{ id: "places", sections: ["locations"], brief: "Create distinct places.", desiredCounts: { locations: count } }] }] });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class FakeApi {
  calls: Array<{ path: string; method: string; body: any }> = [];
  attempts = new Map<string, number>();
  states = new Map<string, { state: string; attempt: number; draftId: string | null }>();
  drafts = new Map<string, any>();
  active = 0;
  peak = 0;
  staleApplies = 0;
  generation: (body: any, api: FakeApi) => Promise<Response>;

  constructor(generation?: (body: any, api: FakeApi) => Promise<Response>) {
    this.generation = generation ?? (async (body) => this.success(body));
  }

  success(body: any, count?: number): Response {
    const target = body.brief.match(/(\d+) ([A-Za-z]+)/), requested = count ?? Number(target?.[1] ?? 1), field = target?.[2] ?? "locations";
    const preview = { [field]: Array.from({ length: requested }, (_, index) => ({ key: `artifact-${this.drafts.size + 1}-${index}`, visibility: "public" })) };
    return this.successPreview(body, preview);
  }

  successPreview(body: any, preview: Record<string, unknown>): Response {
    const id = `draft-${this.drafts.size + 1}`;
    const draft = { draft: { draftId: id, campaignId: body.campaignId, state: "staged", revision: 0 }, preview };
    this.drafts.set(id, draft); this.states.set(body.idempotencyKey, { state: "succeeded", attempt: this.attempts.get(body.idempotencyKey) ?? 1, draftId: id }); return json(201, draft);
  }

  confirmedFailure(body: any): Response {
    const attempt = (this.attempts.get(body.idempotencyKey) ?? 0) + 1; this.attempts.set(body.idempotencyKey, attempt);
    this.states.set(body.idempotencyKey, { state: "failed", attempt, draftId: null }); return json(503, { code: "RPG_GENERATION_UNAVAILABLE" });
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url), path = url.pathname, method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push({ path, method, body });
    if (path.endsWith("/reconcile")) { const state = this.states.get(body.idempotencyKey) ?? { state: "not-found", attempt: 0, draftId: null }; return json(200, { campaignId: body.campaignId, idempotencyKey: body.idempotencyKey, ...state }); }
    if (method === "POST" && path.endsWith("/campaign-content-drafts")) { this.active++; this.peak = Math.max(this.peak, this.active); try { return await this.generation(body, this); } finally { this.active--; } }
    const apply = path.match(/\/campaign-content-drafts\/([^/]+)\/apply$/); if (apply) { const draft = this.drafts.get(apply[1]!); if (this.staleApplies > 0) { this.staleApplies--; return json(409, { code: "RPG_GENERATION_DRAFT_CONFLICT" }); } draft.draft.state = "applied"; return json(200, { draft: draft.draft, application: {}, receipts: [] }); }
    const read = path.match(/\/campaign-content-drafts\/([^/]+)$/); if (read) return this.drafts.has(read[1]!) ? json(200, this.drafts.get(read[1]!)) : json(404, { code: "NOT_FOUND" });
    return json(404, { code: "NOT_FOUND" });
  };
}

async function ledgerPath(): Promise<string> { return join(await mkdtemp(join(tmpdir(), "velvet-hydrate-")), "ledger.json"); }
async function run(recipe: HydrationRecipe, api: FakeApi, path: string, concurrency?: number, allowStaleRegeneration = false, log: (message: string) => void = () => {}) { return hydrateCampaign({ recipe, apiBase: "http://fake", campaignId: "campaign-1", ledgerPath: path, ...(concurrency === undefined ? {} : { concurrency }), ...(allowStaleRegeneration ? { allowStaleRegeneration: true } : {}), fetch: api.fetch, log }); }

test("bisects after two confirmed failures and preserves the parent key", async () => {
  let parentKey: string | null = null;
  const api = new FakeApi(async (body, current) => { parentKey ??= body.idempotencyKey; return body.idempotencyKey === parentKey ? current.confirmedFailure(body) : current.success(body); });
  const ledger = await run(baseRecipe(4), api, await ledgerPath());
  const parent = ledger.works.places!;
  assert.equal(parent.status, "expanded"); assert.equal(parent.children.length, 2);
  const parentPosts = api.calls.filter((call) => call.path.endsWith("campaign-content-drafts") && call.body.idempotencyKey === parent.idempotencyKey);
  assert.equal(parentPosts.length, 2); assert.equal(parentPosts[1]!.body.retryFailedAttempt.failedAttempt, 1);
  assert.deepEqual(parentPosts.map((call) => call.body.sections), [["locations"], ["locations"]]);
  assert.deepEqual(parent.children.map((id) => ledger.works[id]!.desiredCounts.locations ?? 0).sort((a, b) => a - b), [2, 2]);
  assert.ok(parent.children.every((id) => ledger.works[id]!.status === "applied"));
});

test("bisects an odd single-section count into exact 2 and 3 prompts", async () => {
  const recipe: HydrationRecipe = { version: 1, name: "Odd encounters", tone: "measured", stages: [{ id: "play", jobs: [{ id: "encounters", sections: ["encounters"], brief: "Create encounters.", desiredCounts: { encounters: 5 } }] }] };
  let parentKey: string | null = null;
  const api = new FakeApi(async (body, current) => { parentKey ??= body.idempotencyKey; return body.idempotencyKey === parentKey ? current.confirmedFailure(body) : current.success(body); });
  const ledger = await run(recipe, api, await ledgerPath()), children = ledger.works.encounters!.children.map((id) => ledger.works[id]!);
  assert.deepEqual(children.map((work) => work.desiredCounts.encounters ?? 0).sort((a, b) => a - b), [2, 3]);
  const childPrompts = api.calls.filter((call) => call.path.endsWith("campaign-content-drafts") && call.body.idempotencyKey !== parentKey).map((call) => call.body.brief);
  assert.ok(childPrompts.some((brief) => brief.includes("2 encounters"))); assert.ok(childPrompts.some((brief) => brief.includes("3 encounters")));
});

test("records a graceful deficit after two failures at the unit floor", async () => {
  const api = new FakeApi(async (body, current) => current.confirmedFailure(body)), messages: string[] = [];
  const ledger = await run(baseRecipe(1), api, await ledgerPath(), undefined, false, (message) => messages.push(message));
  assert.equal(ledger.works.places!.status, "deficit");
  assert.equal(api.calls.filter((call) => call.path.endsWith("campaign-content-drafts")).length, 2);
  assert.ok(messages.at(-1)?.includes("1 unit-floor deficit"));
});

test("stops on an outcome-uncertain generation without retry", async () => {
  const api = new FakeApi(async () => { throw new Error("connection lost"); });
  await assert.rejects(run(baseRecipe(), api, await ledgerPath()), /outcomes could not be confirmed|reconciliation state/);
  assert.equal(api.calls.filter((call) => call.path.endsWith("campaign-content-drafts")).length, 1);
});

test("applies sparse success and creates additive fill work", async () => {
  let first = true; const api = new FakeApi(async (body, current) => { if (first) { first = false; return current.success(body, 1); } return current.success(body); });
  const ledger = await run(baseRecipe(3), api, await ledgerPath()), parent = ledger.works.places!;
  assert.equal(parent.status, "expanded"); assert.equal(parent.children.length, 1);
  assert.deepEqual(ledger.works[parent.children[0]!]!.desiredCounts, { locations: 2 });
  assert.equal(ledger.works[parent.children[0]!]!.status, "applied");
});

test("resume neither redispatches nor reapplies completed work", async () => {
  const path = await ledgerPath(), api = new FakeApi(); await run(baseRecipe(), api, path); const prior = api.calls.length;
  await run(baseRecipe(), api, path); assert.equal(api.calls.length, prior);
  assert.doesNotMatch(await readFile(path, "utf8"), /apiKey/i);
});

test("stages serially even when a wider concurrency is requested", async () => {
  const recipe: HydrationRecipe = { version: 1, name: "Pool", tone: "calm", stages: [{ id: "parallel", jobs: Array.from({ length: 5 }, (_, index) => ({ id: `job-${index}`, sections: ["locations"], brief: "Place", desiredCounts: { locations: 1 } })) }] };
  const api = new FakeApi(async (body, current) => { await new Promise((resolve) => setTimeout(resolve, 15)); return current.success(body); });
  const messages: string[] = [];
  await run(recipe, api, await ledgerPath(), 2, true, (message) => messages.push(message));
  // Same-campaign drafts snapshot one content revision, so staging is serial by design even when
  // a wider cap is requested; the flag is accepted with a warning, never a worker pool.
  assert.equal(api.peak, 1);
  assert.ok(messages[0]?.startsWith("WARNING:"));
});

test("defaults to serial staging and rejects unsafe wider staging", async () => {
  const recipe: HydrationRecipe = { version: 1, name: "Serial", tone: "calm", stages: [{ id: "parallel", jobs: Array.from({ length: 3 }, (_, index) => ({ id: `serial-${index}`, sections: ["locations"], brief: "Place", desiredCounts: { locations: 1 } })) }] };
  const serialApi = new FakeApi(async (body, current) => { await new Promise((resolve) => setTimeout(resolve, 10)); return current.success(body); });
  await run(recipe, serialApi, await ledgerPath()); assert.equal(serialApi.peak, 1);
  const rejectedApi = new FakeApi(); await assert.rejects(run(recipe, rejectedApi, await ledgerPath(), 2), /requires --allow-stale-regeneration/); assert.equal(rejectedApi.calls.length, 0);
});

test("does not regenerate a stale paid draft until explicitly authorized", async () => {
  const path = await ledgerPath(), api = new FakeApi(); api.staleApplies = 1;
  await assert.rejects(run(baseRecipe(1), api, path), /rerun with --allow-stale-regeneration/);
  assert.equal(api.calls.filter((call) => call.path.endsWith("campaign-content-drafts")).length, 1);
  const ledger = await run(baseRecipe(1), api, path, undefined, true);
  assert.equal(api.calls.filter((call) => call.path.endsWith("campaign-content-drafts")).length, 2);
  assert.equal(ledger.works.places!.status, "expanded");
  assert.equal(ledger.works[ledger.works.places!.children[0]!]!.status, "applied");
});

test("changed recipe is rejected before any API call", async () => {
  const path = await ledgerPath(), api = new FakeApi(); await run(baseRecipe(1), api, path); const prior = api.calls.length;
  await assert.rejects(run(baseRecipe(2), api, path), /recipe digest differs/); assert.equal(api.calls.length, prior);
});

test("feeds generated public keys rather than predicted keys to a dependent request", async () => {
  const recipe: HydrationRecipe = { version: 1, name: "Dynamic", tone: "calm", stages: [
    { id: "sources", jobs: [{ id: "factions", sections: ["factions"], brief: "Factions", desiredCounts: { factions: 2 } }] },
    { id: "dependents", dependsOn: ["sources"], jobs: [{ id: "cast", sections: ["npcs"], brief: "Cast", expandFrom: [{ jobId: "factions", fields: ["factions"] }], desiredCounts: { npcs: 1 } }] },
  ] };
  const api = new FakeApi(async (body, current) => body.sections.includes("factions")
    ? current.successPreview(body, { factions: [{ key: "generated-copper-union", visibility: "public" }, { key: "generated-ash-league", visibility: "public" }] })
    : current.success(body));
  const ledger = await run(recipe, api, await ledgerPath());
  const cast = api.calls.find((call) => call.path.endsWith("campaign-content-drafts") && call.body.sections.includes("npcs"));
  assert.deepEqual(cast?.body.expandArtifactKeys, ["generated-copper-union", "generated-ash-league"]);
  assert.deepEqual(ledger.works.factions!.acceptedPublicArtifactKeys, { factions: ["generated-copper-union", "generated-ash-league"] });
});

test("excludes GM-only source artifacts from dynamic expansion", async () => {
  const recipe: HydrationRecipe = { version: 1, name: "Visibility", tone: "calm", stages: [
    { id: "sources", jobs: [{ id: "places", sections: ["locations"], brief: "Places", desiredCounts: { locations: 2 } }] },
    { id: "dependents", dependsOn: ["sources"], jobs: [{ id: "lore", sections: ["lore"], brief: "Lore", expandFrom: [{ jobId: "places", fields: ["locations"] }], desiredCounts: { lore: 1 } }] },
  ] };
  const api = new FakeApi(async (body, current) => body.sections.includes("locations")
    ? current.successPreview(body, { locations: [{ key: "public-yard", visibility: "public" }, { key: "secret-vault", visibility: "gm" }] })
    : current.success(body));
  const ledger = await run(recipe, api, await ledgerPath());
  const lore = api.calls.find((call) => call.path.endsWith("campaign-content-drafts") && call.body.sections.includes("lore"));
  assert.deepEqual(lore?.body.expandArtifactKeys, ["public-yard"]);
  assert.deepEqual(ledger.works.places!.acceptedPublicArtifactKeys, { locations: ["public-yard"] });
});

test("rejects expansion allocations above 16 and invalid forward references", async () => {
  const tooWide = { version: 1, name: "Wide", tone: "calm", stages: [
    { id: "source", jobs: [{ id: "source-job", sections: ["locations"], brief: "Source", desiredCounts: { locations: 16 } }] },
    { id: "target", dependsOn: ["source"], jobs: [{ id: "target-job", sections: ["lore"], brief: "Target", expandArtifactKeys: ["fixed"], expandFrom: [{ jobId: "source-job", fields: ["locations"], limit: 16 }], desiredCounts: { lore: 1 } }] },
  ] } as HydrationRecipe;
  const forward = { version: 1, name: "Forward", tone: "calm", stages: [
    { id: "target", dependsOn: ["source"], jobs: [{ id: "target-job", sections: ["lore"], brief: "Target", expandFrom: [{ jobId: "source-job", fields: ["locations"] }], desiredCounts: { lore: 1 } }] },
    { id: "source", jobs: [{ id: "source-job", sections: ["locations"], brief: "Source", desiredCounts: { locations: 1 } }] },
  ] } as HydrationRecipe;
  const api = new FakeApi();
  await assert.rejects(run(tooWide, api, await ledgerPath()), /more than 16 combined expansion keys/);
  await assert.rejects(run(forward, api, await ledgerPath()), /earlier dependency-reachable stage/);
  assert.equal(api.calls.length, 0);
});

test("collects public artifacts from bisection descendants in output order", async () => {
  const recipe: HydrationRecipe = { version: 1, name: "Split expansion", tone: "calm", stages: [
    { id: "seed", jobs: [{ id: "factions", sections: ["factions"], brief: "Faction", desiredCounts: { factions: 1 } }] },
    { id: "source", dependsOn: ["seed"], jobs: [{ id: "places", sections: ["locations"], brief: "Places", expandFrom: [{ jobId: "factions", fields: ["factions"] }], desiredCounts: { locations: 4 } }] },
    { id: "target", dependsOn: ["source"], jobs: [{ id: "cast", sections: ["npcs"], brief: "Cast", expandFrom: [{ jobId: "places", fields: ["locations"] }], desiredCounts: { npcs: 1 } }] },
  ] };
  let parentKey: string | null = null;
  const api = new FakeApi(async (body, current) => {
    if (!body.sections.includes("locations")) return current.success(body);
    parentKey ??= body.idempotencyKey;
    return body.idempotencyKey === parentKey ? current.confirmedFailure(body) : current.success(body);
  });
  const ledger = await run(recipe, api, await ledgerPath()), children = ledger.works.places!.children;
  const expected = children.flatMap((id) => ledger.works[id]!.acceptedPublicArtifactKeys!.locations!);
  const cast = api.calls.find((call) => call.path.endsWith("campaign-content-drafts") && call.body.sections.includes("npcs"));
  assert.ok(children.every((id) => JSON.stringify(ledger.works[id]!.resolvedExpandArtifactKeys) === JSON.stringify(ledger.works.places!.resolvedExpandArtifactKeys)));
  assert.deepEqual(cast?.body.expandArtifactKeys, expected);
  assert.equal(expected.length, 4);
});

test("freezes resolved expansion keys across resume", async () => {
  const recipe: HydrationRecipe = { version: 1, name: "Stable resume", tone: "calm", stages: [
    { id: "source", jobs: [{ id: "places", sections: ["locations"], brief: "Places", desiredCounts: { locations: 1 } }] },
    { id: "target", dependsOn: ["source"], jobs: [{ id: "cast", sections: ["npcs"], brief: "Cast", expandFrom: [{ jobId: "places", fields: ["locations"] }], desiredCounts: { npcs: 1 } }] },
  ] };
  const path = await ledgerPath(), api = new FakeApi(), first = await run(recipe, api, path), frozen = first.works.cast!.resolvedExpandArtifactKeys;
  const priorCalls = api.calls.length, resumed = await run(recipe, api, path);
  assert.deepEqual(resumed.works.cast!.resolvedExpandArtifactKeys, frozen);
  assert.equal(api.calls.length, priorCalls);
});

test("rejects a selector-only recipe change against an existing ledger", async () => {
  const recipe = (limit: number): HydrationRecipe => ({ version: 1, name: "Selector digest", tone: "calm", stages: [
    { id: "source", jobs: [{ id: "places", sections: ["locations"], brief: "Places", desiredCounts: { locations: 2 } }] },
    { id: "target", dependsOn: ["source"], jobs: [{ id: "cast", sections: ["npcs"], brief: "Cast", expandFrom: [{ jobId: "places", fields: ["locations"], limit }], desiredCounts: { npcs: 1 } }] },
  ] });
  const path = await ledgerPath(), api = new FakeApi(); await run(recipe(1), api, path); const prior = api.calls.length;
  await assert.rejects(run(recipe(2), api, path), /recipe digest differs/);
  assert.equal(api.calls.length, prior);
});

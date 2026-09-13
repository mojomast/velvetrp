#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SECTIONS = ["outline", "arcs", "locations", "factions", "npcs", "quests", "encounters", "clues", "story", "lore", "quest-items", "monster-concepts", "handouts", "scene-prompts"] as const;
type Section = typeof SECTIONS[number];
type Fetch = typeof globalThis.fetch;
type WorkStatus = "pending" | "dispatching" | "staged" | "applying" | "applied" | "expanded" | "deficit" | "stale" | "uncertain" | "failed";

export interface RecipeJob {
  id: string;
  sections: Section[];
  brief: string;
  tone?: string;
  exclusions?: string[];
  expandArtifactKeys?: string[];
  expandFrom?: Array<{ jobId: string; fields: string[]; limit?: number }>;
  revisionFeedback?: string | null;
  desiredCounts: Record<string, number>;
  minCount?: number;
}
export interface RecipeStage { id: string; dependsOn?: string[]; jobs: RecipeJob[] }
export interface HydrationRecipe { version: 1; name: string; tone: string; exclusions?: string[]; stages: RecipeStage[] }
interface DraftView { draft: { draftId: string; campaignId: string; state: "staged" | "approved" | "applied"; revision: number }; preview: Record<string, unknown> }
interface Work {
  id: string; rootId: string; stageId: string; path: string; status: WorkStatus; idempotencyKey: string;
  sections: Section[]; brief: string; tone: string; exclusions: string[]; expandArtifactKeys: string[];
  expandFrom: Array<{ jobId: string; fields: string[]; limit?: number }>; resolvedExpandArtifactKeys?: string[];
  revisionFeedback: string | null; desiredCounts: Record<string, number>; minCount: number; confirmedFailures: number;
  failedAttempt?: number; draft?: DraftView; acceptedPublicArtifactKeys?: Record<string, string[]>; children: string[]; reason?: string;
}
interface Ledger {
  schemaVersion: 1; recipeDigest: string; recipeName: string; apiBase: string; campaignId: string | null;
  createdCampaign: boolean; creationStatus: "not-requested" | "pending" | "dispatching" | "complete";
  createCampaignName?: string; starterSetup?: { starter: "original" | "mechanics" | "srd-5.1"; status: "dispatching" | "complete" };
  works: Record<string, Work>; updatedAt: string;
}
export interface HydrateOptions {
  recipe: HydrationRecipe; apiBase: string; campaignId?: string; createCampaign?: string; starter?: "original" | "mechanics" | "srd-5.1";
  ledgerPath: string; concurrency?: number; dryRun?: boolean; requireProvider?: boolean; providerModel?: string;
  allowStaleRegeneration?: boolean;
  fetch?: Fetch; log?: (message: string) => void;
}

const FIELD_SECTIONS: Record<string, Section> = {
  outlines: "outline", arcs: "arcs", locations: "locations", connections: "locations", factions: "factions", npcs: "npcs",
  quests: "quests", encounters: "encounters", clues: "clues", storyNodes: "story", storyRelationships: "story", lore: "lore",
  questItems: "quest-items", monsterConcepts: "monster-concepts", handouts: "handouts", scenePrompts: "scene-prompts",
};
const STARTERS = {
  original: { path: "starter-setup", starterId: "velvet:original-starter@1.0.0+d15042935818" },
  mechanics: { path: "mechanics-starter-setup", starterId: "velvet:mechanics-starter@1.1.0+2f9199b5696d" },
  "srd-5.1": { path: "mechanics-starter-setup", starterId: "srd-5.1:starter@1.4.0+dc8659693163" },
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function fail(message: string): never { throw new Error(message); }
function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`); return value as Record<string, unknown>; }
function text(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`); return value.trim(); }
function strings(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) fail(`${label} must be an array of non-empty strings`); return value.map((item) => (item as string).trim()); }

export function parseRecipe(value: unknown): HydrationRecipe {
  const raw = object(value, "recipe");
  if (raw.version !== 1) fail("recipe.version must be 1");
  const name = text(raw.name, "recipe.name"), tone = text(raw.tone, "recipe.tone");
  const exclusions = raw.exclusions === undefined ? [] : strings(raw.exclusions, "recipe.exclusions");
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) fail("recipe.stages must be a non-empty array");
  const stageIds = new Set<string>(), jobIds = new Set<string>();
  const stages = raw.stages.map((entry, stageIndex): RecipeStage => {
    const stage = object(entry, `stages[${stageIndex}]`), id = text(stage.id, `stages[${stageIndex}].id`);
    if (stageIds.has(id)) fail(`duplicate stage id: ${id}`); stageIds.add(id);
    const dependsOn = stage.dependsOn === undefined ? [] : strings(stage.dependsOn, `${id}.dependsOn`);
    if (!Array.isArray(stage.jobs) || stage.jobs.length === 0) fail(`${id}.jobs must be a non-empty array`);
    const jobs = stage.jobs.map((entryJob, jobIndex): RecipeJob => {
      const job = object(entryJob, `${id}.jobs[${jobIndex}]`), jobId = text(job.id, `${id}.jobs[${jobIndex}].id`);
      if (jobIds.has(jobId)) fail(`duplicate job id: ${jobId}`); jobIds.add(jobId);
      const sections = strings(job.sections, `${jobId}.sections`) as Section[];
      if (!sections.length || sections.some((section) => !SECTIONS.includes(section))) fail(`${jobId}.sections contains an unsupported section`);
      const countsRaw = object(job.desiredCounts, `${jobId}.desiredCounts`), desiredCounts: Record<string, number> = {};
      for (const [field, count] of Object.entries(countsRaw)) {
        if (!(field in FIELD_SECTIONS) || !sections.includes(FIELD_SECTIONS[field]!) || !Number.isInteger(count) || (count as number) < 1) fail(`${jobId}.desiredCounts.${field} is invalid or outside requested sections`);
        desiredCounts[field] = count as number;
      }
      if (!Object.keys(desiredCounts).length) fail(`${jobId}.desiredCounts must not be empty`);
      const minCount = job.minCount === undefined ? 1 : job.minCount;
      if (!Number.isInteger(minCount) || (minCount as number) < 1) fail(`${jobId}.minCount must be a positive integer`);
      let expandFrom: RecipeJob["expandFrom"];
      if (job.expandFrom !== undefined) {
        if (!Array.isArray(job.expandFrom)) fail(`${jobId}.expandFrom must be an array`);
        const sourceIds = new Set<string>();
        expandFrom = job.expandFrom.map((entrySelector, selectorIndex) => {
          const selector = object(entrySelector, `${jobId}.expandFrom[${selectorIndex}]`), sourceJobId = text(selector.jobId, `${jobId}.expandFrom[${selectorIndex}].jobId`);
          if (sourceIds.has(sourceJobId)) fail(`${jobId}.expandFrom contains duplicate job ${sourceJobId}`); sourceIds.add(sourceJobId);
          const fields = strings(selector.fields, `${jobId}.expandFrom[${selectorIndex}].fields`);
          if (!fields.length || new Set(fields).size !== fields.length || fields.some((field) => !(field in FIELD_SECTIONS))) fail(`${jobId}.expandFrom[${selectorIndex}].fields is invalid`);
          const limit = selector.limit;
          if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 16)) fail(`${jobId}.expandFrom[${selectorIndex}].limit must be between 1 and 16`);
          return { jobId: sourceJobId, fields, ...(limit === undefined ? {} : { limit: limit as number }) };
        });
      }
      const expandArtifactKeys = job.expandArtifactKeys === undefined ? undefined : [...new Set(strings(job.expandArtifactKeys, `${jobId}.expandArtifactKeys`))];
      if ((expandArtifactKeys?.length ?? 0) + (expandFrom ?? []).reduce((sum, selector) => sum + (selector.limit ?? 0), 0) > 16) fail(`${jobId} requests more than 16 combined expansion keys`);
      return { id: jobId, sections: [...new Set(sections)], brief: text(job.brief, `${jobId}.brief`), desiredCounts, minCount: minCount as number,
        ...(job.tone === undefined ? {} : { tone: text(job.tone, `${jobId}.tone`) }),
        ...(job.exclusions === undefined ? {} : { exclusions: strings(job.exclusions, `${jobId}.exclusions`) }),
        ...(expandArtifactKeys === undefined ? {} : { expandArtifactKeys }),
        ...(expandFrom === undefined ? {} : { expandFrom }),
        ...(job.revisionFeedback === undefined ? {} : { revisionFeedback: job.revisionFeedback === null ? null : text(job.revisionFeedback, `${jobId}.revisionFeedback`) }) };
    });
    return { id, dependsOn, jobs };
  });
  for (const stage of stages) for (const dependency of stage.dependsOn ?? []) if (!stageIds.has(dependency) || dependency === stage.id) fail(`invalid dependency ${dependency} for stage ${stage.id}`);
  const visiting = new Set<string>(), visited = new Set<string>(), byId = new Map(stages.map((stage) => [stage.id, stage]));
  const visit = (id: string) => { if (visiting.has(id)) fail("recipe stage dependencies contain a cycle"); if (visited.has(id)) return; visiting.add(id); for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency); visiting.delete(id); visited.add(id); };
  for (const stage of stages) visit(stage.id);
  const stageOrder = new Map(stages.map((stage, index) => [stage.id, index]));
  const jobStage = new Map<string, string>(); for (const stage of stages) for (const job of stage.jobs) jobStage.set(job.id, stage.id);
  const dependencies = (stageId: string): Set<string> => { const result = new Set<string>(); const add = (id: string) => { for (const dependency of byId.get(id)?.dependsOn ?? []) if (!result.has(dependency)) { result.add(dependency); add(dependency); } }; add(stageId); return result; };
  for (const stage of stages) {
    const reachable = dependencies(stage.id);
    for (const job of stage.jobs) for (const selector of job.expandFrom ?? []) {
      const sourceStage = jobStage.get(selector.jobId), sourceJob = stages.flatMap((item) => item.jobs).find((item) => item.id === selector.jobId);
      if (!sourceStage || !reachable.has(sourceStage) || stageOrder.get(sourceStage)! >= stageOrder.get(stage.id)!) fail(`${job.id}.expandFrom job ${selector.jobId} must be in an earlier dependency-reachable stage`);
      if (selector.fields.some((field) => !(field in sourceJob!.desiredCounts))) fail(`${job.id}.expandFrom job ${selector.jobId} does not request every selected field`);
    }
  }
  return { version: 1, name, tone, exclusions, stages };
}

async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  ledger.updatedAt = new Date().toISOString(); await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`, handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path); const directory = await open(dirname(path), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function loadLedger(path: string): Promise<Ledger | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8")), value = object(parsed, "ledger");
    if (value.schemaVersion !== 1 || typeof value.recipeDigest !== "string" || typeof value.apiBase !== "string" || !value.works || typeof value.works !== "object" || Array.isArray(value.works)) fail("ledger has an unsupported or malformed schema");
    return value as unknown as Ledger;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

class ApiError extends Error { constructor(readonly status: number, readonly body: Record<string, unknown>) { super(`API request failed with HTTP ${status}${typeof body.code === "string" ? ` (${body.code})` : ""}`); } }
async function request(fetcher: Fetch, base: string, path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetcher(`${base}${path}`, body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let parsed: Record<string, unknown> = {}; try { parsed = object(await response.json(), "API response"); } catch { if (response.ok) fail("API returned a malformed success response"); }
  if (!response.ok) throw new ApiError(response.status, parsed); return parsed;
}
function generationBody(work: Work, campaignId: string, retry = false): Record<string, unknown> {
  const targets = Object.entries(work.desiredCounts).map(([field, count]) => `${count} ${field}`).join(", ");
  return { campaignId, brief: `${work.brief}\n\nHydration target for this additive candidate: ${targets}. Return as many requested items as safely fit; do not duplicate accepted canon.`, tone: work.tone,
    exclusions: work.exclusions, idempotencyKey: work.idempotencyKey, sections: work.sections, expandArtifactKeys: work.resolvedExpandArtifactKeys ?? work.expandArtifactKeys,
    revisionFeedback: work.revisionFeedback, retryFailedAttempt: retry ? { failedAttempt: work.failedAttempt } : null };
}
function acceptedPublicArtifactKeys(preview: Record<string, unknown>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const field of Object.keys(FIELD_SECTIONS)) {
    const items = preview[field]; if (!Array.isArray(items)) continue;
    const keys = items.flatMap((item) => item && typeof item === "object" && (item as Record<string, unknown>).visibility === "public" && typeof (item as Record<string, unknown>).key === "string" ? [(item as Record<string, unknown>).key as string] : []);
    if (keys.length) result[field] = [...new Set(keys)];
  }
  return result;
}
function recordAcceptedPublicArtifacts(work: Work): void { if (work.draft) work.acceptedPublicArtifactKeys = acceptedPublicArtifactKeys(work.draft.preview); }
function keysAndCounts(preview: Record<string, unknown>): { keys: string[]; counts: Record<string, number> } {
  const keys: string[] = [], counts: Record<string, number> = {};
  for (const field of Object.keys(FIELD_SECTIONS)) { const items = preview[field]; counts[field] = Array.isArray(items) ? items.length : 0; if (Array.isArray(items)) for (const item of items) { const key = item && typeof item === "object" ? (item as Record<string, unknown>).key : null; if (typeof key === "string") keys.push(key); } }
  return { keys: [...new Set(keys)], counts };
}
function childId(parent: Work, kind: "split" | "fill" | "stale", index: number): string { return `${parent.id}.${kind}-${index}`; }
function makeChild(parent: Work, kind: "split" | "fill" | "stale", index: number, counts: Record<string, number>): Work {
  const id = childId(parent, kind, index), path = `${parent.path}/${kind}-${index}`;
  const { draft: _draft, failedAttempt: _attempt, acceptedPublicArtifactKeys: _accepted, reason: _reason, ...basis } = parent;
  return { ...basis, id, path, status: "pending", idempotencyKey: `hydrate-${digest(`${parent.rootId}:${path}`).slice(0, 40)}`, desiredCounts: counts,
    confirmedFailures: 0, children: [] };
}
function splitWork(ledger: Ledger, work: Work): boolean {
  const total = Object.values(work.desiredCounts).reduce((sum, count) => sum + count, 0);
  if (total <= work.minCount) return false;
  const left: Record<string, number> = {}, right: Record<string, number> = {};
  let leftUnits = 0; const leftTarget = Math.floor(total / 2);
  for (const [field, count] of Object.entries(work.desiredCounts)) {
    const a = Math.min(count, Math.max(0, leftTarget - leftUnits)), b = count - a; leftUnits += a;
    if (a > 0) left[field] = a; if (b > 0) right[field] = b;
  }
  const parts = [left, right].filter((part) => Object.keys(part).length);
  if (parts.length < 2) return false;
  const children = parts.map((counts, index) => makeChild(work, "split", index + 1, counts));
  for (const child of children) ledger.works[child.id] = child; work.children = children.map(({ id }) => id); work.status = "expanded"; work.reason = "split after two confirmed paid-attempt failures"; return true;
}
function addReplacement(ledger: Ledger, work: Work, kind: "fill" | "stale", counts: Record<string, number>): void {
  const child = makeChild(work, kind, work.children.length + 1, counts); ledger.works[child.id] = child; work.children.push(child.id); work.status = "expanded";
}
function rootComplete(ledger: Ledger, rootId: string): boolean {
  const root = ledger.works[rootId]; if (!root) return false;
  const complete = (work: Work): boolean => work.status === "applied" || work.status === "deficit" || (work.status === "expanded" && work.children.length > 0 && work.children.every((id) => ledger.works[id] !== undefined && complete(ledger.works[id]!)));
  return complete(root);
}
function stageReady(recipe: HydrationRecipe, ledger: Ledger, stageId: string): boolean {
  const stage = recipe.stages.find((item) => item.id === stageId)!;
  return (stage.dependsOn ?? []).every((dependency) => recipe.stages.find((item) => item.id === dependency)!.jobs.every((job) => rootComplete(ledger, job.id)));
}
function resolveExpansionKeys(recipe: HydrationRecipe, ledger: Ledger, work: Work): string[] {
  if (work.resolvedExpandArtifactKeys) return work.resolvedExpandArtifactKeys;
  const recipeJobs = recipe.stages.flatMap((stage) => stage.jobs), order = new Map(recipeJobs.map((job, index) => [job.id, index]));
  const selectors = [...(work.expandFrom ?? [])].sort((left, right) => order.get(left.jobId)! - order.get(right.jobId)!);
  const keys = [...work.expandArtifactKeys];
  const visit = (source: Work, field: string, output: string[]) => { output.push(...(source.acceptedPublicArtifactKeys?.[field] ?? [])); for (const child of source.children) visit(ledger.works[child]!, field, output); };
  for (const selector of selectors) {
    const root = ledger.works[selector.jobId]; if (!root || !rootComplete(ledger, selector.jobId)) fail(`${work.id} expansion source ${selector.jobId} is incomplete`);
    const selected: string[] = []; for (const field of selector.fields) visit(root, field, selected);
    keys.push(...selected.slice(0, selector.limit ?? selected.length));
  }
  return [...new Set(keys)].slice(0, 16);
}

async function recoverGeneration(work: Work, ledger: Ledger, save: () => Promise<void>, fetcher: Fetch): Promise<"staged" | "failed" | "uncertain"> {
  const campaignId = ledger.campaignId!, body = generationBody(work, campaignId), recovery = await request(fetcher, ledger.apiBase, "/api/rpg/v1/campaign-content-drafts/reconcile", "POST", body);
  if (recovery.state === "succeeded" && typeof recovery.draftId === "string") {
    work.draft = await request(fetcher, ledger.apiBase, `/api/rpg/v1/campaign-content-drafts/${encodeURIComponent(recovery.draftId)}`) as unknown as DraftView; work.status = work.draft.draft.state === "applied" ? "applied" : "staged"; if (work.status === "applied") recordAcceptedPublicArtifacts(work); await save(); return "staged";
  }
  if (recovery.state === "failed" && typeof recovery.attempt === "number") { work.failedAttempt = recovery.attempt; work.confirmedFailures = recovery.attempt; await save(); return "failed"; }
  work.status = "uncertain"; work.reason = `generation reconciliation state: ${String(recovery.state)}`; await save(); return "uncertain";
}

async function stageWork(work: Work, ledger: Ledger, save: () => Promise<void>, fetcher: Fetch): Promise<void> {
  if (work.status === "dispatching") { const recovered = await recoverGeneration(work, ledger, save, fetcher); if (recovered !== "failed") return; }
  while (work.confirmedFailures < 2) {
    work.status = "dispatching"; await save();
    try {
      work.draft = await request(fetcher, ledger.apiBase, "/api/rpg/v1/campaign-content-drafts", "POST", generationBody(work, ledger.campaignId!, work.confirmedFailures > 0)) as unknown as DraftView;
      work.status = work.draft.draft.state === "applied" ? "applied" : "staged"; if (work.status === "applied") recordAcceptedPublicArtifacts(work); await save(); return;
    } catch {
      try { const recovered = await recoverGeneration(work, ledger, save, fetcher); if (recovered !== "failed") return; }
      catch { work.status = "uncertain"; work.reason = "generation request and reconciliation outcomes could not be confirmed"; await save(); return; }
    }
  }
  if (!splitWork(ledger, work)) { work.status = "deficit"; work.reason = "desired unit remains unavailable after two confirmed failures at the minimum split size"; } await save();
}

async function applyWork(work: Work, ledger: Ledger, save: () => Promise<void>, fetcher: Fetch, allowStaleRegeneration: boolean): Promise<void> {
  if (!work.draft || work.status === "applied" || work.status === "expanded") return;
  if (work.status === "applying") {
    try { work.draft = await request(fetcher, ledger.apiBase, `/api/rpg/v1/campaign-content-drafts/${encodeURIComponent(work.draft.draft.draftId)}`) as unknown as DraftView; }
    catch { work.status = "uncertain"; work.reason = "apply reconciliation could not read authoritative draft state"; await save(); return; }
    if (work.draft.draft.state === "applied") { work.status = "applied"; recordAcceptedPublicArtifacts(work); await save(); return; }
    work.status = "uncertain"; work.reason = "an interrupted apply was not proven committed; refusing automatic retry"; await save(); return;
  }
  const { keys, counts } = keysAndCounts(work.draft.preview); if (!keys.length) { work.status = "failed"; work.reason = "candidate contains no selectable artifacts"; await save(); return; }
  work.status = "applying"; await save();
  try {
    await request(fetcher, ledger.apiBase, `/api/rpg/v1/campaign-content-drafts/${encodeURIComponent(work.draft.draft.draftId)}/apply`, "POST", { expectedRevision: work.draft.draft.revision, idempotencyKey: `${work.idempotencyKey}-apply`, selectedArtifactKeys: keys });
    work.status = "applied";
    recordAcceptedPublicArtifacts(work);
    const missing: Record<string, number> = {};
    for (const [field, desired] of Object.entries(work.desiredCounts)) { const count = Math.max(0, desired - (counts[field] ?? 0)); if (count > 0) missing[field] = count; }
    if (Object.keys(missing).length) { addReplacement(ledger, work, "fill", missing); work.reason = "sparse candidate applied; additive fill scheduled"; }
    await save();
  } catch (error) {
    try {
      work.draft = await request(fetcher, ledger.apiBase, `/api/rpg/v1/campaign-content-drafts/${encodeURIComponent(work.draft.draft.draftId)}`) as unknown as DraftView;
      if (work.draft.draft.state === "applied") { work.status = "applied"; recordAcceptedPublicArtifacts(work); await save(); return; }
      if (error instanceof ApiError && error.status === 409) {
        if (allowStaleRegeneration) { addReplacement(ledger, work, "stale", work.desiredCounts); work.reason = "stale staged candidate replaced under explicit stale-regeneration policy"; }
        else { work.status = "stale"; work.reason = "paid candidate became stale; rerun with --allow-stale-regeneration to authorize replacement"; }
        await save(); return;
      }
    } catch { /* Preserve outcome uncertainty below. */ }
    work.status = "uncertain"; work.reason = "apply outcome could not be proven; refusing automatic retry"; await save();
  }
}

export async function hydrateCampaign(options: HydrateOptions): Promise<Ledger> {
  const recipe = parseRecipe(options.recipe), apiBase = options.apiBase.replace(/\/+$/, ""), concurrency = options.concurrency ?? 1, log = options.log ?? console.log, fetcher = options.fetch ?? globalThis.fetch;
  if (!/^https?:\/\//.test(apiBase)) fail("apiBase must be an absolute HTTP(S) URL"); if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) fail("concurrency must be between 1 and 32");
  if (concurrency > 1 && !options.allowStaleRegeneration) fail("concurrency above 1 requires --allow-stale-regeneration because same-campaign staged drafts can stale each other");
  if (concurrency > 1) log("WARNING: concurrent same-campaign drafts snapshot one content revision; serial application can stale successful paid siblings and require paid regeneration.");
  if (options.campaignId && options.createCampaign) fail("use either campaignId or createCampaign, not both"); if (!options.campaignId && !options.createCampaign && !options.dryRun) fail("campaignId or createCampaign is required");
  const recipeDigest = digest(recipe);
  if (options.dryRun) { log(`Dry run: ${recipe.stages.length} stages, ${recipe.stages.reduce((sum, stage) => sum + stage.jobs.length, 0)} root jobs, concurrency ${concurrency}.`); return { schemaVersion: 1, recipeDigest, recipeName: recipe.name, apiBase, campaignId: options.campaignId ?? null, createdCampaign: false, creationStatus: "not-requested", works: {}, updatedAt: new Date().toISOString() }; }
  let ledger = await loadLedger(options.ledgerPath);
  if (ledger && ledger.recipeDigest !== recipeDigest) fail("ledger recipe digest differs; use the original recipe or a new ledger path");
  if (ledger && ledger.apiBase !== apiBase) fail("ledger API base differs; use a new ledger path");
  if (ledger && options.campaignId && ledger.campaignId !== options.campaignId) fail("ledger campaign differs from --campaign-id");
  if (ledger && options.createCampaign && ledger.createCampaignName !== options.createCampaign) fail("ledger campaign creation name differs from --create-campaign");
  if (!ledger) {
    const works: Record<string, Work> = {};
    for (const stage of recipe.stages) for (const job of stage.jobs) works[job.id] = { id: job.id, rootId: job.id, stageId: stage.id, path: job.id, status: "pending", idempotencyKey: `hydrate-${digest(`${recipeDigest}:${job.id}`).slice(0, 40)}`,
      sections: job.sections, brief: job.brief, tone: job.tone ?? recipe.tone, exclusions: job.exclusions ?? recipe.exclusions ?? [], expandArtifactKeys: job.expandArtifactKeys ?? [], expandFrom: job.expandFrom ?? [], revisionFeedback: job.revisionFeedback ?? null,
      desiredCounts: job.desiredCounts, minCount: job.minCount ?? 1, confirmedFailures: 0, children: [] };
    ledger = { schemaVersion: 1, recipeDigest, recipeName: recipe.name, apiBase, campaignId: options.campaignId ?? null, createdCampaign: false,
      creationStatus: options.createCampaign ? "pending" : "not-requested", ...(options.createCampaign ? { createCampaignName: options.createCampaign } : {}), works, updatedAt: new Date().toISOString() };
    await writeLedger(options.ledgerPath, ledger);
  }
  let saveTail = Promise.resolve();
  const save = () => { saveTail = saveTail.then(() => writeLedger(options.ledgerPath, ledger!)); return saveTail; };
  if (ledger.starterSetup?.status === "dispatching") fail("starter setup outcome is uncertain; inspect campaign configuration before continuing");
  if (!ledger.campaignId) {
    if (ledger.creationStatus === "dispatching") fail("campaign creation outcome is uncertain; inspect campaigns and start with an explicit campaign ID and new ledger");
    ledger.creationStatus = "dispatching"; await save();
    const created = await request(fetcher, apiBase, "/api/rpg/v1/campaigns", "POST", { name: ledger.createCampaignName }); const campaign = object(created.campaign, "campaign creation response.campaign");
    ledger.campaignId = text(campaign.id, "created campaign id"); ledger.createdCampaign = true; ledger.creationStatus = "complete"; await save();
  }
  if (options.requireProvider || options.providerModel) { const provider = await request(fetcher, apiBase, "/api/provider"); if (provider.hasApiKey !== true || typeof provider.model !== "string" || !provider.model.trim()) fail("provider is not fully configured"); if (options.providerModel && provider.model !== options.providerModel) fail("configured provider model does not match --provider-model"); }
  if (options.starter) {
    const starter = STARTERS[options.starter]; if (!starter) fail("starter must be original, mechanics, or srd-5.1");
    if (ledger.starterSetup && ledger.starterSetup.starter !== options.starter) fail("ledger starter setup differs from --starter");
    if (ledger.starterSetup?.status !== "complete") { ledger.starterSetup = { starter: options.starter, status: "dispatching" }; await save(); await request(fetcher, apiBase, `/api/rpg/v1/campaigns/${encodeURIComponent(ledger.campaignId)}/${starter.path}`, "PUT", { starterId: starter.starterId }); ledger.starterSetup.status = "complete"; await save(); }
  }
  let applyTail = Promise.resolve(), active = 0;
  const scheduleApply = (work: Work) => { applyTail = applyTail.then(() => applyWork(work, ledger!, save, fetcher, options.allowStaleRegeneration === true)); return applyTail; };
  while (true) {
    if (options.allowStaleRegeneration) for (const work of Object.values(ledger.works)) if (work.status === "stale") { addReplacement(ledger, work, "stale", work.desiredCounts); work.reason = "stale replacement authorized on resume"; await save(); }
    const terminalProblem = Object.values(ledger.works).find((work) => work.status === "uncertain" || work.status === "failed");
    if (terminalProblem) fail(`hydration stopped at ${terminalProblem.id}: ${terminalProblem.reason ?? terminalProblem.status}`);
    const staleProblem = Object.values(ledger.works).find((work) => work.status === "stale");
    if (staleProblem) fail(`hydration stopped at ${staleProblem.id}: ${staleProblem.reason}`);
    const staged = Object.values(ledger.works).filter((work) => work.status === "staged" || work.status === "applying"); for (const work of staged) await scheduleApply(work);
    const pending = Object.values(ledger.works).filter((work) => work.status === "pending" || work.status === "dispatching").filter((work) => stageReady(recipe, ledger!, work.stageId));
    if (!pending.length) { await applyTail; if (recipe.stages.every((stage) => stage.jobs.every((job) => rootComplete(ledger!, job.id)))) break; fail("hydration cannot progress because dependencies are incomplete"); }
    for (const work of pending) if (!work.resolvedExpandArtifactKeys) { work.resolvedExpandArtifactKeys = resolveExpansionKeys(recipe, ledger, work); await save(); }
    let cursor = 0; const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => { while (cursor < pending.length) { const work = pending[cursor++]!; active++; log(`Staging ${work.id} (${active}/${concurrency})`); try { await stageWork(work, ledger!, save, fetcher); if (work.status === "staged") await scheduleApply(work); } finally { active--; } } });
    await Promise.all(workers); await applyTail;
  }
  const deficits = Object.values(ledger.works).filter((work) => work.status === "deficit");
  log(`Hydration complete for campaign ${ledger.campaignId}${deficits.length ? ` with ${deficits.length} unit-floor deficit(s)` : ""}.`); return ledger;
}

function usage(): never { fail("usage: npm run hydrate:campaign -- --recipe FILE --api-base URL (--campaign-id ID | --create-campaign NAME) [--ledger FILE] [--concurrency N] [--allow-stale-regeneration] [--starter original|mechanics|srd-5.1] [--require-provider] [--provider-model MODEL] [--dry-run]"); }
function args(argv: string[]): Record<string, string | boolean> { const result: Record<string, string | boolean> = {}; for (let index = 0; index < argv.length; index++) { const arg = argv[index]!; if (!arg.startsWith("--")) usage(); const name = arg.slice(2); if (["dry-run", "require-provider", "allow-stale-regeneration"].includes(name)) result[name] = true; else { const value = argv[++index]; if (!value || value.startsWith("--")) usage(); result[name] = value; } } return result; }
async function main(): Promise<void> { const input = args(process.argv.slice(2)), recipePath = typeof input.recipe === "string" ? resolve(input.recipe) : usage(); const recipe = parseRecipe(JSON.parse(await readFile(recipePath, "utf8"))), starter = input.starter; if (typeof starter === "string" && !(starter in STARTERS)) fail("starter must be original, mechanics, or srd-5.1"); await hydrateCampaign({ recipe, apiBase: typeof input["api-base"] === "string" ? input["api-base"] : "http://127.0.0.1:3000", ledgerPath: typeof input.ledger === "string" ? resolve(input.ledger) : resolve(`.hydration/${digest(recipe).slice(0, 16)}.json`), ...(typeof input["campaign-id"] === "string" ? { campaignId: input["campaign-id"] } : {}), ...(typeof input["create-campaign"] === "string" ? { createCampaign: input["create-campaign"] } : {}), ...(typeof starter === "string" ? { starter: starter as NonNullable<HydrateOptions["starter"]> } : {}), ...(typeof input.concurrency === "string" ? { concurrency: Number(input.concurrency) } : {}), ...(input["allow-stale-regeneration"] === true ? { allowStaleRegeneration: true } : {}), ...(input["dry-run"] === true ? { dryRun: true } : {}), ...(input["require-provider"] === true ? { requireProvider: true } : {}), ...(typeof input["provider-model"] === "string" ? { providerModel: input["provider-model"] } : {}) }); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error instanceof Error ? error.message : "hydration failed"); process.exitCode = 1; });

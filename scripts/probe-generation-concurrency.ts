import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const REQUIRED_MODEL = "deepseek/deepseek-v4-flash";
const PROBE_CAMPAIGN_PREFIX = "Generation concurrency probe ";
const WIDTHS = [1, 2, 3, 4] as const;
const MIN_WAVES = 2;
const GENERATION_LEASE_MS = 10 * 60 * 1_000;

type Args = {
  apiBaseUrl: string;
  campaignId: string | null;
  createProbeCampaign: boolean;
  execute: boolean;
  waves: number;
};

type ProviderView = {
  baseUrl?: unknown;
  model?: unknown;
  hasApiKey?: unknown;
  requestTimeoutSeconds?: unknown;
  allowFallbacks?: unknown;
  requireParameters?: unknown;
  routingSort?: unknown;
  dataCollection?: unknown;
  zdr?: unknown;
  pricing?: { promptPerMillion?: unknown; completionPerMillion?: unknown };
};

type ProbeRequest = {
  campaignId: string;
  brief: string;
  tone: string;
  exclusions: string[];
  idempotencyKey: string;
  sections: ["handouts"];
  expandArtifactKeys: [];
  revisionFeedback: null;
  retryFailedAttempt: null;
};

export type ProbeResult = {
  width: number;
  wave: number;
  slot: number;
  artifactKey: string;
  idempotencyKey: string;
  stagingSucceeded: boolean;
  instructionAdherent: boolean | null;
  providerFailed: boolean;
  uncertain: boolean;
  latencyMs: number;
  httpStatus: number | null;
  recoveryState: string;
  attempt: number;
  reason: string | null;
};

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/probe-generation-concurrency.ts (--campaign-id <id> | --create-probe-campaign) [options]",
    "",
    "Options:",
    "  --execute-paid-probe   Make the campaign-generation calls. Without it, print a dry-run plan.",
    "  --waves <n>            Waves per width; minimum and default are 2.",
    "  --api-base-url <url>   Velvet server URL; defaults to VELVET_API_URL or http://127.0.0.1:8787.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  let apiBaseUrl = process.env.VELVET_API_URL?.trim() || "http://127.0.0.1:8787";
  let campaignId: string | null = null;
  let createProbeCampaign = false;
  let execute = false;
  let waves = MIN_WAVES;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--campaign-id") campaignId = argv[++index] ?? null;
    else if (arg === "--create-probe-campaign") createProbeCampaign = true;
    else if (arg === "--execute-paid-probe") execute = true;
    else if (arg === "--waves") waves = Number(argv[++index]);
    else if (arg === "--api-base-url") apiBaseUrl = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg ?? ""}\n\n${usage()}`);
  }

  if (Boolean(campaignId) === createProbeCampaign) {
    throw new Error(`Choose exactly one of --campaign-id or --create-probe-campaign.\n\n${usage()}`);
  }
  if (!Number.isInteger(waves) || waves < MIN_WAVES) throw new Error(`--waves must be an integer of at least ${MIN_WAVES}`);
  let parsedBase: URL;
  try { parsedBase = new URL(apiBaseUrl); } catch { throw new Error("--api-base-url must be a valid URL"); }
  if (!(["http:", "https:"] as string[]).includes(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
    throw new Error("--api-base-url must be an HTTP(S) origin or path without credentials, query, or fragment");
  }
  apiBaseUrl = parsedBase.toString().replace(/\/+$/, "");
  return { apiBaseUrl, campaignId, createProbeCampaign, execute, waves };
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function getJson(url: string, timeoutMs = 15_000): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  return { response, body: await responseJson(response) };
}

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, body: await responseJson(response) };
}

function validateProvider(value: unknown): ProviderView & { baseUrl: string; model: string; requestTimeoutSeconds: number } {
  if (!value || typeof value !== "object") throw new Error("GET /api/provider returned an invalid response");
  const provider = value as ProviderView;
  if (provider.model !== REQUIRED_MODEL) throw new Error(`Configured provider model must be exactly ${REQUIRED_MODEL}`);
  if (provider.hasApiKey !== true) throw new Error("Configured OpenRouter profile does not report an API key");
  if (typeof provider.baseUrl !== "string") throw new Error("Configured provider base URL is unavailable");
  let providerUrl: URL;
  try { providerUrl = new URL(provider.baseUrl); } catch { throw new Error("Configured provider base URL is invalid"); }
  if (providerUrl.protocol !== "https:" || providerUrl.hostname.toLowerCase() !== "openrouter.ai") {
    throw new Error("Configured provider must use HTTPS on the exact openrouter.ai host");
  }
  if (typeof provider.requestTimeoutSeconds !== "number" || !Number.isFinite(provider.requestTimeoutSeconds)) {
    throw new Error("Configured provider timeout is invalid");
  }
  return provider as ProviderView & { baseUrl: string; model: string; requestTimeoutSeconds: number };
}

async function requireProbeCampaign(apiBaseUrl: string, campaignId: string): Promise<void> {
  const { response, body } = await getJson(`${apiBaseUrl}/api/rpg/v1/campaigns/${encodeURIComponent(campaignId)}`);
  if (!response.ok || body?.campaign?.id !== campaignId) throw new Error("The requested probe campaign is unavailable");
  if (typeof body.campaign.name !== "string" || !body.campaign.name.startsWith(PROBE_CAMPAIGN_PREFIX)) {
    throw new Error(`Refusing a non-dedicated campaign; its name must start with ${JSON.stringify(PROBE_CAMPAIGN_PREFIX)}`);
  }
}

async function createProbeCampaign(apiBaseUrl: string, runId: string): Promise<string> {
  const { response, body } = await postJson(`${apiBaseUrl}/api/rpg/v1/campaigns`, { name: `${PROBE_CAMPAIGN_PREFIX}${runId}` }, 15_000);
  if (response.status !== 201 || typeof body?.campaign?.id !== "string") throw new Error("Dedicated probe campaign creation failed");
  return body.campaign.id;
}

function makeRequest(campaignId: string, runId: string, width: number, wave: number, slot: number): { request: ProbeRequest; artifactKey: string } {
  const suffix = `${runId}-w${width}v${wave}s${slot}`;
  const artifactKey = `probe-${suffix}`;
  return {
    artifactKey,
    request: {
      campaignId,
      brief: `Return exactly one short public handout candidate. Its key must be ${artifactKey}. It must be independent, contain no references, and state only: concurrency probe ${suffix}.`,
      tone: "plain operational test",
      exclusions: ["links", "dependencies", "additional candidates"],
      idempotencyKey: `generation-concurrency:${suffix}`,
      sections: ["handouts"],
      expandArtifactKeys: [],
      revisionFeedback: null,
      retryFailedAttempt: null,
    },
  };
}

async function reconcile(apiBaseUrl: string, request: ProbeRequest, deadlineMs: number): Promise<any> {
  while (Date.now() < deadlineMs) {
    try {
      const { response, body } = await postJson(`${apiBaseUrl}/api/rpg/v1/campaign-content-drafts/reconcile`, request, 15_000);
      if (response.ok && body && body.state !== "running") return body;
      if (response.ok && body?.state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      return { state: "reconcile-failed", attempt: 0, draftId: null };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return { state: "reconcile-timeout", attempt: 0, draftId: null };
}

async function runOne(apiBaseUrl: string, request: ProbeRequest, artifactKey: string, width: number, wave: number, slot: number, requestTimeoutMs: number): Promise<ProbeResult> {
  const startedAt = performance.now();
  let httpStatus: number | null = null;
  let responseBody: any = null;
  let transportFailed = false;
  try {
    const result = await postJson(`${apiBaseUrl}/api/rpg/v1/campaign-content-drafts`, request, requestTimeoutMs);
    httpStatus = result.response.status;
    responseBody = result.body;
  } catch {
    transportFailed = true;
  }

  const recovery = await reconcile(apiBaseUrl, request, Date.now() + GENERATION_LEASE_MS + 30_000);
  const latencyMs = Math.round(performance.now() - startedAt);
  const preview = responseBody?.preview;
  const instructionAdherent = Boolean(httpStatus === 201
    && responseBody?.draft?.campaignId === request.campaignId
    && recovery?.draftId === responseBody?.draft?.draftId
    && Array.isArray(preview?.handouts)
    && preview.handouts.length === 1
    && preview.handouts[0]?.key === artifactKey);

  const stagingSucceeded = recovery?.state === "succeeded" && typeof recovery?.draftId === "string";
  const providerFailed = recovery?.state === "failed";
  const uncertain = recovery?.state === "outcome-uncertain" || recovery?.state === "running"
    || recovery?.state === "reconcile-timeout" || recovery?.state === "reconcile-failed" || recovery?.state === "not-found";
  let reason: string | null = null;
  if (uncertain) {
    reason = transportFailed ? "transport outcome not confirmed" : `terminal state not confirmed (${recovery?.state ?? "invalid"})`;
  } else if (providerFailed) {
    const code = typeof responseBody?.code === "string" ? responseBody.code : null;
    reason = code ? `API ${code}` : `generation ${recovery?.state ?? "failed"}`;
  } else if (stagingSucceeded && instructionAdherent === false) {
    reason = "staged successfully, but the provider did not return the one exact requested key";
  }

  return {
    width, wave, slot, artifactKey, idempotencyKey: request.idempotencyKey,
    stagingSucceeded,
    instructionAdherent: stagingSucceeded && httpStatus === 201 ? instructionAdherent : null,
    providerFailed,
    uncertain,
    latencyMs, httpStatus, recoveryState: recovery?.state ?? "invalid",
    attempt: Number.isInteger(recovery?.attempt) ? recovery.attempt : 0, reason,
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export function summarizeProbeResults(results: ProbeResult[], waves: number) {
  return WIDTHS.map((width) => {
    const selected = results.filter((result) => result.width === width);
    const stagingSucceeded = selected.filter((result) => result.stagingSucceeded).length;
    const instructionAdherent = selected.filter((result) => result.instructionAdherent === true).length;
    const instructionUnassessed = selected.filter((result) => result.instructionAdherent === null).length;
    const providerFailed = selected.filter((result) => result.providerFailed).length;
    const uncertain = selected.filter((result) => result.uncertain).length;
    const observedPerfectStaging = Array.from({ length: waves }, (_, index) => index + 1).every((wave) => {
      const waveResults = selected.filter((result) => result.wave === wave);
      return waveResults.length === width && waveResults.every((result) => result.stagingSucceeded);
    });
    return {
      width,
      requests: selected.length,
      stagingSucceeded,
      stagingSuccessRate: selected.length ? stagingSucceeded / selected.length : 0,
      instructionAdherent,
      instructionUnassessed,
      instructionAdherenceRate: selected.length ? instructionAdherent / selected.length : 0,
      instructionAdherenceAmongStagedRate: stagingSucceeded ? instructionAdherent / stagingSucceeded : 0,
      providerFailed,
      uncertain,
      latencyMs: {
        min: percentile(selected.map((result) => result.latencyMs), 0),
        median: percentile(selected.map((result) => result.latencyMs), 0.5),
        p95: percentile(selected.map((result) => result.latencyMs), 0.95),
        max: percentile(selected.map((result) => result.latencyMs), 1),
      },
      observedPerfectStaging,
    };
  });
}

export function buildObservedRecommendation(summary: ReturnType<typeof summarizeProbeResults>) {
  const perfectWidths = summary.filter((entry) => entry.observedPerfectStaging).map((entry) => entry.width);
  const width = perfectWidths.length ? Math.max(...perfectWidths) : 1;
  const selected = summary.find((entry) => entry.width === width)!;
  return {
    largestObservedPerfectStagingWidth: perfectWidths.length ? width : null,
    observedRecommendedWidth: width,
    stagingSuccessRateAtWidth: selected.stagingSuccessRate,
    instructionAdherenceRateAtWidth: selected.instructionAdherenceRate,
    instructionAdherenceAmongStagedRateAtWidth: selected.instructionAdherenceAmongStagedRate,
    label: "observed result only; sample is insufficient to claim reliability",
    basis: perfectWidths.length
      ? "Largest tested width with 100% staging success in every observed wave; instruction adherence is reported separately."
      : "No tested width had 100% staging success in every observed wave; remain serial while investigating.",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const providerResponse = await getJson(`${args.apiBaseUrl}/api/provider`);
  if (!providerResponse.response.ok) throw new Error("GET /api/provider failed");
  const provider = validateProvider(providerResponse.body);
  const callCount = WIDTHS.reduce((total, width) => total + width, 0) * args.waves;
  const providerSummary = {
    host: new URL(provider.baseUrl).hostname,
    model: provider.model,
    requestTimeoutSeconds: provider.requestTimeoutSeconds,
    allowFallbacks: provider.allowFallbacks,
    requireParameters: provider.requireParameters,
    routingSort: provider.routingSort,
    dataCollection: provider.dataCollection,
    zdr: provider.zdr,
    pricing: provider.pricing ?? null,
    hasApiKey: true,
  };

  if (args.campaignId) await requireProbeCampaign(args.apiBaseUrl, args.campaignId);
  if (!args.execute) {
    process.stdout.write(`${JSON.stringify({
      mode: "dry-run",
      apiBaseUrl: args.apiBaseUrl,
      campaign: args.campaignId ? { id: args.campaignId, validatedDedicated: true } : { createDedicated: true },
      provider: providerSummary,
      widths: WIDTHS,
      waves: args.waves,
      paidGenerationCalls: callCount,
      mutations: "none",
      staticRecommendation: {
        observedRecommendedWidth: 1,
        label: "no observed results; sample is insufficient to claim reliability",
        reason: "Begin serially until staging outcomes are measured.",
      },
    }, null, 2)}\n`);
    return;
  }

  const runId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const campaignId = args.campaignId ?? await createProbeCampaign(args.apiBaseUrl, runId);
  const results: ProbeResult[] = [];
  const generationRequestTimeoutMs = Math.max(GENERATION_LEASE_MS, provider.requestTimeoutSeconds * 1_000) + 15_000;
  for (const width of WIDTHS) {
    for (let wave = 1; wave <= args.waves; wave += 1) {
      const requests = Array.from({ length: width }, (_, index) => makeRequest(campaignId, runId, width, wave, index + 1));
      results.push(...await Promise.all(requests.map(({ request, artifactKey }, index) => runOne(
        args.apiBaseUrl, request, artifactKey, width, wave, index + 1, generationRequestTimeoutMs,
      ))));
    }
  }

  const summary = summarizeProbeResults(results, args.waves);
  const recommendation = buildObservedRecommendation(summary);
  const hasIncompleteOutcome = results.some((result) => result.providerFailed || result.uncertain);
  process.stdout.write(`${JSON.stringify({
    mode: "executed-paid-probe",
    runId,
    campaignId,
    disposableCampaignWasCreated: args.createProbeCampaign,
    provider: providerSummary,
    appliedOrPublished: false,
    results,
    summary,
    recommendation,
  }, null, 2)}\n`);
  if (hasIncompleteOutcome) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Probe failed"}\n`);
    process.exitCode = 1;
  });
}

import { createHash } from "node:crypto";
import {
  adventureTurnConfirmRequestSchema, adventureTurnConfirmResponseSchema, adventureTurnGetResponseSchema,
  adventureTurnInitialReconcileRequestSchema, adventureTurnInitialReconcileResponseSchema, adventureTurnResumeTokenSchema,
  adventureTurnStreamEventSchema, adventureTurnStreamRequestSchema, resourceIdSchema,
  type AdventureTurnStreamEvent, type PrivateAdventureTurn, type AdventureTurnHttpProposal,
} from "@velvet/contracts";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { readRpgFeatureFlags } from "../../../features.js";
import { sendApiProblem } from "../../../http/problem.js";
import {
  AdventureTurnAuthorizationError, AdventureTurnConflictError, AdventureTurnExpiredError, AdventureTurnStaleError,
  AdventureTurnUnavailableError, type AdventureTurnRepository,
} from "../../../repo/index.js";
import { openSse, type SseWriter } from "../../roleplay/generationService.js";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../../../agent/adventureOrchestrator.js";
import type { Repository } from "../../../repo/index.js";
import { completeWithProvider } from "../../../provider/index.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../../../defaults.js";
import { getPromptPreset } from "../../../presets.js";

const OWNER = "local-owner";
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"]+"))?\s*$/i;
const FALLBACK_PREFIX = "No mechanics were planned for this declaration. The scene records the action without changing campaign state: ";
const MECHANICS_FALLBACK_PREFIX = "The action was resolved by the authoritative game mechanics: ";

type Repo = Pick<AdventureTurnRepository,
  "createAdventureTurn" | "getAdventureTurn" | "getAdventureTurnNarration" | "waitForToolConfirmation"
  | "getAdventureTurnByInitialIdempotencyKey" | "decideToolProposals" | "expireToolProposals" | "reconcileAdventureTurnMechanics" | "updateAdventureTurnNarration"
  | "recordProviderCallStart" | "recordProviderCallOutcome"> & {
  getCampaign(actorPrincipalId: string, campaignId: string): { activeTimelineId: string } | null;
};

/** Narrow durable repository lane required by adventure-turn HTTP routes. */
export interface AdventureTurnsHttpOptions {
  adventureTurnRepositoryAccessor: () => Repo & Repository;
  agentDependencies?: AdventureAgentDependencies;
}

const enabled = () => { const flags = readRpgFeatureFlags(); return flags.campaign && flags.mechanics; };
const hasQuery = (request: FastifyRequest) => (request.raw.url ?? request.url).includes("?")
  || Object.keys(request.query as Record<string, unknown>).length > 0;
const key = (prefix: string, ...parts: string[]) => `${prefix}:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 48)}`;
const fallback = (declaration: string) => `${FALLBACK_PREFIX}${declaration}`.slice(0, 8_000);
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type NarrationReceipt = { kind: "mechanic"; event: { type: string; data: unknown } } | { kind: "combat"; roundBefore: number; roundAfter: number }
  | {kind:"travel";destination:string};
const activeNarrationDispatches = new Map<string, Promise<{ turn: PrivateAdventureTurn; text: string }>>();
function narrationReceipts(repo: Repo & Repository, turn: PrivateAdventureTurn): NarrationReceipt[] | null {
  const values: NarrationReceipt[] = [];
  for (const link of turn.receiptLinks) {
    const mechanic = repo.getCommandReceipt(OWNER, turn.campaignId, link.commandId);
    if (mechanic) {
      const [event] = mechanic.events;
      if (!event || mechanic.campaignId !== turn.campaignId || mechanic.commandId !== link.commandId) return null;
      const data = event.type === "actor_attribute_set" ? { valueBefore: event.data.valueBefore, valueAfter: event.data.valueAfter }
        : event.type === "actor_resource_initialized" ? { current: event.data.current, max: event.data.max }
          : event.type === "actor_dice_rolled" && typeof event.data.total === "number" && typeof event.data.modifier === "number"
            ? { total: event.data.total, modifier: event.data.modifier } : null;
      if (!data) return null;
      values.push({ kind: "mechanic", event: { type: event.type, data } });
      continue;
    }
    const travel=repo.getExactCandidateTravelNarrationReceipt(OWNER,turn.turnId,link.commandId);
    if(travel){values.push({kind:"travel",destination:travel.destination});continue;}
    const combat = repo.getAgentCombatReceipt(OWNER, turn.campaignId, link.commandId);
    if (!combat || typeof combat.resolution.roundBefore !== "number" || typeof combat.resolution.roundAfter !== "number") return null;
    values.push({ kind: "combat", roundBefore: combat.resolution.roundBefore, roundAfter: combat.resolution.roundAfter });
  }
  return values;
}
export function narrationFallback(declaration: string, values: readonly NarrationReceipt[]): string {
  if (values.length === 0) return fallback(declaration);
  return `${MECHANICS_FALLBACK_PREFIX}${declaration}\n\nCommitted results: ${values.map((value) => value.kind === "combat"
    ? `combat advanced from round ${value.roundBefore} to ${value.roundAfter}` : value.kind==="travel"?`the actor travelled to ${value.destination}`
    : `${value.event.type}: ${JSON.stringify(value.event.data)}`).join("; ")}`.slice(0, 8_000);
}
async function performNarration(repo: Repo & Repository, turn: PrivateAdventureTurn, dependencies: AdventureAgentDependencies | undefined,
  signal: AbortSignal): Promise<{ turn: PrivateAdventureTurn; text: string }> {
  const safeReceipts = narrationReceipts(repo, turn);
  const fallbackText = narrationFallback(turn.declaration, safeReceipts ?? []);
  if (!safeReceipts) return { turn, text: fallbackText };
  const callId = key("narration-provider", turn.turnId);
  const start = turn.providerCalls.find((call) => call.callId === callId && call.phase === "started");
  const started = Boolean(start);
  const settled = turn.providerCalls.some((call) => call.callId === callId && call.phase !== "started");
  if (started && !settled) {
    turn = repo.recordProviderCallOutcome(OWNER, { turnId: turn.turnId, callId, provider: start!.provider, model: start!.model, attempt: start!.attempt,
      outcome: "failed", outcomeCode: "interrupted", expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
      idempotencyKey: key("narration-provider-interrupted", turn.turnId) });
  } else if (!settled) {
    const provider = await (dependencies?.getProvider() ?? Promise.resolve(defaultProviderSettings())).catch(defaultProviderSettings);
    turn = repo.recordProviderCallStart(OWNER, { turnId: turn.turnId, callId, provider: provider.providerType || "openai-compatible",
      model: provider.model.trim() || "unconfigured", attempt: 1, expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
      idempotencyKey: key("narration-provider-start", turn.turnId) });
    try {
      const harness = await (dependencies?.getHarness() ?? Promise.resolve(defaultHarnessSettings())).catch(defaultHarnessSettings);
      const result = await (dependencies?.complete ?? completeWithProvider)({ provider, harness, preset: getPromptPreset("default"), toolChoice: "none", signal,
        messages: [{ role: "system", content: "You are an RPG narrator. Narrate only the supplied display-safe declaration and committed receipt facts. Do not mention IDs, tools, providers, private state, permissions, or unprovided facts. Do not invent mechanics or numeric outcomes. Return narration only." },
          { role: "user", content: JSON.stringify({ declaration: turn.declaration, receipts: safeReceipts }) }] });
      // Model prose is untrusted input.  A receipt's public projection is the
      // only narration contract: never persist or stream model-authored text,
      // even when it appears to follow the prompt.  This also makes retries
      // deterministic and prevents prompt injection from crossing this lane.
      if (result.message.toolCalls?.length || typeof result.message.content !== "string") throw new Error("invalid narration response");
      turn = repo.recordProviderCallOutcome(OWNER, { turnId: turn.turnId, callId, provider: provider.providerType || "openai-compatible",
        model: provider.model.trim() || "unconfigured", attempt: 1, outcome: "succeeded", outcomeCode: "ok", promptTokens: result.usage?.promptTokens ?? null,
        completionTokens: result.usage?.completionTokens ?? null, expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
        idempotencyKey: key("narration-provider-outcome", turn.turnId) });
      return { turn, text: fallbackText };
    } catch {
      const current = requirePrivate(repo.getAdventureTurn(OWNER, turn.turnId));
      if (!current.providerCalls.some((call) => call.callId === callId && call.phase !== "started")) turn = repo.recordProviderCallOutcome(OWNER, { turnId: current.turnId, callId,
        provider: provider.providerType || "openai-compatible", model: provider.model.trim() || "unconfigured", attempt: 1, outcome: "failed", outcomeCode: "narration-failed",
        expectedTurnRevision: current.revision, expectedCampaignRevision: current.campaignRevision, idempotencyKey: key("narration-provider-failed", current.turnId) });
      else turn = current;
    }
  }
  return { turn, text: fallbackText };
}
async function narrate(repo: Repo & Repository, turn: PrivateAdventureTurn, dependencies: AdventureAgentDependencies | undefined,
  signal: AbortSignal): Promise<{ turn: PrivateAdventureTurn; text: string }> {
  const callId = key("narration-provider", turn.turnId);
  const active = activeNarrationDispatches.get(callId);
  if (active) return active;
  const dispatch = performNarration(repo, turn, dependencies, signal).finally(() => activeNarrationDispatches.delete(callId));
  activeNarrationDispatches.set(callId, dispatch);
  return dispatch;
}

function projectTurn(turn: PrivateAdventureTurn) {
  return { turnId: turn.turnId, campaignId: turn.campaignId, sessionId: turn.sessionId, actorId: turn.actorId,
    mode: turn.mode === "narration-fallback" ? "narration-retry" as const : turn.mode, priorTurnId: turn.priorTurnId,
    declaration: turn.declaration, state: turn.state, revision: turn.revision, createdAt: turn.createdAt, updatedAt: turn.updatedAt };
}
const proposals = (turn: PrivateAdventureTurn): AdventureTurnHttpProposal[] => turn.toolCalls.map(({ proposal }) => ({
  proposalId: proposal.proposalId, position: proposal.position, toolName: proposal.toolName,
  proposedAt: proposal.proposedAt, policy:{version:proposal.policy.version,category:proposal.policy.category,
    requiresConfirmation:proposal.policy.requiresConfirmation,requiredAuthorizer:proposal.policy.requiredAuthorizer,review:proposal.policy.review}, confirmation: proposal.confirmation.state === "decided"
    ? { state: "decided", decision: proposal.confirmation.decision.decision, decidedAt: proposal.confirmation.decision.decidedAt }
    : proposal.confirmation,
}));
const receipts = (turn: PrivateAdventureTurn) => turn.receiptLinks.map(({ commandId, proposalId, linkedAt }) => {
  return { commandId, proposalId, linkedAt };
});
function confirmation(turn: PrivateAdventureTurn) {
  const pending = turn.toolCalls.filter(({ proposal }) => proposal.confirmation.state === "pending");
  if (pending.length > 0) return { state: "pending" as const, proposalIds: pending.map(({ proposal }) => proposal.proposalId),
    expiresAt: pending.map(({ proposal }) => proposal.confirmation.state === "pending" ? proposal.confirmation.expiresAt : "").sort()[0]! };
  const decided = turn.toolCalls.flatMap(({ proposal }) => proposal.confirmation.state === "decided"
    ? [{ proposalId: proposal.proposalId, decision: proposal.confirmation.decision.decision, decidedAt: proposal.confirmation.decision.decidedAt }] : []);
  return decided.length > 0 ? { state: "decided" as const, decisions: decided } : { state: "none" as const };
}
function requirePrivate(value: ReturnType<Repo["getAdventureTurn"]>): PrivateAdventureTurn {
  if (!value || !("declaration" in value)) throw new AdventureTurnUnavailableError("turn is unavailable");
  return value;
}
function resumableDecisionDigest(turn: PrivateAdventureTurn): string | null {
  const required = turn.toolCalls.filter(({ proposal }) => proposal.confirmation.state !== "not-required");
  if (required.length === 0 || required.some(({ proposal }) => proposal.confirmation.state !== "decided")) return null;
  const decisions = required.map(({ proposal }) => {
    if (proposal.confirmation.state !== "decided" || proposal.confirmation.decision.principalId !== OWNER
      || !proposal.confirmation.decision.idempotencyKey.startsWith("batch:")) return null;
    const decision = proposal.confirmation.decision;
    return [proposal.proposalId, decision.decisionId, decision.decision, decision.expectedTurnRevision,
      decision.idempotencyKey, decision.principalId] as const;
  });
  if (decisions.some((decision) => decision === null)) return null;
  return createHash("sha256").update(JSON.stringify([turn.turnId, OWNER, decisions.sort((left, right) => left![0].localeCompare(right![0]))])).digest("base64url");
}
function resumeToken(turn: PrivateAdventureTurn): string | null {
  if(turn.state==="awaiting-confirmation"){
    const pending=turn.toolCalls.filter(({proposal})=>proposal.confirmation.state==="pending").map(({proposal})=>[proposal.proposalId,
      proposal.confirmation.state==="pending"?proposal.confirmation.expiresAt:"",proposal.policy.proposedCommandDigest]).sort((a,b)=>a[0]!.localeCompare(b[0]!));
    if(pending.length){const digest=createHash("sha256").update(JSON.stringify([turn.turnId,OWNER,pending])).digest("base64url");
      return adventureTurnResumeTokenSchema.parse(`v1.${Buffer.from(turn.turnId).toString("base64url")}.${digest}`);}
  }
  if (["declared","proposed"].includes(turn.state) && !turn.toolCalls.some(({proposal})=>proposal.confirmation.state==="pending")) {
    const digest=createHash("sha256").update(JSON.stringify([turn.turnId,OWNER,turn.createdAt,"automatic-planning"])).digest("base64url");
    return adventureTurnResumeTokenSchema.parse(`v1.${Buffer.from(turn.turnId).toString("base64url")}.${digest}`);
  }
  if (!["confirmed", "mechanics-committed", "narrating", "cancelled"].includes(turn.state)) return null;
  const digest = resumableDecisionDigest(turn); if (!digest) return null;
  return adventureTurnResumeTokenSchema.parse(`v1.${Buffer.from(turn.turnId).toString("base64url")}.${digest}`);
}
function reconcile(repo: Repo, turn: PrivateAdventureTurn) {
  const token = resumeToken(turn);
  return adventureTurnGetResponseSchema.parse({ turn: projectTurn(turn), proposals: proposals(turn), confirmation: confirmation(turn),
    receipts: receipts(turn), narrationStatus: { status: turn.narrationStatus, text: repo.getAdventureTurnNarration(OWNER, turn.turnId) },
    ...(token ? { resumeToken: token } : {}) });
}

function decodeResumeToken(token: string): { turnId: string; digest: string } {
  const parsed = adventureTurnResumeTokenSchema.parse(token);
  const [, turnPart, digest] = parsed.split(".");
  const turnId = Buffer.from(turnPart!, "base64url").toString("utf8");
  if (!resourceIdSchema.safeParse(turnId).success || !digest) throw new AdventureTurnUnavailableError();
  return { turnId, digest };
}
function turnFromToken(repo: Repo, token: string): PrivateAdventureTurn {
  const { turnId } = decodeResumeToken(token);
  const turn = requirePrivate(repo.getAdventureTurn(OWNER, turnId));
   if (resumeToken(turn) !== token) {
    throw new AdventureTurnUnavailableError("resume token is unavailable");
  }
  return turn;
}

function expireDue(repo:Repo,turn:PrivateAdventureTurn):PrivateAdventureTurn{
  if(!turn.toolCalls.some(({proposal})=>proposal.confirmation.state==="pending"))return turn;
  try{return repo.expireToolProposals(OWNER,{turnId:turn.turnId,expectedTurnRevision:turn.revision,
    expectedCampaignRevision:turn.campaignRevision,idempotencyKey:key("http-expire",turn.turnId,String(turn.revision))});}
  catch(error){if(error instanceof AdventureTurnConflictError)return turn;throw error;}
}

function fail(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], error: unknown) {
  if (error instanceof AdventureTurnUnavailableError || error instanceof AdventureTurnAuthorizationError) {
    return sendApiProblem(request, reply, 404, "RPG_ADVENTURE_TURN_NOT_FOUND", "Adventure turn not found");
  }
  if (error instanceof AdventureTurnStaleError) return sendApiProblem(request, reply, 409, "RPG_ADVENTURE_TURN_STALE", "Adventure turn is stale; reconcile before trying again");
  if (error instanceof AdventureTurnConflictError || error instanceof AdventureTurnExpiredError) return sendApiProblem(request, reply, 409, "RPG_ADVENTURE_TURN_CONFLICT", "Adventure turn command conflicts with durable state");
  request.log.error({ operation: "adventure-turn", method: request.method, route: request.routeOptions.url }, "RPG adventure turn operation failed");
  return sendApiProblem(request, reply, 500, "RPG_INTERNAL_ERROR", "Adventure turn status is unknown; reconcile with GET before retrying and do not automatically retry");
}

async function stream(request: FastifyRequest, reply: Parameters<typeof sendApiProblem>[1], repo: Repo, initial: PrivateAdventureTurn,
  streamKind: "initial" | "resume" | "variant", agentDependencies?:AdventureAgentDependencies): Promise<void> {
  let writer: SseWriter | null = null; let heartbeat: NodeJS.Timeout | null = null; let sequence = 0; let closed = false; let terminal = false;
  const abort = new AbortController();
  const send = (event: Omit<AdventureTurnStreamEvent, "sequence" | "timestamp">) => {
    if (!writer || closed) return;
    const envelope = adventureTurnStreamEventSchema.parse({ ...event, sequence, timestamp: new Date().toISOString() });
    sequence += 1; writer.send(envelope.type, envelope);
  };
  const finish = (turn: PrivateAdventureTurn, outcome: "done" | "aborted" | "error") => {
    if (terminal || closed) return; terminal = true;
    const view = reconcile(repo, turn);
    send({ type: "terminal", payload: { outcome, turn: view.turn, narrationStatus: view.narrationStatus, receipts: view.receipts } });
  };
  try {
    writer = openSse(reply, "private, no-store, no-transform"); reply.raw.on("close", () => { closed = true; abort.abort(); });
    const configuredHeartbeat = Number(process.env.VELVET_SSE_HEARTBEAT_MS ?? 15_000);
    heartbeat = setInterval(() => writer?.comment("heartbeat"), Number.isFinite(configuredHeartbeat) && configuredHeartbeat > 0 ? configuredHeartbeat : 15_000);
    heartbeat.unref();
    let turn = expireDue(repo,initial);
    if (streamKind === "resume" && turn.receiptLinks.some(({ linkId }) => linkId.startsWith("recoverable-"))) {
      turn = repo.reconcileAdventureTurnMechanics(OWNER, { turnId: turn.turnId, expectedTurnRevision: turn.revision,
        expectedCampaignRevision: turn.campaignRevision, idempotencyKey: key("http-reconcile", turn.turnId, String(turn.revision)) });
      await yieldToEventLoop();
    }
    if (closed) return;
    if (streamKind !== "resume") { send({ type: "turn_started", payload: { turn: projectTurn(turn) } }); await yieldToEventLoop(); }
    if (closed) return;
    if(turn.state==="completed"){
      const narration=repo.getAdventureTurnNarration(OWNER,turn.turnId);if(narration){send({type:"narration_delta",payload:{text:narration}});await yieldToEventLoop();}
      finish(turn,"done");return;
    }
    if(["cancelled","failed"].includes(turn.state)){
      const decisions=turn.toolCalls.flatMap(({proposal})=>proposal.confirmation.state==="decided"?[proposal.confirmation.decision.decision]:[]);
      send({type:"agent_status",payload:{status:decisions.includes("expired")?"expired":"decision-rejected"}});await yieldToEventLoop();
      finish(turn,turn.state==="cancelled"?"aborted":"error");return;}
    send({ type: "agent_status", payload: { status: turn.state === "awaiting-confirmation" ? "awaiting-confirmation" : "planning" } });
    await yieldToEventLoop();
    if (closed) return;
    if ((streamKind === "initial" || streamKind === "resume") && (["declared","proposed"].includes(turn.state)
      ||turn.toolCalls.some((call)=>call.status==="approved"))) {
      let agent=await orchestrateAdventureTurn(repo as Repo & Repository,turn.turnId,agentDependencies,abort.signal);turn=agent.turn;
      await yieldToEventLoop();
      if (closed) return;
      // An exclusive dispatch owner may be running in another resume. Wait for
      // its durable response and reconcile it; never emit a false aborted
      // terminal that suggests the already-dispatched request was cancelled.
      while(!closed&&agent.outcome==="in-progress"){
        await new Promise<void>((resolve)=>setTimeout(resolve,10));
        if (closed) return;
        turn=requirePrivate(repo.getAdventureTurn(OWNER,turn.turnId));
        agent=await orchestrateAdventureTurn(repo as Repo & Repository,turn.turnId,agentDependencies,abort.signal);turn=agent.turn;
      }
    }
    if (closed) return;

    const visibleProposals=streamKind==="initial"?proposals(turn):proposals(turn).filter((proposal)=>proposal.confirmation.state==="pending");
    for (const proposal of visibleProposals) { send({ type: "tool_proposed", payload: { proposal } }); await yieldToEventLoop(); }
    const pending = turn.toolCalls.filter(({ proposal }) => proposal.confirmation.state === "pending");
    if (pending.length > 0) {
      if (turn.state === "proposed") turn = repo.waitForToolConfirmation(OWNER, { turnId: turn.turnId,
        expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
        idempotencyKey: key("http-wait", turn.turnId) });
      await yieldToEventLoop();
      const state = confirmation(turn); if (state.state !== "pending") throw new Error("confirmation projection changed unexpectedly");
      send({ type: "confirmation_required", payload: { proposalIds: state.proposalIds, expiresAt: state.expiresAt } });
      await yieldToEventLoop();
      finish(turn, "aborted"); return;
    }
    if(["cancelled","failed"].includes(turn.state)){finish(turn,turn.state==="cancelled"?"aborted":"error");return;}

    if (turn.toolCalls.some((call)=>call.status==="approved") && turn.receiptLinks.length === 0) {
      send({ type: "agent_status", payload: { status: "pending-mechanics" } });
      await yieldToEventLoop();
      finish(turn, "aborted"); return;
    }
    if(turn.toolCalls.length>0&&turn.toolCalls.every((call)=>["rejected","expired","cancelled"].includes(call.status))){finish(turn,"aborted");return;}
    if (turn.receiptLinks.length > 0) { send({ type: "mechanics_committed", payload: { receipts: receipts(turn) } }); await yieldToEventLoop(); }
    let narration = repo.getAdventureTurnNarration(OWNER, turn.turnId);
    if (turn.narrationStatus !== "completed") {
      send({ type: "agent_status", payload: { status: "narrating" } });
      await yieldToEventLoop();
      if (turn.state !== "narrating") turn = repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId,
        expectedTurnRevision: turn.revision, expectedCampaignRevision: turn.campaignRevision,
        idempotencyKey: key("http-narrating", turn.turnId), narrationStatus: "in-progress" });
      await yieldToEventLoop();
       const narrated = await narrate(repo as Repo & Repository, turn, agentDependencies, abort.signal);
       turn = narrated.turn; narration = narrated.text;
      turn = repo.updateAdventureTurnNarration(OWNER, { turnId: turn.turnId, expectedTurnRevision: turn.revision,
        expectedCampaignRevision: turn.campaignRevision, idempotencyKey: key("http-narrated", turn.turnId),
        narrationStatus: "completed", terminalState: "completed", fallbackNarration: narration });
      await yieldToEventLoop();
    }
    if (narration) { send({ type: "narration_delta", payload: { text: narration } }); await yieldToEventLoop(); }
    finish(turn, "done");
  } catch (error) {
    if (closed || abort.signal.aborted) return;
    request.log.error({ operation: "adventure-turn-stream" }, "RPG adventure turn stream failed");
    try { finish(requirePrivate(repo.getAdventureTurn(OWNER, initial.turnId)), "error"); } catch { /* connection or durable state is unavailable */ }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (!reply.raw.destroyed && !reply.raw.writableEnded) writer?.end();
  }
}

/** Registers strict adventure-turn stream, reconciliation, and confirmation routes. */
export const adventureTurnsHttpRoutes: FastifyPluginAsync<AdventureTurnsHttpOptions> = async (app, options) => {
  app.post<{ Querystring: Record<string, unknown>; Body: unknown }>("/adventure-turns/stream", {
    onRequest: async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn streams do not accept query parameters"); return; }
      const type = request.headers["content-type"];
      if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Adventure turn streams require application/json");
    }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn stream request is invalid"),
  }, async (request, reply) => {
    const body = adventureTurnStreamRequestSchema.safeParse(request.body);
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn stream request is invalid");
    try {
      const repo = options.adventureTurnRepositoryAccessor();
      let turn: PrivateAdventureTurn;
       let streamKind: "initial" | "resume" | "variant" = "initial";
       if ("resumeToken" in body.data) { streamKind = "resume"; turn = turnFromToken(repo, body.data.resumeToken); }
       else if ("variant" in body.data) {
         streamKind = "variant";
         const campaign = repo.getCampaign(OWNER, body.data.campaignId); if (!campaign) throw new AdventureTurnUnavailableError();
         const prior = requirePrivate(repo.getAdventureTurn(OWNER, body.data.priorTurnId));
         if (prior.campaignId !== body.data.campaignId || prior.sessionId !== body.data.sessionId || prior.actorId !== body.data.actorId
           || !["completed", "cancelled", "failed"].includes(prior.state)) throw new AdventureTurnConflictError("narration ancestor is out of scope");
         turn = repo.createAdventureTurn(OWNER, { campaignId: body.data.campaignId, timelineId: campaign.activeTimelineId,
           sessionId: body.data.sessionId, actorId: body.data.actorId, declaration: prior.declaration, mode: body.data.variant,
           priorTurnId: prior.turnId, expectedCampaignRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey });
         turn = requirePrivate(repo.getAdventureTurn(OWNER, turn.turnId));
       }
       else {
        const campaign = repo.getCampaign(OWNER, body.data.campaignId);
        if (!campaign) throw new AdventureTurnUnavailableError();
        turn = repo.createAdventureTurn(OWNER, { campaignId: body.data.campaignId, timelineId: campaign.activeTimelineId,
          sessionId: body.data.sessionId, actorId: body.data.actorId, declaration: body.data.declaration,
          expectedCampaignRevision: body.data.expectedRevision, idempotencyKey: body.data.idempotencyKey });
        // Creation receipts intentionally replay their historical result; stream the fresh durable aggregate.
        turn = requirePrivate(repo.getAdventureTurn(OWNER, turn.turnId));
      }
       // The durable identity exists before SSE framing for both initial and
      // resume requests, allowing clients to reconcile even if the first body
      // frame is never delivered.
      // openSse hijacks Fastify and writes directly to the Node response, so
      // bind this route-specific header on the raw response before writeHead.
      reply.raw.setHeader("X-Adventure-Turn-Id", turn.turnId);
        await stream(request, reply, repo, turn, streamKind,options.agentDependencies);
    } catch (error) { return fail(request, reply, error); }
  });

  // Register the fixed reconciliation locator before the turn-ID resource so
  // every route and error path retains its reviewed static identity.
  app.get<{ Querystring: Record<string, unknown> }>("/adventure-turns/reconcile-initial", { exposeHeadRoute: false,
    onRequest: async (request, reply) => { reply.header("cache-control", "private, no-store"); if (!enabled()) {
      await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; } },
  }, async (request, reply) => {
    const query = adventureTurnInitialReconcileRequestSchema.safeParse(request.query);
    if (!query.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Initial turn reconciliation locator is invalid");
    try {
      const repo = options.adventureTurnRepositoryAccessor();
      const found = repo.getAdventureTurnByInitialIdempotencyKey(OWNER, query.data.campaignId, query.data.sessionId,
        query.data.actorId, query.data.idempotencyKey);
       const result = found ? reconcile(repo, expireDue(repo,requirePrivate(found))) : null;
      return reply.send(adventureTurnInitialReconcileResponseSchema.parse({ result }));
    } catch (error) { return fail(request, reply, error); }
  });

  app.get<{ Params: { turnId: string }; Querystring: Record<string, unknown> }>("/adventure-turns/:turnId", { exposeHeadRoute: false,
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store"); if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn reads do not accept query parameters"); },
  }, async (request, reply) => {
    const turnId = resourceIdSchema.safeParse(request.params.turnId); if (!turnId.success) return sendApiProblem(request, reply, 404, "RPG_ADVENTURE_TURN_NOT_FOUND", "Adventure turn not found");
    try { const repo=options.adventureTurnRepositoryAccessor();return reply.send(reconcile(repo,expireDue(repo,requirePrivate(repo.getAdventureTurn(OWNER, turnId.data))))); }
    catch (error) { return fail(request, reply, error); }
  });

  app.post<{ Params: { turnId: string }; Querystring: Record<string, unknown>; Body: unknown }>("/adventure-turns/:turnId/confirm", {
    onRequest: async (request, reply) => { reply.header("cache-control", "no-store"); if (!enabled()) { await sendApiProblem(request, reply, 404, "RPG_ROUTE_NOT_FOUND", "RPG route not found"); return; }
      if (hasQuery(request)) { await sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn confirmation does not accept query parameters"); return; }
      if (!resourceIdSchema.safeParse(request.params.turnId).success) { await sendApiProblem(request, reply, 404, "RPG_ADVENTURE_TURN_NOT_FOUND", "Adventure turn not found"); return; }
      const type = request.headers["content-type"]; if (typeof type !== "string" || !JSON_TYPE.test(type)) await sendApiProblem(request, reply, 415, "RPG_UNSUPPORTED_MEDIA_TYPE", "Adventure turn confirmation requires application/json");
    }, errorHandler: (_error, request, reply) => sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn confirmation request is invalid"),
  }, async (request, reply) => {
    const turnId = resourceIdSchema.safeParse(request.params.turnId), body = adventureTurnConfirmRequestSchema.safeParse(request.body);
    if (!turnId.success) return sendApiProblem(request, reply, 404, "RPG_ADVENTURE_TURN_NOT_FOUND", "Adventure turn not found");
    if (!body.success) return sendApiProblem(request, reply, 400, "RPG_INVALID_REQUEST", "Adventure turn confirmation request is invalid");
    try {
      const repo = options.adventureTurnRepositoryAccessor(); const before = requirePrivate(repo.getAdventureTurn(OWNER, turnId.data));
       let turn = repo.decideToolProposals(OWNER, { turnId: turnId.data, proposalIds: body.data.proposalIds,
         decision: body.data.decision === "approve" ? "approved" : "rejected", expectedTurnRevision: body.data.expectedRevision,
         expectedCampaignRevision: before.campaignRevision, idempotencyKey: body.data.idempotencyKey });
       const planning=(repo as Repo&Repository).getDurableAgentPlanningState(OWNER,turn.turnId);
       const providerSelected=turn.toolCalls.some((call)=>call.status==="approved"&&call.proposal.executionBinding.commandType==="combat_action")
         ||Boolean(planning?.toolCalls.some((call)=>call.kind==="mutation"));
       const noPending=!turn.toolCalls.some(({proposal})=>proposal.confirmation.state==="pending");
       if(noPending&&providerSelected)turn=(await orchestrateAdventureTurn(repo as Repo&Repository,turn.turnId,options.agentDependencies)).turn;
      const token = resumeToken(turn); const response = { turn: projectTurn(turn), ...(token ? { resumeToken: token } : {}) };
      return reply.send(adventureTurnConfirmResponseSchema.parse(response));
    } catch (error) { return fail(request, reply, error); }
  });
};

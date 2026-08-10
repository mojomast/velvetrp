import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  appendToolProposalInputSchema, applyGenerationDraftInputSchema, createAdventureTurnInputSchema,
  AGENT_TOOL_REGISTRY_VERSION, DEFAULT_AGENT_EXECUTION_LIMITS,
  createGenerationDraftInputSchema, decideToolProposalInputSchema, decideToolProposalsInputSchema, generationDraftValidationSchema,
  linkTurnReceiptInputSchema, privateAdventureTurnSchema, privateGenerationDraftSchema,
  providerCallOutcomeInputSchema, providerCallStartInputSchema, resourceIdSchema, canonicalAgentJson,
  reviewGenerationDraftInputSchema, stagedGenerationContentSchema, turnMutationInputSchema,
  updateTurnNarrationInputSchema, utcIsoTimestampSchema,
  type AppendToolProposalInput, type ApplyGenerationDraftInput, type CreateAdventureTurnInput,
  type CreateGenerationDraftInput, type DecideToolProposalInput, type DecideToolProposalsInput, type DraftMutationInput,
  type LinkTurnReceiptInput, type PrivateAdventureTurn, type PrivateGenerationDraft,
  type ProviderCallOutcomeInput, type ProviderCallStartInput, type ReviewGenerationDraftInput,
  type TurnMutationInput, type UpdateTurnNarrationInput,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";
import { AdventureTurnAuthorizationError, AdventureTurnConflictError, AdventureTurnExpiredError, AdventureTurnStaleError, AdventureTurnUnavailableError } from "./errors.js";
import { createAdventureTurnReadRepository, type AdventureTurnReadRepository } from "./read.js";
import { deriveConfirmationPolicy } from "../../agent/confirmationPolicy.js";

export type { AppendToolProposalInput, ApplyGenerationDraftInput, CreateAdventureTurnInput, CreateGenerationDraftInput,
  DecideToolProposalInput, DecideToolProposalsInput, DraftMutationInput, LinkTurnReceiptInput, ProviderCallOutcomeInput, ProviderCallStartInput,
  ReviewGenerationDraftInput, TurnMutationInput, UpdateTurnNarrationInput };

type Database = DatabaseDriver.Database;
type AggregateKind = "turn" | "draft";
type Action = "turn" | "provider" | "draft";

/** Runtime and transaction guard dependencies for M1.10 writes. */
export interface AdventureTurnWriteContext { clock: Clock; ids: IdGenerator; guard(): void }

/** Authoritative M1.10 mutation surface. */
export interface AdventureTurnWriteRepository {
  /** Creates a durable declaration or receipt-inheriting narration derivative. */
  createAdventureTurn(principalId: string, input: CreateAdventureTurnInput): PrivateAdventureTurn;
  /** Appends one bounded tool proposal. */
  appendToolProposal(principalId: string, input: AppendToolProposalInput): PrivateAdventureTurn;
  /** Persists the exact confirmation wait command and immutable result. */
  waitForToolConfirmation(principalId: string, input: TurnMutationInput): PrivateAdventureTurn;
  /** Records one exact, non-expired proposal decision. */
  decideToolProposal(principalId: string, input: DecideToolProposalInput): PrivateAdventureTurn;
  /** Atomically records one decision across an exact proposal set and advances the turn once. */
  decideToolProposals(principalId: string, input: DecideToolProposalsInput): PrivateAdventureTurn;
  /** Atomically records every due immutable expiry and advances the turn once. */
  expireToolProposals(principalId: string, input: TurnMutationInput): PrivateAdventureTurn;
  /** Returns a stale approved proposal to planning without changing turn identity. */
  replanAgentProposal(principalId:string,input:{turnId:string;proposalId:string;reason:string;expectedTurnRevision:number;expectedCampaignRevision:number;idempotencyKey:string}):PrivateAdventureTurn;
  /** Records provider start metadata only; no provider work runs in this transaction. */
  recordProviderCallStart(principalId: string, input: ProviderCallStartInput): PrivateAdventureTurn;
  /** Records a matching provider outcome without directly completing narration. */
  recordProviderCallOutcome(principalId: string, input: ProviderCallOutcomeInput): PrivateAdventureTurn;
  /** Links one exact source-turn command receipt to one approved proposal. */
  linkFinalMechanicsReceipt(principalId: string, input: LinkTurnReceiptInput): PrivateAdventureTurn;
  /** Reconciles committed source-turn commands after a crash between command execution and linking. */
  reconcileAdventureTurnMechanics(principalId: string, input: TurnMutationInput): PrivateAdventureTurn;
  /** Advances narration or cancellation after reconciling any committed source-turn commands. */
  updateAdventureTurnNarration(principalId: string, input: UpdateTurnNarrationInput): PrivateAdventureTurn;
  /** Creates generated content staged for owner/GM review. */
  createGenerationDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  /** Records one immutable owner/GM review. */
  reviewGenerationDraft(principalId: string, input: ReviewGenerationDraftInput): PrivateGenerationDraft;
  /** Applies an approved draft with a draft-specific receipt, never an arbitrary campaign command. */
  applyGenerationDraft(principalId: string, input: ApplyGenerationDraftInput): PrivateGenerationDraft;
  /** Reviews, applies the authoritative encounter command, and seals one draft in one SQLite transaction. */
  applyEncounterGenerationDraftAtomically(principalId: string, input: DraftMutationInput): { draft: PrivateGenerationDraft; encounterId: string };
  /** Applies a reviewed content bundle through the campaign-content command service. */
  applyCampaignContentGenerationDraftAtomically(principalId: string, input: DraftMutationInput): PrivateGenerationDraft;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
  ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) : nested);

/** Creates synchronous, immediate coordination transactions; provider waits and deterministic commands remain separate transactions. */
export function createAdventureTurnWriteRepository(db: Database, context: AdventureTurnWriteContext,
  reads: AdventureTurnReadRepository = createAdventureTurnReadRepository(db)): AdventureTurnWriteRepository {
  const now = () => utcIsoTimestampSchema.parse(context.clock.now().toISOString());
  const id = () => resourceIdSchema.parse(context.ids.nextId());
  const immediate = <T>(work: () => T): T => { context.guard(); return db.transaction(work).immediate(); };
  const turn = (turnId: string) => { const row = db.prepare("SELECT * FROM adventure_turns WHERE id=?").get(turnId) as any;
    if (!row) throw new AdventureTurnUnavailableError("turn is unavailable"); return row; };
  const draft = (draftId: string) => { const row = db.prepare("SELECT * FROM generation_drafts WHERE id=?").get(draftId) as any;
    if (!row) throw new AdventureTurnUnavailableError("draft is unavailable"); return row; };
  const latest = (kind: AggregateKind, campaignId: string, aggregateId: string) => db.prepare(`SELECT * FROM adventure_coordination_events_v36
    WHERE aggregate_kind=? AND campaign_id=? AND aggregate_id=? ORDER BY resulting_revision DESC LIMIT 1`).get(kind, campaignId, aggregateId) as any;
  const privateTurn = (principalId: string, turnId: string) => {
    const value = reads.getAdventureTurn(principalId, turnId); if (!value || !("declaration" in value)) throw new AdventureTurnUnavailableError("private turn is unavailable"); return value;
  };
  const privateDraft = (principalId: string, draftId: string) => {
    const value = reads.getGenerationDraft(principalId, draftId); if (!value || !("stagedContent" in value)) throw new AdventureTurnUnavailableError("private draft is unavailable"); return value;
  };

  function authority(principalId: string, row: any, expectedCampaignRevision: number, action: Action): void {
    const campaign = db.prepare("SELECT active_timeline_id,administration_revision,lifecycle_status FROM campaigns WHERE id=?").get(row.campaign_id) as any;
    if (!campaign) throw new AdventureTurnUnavailableError("campaign is unavailable");
    if (campaign.lifecycle_status !== "draft" && campaign.lifecycle_status !== "published") throw new AdventureTurnStaleError("campaign lifecycle does not permit coordination");
    if (campaign.active_timeline_id !== row.timeline_id) throw new AdventureTurnStaleError("active timeline changed");
    if (campaign.administration_revision !== expectedCampaignRevision) throw new AdventureTurnStaleError("campaign revision is stale");
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(row.campaign_id, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new AdventureTurnAuthorizationError("current action role is required");
    if (action === "draft" && member.role !== "owner" && member.role !== "gm") throw new AdventureTurnAuthorizationError("owner or GM authority is required");
    if (row.session_id) {
      const active = db.prepare(`SELECT 1 FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
        WHERE attached.campaign_id=? AND attached.session_id=? AND session.state='active' AND session.stopped_at IS NULL`).get(row.campaign_id, row.session_id);
      if (!active) throw new AdventureTurnStaleError("an attached active session is required");
    }
    if (action !== "draft") {
      const participant = db.prepare(`SELECT 1 FROM campaign_actors actor JOIN campaign_characters cc
        ON cc.campaign_id=actor.campaign_id AND cc.id=actor.campaign_character_id JOIN session_characters participant
        ON participant.character_id=cc.character_id WHERE actor.campaign_id=? AND actor.id=? AND participant.session_id=?`).get(row.campaign_id, row.actor_id, row.session_id);
      if (!participant) throw new AdventureTurnAuthorizationError("the selected actor persona is not a session participant");
      if (member.role !== "owner" && member.role !== "gm" && (member.role !== "player" || !db.prepare(`SELECT 1 FROM campaign_actor_private_state
        WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(row.campaign_id, row.actor_id, principalId))) {
        throw new AdventureTurnAuthorizationError("current actor control is required");
      }
    }
  }

  function attestConfirmationAuthority(row:any,proposal:any,principalId:string,decisionId:string,
    decision:"approved"|"rejected"|"expired",at:string):void {
    const member=db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(row.campaign_id,principalId) as {role:"owner"|"gm"|"player"|"observer"}|undefined;
    const controlled=Boolean(db.prepare(`SELECT 1 FROM campaign_actor_private_state
      WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(row.campaign_id,row.actor_id,principalId));
    const control=member?.role==="owner"||member?.role==="gm"?"all":controlled?"controlled":"none";
    if(!member||member.role==="observer"||(member.role==="player"&&!controlled)
      ||(decision!=="expired"&&proposal.required_authorizer==="gm"&&!['owner','gm'].includes(member.role)))
      throw new AdventureTurnAuthorizationError("decision-time confirmation authority is required");
    const policyDigest=createHash("sha256").update(canonicalAgentJson({version:proposal.policy_version,category:proposal.category,
      requiresConfirmation:Boolean(proposal.policy_requires_confirmation??proposal.requires_confirmation),
      requiredAuthorizer:proposal.required_authorizer,proposedCommandDigest:proposal.proposed_command_digest,
      observedDomains:JSON.parse(proposal.observed_domain_revisions_json)} as never)).digest("hex");
    const value={evidenceVersion:"v1",authorityProven:true,decisionId,campaignId:row.campaign_id,turnId:row.id,
      proposalId:proposal.proposal_id,principalId,decision,actorId:row.actor_id,authorityRole:member.role,
      authorityControl:control,requiredAuthorizer:proposal.required_authorizer,policyDigest,attestedAt:at};
    const json=canonicalAgentJson(value as never);
    db.prepare("INSERT INTO confirmation_authority_evidence_v40 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id(),decisionId,row.campaign_id,row.id,proposal.proposal_id,principalId,decision,"v1",member.role,control,row.actor_id,
        proposal.required_authorizer,policyDigest,json,createHash("sha256").update(json).digest("hex"),at);
  }

  const stale = (kind: AggregateKind, row: any, expected: number) => {
    const event = latest(kind, row.campaign_id, row.id); if (!event || event.resulting_revision !== expected) throw new AdventureTurnStaleError(`${kind} revision is stale`); return event;
  };
  const replay = <T>(kind: AggregateKind, row: any, principalId: string, mutationType: string, input: { idempotencyKey: string; expectedCampaignRevision: number }, expectedRevision: number,
    schema: { parse(value: unknown): T }): T | null => {
    const command = db.prepare(`SELECT command.*,receipt.result_json FROM adventure_coordination_commands_v36 command
      JOIN adventure_coordination_receipts_v36 receipt ON receipt.command_id=command.command_id
      WHERE command.aggregate_kind=? AND command.campaign_id=? AND command.aggregate_id=? AND command.idempotency_key=?`)
      .get(kind, row.campaign_id, row.id, input.idempotencyKey) as any;
    if (!command) return null;
    if (command.principal_id !== principalId || command.mutation_type !== mutationType || command.request_json !== canonical(input)
        || command.expected_revision !== expectedRevision || command.expected_campaign_revision !== input.expectedCampaignRevision) {
      throw new AdventureTurnConflictError("idempotency key was reused with changed values");
    }
    return schema.parse(JSON.parse(command.result_json));
  };
  const command = (kind: AggregateKind, row: any, principalId: string, mutationType: string, input: any, expected: number, resulting: number, at: string) => {
    const commandId = id();
    db.prepare(`INSERT INTO adventure_coordination_commands_v36(command_id,aggregate_kind,campaign_id,aggregate_id,principal_id,mutation_type,
      idempotency_key,expected_revision,expected_campaign_revision,resulting_revision,request_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(commandId, kind, row.campaign_id, row.id, principalId, mutationType, input.idempotencyKey, expected, input.expectedCampaignRevision, resulting, canonical(input), at);
    return commandId;
  };
  const finish = <T>(kind: AggregateKind, row: any, principalId: string, mutationType: string, input: any, expected: number,
    state: string, narration: string | null, at: string, read: () => T): T => {
    const resulting = expected + 1;
    if (row.revision !== resulting) throw new AdventureTurnStaleError(`${kind} physical revision did not advance exactly once`);
    const commandId = command(kind, row, principalId, mutationType, input, expected, resulting, at), eventId = id();
    db.prepare(`INSERT INTO adventure_coordination_events_v36(event_id,command_id,aggregate_kind,campaign_id,aggregate_id,principal_id,mutation_type,
      expected_revision,resulting_revision,resulting_state,narration_status,event_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(eventId, commandId, kind, row.campaign_id, row.id, principalId, mutationType, expected, resulting, state, narration, canonical({ state, narrationStatus: narration }), at);
    const result = read();
    db.prepare(`INSERT INTO adventure_coordination_receipts_v36(command_id,event_id,aggregate_kind,campaign_id,aggregate_id,expected_revision,resulting_revision,result_json)
      VALUES(?,?,?,?,?,?,?,?)`).run(commandId, eventId, kind, row.campaign_id, row.id, expected, resulting, canonical(result));
    return result;
  };
  const physicalAdvance = (row: any, state: string, narration: string, at: string) => {
    const changed = db.prepare("UPDATE adventure_turns SET state=?,narration_status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
      .run(state, narration, at, row.id, row.revision).changes;
    if (changed !== 1) throw new AdventureTurnStaleError("physical turn revision changed");
    row.state = state; row.narration_status = narration; row.revision += 1;
  };
  const root = (row: any) => { let current = row; const visited = new Set<string>(); while (current.mode !== "original") {
    if (visited.has(current.id) || !current.prior_turn_id) throw new AdventureTurnConflictError("narration ancestry is cyclic or incomplete");
    visited.add(current.id); current = turn(current.prior_turn_id);
  } return current; };
  const approvedProposals = (row: any) => db.prepare(`SELECT proposal.* FROM tool_proposals proposal LEFT JOIN confirmation_decisions decision
    ON decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id
    WHERE proposal.campaign_id=? AND proposal.turn_id=? AND (proposal.requires_confirmation=0 OR decision.decision='approved') ORDER BY proposal.position`)
    .all(row.campaign_id, row.id) as any[];
  const commandType = (toolName: string): "set_actor_attribute" | "initialize_actor_resource" | "roll_actor_dice" | "combat_action" => {
    if (["roll", "roll-check", "roll_actor_dice"].includes(toolName)) return "roll_actor_dice";
    if (toolName === "set_actor_attribute" || toolName === "initialize_actor_resource") return toolName;
    if(toolName==="combat_action")return "combat_action";
    throw new AdventureTurnConflictError("tool proposal has no supported mechanics command binding");
  };
  const insertMechanicsLink = (row: any, proposalId: string, commandId: string, at: string) => {
    const authoritative = db.prepare(`SELECT 1 FROM campaign_commands command JOIN command_receipts receipt
      ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id WHERE command.campaign_id=?
        AND command.command_id=? AND command.timeline_id=? AND command.actor_id=? AND command.source_turn_id=?
        AND command.idempotency_key=(SELECT execution_idempotency_key FROM tool_proposal_execution_bindings_v37
          WHERE campaign_id=? AND turn_id=? AND proposal_id=?)`)
      .get(row.campaign_id, commandId, row.timeline_id, row.actor_id, row.id, row.campaign_id, row.id, proposalId);
    if (!authoritative) throw new AdventureTurnUnavailableError("mechanics receipt provenance is unavailable");
    const linkId = id();
    db.prepare(`INSERT INTO turn_mechanics_links_v36(link_id,campaign_id,turn_id,root_turn_id,proposal_id,command_id,source_turn_id,linked_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(linkId, row.campaign_id, row.id, row.id, proposalId, commandId, row.id, at);
    db.prepare(`INSERT INTO final_receipt_links(link_id,campaign_id,turn_id,draft_id,command_id,idempotency_key,linked_at)
      VALUES(?,?,?,NULL,?,?,?)`).run(linkId, row.campaign_id, row.id, commandId, `v36:${proposalId}`, at);
  };
  const reconcile = (row: any, at: string): number => {
    const proposals = approvedProposals(row);
    const unlinked = proposals.filter((proposal) => !db.prepare("SELECT 1 FROM turn_mechanics_links_v36 WHERE campaign_id=? AND turn_id=? AND proposal_id=?")
      .get(row.campaign_id, row.id, proposal.proposal_id));
    const commands = db.prepare(`SELECT command.command_id,binding.proposal_id FROM campaign_commands command JOIN command_receipts receipt
      ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
      JOIN tool_proposal_execution_bindings_v37 binding ON binding.campaign_id=command.campaign_id
        AND binding.execution_idempotency_key=command.idempotency_key AND binding.turn_id=command.source_turn_id
        AND binding.timeline_id=command.timeline_id AND binding.actor_id=command.actor_id AND binding.command_type=command.type
      WHERE command.campaign_id=? AND command.timeline_id=? AND command.actor_id=? AND command.source_turn_id=?
        AND NOT EXISTS(SELECT 1 FROM turn_mechanics_links_v36 link WHERE link.campaign_id=command.campaign_id AND link.command_id=command.command_id)
      ORDER BY receipt.revision_after,command.command_id`).all(row.campaign_id, row.timeline_id, row.actor_id, row.id) as Array<{ command_id: string; proposal_id: string }>;
    if (commands.length > unlinked.length) throw new AdventureTurnConflictError("source-turn commands exceed approved proposals");
    for (const entry of commands) {
      const proposal = unlinked.find((candidate) => candidate.proposal_id === entry.proposal_id);
      if (!proposal) throw new AdventureTurnConflictError("source-turn command proposal execution binding is invalid");
      insertMechanicsLink(row, proposal.proposal_id, entry.command_id, at);
      unlinked.splice(unlinked.indexOf(proposal), 1);
    }
    return commands.length;
  };
  const mechanicsState = (row: any): "confirmed" | "mechanics-committed" => {
    const approved = approvedProposals(row); const linked = (db.prepare("SELECT count(*) count FROM turn_mechanics_links_v36 WHERE campaign_id=? AND turn_id=?")
      .get(row.campaign_id, row.id) as { count: number }).count;
    return approved.length > 0 && linked === approved.length ? "mechanics-committed" : "confirmed";
  };

  return {
    createAdventureTurn(principalId, raw) { const input = createAdventureTurnInputSchema.parse(raw); return immediate(() => {
      const synthetic = { campaign_id: input.campaignId, timeline_id: input.timelineId, session_id: input.sessionId, actor_id: input.actorId };
      authority(principalId, synthetic, input.expectedCampaignRevision, "turn");
      const existingCommand = db.prepare(`SELECT command.aggregate_id FROM adventure_coordination_commands_v36 command WHERE command.aggregate_kind='turn'
        AND command.campaign_id=? AND command.idempotency_key=? AND command.mutation_type='turn-create'`).get(input.campaignId, input.idempotencyKey) as any;
      if (existingCommand) { const row = turn(existingCommand.aggregate_id); const old = replay("turn", row, principalId, "turn-create", input, -1, privateAdventureTurnSchema); if (old) return old; }
      const mode = input.mode ?? "original", priorId = input.priorTurnId ?? null; let state = "declared", narration = "none";
      if (mode !== "original") {
        const prior = turn(priorId!); authority(principalId, prior, input.expectedCampaignRevision, "turn");
        if (prior.campaign_id !== input.campaignId || prior.timeline_id !== input.timelineId || prior.session_id !== input.sessionId || prior.actor_id !== input.actorId)
          throw new AdventureTurnConflictError("narration ancestry is out of scope");
        const priorState = latest("turn", prior.campaign_id, prior.id)?.resulting_state;
        if (!["completed", "cancelled", "failed"].includes(priorState)) throw new AdventureTurnConflictError("narration retry requires a terminal ancestor");
        state = "mechanics-committed"; narration = "pending";
      }
      const row = { id: id(), campaign_id: input.campaignId, timeline_id: input.timelineId, session_id: input.sessionId, actor_id: input.actorId,
        revision: 0 } as any;
      const at = now(), physicalMode = mode === "narration-fallback" ? "narration-retry" : mode;
      db.prepare(`INSERT INTO adventure_turns(id,campaign_id,timeline_id,session_id,actor_id,principal_id,declaration,mode,prior_turn_id,state,narration_status,
        revision,campaign_revision,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'declared','none',0,?,?,?,?)`)
        .run(row.id, input.campaignId, input.timelineId, input.sessionId, input.actorId, principalId, input.declaration, physicalMode, priorId,
          input.expectedCampaignRevision, input.idempotencyKey, at, at);
      const limits = input.executionLimits ?? DEFAULT_AGENT_EXECUTION_LIMITS;
      const deadlineAt = utcIsoTimestampSchema.parse(new Date(new Date(at).getTime() + limits.durationMs).toISOString());
      db.prepare(`INSERT INTO adventure_agent_executions_v38(campaign_id,turn_id,tool_registry_version,
        max_decision_rounds,max_tool_calls,max_mutation_calls,max_provider_calls,max_duration_ms,started_at,deadline_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(row.campaign_id, row.id, AGENT_TOOL_REGISTRY_VERSION,
          limits.decisionRounds, limits.toolCalls, limits.mutationCalls, limits.providerCalls, limits.durationMs, at, deadlineAt);
      return finish("turn", row, principalId, "turn-create", input, -1, state, narration, at, () => privateTurn(principalId, row.id));
    }); },
    appendToolProposal(principalId, raw) { const input = appendToolProposalInputSchema.parse(raw); return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "turn");
      const old = replay("turn", row, principalId, "proposal-append", input, input.expectedTurnRevision, privateAdventureTurnSchema); if (old) return old;
      const current = stale("turn", row, input.expectedTurnRevision); if (row.mode !== "original" || !["declared", "proposed"].includes(current.resulting_state)) throw new AdventureTurnConflictError("turn cannot accept proposals");
      const position = (db.prepare("SELECT count(*) count FROM tool_proposals WHERE campaign_id=? AND turn_id=?").get(row.campaign_id, row.id) as { count: number }).count;
      const at = now(), proposalId = id(), argumentsJson = canonical(input.arguments);
      const timelineRevision=(db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(row.campaign_id,row.timeline_id) as {revision:number}|undefined)?.revision;
      if(timelineRevision===undefined)throw new AdventureTurnStaleError("timeline is unavailable");
      const combatRevision=Number.isSafeInteger((input.arguments as any).expectedCombatRevision)?(input.arguments as any).expectedCombatRevision as number:undefined;
      const autonomousEnemy=input.toolName==="combat_action"&&Boolean(db.prepare(`SELECT 1 FROM encounter JOIN combatant ON combatant.encounter_id=encounter.encounter_id
        WHERE encounter.encounter_id=? AND encounter.campaign_id=? AND encounter.current_turn_combatant_id=combatant.combatant_id AND combatant.combatant_kind='enemy'`)
        .get((input.arguments as any).encounterId,row.campaign_id));
      const policy=deriveConfirmationPolicy({toolName:input.toolName,arguments:input.arguments,campaignRevision:row.campaign_revision,
        turnRevision:input.expectedTurnRevision,timelineRevision,...(combatRevision===undefined?{}:{combatRevision}),autonomousEnemy,at});
      if(policy.requiresConfirmation&&!input.confirmationExpiresAt)throw new AdventureTurnConflictError("server policy requires a confirmation expiry");
      db.prepare(`INSERT INTO tool_proposals(proposal_id,campaign_id,turn_id,position,tool_name,arguments_json,requires_confirmation,confirmation_expires_at,idempotency_key,proposed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(proposalId, row.campaign_id, row.id, position, input.toolName, argumentsJson, policy.requiresConfirmation ? 1 : 0,
          policy.requiresConfirmation ? input.confirmationExpiresAt : null, input.idempotencyKey, at);
      db.prepare(`INSERT INTO confirmation_policy_attestations_v40 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(proposalId,row.campaign_id,row.id,
        policy.version,policy.category,policy.requiresConfirmation?1:0,policy.requiredAuthorizer,canonicalAgentJson(policy.review as never),
        policy.proposedCommandDigest,canonicalAgentJson(policy.observedDomains),policy.attestedAt);
      const executionKey = `mechanics:${createHash("sha256").update(proposalId).digest("hex").slice(0, 48)}`;
       if(commandType(input.toolName)==="combat_action"){
         const args=input.arguments as Record<string,unknown>;
           db.prepare(`INSERT INTO agent_combat_proposal_bindings_v39(proposal_id,campaign_id,turn_id,provider_call_id,provider_tool_call_id,encounter_id,legal_action_id,command_legal_action_id,legal_action_digest,expected_combat_revision,execution_idempotency_key,bound_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
             .run(proposalId,row.campaign_id,row.id,args.providerCallId,args.providerToolCallId,args.encounterId,args.legalActionId,args.commandLegalActionId,args.legalActionDigest,args.expectedCombatRevision,executionKey,at);
           const response=db.prepare(`SELECT context.round_number FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context
             ON context.context_id=response.context_id AND context.campaign_id=response.campaign_id AND context.turn_id=response.turn_id
               AND context.provider_call_id=response.provider_call_id
             WHERE response.campaign_id=? AND response.provider_call_id=? AND response.turn_id=? AND response.status='succeeded'`)
             .get(row.campaign_id,args.providerCallId,row.id) as {round_number:number}|undefined;
          if(!response)throw new AdventureTurnConflictError("combat mutation lacks durable provider response");
          db.prepare(`INSERT INTO agent_mutation_accounting_v40 VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id(),row.campaign_id,row.id,proposalId,
            args.providerCallId,args.providerToolCallId,response.round_number,"combat_action.execute",createHash("sha256").update(canonicalAgentJson(input.arguments as never)).digest("hex"),at);
       }else db.prepare(`INSERT INTO tool_proposal_execution_bindings_v37(proposal_id,campaign_id,turn_id,execution_idempotency_key,
         command_type,source_turn_id,timeline_id,actor_id,bound_at) VALUES(?,?,?,?,?,?,?,?,?)`)
         .run(proposalId, row.campaign_id, row.id, executionKey, commandType(input.toolName), row.id, row.timeline_id, row.actor_id, at);
       physicalAdvance(row, row.state==="mechanics-committed"?"mechanics-committed":"proposed", "none", at);
      return finish("turn", row, principalId, "proposal-append", input, input.expectedTurnRevision, "proposed", "none", at, () => privateTurn(principalId, row.id));
    }); },
    waitForToolConfirmation(principalId, raw) { const input = turnMutationInputSchema.parse(raw); return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "turn");
      const old = replay("turn", row, principalId, "confirmation-wait", input, input.expectedTurnRevision, privateAdventureTurnSchema); if (old) return old;
      const current = stale("turn", row, input.expectedTurnRevision); if (current.resulting_state !== "proposed" || !db.prepare(`SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=? AND proposal.turn_id=? AND proposal.requires_confirmation=1
        AND NOT EXISTS(SELECT 1 FROM confirmation_decisions decision WHERE decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id)`).get(row.campaign_id, row.id))
        throw new AdventureTurnConflictError("no proposal is waiting for confirmation");
      const at = now(); physicalAdvance(row, row.state==="mechanics-committed"?"mechanics-committed":"awaiting-confirmation", "none", at);
      return finish("turn", row, principalId, "confirmation-wait", input, input.expectedTurnRevision, "awaiting-confirmation", "none", at, () => privateTurn(principalId, row.id));
    }); },
    decideToolProposal(principalId, raw) { const input = decideToolProposalInputSchema.parse(raw); return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "turn");
      const old = replay("turn", row, principalId, "confirmation-decision", input, input.expectedTurnRevision, privateAdventureTurnSchema); if (old) return old;
      const current = stale("turn", row, input.expectedTurnRevision); if (current.resulting_state !== "awaiting-confirmation") throw new AdventureTurnConflictError("turn is not waiting for confirmation");
        const proposal = db.prepare(`SELECT proposal.*,policy.required_authorizer,policy.policy_version,policy.category,
          policy.requires_confirmation policy_requires_confirmation,policy.proposed_command_digest,policy.observed_domain_revisions_json FROM tool_proposals proposal
         JOIN confirmation_policy_attestations_v40 policy ON policy.campaign_id=proposal.campaign_id
           AND policy.turn_id=proposal.turn_id AND policy.proposal_id=proposal.proposal_id
         WHERE proposal.campaign_id=? AND proposal.turn_id=? AND proposal.proposal_id=? AND proposal.requires_confirmation=1`)
         .get(row.campaign_id, row.id, input.proposalId) as any;
       if (!proposal || proposal.confirmation_expires_at !== input.expiresAt || proposal.policy_version!=="v1"
         || !proposal.policy_requires_confirmation) throw new AdventureTurnConflictError("confirmation proposal, policy, or expiry does not match");
       const at = now(); if (at >= input.expiresAt) throw new AdventureTurnExpiredError("confirmation expired");
       const decisionRole=(db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
         .get(row.campaign_id,principalId) as {role:string}).role;
       if(proposal.required_authorizer==="gm"&&decisionRole!=="owner"&&decisionRole!=="gm")
         throw new AdventureTurnAuthorizationError("owner or GM confirmation is required");
      if (db.prepare("SELECT 1 FROM confirmation_decisions WHERE campaign_id=? AND turn_id=? AND proposal_id=?").get(row.campaign_id, row.id, input.proposalId))
        throw new AdventureTurnConflictError("proposal already has a decision");
       const decisionId=id();attestConfirmationAuthority(row,proposal,principalId,decisionId,input.decision,at);
       db.prepare(`INSERT INTO confirmation_decisions(decision_id,campaign_id,turn_id,proposal_id,principal_id,decision,expected_turn_revision,idempotency_key,expires_at,decided_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`).run(decisionId, row.campaign_id, row.id, input.proposalId, principalId, input.decision, row.revision, input.idempotencyKey, input.expiresAt, at);
      const pending = db.prepare(`SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=? AND proposal.turn_id=? AND proposal.requires_confirmation=1
        AND NOT EXISTS(SELECT 1 FROM confirmation_decisions decision WHERE decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id)`).get(row.campaign_id, row.id);
      let state = "awaiting-confirmation", physicalState = "awaiting-confirmation";
      if (!pending) { const approved = approvedProposals(row); state = approved.length > 0 ? "confirmed" : "cancelled";
        physicalState = approved.length > 0 ? "mechanics-committed" : "cancelled"; }
      physicalAdvance(row, physicalState, "none", at);
      return finish("turn", row, principalId, "confirmation-decision", input, input.expectedTurnRevision, state, "none", at, () => privateTurn(principalId, row.id));
    }); },
    decideToolProposals(principalId, raw) {
      const parsed = decideToolProposalsInputSchema.parse(raw);
      const input = { ...parsed, proposalIds: [...parsed.proposalIds].sort() };
      return immediate(() => {
        const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "turn");
        const old = replay("turn", row, principalId, "confirmation-decisions", input, input.expectedTurnRevision, privateAdventureTurnSchema);
        if (old) return old;
        const current = stale("turn", row, input.expectedTurnRevision);
        if (current.resulting_state !== "awaiting-confirmation") throw new AdventureTurnConflictError("turn is not waiting for confirmation");
        const at = now();
        const selected = input.proposalIds.map((proposalId) => db.prepare(`SELECT proposal.*,policy.required_authorizer,policy.policy_version,
          policy.category,policy.requires_confirmation policy_requires_confirmation,policy.proposed_command_digest,policy.observed_domain_revisions_json,
          decision.decision_id FROM tool_proposals proposal LEFT JOIN confirmation_decisions decision
            ON decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id
          JOIN confirmation_policy_attestations_v40 policy ON policy.proposal_id=proposal.proposal_id
          WHERE proposal.campaign_id=? AND proposal.turn_id=? AND proposal.proposal_id=? AND proposal.requires_confirmation=1`)
          .get(row.campaign_id, row.id, proposalId) as any);
        // Validate the complete batch before the first immutable decision row is inserted.
        if (selected.some((proposal, index) => !proposal || proposal.proposal_id !== input.proposalIds[index]
            || proposal.decision_id || !proposal.confirmation_expires_at)) {
          throw new AdventureTurnConflictError("confirmation proposal set does not match durable pending state");
        }
        if (selected.some((proposal) => at >= proposal.confirmation_expires_at)) throw new AdventureTurnExpiredError("confirmation expired");
        const role=(db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(row.campaign_id,principalId) as {role:string}).role;
        if(selected.some((proposal)=>proposal.required_authorizer==="gm"&&role!=="owner"&&role!=="gm"))
          throw new AdventureTurnAuthorizationError("owner or GM confirmation is required");
        for (const proposal of selected) {
          const decisionKey = `batch:${createHash("sha256").update(`${input.idempotencyKey}\0${proposal.proposal_id}`).digest("hex").slice(0, 48)}`;
          const decisionId=id();attestConfirmationAuthority(row,proposal,principalId,decisionId,input.decision,at);
          db.prepare(`INSERT INTO confirmation_decisions(decision_id,campaign_id,turn_id,proposal_id,principal_id,decision,expected_turn_revision,idempotency_key,expires_at,decided_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run(decisionId, row.campaign_id, row.id, proposal.proposal_id, principalId, input.decision,
              input.expectedTurnRevision, decisionKey, proposal.confirmation_expires_at, at);
        }
        const pending = db.prepare(`SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=? AND proposal.turn_id=?
          AND proposal.requires_confirmation=1 AND NOT EXISTS(SELECT 1 FROM confirmation_decisions decision
            WHERE decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id)`)
          .get(row.campaign_id, row.id);
        let state = "awaiting-confirmation", physicalState = "awaiting-confirmation";
        if (!pending) {
          const approved = approvedProposals(row); state = approved.length > 0 ? "confirmed" : "cancelled";
          physicalState = approved.length > 0 ? "mechanics-committed" : "cancelled";
        }
        physicalAdvance(row, physicalState, "none", at);
        return finish("turn", row, principalId, "confirmation-decisions", input, input.expectedTurnRevision, state, "none", at,
          () => privateTurn(principalId, row.id));
      });
    },
    expireToolProposals(principalId, raw) { const input=turnMutationInputSchema.parse(raw); return immediate(()=>{
      const row=turn(input.turnId);authority(principalId,row,input.expectedCampaignRevision,"turn");
      const old=replay("turn",row,principalId,"confirmation-expiration",input,input.expectedTurnRevision,privateAdventureTurnSchema);if(old)return old;
      const current=stale("turn",row,input.expectedTurnRevision);if(current.resulting_state!=="awaiting-confirmation")throw new AdventureTurnConflictError("turn is not waiting for confirmation");
      const at=now();const due=db.prepare(`SELECT proposal.*,policy.required_authorizer,policy.policy_version,policy.category,
        policy.requires_confirmation policy_requires_confirmation,policy.proposed_command_digest,policy.observed_domain_revisions_json
        FROM tool_proposals proposal JOIN confirmation_policy_attestations_v40 policy ON policy.campaign_id=proposal.campaign_id
          AND policy.turn_id=proposal.turn_id AND policy.proposal_id=proposal.proposal_id WHERE proposal.campaign_id=? AND proposal.turn_id=?
        AND proposal.requires_confirmation=1 AND proposal.confirmation_expires_at<=? AND NOT EXISTS(SELECT 1 FROM confirmation_decisions decision
          WHERE decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id)
        ORDER BY proposal.proposal_id`).all(row.campaign_id,row.id,at) as any[];
      if(!due.length)throw new AdventureTurnConflictError("no confirmation is due for expiration");
      for(const proposal of due){const decisionId=id();attestConfirmationAuthority(row,proposal,principalId,decisionId,"expired",at);
        db.prepare(`INSERT INTO confirmation_decisions(decision_id,campaign_id,turn_id,proposal_id,principal_id,decision,
          expected_turn_revision,idempotency_key,expires_at,decided_at) VALUES(?,?,?,?,?,'expired',?,?,?,?)`).run(decisionId,row.campaign_id,row.id,proposal.proposal_id,
            principalId,input.expectedTurnRevision,`expiry:${createHash("sha256").update(`${input.idempotencyKey}\0${proposal.proposal_id}`).digest("hex").slice(0,48)}`,proposal.confirmation_expires_at,at);}
      const pending=Boolean(db.prepare(`SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=? AND proposal.turn_id=? AND proposal.requires_confirmation=1
        AND NOT EXISTS(SELECT 1 FROM confirmation_decisions decision WHERE decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id)`).get(row.campaign_id,row.id));
      const approved=approvedProposals(row);const state=pending?"awaiting-confirmation":approved.length?"confirmed":"cancelled";
      physicalAdvance(row,state==="confirmed"?"mechanics-committed":state,"none",at);
      db.prepare(`INSERT INTO confirmation_expiration_operations_v40 VALUES(?,?,?,?,?,?,?,?,?)`).run(id(),row.campaign_id,row.id,principalId,input.idempotencyKey,
        input.expectedTurnRevision,input.expectedTurnRevision+1,canonicalAgentJson(due.map((proposal)=>proposal.proposal_id)),at);
      return finish("turn",row,principalId,"confirmation-expiration",input,input.expectedTurnRevision,state,"none",at,()=>privateTurn(principalId,row.id));
    }); },
    replanAgentProposal(principalId,input){return immediate(()=>{
      const row=turn(input.turnId);authority(principalId,row,input.expectedCampaignRevision,"turn");
      const old=replay("turn",row,principalId,"agent-replan",input,input.expectedTurnRevision,privateAdventureTurnSchema);if(old)return old;
      const current=stale("turn",row,input.expectedTurnRevision);
      if(["completed","cancelled","failed"].includes(current.resulting_state))throw new AdventureTurnConflictError("terminal turn cannot replan");
      const requirement=db.prepare("SELECT reason FROM agent_replan_requirements_v40 WHERE campaign_id=? AND turn_id=? AND proposal_id=?")
        .get(row.campaign_id,row.id,input.proposalId) as {reason:string}|undefined;
      if(!requirement||requirement.reason!==input.reason)throw new AdventureTurnConflictError("durable replan requirement is unavailable");
      const at=now();physicalAdvance(row,row.state,"none",at);
      return finish("turn",row,principalId,"agent-replan",input,input.expectedTurnRevision,"declared","none",at,()=>privateTurn(principalId,row.id));
    });},
    recordProviderCallStart(principalId, raw) { const input = providerCallStartInputSchema.parse(raw); return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "provider");
      const old = replay("turn", row, principalId, "provider-start", input, input.expectedTurnRevision, privateAdventureTurnSchema); if (old) return old;
      const current = stale("turn", row, input.expectedTurnRevision); if (!["declared", "proposed", "awaiting-confirmation", "confirmed", "mechanics-committed", "narrating"].includes(current.resulting_state)) throw new AdventureTurnConflictError("provider start is illegal in this state");
      const run = db.prepare("SELECT max_provider_calls FROM adventure_agent_executions_v38 WHERE campaign_id=? AND turn_id=?")
        .get(row.campaign_id, row.id) as { max_provider_calls: number } | undefined;
      if (!run) throw new AdventureTurnUnavailableError("durable execution is unavailable");
      const starts = (db.prepare("SELECT count(*) count FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND phase='started'")
        .get(row.campaign_id, row.id) as { count: number }).count;
      if (starts >= run.max_provider_calls || db.prepare("SELECT 1 FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND call_id=?")
        .get(row.campaign_id, row.id, input.callId)) throw new AdventureTurnConflictError("provider call identity or bound is invalid");
      const at = now(); db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,prompt_tokens,completion_tokens,outcome_code,idempotency_key,recorded_at)
        VALUES(?,?,?,?,'started',?,?,?,NULL,NULL,NULL,?,?)`).run(id(), row.campaign_id, row.id, input.callId, input.provider, input.model, input.attempt, input.idempotencyKey, at);
      const narrating = current.resulting_state === "mechanics-committed" || current.resulting_state === "narrating";
      const state = narrating ? "narrating" : current.resulting_state, narration = narrating ? "in-progress" : current.narration_status;
      physicalAdvance(row, narrating ? "narrating" : row.state, narration, at);
      return finish("turn", row, principalId, "provider-start", input, input.expectedTurnRevision, state,
        narration, at, () => privateTurn(principalId, row.id));
    }); },
    recordProviderCallOutcome(principalId, raw) { const input = providerCallOutcomeInputSchema.parse(raw); return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "provider");
      const old = replay("turn", row, principalId, "provider-outcome", input, input.expectedTurnRevision, privateAdventureTurnSchema); if (old) return old;
      const current = stale("turn", row, input.expectedTurnRevision); if (!["declared", "proposed", "awaiting-confirmation", "confirmed", "narrating"].includes(current.resulting_state)) throw new AdventureTurnConflictError("provider outcome is illegal in this state");
      const start = db.prepare("SELECT * FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND call_id=? AND phase='started'").get(row.campaign_id, row.id, input.callId) as any;
      if (!start || start.provider !== input.provider || start.model !== input.model || start.attempt !== input.attempt || db.prepare("SELECT 1 FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND call_id=? AND phase<>'started'").get(row.campaign_id, row.id, input.callId))
        throw new AdventureTurnConflictError("provider outcome does not match its immutable start");
      const at = now(); db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,prompt_tokens,completion_tokens,outcome_code,idempotency_key,recorded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id(), row.campaign_id, row.id, input.callId, input.outcome, input.provider, input.model, input.attempt,
          input.promptTokens ?? null, input.completionTokens ?? null, input.outcomeCode, input.idempotencyKey, at);
      const failedNarration = current.resulting_state === "narrating" && input.outcome !== "succeeded";
      const narration = failedNarration ? "failed" : current.narration_status;
      physicalAdvance(row, row.state, narration, at);
      return finish("turn", row, principalId, "provider-outcome", input, input.expectedTurnRevision, current.resulting_state,
        narration, at, () => privateTurn(principalId, row.id));
    }); },
    linkFinalMechanicsReceipt(principalId, raw) { const input = linkTurnReceiptInputSchema.parse(raw); return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "turn");
      const old = replay("turn", row, principalId, "mechanics-link", input, input.expectedTurnRevision, privateAdventureTurnSchema); if (old) return old;
      const current = stale("turn", row, input.expectedTurnRevision); if (row.mode !== "original" || !["proposed", "confirmed", "mechanics-committed"].includes(current.resulting_state)) throw new AdventureTurnConflictError("turn cannot link mechanics");
      if (!approvedProposals(row).some((proposal) => proposal.proposal_id === input.proposalId)) throw new AdventureTurnConflictError("proposal is not approved");
      const at = now(); insertMechanicsLink(row, input.proposalId, input.commandId, at);
      const state = mechanicsState(row); physicalAdvance(row, "mechanics-committed", state === "mechanics-committed" ? "pending" : "none", at);
      return finish("turn", row, principalId, "mechanics-link", input, input.expectedTurnRevision, state, state === "mechanics-committed" ? "pending" : "none", at, () => privateTurn(principalId, row.id));
    }); },
    reconcileAdventureTurnMechanics(principalId, raw) { const input = turnMutationInputSchema.parse(raw); return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "turn");
      const old = replay("turn", row, principalId, "mechanics-reconcile", input, input.expectedTurnRevision, privateAdventureTurnSchema); if (old) return old;
      const current = stale("turn", row, input.expectedTurnRevision); if (row.mode !== "original" || !["proposed", "confirmed", "mechanics-committed"].includes(current.resulting_state)) throw new AdventureTurnConflictError("turn cannot reconcile mechanics");
      const at = now(), linked = reconcile(row, at); if (linked === 0) throw new AdventureTurnConflictError("no unlinked source-turn command receipts exist");
      const state = mechanicsState(row); physicalAdvance(row, "mechanics-committed", state === "mechanics-committed" ? "pending" : "none", at);
      return finish("turn", row, principalId, "mechanics-reconcile", input, input.expectedTurnRevision, state, state === "mechanics-committed" ? "pending" : "none", at, () => privateTurn(principalId, row.id));
    }); },
    updateAdventureTurnNarration(principalId, raw) { const input = updateTurnNarrationInputSchema.parse(raw); return immediate(() => {
      const row = turn(input.turnId); authority(principalId, row, input.expectedCampaignRevision, "turn");
      const old = replay("turn", row, principalId, "narration-update", input, input.expectedTurnRevision, privateAdventureTurnSchema); if (old) return old;
      const current = stale("turn", row, input.expectedTurnRevision), at = now();
      if (input.terminalState === "cancelled" && row.mode === "original") reconcile(row, at);
      const rootRow = root(row); const hasMechanics = Boolean(
        db.prepare("SELECT 1 FROM turn_mechanics_links_v36 WHERE campaign_id=? AND root_turn_id=?").get(rootRow.campaign_id, rootRow.id)
        || db.prepare("SELECT 1 FROM agent_generalized_receipts_v39 WHERE campaign_id=? AND turn_id=?").get(rootRow.campaign_id, rootRow.id));
      const hasProposals = Boolean(db.prepare("SELECT 1 FROM tool_proposals WHERE campaign_id=? AND turn_id=?").get(row.campaign_id, row.id));
      const deterministicFallback = row.mode === "original" && !hasProposals;
      const narrationDerivative = row.mode !== "original";
      let state = input.terminalState ?? current.resulting_state;
      if (input.terminalState === "completed" && (current.resulting_state !== "narrating" || (!hasMechanics && !deterministicFallback && !narrationDerivative))) throw new AdventureTurnConflictError("only committed, derivative, or deterministic fallback narration can complete");
      if (!input.terminalState && input.narrationStatus !== "none") {
        if (!hasMechanics && !deterministicFallback && !narrationDerivative) throw new AdventureTurnConflictError("narration requires committed mechanics, a derivative, or an empty fallback turn"); state = "narrating";
      }
      if (input.terminalState === "cancelled" && !hasMechanics) {
        const commandExists = db.prepare("SELECT 1 FROM campaign_commands WHERE campaign_id=? AND source_turn_id=?").get(row.campaign_id, rootRow.id);
        if (commandExists) throw new AdventureTurnConflictError("precommit cancellation cannot leave source-turn commands");
      }
      const physicalState = state === "confirmed" ? "mechanics-committed" : state;
      physicalAdvance(row, physicalState, input.narrationStatus, at);
      return finish("turn", row, principalId, "narration-update", input, input.expectedTurnRevision, state, input.narrationStatus, at, () => privateTurn(principalId, row.id));
    }); },
    createGenerationDraft(principalId, raw) { const input = createGenerationDraftInputSchema.parse(raw); return immediate(() => {
      const synthetic = { campaign_id: input.campaignId, timeline_id: input.timelineId, session_id: input.sessionId ?? null };
      authority(principalId, synthetic, input.expectedCampaignRevision, "draft");
      const existing = db.prepare(`SELECT aggregate_id FROM adventure_coordination_commands_v36 WHERE aggregate_kind='draft' AND campaign_id=?
        AND idempotency_key=? AND mutation_type='draft-create'`).get(input.campaignId, input.idempotencyKey) as any;
      if (existing) { const row = draft(existing.aggregate_id); const old = replay("draft", row, principalId, "draft-create", input, -1, privateGenerationDraftSchema); if (old) return old; }
      const content = stagedGenerationContentSchema.parse(input.stagedContent), validation = generationDraftValidationSchema.parse(input.validation), at = now();
      const row = { id: id(), campaign_id: input.campaignId, revision: 0 } as any;
      db.prepare(`INSERT INTO generation_drafts(id,campaign_id,timeline_id,session_id,principal_id,kind,staged_content_json,validation_json,state,revision,campaign_revision,idempotency_key,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'staged',0,?,?,?,?)`).run(row.id, input.campaignId, input.timelineId, input.sessionId ?? null, principalId,
          input.kind, canonical(content), canonical(validation), input.expectedCampaignRevision, input.idempotencyKey, at, at);
      return finish("draft", row, principalId, "draft-create", input, -1, "staged", null, at, () => privateDraft(principalId, row.id));
    }); },
    reviewGenerationDraft(principalId, raw) { const input = reviewGenerationDraftInputSchema.parse(raw); return immediate(() => {
      const row = draft(input.draftId); authority(principalId, row, input.expectedCampaignRevision, "draft");
      const old = replay("draft", row, principalId, "draft-review", input, input.expectedDraftRevision, privateGenerationDraftSchema); if (old) return old;
      const current = stale("draft", row, input.expectedDraftRevision); if (current.resulting_state !== "staged") throw new AdventureTurnConflictError("only staged drafts can be reviewed");
      const at = now();
      db.prepare(`INSERT INTO review_decisions(decision_id,campaign_id,draft_id,principal_id,decision,notes,expected_draft_revision,idempotency_key,decided_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id(), row.campaign_id, row.id, principalId, input.decision, input.notes ?? null, row.revision, input.idempotencyKey, at);
      db.prepare("UPDATE generation_drafts SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(input.decision, at, row.id, row.revision); row.revision += 1;
      return finish("draft", row, principalId, "draft-review", input, input.expectedDraftRevision, input.decision, null, at, () => privateDraft(principalId, row.id));
    }); },
    applyGenerationDraft(principalId, raw) { const input = applyGenerationDraftInputSchema.parse(raw); return immediate(() => {
      const row = draft(input.draftId); authority(principalId, row, input.expectedCampaignRevision, "draft");
      const old = replay("draft", row, principalId, "draft-apply", input, input.expectedDraftRevision, privateGenerationDraftSchema); if (old) return old;
      const current = stale("draft", row, input.expectedDraftRevision); if (current.resulting_state !== "approved") throw new AdventureTurnConflictError("only approved drafts can be applied");
      const review = db.prepare("SELECT * FROM review_decisions WHERE campaign_id=? AND draft_id=? AND decision='approved'").get(row.campaign_id, row.id) as any;
      if (!review) throw new AdventureTurnConflictError("approved review provenance is missing");
      const at = now(); db.prepare(`INSERT INTO generation_draft_apply_receipts_v36(receipt_id,campaign_id,draft_id,review_decision_id,principal_id,
        expected_draft_revision,resulting_draft_revision,result_json,applied_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(id(), row.campaign_id, row.id,
          review.decision_id, principalId, input.expectedDraftRevision, input.expectedDraftRevision + 1, canonical(input.result), at);
      db.prepare("UPDATE generation_drafts SET state='applied',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(at, row.id, row.revision); row.revision += 1;
      return finish("draft", row, principalId, "draft-apply", input, input.expectedDraftRevision, "applied", null, at, () => privateDraft(principalId, row.id));
    }); },
    // The encounter command is supplied by orchestration so this coordination
    // aggregate never fabricates domain writes or bypasses encounter authority.
    applyEncounterGenerationDraftAtomically() {
      throw new AdventureTurnUnavailableError("encounter draft application is unavailable");
    },
    applyCampaignContentGenerationDraftAtomically() {
      throw new AdventureTurnUnavailableError("campaign-content draft application is unavailable");
    },
  };
}

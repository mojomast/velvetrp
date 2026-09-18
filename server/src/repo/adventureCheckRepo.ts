import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { canonicalAgentJson, resourceIdSchema, utcIsoTimestampSchema } from "@velvet/contracts";
import { z } from "zod";
import type { M16Dependencies } from "./effectRepo.js";
import {
  propagateFactionWitnessObservations,
  propagateGossipToPresentNpcs,
  propagateTownGossipObservations,
  propagateWitnessObservations,
} from "./observations/agentObservationPropagation.js";
import { DND_5E_RULESET_DESCRIPTOR, resolveCampaignRuleset } from "../rulesets/index.js";
import { exactPairParameters, stripCandidateLabels } from "../agent/providerCandidateProjection.js";

const ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"] as const;
const ABILITY_NAMES: Record<(typeof ABILITIES)[number], string> = {
  strength: "Strength", dexterity: "Dexterity", constitution: "Constitution", intelligence: "Intelligence", wisdom: "Wisdom", charisma: "Charisma",
};
const SKILLS = [
  ["athletics", "Athletics", "strength"], ["acrobatics", "Acrobatics", "dexterity"], ["sleight-of-hand", "Sleight of Hand", "dexterity"],
  ["stealth", "Stealth", "dexterity"], ["arcana", "Arcana", "intelligence"], ["history", "History", "intelligence"],
  ["investigation", "Investigation", "intelligence"], ["nature", "Nature", "intelligence"], ["religion", "Religion", "intelligence"],
  ["animal-handling", "Animal Handling", "wisdom"], ["insight", "Insight", "wisdom"], ["medicine", "Medicine", "wisdom"],
  ["perception", "Perception", "wisdom"], ["survival", "Survival", "wisdom"], ["deception", "Deception", "charisma"],
  ["intimidation", "Intimidation", "charisma"], ["performance", "Performance", "charisma"], ["persuasion", "Persuasion", "charisma"],
] as const;
const DIFFICULTIES = DND_5E_RULESET_DESCRIPTOR.difficultyClasses;
const MODES = ["normal", "advantage", "disadvantage"] as const;
const selectionSchema = z.object({ candidateId: resourceIdSchema, digest: z.string().length(64).regex(/^[0-9a-f]{64}$/) }).strict();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const normalize = (value: string) => value.toLowerCase().split(/[.:_-]+/u).filter(Boolean).join("-");

export type ProviderSafeAdventureCheckCandidate = { candidateId: string; digest: string; label: string };
export type AdventureCheckPublicReceipt = {
  checkKind: "ability" | "skill"; ability: string; skill: string | null; mode: "normal" | "advantage" | "disadvantage";
  difficulty: string; rolls: Array<{ value: number; kept: boolean }>; abilityModifier: number; proficiencyBonus: number;
  modifier: number; total: number; dc: number; outcome: "success" | "failure"; revisionBefore: number; revisionAfter: number; occurredAt: string;
};

export interface AdventureCheckRepository {
  generateAdventureCheckCandidates(principalId: string, turnId: string): ProviderSafeAdventureCheckCandidate[];
  executeAdventureCheckCandidate(principalId: string, input: { turnId: string; providerCallId: string; providerToolCallId: string; round: number; selection: unknown; requireCommittedExecution?: boolean }): { commandId: string; receipt: AdventureCheckPublicReceipt };
  executeAdventureCheckCandidateFromLane(principalId: string, input: { turnId: string; decisionId: string; selection: unknown }): { commandId: string; receipt: AdventureCheckPublicReceipt };
  getAdventureCheckPublicReceipt(principalId: string, campaignId: string, commandId: string): AdventureCheckPublicReceipt | null;
  getAdventureCheckNarrationReceipt(principalId: string, turnId: string, commandId: string): AdventureCheckPublicReceipt | null;
}

type SheetSnapshot = { campaignId: string; turnId: string; sessionId: string; actorId: string; principalId: string; campaignRevision: number;
  timelineId: string; timelineRevision: number; turnRevision: number; actorRevision: number; checkRevision: number; sheetId: string;
  sheetUpdatedAt: string; sheetDigest: string; scores: Record<(typeof ABILITIES)[number], number>; level: number; proficiencies: Set<string> };

function sheetSnapshot(db: DatabaseDriver.Database, principalId: string, turnId: string): SheetSnapshot | null {
  const row = db.prepare(`SELECT turn.campaign_id campaignId,turn.id turnId,turn.session_id sessionId,turn.actor_id actorId,turn.principal_id principalId,
      turn.campaign_revision campaignRevision,turn.timeline_id timelineId,timeline.revision timelineRevision,
      (SELECT max(event.resulting_revision) FROM adventure_coordination_events_v36 event WHERE event.aggregate_kind='turn' AND event.campaign_id=turn.campaign_id AND event.aggregate_id=turn.id) turnRevision,
      actor.sheet_id sheetId,sheet.updated_at sheetUpdatedAt,profile.rules_profile_id rulesProfile,
      COALESCE(m16.revision,0) actorRevision,COALESCE(checks.revision,0) checkRevision
    FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id AND campaign.active_timeline_id=turn.timeline_id
    JOIN campaign_timelines timeline ON timeline.campaign_id=turn.campaign_id AND timeline.id=turn.timeline_id
    JOIN campaign_rules_profiles profile ON profile.campaign_id=turn.campaign_id
    JOIN campaign_actors actor ON actor.campaign_id=turn.campaign_id AND actor.id=turn.actor_id
    JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=actor.campaign_id AND sheet.id=actor.sheet_id
    JOIN campaign_memberships member ON member.campaign_id=turn.campaign_id AND member.principal_id=?
    JOIN campaign_sessions attached ON attached.campaign_id=turn.campaign_id AND attached.session_id=turn.session_id
    JOIN sessions session ON session.id=attached.session_id AND session.state='active' AND session.stopped_at IS NULL
    LEFT JOIN campaign_actor_private_state control ON control.campaign_id=turn.campaign_id AND control.actor_id=turn.actor_id
    LEFT JOIN rpg_m16_mutation_revisions_v26 m16 ON m16.campaign_id=turn.campaign_id AND m16.actor_id=turn.actor_id
    LEFT JOIN adventure_check_revisions_v54 checks ON checks.campaign_id=turn.campaign_id AND checks.actor_id=turn.actor_id
    WHERE turn.id=? AND turn.principal_id=? AND turn.mode='original' AND member.role<>'observer'
      AND (member.role IN('owner','gm') OR control.controller_principal_id=?)`).get(principalId, turnId, principalId, principalId) as any;
  if (!row) return null;
  let binding: ReturnType<typeof resolveCampaignRuleset>;
  try { binding = resolveCampaignRuleset(db, row.campaignId); } catch { return null; }
  if (binding.rulesetId !== DND_5E_RULESET_DESCRIPTOR.id
      || binding.rulesetVersion !== DND_5E_RULESET_DESCRIPTOR.version) return null;
  const attributes = db.prepare("SELECT attribute_id,value FROM rpg_character_attributes WHERE campaign_id=? AND sheet_id=? ORDER BY attribute_id")
    .all(row.campaignId, row.sheetId) as Array<{ attribute_id: string; value: number }>;
  if (attributes.length !== ABILITIES.length || attributes.some((entry) => !ABILITIES.includes(entry.attribute_id as any)
      || !Number.isInteger(entry.value) || entry.value < 1 || entry.value > 30)) return null;
  const classes = db.prepare("SELECT position,pack_id,pack_version,definition_id,level FROM rpg_character_classes WHERE campaign_id=? AND sheet_id=? ORDER BY position")
    .all(row.campaignId, row.sheetId) as Array<{ level: number }>;
  const level = classes.reduce((sum, entry) => sum + entry.level, 0);
  if (classes.length === 0 || level < 1 || level > 20) return null;
  const proficiencies = db.prepare("SELECT category,proficiency_id FROM rpg_character_proficiencies WHERE campaign_id=? AND sheet_id=? ORDER BY category,proficiency_id")
    .all(row.campaignId, row.sheetId) as Array<{ category: string; proficiency_id: string }>;
  const sheetDigest = sha(canonicalAgentJson({ updatedAt: row.sheetUpdatedAt, attributes, classes, proficiencies } as never));
  return { ...row, rulesProfile: binding.rulesProfileId, sheetDigest, level, scores: Object.fromEntries(attributes.map((entry) => [entry.attribute_id, entry.value])) as SheetSnapshot["scores"],
    proficiencies: new Set(proficiencies.filter((entry) => entry.category === "skill").map((entry) => normalize(entry.proficiency_id))) };
}

function frame(snapshot: SheetSnapshot, check: { checkKind: "ability" | "skill"; abilityId: string; skillId: string | null; difficultyRef: string; dc: number; mode: string; proficient: boolean }) {
  return { version: "v1", rulesProfileId: DND_5E_RULESET_DESCRIPTOR.id, rulesetVersion: DND_5E_RULESET_DESCRIPTOR.version,
    campaignId: snapshot.campaignId, turnId: snapshot.turnId, sessionId: snapshot.sessionId, actorId: snapshot.actorId, principalId: snapshot.principalId,
    campaignRevision: snapshot.campaignRevision, timelineId: snapshot.timelineId, timelineRevision: snapshot.timelineRevision,
    turnRevision: snapshot.turnRevision, actorRevision: snapshot.actorRevision, checkRevision: snapshot.checkRevision,
    sheetId: snapshot.sheetId, sheetUpdatedAt: snapshot.sheetUpdatedAt, sheetDigest: snapshot.sheetDigest,
    checkKind: check.checkKind, abilityId: check.abilityId, skillId: check.skillId, difficultyRef: check.difficultyRef,
    dc: check.dc, mode: check.mode, abilityScore: snapshot.scores[check.abilityId as keyof typeof snapshot.scores], level: snapshot.level, proficient: check.proficient };
}

function projectRows(rows: any[]): ProviderSafeAdventureCheckCandidate[] {
  return rows.map((row) => ({ candidateId: row.candidate_id, digest: row.candidate_digest, label: row.public_label }));
}

function verifyExecution(db: DatabaseDriver.Database, row: any): { commandId: string; receipt: AdventureCheckPublicReceipt } {
  const result = JSON.parse(row.public_result_json) as AdventureCheckPublicReceipt;
  if (sha(canonicalAgentJson(result as never)) !== row.result_digest || sha(row.selection_json) !== row.selection_digest) throw new Error("adventure check receipt evidence is malformed");
  if (row.origin === "provider") {
    const provider = db.prepare("SELECT request_digest FROM agent_provider_contexts_v39 context JOIN agent_provider_responses_v39 response ON response.context_id=context.context_id WHERE response.turn_id=? AND response.provider_call_id=? AND response.response_digest=?")
      .get(row.turn_id, row.provider_call_id, row.provider_response_digest) as { request_digest: string } | undefined;
    if (!provider || provider.request_digest !== row.provider_request_digest) throw new Error("adventure check provider evidence is malformed");
  } else if (row.origin !== "lane" || row.provider_call_id !== null || row.provider_tool_call_id !== null || row.round_number !== null
    || row.provider_request_digest !== null || row.provider_response_digest !== null
    || typeof row.system_one_decision_id !== "string" || row.system_one_decision_id.length === 0) {
    throw new Error("adventure check execution origin evidence is malformed");
  }
  return { commandId: row.command_id, receipt: result };
}

type AdvertisedCheckProjection = { version: string; candidates: ProviderSafeAdventureCheckCandidate[] };

type CheckExecutionProvenance =
  | { origin: "provider"; providerCallId: string; providerToolCallId: string; round: number; requestDigest: string; responseDigest: string }
  | { origin: "lane"; decisionId: string };

/**
 * Loads the candidate advertised for the turn and verifies the batch projection integrity and the
 * selection's claimed digest. Shared by both origins so candidate resolution cannot drift.
 */
function loadAdvertisedCheckCandidate(db: DatabaseDriver.Database, turnId: string, selection: { candidateId: string; digest: string }) {
  const candidate = db.prepare("SELECT candidate.*,batch.projection_json,batch.projection_digest FROM adventure_check_candidates_v54 candidate JOIN adventure_check_candidate_batches_v54 batch ON batch.batch_id=candidate.batch_id WHERE candidate.candidate_id=? AND candidate.turn_id=?")
    .get(selection.candidateId, turnId) as any;
  if (!candidate || candidate.candidate_digest !== selection.digest || sha(candidate.projection_json) !== candidate.projection_digest) throw new Error("adventure check candidate is unavailable");
  return { candidate, projection: JSON.parse(candidate.projection_json) as AdvertisedCheckProjection };
}

/**
 * Re-derives the candidate frame from the current authoritative sheet and rejects a candidate
 * whose revisions, sheet, or digest moved. Shared by both origins.
 */
function requireCurrentCheckCandidate(db: DatabaseDriver.Database, principalId: string, turnId: string, candidate: any): SheetSnapshot {
  const current = sheetSnapshot(db, principalId, turnId);
  if (!current || current.campaignId !== candidate.campaign_id || current.sessionId !== candidate.session_id || current.actorId !== candidate.actor_id
    || current.principalId !== candidate.principal_id || current.campaignRevision !== candidate.campaign_revision || current.timelineId !== candidate.timeline_id
    || current.timelineRevision !== candidate.timeline_revision || current.turnRevision !== candidate.turn_revision || current.actorRevision !== candidate.actor_revision
    || current.checkRevision !== candidate.check_revision || current.sheetId !== candidate.sheet_id || current.sheetUpdatedAt !== candidate.sheet_updated_at
    || current.sheetDigest !== candidate.sheet_digest) throw new Error("adventure check candidate is stale");
  const reconstructed = frame(current, { checkKind: candidate.check_kind, abilityId: candidate.ability_id, skillId: candidate.skill_id,
    difficultyRef: candidate.difficulty_ref, dc: candidate.dc, mode: candidate.roll_mode, proficient: Boolean(candidate.proficient) });
  if (sha(canonicalAgentJson(reconstructed as never)) !== candidate.candidate_digest) throw new Error("adventure check candidate digest is invalid");
  return current;
}

/**
 * Resolves one verified candidate with the authoritative d20 and ruleset and commits the immutable
 * execution row, advancing the actor check revision and propagating observations. Both origins
 * share every receipt rule; only the provenance written beside the row differs.
 */
function commitCheckExecution(db: DatabaseDriver.Database, deps: M16Dependencies, input: {
  provenance: CheckExecutionProvenance; candidate: any; current: SheetSnapshot; turnId: string; selectionJson: string;
}): { commandId: string; receipt: AdventureCheckPublicReceipt } {
  const { candidate, current, provenance } = input;
  const count = candidate.roll_mode === "normal" ? 1 : 2;
  const values = Array.from({ length: count }, () => deps.rng.integer(1, 21));
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 20)) throw new Error("check RNG returned an out-of-range die");
  const keptValue = candidate.roll_mode === "advantage" ? Math.max(...values) : candidate.roll_mode === "disadvantage" ? Math.min(...values) : values[0]!;
  let kept = false; const rolls = values.map((value) => ({ value, kept: !kept && value === keptValue ? (kept = true) : false }));
  const binding = resolveCampaignRuleset(db, current.campaignId);
  const proficiencyBonus = candidate.proficient ? binding.module.proficiencyBonus(candidate.level) : 0;
  const resolved = binding.module.resolveCheck({ d20: keptValue, abilityScore: candidate.ability_score, proficiencyBonus, dc: candidate.dc });
  const abilityModifier = resolved.abilityModifier;
  const modifier = abilityModifier + proficiencyBonus, total = resolved.total, occurredAt = utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
  const receipt: AdventureCheckPublicReceipt = { checkKind: candidate.check_kind, ability: ABILITY_NAMES[candidate.ability_id as keyof typeof ABILITY_NAMES],
    skill: candidate.skill_id ? SKILLS.find(([id]) => id === candidate.skill_id)?.[1] ?? null : null, mode: candidate.roll_mode,
    difficulty: DIFFICULTIES.find(({ id }) => id === candidate.difficulty_ref)!.name, rolls, abilityModifier, proficiencyBonus, modifier,
    total, dc: candidate.dc, outcome: total >= candidate.dc ? "success" : "failure", revisionBefore: current.checkRevision,
    revisionAfter: current.checkRevision + 1, occurredAt };
  const resultJson = canonicalAgentJson(receipt as never), commandId = `check-command:${sha(`${input.turnId}\0${candidate.candidate_id}`).slice(0, 48)}`;
  db.prepare("INSERT OR IGNORE INTO adventure_check_revisions_v54 VALUES(?,?,?,?)").run(current.campaignId, current.actorId, current.checkRevision, occurredAt);
  db.prepare("UPDATE adventure_check_revisions_v54 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=? AND revision=?")
    .run(current.checkRevision + 1, occurredAt, current.campaignId, current.actorId, current.checkRevision);
  db.prepare(`INSERT INTO adventure_check_executions_v54 (command_id,candidate_id,campaign_id,turn_id,origin,provider_call_id,
    provider_tool_call_id,round_number,provider_request_digest,provider_response_digest,system_one_decision_id,selection_json,selection_digest,
    revision_before,revision_after,rolls_json,public_result_json,result_digest,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(commandId,
    candidate.candidate_id, current.campaignId, input.turnId, provenance.origin,
    provenance.origin === "provider" ? provenance.providerCallId : null,
    provenance.origin === "provider" ? provenance.providerToolCallId : null,
    provenance.origin === "provider" ? provenance.round : null,
    provenance.origin === "provider" ? provenance.requestDigest : null,
    provenance.origin === "provider" ? provenance.responseDigest : null,
    provenance.origin === "lane" ? provenance.decisionId : null,
    input.selectionJson, sha(input.selectionJson), current.checkRevision, current.checkRevision + 1,
    canonicalAgentJson(rolls as never), resultJson, sha(resultJson), occurredAt);
  const witnessSummary = `A ${receipt.skill ?? receipt.ability} check ended in ${receipt.outcome}.`;
  propagateWitnessObservations(db, deps, {
    campaignId: current.campaignId,
    timelineId: current.timelineId,
    sessionId: current.sessionId,
    sourceCommandId: commandId,
    observedRevision: current.timelineRevision,
    summary: witnessSummary,
  });
  propagateFactionWitnessObservations(db, deps, {
    campaignId: current.campaignId,
    timelineId: current.timelineId,
    sessionId: current.sessionId,
    sourceCommandId: commandId,
    observedRevision: current.timelineRevision,
    summary: witnessSummary,
  });
  propagateTownGossipObservations(db, deps, {
    campaignId: current.campaignId,
    timelineId: current.timelineId,
    sessionId: current.sessionId,
    sourceCommandId: commandId,
    observedRevision: current.timelineRevision,
    summary: witnessSummary,
  });
  propagateGossipToPresentNpcs(db, deps, {
    campaignId: current.campaignId,
    timelineId: current.timelineId,
    sessionId: current.sessionId,
  });
  return { commandId, receipt };
}

export function createAdventureCheckRepository(db: DatabaseDriver.Database, deps: M16Dependencies, guard: () => void): AdventureCheckRepository {
  return {
    generateAdventureCheckCandidates(principalIdInput, turnIdInput) {
      guard(); const principalId = resourceIdSchema.parse(principalIdInput), turnId = resourceIdSchema.parse(turnIdInput);
      return db.transaction(() => {
        const old = db.prepare("SELECT * FROM adventure_check_candidate_batches_v54 WHERE turn_id=?").get(turnId) as any;
        if (old) {
          const rows = db.prepare("SELECT * FROM adventure_check_candidates_v54 WHERE batch_id=? ORDER BY candidate_id").all(old.batch_id) as any[];
          if(!rows.length||rows.some((row)=>row.principal_id!==principalId)||!sheetSnapshot(db,principalId,turnId))return[];
          const projection = { version: "v1", candidates: projectRows(rows) };
          if (canonicalAgentJson(projection as never) !== old.projection_json || sha(old.projection_json) !== old.projection_digest) throw new Error("adventure check candidate projection is malformed");
          return projection.candidates;
        }
        const snapshot = sheetSnapshot(db, principalId, turnId); if (!snapshot) return [];
        const issuedAt = utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
        const specs: Array<{ checkKind: "ability" | "skill"; abilityId: string; abilityName: string; skillId: string | null; skillName: string | null }> = [
          ...ABILITIES.map((abilityId) => ({ checkKind: "ability" as const, abilityId, abilityName: ABILITY_NAMES[abilityId], skillId: null, skillName: null })),
          ...SKILLS.map(([skillId, skillName, abilityId]) => ({ checkKind: "skill" as const, abilityId, abilityName: ABILITY_NAMES[abilityId], skillId, skillName })),
        ];
        const values: any[] = [];
        for (const spec of specs) for (const difficulty of DIFFICULTIES) for (const mode of MODES) {
          const proficient = spec.skillId !== null && [...snapshot.proficiencies].some((entry) => entry === spec.skillId || entry.endsWith(`-${spec.skillId}`));
          const evidence = frame(snapshot, { ...spec, difficultyRef: difficulty.id, dc: difficulty.value, mode, proficient });
          const candidateDigest = sha(canonicalAgentJson(evidence as never));
          values.push({ ...evidence, candidateId: `check-candidate:${candidateDigest.slice(0, 48)}`, candidateDigest,
            label: `${spec.skillName ?? spec.abilityName} (${spec.abilityName}), ${difficulty.name} difficulty, ${mode}` });
        }
        const batchId = `check-batch:${sha(turnId).slice(0, 48)}`;
        const projection = { version: "v1", candidates: values.map((value) => ({ candidateId: value.candidateId, digest: value.candidateDigest, label: value.label })).sort((a, b) => a.candidateId.localeCompare(b.candidateId)) };
        const projectionJson = canonicalAgentJson(projection as never);
        db.prepare("INSERT INTO adventure_check_candidate_batches_v54 VALUES(?,?,?,?,?,?,?)").run(batchId, snapshot.campaignId, turnId, projectionJson, sha(projectionJson), values.length, issuedAt);
        const insert = db.prepare(`INSERT INTO adventure_check_candidates_v54 VALUES(${Array.from({ length: 30 }, () => "?").join(",")})`);
        for (const value of values) insert.run(value.candidateId, value.candidateDigest, batchId, snapshot.campaignId, turnId, snapshot.sessionId, snapshot.actorId, snapshot.principalId,
          value.rulesProfileId, value.rulesetVersion, snapshot.campaignRevision, snapshot.timelineId, snapshot.timelineRevision, snapshot.turnRevision,
          snapshot.actorRevision, snapshot.checkRevision, snapshot.sheetId, snapshot.sheetUpdatedAt, snapshot.sheetDigest, value.checkKind, value.abilityId,
          value.skillId, value.difficultyRef, value.dc, value.mode, value.abilityScore, value.level, value.proficient ? 1 : 0, value.label, issuedAt);
        return projection.candidates;
      }).immediate();
    },
    executeAdventureCheckCandidate(principalIdInput, input) {
      guard(); const principalId = resourceIdSchema.parse(principalIdInput), turnId = resourceIdSchema.parse(input.turnId);
      resourceIdSchema.parse(input.providerCallId); resourceIdSchema.parse(input.providerToolCallId);
      const selection = selectionSchema.parse(input.selection), selectionJson = canonicalAgentJson(selection as never);
      return db.transaction(() => {
        const existing = db.prepare("SELECT * FROM adventure_check_executions_v54 WHERE turn_id=?").get(turnId) as any;
        if (existing) {
          if (existing.provider_call_id !== input.providerCallId || existing.provider_tool_call_id !== input.providerToolCallId || existing.round_number !== input.round || existing.selection_json !== selectionJson) throw new Error("adventure check replay changed");
          return verifyExecution(db, existing);
        }
        if (input.requireCommittedExecution) throw new Error("committed adventure check execution is unavailable");
        const { candidate, projection } = loadAdvertisedCheckCandidate(db, turnId, selection);
        const response = db.prepare(`SELECT response.response_json,response.response_digest,context.request_json,context.request_digest,context.round_number
          FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id
          WHERE response.turn_id=? AND response.provider_call_id=? AND response.status='succeeded'`).get(turnId, input.providerCallId) as any;
        const settled = response && JSON.parse(response.response_json), call = settled?.calls?.[0], request = response && JSON.parse(response.request_json);
        const tool = request?.advertisedToolSchemas?.find((entry: any) => entry?.name === "exact_srd_check.select");
        const requestedProjection=request?.checkCandidateProjection;
        const expectedParameters=exactPairParameters(requestedProjection?.candidates??[]);
        if (!response || response.round_number !== input.round || sha(response.request_json) !== response.request_digest || sha(response.response_json) !== response.response_digest
          || settled?.result !== "tool-calls" || settled.calls.length !== 1 || call?.providerToolCallId !== input.providerToolCallId
          || call?.toolName !== "exact_srd_check.select" || call?.kind !== "mutation" || canonicalAgentJson(call.arguments) !== selectionJson
          || !Array.isArray(requestedProjection?.candidates) || requestedProjection.candidates.length===0
          || stripCandidateLabels(requestedProjection).candidates.some((requested:any)=>!projection.candidates.some((stored)=>canonicalAgentJson(stored as never)===canonicalAgentJson(requested as never)))
          || !tool || canonicalAgentJson(tool.parameters as never)!==canonicalAgentJson(expectedParameters as never)
          || !request?.advertisedTools?.includes("exact_srd_check.select")) throw new Error("adventure check provider selection is invalid");
        const current = requireCurrentCheckCandidate(db, principalId, turnId, candidate);
        return commitCheckExecution(db, deps, { provenance: { origin: "provider", providerCallId: input.providerCallId,
          providerToolCallId: input.providerToolCallId, round: input.round, requestDigest: response.request_digest,
          responseDigest: response.response_digest }, candidate, current, turnId, selectionJson });
      }).immediate();
    },
    executeAdventureCheckCandidateFromLane(principalIdInput, input) {
      guard(); const principalId = resourceIdSchema.parse(principalIdInput), turnId = resourceIdSchema.parse(input.turnId);
      const decisionId = resourceIdSchema.parse(input.decisionId);
      const selection = selectionSchema.parse(input.selection), selectionJson = canonicalAgentJson(selection as never);
      return db.transaction(() => {
        const existing = db.prepare("SELECT * FROM adventure_check_executions_v54 WHERE turn_id=?").get(turnId) as any;
        if (existing) {
          if (existing.origin !== "lane" || existing.system_one_decision_id !== decisionId || existing.selection_json !== selectionJson) throw new Error("adventure check replay changed");
          return verifyExecution(db, existing);
        }
        const decision = db.prepare("SELECT campaign_id,session_id,turn_id FROM system_one_decisions_v1 WHERE decision_id=?").get(decisionId) as any;
        if (!decision || decision.turn_id !== turnId) throw new Error("adventure check lane decision is unavailable");
        const { candidate, projection } = loadAdvertisedCheckCandidate(db, turnId, selection);
        if (!Array.isArray(projection.candidates) || projection.candidates.length === 0
          || !projection.candidates.some((advertised) => advertised?.candidateId === selection.candidateId && advertised?.digest === selection.digest))
          throw new Error("adventure check candidate is not advertised for the turn");
        if ((decision.campaign_id !== null && decision.campaign_id !== candidate.campaign_id)
          || (decision.session_id !== null && decision.session_id !== candidate.session_id))
          throw new Error("adventure check lane decision is unavailable");
        const current = requireCurrentCheckCandidate(db, principalId, turnId, candidate);
        return commitCheckExecution(db, deps, { provenance: { origin: "lane", decisionId }, candidate, current, turnId, selectionJson });
      }).immediate();
    },
    getAdventureCheckPublicReceipt(principalIdInput, campaignIdInput, commandIdInput) {
      const principalId = resourceIdSchema.parse(principalIdInput), campaignId = resourceIdSchema.parse(campaignIdInput), commandId = resourceIdSchema.parse(commandIdInput);
      const row = db.prepare(`SELECT execution.* FROM adventure_check_executions_v54 execution JOIN campaign_memberships member
        ON member.campaign_id=execution.campaign_id AND member.principal_id=? WHERE execution.campaign_id=? AND execution.command_id=?`)
        .get(principalId, campaignId, commandId) as any; return row ? verifyExecution(db, row).receipt : null;
    },
    getAdventureCheckNarrationReceipt(principalIdInput, turnIdInput, commandIdInput) {
      const principalId = resourceIdSchema.parse(principalIdInput), turnId = resourceIdSchema.parse(turnIdInput), commandId = resourceIdSchema.parse(commandIdInput);
      const row = db.prepare(`WITH RECURSIVE ancestry(id,prior_turn_id,mode) AS (SELECT id,prior_turn_id,mode FROM adventure_turns WHERE id=?
        UNION ALL SELECT parent.id,parent.prior_turn_id,parent.mode FROM adventure_turns parent JOIN ancestry child ON child.prior_turn_id=parent.id)
        SELECT execution.* FROM ancestry JOIN adventure_check_executions_v54 execution ON execution.turn_id=ancestry.id
        JOIN adventure_turns requested ON requested.id=? JOIN campaign_memberships member ON member.campaign_id=requested.campaign_id AND member.principal_id=?
        LEFT JOIN campaign_actor_private_state control ON control.campaign_id=requested.campaign_id AND control.actor_id=requested.actor_id
        WHERE ancestry.mode='original' AND execution.command_id=? AND (member.role IN('owner','gm') OR control.controller_principal_id=?)`)
        .get(turnId, turnId, principalId, commandId, principalId) as any; return row ? verifyExecution(db, row).receipt : null;
    },
  };
}

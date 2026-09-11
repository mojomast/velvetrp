CREATE TABLE dm_control (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK(mode IN ('human','ai')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
  delegator TEXT,
  CHECK((mode='human' AND delegator IS NULL) OR (mode='ai' AND delegator IS NOT NULL)),
  FOREIGN KEY(delegator) REFERENCES principals(id) ON DELETE RESTRICT
);
CREATE TABLE dm_mode_commands (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL, principal_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(campaign_id,idempotency_key),
  FOREIGN KEY(principal_id) REFERENCES principals(id) ON DELETE RESTRICT
);
CREATE TRIGGER dm_control_campaign AFTER INSERT ON campaigns BEGIN
  INSERT INTO dm_control(campaign_id,mode,revision,delegator) VALUES(NEW.id,'human',0,NULL);
END;
CREATE TABLE dm_runs (
  run_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, session_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL, principal_id TEXT NOT NULL, gm_principal_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('human','ai')), mode_revision INTEGER NOT NULL CHECK(mode_revision>=0),
  intent TEXT NOT NULL CHECK(intent IN ('open','continue')), idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(context_json)<=64000),
  candidates_json TEXT NOT NULL CHECK(json_valid(candidates_json) AND length(candidates_json)<=64000),
  freshness_digest TEXT NOT NULL CHECK(length(freshness_digest)=64),
  state TEXT NOT NULL CHECK(state IN ('planning','awaiting-approval','completed','blocked','cancelled','unknown')),
  revision INTEGER NOT NULL CHECK(revision>=0),
  proposal_json TEXT CHECK(proposal_json IS NULL OR json_valid(proposal_json)),
  blockers_json TEXT NOT NULL CHECK(json_valid(blockers_json)),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at>created_at),
  UNIQUE(campaign_id,run_id), UNIQUE(campaign_id,session_id,principal_id,idempotency_key),
  FOREIGN KEY(campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
  FOREIGN KEY(gm_principal_id) REFERENCES principals(id) ON DELETE RESTRICT,
  FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX dm_one_room_run ON dm_runs(campaign_id,session_id) WHERE state IN ('planning','awaiting-approval');
CREATE TABLE dm_dispatches (
  run_id TEXT PRIMARY KEY REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  claim_id TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(request_json)<=64000),
  provider TEXT NOT NULL, model TEXT NOT NULL, deadline_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed','settled','unknown')),
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  prompt_tokens INTEGER, completion_tokens INTEGER
);
CREATE TABLE dm_provider_requests (
  run_id TEXT PRIMARY KEY REFERENCES dm_dispatches(run_id) ON DELETE RESTRICT,
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object' AND length(request_json)<=64000),
  reserved_prompt_tokens INTEGER NOT NULL CHECK(reserved_prompt_tokens BETWEEN 1 AND 23744),
  reserved_completion_tokens INTEGER NOT NULL CHECK(reserved_completion_tokens BETWEEN 1 AND 1024)
);
CREATE TABLE dm_decisions (
  run_id TEXT PRIMARY KEY REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('human-approved','human-rejected','ai-policy-v1')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)), decided_at TEXT NOT NULL
);
CREATE TABLE dm_receipts (
  run_id TEXT PRIMARY KEY REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL UNIQUE, action TEXT NOT NULL CHECK(action IN ('encounter-start','encounter-materialize','enemy-turn','encounter-complete','reveal-node','resolve-node','reveal-clue','advance-time','ambient-beat')),
  domain_receipt_json TEXT NOT NULL CHECK(json_valid(domain_receipt_json)),
  public_json TEXT NOT NULL CHECK(json_valid(public_json) AND length(public_json)<=8000)
);
CREATE TABLE dm_composition_receipts (
  run_id TEXT NOT NULL REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
  command_key TEXT NOT NULL UNIQUE, action TEXT NOT NULL CHECK(action IN ('encounter-start','encounter-materialize','enemy-turn','encounter-complete','reveal-node','resolve-node','reveal-clue','advance-time','ambient-beat')),
  domain_receipt_json TEXT NOT NULL CHECK(json_valid(domain_receipt_json)),
  public_json TEXT NOT NULL CHECK(json_valid(public_json) AND length(public_json)<=8000),
  PRIMARY KEY(run_id,ordinal)
);
CREATE TABLE dm_world_time_receipts (
  run_id TEXT PRIMARY KEY REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL UNIQUE,
  minutes INTEGER NOT NULL CHECK(typeof(minutes)='integer' AND minutes BETWEEN 1 AND 60),
  elapsed_before INTEGER NOT NULL CHECK(typeof(elapsed_before)='integer' AND elapsed_before BETWEEN 0 AND 1000000000),
  elapsed_after INTEGER NOT NULL CHECK(elapsed_after=elapsed_before+minutes AND elapsed_after<=1000000000),
  occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23')
);
CREATE TABLE dm_public_history (
  run_id TEXT PRIMARY KEY REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  narration TEXT NOT NULL CHECK(length(narration) BETWEEN 1 AND 8000), published_at TEXT NOT NULL
);
CREATE TABLE dm_encounter_bindings (
  campaign_id TEXT NOT NULL, artifact_key TEXT NOT NULL, encounter_id TEXT NOT NULL REFERENCES encounter(encounter_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  PRIMARY KEY(campaign_id,artifact_key),
  FOREIGN KEY(campaign_id,artifact_key) REFERENCES campaign_generation_accepted_artifacts_v52(campaign_id,artifact_key) ON DELETE RESTRICT
);
CREATE TABLE dm_story_evidence (
  campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  PRIMARY KEY(campaign_id,turn_id),
  FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER dm_mode_commands_update BEFORE UPDATE ON dm_mode_commands BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_mode_commands_delete BEFORE DELETE ON dm_mode_commands BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_decisions_update BEFORE UPDATE ON dm_decisions BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_decisions_delete BEFORE DELETE ON dm_decisions BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_receipts_update BEFORE UPDATE ON dm_receipts BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_receipts_delete BEFORE DELETE ON dm_receipts BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_public_history_update BEFORE UPDATE ON dm_public_history BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_public_history_delete BEFORE DELETE ON dm_public_history BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_encounter_bindings_update BEFORE UPDATE ON dm_encounter_bindings BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_encounter_bindings_delete BEFORE DELETE ON dm_encounter_bindings BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_story_evidence_update BEFORE UPDATE ON dm_story_evidence BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_story_evidence_delete BEFORE DELETE ON dm_story_evidence BEGIN SELECT RAISE(ABORT,'DM evidence is immutable'); END;
CREATE TRIGGER dm_runs_identity BEFORE UPDATE ON dm_runs WHEN
  NEW.run_id<>OLD.run_id OR NEW.campaign_id<>OLD.campaign_id OR NEW.session_id<>OLD.session_id OR NEW.timeline_id<>OLD.timeline_id
  OR NEW.principal_id<>OLD.principal_id OR NEW.gm_principal_id<>OLD.gm_principal_id OR NEW.mode<>OLD.mode OR NEW.mode_revision<>OLD.mode_revision
  OR NEW.intent<>OLD.intent OR NEW.idempotency_key<>OLD.idempotency_key OR NEW.request_json<>OLD.request_json
  OR NEW.context_json<>OLD.context_json OR NEW.candidates_json<>OLD.candidates_json OR NEW.freshness_digest<>OLD.freshness_digest
  OR NEW.created_at<>OLD.created_at OR NEW.expires_at<>OLD.expires_at OR NEW.revision<>OLD.revision+1
  OR OLD.state NOT IN ('planning','awaiting-approval')
  OR (OLD.proposal_json IS NOT NULL AND NEW.proposal_json IS NOT OLD.proposal_json)
  OR (OLD.state='awaiting-approval' AND NEW.state='planning')
BEGIN SELECT RAISE(ABORT,'DM run identity or transition is immutable'); END;
CREATE TRIGGER dm_runs_delete BEFORE DELETE ON dm_runs BEGIN SELECT RAISE(ABORT,'DM runs are durable'); END;
CREATE TRIGGER dm_runs_replace BEFORE INSERT ON dm_runs WHEN EXISTS(SELECT 1 FROM dm_runs WHERE run_id=NEW.run_id
  OR (campaign_id=NEW.campaign_id AND session_id=NEW.session_id AND principal_id=NEW.principal_id AND idempotency_key=NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT,'DM runs cannot be replaced'); END;
CREATE TRIGGER dm_dispatches_update BEFORE UPDATE ON dm_dispatches WHEN OLD.status<>'claimed' OR NEW.status='claimed'
  OR NEW.run_id<>OLD.run_id OR NEW.claim_id<>OLD.claim_id OR NEW.request_json<>OLD.request_json
  OR NEW.provider<>OLD.provider OR NEW.model<>OLD.model OR NEW.deadline_at<>OLD.deadline_at
BEGIN SELECT RAISE(ABORT,'DM dispatch identity and outcomes are immutable'); END;
CREATE TRIGGER dm_dispatches_delete BEFORE DELETE ON dm_dispatches BEGIN SELECT RAISE(ABORT,'DM dispatches are durable'); END;
CREATE TRIGGER dm_dispatches_replace BEFORE INSERT ON dm_dispatches WHEN EXISTS(SELECT 1 FROM dm_dispatches WHERE run_id=NEW.run_id OR claim_id=NEW.claim_id)
BEGIN SELECT RAISE(ABORT,'DM dispatches cannot be replaced'); END;
CREATE TRIGGER dm_decisions_replace BEFORE INSERT ON dm_decisions WHEN EXISTS(SELECT 1 FROM dm_decisions WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'DM decisions cannot be replaced'); END;
CREATE TRIGGER dm_receipts_replace BEFORE INSERT ON dm_receipts WHEN EXISTS(SELECT 1 FROM dm_receipts WHERE run_id=NEW.run_id OR command_key=NEW.command_key)
BEGIN SELECT RAISE(ABORT,'DM receipts cannot be replaced'); END;
CREATE TRIGGER dm_composition_receipts_update BEFORE UPDATE ON dm_composition_receipts BEGIN SELECT RAISE(ABORT,'DM composition receipt is immutable'); END;
CREATE TRIGGER dm_composition_receipts_delete BEFORE DELETE ON dm_composition_receipts BEGIN SELECT RAISE(ABORT,'DM composition receipt is immutable'); END;
CREATE TRIGGER dm_composition_receipts_replace BEFORE INSERT ON dm_composition_receipts WHEN EXISTS(SELECT 1 FROM dm_composition_receipts WHERE run_id=NEW.run_id AND ordinal=NEW.ordinal)
BEGIN SELECT RAISE(ABORT,'DM composition receipts cannot be replaced'); END;
CREATE TRIGGER dm_world_time_receipts_update BEFORE UPDATE ON dm_world_time_receipts BEGIN SELECT RAISE(ABORT,'DM world time receipt is immutable'); END;
CREATE TRIGGER dm_world_time_receipts_delete BEFORE DELETE ON dm_world_time_receipts BEGIN SELECT RAISE(ABORT,'DM world time receipt is immutable'); END;
CREATE TRIGGER dm_world_time_receipts_replace BEFORE INSERT ON dm_world_time_receipts WHEN EXISTS(
  SELECT 1 FROM dm_world_time_receipts WHERE run_id=NEW.run_id OR command_key=NEW.command_key)
BEGIN SELECT RAISE(ABORT,'DM world time receipt cannot be replaced'); END;
CREATE TRIGGER dm_composition_receipts_authority BEFORE INSERT ON dm_composition_receipts WHEN NOT EXISTS(
  SELECT 1 FROM dm_runs run JOIN dm_decisions decision USING(run_id)
  WHERE run.run_id=NEW.run_id AND run.state='awaiting-approval' AND decision.kind IN ('human-approved','ai-policy-v1')
    AND (EXISTS(SELECT 1 FROM combat_commands_v27 command JOIN encounter ON encounter.encounter_id=command.encounter_id
      WHERE encounter.campaign_id=run.campaign_id AND encounter.session_id=run.session_id AND command.idempotency_key=NEW.command_key
        AND NEW.action IN ('encounter-start','encounter-materialize','encounter-complete','enemy-turn'))
      OR EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=run.campaign_id
        AND command.idempotency_key=NEW.command_key AND command.command_type=NEW.action)
      OR (NEW.action='advance-time' AND EXISTS(SELECT 1 FROM dm_world_time_receipts world_time
        WHERE world_time.run_id=run.run_id AND world_time.command_key=NEW.command_key))
      OR NEW.action='ambient-beat'))
BEGIN SELECT RAISE(ABORT,'DM composition receipt requires approved domain command'); END;
CREATE TRIGGER dm_public_history_replace BEFORE INSERT ON dm_public_history WHEN EXISTS(SELECT 1 FROM dm_public_history WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'DM history cannot be replaced'); END;
CREATE TRIGGER dm_control_revision BEFORE UPDATE ON dm_control WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.revision<>OLD.revision+1
BEGIN SELECT RAISE(ABORT,'DM mode revision must advance exactly once'); END;
CREATE TRIGGER dm_control_delete BEFORE DELETE ON dm_control BEGIN SELECT RAISE(ABORT,'DM control is durable'); END;
CREATE TRIGGER dm_runs_authority BEFORE INSERT ON dm_runs WHEN NOT EXISTS(
  SELECT 1 FROM campaigns campaign JOIN campaign_sessions room ON room.campaign_id=campaign.id
  JOIN campaign_memberships gm ON gm.campaign_id=campaign.id AND gm.principal_id=NEW.gm_principal_id AND gm.role IN ('owner','gm')
  JOIN campaign_memberships initiator ON initiator.campaign_id=campaign.id AND initiator.principal_id=NEW.principal_id
  JOIN dm_control control ON control.campaign_id=campaign.id AND control.revision=NEW.mode_revision AND control.mode=NEW.mode
  WHERE campaign.id=NEW.campaign_id AND room.session_id=NEW.session_id AND campaign.active_timeline_id=NEW.timeline_id
    AND ((NEW.mode='human' AND initiator.role IN ('owner','gm')) OR
      (NEW.mode='ai' AND control.delegator=NEW.gm_principal_id AND initiator.role IN ('owner','gm','player'))))
BEGIN SELECT RAISE(ABORT,'DM run requires current room and delegated authority'); END;
CREATE TRIGGER dm_decisions_authority BEFORE INSERT ON dm_decisions WHEN NOT EXISTS(
  SELECT 1 FROM dm_runs run JOIN campaign_memberships member ON member.campaign_id=run.campaign_id
    AND member.principal_id=NEW.principal_id AND member.role IN ('owner','gm')
  JOIN dm_control control ON control.campaign_id=run.campaign_id AND control.revision=run.mode_revision AND control.mode=run.mode
  WHERE run.run_id=NEW.run_id AND run.state='awaiting-approval' AND NEW.decided_at<run.expires_at
    AND ((NEW.kind IN ('human-approved','human-rejected') AND run.mode='human') OR
      (NEW.kind='ai-policy-v1' AND run.mode='ai' AND control.delegator=NEW.principal_id)))
BEGIN SELECT RAISE(ABORT,'DM decisions require current GM authority'); END;
CREATE TRIGGER dm_receipts_authority BEFORE INSERT ON dm_receipts WHEN NOT EXISTS(
  SELECT 1 FROM dm_runs run JOIN dm_decisions decision USING(run_id)
  WHERE run.run_id=NEW.run_id AND run.state='awaiting-approval' AND decision.kind IN ('human-approved','ai-policy-v1')
    AND NEW.command_key='dm-command:'||NEW.run_id
    AND (EXISTS(SELECT 1 FROM combat_commands_v27 command JOIN encounter ON encounter.encounter_id=command.encounter_id
      WHERE encounter.campaign_id=run.campaign_id AND encounter.session_id=run.session_id AND command.idempotency_key=NEW.command_key
        AND NEW.action IN ('encounter-start','encounter-materialize','encounter-complete','enemy-turn'))
      OR EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=run.campaign_id
        AND command.idempotency_key=NEW.command_key AND command.command_type=NEW.action)
      OR (NEW.action='advance-time' AND EXISTS(SELECT 1 FROM dm_world_time_receipts world_time
        WHERE world_time.run_id=run.run_id AND world_time.command_key=NEW.command_key))
      OR NEW.action='ambient-beat'))
BEGIN SELECT RAISE(ABORT,'DM receipt requires approved domain command'); END;
CREATE TRIGGER dm_public_history_authority BEFORE INSERT ON dm_public_history WHEN NOT EXISTS(
  SELECT 1 FROM dm_runs run JOIN dm_control control ON control.campaign_id=run.campaign_id AND control.revision=run.mode_revision AND control.mode=run.mode
  JOIN campaigns campaign ON campaign.id=run.campaign_id AND campaign.active_timeline_id=run.timeline_id AND campaign.lifecycle_status IN ('draft','published')
  JOIN campaign_sessions room ON room.campaign_id=run.campaign_id AND room.session_id=run.session_id
  JOIN sessions session ON session.id=room.session_id AND session.state='active' AND session.stopped_at IS NULL
  JOIN campaign_memberships gm ON gm.campaign_id=run.campaign_id AND gm.principal_id=run.gm_principal_id AND gm.role IN ('owner','gm')
  WHERE run.run_id=NEW.run_id AND run.state IN ('planning','awaiting-approval')
    AND (run.state='planning' OR EXISTS(SELECT 1 FROM dm_receipts receipt WHERE receipt.run_id=run.run_id))
    AND NOT EXISTS(SELECT 1 FROM campaign_administration_integrations_v59 safety WHERE safety.campaign_id=run.campaign_id AND safety.paused=1))
BEGIN SELECT RAISE(ABORT,'DM publication requires current safety and authority'); END;
CREATE TRIGGER dm_runs_completion BEFORE UPDATE ON dm_runs WHEN NEW.state='completed'
  AND NOT EXISTS(SELECT 1 FROM dm_public_history WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'DM completion requires durable public narration'); END;
CREATE TRIGGER dm_mode_commands_replace BEFORE INSERT ON dm_mode_commands WHEN EXISTS(
  SELECT 1 FROM dm_mode_commands WHERE campaign_id=NEW.campaign_id AND idempotency_key=NEW.idempotency_key)
BEGIN SELECT RAISE(ABORT,'DM mode commands cannot be replaced'); END;
CREATE TRIGGER dm_provider_requests_update BEFORE UPDATE ON dm_provider_requests BEGIN SELECT RAISE(ABORT,'DM requests are immutable'); END;
CREATE TRIGGER dm_provider_requests_delete BEFORE DELETE ON dm_provider_requests BEGIN SELECT RAISE(ABORT,'DM requests are immutable'); END;
CREATE TRIGGER dm_provider_requests_replace BEFORE INSERT ON dm_provider_requests WHEN EXISTS(SELECT 1 FROM dm_provider_requests WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'DM requests cannot be replaced'); END;
CREATE TABLE dm_narration_jobs (
  run_id TEXT PRIMARY KEY REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  public_context_json TEXT NOT NULL CHECK(json_valid(public_context_json) AND json_type(public_context_json)='object' AND length(public_context_json)<=32000),
  guard_digest TEXT NOT NULL CHECK(length(guard_digest)=64),
  fallback TEXT NOT NULL CHECK(length(fallback) BETWEEN 1 AND 8000)
);
CREATE TABLE dm_narration_dispatches (
  run_id TEXT PRIMARY KEY REFERENCES dm_narration_jobs(run_id) ON DELETE RESTRICT,
  claim_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, model TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(request_json)<=64000),
  deadline_at TEXT NOT NULL,
  reserved_prompt_tokens INTEGER NOT NULL CHECK(reserved_prompt_tokens BETWEEN 0 AND 24000),
  reserved_completion_tokens INTEGER NOT NULL CHECK(reserved_completion_tokens BETWEEN 0 AND 1536),
  status TEXT NOT NULL CHECK(status IN ('claimed','settled')),
  source TEXT CHECK(source IN ('provider-assisted','deterministic-fallback')),
  narration TEXT CHECK(length(narration) BETWEEN 1 AND 8000),
  outcome_code TEXT,
  CHECK((status='claimed' AND source IS NULL AND narration IS NULL AND outcome_code IS NULL)
    OR (status='settled' AND source IS NOT NULL AND narration IS NOT NULL AND outcome_code IS NOT NULL))
);
CREATE TRIGGER dm_narration_jobs_update BEFORE UPDATE ON dm_narration_jobs BEGIN SELECT RAISE(ABORT,'DM narration jobs are immutable'); END;
CREATE TRIGGER dm_narration_jobs_delete BEFORE DELETE ON dm_narration_jobs BEGIN SELECT RAISE(ABORT,'DM narration jobs are immutable'); END;
CREATE TRIGGER dm_narration_jobs_replace BEFORE INSERT ON dm_narration_jobs WHEN EXISTS(SELECT 1 FROM dm_narration_jobs WHERE run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'DM narration jobs cannot be replaced'); END;
CREATE TRIGGER dm_narration_dispatches_update BEFORE UPDATE ON dm_narration_dispatches WHEN OLD.status<>'claimed' OR NEW.status<>'settled'
  OR NEW.run_id<>OLD.run_id OR NEW.claim_id<>OLD.claim_id OR NEW.provider<>OLD.provider OR NEW.model<>OLD.model
  OR NEW.request_json<>OLD.request_json OR NEW.deadline_at<>OLD.deadline_at
  OR NEW.reserved_prompt_tokens<>OLD.reserved_prompt_tokens OR NEW.reserved_completion_tokens<>OLD.reserved_completion_tokens
BEGIN SELECT RAISE(ABORT,'DM narration dispatch identity and results are immutable'); END;
CREATE TRIGGER dm_narration_dispatches_delete BEFORE DELETE ON dm_narration_dispatches BEGIN SELECT RAISE(ABORT,'DM narration dispatches are immutable'); END;
CREATE TRIGGER dm_narration_dispatches_replace BEFORE INSERT ON dm_narration_dispatches WHEN EXISTS(SELECT 1 FROM dm_narration_dispatches WHERE run_id=NEW.run_id OR claim_id=NEW.claim_id)
BEGIN SELECT RAISE(ABORT,'DM narration dispatches cannot be replaced'); END;
CREATE TABLE dm_review_scene_bindings (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  node_id TEXT NOT NULL, storyline_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('check-turn','quest-objective','encounter')),
  target_id TEXT NOT NULL, principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(campaign_id,node_id,evidence_kind,target_id), UNIQUE(campaign_id,idempotency_key),
  FOREIGN KEY(campaign_id,storyline_id,node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id) ON DELETE RESTRICT
);
CREATE TABLE dm_review_provider_usage (
  run_id TEXT NOT NULL REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK(phase IN ('planning','narration')),
  source TEXT NOT NULL CHECK(source IN ('provider','reserved')),
  prompt_tokens INTEGER NOT NULL CHECK(prompt_tokens>=0), completion_tokens INTEGER NOT NULL CHECK(completion_tokens>=0),
  total_tokens INTEGER NOT NULL CHECK(total_tokens>=0), cost_usd REAL CHECK(cost_usd>=0),
  PRIMARY KEY(run_id,phase)
);
CREATE TRIGGER dm_review_scene_bindings_update BEFORE UPDATE ON dm_review_scene_bindings BEGIN SELECT RAISE(ABORT,'DM scene bindings are immutable'); END;
CREATE TRIGGER dm_review_scene_bindings_delete BEFORE DELETE ON dm_review_scene_bindings BEGIN SELECT RAISE(ABORT,'DM scene bindings are immutable'); END;
CREATE TRIGGER dm_review_scene_bindings_replace BEFORE INSERT ON dm_review_scene_bindings WHEN EXISTS(SELECT 1 FROM dm_review_scene_bindings
  WHERE campaign_id=NEW.campaign_id AND (idempotency_key=NEW.idempotency_key OR (node_id=NEW.node_id AND evidence_kind=NEW.evidence_kind AND target_id=NEW.target_id)))
BEGIN SELECT RAISE(ABORT,'DM scene bindings cannot be replaced'); END;
CREATE TRIGGER dm_review_provider_usage_update BEFORE UPDATE ON dm_review_provider_usage BEGIN SELECT RAISE(ABORT,'DM usage is immutable'); END;
CREATE TRIGGER dm_review_provider_usage_delete BEFORE DELETE ON dm_review_provider_usage BEGIN SELECT RAISE(ABORT,'DM usage is immutable'); END;
CREATE TRIGGER dm_review_provider_usage_replace BEFORE INSERT ON dm_review_provider_usage WHEN EXISTS(SELECT 1 FROM dm_review_provider_usage WHERE run_id=NEW.run_id AND phase=NEW.phase)
BEGIN SELECT RAISE(ABORT,'DM usage cannot be replaced'); END;
CREATE TRIGGER dm_review_membership_removed AFTER DELETE ON campaign_memberships BEGIN
  UPDATE dm_runs SET state='cancelled',revision=revision+1,blockers_json='["dm-membership-revoked"]'
    WHERE campaign_id=OLD.campaign_id AND (principal_id=OLD.principal_id OR gm_principal_id=OLD.principal_id) AND state IN ('planning','awaiting-approval');
  UPDATE dm_control SET mode='human',revision=revision+1,delegator=NULL WHERE campaign_id=OLD.campaign_id AND delegator=OLD.principal_id;
END;
CREATE TRIGGER dm_review_membership_demoted AFTER UPDATE OF role ON campaign_memberships WHEN NEW.role NOT IN ('owner','gm') AND OLD.role IN ('owner','gm') BEGIN
  UPDATE dm_runs SET state='cancelled',revision=revision+1,blockers_json='["dm-membership-revoked"]'
    WHERE campaign_id=OLD.campaign_id AND gm_principal_id=OLD.principal_id AND state IN ('planning','awaiting-approval');
  UPDATE dm_control SET mode='human',revision=revision+1,delegator=NULL WHERE campaign_id=OLD.campaign_id AND delegator=OLD.principal_id;
END;
CREATE TABLE dm_planning_rounds (
  run_id TEXT NOT NULL REFERENCES dm_runs(run_id) ON DELETE RESTRICT,
  round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 2),
  claim_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('claimed','settled','unknown')),
  request_json TEXT CHECK(request_json IS NULL OR (json_valid(request_json) AND length(request_json)<=64000)),
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  reserved_prompt_tokens INTEGER NOT NULL CHECK(reserved_prompt_tokens BETWEEN 1 AND 23744),
  reserved_completion_tokens INTEGER NOT NULL CHECK(reserved_completion_tokens BETWEEN 1 AND 1024),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  deadline_at TEXT NOT NULL,
  PRIMARY KEY(run_id,round)
);
CREATE TRIGGER dm_planning_rounds_update BEFORE UPDATE ON dm_planning_rounds WHEN
  OLD.status<>'claimed' OR NEW.status='claimed'
  OR NEW.run_id<>OLD.run_id OR NEW.round<>OLD.round OR NEW.claim_id<>OLD.claim_id
  OR NEW.reserved_prompt_tokens<>OLD.reserved_prompt_tokens OR NEW.reserved_completion_tokens<>OLD.reserved_completion_tokens
  OR NEW.request_json IS NOT OLD.request_json OR NEW.deadline_at<>OLD.deadline_at
BEGIN SELECT RAISE(ABORT,'DM planning round identity and outcome are immutable'); END;
CREATE TRIGGER dm_planning_rounds_delete BEFORE DELETE ON dm_planning_rounds BEGIN SELECT RAISE(ABORT,'DM planning rounds are durable'); END;
CREATE TRIGGER dm_planning_rounds_replace BEFORE INSERT ON dm_planning_rounds WHEN EXISTS(
  SELECT 1 FROM dm_planning_rounds WHERE (run_id=NEW.run_id AND round=NEW.round) OR claim_id=NEW.claim_id)
BEGIN SELECT RAISE(ABORT,'DM planning rounds cannot be replaced'); END;

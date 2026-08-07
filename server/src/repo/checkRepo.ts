import type DatabaseDriver from "better-sqlite3";
import {
  actorCheckCommandRequestSchema,
  checkCommandSchema,
  checkResolutionSchema,
  resourceIdSchema,
  type ActorCheckCommandRequest,
  type CheckCommand,
  type CheckDifficultyRef,
  type CheckResolution,
} from "@velvet/contracts";
import { evaluateDiceExpression } from "../dice.js";
import { runM16Mutation, type M16Dependencies, type M16Result } from "./effectRepo.js";

export class CheckUnavailableError extends Error { readonly code = "CHECK_UNAVAILABLE"; }
export class ActorCheckNotFoundError extends Error { readonly code = "ACTOR_CHECK_NOT_FOUND"; }

const SUPPORTED_KEYS = new Set([
  "might", "agility", "resolve", "insight", "presence", "craft",
  "melee", "ranged", "spell", "defense",
]);

/** Deliberately closed: HTTP callers select a name, never a numeric DC. */
const DIFFICULTY_CLASSES: Readonly<Record<CheckDifficultyRef, number>> = Object.freeze({
  easy: 8,
  standard: 10,
  hard: 12,
  "very-hard": 15,
});
const DIFFICULTY_REFS = new Set(Object.keys(DIFFICULTY_CLASSES));

export interface CheckRepository {
  resolveCheck(principal: string, command: CheckCommand): M16Result<{ resolution: CheckResolution }>;
  resolveActorCheck(principal: string, actorId: string, input: ActorCheckCommandRequest): M16Result<{ resolution: CheckResolution }>;
}

export function createCheckRepository(
  db: DatabaseDriver.Database,
  deps: M16Dependencies,
  guard: () => void,
): CheckRepository {
  function resolve(
    principal: string,
    command: CheckCommand,
    difficultyRef?: CheckDifficultyRef,
  ): M16Result<{ resolution: CheckResolution }> {
    const request = difficultyRef === undefined ? command : { ...command, difficultyRef };
    return runM16Mutation(db, deps, guard, {
      principal,
      campaignId: command.campaignId,
      actorId: command.actorId,
      family: "check",
      type: "resolve_check",
      expectedRevision: command.expectedRevision,
      idempotencyKey: command.idempotencyKey,
      request,
      eventType: "check_resolved",
      build: (after, now, commandId) => {
        const key = command.kind === "ability" || command.kind === "save"
          ? command.abilityId
          : command.kind === "skill"
            ? command.skillId
            : command.kind === "attack"
              ? command.attackId
              : command.skillId ?? "insight";
        if (!SUPPORTED_KEYS.has(key)) throw new CheckUnavailableError("check selection is unavailable");

        const targetActorId = command.kind === "opposed"
          ? command.opponentActorId
          : command.kind === "attack" ? command.targetActorId : undefined;
        if (targetActorId !== undefined) {
          const target = db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(targetActorId) as { campaign_id: string } | undefined;
          if (!target || target.campaign_id !== command.campaignId || targetActorId === command.actorId) {
            throw new CheckUnavailableError("check target is unavailable");
          }
        }

        const sheet = db.prepare("SELECT sheet_id FROM campaign_actors WHERE campaign_id=? AND id=?")
          .get(command.campaignId, command.actorId) as { sheet_id: string } | undefined;
        if (!sheet) throw new ActorCheckNotFoundError("actor check state is unavailable");
        const attribute = db.prepare("SELECT value FROM rpg_character_attributes WHERE campaign_id=? AND sheet_id=? AND attribute_id=?")
          .get(command.campaignId, sheet.sheet_id, key) as { value: number } | undefined;
        const proficiencyCategory = command.kind === "save" ? "saving-throw"
          : command.kind === "skill" || (command.kind === "opposed" && command.skillId !== undefined) ? "skill"
            : command.kind === "attack" ? "weapon" : "none";
        const proficient = Boolean(db.prepare("SELECT 1 FROM rpg_character_proficiencies WHERE campaign_id=? AND sheet_id=? AND category=? AND proficiency_id=?")
          .get(command.campaignId, sheet.sheet_id, proficiencyCategory, key));
        const effects = (db.prepare(`SELECT command.canonical_request_json
          FROM rpg_active_effects_v26 effect
          JOIN rpg_m16_commands_v26 command ON command.campaign_id=effect.campaign_id
            AND command.actor_id=effect.actor_id AND command.command_id=effect.command_id
          WHERE effect.campaign_id=? AND effect.actor_id=? AND effect.status='active'
            AND (effect.duration_kind<>'rounds' OR effect.remaining_rounds>0)
            AND (effect.duration_kind<>'until_timestamp' OR effect.expires_at>?)`)
          .all(command.campaignId, command.actorId, now) as Array<{ canonical_request_json: string }>)
          .flatMap((row) => JSON.parse(row.canonical_request_json).effect.modifiers)
          .filter((modifier: { appliesToId: string }) => modifier.appliesToId === key || modifier.appliesToId === "all")
          .map((modifier: { kind: string; amount?: number; bonus?: number }) => ({
            modifierKind: modifier.kind,
            amount: modifier.amount ?? modifier.bonus ?? 0,
          }));
        const advantage = effects.some((effect) => effect.modifierKind === "advantage");
        const roll = evaluateDiceExpression(advantage ? "1d20adv" : "1d20", deps.rng);
        const flat = (attribute?.value ?? 0)
          + effects.filter((effect) => effect.modifierKind === "flat").reduce((sum, effect) => sum + effect.amount, 0);
        const proficiency = proficient
          ? 2 + effects.filter((effect) => effect.modifierKind === "proficiency").reduce((sum, effect) => sum + effect.amount, 0)
          : 0;
        const terms: Array<Record<string, unknown>> = [
          { kind: "roll", roll },
          { kind: "flat", sourceId: null, value: flat },
        ];
        if (proficiency) terms.push({ kind: "proficiency", sourceId: key, value: proficiency });
        const total = terms.reduce((sum, term) => sum + (term.kind === "roll" ? roll.total : term.value as number), 0);
        const target = command.kind === "opposed"
          ? { kind: "opposed_total" as const, actorId: command.opponentActorId, value: 14 }
          : { kind: "difficulty_class" as const, value: difficultyRef === undefined ? 10 : DIFFICULTY_CLASSES[difficultyRef] };
        if (target.value === undefined) throw new CheckUnavailableError("check difficulty is unavailable");
        const outcome = roll.terms.some((term) => term.kept && term.value === 20) ? "critical_success"
          : roll.terms.some((term) => term.kept && term.value === 1) ? "critical_failure"
            : total >= target.value ? "success" : "failure";
        const resolution = checkResolutionSchema.parse({ terms, total, target, outcome });
        return {
          result: { resolution },
          persist: () => db.prepare(`INSERT INTO rpg_check_results_v26(
            check_id,campaign_id,actor_id,command_id,resulting_revision,check_kind,check_key,
            target_actor_id,difficulty,dice_json,result_json,total,resolved_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            resourceIdSchema.parse(deps.ids.nextId()), command.campaignId, command.actorId, commandId, after,
            command.kind, key, targetActorId ?? null, target.value, JSON.stringify([roll]),
            JSON.stringify(resolution), total, now,
          ),
        };
      },
    });
  }

  return {
    resolveCheck(principal, input) {
      return resolve(principal, checkCommandSchema.parse(input));
    },
    resolveActorCheck(principal, actorIdInput, input) {
      const actorId = resourceIdSchema.parse(actorIdInput);
      const suppliedDifficulty = input && typeof input === "object" && "difficultyRef" in input
        ? (input as { difficultyRef?: unknown }).difficultyRef
        : undefined;
      if (typeof suppliedDifficulty === "string" && !DIFFICULTY_REFS.has(suppliedDifficulty)) {
        throw new CheckUnavailableError("check difficulty is unavailable");
      }
      const intent = actorCheckCommandRequestSchema.parse(input);
      // campaign_actors.id is globally unique; campaign identity never crosses
      // the HTTP trust boundary.
      const actor = db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(actorId) as { campaign_id: string } | undefined;
      if (!actor) throw new ActorCheckNotFoundError("actor check state is unavailable");
      const common = {
        campaignId: actor.campaign_id,
        actorId,
        expectedRevision: intent.expectedRevision,
        idempotencyKey: intent.idempotencyKey,
      };
      const command: CheckCommand = intent.kind === "ability"
        ? { ...common, kind: "ability", abilityId: intent.skillOrAttribute }
        : intent.kind === "skill"
          ? { ...common, kind: "skill", skillId: intent.skillOrAttribute }
          : intent.kind === "save"
            ? { ...common, kind: "save", abilityId: intent.skillOrAttribute }
            : intent.kind === "attack"
              ? { ...common, kind: "attack", attackId: intent.skillOrAttribute, ...(intent.targetActorId ? { targetActorId: intent.targetActorId } : {}) }
              : { ...common, kind: "opposed", opponentActorId: intent.targetActorId, skillId: intent.skillOrAttribute };
      return resolve(principal, checkCommandSchema.parse(command), intent.kind === "opposed" ? undefined : intent.difficultyRef);
    },
  };
}

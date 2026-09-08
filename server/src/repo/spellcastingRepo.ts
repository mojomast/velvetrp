import type DatabaseDriver from "better-sqlite3";
import { castSpellCommandRequestSchema, spellCatalogDefinitionSchema, type CastSpellCommandRequest } from "@velvet/contracts";
import type { M16Dependencies, M16Result } from "./effectRepo.js";
import type { ActorPowerActorState, ActorPowerResolution } from "@velvet/contracts";
import { resourceIdSchema } from "@velvet/contracts";
import { m15Authorized } from "./actorResourceRepo.js";
import { M16AuthorizationError } from "./effectRepo.js";
import type { PowerRepository } from "./powerRepo.js";
import { authoritativeMapTileSchema } from "@velvet/contracts";
import { gridDistanceFeet, lineOfEffectBetween } from "../map/geometry.js";
import { tileIndex } from "../map/types.js";
import { isSupportedRangedSpell } from "./actorPowerCommandPlanner.js";

export class SpellcastingUnavailableError extends Error { readonly code = "SPELLCASTING_UNAVAILABLE"; }
export class SpellcastingComponentError extends Error { readonly code = "SPELLCASTING_COMPONENTS"; }
export class SpellcastingRangeError extends Error { readonly code = "SPELLCASTING_RANGE"; }

export type SpellcastingRangedValidation = (input: {
  campaignId: string; actorId: string; targetIds: string[]; rangeFeet: number;
  cover: "none" | "half" | "three-quarters" | "full";
}) => void;

export interface SpellcastingRepositoryOptions { rangedValidation?: SpellcastingRangedValidation; }

export type CastSpellResult = M16Result<{
  resolution: ActorPowerResolution;
  actorStates: ActorPowerActorState[];
}>;

const sameRef = (left: any, right: any) => Boolean(left && right) && left.kind === right.kind && left.packId === right.packId
  && left.packVersion === right.packVersion && left.definitionId === right.definitionId;

/** Spell-only command boundary. Execution remains delegated to the atomic M16 actor-power transaction. */
export function createSpellcastingRepository(db: DatabaseDriver.Database, power: PowerRepository, options: SpellcastingRepositoryOptions = {}): Pick<SpellcastingRepository, "castSpell"> {
  return {
    castSpell(principal, actorIdInput, input) {
      const actorId = resourceIdSchema.parse(actorIdInput);
      const command = castSpellCommandRequestSchema.parse(input);
      if (!m15Authorized(db, principal, (db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(actorId) as any)?.campaign_id, actorId))
        throw new M16AuthorizationError("spellcasting unavailable");
      const actor = db.prepare(`SELECT actor.campaign_id, actor.campaign_character_id, actor.sheet_id, cls.level, cls.pack_id, cls.pack_version,
        cls.definition_id class_definition_id FROM campaign_actors actor JOIN rpg_character_classes cls
        ON cls.campaign_id=actor.campaign_id AND cls.sheet_id=actor.sheet_id AND cls.position=0 WHERE actor.id=?`).get(actorId) as any;
      if (!actor || actor.campaign_character_id === null) throw new SpellcastingUnavailableError("spellcasting unavailable");
      const classReference = { kind: "class", packId: actor.pack_id, packVersion: actor.pack_version, definitionId: actor.class_definition_id };
      const classRow = db.prepare(`SELECT definition.definition_json FROM campaign_catalog_current_pins pin
        JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
        WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=? AND definition.kind='class' AND definition.definition_id=?`)
        .get(actor.campaign_id, actor.pack_id, actor.pack_version, actor.class_definition_id) as { definition_json: string } | undefined;
      let spellcastingAttribute: string;
      try {
        const classDefinition = classRow ? JSON.parse(classRow.definition_json) : null;
        spellcastingAttribute = classDefinition?.mechanics?.primaryAttribute;
      } catch {
        spellcastingAttribute = "";
      }
      if (!spellcastingAttribute || !db.prepare(`SELECT 1 FROM rpg_character_attributes
        WHERE campaign_id=? AND sheet_id=? AND attribute_id=?`).get(actor.campaign_id, actor.sheet_id, spellcastingAttribute))
        throw new SpellcastingUnavailableError("spellcasting ability is unavailable");

      const levels = db.prepare(`SELECT definition.definition_json FROM campaign_catalog_current_pins pin
          JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
          WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=? AND definition.kind='class-level'`)
         .all(actor.campaign_id, actor.pack_id, actor.pack_version) as Array<{ definition_json: string }>;
      const prepared = levels.flatMap((row) => { try { const value = JSON.parse(row.definition_json); return value.mechanics?.level === actor.level && sameRef(value.mechanics.classRef, classReference) ? value.mechanics.preparedSpellRefs ?? [] : []; } catch { return []; } });
       if (!prepared.some((reference) => sameRef(reference, command.powerRef))) throw new SpellcastingUnavailableError("spell is not prepared");

       const definitionRow = db.prepare(`SELECT definition.definition_json FROM campaign_catalog_current_pins pin
         JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
         WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=? AND definition.kind='spell' AND definition.definition_id=?`)
         .get(actor.campaign_id, command.powerRef.packId, command.powerRef.packVersion, command.powerRef.definitionId) as { definition_json: string } | undefined;
       if (!definitionRow) throw new SpellcastingUnavailableError("spell execution pin is unavailable");
       let definition: ReturnType<typeof spellCatalogDefinitionSchema.parse>;
       try {
         definition = spellCatalogDefinitionSchema.parse(JSON.parse(definitionRow.definition_json));
       } catch {
         throw new SpellcastingUnavailableError("spell definition is not executable");
       }
       const mechanics = definition.mechanics;
        const runtimeSpell = command.powerRef.definitionId === "srd-5.1:spell:magic-missile";
        if (mechanics.level < 0 || mechanics.level > 9 || (!runtimeSpell && mechanics.effects.length === 0)
          || (mechanics.range === 0 && mechanics.target !== "self"))
          throw new SpellcastingUnavailableError("spell effect is not executable");
       const required = mechanics.components ?? { verbal: false, somatic: false, material: false };
       if ((["verbal", "somatic", "material"] as const).some((key) => required[key] && !command.components[key]))
         throw new SpellcastingComponentError("required spell components were not provided");
        if (isSupportedRangedSpell(definition)) {
          if (((mechanics as any).attackType ?? "none") !== "none" || ((mechanics as any).saveType ?? "none") !== "none")
            throw new SpellcastingUnavailableError("spell metadata is not executable");
           if (command.targetIds.length !== 1) throw new SpellcastingRangeError(`${definition.name} requires one target`);
          const maps = db.prepare(`SELECT map_id,tiles_json,width,height FROM tactical_maps_v58
            WHERE campaign_id=? AND active=1 ORDER BY map_id`).all(actor.campaign_id) as Array<{ map_id:string; tiles_json:string; width:number; height:number }>;
          const candidates = maps.flatMap((map) => {
            const sourceRows = db.prepare("SELECT x,y FROM tactical_map_tokens_v58 WHERE map_id=? AND actor_id=?").all(map.map_id, actorId) as Array<{x:number;y:number}>;
            const targetRows = db.prepare("SELECT x,y FROM tactical_map_tokens_v58 WHERE map_id=? AND actor_id=?").all(map.map_id, command.targetIds[0]) as Array<{x:number;y:number}>;
            return sourceRows.length === 1 && targetRows.length === 1 ? [{ map, source: sourceRows[0]!, target: targetRows[0]! }] : [];
          });
          if (candidates.length !== 1) throw new SpellcastingRangeError("ranged spell positions are ambiguous or unavailable");
          const { map, source, target } = candidates[0]!;
          let tiles;
          try { tiles = tileIndex({ tiles: authoritativeMapTileSchema.array().parse(JSON.parse(map.tiles_json)) }); }
          catch { throw new SpellcastingRangeError("ranged spell geometry is unavailable"); }
          const distance = gridDistanceFeet(source, target);
          const evidence = lineOfEffectBetween(source, target, tiles);
          if (distance > mechanics.range || !evidence.supported || evidence.cover === "full")
            throw new SpellcastingRangeError("target is out of range or blocked");
          options.rangedValidation?.({ campaignId: actor.campaign_id, actorId, targetIds: command.targetIds, rangeFeet: distance, cover: evidence.cover });
        }
       // The planner/runtime require an execution pin, but a failed cast must
       // not leave a discoverable pin behind. The mutation itself remains the
       // single atomic source of truth for resources, effects, and receipts.
       const alreadyPinned = Boolean(db.prepare(`SELECT 1 FROM rpg_campaign_catalog_definitions_v25
         WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind='spell' AND definition_id=?`)
         .get(actor.campaign_id, command.powerRef.packId, command.powerRef.packVersion, command.powerRef.definitionId));
       if (!alreadyPinned) db.prepare(`INSERT INTO rpg_campaign_catalog_definitions_v25
         (campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?, 'spell',?)`)
         .run(actor.campaign_id, command.powerRef.packId, command.powerRef.packVersion, command.powerRef.definitionId);
       const { components: _components, ...powerCommand } = command;
       try {
         return power.useActorPower(principal, actorId, powerCommand);
       } catch (error) {
         if (!alreadyPinned && !db.prepare(`SELECT 1 FROM rpg_m16_commands_v26
           WHERE campaign_id=? AND actor_id=? AND idempotency_key=?`).get(actor.campaign_id, actorId, command.idempotencyKey)) {
           db.prepare(`DELETE FROM rpg_campaign_catalog_definitions_v25
             WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind='spell' AND definition_id=?`)
             .run(actor.campaign_id, command.powerRef.packId, command.powerRef.packVersion, command.powerRef.definitionId);
         }
         throw error;
       }
    },
  };
}

export interface SpellcastingRepository { castSpell(principal: string, actorId: string, input: CastSpellCommandRequest): CastSpellResult; }

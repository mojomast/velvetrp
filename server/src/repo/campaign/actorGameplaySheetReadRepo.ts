import type DatabaseDriver from "better-sqlite3";
import {
  actorGameplaySheetResponseSchema,
  resourceIdSchema,
  type ActorGameplaySheetResponse,
} from "@velvet/contracts";
import { m15Authorized } from "../actorResourceRepo.js";
import type { ActorResourceRepository } from "../actorResourceRepo.js";
import type { EffectRepository } from "../effectRepo.js";
import type { InventoryRepository } from "../inventoryRepo.js";
import type { PowerRepository } from "../powerRepo.js";
import type { CampaignActorRepository } from "./campaignActorRepo.js";
import { rulesetIdentityForProfile } from "../../rulesets/campaignBinding.js";

export interface ActorGameplaySheetReadRepository {
  getActorGameplaySheet(actorPrincipalId: string, actorId: string): ActorGameplaySheetResponse | null;
}

interface Dependencies {
  campaignActors: CampaignActorRepository;
  resources: Pick<ActorResourceRepository, "getActorResourceSnapshot">;
  inventory: Pick<InventoryRepository, "getActorInventorySnapshot">;
  powers: Pick<PowerRepository, "getActorPowerSnapshot">;
  effects: Pick<EffectRepository, "getActorEffectSnapshot">;
}

const semanticLabel = (id: string): string => id.split(/[-_.:]+/u)
  .filter(Boolean)
  .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
  .join(" ");

/** Resolve labels only through the campaign's current, reviewed public catalog projection. */
function publicDefinitionLabel(
  db: DatabaseDriver.Database,
  campaignId: string,
  reference: { kind: string; packId: string; packVersion: string; definitionId: string },
): string {
  const row = db.prepare(`SELECT visibility.public_definition_json
    FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definition_visibility visibility
      ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
      AND visibility.kind=? AND visibility.definition_id=? AND visibility.publicly_reachable=1
    WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?`)
    .get(reference.kind, reference.definitionId, campaignId, reference.packId, reference.packVersion) as
      { public_definition_json: string } | undefined;
  if (!row) throw new Error("gameplay sheet definition is not publicly reachable");
  const parsed = JSON.parse(row.public_definition_json) as { name?: unknown };
  if (typeof parsed.name !== "string") throw new Error("gameplay sheet definition label is malformed");
  return parsed.name;
}

/**
 * Reads one actor-bound gameplay aggregate in a single SQLite snapshot. The
 * core sheet provides safe display labels while the privileged semantic read
 * restores only reviewed domain IDs; private controller state and notes never
 * enter the returned object.
 */
export function createActorGameplaySheetReadRepository(
  db: DatabaseDriver.Database,
  dependencies: Dependencies,
): ActorGameplaySheetReadRepository {
  return {
    getActorGameplaySheet(actorPrincipalId, actorId) {
      const principal = resourceIdSchema.parse(actorPrincipalId);
      const targetActorId = resourceIdSchema.parse(actorId);
      return db.transaction(() => {
        const binding = db.prepare("SELECT campaign_id,campaign_character_id FROM campaign_actors WHERE id=?")
          .get(targetActorId) as { campaign_id: string; campaign_character_id: string | null } | undefined;
        if (!binding?.campaign_character_id || !m15Authorized(db, principal, binding.campaign_id, targetActorId)) return null;

        const character = dependencies.campaignActors.getCampaignCharacterByActorId(
          principal, binding.campaign_id, targetActorId,
        );
        if (!character || character.access !== "privileged") return null;
        const snapshot = dependencies.campaignActors.getCampaignCharacterSheetSnapshot(
          principal, binding.campaign_id, binding.campaign_character_id,
        );
        const resources = dependencies.resources.getActorResourceSnapshot(principal, binding.campaign_id, targetActorId);
        const inventory = dependencies.inventory.getActorInventorySnapshot(principal, binding.campaign_id, targetActorId);
        const powers = dependencies.powers.getActorPowerSnapshot(principal, targetActorId);
        const effects = dependencies.effects.getActorEffectSnapshot(principal, targetActorId);
        if (!snapshot || !resources || !inventory || !powers || !effects) return null;
        if (snapshot.campaignId !== binding.campaign_id || snapshot.campaignCharacterId !== binding.campaign_character_id
          || snapshot.progression.actorId !== targetActorId
          || resources.campaignId !== binding.campaign_id || resources.actorId !== targetActorId
          || inventory.campaignId !== binding.campaign_id || inventory.actorId !== targetActorId
          || powers.campaignId !== binding.campaign_id || powers.actorId !== targetActorId
          || effects.campaignId !== binding.campaign_id || effects.actorId !== targetActorId) {
          throw new Error("actor gameplay sheet aggregate binding is inconsistent");
        }

        const semantic = character.projection.sheet;
        const display = snapshot.sheet;
        if (semantic.classes.length !== display.classes.length
          || semantic.attributes.length !== display.attributes.length
          || semantic.proficiencies.length !== display.proficiencies.length
          || semantic.choices.length !== display.choices.length) {
          throw new Error("actor gameplay sheet semantic and display projections differ");
        }
        const equipment = new Map(inventory.equipment.map((entry) => [entry.entryId, entry.slot]));
        const availability = new Map(powers.legalNow.map((entry) => [
          `${entry.powerRef.kind}\0${entry.powerRef.packId}\0${entry.powerRef.packVersion}\0${entry.powerRef.definitionId}`,
          entry,
        ]));

        const [rulesetId, rulesetVersion] = rulesetIdentityForProfile(snapshot.progression.profile.rulesProfileId);
        return actorGameplaySheetResponseSchema.parse({
          rulesetId, rulesetVersion,
          identity: { actorId: targetActorId, name: display.name },
          race: { reference: semantic.race, label: display.race.name },
          background: { reference: semantic.background, label: display.background.name },
          classes: semantic.classes.map((entry, index) => ({
            reference: entry.class, label: display.classes[index]!.name, level: entry.level,
          })),
          attributes: semantic.attributes.map((entry) => ({
            ...entry, label: semanticLabel(entry.attributeId),
          })),
          proficiencies: semantic.proficiencies.map((entry) => ({
            ...entry, label: semanticLabel(entry.proficiencyId),
          })),
          choices: semantic.choices.map((entry, index) => ({
            choiceId: entry.choiceId,
            label: semanticLabel(entry.choiceId),
            selection: { reference: entry.selection, label: display.choices[index]!.selection.name },
          })),
          derived: snapshot.progression.derived,
          progression: {
            mode: snapshot.progression.profile.mode,
            level: snapshot.progression.level,
            totalXp: snapshot.progression.totalXp,
            milestoneCount: snapshot.progression.milestoneCount,
            pendingChoiceCount: snapshot.progression.pendingChoices.length,
            updatedAt: snapshot.progression.updatedAt,
          },
          resources: resources.resources.map((entry) => ({ ...entry, label: semanticLabel(entry.resourceId) })),
          inventory: {
            capacity: inventory.inventory.capacity,
            items: inventory.inventory.items.map((entry) => ({
              entryId: entry.entryId,
              item: entry.item,
              label: publicDefinitionLabel(db, binding.campaign_id, entry.item),
              quantity: entry.kind === "stackable" ? entry.quantity : 1,
              equippedSlot: equipment.get(entry.entryId) ?? null,
            })),
          },
          knownPowers: powers.known.map((power) => {
            const state = availability.get(`${power.kind}\0${power.packId}\0${power.packVersion}\0${power.definitionId}`);
            if (!state) throw new Error("known power availability is incomplete");
            return {
              power,
              label: publicDefinitionLabel(db, binding.campaign_id, power),
              available: state.legal,
              unavailableReasons: state.reasons,
            };
          }),
          activeEffects: effects.effects.map((effect) => ({
            effectId: effect.effectId,
            source: effect.source === null ? null : {
              reference: effect.source,
              label: publicDefinitionLabel(db, binding.campaign_id, effect.source),
            },
            modifiers: effect.modifiers,
            duration: effect.duration,
            recovery: effect.recovery,
            stacking: effect.concentration.kind === "required" ? "concentration" : "coexists",
            appliedAt: effect.appliedAt,
          })),
        });
      }).deferred();
    },
  };
}

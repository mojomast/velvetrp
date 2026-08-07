import type DatabaseDriver from "better-sqlite3";
import { actorResourceCommandSchema, type ActorResourceCommand } from "@velvet/contracts";
import {
  ActorResourceConflictError,
  ActorResourceNegativeError,
  runM15Mutation,
  type ActorScopedResourceChange,
  type M15ActorResource,
  type M15Dependencies,
  type M15Result,
} from "../actorResourceRepo.js";
import type { ActorResourceReadRepository } from "./actorResourceReadRepo.js";

/** Matches the canonical JSON representation used by M1.5 receipts. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);

/** State-changing actor-resource commands backed by the shared M1.5 stream. */
export interface ActorResourceWriteRepository {
  /** Applies a path-bound resource delta after binding its campaign and actor identity. */
  changeActorResourceForActor(
    principal: string,
    campaignId: string,
    actorId: string,
    input: ActorScopedResourceChange,
  ): M15Result<{ resources: M15ActorResource[] }>;
  /** Validates and applies an authoritative M1.5 actor-resource command. */
  mutateActorResource(
    principal: string,
    command: ActorResourceCommand,
  ): M15Result<{ resources: M15ActorResource[] }>;
}

/**
 * Creates actor-resource commands using the root M1.5 transaction protocol.
 *
 * The reader is injected so mutation responses use the same authorized
 * projection implementation as the public read facade. `runM15Mutation` owns
 * authorization, idempotency, revision advancement, and its IMMEDIATE SQLite
 * transaction; command handlers only change their domain rows in `apply`.
 */
export function createActorResourceWriteRepository(
  db: DatabaseDriver.Database,
  deps: M15Dependencies,
  assertMutation: () => void,
  reader: Pick<ActorResourceReadRepository, "getM15ActorResources">,
): ActorResourceWriteRepository {
  const mutate = (principal: string, input: ActorResourceCommand) => {
    const command = actorResourceCommandSchema.parse(input);
    return runM15Mutation(db, deps, assertMutation, {
      principal,
      campaignId: command.campaignId,
      actorId: command.actorId,
      family: "resource",
      type: command.type,
      expectedRevision: command.expectedRevision,
      idempotencyKey: command.idempotencyKey,
      request: command,
      changedKeys: [`resource:${command.resourceId}`],
      apply() {
        const row = db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?")
          .get(command.campaignId, command.actorId, command.resourceId) as any;
        if (!row) throw new ActorResourceConflictError("actor resource is unavailable");
        let amount = row.current;
        let max = row.max;
        if (command.type === "change_actor_resource") amount += command.amount;
        else if (command.type === "set_actor_resource") amount = command.current;
        else if (command.type === "set_actor_resource_capacity") max = command.capacity;
        if (amount < 0) throw new ActorResourceNegativeError("actor resource cannot become negative");
        if (amount > max) throw new ActorResourceConflictError("actor resource cannot exceed capacity");
        if (command.type === "change_actor_resource" || command.type === "set_actor_resource" || command.type === "set_actor_resource_capacity") {
          db.prepare("UPDATE rpg_actor_resources SET current=?,max=? WHERE campaign_id=? AND actor_id=? AND name=?")
            .run(amount, max, command.campaignId, command.actorId, command.resourceId);
        }
        // Capacity sidecars model an additional bounded pool and must never exceed its new limit.
        if (command.type === "set_actor_resource_capacity") {
          db.prepare("UPDATE rpg_actor_resource_capacities_v25 SET maximum_capacity=?,used_capacity=MIN(used_capacity,?) WHERE campaign_id=? AND actor_id=? AND resource_name=?")
            .run(max, max, command.campaignId, command.actorId, command.resourceId);
        }
        if (command.type === "set_actor_resource_charges") {
          db.prepare(`INSERT INTO rpg_actor_resource_charges_v25(campaign_id,actor_id,resource_name,current_charges,maximum_charges)
            VALUES(?,?,?,?,?) ON CONFLICT(campaign_id,actor_id,resource_name) DO UPDATE SET current_charges=excluded.current_charges,maximum_charges=excluded.maximum_charges`)
            .run(command.campaignId, command.actorId, command.resourceId, command.current, command.capacity);
        }
        if (command.type === "set_actor_resource_ammunition") {
          db.prepare(`INSERT INTO rpg_actor_resource_ammunition_v25(campaign_id,actor_id,resource_name,current_ammunition,maximum_ammunition)
            VALUES(?,?,?,?,?) ON CONFLICT(campaign_id,actor_id,resource_name) DO UPDATE SET current_ammunition=excluded.current_ammunition,maximum_ammunition=excluded.maximum_ammunition`)
            .run(command.campaignId, command.actorId, command.resourceId, command.current, command.capacity);
        }
        if (command.type === "set_actor_resource_binding") {
          db.prepare(`INSERT INTO rpg_actor_resource_bindings_v25(campaign_id,actor_id,resource_name,binding_key,binding_json)
            VALUES(?,?,?,?,?) ON CONFLICT(campaign_id,actor_id,resource_name) DO UPDATE SET binding_key=excluded.binding_key,binding_json=excluded.binding_json`)
            .run(command.campaignId, command.actorId, command.resourceId, command.binding.kind, canonical(command.binding));
        }
        return { resources: reader.getM15ActorResources(principal, command.campaignId, command.actorId) };
      },
    });
  };

  return {
    changeActorResourceForActor(principal, campaignId, actorId, input) {
      return mutate(principal, {
        type: "change_actor_resource",
        campaignId,
        actorId,
        resourceId: input.resourceName,
        amount: input.amount,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
      });
    },
    mutateActorResource: mutate,
  };
}

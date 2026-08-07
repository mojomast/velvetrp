import type DatabaseDriver from "better-sqlite3";
import {
  actorResourceAmmunitionProjectionSchema,
  actorResourceBindingProjectionSchema,
  actorResourceChargesProjectionSchema,
  actorResourcesSchema,
  resourceIdSchema,
  type ActorResourceAmmunitionProjection,
  type ActorResourceBindingProjection,
  type ActorResourceChargesProjection,
} from "@velvet/contracts";
import {
  getM15ActorRevision,
  m15Authorized,
  type ActorResourceSnapshot,
  type M15ActorResource,
} from "../actorResourceRepo.js";

/** Principal-authorized, non-mutating actor-resource projections. */
export interface ActorResourceReadRepository {
  getActorResourceSnapshot(principal: string, campaignId: string, actorId: string): ActorResourceSnapshot | null;
  getM15ActorResources(principal: string, campaignId: string, actorId: string): M15ActorResource[];
  getActorResourceCharges(principal: string, campaignId: string, actorId: string, resourceId: string): ActorResourceChargesProjection | null;
  getActorResourceAmmunition(principal: string, campaignId: string, actorId: string, resourceId: string): ActorResourceAmmunitionProjection | null;
  getActorResourceBinding(principal: string, campaignId: string, actorId: string, resourceId: string): ActorResourceBindingProjection | null;
}

/** Creates authorized actor-resource projections backed by the M1.5 tables. */
export function createActorResourceReadRepository(db: DatabaseDriver.Database): ActorResourceReadRepository {
  const list = (principal: string, campaign: string, actor: string): M15ActorResource[] => {
    resourceIdSchema.parse(principal); resourceIdSchema.parse(campaign); resourceIdSchema.parse(actor);
    if (!m15Authorized(db, principal, campaign, actor)) return [];
    return actorResourcesSchema.parse(db.prepare("SELECT name resourceId,current, max capacity FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? ORDER BY name").all(campaign, actor) as any[]);
  };
  const sidecarRead = (
    principal: string,
    campaign: string,
    actor: string,
    resource: string,
    table: string,
    column: string,
    schema: { parse(value: unknown): ActorResourceChargesProjection | ActorResourceAmmunitionProjection },
    property: "charges" | "ammunition",
  ): ActorResourceChargesProjection | ActorResourceAmmunitionProjection | null => {
    resourceIdSchema.parse(principal); resourceIdSchema.parse(campaign); resourceIdSchema.parse(actor); resourceIdSchema.parse(resource);
    if (!m15Authorized(db, principal, campaign, actor)) return null;
    const row = db.prepare(`SELECT current_${column} current,maximum_${column} capacity FROM ${table} WHERE campaign_id=? AND actor_id=? AND resource_name=?`).get(campaign, actor, resource) as any;
    return row ? schema.parse({ campaignId: campaign, actorId: actor, resourceId: resource, [property]: row }) : null;
  };
  const bindingRead = (principal: string, campaign: string, actor: string, resource: string): ActorResourceBindingProjection | null => {
    resourceIdSchema.parse(principal); resourceIdSchema.parse(campaign); resourceIdSchema.parse(actor); resourceIdSchema.parse(resource);
    if (!m15Authorized(db, principal, campaign, actor)) return null;
    const row = db.prepare("SELECT binding_json FROM rpg_actor_resource_bindings_v25 WHERE campaign_id=? AND actor_id=? AND resource_name=?").get(campaign, actor, resource) as any;
    return row ? actorResourceBindingProjectionSchema.parse({ campaignId: campaign, actorId: actor, resourceId: resource, binding: JSON.parse(row.binding_json) }) : null;
  };
  /** Keeps resources and revision in one reader-owned SQLite snapshot. */
  const snapshot = (principal: string, campaign: string, actor: string): ActorResourceSnapshot | null => db.transaction(() => {
    resourceIdSchema.parse(principal); resourceIdSchema.parse(campaign); resourceIdSchema.parse(actor);
    // Authorization is checked before either projection so denied and absent roots stay indistinguishable.
    if (!m15Authorized(db, principal, campaign, actor)) return null;
    return { campaignId: campaign, actorId: actor, resources: list(principal, campaign, actor), revision: getM15ActorRevision(db, campaign, actor) };
  })();

  return {
    getActorResourceSnapshot: snapshot,
    getM15ActorResources: list,
    getActorResourceCharges: (principal, campaign, actor, resource) => sidecarRead(principal, campaign, actor, resource, "rpg_actor_resource_charges_v25", "charges", actorResourceChargesProjectionSchema, "charges") as ActorResourceChargesProjection | null,
    getActorResourceAmmunition: (principal, campaign, actor, resource) => sidecarRead(principal, campaign, actor, resource, "rpg_actor_resource_ammunition_v25", "ammunition", actorResourceAmmunitionProjectionSchema, "ammunition") as ActorResourceAmmunitionProjection | null,
    getActorResourceBinding: bindingRead,
  };
}

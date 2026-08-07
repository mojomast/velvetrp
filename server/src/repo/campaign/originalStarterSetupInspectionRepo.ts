// Private original-starter setup inspection repository.
import type DatabaseDriver from "better-sqlite3";
import { campaignMembershipReadSchema, resourceIdSchema } from "@velvet/contracts";
import {
  ORIGINAL_STARTER_MANIFEST,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RULES_PROFILE_ID,
} from "../../content/originalStarterManifest.js";
import type { CampaignAccess, CampaignDetail, ContentPack, RpgDefinition, RulesProfile } from "../../types.js";

interface RulesProfileRow {
  rules_profile_id: string;
  name: string;
  description: string;
  tags: string;
}

interface ContentPackRow extends RulesProfileRow {
  pack_id: string;
  pack_version: string;
}

interface RpgDefinitionRow {
  kind: string;
  definition_id: string;
  name: string;
  description: string;
  tags: string;
}

export type OriginalStarterSetupInspection =
  | { status: "unavailable" }
  | { status: "conflict" }
  | { status: "unconfigured"; campaign: CampaignDetail }
  | { status: "exact"; campaign: CampaignDetail };

export interface OriginalStarterSetupInspectionRepository {
  inspectOriginalStarterSetup(actorPrincipalId: string, campaignId: string): OriginalStarterSetupInspection;
}

interface OriginalStarterSetupInspectionDependencies {
  getCampaign(actorPrincipalId: string, campaignId: string): CampaignAccess | null;
  getCampaignDetail(actorPrincipalId: string, campaignId: string): CampaignDetail | null;
  toRulesProfile(row: RulesProfileRow): RulesProfile;
  toContentPack(row: ContentPackRow): ContentPack;
  toRpgDefinition(row: RpgDefinitionRow): RpgDefinition;
  sameMetadata(
    left: { name: string; description: string; tags: readonly string[] },
    right: { name: string; description: string; tags: readonly string[] },
  ): boolean;
}

export function createOriginalStarterSetupInspectionRepository(
  db: DatabaseDriver.Database,
  dependencies: OriginalStarterSetupInspectionDependencies,
): OriginalStarterSetupInspectionRepository {
  return {
    inspectOriginalStarterSetup(actorPrincipalId, campaignId) {
      const actor = resourceIdSchema.safeParse(actorPrincipalId);
      const id = resourceIdSchema.safeParse(campaignId);
      if (!actor.success || !id.success) return { status: "unavailable" };

      // Check both authorities before reserved identities to avoid disclosing state.
      const authority = db.prepare(`SELECT ao.principal_id, p.id AS principal_parent_id, p.is_local,
      (SELECT COUNT(*) FROM application_owner) AS owner_count
    FROM application_owner ao JOIN principals p ON p.id = ao.principal_id
    WHERE ao.singleton = 1`).get() as
        | { principal_id: string; principal_parent_id: string; is_local: number; owner_count: number }
        | undefined;
      if (!authority || authority.owner_count !== 1 || authority.principal_id !== actor.data
        || authority.principal_parent_id !== actor.data || authority.is_local !== 1) {
        return { status: "unavailable" };
      }
      const ownership = db.prepare(`SELECT c.owner_principal_id, owner_principal.id AS owner_parent_id,
      cm.campaign_id AS membership_campaign_id, cm.principal_id AS membership_principal_id,
      cm.role, cm.created_at AS membership_created_at,
      (SELECT COUNT(*) FROM campaign_memberships owner_lock
        WHERE owner_lock.campaign_id = c.id AND owner_lock.role = 'owner') AS owner_count
    FROM campaigns c
    LEFT JOIN principals owner_principal ON owner_principal.id = c.owner_principal_id
    LEFT JOIN campaign_memberships cm
      ON cm.campaign_id = c.id AND cm.principal_id = ?
    WHERE c.id = ?`).get(actor.data, id.data) as
        | { owner_principal_id: string; owner_parent_id: string | null; membership_campaign_id: unknown;
            membership_principal_id: unknown; role: unknown; membership_created_at: unknown; owner_count: number }
        | undefined;
      const ownerMembership = ownership && campaignMembershipReadSchema.safeParse({
        campaignId: ownership.membership_campaign_id,
        principalId: ownership.membership_principal_id,
        role: ownership.role,
        createdAt: ownership.membership_created_at,
      });
      if (!ownership || !ownerMembership || !ownerMembership.success
        || ownership.owner_principal_id !== actor.data || ownership.owner_parent_id !== actor.data
        || ownerMembership.data.campaignId !== id.data || ownerMembership.data.principalId !== actor.data
        || ownerMembership.data.role !== "owner" || ownership.owner_count !== 1) {
        return { status: "unavailable" };
      }

      // Validate the attributable campaign row before classifying reserved state,
      // so an exact content pointer cannot hide unrelated campaign corruption.
      if (!dependencies.getCampaign(actor.data, id.data)) return { status: "unavailable" };

      // Inspect only raw configuration identities before detail reconstruction.
      // An exact starter pointer whose required profile/pack has disappeared (or
      // is malformed) is a stable reserved-namespace conflict, not an incidental
      // failure of the general detail projection. Other malformed configurations
      // still flow through the ordinary detail validator below and remain loud.
      const selectedIdentity = db.prepare(`SELECT campaign_id, rules_profile_id
    FROM campaign_rules_profiles WHERE campaign_id = ?`).get(id.data) as
        | { campaign_id: string; rules_profile_id: string }
        | undefined;
      const pinIdentities = db.prepare(`SELECT campaign_id, pack_id, pack_version, rules_profile_id
    FROM campaign_content_packs WHERE campaign_id = ? ORDER BY rowid ASC`).all(id.data) as Array<{
        campaign_id: string;
        pack_id: string;
        pack_version: string;
        rules_profile_id: string;
      }>;
      const pointsExactlyToStarter = selectedIdentity?.campaign_id === id.data
        && selectedIdentity.rules_profile_id === ORIGINAL_STARTER_RULES_PROFILE_ID
        && pinIdentities.length === 1
        && pinIdentities[0]?.campaign_id === id.data
        && pinIdentities[0]?.rules_profile_id === ORIGINAL_STARTER_RULES_PROFILE_ID
        && pinIdentities[0]?.pack_id === ORIGINAL_STARTER_PACK_ID
        && pinIdentities[0]?.pack_version === ORIGINAL_STARTER_PACK_VERSION;
      if (pointsExactlyToStarter) {
        const requiredProfile = db.prepare(`SELECT rules_profile_id, name, description, tags
      FROM rpg_rules_profiles WHERE rules_profile_id = ?`)
          .get(ORIGINAL_STARTER_RULES_PROFILE_ID) as RulesProfileRow | undefined;
        const requiredPack = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags, sealed
      FROM rpg_content_packs WHERE pack_id = ? AND pack_version = ?`)
          .get(ORIGINAL_STARTER_PACK_ID, ORIGINAL_STARTER_PACK_VERSION) as
          | (ContentPackRow & { sealed: number })
          | undefined;
        try {
          if (!requiredProfile || !requiredPack || requiredPack.sealed !== 1
            || requiredPack.rules_profile_id !== ORIGINAL_STARTER_RULES_PROFILE_ID
            || !dependencies.sameMetadata(dependencies.toRulesProfile(requiredProfile), ORIGINAL_STARTER_MANIFEST.rulesProfile)
            || !dependencies.sameMetadata(dependencies.toContentPack(requiredPack), ORIGINAL_STARTER_MANIFEST)) {
            return { status: "conflict" };
          }
        } catch {
          return { status: "conflict" };
        }
      }

      const campaign = dependencies.getCampaignDetail(actor.data, id.data);
      if (!campaign) return { status: "unavailable" };
      const exactConfiguration = campaign.content.status === "configured"
        && campaign.content.rulesProfileId === ORIGINAL_STARTER_RULES_PROFILE_ID
        && campaign.content.contentPacks.length === 1
        && campaign.content.contentPacks[0]?.packId === ORIGINAL_STARTER_PACK_ID
        && campaign.content.contentPacks[0]?.packVersion === ORIGINAL_STARTER_PACK_VERSION;
      if (campaign.content.status === "configured" && !exactConfiguration) return { status: "conflict" };

      const profile = db.prepare(`SELECT rules_profile_id, name, description, tags
    FROM rpg_rules_profiles WHERE rules_profile_id = ?`)
        .get(ORIGINAL_STARTER_RULES_PROFILE_ID) as RulesProfileRow | undefined;
      const packs = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags, sealed
    FROM rpg_content_packs WHERE pack_id = ? ORDER BY pack_version`)
        .all(ORIGINAL_STARTER_PACK_ID) as Array<ContentPackRow & { sealed: number }>;
      if (packs.some((pack) => pack.pack_version !== ORIGINAL_STARTER_PACK_VERSION) || packs.length > 1) {
        return { status: "conflict" };
      }

      const expectedDefinitions = [
        ...ORIGINAL_STARTER_MANIFEST.classes, ...ORIGINAL_STARTER_MANIFEST.races,
        ...ORIGINAL_STARTER_MANIFEST.backgrounds, ...ORIGINAL_STARTER_MANIFEST.items,
        ...ORIGINAL_STARTER_MANIFEST.spells, ...ORIGINAL_STARTER_MANIFEST.abilities,
        ...ORIGINAL_STARTER_MANIFEST.enemies,
      ];
      const placeholders = expectedDefinitions.map(() => "?").join(", ");
      // Compare every row owned by the reserved pack (including unexpected kinds
      // and IDs), while also finding expected reserved IDs captured elsewhere.
      const reservedDefinitions = db.prepare(`SELECT pack_id, pack_version, kind, definition_id, name, description, tags
    FROM rpg_definitions
    WHERE pack_id = ? OR definition_id IN (${placeholders})`)
        .all(
          ORIGINAL_STARTER_PACK_ID,
          ...expectedDefinitions.map((definition) => definition.definitionId),
        ) as Array<RpgDefinitionRow & { pack_id: string; pack_version: string }>;
      if (reservedDefinitions.some((definition) => definition.pack_id !== ORIGINAL_STARTER_PACK_ID
        || definition.pack_version !== ORIGINAL_STARTER_PACK_VERSION)) return { status: "conflict" };

      const pack = packs[0];
      try {
        if (profile && !dependencies.sameMetadata(dependencies.toRulesProfile(profile), ORIGINAL_STARTER_MANIFEST.rulesProfile)) {
          return { status: "conflict" };
        }
        if (pack) {
          if (!profile || pack.sealed !== 1 || pack.rules_profile_id !== ORIGINAL_STARTER_RULES_PROFILE_ID
            || !dependencies.sameMetadata(dependencies.toContentPack(pack), ORIGINAL_STARTER_MANIFEST)) return { status: "conflict" };
          let installed: Map<string, RpgDefinition>;
          installed = new Map(reservedDefinitions.map((row) => {
            const definition = dependencies.toRpgDefinition(row);
            return [`${definition.kind}:${definition.definitionId}`, definition];
          }));
          if (installed.size !== expectedDefinitions.length || expectedDefinitions.some((definition) => {
            const persisted = installed.get(`${definition.kind}:${definition.definitionId}`);
            return !persisted || !dependencies.sameMetadata(persisted, definition);
          })) return { status: "conflict" };
        } else if (reservedDefinitions.length > 0) {
          return { status: "conflict" };
        }
      } catch {
        return { status: "conflict" };
      }

      if (exactConfiguration && pack) return { status: "exact", campaign };
      return { status: "unconfigured", campaign };
    },
  };
}

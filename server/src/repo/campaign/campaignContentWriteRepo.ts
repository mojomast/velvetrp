// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  campaignContentConfigurationSchema,
  configureCampaignContentInputSchema,
  contentPackSchema,
  installContentPackInputSchema,
  resourceIdSchema,
} from "@velvet/contracts";
import type {
  CampaignContentConfiguration,
  ConfigureCampaignContentInput,
  ContentPack,
  InstallContentPackInput,
  RpgDefinition,
} from "../../types.js";
import {
  CampaignContentConfigurationAuthorizationError,
  CampaignContentConfigurationConflictError,
  ContentPackInstallationAuthorizationError,
  ContentPackInstallationConflictError,
} from "./campaignErrors.js";
import {
  sameMetadata,
  toContentPack,
  toRpgDefinition,
  toRulesProfile,
  type ContentPackRow,
  type RpgDefinitionRow,
  type RulesProfileRow,
} from "./campaignContentRowMappers.js";
import type {
  OriginalStarterSetupInspection,
  OriginalStarterSetupInspectionRepository,
} from "./originalStarterSetupInspectionRepo.js";

/** Write boundary for campaign content installation and configuration. */
export interface CampaignContentWriteRepository {
  installContentPack(actorPrincipalId: string, input: InstallContentPackInput): ContentPack;
  configureCampaignContent(
    actorPrincipalId: string,
    campaignId: string,
    input: ConfigureCampaignContentInput,
  ): CampaignContentConfiguration;
  installOriginalStarterContent(actorPrincipalId: string, campaignId: string, input: InstallContentPackInput): ContentPack;
  configureOriginalStarterContent(
    actorPrincipalId: string,
    campaignId: string,
    input: ConfigureCampaignContentInput,
  ): CampaignContentConfiguration;
}

function requireOriginalStarterInspectionForWrite(
  inspectionRepository: OriginalStarterSetupInspectionRepository,
  actorId: string,
  campaignId: string,
  operation: "install" | "configure",
): OriginalStarterSetupInspection {
  const inspection = inspectionRepository.inspectOriginalStarterSetup(actorId, campaignId);
  if (inspection.status === "unavailable") {
    if (operation === "install") throw new ContentPackInstallationAuthorizationError();
    throw new CampaignContentConfigurationAuthorizationError();
  }
  if (inspection.status === "conflict") {
    if (operation === "install") {
      throw new ContentPackInstallationConflictError("original starter reserved identities conflict");
    }
    throw new CampaignContentConfigurationConflictError("original starter reserved identities conflict");
  }
  return inspection;
}

function installContentPackSync(
  db: DatabaseDriver.Database, actorPrincipalId: string, input: InstallContentPackInput,
  originalStarterCampaignId?: string,
  originalStarterSetupInspectionRepository?: OriginalStarterSetupInspectionRepository,
): ContentPack {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const starterCampaignId = originalStarterCampaignId === undefined ? undefined : resourceIdSchema.parse(originalStarterCampaignId);
  const normalized = installContentPackInputSchema.parse(input);
  const definitions: RpgDefinition[] = [
    ...normalized.classes, ...normalized.races, ...normalized.backgrounds, ...normalized.items,
    ...normalized.spells, ...normalized.abilities, ...normalized.enemies,
  ];
  const contentPack = contentPackSchema.parse({
    packId: normalized.packId, packVersion: normalized.packVersion, rulesProfileId: normalized.rulesProfileId,
    name: normalized.name, description: normalized.description, tags: normalized.tags,
  });
  return db.transaction(() => {
    if (starterCampaignId !== undefined) {
      // Full authority, campaign configuration, reserved profile, every pack
      // version, and every expected/captured definition are checked after the
      // IMMEDIATE lock is acquired, before any generic install decisions.
      requireOriginalStarterInspectionForWrite(originalStarterSetupInspectionRepository!, actorId, starterCampaignId, "install");
    } else {
      // Preserve the generic installation API's established authorization.
      const owner = db.prepare("SELECT principal_id FROM application_owner WHERE singleton = 1").get() as { principal_id: string } | undefined;
      if (!owner || owner.principal_id !== actorId) throw new ContentPackInstallationAuthorizationError();
    }
    const profileRow = db.prepare(`SELECT rules_profile_id, name, description, tags
      FROM rpg_rules_profiles WHERE rules_profile_id = ?`).get(normalized.rulesProfileId) as RulesProfileRow | undefined;
    if (profileRow && !sameMetadata(toRulesProfile(profileRow), normalized.rulesProfile)) {
      throw new ContentPackInstallationConflictError("rules profile metadata conflicts with the installed profile");
    }
    const packRow = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags, sealed
      FROM rpg_content_packs WHERE pack_id = ? AND pack_version = ?`).get(normalized.packId, normalized.packVersion) as ContentPackRow | undefined;
    if (packRow) {
      if ((packRow as ContentPackRow & { sealed: number }).sealed !== 1) {
        throw new ContentPackInstallationConflictError("content pack installation conflicts with an incomplete pack");
      }
      const installedPack = toContentPack(packRow);
      if (installedPack.rulesProfileId !== normalized.rulesProfileId || !sameMetadata(installedPack, contentPack)) {
        throw new ContentPackInstallationConflictError("content pack metadata conflicts with the installed pack");
      }
      const rows = db.prepare(`SELECT kind, definition_id, name, description, tags
        FROM rpg_definitions WHERE pack_id = ? AND pack_version = ?`).all(normalized.packId, normalized.packVersion) as RpgDefinitionRow[];
      const installed = new Map(rows.map((row) => {
        const definition = toRpgDefinition(row);
        return [`${definition.kind}:${definition.definitionId}`, definition];
      }));
      const equivalent = installed.size === definitions.length && definitions.every((definition) => {
        const persisted = installed.get(`${definition.kind}:${definition.definitionId}`);
        return persisted !== undefined && sameMetadata(persisted, definition);
      });
      if (!equivalent) throw new ContentPackInstallationConflictError("content pack definitions conflict with the installed pack");
      return installedPack;
    }
    // This is deliberately the last statement before the first global write.
    // BEGIN IMMEDIATE prevents either authority from changing afterward.
    if (starterCampaignId !== undefined) {
      requireOriginalStarterInspectionForWrite(originalStarterSetupInspectionRepository!, actorId, starterCampaignId, "install");
    }
    if (!profileRow) {
      db.prepare(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags) VALUES (?, ?, ?, ?)`).run(
        normalized.rulesProfileId, normalized.rulesProfile.name, normalized.rulesProfile.description,
        JSON.stringify(normalized.rulesProfile.tags),
      );
    }
    db.prepare(`INSERT INTO rpg_content_packs
      (pack_id, pack_version, rules_profile_id, name, description, tags, sealed) VALUES (?, ?, ?, ?, ?, ?, 0)`).run(
      contentPack.packId, contentPack.packVersion, contentPack.rulesProfileId, contentPack.name,
      contentPack.description, JSON.stringify(contentPack.tags),
    );
    const insertDefinition = db.prepare(`INSERT INTO rpg_definitions
      (pack_id, pack_version, kind, definition_id, name, description, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const definition of definitions) {
      insertDefinition.run(contentPack.packId, contentPack.packVersion, definition.kind, definition.definitionId,
        definition.name, definition.description, JSON.stringify(definition.tags));
    }
    db.prepare(`UPDATE rpg_content_packs SET sealed = 1 WHERE pack_id = ? AND pack_version = ? AND sealed = 0`)
      .run(contentPack.packId, contentPack.packVersion);
    db.prepare(`INSERT INTO rpg_content_pack_publications
      (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
       validation_report_json,published_by_principal_id,published_at)
      VALUES (?,?,'legacy-v10',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`).run(contentPack.packId, contentPack.packVersion);
    return contentPack;
  }).immediate();
}

interface CampaignContentPinRow { pack_id: string; pack_version: string; rules_profile_id: string; }

function configureCampaignContentSync(
  db: DatabaseDriver.Database, actorPrincipalId: string, campaignId: string, input: ConfigureCampaignContentInput,
  requireOriginalStarterAuthority = false,
  originalStarterSetupInspectionRepository?: OriginalStarterSetupInspectionRepository,
): CampaignContentConfiguration {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const id = resourceIdSchema.parse(campaignId);
  const normalized = configureCampaignContentInputSchema.parse(input);
  const projection = () => campaignContentConfigurationSchema.parse({
    campaignId: id, rulesProfileId: normalized.rulesProfileId,
    contentPacks: [...normalized.contentPacks].sort((left, right) =>
      (left.packId < right.packId ? -1 : left.packId > right.packId ? 1 : 0)
      || (left.packVersion < right.packVersion ? -1 : left.packVersion > right.packVersion ? 1 : 0)),
  });
  return db.transaction(() => {
    if (requireOriginalStarterAuthority) requireOriginalStarterInspectionForWrite(originalStarterSetupInspectionRepository!, actorId, id, "configure");
    const campaign = db.prepare("SELECT owner_principal_id FROM campaigns WHERE id = ?").get(id) as { owner_principal_id: string } | undefined;
    if (!campaign) throw new CampaignContentConfigurationAuthorizationError("campaign not found");
    if (campaign.owner_principal_id !== actorId) throw new CampaignContentConfigurationAuthorizationError("campaign content configuration requires the campaign owner");
    if (!db.prepare(`SELECT 1 FROM campaign_memberships WHERE campaign_id = ? AND principal_id = ? AND role = 'owner'`).get(id, actorId)) {
      throw new CampaignContentConfigurationAuthorizationError("malformed campaign ownership");
    }
    const selectedProfile = db.prepare(`SELECT campaign_id, rules_profile_id FROM campaign_rules_profiles WHERE campaign_id = ?`).get(id) as { campaign_id: string; rules_profile_id: string } | undefined;
    const pinRows = db.prepare(`SELECT pack_id, pack_version, rules_profile_id
      FROM campaign_content_packs WHERE campaign_id = ? ORDER BY rowid ASC`).all(id) as CampaignContentPinRow[];
    if (selectedProfile || pinRows.length > 0) {
      if (!selectedProfile) throw new Error("malformed campaign content configuration");
      let existing: CampaignContentConfiguration;
      try { existing = campaignContentConfigurationSchema.parse({ campaignId: selectedProfile.campaign_id,
        rulesProfileId: selectedProfile.rules_profile_id, contentPacks: pinRows.map((pin) => ({ packId: pin.pack_id, packVersion: pin.pack_version })) });
      } catch { throw new Error("malformed campaign content configuration"); }
      const profileRow = db.prepare(`SELECT rules_profile_id, name, description, tags FROM rpg_rules_profiles
        WHERE rules_profile_id = ?`).get(existing.rulesProfileId) as RulesProfileRow | undefined;
      if (!profileRow || pinRows.some((pin) => pin.rules_profile_id !== existing.rulesProfileId)) throw new Error("malformed campaign content configuration");
      try { toRulesProfile(profileRow); } catch { throw new Error("malformed campaign content configuration"); }
      const exactSealedPack = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags
        FROM rpg_content_packs WHERE pack_id = ? AND pack_version = ? AND rules_profile_id = ? AND sealed = 1`);
      for (const pack of existing.contentPacks) {
        const row = exactSealedPack.get(pack.packId, pack.packVersion, existing.rulesProfileId) as ContentPackRow | undefined;
        try { if (!row) throw new Error(); toContentPack(row); } catch { throw new Error("malformed campaign content configuration"); }
      }
      const requestedPins = new Set(normalized.contentPacks.map((pack) => `${pack.packId}\u0000${pack.packVersion}`));
      const equivalent = existing.rulesProfileId === normalized.rulesProfileId && existing.contentPacks.length === normalized.contentPacks.length
        && existing.contentPacks.every((pack) => requestedPins.has(`${pack.packId}\u0000${pack.packVersion}`));
      if (!equivalent) throw new CampaignContentConfigurationConflictError();
      return projection();
    }
    const profileRow = db.prepare(`SELECT rules_profile_id, name, description, tags FROM rpg_rules_profiles
      WHERE rules_profile_id = ?`).get(normalized.rulesProfileId) as RulesProfileRow | undefined;
    if (!profileRow) throw new Error("campaign content configuration unavailable");
    toRulesProfile(profileRow);
    const exactSealedPack = db.prepare(`SELECT pack_id, pack_version, rules_profile_id, name, description, tags
      FROM rpg_content_packs WHERE pack_id = ? AND pack_version = ? AND rules_profile_id = ? AND sealed = 1`);
    for (const pack of normalized.contentPacks) {
      const row = exactSealedPack.get(pack.packId, pack.packVersion, normalized.rulesProfileId) as ContentPackRow | undefined;
      if (!row) throw new Error("campaign content configuration unavailable");
      toContentPack(row);
    }
    // Recheck both authority graphs after all dependency reads and directly
    // before the first configuration write. The IMMEDIATE lock closes the
    // remaining window through both profile and pin inserts.
    if (requireOriginalStarterAuthority) requireOriginalStarterInspectionForWrite(originalStarterSetupInspectionRepository!, actorId, id, "configure");
    db.prepare(`INSERT INTO campaign_rules_profiles (campaign_id, rules_profile_id) VALUES (?, ?)`).run(id, normalized.rulesProfileId);
    const insertPin = db.prepare(`INSERT INTO campaign_content_packs
      (campaign_id, pack_id, pack_version, rules_profile_id) VALUES (?, ?, ?, ?)`);
    for (const pack of normalized.contentPacks) insertPin.run(id, pack.packId, pack.packVersion, normalized.rulesProfileId);
    return projection();
  }).immediate();
}

/** Creates campaign-content write operations scoped to one database connection. */
export function createCampaignContentWriteRepository(
  db: DatabaseDriver.Database,
  inspectionRepository: OriginalStarterSetupInspectionRepository,
): CampaignContentWriteRepository {
  return {
    installContentPack: (actorPrincipalId, input) => installContentPackSync(db, actorPrincipalId, input),
    configureCampaignContent: (actorPrincipalId, campaignId, input) => configureCampaignContentSync(db, actorPrincipalId, campaignId, input),
    installOriginalStarterContent: (actorPrincipalId, campaignId, input) =>
      installContentPackSync(db, actorPrincipalId, input, campaignId, inspectionRepository),
    configureOriginalStarterContent: (actorPrincipalId, campaignId, input) =>
      configureCampaignContentSync(db, actorPrincipalId, campaignId, input, true, inspectionRepository),
  };
}

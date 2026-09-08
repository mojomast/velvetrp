import type DatabaseDriver from "better-sqlite3";
import {
  MECHANICS_STARTER_RULES_PROFILE_ID,
  ORIGINAL_STARTER_RULES_PROFILE,
  SRD_5_1_STARTER_RULES_PROFILE_ID,
} from "@velvet/contracts";
import { createDefaultRulesetRegistry } from "./registry.js";
import type { RulesetModule } from "./types.js";

export type CampaignRulesetBinding = Readonly<{
  rulesProfileId: string;
  rulesetId: string;
  rulesetVersion: string;
  module: RulesetModule;
}>;

const PROFILE_BINDINGS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  [MECHANICS_STARTER_RULES_PROFILE_ID]: ["velvet-starter-v1", "1.0.0"] as const,
  [ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId]: ["velvet-starter-v1", "1.0.0"] as const,
  [SRD_5_1_STARTER_RULES_PROFILE_ID]: ["dnd-5e", "1.0.0"] as const,
  "dnd-5e": ["dnd-5e", "1.0.0"] as const,
});

export function rulesetIdentityForProfile(rulesProfileId: string): readonly [string, string] {
  const identity = PROFILE_BINDINGS[rulesProfileId];
  if (!identity) throw new Error(`unknown rules profile engine: ${rulesProfileId}`);
  return identity;
}

export function resolveProfileRulesetIdentity(db: DatabaseDriver.Database, rulesProfileId: string): readonly [string, string] {
  const row = db.prepare("SELECT ruleset_id,ruleset_version FROM rpg_rules_profile_bindings_v60 WHERE rules_profile_id=?")
    .get(rulesProfileId) as { ruleset_id: string; ruleset_version: string } | undefined;
  if (row) return [row.ruleset_id, row.ruleset_version];
  const builtIn = PROFILE_BINDINGS[rulesProfileId];
  if (builtIn) return builtIn;
  // Profiles created before engine bindings existed used Velvet mechanics.
  // Only an extant legacy profile receives this compatibility interpretation.
  if (db.prepare("SELECT 1 FROM rpg_rules_profiles WHERE id=?").get(rulesProfileId)) {
    return ["velvet-starter-v1", "1.0.0"];
  }
  throw new Error(`unknown rules profile engine: ${rulesProfileId}`);
}

export function resolveCampaignRuleset(db: DatabaseDriver.Database, campaignId: string): CampaignRulesetBinding {
  const row = db.prepare(`SELECT profile.rules_profile_id rulesProfileId,binding.ruleset_id rulesetId,
      binding.ruleset_version rulesetVersion
    FROM campaign_rules_profiles profile
    LEFT JOIN campaign_ruleset_bindings_v60 binding ON binding.campaign_id=profile.campaign_id
    WHERE profile.campaign_id=?`).get(campaignId) as { rulesProfileId: string; rulesetId: string | null; rulesetVersion: string | null } | undefined;
  if (!row) throw new Error("campaign has no rules profile binding");
  const expected = resolveProfileRulesetIdentity(db, row.rulesProfileId);
  const id = row.rulesetId ?? expected[0], version = row.rulesetVersion ?? expected[1];
  if (id !== expected[0] || version !== expected[1]) throw new Error("campaign rules profile and engine identity are mixed");
  const publications = db.prepare(`SELECT publication.rules_engine rulesetId,
      COALESCE(json_extract(publication.manifest_json,'$.compatibility.rulesEngineVersion'),
        CASE publication.rules_engine WHEN 'velvet-starter-v1' THEN '1.0.0' END) rulesetVersion
    FROM campaign_content_packs pin JOIN rpg_content_pack_publications publication
      ON publication.pack_id=pin.pack_id AND publication.pack_version=pin.pack_version
    WHERE pin.campaign_id=? ORDER BY pin.pack_id`).all(campaignId) as Array<{ rulesetId: string | null; rulesetVersion: string | null }>;
  if (publications.some((publication) => publication.rulesetId !== null
      && (publication.rulesetId !== id || publication.rulesetVersion !== version))) {
    throw new Error("campaign content publications use mixed rules engines");
  }
  return Object.freeze({ rulesProfileId: row.rulesProfileId, rulesetId: id, rulesetVersion: version,
    module: createDefaultRulesetRegistry().get(id, version) });
}

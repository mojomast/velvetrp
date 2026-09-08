import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  administrationIntegrationReceiptSchema, campaignAdministrationIntegrationsSchema,
  rulesetSelectionCommandSchema, safetyActionCommandSchema, sessionZeroSafetyPolicySchema,
  sessionZeroSafetyUpdateCommandSchema, shopBuyPolicyCommandSchema, vendorAssociationCommandSchema,
  type AdministrationIntegrationReceipt, type CampaignAdministrationIntegrations,
  type RulesetSelectionCommand, type SafetyActionCommand, type SessionZeroSafetyPolicy,
  type SessionZeroSafetyUpdateCommand, type ShopBuyPolicyCommand, type VendorAssociationCommand,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaign/campaignTypes.js";
import { createDefaultRulesetRegistry } from "../rulesets/registry.js";
import { resolveCampaignRuleset } from "../rulesets/campaignBinding.js";

export class CampaignIntegrationUnavailableError extends Error {}
export class CampaignIntegrationForbiddenError extends Error {}
export class CampaignIntegrationStaleError extends Error {}
export class CampaignIntegrationConflictError extends Error {}

type Operation = AdministrationIntegrationReceipt["operation"];
type Command = VendorAssociationCommand | ShopBuyPolicyCommand | RulesetSelectionCommand | SessionZeroSafetyUpdateCommand | SafetyActionCommand;

export interface CampaignAdministrationIntegrationRepository {
  getCampaignAdministrationIntegrations(principalId: string, campaignId: string): CampaignAdministrationIntegrations | null;
  getSessionZeroSafetyPolicy(principalId: string, campaignId: string): SessionZeroSafetyPolicy | null;
  associateCampaignVendor(principalId: string, campaignId: string, input: VendorAssociationCommand): { receipt: AdministrationIntegrationReceipt; administration: CampaignAdministrationIntegrations };
  configureCampaignBuyPolicy(principalId: string, campaignId: string, input: ShopBuyPolicyCommand): { receipt: AdministrationIntegrationReceipt; administration: CampaignAdministrationIntegrations };
  selectCampaignRuleset(principalId: string, campaignId: string, input: RulesetSelectionCommand): { receipt: AdministrationIntegrationReceipt; administration: CampaignAdministrationIntegrations };
  updateSessionZeroSafetyPolicy(principalId: string, campaignId: string, input: SessionZeroSafetyUpdateCommand): { receipt: AdministrationIntegrationReceipt; administration: CampaignAdministrationIntegrations };
  requestCampaignSafetyAction(principalId: string, campaignId: string, input: SafetyActionCommand): { receipt: AdministrationIntegrationReceipt; administration: CampaignAdministrationIntegrations };
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]])) : item);
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const safetyRank = { disallowed: 0, "fade-to-black": 1, "explicit-consent": 2, allowed: 3 } as const;
const lethalityRank = { "nonlethal-default": 0, "consent-required": 1, "rules-as-written": 2 } as const;

export function createCampaignAdministrationIntegrationRepository(db: DatabaseDriver.Database, deps: RepositoryDependencies,
  guard: () => void): CampaignAdministrationIntegrationRepository {
  const registry = createDefaultRulesetRegistry();
  const member = (principalId: string, campaignId: string) => db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
    .get(campaignId, principalId) as { role: "owner" | "gm" | "player" | "observer" } | undefined;
  const ensureRoot = (campaignId: string, at: string) => db.prepare("INSERT OR IGNORE INTO campaign_administration_integrations_v59(campaign_id,updated_at) VALUES(?,?)").run(campaignId, at);
  const mechanicallyEmpty = (campaignId: string): boolean => {
    const checks = ["campaign_actors", "campaign_commands", "rpg_m15_receipts_v25", "encounter", "campaign_catalog_current_selections", "campaign_generation_accepted_artifacts_v52"];
    return checks.every((table) => !(db.prepare(`SELECT 1 FROM ${table} WHERE campaign_id=? LIMIT 1`).get(campaignId)));
  };
  const rulesetIdentity = (module: ReturnType<typeof registry.get>, migration: "none" | "destructive") => ({
    rulesetId: module.descriptor.id, name: module.descriptor.name, version: module.descriptor.version,
    digest: digest(module.descriptor), migration,
    ...(migration === "destructive" ? { migrationSummary: "Selection is permitted only while the campaign has no rules profile, catalog selection, characters, generated canon, encounters, or mechanical receipts. Existing mechanics are never reinterpreted." } : {}),
    capabilities: (module.descriptor.capabilities ?? []).map((capability) => ({ capabilityId: capability.id,
      label: capability.id.replaceAll("-", " "), supported: capability.status !== "unsupported",
      ...(capability.status === "supported" ? {} : { detail: capability.notes ?? capability.status }) })),
  });
  const safety = (campaignId: string, revision: number): SessionZeroSafetyPolicy => {
    const row = db.prepare("SELECT * FROM campaign_administration_integrations_v59 WHERE campaign_id=?").get(campaignId) as any;
    return sessionZeroSafetyPolicySchema.parse({ revision, hardLimits: row ? JSON.parse(row.hard_limits_json) : [],
      veils: row ? JSON.parse(row.veils_json) : [], pvpPolicy: row?.pvp_policy ?? "explicit-consent",
      romancePolicy: row?.romance_policy ?? "fade-to-black", lethalityPolicy: row?.lethality_policy ?? "consent-required",
      paused: Boolean(row?.paused) });
  };
  const read = (principalId: string, campaignId: string): CampaignAdministrationIntegrations | null => {
    guard(); const role = member(principalId, campaignId); if (!role) return null;
    const campaign = db.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(campaignId) as { administration_revision: number } | undefined;
    if (!campaign) return null;
    const root = db.prepare("SELECT ruleset_id,ruleset_version,ruleset_digest FROM campaign_administration_integrations_v59 WHERE campaign_id=?").get(campaignId) as any;
    let bound: ReturnType<typeof resolveCampaignRuleset> | null = null;
    try { bound = resolveCampaignRuleset(db, campaignId); } catch { bound = null; }
    const currentModule = bound?.module ?? registry.get(root?.ruleset_id ?? registry.list()[0]!.descriptor.id,
      root?.ruleset_version ?? registry.list()[0]!.descriptor.version);
    if (root?.ruleset_id && (root.ruleset_version !== currentModule.descriptor.version || root.ruleset_digest !== digest(currentModule.descriptor))) throw new Error("persisted ruleset identity is not compiled");
    const empty = mechanicallyEmpty(campaignId);
    const npcs = db.prepare("SELECT npc_id npcId,public_name name FROM campaign_npcs_v28 WHERE campaign_id=? ORDER BY public_name,npc_id").all(campaignId) as any[];
    const shopRows = db.prepare("SELECT shop_id shopId,name FROM rpg_shop_definitions_v25 WHERE campaign_id=? ORDER BY name,shop_id").all(campaignId) as any[];
    const shops = shopRows.map((shop) => ({ ...shop, stock: (db.prepare("SELECT stock_id stockId,item_definition_id label FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=? ORDER BY stock_id").all(campaignId, shop.shopId) as any[]) }));
    const associations = (db.prepare(`SELECT binding.npc_id npcId,binding.shop_id shopId,COALESCE(MAX(command.expected_revision+1),0) revision
      FROM campaign_npc_shop_bindings_v57 binding LEFT JOIN campaign_administration_integration_commands_v59 command
      ON command.campaign_id=binding.campaign_id AND command.operation='associate-vendor' AND json_extract(command.request_json,'$.npcId')=binding.npc_id
      WHERE binding.campaign_id=? GROUP BY binding.npc_id,binding.shop_id ORDER BY binding.npc_id`).all(campaignId) as any[]);
    const buyPolicies = (db.prepare(`SELECT policy.shop_id shopId,policy.stock_id stockId,policy.payout_unit_minor payoutUnitMinor,COALESCE(MAX(command.expected_revision+1),0) revision
      FROM rpg_shop_buy_policies_v57 policy LEFT JOIN campaign_administration_integration_commands_v59 command
      ON command.campaign_id=policy.campaign_id AND command.operation='set-buy-policy' AND json_extract(command.request_json,'$.shopId')=policy.shop_id AND json_extract(command.request_json,'$.stockId')=policy.stock_id
      WHERE policy.campaign_id=? GROUP BY policy.shop_id,policy.stock_id,policy.payout_unit_minor ORDER BY policy.shop_id,policy.stock_id`).all(campaignId) as any[]);
    const privileged = role.role === "owner" || role.role === "gm";
    const jobs = (db.prepare("SELECT job_id jobId,state,attempt_count attempt,request_digest requestDigest,updated_at updatedAt,draft_id draftId FROM campaign_generation_jobs_v52 WHERE campaign_id=? ORDER BY updated_at DESC,job_id").all(campaignId) as any[]);
    const drafts = (db.prepare(`SELECT draft.id draftId,job.job_id jobId,draft.state,draft.revision,draft.created_at createdAt,
      (SELECT count(*) FROM campaign_generation_candidate_artifacts_v52 artifact WHERE artifact.draft_id=draft.id ${privileged ? "" : "AND artifact.visibility='public'"}) artifactCount
      FROM generation_drafts draft LEFT JOIN campaign_generation_jobs_v52 job ON job.draft_id=draft.id WHERE draft.campaign_id=? AND draft.kind='content-pack' ORDER BY draft.updated_at DESC,draft.id`).all(campaignId) as any[])
      .map((draft) => ({ ...draft, state: ["staged", "approved", "applied"].includes(draft.state) ? draft.state : "abandoned" }));
    const profile = db.prepare("SELECT rules_profile_id rulesProfileId FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId) as any;
    const recentSafetyRequests = (db.prepare("SELECT receipt_json FROM campaign_administration_integration_commands_v59 WHERE campaign_id=? AND operation IN('pause','resume','skip','rewind') ORDER BY occurred_at DESC,command_id DESC LIMIT 20").all(campaignId) as any[]).map((row) => JSON.parse(row.receipt_json));
    return campaignAdministrationIntegrationsSchema.parse({ campaignId, actorRole: role.role, revision: campaign.administration_revision,
      commerce: { npcs, shops, associations, buyPolicies }, rulesets: { current: rulesetIdentity(currentModule, "none"),
        available: registry.list().filter((item) => item.descriptor.id !== currentModule.descriptor.id).map((item) => rulesetIdentity(item, "destructive")),
        rulesProfileId: profile?.rulesProfileId ?? null, mechanicallyEmpty: empty,
        selectionWarning: "Ruleset selection is a mechanical identity change, never a cosmetic migration. It is rejected after any mechanical or rules-profile state exists." },
      generation: { jobs, drafts, retrySupported: false }, safety: safety(campaignId, campaign.administration_revision), recentSafetyRequests });
  };
  const mutate = (principalId: string, campaignId: string, operation: Operation, input: Command, requireOwner: boolean,
    apply: (at: string) => { outcome: string; checkpointWorkflowRequired?: boolean }) => {
    guard(); return db.transaction(() => {
      const role = member(principalId, campaignId), safetyAction = ["pause", "resume", "skip", "rewind"].includes(operation);
      if (!role || (requireOwner ? role.role !== "owner" : safetyAction ? false : !["owner", "gm"].includes(role.role))) throw new CampaignIntegrationForbiddenError();
      const requestJson = canonical(input);
      const prior = db.prepare("SELECT operation,request_json,receipt_json FROM campaign_administration_integration_commands_v59 WHERE campaign_id=? AND idempotency_key=?").get(campaignId, input.idempotencyKey) as any;
      if (prior) {
        if (prior.operation !== operation || prior.request_json !== requestJson) throw new CampaignIntegrationConflictError("idempotency key was reused");
        return { receipt: administrationIntegrationReceiptSchema.parse(JSON.parse(prior.receipt_json)), administration: read(principalId, campaignId)! };
      }
      const campaign = db.prepare("SELECT administration_revision,updated_at FROM campaigns WHERE id=?").get(campaignId) as any;
      if (!campaign) throw new CampaignIntegrationUnavailableError();
      if (campaign.administration_revision !== input.expectedRevision) throw new CampaignIntegrationStaleError();
      const at = new Date(Math.max(deps.clock.now().getTime(), Date.parse(campaign.updated_at) + 1)).toISOString(); ensureRoot(campaignId, at);
      const result = apply(at), commandId = deps.ids.nextId(), receipt = administrationIntegrationReceiptSchema.parse({ commandId, campaignId,
        operation, idempotencyKey: input.idempotencyKey, revisionBefore: input.expectedRevision, revisionAfter: input.expectedRevision + 1,
        occurredAt: at, ...result });
      db.prepare("UPDATE campaigns SET administration_revision=administration_revision+1,updated_at=? WHERE id=? AND administration_revision=?").run(at, campaignId, input.expectedRevision);
      db.prepare("INSERT INTO campaign_administration_integration_commands_v59 VALUES(?,?,?,?,?,?,?,?,?)").run(commandId, campaignId, principalId, operation, input.idempotencyKey, input.expectedRevision, requestJson, canonical(receipt), at);
      return { receipt, administration: read(principalId, campaignId)! };
    }).immediate();
  };
  return {
    getCampaignAdministrationIntegrations: read,
    getSessionZeroSafetyPolicy(principalId, campaignId) { const snapshot = read(principalId, campaignId); return snapshot?.safety ?? null; },
    associateCampaignVendor(principalId, campaignId, raw) { const input = vendorAssociationCommandSchema.parse(raw); return mutate(principalId, campaignId, "associate-vendor", input, false, (at) => {
      const valid = db.prepare("SELECT 1 FROM campaign_npcs_v28 npc JOIN rpg_shop_definitions_v25 shop ON shop.campaign_id=npc.campaign_id WHERE npc.campaign_id=? AND npc.npc_id=? AND shop.shop_id=?").get(campaignId, input.npcId, input.shopId);
      if (!valid) throw new CampaignIntegrationUnavailableError();
      const prior = db.prepare("SELECT shop_id FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=? AND npc_id=?").get(campaignId, input.npcId) as any;
      if (prior && prior.shop_id !== input.shopId) throw new CampaignIntegrationConflictError("NPC already has a different shop");
      if (!prior) db.prepare("INSERT INTO campaign_npc_shop_bindings_v57 VALUES(?,?,?,?,?)").run(campaignId, input.npcId, input.shopId, at, principalId);
      return { outcome: `NPC ${input.npcId} is associated with shop ${input.shopId}.` };
    }); },
    configureCampaignBuyPolicy(principalId, campaignId, raw) { const input = shopBuyPolicyCommandSchema.parse(raw); return mutate(principalId, campaignId, "set-buy-policy", input, false, (at) => {
      const stock = db.prepare("SELECT currency_code FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=? AND stock_id=?").get(campaignId, input.shopId, input.stockId) as any;
      if (!stock) throw new CampaignIntegrationUnavailableError();
      db.prepare(`INSERT INTO rpg_shop_buy_policies_v57 VALUES(?,?,?,?,?,?,?) ON CONFLICT(campaign_id,shop_id,stock_id) DO UPDATE SET payout_unit_minor=excluded.payout_unit_minor,currency_code=excluded.currency_code,accepted_at=excluded.accepted_at,accepted_by_principal_id=excluded.accepted_by_principal_id`).run(campaignId, input.shopId, input.stockId, input.payoutUnitMinor, stock.currency_code, at, principalId);
      return { outcome: input.payoutUnitMinor === 0 ? "Paid purchase is disabled; gifts remain available." : `Payout set to ${input.payoutUnitMinor} minor units.` };
    }); },
    selectCampaignRuleset(principalId, campaignId, raw) { const input = rulesetSelectionCommandSchema.parse(raw); return mutate(principalId, campaignId, "select-ruleset", input, true, () => {
      if (!mechanicallyEmpty(campaignId)) throw new CampaignIntegrationConflictError("campaign is not mechanically empty");
      const prior = db.prepare("SELECT ruleset_id,ruleset_version,ruleset_digest FROM campaign_administration_integrations_v59 WHERE campaign_id=?")
        .get(campaignId) as { ruleset_id: string | null; ruleset_version: string | null; ruleset_digest: string | null } | undefined;
      if (prior?.ruleset_id) {
        if (prior.ruleset_id === input.rulesetId && prior.ruleset_version === input.version && prior.ruleset_digest === input.digest) {
          return { outcome: `Selected compiled ruleset ${input.rulesetId}@${input.version}; no existing mechanics were migrated.` };
        }
        throw new CampaignIntegrationConflictError("campaign ruleset identity is already reserved");
      }
      const selected = registry.get(input.rulesetId, input.version), selectedDigest = digest(selected.descriptor);
      if (selected.descriptor.version !== input.version || selectedDigest !== input.digest) throw new CampaignIntegrationConflictError("ruleset identity is not compiled");
      db.prepare("UPDATE campaign_administration_integrations_v59 SET ruleset_id=?,ruleset_version=?,ruleset_digest=? WHERE campaign_id=?").run(input.rulesetId, input.version, input.digest, campaignId);
      return { outcome: `Selected compiled ruleset ${input.rulesetId}@${input.version}; no existing mechanics were migrated.` };
    }); },
    updateSessionZeroSafetyPolicy(principalId, campaignId, raw) { const input = sessionZeroSafetyUpdateCommandSchema.parse(raw); return mutate(principalId, campaignId, "update-safety", input, false, (at) => {
      const current = safety(campaignId, input.expectedRevision), union = (left: string[], right: string[]) => [...new Set([...left, ...right])].sort();
      const hardLimits = union(current.hardLimits, input.hardLimits), veils = union(current.veils, input.veils);
      if (hardLimits.length > 32 || veils.length > 32) throw new CampaignIntegrationConflictError("conservative safety union exceeds the policy limit");
      const pvpPolicy = safetyRank[input.pvpPolicy] < safetyRank[current.pvpPolicy] ? input.pvpPolicy : current.pvpPolicy;
      const romancePolicy = safetyRank[input.romancePolicy] < safetyRank[current.romancePolicy] ? input.romancePolicy : current.romancePolicy;
      const lethalityPolicy = lethalityRank[input.lethalityPolicy] < lethalityRank[current.lethalityPolicy] ? input.lethalityPolicy : current.lethalityPolicy;
      db.prepare(`UPDATE campaign_administration_integrations_v59 SET safety_revision=safety_revision+1,hard_limits_json=?,veils_json=?,pvp_policy=?,romance_policy=?,lethality_policy=?,updated_at=? WHERE campaign_id=?`)
        .run(canonical(hardLimits), canonical(veils), pvpPolicy, romancePolicy, lethalityPolicy, at, campaignId);
      return { outcome: "Safety agreement updated conservatively; existing limits were retained." };
    }); },
    requestCampaignSafetyAction(principalId, campaignId, raw) { const input = safetyActionCommandSchema.parse(raw); return mutate(principalId, campaignId, input.action, input, false, (at) => {
      if (input.action === "pause" || input.action === "resume") db.prepare("UPDATE campaign_administration_integrations_v59 SET paused=?,updated_at=? WHERE campaign_id=?").run(input.action === "pause" ? 1 : 0, at, campaignId);
      if (input.action === "rewind") return { outcome: "Rewind requested. Mechanics were not erased; use an existing checkpoint and fork the timeline for a safe reversal.", checkpointWorkflowRequired: true };
      if (input.action === "skip") return { outcome: "Skip requested and recorded. Existing mechanics remain durable." };
      return { outcome: input.action === "pause" ? "Campaign adventure mutations are paused." : "Campaign adventure mutations are resumed." };
    }); },
  };
}

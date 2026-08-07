import type DatabaseDriver from "better-sqlite3";
import {
  campaignAdministrationEventSchema, campaignAdministrationReceiptSchema, campaignCheckpointSchema,
  campaignMembershipReadSchema, campaignRecapSchema, campaignSessionAttachmentSchema,
  campaignTimelineHistorySchema,
  type ApplyCampaignImportInput, type CampaignAdministration, type CampaignAdministrationEvent,
  type CampaignAdministrationPatch, type CampaignAdministrationReceipt, type CampaignCheckpoint,
  type CampaignExportManifest, type CampaignImportDryRun, type CampaignMembership,
  type CampaignMembershipMutation, type CampaignMembershipRead, type CampaignMembershipRoleMutation,
  type CampaignRecap, type CampaignRevisionMutation, type CampaignRoomMutation,
  type CampaignSessionAttachment, type CampaignTimelineHistory, type CampaignTransferPackage,
  type CreateCampaignCheckpointInput, type CreateCampaignExportInput, type CreateCampaignRecapInput,
  type ForkCampaignTimelineInput,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaign/campaignTypes.js";
import {
  createAdministrationAccessRepo, createAdministrationCommandRepo, createAdministrationEventRepo,
  createAdministrationExportRepository, createAdministrationImportRepository,
  createAdministrationReceiptRepo, createCampaignTimelineRepo,
} from "./campaignAdmin/index.js";

export class CampaignAdministrationForbiddenError extends Error {
  readonly code = "CAMPAIGN_ADMINISTRATION_FORBIDDEN";
  constructor() { super("campaign administration is unavailable"); this.name = "CampaignAdministrationForbiddenError"; }
}
export class CampaignAdministrationStaleError extends Error {
  readonly code = "CAMPAIGN_ADMINISTRATION_STALE";
  constructor() { super("campaign administration revision is stale"); this.name = "CampaignAdministrationStaleError"; }
}
export class CampaignAdministrationConflictError extends Error {
  readonly code = "CAMPAIGN_ADMINISTRATION_CONFLICT";
  constructor(message: string) { super(message); this.name = "CampaignAdministrationConflictError"; }
}

type MutationResult<T> = { value: T; receipt: CampaignAdministrationReceipt };
export interface ConfirmedCampaignArchiveInput {
  confirmationName: string;
  expectedRevision: number;
  idempotencyKey: string;
}
export interface CampaignAdministrationRepository {
  getCampaignAdministration(actor: string, campaignId: string): CampaignAdministration | null;
  renameCampaignCompatibility(actor: string, campaignId: string, name: string, expectedUpdatedAt?: string): CampaignAdministrationReceipt;
  updateCampaignAdministration(actor: string, campaignId: string, input: CampaignAdministrationPatch): MutationResult<CampaignAdministration>;
  archiveCampaignWithConfirmation(actor: string, campaignId: string, input: ConfirmedCampaignArchiveInput):
    MutationResult<CampaignAdministration>;
  addAuditedCampaignMembership(actor: string, campaignId: string, input: CampaignMembershipMutation): MutationResult<CampaignMembership>;
  changeAuditedCampaignMembershipRole(actor: string, campaignId: string, principalId: string, input: CampaignMembershipRoleMutation): MutationResult<CampaignMembershipRead>;
  removeAuditedCampaignMembership(actor: string, campaignId: string, principalId: string, input: CampaignRevisionMutation): MutationResult<CampaignMembershipRead>;
  attachAuditedCampaignRoom(actor: string, campaignId: string, input: CampaignRoomMutation): MutationResult<CampaignSessionAttachment>;
  detachAuditedCampaignRoom(actor: string, campaignId: string, input: CampaignRoomMutation): MutationResult<CampaignSessionAttachment>;
  listCampaignTimelineHistory(actor: string, campaignId: string): CampaignTimelineHistory[];
  createCampaignCheckpoint(actor: string, campaignId: string, input: CreateCampaignCheckpointInput): MutationResult<CampaignCheckpoint>;
  listCampaignCheckpoints(actor: string, campaignId: string): CampaignCheckpoint[];
  forkCampaignTimeline(actor: string, campaignId: string, input: ForkCampaignTimelineInput): MutationResult<CampaignTimelineHistory>;
  createCampaignRecap(actor: string, campaignId: string, input: CreateCampaignRecapInput): MutationResult<CampaignRecap>;
  listCampaignRecaps(actor: string, campaignId: string): CampaignRecap[];
  dryRunCampaignImport(actor: string, input: unknown): CampaignImportDryRun;
  applyCampaignImport(actor: string, input: ApplyCampaignImportInput): MutationResult<CampaignAdministration>;
  createCampaignExport(actor: string, campaignId: string, input: CreateCampaignExportInput):
    MutationResult<{ manifest: CampaignExportManifest; package: CampaignTransferPackage }>;
  listCampaignAdministrationEvents(actor: string, campaignId: string): CampaignAdministrationEvent[];
  getCampaignAdministrationReceipt(actor: string, campaignId: string, commandId: string): CampaignAdministrationReceipt | null;
}

export function createCampaignAdministrationRepository(db: DatabaseDriver.Database,
  deps: RepositoryDependencies, assertCanMutate: () => void = () => undefined,
  validateRoom: (sessionId: string) => "running" | "stopped" | null = () => null): CampaignAdministrationRepository {
  const access = createAdministrationAccessRepo(db);
  let runDryRunCampaignImport: (actor: string, input: unknown) => CampaignImportDryRun;
  const imports = createAdministrationImportRepository({ db, deps, validateRoom, getAuthority: access.getAuthority,
    forbidden: () => new CampaignAdministrationForbiddenError(), assertCanMutate,
    conflict: (message) => new CampaignAdministrationConflictError(message),
    getCampaignAdministration: access.getCampaignAdministration,
    dryRunCampaignImport: (actor, input) => runDryRunCampaignImport(actor, input) });
  runDryRunCampaignImport = imports.dryRunCampaignImport;
  const member = (row: any) => campaignMembershipReadSchema.parse({ campaignId: row.campaign_id,
    principalId: row.principal_id, role: row.role, createdAt: row.created_at });
  const attachment = (row: any) => campaignSessionAttachmentSchema.parse({ campaignId: row.campaign_id,
    sessionId: row.session_id, attachedAt: row.attached_at });
  const checkpoint = (row: any) => campaignCheckpointSchema.parse({ id: row.id, campaignId: row.campaign_id,
    timelineId: row.timeline_id, timelineRevision: row.timeline_revision, label: row.label, createdAt: row.created_at });
  const recap = (row: any) => campaignRecapSchema.parse({ id: row.id, campaignId: row.campaign_id,
    timelineId: row.timeline_id, throughRevision: row.through_revision,
    selectedSessionIds: JSON.parse(row.selected_session_ids), visibility: row.visibility, text: row.text, createdAt: row.created_at });
  const timeline = (row: any, activeId: string) => campaignTimelineHistorySchema.parse({ id: row.id,
    campaignId: row.campaign_id, parentTimelineId: row.parent_timeline_id, forkedFromRevision: row.forked_from_revision,
    revision: row.revision, createdAt: row.created_at, active: row.id === activeId });
  const commands = createAdministrationCommandRepo({ db, nextId: () => deps.ids.nextId(), now: () => deps.clock.now(),
    getAuthority: access.getAuthority, assertCanMutate,
    errors: { forbidden: () => new CampaignAdministrationForbiddenError(), stale: () => new CampaignAdministrationStaleError(),
      conflict: (message) => new CampaignAdministrationConflictError(message) },
    validateRoom, member, attachment, checkpoint, recap, timeline });
  const events = createAdministrationEventRepo({ db, getAuthority: access.getAuthority });
  const receipts = createAdministrationReceiptRepo({ db, event: campaignAdministrationEventSchema.parse,
    getAuthority: access.getAuthority, receipt: campaignAdministrationReceiptSchema.parse });
  const exports = createAdministrationExportRepository({ db, deps, runMutation: commands.runMutation, events, receipts });
  const timelines = createCampaignTimelineRepo({ db, getAuthority: access.getAuthority, timeline });
  return {
    getCampaignAdministration: access.getCampaignAdministration,
    renameCampaignCompatibility: commands.renameCampaignCompatibility,
    updateCampaignAdministration: commands.updateCampaignAdministration,
    archiveCampaignWithConfirmation: commands.archiveCampaignWithConfirmation,
    addAuditedCampaignMembership: commands.addAuditedCampaignMembership,
    changeAuditedCampaignMembershipRole: commands.changeAuditedCampaignMembershipRole,
    removeAuditedCampaignMembership: commands.removeAuditedCampaignMembership,
    attachAuditedCampaignRoom: commands.attachAuditedCampaignRoom,
    detachAuditedCampaignRoom: commands.detachAuditedCampaignRoom,
    createCampaignCheckpoint: commands.createCampaignCheckpoint,
    listCampaignCheckpoints: commands.listCampaignCheckpoints,
    forkCampaignTimeline: commands.forkCampaignTimeline,
    createCampaignRecap: commands.createCampaignRecap,
    listCampaignRecaps: commands.listCampaignRecaps,
    listCampaignTimelineHistory: timelines.listCampaignTimelineHistory,
    dryRunCampaignImport: imports.dryRunCampaignImport,
    applyCampaignImport: imports.applyCampaignImport,
    createCampaignExport: exports.createCampaignExport,
    listCampaignAdministrationEvents: events.listCampaignAdministrationEvents,
    getCampaignAdministrationReceipt: receipts.getCampaignAdministrationReceipt,
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { campaignDiceRollRequestSchema, campaignRenameRequestSchema, MECHANICS_STARTER_IDENTITY, ORIGINAL_STARTER_PRESENTATION } from "@velvet/contracts";
import { ApiError, attachCampaignRoom, createOriginalStarterCampaignCharacter, getCampaignCharacterCreationOptions, getCampaignDetail, getCampaignDiceHistory, listCampaignCharacters, listCampaignRooms, renameCampaign, rollCampaignDice, setupMechanicsStarter, setupOriginalStarter, type CampaignDetail } from "../api";
import type { CampaignCharacterCreateResponse, CampaignCharacterCreationOptionsResponse, CampaignCharacterListResponse, CampaignDetailResponse, CampaignDiceHistoryResponse, CampaignDiceRollResponse, CampaignRoomAttachResponse, CampaignRoomLinkingResponse, CampaignRoomSummary } from "@velvet/contracts";

export interface CampaignDetailPageProps {
  campaignId: string;
  onBack: () => void;
  onUnavailable: () => void;
  onOpenCharacter?: (campaignCharacterId: string) => void;
  onOpenCharacterBuilder?: () => void;
  onOpenRoom?: (sessionId: string) => void;
  onOpenAdministration?: (campaignName: string) => void;
  onOpenCombat?: () => void;
  focusCombatRequest?: number;
  onCombatFocused?: (request: number) => void;
  mechanicsEnabled?: boolean;
  /** App-owned, campaign-scoped SPA transition request. */
  focusHeadingRequest?: number;
  onHeadingFocused?: (request: number) => void;
  /** App-owned request used when returning from campaign-origin chat. */
  roomsRefreshRequest?: number;
  /** Acknowledges this exact request only after its refreshed target is focused. */
  onRoomsRefreshHandled?: (request: number) => void;
  /** App-owned room hydration state; it blocks detail navigation while pending. */
  roomOpenPending?: boolean;
  /** Privacy-safe, request-scoped room hydration failure. */
  roomOpenFailure?: { request: number; text: string } | null;
}

type RenamePhase = "idle" | "writing" | "reconciling";
type SetupPhase = "idle" | "writing" | "reconciling";
type SetupChoice = "original" | "mechanics";
type RosterPhase = "loading" | "ready" | "failed" | "unsupported";
type OptionsPhase = "loading" | "ready" | "failed" | "unsupported";
type CreatePhase = "idle" | "writing" | "reconciling";
type CharacterStatusActivity = "idle" | "reconciling" | "refreshing";
type RosterRetryFocusIntent = {
  campaignId: string;
  generation: number;
  outcome: "pending" | "success" | "failure";
};
type OptionsRetryFocusIntent = {
  campaignId: string;
  generation: number;
  outcome: "pending" | "success" | "failure";
};
type MutationKind = "rename" | "setup" | "create" | "dice" | "attach-room";
type MutationToken = symbol;
type SettledRoster = PromiseSettledResult<CampaignCharacterListResponse>;
type SettledOptions = PromiseSettledResult<CampaignCharacterCreationOptionsResponse>;
interface CreateReconciliation {
  characterId: string;
  post: PromiseSettledResult<CampaignCharacterCreateResponse>;
  roster: SettledRoster;
  options: SettledOptions;
}
interface CampaignMutation {
  token: MutationToken;
  kind: MutationKind;
  createReconciliation?: CreateReconciliation;
  diceReconciliation?: DiceReconciliation;
  roomReconciliation?: RoomReconciliation;
  setupReconciliation?: SetupReconciliation;
}
interface SetupReconciliation {
  choice: SetupChoice;
  put: PromiseSettledResult<CampaignDetailResponse>;
  detail: PromiseSettledResult<CampaignDetailResponse>;
}
interface RoomReconciliation {
  sessionId: string;
  put: PromiseSettledResult<CampaignRoomAttachResponse>;
  rooms: PromiseSettledResult<CampaignRoomLinkingResponse>;
}
interface CompletedRoomReconciliation {
  campaignId: string;
  token: MutationToken;
  reconciliation: RoomReconciliation;
}
interface CompletedCreateReconciliation {
  campaignId: string;
  token: MutationToken;
  reconciliation: CreateReconciliation;
}
type DicePhase = "loading" | "ready" | "failed" | "writing" | "reconciling";
type DiceOutcomeKind = "committed" | "binding-conflict" | "unavailable" | "ambiguous";
interface DiceResult {
  text: string;
  alert: boolean;
  ambiguous: boolean;
  kind: DiceOutcomeKind;
}
interface DiceReconciliation {
  post: PromiseSettledResult<CampaignDiceRollResponse>;
  history: PromiseSettledResult<CampaignDiceHistoryResponse>;
}
interface CompletedDiceReconciliation {
  campaignId: string;
  token: MutationToken;
  reconciliation: DiceReconciliation;
}

// Component-local refs cannot survive a route unmount. This module-level guard
// serializes the one explicit mutation across close/reopen without retrying it.
// A full document reload necessarily loses JS memory, so its outcome remains
// ambiguous and must be reconciled by GET rather than an automatic write.
const inFlightCampaignMutations = new Map<string, CampaignMutation>();
const completedCreateReconciliations = new Map<string, CompletedCreateReconciliation>();
const completedDiceReconciliations = new Map<string, CompletedDiceReconciliation>();
// A peer that observes completion before its detail is renderable owns a hold
// on the module snapshot. If that peer unmounts, the hold deliberately remains
// so a later reopen can consume the exact outcome instead of losing it.
const pendingDiceDetailCompletions = new Map<string, MutationToken>();
const completedRoomReconciliations = new Map<string, CompletedRoomReconciliation>();
const mutationListeners = new Set<(campaignId: string, mutation: CampaignMutation, active: boolean) => void>();
let documentMutationWarningInstalled = false;

/**
 * Completion broadcasts are synchronous, but React StrictMode may immediately
 * tear down and replay an effect after it consumes one. Defer removal until a
 * microtask after application: every currently mounted listener can consume
 * the exact token during finish(), and a replay in the same turn can consume
 * it again. If no matching instance can apply it (for example an operation
 * settles while its route is unmounted), no cleanup is scheduled and the
 * snapshot remains available for the next matching reopen.
 */
function deferCompletionCleanup<T extends { token: MutationToken }>(
  completions: Map<string, T>, campaignId: string, token: MutationToken,
  cleanupAllowed: () => boolean = () => true,
): void {
  void Promise.resolve().then(() => {
    if (!cleanupAllowed()) return;
    if (!inFlightCampaignMutations.has(campaignId)
      && completions.get(campaignId)?.token === token) completions.delete(campaignId);
  });
}

function blockDocumentUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

function syncDocumentMutationWarning(): void {
  const needed = inFlightCampaignMutations.size > 0;
  if (needed === documentMutationWarningInstalled) return;
  if (needed) window.addEventListener("beforeunload", blockDocumentUnload);
  else window.removeEventListener("beforeunload", blockDocumentUnload);
  documentMutationWarningInstalled = needed;
}

/** Clears document-lifetime state only for isolated component tests. */
export function resetCampaignDetailPageModuleStateForTests(): void {
  inFlightCampaignMutations.clear();
  syncDocumentMutationWarning();
  completedCreateReconciliations.clear();
  completedDiceReconciliations.clear();
  pendingDiceDetailCompletions.clear();
  completedRoomReconciliations.clear();
  mutationListeners.clear();
  initialDetailReads.clear();
  initialRosterReads.clear();
  initialOptionsReads.clear();
  initialDiceReads.clear();
  initialRoomReads.clear();
  setupOptionsRefreshCampaigns.clear();
}
function beginCampaignMutation(campaignId: string, kind: MutationKind): CampaignMutation | null {
  if (inFlightCampaignMutations.has(campaignId)) return null;
  const mutation = { token: Symbol(`${kind}:${campaignId}`), kind };
  inFlightCampaignMutations.set(campaignId, mutation);
  // Reload protection is document-wide, unlike the displayed campaign's busy
  // policy. It therefore survives route unmounts and A-to-B navigation.
  syncDocumentMutationWarning();
  for (const listener of mutationListeners) listener(campaignId, mutation, true);
  return mutation;
}

function finishCampaignMutation(campaignId: string, mutation: CampaignMutation): void {
  // A completion may release only the exact campaign operation it acquired.
  // This also makes every guard release idempotent.
  if (inFlightCampaignMutations.get(campaignId)?.token !== mutation.token) return;
  inFlightCampaignMutations.delete(campaignId);
  syncDocumentMutationWarning();
  for (const listener of mutationListeners) listener(campaignId, mutation, false);
}

const initialDetailReads = new Map<string, Promise<Awaited<ReturnType<typeof getCampaignDetail>>>>();
const initialRosterReads = new Map<string, Promise<Awaited<ReturnType<typeof listCampaignCharacters>>>>();
const initialOptionsReads = new Map<string, Promise<Awaited<ReturnType<typeof getCampaignCharacterCreationOptions>>>>();
const initialDiceReads = new Map<string, Promise<Awaited<ReturnType<typeof getCampaignDiceHistory>>>>();
const initialRoomReads = new Map<string, Promise<Awaited<ReturnType<typeof listCampaignRooms>>>>();
// Setup can settle while its page is absent or showing another campaign. This
// intent is document-lifetime and campaign-scoped, not tied to a detail read.
const setupOptionsRefreshCampaigns = new Set<string>();

function invalidateInitialOptionsRead(campaignId: string): void {
  initialOptionsReads.delete(campaignId);
}

function invalidateInitialCharacterReads(campaignId: string): void {
  initialRosterReads.delete(campaignId);
  invalidateInitialOptionsRead(campaignId);
}

function reusableInitialRead<T>(cache: Map<string, Promise<T>>, campaignId: string, read: () => Promise<T>): Promise<T> {
  const existing = cache.get(campaignId);
  if (existing) return existing;
  const promise = read();
  cache.set(campaignId, promise);
  void promise.finally(() => {
    if (cache.get(campaignId) === promise) cache.delete(campaignId);
  }).catch(() => undefined);
  return promise;
}

function displayRole(role: CampaignDetail["actorRole"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function isOriginalStarterConfigured(campaign: CampaignDetail): boolean {
  return campaign.content.status === "configured"
    && campaign.content.rulesProfileId === ORIGINAL_STARTER_PRESENTATION.rulesProfile.id
    && campaign.content.contentPacks.length === 1
    && campaign.content.contentPacks[0]?.packId === ORIGINAL_STARTER_PRESENTATION.pack.id
    && campaign.content.contentPacks[0]?.packVersion === ORIGINAL_STARTER_PRESENTATION.pack.version;
}

function isMechanicsStarterConfigured(campaign: CampaignDetail): boolean {
  return campaign.content.status === "configured"
    && campaign.content.rulesProfileId === MECHANICS_STARTER_IDENTITY.rulesProfileId
    && campaign.content.contentPacks.length === 1
    && campaign.content.contentPacks[0]?.packId === MECHANICS_STARTER_IDENTITY.packId
    && campaign.content.contentPacks[0]?.packVersion === MECHANICS_STARTER_IDENTITY.packVersion;
}

function reconciledPresence(reconciliation: CreateReconciliation): { present: boolean; used: boolean; complete: boolean } {
  if (reconciliation.roster.status !== "fulfilled" || reconciliation.options.status !== "fulfilled") {
    return { present: false, used: false, complete: false };
  }
  return {
    present: reconciliation.roster.value.characters.some((entry) => entry.characterId === reconciliation.characterId),
    used: reconciliation.options.value.personas.some((entry) => entry.characterId === reconciliation.characterId && entry.alreadyUsed),
    complete: true,
  };
}

function createOutcomeMessage(reconciliation: CreateReconciliation): { text: string; alert: boolean } {
  const proof = reconciledPresence(reconciliation);
  const validResponse = reconciliation.post.status === "fulfilled";
  if (validResponse && proof.complete && proof.present && proof.used) {
    return { text: "Character record created and confirmed by the latest character status.", alert: false };
  }
  if (!validResponse && proof.complete && proof.present && proof.used) {
    return { text: "The character record is currently present, but it cannot be attributed to this create attempt.", alert: true };
  }
  if (!proof.complete || proof.present !== proof.used) {
    return { text: "Character creation has only partial reconciliation or unavailable reads. Current status could not be confirmed; the POST was not repeated.", alert: true };
  }
  const error = reconciliation.post.status === "rejected" ? reconciliation.post.reason : null;
  if (error instanceof ApiError && error.status === 409) {
    return { text: "Character creation conflicts with current state. Latest status is shown; the POST was not repeated.", alert: true };
  }
  if (error instanceof ApiError && error.status === 404) {
    return { text: "Character creation is unavailable for this campaign or persona. Latest status is shown; the POST was not repeated.", alert: true };
  }
  return { text: "The selected persona is currently unused, so character creation was not confirmed. The POST was not repeated.", alert: true };
}

function diceOutcomeMessage(reconciliation: DiceReconciliation): DiceResult {
  const historyLoaded = reconciliation.history.status === "fulfilled";
  if (reconciliation.post.status === "fulfilled") {
    return {
      text: historyLoaded
        ? "The server confirmed the roll was committed. Latest roll history was refreshed."
        : "The server confirmed the roll was committed, but latest roll history could not be refreshed.",
      alert: !historyLoaded,
      ambiguous: false,
      kind: "committed",
    };
  }

  const error = reconciliation.post.reason;
  if (error instanceof ApiError && error.status === 409 && error.code === "RPG_CAMPAIGN_DICE_BINDING_CONFLICT") {
    return {
      text: historyLoaded
        ? "The roll was not committed because the character selection changed. Latest roll history is shown."
        : "The roll was not committed because the character selection changed. Latest roll history could not be loaded.",
      alert: true,
      ambiguous: false,
      kind: "binding-conflict",
    };
  }
  if (error instanceof ApiError && error.status === 404 && error.code === "RPG_CAMPAIGN_NOT_FOUND") {
    return {
      text: historyLoaded
        ? "The roll was not committed because campaign dice became unavailable. Latest roll history is shown."
        : "The roll was not committed because campaign dice became unavailable. Latest roll history could not be loaded.",
      alert: true,
      ambiguous: false,
      kind: "unavailable",
    };
  }
  return {
    text: historyLoaded
      ? "The latest roll history is shown, but this roll attempt remains unknown and cannot be attributed. No roll was repeated."
      : "This roll attempt remains unknown, and the latest roll history could not be loaded. No roll was repeated.",
    alert: true,
    ambiguous: true,
    kind: "ambiguous",
  };
}

function refreshedDiceOutcome(kind: DiceOutcomeKind, historyLoaded: boolean): DiceResult {
  const common = { alert: kind !== "committed" || !historyLoaded, ambiguous: kind === "ambiguous", kind };
  if (kind === "committed") return {
    ...common,
    text: historyLoaded
      ? "The committed roll remains confirmed by the server response. Latest roll history was refreshed."
      : "The committed roll remains confirmed by the server response, but latest roll history could not be refreshed.",
  };
  if (kind === "binding-conflict") return {
    ...common,
    text: historyLoaded
      ? "The roll was not committed because the character selection changed. Latest roll history was refreshed."
      : "The roll was not committed because the character selection changed. Latest roll history could not be refreshed.",
  };
  if (kind === "unavailable") return {
    ...common,
    text: historyLoaded
      ? "The roll was not committed because campaign dice was unavailable. Latest roll history was refreshed."
      : "The roll was not committed because campaign dice was unavailable. Latest roll history could not be refreshed.",
  };
  return {
    ...common,
    text: historyLoaded
      ? "Latest roll history was refreshed, but the earlier roll attempt remains unknown and cannot be attributed. No roll was repeated."
      : "The earlier roll attempt remains unknown, and latest roll history could not be refreshed. No roll was repeated.",
  };
}

function roomTitle(room: CampaignRoomSummary): string {
  return room.title ?? (room.participantNames.join(" & ") || "Untitled room");
}

function roomOutcomeMessage(reconciliation: RoomReconciliation): { text: string; alert: boolean } {
  const refreshed = reconciliation.rooms.status === "fulfilled";
  if (reconciliation.put.status === "fulfilled") return {
    text: refreshed
      ? "Room attached. Latest campaign rooms were refreshed."
      : "Room attached, but latest campaign rooms could not be loaded.",
    alert: !refreshed,
  };
  const error = reconciliation.put.reason;
  if (error instanceof ApiError && error.status === 409) return {
    text: refreshed
      ? "The room could not be attached because its status conflicts with this campaign. Latest rooms are shown; the PUT was not repeated."
      : "The room could not be attached because its status conflicts with this campaign, and latest rooms could not be loaded. The PUT was not repeated.",
    alert: true,
  };
  if (error instanceof ApiError && error.status === 404) return {
    text: refreshed
      ? "The campaign or room is no longer available. Latest rooms are shown; the PUT was not repeated."
      : "The campaign or room is no longer available, and latest rooms could not be loaded. The PUT was not repeated.",
    alert: true,
  };
  return {
    text: refreshed
      ? "Latest rooms are shown, but the attachment outcome is unknown. The PUT was not repeated."
      : "The attachment outcome is unknown and latest rooms could not be loaded. Refresh rooms before deciding whether to try again; the PUT was not repeated.",
    alert: true,
  };
}

export function CampaignDetailPage({ campaignId, mechanicsEnabled = false, onBack, onUnavailable, onOpenCharacter = () => undefined, onOpenCharacterBuilder = () => undefined, onOpenRoom = () => undefined, onOpenAdministration = () => undefined, onOpenCombat, focusCombatRequest, onCombatFocused = () => undefined, focusHeadingRequest, onHeadingFocused = () => undefined, roomsRefreshRequest, onRoomsRefreshHandled = () => undefined, roomOpenPending = false, roomOpenFailure = null }: CampaignDetailPageProps) {
  const [campaign, setCampaign] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [renamePhase, setRenamePhase] = useState<RenamePhase>("idle");
  const [renameError, setRenameError] = useState("");
  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
  const [setupChoice, setSetupChoice] = useState<SetupChoice | null>(null);
  const [setupConfirmed, setSetupConfirmed] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [roster, setRoster] = useState<CampaignCharacterListResponse["characters"]>([]);
  const [rosterPhase, setRosterPhase] = useState<RosterPhase>("loading");
  const [rosterAnnouncement, setRosterAnnouncement] = useState("");
  const [options, setOptions] = useState<CampaignCharacterCreationOptionsResponse | null>(null);
  const [optionsPhase, setOptionsPhase] = useState<OptionsPhase>("loading");
  const [optionsAnnouncement, setOptionsAnnouncement] = useState("");
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [createConfirmed, setCreateConfirmed] = useState(false);
  const [createPhase, setCreatePhase] = useState<CreatePhase>("idle");
  const [createResult, setCreateResult] = useState<{ text: string; alert: boolean } | null>(null);
  const [characterStatusActivity, setCharacterStatusActivity] = useState<CharacterStatusActivity>("idle");
  const [diceHistory, setDiceHistory] = useState<CampaignDiceHistoryResponse | null>(null);
  const [dicePhase, setDicePhase] = useState<DicePhase>("loading");
  const [diceExpression, setDiceExpression] = useState("1d20");
  const [diceCharacterPosition, setDiceCharacterPosition] = useState<number | null>(null);
  const [diceError, setDiceError] = useState("");
  const [diceResult, setDiceResult] = useState<DiceResult | null>(null);
  const [rooms, setRooms] = useState<CampaignRoomLinkingResponse | null>(null);
  const [roomsPhase, setRoomsPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [completedRoomsRefresh, setCompletedRoomsRefresh] = useState<{ request: number; succeeded: boolean } | null>(null);
  const [roomResult, setRoomResult] = useState<{ text: string; alert: boolean } | null>(null);
  const [roomActivity, setRoomActivity] = useState<"idle" | "writing" | "reconciling" | "refreshing">("idle");
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  // Roster reads are deliberately independent from detail reconciliation and
  // write generations: neither operation may invalidate or unlock the other.
  const rosterGenerationRef = useRef(0);
  const optionsGenerationRef = useRef(0);
  const diceGenerationRef = useRef(0);
  const roomsGenerationRef = useRef(0);
  const activeCampaignRef = useRef(campaignId);
  activeCampaignRef.current = campaignId;
  const campaignRef = useRef<CampaignDetail | null>(campaign);
  campaignRef.current = campaign;
  const renameLockedRef = useRef(false);
  const setupLockedRef = useRef(false);
  const createLockedRef = useRef(false);
  const diceLockedRef = useRef(false);
  const roomLockedRef = useRef(false);
  const roomManualReadLockRef = useRef<symbol | null>(null);
  const ownedMutationsRef = useRef(new Map<MutationToken, { campaignId: string; generation: number }>());
  const [sharedMutationPending, setSharedMutationPending] = useState(() => inFlightCampaignMutations.has(campaignId));
  const renameInputRef = useRef<HTMLInputElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const combatButtonRef = useRef<HTMLButtonElement>(null);
  const detailFocusIntentRef = useRef<{ campaignId: string; request: number; generation: number } | null>(null);
  const focusedHeadingRequestRef = useRef<number | null>(null);
  const focusHeadingRequestRef = useRef(focusHeadingRequest);
  focusHeadingRequestRef.current = focusHeadingRequest;
  const onHeadingFocusedRef = useRef(onHeadingFocused);
  onHeadingFocusedRef.current = onHeadingFocused;
  const onRoomsRefreshHandledRef = useRef(onRoomsRefreshHandled);
  onRoomsRefreshHandledRef.current = onRoomsRefreshHandled;
  const setupConfirmationRef = useRef<HTMLInputElement>(null);
  const configuredStatusRef = useRef<HTMLDivElement>(null);
  const rosterHeadingRef = useRef<HTMLHeadingElement>(null);
  const rosterRetryRef = useRef<HTMLButtonElement>(null);
  const rosterRetryFocusIntentRef = useRef<RosterRetryFocusIntent | null>(null);
  const optionsHeadingRef = useRef<HTMLHeadingElement>(null);
  const optionsRetryRef = useRef<HTMLButtonElement>(null);
  const firstPersonaChoiceRef = useRef<HTMLInputElement>(null);
  const optionsRetryFocusIntentRef = useRef<OptionsRetryFocusIntent | null>(null);
  const createConfirmationRef = useRef<HTMLInputElement>(null);
  const createStatusRef = useRef<HTMLParagraphElement>(null);
  const diceHeadingRef = useRef<HTMLHeadingElement>(null);
  const diceRetryRef = useRef<HTMLButtonElement>(null);
  const diceManualReadLockRef = useRef<symbol | null>(null);
  const diceExpressionRef = useRef<HTMLInputElement>(null);
  const diceStatusRef = useRef<HTMLParagraphElement>(null);
  const roomsHeadingRef = useRef<HTMLHeadingElement>(null);
  const roomsRetryRef = useRef<HTMLButtonElement>(null);
  const roomStatusRef = useRef<HTMLParagraphElement>(null);
  const roomOpenStatusRef = useRef<HTMLParagraphElement>(null);
  const focusedRoomOpenFailureRef = useRef<number | null>(null);
  const appliedRoomTokenRef = useRef<MutationToken | null>(null);
  const handedOffRoomRef = useRef<CompletedRoomReconciliation | null>(null);
  const roomFocusIntentRef = useRef<{ campaignId: string; token?: MutationToken; request?: number; generation: number } | null>(null);
  const handledRoomsRefreshRequestRef = useRef<number | undefined>(undefined);
  const acknowledgedRoomsRefreshRequestRef = useRef<number | undefined>(undefined);
  const diceFocusIntentRef = useRef<{ campaignId: string; token: MutationToken; generation: number } | null>(null);
  const appliedDiceTokenRef = useRef<MutationToken | null>(null);
  const handedOffDiceRef = useRef<CompletedDiceReconciliation | null>(null);
  const pendingPeerDiceRef = useRef<CompletedDiceReconciliation | null>(null);
  const diceInitializedCampaignRef = useRef<string | null>(null);
  const createFocusIntentRef = useRef<{ campaignId: string; token: MutationToken; generation: number } | null>(null);
  const appliedCreateTokenRef = useRef<MutationToken | null>(null);
  // Retain a consumed handoff only across React StrictMode's effect replay.
  // A real second reopen gets a new component and cannot replay the snapshot.
  const handedOffCreateRef = useRef<CompletedCreateReconciliation | null>(null);
  // A same-campaign peer can observe create completion before its detail GET
  // has made that campaign renderable. Keep that exact token locally until the
  // matching detail is ready; the module snapshot may be consumed/cleaned by
  // another mounted peer in the meantime.
  const pendingPeerCreateRef = useRef<CompletedCreateReconciliation | null>(null);
  const handoffFreshReadsRef = useRef<{
    token: MutationToken;
    promise: Promise<[SettledRoster, SettledOptions]>;
  } | null>(null);
  const mutationFocusAfterReconciliationRef = useRef<{ kind: "rename" | "setup"; generation: number } | null>(null);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    if (!campaign || focusCombatRequest === undefined || !onOpenCombat) return;
    queueMicrotask(() => { if (mountedRef.current) { combatButtonRef.current?.focus(); onCombatFocused(focusCombatRequest); } });
  }, [campaign, focusCombatRequest, onCombatFocused, onOpenCombat]);

  const focusRename = useCallback((generation: number) => {
    queueMicrotask(() => {
      if (mountedRef.current && generation === generationRef.current) renameInputRef.current?.focus();
    });
  }, []);

  const hideOptionsForSetupReconciliation = useCallback((requestedCampaignId: string) => {
    invalidateInitialOptionsRead(requestedCampaignId);
    if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId) return;
    // A pre-commit request may still settle, so advance its generation before
    // clearing all form/error state while detail becomes authoritative.
    optionsGenerationRef.current += 1;
    optionsRetryFocusIntentRef.current = null;
    setOptions(null);
    setOptionsPhase("loading");
    setOptionsAnnouncement("");
    setSelectedCharacterId(null);
    setCreateConfirmed(false);
  }, []);

  const requirePostSetupOptionsRefresh = useCallback((requestedCampaignId: string) => {
    setupOptionsRefreshCampaigns.add(requestedCampaignId);
    hideOptionsForSetupReconciliation(requestedCampaignId);
  }, [hideOptionsForSetupReconciliation]);

  const markCampaignUnavailable = useCallback((requestedCampaignId: string) => {
    setupOptionsRefreshCampaigns.delete(requestedCampaignId);
    unavailableRef.current();
  }, []);

  const load = useCallback(async (reuseInitialInFlight = false, transitionFocusRequest?: number): Promise<number | null> => {
    const requestedCampaignId = campaignId;
    const generation = ++generationRef.current;
    if (!mountedRef.current) return null;
    detailFocusIntentRef.current = transitionFocusRequest !== undefined
      && focusedHeadingRequestRef.current !== transitionFocusRequest
      ? { campaignId: requestedCampaignId, request: transitionFocusRequest, generation }
      : null;
    setCampaign(null);
    setDraft("");
    setLoading(true);
    setFailed(false);
    setRenameError("");
    setSetupError("");
    setSetupConfirmed(false);
    setSetupChoice(null);
    setAnnouncement("");
    try {
      const response = await (reuseInitialInFlight
        ? reusableInitialRead(initialDetailReads, campaignId, () => getCampaignDetail(campaignId))
        : getCampaignDetail(campaignId));
      if (!mountedRef.current || generation !== generationRef.current) return null;
      setCampaign(response.campaign);
      setDraft(response.campaign.name);
      setSetupChoice(response.campaign.actorRole === "owner" && response.campaign.content.status === "unconfigured"
        ? "original" : null);
      setLoading(false);
      return generation;
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return null;
      if (error instanceof ApiError && error.status === 404) {
        markCampaignUnavailable(campaignId);
        return null;
      }
      setFailed(true);
      setLoading(false);
      return null;
    }
  }, [campaignId, markCampaignUnavailable]);

  const loadRoster = useCallback(async (retry = false, reuseInitialInFlight = false) => {
    const requestedCampaignId = campaignId;
    const generation = ++rosterGenerationRef.current;
    if (!mountedRef.current) return;
    setRoster([]);
    setRosterPhase("loading");
    setRosterAnnouncement("");
    rosterRetryFocusIntentRef.current = retry
      ? { campaignId: requestedCampaignId, generation, outcome: "pending" }
      : null;
    try {
      const response = await (reuseInitialInFlight
        ? reusableInitialRead(initialRosterReads, requestedCampaignId, () => listCampaignCharacters(requestedCampaignId))
        : listCampaignCharacters(requestedCampaignId));
      if (!mountedRef.current || generation !== rosterGenerationRef.current
        || activeCampaignRef.current !== requestedCampaignId) return;
      setRoster(response.characters);
      setRosterPhase("ready");
      setRosterAnnouncement(response.characters.length === 0
        ? "Character roster is empty."
        : `${response.characters.length} ${response.characters.length === 1 ? "character" : "characters"} loaded.`);
      const intent = rosterRetryFocusIntentRef.current;
      if (intent?.campaignId === requestedCampaignId && intent.generation === generation) {
        intent.outcome = "success";
      }
    } catch (error) {
      if (!mountedRef.current || generation !== rosterGenerationRef.current
        || activeCampaignRef.current !== requestedCampaignId) return;
      setRoster([]);
      // Older compatible servers do not have this read. Its absence says
      // nothing about detail availability and must never navigate the user.
      const unsupported = error instanceof ApiError && error.status === 404;
      setRosterPhase(unsupported ? "unsupported" : "failed");
      const intent = rosterRetryFocusIntentRef.current;
      if (unsupported) {
        rosterRetryFocusIntentRef.current = null;
      } else if (intent?.campaignId === requestedCampaignId && intent.generation === generation) {
        intent.outcome = "failure";
      }
    }
  }, [campaignId]);

  const loadOptions = useCallback(async (retry = false, reuseInitialInFlight = false) => {
    const requestedCampaignId = campaignId;
    const generation = ++optionsGenerationRef.current;
    if (!mountedRef.current) return;
    setOptions(null);
    setOptionsPhase("loading");
    setOptionsAnnouncement("");
    setSelectedCharacterId(null);
    setCreateConfirmed(false);
    optionsRetryFocusIntentRef.current = retry
      ? { campaignId: requestedCampaignId, generation, outcome: "pending" }
      : null;
    try {
      const response = await (reuseInitialInFlight
        ? reusableInitialRead(initialOptionsReads, requestedCampaignId, () => getCampaignCharacterCreationOptions(requestedCampaignId))
        : getCampaignCharacterCreationOptions(requestedCampaignId));
      if (!mountedRef.current || generation !== optionsGenerationRef.current
        || activeCampaignRef.current !== requestedCampaignId) return;
      setOptions(response);
      setOptionsPhase("ready");
      setOptionsAnnouncement(retry ? "Character creation options loaded." : "");
      const intent = optionsRetryFocusIntentRef.current;
      if (intent?.campaignId === requestedCampaignId && intent.generation === generation) {
        intent.outcome = "success";
      }
    } catch (error) {
      if (!mountedRef.current || generation !== optionsGenerationRef.current
        || activeCampaignRef.current !== requestedCampaignId) return;
      setOptions(null);
      setOptionsPhase(error instanceof ApiError && error.status === 404 ? "unsupported" : "failed");
      const intent = optionsRetryFocusIntentRef.current;
      if (intent?.campaignId === requestedCampaignId && intent.generation === generation) {
        intent.outcome = "failure";
      }
    }
  }, [campaignId]);

  const loadDice = useCallback(async (retry = false, reuseInitialInFlight = false) => {
    const manualReadToken = retry ? Symbol("manual dice history read") : null;
    if (manualReadToken && diceManualReadLockRef.current) return;
    if (manualReadToken) diceManualReadLockRef.current = manualReadToken;
    const requestedCampaignId = campaignId;
    const generation = ++diceGenerationRef.current;
    try {
      if (!mountedRef.current) return;
      setDicePhase("loading");
      setDiceError("");
      const response = await (reuseInitialInFlight
        ? reusableInitialRead(initialDiceReads, requestedCampaignId, () => getCampaignDiceHistory(requestedCampaignId))
        : getCampaignDiceHistory(requestedCampaignId));
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
          || diceGenerationRef.current !== generation) return;
      setDiceHistory(response);
      setDiceCharacterPosition((current) => response.characters.some((character) => character.position === current)
        ? current : response.characters[0]?.position ?? null);
      setDicePhase("ready");
      if (retry) queueMicrotask(() => {
        if (mountedRef.current && activeCampaignRef.current === requestedCampaignId
            && diceGenerationRef.current === generation) diceHeadingRef.current?.focus();
      });
    } catch {
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
          || diceGenerationRef.current !== generation) return;
      setDiceHistory(null);
      setDicePhase("failed");
      setDiceError("Roll history could not be loaded.");
      if (retry) queueMicrotask(() => {
        if (mountedRef.current && activeCampaignRef.current === requestedCampaignId
            && diceGenerationRef.current === generation) diceRetryRef.current?.focus();
      });
    } finally {
      if (manualReadToken && diceManualReadLockRef.current === manualReadToken) {
        diceManualReadLockRef.current = null;
      }
    }
  }, [campaignId]);

  const loadRooms = useCallback(async (focus = false, reuseInitialInFlight = false, refreshRequest?: number) => {
    if (!mountedRef.current || roomLockedRef.current) return;
    const manualReadToken = focus ? Symbol("manual campaign rooms read") : null;
    if (manualReadToken && roomManualReadLockRef.current) return;
    if (manualReadToken) roomManualReadLockRef.current = manualReadToken;
    const requestedCampaignId = campaignId;
    const generation = ++roomsGenerationRef.current;
    if (refreshRequest !== undefined) {
      handledRoomsRefreshRequestRef.current = refreshRequest;
      roomFocusIntentRef.current = { campaignId: requestedCampaignId, request: refreshRequest, generation: generationRef.current };
    }
    // Manual refresh preserves the current projection so its room actions can
    // remain visibly disabled until the fresh GET settles.
    if (!focus) setRoomsPhase("loading");
    if (focus) setRoomActivity("refreshing");
    let succeeded = false;
    try {
      const response = await (reuseInitialInFlight
        ? reusableInitialRead(initialRoomReads, requestedCampaignId, () => listCampaignRooms(requestedCampaignId))
        : listCampaignRooms(requestedCampaignId));
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || roomsGenerationRef.current !== generation) return;
      setRooms(response);
      setRoomsPhase("ready");
      succeeded = true;
    } catch {
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || roomsGenerationRef.current !== generation) return;
      setRooms(null);
      setRoomsPhase("failed");
    } finally {
      if (mountedRef.current && activeCampaignRef.current === requestedCampaignId
        && roomsGenerationRef.current === generation && focus) setRoomActivity("idle");
      if (manualReadToken && roomManualReadLockRef.current === manualReadToken) roomManualReadLockRef.current = null;
    }
    if (focus) setRoomResult((current) => current ? {
      text: succeeded
        ? "Latest campaign rooms were refreshed. No PUT was made; the earlier attachment result is unchanged."
        : "Latest campaign rooms could not be refreshed. No PUT was made; the earlier attachment result is unchanged.",
      alert: current.alert || !succeeded,
    } : null);
    if (refreshRequest !== undefined && mountedRef.current
      && activeCampaignRef.current === requestedCampaignId && roomsGenerationRef.current === generation) {
      // A distinct state transition guarantees focus/acknowledgement runs even
      // when React batches loading→ready back to the prior visible phase.
      setCompletedRoomsRefresh({ request: refreshRequest, succeeded });
    }
    if (focus) queueMicrotask(() => {
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || roomsGenerationRef.current !== generation) return;
      const target = succeeded ? roomsHeadingRef.current : roomsRetryRef.current;
      target?.focus();
    });
  }, [campaignId]);

  const applyRoomReconciliation = useCallback((completed: CompletedRoomReconciliation, generation: number) => {
    if (!mountedRef.current || activeCampaignRef.current !== completed.campaignId
      || generationRef.current !== generation) return false;
    // The operation's reconciliation is authoritative over every room read
    // that started before it. Advancing here also protects listener handoff
    // paths where this component did not acquire the mutation itself.
    roomsGenerationRef.current += 1;
    initialRoomReads.delete(completed.campaignId);
    roomManualReadLockRef.current = null;
    const { reconciliation } = completed;
    if (reconciliation.rooms.status === "fulfilled") {
      setRooms(reconciliation.rooms.value);
      setRoomsPhase("ready");
    } else {
      setRooms(null);
      setRoomsPhase("failed");
    }
    setRoomResult(roomOutcomeMessage(reconciliation));
    setRoomActivity("idle");
    appliedRoomTokenRef.current = completed.token;
    roomFocusIntentRef.current = { campaignId: completed.campaignId, token: completed.token, generation };
    deferCompletionCleanup(completedRoomReconciliations, completed.campaignId, completed.token);
    return true;
  }, []);

  const applySetupReconciliation = useCallback((
    reconciliation: SetupReconciliation,
    requestedCampaignId: string,
    generation: number,
  ): boolean => {
    if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
      || generationRef.current !== generation) return false;
    setSetupConfirmed(false);
    if (reconciliation.detail.status === "rejected" || !reconciliation.detail.value?.campaign) {
      setSetupChoice(reconciliation.choice);
      const detailReason = reconciliation.detail.status === "rejected" ? reconciliation.detail.reason : null;
      const putReason = reconciliation.put.status === "rejected" ? reconciliation.put.reason : null;
      if ((detailReason instanceof ApiError && detailReason.status === 404)
        || (putReason instanceof ApiError && putReason.status === 404)) {
        markCampaignUnavailable(requestedCampaignId);
        return true;
      }
      const putConflict = reconciliation.put.status === "rejected"
        && reconciliation.put.reason instanceof ApiError && reconciliation.put.reason.status === 409;
      if (reconciliation.put.status === "fulfilled") {
        setSetupError(`${reconciliation.choice === "mechanics" ? "Mechanics" : "Original"} starter setup completed, but the latest details could not be refreshed. Refresh the campaign to reconcile current configuration; the PUT was not repeated.`);
      } else setSetupError(putConflict
        ? `${reconciliation.choice === "mechanics" ? "Mechanics" : "Original"} starter setup conflicts with current state, and the latest campaign details could not be loaded. The PUT was not repeated.`
        : "Setup outcome is uncertain and latest details could not be loaded. Setup uses two transactions, so the pack may remain installed (or the catalog may remain published). Refresh before deciding whether to try again; the PUT was not repeated.");
      return true;
    }

    // This successful authoritative post-PUT GET supersedes every detail read
    // started before it, including a StrictMode cache or same-campaign
    // reopen/peer read. Failed reconciliation has no state to supersede.
    initialDetailReads.delete(requestedCampaignId);
    const authoritativeGeneration = ++generationRef.current;
    const refreshed = reconciliation.detail.value.campaign;
    setCampaign(refreshed);
    setDraft(refreshed.name);
    setLoading(false);
    setFailed(false);
    setSetupChoice(refreshed.content.status === "unconfigured" ? reconciliation.choice : null);
    const exact = reconciliation.choice === "original"
      ? isOriginalStarterConfigured(refreshed)
      : isMechanicsStarterConfigured(refreshed);
    if (exact) {
      if (reconciliation.choice === "original") requirePostSetupOptionsRefresh(requestedCampaignId);
      else {
        setupOptionsRefreshCampaigns.delete(requestedCampaignId);
        hideOptionsForSetupReconciliation(requestedCampaignId);
      }
      setSetupError("");
      setAnnouncement(reconciliation.put.status === "fulfilled"
        ? `${reconciliation.choice === "mechanics" ? "Mechanics" : "Original"} starter setup is complete. The configured identifiers are now read-only.`
        : `${reconciliation.choice === "mechanics" ? "Mechanics" : "Original"} starter is currently active. The write response was not authoritative, so campaign detail was reconciled; the PUT was not repeated.`);
    } else if (refreshed.content.status === "configured") {
      setAnnouncement("");
      setSetupError("This campaign has a different content configuration. Latest identifiers are shown read-only; setup was not repeated.");
    } else {
      const conflict = reconciliation.put.status === "rejected"
        && reconciliation.put.reason instanceof ApiError && reconciliation.put.reason.status === 409;
      setAnnouncement("");
      setSetupError(conflict
        ? `${reconciliation.choice === "mechanics" ? "Mechanics" : "Original"} starter setup conflicts with reserved starter state or another configuration. The campaign remains unconfigured; setup was not repeated. The PUT was not repeated.`
        : "Setup could not be confirmed complete. The campaign remains unconfigured. Setup uses two transactions, so the pack may remain installed (or the catalog may remain published) after failure. The PUT was not repeated.");
    }
    mutationFocusAfterReconciliationRef.current = { kind: "setup", generation: authoritativeGeneration };
    return true;
  }, [hideOptionsForSetupReconciliation, markCampaignUnavailable, requirePostSetupOptionsRefresh]);

  const applyDiceReconciliation = useCallback((completed: CompletedDiceReconciliation, generation: number): boolean => {
    if (!mountedRef.current || activeCampaignRef.current !== completed.campaignId
        || campaignRef.current?.id !== completed.campaignId
        || generationRef.current !== generation) return false;
    // Supersede every history read/action that started before this operation,
    // including reads owned by another mounted instance of this campaign.
    diceGenerationRef.current += 1;
    initialDiceReads.delete(completed.campaignId);
    // Completion itself initializes this campaign's dice projection. In
    // particular, a detail GET that settles later must not start another,
    // potentially failing history GET over this retained result.
    diceInitializedCampaignRef.current = completed.campaignId;
    diceManualReadLockRef.current = null;
    const { reconciliation } = completed;
    if (reconciliation.history.status === "fulfilled") {
      setDiceHistory(reconciliation.history.value);
      setDiceCharacterPosition((current) => reconciliation.history.status === "fulfilled"
        && reconciliation.history.value.characters.some((character) => character.position === current)
        ? current : reconciliation.history.status === "fulfilled" ? reconciliation.history.value.characters[0]?.position ?? null : null);
      setDicePhase("ready");
      setDiceError("");
    } else {
      setDiceHistory(null);
      setDicePhase("failed");
      setDiceError("Roll history could not be loaded.");
    }
    const outcome = diceOutcomeMessage(reconciliation);
    setDiceResult(outcome);
    appliedDiceTokenRef.current = completed.token;
    diceFocusIntentRef.current = { campaignId: completed.campaignId, token: completed.token, generation };
    deferCompletionCleanup(completedDiceReconciliations, completed.campaignId, completed.token,
      () => pendingDiceDetailCompletions.get(completed.campaignId) !== completed.token);
    return true;
  }, []);

  const applyCreateReconciliation = useCallback((
    completed: CompletedCreateReconciliation,
    expectedDetailGeneration: number,
    focus = true,
    supersedeCharacterReads = true,
    allowBeforeDetail = false,
    requireStoredToken = true,
  ): boolean => {
    const latest = completedCreateReconciliations.get(completed.campaignId);
    if (!mountedRef.current || activeCampaignRef.current !== completed.campaignId
      || (!allowBeforeDetail && campaignRef.current?.id !== completed.campaignId)
      || generationRef.current !== expectedDetailGeneration
      || (requireStoredToken && latest?.token !== completed.token)) return false;

    // A live operation reconciliation is newer than reads that predate its
    // POST and supersedes them. A completed-operation handoff on reopen is
    // only interim: the fresh GETs started by that reopen keep their
    // generations and must be allowed to become authoritative.
    if (supersedeCharacterReads) {
      invalidateInitialCharacterReads(completed.campaignId);
      rosterGenerationRef.current += 1;
      optionsGenerationRef.current += 1;
    }
    const { reconciliation } = completed;
    if (reconciliation.roster.status === "fulfilled") {
      setRoster(reconciliation.roster.value.characters);
      setRosterPhase("ready");
      setRosterAnnouncement(reconciliation.roster.value.characters.length === 0
        ? "Character roster is empty."
        : `${reconciliation.roster.value.characters.length} ${reconciliation.roster.value.characters.length === 1 ? "character" : "characters"} loaded.`);
    } else {
      setRoster([]);
      setRosterPhase(reconciliation.roster.status === "rejected"
        && reconciliation.roster.reason instanceof ApiError && reconciliation.roster.reason.status === 404 ? "unsupported" : "failed");
      setRosterAnnouncement("");
    }
    if (reconciliation.options.status === "fulfilled") {
      setOptions(reconciliation.options.value);
      setOptionsPhase("ready");
      const selected = reconciliation.options.value.personas.find((persona) => persona.characterId === reconciliation.characterId);
      setSelectedCharacterId(selected && !selected.alreadyUsed ? reconciliation.characterId : null);
    } else {
      setOptions(null);
      setOptionsPhase(reconciliation.options.status === "rejected"
        && reconciliation.options.reason instanceof ApiError && reconciliation.options.reason.status === 404 ? "unsupported" : "failed");
      setSelectedCharacterId(null);
    }
    setCreateConfirmed(false);
    setCreateResult(createOutcomeMessage(reconciliation));
    setCharacterStatusActivity("idle");
    setCreatePhase("idle");
    appliedCreateTokenRef.current = completed.token;
    if (focus) createFocusIntentRef.current = {
      campaignId: completed.campaignId,
      token: completed.token,
      generation: expectedDetailGeneration,
    };
    deferCompletionCleanup(completedCreateReconciliations, completed.campaignId, completed.token);
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    renameLockedRef.current = false;
    setupLockedRef.current = false;
    createLockedRef.current = false;
    diceLockedRef.current = false;
    const activeRoomMutation = inFlightCampaignMutations.get(campaignId)?.kind === "attach-room";
    roomLockedRef.current = activeRoomMutation;
    roomManualReadLockRef.current = null;
    diceManualReadLockRef.current = null;
    setRenamePhase("idle");
    setSetupPhase("idle");
    setSetupChoice(null);
    setSetupConfirmed(false);
    setCreatePhase("idle");
    setCreateResult(null);
    setCharacterStatusActivity("idle");
    setDiceHistory(null);
    setDicePhase("loading");
    setDiceError("");
    setDiceResult(null);
    setRooms(null);
    setRoomsPhase("loading");
    setRoomResult(null);
    setRoomActivity("idle");
    appliedRoomTokenRef.current = null;
    roomFocusIntentRef.current = null;
    if (handedOffRoomRef.current?.campaignId !== campaignId) handedOffRoomRef.current = null;
    diceInitializedCampaignRef.current = null;
    appliedDiceTokenRef.current = null;
    diceFocusIntentRef.current = null;
    appliedCreateTokenRef.current = null;
    createFocusIntentRef.current = null;
    if (setupOptionsRefreshCampaigns.has(campaignId)) {
      hideOptionsForSetupReconciliation(campaignId);
    }
    if (inFlightCampaignMutations.get(campaignId)?.kind === "create") {
      invalidateInitialCharacterReads(campaignId);
    }
    if (handedOffCreateRef.current?.campaignId !== campaignId) {
      handedOffCreateRef.current = null;
      handoffFreshReadsRef.current = null;
    }
    if (pendingPeerCreateRef.current?.campaignId !== campaignId) pendingPeerCreateRef.current = null;
    if (handedOffDiceRef.current?.campaignId !== campaignId) {
      handedOffDiceRef.current = null;
    }
    if (pendingPeerDiceRef.current?.campaignId !== campaignId) pendingPeerDiceRef.current = null;
    if (!handedOffDiceRef.current) {
      handedOffDiceRef.current = completedDiceReconciliations.get(campaignId) ?? null;
    }
    let handoff = handedOffCreateRef.current;
    let requireStoredToken = false;
    if (!handoff) {
      handoff = completedCreateReconciliations.get(campaignId) ?? null;
      handedOffCreateRef.current = handoff;
      requireStoredToken = true;
    }
    if (handoff) {
      applyCreateReconciliation(handoff, generationRef.current, false, false, true, requireStoredToken);
    }
    const detailLoad = load(true, focusHeadingRequestRef.current);
    if (!handedOffRoomRef.current) handedOffRoomRef.current = completedRoomReconciliations.get(campaignId) ?? null;
    if (handedOffRoomRef.current) applyRoomReconciliation(handedOffRoomRef.current, generationRef.current);
    // Reuse only the same in-flight request across StrictMode effect replay;
    // the cache evicts immediately on settlement, so this remains a fresh GET.
    // A reopened page observing an active attach must wait for that token's
    // listener reconciliation. Starting (or reusing) an initial GET here can
    // only represent pre-PUT state and creates an avoidable stale overwrite.
    if (!activeRoomMutation) void loadRooms(roomsRefreshRequest !== undefined, true, roomsRefreshRequest);
    if (handoff) {
      // The completed operation is only an interim handoff. Reopen owns one
      // new authoritative pair (shared across StrictMode effect replay) and
      // recomputes the outcome from that pair rather than leaving stale proof.
      if (handoffFreshReadsRef.current?.token !== handoff.token) {
        handoffFreshReadsRef.current = {
          token: handoff.token,
          promise: Promise.allSettled([
            listCampaignCharacters(campaignId),
            getCampaignCharacterCreationOptions(campaignId),
          ]),
        };
      }
      const rosterGeneration = ++rosterGenerationRef.current;
      const optionsGeneration = ++optionsGenerationRef.current;
      setCharacterStatusActivity("reconciling");
      const freshReads = handoffFreshReadsRef.current.promise;
      void Promise.all([detailLoad, freshReads]).then(([detailGeneration, [roster, freshOptions]]) => {
        if (detailGeneration === null || !mountedRef.current || activeCampaignRef.current !== campaignId
          || generationRef.current !== detailGeneration || rosterGenerationRef.current !== rosterGeneration
          || optionsGenerationRef.current !== optionsGeneration
          || handedOffCreateRef.current?.token !== handoff.token) return;
        applyCreateReconciliation({
          ...handoff,
          reconciliation: { ...handoff.reconciliation, roster, options: freshOptions },
        }, detailGeneration, true, false, false, false);
      });
    } else {
      void loadRoster(false, true);
      if (!setupOptionsRefreshCampaigns.has(campaignId)) void loadOptions(false, true);
    }
    return () => {
      mountedRef.current = false;
      renameLockedRef.current = false;
      setupLockedRef.current = false;
      createLockedRef.current = false;
      diceLockedRef.current = false;
      roomLockedRef.current = false;
      roomManualReadLockRef.current = null;
      diceManualReadLockRef.current = null;
      generationRef.current += 1;
      rosterGenerationRef.current += 1;
      optionsGenerationRef.current += 1;
      diceGenerationRef.current += 1;
      roomsGenerationRef.current += 1;
      rosterRetryFocusIntentRef.current = null;
      optionsRetryFocusIntentRef.current = null;
      createFocusIntentRef.current = null;
      diceFocusIntentRef.current = null;
      roomFocusIntentRef.current = null;
      detailFocusIntentRef.current = null;
      if (inFlightCampaignMutations.get(campaignId)?.kind === "create") {
        invalidateInitialCharacterReads(campaignId);
      }
    };
  // A refresh token is request-scoped state, not page identity. The dedicated
  // effect below consumes later tokens; acknowledging one must not tear down
  // and reload the entire campaign detail page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyCreateReconciliation, applyRoomReconciliation, campaignId, hideOptionsForSetupReconciliation, load, loadOptions, loadRoster, loadRooms]);

  useEffect(() => {
    const authorized = mechanicsEnabled && campaign
      && (campaign.actorRole === "owner" || campaign.actorRole === "gm");
    if (!authorized || loading || diceInitializedCampaignRef.current === campaignId) return;
    diceInitializedCampaignRef.current = campaignId;
    const handoff = handedOffDiceRef.current;
    if (handoff?.campaignId === campaignId) {
      handedOffDiceRef.current = null;
      if (applyDiceReconciliation(handoff, generationRef.current)
        && pendingDiceDetailCompletions.get(campaignId) === handoff.token) {
        pendingDiceDetailCompletions.delete(campaignId);
      }
      return;
    }
    if (inFlightCampaignMutations.get(campaignId)?.kind !== "dice") {
      void loadDice(false, true);
    }
  }, [applyDiceReconciliation, campaign, campaignId, loadDice, loading, mechanicsEnabled]);

  useEffect(() => {
    const intent = detailFocusIntentRef.current;
    if (loading || !campaign || !intent || intent.campaignId !== campaignId
      || intent.generation !== generationRef.current || intent.request !== focusHeadingRequest) return;
    detailFocusIntentRef.current = null;
    queueMicrotask(() => {
      if (!mountedRef.current || activeCampaignRef.current !== intent.campaignId
        || generationRef.current !== intent.generation || focusHeadingRequest !== intent.request) return;
      const heading = detailHeadingRef.current;
      heading?.focus();
      if (!heading || document.activeElement !== heading) return;
      focusedHeadingRequestRef.current = intent.request;
      onHeadingFocusedRef.current(intent.request);
    });
  }, [campaign, campaignId, focusHeadingRequest, loading]);

  useEffect(() => {
    let observed = inFlightCampaignMutations.get(campaignId);
    setSharedMutationPending(Boolean(observed));
    const listener = (changedCampaignId: string, mutation: CampaignMutation, active: boolean) => {
      if (changedCampaignId !== campaignId) return;
      const next = active ? mutation : undefined;
      setSharedMutationPending(Boolean(next));
      if (observed && !next) {
        const ownership = ownedMutationsRef.current.get(mutation.token);
        const handlerWillApply = ownership?.campaignId === campaignId
          && ownership.generation === generationRef.current
          && activeCampaignRef.current === campaignId;
        if (!handlerWillApply) {
          if (mutation.kind === "dice") {
            // Completion is newer than every pre-roll history projection, but
            // it cannot be rendered until this peer's exact detail is ready.
            // Invalidate synchronously and retain the token at module scope so
            // unmount/reopen cannot consume or clean it prematurely.
            initialDiceReads.delete(campaignId);
            diceGenerationRef.current += 1;
            diceInitializedCampaignRef.current = campaignId;
            diceManualReadLockRef.current = null;
            setDiceHistory(null);
            setDicePhase("loading");
            setDiceError("");
            const completed = completedDiceReconciliations.get(campaignId);
            if (completed?.token === mutation.token) {
              pendingPeerDiceRef.current = completed;
              pendingDiceDetailCompletions.set(campaignId, completed.token);
              if (campaignRef.current?.id === campaignId
                && applyDiceReconciliation(completed, generationRef.current)) {
                pendingPeerDiceRef.current = null;
                if (pendingDiceDetailCompletions.get(campaignId) === completed.token) {
                  pendingDiceDetailCompletions.delete(campaignId);
                }
              }
            }
            diceLockedRef.current = false;
          } else if (mutation.kind === "create") {
            // The completed pair supersedes every active pre-create roster and
            // options read immediately, even when this peer's detail is still
            // pending and applyCreateReconciliation cannot render it yet.
            invalidateInitialCharacterReads(campaignId);
            rosterGenerationRef.current += 1;
            optionsGenerationRef.current += 1;
            rosterRetryFocusIntentRef.current = null;
            optionsRetryFocusIntentRef.current = null;
            setRoster([]);
            setRosterPhase("loading");
            setOptions(null);
            setOptionsPhase("loading");
            setSelectedCharacterId(null);
            setCreateConfirmed(false);
            const completed = completedCreateReconciliations.get(campaignId);
            if (completed?.token === mutation.token) {
              pendingPeerCreateRef.current = completed;
              if (applyCreateReconciliation(completed, generationRef.current, true, false, false, false)) {
                pendingPeerCreateRef.current = null;
              }
            }
            createLockedRef.current = false;
          } else if (mutation.kind === "attach-room") {
            const completed = completedRoomReconciliations.get(campaignId);
            if (completed?.token === mutation.token) applyRoomReconciliation(completed, generationRef.current);
            roomLockedRef.current = false;
          } else if (mutation.kind === "setup" && mutation.setupReconciliation) {
            // The issuing action already performed the operation's one fresh
            // authoritative detail GET. Every mounted peer consumes that same
            // reconciliation instead of issuing a competing second GET.
            setupLockedRef.current = true;
            setSetupPhase("reconciling");
            applySetupReconciliation(mutation.setupReconciliation, campaignId, generationRef.current);
            setupLockedRef.current = false;
            setSetupPhase("idle");
          } else {
            if (mutation.kind === "rename") {
              renameLockedRef.current = true;
              setRenamePhase("reconciling");
            } else {
              setupLockedRef.current = true;
              setSetupPhase("reconciling");
            }
            const reconciliationGeneration = generationRef.current + 1;
            if (mutation.kind === "setup") {
              requirePostSetupOptionsRefresh(campaignId);
            }
            void load(false).then((generation) => {
              if (generation === null) return;
              mutationFocusAfterReconciliationRef.current = {
                kind: mutation.kind === "rename" ? "rename" : "setup",
                generation,
              };
            }).finally(() => {
              if (!mountedRef.current || reconciliationGeneration !== generationRef.current) return;
              if (mutation.kind === "rename") {
                renameLockedRef.current = false;
                setRenamePhase("idle");
              } else {
                setupLockedRef.current = false;
                setSetupPhase("idle");
                setSetupConfirmed(false);
              }
            });
          }
        }
      }
      observed = next;
    };
    mutationListeners.add(listener);
    return () => { mutationListeners.delete(listener); };
  }, [applyCreateReconciliation, applyDiceReconciliation, applyRoomReconciliation, applySetupReconciliation, campaignId, load, requirePostSetupOptionsRefresh]);

  useEffect(() => {
    const pending = pendingPeerDiceRef.current;
    if (loading || !campaign || campaign.id !== campaignId || pending?.campaignId !== campaignId) return;
    if (applyDiceReconciliation(pending, generationRef.current)) {
      pendingPeerDiceRef.current = null;
      if (pendingDiceDetailCompletions.get(campaignId) === pending.token) {
        pendingDiceDetailCompletions.delete(campaignId);
      }
    }
  }, [applyDiceReconciliation, campaign, campaignId, loading]);

  useEffect(() => {
    const pending = pendingPeerCreateRef.current;
    if (loading || !campaign || campaign.id !== campaignId || pending?.campaignId !== campaignId) return;
    // Generations/cache were already invalidated synchronously by the listener.
    // Apply this retained token exactly once when its matching detail exists.
    if (applyCreateReconciliation(pending, generationRef.current, true, false, false, false)) {
      pendingPeerCreateRef.current = null;
    }
  }, [applyCreateReconciliation, campaign, campaignId, loading]);

  useEffect(() => {
    if (loading || !campaign || campaign.id !== campaignId
      || !setupOptionsRefreshCampaigns.has(campaignId)
      || !isOriginalStarterConfigured(campaign)) return;
    // Consume only when this current exact-configured detail success actually
    // starts the uncached options request.
    setupOptionsRefreshCampaigns.delete(campaignId);
    invalidateInitialOptionsRead(campaignId);
    void loadOptions(false, false);
  }, [campaign, campaignId, loadOptions, loading]);

  useEffect(() => {
    const intent = createFocusIntentRef.current;
    if (!createResult || !intent || intent.campaignId !== campaignId
      || intent.token !== appliedCreateTokenRef.current || intent.generation !== generationRef.current) return;
    createFocusIntentRef.current = null;
    queueMicrotask(() => {
      if (!mountedRef.current || activeCampaignRef.current !== intent.campaignId
        || generationRef.current !== intent.generation || appliedCreateTokenRef.current !== intent.token) return;
      createStatusRef.current?.focus();
    });
  }, [campaignId, createResult]);

  useEffect(() => {
    const intent = diceFocusIntentRef.current;
    if (!diceResult || !intent || intent.campaignId !== campaignId
        || intent.token !== appliedDiceTokenRef.current || intent.generation !== generationRef.current) return;
    diceFocusIntentRef.current = null;
    queueMicrotask(() => {
      if (mountedRef.current && activeCampaignRef.current === intent.campaignId
          && generationRef.current === intent.generation && appliedDiceTokenRef.current === intent.token) {
        diceStatusRef.current?.focus();
      }
    });
  }, [campaignId, diceResult]);

  useEffect(() => {
    const intent = roomFocusIntentRef.current;
    if (!intent || intent.campaignId !== campaignId || intent.generation !== generationRef.current) return;
    // The independent rooms GET may beat detail; retain the intent until the
    // section actually exists instead of consuming focus against a null ref.
    if (loading || !campaign) return;
    if (intent.token && intent.token !== appliedRoomTokenRef.current) return;
    if (intent.token && !roomResult) return;
    if (!intent.token && roomsPhase === "loading") return;
    roomFocusIntentRef.current = null;
    queueMicrotask(() => {
      if (!mountedRef.current || activeCampaignRef.current !== intent.campaignId
        || generationRef.current !== intent.generation) return;
      const target = intent.token
        ? roomStatusRef.current
        : roomsPhase === "ready" ? roomsHeadingRef.current : roomsRetryRef.current;
      target?.focus();
    });
  }, [campaign, campaignId, loading, roomResult, roomsPhase]);

  useEffect(() => {
    if (!completedRoomsRefresh || loading || !campaign
      || acknowledgedRoomsRefreshRequestRef.current === completedRoomsRefresh.request) return;
    const target = completedRoomsRefresh.succeeded ? roomsHeadingRef.current : roomsRetryRef.current;
    target?.focus();
    if (!target || document.activeElement !== target) return;
    acknowledgedRoomsRefreshRequestRef.current = completedRoomsRefresh.request;
    onRoomsRefreshHandledRef.current(completedRoomsRefresh.request);
    queueMicrotask(() => {
      if (mountedRef.current && activeCampaignRef.current === campaignId) {
        (completedRoomsRefresh.succeeded ? roomsHeadingRef.current : roomsRetryRef.current)?.focus();
      }
    });
  }, [campaign, completedRoomsRefresh, loading]);

  useEffect(() => {
    if (!roomOpenFailure || focusedRoomOpenFailureRef.current === roomOpenFailure.request) return;
    // A missing-room failure owns a rooms refresh/focus request. Do not let
    // its earlier alert-focus microtask steal focus back after that request.
    if (roomsRefreshRequest !== undefined) {
      focusedRoomOpenFailureRef.current = roomOpenFailure.request;
      return;
    }
    focusedRoomOpenFailureRef.current = roomOpenFailure.request;
    queueMicrotask(() => {
      if (mountedRef.current && activeCampaignRef.current === campaignId) roomOpenStatusRef.current?.focus();
    });
  }, [campaignId, roomOpenFailure, roomsRefreshRequest]);

  useEffect(() => {
    if (roomsRefreshRequest === undefined || handledRoomsRefreshRequestRef.current === roomsRefreshRequest) return;
    void loadRooms(true, false, roomsRefreshRequest);
  }, [campaignId, loadRooms, roomsRefreshRequest, sharedMutationPending]);

  useEffect(() => {
    const pending = mutationFocusAfterReconciliationRef.current;
    if (!pending || loading || pending.generation !== generationRef.current
      || renamePhase !== "idle" || setupPhase !== "idle") return;
    mutationFocusAfterReconciliationRef.current = null;
    if (pending.kind === "rename") renameInputRef.current?.focus();
    else if (configuredStatusRef.current) configuredStatusRef.current.focus();
    else setupConfirmationRef.current?.focus();
  }, [campaign, loading, renamePhase, setupPhase]);

  useEffect(() => {
    const intent = rosterRetryFocusIntentRef.current;
    if (intent?.campaignId === campaignId && intent.generation === rosterGenerationRef.current
      && ((rosterPhase === "ready" && intent.outcome === "success")
        || (rosterPhase === "failed" && intent.outcome === "failure"))) {
      rosterRetryFocusIntentRef.current = null;
      queueMicrotask(() => {
        if (!mountedRef.current || activeCampaignRef.current !== intent.campaignId
          || rosterGenerationRef.current !== intent.generation) return;
        if (intent.outcome === "success") rosterHeadingRef.current?.focus();
        else rosterRetryRef.current?.focus();
      });
    }
  }, [campaignId, rosterPhase]);

  useEffect(() => {
    const intent = optionsRetryFocusIntentRef.current;
    if (intent?.campaignId === campaignId && intent.generation === optionsGenerationRef.current
      && ((optionsPhase === "ready" && intent.outcome === "success")
        || ((optionsPhase === "failed" || optionsPhase === "unsupported") && intent.outcome === "failure"))) {
      optionsRetryFocusIntentRef.current = null;
      queueMicrotask(() => {
        if (!mountedRef.current || activeCampaignRef.current !== intent.campaignId
          || optionsGenerationRef.current !== intent.generation) return;
        if (intent.outcome === "success") {
          if (optionsHeadingRef.current) optionsHeadingRef.current.focus();
          else firstPersonaChoiceRef.current?.focus();
        } else {
          optionsRetryRef.current?.focus();
        }
      });
    }
  }, [campaignId, optionsPhase]);

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // State updates are asynchronous, so the ref is the actual duplicate-write lock.
    if (!campaign || campaign.actorRole !== "owner" || renameLockedRef.current || setupLockedRef.current || createLockedRef.current || diceLockedRef.current
      || inFlightCampaignMutations.has(campaignId)) return;

    const parsed = campaignRenameRequestSchema.safeParse({ name: draft, expectedUpdatedAt: campaign.updatedAt });
    if (!parsed.success) {
      setRenameError("Enter a campaign name between 1 and 200 characters.");
      setAnnouncement("");
      renameInputRef.current?.focus();
      return;
    }

    renameLockedRef.current = true;
    const generation = ++generationRef.current;
    const mutation = beginCampaignMutation(campaignId, "rename");
    if (!mutation) {
      renameLockedRef.current = false;
      return;
    }
    ownedMutationsRef.current.set(mutation.token, { campaignId, generation });
    const requestedName = parsed.data.name;
    setRenamePhase("writing");
    setRenameError("");
    setAnnouncement("");

    try {
      const response = await renameCampaign(campaignId, parsed.data);
      if (!mountedRef.current || generation !== generationRef.current) return;

      // The PATCH result is authoritative for the mutation's minimal fields.
      setCampaign((current) => current?.id === response.campaign.id
        ? { ...current, name: response.campaign.name, updatedAt: response.campaign.updatedAt }
        : current);
      setDraft(response.campaign.name);
      setRenamePhase("reconciling");

      try {
        const refreshed = await getCampaignDetail(campaignId);
        if (!mountedRef.current || generation !== generationRef.current) return;
        setCampaign(refreshed.campaign);
        setDraft(refreshed.campaign.name);
        if (refreshed.campaign.name === requestedName) {
          setAnnouncement(`Campaign renamed to “${requestedName}”.`);
        } else {
          setAnnouncement(`Campaign was renamed, then changed elsewhere to “${refreshed.campaign.name}”.`);
        }
      } catch (refreshError) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        if (refreshError instanceof ApiError && refreshError.status === 404) {
          unavailableRef.current();
          return;
        }
        setAnnouncement(`Campaign renamed to “${requestedName}”, but the latest details could not be refreshed.`);
      }
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (error instanceof ApiError && error.status === 404) {
        unavailableRef.current();
        return;
      }
      if (error instanceof ApiError && (error.status === 400 || error.status === 415)) {
        setRenameError("The campaign name was rejected. Check it and try again.");
        return;
      }

      // A stale response is known not to have written. Internal, malformed,
      // and network failures are ambiguous, so reconcile with one GET and
      // never repeat the PATCH.
      const stale = error instanceof ApiError && error.status === 409;
      setRenamePhase("reconciling");
      try {
        const refreshed = await getCampaignDetail(campaignId);
        if (!mountedRef.current || generation !== generationRef.current) return;
        setCampaign(refreshed.campaign);
        setDraft(requestedName);
        if (stale) {
          setRenameError("This campaign changed elsewhere. Latest details are shown; your name draft was kept.");
        } else {
          // A GET can reveal current state but cannot attribute a matching name
          // or timestamp to this failed PATCH (names are not unique).
          setRenameError(refreshed.campaign.name === requestedName
            ? `The requested name is currently “${requestedName}”, but this rename write could not be confirmed. Your draft was kept.`
            : `The rename write could not be confirmed. The current name is “${refreshed.campaign.name}”; your draft was kept.`);
        }
      } catch (refreshError) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        if (refreshError instanceof ApiError && refreshError.status === 404) {
          unavailableRef.current();
          return;
        }
        setRenameError(stale
          ? "This campaign changed elsewhere, but the latest details could not be loaded. Your name draft was kept."
          : "The rename outcome could not be confirmed. Refresh the campaign before trying again; your name draft was kept.");
      }
    } finally {
      finishCampaignMutation(campaignId, mutation);
      ownedMutationsRef.current.delete(mutation.token);
      if (mountedRef.current && generation === generationRef.current) {
        renameLockedRef.current = false;
        setRenamePhase("idle");
        focusRename(generation);
      }
    }
  }

  async function setupStarter() {
    // React state cannot synchronously serialize clicks, so the ref owns the lock.
    if (!campaign || campaign.actorRole !== "owner" || campaign.content.status !== "unconfigured"
      || !setupChoice || (setupChoice === "mechanics" && !mechanicsEnabled)
      || !setupConfirmed || setupLockedRef.current || renameLockedRef.current || createLockedRef.current || diceLockedRef.current
      || inFlightCampaignMutations.has(campaignId)) return;

    const operationCampaignId = campaignId;
    const choice = setupChoice;
    setupLockedRef.current = true;
    const generation = ++generationRef.current;
    const mutation = beginCampaignMutation(operationCampaignId, "setup");
    if (!mutation) {
      setupLockedRef.current = false;
      return;
    }
    ownedMutationsRef.current.set(mutation.token, { campaignId: operationCampaignId, generation });
    setSetupPhase("writing");
    setSetupError("");
    setAnnouncement("");

    let put: PromiseSettledResult<CampaignDetailResponse>;
    try {
      put = { status: "fulfilled", value: choice === "mechanics"
        ? await setupMechanicsStarter(operationCampaignId)
        : await setupOriginalStarter(operationCampaignId) };
    } catch (reason) {
      put = { status: "rejected", reason };
    }
    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
      && generationRef.current === generation) {
      setSetupPhase("reconciling");
    }
    // Every issued PUT, including every HTTP/network/schema outcome, owns one
    // and only one fresh campaign detail GET. No branch repeats the PUT.
    let detail: PromiseSettledResult<CampaignDetailResponse>;
    try {
      detail = { status: "fulfilled", value: await getCampaignDetail(operationCampaignId) };
    } catch (reason) {
      detail = { status: "rejected", reason };
    }
    const reconciliation = { choice, put, detail } satisfies SetupReconciliation;
    mutation.setupReconciliation = reconciliation;
    let settledGeneration = generation;
    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
      && generationRef.current === generation) {
      if (applySetupReconciliation(reconciliation, operationCampaignId, generation)) {
        settledGeneration = generationRef.current;
        // finish() broadcasts synchronously. Mark this owner as current so its
        // listener does not consume and apply the same reconciliation twice.
        ownedMutationsRef.current.set(mutation.token, {
          campaignId: operationCampaignId,
          generation: settledGeneration,
        });
      }
    }
    finishCampaignMutation(operationCampaignId, mutation);
    ownedMutationsRef.current.delete(mutation.token);
    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
      && settledGeneration === generationRef.current) {
      setupLockedRef.current = false;
      setSetupPhase("idle");
      queueMicrotask(() => {
        if (!mountedRef.current || settledGeneration !== generationRef.current) return;
        if (configuredStatusRef.current) configuredStatusRef.current.focus();
        else setupConfirmationRef.current?.focus();
      });
    }
  }

  async function createCharacter() {
    const operationCampaignId = campaignId;
    const selected = options?.personas.find((persona) => persona.characterId === selectedCharacterId);
    if (!campaign || !isOriginalStarterConfigured(campaign) || optionsPhase !== "ready"
      || !selected || selected.alreadyUsed || !createConfirmed || createLockedRef.current
      || renameLockedRef.current || setupLockedRef.current || diceLockedRef.current || inFlightCampaignMutations.has(campaignId)) return;

    createLockedRef.current = true;
    const generation = ++generationRef.current;
    const mutation = beginCampaignMutation(campaignId, "create");
    if (!mutation) {
      createLockedRef.current = false;
      return;
    }
    ownedMutationsRef.current.set(mutation.token, { campaignId, generation });
    completedCreateReconciliations.delete(operationCampaignId);
    appliedCreateTokenRef.current = null;
    invalidateInitialCharacterReads(operationCampaignId);
    // Cancel only this currently displayed campaign's pre-create reads. No
    // later operation step mutates whatever campaign happens to be displayed.
    rosterGenerationRef.current += 1;
    optionsGenerationRef.current += 1;
    setCreatePhase("writing");
    setCreateResult(null);
    setCreateConfirmed(false);
    setCharacterStatusActivity("idle");

    let post: PromiseSettledResult<CampaignCharacterCreateResponse>;
    try {
      post = { status: "fulfilled", value: await createOriginalStarterCampaignCharacter(operationCampaignId, { characterId: selected.characterId }) };
    } catch (reason) {
      post = { status: "rejected", reason };
    }

    // Confirmation is single-use for every issued POST, whatever its outcome.
    if (mountedRef.current && generation === generationRef.current && activeCampaignRef.current === operationCampaignId
      && campaignRef.current?.id === operationCampaignId
      && inFlightCampaignMutations.get(operationCampaignId)?.token === mutation.token) {
      setCreateConfirmed(false);
      setCreatePhase("reconciling");
      setCharacterStatusActivity("reconciling");
      setRosterPhase("loading");
    }
    // These are exactly one fresh roster GET and one fresh options GET. They
    // deliberately bypass StrictMode caches and run concurrently. No branch
    // above or below retries the non-idempotent POST.
    const [roster, freshOptions] = await Promise.allSettled([
      listCampaignCharacters(operationCampaignId),
      getCampaignCharacterCreationOptions(operationCampaignId),
    ]);
    const reconciliation: CreateReconciliation = {
      characterId: selected.characterId,
      post,
      roster,
      options: freshOptions,
    };
    mutation.createReconciliation = reconciliation;
    const completed: CompletedCreateReconciliation = {
      campaignId: operationCampaignId,
      token: mutation.token,
      reconciliation,
    };
    completedCreateReconciliations.set(operationCampaignId, completed);
    invalidateInitialCharacterReads(operationCampaignId);

    if (mountedRef.current && generation === generationRef.current
      && activeCampaignRef.current === operationCampaignId) {
      applyCreateReconciliation(completed, generation);
    }
    finishCampaignMutation(operationCampaignId, mutation);
    ownedMutationsRef.current.delete(mutation.token);
    if (mountedRef.current && generation === generationRef.current && activeCampaignRef.current === operationCampaignId) {
      createLockedRef.current = false;
      setCreatePhase("idle");
    }
  }

  async function refreshCharacterStatus() {
    if (createLockedRef.current || renameLockedRef.current || setupLockedRef.current || diceLockedRef.current
      || inFlightCampaignMutations.has(campaignId)) return;
    const requestedCampaignId = campaignId;
    const rosterGeneration = ++rosterGenerationRef.current;
    const optionsGeneration = ++optionsGenerationRef.current;
    const previousSelection = selectedCharacterId;
    setRosterPhase("loading");
    setCharacterStatusActivity("refreshing");
    const [freshRoster, freshOptions] = await Promise.allSettled([
      listCampaignCharacters(requestedCampaignId),
      getCampaignCharacterCreationOptions(requestedCampaignId),
    ]);
    if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
      || rosterGenerationRef.current !== rosterGeneration || optionsGenerationRef.current !== optionsGeneration) return;

    if (freshRoster.status === "fulfilled") {
      setRoster(freshRoster.value.characters);
      setRosterPhase("ready");
      setRosterAnnouncement(freshRoster.value.characters.length === 0
        ? "Character roster is empty."
        : `${freshRoster.value.characters.length} ${freshRoster.value.characters.length === 1 ? "character" : "characters"} loaded.`);
    } else {
      setRoster([]);
      setRosterPhase(freshRoster.reason instanceof ApiError && freshRoster.reason.status === 404 ? "unsupported" : "failed");
    }
    if (freshOptions.status === "fulfilled") {
      setOptions(freshOptions.value);
      setOptionsPhase("ready");
      const stillUnused = freshOptions.value.personas.some((persona) => persona.characterId === previousSelection && !persona.alreadyUsed);
      setSelectedCharacterId(stillUnused ? previousSelection : null);
    } else {
      setOptions(null);
      setOptionsPhase(freshOptions.reason instanceof ApiError && freshOptions.reason.status === 404 ? "unsupported" : "failed");
      setSelectedCharacterId(null);
    }
    setCreateConfirmed(false);
    setCreateResult(freshRoster.status === "fulfilled" && freshOptions.status === "fulfilled"
      ? { text: "Character status refreshed from the authoritative roster and creation options.", alert: false }
      : { text: "Character status refresh was partial or unavailable. No create request was made.", alert: true });
    setCharacterStatusActivity("idle");
    queueMicrotask(() => {
      if (mountedRef.current && activeCampaignRef.current === requestedCampaignId
        && rosterGenerationRef.current === rosterGeneration && optionsGenerationRef.current === optionsGeneration) {
        createStatusRef.current?.focus();
      }
    });
  }

  async function refreshDiceRolls() {
    const priorOutcome = diceResult;
    if (!priorOutcome || dicePhase === "loading" || diceBusy || renameLockedRef.current
      || setupLockedRef.current || createLockedRef.current || diceLockedRef.current
      || diceManualReadLockRef.current || inFlightCampaignMutations.has(campaignId)) return;
    const manualReadToken = Symbol("manual dice history refresh");
    diceManualReadLockRef.current = manualReadToken;
    const requestedCampaignId = campaignId;
    const generation = ++diceGenerationRef.current;
    setDicePhase("loading");
    setDiceError("");
    try {
      const response = await getCampaignDiceHistory(requestedCampaignId);
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || diceGenerationRef.current !== generation) return;
      setDiceHistory(response);
      setDiceCharacterPosition((current) => response.characters.some((character) => character.position === current)
        ? current : response.characters[0]?.position ?? null);
      setDicePhase("ready");
      setDiceResult(refreshedDiceOutcome(priorOutcome.kind, true));
    } catch {
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || diceGenerationRef.current !== generation) return;
      setDiceHistory(null);
      setDicePhase("failed");
      setDiceError("Roll history could not be loaded.");
      setDiceResult(refreshedDiceOutcome(priorOutcome.kind, false));
    } finally {
      if (diceManualReadLockRef.current === manualReadToken) diceManualReadLockRef.current = null;
    }
    queueMicrotask(() => {
      if (mountedRef.current && activeCampaignRef.current === requestedCampaignId
        && diceGenerationRef.current === generation) diceStatusRef.current?.focus();
    });
  }

  async function attachRoom(room: CampaignRoomSummary) {
    const operationCampaignId = campaignId;
    if (!campaign || campaign.actorRole !== "owner" || roomLockedRef.current
      || roomManualReadLockRef.current || roomActivity !== "idle"
      || inFlightCampaignMutations.has(operationCampaignId)) return;
    roomLockedRef.current = true;
    // Acquisition synchronously supersedes all pre-PUT room reads and prevents
    // a cached StrictMode/reopen request from being reused during the write.
    roomsGenerationRef.current += 1;
    initialRoomReads.delete(operationCampaignId);
    const generation = ++generationRef.current;
    const mutation = beginCampaignMutation(operationCampaignId, "attach-room");
    if (!mutation) { roomLockedRef.current = false; return; }
    ownedMutationsRef.current.set(mutation.token, { campaignId: operationCampaignId, generation });
    completedRoomReconciliations.delete(operationCampaignId);
    setRoomResult(null);
    setRoomActivity("writing");
    let put: PromiseSettledResult<CampaignRoomAttachResponse>;
    try {
      put = { status: "fulfilled", value: await attachCampaignRoom(operationCampaignId, { sessionId: room.sessionId }) };
    } catch (reason) {
      put = { status: "rejected", reason };
    }
    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
      && generationRef.current === generation) setRoomActivity("reconciling");
    // Every issued PUT owns exactly one fresh GET, regardless of its outcome.
    let freshRooms: PromiseSettledResult<CampaignRoomLinkingResponse>;
    try {
      freshRooms = { status: "fulfilled", value: await listCampaignRooms(operationCampaignId) };
    } catch (reason) {
      freshRooms = { status: "rejected", reason };
    }
    const reconciliation = { sessionId: room.sessionId, put, rooms: freshRooms } satisfies RoomReconciliation;
    mutation.roomReconciliation = reconciliation;
    const completed = { campaignId: operationCampaignId, token: mutation.token, reconciliation };
    completedRoomReconciliations.set(operationCampaignId, completed);
    initialRoomReads.delete(operationCampaignId);
    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
      && generationRef.current === generation) applyRoomReconciliation(completed, generation);
    finishCampaignMutation(operationCampaignId, mutation);
    ownedMutationsRef.current.delete(mutation.token);
    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
      && generationRef.current === generation) roomLockedRef.current = false;
  }

  function refreshRooms() {
    if (roomLockedRef.current || inFlightCampaignMutations.has(campaignId)) return;
    void loadRooms(true, false);
  }

  async function submitDice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const operationCampaignId = campaignId;
    const character = diceHistory?.characters.find((entry) => entry.position === diceCharacterPosition);
    if (!mechanicsEnabled || !campaign || (campaign.actorRole !== "owner" && campaign.actorRole !== "gm")
        || dicePhase !== "ready" || !character || diceLockedRef.current || renameLockedRef.current
        || setupLockedRef.current || createLockedRef.current || inFlightCampaignMutations.has(operationCampaignId)) return;

    const parsed = campaignDiceRollRequestSchema.safeParse({ character, expression: diceExpression });
    if (!parsed.success) {
      setDiceError("Use canonical dice notation, for example 1d20, 2d6+3, 4d6kh3, 1d20adv, or 1d20dis. Maximums are 100 dice, 1,000 sides, and a modifier of 1,000.");
      setDiceResult(null);
      diceExpressionRef.current?.focus();
      return;
    }

    diceLockedRef.current = true;
    const generation = ++generationRef.current;
    const mutation = beginCampaignMutation(operationCampaignId, "dice");
    if (!mutation) {
      diceLockedRef.current = false;
      return;
    }
    ownedMutationsRef.current.set(mutation.token, { campaignId: operationCampaignId, generation });
    completedDiceReconciliations.delete(operationCampaignId);
    appliedDiceTokenRef.current = null;
    setDicePhase("writing");
    setDiceError("");
    setDiceResult(null);

    let post: PromiseSettledResult<CampaignDiceRollResponse>;
    try {
      post = { status: "fulfilled", value: await rollCampaignDice(operationCampaignId, parsed.data) };
    } catch (reason) {
      post = { status: "rejected", reason };
    }

    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
        && generationRef.current === generation && inFlightCampaignMutations.get(operationCampaignId)?.token === mutation.token) {
      setDicePhase("reconciling");
    }
    // Every issued POST outcome owns exactly one uncached reconciliation GET.
    // It runs for valid, malformed, network, and every HTTP error response.
    let history: PromiseSettledResult<CampaignDiceHistoryResponse>;
    try {
      history = { status: "fulfilled", value: await getCampaignDiceHistory(operationCampaignId) };
    } catch (reason) {
      history = { status: "rejected", reason };
    }
    const reconciliation = { post, history } satisfies DiceReconciliation;
    mutation.diceReconciliation = reconciliation;
    const completed = { campaignId: operationCampaignId, token: mutation.token, reconciliation };
    completedDiceReconciliations.set(operationCampaignId, completed);
    initialDiceReads.delete(operationCampaignId);

    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
        && generationRef.current === generation) {
      applyDiceReconciliation(completed, generation);
    }
    finishCampaignMutation(operationCampaignId, mutation);
    ownedMutationsRef.current.delete(mutation.token);
    if (mountedRef.current && activeCampaignRef.current === operationCampaignId
        && generationRef.current === generation) diceLockedRef.current = false;
  }

  const renameBusy = renamePhase !== "idle";
  const setupBusy = setupPhase !== "idle";
  const createBusy = createPhase !== "idle";
  const diceBusy = dicePhase === "writing" || dicePhase === "reconciling";
  const roomBusy = roomActivity === "writing" || roomActivity === "reconciling";
  const pageBusy = renameBusy || setupBusy || createBusy || diceBusy || roomBusy || sharedMutationPending || roomOpenPending;
  return <main className="page library-page campaign-page"><section className="campaign-shell" aria-labelledby="campaign-detail-heading">
    <header className="library-header"><div><button className="back-link" disabled={pageBusy && !roomOpenPending} onClick={() => { if (!pageBusy || roomOpenPending) onBack(); }}>← Campaigns</button><p className="eyebrow">TRUSTED LOCAL CAMPAIGN</p><h1 ref={detailHeadingRef} tabIndex={-1} className="title" id="campaign-detail-heading">{campaign?.name ?? "Campaign detail"}</h1></div>{campaign && <div className="button-row">{onOpenCombat && <button ref={combatButtonRef} className="primary" disabled={pageBusy} onClick={onOpenCombat}>Open combat tracker</button>}<button className="ghost" disabled={pageBusy} onClick={() => onOpenAdministration(campaign.name)}>Administration</button></div>}</header>
    <section className="library-panel campaign-detail-panel" aria-busy={loading}>
      {loading && <p className="empty-state" role="status">Loading campaign…</p>}
      {!loading && failed && <div className="empty-state large" role="alert"><p>Campaign could not be loaded.</p><button className="ghost" onClick={() => void load()}>Retry</button></div>}
      {!loading && campaign && <>
        {campaign.actorRole === "owner" && <form className="campaign-rename" onSubmit={(event) => void submitRename(event)} aria-busy={pageBusy}>
          <div><label htmlFor="campaign-rename-name">Campaign name</label><input ref={renameInputRef} id="campaign-rename-name" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={200} required disabled={pageBusy} /></div>
          <button className="primary" type="submit" disabled={pageBusy}>{renamePhase === "writing" ? "Renaming…" : renamePhase === "reconciling" ? "Refreshing…" : "Rename campaign"}</button>
          {renameError && <p className="form-error" role="alert">{renameError}</p>}
        </form>}
        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
        <dl className="campaign-detail-list">
          <div><dt>Role</dt><dd>{displayRole(campaign.actorRole)}</dd></div>
          <div><dt>Created</dt><dd><time dateTime={campaign.createdAt}>{new Date(campaign.createdAt).toLocaleDateString()}</time></dd></div>
          <div><dt>Updated</dt><dd><time dateTime={campaign.updatedAt}>{new Date(campaign.updatedAt).toLocaleDateString()}</time></dd></div>
          {campaign.content.status === "unconfigured" ? <div><dt>Content</dt><dd>Unconfigured</dd></div> : <>
            <div><dt>Rules profile</dt><dd><code>{campaign.content.rulesProfileId}</code></dd></div>
            <div><dt>Content packs</dt><dd>{campaign.content.contentPacks.length === 0 ? "None" : <ul className="identifier-list">{campaign.content.contentPacks.map((pack) => <li key={pack.packId}><code>{pack.packId}</code> <span>version</span> <code>{pack.packVersion}</code></li>)}</ul>}</dd></div>
          </>}
        </dl>
        <section className="campaign-rooms" aria-labelledby="campaign-rooms-heading" aria-busy={roomsPhase === "loading" || roomActivity !== "idle"}>
          <div className="campaign-rooms-heading">
            <h2 ref={roomsHeadingRef} tabIndex={-1} id="campaign-rooms-heading">Rooms</h2>
            <button className="ghost" type="button" disabled={pageBusy || roomActivity !== "idle"} onClick={refreshRooms}>Refresh rooms</button>
          </div>
          {roomsPhase === "loading" && <p className="rooms-status" role="status">Loading rooms…</p>}
          {roomsPhase === "failed" && <div className="rooms-error" role="alert"><p>Campaign rooms could not be loaded.</p><button ref={roomsRetryRef} className="ghost" type="button" disabled={pageBusy} onClick={refreshRooms}>Retry rooms</button></div>}
          {rooms && roomsPhase === "ready" && <>
            <h3>Attached rooms</h3>
            {rooms.attached.length === 0 ? <p className="rooms-status">No rooms attached.</p> : <ul className="campaign-room-list" aria-label="Attached campaign rooms">
              {rooms.attached.map((room, index) => <li key={index}>
                <div><strong><bdi dir="auto">{roomTitle(room)}</bdi></strong><p>{room.participantNames.map((name, participantIndex) => <span key={participantIndex}><bdi dir="auto">{name}</bdi>{participantIndex < room.participantNames.length - 1 ? " · " : ""}</span>)}</p><small>Created <time dateTime={room.createdAt}>{new Date(room.createdAt).toLocaleDateString()}</time> · Attached <time dateTime={room.attachedAt}>{new Date(room.attachedAt).toLocaleDateString()}</time>{room.stopped ? " · Stopped · Read-only" : ""}</small></div>
                <button className="ghost room-open" type="button" disabled={pageBusy} aria-label={`Open attached room ${index + 1} of ${rooms.attached.length}`} onClick={() => { if (!pageBusy) onOpenRoom(room.sessionId); }}>{roomOpenPending ? "Opening room…" : "Open room"}</button>
              </li>)}
            </ul>}
            {campaign.actorRole === "owner" && <div className="eligible-rooms"><h3>Attach a room</h3>{rooms.eligible.length === 0
              ? <p className="rooms-status">No eligible running rooms.</p>
              : <ul className="campaign-room-list" aria-label="Eligible campaign rooms">{rooms.eligible.map((room, index) => <li key={index}>
                <div><strong><bdi dir="auto">{roomTitle(room)}</bdi></strong><p>{room.participantNames.map((name, participantIndex) => <span key={participantIndex}><bdi dir="auto">{name}</bdi>{participantIndex < room.participantNames.length - 1 ? " · " : ""}</span>)}</p><small>Created <time dateTime={room.createdAt}>{new Date(room.createdAt).toLocaleDateString()}</time></small></div>
                <button className="primary room-attach" type="button" disabled={pageBusy || roomActivity !== "idle"} aria-label={`Attach eligible room ${index + 1} of ${rooms.eligible.length}`} onClick={() => void attachRoom(room)}>{roomActivity === "writing" ? "Attaching once…" : roomActivity === "reconciling" ? "Refreshing rooms…" : "Attach room"}</button>
              </li>)}</ul>}</div>}
          </>}
          {roomResult && <div className="room-result-actions"><p ref={roomStatusRef} tabIndex={-1} className={roomResult.alert ? "form-error" : "create-success"} role={roomResult.alert ? "alert" : "status"}>{roomResult.text}</p><button className="ghost" type="button" disabled={pageBusy || roomActivity !== "idle"} onClick={refreshRooms}>Refresh rooms</button></div>}
          {roomOpenFailure && <p ref={roomOpenStatusRef} tabIndex={-1} className="form-error" role="alert">{roomOpenFailure.text}</p>}
        </section>
        {rosterPhase !== "unsupported" && <section className="campaign-roster" aria-labelledby="campaign-roster-heading" aria-busy={rosterPhase === "loading"}>
          <div className="campaign-roster-heading"><h2 ref={rosterHeadingRef} tabIndex={-1} id="campaign-roster-heading">Characters</h2>{mechanicsEnabled && campaign.actorRole !== "observer" && <button className="primary" type="button" disabled={pageBusy} onClick={onOpenCharacterBuilder}>Build playable character</button>}</div>
          <p className="sr-only" role="status" aria-live="polite">{rosterAnnouncement}</p>
          {rosterPhase === "loading" && <p className="roster-status" role="status">Loading characters…</p>}
          {rosterPhase === "failed" && <div className="roster-error" role="alert">
            <p>Characters could not be loaded.</p>
            <button ref={rosterRetryRef} className="ghost roster-retry" type="button" onClick={() => void loadRoster(true)}>Retry characters</button>
          </div>}
          {rosterPhase === "ready" && (roster.length === 0
            ? <p className="roster-status">No characters yet.</p>
            : <ul className="campaign-roster-list" aria-label="Campaign characters">{roster.map((character, index) => <li key={character.id}>
              <bdi dir="auto">{character.name}</bdi>
              <button className="ghost roster-open" type="button" disabled={pageBusy} aria-label={`Open character ${character.name}, character ${index + 1} of ${roster.length}`} onClick={() => { if (!pageBusy) onOpenCharacter(character.id); }}>Open character</button>
            </li>)}</ul>)}
          </section>}
        {mechanicsEnabled && (campaign.actorRole === "owner" || campaign.actorRole === "gm") && <section className="campaign-dice" aria-labelledby="campaign-dice-heading" aria-busy={dicePhase === "loading" || diceBusy}>
          <h2 ref={diceHeadingRef} tabIndex={-1} id="campaign-dice-heading">Dice</h2>
          {dicePhase === "loading" && <p className="dice-status" role="status">Loading roll history…</p>}
          {dicePhase === "failed" && <div className="dice-error">
            <p role="alert">{diceError || "Roll history could not be loaded."}</p>
            {!diceResult && <button ref={diceRetryRef} className="ghost" type="button" disabled={pageBusy} onClick={() => void loadDice(true, false)}>Retry roll history</button>}
          </div>}
          {diceHistory && (dicePhase === "ready" || diceBusy) && <>
            <form className="dice-form" onSubmit={(event) => void submitDice(event)}>
              <div className="dice-field"><label htmlFor="dice-character-position">Character</label><select id="dice-character-position" value={diceCharacterPosition ?? ""} disabled={pageBusy || diceHistory.characters.length === 0} onChange={(event) => setDiceCharacterPosition(Number(event.target.value))}>
                {diceHistory.characters.length === 0 && <option value="">No characters available</option>}
                {diceHistory.characters.map((character) => <option key={character.position} value={character.position}>Character {character.position} of {diceHistory.characters.length} — {character.name}</option>)}
              </select></div>
              <div className="dice-field"><label htmlFor="dice-expression">Expression</label><input id="dice-expression" ref={diceExpressionRef} value={diceExpression} maxLength={24} required disabled={pageBusy || diceHistory.characters.length === 0} onChange={(event) => setDiceExpression(event.target.value)} aria-describedby="dice-expression-help" /></div>
              <p id="dice-expression-help" className="dice-help">Examples: 1d20, 2d6+3, 4d6kh3, 1d20adv, 1d20dis. Up to 100 dice, 1,000 sides, and ±1,000 modifier.</p>
              <button className="primary" type="submit" disabled={pageBusy || diceHistory.characters.length === 0}>{dicePhase === "writing" ? "Rolling once…" : dicePhase === "reconciling" ? "Refreshing roll history…" : "Roll dice"}</button>
            </form>
            {diceError && dicePhase === "ready" && <p className="form-error" role="alert">{diceError}</p>}
            <div className="dice-history" aria-labelledby="dice-history-heading">
              <h3 id="dice-history-heading">Recent rolls</h3>
              {diceHistory.rolls.length === 0 ? <p className="dice-status">No rolls yet.</p> : <ol aria-label="Recent dice rolls">
                {diceHistory.rolls.slice(0, 20).map((roll, index) => <li key={`${roll.occurredAt}-${index}`}>
                  <div className="dice-roll-heading"><strong><bdi dir="auto">{roll.character.name}</bdi></strong><time dateTime={roll.occurredAt}>{new Date(roll.occurredAt).toLocaleString()}</time></div>
                  <dl>
                    <div><dt>Expression</dt><dd><code>{roll.result.expression}</code></dd></div>
                    <div><dt>Physical dice</dt><dd>{roll.result.terms.map((term, termIndex) => <span className="dice-term" key={termIndex}>{term.value} ({term.kept ? "kept" : "discarded"})</span>)}</dd></div>
                    <div><dt>Modifier</dt><dd>{roll.result.modifier > 0 ? `+${roll.result.modifier}` : roll.result.modifier}</dd></div>
                    <div><dt>Total</dt><dd><strong>{roll.result.total}</strong></dd></div>
                  </dl>
                </li>)}
              </ol>}
            </div>
          </>}
          {diceResult && <div className="create-result-actions">
            <p ref={diceStatusRef} tabIndex={-1} className={diceResult.alert ? "dice-warning" : "create-success"} role={diceResult.alert ? "alert" : "status"}>{diceResult.text}</p>
            <button className="ghost" type="button" disabled={pageBusy || dicePhase === "loading"} onClick={() => void refreshDiceRolls()}>Refresh rolls</button>
          </div>}
        </section>}
        {isOriginalStarterConfigured(campaign) && <section className="character-options" aria-label="Character creation" aria-busy={optionsPhase === "loading" || characterStatusActivity !== "idle"}>
          {(optionsPhase === "loading" || characterStatusActivity !== "idle") && <p className="character-options-status" role="status" aria-live="polite">
            {characterStatusActivity === "refreshing" ? "Refreshing character creation options…"
              : characterStatusActivity === "reconciling" ? "Checking character creation options…"
                : "Loading character creation options…"}
          </p>}
          {(optionsPhase === "failed" || optionsPhase === "unsupported") && <div className="character-options-error" aria-label="Character creation options">
            <div role="alert"><p>Character creation options could not be loaded.</p></div>
            <button ref={optionsRetryRef} className="ghost" type="button" disabled={pageBusy} onClick={() => void loadOptions(true, false)}>Retry character options</button>
          </div>}
          {optionsAnnouncement && <p className="character-options-status" role="status" aria-live="polite">{optionsAnnouncement}</p>}
          {optionsPhase === "ready" && options && <form className="starter-character-create" aria-busy={createBusy} onSubmit={(event) => { event.preventDefault(); void createCharacter(); }}>
          <div>
            <p className="eyebrow">FIXED ORIGINAL STARTER</p>
            <h2 ref={optionsHeadingRef} tabIndex={-1}>Finalize a character record</h2>
          </div>
          <p className="starter-warning"><strong>Final metadata only.</strong> Select one unused existing Velvet persona. The fixed record has no customization and cannot be edited, deleted, rebuilt, or reset here.</p>
          <dl className="starter-character-metadata" aria-label="Fixed read-only starter metadata">
            <div><dt>Rules profile</dt><dd><strong>{options.starter.rulesProfile.name}</strong><code>{options.starter.rulesProfile.rulesProfileId}</code></dd></div>
            <div><dt>Content pack</dt><dd><strong>{options.starter.pack.name}</strong><code>{options.starter.pack.packId}@{options.starter.pack.packVersion}</code></dd></div>
            <div><dt>Race</dt><dd><strong>{options.starter.race.name}</strong><code>{options.starter.race.reference.definitionId}</code></dd></div>
            <div><dt>Background</dt><dd><strong>{options.starter.background.name}</strong><code>{options.starter.background.reference.definitionId}</code></dd></div>
            <div><dt>Class</dt><dd><strong>{options.starter.class.name}, level {options.starter.class.level}</strong><code>{options.starter.class.reference.definitionId}</code></dd></div>
          </dl>
          <fieldset className="persona-options" disabled={pageBusy}>
            <legend>Select one existing persona</legend>
            {options.personas.length === 0 && <p>No existing personas are available.</p>}
            {options.personas.map((persona, index) => <label className={persona.alreadyUsed ? "persona-option is-used" : "persona-option"} key={index}>
              <input ref={index === 0 ? firstPersonaChoiceRef : undefined} type="radio" name="starter-persona" checked={selectedCharacterId === persona.characterId} disabled={persona.alreadyUsed || pageBusy} onChange={() => { if (!persona.alreadyUsed) { setSelectedCharacterId(persona.characterId); setCreateConfirmed(false); } }} />
              <span><bdi dir="auto">{persona.name}</bdi>{" "}<small>Persona {index + 1} of {options.personas.length}</small>{persona.alreadyUsed && <>{" "}<small>Already used — not selectable</small></>}</span>
            </label>)}
          </fieldset>
          <label className="checkbox starter-confirm create-confirm"><input ref={createConfirmationRef} type="checkbox" required checked={createConfirmed} onChange={(event) => setCreateConfirmed(event.target.checked)} disabled={pageBusy} /><span>I confirm this record is finalized and currently has <strong>NO</strong> derived stats, rules validation, editing, deletion, rebuilding or reset, gameplay or mechanics, inventory, equipment, spells, powers, progression, or AI workflow.</span></label>
          <button className="primary starter-submit" type="submit" disabled={pageBusy || !selectedCharacterId || !createConfirmed}>{createPhase === "writing" ? "Creating once…" : createPhase === "reconciling" ? "Checking character status…" : "Finalize character record"}</button>
        </form>}
          {createResult && <div className="create-result-actions">
            <p ref={createStatusRef} tabIndex={-1} className={createResult.alert ? "form-error" : "create-success"} role={createResult.alert ? "alert" : "status"}>{createResult.text}</p>
            <button className="ghost" type="button" disabled={pageBusy || characterStatusActivity !== "idle"} onClick={() => void refreshCharacterStatus()}>Refresh character status</button>
          </div>}
        </section>}
        {campaign.actorRole === "owner" && campaign.content.status === "unconfigured" && <section className="starter-setup" aria-labelledby="starter-setup-heading" aria-busy={setupBusy}>
          <div className="starter-heading"><div><p className="eyebrow">FIXED STARTER ACTIVATION</p><h2 id="starter-setup-heading">Set up campaign metadata</h2></div></div>
          <p className="starter-warning"><strong>Choose once.</strong> Starter setup is available only while this campaign is unconfigured. Neither choice can replace, migrate, reset, or add to configured content.</p>
          <fieldset className="persona-options starter-choice-options" disabled={pageBusy}>
            <legend>Select one mutually exclusive starter</legend>
            <label className="persona-option"><input type="radio" name="campaign-starter-choice" checked={setupChoice === "original"} onChange={() => { setSetupChoice("original"); setSetupConfirmed(false); setSetupError(""); }} /><span><strong>Original metadata starter</strong><small> Narrative identities only; no playable mechanics.</small></span></label>
            {mechanicsEnabled && <label className="persona-option"><input type="radio" name="campaign-starter-choice" checked={setupChoice === "mechanics"} onChange={() => { setSetupChoice("mechanics"); setSetupConfirmed(false); setSetupError(""); }} /><span><strong>Mechanics starter</strong><small> Enables the fixed catalog for future character builder and progression workflows.</small></span></label>}
          </fieldset>
          {setupChoice === "original" && <>
            <div className="starter-heading"><div><p className="eyebrow">FIXED ORIGINAL STARTER</p><h3>Original metadata starter</h3></div><code>{ORIGINAL_STARTER_PRESENTATION.starterId}</code></div>
            <p className="starter-warning"><strong>Metadata scaffolding only.</strong> This starter adds no playable mechanics, gameplay, or character creation. Setup is final and has no reset, change, or add controls.</p>
            <p className="starter-warning"><strong>Internal local material.</strong> Names are not claimed to be unique; similarity review was limited, and no distribution license is granted. The concepts and wording were originally authored for Velvet.</p>
            <div className="starter-identities">
              <article><span>Rules profile</span><h3>{ORIGINAL_STARTER_PRESENTATION.rulesProfile.name}</h3><p>{ORIGINAL_STARTER_PRESENTATION.rulesProfile.description}</p><code>{ORIGINAL_STARTER_PRESENTATION.rulesProfile.id}</code></article>
              <article><span>Content pack</span><h3>{ORIGINAL_STARTER_PRESENTATION.pack.name}</h3><p>{ORIGINAL_STARTER_PRESENTATION.pack.description}</p><code>{ORIGINAL_STARTER_PRESENTATION.pack.id}@{ORIGINAL_STARTER_PRESENTATION.pack.version}</code></article>
            </div>
            <div className="starter-definitions">
              {[{ label: "Race", item: ORIGINAL_STARTER_PRESENTATION.races[0] }, { label: "Background", item: ORIGINAL_STARTER_PRESENTATION.backgrounds[0] }, { label: "Class", item: ORIGINAL_STARTER_PRESENTATION.classes[0] }].map(({ label, item }) => <article key={label}><span>{label}</span><h3>{item.name}</h3><p>{item.description}</p></article>)}
            </div>
          </>}
          {setupChoice === "mechanics" && <>
            <div className="starter-heading"><div><p className="eyebrow">FIXED MECHANICS STARTER</p><h3>Velvet Mechanics Starter</h3></div><code>{MECHANICS_STARTER_IDENTITY.starterId}</code></div>
            <p className="starter-warning"><strong>Future mechanics foundation.</strong> This activates the reviewed fixed catalog for future builder and progression UI. It does not add builder, finalization, progression, or arbitrary content controls in this slice, and it cannot replace any configured content.</p>
            <div className="starter-identities">
              <article><span>Rules profile</span><h3>Velvet Starter Rules</h3><p>Closed deterministic mechanics profile for the built-in catalog.</p><code>{MECHANICS_STARTER_IDENTITY.rulesProfileId}</code></article>
              <article><span>Content catalog</span><h3>Velvet Mechanics Starter</h3><p>Fixed original races, backgrounds, classes, abilities, spells, items, resources, and encounter metadata.</p><code>{MECHANICS_STARTER_IDENTITY.packId}@{MECHANICS_STARTER_IDENTITY.packVersion}</code></article>
            </div>
          </>}
          {setupChoice && <>
            <p className="starter-warning"><strong>Two-transaction setup:</strong> the {setupChoice === "mechanics" ? "catalog is published" : "pack is installed"} first and the campaign is configured second. If setup fails between them, {setupChoice === "mechanics" ? "the catalog may remain published" : "the pack may remain installed"} without changing this campaign.</p>
            <label className="checkbox starter-confirm"><input ref={setupConfirmationRef} type="checkbox" checked={setupConfirmed} onChange={(event) => setSetupConfirmed(event.target.checked)} disabled={pageBusy} /><span>{setupChoice === "mechanics" ? "I explicitly confirm mechanics starter activation for future builder and progression, knowing it cannot replace configured content" : "I understand this metadata-only setup is final"} and understand the two-transaction outcome.</span></label>
          </>}
          <button className="primary starter-submit" type="button" disabled={pageBusy || !setupChoice || !setupConfirmed} onClick={() => void setupStarter()}>{setupPhase === "writing" ? "Setting up once…" : setupPhase === "reconciling" ? "Checking latest details…" : setupChoice === "mechanics" ? "Activate mechanics starter" : setupChoice === "original" ? "Set up original starter" : "Select a starter"}</button>
        </section>}
        {campaign.content.status === "configured" && <div className="configured-readonly" ref={configuredStatusRef} tabIndex={-1}><strong>Content configuration is read-only.</strong> There are no reset, change, or add controls.</div>}
        {setupError && <p className="form-error setup-result" role="alert">{setupError}</p>}
      </>}
    </section>
  </section></main>;
}

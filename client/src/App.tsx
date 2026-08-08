import { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, Character, CharacterSpec, ChatMessage, FeatureFlags, HarnessSettings, ProviderSettings, SessionContextBasket, UsageSummary,
  Session, SiblingsResponse, StreamHandle, activateMessage, branchMessage, continueSession,
  createCharacter, deleteCharacter, deleteSession, exportCharacter, getContentPackPublication, getFeatures, getHarness, getProvider, getRpgFeatures, getSession,
  getSessionContext, getSiblings, getUsage, importCharacter, listCharacters, listSessions, openSoloSession, sendMessage, startSession, stopSession,
  listContentPackPublications, publishContentPack, streamMessage, streamRoomContinuation, streamRoomMessage, streamSwipe, swipeMessage, updateCharacter, updateHarness, updateProvider, updateSessionContext, validateContentPackDraft,
} from "./api";
import { CharacterForm } from "./components/CharacterForm";
import { LoreManager } from "./components/LoreManager";
import { MemoryManager } from "./components/MemoryManager";
import { PromptSettings } from "./components/PromptSettings";
import { CharacterLibraryPage as Home } from "./roleplay/CharacterLibraryPage";
import { CampaignLibraryPage } from "./roleplay/CampaignLibraryPage";
import { CampaignDetailPage } from "./roleplay/CampaignDetailPage";
import { CampaignCharacterWorkspacePage } from "./roleplay/CampaignCharacterWorkspacePage";
import { CampaignAdministrationPage } from "./components/rpg/campaign/CampaignAdministrationPage";
import { ContentPackLibraryPage, type ContentPackLibraryApi } from "./components/rpg/content/ContentPackLibraryPage";
import { readNavigation, writeNavigation, type StoredNavigation, type View } from "./roleplay/navigation";

function messageFor(error: unknown, fallback: string) { return error instanceof ApiError ? error.message : fallback; }

function isExactRequestedSoloSession(session: Session, characterId: string): boolean {
  if (typeof session.id !== "string" || session.id.trim().length < 1) return false;
  if (!Array.isArray(session.participants) || session.participants.length !== 1
    || session.participants[0]?.id !== characterId) return false;
  if (session.primaryCharacterId !== characterId) return false;
  // characterId is the legacy compatibility alias. Older payloads may omit
  // it, but whenever it is present it must bind to the same requested solo.
  return !("characterId" in session) || session.characterId === characterId;
}

const contentPackLibraryApi: ContentPackLibraryApi = {
  list: listContentPackPublications,
  detail: getContentPackPublication,
  validate: validateContentPackDraft,
  publish: publishContentPack,
};

export default function App() {
  const stored = useRef(readNavigation()).current;
  const [view, setView] = useState<View>(stored.view ?? "home");
  const [characters, setCharacters] = useState<Character[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(stored.selectedIds ?? []);
  const [primaryId, setPrimaryId] = useState(stored.primaryId ?? "");
  const [activeCharacterId, setActiveCharacterId] = useState(stored.characterId ?? "");
  const [activeCampaignId, setActiveCampaignId] = useState(stored.campaignId ?? "");
  const [activeCampaignCharacterId, setActiveCampaignCharacterId] = useState(stored.campaignCharacterId ?? "");
  const [activeCampaignName, setActiveCampaignName] = useState("");
  const [chatReturnCampaignId, setChatReturnCampaignId] = useState(stored.chatReturnCampaignId ?? "");
  const [roomsRefreshRequest, setRoomsRefreshRequest] = useState<{ campaignId: string; request: number } | null>(null);
  const [roomOpenPending, setRoomOpenPending] = useState<{ campaignId: string; request: number } | null>(null);
  const [roomOpenFailure, setRoomOpenFailure] = useState<{ campaignId: string; request: number; text: string } | null>(null);
  const transitionRequestRef = useRef(0);
  const roomOpenRequestRef = useRef(0);
  const privateOpenRequestRef = useRef(0);
  const ordinaryOpenRequestRef = useRef(0);
  const saveCharacterRequestRef = useRef(0);
  const navigationEpochRef = useRef(0);
  const chatEntryRef = useRef(0);
  const campaignDetailEntryRef = useRef(0);
  const campaignAdministrationEntryRef = useRef(0);
  const contentStudioEntryRef = useRef(0);
  const [campaignHeadingFocusRequest, setCampaignHeadingFocusRequest] = useState<{ campaignId: string; request: number } | null>(null);
  const [workspaceHeadingFocusRequest, setWorkspaceHeadingFocusRequest] = useState<{ campaignId: string; campaignCharacterId: string; request: number } | null>(null);
  const [administrationHeadingFocusRequest, setAdministrationHeadingFocusRequest] = useState<{ campaignId: string; request: number } | null>(null);
  const [contentHeadingFocusRequest, setContentHeadingFocusRequest] = useState<number | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [features, setFeatures] = useState<FeatureFlags>({ voice: false, images: false });
  const [campaignLibraryAvailable, setCampaignLibraryAvailable] = useState(false);
  const campaignAvailabilityRef = useRef<boolean | null>(null);
  // Mechanics discovery is retained independently from campaign navigation so
  // an optional/legacy RPG endpoint never stalls the legacy application.
  const [campaignMechanicsAvailable, setCampaignMechanicsAvailable] = useState(false);
  const [contentStudioAvailable, setContentStudioAvailable] = useState(false);
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [harness, setHarness] = useState<HarnessSettings | null>(null);
  const currentNavigationRef = useRef({ view, campaignId: activeCampaignId, chatReturnCampaignId });
  currentNavigationRef.current = { view, campaignId: activeCampaignId, chatReturnCampaignId };
  const currentSessionRef = useRef<Session | null>(session);
  currentSessionRef.current = session;
  const previousViewRef = useRef(view);

  useEffect(() => {
    if (previousViewRef.current === view) return;
    previousViewRef.current = view;
    // Every user- or operation-driven view transition is a navigation
    // boundary. Pending work may finish, but can no longer publish into a
    // later visit that happens to return to the same view.
    navigationEpochRef.current += 1;
  }, [view]);

  function cancelRoomOpenForNavigation() {
    navigationEpochRef.current += 1;
    roomOpenRequestRef.current += 1;
    privateOpenRequestRef.current += 1;
    ordinaryOpenRequestRef.current += 1;
    saveCharacterRequestRef.current += 1;
    setBusy(false);
    setError(null);
    setRoomOpenPending(null);
    setRoomOpenFailure(null);
  }

  async function refreshLibrary(isCurrent: () => boolean = () => true) {
    const [characterData, sessionData] = await Promise.all([listCharacters(), listSessions()]);
    if (!isCurrent()) return null;
    setCharacters(characterData.characters); setSessions(sessionData.sessions);
    return { characters: characterData.characters, sessions: sessionData.sessions };
  }

  useEffect(() => {
    let mounted = true;
    // Optional RPG discovery is intentionally independent: a slow or legacy
    // server endpoint must never hold the character library or restored chat.
    void getRpgFeatures()
      .catch(() => ({ campaign: false, mechanics: false, combat: false, studio: false, remoteAuthentication: false }))
      .then((rpgFeatureData) => {
        if (!mounted) return;
        campaignAvailabilityRef.current = rpgFeatureData.campaign;
        setCampaignLibraryAvailable(rpgFeatureData.campaign);
        setCampaignMechanicsAvailable(rpgFeatureData.mechanics);
        setContentStudioAvailable(rpgFeatureData.campaign && rpgFeatureData.mechanics);
        const current = currentNavigationRef.current;
        const campaignRelated = current.view === "campaigns" || current.view === "campaign-detail" || current.view === "campaign-administration"
          || current.view === "campaign-character" || (current.view === "chat" && Boolean(current.chatReturnCampaignId));
        if (campaignRelated && !rpgFeatureData.campaign) {
          cancelRoomOpenForNavigation();
          currentNavigationRef.current = { view: "home", campaignId: "", chatReturnCampaignId: "" };
          setActiveCampaignId("");
          setActiveCampaignCharacterId("");
          setChatReturnCampaignId("");
          setSession(null);
          setMessages([]);
          setView("home");
        }
        if (current.view === "content-packs" && !(rpgFeatureData.campaign && rpgFeatureData.mechanics)) {
          cancelRoomOpenForNavigation();
          currentNavigationRef.current = { view: "home", campaignId: "", chatReturnCampaignId: "" };
          setView("home");
        }
      });
    void Promise.all([refreshLibrary(), getFeatures().catch(() => ({ voice: false, images: false })), getProvider().catch(() => null), getHarness().catch(() => null)])
      .then(async ([library, featureData, providerData, harnessData]) => {
        if (!mounted) return;
        if (!library) return;
        setFeatures(featureData); setProvider(providerData); setHarness(harnessData);
        const valid = new Set(library.characters.map((character) => character.id));
        const validSelected = selectedIds.filter((id) => valid.has(id));
        setSelectedIds(validSelected); setPrimaryId(validSelected.includes(primaryId) ? primaryId : validSelected[0] ?? "");
        if (activeCharacterId && !valid.has(activeCharacterId)) { setActiveCharacterId(""); if (["edit", "memory"].includes(view)) setView("home"); }
        if (stored.sessionId && library.sessions.some((item) => item.id === stored.sessionId) && stored.view === "chat") {
          const restorationEpoch = navigationEpochRef.current;
          try {
            const hydrated = await getSession(stored.sessionId);
            // Session IDs are opaque and exact. A valid-looking response for a
            // different room must never inherit the persisted campaign origin.
            if (hydrated.session.id !== stored.sessionId) throw new Error("Session response did not match the requested room");
            if (mounted && restorationEpoch === navigationEpochRef.current
              && !(stored.chatReturnCampaignId && campaignAvailabilityRef.current === false)) {
              chatEntryRef.current += 1; currentSessionRef.current = hydrated.session;
              setSession(hydrated.session); setMessages(hydrated.messages); setView("chat");
            }
          } catch {
            if (!mounted || restorationEpoch !== navigationEpochRef.current) return;
            if (stored.chatReturnCampaignId && campaignAvailabilityRef.current !== false) {
              const request = ++transitionRequestRef.current;
              campaignDetailEntryRef.current = request;
              currentNavigationRef.current = { view: "campaign-detail", campaignId: stored.chatReturnCampaignId, chatReturnCampaignId: "" };
              setActiveCampaignId(stored.chatReturnCampaignId);
              setChatReturnCampaignId("");
              setRoomOpenFailure({ campaignId: stored.chatReturnCampaignId, request, text: "Room could not be opened. Please try again." });
              setSession(null); setMessages([]); setView("campaign-detail");
            } else { setChatReturnCampaignId(""); setView("home"); }
          }
        } else if (stored.view === "chat") { setChatReturnCampaignId(""); setView("home"); }
      })
      .catch((err) => setError(messageFor(err, "Could not load your library. Is the backend running on port 8787?")))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
    // Initial restoration intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    writeNavigation({ view, characterId: activeCharacterId || undefined, sessionId: session?.id, selectedIds, primaryId, campaignId: activeCampaignId || undefined, campaignCharacterId: activeCampaignCharacterId || undefined, chatReturnCampaignId: view === "chat" && session && chatReturnCampaignId ? chatReturnCampaignId : undefined } satisfies StoredNavigation);
  }, [view, activeCharacterId, session?.id, selectedIds, primaryId, activeCampaignId, activeCampaignCharacterId, chatReturnCampaignId]);

  function goHome() { cancelRoomOpenForNavigation(); currentNavigationRef.current = { view: "home", campaignId: "", chatReturnCampaignId: "" }; setChatReturnCampaignId(""); setView("home"); setSession(null); setMessages([]); setError(null); }
  async function openSession(id: string) {
    cancelRoomOpenForNavigation();
    const request = ++ordinaryOpenRequestRef.current;
    const navigationEpoch = navigationEpochRef.current;
    const isCurrent = () => request === ordinaryOpenRequestRef.current
      && navigationEpoch === navigationEpochRef.current
      && currentNavigationRef.current.view === "home";
    setChatReturnCampaignId(""); setBusy(true); setError(null);
    try {
      const data = await getSession(id);
      if (!isCurrent()) return;
      if (data.session.id !== id) throw new Error("Session response did not match the request");
      chatEntryRef.current += 1; currentSessionRef.current = data.session;
      currentNavigationRef.current = { view: "chat", campaignId: "", chatReturnCampaignId: "" };
      setSession(data.session); setMessages(data.messages); setView("chat");
    } catch (err) {
      if (!isCurrent()) return;
      setError(messageFor(err, "Could not resume session."));
      await refreshLibrary(isCurrent).catch(() => undefined);
    } finally { if (request === ordinaryOpenRequestRef.current) setBusy(false); }
  }
  async function openPrivateSession(characterId: string) {
    const request = ++privateOpenRequestRef.current;
    const navigationEpoch = navigationEpochRef.current;
    const sourceEntry = chatEntryRef.current;
    const sourceSessionId = currentSessionRef.current?.id;
    // Do not clear campaign return state while this request is uncertain. The
    // existing room and Back origin remain authoritative until latest success.
    roomOpenRequestRef.current += 1;
    setBusy(true); setError(null);
    const isCurrent = () => request === privateOpenRequestRef.current
      && navigationEpoch === navigationEpochRef.current
      && currentNavigationRef.current.view === "chat"
      && chatEntryRef.current === sourceEntry
      && currentSessionRef.current?.id === sourceSessionId;
    try {
      const data = await openSoloSession(characterId);
      if (!isCurrent()) return;
      if (!isExactRequestedSoloSession(data.session, characterId)) {
        throw new Error("Solo session response did not match the request");
      }
      navigationEpochRef.current += 1;
      chatEntryRef.current += 1; currentSessionRef.current = data.session;
      currentNavigationRef.current = { view: "chat", campaignId: "", chatReturnCampaignId: "" };
      setChatReturnCampaignId(""); setSession(data.session); setMessages(data.messages); setView("chat");
      // Library refresh is ancillary and cannot turn a successful navigation
      // into a stale failure that restores or overwrites its prior origin.
      void refreshLibrary().catch(() => undefined);
    } catch (err) {
      if (isCurrent()) setError(messageFor(err, "Could not open private chat."));
    } finally {
      if (request === privateOpenRequestRef.current) setBusy(false);
    }
  }
  async function saveCharacter(spec: CharacterSpec, start: boolean) {
    const request = ++saveCharacterRequestRef.current;
    const navigationEpoch = navigationEpochRef.current;
    const sourceView = currentNavigationRef.current.view;
    const sourceCharacterId = activeCharacterId;
    let saveCompleted = false;
    const isCurrent = () => request === saveCharacterRequestRef.current
      && navigationEpoch === navigationEpochRef.current
      && currentNavigationRef.current.view === sourceView
      && (sourceView === "create" || sourceView === "edit")
      && activeCharacterId === sourceCharacterId;
    setBusy(true); setError(null);
    try {
      const current = characters.find((item) => item.id === activeCharacterId);
      const saved = current ? await updateCharacter(current.id, spec) : await createCharacter(spec);
      if (!isCurrent()) return;
      saveCompleted = true;
      await refreshLibrary(isCurrent);
      if (!isCurrent()) return;
      setActiveCharacterId(saved.id);
      if (start) {
        const created = await startSession(saved.id);
        if (!isCurrent()) return;
        const hydrated = await getSession(created.id);
        if (!isCurrent()) return;
        if (hydrated.session.id !== created.id) throw new Error("Session response did not match the created session");
        chatEntryRef.current += 1; currentSessionRef.current = hydrated.session;
        currentNavigationRef.current = { view: "chat", campaignId: "", chatReturnCampaignId: "" };
        setChatReturnCampaignId(""); setSession(hydrated.session); setMessages(hydrated.messages); setView("chat");
      }
      else { currentNavigationRef.current = { view: "home", campaignId: "", chatReturnCampaignId: "" }; setView("home"); }
    } catch (err) {
      if (!isCurrent()) return;
      if (saveCompleted) { currentNavigationRef.current = { view: "home", campaignId: "", chatReturnCampaignId: "" }; setView("home"); }
      setError(messageFor(err, "Could not save character."));
    } finally { if (request === saveCharacterRequestRef.current) setBusy(false); }
  }
  async function createSelectedSession(title: string) {
    if (!selectedIds.length || !primaryId) return;
    setChatReturnCampaignId(""); setBusy(true); setError(null);
    try { const created = await startSession({ characterIds: selectedIds, primaryCharacterId: primaryId, ...(title.trim() ? { title: title.trim() } : {}) }); await refreshLibrary(); await openSession(created.id); }
    catch (err) { setError(messageFor(err, "Could not start session.")); setBusy(false); }
  }

  async function openCampaignRoom(campaignId: string, sessionId: string) {
    const current = currentNavigationRef.current;
    if (current.view !== "campaign-detail" || current.campaignId !== campaignId) return;
    const request = ++roomOpenRequestRef.current;
    const navigationEpoch = navigationEpochRef.current;
    setRoomOpenPending({ campaignId, request });
    setRoomOpenFailure(null);
    const isCurrent = () => {
      const navigation = currentNavigationRef.current;
      return request === roomOpenRequestRef.current && navigationEpoch === navigationEpochRef.current
        && navigation.view === "campaign-detail" && navigation.campaignId === campaignId;
    };
    try {
      const data = await getSession(sessionId);
      if (!isCurrent()) return;
      if (data.session.id !== sessionId) throw new Error("Session response did not match the requested room");
      // Persist the explicit origin before rendering chat so an immediate
      // reload cannot observe the prior detail navigation snapshot.
      writeNavigation({ view: "chat", sessionId: data.session.id, selectedIds, primaryId, campaignId, chatReturnCampaignId: campaignId });
      navigationEpochRef.current += 1;
      chatEntryRef.current += 1; currentSessionRef.current = data.session;
      currentNavigationRef.current = { view: "chat", campaignId, chatReturnCampaignId: campaignId };
      setChatReturnCampaignId(campaignId);
      setSession(data.session); setMessages(data.messages); setView("chat");
    }
    catch (err) {
      if (!isCurrent()) return;
      const missing = err instanceof ApiError && err.status === 404;
      setRoomOpenFailure({
        campaignId,
        request,
        text: missing
          ? "That room is no longer available. Latest campaign rooms are being refreshed."
          : "Room could not be opened. Please try again.",
      });
      if (missing) setRoomsRefreshRequest({ campaignId, request: ++transitionRequestRef.current });
    }
    finally {
      if (request === roomOpenRequestRef.current) setRoomOpenPending((pending) => pending?.request === request ? null : pending);
    }
  }

  const activeCharacter = characters.find((item) => item.id === activeCharacterId) ?? null;
  if (loading) return <main className="page"><section className="card loading-card"><h1 className="title">Velvet</h1><p className="subtitle">Opening your library…</p></section></main>;
  if (view === "create" || view === "edit") return <main className="page"><CharacterForm character={view === "edit" ? activeCharacter : null} busy={busy} error={error} onCancel={goHome} onSave={saveCharacter} /></main>;
  if (view === "memory" && activeCharacter) return <main className="page"><MemoryManager character={activeCharacter} onClose={goHome} /></main>;
  if (view === "lore") return <main className="page"><LoreManager characters={characters} onClose={goHome} /></main>;
  if (view === "content-packs" && contentStudioAvailable) return <ContentPackLibraryPage api={contentPackLibraryApi} focusHeadingRequest={contentHeadingFocusRequest === contentStudioEntryRef.current ? contentHeadingFocusRequest : undefined} onHeadingFocused={(request) => setContentHeadingFocusRequest((current) => current === request ? null : current)} onBack={goHome} />;
  if (view === "campaigns" && campaignLibraryAvailable) return <CampaignLibraryPage onBack={goHome} onContentPacks={contentStudioAvailable ? () => { cancelRoomOpenForNavigation(); const request = ++transitionRequestRef.current; contentStudioEntryRef.current = request; setContentHeadingFocusRequest(request); currentNavigationRef.current = { view: "content-packs", campaignId: "", chatReturnCampaignId: "" }; setView("content-packs"); } : undefined} onOpen={(campaignId) => { cancelRoomOpenForNavigation(); currentNavigationRef.current = { view: "campaign-detail", campaignId, chatReturnCampaignId: "" }; setChatReturnCampaignId(""); campaignDetailEntryRef.current = ++transitionRequestRef.current; setActiveCampaignId(campaignId); setView("campaign-detail"); }} />;
  if (view === "campaign-detail" && campaignLibraryAvailable && activeCampaignId) {
    const focusRequest = campaignHeadingFocusRequest?.campaignId === activeCampaignId
      && campaignHeadingFocusRequest.request === campaignDetailEntryRef.current ? campaignHeadingFocusRequest.request : undefined;
    const leaveDetail = () => { cancelRoomOpenForNavigation(); currentNavigationRef.current = { view: "campaigns", campaignId: "", chatReturnCampaignId: "" }; campaignDetailEntryRef.current = ++transitionRequestRef.current; setActiveCampaignId(""); setActiveCampaignCharacterId(""); setView("campaigns"); };
    return <CampaignDetailPage campaignId={activeCampaignId} mechanicsEnabled={campaignMechanicsAvailable} focusHeadingRequest={focusRequest} roomsRefreshRequest={roomsRefreshRequest?.campaignId === activeCampaignId ? roomsRefreshRequest.request : undefined} onRoomsRefreshHandled={(request) => setRoomsRefreshRequest((current) => current?.campaignId === activeCampaignId && current.request === request ? null : current)} roomOpenPending={roomOpenPending?.campaignId === activeCampaignId} roomOpenFailure={roomOpenFailure?.campaignId === activeCampaignId ? roomOpenFailure : null} onHeadingFocused={(request) => setCampaignHeadingFocusRequest((current) => current?.campaignId === activeCampaignId && current.request === request && campaignDetailEntryRef.current === request ? null : current)} onBack={leaveDetail} onUnavailable={leaveDetail} onOpenRoom={(sessionId) => void openCampaignRoom(activeCampaignId, sessionId)} onOpenAdministration={(campaignName) => { cancelRoomOpenForNavigation(); currentNavigationRef.current = { view: "campaign-administration", campaignId: activeCampaignId, chatReturnCampaignId: "" }; const request = ++transitionRequestRef.current; campaignAdministrationEntryRef.current = request; setAdministrationHeadingFocusRequest({ campaignId: activeCampaignId, request }); setActiveCampaignName(campaignName); setView("campaign-administration"); }} onOpenCharacter={(campaignCharacterId) => { cancelRoomOpenForNavigation(); currentNavigationRef.current = { view: "campaign-character", campaignId: activeCampaignId, chatReturnCampaignId: "" }; const request = ++transitionRequestRef.current; setWorkspaceHeadingFocusRequest({ campaignId: activeCampaignId, campaignCharacterId, request }); setActiveCampaignCharacterId(campaignCharacterId); setView("campaign-character"); }} />;
  }
  if (view === "campaign-administration" && campaignLibraryAvailable && activeCampaignId) {
    const returnToCampaign = () => { cancelRoomOpenForNavigation(); currentNavigationRef.current = { view: "campaign-detail", campaignId: activeCampaignId, chatReturnCampaignId: "" }; const request = ++transitionRequestRef.current; campaignDetailEntryRef.current = request; setCampaignHeadingFocusRequest({ campaignId: activeCampaignId, request }); setView("campaign-detail"); };
    const focusRequest = administrationHeadingFocusRequest?.campaignId === activeCampaignId
      && administrationHeadingFocusRequest.request === campaignAdministrationEntryRef.current ? administrationHeadingFocusRequest.request : undefined;
    return <CampaignAdministrationPage campaignId={activeCampaignId} campaignName={activeCampaignName} focusHeadingRequest={focusRequest} onHeadingFocused={(request) => setAdministrationHeadingFocusRequest((current) => current?.campaignId === activeCampaignId && current.request === request ? null : current)} onBack={returnToCampaign} onUnavailable={() => { cancelRoomOpenForNavigation(); currentNavigationRef.current = { view: "campaigns", campaignId: "", chatReturnCampaignId: "" }; setActiveCampaignId(""); setActiveCampaignName(""); setView("campaigns"); }} />;
  }
  if (view === "campaign-character" && campaignLibraryAvailable && activeCampaignId && activeCampaignCharacterId) {
    const returnToCampaign = () => { cancelRoomOpenForNavigation(); currentNavigationRef.current = { view: "campaign-detail", campaignId: activeCampaignId, chatReturnCampaignId: "" }; const request = ++transitionRequestRef.current; campaignDetailEntryRef.current = request; setCampaignHeadingFocusRequest({ campaignId: activeCampaignId, request }); setActiveCampaignCharacterId(""); setView("campaign-detail"); };
    return <CampaignCharacterWorkspacePage campaignId={activeCampaignId} campaignCharacterId={activeCampaignCharacterId} focusHeadingRequest={workspaceHeadingFocusRequest?.campaignId === activeCampaignId && workspaceHeadingFocusRequest.campaignCharacterId === activeCampaignCharacterId ? workspaceHeadingFocusRequest.request : undefined} onBack={returnToCampaign} onUnavailable={returnToCampaign} />;
  }
  if (view === "chat" && session) {
    const returnCampaignId = chatReturnCampaignId;
    const returnToCampaign = returnCampaignId ? () => {
      cancelRoomOpenForNavigation();
      currentNavigationRef.current = { view: "campaign-detail", campaignId: returnCampaignId, chatReturnCampaignId: "" };
      const request = ++transitionRequestRef.current;
      setRoomsRefreshRequest({ campaignId: returnCampaignId, request });
      setActiveCampaignId(returnCampaignId); setChatReturnCampaignId(""); setSession(null); setMessages([]); setView("campaign-detail");
    } : undefined;
    const entryToken = chatEntryRef.current;
    const replaceCurrentSession = (next: Session) => {
      if (currentNavigationRef.current.view !== "chat" || chatEntryRef.current !== entryToken
        || currentSessionRef.current?.id !== session.id || next.id !== session.id) return;
      currentSessionRef.current = next;
      setSession(next);
    };
    return <Chat key={`${session.id}:${entryToken}`} session={session} initialMessages={messages} provider={provider} harness={harness} features={features} externalError={error} navigationBusy={busy} onSessionChange={replaceCurrentSession} onProviderChange={setProvider} onHarnessChange={setHarness} onOpenPrivate={openPrivateSession} backLabel={returnToCampaign ? "← Back to campaign" : "← Library"} onBack={returnToCampaign ?? (async () => { await refreshLibrary().catch(() => undefined); goHome(); })} />;
  }

  return <Home characters={characters} sessions={sessions} selectedIds={selectedIds} primaryId={primaryId} busy={busy} error={error} provider={provider} campaignLibraryAvailable={campaignLibraryAvailable} onCampaigns={() => { setChatReturnCampaignId(""); setView("campaigns"); }} onSelected={(ids) => { setSelectedIds(ids); setPrimaryId((current) => ids.includes(current) ? current : ids[0] ?? ""); }} onPrimary={setPrimaryId} onCreate={() => { setActiveCharacterId(""); setError(null); setView("create"); }} onEdit={(id) => { setActiveCharacterId(id); setError(null); setView("edit"); }} onMemory={(id) => { setActiveCharacterId(id); setView("memory"); }} onLore={() => setView("lore")} onStart={createSelectedSession} onResume={(id) => void openSession(id)} onDeleteSession={async (item) => { if (!confirm(`Delete session “${item.title || item.participants.map((participant) => participant.name).join(", ")}”? Its messages and summary will be permanently removed.`)) return; setBusy(true); setError(null); try { await deleteSession(item.id); if (session?.id === item.id) { setSession(null); setMessages([]); setView("home"); } await refreshLibrary(); } catch (err) { setError(messageFor(err, "Could not delete session.")); } finally { setBusy(false); } }} onDelete={async (character) => { if (!confirm(`Delete ${character.name}? This cannot be undone.`)) return; setError(null); try { await deleteCharacter(character.id); setSelectedIds((ids) => ids.filter((id) => id !== character.id)); await refreshLibrary(); } catch (err) { setError(messageFor(err, "Could not delete character.")); } }} onExport={async (character) => { try { const data = await exportCharacter(character.id); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); link.download = `${character.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-velvet.json`; link.click(); URL.revokeObjectURL(link.href); } catch (err) { setError(messageFor(err, "Could not export character.")); } }} onImport={async (file) => { setError(null); try { const data: unknown = JSON.parse(await file.text()); await importCharacter(data); await refreshLibrary(); } catch (err) { setError(messageFor(err, "That file is not a valid Velvet character export.")); } }} />;
}

interface ChatProps { session: Session; initialMessages: ChatMessage[]; provider: ProviderSettings | null; harness: HarnessSettings | null; features: FeatureFlags; externalError: string | null; navigationBusy: boolean; onSessionChange: (session: Session) => void; onProviderChange: (provider: ProviderSettings) => void; onHarnessChange: (harness: HarnessSettings) => void; onOpenPrivate: (characterId: string) => Promise<void>; backLabel: string; onBack: () => void; }
function Chat({ session, initialMessages, provider, harness, features, externalError, navigationBusy, onSessionChange, onProviderChange, onHarnessChange, onOpenPrivate, backLabel, onBack }: ChatProps) {
  const [messages, setMessages] = useState(initialMessages); const [draft, setDraft] = useState(""); const [targetId, setTargetId] = useState(session.primaryCharacterId); const [sending, setSending] = useState(false); const [roomSending, setRoomSending] = useState(false); const [error, setError] = useState<string | null>(null); const [streamText, setStreamText] = useState(""); const [streamSpeakerId, setStreamSpeakerId] = useState(session.primaryCharacterId); const [swipeInfo, setSwipeInfo] = useState<SiblingsResponse | null>(null); const [settingsOpen, setSettingsOpen] = useState(false);
  const handleRef = useRef<StreamHandle | null>(null); const streamRef = useRef(""); const scrollRef = useRef<HTMLDivElement>(null);
  const [settingsWidth, setSettingsWidth] = useState(() => { const saved = Number(localStorage.getItem("velvet.settings.width")); return Number.isFinite(saved) && saved >= 320 ? saved : 440; });
  const [roomMaxSpeakers, setRoomMaxSpeakers] = useState(() => Math.min(4, session.participants.length));
  const [autoRoomRounds, setAutoRoomRounds] = useState(() => { const saved = Number(localStorage.getItem("velvet.room.autoRounds") ?? 1); return Number.isFinite(saved) ? Math.max(0, Math.min(3, saved)) : 1; });
  const [autoRunning, setAutoRunning] = useState(false);
  const stopAutoRef = useRef(false);
  const [contextBasket, setContextBasket] = useState<SessionContextBasket | null>(null);
  const [contextRevision, setContextRevision] = useState(0);
  const [overallUsage, setOverallUsage] = useState<UsageSummary | null>(null);
  const [sourceDraft, setSourceDraft] = useState(""); const [savingSource, setSavingSource] = useState(false); const sourceDialogRef = useRef<HTMLDialogElement>(null);
  const closed = session.state === "closed" || Boolean(session.stoppedAt);
  useEffect(() => { setMessages(initialMessages); }, [initialMessages]);
  useEffect(() => { if (!session.participants.some((item) => item.id === targetId)) setTargetId(session.primaryCharacterId); }, [session, targetId]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [messages, streamText]);
  useEffect(() => { try { localStorage.setItem("velvet.settings.width", String(settingsWidth)); } catch { /* optional UI preference */ } }, [settingsWidth]);
  useEffect(() => { try { localStorage.setItem("velvet.room.autoRounds", String(autoRoomRounds)); } catch { /* optional UI preference */ } }, [autoRoomRounds]);
  useEffect(() => { let current = true; void getSessionContext(session.id).then(({ context }) => { if (current) { setContextBasket(context); setSourceDraft(context.editableSource); } }).catch(() => undefined); return () => { current = false; }; }, [session.id, messages.length, contextRevision]);
  useEffect(() => { let current = true; void getUsage().then(({ usage }) => { if (current) setOverallUsage(usage); }).catch(() => undefined); return () => { current = false; }; }, [messages.length, contextRevision]);
  function resizeSettings(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault(); const startX = event.clientX; const startWidth = settingsWidth;
    const move = (next: PointerEvent) => setSettingsWidth(Math.max(320, Math.min(window.innerWidth * 0.6, startWidth + startX - next.clientX)));
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  }
  const speakerName = (id: string | null | undefined) => session.participants.find((item) => item.id === id)?.name ?? "Character";
  const speakerBubbleStyle = (id: string | null | undefined) => {
    const index = Math.max(0, session.participants.findIndex((participant) => participant.id === id));
    return { "--speaker-hue": String((258 + index * 137.508) % 360) } as CSSProperties;
  };
  const latestCharacter = useMemo(() => [...messages].reverse().find((item) => item.role === "character") ?? null, [messages]);
  const latestUserParent = useMemo(() => latestCharacter?.parentId ? messages.find((item) => item.id === latestCharacter.parentId && item.role === "user") ?? null : null, [latestCharacter, messages]);
  const usage = messages.reduce((total, item) => total + (item.usage?.totalTokens ?? 0), 0);
  const formatCost = (value: number | null) => value === null ? "Pricing not configured" : value > 0 && value < .0001 ? "< $0.0001" : `$${value.toFixed(4)}`;
  async function refreshSwipe(id: string) { try { setSwipeInfo(await getSiblings(session.id, id)); } catch { setSwipeInfo(null); } }
  async function saveSourceOfTruth() { if (navigationBusy) return; setSavingSource(true); setError(null); try { await updateSessionContext(session.id, sourceDraft); const { context } = await getSessionContext(session.id); setContextBasket(context); setSourceDraft(context.editableSource); sourceDialogRef.current?.close(); } catch (err) { setError(messageFor(err, "Could not save the scene source of truth.")); } finally { setSavingSource(false); } }
  function applyResult(result: { messages?: ChatMessage[]; reply: ChatMessage; session?: Session; providerError?: boolean }) { const branch = result.messages ?? [...messages, result.reply]; setMessages(branch); setContextRevision((revision) => revision + 1); if (result.session) onSessionChange(result.session); if (result.providerError) setError("The provider could not be reached, so a safe fallback reply was saved."); const parent = result.reply.parentId ? branch.find((item) => item.id === result.reply.parentId) : null; if (parent?.role === "user") void refreshSwipe(result.reply.id); else setSwipeInfo(null); }
  function finish() { setSending(false); setStreamText(""); streamRef.current = ""; handleRef.current = null; }
  const roomHandlers = () => ({
    onState: (next: Session | undefined) => { if (next) onSessionChange(next); },
    onReply: (reply: ChatMessage) => setMessages((current) => [...current, reply]),
    onDone: (result: { messages: ChatMessage[]; session?: Session; providerError?: boolean }) => { setMessages(result.messages); setContextRevision((revision) => revision + 1); if (result.session) onSessionChange(result.session); if (result.providerError) setError("One or more room replies used the safe provider fallback."); },
    onError: (text: string) => setError(text),
  });
  async function runAutomaticRounds(rounds: number) {
    if (rounds < 1) return;
    stopAutoRef.current = false; setAutoRunning(true);
    try {
      for (let round = 0; round < rounds && !stopAutoRef.current; round++) {
        await streamRoomContinuation(session.id, roomHandlers(), Math.min(roomMaxSpeakers, session.participants.length));
      }
    } finally { setAutoRunning(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); const content = draft.trim(); if (!content || sending || navigationBusy || closed) return; setError(null); setSending(true); setStreamSpeakerId(targetId); setDraft("");
    const roomTurn = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === "room";
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, sessionId: session.id, role: "user", speakerCharacterId: null, content, parentId: null, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]);
    if (roomTurn) {
      setRoomSending(true); let receivedUser = false;
      try {
        await streamRoomMessage(session.id, content, {
          onUserMessage: (message) => { receivedUser = true; setMessages((current) => current.map((item) => item.id === optimistic.id ? message : item)); },
          onState: (next) => { if (next) onSessionChange(next); },
          onReply: (reply) => setMessages((current) => [...current, reply]),
          onDone: (result) => { setMessages(result.messages); setContextRevision((revision) => revision + 1); if (result.session) onSessionChange(result.session); if (result.providerError) setError("One or more room replies used the safe provider fallback."); },
          onError: (text) => setError(text),
        }, Math.min(roomMaxSpeakers, session.participants.length));
        setSwipeInfo(null);
        await runAutomaticRounds(autoRoomRounds);
      } catch (err) {
        setError(messageFor(err, "Failed to send message to the room."));
        if (!receivedUser) setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      } finally { setRoomSending(false); setSending(false); }
      return;
    }
    if (provider?.streaming) {
      let receivedUser = false; const handle = streamMessage(session.id, content, targetId, { onUserMessage: (message) => { receivedUser = true; setMessages((current) => current.map((item) => item.id === optimistic.id ? message : item)); }, onDelta: (_seq, text) => { streamRef.current += text; setStreamText(streamRef.current); }, onState: (next) => { if (next) onSessionChange(next); }, onDone: (payload) => applyResult(payload), onBoundary: (payload) => { setStreamText(""); applyResult(payload); setError("The reply crossed the agreed boundaries, so a boundary-safe reply was saved instead."); }, onError: (text, violations) => { setError(violations.length ? `${text}: ${violations.join("; ")}` : text); if (!receivedUser) setMessages((current) => current.filter((item) => item.id !== optimistic.id)); } });
      handleRef.current = handle; try { await handle.done; } catch (err) { if (!(err instanceof Error && err.name === "AbortError")) { setError(messageFor(err, "Failed to send message.")); if (!receivedUser) setMessages((current) => current.filter((item) => item.id !== optimistic.id)); } } finally { finish(); } return;
    }
    try { applyResult(await sendMessage(session.id, content, targetId)); } catch (err) { setError(messageFor(err, "Failed to send message.")); setMessages((current) => current.filter((item) => item.id !== optimistic.id)); } finally { setSending(false); }
  }
  async function continueAs() { if (sending || navigationBusy || closed) return; setSending(true); setStreamSpeakerId(targetId); setError(null); try { applyResult(await continueSession(session.id, targetId)); } catch (err) { setError(messageFor(err, "Could not continue the scene.")); } finally { setSending(false); } }
  async function continueRoomTurn() { if (sending || navigationBusy || closed || session.participants.length < 2 || !latestCharacter) return; setSending(true); setRoomSending(true); setError(null); setSwipeInfo(null); try { await streamRoomContinuation(session.id, roomHandlers(), Math.min(roomMaxSpeakers, session.participants.length)); } catch (err) { setError(messageFor(err, "Could not give the room another turn.")); } finally { setRoomSending(false); setSending(false); } }
  async function regenerate() { if (!latestCharacter || !latestUserParent || sending || navigationBusy || closed) return; setSending(true); setStreamSpeakerId(targetId); setError(null); if (provider?.streaming) { const handle = streamSwipe(session.id, latestCharacter.id, targetId, { onDelta: (_seq, text) => { streamRef.current += text; setStreamText(streamRef.current); }, onDone: applyResult, onBoundary: (payload) => { applyResult(payload); setError("The reply crossed the agreed boundaries, so a boundary-safe reply was saved instead."); }, onError: (text) => setError(text) }); handleRef.current = handle; try { await handle.done; } catch (err) { if (!(err instanceof Error && err.name === "AbortError")) setError(messageFor(err, "Failed to regenerate reply.")); } finally { finish(); } } else { try { applyResult(await swipeMessage(session.id, latestCharacter.id, targetId)); } catch (err) { setError(messageFor(err, "Failed to regenerate reply.")); } finally { setSending(false); } } }
  async function retry() { if (!latestCharacter || !latestUserParent || sending || navigationBusy || closed) return; setSending(true); setError(null); try { applyResult(await branchMessage(session.id, latestCharacter.id, latestUserParent.content, targetId)); } catch (err) { setError(messageFor(err, "Failed to retry turn.")); } finally { setSending(false); } }
  async function navigateSwipe(direction: -1 | 1) { if (!swipeInfo || sending || navigationBusy) return; const sorted = [...swipeInfo.siblings].sort((a, b) => (a.swipeIndex ?? 0) - (b.swipeIndex ?? 0)); const active = swipeInfo.activeMessageId ?? latestCharacter?.id; const target = sorted[sorted.findIndex((item) => item.id === active) + direction]; if (!target) return; setSending(true); try { const data = await activateMessage(session.id, target.id); setMessages(data.messages); await refreshSwipe(target.id); } catch (err) { setError(messageFor(err, "Could not switch reply.")); } finally { setSending(false); } }
  const sortedSwipes = swipeInfo ? [...swipeInfo.siblings].sort((a, b) => (a.swipeIndex ?? 0) - (b.swipeIndex ?? 0)) : []; const activeSwipe = sortedSwipes.findIndex((item) => item.id === (swipeInfo?.activeMessageId ?? latestCharacter?.id));
  return <main className="chat-page"><section className={`chat-app ${settingsOpen ? "settings-visible" : ""}`} style={{ "--settings-width": `${settingsWidth}px` } as CSSProperties}>
    <div className="chat-main"><header className="chat-header"><div><button className="back-link" onClick={onBack}>{backLabel}</button><h1 className="chat-title">{session.title || session.participants.map((item) => item.name).join(" & ")}</h1><p className="chat-meta">{session.participants.map((item) => item.name).join(" · ")} · {session.state}</p><p className="chat-meta token-status">ACTIVE BRANCH // {usage.toLocaleString()} TOKENS{overallUsage ? ` · LIFETIME // ${overallUsage.totalTokens.toLocaleString()} TOKENS · ${formatCost(overallUsage.estimatedCostUsd)}` : ""}</p></div><div className="chat-actions">{handleRef.current && <button className="ghost" disabled={navigationBusy} onClick={() => { if (!navigationBusy) void handleRef.current?.cancel().finally(finish); }}>Stop generating</button>}<button className="ghost" disabled={navigationBusy} aria-expanded={settingsOpen} onClick={() => { if (!navigationBusy) setSettingsOpen((open) => !open); }}>Prompt & settings</button><button className="danger" disabled={closed || navigationBusy} onClick={() => { if (!navigationBusy) void stopSession(session.id).then(onSessionChange).catch((err) => setError(messageFor(err, "Could not end session."))); }}>End session</button></div></header>
      {overallUsage && <details className="usage-dashboard"><summary>Overall usage & estimated cost <span>{overallUsage.totalTokens.toLocaleString()} tokens · {formatCost(overallUsage.estimatedCostUsd)}</span></summary><div className="usage-totals"><div><strong>{overallUsage.promptTokens.toLocaleString()}</strong><small>Prompt tokens</small></div><div><strong>{overallUsage.completionTokens.toLocaleString()}</strong><small>Completion tokens</small></div><div><strong>{overallUsage.calls.toLocaleString()}</strong><small>Tracked calls</small></div><div><strong>{formatCost(overallUsage.estimatedCostUsd)}</strong><small>Estimated lifetime cost</small></div></div><p className="meta-text">{overallUsage.providerMeasuredTokens.toLocaleString()} provider-reported tokens · {overallUsage.estimatedTokens.toLocaleString()} locally estimated tokens. Cost uses ${overallUsage.pricing.promptPerMillion ?? "unset"}/M input and ${overallUsage.pricing.completionPerMillion ?? "unset"}/M output.</p><div className="usage-breakdowns"><section><h3>By operation</h3>{overallUsage.byKind.map((item) => <p key={item.kind}><span>{item.kind.replaceAll("_", " ")}</span><strong>{item.totalTokens.toLocaleString()} · {formatCost(item.estimatedCostUsd)}</strong></p>)}</section><section><h3>By model</h3>{overallUsage.byModel.map((item) => <p key={item.model}><span>{item.model}</span><strong>{item.totalTokens.toLocaleString()} · {formatCost(item.estimatedCostUsd)}</strong></p>)}</section><section><h3>Top sessions</h3>{overallUsage.bySession.slice(0, 8).map((item) => <p key={item.sessionId}><span>{item.title || "Untitled session"}</span><strong>{item.totalTokens.toLocaleString()} · {formatCost(item.estimatedCostUsd)}</strong></p>)}</section></div></details>}
      {closed && <p className="closed-banner">This session is closed{session.stopReason ? ` (${session.stopReason})` : ""}. You can read its history, but it is no longer writable.</p>}
      {contextBasket && <details className="context-basket" open><summary>Shared context basket <span>{contextBasket.recentEvents.length + contextBasket.rememberedFacts.length + contextBasket.activeLore.length} elements</span></summary><div className="source-truth"><div><span className="eyebrow">AUTHORITATIVE SCENE · LIVE</span><p>{contextBasket.sourceOfTruth}</p><div className="source-timestamps">{contextBasket.sourceUpdatedAt && <small>Manual canon updated {new Date(contextBasket.sourceUpdatedAt).toLocaleString()}</small>}{contextBasket.synthesizedUpdatedAt && <small>Scene facts synthesized {new Date(contextBasket.synthesizedUpdatedAt).toLocaleString()}</small>}</div></div><button className="primary small" disabled={navigationBusy} onClick={() => { if (!navigationBusy) { setSourceDraft(contextBasket.editableSource); sourceDialogRef.current?.showModal(); } }}>Edit manual canon</button></div><div className="context-grid"><section><h3>Participants</h3>{contextBasket.participants.map((participant) => <p key={participant.id}><strong>{participant.name}</strong> · {participant.archetype}</p>)}</section><section><h3>Recent events</h3>{contextBasket.recentEvents.length ? contextBasket.recentEvents.map((event, index) => <p key={index}>{event}</p>) : <p className="meta-text">No events yet.</p>}</section><section><h3>Remembered facts</h3>{contextBasket.rememberedFacts.length ? contextBasket.rememberedFacts.map((fact, index) => <p key={index}>{fact}</p>) : <p className="meta-text">No approved shared memories.</p>}</section><section><h3>Active lore & threads</h3>{contextBasket.activeLore.map((entry, index) => <p key={`lore-${index}`}>{entry}</p>)}{contextBasket.openThreads.map((thread, index) => <p key={`thread-${index}`}>Open: {thread}</p>)}{!contextBasket.activeLore.length && !contextBasket.openThreads.length && <p className="meta-text">Nothing active.</p>}</section></div></details>}
      <dialog className="scene-dialog" ref={sourceDialogRef} onClose={() => setSourceDraft(contextBasket?.editableSource ?? "")}><form method="dialog" onSubmit={(event) => { event.preventDefault(); void saveSourceOfTruth(); }}><fieldset disabled={navigationBusy}><div className="dialog-heading"><div><p className="eyebrow">SOURCE OF TRUTH</p><h2>Current situation and scene</h2></div><button type="button" className="ghost small" onClick={() => sourceDialogRef.current?.close()}>Close</button></div><p className="meta-text">Edit the highest-priority manual canon. A factual scene synthesizer separately updates locations, conditions, objects, relationships, knowledge, goals, and tensions after completed turns.</p><label className="field"><span>Manual scene canon</span><textarea autoFocus rows={12} maxLength={8000} value={sourceDraft} onChange={(event) => setSourceDraft(event.target.value)} placeholder="Example: It is late evening in the observatory. Mara stands beside the western window, still holding the brass key. Jules knows the door is locked but does not know why…" /></label><div className="dialog-actions"><span className="meta-text">{sourceDraft.length.toLocaleString()} / 8,000</span><button type="submit" className="primary" disabled={savingSource}>{savingSource ? "Saving…" : "Save manual canon"}</button></div></fieldset></form></dialog>
      <div className="messages" ref={scrollRef} role="log" aria-live="polite" aria-busy={sending}>{messages.length === 0 && <p className="empty-state">The scene is ready. Write the opening message or choose “Continue as…” for a character-led opening.</p>}{messages.map((item) => <div className={`message message-${item.role}`} style={item.role === "character" ? speakerBubbleStyle(item.speakerCharacterId) : undefined} key={item.id}><span className="message-role">{item.role === "user" ? "You" : item.role === "system" ? "System" : speakerName(item.speakerCharacterId)}</span><p>{item.content}</p>{item.usage && <span className="message-usage">{item.usage.source === "estimated" ? "≈" : ""}{item.usage.totalTokens.toLocaleString()} tokens · {item.usage.promptTokens.toLocaleString()} in / {item.usage.completionTokens.toLocaleString()} out</span>}</div>)}{sending && !roomSending && <div className="message message-character message-streaming" style={speakerBubbleStyle(streamSpeakerId)}><span className="message-role">{speakerName(streamSpeakerId)}</span><p>{streamText || "…"}</p></div>}{roomSending && <div className="message message-system room-thinking"><span className="message-role">Room</span><p>Choosing the next speaker…</p></div>}</div>
      {latestCharacter && latestUserParent && <div className="swipe-controls">{sortedSwipes.length > 0 && <><button className="ghost" aria-label="Previous reply" disabled={sending || navigationBusy || activeSwipe <= 0} onClick={() => void navigateSwipe(-1)}>‹ Prev</button><span className="swipe-position">{activeSwipe + 1}/{sortedSwipes.length}</span><button className="ghost" aria-label="Next reply" disabled={sending || navigationBusy || activeSwipe >= sortedSwipes.length - 1} onClick={() => void navigateSwipe(1)}>Next ›</button></>}<button className="ghost" aria-label="Regenerate reply" disabled={sending || navigationBusy || closed} onClick={() => void regenerate()}>Regenerate</button><button className="ghost" aria-label="Retry last turn" disabled={sending || navigationBusy || closed} onClick={() => void retry()}>Retry</button></div>}
      {(error || externalError) && <p className="error" role="alert">{error || externalError}</p>}
      <div className="speaker-controls"><label className="field"><span>Target speaker</span><select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={closed || sending || navigationBusy}>{session.participants.map((item) => <option value={item.id} key={item.id}>{item.name}{item.id === session.primaryCharacterId ? " · primary" : ""}</option>)}</select></label>{session.participants.length > 1 && <><label className="field compact-control"><span>Max room responders</span><select aria-label="Max room responders" value={roomMaxSpeakers} disabled={sending || navigationBusy} onChange={(event) => setRoomMaxSpeakers(Number(event.target.value))}>{Array.from({ length: Math.min(6, session.participants.length) }, (_, index) => index + 1).map((count) => <option value={count} key={count}>{count}</option>)}</select></label><label className="field compact-control"><span>Auto follow-up rounds</span><select aria-label="Auto follow-up rounds" value={autoRoomRounds} disabled={sending || navigationBusy} onChange={(event) => setAutoRoomRounds(Number(event.target.value))}><option value={0}>Off</option><option value={1}>1 round</option><option value={2}>2 rounds</option><option value={3}>3 rounds</option></select></label></>}{session.participants.length > 1 && <button className="ghost continue-button" disabled={sending || savingSource || settingsOpen || navigationBusy} onClick={() => void onOpenPrivate(targetId)}>Private chat with {speakerName(targetId)}</button>}{session.participants.length > 1 && <button className="ghost continue-button" disabled={closed || sending || navigationBusy || !latestCharacter} onClick={() => void continueRoomTurn()}>Give room another turn</button>}<button className="ghost continue-button" disabled={closed || sending || navigationBusy} onClick={() => void continueAs()}>Continue as {speakerName(targetId)}</button></div>
      {session.participants.length > 1 && <p className="room-cost">Current room automation limit: up to {(2 + roomMaxSpeakers) * (1 + autoRoomRounds)} provider calls per room message ({roomMaxSpeakers} replies, routing, and one scene-state update per round).</p>}
      {autoRunning && <div className="auto-room-status"><span>Automatic room conversation is running. It will stop after this bounded turn.</span><button className="danger subtle small" disabled={navigationBusy} onClick={() => { if (!navigationBusy) stopAutoRef.current = true; }}>Stop auto chat</button></div>}
      <form className="composer" onSubmit={send}><label className="sr-only" htmlFor="chat-message">Message for {speakerName(targetId)}</label><input id="chat-message" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={closed ? "Session ended" : "Write a message…"} disabled={closed || sending || navigationBusy} maxLength={1000} />{session.participants.length > 1 && <button type="submit" value="room" className="ghost" disabled={closed || sending || navigationBusy || !draft.trim()} title="Let the room choose up to six pertinent speakers">Send to room</button>}<button type="submit" value="target" className="primary" disabled={closed || sending || navigationBusy || !draft.trim()}>Send to {speakerName(targetId)}</button></form>
    </div>
    <div className="settings-separator" role="separator" aria-label="Resize settings pane" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={Math.round(window.innerWidth * .6)} aria-valuenow={Math.round(settingsWidth)} onPointerDown={(event) => { if (!navigationBusy) resizeSettings(event); }} onKeyDown={(event) => { if (navigationBusy) return; if (event.key === "ArrowLeft") setSettingsWidth((width) => Math.min(window.innerWidth * .6, width + (event.shiftKey ? 64 : 16))); if (event.key === "ArrowRight") setSettingsWidth((width) => Math.max(320, width - (event.shiftKey ? 64 : 16))); }} tabIndex={settingsOpen && !navigationBusy ? 0 : -1} />
    <aside className="settings-pane" aria-hidden={!settingsOpen}><fieldset disabled={navigationBusy}><PromptSettings provider={provider} harness={harness} features={features} onProviderChange={onProviderChange} onHarnessChange={onHarnessChange} onClose={() => setSettingsOpen(false)} /></fieldset></aside>
  </section></main>;
}

export function RuntimeSettings({ provider, harness, features, onProviderChange, onHarnessChange }: { provider: ProviderSettings | null; harness: HarnessSettings | null; features: FeatureFlags; onProviderChange: (value: ProviderSettings) => void; onHarnessChange: (value: HarnessSettings) => void }) {
  const [status, setStatus] = useState<string | null>(null);
  return <section className="runtime-settings"><p className="notice">Changes apply to the next reply. Voice: {features.voice ? "ready" : "not configured"} · Images: {features.images ? "ready" : "not configured"}.</p><div className="runtime-settings-grid">{harness && <><label className="field runtime-system-prompt"><span>System prompt</span><textarea rows={5} value={harness.systemPrompt} onChange={(e) => onHarnessChange({ ...harness, systemPrompt: e.target.value })} /></label><label className="field"><span>Temperature</span><input type="number" min={0} max={2} step={0.1} value={harness.temperature ?? ""} onChange={(e) => onHarnessChange({ ...harness, temperature: e.target.value === "" ? null : Number(e.target.value) })} /></label><button className="primary" onClick={() => void updateHarness({ systemPrompt: harness.systemPrompt, temperature: harness.temperature }).then((value) => { onHarnessChange(value); setStatus("Prompt settings saved."); }).catch((err) => setStatus(messageFor(err, "Could not save settings.")))}>Save prompt settings</button></>}{provider && <><label className="field"><span>Streaming</span><select value={provider.streaming ? "yes" : "no"} onChange={(e) => onProviderChange({ ...provider, streaming: e.target.value === "yes" })}><option value="yes">On</option><option value="no">Off</option></select></label><label className="field"><span>Maximum reply tokens</span><input type="number" min={1} max={32768} value={provider.samplers.maxTokens ?? ""} onChange={(e) => onProviderChange({ ...provider, samplers: { ...provider.samplers, maxTokens: e.target.value ? Number(e.target.value) : null } })} /></label><button className="primary" onClick={() => void updateProvider({ streaming: provider.streaming, samplers: { maxTokens: provider.samplers.maxTokens } }).then((value) => { onProviderChange(value); setStatus("Generation settings saved."); }).catch((err) => setStatus(messageFor(err, "Could not save settings.")))}>Save generation settings</button></>}{status && <p className="notice runtime-status">{status}</p>}</div></section>;
}

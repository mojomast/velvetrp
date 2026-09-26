import { useEffect, useRef, useState } from "react";
import { campaignAdministrationHttpPatchRequestSchema, sessionZeroSafetyUpdateCommandSchema, type SessionZeroSafetyUpdateCommand } from "@velvet/contracts";
import { ApiError, attachCampaignRoom, campaignStartup, getCampaignAdministration, getCampaignAdministrationIntegrations, getCampaignDetail, listCampaignCharacters, listCampaignRooms, setupMechanicsStarter, setupOriginalStarter, setupSrd51Starter, startSession, updateCampaignAdministration, updateCampaignSessionZeroSafety } from "../../../api";
import { useCampaignShell } from "../shell/CampaignShell";
import { createClientId } from "../../../utils/clientId";

type Snapshot = { detail: Awaited<ReturnType<typeof getCampaignDetail>>; administration: Awaited<ReturnType<typeof getCampaignAdministration>>; integrations: Awaited<ReturnType<typeof getCampaignAdministrationIntegrations>>; rooms: Awaited<ReturnType<typeof listCampaignRooms>>; party: Awaited<ReturnType<typeof listCampaignCharacters>> };
type Command = { kind: "safety"; input: SessionZeroSafetyUpdateCommand } | { kind: "publish" | "complete"; input: Parameters<typeof updateCampaignAdministration>[1] } | { kind: "setup" | "attach" | "create" };
// A remount must not issue a second request while the original is in flight.
const writing = new Set<string>();
const stages = ["Rules", "Safety", "Publication", "Rooms"] as const;

export function CampaignPreparation({ campaignId, mechanics, initialStage, onRead, onBuilder }: { campaignId: string; mechanics: boolean; initialStage: number; onRead: (snapshot: Snapshot) => void; onBuilder: () => void }) {
  const key = `velvet.preparation.v1:${campaignId}`;
  const [saved, setSaved] = useState<Command | null>(null), [storageError, setStorageError] = useState(false);
  const [data, setData] = useState<Snapshot | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [stage, setStage] = useState(initialStage), [confirmed, setConfirmed] = useState(false), [reconciled, setReconciled] = useState(false);
  const [choice, setChoice] = useState(""), [title, setTitle] = useState(""), [participants, setParticipants] = useState<string[]>([]);
  const [roomConfirmed, setRoomConfirmed] = useState(false);
  const [safety, setSafety] = useState<SessionZeroSafetyUpdateCommand | null>(null);
  const [limitsText, setLimitsText] = useState(""), [veilsText, setVeilsText] = useState("");
  const alive = useRef(false), lock = useRef(false), onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const { blockNavigation, navigate } = useCampaignShell();
  useEffect(() => { blockNavigation(busy); return () => blockNavigation(false); }, [busy, blockNavigation]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    if (busy) window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  useEffect(() => {
    alive.current = true;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const command = JSON.parse(raw) as Command;
        if (command.kind === "safety") setSaved({ kind: "safety", input: sessionZeroSafetyUpdateCommandSchema.parse(command.input) });
        else if (command.kind === "publish" || command.kind === "complete") {
          const input = campaignAdministrationHttpPatchRequestSchema.parse(command.input);
          if ((command.kind === "publish" ? input.status !== "published" : input.status !== "completed") || input.settings !== undefined) throw new Error("Invalid lifecycle recovery");
          setSaved({ kind: command.kind, input });
        } else if (["setup", "attach", "create"].includes(command.kind)) setSaved({ kind: command.kind });
        else throw new Error("Invalid recovery record");
      }
    } catch { setStorageError(true); }
    void read();
    return () => { alive.current = false; };
  }, [campaignId]);

  async function read() {
    if (lock.current || writing.has(campaignId)) { setNotice("A preparation write is still in flight. Read current preparation after it settles."); return; }
    lock.current = true; setBusy(true); setConfirmed(false); setRoomConfirmed(false); setReconciled(false);
    try {
      const [detail, administration, integrations, rooms, party] = await Promise.all([getCampaignDetail(campaignId), getCampaignAdministration(campaignId), getCampaignAdministrationIntegrations(campaignId), listCampaignRooms(campaignId), listCampaignCharacters(campaignId)]);
      if (!alive.current) return;
      const snapshot = { detail, administration, integrations, rooms, party };
      setData(snapshot); onReadRef.current(snapshot);
      const { revision, paused: _paused, ...policy } = integrations.safety;
      setSafety({ ...policy, expectedRevision: revision, idempotencyKey: "review-only" });
      setLimitsText(policy.hardLimits.join("\n")); setVeilsText(policy.veils.join("\n"));
      setParticipants([]); setReconciled(true);
      setNotice("Current preparation read. No write was repeated. A current state is not proof of an earlier command receipt.");
    } catch { if (alive.current) { setData(null); setNotice("Preparation could not be read. No permissions, safety settings or readiness are assumed. Retry the read."); } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }

  async function write(command: Command, operation?: () => Promise<unknown>, startupSessionId?: string) {
    if (lock.current || writing.has(campaignId) || storageError || !data) return;
    const role = data.detail.campaign.actorRole;
    const owner = role === "owner" && data.administration.campaign.actorRole === "owner";
    const gm = (role === "owner" || role === "gm") && ["owner", "gm"].includes(data.integrations.actorRole);
    if ((command.kind === "publish" || command.kind === "complete" || command.kind === "setup") ? !owner : !gm) return;
    if (!saved && !(command.kind === "create" ? roomConfirmed : confirmed)) return;
    try { localStorage.setItem(key, JSON.stringify(command)); }
    catch { setStorageError(true); setNotice("Safe recovery storage is unavailable. Nothing was sent."); return; }
    const retry = saved !== null;
    lock.current = true; writing.add(campaignId); setBusy(true); setSaved(command); setReconciled(false); setConfirmed(false); setRoomConfirmed(false);
    let startupNotice: string | null = null;
    try {
      if (command.kind === "safety") await updateCampaignSessionZeroSafety(campaignId, command.input);
      else if (command.kind === "publish" || command.kind === "complete") {
        const result = await updateCampaignAdministration(campaignId, command.input);
        if (command.kind === "complete" && alive.current) setNotice(`Campaign marked completed. Receipt confirmed at revision ${result.receipt.revisionAfter}.`);
      }
      else if (operation) {
        await operation();
        // Room operations reach this line with both identifiers known after the
        // write settles. This is the documented invocation point for the
        // idempotent `campaignStartup` command (see api.ts): once the campaign's
        // first room is attached, the freshly created campaign is ready for its
        // one startup call. Attaching an additional room to a campaign that
        // already has attached rooms never starts it, so a live campaign under
        // playtest is never mutated.
        if (command.kind === "attach" && startupSessionId && data.rooms.attached.length === 0) {
          startupNotice = await firstRoomStartupNotice(startupSessionId);
        }
      }
      else throw new Error("This operation cannot be retried");
      localStorage.removeItem(key);
      if (alive.current) { setSaved(null); setData(null); if (command.kind !== "complete") setNotice(startupNotice ?? "Server response confirmed. Read current preparation before the next step."); }
    } catch (error) {
      // Only a first, definitive rejection can release an exact command.
      // Starter setup spans transactions and may leave catalog changes behind.
      const rejected = !retry && (command.kind === "safety" || command.kind === "publish" || command.kind === "complete") && error instanceof ApiError && [400, 403, 404, 409, 415, 422].includes(error.status);
      if (rejected) localStorage.removeItem(key);
      if (alive.current) { if (rejected) setSaved(null); setNotice(rejected ? "Command rejected. Read current preparation and review again; no retry was made." : "Write outcome uncertain. Read current preparation. Only revision-bound commands offer exact retry; creation, attachment and starter setup are never repeated automatically."); setData(null); }
    } finally { writing.delete(campaignId); lock.current = false; if (alive.current) setBusy(false); }
  }

  /**
   * Runs the one idempotent first-room startup and never throws: the attach has
   * already succeeded, so a blocked or failed startup must not be reported as an
   * uncertain attach. Blockers and unexpected errors surface through the same
   * status notice the rest of the component uses; no retry is issued here.
   */
  async function firstRoomStartupNotice(sessionId: string): Promise<string | null> {
    try {
      const summary = await campaignStartup(campaignId, sessionId);
      return summary.blockers.length ? `Room attached, but campaign startup is blocked: ${summary.blockers.join("; ")}` : null;
    } catch (error) {
      if (!(error instanceof ApiError)) console.error("Campaign startup failed after the first room attach", error);
      return "Room attached, but campaign startup did not complete. The campaign was not otherwise changed.";
    }
  }

  const owner = data?.detail.campaign.actorRole === "owner" && data.administration.campaign.actorRole === "owner";
  const privileged = data && ["owner", "gm"].includes(data.detail.campaign.actorRole) && ["owner", "gm"].includes(data.integrations.actorRole);
  const locked = busy || !!saved || storageError;
  const configured = data?.detail.campaign.content.status === "configured";
  const status = data?.administration.campaign.status;
  const editable = status !== "archived" && status !== "completed";
  const reviewedSafety = safety && { ...safety, hardLimits: limitsText.split("\n").map(line => line.trim()).filter(Boolean), veils: veilsText.split("\n").map(line => line.trim()).filter(Boolean) };
  const safetyValid = reviewedSafety && sessionZeroSafetyUpdateCommandSchema.safeParse(reviewedSafety).success;
  return <section className="entry-preparation" aria-labelledby="preparation-heading" data-testid="campaign-preparation">
    <h2 id="preparation-heading" tabIndex={-1}>Prepare your table</h2>
    <nav aria-label="Preparation stages">{stages.map((label, index) => <button key={label} disabled={busy} aria-current={stage === index ? "step" : undefined} onClick={() => { setStage(index); setConfirmed(false); }}>{index + 1}. {label}</button>)}</nav>
    <button disabled={busy} onClick={() => void read()}>Read current preparation</button>
    {notice && <p role="status">{notice}</p>}
    {storageError && <p role="alert">Recovery storage is unavailable or invalid. Writes are blocked; do not discard an unresolved command.</p>}
    {saved && <aside className="entry-recovery" role="alert"><h3>Resolve the earlier {saved.kind} attempt</h3><p>Reading never repeats a write. Review attached and available rooms before deciding whether a new room is needed. A matching title alone does not identify a creation receipt.</p>
      {(saved.kind === "safety" || saved.kind === "publish" || saved.kind === "complete") ? <button disabled={busy || !data || !((saved.kind === "publish" || saved.kind === "complete") ? owner : privileged)} onClick={() => void write(saved)}>Retry exact {saved.kind} command</button> : <button disabled={busy || !reconciled || !data} onClick={() => { try { localStorage.removeItem(key); setSaved(null); setNotice("Current state reviewed. Earlier outcome remains unattributed. Any further submission is a new, explicitly confirmed operation, not a retry."); } catch { setStorageError(true); } }}>I reviewed current state; allow a new decision</button>}
    </aside>}
    {data && <>
      {!privileged && <p>Only the owner or GM can prepare rooms and safety. Ask your DM to complete these steps.</p>}
      {!editable && <p>This campaign is {status}. Normal setup writes are unavailable.</p>}
      {stage === 0 && <div><h3>Choose your campaign rules</h3>{configured ? <><p>Rules and content are configured and will not be replaced here.</p><button onClick={() => { setStage(1); setConfirmed(false); }}>Next: review table safety</button></> : <><p>Choose one starter. Setup installs its fixed content; mechanics starters also publish their catalog. It does not publish this campaign or start a room.</p>{!owner && <p>Only the campaign owner can configure starter content.</p>}<fieldset disabled={locked || !owner || !editable}><legend>Starter rules</legend><label>Rules package<select value={choice} onChange={event => { setChoice(event.target.value); setConfirmed(false); }}><option value="">Choose a rules package</option>{mechanics && <><option value="srd">SRD 5.1</option><option value="mechanics">Velvet mechanics</option></>}<option value="original">Original narrative starter</option></select></label><p>Original is narrative-only. Choose a mechanics starter for the character builder and tactical play.</p><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I confirm this starter installation and its catalog publication where applicable.</label><button disabled={!choice || !confirmed} onClick={() => void write({ kind: "setup" }, () => (choice === "srd" ? setupSrd51Starter : choice === "mechanics" ? setupMechanicsStarter : setupOriginalStarter)(campaignId))}>Install selected starter once</button></fieldset></>}</div>}
      {stage === 1 && safety && <div>
        <h3>Agree on table safety</h3>
        <p>These are the server's current settings, not suggested defaults. Review with your group. The server retains existing limits and the stricter policies when saving; this form cannot remove a boundary or loosen a policy. Saving never changes the paused state.</p>
        <p>{data.integrations.safety.paused ? "Safety is paused. Resume requires a separate reviewed action in Manage; publication will not resume safety." : "Safety is not paused."}</p>
        {data.integrations.safety.paused && navigate && <button disabled={locked} onClick={() => navigate("manage")}>Review safety pause in Manage</button>}
        <fieldset disabled={locked || !privileged || !editable}>
          <legend>Current agreement</legend>
          <label>Hard limits, one per line<textarea rows={3} value={limitsText} onChange={event => { setLimitsText(event.target.value); setConfirmed(false); }} /></label>
          <label>Veils, one per line<textarea rows={3} value={veilsText} onChange={event => { setVeilsText(event.target.value); setConfirmed(false); }} /></label>
          {(["pvpPolicy", "romancePolicy", "lethalityPolicy"] as const).map(field => <label key={field}>
            {field === "pvpPolicy" ? "Player-versus-player policy" : field === "romancePolicy" ? "Romance policy" : "Character lethality policy"}
            <select value={safety[field]} onChange={event => { setSafety({ ...safety, [field]: event.target.value }); setConfirmed(false); }}>
              {(field === "lethalityPolicy" ? ["nonlethal-default", "consent-required", "rules-as-written"] : ["disallowed", "fade-to-black", "explicit-consent", "allowed"]).map(policy => <option key={policy} value={policy}>{policy.replaceAll("-", " ")}</option>)}
            </select>
          </label>)}
          <p>Up to 32 boundaries per list, 200 characters each. Blank lines are ignored. Empty lists do not erase existing limits or establish consent.</p>
          {!safetyValid && <p role="alert">Use at most 32 boundaries per list, each no longer than 200 characters.</p>}
          <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I reviewed the complete agreement with the table and confirm saving it.</label>
          <button disabled={!confirmed || !safetyValid} onClick={() => void write({ kind: "safety", input: sessionZeroSafetyUpdateCommandSchema.parse({ ...reviewedSafety, idempotencyKey: createClientId() }) })}>Save reviewed safety agreement</button>
        </fieldset>
        <button disabled={busy} onClick={() => { setStage(2); setConfirmed(false); }}>Next: review publication</button>
      </div>}
      {stage === 2 && <div><h3>Make the campaign available for play</h3><p>Campaign status: {status}. Publication changes campaign availability. It does not approve AI drafts, publish generated materials, clear a safety pause or start any room.</p>{status === "published" ? <><button onClick={() => { setStage(3); setConfirmed(false); }}>Next: connect a room</button>{owner && <fieldset disabled={locked}><legend>Complete this campaign</legend><p>Completion ends normal campaign play. This cannot be undone here.</p><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I confirm that this published campaign is complete.</label><button disabled={!confirmed} onClick={() => void write({ kind: "complete", input: { expectedRevision: data.administration.campaign.revision, idempotencyKey: createClientId(), status: "completed" } })}>Mark campaign complete</button></fieldset>}</> : <fieldset disabled={locked || !owner || !configured || !["draft", "paused"].includes(status ?? "")}><legend>Explicit publication</legend>{!owner && <p>Only the campaign owner can publish or resume the campaign.</p>}<label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I reviewed the rules and safety agreement and confirm making this campaign available for play.</label><button disabled={!confirmed} onClick={() => void write({ kind: "publish", input: { expectedRevision: data.administration.campaign.revision, idempotencyKey: createClientId(), status: "published" } })}>{status === "paused" ? "Resume campaign publication" : "Publish campaign"}</button></fieldset>}</div>}
      {stage === 3 && <div><h3>Connect your session</h3><p>Create a room from campaign personas, then attach it explicitly from the available list. Neither action activates gameplay.</p><h4>Attached rooms</h4>{data.rooms.attached.length ? <ul>{data.rooms.attached.map(room => <li key={room.sessionId}>{room.title ?? "Untitled room"} / {room.participantNames.join(", ")}</li>)}</ul> : <p>No rooms attached.</p>}<h4>Available rooms</h4>{!data.rooms.eligible.length && <p>No eligible rooms found.</p>}<fieldset disabled={locked || !privileged || !editable}><legend>Attach an existing room</legend><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I confirm the selected room operation.</label>{data.rooms.eligible.map(room => <article key={room.sessionId}><p>{room.title ?? "Untitled room"} / {room.participantNames.join(", ")}</p><button disabled={!confirmed} onClick={() => void write({ kind: "attach" }, () => attachCampaignRoom(campaignId, { sessionId: room.sessionId }), room.sessionId)}>Attach {room.title ?? "untitled room"}</button></article>)}</fieldset>
      <details>
        <summary>Create a new room</summary>
        <p>Creation has no idempotency/retry contract. If its response is lost, inspect available and attached rooms; do not automatically create a duplicate.</p>
        <fieldset disabled={locked || !privileged || !editable}>
          <legend>Room participants</legend>
          <label>Room title<input value={title} maxLength={200} onChange={event => { setTitle(event.target.value); setRoomConfirmed(false); }} /></label>
          {data.party.characters.map(actor => <label key={actor.id}><input type="checkbox" checked={participants.includes(actor.characterId)} onChange={event => { setParticipants(event.target.checked ? [...participants, actor.characterId] : participants.filter(id => id !== actor.characterId)); setRoomConfirmed(false); }} />{actor.name}</label>)}
          <p>Select up to 12 participants. The first selected persona is the primary participant. All participants need finalized campaign actors before activation.</p>
          <label><input type="checkbox" checked={roomConfirmed} onChange={event => setRoomConfirmed(event.target.checked)} /> I confirm the selected room operation.</label>
          <button disabled={!roomConfirmed || !participants.length || participants.length > 12 || !title.trim()} onClick={() => void write({ kind: "create" }, () => startSession({ characterIds: participants, primaryCharacterId: participants[0]!, title: title.trim() }))}>Create room once</button>
        </fieldset>
      </details>
      {!data.party.characters.length && mechanics && configured && privileged && <button disabled={locked} onClick={onBuilder}>Build a room participant</button>}
      </div>}
    </>}
  </section>;
}

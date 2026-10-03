import { useCallback, useEffect, useRef, useState } from "react";
import { campaignRoomActivationRequestSchema, type CampaignRoomActivationReadiness, type CampaignRoomActivationRequest } from "@velvet/contracts";
import { getCampaignDetail, listCampaignCharacters, listCampaignRooms } from "../../../api";
import { useCampaignShell } from "../shell/CampaignShell";
import { activateRoom, ActivationHttpError, getActivationReadiness } from "./activationApi";
import { CampaignPreparation } from "./CampaignPreparation";
import "./overview.css";
import { createClientId } from "../../../utils/clientId";

type Data = { campaign: Awaited<ReturnType<typeof getCampaignDetail>>["campaign"]; party: Awaited<ReturnType<typeof listCampaignCharacters>>["characters"]; rooms: Awaited<ReturnType<typeof listCampaignRooms>>["attached"] };
export function CampaignOverviewPage({ campaignId, destination, mechanics, onAdvanced, onBuilder, onCharacter, onRoom, roomPending, roomError, refreshRequest }: {
  campaignId: string; destination: "overview" | "rooms" | "party"; mechanics: boolean;
  onAdvanced: () => void; onBuilder: () => void; onCharacter: (id: string) => void; onRoom: (id: string) => void;
  roomPending?: boolean; roomError?: string; refreshRequest?: number;
}) {
  const { report, navigate } = useCampaignShell();
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(false), [revision, setRevision] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const sessionsHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let current = true, generation = 0;
    // A focus refresh keeps the current snapshot and any open preparation drafts mounted.
    // Only the first read may show the loading surface or clear the shell identity.
    const refresh = (background = false) => {
      const request = ++generation;
      if (!background) { setData(null); setError(false); report(null); }
      void Promise.all([getCampaignDetail(campaignId), listCampaignCharacters(campaignId), listCampaignRooms(campaignId)])
        .then(([detail, party, rooms]) => { if (current && request === generation) { setData({ campaign: detail.campaign, party: party.characters, rooms: rooms.attached }); report(detail.campaign); } })
        .catch(() => { if (current && request === generation && !background) setError(true); });
    };
    refresh();
    const onFocus = () => refresh(true);
    window.addEventListener("focus", onFocus);
    return () => { current = false; window.removeEventListener("focus", onFocus); };
  }, [campaignId, report, revision, refreshRequest]);
  const heading = destination === "overview" ? "Campaign overview" : destination === "rooms" ? "Rooms" : "Party";
  if (!data) return <main className="campaign-entry"><h1>{heading}</h1>{error ? <div role="alert"><p>Campaign workspace could not be read. No readiness is assumed.</p><button onClick={() => setRevision(value => value + 1)}>Retry workspace read</button></div> : <p role="status">Reading campaign, party and sessions...</p>}<button onClick={onAdvanced}>Open advanced setup</button></main>;
  const privileged = data.campaign.actorRole === "owner" || data.campaign.actorRole === "gm";
  const configured = data.campaign.content.status === "configured";
  const hasTable = data.party.length > 0 && data.rooms.length > 0;
  const showSessions = () => {
    sessionsHeading.current?.focus();
    sessionsHeading.current?.scrollIntoView?.({ block: "start" });
  };
  return <main className="campaign-entry" data-testid={`campaign-${destination}`}>
    <header><p className="entry-kicker">{data.campaign.name} / At your table</p><h1 tabIndex={-1}>{heading}</h1><p>{destination === "overview" ? "A hero, a room, a story worth telling. Your next chapter begins at the table." : destination === "rooms" ? "Choose a room and take your place at the table." : "The people who carry this story. Open a character to review their sheet."}</p></header>
    {destination === "overview" && <>
      <section className="entry-next" aria-labelledby="entry-next-heading">
        <p className="entry-kicker">Your next step</p>
        <h2 id="entry-next-heading">{hasTable ? "Gather your party and play" : !configured ? "Choose your campaign rules" : !data.party.length ? "Build your first party member" : "Connect a session to your campaign"}</h2>
        <p>{hasTable ? "Choose a session below to continue your story. Enter your room when it is ready, then describe what your hero does next." : !configured ? "Select starter rules here, then review safety and publication. Only the owner can install content." : !data.party.length ? "Create a hero to bring to the table. Your character sheet holds their abilities and the details that make them yours." : "Give your party a place to play. Connect a room, then enter it together when preparation is complete."}</p>
        <div className="entry-actions">
          {hasTable && <button className="entry-primary" onClick={showSessions}>Go to Sessions</button>}
          {privileged && <button className={hasTable ? "entry-secondary" : "entry-primary"} onClick={() => setPreparing(true)}>Continue preparation</button>}
        </div>
        {!privileged && !hasTable && <p>Ask your DM to complete campaign preparation. You can review your party and attached rooms.</p>}
        <dl className="entry-facts"><div><dt>Party members</dt><dd>{data.party.length}</dd></div><div><dt>Sessions</dt><dd>{data.rooms.length}</dd></div><div><dt>Rules & content</dt><dd>{configured ? "Configured" : "Not configured"}</dd></div></dl>
      </section>
      <ol className="entry-steps" aria-label="How to play">
        <li><span className="entry-step-number" aria-hidden="true">01</span><div><strong>Choose a hero</strong><p>Meet your character in the party roster.</p></div></li>
        <li><span className="entry-step-number" aria-hidden="true">02</span><div><strong>Enter a room</strong><p>Join your table in a session below.</p></div></li>
        <li><span className="entry-step-number" aria-hidden="true">03</span><div><strong>Tell your story</strong><p>Describe what your hero does next.</p></div></li>
      </ol>
    </>}
    {destination !== "party" && privileged && preparing && <CampaignPreparation key={campaignId} campaignId={campaignId} mechanics={mechanics} initialStage={destination === "rooms" ? 3 : configured ? 1 : 0} onBuilder={onBuilder} onRead={snapshot => { setData({ campaign: snapshot.detail.campaign, party: snapshot.party.characters, rooms: snapshot.rooms.attached }); report(snapshot.detail.campaign); }} />}
    <div className={`entry-grid${destination === "overview" ? " entry-grid-overview" : ""}`}>
      {destination !== "party" && <section className="entry-sessions" aria-labelledby="entry-sessions-heading">
        <div className="entry-section-heading"><h2 id="entry-sessions-heading" ref={sessionsHeading} tabIndex={-1}>Sessions</h2>{destination === "rooms" && privileged && !preparing && <button className="entry-secondary" onClick={() => setPreparing(true)}>Connect or create a room</button>}</div>
        {roomError && <p role="alert">{roomError}</p>}
        {!data.rooms.length && <p>No attached sessions. {privileged ? "Connect or create a room in preparation to bring your party together." : "Ask your DM to attach a session."}</p>}
        {data.rooms.map(room => <article className="entry-room" key={room.sessionId}>
          <p className="entry-room-label">{room.stopped ? "Stopped session" : "Attached session"}</p>
          <h3>{room.title ?? "Untitled session"}</h3>
          <p className="entry-room-party">{room.participantNames.join(", ") || "No participants yet"}</p>
          {mechanics && privileged && !room.stopped ? <RoomActivation key={`${campaignId}:${room.sessionId}`} campaignId={campaignId} sessionId={room.sessionId} onOpen={() => onRoom(room.sessionId)} opening={roomPending} onPrepare={() => setPreparing(true)} onWorld={() => navigate?.("world")} onParty={onBuilder} /> : <button disabled={roomPending} onClick={() => onRoom(room.sessionId)}>Open room</button>}
        </article>)}
      </section>}
      {destination !== "rooms" && <section className="entry-party" aria-labelledby="entry-party-heading"><h2 id="entry-party-heading">Party roster</h2>{data.party.length ? <ul>{data.party.map(actor => <li key={actor.id}><strong>{actor.name}</strong><button onClick={() => onCharacter(actor.id)}>Open {actor.name}</button></li>)}</ul> : <p>No campaign characters yet.</p>}{mechanics && configured && data.campaign.actorRole !== "observer" && <button onClick={onBuilder}>Build a character</button>}</section>}
    </div>
    <footer><h2>Behind the scenes</h2><p>Custom content, administration and legacy dice tools live in advanced setup.</p><button className="entry-secondary" onClick={onAdvanced}>Open advanced setup</button><p className="entry-note">Current server-reported role: {data.campaign.actorRole}. This trusted-local workspace does not provide remote sign-in or authenticated multiplayer.</p></footer>
  </main>;
}

function RoomActivation({ campaignId, sessionId, onOpen, opening, onPrepare, onWorld, onParty }: { campaignId: string; sessionId: string; onOpen: () => void; opening?: boolean; onPrepare: () => void; onWorld: () => void; onParty: () => void }) {
  const key = `velvet.room-activation.v1:${campaignId}:${sessionId}`;
  const [pending, setPending] = useState<CampaignRoomActivationRequest | null>(() => { try { return campaignRoomActivationRequestSchema.parse(JSON.parse(localStorage.getItem(key) ?? "null")); } catch { return null; } });
  const [readiness, setReadiness] = useState<CampaignRoomActivationReadiness | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const alive = useRef(true), lock = useRef(false), pendingRef = useRef(pending);
  pendingRef.current = pending;
  const loadReadiness = useCallback(async (source: "automatic" | "manual" | "activation") => {
    const receipt = source === "activation" ? "Activation receipt confirmed. " : "";
    setReadiness(null); setNotice(`${receipt}Checking room readiness...`);
    try {
      const result = await getActivationReadiness(campaignId, sessionId);
      if (alive.current) {
        setReadiness(result);
        setNotice(source === "activation" ? `${receipt}Readiness refreshed.` : pendingRef.current ? "Current state read. The saved command still requires exact retry to recover its receipt." : source === "manual" ? "Readiness refreshed." : "");
      }
    } catch {
      if (alive.current) setNotice(`${receipt}Readiness unavailable. ${source === "activation" ? "Check room readiness before entering." : "Retry the read; no start is assumed."}`);
    }
  }, [campaignId, sessionId]);
  const read = useCallback(async (source: "automatic" | "manual" = "manual") => {
    if (lock.current) return; lock.current = true; setBusy(true);
    try { await loadReadiness(source); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }, [loadReadiness]);
  useEffect(() => {
    alive.current = true;
    // Arrival and focus only read authority; neither can replay a saved command.
    void read("automatic");
    const onFocus = () => void read("automatic");
    window.addEventListener("focus", onFocus);
    return () => { alive.current = false; window.removeEventListener("focus", onFocus); };
  }, [read]);
  async function start() {
    if (lock.current || (!pending && (readiness?.active !== false || !readiness.ready))) return;
    const command = pending ?? { expectedRevision: readiness!.expectedRevision, idempotencyKey: createClientId() };
    // Persist before dispatch. Never mint a replacement while an outcome is uncertain.
    try { localStorage.setItem(key, JSON.stringify(command)); } catch { setNotice("Safe command persistence is unavailable. Room was not started."); return; }
    lock.current = true; setPending(command); setBusy(true); setReadiness(null); setNotice("Confirming room start...");
    try {
      await activateRoom(campaignId, sessionId, command); localStorage.removeItem(key);
      if (alive.current) {
        setPending(null);
        // Keep the command lock through the follow-up GET. A receipt alone is
        // not current readiness, and a failed GET must not restore a saved write.
        await loadReadiness("activation");
      }
    } catch (error) {
      // A later rejection cannot prove that an earlier uncertain attempt did
      // not commit. Retain its identity until the exact receipt is recovered.
      const rejected = !pending && error instanceof ActivationHttpError && [400, 403, 404, 409, 415].includes(error.status);
      if (rejected) localStorage.removeItem(key);
      if (alive.current) { if (rejected) setPending(null); setReadiness(null); setNotice(rejected ? "Start rejected. Read current readiness before preparing a new command." : "Start outcome uncertain. Read current state or retry the exact saved command."); }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const canEnter = readiness?.active && readiness.ready && readiness.blockers.length === 0 && !pending;
  const canStart = readiness?.active === false && readiness.ready && !pending;
  return <div className="entry-activation">
    {readiness && <>
      <p className={`entry-readiness${canEnter ? " entry-readiness-ready" : ""}`}>{canEnter ? "Active and ready. Enter the adventure when your table is ready." : canStart ? "Setup is ready. Start the room to begin play." : readiness.active && readiness.ready ? "Active room requires command recovery before entry." : "Preparation required. Resolve each blocker before starting."}</p>
      {readiness.blockers.length > 0 && <ul className="entry-blockers">{readiness.blockers.map(blocker => <li key={blocker}>{blocker.replaceAll("-", " ")}{["campaign-not-published", "content-not-ready", "safety-paused"].includes(blocker) && <button onClick={onPrepare}>Review preparation</button>}{blocker === "starting-location-required" && <button onClick={onWorld}>Choose a public starting location</button>}{blocker === "participants-not-ready" && <button onClick={onParty}>Review character building</button>}</li>)}</ul>}
    </>}
    {pending && <div className="entry-recovery"><p>A previous start outcome is uncertain. Retry only the exact saved command to recover its receipt.</p><button disabled={busy} onClick={() => void start()}>Retry exact room start</button></div>}
    <div className="entry-actions">
      {canEnter && <button className="entry-primary" disabled={busy || opening} onClick={onOpen}>Enter adventure</button>}
      {canStart && <button className="entry-primary" disabled={busy} onClick={() => void start()}>Start room</button>}
      <button className="entry-secondary" disabled={busy} onClick={() => void read()}>Check room readiness</button>
    </div>
    {notice && <p className="entry-note" role="status">{notice}</p>}
  </div>;
}

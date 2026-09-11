import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignAdministrationHttpMembershipListResponse, CampaignRoomLinkingResponse, CompanionAdministrationHttpCommand, CompanionAdministrationHttpCommandResponse, CompanionAdministrationHttpGetResponse, CompanionCommandFamily, CompanionManagementProjection } from "@velvet/contracts";
import { companionCommandFamilySchema } from "@velvet/contracts";
import { ApiError } from "../../../api";
import { createClientId } from "../../../utils/clientId";

export interface CompanionAdministrationApi {
  get: (campaignId: string, npcId: string) => Promise<CompanionAdministrationHttpGetResponse>;
  command: (campaignId: string, npcId: string, input: CompanionAdministrationHttpCommand) => Promise<CompanionAdministrationHttpCommandResponse>;
  listMemberships: (campaignId: string) => Promise<CampaignAdministrationHttpMembershipListResponse>;
  listRooms: (campaignId: string) => Promise<CampaignRoomLinkingResponse>;
}

const RESOURCE_SCOPES = ["none", "actor-resources", "wallet", "inventory", "powers"] as const;
const commandFamilies = companionCommandFamilySchema.options;

/** Owner/GM management projection and bounded grants for one path-owned companion NPC. */
export function CompanionAdministrationPanel({ campaignId, npcId, npcName, canAdminister, actors, api }: {
  campaignId: string; npcId: string; npcName: string; canAdminister: boolean;
  actors: readonly { actorId: string; name: string }[]; api: CompanionAdministrationApi;
}) {
  const [companion, setCompanion] = useState<CompanionManagementProjection | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing" | "failed">("loading");
  const [notice, setNotice] = useState("");
  const [memberships, setMemberships] = useState<CampaignAdministrationHttpMembershipListResponse["memberships"]>([]);
  const [rooms, setRooms] = useState<CampaignRoomLinkingResponse | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [grantee, setGrantee] = useState("");
  const [families, setFamilies] = useState<CompanionCommandFamily[]>([]);
  const [actorId, setActorId] = useState("");
  const [resourceScope, setResourceScope] = useState<(typeof RESOURCE_SCOPES)[number]>("actor-resources");
  const [maxSpend, setMaxSpend] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [confirmationPolicy, setConfirmationPolicy] = useState<"always" | "domain-policy">("always");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const token = ++generation.current;
    setPhase("loading");
    try {
      const response = await api.get(campaignId, npcId);
      if (token !== generation.current) return;
      setCompanion(response.companion);
      setPhase("ready");
    } catch (error) {
      if (token !== generation.current) return;
      setCompanion(null);
      setPhase(error instanceof ApiError && error.status === 404 ? "missing" : "failed");
    }
  }, [api, campaignId, npcId]);

  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load]);
  useEffect(() => {
    let current = true;
    void api.listMemberships(campaignId).then((value) => { if (current) setMemberships(value.memberships); }).catch(() => undefined);
    void api.listRooms(campaignId).then((value) => { if (current) setRooms(value); }).catch(() => undefined);
    return () => { current = false; };
  }, [api, campaignId]);

  async function command(input: CompanionAdministrationHttpCommand, operation: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setNotice("");
    try {
      await api.command(campaignId, npcId, input);
      setNotice(`${operation} committed. Companion revision advanced by one.`);
      await load();
      return true;
    } catch (error) {
      setNotice(error instanceof ApiError && error.status === 409
        ? `${operation} conflicts with current companion state. Reconcile with the authoritative read; the command was not repeated.`
        : `${operation} outcome is unknown. Reconcile with the authoritative read before creating another command; it was not repeated.`);
      return false;
    } finally { setBusy(false); }
  }

  const createCompanion = () => command({ kind: "companion-create", sessionId, expectedRevision: 0, idempotencyKey: createClientId() }, "Companion creation");
  const createGrant = () => {
    if (companion === null) return;
    command({
      kind: "grant-create", granteePrincipalId: grantee, allowedCommandFamilies: families,
      actorScope: { kind: "campaign-actor", actorId }, resourceScope: { kind: resourceScope },
      maxSpend: maxSpend.trim() === "" ? null : Number(maxSpend),
      maxUses: maxUses.trim() === "" ? null : Number(maxUses),
      startsAt: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString(),
      confirmationPolicy, expectedRevision: companion.revision, idempotencyKey: createClientId(),
    }, "Companion grant creation");
  };
  const revokeGrant = (grantId: string) => command({ kind: "grant-revoke", grantId, reason: "Revoked from the cast studio", expectedRevision: companion?.revision ?? 0, idempotencyKey: createClientId() }, "Companion grant revocation");

  if (!canAdminister) return null;
  return <section className="companion-administration" aria-labelledby="companion-administration-heading">
    <h3 id="companion-administration-heading">Companion administration for {npcName}</h3>
    <p className="field-help">Companion grants are separate from NPC definitions. Grants can be revoked but are never exercised from this panel.</p>
    {notice && <p role="status">{notice}</p>}
    {phase === "loading" && <p role="status">Loading companion administration…</p>}
    {phase === "failed" && <p role="alert">Companion administration could not be read. Reauthorize & refresh; nothing was changed.</p>}
    {phase === "missing" && <div className="companion-create">
      <p>This NPC is not a companion yet.</p>
      <label>Attached room<select value={sessionId} disabled={busy} onChange={(event) => setSessionId(event.target.value)}>
        <option value="">Choose an attached room</option>
        {(rooms?.attached ?? []).map((room) => <option key={room.sessionId} value={room.sessionId}>{room.title ?? room.sessionId}</option>)}
      </select></label>
      <button type="button" disabled={busy || sessionId.length === 0} onClick={() => void createCompanion()}>Create companion</button>
    </div>}
    {phase === "ready" && companion && <>
      <dl className="command-detail-list"><div><dt>State</dt><dd>{companion.state}</dd></div><div><dt>Room</dt><dd>{companion.sessionId}</dd></div><div><dt>Revision</dt><dd>{companion.revision}</dd></div></dl>
      <h4>Grants</h4>
      {companion.grants.length === 0 ? <p>No grants recorded.</p> : <ul className="companion-grant-list">{companion.grants.map((grant) => <li key={grant.grantId}>
        <div><strong>{grant.granteePrincipalId}</strong><p>{grant.allowedCommandFamilies.join(", ")} · {grant.actorScope.actorId} · {grant.resourceScope.kind}</p><small>Sends {grant.maxSpend ?? "no"} · uses {grant.maxUses ?? "unbounded"} · {grant.revokedAt ? "revoked" : grant.confirmationPolicy === "always" ? "always confirms" : "domain policy"}</small></div>
        <button type="button" disabled={busy || grant.revokedAt !== null} onClick={() => void revokeGrant(grant.grantId)}>Revoke grant</button>
      </li>)}</ul>}
      <h4>Create grant</h4>
      <form className="studio-form" onSubmit={(event) => { event.preventDefault(); createGrant(); }}>
        <label>Grantee<select required value={grantee} disabled={busy} onChange={(event) => setGrantee(event.target.value)}>
          <option value="">Choose a campaign member</option>
          {memberships.filter((member) => member.principalId !== "local-owner").map((member) => <option key={member.principalId} value={member.principalId}>{member.principalId}</option>)}
        </select></label>
        <label>Actor scope<select required value={actorId} disabled={busy} onChange={(event) => setActorId(event.target.value)}>
          <option value="">Choose a campaign actor</option>
          {actors.map((actor) => <option key={actor.actorId} value={actor.actorId}>{actor.name}</option>)}
        </select></label>
        <fieldset><legend>Command families</legend>{commandFamilies.map((family) => <label className="checkbox" key={family}><input type="checkbox" checked={families.includes(family)} disabled={busy} onChange={(event) => setFamilies((current) => event.target.checked ? [...current, family] : current.filter((item) => item !== family))} />{family}</label>)}</fieldset>
        <label>Resource scope<select value={resourceScope} disabled={busy} onChange={(event) => setResourceScope(event.target.value as (typeof RESOURCE_SCOPES)[number])}>{RESOURCE_SCOPES.map((scope) => <option key={scope} value={scope}>{scope}</option>)}</select></label>
        <label>Max spend<input type="number" min="0" value={maxSpend} disabled={busy} onChange={(event) => setMaxSpend(event.target.value)} /></label>
        <label>Max uses<input type="number" min="1" value={maxUses} disabled={busy} onChange={(event) => setMaxUses(event.target.value)} /></label>
        <label>Confirmation<select value={confirmationPolicy} disabled={busy} onChange={(event) => setConfirmationPolicy(event.target.value as "always" | "domain-policy")}><option value="always">Always confirm</option><option value="domain-policy">Domain policy</option></select></label>
        <label>Expires<textarea required value={expiresAt} disabled={busy} onChange={(event) => setExpiresAt(event.target.value)} placeholder="2036-01-01T00:00:00.000Z" /></label>
        <button className="primary" type="submit" disabled={busy || !grantee || !actorId || families.length === 0 || Number.isNaN(new Date(expiresAt).getTime())}>Create exact grant</button>
      </form>
    </>}
  </section>;
}

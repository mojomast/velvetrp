import { useState, type FormEvent } from "react";
import type { CampaignAdministrationHttpMembership, CampaignMemberRole } from "@velvet/contracts";

export interface MembershipManagerProps {
  memberships: CampaignAdministrationHttpMembership[];
  busy: boolean;
  mutationLocked: boolean;
  onAdd: (principalId: string, role: Exclude<CampaignMemberRole, "owner">) => void;
  onChangeRole: (principalId: string, role: Exclude<CampaignMemberRole, "owner">) => void;
  onRemove: (principalId: string) => void;
}

const NON_OWNER_ROLES = ["gm", "player", "observer"] as const;

export function MembershipManager({ memberships, busy, mutationLocked, onAdd, onChangeRole, onRemove }: MembershipManagerProps) {
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState<(typeof NON_OWNER_ROLES)[number]>("player");
  const nonOwners = memberships.filter((membership) => membership.role !== "owner");

  function add(event: FormEvent) {
    event.preventDefault();
    const exactPrincipalId = principalId;
    if (!exactPrincipalId || busy || mutationLocked) return;
    if (!window.confirm(`Add this local principal as ${role}?`)) return;
    onAdd(exactPrincipalId, role);
    setPrincipalId("");
  }

  return <section className="admin-section" aria-labelledby="membership-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">ACCESS</p><h2 id="membership-heading">Memberships</h2></div><span className="count-badge" aria-label={`${nonOwners.length} non-owner memberships`}>{nonOwners.length}</span></div>
    <p className="admin-help">Manage GM, player, and observer access. The sole owner is intentionally not editable here.</p>
    <form className="membership-add" onSubmit={add}>
      <label className="field"><span>Local principal ID</span><input required maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" value={principalId} onChange={(event) => setPrincipalId(event.target.value)} /></label>
      <label className="field"><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>{NON_OWNER_ROLES.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      <button className="primary" type="submit" disabled={busy || mutationLocked}>Add member</button>
    </form>
    {nonOwners.length === 0 ? <p className="empty-state">No non-owner memberships.</p> : <ul className="membership-list">
      {nonOwners.map((membership) => <li key={membership.principalId}>
        <div><bdi>{membership.principalId}</bdi><small>Added {new Date(membership.createdAt).toLocaleDateString()}</small></div>
        <label className="sr-only" htmlFor={`membership-role-${membership.principalId}`}>Role for {membership.principalId}</label>
        <select id={`membership-role-${membership.principalId}`} value={membership.role} disabled={busy || mutationLocked} onChange={(event) => {
          const next = event.target.value as (typeof NON_OWNER_ROLES)[number];
          if (window.confirm(`Change this member's role to ${next}?`)) onChangeRole(membership.principalId, next);
        }}>{NON_OWNER_ROLES.map((value) => <option value={value} key={value}>{value}</option>)}</select>
        <button className="danger subtle" disabled={busy || mutationLocked} onClick={() => {
          if (window.confirm("Remove this member from the campaign?")) onRemove(membership.principalId);
        }}>Remove</button>
      </li>)}
    </ul>}
  </section>;
}

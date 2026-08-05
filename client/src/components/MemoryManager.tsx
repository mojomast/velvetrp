import { FormEvent, useEffect, useMemo, useState } from "react";
import { ApiError, Character, MemoryFact, MemoryKind, createMemory, forgetMemory, listMemories, restoreMemory, updateMemory } from "../api";

export function MemoryManager({ character, onClose }: { character: Character; onClose: () => void }) {
  const [memories, setMemories] = useState<MemoryFact[]>([]);
  const [tab, setTab] = useState<"active" | "pending" | "forgotten">("active");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function reload() {
    try { setMemories((await listMemories(character.id)).memories); setError(null); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not load memories."); }
  }
  useEffect(() => { void reload(); }, [character.id]);

  const visible = useMemo(() => memories.filter((memory) => tab === "forgotten" ? Boolean(memory.forgottenAt) : !memory.forgottenAt && (tab === "active" ? memory.userApproved : !memory.userApproved)), [memories, tab]);
  const counts = { active: memories.filter((m) => !m.forgottenAt && m.userApproved).length, pending: memories.filter((m) => !m.forgottenAt && !m.userApproved).length, forgotten: memories.filter((m) => m.forgottenAt).length };

  async function add(event: FormEvent) {
    event.preventDefault(); if (!content.trim()) return;
    try { await createMemory(character.id, { content: content.trim(), kind, userApproved: true }); setContent(""); await reload(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Could not add memory."); }
  }
  async function mutate(id: string, action: () => Promise<unknown>) {
    setBusyId(id); setError(null); try { await action(); await reload(); } catch (err) { setError(err instanceof ApiError ? err.message : "Could not update memory."); } finally { setBusyId(null); }
  }

  return <section className="card manager-card">
    <div className="section-heading-row"><div><p className="eyebrow">MEMORY</p><h1 className="title">{character.name}'s memories</h1></div><button className="ghost" onClick={onClose}>Back to library</button></div>
    <form className="inline-create" onSubmit={add}><select aria-label="New memory kind" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}><option value="fact">Fact</option><option value="preference">Preference</option><option value="event">Event</option></select><input value={content} onChange={(e) => setContent(e.target.value)} placeholder="Add something worth remembering…" maxLength={160} /><button className="primary" disabled={!content.trim()}>Add</button></form>
    <div className="tabs" role="tablist">{(["active", "pending", "forgotten"] as const).map((value) => <button type="button" role="tab" aria-selected={tab === value} className={tab === value ? "tab active" : "tab"} onClick={() => setTab(value)} key={value}>{value} <span>{counts[value]}</span></button>)}</div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="manager-list">{visible.length === 0 && <p className="empty-state">No {tab} memories.</p>}{visible.map((memory) => <MemoryRow key={memory.id} memory={memory} disabled={busyId === memory.id} onChange={(patch) => mutate(memory.id, () => updateMemory(memory.id, patch))} onForget={() => mutate(memory.id, () => forgetMemory(memory.id))} onRestore={() => mutate(memory.id, () => restoreMemory(memory.id))} />)}</div>
  </section>;
}

function MemoryRow({ memory, disabled, onChange, onForget, onRestore }: { memory: MemoryFact; disabled: boolean; onChange: (patch: Partial<Pick<MemoryFact, "content" | "kind" | "userApproved">>) => void; onForget: () => void; onRestore: () => void }) {
  const [editing, setEditing] = useState(false); const [content, setContent] = useState(memory.content); const [kind, setKind] = useState(memory.kind);
  useEffect(() => { setContent(memory.content); setKind(memory.kind); }, [memory]);
  return <article className={`manager-item ${memory.forgottenAt ? "is-muted" : ""}`}>
    <div className="manager-item-head"><span className={`status-pill ${memory.forgottenAt ? "forgotten" : memory.userApproved ? "active" : "pending"}`}>{memory.forgottenAt ? "forgotten" : memory.userApproved ? "active" : "pending"}</span><span className="meta-text">{memory.kind} · {memory.sourceTurnId === "manual" ? "manual" : "from chat"}</span></div>
    {editing ? <div className="form compact-form"><textarea value={content} maxLength={160} onChange={(e) => setContent(e.target.value)} /><select value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}><option value="fact">Fact</option><option value="preference">Preference</option><option value="event">Event</option></select><div className="button-row"><button className="primary" disabled={disabled || !content.trim()} onClick={() => { onChange({ content: content.trim(), kind }); setEditing(false); }}>Save</button><button className="ghost" onClick={() => setEditing(false)}>Cancel</button></div></div> : <p>{memory.content}</p>}
    {!editing && <div className="item-actions"><button className="ghost small" onClick={() => setEditing(true)} disabled={disabled}>Edit</button>{!memory.forgottenAt && !memory.userApproved && <button className="primary small" onClick={() => onChange({ userApproved: true })} disabled={disabled}>Approve</button>}{!memory.forgottenAt && memory.userApproved && <button className="ghost small" onClick={() => onChange({ userApproved: false })} disabled={disabled}>Mark pending</button>}{memory.forgottenAt ? <button className="primary small" onClick={onRestore} disabled={disabled}>Restore</button> : <button className="danger subtle small" onClick={onForget} disabled={disabled}>Forget</button>}</div>}
  </article>;
}

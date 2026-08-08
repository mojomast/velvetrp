import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogDefinition, CatalogDefinitionKind, ContentCatalogHttpValidationRequest } from "@velvet/contracts";

export type ContentPackDraft = ContentCatalogHttpValidationRequest;

export interface ContentPackEditorProps {
  draft: ContentPackDraft;
  disabled?: boolean;
  focusPath?: string | null;
  onChange: (draft: ContentPackDraft) => void;
  onValidate: () => void;
}

const KINDS: CatalogDefinitionKind[] = ["race", "background", "class", "class-level", "skill", "ability", "spell", "item", "currency", "enemy-template"];

function tags(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function fieldId(path: string): string {
  return `pack-field-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function definitionJson(definition: CatalogDefinition): string {
  return JSON.stringify(definition, null, 2);
}

/** An intentionally browser-memory-only editor; it has no path or upload input. */
export function ContentPackEditor({ draft, disabled = false, focusPath = null, onChange, onValidate }: ContentPackEditorProps) {
  const fieldsRef = useRef(new Map<string, HTMLElement>());
  const [definitionText, setDefinitionText] = useState(() => draft.definitions.map(definitionJson));
  const [definitionErrors, setDefinitionErrors] = useState<Record<number, string>>({});
  const grouped = useMemo(() => KINDS.map((kind) => ({
    kind,
    entries: draft.definitions.map((definition, index) => ({ definition, index }))
      .filter(({ definition }) => definition.reference.kind === kind),
  })), [draft.definitions]);

  useEffect(() => {
    setDefinitionText((current) => draft.definitions.map((definition, index) => current[index] ?? definitionJson(definition)));
  }, [draft.definitions]);

  useEffect(() => {
    if (!focusPath) return;
    const exact = fieldsRef.current.get(focusPath);
    const definitionMatch = /^definitions\[(\d+)]/.exec(focusPath);
    const fallback = definitionMatch ? fieldsRef.current.get(`definitions[${definitionMatch[1]}]`) : undefined;
    (exact ?? fallback)?.focus();
  }, [focusPath]);

  const register = (path: string) => (element: HTMLElement | null) => {
    if (element) fieldsRef.current.set(path, element);
    else fieldsRef.current.delete(path);
  };
  const manifest = draft.manifest;
  const changeManifest = <Key extends keyof ContentPackDraft["manifest"]>(key: Key, value: ContentPackDraft["manifest"][Key]) => {
    onChange({ ...draft, manifest: { ...manifest, [key]: value } });
  };
  const textField = (path: string, label: string, value: string, change: (value: string) => void, multiline = false) => <label className="field" htmlFor={fieldId(path)}>
    <span>{label}</span>
    {multiline
      ? <textarea ref={register(path) as React.Ref<HTMLTextAreaElement>} id={fieldId(path)} rows={3} value={value} disabled={disabled} onChange={(event) => change(event.target.value)} />
      : <input ref={register(path) as React.Ref<HTMLInputElement>} id={fieldId(path)} value={value} disabled={disabled} onChange={(event) => change(event.target.value)} />}
  </label>;

  function commitDefinition(index: number, value: string): void {
    setDefinitionText((current) => current.map((entry, entryIndex) => entryIndex === index ? value : entry));
    try {
      const parsed = JSON.parse(value) as CatalogDefinition;
      setDefinitionErrors((current) => { const next = { ...current }; delete next[index]; return next; });
      onChange({ ...draft, definitions: draft.definitions.map((entry, entryIndex) => entryIndex === index ? parsed : entry) });
    } catch {
      setDefinitionErrors((current) => ({ ...current, [index]: "Definition JSON must be valid before validation." }));
    }
  }

  return <section className="content-pack-editor" aria-labelledby="content-pack-editor-heading">
    <div className="content-studio-heading"><div><p className="eyebrow">EDITABLE · LOCAL MEMORY</p><h2 id="content-pack-editor-heading">Local draft</h2></div><span className="status-pill">Not published</span></div>
    <p className="content-studio-help">Changes stay in this browser tab until publication. This editor never reads or accepts server filesystem paths.</p>
    <fieldset disabled={disabled}>
      <legend>Pack identity</legend>
      <div className="content-editor-grid">
        {textField("manifest.packId", "Pack ID", manifest.packId, (value) => changeManifest("packId", value))}
        {textField("manifest.packVersion", "Exact version", manifest.packVersion, (value) => changeManifest("packVersion", value))}
        {textField("manifest.name", "Pack name", manifest.name, (value) => changeManifest("name", value))}
        {textField("manifest.tags", "Tags (comma separated)", manifest.tags.join(", "), (value) => changeManifest("tags", tags(value)))}
        <div className="content-editor-wide">{textField("manifest.description", "Description", manifest.description, (value) => changeManifest("description", value), true)}</div>
      </div>
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Compatibility and rules profile</legend>
      <div className="content-editor-grid">
        {textField("manifest.compatibility.rulesProfileId", "Rules profile ID", manifest.compatibility.rulesProfileId, (value) => changeManifest("compatibility", { ...manifest.compatibility, rulesProfileId: value }))}
        {textField("manifest.rulesProfile.name", "Rules profile name", manifest.rulesProfile.name, (value) => changeManifest("rulesProfile", { ...manifest.rulesProfile, name: value }))}
        <div className="content-editor-wide">{textField("manifest.rulesProfile.description", "Rules profile description", manifest.rulesProfile.description, (value) => changeManifest("rulesProfile", { ...manifest.rulesProfile, description: value }), true)}</div>
      </div>
      <p className="locked-value">Rules engine <code>{manifest.compatibility.rulesEngine}</code> · catalog format <code>{manifest.compatibility.catalogFormat}</code></p>
    </fieldset>
    <fieldset disabled={disabled}>
      <legend>Original-work review</legend>
      <div className="content-editor-grid">
        {textField("manifest.provenance.author", "Author", manifest.provenance.author, (value) => changeManifest("provenance", { ...manifest.provenance, author: value }))}
        {textField("manifest.provenance.reviewedBy", "Reviewed by", manifest.provenance.reviewedBy, (value) => changeManifest("provenance", { ...manifest.provenance, reviewedBy: value }))}
        {textField("manifest.provenance.authoredAt", "Authored at (UTC ISO)", manifest.provenance.authoredAt, (value) => changeManifest("provenance", { ...manifest.provenance, authoredAt: value }))}
        {textField("manifest.provenance.reviewedAt", "Reviewed at (UTC ISO)", manifest.provenance.reviewedAt, (value) => changeManifest("provenance", { ...manifest.provenance, reviewedAt: value }))}
        <div className="content-editor-wide">{textField("manifest.provenance.declaration", "Original-work declaration", manifest.provenance.declaration, (value) => changeManifest("provenance", { ...manifest.provenance, declaration: value }), true)}</div>
      </div>
    </fieldset>
    <section className="definition-editor" aria-labelledby="draft-definitions-heading">
      <h3 id="draft-definitions-heading">Draft definitions by kind</h3>
      {draft.definitions.length === 0 && <p className="content-empty">This draft has no definitions.</p>}
      {grouped.map(({ kind, entries }) => entries.length > 0 && <section key={kind} className="definition-kind"><h4>{kind} <span>{entries.length}</span></h4>
        {entries.map(({ definition, index }) => <label className="definition-json" key={`${definition.reference.definitionId}:${index}`} htmlFor={fieldId(`definitions[${index}]`)}>
          <span>{definition.name || definition.reference.definitionId} · complete definition JSON</span>
          <textarea ref={register(`definitions[${index}]`) as React.Ref<HTMLTextAreaElement>} id={fieldId(`definitions[${index}]`)} rows={12} spellCheck={false} value={definitionText[index] ?? definitionJson(definition)} disabled={disabled} aria-invalid={Boolean(definitionErrors[index])} onChange={(event) => commitDefinition(index, event.target.value)} />
          {definitionErrors[index] && <small className="form-error" role="alert">{definitionErrors[index]}</small>}
        </label>)}
      </section>)}
    </section>
    <button type="button" className="primary content-validate" disabled={disabled || Object.keys(definitionErrors).length > 0} onClick={onValidate}>Validate current draft</button>
  </section>;
}

import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import {
  catalogDefinitionSchema,
  contentCatalogHttpValidationRequestSchema,
  type CatalogDefinition,
  type CatalogDefinitionKind,
  type ContentCatalogHttpValidationRequest,
} from "@velvet/contracts";

export type ContentPackDraft = ContentCatalogHttpValidationRequest;

export interface ContentPackEditorProps {
  draft: ContentPackDraft;
  disabled?: boolean;
  focusPath?: string | null;
  onChange: (draft: ContentPackDraft) => void;
  onValidate: () => void;
}

export const CONTENT_DEFINITION_KINDS: CatalogDefinitionKind[] = ["race", "background", "class", "class-level", "skill", "ability", "spell", "item", "currency", "enemy-template"];
const DEFAULT_IDS: Record<CatalogDefinitionKind, string> = {
  race: "local-race", background: "local-background", class: "local-class", "class-level": "local-class-level-1",
  skill: "local-skill", ability: "local-ability", spell: "local-spell", item: "local-item",
  currency: "local-currency", "enemy-template": "local-enemy",
};

const tags = (value: string) => value.split(",").map((entry) => entry.trim()).filter(Boolean);
const fieldId = (path: string) => `pack-field-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

function replaceIdentityValue(value: unknown, packId: string, packVersion: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => replaceIdentityValue(entry, packId, packVersion));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key,
    key === "packId" ? packId : key === "packVersion" ? packVersion : replaceIdentityValue(entry, packId, packVersion)]));
}

/** Keeps every direct and nested catalog reference on one exact identity. */
export function replaceDraftIdentity(draft: ContentPackDraft, packId: string, packVersion: string): ContentPackDraft {
  const parsed = contentCatalogHttpValidationRequestSchema.safeParse({
    ...draft,
    manifest: { ...draft.manifest, packId, packVersion },
    definitions: replaceIdentityValue(draft.definitions, packId, packVersion),
  });
  return parsed.success ? parsed.data : draft;
}

function ref(packId: string, packVersion: string, kind: CatalogDefinitionKind, definitionId = DEFAULT_IDS[kind]) {
  return { packId, packVersion, kind, definitionId };
}

function defaultDefinition(kind: CatalogDefinitionKind, packId: string, packVersion: string, definitionId = DEFAULT_IDS[kind]): CatalogDefinition {
  const reference = ref(packId, packVersion, kind, definitionId);
  const currency = ref(packId, packVersion, "currency");
  const ability = ref(packId, packVersion, "ability");
  const skill = ref(packId, packVersion, "skill");
  const item = ref(packId, packVersion, "item");
  const spell = ref(packId, packVersion, "spell");
  const klass = ref(packId, packVersion, "class");
  const level = ref(packId, packVersion, "class-level");
  const base = { reference, name: `Local ${kind}`, description: `An original local ${kind} definition.`, tags: ["local"] };
  switch (kind) {
    case "race": return catalogDefinitionSchema.parse({ ...base, mechanics: { speed: 30, attributeBonuses: { resolve: 1 }, abilityRefs: [ability] } });
    case "background": return catalogDefinitionSchema.parse({ ...base, mechanics: { skillRefs: [skill], itemRefs: [item], startingCurrency: { currency, amount: 10 } } });
    case "class": return catalogDefinitionSchema.parse({ ...base, mechanics: { hitDie: 8, primaryAttribute: "resolve", savingAttributes: ["resolve"], levelRefs: [level] } });
    case "class-level": return catalogDefinitionSchema.parse({ ...base, mechanics: { classRef: klass, level: 1, proficiencyBonus: 2, hpGain: 8, abilityRefs: [ability], spellRefs: [spell] } });
    case "skill": return catalogDefinitionSchema.parse({ ...base, mechanics: { attribute: "insight" } });
    case "ability": return catalogDefinitionSchema.parse({ ...base, mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "physical", dice: { count: 1, sides: 6, modifier: 0 } }] } });
    case "spell": return catalogDefinitionSchema.parse({ ...base, mechanics: { level: 1, actionCost: "action", range: 30, target: "ally", concentration: false, effects: [{ type: "modifier", statistic: "defense", amount: 1, duration: "round" }] } });
    case "item": return catalogDefinitionSchema.parse({ ...base, mechanics: { category: "gear", stackable: false, slot: "hand", price: { currency, amount: 5 }, effects: [] } });
    case "currency": return catalogDefinitionSchema.parse({ ...base, mechanics: { symbol: "lc", minorPerMajor: 100 } });
    case "enemy-template": return catalogDefinitionSchema.parse({ ...base, mechanics: { tier: 1, maxHp: 8, defense: 10, speed: 25, abilityRefs: [ability], resistances: [], vulnerabilities: [], immunities: [] }, private: { tactics: "Approach the nearest opponent.", gmNotes: "Original local opponent.", hiddenAbilityRefs: [] } });
  }
}

/** A complete semantic starter draft. Its digest identity is normalized by validation. */
export function createCompleteContentPackDraft(): ContentPackDraft {
  const packId = "local-pack", packVersion = "0.1.0+000000000000", at = "2030-01-01T00:00:00.000Z";
  return contentCatalogHttpValidationRequestSchema.parse({
    manifest: {
      packId, packVersion, name: "Local content pack", description: "An editable original local starter catalog.", tags: ["local"], digest: "0".repeat(64),
      rulesProfile: { name: "Local rules profile", description: "A Velvet starter-compatible local profile.", tags: ["local"] },
      compatibility: { rulesEngine: "velvet-starter-v1", rulesProfileId: "local-rules", catalogFormat: "validated-v1" },
      provenance: { authorship: "original", author: "Local author", authoredAt: at, reviewedBy: "Local reviewer", reviewedAt: at, declaration: "This pack contains original work.", thirdPartyData: false },
    },
    definitions: CONTENT_DEFINITION_KINDS.map((kind) => defaultDefinition(kind, packId, packVersion)),
  });
}

function uniqueCopyId(definition: CatalogDefinition, definitions: CatalogDefinition[]): string {
  const prefix = definition.reference.definitionId.slice(0, 108);
  let number = 1;
  while (definitions.some((entry) => entry.reference.kind === definition.reference.kind && entry.reference.definitionId === `${prefix}-copy-${number}`)) number += 1;
  return `${prefix}-copy-${number}`;
}

function resolveIssueTarget(path: string, draft: ContentPackDraft): string {
  const normalized = path.replace(/\[(\d+)]/g, ".$1");
  if (!normalized.startsWith("definitions.")) return normalized;
  const rest = normalized.slice("definitions.".length);
  const indexMatch = /^(\d+)(?:\.(.*))?$/.exec(rest);
  if (indexMatch) {
    const index = Number(indexMatch[1]), suffix = indexMatch[2] ?? "";
    if (suffix.startsWith("reference")) return `definitions.${index}.reference.definitionId`;
    if (suffix === "name" || suffix === "description" || suffix === "tags") return `definitions.${index}.${suffix}`;
    return `definitions.${index}.mechanics`;
  }
  const identityIndex = draft.definitions.findIndex((definition) => {
    const identity = `${definition.reference.kind}:${definition.reference.definitionId}`;
    return rest === identity || rest.startsWith(`${identity}.`);
  });
  if (identityIndex >= 0) {
    const definition = draft.definitions[identityIndex]!;
    const suffix = rest.slice(`${definition.reference.kind}:${definition.reference.definitionId}`.length + 1);
    return suffix === "reference" || suffix.startsWith("reference.")
      ? `definitions.${identityIndex}.reference.definitionId` : `definitions.${identityIndex}.mechanics`;
  }
  if (CONTENT_DEFINITION_KINDS.includes(rest as CatalogDefinitionKind)) return `definitions.add.${rest}`;
  return "definitions-heading";
}

/** Browser-memory editor with only contract-shaped structured definition controls. */
export function ContentPackEditor({ draft, disabled = false, focusPath = null, onChange, onValidate }: ContentPackEditorProps) {
  const fieldsRef = useRef(new Map<string, HTMLElement>());
  const [definitionErrors, setDefinitionErrors] = useState<Record<number, string>>({});
  const grouped = useMemo(() => CONTENT_DEFINITION_KINDS.map((kind) => ({ kind, entries: draft.definitions.map((definition, index) => ({ definition, index })).filter(({ definition }) => definition.reference.kind === kind) })), [draft.definitions]);

  useEffect(() => {
    if (!focusPath) return;
    fieldsRef.current.get(resolveIssueTarget(focusPath, draft))?.focus();
  }, [draft, focusPath]);

  const register = (paths: string | string[]) => (element: HTMLElement | null) => {
    for (const path of typeof paths === "string" ? [paths] : paths) {
      if (element) fieldsRef.current.set(path, element); else fieldsRef.current.delete(path);
    }
  };
  const manifest = draft.manifest;
  const changeManifest = <Key extends keyof ContentPackDraft["manifest"]>(key: Key, value: ContentPackDraft["manifest"][Key]) => onChange({ ...draft, manifest: { ...manifest, [key]: value } });
  const textField = (path: string, label: string, value: string, change: (value: string) => void, multiline = false) => <label className="field" htmlFor={fieldId(path)}><span>{label}</span>{multiline
    ? <textarea ref={register(path) as Ref<HTMLTextAreaElement>} id={fieldId(path)} rows={3} value={value} disabled={disabled} onChange={(event) => change(event.target.value)} />
    : <input ref={register(path) as Ref<HTMLInputElement>} id={fieldId(path)} value={value} disabled={disabled} onChange={(event) => change(event.target.value)} />}</label>;

  function commitDefinition(index: number, candidate: unknown, message = "Definition must match its strict catalog shape."): void {
    const parsed = catalogDefinitionSchema.safeParse(candidate);
    if (!parsed.success) { setDefinitionErrors((current) => ({ ...current, [index]: message })); return; }
    setDefinitionErrors((current) => { const next = { ...current }; delete next[index]; return next; });
    onChange({ ...draft, definitions: draft.definitions.map((entry, entryIndex) => entryIndex === index ? parsed.data : entry) });
  }

  function addDefinition(kind: CatalogDefinitionKind): void {
    const next = defaultDefinition(kind, manifest.packId, manifest.packVersion, uniqueCopyId(defaultDefinition(kind, manifest.packId, manifest.packVersion), draft.definitions));
    onChange({ ...draft, definitions: [...draft.definitions, next] });
  }

  return <section className="content-pack-editor" aria-labelledby="content-pack-editor-heading">
    <div className="content-studio-heading"><div><p className="eyebrow">EDITABLE · LOCAL MEMORY</p><h2 id="content-pack-editor-heading">Local draft</h2></div><span className="status-pill">Not published</span></div>
    <p className="content-studio-help">Changes stay in this browser tab until publication. This editor never reads or accepts server filesystem paths.</p>
    <fieldset disabled={disabled}><legend>Pack identity</legend><div className="content-editor-grid">
      {textField("manifest.packId", "Pack ID", manifest.packId, (value) => onChange(replaceDraftIdentity(draft, value, manifest.packVersion)))}
      {textField("manifest.packVersion", "Exact version", manifest.packVersion, (value) => onChange(replaceDraftIdentity(draft, manifest.packId, value)))}
      {textField("manifest.name", "Pack name", manifest.name, (value) => changeManifest("name", value))}
      {textField("manifest.tags", "Tags (comma separated)", manifest.tags.join(", "), (value) => changeManifest("tags", tags(value)))}
      <label className="field" htmlFor={fieldId("manifest.digest")}><span>Derived canonical digest</span><input ref={register("manifest.digest") as Ref<HTMLInputElement>} id={fieldId("manifest.digest")} value={manifest.digest} readOnly aria-readonly="true" /></label>
      <div className="content-editor-wide">{textField("manifest.description", "Description", manifest.description, (value) => changeManifest("description", value), true)}</div>
    </div></fieldset>
    <fieldset disabled={disabled}><legend>Compatibility and rules profile</legend><div className="content-editor-grid">
      {textField("manifest.compatibility.rulesProfileId", "Rules profile ID", manifest.compatibility.rulesProfileId, (value) => changeManifest("compatibility", { ...manifest.compatibility, rulesProfileId: value }))}
      {textField("manifest.rulesProfile.name", "Rules profile name", manifest.rulesProfile.name, (value) => changeManifest("rulesProfile", { ...manifest.rulesProfile, name: value }))}
      <div className="content-editor-wide">{textField("manifest.rulesProfile.description", "Rules profile description", manifest.rulesProfile.description, (value) => changeManifest("rulesProfile", { ...manifest.rulesProfile, description: value }), true)}</div>
    </div><p className="locked-value">Rules engine <code>{manifest.compatibility.rulesEngine}</code> · catalog format <code>{manifest.compatibility.catalogFormat}</code></p></fieldset>
    <fieldset disabled={disabled}><legend>Original-work review</legend><div className="content-editor-grid">
      {textField("manifest.provenance.author", "Author", manifest.provenance.author, (value) => changeManifest("provenance", { ...manifest.provenance, author: value }))}
      {textField("manifest.provenance.reviewedBy", "Reviewed by", manifest.provenance.reviewedBy, (value) => changeManifest("provenance", { ...manifest.provenance, reviewedBy: value }))}
      {textField("manifest.provenance.authoredAt", "Authored at (UTC ISO)", manifest.provenance.authoredAt, (value) => changeManifest("provenance", { ...manifest.provenance, authoredAt: value }))}
      {textField("manifest.provenance.reviewedAt", "Reviewed at (UTC ISO)", manifest.provenance.reviewedAt, (value) => changeManifest("provenance", { ...manifest.provenance, reviewedAt: value }))}
      <div className="content-editor-wide">{textField("manifest.provenance.declaration", "Original-work declaration", manifest.provenance.declaration, (value) => changeManifest("provenance", { ...manifest.provenance, declaration: value }), true)}</div>
    </div></fieldset>
    <section className="definition-editor" aria-labelledby="draft-definitions-heading"><h3 ref={register("definitions-heading") as Ref<HTMLHeadingElement>} tabIndex={-1} id="draft-definitions-heading">Draft definitions by kind</h3>
      {grouped.map(({ kind, entries }) => <section key={kind} className="definition-kind"><div className="definition-kind-heading"><h4>{kind} <span>{entries.length}</span></h4><button ref={register(`definitions.add.${kind}`) as Ref<HTMLButtonElement>} type="button" className="ghost" disabled={disabled} onClick={() => addDefinition(kind)}>Add {kind} definition</button></div>
        {entries.length === 0 && <p className="content-empty">No {kind} definition. Add one before validation.</p>}
        {entries.map(({ definition, index }) => <article className="definition-fields" key={`${definition.reference.definitionId}:${index}`}>
          <div className="content-editor-grid">
            {textField(`definitions.${index}.reference.definitionId`, "Definition ID", definition.reference.definitionId, (value) => commitDefinition(index, { ...definition, reference: { ...definition.reference, definitionId: value } }))}
            {textField(`definitions.${index}.name`, "Definition name", definition.name, (value) => commitDefinition(index, { ...definition, name: value }))}
            {textField(`definitions.${index}.tags`, "Definition tags", definition.tags.join(", "), (value) => commitDefinition(index, { ...definition, tags: tags(value) }))}
            <div className="content-editor-wide">{textField(`definitions.${index}.description`, "Definition description", definition.description, (value) => commitDefinition(index, { ...definition, description: value }), true)}</div>
          </div>
          <label className="definition-json" htmlFor={fieldId(`definitions.${index}.mechanics`)}><span>Mechanics JSON for {definition.name}</span><textarea key={`${manifest.packId}:${manifest.packVersion}:${definition.reference.definitionId}:${JSON.stringify(definition.mechanics)}`} ref={register(`definitions.${index}.mechanics`) as Ref<HTMLTextAreaElement>} id={fieldId(`definitions.${index}.mechanics`)} rows={8} spellCheck={false} defaultValue={JSON.stringify({ mechanics: definition.mechanics, ...("private" in definition ? { private: definition.private } : {}) }, null, 2)} disabled={disabled} aria-invalid={Boolean(definitionErrors[index])} onBlur={(event) => { try { commitDefinition(index, { ...definition, ...JSON.parse(event.target.value) as object }, "Mechanics JSON must be valid and match this definition kind."); } catch { setDefinitionErrors((current) => ({ ...current, [index]: "Mechanics JSON must be valid and match this definition kind." })); } }} /></label>
          {definitionErrors[index] && <small className="form-error" role="alert">{definitionErrors[index]}</small>}
          <div className="button-row"><button type="button" className="ghost" disabled={disabled} onClick={() => { const copyId = uniqueCopyId(definition, draft.definitions); const copy = catalogDefinitionSchema.parse({ ...structuredClone(definition), reference: { ...definition.reference, definitionId: copyId }, name: `${definition.name} copy` }); onChange({ ...draft, definitions: [...draft.definitions, copy] }); }}>Duplicate {definition.name}</button><button type="button" className="danger subtle" disabled={disabled} onClick={() => onChange({ ...draft, definitions: draft.definitions.filter((_entry, entryIndex) => entryIndex !== index) })}>Remove {definition.name}</button></div>
        </article>)}
      </section>)}
    </section>
    <button type="button" className="primary content-validate" disabled={disabled || Object.keys(definitionErrors).length > 0} onClick={onValidate}>Validate current draft</button>
  </section>;
}

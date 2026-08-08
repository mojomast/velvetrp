import type { CharacterDraftHttpView, UpdateCharacterDraftHttpInput } from "@velvet/contracts";

export interface ChoiceGroupEditorProps {
  groups: CharacterDraftHttpView["choiceGroups"];
  selections: CharacterDraftHttpView["selections"];
  disabled?: boolean;
  onSelect: (selections: UpdateCharacterDraftHttpInput["selections"]) => void;
}

function title(id: CharacterDraftHttpView["choiceGroups"][number]["id"]): string {
  return id === "starter-grant" ? "Starting grant" : id[0]!.toUpperCase() + id.slice(1);
}

function referenceKey(value: object | null): string {
  if (!value) return "";
  const reference = value as { kind: string; packId: string; packVersion: string; definitionId: string };
  return `${reference.kind}:${reference.packId}:${reference.packVersion}:${reference.definitionId}`;
}

/** Renders server-returned options verbatim and emits only a selection patch. */
export function ChoiceGroupEditor({ groups, selections, disabled = false, onSelect }: ChoiceGroupEditorProps) {
  return <section className="builder-section choice-group-editor" aria-labelledby="choices-heading">
    <div className="builder-section-heading"><div><p className="eyebrow">STEP 2</p><h2 id="choices-heading">Required choices</h2></div></div>
    <p className="builder-help">Each choice saves automatically. Definitions come from the campaign's exact pinned content.</p>
    {groups.map((group) => <fieldset key={group.id} id={`builder-choice-${group.id}`} tabIndex={-1} disabled={disabled}>
      <legend>{title(group.id)} {group.required && <span aria-label="required">*</span>}</legend>
      <div className="builder-choice-options">
        {group.id === "starter-grant" ? group.options.map((option) => <label key={option}>
          <input type="radio" name="builder-starter-grant" checked={selections.starterGrant === option} onChange={() => onSelect({ starterGrant: option })} />
          <span><strong>{option === "kit" ? "Background kit" : "Starting currency"}</strong><small>{option === "kit" ? "Receive the exact item bundle shown in review." : "Receive the exact currency grant shown in review."}</small></span>
        </label>) : group.options.map((option) => {
          const selected = referenceKey(selections[group.id]) === referenceKey(option.reference);
          return <label key={referenceKey(option.reference)}>
            <input type="radio" name={`builder-${group.id}`} checked={selected} onChange={() => onSelect({ [group.id]: option.reference })} />
            <span><strong><bdi dir="auto">{option.name}</bdi></strong><small><bdi dir="auto">{option.description}</bdi></small></span>
          </label>;
        })}
      </div>
    </fieldset>)}
  </section>;
}

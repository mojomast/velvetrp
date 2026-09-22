import type { ActorGameplaySheetResponse } from "@velvet/contracts";
import { AtlasDrawerSideControl, type AtlasDrawerSide } from "./PlaySurface";

export interface GameplaySheetDrawerProps {
  sheet: ActorGameplaySheetResponse;
  canReference: boolean;
  onClose: () => void;
  onReference: (fragment: string) => void;
  closeButtonRef?: React.RefObject<HTMLButtonElement>;
  /** Command Center only: current drawer edge and the four-way persistence hook. */
  side?: AtlasDrawerSide;
  onSideChange?: (side: AtlasDrawerSide) => void;
}

const signed = (value: number) => value >= 0 ? `+${value}` : String(value);
const words = (value: string) => value.replace(/[-_]/g, " ");

function Empty({ children }: { children: string }) { return <p className="gameplay-sheet-empty">{children}</p>; }

function durationText(duration: ActorGameplaySheetResponse["activeEffects"][number]["duration"]): string {
  if (duration.kind === "rounds") return `${duration.remaining} round${duration.remaining === 1 ? "" : "s"} remaining`;
  if (duration.kind === "until_timestamp") return `until ${new Date(duration.expiresAt).toLocaleString()}`;
  return "until removed";
}

function modifierText(modifier: ActorGameplaySheetResponse["activeEffects"][number]["modifiers"][number]): string {
  if (modifier.kind === "flat") return `${signed(modifier.amount)} to ${words(modifier.appliesToId)}`;
  if (modifier.kind === "proficiency") return `${signed(modifier.bonus)} proficiency to ${words(modifier.appliesToId)}`;
  return `${words(modifier.kind)}: ${words(modifier.appliesToId)}`;
}

const derivedEntries = (sheet: ActorGameplaySheetResponse): Array<readonly [string, string | number | undefined, string]> => {
  const defenses: Array<readonly [string, string | number | undefined, string]> = sheet.rulesetId === "dnd-5e" ? [["Armor Class", sheet.derived.armorClass, "my Armor Class"]] : [
    ["Guard", sheet.derived.defenses.guard, "my Guard defense"],
    ["Evasion", sheet.derived.defenses.evasion, "my Evasion defense"],
    ["Will", sheet.derived.defenses.will, "my Will defense"],
  ];
  return [["Maximum HP", sheet.derived.maxHp, "my maximum health"], ...defenses,
  ["Initiative", signed(sheet.derived.initiative), "my initiative"],
  ["Speed", sheet.derived.speed, "my speed"],
  ["Carrying limit", sheet.derived.carryingLimit, "my carrying limit"],
  ["Spell attack", signed(sheet.derived.spellAttack), "my spell attack"],
  ["Save DC", sheet.derived.saveDc, "my save difficulty"],
  ];
};

/** Read-only actor projection. Reference controls only compose text for an explicit later declaration. */
export function GameplaySheetDrawer({ sheet, canReference, onClose, onReference, closeButtonRef, side = "right", onSideChange }: GameplaySheetDrawerProps) {
  const hintId = "gameplay-sheet-reference-hint";
  const reference = (label: string, fragment: string, available = true) => (
    <button type="button" disabled={!canReference || !available} aria-describedby={hintId} onClick={() => onReference(fragment)}>{label}</button>
  );
  const progression = sheet.progression;

  return <aside className="gameplay-sheet-drawer" role="dialog" aria-modal="false" aria-labelledby="gameplay-sheet-title" aria-describedby={hintId}>
    <header><div><p className="eyebrow">READ-ONLY REFERENCE · {sheet.rulesetId ?? "velvet-starter-v1"} @ {sheet.rulesetVersion ?? "1.0.0"}</p><h2 id="gameplay-sheet-title">{sheet.identity.name}&apos;s character sheet</h2></div>
      <div className="atlas-drawer-controls"><AtlasDrawerSideControl tool="character" side={side} onSideChange={onSideChange} />
        <button ref={closeButtonRef} type="button" aria-label="Close character sheet" onClick={onClose}>Close</button></div></header>
    <p id={hintId} className="gameplay-sheet-hint">Reference buttons only append words to your existing declaration draft and move focus to the composer. They never submit, roll, use an item or power, or change character state. Review and explicitly press Declare action to proceed.{!canReference && " References are disabled until play is ready and unambiguous."}</p>

    <section aria-labelledby="gameplay-sheet-identity"><h3 id="gameplay-sheet-identity">Identity</h3><dl>
      <div><dt>Name</dt><dd>{sheet.identity.name}</dd></div>
      <div><dt>Race</dt><dd>{reference(sheet.race.label, `I draw on my ${sheet.race.label} heritage to `)}</dd></div>
      <div><dt>Background</dt><dd>{reference(sheet.background.label, `I draw on my ${sheet.background.label} background to `)}</dd></div>
    </dl></section>
    <section aria-labelledby="gameplay-sheet-classes"><h3 id="gameplay-sheet-classes">Classes</h3>{sheet.classes.length ? <ul>{sheet.classes.map((entry) => <li key={`${entry.reference.packId}:${entry.reference.packVersion}:${entry.reference.definitionId}`}>{reference(`${entry.label}, level ${entry.level}`, `I use my ${entry.label} training to `)}</li>)}</ul> : <Empty>No classes listed.</Empty>}</section>
    <section aria-labelledby="gameplay-sheet-attributes"><h3 id="gameplay-sheet-attributes">Attributes</h3>{sheet.attributes.length ? <ul>{sheet.attributes.map((entry) => <li key={entry.attributeId}>{reference(entry.label, `I rely on my ${entry.label} to `)} <strong>{entry.value}</strong></li>)}</ul> : <Empty>No attributes listed.</Empty>}</section>
    <section aria-labelledby="gameplay-sheet-derived"><h3 id="gameplay-sheet-derived">Derived stats and progression</h3><dl>{derivedEntries(sheet).map(([label, value, phrase]) => <div key={label}><dt>{reference(label, `I account for ${phrase} as I `)}</dt><dd>{value}</dd></div>)}</dl>
      <h4>Progression</h4><dl><div><dt>Mode</dt><dd>{words(progression.mode)}</dd></div><div><dt>Level</dt><dd>{progression.level}</dd></div><div><dt>Total XP</dt><dd>{progression.totalXp}</dd></div><div><dt>Milestones</dt><dd>{progression.milestoneCount}</dd></div><div><dt>Pending choices</dt><dd>{progression.pendingChoiceCount}</dd></div></dl>
      <details><summary>How stats were calculated</summary><ul>{sheet.derived.explanations.map((entry) => <li key={entry.statistic}><strong>{words(entry.statistic)}</strong>: {entry.formula} = {entry.result}</li>)}</ul></details></section>
    <section aria-labelledby="gameplay-sheet-proficiencies"><h3 id="gameplay-sheet-proficiencies">Proficiencies</h3>{sheet.proficiencies.length ? <ul>{sheet.proficiencies.map((entry) => <li key={entry.proficiencyId}>{reference(entry.label, `I use my ${entry.label} proficiency to `)} <span>{words(entry.category)}</span></li>)}</ul> : <Empty>No proficiencies listed.</Empty>}</section>
    <section aria-labelledby="gameplay-sheet-choices"><h3 id="gameplay-sheet-choices">Choices</h3>{sheet.choices.length ? <ul>{sheet.choices.map((entry) => <li key={entry.choiceId}><span>{entry.label}: </span>{reference(entry.selection.label, `I draw on my choice of ${entry.selection.label} to `)}</li>)}</ul> : <Empty>No choices listed.</Empty>}</section>
    <section aria-labelledby="gameplay-sheet-resources"><h3 id="gameplay-sheet-resources">Resources</h3>{sheet.resources.length ? <ul>{sheet.resources.map((entry) => <li key={entry.resourceId}>{reference(entry.label, `I draw on ${entry.label} to `)} <strong>{entry.current} / {entry.capacity}</strong></li>)}</ul> : <Empty>No resources listed.</Empty>}</section>
    <section aria-labelledby="gameplay-sheet-inventory"><h3 id="gameplay-sheet-inventory">Inventory and equipment</h3><p>{sheet.inventory.items.length} of {sheet.inventory.capacity} capacity entries</p>{sheet.inventory.items.length ? <ul>{sheet.inventory.items.map((entry) => <li key={entry.entryId}>{reference(entry.label, `I use ${entry.label} to `)} <strong>x{entry.quantity}</strong>{entry.equippedSlot && <span> Equipped: {words(entry.equippedSlot)}</span>}</li>)}</ul> : <Empty>No inventory listed.</Empty>}</section>
    <section aria-labelledby="gameplay-sheet-powers"><h3 id="gameplay-sheet-powers">Known powers and spells</h3>{sheet.knownPowers.length ? <ul>{sheet.knownPowers.map((entry) => <li key={`${entry.power.kind}:${entry.power.packId}:${entry.power.packVersion}:${entry.power.definitionId}`}>{reference(entry.label, entry.power.kind === "spell" ? `I cast ${entry.label} to ` : `I use ${entry.label} to `, entry.available)} <span>{entry.available ? "Available" : `Unavailable: ${entry.unavailableReasons.map(words).join(", ")}`}</span></li>)}</ul> : <Empty>No known powers or spells.</Empty>}</section>
    <section aria-labelledby="gameplay-sheet-effects"><h3 id="gameplay-sheet-effects">Active effects</h3>{sheet.activeEffects.length ? <ul>{sheet.activeEffects.map((entry) => { const label = entry.source?.label ?? "Unlabeled effect"; return <li key={entry.effectId}>{reference(label, `I account for ${label} as I `)} <span>{durationText(entry.duration)}; {words(entry.stacking)}{entry.recovery !== "none" ? `; recovers on ${words(entry.recovery)}` : ""}</span><ul>{entry.modifiers.map((modifier, index) => <li key={index}>{modifierText(modifier)}</li>)}</ul></li>; })}</ul> : <Empty>No active effects.</Empty>}</section>
  </aside>;
}

import { z } from "zod";
import type { ActorGameplaySheetResponse } from "./gameplay-sheet-http.js";
import { catalogDefinitionReferenceSchema } from "./content-catalog.js";

export const MAX_SHEET_REFERENCES = 16;
export const sheetReferenceSectionSchema = z.enum(["identity", "classes", "attributes", "derived", "progression", "proficiencies", "choices", "resources", "inventory", "powers", "effects", "calculations"]);
/** A selector only: clients cannot supply sheet facts, values or another actor. */
export const sheetReferenceSchema = z.object({ section: sheetReferenceSectionSchema, key: z.string().min(1).max(2_000) }).strict();
export const sheetReferenceKey = (reference: SheetReference): string => JSON.stringify([reference.section, reference.key]);
export const sheetReferencesSchema = z.array(sheetReferenceSchema).max(MAX_SHEET_REFERENCES)
  .refine((entries) => new Set(entries.map(sheetReferenceKey)).size === entries.length, "sheet references must be unique");
export const sheetContextEntrySchema = z.object({ reference: sheetReferenceSchema, label: z.string().min(1).max(400), value: z.string().min(1).max(4_000), catalogReference: catalogDefinitionReferenceSchema.optional() }).strict();
export const sheetContextSchema = z.array(sheetContextEntrySchema).max(MAX_SHEET_REFERENCES)
  .refine((entries) => new Set(entries.map((entry) => sheetReferenceKey(entry.reference))).size === entries.length, "sheet context must be unique");
export type SheetReference = z.infer<typeof sheetReferenceSchema>;
export type SheetContextEntry = z.infer<typeof sheetContextEntrySchema>;
export type SheetReferenceSection = SheetReference["section"];

export const sheetSectionLabels: Record<SheetReferenceSection, string> = {
  identity: "Identity", classes: "Classes", attributes: "Attributes", derived: "Statistics & defenses",
  progression: "Progression", proficiencies: "Skills, saves & proficiencies", choices: "Choices & features",
  resources: "Health & resources", inventory: "Inventory & equipment", powers: "Powers & spells", effects: "Active effects", calculations: "Stat calculations",
};
const words = (value: string) => value.replace(/[-_]/g, " ");
const signed = (value: number) => value >= 0 ? `+${value}` : String(value);
const catalogKey = (value: { kind: string; packId: string; packVersion: string; definitionId: string }) => JSON.stringify([value.kind, value.packId, value.packVersion, value.definitionId]);

/** The complete reference index, shared by the sheet UI and server-side resolution.
 * Values come only from the authorized sheet; labels never serve as identity. */
export function gameplaySheetEntries(sheet: ActorGameplaySheetResponse): SheetContextEntry[] {
  const entries: SheetContextEntry[] = [];
  const add = (section: SheetReferenceSection, key: string, label: string, value: string | number, catalogReference?: SheetContextEntry["catalogReference"]) => {
    const text = String(value);
    entries.push({ reference: { section, key }, label, value: text.length > 4_000 ? `${text.slice(0, 3_950)}… (remaining details omitted)` : text, ...(catalogReference ? { catalogReference } : {}) });
  };
  add("identity", "name", "Name", sheet.identity.name);
  add("identity", "race", "Ancestry", sheet.race.label, sheet.race.reference);
  add("identity", "background", "Background", sheet.background.label, sheet.background.reference);
  add("identity", "ruleset", "Ruleset", sheet.rulesetId ? `${sheet.rulesetId}${sheet.rulesetVersion ? ` @ ${sheet.rulesetVersion}` : ""}` : "Not supplied");
  for (const entry of sheet.classes) add("classes", catalogKey(entry.reference), entry.label, `Level ${entry.level}`, entry.reference);
  for (const entry of sheet.attributes) add("attributes", entry.attributeId, entry.label, `${entry.value}${sheet.rulesetId === "dnd-5e" ? ` · ${signed(Math.floor((entry.value - 10) / 2))} modifier` : ""}`);
  add("derived", "maxHp", "Maximum HP", sheet.derived.maxHp);
  if (sheet.rulesetId === "dnd-5e") add("derived", "armorClass", "Armor Class", sheet.derived.armorClass ?? "Not supplied");
  else for (const [key, value] of Object.entries(sheet.derived.defenses)) add("derived", key, key.charAt(0).toUpperCase() + key.slice(1), value);
  for (const [key, label, value] of [
    ["initiative", "Initiative", signed(sheet.derived.initiative)], ["speed", "Speed", sheet.derived.speed],
    ["carryingLimit", "Carrying limit", sheet.derived.carryingLimit], ["spellAttack", "Spell attack", signed(sheet.derived.spellAttack)], ["saveDc", "Save DC", sheet.derived.saveDc],
  ] as const) add("derived", key, label, value);
  for (const [key, label] of [["mode", "Progression mode"], ["level", "Level"], ["totalXp", "Total XP"], ["milestoneCount", "Milestones"], ["pendingChoiceCount", "Pending choices"], ["updatedAt", "Progression updated"]] as const)
    add("progression", key, label, String(sheet.progression[key]));
  for (const entry of sheet.proficiencies) add("proficiencies", JSON.stringify([entry.category, entry.proficiencyId]), entry.label, words(entry.category));
  for (const entry of sheet.choices) add("choices", entry.choiceId, entry.label, entry.selection.label, entry.selection.reference);
  for (const entry of sheet.resources) add("resources", entry.resourceId, entry.label, `${entry.current} / ${entry.capacity}`);
  add("inventory", "capacity", "Inventory capacity", `${sheet.inventory.items.length} / ${sheet.inventory.capacity} entries`);
  for (const entry of sheet.inventory.items) add("inventory", `item:${entry.entryId}`, entry.label, `Quantity ${entry.quantity} · ${entry.equippedSlot ? `Equipped: ${words(entry.equippedSlot)}` : "Not equipped"}`, entry.item);
  for (const entry of sheet.knownPowers) add("powers", catalogKey(entry.power), entry.label, `${entry.power.kind === "spell" ? "Spell" : "Ability"} · ${entry.available ? "Available" : `Unavailable: ${entry.unavailableReasons.map(words).join(", ")}`}`, entry.power);
  for (const entry of sheet.activeEffects) {
    const duration = entry.duration.kind === "rounds" ? `${entry.duration.remaining} rounds remaining` : entry.duration.kind === "until_timestamp" ? `Until ${entry.duration.expiresAt}` : "Until removed";
    const modifiers = entry.modifiers.map((modifier) => modifier.kind === "flat" ? `${signed(modifier.amount)} to ${words(modifier.appliesToId)}` : modifier.kind === "proficiency" ? `${signed(modifier.bonus)} proficiency to ${words(modifier.appliesToId)}` : `${words(modifier.kind)}: ${words(modifier.appliesToId)}`);
    add("effects", entry.effectId, entry.source?.label ?? "Unlabeled effect", `${duration} · ${words(entry.stacking)} · ${entry.recovery === "none" ? "No rest recovery" : `Recovers on ${words(entry.recovery)}`} · Applied ${entry.appliedAt}; ${modifiers.join("; ")}`, entry.source?.reference);
  }
  for (const entry of sheet.derived.explanations) add("calculations", entry.statistic, words(entry.statistic), `${entry.formula} = ${entry.result}; inputs: ${JSON.stringify(entry.inputs)}`);
  return entries;
}

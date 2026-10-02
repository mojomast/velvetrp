import { sheetReferenceKey, sheetSectionLabels, type SheetContextEntry } from "@velvet/contracts";

/** The same facts the server attached to the declaration, expandable without cluttering the story. */
export function SentSheetContext({ entries }: { entries?: readonly SheetContextEntry[] }) {
  if (!entries?.length) return null;
  return <details className="sent-sheet-context"><summary>Character context · {entries.length} {entries.length === 1 ? "reference" : "references"}</summary>
    <p>At declaration time</p><ul>{entries.map((entry) => <li key={sheetReferenceKey(entry.reference)}><strong>{entry.label}</strong><span>{sheetSectionLabels[entry.reference.section]} · {entry.value}</span></li>)}</ul>
  </details>;
}

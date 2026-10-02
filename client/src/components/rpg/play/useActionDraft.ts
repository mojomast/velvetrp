import { useMemo, useState, type SetStateAction } from "react";
import { sheetContextSchema, type SheetContextEntry } from "@velvet/contracts";

/** Tab-local drafts are actor/room scoped. Cached display facts are never submitted as authority. */
export function useActionDraft(campaignId: string, sessionId: string, actorId: string) {
  const key = `velvet.action-draft.v1:${JSON.stringify([campaignId, sessionId, actorId])}`;
  type Draft = { key: string; declaration: string; context: SheetContextEntry[] };
  const restored = useMemo((): Draft => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (saved && typeof saved.declaration === "string" && saved.declaration.length <= 8000) {
        const context = sheetContextSchema.safeParse(saved.context);
        return { key, declaration: saved.declaration, context: context.success ? context.data : [] };
      }
    } catch { /* Storage is optional; the in-memory draft still works. */ }
    return { key, declaration: "", context: [] };
  }, [key]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const current = drafts[key] ?? restored;
  function update(change: (value: Draft) => Draft) {
    setDrafts((previous) => {
      const next = change(previous[key] ?? restored);
      try { if (actorId && (next.declaration || next.context.length)) sessionStorage.setItem(key, JSON.stringify(next)); else sessionStorage.removeItem(key); } catch { /* best effort */ }
      return { ...previous, [key]: next };
    });
  }
  return {
    declaration: current.declaration, sheetContext: current.context,
    setDeclaration: (value: SetStateAction<string>) => update((previous) => ({ ...previous, declaration: typeof value === "function" ? value(previous.declaration) : value })),
    setSheetContext: (value: SetStateAction<SheetContextEntry[]>) => update((previous) => ({ ...previous, context: typeof value === "function" ? value(previous.context) : value })),
    clearDraft: () => update((previous) => ({ ...previous, declaration: "", context: [] })),
  };
}

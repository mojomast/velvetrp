import { useEffect, useState, type SetStateAction } from "react";
import { readAuthoringField, writeAuthoringField } from "./generationRecovery";

// Large previews remain document-local; bounded authoring inputs survive reload.
const workspaces = new Map<string, Map<string, unknown>>();

export function useCampaignWorkspaceState<T>(campaignId: string | null, field: string, initial: T) {
  const state = useState<T>(() => {
    if (!campaignId) return initial;
    const saved=readAuthoringField(campaignId,field);
    if(field.endsWith("Intent")||field==="draftId")return saved===undefined?initial:saved as T;
    return saved!==undefined?saved as T:workspaces.get(campaignId)?.has(field)?workspaces.get(campaignId)!.get(field) as T:initial;
  });
  const [value] = state;
  useEffect(() => {
    if (!campaignId) return;
    const workspace = workspaces.get(campaignId) ?? new Map<string, unknown>();
    workspace.set(field, value);
    workspaces.set(campaignId, workspace);
  }, [campaignId, field, value]);
  const setValue=(action:SetStateAction<T>)=>{
    const next=typeof action==="function"?(action as (prior:T)=>T)(value):action;
    if(campaignId) {
      if(field.endsWith("Intent")) writeAuthoringField(campaignId,field,next);
      else try { writeAuthoringField(campaignId,field,next); } catch { /* Intent dispatch still requires durable storage. */ }
    }
    state[1](next);
  };
  return [value,setValue] as const;
}

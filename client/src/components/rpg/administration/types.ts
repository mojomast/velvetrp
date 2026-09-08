export type AdministrationRole = "owner" | "gm" | "player";

export interface AdministrationMutationState {
  phase: "idle" | "submitting" | "uncertain";
  message?: string;
}

export const canAdminister = (role: AdministrationRole): boolean => role === "owner" || role === "gm";

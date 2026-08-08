import { createContext, useContext } from "react";
import type { CampaignDetail } from "../../api";

export type StudioAuthorization = {
  role: CampaignDetail["actorRole"];
  audience: "gm" | "player";
  generation: number;
  reauthorize: () => Promise<StudioAuthorization>;
};

const Context = createContext<StudioAuthorization | null>(null);
export const StudioAuthorizationProvider = Context.Provider;
export function useStudioAuthorization(): StudioAuthorization {
  const authorization = useContext(Context);
  if (!authorization) throw new Error("Campaign studio authorization is unavailable");
  return authorization;
}

import { createContext, useContext } from "react";
import type { MeResponse } from "@/lib/api";

const MeContext = createContext<MeResponse | undefined>(undefined);

export const MeProvider = MeContext.Provider;

export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe must be used within MeProvider");
  return me;
}
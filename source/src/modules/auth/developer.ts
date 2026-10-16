// Whether the signed-in person gets the developer tools (diagnostics panel,
// Google Calendar debug log, Putting Lab and video debug overlays).
//
// The server decides it from the signed-in email (netlify/functions/_shared/
// developer.mts); App provides it once so screens deep in the tree can read it
// without it being passed through every layer.

import { createContext, useContext } from "react";

export const DeveloperContext = createContext(false);

export function useIsDeveloper() {
  return useContext(DeveloperContext);
}

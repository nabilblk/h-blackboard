import type { BlackboardClient } from "../../application/client";

/** The preload's narrow, allowlisted surface. Never expose ipcRenderer to UI. */
export interface ElectronHost {
  contributor: BlackboardClient["workspace"];
  blackboardNode: BlackboardClient["missions"];
  blackboardExecution: BlackboardClient["execution"];
  blackboardSetup: BlackboardClient["setup"];
  blackboardDrafting: BlackboardClient["drafting"];
}

/** Only the composition root selects a transport. There is no global singleton,
 * fallback connection, credential access or side effect during module import. */
export function createElectronClient(host: ElectronHost): BlackboardClient {
  return Object.freeze({
    workspace: host.contributor,
    missions: host.blackboardNode,
    execution: host.blackboardExecution,
    setup: host.blackboardSetup,
    drafting: host.blackboardDrafting,
  });
}

declare global {
  interface Window extends ElectronHost {}
}

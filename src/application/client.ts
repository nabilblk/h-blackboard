import type { DesktopAPI, NodeAPI } from "./contracts/workspace";
import type { ExecutionAPI } from "./contracts/execution";
import type { SetupAPI } from "./contracts/setup";
import type { DraftingAPI } from "./contracts/drafting";

/** Application ports. No React, Electron, storage or network implementation.
 * Commands express intent; the host still validates identity and authority. */
export interface BlackboardClient {
  readonly workspace: DesktopAPI;
  readonly missions: NodeAPI;
  readonly execution: ExecutionAPI;
  readonly setup: SetupAPI;
  readonly drafting: DraftingAPI;
}

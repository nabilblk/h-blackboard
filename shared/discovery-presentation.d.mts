import type { DiscoveryState } from "../src/desktop/bridge";
import type {
  DiscoveryOutcome,
  DiscoveryPeerHealth,
  ListingView,
} from "../src/desktop/node-contract";
export const discoveryOutcomes: Record<DiscoveryOutcome, string>;
export function discoveryPresentation(input: {
  state: DiscoveryState | null;
  online: boolean;
  query?: string;
  error?: string;
  now?: number;
}): {
  title: string;
  detail: string;
  action: "network" | "settings" | "clear" | null;
  visible: ListingView[];
  recent: number;
  peers: DiscoveryPeerHealth[];
};

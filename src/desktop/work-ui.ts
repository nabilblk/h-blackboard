import type { AgentView, MissionView } from "./node-contract";
import type { Perform } from "./ui";
export const statuses = [
  "planned",
  "in_progress",
  "blocked",
  "paused",
  "submitted",
  "complete",
  "cancelled",
  "conflict",
];
export const statusLabel = (s: string) =>
  s === "submitted" ? "Awaiting review" : s.replaceAll("_", " ");
export const active = (a: AgentView) =>
  !["withdrawn", "revoked", "conflict", "review_required"].includes(a.status);
export type Props = {
  mission: MissionView;
  localKey: string;
  busy: boolean;
  blocked: boolean;
  perform: Perform;
  changed: () => Promise<void>;
};

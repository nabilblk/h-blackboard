import type { Base } from "./model";
export interface BudgetLimits {
  tokens: number | null;
  costUsd: number | null;
  turns: number | null;
  concurrency: number | null;
  deadline: number | null;
}
export const hasBudgetLimits = (limits: BudgetLimits) =>
  Object.values(limits).some((value) => value !== null);
export interface Usage {
  tokens: number | null;
  costUsd: number | null;
  quality: "reported" | "estimated" | "unknown";
  source: string;
}
export interface BudgetRun {
  id: string;
  agentId: string;
  streamId: string;
  version: number;
  purpose: string;
  status: "reserved" | "settled";
  startedAt: number;
  finishedAt: number | null;
  allowance: { tokens: number; costUsd: number };
  usage: Usage | null;
  outcome?: string;
}
type Resources = { tokens: number; costUsd: number; turns: number };
export interface Budget {
  version: number;
  limits: BudgetLimits;
  perTurn: { tokens: number; costUsd: number };
  finalizationPercent: number;
  finalizers: string[];
  consumed: Resources;
  reserved: Resources;
  available: { [K in keyof Resources]: number | null };
  workAvailable: { [K in keyof Resources]: number | null };
  active: number;
  unknownRuns: number;
  totalRuns: number;
  quality: { reported: number; estimated: number; unknown: number };
  exhausted: boolean;
  deadlineReached: boolean;
  history: { version: number; at: number; authorId: string; reason: string }[];
}
export interface ArtifactFile {
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
}
export interface ArtifactRevision extends Base {
  artifactId: string;
  number: number;
  authorId: string;
  title: string;
  kind: string;
  summary: string;
  limitations: string;
  outcome: "draft" | "complete" | "inconclusive";
  refs: string[];
  runId: string | null;
  directAgentId: string | null;
  files: ArtifactFile[];
  stale?: boolean;
}
export interface Artifact extends Base {
  title: string;
  kind: string;
  createdBy: string;
  directAgentId: string | null;
  streamId: string | null;
  headId: string;
  revisionCount: number;
  revision: ArtifactRevision;
  stale: boolean;
}
export interface ArtifactReview extends Base {
  artifactId: string;
  revisionId: string;
  authorId: string;
  selfReview: boolean;
  verdict: "verified" | "rejected" | "inconclusive" | "accepted";
  summary: string;
  conditions: string;
  refs: string[];
  stale: boolean;
}
export interface ArtifactDetail {
  nextRevisionOffset: number | null;
  nextReviewOffset: number | null;
  artifact: Artifact;
  revisions: ArtifactRevision[];
  reviews: ArtifactReview[];
}

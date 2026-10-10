import type { MissionDefinition } from "./node";
import type { Runtime } from "./workspace";
export type Brief = {
  name: string;
  objective: string;
  scope: string;
  deliverables: string[];
  criteria: string[];
  assumptions: string[];
  openQuestions: string[];
};
export type BriefField = keyof Brief;
export type BriefListField =
  "deliverables" | "criteria" | "assumptions" | "openQuestions";
export type DraftEdit = Partial<Brief> & {
  idea?: string;
  composer?: string;
  listInputs?: Partial<Record<BriefListField, string>>;
  mode?: "choice" | "assisted" | "manual";
  runtime?: Runtime;
  policy?: MissionDefinition["policy"];
};
export type DraftChange = {
  id: string;
  at: number;
  revision: number;
  undone: boolean;
  fields: BriefField[];
  before: Partial<Brief>;
  after: Partial<Brief>;
};
export type DraftProposal = { field: BriefField; value: string | string[] };
export type MissionDraft = {
  id: string;
  version: 1;
  revision: number;
  updatedAt: number;
  mode: "choice" | "assisted" | "manual";
  runtime: Runtime;
  idea: string;
  composer: string;
  listInputs: Record<BriefListField, string>;
  brief: Brief;
  policy: MissionDefinition["policy"];
  messages: {
    id: string;
    role: "user" | "assistant";
    text: string;
    at: number;
    runtime: Runtime;
  }[];
  question: { text: string; choices: string[] } | null;
  assessment: { ready: boolean; reason: string; revision: number } | null;
  changes: DraftChange[];
  conflicts: DraftProposal[];
  status:
    | "idle"
    | "thinking"
    | "stopped"
    | "error"
    | "creating"
    | "created"
    | "uncertain";
  error: string | null;
  mission: string | null;
  fieldRevisions: Record<BriefField, number>;
};
export type DraftRuntime = {
  runtime: Runtime;
  label: string;
  available: boolean;
  version: string | null;
  detail: string;
  privateLogin: boolean;
  login: { status: string; url: string | null; code: string | null } | null;
};
export type DraftReview = {
  id: string;
  draft: string;
  revision: number;
  definition: MissionDefinition;
  assumptions: string[];
  openQuestions: string[];
};
export interface DraftingAPI {
  current(): Promise<MissionDraft>;
  runtimes(): Promise<DraftRuntime[]>;
  edit(input: { id: string; changes: DraftEdit }): Promise<MissionDraft>;
  send(input: { id: string; text: string }): Promise<MissionDraft>;
  stop(id: string): Promise<MissionDraft>;
  undo(input: { id: string; change: string }): Promise<MissionDraft>;
  resolve(input: {
    id: string;
    field: BriefField;
    accept: boolean;
  }): Promise<MissionDraft>;
  review(id: string): Promise<DraftReview>;
  create(input: {
    id: string;
    review: string;
    acknowledgeOpenDecisions: boolean;
  }): Promise<MissionDraft>;
  discard(id: string): Promise<MissionDraft>;
  signIn(): Promise<unknown>;
  openLogin(): Promise<void>;
  cancelLogin(): Promise<void>;
}

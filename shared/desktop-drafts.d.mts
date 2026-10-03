export type DraftSession = { audience: string; drafts: Record<string, string> };
export function readDrafts(
  storage: Pick<Storage, "getItem">,
  owner: string,
  mission: string,
): DraftSession;
export function writeDrafts(
  storage: Pick<Storage, "setItem">,
  owner: string,
  mission: string,
  session: DraftSession,
): void;

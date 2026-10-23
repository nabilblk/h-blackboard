import type { NodeAPI } from "./contracts/workspace";
import type { AgentView } from "./contracts/node";
export async function readRoster(
  node: NodeAPI,
  mission: string,
): Promise<AgentView[]> {
  const all: AgentView[] = [],
    seen = new Set<string>();
  let after: string | null = null;
  do {
    const page = await node.agents(mission, after);
    all.push(...page.items);
    after = page.after;
    if (after && seen.has(after))
      throw new Error("Roster did not advance. Refresh the mission.");
    if (after) seen.add(after);
  } while (after && all.length < 512);
  return all;
}

import { useCallback, useEffect, useState } from "react";
import { node } from "./bridge";
import type { GovernanceView } from "./node-contract";
export function useLedger(mission: string) {
  const [data, setData] = useState<GovernanceView | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setData(await node.governance(mission));
    setError("");
  }, [mission]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await node.governance(mission);
        if (active) {
          setData(data);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Unable to read the ledger.",
          );
      }
      if (active) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [mission]);
  return { data, error, refresh };
}
export const short = (s: string) => s.slice(0, 10);

import { useEffect, useRef, useState } from "react";

/** Bounded, device-local navigation. Drafts and permissions are deliberately
 * outside this history: going Back must never restore an old command or form. */
export function useWorkspaceHistory<T>(value: T, restore: (value: T) => void) {
  const signature = JSON.stringify(value);
  const entries = useRef([{ signature, value }]);
  const index = useRef(0);
  const restoring = useRef<string | null>(null);
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  const [, refresh] = useState(0);
  useEffect(() => {
    if (restoring.current !== null) {
      if (signature === restoring.current) restoring.current = null;
      return;
    }
    if (entries.current[index.current]?.signature === signature) return;
    entries.current = [
      ...entries.current.slice(0, index.current + 1),
      { signature, value },
    ].slice(-50);
    index.current = entries.current.length - 1;
    refresh((n) => n + 1);
  }, [signature, value]);
  const go = (delta: number) => {
    const next = index.current + delta;
    const entry = entries.current[next];
    if (!entry) return;
    index.current = next;
    restoring.current = entry.signature;
    restoreRef.current(entry.value);
    refresh((n) => n + 1);
  };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        !["ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
      event.preventDefault();
      goRef.current(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return {
    back: () => go(-1),
    forward: () => go(1),
    canBack: index.current > 0,
    canForward: index.current < entries.current.length - 1,
  };
}

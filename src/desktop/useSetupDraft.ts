import { useState } from "react";
// Local input convenience, never authority. Host review/consent is always fresh.
export function useSetupDraft<T>(
  key: string,
  initial: T,
  valid: (value: unknown) => value is T,
) {
  const storageKey = `harakiri.setup.v1:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw && raw.length <= 32768) {
        const parsed: unknown = JSON.parse(raw);
        if (valid(parsed)) return parsed;
      }
    } catch {
      /* A damaged draft never blocks setup. */
    }
    return initial;
  });
  const [error, setError] = useState("");
  const save = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setError("");
    } catch {
      setError(
        "This draft could not be saved. Keep this panel open until setup is submitted.",
      );
    }
  };
  const clear = () => {
    localStorage.removeItem(storageKey);
    setValue(initial);
  };
  return [value, save, clear, error] as const;
}

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DraftEdit,
  DraftingAPI,
  MissionDraft,
} from "../application/contracts/drafting";
import { briefFields } from "../../shared/mission-draft.mjs";

function overlay(draft: MissionDraft, edits: DraftEdit): MissionDraft {
  const next = { ...draft, brief: { ...draft.brief } };
  for (const [field, value] of Object.entries(edits)) {
    if (briefFields.includes(field as keyof typeof next.brief))
      Object.assign(next.brief, { [field]: value });
    else if (field === "listInputs")
      next.listInputs = {
        ...next.listInputs,
        ...(value as DraftEdit["listInputs"]),
      };
    else Object.assign(next, { [field]: value });
  }
  return next;
}

/** Optimistic field edits with one ordered save queue. Polls and late replies
 * cannot replace text still being typed. A failed save stays visible/retryable. */
export function useMissionDraft(api: DraftingAPI) {
  const [draft, setDraft] = useState<MissionDraft | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const current = useRef<MissionDraft | null>(null);
  const pending = useRef<DraftEdit>({});
  const inFlight = useRef<DraftEdit>({});
  const writing = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const receive = useCallback((next: MissionDraft) => {
    if (
      current.current?.id === next.id &&
      current.current.updatedAt > next.updatedAt
    )
      return;
    current.current = next;
    if (mounted.current)
      setDraft(overlay(overlay(next, inFlight.current), pending.current));
  }, []);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (writing.current) await writing.current;
    if (!Object.keys(pending.current).length) return;
    const run = async () => {
      if (mounted.current) setSaving(true);
      try {
        while (Object.keys(pending.current).length && current.current) {
          const changes = pending.current;
          pending.current = {};
          inFlight.current = changes;
          try {
            const next = await api.edit({ id: current.current.id, changes });
            inFlight.current = {};
            receive(next);
            if (mounted.current) setError("");
          } catch (e) {
            pending.current = {
              ...changes,
              ...pending.current,
              ...(changes.listInputs || pending.current.listInputs
                ? {
                    listInputs: {
                      ...changes.listInputs,
                      ...pending.current.listInputs,
                    },
                  }
                : {}),
            };
            inFlight.current = {};
            if (mounted.current)
              setError(
                e instanceof Error
                  ? e.message
                  : "Your changes could not be saved.",
              );
            throw e;
          }
        }
      } finally {
        if (mounted.current) setSaving(false);
      }
    };
    writing.current = run();
    try {
      await writing.current;
    } finally {
      writing.current = null;
    }
  }, [api, receive]);
  const edit = useCallback(
    (changes: DraftEdit) => {
      pending.current = {
        ...pending.current,
        ...changes,
        ...(changes.listInputs
          ? {
              listInputs: {
                ...pending.current.listInputs,
                ...changes.listInputs,
              },
            }
          : {}),
      };
      if (current.current)
        setDraft(
          overlay(overlay(current.current, inFlight.current), pending.current),
        );
      setSaving(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush().catch(() => {}), 120);
    },
    [flush],
  );
  useEffect(() => {
    mounted.current = true;
    let active = true,
      reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const d = await api.current();
        if (active) receive(d);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error
              ? e.message
              : "The saved draft could not be opened.",
          );
      } finally {
        reading = false;
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 1000);
    return () => {
      active = false;
      mounted.current = false;
      clearInterval(interval);
      void flush().catch(() => {});
    };
  }, [api, receive, flush]);
  return { draft, edit, flush, receive, error, saving };
}

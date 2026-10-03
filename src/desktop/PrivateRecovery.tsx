import { useEffect, useState } from "react";
import { node } from "./bridge";
import type { MessageView } from "./node-contract";
import type { Perform } from "./ui";
export function PrivateRecovery({
  mission,
  audience,
  messages,
  perform,
  busy,
}: {
  mission: string;
  audience: string;
  messages: MessageView[];
  perform: Perform;
  busy: boolean;
}) {
  const [items, setItems] = useState<{ member: string; revocation: string }[]>(
    [],
  );
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await node.privateRecovery(mission, audience);
        if (active) {
          setItems(next);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "History review unavailable.",
          );
      }
      if (active) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [mission, audience]);
  if (!items.length)
    return error ? (
      <p className="d-field-help" role="status">
        Private history review is unavailable: {error}
      </p>
    ) : null;
  const item = items[0];
  return (
    <details className="n-review-needed">
      <summary>Review provisional private history</summary>
      <p>
        A participant left or was revoked. Only this conversation’s creator can
        accept its private history. Other members cannot see this decision.
      </p>
      <label className="d-field">
        <span>Accepted history</span>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choose after reviewing the messages…</option>
          <option value="none">
            Accept none of this participant’s private records
          </option>
          {messages
            .filter((m) => m.author === item.member)
            .map((m) => (
              <option key={m.id} value={m.id}>
                Through {m.id.slice(0, 10)} · {m.text.slice(0, 80)}
              </option>
            ))}
        </select>
      </label>
      <p className="d-field-help">
        Only loaded messages are listed. Load older messages to review a
        different point in the history. This decision is permanent; later
        records remain provisional.
      </p>
      <button
        className="d-button"
        disabled={busy || !selected}
        onClick={() =>
          void perform(async () => {
            await node.reconcilePrivate(
              mission,
              audience,
              item.member,
              item.revocation,
              selected === "none" ? null : selected,
            );
            setItems((xs) => xs.slice(1));
            setSelected("");
          })
        }
      >
        Record accepted private history
      </button>
    </details>
  );
}

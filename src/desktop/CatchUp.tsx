import { useEffect, useState } from "react";
import { useApplication } from "./ApplicationProvider";
import { observations } from "../application/observations";
import type { MessageView, Updates } from "../application/contracts/node";
import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";

/** Exact local-arrival cursors, not peer clocks or an AI-generated account. */
export function CatchUp({
  mission,
  owner,
  openMessage,
  openArtifact,
}: {
  mission: string;
  owner: string;
  openMessage: (message: MessageView) => void;
  openArtifact: (revision: string) => void;
}) {
  const { missions } = useApplication();
  const key = `harakiri.catch-up.v1:${owner}:${mission}`;
  const [cursor, setCursor] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved && /^[a-f0-9]{64}$/.test(saved) ? saved : null;
    } catch {
      return null;
    }
  });
  const [page, setPage] = useState<Updates | null>(null);
  const [error, setError] = useState("");
  const save = (next: string | null) => {
    try {
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
    } catch {
      setError("Your catch-up point could not be saved on this computer.");
      return;
    }
    setCursor(next);
    setPage(null);
  };
  useEffect(
    () =>
      observations(missions).subscribe(
        `catch-up:${mission}:${cursor ?? "first"}`,
        () => missions.catchUp(mission, cursor),
        (value) => {
          setPage(value);
          setError("");
          // First use establishes a baseline. Reading this list never sends receipts.
          if (cursor === null && value.after) save(value.after);
        },
        (e) => setError(e.message),
      ),
    [missions, mission, cursor],
  );
  const items = page?.items ?? [];
  const significant = items.filter((m) => m.kind !== "acknowledgment");
  const show = (message: MessageView) => (
    <li key={message.id}>
      <p className="d-label">
        {message.kind === "message" ? "Message" : message.kind} ·{" "}
        {message.author === owner
          ? "You"
          : (message.author_label ?? "Participant")}
      </p>
      <p className="n-catch-up-excerpt">
        {message.text.length > 320
          ? `${message.text.slice(0, 320)}…`
          : message.text}
      </p>
      <div className="n-action-row">
        <Button size="compact" onClick={() => openMessage(message)}>
          Open in conversation
        </Button>
        {message.work?.kind === "artifact" ? (
          <Button size="compact" onClick={() => openArtifact(message.work!.id)}>
            Inspect exact revision
          </Button>
        ) : null}
      </div>
    </li>
  );
  return (
    <section className="n-catch-up">
      <h3>What changed</h3>
      <p>New updates since you last caught up on this Mac.</p>
      {error ? (
        <p role="alert" className="d-alert">
          {error}
        </p>
      ) : null}
      {!page ? (
        <p role="status">Loading saved changes…</p>
      ) : items.length ? (
        <>
          <ul className="n-catch-up-list">{significant.map(show)}</ul>
          {significant.length < items.length ? (
            <Disclosure
              title="Acknowledgments"
              count={items.length - significant.length}
            >
              <ul className="n-catch-up-list">
                {items.filter((m) => m.kind === "acknowledgment").map(show)}
              </ul>
            </Disclosure>
          ) : null}
          <Button onClick={() => save(page.after)}>
            {page.has_more ? "Continue to the next changes" : "Caught up"}
          </Button>
          <p className="d-field-help">Save your reading place on this Mac.</p>
        </>
      ) : (
        <p role="status">
          You’re caught up on this computer. New changes will appear here.
        </p>
      )}
      <Disclosure title="Catch-up settings">
        <p>
          Updates appear as they reach this Mac, including delayed messages.
          Saving your place does not mark conversations read, accept a result or
          acknowledge an agent’s instructions.
        </p>
        <p>
          Resetting starts from the newest saved change. Earlier messages remain
          in their conversations.
        </p>
        <Button onClick={() => save(null)}>
          Start from the latest changes
        </Button>
      </Disclosure>
    </section>
  );
}

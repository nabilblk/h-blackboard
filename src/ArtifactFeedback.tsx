import { useState } from "react";
import { rpc } from "./client";
import { Field, ModalFrame } from "./ui";
import type { Context } from "./model";
import type { Artifact, ArtifactRevision } from "./resources";

export function ArtifactFeedback({
  context,
  artifact,
  revision,
  close,
  sent,
}: {
  context: Context;
  artifact: Artifact;
  revision: ArtifactRevision;
  close: () => void;
  sent: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const coordinator = context.mission.coordinatorId;
  return (
    <ModalFrame
      title="Give feedback"
      label={`${revision.title} · v${revision.number}`}
      close={close}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setBusy(true);
          setError("");
          try {
            await rpc("message_post", {
              channel_id: context.mission.id,
              ...(artifact.directAgentId
                ? { direct_agent_id: artifact.directAgentId }
                : {
                    stream_id:
                      artifact.streamId || context.mission.defaultStreamId,
                    audience: form.get("audience"),
                  }),
              body: `Feedback on ${revision.title} · revision ${revision.number}\n\n${String(form.get("feedback")).trim()}`,
              refs: [revision.id],
              kind: "message",
            });
            sent();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body stack">
          <p className="secondary">
            {artifact.directAgentId
              ? "This feedback stays in the private conversation."
              : `Posted in #${context.workstreams.find((s) => s.id === artifact.streamId)?.name || "Main"}, visible to the mission.`}{" "}
            It references exactly revision {revision.number}.
          </p>
          {!artifact.directAgentId ? (
            <Field label="Address to">
              <select
                name="audience"
                defaultValue={
                  coordinator
                    ? "coordinator"
                    : revision.authorId === "human"
                      ? "everyone"
                      : revision.authorId
                }
              >
                {coordinator ? (
                  <option value="coordinator">Coordinator</option>
                ) : null}
                {revision.authorId !== "human" ? (
                  <option value={revision.authorId}>
                    {context.agents.find((a) => a.id === revision.authorId)
                      ?.name || "Artifact author"}{" "}
                    · author
                  </option>
                ) : null}
                <option value="everyone">Everyone in the workstream</option>
              </select>
            </Field>
          ) : null}
          <Field label="What should change?">
            <textarea
              name="feedback"
              autoFocus
              required
              maxLength={15000}
              rows={5}
              placeholder="Describe what works, what needs changing, or what you want to try next."
            />
          </Field>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Sending…" : "Send feedback"}
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}

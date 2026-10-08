import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import { useApplication } from "./ApplicationProvider";
import { useState } from "react";
import { Hash } from "lucide-react";

import { Text } from "../Markdown";
import type {
  AgentView,
  WorkAction,
  WorkstreamView,
} from "../application/contracts/node";
import { active, type Props } from "./work-ui";
export function WorkstreamPanel({
  mission,
  localKey,
  busy,
  blocked,
  perform,
  changed,
  stream,
  agents,
  open,
}: Props & {
  stream: WorkstreamView | null;
  agents: AgentView[];
  open: (id: string) => void;
}) {
  const { missions: node } = useApplication();
  const [editing, setEditing] = useState(!stream);
  const [snapshot, setSnapshot] = useState(stream);
  const [revision, setRevision] = useState(mission.lifecycle.revision);
  const [assignmentRevision, setAssignmentRevision] = useState({
    control: mission.lifecycle.revision,
    goal: stream?.heads[0]?.id,
  });
  const assignmentChanged =
    assignmentRevision.control !== mission.lifecycle.revision ||
    assignmentRevision.goal !== stream?.heads[0]?.id;
  const editable = mission.owner === localKey && !blocked;
  const change = (action: WorkAction, done?: (id: string) => void) =>
    void perform(async () => {
      const result = await node.work(mission.id, revision, action);
      setEditing(false);
      setAssignmentRevision({ control: revision, goal: result.event });
      await changed();
      done?.(result.event);
    });
  return (
    <div className="n-work-detail">
      {stream ? (
        <>
          <p className="d-label">Public workstream</p>
          <h2>
            <Hash size={20} /> {stream.name}
          </h2>
          <Text value={stream.goal} links="text" />
          <p className="d-field-help">
            Everyone in this mission can read and contribute here. Tasks are
            optional.
          </p>
          {stream.stale ? (
            <p className="d-alert">
              Mission instructions changed. Review this goal before assigning
              work.
            </p>
          ) : null}
          {stream.heads.length > 1 ? (
            <div className="d-alert">
              <strong>Conflicting goals need a decision.</strong>
              {stream.heads.map((h) => (
                <div key={h.id}>
                  <p>{h.name}</p>
                  <Text value={h.goal} links="text" />
                </div>
              ))}
            </div>
          ) : null}
          {editable && !editing ? (
            <Button
              onClick={() => {
                setSnapshot(stream);
                setRevision(mission.lifecycle.revision);
                setEditing(true);
              }}
            >
              Edit goal{stream.heads.length > 1 ? " / resolve conflict" : ""}
            </Button>
          ) : null}
        </>
      ) : (
        <p>
          Give a group a shared direction. A workstream adds a conversation
          beneath this mission.
        </p>
      )}
      {editing && editable ? (
        <form
          className="n-fields"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const fields = {
              name: String(data.get("name")).trim(),
              goal: String(data.get("goal")).trim(),
            };
            change(
              snapshot
                ? {
                    type: "revise_workstream",
                    workstream: snapshot.id,
                    bases: snapshot.heads.slice(0, 256).map((h) => h.id),
                    ...fields,
                  }
                : { type: "create_workstream", ...fields },
              (id) => {
                if (!snapshot) open(id);
              },
            );
          }}
        >
          <Field>
            Name
            <input
              name="name"
              defaultValue={snapshot?.name ?? ""}
              required
              maxLength={80}
              placeholder="e.g. accessibility"
            />
          </Field>
          <Field>
            Shared goal
            <textarea
              name="goal"
              defaultValue={snapshot?.goal ?? ""}
              required
              maxLength={4096}
              rows={4}
              placeholder="What should this group explore or deliver?"
            />
          </Field>
          <div className="n-action-row">
            <Button variant="primary" type="submit" disabled={busy}>
              {snapshot ? "Save goal" : "Create workstream"}
            </Button>
            {stream ? (
              <Button
                type="button"

                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
      {stream ? (
        <>
          <h3>Assigned agents</h3>
          <div className="n-work-assignees">
            {agents
              .filter((a) => a.assignment?.workstream === stream.id)
              .map((a) => (
                <div key={a.id}>
                  <strong>{a.identity.label}</strong>
                  <span className="d-field-help">
                    {!active(a)
                      ? a.status.replaceAll("_", " ")
                      : a.assignment?.stale
                        ? "Goal changed · needs direction"
                        : a.acknowledgment &&
                            a.direction?.id === a.assignment?.id
                          ? "Direction acknowledged"
                          : "Awaiting acknowledgment"}
                  </span>
                </div>
              ))}
          </div>
          {!agents.some((a) => a.assignment?.workstream === stream.id) ? (
            <p className="d-field-help">
              No agents assigned yet. Everyone can still contribute to the
              conversation.
            </p>
          ) : null}
          {editable && stream.heads.length === 1 && !stream.stale ? (
            <form
              className="n-fields"
              onSubmit={(e) => {
                e.preventDefault();
                if (assignmentChanged) return;
                const data = new FormData(e.currentTarget);
                void perform(async () => {
                  await node.work(mission.id, assignmentRevision.control, {
                    type: "assign_workstream",
                    registration: String(data.get("agent")),
                    workstream: stream.id,
                    goal_revision: assignmentRevision.goal ?? null,
                    direction: String(data.get("direction")).trim(),
                  });
                  await changed();
                });
              }}
            >
              {assignmentChanged ? (
                <div className="d-field-help" role="status">
                  <p>
                    The goal or mission instructions changed while this panel
                    was open. Review them before assigning this direction.
                  </p>
                  <Button
                    type="button"

                    onClick={() =>
                      setAssignmentRevision({
                        control: mission.lifecycle.revision,
                        goal: stream.heads[0].id,
                      })
                    }
                  >
                    Use reviewed goal
                  </Button>
                </div>
              ) : null}
              <Field>
                Assign an existing agent
                <select name="agent" required defaultValue="">
                  <option value="" disabled>
                    Select an agent
                  </option>
                  {agents.filter(active).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.identity.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                Direction
                <textarea
                  name="direction"
                  required
                  maxLength={2048}
                  rows={2}
                  placeholder="Describe the approach or contribution you need."
                />
              </Field>
              <Button
                type="submit"
                disabled={busy || assignmentChanged || !agents.some(active)}
              >
                Assign direction
              </Button>
              <p className="d-field-help">
                This is a human direction. Receipt and execution remain
                separate.
              </p>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

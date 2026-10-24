import { Text } from "../Markdown";
import { Button } from "../ui/Button";
import type { ExecutionState } from "../application/contracts/execution";

const actions: Record<string, string> = {
  review_artifact: "Recorded an artifact review",
  post_message: "Posted a conversation message",
  reply: "Replied in a conversation",
};
const completedOperations: Record<string, string> = {
  command: "Workspace command finished",
  publish: "Published an artifact",
  import: "Imported a shared project",
};

/** Local attributed updates, not a percentage or a claim of result quality. */
export function ExecutionUpdate({
  state,
  details,
}: {
  state: ExecutionState;
  details: () => void;
}) {
  const events = [...(state.events ?? [])].reverse();
  const began = Math.max(
    events.find((e) => e.type === "runtime_ready")?.at ?? -Infinity,
    state.record?.transitions
      ?.slice()
      .reverse()
      .find((t) => ["reserving", "launching", "running"].includes(t.to))?.at ??
      -Infinity,
  );
  if (!Number.isFinite(began)) return null;
  const recent = events.filter((e) => e.at >= began);
  const report = recent.find((e) => e.type === "agent" && e.message.trim());
  const activities: { at: number; label: string }[] = [];
  for (const event of recent) {
    if (event.type === "browser_check")
      activities.push({
        at: event.at,
        label: "Checked an artifact in the browser",
      });
    if (event.type !== "tool_outcome") continue;
    try {
      const outcome = JSON.parse(event.message);
      if (outcome.outcome === "ok" && actions[outcome.operation]) {
        activities.push({ at: event.at, label: actions[outcome.operation] });
        break;
      }
    } catch {
      /* An incomplete log entry is not progress evidence. */
    }
  }
  for (const operation of state.operations ?? [])
    if (
      operation.updatedAt >= began &&
      operation.state === "complete" &&
      completedOperations[operation.kind]
    )
      activities.push({
        at: operation.updatedAt,
        label: completedOperations[operation.kind],
      });
  for (const checkpoint of state.checkpoints ?? [])
    if (checkpoint.at >= began && checkpoint.files > 0)
      activities.push({
        at: checkpoint.at,
        label: "Saved a source checkpoint",
      });
  const activity = activities.sort((a, b) => b.at - a.at)[0];
  if (!report && !activity) return null;
  return (
    <section className="d-panel" aria-label="Latest agent update">
      <h4>
        {state.record?.status === "stopped"
          ? "Saved agent update"
          : report
            ? "Agent update"
            : "Latest activity"}
      </h4>
      {report ? (
        <>
          <time
            className="d-field-help"
            dateTime={new Date(report.at).toISOString()}
          >
            {new Date(report.at).toLocaleString()}
          </time>
          <Text
            value={
              report.message.length > 700
                ? `${report.message.slice(0, 700)}…`
                : report.message
            }
            links="text"
          />
        </>
      ) : null}
      {activity ? (
        <p className="d-field-help">
          {activity.label} ·{" "}
          <time dateTime={new Date(activity.at).toISOString()}>
            {new Date(activity.at).toLocaleTimeString()}
          </time>
        </p>
      ) : null}
      <Button onClick={details}>View activity details</Button>
    </section>
  );
}

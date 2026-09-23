import { useState } from "react";
import { rpc, quote } from "./client";
import { Badge, Field } from "./ui";
import { CopyDetail } from "./Execution";
import type { Agent, Context, Session } from "./model";

export const connected = (agent: Agent) =>
  agent.online && !["offline", "error"].includes(agent.status);
export function connectionLabel(agent: Agent) {
  if (connected(agent))
    return agent.status === "working"
      ? "Working"
      : agent.status === "waiting"
        ? "Waiting"
        : agent.status === "paused"
          ? "Paused"
          : "Connected";
  if (agent.recovery?.state === "queued") return "Resume requested";
  if (
    agent.recovery?.runnerOnline &&
    ["starting", "running"].includes(agent.recovery.state)
  )
    return "Reconnecting";
  if (agent.recovery?.state === "failed" || agent.status === "error")
    return "Failed";
  return "Offline";
}
function resumable(agent: Agent) {
  return (
    !connected(agent) &&
    !!agent.recovery?.runnerOnline &&
    agent.recovery.provider.capabilities.resume &&
    !["queued", "starting"].includes(agent.recovery.state)
  );
}
export function Presence({ agent }: { agent: Agent }) {
  return (
    <i
      role="img"
      aria-label={connectionLabel(agent)}
      title={connectionLabel(agent)}
      className={`square ${connected(agent) ? "success" : connectionLabel(agent) === "Failed" ? "danger" : "muted hollow"}`}
    />
  );
}
export function ResumeAgent({
  agent,
  context,
  refresh,
  setup,
}: {
  agent: Agent;
  context: Context;
  refresh: () => Promise<void>;
  setup: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (
    connected(agent) ||
    context.mission.archived ||
    context.mission.state === "closed"
  )
    return null;
  const requestResume = async () => {
    setBusy(true);
    setError("");
    try {
      await rpc("agents_resume", {
        channel_id: context.mission.id,
        agent_ids: [agent.id],
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="recovery-action">
      {!agent.recovery?.runnerOnline ? (
        <button className="button compact" onClick={setup}>
          Connect launcher
        </button>
      ) : (
        <button
          className="button compact"
          disabled={busy || !resumable(agent)}
          onClick={requestResume}
        >
          {busy || agent.recovery.state === "queued"
            ? "Resume requested…"
            : agent.recovery.state === "starting"
              ? "Starting…"
              : "Resume agent"}
        </button>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
export function AgentRecovery({
  agent,
  context,
  refresh,
  setup,
}: {
  agent: Agent;
  context: Context;
  refresh: () => Promise<void>;
  setup: () => void;
}) {
  const e = agent.recovery;
  return (
    <section className="panel-block">
      <div className="section-heading">
        <h3 className="label">Connection</h3>
        <Badge tone={connected(agent) ? "success" : "warning"}>
          {connectionLabel(agent)}
        </Badge>
      </div>
      {e ? (
        <>
          <p>
            {e.provider.label} · {e.runnerName}
          </p>
          <p className="hint">
            Launcher {e.runnerOnline ? "connected" : "offline"} · Isolation:{" "}
            {e.provider.isolation}
          </p>
        </>
      ) : (
        <p className="hint">
          Connect a launcher on the execution machine to make saved sessions
          available here.
        </p>
      )}
      <ResumeAgent
        agent={agent}
        context={context}
        refresh={refresh}
        setup={setup}
      />
      {e?.error ? (
        <p className="error" role="status">
          {e.error}
        </p>
      ) : null}
      {e?.resumeCommand ? (
        <details className="execution-logs">
          <summary>Manual recovery</summary>
          <p className="hint">
            Run on {e.runnerName}. This restores the existing identity and saved
            runtime session.
          </p>
          <CopyDetail label="Resume command" value={e.resumeCommand} />
        </details>
      ) : null}
    </section>
  );
}

export function RecoveryDialog({
  context,
  session,
  refresh,
  close,
}: {
  context: Context;
  session: Session;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  const offline = context.agents.filter((a) => !connected(a));
  const [selection, setSelection] = useState(() =>
    offline.filter(resumable).map((a) => a.id),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [pair, setPair] = useState<{ token: string; expiresAt: number } | null>(
    null,
  );
  const [stateDir, setStateDir] = useState("var/sessions");
  const [requested, setRequested] = useState(false);
  const launchers = [
    ...new Map(
      context.agents
        .filter((a) => a.recovery)
        .map((a) => [a.recovery!.runnerId, a.recovery!]),
    ).values(),
  ];
  const selected = selection.filter((id) =>
    offline.some((a) => a.id === id && resumable(a)),
  );
  const resume = async () => {
    setBusy(true);
    setError("");
    try {
      await rpc("agents_resume", {
        channel_id: context.mission.id,
        agent_ids: selected,
      });
      setRequested(true);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      setPair(await rpc("runner_pair", { channel_id: context.mission.id }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="dialog-body">
        <p>
          Resume the existing agents with their saved conversations, folders,
          and permissions. Work follows the mission’s current start and pause
          settings.
        </p>
        <div className="stack">
          {offline.map((a) => (
            <label className="recovery-choice" key={a.id}>
              <input
                type="checkbox"
                checked={selected.includes(a.id)}
                disabled={busy || !resumable(a)}
                onChange={(e) =>
                  setSelection((ids) =>
                    e.target.checked
                      ? [...ids, a.id]
                      : ids.filter((id) => id !== a.id),
                  )
                }
              />
              <span>
                <strong>{a.name}</strong>
                <small>
                  {a.role === "coordinator" ? "Coordinator" : "Agent"} ·{" "}
                  {connectionLabel(a)}
                  {!a.recovery
                    ? " · Connect its launcher"
                    : !a.recovery.runnerOnline
                      ? " · Launcher offline"
                      : ""}
                </small>
              </span>
            </label>
          ))}
          {!offline.length ? (
            <p className="hint">All agents are connected.</p>
          ) : null}
        </div>
        {selected.length ? (
          <button className="button primary" disabled={busy} onClick={resume}>
            Resume {selected.length}{" "}
            {selected.length === 1 ? "agent" : "agents"}
          </button>
        ) : null}
        {requested ? (
          <p role="status" className="hint">
            Resume requested. Connection status will update after each agent
            reports back.
          </p>
        ) : null}
        {launchers
          .filter((r) => !r.runnerOnline && r.launcherCommand)
          .map((r) => (
            <section key={r.runnerId}>
              <h3>{r.runnerName}</h3>
              <p className="hint">
                Reconnect this launcher on its original machine. Keep it running
                independently of the board service.
              </p>
              <CopyDetail
                label="Reconnect launcher command"
                value={r.launcherCommand!}
              />
            </section>
          ))}
        <details className="task-override" open={!launchers.length || !!pair}>
          <summary>Connect a local launcher</summary>
          <p className="hint">
            Run from your Blackboard checkout on the machine with the saved
            sessions. Connecting makes them available for recovery; it does not
            start agents. Keep this terminal running.
          </p>
          <Field label="Saved sessions folder">
            <input
              value={stateDir}
              onChange={(e) => setStateDir(e.target.value)}
            />
          </Field>
          <button
            className="button"
            disabled={busy || !stateDir.trim()}
            onClick={connect}
          >
            {pair
              ? "Create a new connection command"
              : "Create connection command"}
          </button>
          {pair ? (
            <>
              <CopyDetail
                label="Connect launcher command"
                value={`node bin/harakiri.mjs runner --connect ${quote(`${session.url}/r/${pair.token}`)} --state-dir ${quote(stateDir.trim())}`}
              />
              <p className="hint">
                Single-use connection link, valid until{" "}
                {new Date(pair.expiresAt).toLocaleTimeString()}. This launcher
                is authorized only for this mission.
              </p>
            </>
          ) : null}
        </details>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <footer className="dialog-footer">
        <button className="button" onClick={close}>
          Done
        </button>
      </footer>
    </>
  );
}

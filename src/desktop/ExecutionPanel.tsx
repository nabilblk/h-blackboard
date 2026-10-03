import { useEffect, useState } from "react";
import { Play, Square, Download, Upload, ShieldCheck } from "lucide-react";
import { node, type Contribution } from "./bridge";
import type { GrantView } from "./node-contract";

type ExecutionState = {
  record: null | {
    status: string;
    reason: string;
    session: string | null;
    generation: number | null;
    expiresAt: number | null;
  };
  capacity: number;
  busy: boolean;
  events: { at: number; type: string; message: string }[];
};
type ExecutionAPI = {
  state(id: string): Promise<ExecutionState>;
  prepare(id: string): Promise<void>;
  login(id: string): Promise<{ command: string }>;
  start(id: string, grant: string): Promise<ExecutionState>;
  stop(id: string): Promise<void>;
  exportFiles(id: string): Promise<{ exported: number; directory: string }>;
  importFiles(id: string): Promise<{ imported?: number; cancelled?: boolean }>;
};
declare global {
  interface Window {
    blackboardExecution: ExecutionAPI;
  }
}
const labels: Record<string, string> = {
  preparing: "Preparing VM",
  login_required: "Sign in required",
  ready: "Ready to run",
  reserving: "Reserving allowance",
  launching: "Starting VM",
  running: "Running in VM",
  waiting: "Waiting for updates",
  stopping: "Confirming stop",
  stopped: "Stopped",
  recovery_required: "Recovery required",
  failed: "Preparation failed",
};
const active = new Set([
  "reserving",
  "launching",
  "running",
  "waiting",
  "stopping",
]);

export function ExecutionPanel({ item }: { item: Contribution }) {
  const [state, setState] = useState<ExecutionState | null>(null);
  const [grants, setGrants] = useState<GrantView[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [command, setCommand] = useState("");
  const api = window.blackboardExecution;
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [execution, ledger] = await Promise.all([
          api.state(item.id),
          item.sharedAgent
            ? node.governance(item.mission.missionId)
            : Promise.resolve(null),
        ]);
        if (!cancelled) {
          setState(execution);
          setGrants(
            ledger?.grants.filter(
              (g) =>
                g.registration === item.sharedAgent?.registration &&
                !g.sealed &&
                Math.min(g.expires_ms, g.issued_ms + g.offline_ms) > Date.now(),
            ) ?? [],
          );
        }
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Unable to inspect execution.",
          );
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, item.id, item.mission.missionId, item.sharedAgent?.registration]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      setState(await api.state(item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution operation failed.");
    } finally {
      setBusy(false);
    }
  };
  const runtimeLabel = {
    grok: "Grok Build",
    claude: "Claude Code",
    codex: "Codex",
  }[item.runtime];
  const supported = !!runtimeLabel && !!item.nodeBinding;
  const status = state?.record?.status;
  const working = !!status && active.has(status);
  const available = item.status === "prepared" && !item.sharedAgent?.withdrawn;
  const permission = grants.find((g) => g.id === selected) ?? grants.at(-1);
  return (
    <section className="d-panel n-execution" aria-label="Local agent execution">
      <header>
        <h3>
          <ShieldCheck size={16} /> Local execution
        </h3>
        <span className="d-label" role="status">
          {status ? labels[status] : "Not prepared"}
        </span>
      </header>
      <p>
        {state?.record?.reason ||
          (supported
            ? `Prepare an isolated environment for this contribution, then sign in to ${runtimeLabel} inside it.`
            : "Prepare a contribution to a peer mission to use isolated execution on Apple Silicon with Lima.")}
      </p>
      <dl className="d-facts">
        <div>
          <dt>Environment</dt>
          <dd>Lima · Ubuntu 24.04 · 2 GB RAM · 2 vCPUs</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>
            <code>/workspace</code> in this agent’s VM
          </dd>
        </div>
        <div>
          <dt>Access</dt>
          <dd>
            Workspace tools have no network or credential access. {runtimeLabel}{" "}
            connects to its provider.
          </dd>
        </div>
        {state?.record?.generation ? (
          <div>
            <dt>Generation</dt>
            <dd>
              {state.record.generation}
              {state.record.session ? " · native session saved" : ""}
            </dd>
          </div>
        ) : null}
      </dl>
      {error ? (
        <p className="d-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {supported && !item.sharedAgent ? (
        <p>Share this prepared agent in the mission roster first.</p>
      ) : null}
      {supported && available && item.sharedAgent ? (
        <>
          <div className="n-action-row">
            {!state?.record || status === "failed" ? (
              <button
                className="d-button primary"
                disabled={busy}
                onClick={() => void act(() => api.prepare(item.id))}
              >
                Prepare isolated environment
              </button>
            ) : null}
            {!working && state?.record ? (
              <button
                className="d-button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setCommand((await api.login(item.id)).command);
                  })
                }
              >
                Sign in to {runtimeLabel}…
              </button>
            ) : null}
          </div>
          {command ? (
            <div className="d-field">
              <span>
                Run in Terminal, complete the provider’s login, then return
                here.
              </span>
              <textarea
                readOnly
                rows={4}
                value={command}
                aria-label="Guest login command"
                onFocus={(e) => e.currentTarget.select()}
              />
              <p className="d-field-help">
                This signs in inside the VM. Your host login and configuration
                are not copied.{" "}
                {item.runtime === "claude"
                  ? "Open the link shown in Terminal, sign in with your Claude subscription, and paste the code back there."
                  : "Follow the device login link and code shown in Terminal."}
              </p>
            </div>
          ) : null}
          {!working && ["ready", "stopped"].includes(status ?? "") ? (
            <>
              <label className="d-field">
                <span>Mission permission</span>
                <select
                  value={permission?.id ?? ""}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  <option value="" disabled>
                    No current permission
                  </option>
                  {grants.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.purpose === "planning"
                        ? "Coordinator planning"
                        : "Mission work"}{" "}
                      · {g.turns - g.charged - g.reserved} turns · generation{" "}
                      {g.generation}
                    </option>
                  ))}
                </select>
              </label>
              {permission ? (
                <p className="d-field-help">
                  Approve the isolation policy above and your prepared
                  contribution limits. Permission ends at{" "}
                  {new Date(
                    Math.min(
                      permission.expires_ms,
                      permission.issued_ms + permission.offline_ms,
                    ),
                  ).toLocaleTimeString()}
                  . Human Start is required before workers execute.
                </p>
              ) : (
                <p className="d-field-help">
                  The mission owner issues permissions from Budget. A stopped
                  generation must be replaced before resume.
                </p>
              )}
              <button
                className="d-button primary"
                disabled={busy || !permission}
                onClick={() =>
                  void act(async () => {
                    if (!permission) return;
                    if (!permission.consent)
                      await node.consentGrant(
                        item.mission.missionId,
                        permission.id,
                        item.id,
                      );
                    await api.start(item.id, permission.id);
                  })
                }
              >
                <Play size={14} />{" "}
                {permission?.purpose === "planning"
                  ? "Approve and plan"
                  : "Approve and run"}
              </button>
            </>
          ) : null}
        </>
      ) : null}
      {state?.record ? (
        <div className="n-action-row">
          <button
            className="d-button"
            disabled={busy || status === "stopping"}
            onClick={() => void act(() => api.stop(item.id))}
          >
            <Square size={14} />{" "}
            {status === "recovery_required"
              ? "Recover and confirm stop"
              : "Stop environment"}
          </button>
          <button
            className="d-button"
            disabled={busy || working || status === "recovery_required"}
            onClick={() =>
              void act(async () => {
                const result = await api.exportFiles(item.id);
                setNotice(
                  `${result.exported} files saved in ${result.directory}`,
                );
              })
            }
          >
            <Download size={14} /> Export workspace
          </button>
          <button
            className="d-button"
            disabled={
              busy || working || !available || status === "recovery_required"
            }
            onClick={() =>
              void act(async () => {
                const result = await api.importFiles(item.id);
                if (!result.cancelled)
                  setNotice(`${result.imported} files imported into the VM.`);
              })
            }
          >
            <Upload size={14} /> Import files…
          </button>
        </div>
      ) : null}
      {state?.events.length ? (
        <details>
          <summary>Execution activity</summary>
          <ol className="n-execution-log">
            {state.events.slice(-20).map((event, i) => (
              <li key={`${event.at}:${i}`}>
                <time>{new Date(event.at).toLocaleTimeString()}</time>{" "}
                <strong>{event.type.replaceAll("_", " ")}</strong>
                <p>{event.message}</p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

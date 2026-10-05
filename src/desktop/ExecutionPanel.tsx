import { ContributionConsent } from "./ContributionApproval";
import { useEffect, useState } from "react";
import { Play, Square, Download, Upload, ShieldCheck } from "lucide-react";
import { node, type Contribution } from "./bridge";
import type { GrantView } from "./node-contract";

import type { ExecutionState } from "./execution-types";
import type { MissionView } from "./node-contract";
import { RunApproval, ProviderSetup } from "./ExecutionSetup";
import { agentLifecycle } from "../../shared/agent-lifecycle.mjs";

const labels: Record<string, string> = {
  preparing: "Preparing VM",
  login_required: "Sign in required",
  ready: "Environment ready",
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

export function ExecutionPanel({
  item,
  mission: suppliedMission,
}: {
  item: Contribution;
  mission?: MissionView;
}) {
  const [mission, setMission] = useState(suppliedMission);
  const [owner, setOwner] = useState("");
  const [authInput, setAuthInput] = useState("");
  const [reviewRun, setReviewRun] = useState(false);
  const [manual, setManual] = useState(false);
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
        const [execution, nodeState] = await Promise.all([
          api.state(item.id),
          node.state(),
        ]);
        if (!cancelled) {
          setOwner(nodeState.identity?.owner ?? "");
          setMission(
            nodeState.missions.find((m) => m.id === item.mission.missionId),
          );
        }
        if (!cancelled) {
          setState(execution);
          setGrants(execution.permissions);
        }
      } catch (e) {
        if (!cancelled) {
          setState((previous) =>
            previous
              ? { ...previous, error: "Execution observation unavailable." }
              : null,
          );
          setError(
            e instanceof Error ? e.message : "Unable to inspect execution.",
          );
        }
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
      const execution = await api.state(item.id);
      setState(execution);
      setGrants(execution.permissions);
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
  const available =
    item.status === "prepared" &&
    !item.sharedAgent?.withdrawn &&
    !["closed", "archived"].includes(mission?.lifecycle.phase ?? "");
  const effective = mission
    ? agentLifecycle({
        mission,
        contribution: item,
        execution: state ?? undefined,
        agent: state?.agent ?? undefined,
      })
    : null;
  const permission = grants.find((g) => g.id === selected) ?? grants.at(-1);
  return (
    <section className="d-panel n-execution" aria-label="Local agent execution">
      <header>
        <h3>
          <ShieldCheck size={16} /> Local execution
        </h3>
        <span className="d-label" role="status">
          {effective?.label ?? (status ? labels[status] : "Checking status")}
        </span>
      </header>
      <p>
        {effective?.reason ||
          state?.record?.reason ||
          (supported
            ? `Prepare an isolated environment for this contribution, then sign in to ${runtimeLabel} inside it.`
            : "Prepare a contribution to a peer mission to use isolated execution on Apple Silicon with Lima.")}
      </p>
      {state?.events.at(-1) ? (
        <p className="d-field-help">
          Last observed activity:{" "}
          {new Date(state.events.at(-1)!.at).toLocaleTimeString()} ·{" "}
          {state.events.at(-1)!.type.replaceAll("_", " ")}. Running confirms
          execution, not useful progress.
        </p>
      ) : null}
      {status === "stopped" && state?.record?.interruption ? (
        <div className="d-panel" role="status">
          <h4>Direction changed · review before resuming</h4>
          <p>
            Your agent’s session and files are saved. Its previous permission is
            settled. The mission owner must issue a permission for the current
            direction; you approve it here.
          </p>
          {state.direction ? (
            <p>
              <strong>Current direction</strong>
              <br />
              {state.direction.text}
            </p>
          ) : null}
        </div>
      ) : null}
      {state?.permissionProblem ? (
        <p className="d-field-help">{state.permissionProblem}</p>
      ) : null}
      <details>
        <summary>Environment, limits and session</summary>
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
              Workspace tools have no network or credential access.{" "}
              {runtimeLabel} connects to its provider.
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
      </details>
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
            {!working &&
            state?.record &&
            !state.busy &&
            ["ready", "login_required", "stopped"].includes(status ?? "") ? (
              <button
                className="d-button"
                disabled={busy}
                onClick={() => void act(() => api.signIn(item.id))}
              >
                Sign in to {runtimeLabel}…
              </button>
            ) : null}
          </div>
          {!state?.record || status === "failed" ? <ProviderSetup /> : null}
          {status === "preparing" ? (
            <>
              <progress aria-label="Preparing isolated environment" />
              <button
                className="d-button"
                onClick={() => void act(() => api.cancelSetup(item.id))}
              >
                Cancel environment setup
              </button>
            </>
          ) : null}
          {state?.authentication ? (
            <section className="d-panel" aria-label="Provider sign-in">
              <h4>Sign in inside this agent’s environment</h4>
              {state.authentication.status === "failed" ||
              (state.authentication.expiresAt &&
                state.authentication.expiresAt <= Date.now()) ? (
                <button
                  className="d-button primary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api.cancelLogin(item.id);
                      await api.signIn(item.id);
                    })
                  }
                >
                  Get a fresh sign-in
                </button>
              ) : null}
              <p role="status">
                {state.authentication.status === "complete"
                  ? "Signed in. Continue to contribution approval below."
                  : state.authentication.status === "failed"
                    ? state.authentication.failure === "expired"
                      ? "This code expired. Get a fresh code when you are ready."
                      : state.authentication.failure === "denied"
                        ? "Sign-in was declined. Retry when you are ready."
                        : "Sign-in did not complete. Retry below; your environment and files are saved."
                    : state.authentication.status === "starting"
                      ? "Checking your existing guest login and preparing sign-in…"
                      : "Open the provider in your browser and complete sign-in. Keep this step open until confirmation."}
              </p>
              {state.authentication.code ? (
                <label className="d-field">
                  Provider code
                  <input
                    readOnly
                    value={state.authentication.code}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </label>
              ) : null}
              {state.authentication.expiresAt ? (
                <p className="d-field-help">
                  {state.authentication.expiresAt <= Date.now()
                    ? "Code expired. Cancel this sign-in and retry for a new code."
                    : `Code expires at ${new Date(state.authentication.expiresAt).toLocaleTimeString()}.`}
                </p>
              ) : state.authentication.status === "waiting" ? (
                <p className="d-field-help">
                  The provider did not report a code expiry. If it rejects the
                  code, cancel and retry to get a fresh one.
                </p>
              ) : null}
              <details>
                <summary>Provider details</summary>
                <pre className="n-auth-output">{state.authentication.text}</pre>
              </details>
              {(state.authentication.status === "waiting" &&
              (!state.authentication.expiresAt ||
                state.authentication.expiresAt > Date.now())
                ? state.authentication.urls
                : []
              ).map((url) => (
                <button
                  key={url}
                  className="d-button"
                  onClick={() => void act(() => api.openLogin(item.id, url))}
                >
                  Open provider sign-in
                </button>
              ))}
              {["starting", "waiting"].includes(state.authentication.status) ? (
                <>
                  {item.runtime === "claude" ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const code = authInput;
                        setAuthInput("");
                        void act(() => api.loginInput(item.id, code));
                      }}
                    >
                      <label className="d-field">
                        Code returned by the provider
                        <input
                          type="password"
                          autoComplete="off"
                          value={authInput}
                          onChange={(e) => setAuthInput(e.target.value)}
                          required
                          maxLength={4096}
                        />
                      </label>
                      <button
                        className="d-button"
                        disabled={busy || !authInput}
                      >
                        Submit sign-in code
                      </button>
                    </form>
                  ) : null}
                  <button
                    className="d-button"
                    onClick={() => void act(() => api.cancelLogin(item.id))}
                  >
                    Cancel sign-in
                  </button>
                </>
              ) : null}
            </section>
          ) : null}
          {!working && state?.record && status !== "failed" ? (
            <details>
              <summary>Sign-in diagnostics</summary>
              <button
                className="d-button"
                disabled={busy || state.busy}
                onClick={() =>
                  void act(async () =>
                    setCommand((await api.login(item.id)).command),
                  )
                }
              >
                Show Terminal fallback
              </button>
            </details>
          ) : null}
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
          {mission &&
          state?.agent &&
          [
            "ready",
            "stopped",
            "waiting",
            "running",
            "launching",
            "reserving",
          ].includes(status ?? "") &&
          (mission.lifecycle.phase !== "preparing" ||
            item.mission.role !== "coordinator") ? (
            <ContributionConsent
              mission={mission}
              agent={state.agent}
              contribution={item}
              isOwner={owner === mission.owner}
            />
          ) : null}
          {!working &&
          ["ready", "stopped"].includes(status ?? "") &&
          mission?.lifecycle.phase === "active" ? (
            <label className="n-check-label">
              <input
                type="checkbox"
                checked={manual}
                disabled={state?.agreement?.status === "active"}
                onChange={(e) => setManual(e.target.checked)}
              />
              Approve one permission at a time{" "}
              {state?.agreement?.status === "active"
                ? "(stop automatic contribution first)"
                : ""}
            </label>
          ) : null}
          {!working &&
          ["ready", "stopped"].includes(status ?? "") &&
          (mission?.lifecycle.phase === "preparing" ||
            (manual && mission?.lifecycle.phase === "active")) ? (
            <>
              {mission &&
              owner === mission.owner &&
              (mission.lifecycle.phase === "active" ||
                mission.lifecycle.coordinator?.identity.author ===
                  item.sharedAgent?.author) &&
              !permission ? (
                <>
                  <button
                    className="d-button primary"
                    onClick={() => setReviewRun((v) => !v)}
                  >
                    {mission.lifecycle.phase === "preparing"
                      ? "Review planning session"
                      : "Review next run"}
                  </button>
                  {reviewRun && state ? (
                    <RunApproval
                      item={item}
                      mission={mission}
                      execution={state}
                      done={async () => {
                        setReviewRun(false);
                        setState(await api.state(item.id));
                      }}
                    />
                  ) : null}
                </>
              ) : null}
              {permission ? (
                <label className="d-field">
                  <span>Current run permission</span>
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
              ) : null}
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
              ) : status === "stopped" ? (
                <p className="d-field-help">
                  A new run needs a fresh permission and your approval on this
                  device.
                </p>
              ) : null}
              {permission ? (
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
                    : state?.record?.session
                      ? "Approve and resume"
                      : "Approve and run"}
                </button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {state?.record && status !== "preparing" ? (
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
      {state?.record?.transitions?.length ? (
        <details>
          <summary>State history</summary>
          <ol className="n-execution-log">
            {state.record.transitions
              .slice(-15)
              .reverse()
              .map((t, i) => (
                <li key={`${t.at}:${i}`}>
                  <time>{new Date(t.at).toLocaleTimeString()}</time>{" "}
                  <strong>
                    {labels[t.from] ?? t.from} → {labels[t.to] ?? t.to}
                  </strong>
                  <p>{t.reason}</p>
                </li>
              ))}
          </ol>
        </details>
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

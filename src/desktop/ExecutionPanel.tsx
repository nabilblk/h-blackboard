import { ViewTabs } from "../ui/ViewTabs";
import { Disclosure } from "../ui/Disclosure";
import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import { useApplication } from "./ApplicationProvider";
import { ContributionConsent } from "./ContributionApproval";
import { useEffect, useState } from "react";
import { Play, Square, Download, Upload, ShieldCheck } from "lucide-react";
import { type Contribution } from "../application/contracts/workspace";
import type { GrantView } from "../application/contracts/node";

import type { ExecutionState } from "../application/contracts/execution";
import type { MissionView } from "../application/contracts/node";
import { RunApproval, ProviderSetup } from "./ExecutionSetup";
import { NetworkAccessSettings } from "./NetworkAccess";
import { agentPresentation } from "../../shared/mission-presentation.mjs";

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
  const { execution: api, missions: node } = useApplication();
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
  const [tab, setTab] = useState<"activity" | "access" | "technical">(
    "activity",
  );
  const [historySearch, setHistorySearch] = useState("");
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
  }, [
    api,
    item.id,
    item.mission.missionId,
    item.sharedAgent?.registration,
    node,
  ]);
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
    ? agentPresentation({
        viewer: owner,
        mission,
        contribution: item,
        execution: state ?? undefined,
        agent: state?.agent ?? undefined,
      })
    : null;
  const permission = grants.find((g) => g.id === selected) ?? grants.at(-1);
  const authentication = state?.authentication;
  const signInOpen =
    !!authentication &&
    !["complete", "cancelled"].includes(authentication.status);
  const signInExpired =
    !!authentication?.expiresAt && authentication.expiresAt <= Date.now();
  const networkAccess =
    state?.networkAccess ?? item.networkAccess ?? "restricted";
  const networkRevision =
    state?.networkRevision ?? item.networkRevision ?? null;
  return (
    <section className="d-panel n-execution" aria-label="Local agent execution">
      <header>
        <h3>
          <ShieldCheck size={16} /> {effective?.label ?? "Local execution"}
        </h3>
        <span className="d-label" role="status">
          This Mac
        </span>
      </header>
      <p role="status" hidden={tab === "activity" && signInOpen}>
        {effective?.reason ||
          state?.record?.reason ||
          (supported
            ? `Prepare an isolated environment for this contribution, then sign in to ${runtimeLabel} inside it.`
            : "Prepare a contribution to a peer mission to use isolated execution on Apple Silicon with Lima.")}
      </p>
      <ViewTabs
        label="Agent inspector views"
        value={tab}
        onChange={setTab}
        items={[
          { value: "activity", label: "Activity" },
          { value: "access", label: "Access & limits" },
          { value: "technical", label: "Technical" },
        ]}
      />
      {tab === "activity" &&
      status === "stopped" &&
      state?.record?.interruption ? (
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
      {tab === "access" && state?.permissionProblem ? (
        <p className="d-field-help">{state.permissionProblem}</p>
      ) : null}
      <section hidden={tab !== "technical"} aria-label="Environment and source">
        <h4>Environment and source</h4>
        <Button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await api.exportDiagnostics(item.id);
              if (!result.cancelled)
                setNotice(
                  "Diagnostics exported: execution states and times only.",
                );
            })
          }
        >
          Export diagnostics
        </Button>
        <p className="d-field-help">
          Exports states and times. Provider output, prompts, credentials and
          paths stay on this Mac.
        </p>
        <p className="d-field-help">
          {effective?.source} ·{" "}
          {effective?.fresh ? "Current" : "Expired or unavailable"}
          {effective?.observedAt
            ? ` · ${new Date(effective.observedAt).toLocaleTimeString()}`
            : ""}
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
              {networkAccess === "internet"
                ? "Public HTTPS through a filtered proxy. No direct network route or private destinations. "
                : "Workspace internet blocked. "}
              {runtimeLabel} connects only to its provider. Worker tools have no
              provider credentials.
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
          <div>
            <dt>Technical state</dt>
            <dd>{effective?.technicalState ?? "unknown"}</dd>
          </div>
          <div>
            <dt>Dependency</dt>
            <dd>{effective?.cause ?? "observation_missing"}</dd>
          </div>
          <div>
            <dt>Contribution</dt>
            <dd className="n-key">{item.id}</dd>
          </div>
        </dl>
      </section>
      {error ? (
        <p className="d-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <section hidden={tab !== "access"} aria-label="Execution limits">
        {supported &&
        item.status === "prepared" &&
        !item.sharedAgent?.withdrawn ? (
          <NetworkAccessSettings
            value={networkAccess}
            revision={networkRevision}
            disabled={
              busy ||
              !state ||
              !!state.error ||
              state.busy ||
              active.has(status ?? "") ||
              status === "preparing" ||
              status === "recovery_required" ||
              signInOpen
            }
            save={(value, revision) =>
              void act(async () => {
                await api.setNetwork(item.id, value, revision);
                setReviewRun(false);
                setNotice(
                  "Internet setting applied. Review execution permission before continuing.",
                );
              })
            }
          />
        ) : null}
        <dl className="d-facts">
          <div>
            <dt>Account</dt>
            <dd>Your {runtimeLabel} subscription</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>Isolated VM · no Mac folders or credentials mounted</dd>
          </div>
          <div>
            <dt>Local allowance</dt>
            <dd>
              {item.limits.mode === "unlimited"
                ? "Unlimited; contribution approvals remain finite"
                : `${item.limits.turns} turns · ${item.limits.minutes} minutes`}
            </dd>
          </div>
          <div>
            <dt>Provider access</dt>
            <dd>
              {runtimeLabel} connects to its provider. Workspace tools have no
              provider credentials.
            </dd>
          </div>
        </dl>
      </section>
      {supported && !item.sharedAgent ? (
        <p>Share this prepared agent in the mission roster first.</p>
      ) : null}
      {supported && available && item.sharedAgent ? (
        <>
          <div hidden={tab !== "activity"}>
            <div className="n-action-row">
              {!state?.record || status === "failed" ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void act(() => api.prepare(item.id))}
                >
                  Prepare isolated environment
                </Button>
              ) : null}
              {!working &&
              state?.record &&
              !state.busy &&
              !signInOpen &&
              status === "login_required" ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void act(() => api.signIn(item.id))}
                >
                  Sign in to {runtimeLabel}…
                </Button>
              ) : null}
            </div>
            {!state?.record || status === "failed" ? <ProviderSetup /> : null}
            {status === "preparing" ? (
              <>
                <progress aria-label="Preparing isolated environment" />
                <Button
                  onClick={() => void act(() => api.cancelSetup(item.id))}
                >
                  Cancel environment setup
                </Button>
              </>
            ) : null}
            {state?.authentication &&
            state.authentication.status !== "complete" &&
            state.authentication.status !== "cancelled" ? (
              <section className="d-panel" aria-label="Provider sign-in">
                <h4>{runtimeLabel} sign-in</h4>
                {state.authentication.status === "failed" ||
                (state.authentication.expiresAt &&
                  state.authentication.expiresAt <= Date.now()) ? (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api.cancelLogin(item.id);
                        await api.signIn(item.id);
                      })
                    }
                  >
                    Get a fresh sign-in
                  </Button>
                ) : null}
                <p role="status">
                  {signInExpired
                    ? "This code expired. Get a fresh code when you are ready."
                    : state.authentication.status === "failed"
                      ? state.authentication.failure === "expired"
                        ? "This code expired. Get a fresh code when you are ready."
                        : state.authentication.failure === "denied"
                          ? "Sign-in was declined. Retry when you are ready."
                          : "Sign-in did not complete. Retry below; your environment and files are saved."
                      : state.authentication.status === "starting"
                        ? "Checking your existing guest login and preparing sign-in…"
                        : "Complete sign-in in your browser. Confirmation appears here automatically."}
                </p>
                {state.authentication.code &&
                !signInExpired &&
                state.authentication.status === "waiting" ? (
                  <Field>
                    Provider code
                    <input
                      readOnly
                      value={state.authentication.code}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </Field>
                ) : null}
                {state.authentication.expiresAt && !signInExpired ? (
                  <p className="d-field-help">
                    Code expires at{" "}
                    {new Date(
                      state.authentication.expiresAt,
                    ).toLocaleTimeString()}
                    .
                  </p>
                ) : state.authentication.status === "waiting" &&
                  !signInExpired ? (
                  <p className="d-field-help">
                    The provider did not report a code expiry. If it rejects the
                    code, cancel and retry to get a fresh one.
                  </p>
                ) : null}
                <Disclosure title={<>Provider details</>}>
                  <pre className="n-auth-output">
                    {state.authentication.text}
                  </pre>
                </Disclosure>
                {(state.authentication.status === "waiting" &&
                (!state.authentication.expiresAt ||
                  state.authentication.expiresAt > Date.now())
                  ? state.authentication.urls
                  : []
                ).map((url) => (
                  <Button
                    key={url}
                    variant="primary"
                    disabled={busy}
                    onClick={() => void act(() => api.openLogin(item.id, url))}
                  >
                    Open provider sign-in
                  </Button>
                ))}
                {["starting", "waiting"].includes(
                  state.authentication.status,
                ) ? (
                  <>
                    {item.runtime === "claude" && !signInExpired ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const code = authInput;
                          setAuthInput("");
                          void act(() => api.loginInput(item.id, code));
                        }}
                      >
                        <Field>
                          Code returned by the provider
                          <input
                            type="password"
                            autoComplete="off"
                            value={authInput}
                            onChange={(e) => setAuthInput(e.target.value)}
                            required
                            maxLength={4096}
                          />
                        </Field>
                        <Button type="submit" disabled={busy || !authInput}>
                          Submit sign-in code
                        </Button>
                      </form>
                    ) : null}
                    <Button
                      onClick={() => void act(() => api.cancelLogin(item.id))}
                    >
                      Cancel sign-in
                    </Button>
                  </>
                ) : null}
              </section>
            ) : null}
          </div>
          {tab === "technical" &&
          !working &&
          state?.record &&
          status !== "failed" ? (
            <section aria-label="Sign-in diagnostics">
              <h4>Sign-in diagnostics</h4>
              <Button
                disabled={busy || state.busy}
                onClick={() => {
                  setTab("activity");
                  void act(() => api.signIn(item.id));
                }}
              >
                Sign in again
              </Button>
              <Button
                disabled={busy || state.busy}
                onClick={() =>
                  void act(async () =>
                    setCommand((await api.login(item.id)).command),
                  )
                }
              >
                Show Terminal fallback
              </Button>
            </section>
          ) : null}
          {command && tab === "technical" ? (
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
          {tab === "access" &&
          mission &&
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
              contribution={{
                ...item,
                networkAccess,
                networkRevision: networkRevision ?? undefined,
              }}
              isOwner={owner === mission.owner}
            />
          ) : null}
          {tab === "activity" &&
          mission &&
          state?.agent &&
          ["ready", "stopped", "waiting", "running"].includes(status ?? "") &&
          (mission.lifecycle.phase !== "preparing" ||
            item.mission.role !== "coordinator") ? (
            <Button
              variant={effective?.action ? "primary" : "secondary"}
              onClick={() => setTab("access")}
            >
              {state?.agreement?.status === "active"
                ? "View contribution approval"
                : "Review contribution"}
            </Button>
          ) : null}
          {tab === "access" &&
          !working &&
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
          {((tab === "activity" &&
            mission?.lifecycle.phase === "preparing" &&
            mission.lifecycle.start_blockers.length > 0) ||
            (tab === "access" && manual)) &&
          !working &&
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
                  <Button
                    variant={reviewRun ? "secondary" : "primary"}
                    onClick={() => setReviewRun((v) => !v)}
                  >
                    {mission.lifecycle.phase === "preparing"
                      ? "Review planning session"
                      : "Review next run"}
                  </Button>
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
                <Field>
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
                </Field>
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
                <Button
                  variant="primary"
                  disabled={busy || !permission}
                  onClick={() =>
                    void act(async () => {
                      if (!permission) return;
                      if (!permission.consent)
                        await node.consentGrant(
                          item.mission.missionId,
                          permission.id,
                          item.id,
                          networkRevision,
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
                </Button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {state?.record &&
      status !== "preparing" &&
      (working || status === "recovery_required" || tab === "technical") ? (
        <div className="n-action-row">
          <Button
            disabled={busy || status === "stopping"}
            onClick={() => void act(() => api.stop(item.id))}
          >
            <Square size={14} />{" "}
            {status === "recovery_required"
              ? "Recover and confirm stop"
              : "Stop environment"}
          </Button>
          {tab === "technical" ? (
            <>
              <Button
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
              </Button>
              <Button
                disabled={
                  busy ||
                  working ||
                  !available ||
                  status === "recovery_required"
                }
                onClick={() =>
                  void act(async () => {
                    const result = await api.importFiles(item.id);
                    if (!result.cancelled)
                      setNotice(
                        `${result.imported} files imported into the VM.`,
                      );
                  })
                }
              >
                <Upload size={14} /> Import files…
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {tab === "technical" ? (
        <Field className="n-history-search">
          Search operation history
          <input
            type="search"
            value={historySearch}
            onChange={(e) => setHistorySearch(e.target.value)}
          />
        </Field>
      ) : null}
      {tab === "technical" && state?.record?.transitions?.length ? (
        <section aria-label="State history">
          <h4>State history</h4>
          <ol className="n-execution-log">
            {state.record.transitions
              .filter((t) =>
                `${t.from} ${t.to} ${t.reason}`
                  .toLowerCase()
                  .includes(historySearch.trim().toLowerCase()),
              )
              .slice(-50)
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
        </section>
      ) : null}
      {tab === "technical" && state?.events.length ? (
        <section aria-label="Execution activity">
          <h4>Execution activity</h4>
          <ol className="n-execution-log">
            {state.events
              .filter((e) =>
                `${e.type} ${e.message}`
                  .toLowerCase()
                  .includes(historySearch.trim().toLowerCase()),
              )
              .slice(-50)
              .map((event, i) => (
                <li key={`${event.at}:${i}`}>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>{" "}
                  <strong>{event.type.replaceAll("_", " ")}</strong>
                  <p>{event.message}</p>
                </li>
              ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}

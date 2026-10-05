import { useEffect, useState } from "react";
import { desktop, node, type Contribution, type Runtime } from "./bridge";
import type { MissionView } from "./node-contract";
import { ExecutionPanel } from "./ExecutionPanel";
import { useSetupDraft } from "./useSetupDraft";
import { AgentState, useExecutionStates } from "./ExecutionStatus";
import { ProviderSetup } from "./ExecutionSetup";
import { GroupContributionConsent } from "./ContributionApproval";
import type { SetupRequest, AgentSetupJob } from "./onboarding-types";
type AgentDraft = {
  runtime: Runtime;
  name: string;
  count: number;
  mode: "bounded" | "unlimited";
  turns: number;
  minutes: number;
};
const validDraft = (v: unknown): v is AgentDraft => {
  if (!v || typeof v !== "object") return false;
  const x = v as AgentDraft;
  return (
    ["grok", "claude", "codex"].includes(x.runtime) &&
    typeof x.name === "string" &&
    x.name.length <= 90 &&
    Number.isInteger(x.count) &&
    x.count >= 1 &&
    x.count <= 32 &&
    ["bounded", "unlimited"].includes(x.mode) &&
    Number.isInteger(x.turns) &&
    x.turns > 0 &&
    x.turns <= 10000 &&
    Number.isInteger(x.minutes) &&
    x.minutes > 0 &&
    x.minutes <= 10080
  );
};
export function AgentSetup({
  mission,
  localKey,
  role,
  contributions,
  updated,
  reviewMission,
}: {
  mission: MissionView;
  localKey: string;
  role: "agent" | "coordinator";
  contributions: Contribution[];
  updated: () => Promise<void>;
  reviewMission?: () => void;
}) {
  const [draft, save, clear, draftError] = useSetupDraft<AgentDraft>(
    `${mission.id}:${role}`,
    {
      runtime: "grok",
      name: role === "coordinator" ? "Coordinator" : "Agent",
      count: 1,
      mode: "bounded",
      turns: 20,
      minutes: 60,
    },
    validDraft,
  );
  const [terms] = useState(mission.lifecycle.terms_revision);
  const [workspace, setWorkspace] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [jobs, setJobs] = useState<AgentSetupJob[]>([]);
  const [focus, saveFocus] = useSetupDraft<{ id: string | null }>(
    `${mission.id}:${role}:setup-focus`,
    { id: null },
    (v): v is { id: string | null } =>
      !!v &&
      typeof v === "object" &&
      (typeof (v as { id: unknown }).id === "string" ||
        (v as { id: unknown }).id === null),
  );
  const selected = focus.id;
  const setSelected = (id: string | null) => saveFocus({ id });
  const executionStates = useExecutionStates();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [available, setAvailable] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await window.blackboardSetup.state(mission.id);
        if (!cancelled) setJobs(value.filter((j) => j.kind === "setup"));
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Setup status unavailable.",
          );
      }
      if (!cancelled) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mission.id]);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
      await updated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup failed.");
    } finally {
      setBusy(false);
    }
  };
  const local = contributions.filter(
    (c) =>
      c.mission.missionId === mission.id &&
      c.mission.role === role &&
      c.status === "prepared" &&
      !c.sharedAgent?.withdrawn,
  );
  const current =
    local.find((c) => c.id === selected) ??
    local.find((c) =>
      ["login_required", "failed", "ready"].includes(
        executionStates?.[c.id]?.record?.status ?? "",
      ),
    ) ??
    local[0];
  const signedIn = local.filter((c) =>
    [
      "ready",
      "stopped",
      "waiting",
      "running",
      "reserving",
      "launching",
    ].includes(executionStates?.[c.id]?.record?.status ?? ""),
  );
  const pending = jobs.filter(
    (j) => !["complete", "cancelled"].includes(j.status),
  );
  return (
    <section className="n-guided-setup" aria-label="Guided agent setup">
      <h2>
        {role === "coordinator" ? "Set up your Coordinator" : "Add your agents"}
      </h2>
      <p>
        {role === "coordinator"
          ? "Prepare an isolated agent to write the plan. You review the plan and start mission work."
          : "Choose what this Mac contributes. Each agent keeps its own identity, environment and provider login."}
      </p>
      <ol className="n-setup-steps" aria-label="Setup progress">
        <li aria-current={!local.length ? "step" : undefined}>
          1 · Prepare {local.length ? "✓" : ""}
        </li>
        <li
          aria-current={
            local.length && signedIn.length < local.length ? "step" : undefined
          }
        >
          2 · Sign in {local.length ? `${signedIn.length}/${local.length}` : ""}
        </li>
        <li
          aria-current={
            local.length && signedIn.length === local.length
              ? "step"
              : undefined
          }
        >
          3 · {role === "coordinator" ? "Prepare plan" : "Approve contribution"}
        </li>
        {role === "coordinator" ? <li>4 · Review and Start</li> : null}
      </ol>
      {role === "coordinator" && mission.lifecycle.readiness ? (
        <section className="d-panel">
          <h3>Your plan is ready</h3>
          <p>
            The Coordinator acknowledged the plan. Review it to start mission
            work.
          </p>
          <button className="d-button primary" onClick={reviewMission}>
            Review plan and Start
          </button>
        </section>
      ) : null}
      <ProviderSetup ready={setAvailable} />
      {error || draftError ? (
        <p role="alert" className="d-error">
          {error || draftError}
        </p>
      ) : null}
      {pending.map((job) => (
        <section
          key={job.id}
          className="d-panel"
          aria-label="Saved agent setup"
        >
          <h3>
            {job.request.label} · {job.step}/{job.contributions.length} prepared
          </h3>
          <p role="status">{job.message}</p>
          <div className="n-action-row">
            {job.status !== "running" ? (
              <button
                className="d-button primary"
                disabled={
                  busy ||
                  !available ||
                  job.request.terms !== mission.lifecycle.terms_revision
                }
                onClick={() =>
                  void act(() => window.blackboardSetup.setup(job.request))
                }
              >
                Continue saved setup
              </button>
            ) : (
              <progress
                aria-label="Preparing agents"
                value={job.step}
                max={job.contributions.length}
              />
            )}
            <button
              className="d-button"
              disabled={busy}
              onClick={() =>
                void act(() => window.blackboardSetup.cancel(job.id))
              }
            >
              Cancel setup
            </button>
          </div>
        </section>
      ))}
      <details open={!local.length && !pending.length}>
        <summary>
          {local.length
            ? "Add another contribution"
            : "Review this contribution"}
        </summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const request: SetupRequest = {
                id: requestId,
                mission: mission.id,
                terms,
                role,
                runtime: draft.runtime,
                label: draft.name.trim(),
                count: role === "coordinator" ? 1 : draft.count,
                limits:
                  draft.mode === "unlimited"
                    ? { mode: "unlimited", concurrency: 1 }
                    : {
                        mode: "bounded",
                        concurrency: 1,
                        turns: draft.turns,
                        minutes: draft.minutes,
                      },
                workspaceChoiceId: workspace?.id ?? null,
              };
              await window.blackboardSetup.setup(request);
              clear();
              setRequestId(crypto.randomUUID());
            });
          }}
        >
          <fieldset
            className="n-fields"
            disabled={busy || pending.some((j) => j.status === "running")}
          >
            <label className="d-field">
              Agent name
              <input
                required
                maxLength={90}
                value={draft.name}
                onChange={(e) => save({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="d-field">
              Runtime
              <select
                value={draft.runtime}
                onChange={(e) =>
                  save({ ...draft, runtime: e.target.value as Runtime })
                }
              >
                <option value="grok">Grok Build</option>
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            {role === "agent" ? (
              <label className="d-field">
                Number of agents
                <input
                  type="number"
                  min={1}
                  max={32}
                  required
                  value={draft.count}
                  onChange={(e) =>
                    save({ ...draft, count: Number(e.target.value) })
                  }
                />
              </label>
            ) : null}
            <details>
              <summary>
                Local limits ·{" "}
                {draft.mode === "unlimited"
                  ? "Unlimited"
                  : `${draft.turns} turns · ${draft.minutes} minutes`}
              </summary>
              <label className="d-field">
                Local allowance per agent
                <select
                  value={draft.mode}
                  onChange={(e) =>
                    save({
                      ...draft,
                      mode: e.target.value as AgentDraft["mode"],
                    })
                  }
                >
                  <option value="bounded">Set turn and time limits</option>
                  <option value="unlimited">Unlimited</option>
                </select>
              </label>
              {draft.mode === "bounded" ? (
                <div className="d-limit-fields">
                  <label className="d-field">
                    Runtime turns
                    <input
                      type="number"
                      required
                      min={1}
                      max={10000}
                      value={draft.turns}
                      onChange={(e) =>
                        save({ ...draft, turns: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label className="d-field">
                    Minutes from first run
                    <input
                      type="number"
                      required
                      min={1}
                      max={10080}
                      value={draft.minutes}
                      onChange={(e) =>
                        save({ ...draft, minutes: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
              ) : (
                <p>
                  Unlimited local allowance. Each run still needs bounded
                  permission and your approval. Provider subscription limits
                  apply.
                </p>
              )}
            </details>
            <p>
              Each agent works in <code>/workspace</code> inside its VM. Sign in
              there with your subscription. Your Mac’s credentials and folders
              are not copied or mounted.
            </p>
            <details>
              <summary>Export location</summary>
              <p className="n-key">
                {workspace?.path ??
                  "Documents / Harakiri Exports · a separate folder for each agent"}
              </p>
              <p>Files reach this Mac only when you explicitly export them.</p>
              <button
                type="button"
                className="d-button"
                onClick={() =>
                  void act(async () => {
                    const selected = await desktop.chooseWorkspace();
                    if (selected) setWorkspace(selected);
                  })
                }
              >
                Change export location…
              </button>
            </details>
            <label className="n-check">
              <input type="checkbox" required />I approve these local limits,
              downloading the verified environment, and sharing these agents’
              names and runtimes with this mission. Running requires a separate
              approval.
            </label>
            {terms !== mission.lifecycle.terms_revision ? (
              <p role="alert">
                Mission instructions changed. Close and reopen this panel to
                review the current terms.
              </p>
            ) : null}
            <button
              className="d-button primary"
              disabled={
                !available || terms !== mission.lifecycle.terms_revision
              }
            >
              {role === "coordinator"
                ? "Prepare Coordinator"
                : "Prepare agents"}
            </button>
          </fieldset>
        </form>
      </details>
      {local.length ? (
        <section aria-label="Your prepared agents">
          <h3>
            Continue setup · {signedIn.length}/{local.length} signed in
          </h3>
          {role === "agent" ? (
            <GroupContributionConsent
              mission={mission}
              contributions={signedIn}
              isOwner={localKey === mission.owner}
              done={updated}
            />
          ) : null}
          {local.length > 1 ? (
            <p>
              Each isolated agent needs its own guest login. Complete one
              sign-in, then select the next agent when you are ready; codes are
              only generated when you start that step.
            </p>
          ) : null}
          {local.map((c) => (
            <div key={c.id} className="n-setup-agent">
              <AgentState mission={mission} contribution={c} />
              <button
                className="d-button"
                aria-expanded={current?.id === c.id}
                onClick={() => setSelected(selected === c.id ? null : c.id)}
              >
                {c.sharedAgent?.label ?? c.runtime} ·{" "}
                {signedIn.includes(c) ? "Continue" : "Sign in"}
              </button>
              {!c.sharedAgent ? (
                <button
                  className="d-button"
                  onClick={() =>
                    void act(() =>
                      node.shareAgent(
                        mission.id,
                        c.id,
                        `${c.runtime}-${c.id.slice(0, 6)}`,
                      ),
                    )
                  }
                >
                  Share this prepared agent
                </button>
              ) : null}
              {mission.owner === localKey &&
              !mission.lifecycle.coordinator &&
              c.mission.role === "coordinator" &&
              c.nodeBinding?.revision === mission.lifecycle.terms_revision ? (
                <button
                  className="d-button primary"
                  onClick={() =>
                    void act(() =>
                      node.appointCoordinator(
                        mission.id,
                        mission.lifecycle.revision,
                        c.id,
                      ),
                    )
                  }
                >
                  Appoint this Coordinator
                </button>
              ) : null}
              {current?.id === c.id ? (
                <ExecutionPanel item={c} mission={mission} />
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
    </section>
  );
}

import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import { Field } from "../ui/Field";
import { useApplication } from "./ApplicationProvider";
import { useEffect, useRef, useState } from "react";
import {
  type Contribution,
  type Runtime,
  type NetworkAccess,
} from "../application/contracts/workspace";
import type { MissionView } from "../application/contracts/node";
import { ExecutionPanel } from "./ExecutionPanel";
import { useSetupDraft } from "./useSetupDraft";
import { AgentState, useExecutionStates } from "./ExecutionStatus";
import { ProviderSetup } from "./ExecutionSetup";
import { NetworkAccessField } from "./NetworkAccess";
import { GroupContributionConsent } from "./ContributionApproval";
import type {
  SetupRequest,
  AgentSetupJob,
  Preflight,
} from "../application/contracts/setup";
type AgentDraft = {
  runtime: Runtime;
  networkAccess?: NetworkAccess;
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
    (x.networkAccess === undefined ||
      ["restricted", "internet"].includes(x.networkAccess)) &&
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
  const { setup, workspace: desktop, missions: node } = useApplication();
  const [draft, save, clear, draftError] = useSetupDraft<AgentDraft>(
    `${mission.id}:${role}`,
    {
      runtime: "grok",
      networkAccess: "restricted",
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
  const [device, setDevice] = useState<Preflight | null>(null);
  const available =
    !!device?.supported && device.freeDiskBytes >= device.minimumDiskBytes;
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await setup.state(mission.id);
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
  }, [mission.id, setup]);
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
  const authenticating = local.find((c) =>
    ["starting", "waiting"].includes(
      executionStates?.[c.id]?.authentication?.status ?? "",
    ),
  );
  const previousAuth = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousAuth.current;
    previousAuth.current = authenticating?.id ?? null;
    if (
      previous &&
      !authenticating &&
      signedIn.some((c) => c.id === previous)
    ) {
      const next = local.find((c) => !signedIn.includes(c));
      if (next) setSelected(next.id);
    }
  }, [authenticating?.id, signedIn.map((c) => c.id).join(":")]);
  const current =
    authenticating ??
    (selected === ""
      ? undefined
      : (local.find((c) => c.id === selected) ??
        local.find((c) => !signedIn.includes(c)) ??
        (local.length === 1 ? local[0] : undefined)));
  const pending = jobs.filter(
    (j) => !["complete", "cancelled"].includes(j.status),
  );
  const setupForm = (
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
            networkAccess: draft.networkAccess ?? "restricted",
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
          if (!device?.available) await setup.installProvider();
          await setup.setup(request);
          clear();
          setRequestId(crypto.randomUUID());
        });
      }}
    >
      <fieldset
        className="n-fields"
        disabled={busy || pending.some((j) => j.status === "running")}
      >
        <Field>
          Agent name
          <input
            required
            maxLength={90}
            value={draft.name}
            onChange={(e) => save({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field>
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
        </Field>
        {role === "agent" ? (
          <Field>
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
          </Field>
        ) : null}
        <NetworkAccessField
          value={draft.networkAccess ?? "restricted"}
          onChange={(networkAccess) => save({ ...draft, networkAccess })}
        />
        <Disclosure
          title={
            <>
              Local limits ·{" "}
              {draft.mode === "unlimited"
                ? "Unlimited"
                : `${draft.turns} turns · ${draft.minutes} minutes`}
            </>
          }
        >
          <Field>
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
          </Field>
          {draft.mode === "bounded" ? (
            <div className="d-limit-fields">
              <Field>
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
              </Field>
              <Field>
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
              </Field>
            </div>
          ) : (
            <p>
              No total local allowance. You still approve finite execution
              windows, either together or one session at a time. Provider
              subscription limits apply.
            </p>
          )}
        </Disclosure>
        <p>
          Separate isolated workspaces. Sign in with your subscription for each
          agent; your Mac’s credentials and folders stay private.
        </p>
        <Disclosure title={<>Export location</>}>
          <p className="n-key">
            {workspace?.path ??
              "Documents / Harakiri Exports · a separate folder for each agent"}
          </p>
          <p>Files reach this Mac only when you explicitly export them.</p>
          <Button
            type="button"

            onClick={() =>
              void act(async () => {
                const selected = await desktop.chooseWorkspace();
                if (selected) setWorkspace(selected);
              })
            }
          >
            Change export location…
          </Button>
        </Disclosure>
        <label className="n-check">
          <input type="checkbox" required />I approve these local limits and
          internet access, downloading the verified environment, and sharing
          these agents’ names and runtimes with this mission. Running requires a
          separate approval.
        </label>
        {terms !== mission.lifecycle.terms_revision ? (
          <p role="alert">
            Mission instructions changed. Close and reopen this panel to review
            the current terms.
          </p>
        ) : null}
        <Button
          variant="primary"
          type="submit"
          disabled={!available || terms !== mission.lifecycle.terms_revision}
        >
          {busy
            ? "Preparing…"
            : role === "coordinator"
              ? "Prepare Coordinator"
              : "Prepare agents"}
        </Button>
      </fieldset>
    </form>
  );
  return (
    <section className="n-guided-setup" aria-label="Guided agent setup">
      {!local.length && !pending.length ? (
        <p>
          {role === "coordinator"
            ? "Choose the agent that will prepare your mission plan."
            : "Choose the agents you want to contribute from this Mac."}
        </p>
      ) : null}
      {role === "coordinator" &&
      mission.lifecycle.phase === "preparing" &&
      mission.lifecycle.readiness &&
      !mission.lifecycle.start_blockers.length ? (
        <section className="d-panel">
          <h3>Your plan is ready</h3>
          <p>
            The Coordinator acknowledged the plan. Review it to start mission
            work.
          </p>
          <Button variant="primary" onClick={reviewMission}>
            Review plan and Start
          </Button>
        </section>
      ) : null}
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
              <Button
                variant="primary"
                disabled={
                  busy ||
                  !available ||
                  job.request.terms !== mission.lifecycle.terms_revision
                }
                onClick={() =>
                  void act(async () => {
                    if (!device?.available) await setup.installProvider();
                    return setup.setup(job.request);
                  })
                }
              >
                Continue saved setup
              </Button>
            ) : (
              <progress
                aria-label="Preparing agents"
                value={job.step}
                max={job.contributions.length}
              />
            )}
            <Button
              disabled={busy}
              onClick={() => void act(() => setup.cancel(job.id))}
            >
              Cancel setup
            </Button>
          </div>
        </section>
      ))}
      {!local.length && !pending.length ? setupForm : null}
      {local.length ? (
        <section aria-label="Your prepared agents">
          <h3>
            {signedIn.length < local.length
              ? `Sign in · ${signedIn.length} of ${local.length} complete`
              : "Your agents"}
          </h3>
          {role === "agent" && signedIn.length === local.length ? (
            <GroupContributionConsent
              mission={mission}
              contributions={signedIn.filter(
                (c) => executionStates?.[c.id]?.agreement?.status !== "active",
              )}
              isOwner={localKey === mission.owner}
              done={updated}
            />
          ) : null}
          {local.length > 1 && signedIn.length < local.length ? (
            <p className="d-field-help">
              One sign-in at a time. Each agent has its own isolated login.
            </p>
          ) : null}
          {local.map((c) => (
            <div key={c.id} className="n-setup-agent">
              <div className="n-setup-agent-head">
                <span>
                  <strong>{c.sharedAgent?.label ?? c.runtime}</strong>
                  <AgentState mission={mission} contribution={c} />
                </span>
                <Button
                  aria-expanded={current?.id === c.id}
                  disabled={!!authenticating && authenticating.id !== c.id}
                  onClick={() => setSelected(current?.id === c.id ? "" : c.id)}
                >
                  {current?.id === c.id
                    ? "Hide details"
                    : signedIn.includes(c)
                      ? "Inspect"
                      : "Continue"}
                </Button>
              </div>
              {!c.sharedAgent ? (
                <Button
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
                </Button>
              ) : null}
              {mission.owner === localKey &&
              !mission.lifecycle.coordinator &&
              c.mission.role === "coordinator" &&
              c.nodeBinding?.revision === mission.lifecycle.terms_revision ? (
                <Button
                  variant="primary"
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
                </Button>
              ) : null}
              {current?.id === c.id ? (
                <ExecutionPanel item={c} mission={mission} />
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      {local.length || pending.length ? (
        <Disclosure
          className="n-secondary-section"
          title={<>Add another agent</>}
        >
          {setupForm}
        </Disclosure>
      ) : null}
      <ProviderSetup report={setDevice} integrated />
    </section>
  );
}

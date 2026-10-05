import { useEffect, useState } from "react";
import type { Contribution } from "./bridge";
import type { AgentView, MissionView } from "./node-contract";
import type {
  ContributionAgreement,
  ContributionApproval as Approval,
  ReviewedStart,
  StartJob,
} from "./onboarding-types";
import { useSetupDraft } from "./useSetupDraft";

type GroupDraft = { requests: Approval[]; saved: string[] };
const validGroup = (v: unknown): v is GroupDraft => {
  if (!v || typeof v !== "object") return false;
  const d = v as GroupDraft;
  return (
    Array.isArray(d.saved) &&
    d.saved.length <= 32 &&
    d.saved.every((s) => typeof s === "string") &&
    Array.isArray(d.requests) &&
    d.requests.length <= 32 &&
    d.requests.every(
      (r) =>
        r &&
        typeof r.id === "string" &&
        typeof r.mission === "string" &&
        typeof r.terms === "string" &&
        typeof r.registration === "string" &&
        typeof r.contributionId === "string" &&
        (r.coordinator === null || typeof r.coordinator === "string") &&
        (r.plan === null || typeof r.plan === "string") &&
        Number.isInteger(r.minutes) &&
        r.minutes > 0 &&
        r.minutes <= 1440 &&
        Number.isInteger(r.turns) &&
        r.turns > 0 &&
        r.turns <= 10000 &&
        typeof r.followDirections === "boolean" &&
        typeof r.ownerPermission === "boolean",
    )
  );
};
export function GroupContributionConsent({
  mission,
  contributions,
  isOwner,
  done,
}: {
  mission: MissionView;
  contributions: Contribution[];
  isOwner: boolean;
  done: () => Promise<void>;
}) {
  const [draft, save, clear, storageError] = useSetupDraft<GroupDraft>(
    `${mission.id}:group-approval`,
    { requests: [], saved: [] },
    validGroup,
  );
  const [settings, change] = useState({
    minutes: draft.requests[0]?.minutes ?? 60,
    turns: draft.requests[0]?.turns ?? 20,
    follow: draft.requests[0]?.followDirections ?? true,
  });
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const eligible = contributions
    .filter((c) => c.sharedAgent && !c.sharedAgent.withdrawn)
    .slice(0, 32);
  if (eligible.length < 2 && !draft.requests.length) return null;
  return (
    <section className="d-panel" aria-label="Group contribution approval">
      <h3>Contribute together</h3>
      {notice ? <p role="status">{notice}</p> : null}
      {!review && !draft.requests.length ? (
        <button className="d-button" onClick={() => setReview(true)}>
          Review {eligible.length} agents together
        </button>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const requests = draft.requests.length
              ? draft.requests
              : eligible.map((c): Approval => ({
                  id: crypto.randomUUID(),
                  mission: mission.id,
                  terms: mission.lifecycle.terms_revision,
                  coordinator:
                    mission.lifecycle.coordinator?.appointment ?? null,
                  plan: mission.lifecycle.plan?.id ?? null,
                  registration: c.sharedAgent!.registration,
                  contributionId: c.id,
                  ownerPermission: isOwner,
                  minutes: settings.minutes,
                  turns: settings.turns,
                  followDirections: settings.follow,
                }));
            const next = { requests, saved: [...draft.saved] };
            save(next);
            try {
              for (const r of requests) {
                await window.blackboardSetup.approveContribution(r);
                if (!next.saved.includes(r.id)) next.saved.push(r.id);
                save({ requests, saved: [...next.saved] });
              }
              clear();
              setReview(false);
              setNotice(
                `${requests.length} contributions approved. Each waits for mission Start, its direction and available capacity.`,
              );
              await done();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            {eligible.map((c) => c.sharedAgent?.label ?? c.runtime).join(" · ")}
          </p>
          <p>
            Your subscription · separate isolated workspaces · each agent keeps
            its own limits. You can stop any agent at any time.
          </p>
          <ApprovalFields
            {...settings}
            change={change}
            disabled={busy || !!draft.requests.length}
          />
          {draft.requests.length ? (
            <p role="status">
              {draft.saved.length}/{draft.requests.length} approvals saved.
              Continue using the same reviewed limits.
            </p>
          ) : null}
          <div className="n-action-row">
            <button className="d-button primary" disabled={busy}>
              {draft.requests.length
                ? "Continue group approval"
                : `Approve ${eligible.length} contributions`}
            </button>
            <button
              type="button"
              className="d-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  for (const r of draft.requests) {
                    const found = (
                      await window.blackboardSetup.agreements(mission.id)
                    ).find((a) => a.id === r.id);
                    if (found)
                      await window.blackboardSetup.cancelAgreement(r.id);
                  }
                  clear();
                  setReview(false);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {draft.requests.length ? "Cancel saved approvals" : "Cancel"}
            </button>
          </div>
        </form>
      )}
      {error || storageError ? (
        <p className="d-error" role="alert">
          {error || storageError}
        </p>
      ) : null}
    </section>
  );
}

export function ApprovalFields({
  minutes,
  turns,
  follow,
  change,
  disabled = false,
}: {
  minutes: number;
  turns: number;
  follow: boolean;
  disabled?: boolean;
  change: (v: { minutes: number; turns: number; follow: boolean }) => void;
}) {
  return (
    <fieldset className="n-fields" disabled={disabled}>
      <label className="d-field">
        Contribute for
        <select
          value={minutes}
          onChange={(e) =>
            change({ minutes: Number(e.target.value), turns, follow })
          }
        >
          {[15, 30, 60, 120, 240, 480].map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : `${m / 60} hours`}
            </option>
          ))}
        </select>
      </label>
      <label className="n-check-label">
        <input
          type="checkbox"
          checked={follow}
          onChange={(e) => change({ minutes, turns, follow: e.target.checked })}
        />
        Follow new directions inside this mission’s current instructions
      </label>
      <details>
        <summary>
          Resource limit · up to {turns} runtime turns per agent
        </summary>
        <label className="d-field">
          Maximum runtime turns
          <input
            type="number"
            min={1}
            max={10000}
            required
            value={turns}
            onChange={(e) =>
              change({ minutes, turns: Number(e.target.value), follow })
            }
          />
        </label>
        <p className="d-field-help">
          A turn is one runtime invocation, not a token or a dollar. Your
          subscription’s limits still apply. Short permissions renew only inside
          this time window and allowance.
        </p>
      </details>
    </fieldset>
  );
}

export function ContributionConsent({
  mission,
  agent,
  contribution,
  isOwner,
  done,
}: {
  mission: MissionView;
  agent: AgentView;
  contribution?: Contribution;
  isOwner: boolean;
  done?: () => Promise<void>;
}) {
  const [settings, setSettings] = useState({
    minutes: 60,
    turns: 20,
    follow: true,
  });
  const [agreements, setAgreements] = useState<ContributionAgreement[]>([]);
  const [review, setReview] = useState(false);
  const [id, setId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await window.blackboardSetup.agreements(mission.id);
        if (!closed) setAgreements(result);
      } catch (e) {
        if (!closed) setError((e as Error).message);
      }
      if (!closed) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [mission.id]);
  const agreement = agreements
    .filter((a) => a.request.registration === agent.id)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setAgreements(await window.blackboardSetup.agreements(mission.id));
      await done?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ended = ["closed", "archived"].includes(mission.lifecycle.phase);
  if (ended) return null;
  return (
    <section
      className="d-panel n-contribution-consent"
      aria-label="Contribution approval"
    >
      <h3>
        {contribution
          ? "Your contribution"
          : `Authorize ${agent.identity.label}`}
      </h3>
      {agreement ? (
        <p role="status">
          {agreement.message}
          <br />
          <span className="d-field-help">
            Approved until {new Date(agreement.expiresAt).toLocaleTimeString()}{" "}
            · up to {agreement.request.turns} turns
          </span>
        </p>
      ) : (
        <p>
          {contribution
            ? "Approve this agent to start when the owner starts the mission, and continue within your limits."
            : "Authorize this agent’s work. Its contributor must separately approve execution on their Mac."}
        </p>
      )}
      {agreement?.status === "active" ? (
        <button
          className="d-button"
          disabled={busy}
          onClick={() =>
            void act(() => window.blackboardSetup.cancelAgreement(agreement.id))
          }
        >
          Stop contribution
        </button>
      ) : (
        <div className="n-action-row">
          {agreement?.status === "interrupted" &&
          agreement.expiresAt > Date.now() ? (
            <button
              className="d-button primary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  window.blackboardSetup.continueAgreement(agreement.id),
                )
              }
            >
              Continue saved contribution
            </button>
          ) : null}
          <button
            className="d-button"
            onClick={() => {
              setId(crypto.randomUUID());
              setReview(true);
            }}
          >
            Review contribution
          </button>
        </div>
      )}
      {review ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await window.blackboardSetup.approveContribution({
                id,
                mission: mission.id,
                terms: mission.lifecycle.terms_revision,
                coordinator: mission.lifecycle.coordinator?.appointment ?? null,
                plan: mission.lifecycle.plan?.id ?? null,
                registration: agent.id,
                contributionId: contribution?.id ?? null,
                ownerPermission: isOwner,
                minutes: settings.minutes,
                turns: settings.turns,
                followDirections: settings.follow,
              });
              setReview(false);
            });
          }}
        >
          <p>{agent.direction?.text ?? mission.definition.objective}</p>
          <ApprovalFields {...settings} change={setSettings} disabled={busy} />
          <p className="d-field-help">
            {contribution
              ? "Execution stays in this agent’s isolated VM. Your local limits apply. "
              : "No remote device is started without its contributor’s consent. "}
            Stop cancels automatic continuation. Changes to the instructions,
            accepted plan or Coordinator require your review.
          </p>
          <div className="n-action-row">
            <button className="d-button primary" disabled={busy}>
              Approve contribution
            </button>
            <button
              type="button"
              className="d-button"
              onClick={() => setReview(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="d-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function StartMissionReview({
  mission,
  agents,
  contributions,
  cancel,
  done,
  saved,
}: {
  mission: MissionView;
  agents: AgentView[];
  contributions: Contribution[];
  cancel: () => void;
  done: () => Promise<void>;
  saved?: StartJob | null;
}) {
  const [snapshot] = useState(
    saved?.request.revision ?? mission.lifecycle.revision,
  );
  const [id] = useState(() => saved?.id ?? crypto.randomUUID());
  const [settings, setSettings] = useState({
    minutes: saved?.request.approvals[0]?.minutes ?? 60,
    turns: saved?.request.approvals[0]?.turns ?? 20,
    follow: saved?.request.approvals[0]?.followDirections ?? true,
  });
  const eligible = agents.filter(
    (a) =>
      !["revoked", "withdrawn", "conflict", "review_required"].includes(
        a.status,
      ),
  );
  const [selected, setSelected] = useState(
    () =>
      new Set(
        saved
          ? saved.request.approvals.map((a) => a.registration)
          : eligible
              .filter((a) =>
                contributions.some((c) => c.sharedAgent?.registration === a.id),
              )
              .map((a) => a.id),
      ),
  );
  const [request, setRequest] = useState<ReviewedStart | null>(
    saved?.request ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stale =
    snapshot !== mission.lifecycle.revision &&
    mission.lifecycle.phase !== "active";
  return (
    <form
      className="d-panel"
      aria-label="Review mission start"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const input = request ?? {
          id,
          mission: mission.id,
          revision: snapshot,
          readiness: mission.lifecycle.readiness?.id ?? null,
          approvals: eligible
            .filter((a) => selected.has(a.id))
            .map((a): Approval => ({
              id: crypto.randomUUID(),
              mission: mission.id,
              terms: mission.lifecycle.terms_revision,
              coordinator: mission.lifecycle.coordinator?.appointment ?? null,
              plan: mission.lifecycle.plan?.id ?? null,
              registration: a.id,
              contributionId:
                contributions.find((c) => c.sharedAgent?.registration === a.id)
                  ?.id ?? null,
              ownerPermission: true,
              minutes: settings.minutes,
              turns: settings.turns,
              followDirections: settings.follow,
            })),
        };
        setRequest(input);
        try {
          await window.blackboardSetup.reviewedStart(input);
          await done();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>
        {mission.lifecycle.phase === "paused"
          ? "Resume this mission"
          : "Start this mission"}
      </h3>
      <p className="n-preserve">
        {mission.lifecycle.plan?.text ?? mission.definition.objective}
      </p>
      {saved ? (
        <p role="status">
          Your reviewed start is saved. Continue to reconcile its outcome;
          completed steps will not be repeated.
        </p>
      ) : null}
      {mission.lifecycle.phase === "paused" ? (
        <p>
          The accepted plan is unchanged. Your Resume authorizes work again.
        </p>
      ) : null}
      <fieldset disabled={busy || !!request}>
        <legend>Authorize these contributions</legend>
        {eligible.map((a) => {
          const local = contributions.some(
            (c) => c.sharedAgent?.registration === a.id,
          );
          return (
            <label key={a.id} className="n-check-label">
              <input
                type="checkbox"
                checked={selected.has(a.id)}
                onChange={(e) =>
                  setSelected((old) => {
                    const next = new Set(old);
                    e.target.checked ? next.add(a.id) : next.delete(a.id);
                    return next;
                  })
                }
              />
              {a.identity.label} ·{" "}
              {local
                ? "this Mac · approve and run"
                : "another contributor · their approval is required"}
            </label>
          );
        })}
      </fieldset>
      {selected.size ? (
        <ApprovalFields
          {...settings}
          change={setSettings}
          disabled={busy || !!request}
        />
      ) : null}
      <p className="d-field-help">
        The mission budget is{" "}
        {mission.definition.policy?.budget.mode ?? "limited"}. Each selected
        contribution has its own finite window. Prepared local agents launch
        when their current direction and setup are ready; other contributors
        control their devices.
      </p>
      {stale ? (
        <p role="alert">
          The mission changed. Close this review and read the current plan.
        </p>
      ) : null}
      {error ? (
        <p className="d-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="n-action-row">
        <button
          className="d-button primary"
          disabled={
            busy ||
            stale ||
            (!request && !!mission.lifecycle.start_blockers.length)
          }
        >
          {busy
            ? "Starting…"
            : request
              ? "Continue reviewed start"
              : mission.lifecycle.phase === "paused"
                ? "Resume and run"
                : "Start and run"}
        </button>
        <button
          className="d-button"
          type="button"
          disabled={busy}
          onClick={cancel}
        >
          Cancel
        </button>
        {saved ? (
          <button
            type="button"
            className="d-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await window.blackboardSetup.cancelStart(saved.id);
                await done();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel this review’s contributions
          </button>
        ) : null}
      </div>
    </form>
  );
}

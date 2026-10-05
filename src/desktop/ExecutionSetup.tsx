import { useEffect, useState } from "react";
import type { Contribution } from "./bridge";
import type { MissionView } from "./node-contract";
import type { ExecutionState } from "./execution-types";
import type { Preflight, PermissionRequest } from "./onboarding-types";
export function ProviderSetup({ ready }: { ready?: (value: boolean) => void }) {
  const [state, setState] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const installing = busy || !!state?.installer.active;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.blackboardSetup.preflight();
        if (!cancelled) {
          setState(next);
          ready?.(
            next.available && next.freeDiskBytes >= next.minimumDiskBytes,
          );
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Device check failed.");
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ready]);
  if (state && state.freeDiskBytes < state.minimumDiskBytes)
    return (
      <p className="d-error" role="alert">
        Free at least 4 GB on this Mac before preparing another environment.
        Existing agents and their files are retained.
      </p>
    );
  if (state?.available)
    return (
      <div>
        <p className="d-field-help">
          ✓ This Mac can prepare isolated agents · Up to {state.capacity}{" "}
          environments at once.
        </p>
        <details>
          <summary>Device capacity and downloads</summary>
          <p className="d-field-help">
            Each running environment uses 2 CPUs and 2 GiB RAM, with an 8 GiB
            sparse disk. {(state.freeDiskBytes / 1024 ** 3).toFixed(1)} GiB disk
            space is available. Verified base downloads are reused; guest
            credentials stay separate. The capacity estimate leaves room for
            macOS but does not measure other apps’ current memory use.
          </p>
          <label className="d-field">
            Environments running at once
            <select
              disabled={busy}
              value={state.capacity}
              onChange={async (e) => {
                setBusy(true);
                setError("");
                try {
                  await window.blackboardSetup.setCapacity(
                    Number(e.target.value),
                  );
                  setState(await window.blackboardSetup.preflight());
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {Array.from(
                { length: Math.min(256, state.capacityCeiling) },
                (_, i) => i + 1,
              ).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <p className="d-field-help">
            Additional agents wait for a slot. Reducing this limit queues future
            starts; it does not kill work already running.
          </p>
          {error ? (
            <p className="d-error" role="alert">
              {error}
            </p>
          ) : null}
        </details>
      </div>
    );
  return (
    <section className="d-panel" aria-label="Environment provider setup">
      <h3>Prepare this Mac</h3>
      {error || state?.installer.error ? (
        <p className="d-error" role="alert">
          {error || state?.installer.error}
        </p>
      ) : null}
      <p>
        {!state
          ? "Checking the isolated environment provider…"
          : !state.supported
            ? "Agent execution currently requires Apple Silicon macOS."
            : "Install Lima 2.1.1 in Harakiri’s private application storage. This downloads the verified official release; no administrator access or Homebrew changes are required."}
      </p>
      {state?.supported ? (
        <button
          className="d-button primary"
          disabled={installing}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await window.blackboardSetup.installProvider();
              const next = await window.blackboardSetup.preflight();
              setState(next);
              ready?.(
                next.available && next.freeDiskBytes >= next.minimumDiskBytes,
              );
            } catch (e) {
              setError(e instanceof Error ? e.message : "Installation failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {installing
            ? "Installing Lima…"
            : "Install isolated environment provider"}
        </button>
      ) : null}
      {installing ? (
        <div role="status">
          <p>{state?.installer.stage}</p>
          {state?.installer.total ? (
            <progress
              aria-label="Lima download"
              value={state.installer.bytes}
              max={state.installer.total}
            />
          ) : (
            <progress aria-label="Installing Lima" />
          )}
          <button
            className="d-button"
            onClick={() =>
              void window.blackboardSetup
                .cancelInstall()
                .catch((e) => setError(e.message))
            }
          >
            Cancel download
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function RunApproval({
  item,
  mission,
  execution,
  done,
}: {
  item: Contribution;
  mission: MissionView;
  execution: ExecutionState;
  done: () => Promise<void>;
}) {
  const planning = mission.lifecycle.phase === "preparing";
  const [review, setReview] = useState<
    Pick<PermissionRequest, "id" | "control" | "direction">
  >(() => ({
    id: crypto.randomUUID(),
    control: mission.lifecycle.revision,
    direction: planning
      ? mission.lifecycle.revision
      : (execution.direction?.id ?? ""),
  }));
  const [turns, setTurns] = useState(planning ? 3 : 10);
  const [minutes, setMinutes] = useState(planning ? 10 : 60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [retryRestore, setRetryRestore] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setRestoring(true);
    setRestoreFailed(false);
    void window.blackboardSetup
      .state(mission.id)
      .then((jobs) => {
        if (cancelled) return;
        const saved = jobs
          .filter(
            (j) =>
              j.kind === "permission" &&
              j.contributions.includes(item.id) &&
              !["complete", "cancelled"].includes(j.status),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (saved?.kind === "permission") {
          const r = saved.request;
          setReview({ id: r.id, control: r.control, direction: r.direction });
          setTurns(r.turns);
          setMinutes(r.minutes);
          setAttempted(true);
          setSavedNote(
            "An unfinished approval was saved. Continuing uses its existing allocation and permission; it does not create a second run.",
          );
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message);
          setRestoreFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, mission.id, retryRestore]);
  const stale =
    review.control !== mission.lifecycle.revision ||
    review.direction !==
      (planning ? mission.lifecycle.revision : (execution.direction?.id ?? ""));
  return (
    <form
      className="d-panel"
      aria-label="Review run permission"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        setAttempted(true);
        try {
          await window.blackboardSetup.permission({
            ...review,
            contributionId: item.id,
            turns,
            minutes,
          });
          await done();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Approval failed.");
          const jobs = await window.blackboardSetup
            .state(mission.id)
            .catch(() => null);
          if (jobs && !jobs.some((j) => j.id === review.id))
            setAttempted(false);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>
        {planning
          ? "Prepare the mission plan"
          : execution.record?.session
            ? "Review and resume this agent"
            : "Review and run this agent"}
      </h3>
      <p>
        {planning
          ? "The Coordinator can plan and acknowledge readiness. Workers continue waiting for your Start."
          : execution.direction?.text || "A current direction is required."}
      </p>
      <p>
        This action allocates available mission resources, issues a permission
        and approves execution on this Mac. The isolated workspace and your
        local limits still apply.
      </p>
      <div className="d-limit-fields">
        <label className="d-field">
          Runtime turns
          <input
            type="number"
            required
            min={1}
            max={planning ? 8 : 10000}
            value={turns}
            disabled={busy || restoring || attempted}
            onChange={(e) => setTurns(Number(e.target.value))}
          />
        </label>
        <label className="d-field">
          Permission window (minutes)
          <input
            type="number"
            required
            min={1}
            max={planning ? 15 : 1440}
            value={minutes}
            disabled={busy || restoring || attempted}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
      </div>
      <p className="d-field-help">
        The window begins when permission is issued and continues while
        disconnected. A new generation needs your approval again.
      </p>
      {restoring ? (
        <p role="status">Checking for an unfinished approval…</p>
      ) : savedNote ? (
        <p role="status">{savedNote}</p>
      ) : null}
      {restoreFailed ? (
        <button
          type="button"
          className="d-button"
          onClick={() => setRetryRestore((v) => v + 1)}
        >
          Retry saved approval check
        </button>
      ) : null}
      {error ? (
        <p className="d-error" role="alert">
          {error}
        </p>
      ) : null}
      {stale ? (
        <>
          <p role="alert">
            Direction or mission control changed. Review the current
            instructions before continuing.
          </p>
          <button
            type="button"
            className="d-button"
            onClick={() => {
              setAttempted(false);
              setSavedNote("");
              setReview({
                id: crypto.randomUUID(),
                control: mission.lifecycle.revision,
                direction: planning
                  ? mission.lifecycle.revision
                  : (execution.direction?.id ?? ""),
              });
            }}
          >
            Review current instructions
          </button>
        </>
      ) : null}
      <button
        className="d-button primary"
        disabled={
          busy || restoring || restoreFailed || stale || !review.direction
        }
      >
        {busy
          ? "Recording approval…"
          : planning
            ? "Approve and prepare plan"
            : execution.record?.session
              ? "Approve and resume"
              : "Approve and run"}
      </button>
    </form>
  );
}

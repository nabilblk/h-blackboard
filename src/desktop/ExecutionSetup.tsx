import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Disclosure } from "../ui/Disclosure";
import { useApplication } from "./ApplicationProvider";
import { useEffect, useState } from "react";
import type { Contribution } from "../application/contracts/workspace";
import type { MissionView } from "../application/contracts/node";
import type { ExecutionState } from "../application/contracts/execution";
import type {
  Preflight,
  PermissionRequest,
} from "../application/contracts/setup";
export function ProviderSetup({
  ready,
  report,
  integrated = false,
}: {
  ready?: (value: boolean) => void;
  report?: (value: Preflight) => void;
  integrated?: boolean;
}) {
  const { setup } = useApplication();
  const [state, setState] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const installing = busy || !!state?.installer.active;
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await setup.preflight();
        if (!cancelled) {
          setState(next);
          report?.(next);
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
  }, [ready, report, setup]);
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
        <Disclosure
          title={<>This Mac · {state.capacity} agent environments at once</>}
        >
          <p className="d-field-help">
            Each running environment uses 2 CPUs and 2 GiB RAM, with an 8 GiB
            sparse disk. {(state.freeDiskBytes / 1024 ** 3).toFixed(1)} GiB disk
            space is available. Verified base downloads are reused; guest
            credentials stay separate. The capacity estimate leaves room for
            macOS but does not measure other apps’ current memory use.
          </p>
          <Field>
            Environments running at once
            <select
              disabled={busy}
              value={state.capacity}
              onChange={async (e) => {
                setBusy(true);
                setError("");
                try {
                  await setup.setCapacity(Number(e.target.value));
                  setState(await setup.preflight());
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
          </Field>
          <p className="d-field-help">
            Additional agents wait for a slot. Reducing this limit queues future
            starts; it does not kill work already running.
          </p>
          {error ? (
            <p className="d-error" role="alert">
              {error}
            </p>
          ) : null}
        </Disclosure>
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
            : integrated
              ? "Preparing your first agent also downloads its verified isolation tools into Harakiri’s private storage."
              : "Install Lima 2.1.1 in Harakiri’s private application storage. No administrator access or Homebrew changes are required."}
      </p>
      {state?.supported && !integrated ? (
        <Button
          variant="primary"
          disabled={installing}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await setup.installProvider();
              const next = await setup.preflight();
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
        </Button>
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
          <Button
            onClick={() =>
              void setup.cancelInstall().catch((e) => setError(e.message))
            }
          >
            Cancel download
          </Button>
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
  const { setup } = useApplication();
  const planning = mission.lifecycle.phase === "preparing";
  const networkRevision =
    execution.networkRevision ?? item.networkRevision ?? null;
  const [review, setReview] = useState<
    Pick<PermissionRequest, "id" | "control" | "direction" | "networkRevision">
  >(() => ({
    id: crypto.randomUUID(),
    networkRevision,
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
    void setup
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
          setReview({
            id: r.id,
            control: r.control,
            direction: r.direction,
            networkRevision: r.networkRevision ?? null,
          });
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
  }, [item.id, mission.id, retryRestore, setup]);
  const stale =
    (review.networkRevision ?? null) !== networkRevision ||
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
          await setup.permission({
            ...review,
            contributionId: item.id,
            turns,
            minutes,
          });
          await done();
        } catch (e) {
          setError(e instanceof Error ? e.message : "Approval failed.");
          const jobs = await setup.state(mission.id).catch(() => null);
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
        Uses your subscription in this agent’s isolated workspace. You can stop
        it at any time; your local limits still apply.
      </p>
      <p className="d-field-help">
        Workspace internet:{" "}
        {(execution.networkAccess ?? item.networkAccess) === "internet"
          ? "Public HTTPS allowed; requests may send mission data externally."
          : "Blocked. AI provider access remains available."}
      </p>
      <div className="d-limit-fields">
        <Field>
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
        </Field>
        <Field>
          Time limit (minutes)
          <input
            type="number"
            required
            min={1}
            max={planning ? 15 : 1440}
            value={minutes}
            disabled={busy || restoring || attempted}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </Field>
      </div>
      <p className="d-field-help">
        Time starts when you approve, including time disconnected. This approves
        one session; continuing later requires another approval.
      </p>
      {restoring ? (
        <p role="status">Checking for an unfinished approval…</p>
      ) : savedNote ? (
        <p role="status">{savedNote}</p>
      ) : null}
      {restoreFailed ? (
        <Button
          type="button"

          onClick={() => setRetryRestore((v) => v + 1)}
        >
          Retry saved approval check
        </Button>
      ) : null}
      {error ? (
        <p className="d-error" role="alert">
          {error}
        </p>
      ) : null}
      {stale ? (
        <>
          <p role="alert">
            Instructions or local access changed. Review the current terms
            before continuing.
          </p>
          <Button
            type="button"

            onClick={() => {
              setAttempted(false);
              setSavedNote("");
              setReview({
                id: crypto.randomUUID(),
                networkRevision,
                control: mission.lifecycle.revision,
                direction: planning
                  ? mission.lifecycle.revision
                  : (execution.direction?.id ?? ""),
              });
            }}
          >
            Review current instructions
          </Button>
        </>
      ) : null}
      <Button
        variant="primary"
        type="submit"
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
      </Button>
    </form>
  );
}

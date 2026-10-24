import { useState } from "react";
import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import type {
  ExecutionAPI,
  ExecutionState,
} from "../application/contracts/execution";

const outcome = {
  running: "In progress",
  complete: "Result saved",
  failed: "Failed",
  cancel_requested: "Cancellation requested",
  cancelled: "Cancelled",
  uncertain: "Outcome needs checking",
};

export function ExecutionRecovery({
  id,
  state,
  api,
  stopped,
  changed,
}: {
  id: string;
  state: ExecutionState;
  api: ExecutionAPI;
  stopped: boolean;
  changed(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const checkpoint = state.checkpoints?.[0];
  const operations = state.operations ?? [];
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!checkpoint && !operations.length) return null;
  return (
    <section
      className="n-execution-recovery"
      aria-label="Saved work and operations"
    >
      {checkpoint ? (
        <div className="d-panel">
          <h4>
            {checkpoint.files
              ? "Source checkpoint saved"
              : "No source files captured yet"}
          </h4>
          <p>
            {checkpoint.files} files ·{" "}
            {new Date(checkpoint.at).toLocaleString()}
          </p>
          <p className="d-field-help">
            {!checkpoint.files
              ? "This checkpoint contains no source files to restore. Published artifacts and the agent’s environment are separate."
              : state.record?.reconstructedAt
                ? "The previous environment was replaced. Its runtime conversation and sign-in are unavailable; this separate copy can recover selected source files."
                : "This separate copy can recover selected source if the environment is lost. It does not contain the agent’s login or conversation."}
          </p>
          <Disclosure title="Recover source or inspect exclusions">
            <p>
              Restores into a new folder in the prepared environment. Existing
              work stays in place. Review it with the agent before resuming.
            </p>
            <Button
              disabled={busy || !stopped || !checkpoint.files}
              onClick={() =>
                void act(async () => {
                  const result = await api.restoreCheckpoint(id, checkpoint.id);
                  setNotice(
                    `Recovered ${result.imported} files into ${result.destination}. The next agent briefing will identify this folder.`,
                  );
                })
              }
            >
              Restore source into a new folder
            </Button>
            {!stopped ? (
              <p className="d-field-help">
                Stop the environment before restoring.
              </p>
            ) : null}
            {checkpoint.exclusions.length ? (
              <ul>
                {checkpoint.exclusions.map((item) => (
                  <li key={item.path}>
                    <code>{item.path}</code> — {item.reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No files were excluded.</p>
            )}
          </Disclosure>
        </div>
      ) : null}
      {operations.length ? (
        <Disclosure title={`Recent operations · ${operations.length}`}>
          <p className="d-field-help">
            “Result saved” confirms a receipt, not test success or quality.
            Cancellation stops at a safe boundary; completed output is retained.
          </p>
          <ol className="n-execution-log">
            {operations.slice(0, 12).map((operation) => (
              <li key={operation.id}>
                <strong>{operation.label}</strong>
                <p>
                  {outcome[operation.state]} ·{" "}
                  {new Date(operation.updatedAt).toLocaleTimeString()}
                </p>
                {operation.progress && operation.state === "running" ? (
                  <>
                    <progress
                      aria-label={operation.label}
                      max={Math.max(1, operation.progress.total)}
                      value={operation.progress.completed}
                    />
                    <p className="d-field-help">{operation.progress.detail}</p>
                  </>
                ) : null}
                {operation.error ? <p>{operation.error}</p> : null}
                {operation.state === "running" &&
                ["publish", "import"].includes(operation.kind) ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api.cancelOperation(id, operation.id);
                      })
                    }
                  >
                    Cancel transfer
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

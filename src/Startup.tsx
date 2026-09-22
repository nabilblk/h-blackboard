import { useState } from "react";
import { rpc } from "./client";
import type { Context } from "./model";

export function StartupBanner({
  context,
  refresh,
  details,
}: {
  context: Context;
  refresh: () => Promise<void>;
  details: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { mission, startup } = context;
  async function start() {
    setBusy(true);
    setError("");
    try {
      await rpc("mission_state", {
        channel_id: mission.id,
        version: mission.version,
        state: "active",
        reason: "Human started the prepared mission.",
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="state-banner startup-banner"
      aria-label="Mission preparation"
    >
      <div className="startup-summary" role="status">
        <strong>{startup.canStart ? "Ready to start" : "Preparing"}</strong>
        <span className="mono">
          {startup.connected} connected · {startup.waiting} waiting
        </span>
        <p>{startup.reason}</p>
      </div>
      <div className="button-row">
        <button className="button" onClick={details}>
          Mission setup
        </button>
        <button
          className="button primary"
          disabled={busy || !startup.canStart}
          onClick={start}
        >
          {busy ? "Starting…" : "Start mission"}
        </button>
      </div>
      {error ? (
        <p className="startup-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

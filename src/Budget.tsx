import { useEffect, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { rpc } from "./client";
import { usePanelEscape } from "./usePanelEscape";
import { Badge, Field, ModalFrame, Time } from "./ui";
import type { Context } from "./model";
import type { Budget, BudgetRun } from "./resources";
import { hasBudgetLimits } from "./resources";

const amount = (key: string, value: number | null) =>
  value === null
    ? "No limit"
    : key === "costUsd"
      ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
      : value.toLocaleString();
export function BudgetPanel({
  context,
  close,
  refresh,
}: {
  context: Context;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  usePanelEscape(close);
  const budget = context.budget;
  const limited = hasBudgetLimits(budget.limits);
  const hasReserve = [
    budget.limits.turns,
    budget.limits.tokens,
    budget.limits.costUsd,
  ].some((value) => value !== null);
  const [editing, setEditing] = useState(false),
    [error, setError] = useState("");
  const [runs, setRuns] = useState<BudgetRun[]>([]),
    [nextOffset, setNextOffset] = useState<number | null>(null),
    [busy, setBusy] = useState(false);
  const [reconcile, setReconcile] = useState<BudgetRun | null>(null);
  useEffect(() => {
    let active = true;
    rpc<Budget & { runs: BudgetRun[]; nextOffset: number | null }>(
      "budget_read",
      { channel_id: context.mission.id },
    )
      .then((result) => {
        if (active) {
          setRuns(result.runs);
          setNextOffset(result.nextOffset);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [
    context.mission.id,
    budget.totalRuns,
    budget.active,
    budget.version,
    budget.unknownRuns,
    budget.consumed.tokens,
    budget.consumed.costUsd,
  ]);
  const more = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await rpc<{
        runs: BudgetRun[];
        nextOffset: number | null;
      }>("budget_read", { channel_id: context.mission.id, offset: nextOffset });
      setRuns((old) => [...old, ...result.runs]);
      setNextOffset(result.nextOffset);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="details resource-panel" aria-label="Mission budget">
      <header className="details-heading">
        <h2 className="label">Mission budget</h2>
        <button className="icon" onClick={close} aria-label="Close budget">
          <X size={17} />
        </button>
      </header>
      <div className="details-body">
        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : null}
        <section>
          <div className="section-heading">
            <h2>{limited ? "Mission limits" : "No budget · Unlimited"}</h2>
            <button
              className="button"
              disabled={context.mission.archived}
              onClick={() => setEditing(true)}
            >
              Edit limits
            </button>
          </div>
          <p className="secondary">
            {limited
              ? "Limits and usage are shared across all agents in this mission."
              : "No mission limits are set. Usage is still recorded, and your providers’ subscription limits still apply."}
          </p>
          <div className="resource-table-wrap">
            <table className="resource-table">
              <caption className="sr-only">
                Mission consumption and allowance
              </caption>
              <thead>
                <tr>
                  <th>Resource</th>
                  <th>Consumed</th>
                  <th>Reserved</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["turns", "Turns"],
                    ["tokens", "Tokens"],
                    ["costUsd", "Model cost"],
                  ] as const
                ).map(([key, label]) => (
                  <tr key={key}>
                    <th>
                      {label}
                      <small>Limit: {amount(key, budget.limits[key])}</small>
                    </th>
                    <td>{amount(key, budget.consumed[key])}</td>
                    <td>{amount(key, budget.reserved[key])}</td>
                    <td>{amount(key, budget.available[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="secondary">
            {budget.active} concurrent turns /{" "}
            {budget.limits.concurrency ?? "unlimited"}.{" "}
            {budget.limits.deadline
              ? `Deadline: ${new Date(budget.limits.deadline).toLocaleString()}.`
              : "No deadline."}
          </p>
          {budget.exhausted ? (
            <div className="state-banner warning" role="status">
              {budget.deadlineReached
                ? "The deadline has been reached."
                : "No allowance remains for new work."}{" "}
              Existing artifacts and conversation remain available.
            </div>
          ) : null}
          {budget.unknownRuns ? (
            <div className="panel-block">
              <Badge tone="warning">
                {budget.unknownRuns} runs with unknown usage
              </Badge>
              <p>
                Missing figures remain unknown. Their reservations only reduce
                available allowance when that resource has a limit. Reconcile
                them from runtime logs when needed.
              </p>
            </div>
          ) : null}
          <p className="secondary">
            {budget.quality.reported} reported · {budget.quality.estimated}{" "}
            estimated · {budget.quality.unknown} unreported runs. Missing cost
            is never counted as a known zero. These values describe model usage,
            not subscription invoices.
          </p>
        </section>
        <section>
          <h3 className="label">Finalization reserve</h3>
          <p>
            {hasReserve
              ? `${budget.finalizationPercent}% of limited turns, tokens and model cost is protected for verification and synthesis.`
              : "No allowance needs to be protected while turns, tokens and model cost are unlimited."}
          </p>
          {hasReserve || budget.finalizers.length ? (
            <>
              <p className="secondary">
                Assigned to:{" "}
                {budget.finalizers
                  .map(
                    (id) => context.agents.find((a) => a.id === id)?.name || id,
                  )
                  .join(", ") || "No agents yet"}
                . The coordinator can assign agents to finalize.
              </p>
              <Finalizers
                key={`${budget.version}`}
                context={context}
                refresh={refresh}
              />
            </>
          ) : null}
        </section>
        <section>
          <h3 className="label">Enforcement</h3>
          {context.agents.some(
            (a) => !a.execution || a.execution.budgetProtocol !== 1,
          ) ? (
            <p className="warning">
              {
                context.agents.filter(
                  (a) => !a.execution || a.execution.budgetProtocol !== 1,
                ).length
              }{" "}
              agents have no current managed budget reporter. Interactive
              sessions must report usage; older launchers need to be resumed
              with the updated CLI.
            </p>
          ) : null}
          <p>
            Managed launchers reserve a turn before execution. Tokens and model
            cost are reconciled when that turn ends; an in-flight turn can
            exceed its allowance. Deadline interruptions follow launcher control
            checks. Interactive sessions report their own usage.
          </p>
          <p className="secondary">
            Per-turn reservation: {amount("tokens", budget.perTurn.tokens)}{" "}
            tokens · {amount("costUsd", budget.perTurn.costUsd)}. Unknown
            reports keep this allowance reserved.
          </p>
        </section>
        <section>
          <h3 className="label">Execution ledger · {budget.totalRuns}</h3>
          {runs.length ? (
            runs.map((run) => (
              <div className="resource-row" key={run.id}>
                <div className="section-heading">
                  <strong>
                    {context.agents.find((a) => a.id === run.agentId)?.name ||
                      run.agentId}
                  </strong>
                  <Badge
                    tone={
                      run.status === "reserved"
                        ? "progress"
                        : run.usage?.quality === "unknown"
                          ? "warning"
                          : ""
                    }
                  >
                    {run.status === "reserved" ? "Reserved" : run.outcome}
                  </Badge>
                </div>
                <p>
                  {run.usage?.tokens == null
                    ? "Tokens unknown"
                    : `${amount("tokens", run.usage.tokens)} tokens`}{" "}
                  ·{" "}
                  {run.usage?.costUsd == null
                    ? "Cost unknown"
                    : amount("costUsd", run.usage.costUsd)}
                </p>
                <small className="mono secondary">
                  {run.purpose} · {run.usage?.quality || "Pending"} ·{" "}
                  <Time at={run.startedAt} />
                </small>
                <div className="button-row">
                  <code>{run.id}</code>
                  <button
                    className="text-button"
                    onClick={() => setReconcile(run)}
                  >
                    Reconcile
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p className="secondary">
              No managed execution has been recorded yet.
            </p>
          )}
          {nextOffset !== null ? (
            <button className="button" disabled={busy} onClick={more}>
              Load earlier runs
            </button>
          ) : null}
        </section>
        <section>
          <h3 className="label">Policy history</h3>
          {budget.history
            .slice(-10)
            .reverse()
            .map((entry) => (
              <p key={entry.version}>
                <span className="mono secondary">
                  v{entry.version} · <Time at={entry.at} />
                </span>
                <br />
                {entry.reason}
              </p>
            ))}
        </section>
      </div>
      {editing ? (
        <BudgetEditor
          budget={budget}
          channelId={context.mission.id}
          close={() => setEditing(false)}
          refresh={refresh}
        />
      ) : null}
      {reconcile ? (
        <Reconcile
          run={reconcile}
          channelId={context.mission.id}
          close={() => setReconcile(null)}
          refresh={async () => {
            await refresh();
            const result = await rpc<{
              runs: BudgetRun[];
              nextOffset: number | null;
            }>("budget_read", { channel_id: context.mission.id });
            setRuns(result.runs);
            setNextOffset(result.nextOffset);
          }}
        />
      ) : null}
    </aside>
  );
}
function Finalizers({
  context,
  refresh,
}: {
  context: Context;
  refresh: () => Promise<void>;
}) {
  const [ids, setIds] = useState(context.budget.finalizers),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [version] = useState(context.budget.version);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await rpc("budget_allocate", {
            channel_id: context.mission.id,
            version,
            agent_ids: ids,
            reason:
              "Human assigned agents for verification and final synthesis.",
          });
          await refresh();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Agents allowed to finalize">
        <select
          multiple
          value={ids}
          disabled={context.mission.archived}
          onChange={(e) =>
            setIds(Array.from(e.target.selectedOptions, (o) => o.value))
          }
        >
          {context.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="button" disabled={busy || context.mission.archived}>
        Save allocation
      </button>
    </form>
  );
}
function BudgetEditor({
  budget,
  channelId,
  close,
  refresh,
}: {
  budget: Budget;
  channelId: string;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [version] = useState(budget.version),
    [unlimited, setUnlimited] = useState(!hasBudgetLimits(budget.limits)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const num = (key: string) =>
      String(data.get(key) || "").trim() ? Number(data.get(key)) : null;
    const limits = {
      tokens: unlimited ? null : num("tokens"),
      costUsd: unlimited ? null : num("costUsd"),
      turns: unlimited ? null : num("turns"),
      concurrency: unlimited ? null : num("concurrency"),
      deadline:
        !unlimited && data.get("deadline")
          ? new Date(String(data.get("deadline"))).getTime()
          : null,
    };
    if (!unlimited && !hasBudgetLimits(limits)) {
      setError("Set at least one limit, or choose No budget · Unlimited.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await rpc("budget_update", {
        channel_id: channelId,
        version,
        limits,
        per_turn: unlimited
          ? budget.perTurn
          : { tokens: num("perTokens"), costUsd: num("perCost") },
        finalization_percent: unlimited
          ? budget.finalizationPercent
          : num("reserve"),
        reason: data.get("reason"),
      });
      await refresh();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const localDate = budget.limits.deadline
    ? new Date(
        budget.limits.deadline -
          new Date(budget.limits.deadline).getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16)
    : "";
  return (
    <ModalFrame title="Mission budget" label="Settings" close={close}>
      <form onSubmit={submit}>
        <div className="dialog-body stack">
          <Field label="Budget policy">
            <select
              value={unlimited ? "unlimited" : "limited"}
              onChange={(e) => {
                setUnlimited(e.target.value === "unlimited");
                setError("");
              }}
            >
              <option value="unlimited">No budget · Unlimited</option>
              <option value="limited">Set limits</option>
            </select>
          </Field>
          {unlimited ? (
            <p className="secondary">
              No mission limits on turns, concurrent work, time, tokens or model
              cost. Usage remains recorded. Provider subscription limits still
              apply.
            </p>
          ) : null}
          <fieldset
            className="budget-limit-fields stack"
            aria-label="Mission limits"
            hidden={unlimited}
            disabled={unlimited}
          >
            <p className="secondary">
              For subscriptions, start with turns, concurrency and a deadline.
              Leave any limit empty for unlimited; zero allows no further usage.
            </p>
            <div className="resource-fields">
              <Field label="Runtime turns">
                <input
                  name="turns"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Unlimited"
                  defaultValue={budget.limits.turns ?? ""}
                />
              </Field>
              <Field label="Concurrent turns">
                <input
                  name="concurrency"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  placeholder="Unlimited"
                  defaultValue={budget.limits.concurrency ?? ""}
                />
              </Field>
            </div>
            <p className="secondary">
              One runtime turn can contain many model calls and tool uses.
              Concurrency counts running turns across the whole mission.
            </p>
            <Field label="Deadline · local time">
              <input
                name="deadline"
                type="datetime-local"
                defaultValue={localDate}
              />
            </Field>
            <Field
              label="Finalization reserve · %"
              hint="Protect part of the turn, token or model-cost allowance for verification and synthesis."
            >
              <input
                name="reserve"
                type="number"
                min="0"
                max="50"
                required
                defaultValue={budget.finalizationPercent}
              />
            </Field>
            <details
              className="budget-advanced"
              open={
                budget.limits.tokens !== null || budget.limits.costUsd !== null
              }
              onInvalid={(event) => {
                event.currentTarget.open = true;
              }}
            >
              <summary>Token and model-cost limits · optional</summary>
              <div className="stack">
                <p className="secondary">
                  Model cost is runtime-reported usage, not your subscription
                  bill or remaining quota. Leave USD unlimited for subscription
                  use.
                </p>
                <div className="resource-fields">
                  <Field label="Total tokens">
                    <input
                      name="tokens"
                      type="number"
                      min="0"
                      step="1"
                      placeholder="Unlimited"
                      defaultValue={budget.limits.tokens ?? ""}
                    />
                  </Field>
                  <Field label="Model cost · USD">
                    <input
                      name="costUsd"
                      type="number"
                      min="0"
                      step="0.0001"
                      placeholder="Unlimited"
                      defaultValue={budget.limits.costUsd ?? ""}
                    />
                  </Field>
                  <Field label="Tokens reserved per turn">
                    <input
                      name="perTokens"
                      type="number"
                      min="1"
                      required
                      defaultValue={budget.perTurn.tokens}
                    />
                  </Field>
                  <Field label="USD reserved per turn">
                    <input
                      name="perCost"
                      type="number"
                      min="0.0001"
                      step="0.0001"
                      required
                      defaultValue={budget.perTurn.costUsd}
                    />
                  </Field>
                </div>
                <p className="secondary">
                  Per-turn reservations only constrain admission when the
                  corresponding total has a limit. A running turn can exceed its
                  reservation.
                </p>
              </div>
            </details>
          </fieldset>
          <p className="secondary">
            Changes preserve usage history and human pauses.
          </p>
          <Field label="Reason for this change">
            <textarea name="reason" required maxLength={4000} rows={2} />
          </Field>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="dialog-footer">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save budget"}
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}
function Reconcile({
  run,
  channelId,
  close,
  refresh,
}: {
  run: BudgetRun;
  channelId: string;
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <ModalFrame
      title="Reconcile stopped execution"
      label="Budget"
      close={close}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setBusy(true);
          setError("");
          try {
            await rpc("budget_reconcile", {
              channel_id: channelId,
              run_id: run.id,
              version: run.version,
              usage: {
                tokens: Number(data.get("tokens")),
                costUsd: Number(data.get("costUsd")),
                quality: data.get("quality"),
                source: String(data.get("reason")).slice(0, 240),
              },
              reason: data.get("reason"),
              confirmed_stopped: true,
            });
            await refresh();
            close();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body stack">
          <p>
            Confirm this runtime has stopped before releasing its reservation.
            Zero is a known value; use it only when justified.
          </p>
          <Field label="Tokens consumed">
            <input
              name="tokens"
              type="number"
              min="0"
              required
              defaultValue={run.usage?.tokens ?? ""}
            />
          </Field>
          <Field label="Model cost · USD">
            <input
              name="costUsd"
              type="number"
              min="0"
              step="any"
              required
              defaultValue={run.usage?.costUsd ?? ""}
            />
          </Field>
          <Field label="Evidence quality">
            <select name="quality">
              <option value="estimated">
                Estimated from available evidence
              </option>
              <option value="reported">Reported by runtime</option>
            </select>
          </Field>
          <Field label="Evidence and reason">
            <textarea name="reason" required maxLength={4000} />
          </Field>
          <label className="check-row">
            <input type="checkbox" required />I confirmed the runtime process
            has stopped.
          </label>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="dialog-footer">
          <button className="button" type="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Reconcile usage
          </button>
        </footer>
      </form>
    </ModalFrame>
  );
}

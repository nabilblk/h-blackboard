import { useState } from "react";
import { node, type Contribution } from "./bridge";
import type { AgentView, GovernanceAction, MissionView } from "./node-contract";
import type { Perform } from "./ui";
import { Status } from "./ui";
import { useLedger, short } from "./useGovernance";
import { ResourceForm } from "./ResourceForm";
export function BudgetPanel({
  mission,
  owner,
  agents,
  contributions,
  busy,
  perform,
}: {
  mission: MissionView;
  owner: string;
  agents: AgentView[];
  contributions: Contribution[];
  busy: boolean;
  perform: Perform;
}) {
  const { data, error, refresh } = useLedger(mission.id);
  const [form, setForm] = useState<"allocate" | "grant" | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const own = owner === mission.owner;
  const terms = mission.definition.policy?.budget;
  const apply = (action: GovernanceAction) =>
    void perform(async () => {
      await node.govern(mission.id, mission.lifecycle.revision, action);
      await refresh();
      setForm(null);
      setResolution(null);
      setReason("");
    });
  if (!data)
    return <p role="status">{error || "Reading the resource ledger…"}</p>;
  const nodes = [...new Set([owner, ...agents.map((a) => a.contributor)])];
  const label = (id: string) => {
    if (id === owner) return "You";
    const name = agents.find((a) => a.contributor === id)?.identity
      .contributor_name;
    return name && name !== "You" ? name : `Contributor ${short(id)}`;
  };
  return (
    <div className="n-governance">
      <header>
        <p className="d-muted">
          Allowances, reserved turns and attributed usage. Local subscription
          limits still apply.
        </p>
      </header>
      {error ? (
        <p role="alert" className="d-alert">
          {error}
        </p>
      ) : null}
      <dl className="d-facts">
        <div>
          <dt>Mission budget</dt>
          <dd>
            {terms?.mode === "unlimited"
              ? "Unlimited"
              : `${terms?.turns ?? "Unlimited"} turns · ${terms?.concurrency ?? "Unlimited"} concurrent`}
          </dd>
        </div>
        <div>
          <dt>Accounted turns</dt>
          <dd>
            {data.allocations.reduce((n, a) => n + a.charged, 0)} charged ·{" "}
            {data.allocations.reduce((n, a) => n + a.reserved, 0)} reserved
          </dd>
        </div>
      </dl>
      <p className="d-field-help">
        Contributors approve and run their own agents from agent details. The
        Subscription adapters enforce turns, time and concurrency; missions with
        token or dollar limits require a metered adapter.
      </p>
      <div className="n-action-row">
        {own ? (
          <>
            <button
              className="d-button"
              disabled={
                busy || ["closed", "archived"].includes(mission.lifecycle.phase)
              }
              onClick={() => setForm("allocate")}
            >
              Allocate allowance
            </button>
            <button
              className="d-button"
              disabled={
                busy ||
                !["active", "preparing"].includes(mission.lifecycle.phase) ||
                !data.allocations.some((a) => !a.sealed && !a.reclaimed)
              }
              onClick={() => setForm("grant")}
            >
              {mission.lifecycle.phase === "preparing"
                ? "Allow Coordinator planning"
                : "Issue permission"}
            </button>
          </>
        ) : null}
      </div>
      {form ? (
        <ResourceForm
          key={`${form}:${mission.lifecycle.revision}`}
          mode={form}
          mission={mission}
          data={data}
          agents={agents}
          nodes={nodes}
          label={label}
          busy={busy}
          submit={apply}
          close={() => setForm(null)}
        />
      ) : null}
      <h3>Contributor allowances</h3>
      {data.allocations.length ? (
        data.allocations.map((a) => (
          <section className="d-panel n-ledger-row" key={a.id}>
            <div className="n-action-row">
              <strong>{label(a.node)}</strong>
              <Status muted>
                {a.reclaimed ? "Reconciled" : a.sealed ? "Sealed" : "Allocated"}
              </Status>
            </div>
            <p>
              {a.turns ?? "Unlimited"} turns · {a.slots} concurrent ·{" "}
              {a.charged} charged · {a.reserved} reserved
            </p>
            <small className="d-muted">{short(a.id)}</small>
            <div className="n-action-row">
              {a.node === owner && !a.reclaimed ? (
                <button
                  className="d-button"
                  disabled={
                    busy ||
                    !!a.sealed ||
                    a.reserved > 0 ||
                    data.grants.some((g) => g.allocation === a.id && !g.sealed)
                  }
                  onClick={() =>
                    apply({
                      type: "seal_allocation",
                      allocation: a.id,
                      grants: data.grants
                        .filter((g) => g.allocation === a.id && g.seal)
                        .map((g) => g.seal!),
                    })
                  }
                >
                  Seal allowance
                </button>
              ) : null}
              {own && a.sealed && !a.reclaimed ? (
                <button
                  className="d-button"
                  disabled={busy}
                  onClick={() => apply({ type: "reclaim", seal: a.sealed! })}
                >
                  Reclaim unused allowance
                </button>
              ) : null}
            </div>
          </section>
        ))
      ) : (
        <p className="d-muted">
          No allowance allocated. Contributions can be prepared and discussed
          before resources are assigned.
        </p>
      )}
      <h3>Execution permissions</h3>
      {data.grants.length ? (
        data.grants.map((g) => {
          const agent = agents.find((a) => a.id === g.registration);
          const directionChanged = agent?.direction?.id !== g.direction;
          const local = contributions.find(
            (c) =>
              c.sharedAgent?.registration === g.registration &&
              !c.sharedAgent.withdrawn,
          );
          return (
            <section className="d-panel n-ledger-row" key={g.id}>
              <div className="n-action-row">
                <strong>
                  {agent?.identity.label ?? short(g.registration)}
                </strong>
                <Status muted>
                  {g.risk_accepted
                    ? "Retired · risk accepted"
                    : g.sealed
                      ? "Sealed"
                      : g.expires_ms <= Date.now()
                        ? "Expired · reconcile"
                        : g.control !== mission.lifecycle.revision
                          ? "Mission changed"
                          : directionChanged
                            ? "Direction changed"
                            : g.consent
                              ? "Consented · inspect execution on contributor device"
                              : "Awaiting local consent"}
                </Status>
              </div>
              <p>
                Up to {g.turns} turns · generation {g.generation}
              </p>
              <p className="d-field-help">
                Expires {new Date(g.expires_ms).toLocaleString()} · offline
                validity {Math.floor(g.offline_ms / 60000)} min
              </p>
              <div className="n-action-row">
                {local && !g.consent && !g.sealed ? (
                  <button
                    className="d-button"
                    disabled={
                      busy ||
                      directionChanged ||
                      g.control !== mission.lifecycle.revision ||
                      g.expires_ms <= Date.now()
                    }
                    onClick={() =>
                      void perform(async () => {
                        await node.consentGrant(mission.id, g.id, local.id);
                        await refresh();
                      })
                    }
                  >
                    Consent with my local terms
                  </button>
                ) : null}
                {own && !g.sealed ? (
                  <button
                    className="d-button"
                    disabled={busy || g.reserved > 0}
                    onClick={() => {
                      setResolution(`grant:${g.id}`);
                      setReason("");
                    }}
                  >
                    Retire unreachable permission
                  </button>
                ) : null}
                {g.node === owner && !g.sealed ? (
                  <button
                    className="d-button"
                    disabled={busy || g.reserved > 0}
                    onClick={() =>
                      apply({
                        type: "seal_grant",
                        grant: g.id,
                        settlements: data.reservations
                          .filter((r) => r.grant === g.id && r.resolution)
                          .map((r) => r.resolution!),
                      })
                    }
                  >
                    Seal permission
                  </button>
                ) : null}
              </div>
            </section>
          );
        })
      ) : (
        <p className="d-muted">No execution permissions issued.</p>
      )}
      {data.reservations.length ? (
        <>
          <h3>Reservations & receipts</h3>
          {data.reservations.map((r) => (
            <section className="d-panel n-ledger-row" key={r.id}>
              <strong>{short(r.id)}</strong>
              <p>
                {r.resolution
                  ? "Human risk decision · one turn charged"
                  : r.stopped && r.used !== null
                    ? `${r.used} turn(s) reported · termination reported`
                    : "Usage or termination unresolved · allowance held"}
              </p>
              <p className="d-muted">
                {r.summary ?? "Awaiting an attributed receipt."}
              </p>
              {own && !r.resolution && !(r.stopped && r.used !== null) ? (
                <button
                  className="d-button"
                  onClick={() => {
                    setResolution(r.id);
                    setReason("");
                  }}
                >
                  Review uncertainty
                </button>
              ) : null}
            </section>
          ))}
        </>
      ) : null}
      {resolution ? (
        <form
          className="d-panel n-ledger-row"
          onSubmit={(e) => {
            e.preventDefault();
            apply(
              resolution.startsWith("grant:")
                ? { type: "retire_grant", grant: resolution.slice(6), reason }
                : { type: "resolve", reservation: resolution, reason },
            );
          }}
        >
          <h3>Accept unresolved execution risk</h3>
          <p>
            A reservation is charged in full. Retiring a permission keeps its
            contributor allowance allocated until that contributor reconciles
            it. This does not prove the old execution stopped. Review possible
            duplicate external effects before replacement work.
          </p>
          <label className="d-field">
            <span>Reason for accepting this risk</span>
            <textarea
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={2048}
            />
          </label>
          <div className="n-action-row">
            <button
              className="d-button"
              type="button"
              onClick={() => setResolution(null)}
            >
              Cancel
            </button>
            <button className="d-button" disabled={busy || !reason.trim()}>
              Record risk decision
            </button>
          </div>
        </form>
      ) : null}
      <p className="d-field-help">
        A disconnected or expired permission keeps its allowance. Contributor
        receipts are claims, not independent proof of provider billing or
        process termination.
      </p>
    </div>
  );
}

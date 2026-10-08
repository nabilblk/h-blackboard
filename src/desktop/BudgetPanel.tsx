import { ViewTabs } from "../ui/ViewTabs";
import { Field } from "../ui/Field";
import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { useApplication } from "./ApplicationProvider";
import { useState } from "react";
import { type Contribution } from "../application/contracts/workspace";
import type {
  AgentView,
  GovernanceAction,
  MissionView,
} from "../application/contracts/node";
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
  initialAgent = null,
}: {
  mission: MissionView;
  owner: string;
  agents: AgentView[];
  contributions: Contribution[];
  busy: boolean;
  perform: Perform;
  initialAgent?: string | null;
}) {
  const { missions: node } = useApplication();
  const { data, error, refresh } = useLedger(mission.id);
  const [form, setForm] = useState<"allocate" | "grant" | "auto" | null>(
    initialAgent ? "auto" : null,
  );
  const [resolution, setResolution] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [tab, setTab] = useState<"overview" | "technical">("overview");
  const own = owner === mission.owner;
  const terms = mission.definition.policy?.budget;
  const apply = (action: GovernanceAction) =>
    void perform(async () => {
      await node.govern(mission.id, mission.lifecycle.revision, action);
      await refresh();
      setForm(initialAgent && action.type === "allocate" ? "grant" : null);
      setResolution(null);
      setReason("");
    });
  if (!data)
    return <p role="status">{error || "Reading the resource ledger…"}</p>;
  const nodes = [...new Set([owner, ...agents.map((a) => a.contributor)])];
  const usageByContributor = new Map<
    string,
    { charged: number; reserved: number }
  >();
  for (const allocation of data.allocations) {
    const usage = usageByContributor.get(allocation.node) ?? {
      charged: 0,
      reserved: 0,
    };
    usage.charged += allocation.charged;
    usage.reserved += allocation.reserved;
    usageByContributor.set(allocation.node, usage);
  }
  const focused = agents.find((a) => a.id === initialAgent);
  const usableAllocations = data.allocations.filter(
    (a) =>
      !a.sealed && !a.reclaimed && (!focused || a.node === focused.contributor),
  );
  const currentGrants = focused
    ? data.grants.filter(
        (g) =>
          g.registration === focused.id &&
          !g.sealed &&
          g.control === mission.lifecycle.revision &&
          g.direction === focused.direction?.id &&
          g.turns > g.charged + g.reserved &&
          Math.min(g.expires_ms, g.issued_ms + g.offline_ms) > Date.now(),
      )
    : [];
  const unresolved = data.reservations.filter((r) => {
    if (r.resolution || (r.stopped && r.used !== null)) return false;
    const grant = data.grants.find((g) => g.id === r.grant);
    return (
      !!r.receipt ||
      (!!grant &&
        (grant.revoked ||
          grant.sealed ||
          Math.min(grant.expires_ms, grant.issued_ms + grant.offline_ms) <=
            Date.now()))
    );
  });
  const mode =
    form === "auto"
      ? currentGrants.length
        ? null
        : usableAllocations.length
          ? "grant"
          : "allocate"
      : form;
  const label = (id: string) => {
    if (id === owner) return "You";
    const name = agents.find((a) => a.contributor === id)?.identity
      .contributor_name;
    return name && name !== "You" ? name : `Contributor ${short(id)}`;
  };
  return (
    <div className="n-governance">
      <ViewTabs
        label="Budget inspector views"
        value={tab}
        onChange={setTab}
        items={[
          { value: "overview", label: "Overview" },
          { value: "technical", label: "Technical" },
        ]}
      />
      <div hidden={tab !== "overview"}>
        <header>
          {focused ? (
            <>
              <h3>Run permission · {focused.identity.label}</h3>
              <p className="n-preserve">
                {focused.direction?.text ?? "Waiting for a current direction."}
              </p>
              <p>
                You authorize mission resources. {label(focused.contributor)}{" "}
                must still approve the run on their own device.
              </p>
              {currentGrants.length ? (
                <p role="status">
                  A current permission is already issued.{" "}
                  {currentGrants.some((g) => g.consent)
                    ? "Local approval is recorded; execution status comes from the contributor."
                    : "Waiting for the contributor’s local approval."}
                </p>
              ) : !usableAllocations.length ? (
                <p>
                  First choose this contributor’s allowance, then review a
                  bounded run permission.
                </p>
              ) : null}
            </>
          ) : null}
          <p className="d-muted">
            Allowances, reserved turns and attributed usage. Local subscription
            limits still apply.
          </p>
        </header>
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
          A turn is one agent invocation. Subscription limits still apply.
        </p>
        {unresolved.length ? (
          <div className="n-current-step" role="status">
            <h3>Execution needs reconciliation</h3>
            <p>
              Some usage or stops are unconfirmed. Their allowance remains
              reserved.
            </p>
            <Button onClick={() => setTab("technical")}>
              Review unresolved execution
            </Button>
          </div>
        ) : null}
        {data.allocations.length ? (
          <section>
            <h3>By contributor</h3>
            <dl className="d-facts">
              {[...usageByContributor].map(([id, usage]) => (
                <div key={id}>
                  <dt>{label(id)}</dt>
                  <dd>
                    {usage.charged} charged · {usage.reserved} reserved
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : (
          <p className="d-field-help">
            Allowances appear here when contributions are authorized.
          </p>
        )}
        <Disclosure
          className="n-secondary-section"
          open={!!focused || !!mode}
          title={<>Manage allowances and permissions</>}
        >
          <p className="d-field-help">
            Contributors normally approve their agents in Members. These
            controls let the mission owner allocate resources manually. Local
            consent is still required.
          </p>
          <div className="n-action-row">
            {own ? (
              <>
                <Button
                  disabled={
                    busy ||
                    ["closed", "archived"].includes(mission.lifecycle.phase)
                  }
                  onClick={() => setForm("allocate")}
                >
                  Allocate allowance
                </Button>
                <Button
                  disabled={
                    busy ||
                    !["active", "preparing"].includes(
                      mission.lifecycle.phase,
                    ) ||
                    !usableAllocations.length ||
                    (initialAgent !== null &&
                      (!focused ||
                        !focused.direction ||
                        currentGrants.length > 0))
                  }
                  onClick={() => setForm("grant")}
                >
                  {mission.lifecycle.phase === "preparing"
                    ? "Allow Coordinator planning"
                    : "Issue permission"}
                </Button>
              </>
            ) : null}
          </div>
          {mode && own && (!initialAgent || focused) ? (
            <ResourceForm
              key={`${mode}:${mission.lifecycle.revision}:${initialAgent ?? "all"}`}
              mode={mode}
              mission={mission}
              data={data}
              agents={agents}
              nodes={nodes}
              focused={focused}
              label={label}
              busy={busy}
              submit={apply}
              close={() => setForm(null)}
            />
          ) : null}
        </Disclosure>
      </div>
      {error ? (
        <p role="alert" className="d-alert">
          {error}
        </p>
      ) : null}
      <div hidden={tab !== "technical"}>
        <p className="d-field-help">
          Signed allowance, permission and receipt records. A permission does
          not prove an agent is running.
        </p>
        <h3>Contributor allowances</h3>
        {data.allocations.length ? (
          data.allocations.map((a) => (
            <section className="d-panel n-ledger-row" key={a.id}>
              <div className="n-action-row">
                <strong>{label(a.node)}</strong>
                <Status muted>
                  {a.reclaimed
                    ? "Reconciled"
                    : a.sealed
                      ? "Sealed"
                      : "Allocated"}
                </Status>
              </div>
              <p>
                {a.turns ?? "Unlimited"} turns · {a.slots} concurrent ·{" "}
                {a.charged} charged · {a.reserved} reserved
              </p>
              <small className="d-muted">{short(a.id)}</small>
              <div className="n-action-row">
                {a.node === owner && !a.reclaimed ? (
                  <Button
                    disabled={
                      busy ||
                      !!a.sealed ||
                      a.reserved > 0 ||
                      data.grants.some(
                        (g) => g.allocation === a.id && !g.sealed,
                      )
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
                  </Button>
                ) : null}
                {own && a.sealed && !a.reclaimed ? (
                  <Button
                    disabled={busy}
                    onClick={() => apply({ type: "reclaim", seal: a.sealed! })}
                  >
                    Reclaim unused allowance
                  </Button>
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
                        : g.revoked
                          ? "Stop requested · confirmation pending"
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
                  {local && !g.consent && !g.sealed && !g.revoked ? (
                    <Button
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
                    </Button>
                  ) : null}
                  {own && !g.sealed ? (
                    <Button
                      disabled={busy || g.reserved > 0}
                      onClick={() => {
                        setResolution(`grant:${g.id}`);
                        setReason("");
                      }}
                    >
                      Retire unreachable permission
                    </Button>
                  ) : null}
                  {g.node === owner && !g.sealed ? (
                    <Button
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
                    </Button>
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
                  <Button
                    onClick={() => {
                      setResolution(r.id);
                      setReason("");
                    }}
                  >
                    Review uncertainty
                  </Button>
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
            <Field>
              <span>Reason for accepting this risk</span>
              <textarea
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={2048}
              />
            </Field>
            <div className="n-action-row">
              <Button type="button" onClick={() => setResolution(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !reason.trim()}>
                Record risk decision
              </Button>
            </div>
          </form>
        ) : null}
      </div>
      <p className="d-field-help">
        A disconnected or expired permission keeps its allowance. Contributor
        receipts are claims, not independent proof of provider billing or
        process termination.
      </p>
    </div>
  );
}

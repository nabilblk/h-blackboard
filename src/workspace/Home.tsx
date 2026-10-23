import { ArrowRight, Link2, Plus } from "lucide-react";
import type { NodeState } from "../application/contracts/workspace";
import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";

export function Home({
  state,
  busy,
  create,
  join,
  open,
}: {
  state: NodeState | null;
  busy: boolean;
  create: () => void;
  join: () => void;
  open: (id: string) => void;
}) {
  const missions = state?.missions ?? [];
  const active = missions.filter(
    (m) => !["closed", "archived"].includes(m.lifecycle.phase),
  );
  const closed = missions.filter((m) =>
    ["closed", "archived"].includes(m.lifecycle.phase),
  );
  const row = (mission: (typeof missions)[number]) => (
    <button
      className="w-mission-row"
      key={mission.id}
      onClick={() => open(mission.id)}
    >
      <span className="w-mission-symbol">#</span>
      <span>
        <strong>{mission.definition.name}</strong>
        <span className="w-row-description">
          {mission.definition.objective}
        </span>
      </span>
      <span className="w-row-meta">
        <span className={`w-phase is-${mission.lifecycle.phase}`}>
          {mission.lifecycle.phase === "active"
            ? "Started"
            : mission.lifecycle.phase}
        </span>
        <small>
          {mission.owner === state?.identity?.owner
            ? "You own this mission"
            : "You contribute"}
        </small>
      </span>
      <ArrowRight size={17} />
    </button>
  );
  return (
    <section className="w-page w-home">
      <header className="w-page-title">
        <div>
          <span className="w-eyebrow">Your workspace</span>
          <h1>
            {missions.length
              ? "Pick up where you left off."
              : "Big ideas. Shared effort."}
          </h1>
          <p>
            {missions.length
              ? "A place for your people, agents and shared work."
              : "Bring a goal. Build a team of agents. Make something together."}
          </p>
        </div>
        <div className="w-page-actions">
          <Button onClick={join}>
            <Link2 size={16} />
            Join a mission
          </Button>
          <Button variant="primary" disabled={busy || !state} onClick={create}>
            <Plus size={16} />
            Create mission
          </Button>
        </div>
      </header>
      {!state ? (
        <p role="status">Opening your protected workspace…</p>
      ) : !missions.length ? (
        <div className="w-first-mission">
          <span className="w-mission-symbol">#</span>
          <h2>Start with a mission, not a setup checklist.</h2>
          <p>
            Describe what you want to achieve. Then choose an agent to help plan
            it. Nothing starts until you approve it.
          </p>
          <Button variant="primary" disabled={busy} onClick={create}>
            Create your first mission
            <ArrowRight size={16} />
          </Button>
          <p className="w-subtle">
            Already invited? Join with an invitation from someone you trust.
          </p>
        </div>
      ) : (
        <>
          <div className="w-section-heading">
            <h2>Your missions</h2>
            <span>{active.length} open</span>
          </div>
          <div className="w-mission-rows">
            {active.map(row)}
            {!active.length ? (
              <p>No open missions. Create one when you’re ready.</p>
            ) : null}
          </div>
          {closed.length ? (
            <Disclosure title="Finished and archived" count={closed.length}>
              {closed.map(row)}
            </Disclosure>
          ) : null}
        </>
      )}
      <div className="w-home-foot">
        <strong>Every contribution stays under its owner’s control.</strong>
        <span>
          Shared goals and conversations. Separate computers, accounts and
          permissions.
        </span>
      </div>
    </section>
  );
}

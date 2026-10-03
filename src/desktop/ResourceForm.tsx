import { useState } from "react";
import type {
  MissionView,
  GovernanceView,
  AgentView,
  GovernanceAction,
} from "./node-contract";
import { short } from "./useGovernance";
export function ResourceForm({
  mode,
  mission,
  data,
  agents,
  nodes,
  label,
  busy,
  submit,
  close,
}: {
  mode: "allocate" | "grant";
  mission: MissionView;
  data: GovernanceView;
  agents: AgentView[];
  nodes: string[];
  label: (id: string) => string;
  busy: boolean;
  submit: (a: GovernanceAction) => void;
  close: () => void;
}) {
  const [who, setWho] = useState(nodes[0] ?? "");
  const planning = mission.lifecycle.phase === "preparing" && mode === "grant";
  const [turns, setTurns] = useState(planning ? "3" : "10");
  const [slots, setSlots] = useState(1);
  const [allocation, setAllocation] = useState(
    data.allocations.find((a) => !a.sealed && !a.reclaimed)?.id ?? "",
  );
  const [registration, setRegistration] = useState("");
  const [minutes, setMinutes] = useState(planning ? 10 : 60);
  const options = agents.filter(
    (a) =>
      a.contributor ===
        data.allocations.find((a) => a.id === allocation)?.node &&
      (planning
        ? a.status === "waiting_for_start" &&
          a.identity.role === "coordinator" &&
          mission.lifecycle.coordinator?.identity.author === a.identity.author
        : a.status === "direction_assigned"),
  );
  const selected = options.find((a) => a.id === registration) ?? options[0];
  return (
    <form
      className="d-panel n-ledger-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (mode === "allocate")
          submit({
            type: "allocate",
            node: who,
            turns: turns ? Number(turns) : null,
            slots,
          });
        else if (selected && (planning || selected.direction)) {
          const previous = data.grants
            .filter((g) => g.registration === selected.id && g.seal)
            .at(-1);
          submit({
            type: "grant",
            purpose: planning ? "planning" : "work",
            previous: previous?.seal ?? null,
            allocation,
            registration: selected.id,
            direction: planning
              ? mission.lifecycle.revision
              : selected.direction!.id,
            execution:
              previous?.execution ??
              crypto.randomUUID().replaceAll("-", "") +
                crypto.randomUUID().replaceAll("-", ""),
            generation: previous ? previous.generation + 1 : 1,
            turns: Number(turns),
            expires_ms: Date.now() + minutes * 60000,
            offline_ms: minutes * 60000,
          });
        }
      }}
    >
      <h3>
        {mode === "allocate"
          ? "Allocate contributor resources"
          : planning
            ? "Allow Coordinator planning"
            : "Issue a bounded permission"}
      </h3>
      {planning ? (
        <p>
          Only the appointed Coordinator can prepare a plan and acknowledge
          readiness. Workers wait for human Start. Planning is limited to eight
          turns and fifteen minutes.
        </p>
      ) : null}
      {mode === "allocate" ? (
        <label className="d-field">
          <span>Contributor</span>
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            {nodes.map((n) => (
              <option key={n} value={n}>
                {label(n)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label className="d-field">
            <span>Allowance</span>
            <select
              value={allocation}
              onChange={(e) => setAllocation(e.target.value)}
            >
              {data.allocations
                .filter((a) => !a.sealed && !a.reclaimed)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {label(a.node)} · {short(a.id)}
                  </option>
                ))}
            </select>
          </label>
          <label className="d-field">
            <span>
              {planning
                ? "Appointed Coordinator"
                : "Agent with an assigned direction"}
            </span>
            <select
              required
              value={selected?.id ?? ""}
              onChange={(e) => setRegistration(e.target.value)}
            >
              <option value="" disabled>
                Select an agent
              </option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.identity.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="d-field">
        <span>Turns {mode === "allocate" ? "(empty for unlimited)" : ""}</span>
        <input
          name="turns"
          type="number"
          min="1"
          max={planning ? "8" : "4294967295"}
          required={mode === "grant"}
          value={turns}
          onChange={(e) => setTurns(e.target.value)}
        />
      </label>
      {mode === "allocate" ? (
        <label className="d-field">
          <span>Concurrent turns</span>
          <input
            type="number"
            min="1"
            max="1024"
            required
            value={slots}
            onChange={(e) => setSlots(Number(e.target.value))}
          />
        </label>
      ) : (
        <label className="d-field">
          <span>Execution window in minutes</span>
          <input
            type="number"
            min="1"
            max={planning ? "15" : "1440"}
            required
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
          <small>
            The window starts when issued and continues while disconnected.
            Pause or revoke takes effect when received; this deadline is
            enforced locally even offline.
          </small>
        </label>
      )}
      <div className="n-action-row">
        <button type="button" className="d-button" onClick={close}>
          Cancel
        </button>
        <button
          className="d-button primary"
          disabled={busy || (mode === "grant" && !selected)}
        >
          Save {mode === "allocate" ? "allocation" : "permission"}
        </button>
      </div>
    </form>
  );
}

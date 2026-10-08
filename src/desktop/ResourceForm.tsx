import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { useState } from "react";
import type {
  MissionView,
  GovernanceView,
  AgentView,
  GovernanceAction,
} from "../application/contracts/node";
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
  focused,
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
  focused?: AgentView;
}) {
  const [who, setWho] = useState(focused?.contributor ?? nodes[0] ?? "");
  const planning = mission.lifecycle.phase === "preparing" && mode === "grant";
  const [turns, setTurns] = useState(planning ? "3" : "10");
  const [unlimited, setUnlimited] = useState(false);
  const [slots, setSlots] = useState(1);
  const [allocation, setAllocation] = useState(
    data.allocations.find(
      (a) =>
        !a.sealed &&
        !a.reclaimed &&
        (!focused || a.node === focused.contributor),
    )?.id ?? "",
  );
  const [registration, setRegistration] = useState(focused?.id ?? "");
  const [reviewedDirection] = useState(focused?.direction?.id);
  const staleDirection =
    !!focused && focused.direction?.id !== reviewedDirection;
  const [minutes, setMinutes] = useState(planning ? 10 : 60);
  const options = agents.filter(
    (a) =>
      (!focused || a.id === focused.id) &&
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
        if (busy || staleDirection) return;
        if (mode === "allocate")
          submit({
            type: "allocate",
            node: who,
            turns: unlimited ? null : Number(turns),
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
            offline_ms: minutes * 60000 - 10000,
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
        <Field>
          <span>Contributor</span>
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            {nodes
              .filter((n) => !focused || n === focused.contributor)
              .map((n) => (
                <option key={n} value={n}>
                  {label(n)}
                </option>
              ))}
          </select>
        </Field>
      ) : (
        <>
          <Field>
            <span>Allowance</span>
            <select
              value={allocation}
              onChange={(e) => setAllocation(e.target.value)}
            >
              {data.allocations
                .filter(
                  (a) =>
                    !a.sealed &&
                    !a.reclaimed &&
                    (!focused || a.node === focused.contributor),
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {label(a.node)} · {short(a.id)}
                  </option>
                ))}
            </select>
          </Field>
          <Field>
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
          </Field>
        </>
      )}
      {mode === "allocate" ? (
        <Field>
          Turn allowance
          <select
            value={unlimited ? "unlimited" : "limited"}
            onChange={(e) => setUnlimited(e.target.value === "unlimited")}
          >
            <option value="limited">Set a turn limit</option>
            <option value="unlimited">Unlimited turns</option>
          </select>
        </Field>
      ) : null}
      {!unlimited ? (
        <Field>
          <span>Turns</span>
          <input
            name="turns"
            type="number"
            min="1"
            max={planning ? "8" : "4294967295"}
            required
            value={turns}
            onChange={(e) => setTurns(e.target.value)}
          />
        </Field>
      ) : null}
      {mode === "allocate" ? (
        <Field>
          <span>Concurrent turns</span>
          <input
            type="number"
            min="1"
            max="1024"
            required
            value={slots}
            onChange={(e) => setSlots(Number(e.target.value))}
          />
        </Field>
      ) : (
        <Field>
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
        </Field>
      )}
      <div className="n-action-row">
        <Button type="button" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={busy || staleDirection || (mode === "grant" && !selected)}
        >
          Save {mode === "allocate" ? "allocation" : "permission"}
        </Button>
      </div>
      {staleDirection ? (
        <p role="alert">
          The direction changed. Close and reopen this review before issuing
          permission.
        </p>
      ) : null}
    </form>
  );
}

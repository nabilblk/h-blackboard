import type { MissionView } from "./node-contract";
import type {
  Decision,
  MissionPresentation,
  PresentationAction,
} from "../../shared/mission-presentation.mjs";

type Props = {
  value: MissionPresentation;
  act: (action: PresentationAction) => void;
};

/** The conversation's only operational summary. The decision itself moves into
 * its inspector; navigation never duplicates an open approval. */
export function MissionJourney({
  value,
  act,
  inspect,
  inspectorOpen,
}: Props & {
  inspect: (tab?: "overview" | "decisions" | "technical") => void;
  inspectorOpen: boolean;
}) {
  return (
    <section
      className={`n-mission-summary ${value.urgent ? "attention" : ""}`}
      aria-label="Mission status"
    >
      <button
        className="n-summary-inspect"
        onClick={() => inspect("technical")}
        aria-label={`Inspect status: ${value.summary}`}
      >
        <span className="d-label">{value.phaseLabel}</span>
        <span role="status">{value.summary}</span>
      </button>
      {!inspectorOpen && value.next ? (
        <button
          className="d-button primary"
          onClick={() =>
            value.decisions.length > 1
              ? inspect("decisions")
              : act(value.next!.action)
          }
        >
          {value.decisions.length > 1
            ? `Review ${value.decisions.length} decisions`
            : value.next.action.label}
        </button>
      ) : !inspectorOpen &&
        value.acceptedResult &&
        ["closed", "archived"].includes(value.phase) ? (
        <button
          className="d-button primary"
          onClick={() =>
            act({
              label: "Open accepted result",
              destination: "artifact",
              revision: value.acceptedResult!.revision,
            })
          }
        >
          Open accepted result
        </button>
      ) : (
        <button
          className="d-button"
          onClick={() =>
            inspect(value.decisions.length ? "decisions" : "technical")
          }
        >
          {value.decisions.length
            ? `${value.decisions.length} ${value.decisions.length === 1 ? "decision" : "decisions"}`
            : "Inspect status"}
        </button>
      )}
    </section>
  );
}

export function MissionDecisions({ value, act }: Props) {
  const row = (d: Decision) => (
    <div
      className={`n-decision-row ${d.urgent ? "attention" : ""}`}
      key={d.id}
      data-decision={d.id}
    >
      <div>
        <strong>{d.title}</strong>
        <p>{d.reason}</p>
        <span className="d-field-help">With {d.responsible}</span>
      </div>
      <button className="d-button" onClick={() => act(d.action)}>
        {d.action.label}
      </button>
    </div>
  );
  return (
    <section className="n-decisions" aria-label="Mission decisions">
      <h2>
        Needs you <span className="d-count">{value.decisions.length}</span>
      </h2>
      {value.decisions.length ? (
        value.decisions.map(row)
      ) : (
        <p className="d-field-help">Nothing needs your decision.</p>
      )}
      {value.waiting.length ? (
        <>
          <h3>
            Waiting <span className="d-count">{value.waiting.length}</span>
          </h3>
          {value.waiting.map(row)}
        </>
      ) : null}
    </section>
  );
}

export function MissionActivity({
  value,
  mission,
  act,
}: Props & { mission: MissionView }) {
  return (
    <section
      className="n-mission-activity"
      aria-label="Mission activity and sources"
    >
      <h3>Execution activity</h3>
      <p>{value.activity}</p>
      <p className="d-field-help">
        Local observations and fresh contributor reports. Execution does not
        establish progress or result quality.
      </p>
      {value.rows.map(({ agent, status }) => (
        <button
          key={agent.id}
          className="n-activity-row"
          onClick={() =>
            act({
              label: "Inspect agent",
              destination: "agent",
              agent: agent.id,
            })
          }
        >
          <span>
            <strong>{agent.identity.label}</strong>
            <span>{status.reason}</span>
          </span>
          <span className="n-activity-fact">
            <strong>{status.label}</strong>
            <small>
              {status.source}
              {!status.fresh ? " · expired or unavailable" : ""}
            </small>
            {status.observedAt ? (
              <time dateTime={new Date(status.observedAt).toISOString()}>
                Last observed {new Date(status.observedAt).toLocaleTimeString()}
              </time>
            ) : null}
          </span>
        </button>
      ))}
      <h3>Mission records</h3>
      <dl className="d-facts">
        <div>
          <dt>Control revision</dt>
          <dd className="n-key">{mission.lifecycle.revision}</dd>
        </div>
        <div>
          <dt>Instructions revision</dt>
          <dd className="n-key">{mission.lifecycle.terms_revision}</dd>
        </div>
        <div>
          <dt>Owner identity</dt>
          <dd className="n-key">{mission.owner}</dd>
        </div>
        <div>
          <dt>Start blockers</dt>
          <dd>{mission.lifecycle.start_blockers.join(", ") || "None"}</dd>
        </div>
      </dl>
    </section>
  );
}

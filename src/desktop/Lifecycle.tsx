import { useEffect, useState, type ReactNode } from "react";
import { Pause, Plus, X } from "lucide-react";
import { node, type Contribution } from "./bridge";
import type { Coordination, MissionView, AgentView } from "./node-contract";
import { Status, type Perform } from "./ui";
import { StartMissionReview } from "./ContributionApproval";
import type { StartJob } from "./onboarding-types";
import type {
  MissionPresentation,
  PresentationAction,
} from "../../shared/mission-presentation.mjs";

export const phaseLabel = (mission: MissionView) =>
  mission.conflicted
    ? "Needs recovery"
    : {
        preparing: "Preparing",
        active: "Active",
        paused: "Paused",
        closed: "Closed",
        archived: "Archived",
      }[mission.lifecycle.phase];

const reasons: Record<string, string> = {
  plan_artifact_stale:
    "The shared plan or its inputs changed. Select the current revision and ask for a fresh readiness acknowledgment.",
  closed: "Closed by the mission owner.",
  archived: "This channel is archived. Its history remains readable.",
  coordinator_unavailable:
    "The Coordinator contribution is unavailable. Prepare and appoint an eligible Coordinator.",
  coordinator_missing: "Appoint a prepared Coordinator before starting.",
  plan_missing:
    "The Coordinator needs to publish a shared plan and acknowledge readiness.",
  coordinator_not_ready:
    "Waiting for the Coordinator to acknowledge the current instructions and plan.",
  control_conflict:
    "Conflicting signed history needs recovery. Mission control is suspended.",
  unsupported_policy: "This mission’s policy is unsupported. It cannot start.",
  control_history_full:
    "This mission reached its control history limit. It cannot start again.",
};
type Props = {
  mission: MissionView;
  isOwner: boolean;
  blocked: boolean;
  busy: boolean;
  open: boolean;
  detailsOnly?: boolean;
  contributions: Contribution[];
  perform: Perform;
  updated: () => Promise<void>;
  presentation: MissionPresentation;
  act: (action: PresentationAction) => void;
  agents?: AgentView[];
  reviewStart?: boolean;
  children?: ReactNode;
};
type Edit = {
  kind: "instructions" | "plan" | "coordination";
  snapshot: MissionView;
};

export function MissionControl({
  mission,
  isOwner,
  blocked,
  busy,
  open,
  detailsOnly = false,
  contributions,
  perform,
  updated,
  presentation,
  act,
  agents = [],
  reviewStart = false,
  children,
}: Props) {
  const { lifecycle: l, definition } = mission;
  const [edit, setEdit] = useState<Edit | null>(null);
  const [choice, setChoice] = useState("");
  const [startReview, setStartReview] = useState<string | null>(
    reviewStart &&
      !l.start_blockers.length &&
      ["preparing", "paused"].includes(l.phase)
      ? l.revision
      : null,
  );
  const [pendingStart, setPendingStart] = useState<StartJob | null>(null);
  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void window.blackboardSetup
      .startState(mission.id)
      .then((jobs) => {
        const pending = jobs.find(
          (j) => !["complete", "cancelled"].includes(j.phase),
        );
        if (!cancelled) {
          setPendingStart(pending ?? null);
          if (pending && reviewStart) setStartReview(pending.request.revision);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mission.id, isOwner, reviewStart]);
  const [planReview, setPlanReview] = useState<string | null>(
    reviewStart &&
      l.phase === "paused" &&
      l.plan &&
      l.start_blockers.includes("coordinator_not_ready")
      ? l.revision
      : null,
  );
  const coordinated = definition.policy?.coordination === "coordinated";
  const candidates = contributions.filter(
    (c) =>
      c.status === "prepared" &&
      c.mission.role === "coordinator" &&
      c.mission.missionId === mission.id &&
      c.nodeBinding?.revision === l.terms_revision &&
      c.nodeBinding.owner === mission.owner,
  );
  const selected =
    candidates.find((c) => c.id === choice)?.id ?? candidates[0]?.id ?? "";
  const stale = contributions.some(
    (c) =>
      c.status === "prepared" &&
      c.mission.missionId === mission.id &&
      c.nodeBinding &&
      c.nodeBinding.revision !== l.terms_revision,
  );
  const change = (operation: () => Promise<unknown>) =>
    void perform(async () => {
      await operation();
      await updated();
      setEdit(null);
      setPlanReview(null);
    });
  const fallbackReason =
    l.phase === "active"
      ? "Started by the mission owner."
      : l.phase === "paused"
        ? (l.pause_reason ?? "Paused by the mission owner.")
        : l.start_blockers.length
          ? (reasons[l.start_blockers[0]] ?? "Mission start is unavailable.")
          : coordinated
            ? "Coordinator ready. The mission owner can start."
            : "Peer collaboration · waiting for the mission owner to start.";
  const next = presentation.next;
  const editable =
    isOwner && !blocked && !["closed", "archived"].includes(l.phase);
  const reason = blocked
    ? presentation.summary
    : (next?.reason ??
      (presentation.rows.length ? presentation.summary : fallbackReason));
  return (
    <section className="n-control" aria-label="Mission control">
      <section className="n-mission-brief" aria-label="Mission instructions">
        <div className="n-section-heading">
          <h3 className="d-label">Goal</h3>
          {editable ? (
            <button
              className="d-back"
              disabled={busy}
              onClick={() =>
                setEdit({ kind: "instructions", snapshot: mission })
              }
            >
              Edit mission
            </button>
          ) : null}
        </div>
        <p className="n-mission-objective n-preserve">{definition.objective}</p>
        {definition.scope ? (
          <>
            <h3 className="d-label">Scope</h3>
            <p className="n-preserve">{definition.scope}</p>
          </>
        ) : null}
        {edit?.kind === "instructions" ? (
          <ControlEditor
            key={edit.snapshot.lifecycle.revision}
            edit={edit}
            busy={busy}
            changed={edit.snapshot.lifecycle.revision !== l.revision}
            cancel={() => setEdit(null)}
            save={change}
          />
        ) : null}
      </section>
      {!detailsOnly ? (
        <>
          <div
            className="n-control-bar n-current-step"
            hidden={!!startReview || !!planReview}
          >
            <div>
              <span className="d-label">
                {next ? "Next step" : phaseLabel(mission)}
              </span>
              {next ? (
                <h3>
                  {next.kind === "agent" ? next.action.label : next.title}
                </h3>
              ) : null}
              <p role="status">{reason}</p>
            </div>
            {!startReview && !planReview && next ? (
              <button
                className="d-button primary"
                disabled={busy || blocked}
                onClick={() => {
                  if (
                    next.action.destination === "controls" &&
                    next.action.review
                  ) {
                    if (
                      l.phase === "paused" &&
                      l.start_blockers.includes("coordinator_not_ready") &&
                      l.plan
                    )
                      setPlanReview(l.revision);
                    else
                      setStartReview(
                        pendingStart?.request.revision ?? l.revision,
                      );
                  } else act(next.action);
                }}
              >
                {next.action.label}
              </button>
            ) : null}
            {editable && l.phase === "active" ? (
              <button
                className="d-button"
                disabled={busy || blocked}
                onClick={() =>
                  change(() =>
                    node.pauseMission(
                      mission.id,
                      l.revision,
                      "Paused by the mission owner.",
                    ),
                  )
                }
              >
                <Pause size={15} />
                Pause mission
              </button>
            ) : null}
          </div>
          {planReview && l.phase === "paused" && l.plan ? (
            <section
              className="d-panel"
              aria-label="Review paused mission plan"
            >
              <h3>Prepare to resume this mission</h3>
              <p className="n-preserve">{l.plan.text}</p>
              {l.plan.artifact ? (
                <p className="d-field-help">Plan revision: {l.plan.artifact}</p>
              ) : null}
              <p>
                Confirming returns the mission to Preparing with this plan.
                Review a new Coordinator planning session next. Agents wait for
                the Coordinator’s readiness and your Start.
              </p>
              {planReview !== l.revision ? (
                <p role="alert">
                  The mission changed. Reopen this review to inspect the current
                  plan.
                </p>
              ) : null}
              <div className="n-action-row">
                <button
                  className="d-button"
                  onClick={() => setPlanReview(null)}
                >
                  Cancel
                </button>
                <button
                  className="d-button primary"
                  disabled={busy || blocked || planReview !== l.revision}
                  onClick={() =>
                    change(() =>
                      l.plan!.artifact
                        ? node.missionAction(mission.id, l.revision, {
                            type: "set_plan_artifact",
                            revision: l.plan!.artifact,
                          })
                        : node.setPlan(mission.id, l.revision, l.plan!.text),
                    )
                  }
                >
                  Confirm plan and prepare
                </button>
              </div>
            </section>
          ) : null}
          {pendingStart && !startReview && next?.kind !== "start" ? (
            <p role="status">
              An earlier Start review has an unfinished step.{" "}
              <button
                className="d-button"
                onClick={() => setStartReview(pendingStart.request.revision)}
              >
                Continue saved Start review
              </button>
            </p>
          ) : null}
          {startReview ? (
            <StartMissionReview
              saved={pendingStart}
              mission={mission}
              agents={agents}
              contributions={contributions}
              cancel={() => setStartReview(null)}
              done={async () => {
                await updated();
                setStartReview(null);
                setPendingStart(null);
              }}
            />
          ) : null}
        </>
      ) : null}
      {open ? (
        <div className="n-control-details">
          {stale ? (
            <p className="n-review-needed" role="status">
              The mission instructions changed. Your earlier contribution terms
              are preserved; review the new instructions and prepare a new
              contribution.
            </p>
          ) : null}
          {coordinated && l.coordinator ? (
            <div className="n-coordinator-summary">
              <span className="d-label">Coordinator</span>
              <strong>{l.coordinator.identity.label}</strong>
              <span className="d-field-help">
                {l.readiness
                  ? "Current plan acknowledged"
                  : (presentation.rows.find(
                      (r) =>
                        r.agent.identity.author ===
                        l.coordinator?.identity.author,
                    )?.status.label ?? "Activity unknown")}
              </span>
            </div>
          ) : null}
          {l.plan && !startReview && !planReview ? (
            <details className="n-control-plan" open>
              <summary>
                Shared plan ·{" "}
                {l.plan.author === mission.owner
                  ? "set by mission owner"
                  : "Coordinator"}
              </summary>
              <p className="n-preserve">{l.plan.text}</p>
            </details>
          ) : null}
          {children}
          {isOwner && !blocked && !["closed", "archived"].includes(l.phase) ? (
            <details className="n-secondary-section">
              <summary>Mission settings</summary>
              <p className="d-field-help">
                {coordinated ? "Coordinator-led" : "Peer collaboration"} · Your
                changes update the mission’s shared instructions.
              </p>
              {coordinated && !l.coordinator ? (
                <div className="n-coordinator-choice">
                  {candidates.length ? (
                    <>
                      <label className="d-field">
                        Prepared Coordinator
                        <select
                          value={selected}
                          onChange={(e) => setChoice(e.target.value)}
                          disabled={busy}
                        >
                          {candidates.map((c) => (
                            <option value={c.id} key={c.id}>
                              {
                                {
                                  claude: "Claude Code",
                                  codex: "Codex",
                                  grok: "Grok Build",
                                }[c.runtime]
                              }{" "}
                              · {c.id.slice(0, 8)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="d-button"
                        disabled={busy || !selected}
                        onClick={() =>
                          change(() =>
                            node.appointCoordinator(
                              mission.id,
                              l.revision,
                              selected,
                            ),
                          )
                        }
                      >
                        Appoint Coordinator
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
              <div className="n-action-row">
                <button
                  className="d-button"
                  disabled={busy}
                  onClick={() => setEdit({ kind: "plan", snapshot: mission })}
                >
                  {l.plan ? "Edit shared plan" : "Write a plan yourself"}
                </button>
                <button
                  className="d-button"
                  disabled={busy}
                  onClick={() =>
                    setEdit({ kind: "coordination", snapshot: mission })
                  }
                >
                  Change coordination
                </button>
              </div>
              {edit && edit.kind !== "instructions" ? (
                <ControlEditor
                  key={`${edit.kind}:${edit.snapshot.lifecycle.revision}`}
                  edit={edit}
                  busy={busy}
                  changed={edit.snapshot.lifecycle.revision !== l.revision}
                  cancel={() => setEdit(null)}
                  save={change}
                />
              ) : null}
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ControlEditor({
  edit,
  busy,
  changed,
  cancel,
  save,
}: {
  edit: Edit;
  busy: boolean;
  changed: boolean;
  cancel: () => void;
  save: (operation: () => Promise<unknown>) => void;
}) {
  const { snapshot: m, kind } = edit;
  const [criteria, setCriteria] = useState(m.definition.criteria);
  const [criterion, setCriterion] = useState("");
  const add = () => {
    if (criterion.trim() && criteria.length < 32) {
      setCriteria((current) => [...current, criterion.trim()]);
      setCriterion("");
    }
  };
  return (
    <form
      className="n-control-editor"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        save(() =>
          kind === "instructions"
            ? node.updateInstructions(m.id, m.lifecycle.revision, {
                ...m.definition,
                name: String(data.get("name")).trim(),
                objective: String(data.get("objective")).trim(),
                scope: String(data.get("scope")).trim(),
                criteria: criterion.trim()
                  ? [...criteria, criterion.trim()]
                  : criteria,
              })
            : kind === "plan"
              ? node.setPlan(
                  m.id,
                  m.lifecycle.revision,
                  String(data.get("plan")).trim(),
                )
              : node.setCoordination(
                  m.id,
                  m.lifecycle.revision,
                  data.get("mode") as Coordination,
                ),
        );
      }}
    >
      <header>
        <h2>
          {kind === "instructions"
            ? "Mission instructions"
            : kind === "plan"
              ? "Set the shared plan"
              : "Coordination mode"}
        </h2>
        <button
          className="d-icon"
          type="button"
          onClick={cancel}
          aria-label="Close mission editor"
        >
          <X size={17} />
        </button>
      </header>
      {changed ? (
        <p role="alert">
          Mission control changed while this editor was open. Close it and
          review the current state before saving.
        </p>
      ) : null}
      <fieldset className="n-fields" disabled={busy || changed}>
        {kind === "instructions" ? (
          <>
            <label className="d-field">
              Channel name
              <input
                name="name"
                required
                maxLength={120}
                defaultValue={m.definition.name}
              />
            </label>
            <label className="d-field">
              Objective
              <textarea
                name="objective"
                required
                maxLength={4096}
                rows={3}
                defaultValue={m.definition.objective}
              />
            </label>
            <label className="d-field">
              Scope
              <textarea
                name="scope"
                maxLength={8192}
                rows={3}
                defaultValue={m.definition.scope}
              />
            </label>
            <div className="d-field">
              <span>Completion criteria · {criteria.length}</span>
              <ul className="n-edit-criteria">
                {criteria.map((c, i) => (
                  <li key={i}>
                    <input
                      aria-label={`Criterion ${i + 1}`}
                      required
                      maxLength={1024}
                      value={c}
                      onChange={(e) =>
                        setCriteria((current) =>
                          current.map((v, j) => (i === j ? e.target.value : v)),
                        )
                      }
                    />
                    <button
                      className="d-icon"
                      type="button"
                      aria-label={`Remove criterion ${i + 1}`}
                      onClick={() =>
                        setCriteria((current) =>
                          current.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <X size={16} />
                    </button>
                  </li>
                ))}
              </ul>
              {criteria.length < 32 ? (
                <div className="n-add-criterion">
                  <input
                    aria-label="New completion criterion"
                    placeholder="Add a criterion"
                    maxLength={1024}
                    value={criterion}
                    onChange={(e) => setCriterion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        add();
                      }
                    }}
                  />
                  <button
                    className="d-button"
                    type="button"
                    onClick={add}
                    disabled={!criterion.trim()}
                  >
                    Add
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : kind === "plan" ? (
          <label className="d-field">
            Shared plan
            <textarea
              name="plan"
              required
              maxLength={16384}
              rows={7}
              defaultValue={m.lifecycle.plan?.text ?? ""}
            />
            <span className="d-field-help">
              Recorded as your human direction. In coordinator-led mode, the
              Coordinator must acknowledge it before Start.
            </span>
          </label>
        ) : (
          <label className="d-field">
            Mode
            <select
              name="mode"
              defaultValue={m.definition.policy?.coordination ?? "coordinated"}
            >
              <option value="coordinated">Coordinator-led</option>
              <option value="peer">Peer collaboration</option>
            </select>
            <span className="d-field-help">
              Applying this choice removes the current Coordinator appointment.
              Selecting Coordinator-led keeps the mission waiting for a new
              appointment.
            </span>
          </label>
        )}
        <p className="d-field-help">
          Saving returns this mission to Preparing and clears earlier readiness.
          {kind === "instructions"
            ? " Contributors must review the changed instructions before preparing work."
            : null}
        </p>
        <div className="n-action-row">
          <button className="d-button" type="button" onClick={cancel}>
            Cancel
          </button>
          <button className="d-button primary" type="submit">
            {kind === "instructions"
              ? "Save instructions"
              : kind === "plan"
                ? "Save shared plan"
                : "Apply coordination mode"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

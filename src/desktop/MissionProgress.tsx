import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { useApplication } from "./ApplicationProvider";
import { useEffect, useState } from "react";
import { CompleteMission } from "./CompleteMission";
import { resultsReadyForReview } from "../../shared/mission-presentation.mjs";

import type {
  AgentView,
  MissionView,
  ArtifactSummary,
} from "../application/contracts/node";
import type { Perform } from "./ui";
import { Status } from "./ui";
import { useLedger, short } from "./useGovernance";
export function MissionProgress({
  mission,
  owner,
  agents,
  busy,
  perform,
  updated,
  openArtifact,
}: {
  mission: MissionView;
  owner: string;
  agents: AgentView[];
  busy: boolean;
  perform: Perform;
  updated: () => Promise<void>;
  openArtifact: (id: string) => void;
}) {
  const { missions: node } = useApplication();
  const { data, error, refresh } = useLedger(mission.id);
  const [edit, setEdit] = useState<{
    index: number;
    wording: string;
    control: string;
  } | null>(null);
  const [summary, setSummary] = useState("");
  const [met, setMet] = useState(false);
  const [evidence, setEvidence] = useState<string[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);
  const [artifactError, setArtifactError] = useState("");
  const [target, setTarget] = useState("");
  const [closing, setClosing] = useState<"close" | "archive" | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    let active = true;
    (async () => {
      const items: ArtifactSummary[] = [];
      let after: string | null = null;
      do {
        const page = await node.artifacts(mission.id, {
          after,
        });
        items.push(...page.items);
        after = page.after;
      } while (after && items.length < 512);
      if (active) {
        setArtifacts(items);
        setArtifactError("");
      }
    })().catch(() => {
      if (active) setArtifactError("Artifacts could not be loaded. Retrying…");
    });
    return () => {
      active = false;
    };
  }, [mission.id, mission.lifecycle.revision, data, edit, node]);
  const own = owner === mission.owner;
  const archived = mission.lifecycle.phase === "archived";
  const readyForReview =
    !error && resultsReadyForReview(mission, data?.criteria);
  const act = (action: Parameters<typeof node.missionAction>[2]) =>
    void perform(async () => {
      await node.missionAction(mission.id, mission.lifecycle.revision, action);
      await updated();
      await refresh();
      setClosing(null);
      setReason("");
    });
  const assessment =
    edit !== null ? (
      <form
        className="d-panel n-ledger-row"
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            await node.govern(mission.id, edit.control, {
              type: "criterion",
              index: edit.index,
              wording: edit.wording,
              met,
              summary,
              evidence,
            });
            await refresh();
            setEdit(null);
          });
        }}
      >
        <Field>
          <span>Evidence or remaining gap</span>
          <textarea
            required
            maxLength={4096}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </Field>
        <label className="n-check">
          <input
            name="criterionMet"
            type="checkbox"
            checked={met}
            onChange={(e) => setMet(e.target.checked)}
          />
          Report criterion met
        </label>
        <p className="d-field-help">
          Select exact public artifact revisions to support the report.
        </p>
        {artifacts
          .filter((a) => !a.conversation.startsWith("private:") && !a.stale)
          .map((a) => (
            <label className="n-check" key={a.id}>
              <input
                name="criterionEvidence"
                value={a.revision}
                type="checkbox"
                checked={evidence.includes(a.revision)}
                onChange={(e) =>
                  setEvidence((xs) =>
                    e.target.checked
                      ? [...xs, a.revision]
                      : xs.filter((id) => id !== a.revision),
                  )
                }
              />
              {a.title}
            </label>
          ))}
        <div className="n-action-row">
          <Button
            type="button"

            onClick={() => setEdit(null)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              busy ||
              edit.control !== mission.lifecycle.revision ||
              (met && !evidence.length)
            }
          >
            Save assessment
          </Button>
        </div>
      </form>
    ) : null;
  return (
    <section className="n-governance">
      {readyForReview &&
      !["closed", "archived"].includes(mission.lifecycle.phase) ? (
        <section
          className="d-panel"
          aria-label="Results ready for human review"
        >
          <h3>Criteria reported met · ready for your review</h3>
          <p>
            Inspect the current evidence and artifacts before accepting results.
            Only the mission owner closes the mission.
          </p>
          {[...new Set(data!.criteria.flatMap((c) => c.evidence))].map((id) => (
            <Button
              key={id}

              onClick={() => openArtifact(id)}
            >
              Open result · {short(id)}
            </Button>
          ))}
        </section>
      ) : null}
      {own ? (
        <CompleteMission
          key={mission.id}
          mission={mission}
          artifacts={artifacts}
          readyForReview={readyForReview && !artifactError}
          open={openArtifact}
          updated={updated}
        />
      ) : null}
      <h3>Success criteria</h3>
      {error || artifactError ? (
        <p role="alert">{error || artifactError}</p>
      ) : null}
      <div className="n-criteria-list">
        {data?.criteria.map((c) => (
          <Disclosure
            className="n-criterion"
            key={c.index}
            title={
              <>
                <span>{c.wording}</span>
                {c.author || c.met || c.stale ? (
                  <Status
                    tone={c.stale ? "warning" : c.met ? "success" : "neutral"}
                  >
                    {c.stale
                      ? "Evidence needs review"
                      : c.met
                        ? "Reported met"
                        : "Not yet met"}
                  </Status>
                ) : null}
              </>
            }
          >
            <div className="n-criterion-detail">
              {c.summary ? (
                <p>{c.summary}</p>
              ) : (
                <p className="d-field-help">No assessment yet.</p>
              )}
              {c.author ? (
                <p className="d-field-help">
                  Reported by{" "}
                  {c.author === owner
                    ? "you"
                    : (agents.find((a) => a.identity.author === c.author)
                        ?.identity.label ?? short(c.author))}
                </p>
              ) : null}
              <div className="n-action-row">
                {c.evidence.map((id) => (
                  <Button
                    key={id}

                    onClick={() => openArtifact(id)}
                  >
                    Evidence · {short(id)}
                  </Button>
                ))}
                {own && !archived && edit?.index !== c.index ? (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setEdit({
                        index: c.index,
                        wording: c.wording,
                        control: mission.lifecycle.revision,
                      });
                      setSummary(c.summary ?? "");
                      setMet(c.met);
                      setEvidence(c.evidence);
                    }}
                  >
                    Update assessment
                  </Button>
                ) : null}
              </div>
              {edit?.index === c.index ? assessment : null}
            </div>
          </Disclosure>
        ))}
      </div>
      {mission.lifecycle.plan?.artifact ? (
        <Button onClick={() => openArtifact(mission.lifecycle.plan!.artifact!)}>
          Open shared plan artifact
        </Button>
      ) : null}
      {own && !archived && mission.lifecycle.phase !== "closed" ? (
        <>
          {mission.lifecycle.plan ||
          artifacts.some((a) => a.kind === "plan") ? (
            <Disclosure
              className="n-secondary-section"
              title={<>Plan revisions</>}
            >
              <h3>Shared plan</h3>
              <Field>
                <span>Select a complete plan artifact</span>
                <select
                  defaultValue=""
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.value)
                      act({
                        type: "set_plan_artifact",
                        revision: e.target.value,
                      });
                  }}
                >
                  <option value="">Choose an exact revision…</option>
                  {artifacts
                    .filter(
                      (a) =>
                        !a.conversation.startsWith("private:") &&
                        a.kind === "plan" &&
                        a.stage === "complete" &&
                        !a.stale &&
                        a.heads.length === 1,
                    )
                    .map((a) => (
                      <option key={a.id} value={a.revision}>
                        {a.title}
                      </option>
                    ))}
                </select>
              </Field>
            </Disclosure>
          ) : null}
          {mission.lifecycle.coordinator ? (
            <Disclosure
              className="n-secondary-section"
              title={<>Change Coordinator</>}
            >
              <p className="d-field-help">
                The contributor must share a prepared Coordinator. Handover
                returns the mission to Preparing; a fresh plan, readiness and
                human Start are required. Private messages remain with the
                original agent.
              </p>
              {data?.handover_blockers.length ? (
                <p className="n-review-needed">
                  {data.handover_blockers.length} permission(s) still need
                  reconciliation and sealing.
                </p>
              ) : null}
              <Field>
                <span>Prepared Coordinator</span>
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">Select a Coordinator</option>
                  {agents
                    .filter(
                      (a) =>
                        a.identity.role === "coordinator" &&
                        ![
                          "withdrawn",
                          "revoked",
                          "conflict",
                          "review_required",
                        ].includes(a.status),
                    )
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.identity.label} · {a.identity.contributor_name}
                      </option>
                    ))}
                </select>
              </Field>
              <Button
                disabled={
                  busy ||
                  !target ||
                  !!data?.handover_blockers.length ||
                  mission.definition.policy?.coordination !== "coordinated"
                }
                onClick={() => {
                  const agent = agents.find((a) => a.id === target);
                  if (agent)
                    act({
                      type: "handover",
                      registration: agent.id,
                      coordinator: {
                        author: agent.identity.author,
                        label: agent.identity.label,
                        runtime: agent.identity.runtime,
                      },
                      settlements:
                        data?.grants.flatMap((g) => (g.seal ? [g.seal] : [])) ??
                        [],
                    });
                }}
              >
                Hand over coordination
              </Button>
            </Disclosure>
          ) : null}
        </>
      ) : null}
      {own ? (
        <Disclosure
          className="n-secondary-section"
          open={archived || mission.lifecycle.phase === "closed"}
          title={
            <>
              {archived ? "Restore this channel" : "Close or archive mission"}
            </>
          }
        >
          <div className="n-action-row">
            {archived ? (
              <Button disabled={busy} onClick={() => act({ type: "restore" })}>
                Restore channel
              </Button>
            ) : (
              <>
                {mission.lifecycle.phase !== "closed" ? (
                  <Button disabled={busy} onClick={() => setClosing("close")}>
                    Close mission
                  </Button>
                ) : null}
                <Button disabled={busy} onClick={() => setClosing("archive")}>
                  Archive channel
                </Button>
              </>
            )}
          </div>
          {closing ? (
            <form
              className="d-panel n-ledger-row"
              onSubmit={(e) => {
                e.preventDefault();
                act({ type: closing, reason });
              }}
            >
              <p>
                {closing === "archive"
                  ? "Keep the channel and its private history read-only. Restore returns it paused or closed."
                  : "Closing ends this mission and withdraws permission for its agents to work. Use Pause if you intend to continue later."}{" "}
                Outstanding executions and reservations remain visible until
                reconciled.
              </p>
              <Field>
                <span>Reason</span>
                <textarea
                  required
                  maxLength={2048}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <div className="n-action-row">
                <Button type="button" onClick={() => setClosing(null)}>
                  Cancel
                </Button>
                <Button variant="primary" type="submit" disabled={busy}>
                  Confirm {closing}
                </Button>
              </div>
            </form>
          ) : null}
        </Disclosure>
      ) : null}
    </section>
  );
}

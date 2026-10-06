import { useState } from "react";
import { ArrowLeft, FolderOpen, LockKeyhole } from "lucide-react";
import runtimes from "../../shared/runtimes.json";
import { desktop, type Contribution } from "./bridge";
import { Heading, date, type Perform } from "./ui";
import { ExecutionPanel } from "./ExecutionPanel";

export default function ContributionDetail({
  item,
  busy,
  perform,
  back,
  revoke,
  openMission,
}: {
  item: Contribution;
  busy: boolean;
  perform: Perform;
  back: () => void;
  revoke: () => Promise<void>;
  openMission?: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <button className="d-back" disabled={busy} onClick={back}>
        <ArrowLeft size={14} />
        Contributions
      </button>
      <Heading
        section="Your contribution"
        title={item.mission.name}
        action={
          openMission ? (
            <button
              className="d-button"
              onClick={openMission}
              disabled={!openMission}
            >
              Open mission
            </button>
          ) : undefined
        }
      >
        {item.mission.origin}
      </Heading>
      <ExecutionPanel item={item} />
      <details className="n-secondary-section">
        <summary>
          Local terms · {item.status === "revoked" ? "Revoked" : "Saved"}
        </summary>
        <section>
          <header>
            <h2>Your contribution</h2>
            <span className="d-runtime-badge">
              {runtimes[item.runtime].badge}
            </span>
          </header>
          <dl className="d-facts">
            <div>
              <dt>Runtime</dt>
              <dd>{runtimes[item.runtime].label}</dd>
            </div>
            <div>
              <dt>Requested role</dt>
              <dd>
                {item.mission.role === "coordinator" ? "Coordinator" : "Agent"}
              </dd>
            </div>
            <div>
              <dt>Concurrent agents</dt>
              <dd>{item.limits.concurrency} maximum</dd>
            </div>
            <div>
              <dt>Turn allowance</dt>
              <dd>
                {item.limits.mode === "bounded"
                  ? `${item.limits.turns} runtime turns`
                  : "Unlimited"}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {item.limits.mode === "bounded"
                  ? `${item.limits.minutes} minutes from start`
                  : "Unlimited"}
              </dd>
            </div>
            <div>
              <dt>Prepared</dt>
              <dd>{date(item.createdAt)}</dd>
            </div>
          </dl>
        </section>
      </details>
      <section className="d-panel d-workspace-panel">
        <header>
          <div>
            <h2>Workspace exports</h2>
            <p>
              Exported files remain here if you revoke this contribution. Agent
              execution stays inside its VM.
            </p>
          </div>
          <button
            className="d-button"
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                await desktop.reveal(item.id);
              });
            }}
          >
            <FolderOpen size={15} />
            Open folder
          </button>
        </header>
        <code>{item.workspace}</code>
      </section>
      {item.status === "prepared" ? (
        <section className="d-revoke">
          <div>
            <h2>
              {confirm
                ? "Revoke this local preparation?"
                : "Withdraw this contribution"}
            </h2>
            <p>
              {confirm
                ? "Your files and this record will stay on the device. Prepare a new contribution to approve different terms."
                : "Stop this contribution and keep your exported files."}
            </p>
          </div>
          <div>
            {confirm ? (
              <>
                <button
                  className="d-button"
                  disabled={busy}
                  onClick={() => setConfirm(false)}
                >
                  Keep preparation
                </button>
                <button
                  className="d-button danger"
                  disabled={busy}
                  onClick={() => {
                    void perform(revoke);
                  }}
                >
                  Confirm revocation
                </button>
              </>
            ) : (
              <button
                className="d-button"
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                Revoke consent
              </button>
            )}
          </div>
        </section>
      ) : (
        <div className="d-explainer">
          <LockKeyhole size={16} />
          <p>
            Revoked {date(item.revokedAt!)}. Your workspace is preserved. This
            preparation cannot be reactivated by a remote request.
          </p>
        </div>
      )}
    </>
  );
}

import { useState } from "react";
import { ArrowLeft, FolderOpen, LockKeyhole } from "lucide-react";
import runtimes from "../../shared/runtimes.json";
import { desktop, type Contribution } from "./bridge";
import { Heading, Status, date, type Perform } from "./ui";

export default function ContributionDetail({
  item,
  busy,
  perform,
  back,
  revoke,
}: {
  item: Contribution;
  busy: boolean;
  perform: Perform;
  back: () => void;
  revoke: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <button className="d-back" disabled={busy} onClick={back}>
        <ArrowLeft size={14} />
        Contributions
      </button>
      <Heading
        section="Your contribution / Local preparation"
        title={item.mission.name}
        action={
          <Status muted={item.status === "revoked"}>
            {item.status === "revoked" ? "Revoked" : "Prepared"}
          </Status>
        }
      >
        {item.mission.origin}
      </Heading>
      <div className="d-two-columns">
        <section className="d-panel">
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
        <section className="d-panel">
          <header>
            <h2>Execution</h2>
            <Status muted>Not running</Status>
          </header>
          <p>
            {item.status === "revoked"
              ? "You revoked this preparation. It cannot be reused to authorize work."
              : "Your local preparation is saved. No agent has joined the board or started work."}
          </p>
          <div className="d-pending">
            <span className="d-label">Before an agent can run</span>
            <ul>
              {item.execution.blockers.map((reason) => (
                <li key={reason.code}>{reason.message}</li>
              ))}
            </ul>
          </div>
          <p className="d-footnote">
            The existing unrestricted launcher is not used by the desktop app.
          </p>
        </section>
      </div>
      <section className="d-panel d-workspace-panel">
        <header>
          <div>
            <h2>Dedicated workspace</h2>
            <p>Files remain here if you revoke this preparation.</p>
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
                : "You can withdraw your consent."}
            </h2>
            <p>
              {confirm
                ? "Your files and this record will stay on the device. Prepare a new contribution to approve different terms."
                : "A coordinator cannot restore or expand the terms you approved here."}
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

import { Disclosure } from "../ui/Disclosure";
import { Button } from "../ui/Button";
import { useApplication } from "./ApplicationProvider";
import { useState } from "react";
import { ArrowLeft, FolderOpen, LockKeyhole } from "lucide-react";
import runtimes from "../../shared/runtimes.json";
import { type Contribution } from "../application/contracts/workspace";
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
  const { workspace: desktop } = useApplication();
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
            <Button onClick={openMission} disabled={!openMission}>
              Open mission
            </Button>
          ) : undefined
        }
      >
        {item.mission.origin}
      </Heading>
      <ExecutionPanel item={item} />
      <Disclosure
        className="n-secondary-section"
        title={
          <>Local terms · {item.status === "revoked" ? "Revoked" : "Saved"}</>
        }
      >
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
      </Disclosure>
      <section className="d-panel d-workspace-panel">
        <header>
          <div>
            <h2>Workspace exports</h2>
            <p>
              Exported files remain here if you revoke this contribution. Agent
              execution stays inside its VM.
            </p>
          </div>
          <Button
            disabled={busy}
            onClick={() => {
              void perform(async () => {
                await desktop.reveal(item.id);
              });
            }}
          >
            <FolderOpen size={15} />
            Open folder
          </Button>
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
                <Button disabled={busy} onClick={() => setConfirm(false)}>
                  Keep preparation
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    void perform(revoke);
                  }}
                >
                  Confirm revocation
                </Button>
              </>
            ) : (
              <Button disabled={busy} onClick={() => setConfirm(true)}>
                Revoke consent
              </Button>
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

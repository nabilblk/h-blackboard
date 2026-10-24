import { useState } from "react";
import { useApplication } from "./ApplicationProvider";
import { Button } from "../ui/Button";
import { Disclosure } from "../ui/Disclosure";
import type {
  Contribution,
  ContributionReview,
} from "../application/contracts/workspace";
import type { MissionView } from "../application/contracts/node";

/** A human review changes consent to instructions, never execution permission. */
export function ContributionRenewal({
  item,
  mission,
  working,
  done,
}: {
  item: Contribution;
  mission: MissionView;
  working: boolean;
  done: () => Promise<void>;
}) {
  const { missions } = useApplication();
  const [review, setReview] = useState<ContributionReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stale =
    !!review &&
    review.nodeBinding.revision !== mission.lifecycle.terms_revision;
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="d-panel" aria-label="Updated mission instructions">
      <h3>Continue with the updated brief</h3>
      <p>
        Keep this agent and its saved work. Review the current instructions
        before approving another run.
      </p>
      {working ? (
        <p role="status">Stop this agent below before accepting the update.</p>
      ) : null}
      {!review || stale ? (
        <>
          {stale ? (
            <p role="status">
              The brief changed again. Read the latest version.
            </p>
          ) : null}
          <Button
            variant="primary"
            disabled={busy || working}
            onClick={() =>
              void act(async () => {
                setReview(
                  await missions.reviewContribution(
                    mission.id,
                    item.mission.role,
                  ),
                );
                setConfirmed(false);
              })
            }
          >
            {busy ? "Loading…" : "Review updated instructions"}
          </Button>
        </>
      ) : (
        <>
          <h4>{review.definition.name}</h4>
          <p className="n-preserve">{review.definition.objective}</p>
          {review.definition.scope ? (
            <>
              <h4>Scope</h4>
              <p className="n-preserve">{review.definition.scope}</p>
            </>
          ) : null}
          {review.definition.criteria.length ? (
            <>
              <h4>Completion criteria</h4>
              <ul>
                {review.definition.criteria.map((criterion, i) => (
                  <li key={i}>{criterion}</li>
                ))}
              </ul>
            </>
          ) : null}
          <Disclosure title={<>Mission settings</>}>
            <p>
              Coordination:{" "}
              {review.definition.policy?.coordination === "coordinated"
                ? "Coordinator-led"
                : "Peer collaboration"}
              . Participation: {review.definition.policy?.participation}.
              Mission budget: {review.definition.policy?.budget.mode}.
            </p>
          </Disclosure>
          <p className="d-field-help">
            Your workspace, login, internet setting and local limits stay the
            same. Accepting this update does not start the agent.
          </p>
          <label className="n-check-label">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || working}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed these instructions for this agent.
          </label>
          <div className="n-action-row">
            <Button
              variant="primary"
              disabled={!confirmed || busy || working}
              onClick={() =>
                void act(async () => {
                  await missions.renewContribution({
                    contributionId: item.id,
                    reviewId: review.reviewId,
                  });
                  await done();
                })
              }
            >
              {busy ? "Accepting…" : "Accept updated instructions"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setReview(null);
                setConfirmed(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
      {error ? (
        <p className="d-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

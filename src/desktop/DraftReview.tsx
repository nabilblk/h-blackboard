import { useEffect, useRef } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "../ui/Button";
import { Status } from "../ui/Status";
import type { DraftReview as Review } from "../application/contracts/drafting";

export function DraftReview({
  review,
  acknowledged,
  working,
  enrolled,
  onAcknowledged,
  onBack,
  onCreate,
}: {
  review: Review;
  acknowledged: boolean;
  working: boolean;
  enrolled: boolean;
  onAcknowledged: (value: boolean) => void;
  onBack: () => void;
  onCreate: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  }, [review.id]);
  const { definition } = review;
  const policy = definition.policy;
  const budget = policy?.budget;
  const open = review.assumptions.length + review.openQuestions.length;
  return (
    <div className="d-panel md-review">
      <header>
        <div>
          <div className="d-label">The brief your team will receive</div>
          <h2 ref={heading} tabIndex={-1}>
            # {definition.name}
          </h2>
        </div>
        <Status>Preparing</Status>
      </header>
      <section>
        <h3>Objective</h3>
        <p>{definition.objective}</p>
      </section>
      {definition.scope ? (
        <section>
          <h3>Scope and deliverables</h3>
          <p className="md-preserve">{definition.scope}</p>
        </section>
      ) : null}
      <section>
        <h3>Completion criteria</h3>
        {definition.criteria.length ? (
          <ol>
            {definition.criteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        ) : (
          <p className="d-field-help">
            No criteria yet. The team can propose how to judge the result.
          </p>
        )}
      </section>
      <p className="d-field-help">
        {policy?.coordination === "peer"
          ? "Peer collaboration"
          : "Coordinator-led"}{" "}
        ·{" "}
        {policy?.participation === "private"
          ? "Private invitation"
          : "Discoverable, approval required"}{" "}
        · {budget?.mode === "limited" ? "Limited budget" : "Unlimited budget"}
      </p>
      {budget?.mode === "limited" ? (
        <p className="d-field-help">
          Turns: {budget.turns ?? "No cap"} · Concurrent turns:{" "}
          {budget.concurrency ?? "No cap"} · Deadline:{" "}
          {budget.deadline_ms
            ? new Date(budget.deadline_ms).toLocaleString()
            : "None"}
        </p>
      ) : null}
      {open ? (
        <label className="md-acknowledgment">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => onAcknowledged(e.target.checked)}
            disabled={working}
          />
          <span>
            I have reviewed the working assumptions and questions left for the
            team.
          </span>
        </label>
      ) : null}
      <p className="d-field-help">
        Your drafting conversation is not shared with the mission. The mission
        begins in Preparing; you decide when work starts.
      </p>
      <footer className="md-actions">
        <Button disabled={working} onClick={onBack}>
          Back to editing
        </Button>
        <Button
          variant="primary"
          disabled={working || (!!open && !acknowledged)}
          onClick={onCreate}
        >
          {working ? "Creating mission…" : "Create mission"}
          <ArrowRight size={15} />
        </Button>
      </footer>
      {working && !enrolled ? (
        <p role="status" className="d-field-help">
          Securing your node identity. Approve the macOS Keychain prompt if it
          appears.
        </p>
      ) : null}
    </div>
  );
}

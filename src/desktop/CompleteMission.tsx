import { Field } from "../ui/Field";
import { Button } from "../ui/Button";
import { useApplication } from "./ApplicationProvider";
import { useEffect, useState } from "react";
import type {
  ArtifactSummary,
  MissionView,
} from "../application/contracts/node";
import type {
  CompletionRequest,
  CompletionJob,
} from "../application/contracts/setup";
import { useSetupDraft } from "./useSetupDraft";

type ReviewDraft = { review: boolean; selected: string[]; reason: string };
const validDraft = (v: unknown): v is ReviewDraft => {
  if (!v || typeof v !== "object") return false;
  const d = v as ReviewDraft;
  return (
    typeof d.review === "boolean" &&
    typeof d.reason === "string" &&
    d.reason.length <= 2048 &&
    Array.isArray(d.selected) &&
    d.selected.length <= 32 &&
    d.selected.every((r) => typeof r === "string" && /^[a-f0-9]{64}$/.test(r))
  );
};

export function CompleteMission({
  mission,
  artifacts,
  readyForReview,
  open,
  updated,
}: {
  mission: MissionView;
  artifacts: ArtifactSummary[];
  readyForReview: boolean;
  open: (id: string) => void;
  updated: () => Promise<void>;
}) {
  const { setup } = useApplication();
  const [draft, save, clear, draftError] = useSetupDraft<ReviewDraft>(
    `${mission.id}:completion-review`,
    { review: false, selected: [], reason: "" },
    validDraft,
  );
  const { review, selected, reason } = draft;
  const [saved, setSaved] = useState<CompletionJob | null>(null);
  const [request, setRequest] = useState<CompletionRequest | null>(null);
  // Confirmation is deliberately never restored from a draft or an old job.
  const [confirmation, setConfirmation] = useState<CompletionRequest | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void setup
      .completionState(mission.id)
      .then((jobs) => {
        const pending = jobs.find(
          (j) => !["complete", "abandoned"].includes(j.status),
        );
        if (!cancelled && pending) {
          setSaved(pending);
          setRequest({ ...pending.request, closeConfirmed: true });
          save({
            selected: pending.request.revisions,
            reason: pending.request.reason,
            review: true,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [mission.id, setup]);

  const options = artifacts.filter(
    (a) =>
      a.conversation === "main" &&
      !a.stale &&
      a.heads.length === 1 &&
      a.stage === "complete",
  );
  const currentSelection =
    selected.length > 0 &&
    selected.every((r) => options.some((a) => a.revision === r));
  const changed =
    !!(confirmation ?? request) &&
    (confirmation ?? request)!.control !== mission.lifecycle.revision;
  const canReview = readyForReview && currentSelection && !changed;

  async function discard() {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      await setup.discardCompletion(request.id);
      setRequest(null);
      setSaved(null);
      setConfirmation(null);
      clear();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    if (!confirmation || !canReview || busy) return;
    const r = confirmation;
    setRequest(r);
    setBusy(true);
    setError("");
    try {
      setSaved(await setup.completeMission(r));
      setConfirmation(null);
      clear();
      await updated();
    } catch (e) {
      setError((e as Error).message);
      // A lost response may have saved some decisions. Keep their exact request.
      try {
        setSaved(
          (await setup.completionState(mission.id)).find(
            (j) => j.id === r.id,
          ) ?? null,
        );
      } catch {
        /* Retrying reconciles the saved decisions. */
      }
    } finally {
      setBusy(false);
    }
  }

  if (["closed", "archived"].includes(mission.lifecycle.phase)) return null;
  if (
    (!readyForReview || !options.length) &&
    !saved &&
    !confirmation &&
    !request &&
    !error &&
    !draftError
  )
    return null;

  return (
    <section className="d-panel" aria-label="Mission completion review">
      <h3>
        {confirmation
          ? "Finish this mission?"
          : saved
            ? "Unfinished completion review"
            : "Review final results"}
      </h3>
      {saved ? (
        <p role="status">
          {saved.accepted.length}/{saved.request.revisions.length} acceptance
          decisions saved. {saved.message}
        </p>
      ) : null}
      {!readyForReview ? (
        <>
          <p className="d-field-help">
            Final results are not ready for review. Accept individual artifacts
            in Artifacts; that keeps the mission open.
          </p>
          {confirmation && !request ? (
            <Button onClick={() => setConfirmation(null)}>
              Back to review
            </Button>
          ) : null}
        </>
      ) : confirmation ? (
        <>
          <p>
            This accepts the selected deliverables and closes the mission. Its
            agents will no longer have permission to work and will be asked to
            stop. Saved work stays available.
          </p>
          <ul>
            {confirmation.revisions.map((r) => (
              <li key={r}>
                {options.find((a) => a.revision === r)?.title ??
                  "Revision no longer current"}
              </li>
            ))}
          </ul>
          <p className="d-field-help">
            To approve a plan and continue working, go back and accept the
            artifact instead.
          </p>
          <div className="n-action-row">
            <Button
              type="button"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Back to review
            </Button>
            <Button
              variant="primary"
              disabled={busy || !canReview}
              onClick={() => void finish()}
            >
              {busy
                ? "Finishing mission…"
                : "Accept deliverables and finish mission"}
            </Button>
          </div>
          {!currentSelection ? (
            <p role="alert">
              A selected deliverable changed. Review the current artifacts.
            </p>
          ) : null}
        </>
      ) : !review ? (
        <Button
          variant="primary"
          onClick={() => save({ ...draft, review: true })}
        >
          Review deliverables
        </Button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canReview || busy) return;
            setConfirmation(
              request ?? {
                id: crypto.randomUUID(),
                mission: mission.id,
                control: mission.lifecycle.revision,
                revisions: [...selected],
                reason:
                  reason.trim() ||
                  "Accepted the reviewed deliverables and explicitly finished the mission.",
                closeConfirmed: true,
              },
            );
          }}
        >
          <fieldset disabled={busy || !!request}>
            <legend>Deliverables to accept</legend>
            {options.map((a) => (
              <div key={a.id} className="n-action-row">
                <label className="n-check-label">
                  <input
                    type="checkbox"
                    checked={selected.includes(a.revision)}
                    disabled={
                      !selected.includes(a.revision) && selected.length >= 32
                    }
                    onChange={(e) =>
                      save({
                        ...draft,
                        selected: e.target.checked
                          ? [...selected, a.revision]
                          : selected.filter((r) => r !== a.revision),
                      })
                    }
                  />
                  {a.title}
                </label>
                <Button type="button" onClick={() => open(a.revision)}>
                  Inspect
                </Button>
              </div>
            ))}
            <Field>
              Acceptance note (optional)
              <textarea
                maxLength={2048}
                value={reason}
                onChange={(e) => save({ ...draft, reason: e.target.value })}
              />
            </Field>
          </fieldset>
          {selected.length > 0 && !currentSelection ? (
            <p role="alert">
              A selected deliverable is no longer current.
              {!request ? (
                <Button
                  type="button"
                  onClick={() => save({ ...draft, selected: [] })}
                >
                  Clear selection
                </Button>
              ) : null}
            </p>
          ) : null}
          <p className="d-field-help">
            {saved
              ? "Earlier acceptance decisions stay saved. Finishing still needs your confirmation."
              : "The next step explains what finishing the mission will do. Nothing is saved yet."}
          </p>
          <div className="n-action-row">
            {!request ? (
              <Button
                type="button"
                onClick={() => save({ ...draft, review: false })}
              >
                Cancel
              </Button>
            ) : null}
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !canReview}
            >
              Review mission completion
            </Button>
          </div>
        </form>
      )}
      {changed ? (
        <p role="alert">
          {request
            ? "The mission changed. Discard this completion review and inspect the current results."
            : "The mission changed. Go back and review its current results."}
        </p>
      ) : null}
      {request ? (
        <Button type="button" disabled={busy} onClick={() => void discard()}>
          Discard unfinished completion review
        </Button>
      ) : null}
      {error || draftError ? (
        <p role="alert" className="d-error">
          {error || draftError}
        </p>
      ) : null}
    </section>
  );
}

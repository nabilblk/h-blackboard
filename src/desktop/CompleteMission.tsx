import { useEffect, useState } from "react";
import type { ArtifactSummary, MissionView } from "./node-contract";
import type { CompletionRequest, CompletionJob } from "./onboarding-types";
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
  open,
  updated,
}: {
  mission: MissionView;
  artifacts: ArtifactSummary[];
  open: (id: string) => void;
  updated: () => Promise<void>;
}) {
  const [draft, save, clear, draftError] = useSetupDraft<ReviewDraft>(
    `${mission.id}:completion-review`,
    { review: false, selected: [], reason: "" },
    validDraft,
  );
  const { review, selected, reason } = draft;
  const [saved, setSaved] = useState<CompletionJob | null>(null);
  const [request, setRequest] = useState<CompletionRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void window.blackboardSetup
      .completionState(mission.id)
      .then((jobs) => {
        const pending = jobs.find(
          (j) => !["complete", "abandoned"].includes(j.status),
        );
        if (!cancelled && pending) {
          setSaved(pending);
          setRequest(pending.request);
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
  }, [mission.id]);
  const options = artifacts.filter(
    (a) =>
      a.conversation === "main" &&
      !a.stale &&
      a.heads.length === 1 &&
      a.stage === "complete",
  );
  if (["closed", "archived"].includes(mission.lifecycle.phase))
    return (
      <p className="d-field-help">
        Mission closed. Open Artifacts to revisit accepted deliverables and
        their exact revisions.
      </p>
    );
  if (!options.length && !saved) return null;
  return (
    <section className="d-panel">
      <h3>Review the handoff</h3>
      <p>
        Acceptance records your decision about exact deliverables. Closing ends
        the mission; outstanding processes still need confirmed stops.
      </p>
      {!review ? (
        <button
          className="d-button primary"
          onClick={() => save({ ...draft, review: true })}
        >
          Review deliverables and finish
        </button>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const r = request ?? {
              id: crypto.randomUUID(),
              mission: mission.id,
              control: mission.lifecycle.revision,
              revisions: selected,
              reason,
            };
            setRequest(r);
            try {
              setSaved(await window.blackboardSetup.completeMission(r));
              clear();
              await updated();
            } catch (e) {
              setError((e as Error).message);
              try {
                setSaved(
                  (
                    await window.blackboardSetup.completionState(mission.id)
                  ).find((j) => j.id === r.id) ?? null,
                );
              } catch {
                /* Original failure remains visible; retry reconciles saved decisions. */
              }
            } finally {
              setBusy(false);
            }
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
                <button
                  type="button"
                  className="d-button"
                  onClick={() => open(a.revision)}
                >
                  Inspect
                </button>
              </div>
            ))}
            <label className="d-field">
              Your acceptance note
              <textarea
                required
                maxLength={2048}
                value={reason}
                onChange={(e) => save({ ...draft, reason: e.target.value })}
              />
            </label>
          </fieldset>
          {saved ? (
            <p role="status">
              {saved.accepted.length}/{saved.request.revisions.length} decisions
              saved. {saved.message}
            </p>
          ) : null}
          <button
            className="d-button primary"
            disabled={busy || !selected.length || !reason.trim()}
          >
            {busy
              ? "Saving decisions…"
              : request
                ? "Continue saved completion"
                : "Accept selected and close mission"}
          </button>
          {request ? (
            <button
              type="button"
              className="d-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await window.blackboardSetup.discardCompletion(request.id);
                  setRequest(null);
                  setSaved(null);
                  clear();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Review current results instead
            </button>
          ) : null}
        </form>
      )}
      {error || draftError ? (
        <p role="alert" className="d-error">
          {error || draftError}
        </p>
      ) : null}
    </section>
  );
}

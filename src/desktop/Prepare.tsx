import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FolderOpen,
  Link,
  LockKeyhole,
} from "lucide-react";
import runtimes from "../../shared/runtimes.json";
import {
  desktop,
  node,
  type ContributionReview,
  type Limits,
  type LocalState,
  type Mission,
  type Runtime,
} from "./bridge";
import { Heading, Status, type Perform } from "./ui";

export default function Prepare({
  busy,
  perform,
  cancel,
  complete,
  nodeReview,
}: {
  busy: boolean;
  perform: Perform;
  cancel: () => void;
  complete: (value: LocalState) => void;
  nodeReview?: ContributionReview;
}) {
  const [invitation, setInvitation] = useState("");
  const [review, setReview] = useState<{
    reviewId: string;
    mission: Mission;
  } | null>(nodeReview ?? null);
  const [workspace, setWorkspace] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [runtime, setRuntime] = useState<Runtime>("grok");
  const [mode, setMode] = useState<"bounded" | "unlimited">("bounded");
  const [concurrency, setConcurrency] = useState("1");
  const [turns, setTurns] = useState("20");
  const [minutes, setMinutes] = useState("60");
  return (
    <>
      <button className="d-back" disabled={busy} onClick={cancel}>
        <ArrowLeft size={14} />
        Contributions
      </button>
      <Heading
        section="New contribution"
        title={
          review ? "Choose your local terms." : "Start with an invitation."
        }
      >
        {review
          ? "These choices belong to you. Remote instructions cannot change them."
          : "Read a mission invitation before deciding what to contribute."}
      </Heading>
      {!review ? (
        <div className="d-prepare-grid">
          <form
            className="d-panel d-invitation"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const result = await desktop.inspect(invitation);
                setReview(result);
                setInvitation("");
              });
            }}
          >
            <header>
              <h2>Mission invitation</h2>
              <Link size={17} />
            </header>
            <label className="d-field">
              Invitation URL
              <input
                name="invitation"
                type="url"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={invitation}
                onChange={(event) => setInvitation(event.target.value)}
                placeholder="https://board.example/j/…"
                disabled={busy}
                maxLength={4096}
              />
            </label>
            <p className="d-field-help">
              Use an Agent or Coordinator invitation from a Blackboard mission.
            </p>
            <button
              className="d-button primary"
              type="submit"
              disabled={busy || !invitation.trim()}
            >
              {busy ? "Inspecting…" : "Inspect invitation"}
              <ArrowRight size={15} />
            </button>
            <div className="d-form-note">
              <LockKeyhole size={14} />
              <p>
                Inspection contacts that board once. It does not join the
                mission, start an agent, or share your local identity. The
                invitation token is not saved.
              </p>
            </div>
          </form>
          <aside className="d-prepare-guide">
            <span className="d-label">Before you contribute</span>
            <h2>Know where your agent is going.</h2>
            <p>
              A mission invitation identifies a board and a requested role.
              Check the board address and the person who invited you.
            </p>
            <p>
              The current invitation format does not provide verified owner
              identity or a complete mission brief. Local preparation is the
              furthest this build will go.
            </p>
          </aside>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!workspace) return;
            const limits: Limits =
              mode === "bounded"
                ? {
                    mode,
                    concurrency: Number(concurrency),
                    turns: Number(turns),
                    minutes: Number(minutes),
                  }
                : { mode, concurrency: Number(concurrency) };
            void perform(async () =>
              complete(
                await (nodeReview ? node.prepareContribution : desktop.prepare)(
                  {
                    reviewId: review.reviewId,
                    workspaceChoiceId: workspace.id,
                    runtime,
                    limits,
                  },
                ),
              ),
            );
          }}
        >
          <div className="d-mission-review">
            <div className="d-hash large">#</div>
            <div>
              <span className="d-label">
                {nodeReview
                  ? "Signed mission terms · owner key verified"
                  : "Invitation preview · owner unverified"}
              </span>
              <h2>{review.mission.name}</h2>
              <p className="d-mono">{review.mission.origin}</p>
            </div>
            <Status muted>
              {review.mission.role === "coordinator" ? "Coordinator" : "Agent"}
            </Status>
            <button
              type="button"
              className="d-button"
              disabled={busy}
              onClick={() => (nodeReview ? cancel() : setReview(null))}
            >
              {nodeReview ? "Back to mission" : "Change invitation"}
            </button>
          </div>
          {nodeReview ? (
            <section
              className="d-panel n-reviewed-terms"
              aria-label="Reviewed contribution terms"
            >
              <h2>{nodeReview.definition.objective}</h2>
              <p className="n-preserve">{nodeReview.definition.scope}</p>
              <ul>
                {nodeReview.definition.criteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
              <details>
                <summary>Exact signed mission revision</summary>
                <code className="n-key">{nodeReview.nodeBinding.revision}</code>
                <p className="d-field-help">
                  These local terms are bound to this revision. A signature
                  identifies the owner’s key, not their real-world identity.
                </p>
              </details>
            </section>
          ) : null}
          <div className="d-two-columns d-terms">
            <section className="d-panel">
              <header>
                <h2>Runtime & workspace</h2>
                <FolderOpen size={17} />
              </header>
              <label className="d-field">
                Runtime
                <select
                  value={runtime}
                  onChange={(event) =>
                    setRuntime(event.target.value as Runtime)
                  }
                  disabled={busy}
                >
                  {Object.entries(runtimes).map(([id, data]) => (
                    <option key={id} value={id}>
                      {data.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="d-field-help">
                Your own account, configured when isolated execution becomes
                available.
              </p>
              <div className="d-field">
                <span>Workspace location</span>
                <div className="d-folder-choice">
                  {workspace ? (
                    <>
                      <FolderOpen size={17} />
                      <span className="d-mono">{workspace.path}</span>
                    </>
                  ) : (
                    <span className="d-secondary">No location selected</span>
                  )}
                </div>
                <button
                  type="button"
                  className="d-button"
                  disabled={busy}
                  onClick={() => {
                    void perform(async () => {
                      const choice = await desktop.chooseWorkspace();
                      if (choice) setWorkspace(choice);
                    });
                  }}
                >
                  <FolderOpen size={15} />
                  {workspace ? "Change location" : "Choose folder…"}
                </button>
              </div>
              <p className="d-field-help">
                Saving creates a dedicated, empty folder inside this location.
                The parent folder is not part of the contribution.
              </p>
            </section>
            <section className="d-panel">
              <header>
                <h2>Local allowance</h2>
                <span className="d-label">You control this</span>
              </header>
              <label className="d-field">
                Maximum concurrent agents
                <input
                  type="number"
                  required
                  min={1}
                  max={review.mission.role === "coordinator" ? 1 : 32}
                  value={concurrency}
                  disabled={busy}
                  onChange={(event) => setConcurrency(event.target.value)}
                />
              </label>
              <div
                className="d-radio-group"
                role="radiogroup"
                aria-label="Turn and time allowance"
              >
                <label>
                  <input
                    type="radio"
                    name="allowance"
                    checked={mode === "bounded"}
                    onChange={() => setMode("bounded")}
                    disabled={busy}
                  />
                  Set limits
                </label>
                <label>
                  <input
                    type="radio"
                    name="allowance"
                    checked={mode === "unlimited"}
                    onChange={() => setMode("unlimited")}
                    disabled={busy}
                  />
                  No turn or time limit
                </label>
              </div>
              {mode === "bounded" ? (
                <div className="d-limit-fields">
                  <label className="d-field">
                    Total runtime turns
                    <input
                      type="number"
                      required
                      min={1}
                      max={10000}
                      value={turns}
                      disabled={busy}
                      onChange={(event) => setTurns(event.target.value)}
                    />
                  </label>
                  <label className="d-field">
                    Duration from start (min)
                    <input
                      type="number"
                      required
                      min={1}
                      max={10080}
                      value={minutes}
                      disabled={busy}
                      onChange={(event) => setMinutes(event.target.value)}
                    />
                  </label>
                </div>
              ) : (
                <p className="d-unlimited">
                  No local turn or duration cap. The concurrency limit remains.
                  Provider subscription limits still apply.
                </p>
              )}
              <p className="d-field-help">
                A turn is one managed runtime invocation. These are saved terms
                for future execution, not a measurement of tokens or
                subscription credit.
              </p>
            </section>
          </div>
          <div className="d-consent">
            <label>
              <input type="checkbox" required disabled={busy} />
              <span>
                I approve these local terms. Joining and running will require a
                separate step.
              </span>
            </label>
            <div>
              <button
                type="button"
                className="d-button"
                disabled={busy}
                onClick={cancel}
              >
                Cancel
              </button>
              <button
                className="d-button primary"
                type="submit"
                disabled={busy || !workspace}
              >
                {busy ? "Saving…" : "Save preparation"}
                <Check size={15} />
              </button>
            </div>
          </div>
        </form>
      )}
    </>
  );
}
